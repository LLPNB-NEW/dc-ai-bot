import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EmojiAlias } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

// §24.3 的存储层语义：emoji_aliases 的读写口径（四条管理路由见 test/admin.crud.test.ts）

const MASTER_KEY = toBase64(new Uint8Array(32).fill(13));

// ISO 8601（nowIso 就是 Date#toISOString 的形状）：created_at 由仓储补，调用方不传
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const LAUGH = '150000000000000003';
const CRY = '150000000000000004';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

async function countRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM emoji_aliases').first<{ n: number }>();
  return row?.n ?? 0;
}

async function createdAtOf(guildId: string, alias: string): Promise<string> {
  const row = await env.DB.prepare('SELECT created_at FROM emoji_aliases WHERE guild_id = ? AND alias = ?')
    .bind(guildId, alias)
    .first<{ created_at: string }>();
  return row?.created_at ?? '';
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM emoji_aliases').run();
});

describe('emoji_aliases 仓储', () => {
  it('空表 list 回 []', async () => {
    expect(await countRows()).toBe(0);
    expect(await makeRepos().emojiAliases.list('g1')).toEqual([]);
  });

  it('put 后 list 读回：三个字段都在，created_at 是写入时刻的 ISO', async () => {
    const { emojiAliases } = makeRepos();
    const before = Date.now();
    const entry: EmojiAlias = { alias: '奶龙', emojiId: LAUGH, emojiName: 'laugh' };

    await emojiAliases.put('g1', entry);

    const items = await emojiAliases.list('g1');
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) throw new Error('list 没读回刚写的行');

    // 白名单形状：guild_id / created_at 这类内部列不能漏进上层
    expect(Object.keys(item).sort()).toEqual(['alias', 'emojiId', 'emojiName']);
    expect(item).toEqual({ alias: '奶龙', emojiId: LAUGH, emojiName: 'laugh' });

    const createdAt = await createdAtOf('g1', '奶龙');
    expect(createdAt).toMatch(ISO_PATTERN);
    const writtenAt = Date.parse(createdAt);
    expect(Number.isNaN(writtenAt)).toBe(false);
    expect(writtenAt).toBeGreaterThanOrEqual(before);
    expect(writtenAt).toBeLessThanOrEqual(Date.now());
  });

  it('同别名重复 put：只换指向，不新增行，created_at 保持不变', async () => {
    const { emojiAliases } = makeRepos();

    await emojiAliases.put('g1', { alias: '奶龙', emojiId: LAUGH, emojiName: 'laugh' });
    const firstCreatedAt = await createdAtOf('g1', '奶龙');
    // 隔开几毫秒：时间戳同毫秒也「相等」，分不开是仓储没重写还是碰巧同刻
    await new Promise((resolve) => setTimeout(resolve, 5));

    await emojiAliases.put('g1', { alias: '奶龙', emojiId: CRY, emojiName: 'cry' });

    expect(await countRows()).toBe(1);
    expect(await emojiAliases.list('g1')).toEqual([{ alias: '奶龙', emojiId: CRY, emojiName: 'cry' }]);
    // ON CONFLICT 里没有 created_at：改指向不该洗掉「什么时候配的」
    expect(await createdAtOf('g1', '奶龙')).toBe(firstCreatedAt);
  });

  it('remove 后 list 为空；remove 不存在的别名静默成功', async () => {
    const { emojiAliases } = makeRepos();

    await emojiAliases.put('g1', { alias: '奶龙', emojiId: LAUGH, emojiName: 'laugh' });
    await emojiAliases.remove('g1', '奶龙');

    expect(await countRows()).toBe(0);
    expect(await emojiAliases.list('g1')).toEqual([]);

    // 后台连点两下删除：第二次命中 0 行也不能抛
    await expect(emojiAliases.remove('g1', '奶龙')).resolves.toBeUndefined();
    await expect(emojiAliases.remove('g1', '从没配过的别名')).resolves.toBeUndefined();
    expect(await countRows()).toBe(0);
  });

  it('list 按 alias 升序：排序由 SQL 负责，不靠插入顺序', async () => {
    const { emojiAliases } = makeRepos();

    await emojiAliases.put('g1', { alias: 'c', emojiId: '3', emojiName: 'ccc' });
    await emojiAliases.put('g1', { alias: 'a', emojiId: '1', emojiName: 'aaa' });
    await emojiAliases.put('g1', { alias: 'b', emojiId: '2', emojiName: 'bbb' });

    expect((await emojiAliases.list('g1')).map((item) => item.alias)).toEqual(['a', 'b', 'c']);
  });

  it('两个 guild 互不串：同名别名各指各的，没写过的 guild 回 []', async () => {
    const { emojiAliases } = makeRepos();

    await emojiAliases.put('g1', { alias: '奶龙', emojiId: LAUGH, emojiName: 'laugh' });
    await emojiAliases.put('g2', { alias: '奶龙', emojiId: CRY, emojiName: 'cry' });

    expect(await emojiAliases.list('g1')).toEqual([{ alias: '奶龙', emojiId: LAUGH, emojiName: 'laugh' }]);
    expect(await emojiAliases.list('g2')).toEqual([{ alias: '奶龙', emojiId: CRY, emojiName: 'cry' }]);
    expect(await emojiAliases.list('g3')).toEqual([]);
    // 主键是 (guild_id, alias)：同一个别名在两个 guild 里是两行
    expect(await countRows()).toBe(2);

    // remove 只按本 guild 命中
    await emojiAliases.remove('g1', '奶龙');
    expect(await emojiAliases.list('g1')).toEqual([]);
    expect(await emojiAliases.list('g2')).toHaveLength(1);
  });
});
