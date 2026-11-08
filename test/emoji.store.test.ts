import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

// §23.2 的存储层语义：emoji_descriptions 的读写口径（两条管理路由见 test/admin.crud.test.ts）

const MASTER_KEY = toBase64(new Uint8Array(32).fill(11));

// ISO 8601（nowIso 就是 Date#toISOString 的形状）：updatedAt 由仓储补，调用方不传
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

async function countRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM emoji_descriptions').first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM emoji_descriptions').run();
});

describe('emoji_descriptions 仓储', () => {
  it('空表 list 回 []', async () => {
    expect(await countRows()).toBe(0);
    expect(await makeRepos().emojiDescriptions.list('g1')).toEqual([]);
  });

  it('putMany 写入后 list 读回：四个字段都在，updatedAt 是写入时刻的 ISO', async () => {
    const { emojiDescriptions } = makeRepos();
    const before = Date.now();

    await emojiDescriptions.putMany('g1', [{ emojiId: '111', name: 'laugh', description: '黄胖小子咧嘴大笑' }]);

    const items = await emojiDescriptions.list('g1');
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) throw new Error('list 没读回刚写的行');

    // 白名单形状：guild_id 之类的内部列不能漏进上层
    expect(Object.keys(item).sort()).toEqual(['description', 'emojiId', 'name', 'updatedAt']);
    expect(item.emojiId).toBe('111');
    expect(item.name).toBe('laugh');
    expect(item.description).toBe('黄胖小子咧嘴大笑');
    expect(item.updatedAt).toMatch(ISO_PATTERN);
    const writtenAt = Date.parse(item.updatedAt);
    expect(Number.isNaN(writtenAt)).toBe(false);
    expect(writtenAt).toBeGreaterThanOrEqual(before);
    expect(writtenAt).toBeLessThanOrEqual(Date.now());
  });

  it('同 id 覆盖写：不新增行，name / description / updatedAt 一起换新', async () => {
    const { emojiDescriptions } = makeRepos();

    await emojiDescriptions.putMany('g1', [{ emojiId: '111', name: 'laugh', description: '黄胖小子咧嘴大笑' }]);
    const first = (await emojiDescriptions.list('g1'))[0];
    if (first === undefined) throw new Error('第一次写入没读回');

    await emojiDescriptions.putMany('g1', [{ emojiId: '111', name: 'laugh2', description: '换了名字的同一张脸' }]);

    expect(await countRows()).toBe(1);
    const items = await emojiDescriptions.list('g1');
    expect(items).toHaveLength(1);
    const second = items[0];
    if (second === undefined) throw new Error('覆盖写之后没读回');
    expect(second.emojiId).toBe('111');
    expect(second.name).toBe('laugh2');
    expect(second.description).toBe('换了名字的同一张脸');
    // ISO 定长且同格式，字符串比较即时间比较
    expect(second.updatedAt >= first.updatedAt).toBe(true);
  });

  it('一次 putMany 多条：整批一次写全，list 按 emoji_id 升序', async () => {
    const { emojiDescriptions } = makeRepos();

    // 故意乱序传入：排序由 SQL 的 ORDER BY 负责，不靠插入顺序
    await emojiDescriptions.putMany('g1', [
      { emojiId: '9', name: 'c', description: '第三张' },
      { emojiId: '10', name: 'b', description: '第二张' },
      { emojiId: '1', name: 'a', description: '第一张' },
    ]);

    expect(await countRows()).toBe(3);
    const items = await emojiDescriptions.list('g1');
    expect(items.map((item) => item.emojiId)).toEqual(['1', '10', '9']);
    expect(items.map((item) => item.name)).toEqual(['a', 'b', 'c']);
  });

  it('两个 guild 互不串：同 emoji id 各存各的，没写过的 guild 回 []', async () => {
    const { emojiDescriptions } = makeRepos();

    await emojiDescriptions.putMany('g1', [{ emojiId: '111', name: 'laugh', description: '公会一的描述' }]);
    await emojiDescriptions.putMany('g2', [{ emojiId: '111', name: 'laugh', description: '公会二的描述' }]);

    expect((await emojiDescriptions.list('g1')).map((item) => item.description)).toEqual(['公会一的描述']);
    expect((await emojiDescriptions.list('g2')).map((item) => item.description)).toEqual(['公会二的描述']);
    expect(await emojiDescriptions.list('g3')).toEqual([]);
    // 主键是 (guild_id, emoji_id)：同一个 emoji id 在两个 guild 里是两行
    expect(await countRows()).toBe(2);
  });

  // 选择「原样存」而不是「拒写」：仓储只管键与时间戳，内容口径由 callers 决定
  // （§23.4 的 parseDescribeOutput 已经把空描述丢掉，落库的都是非空；这里空串也能存，读侧见空串即当「没描述」）
  it('description 空串原样存：不拒写，读回来还是空串', async () => {
    const { emojiDescriptions } = makeRepos();

    await emojiDescriptions.putMany('g1', [{ emojiId: '111', name: 'laugh', description: '' }]);

    expect(await countRows()).toBe(1);
    const items = await emojiDescriptions.list('g1');
    expect(items).toEqual([{ emojiId: '111', name: 'laugh', description: '', updatedAt: expect.stringMatching(ISO_PATTERN) }]);
  });

  it('putMany 空数组是 no-op：不抛错也不写行', async () => {
    const { emojiDescriptions } = makeRepos();

    await emojiDescriptions.putMany('g1', []);

    expect(await countRows()).toBe(0);
    expect(await emojiDescriptions.list('g1')).toEqual([]);
  });
});
