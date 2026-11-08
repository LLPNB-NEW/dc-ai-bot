import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelKey, ChatMessage, ConversationSummary } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const KEY: ChannelKey = { guildId: 'g1', channelId: 'c1' };
const OTHER: ChannelKey = { guildId: 'g1', channelId: 'c2' };

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

async function countSummaries(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM conversation_summaries').first<{ n: number }>();
  return row?.n ?? -1;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM messages').run();
  await env.DB.prepare('DELETE FROM conversation_summaries').run();
});

describe('ConversationStore.loadBetween', () => {
  const at = (content: string, createdAt: string): ChatMessage => ({
    role: 'user',
    content,
    author: '小明',
    createdAt,
  });
  const FROM = '2026-10-25T14:00:00.000Z';
  const TO = '2026-10-25T15:00:00.000Z';

  it('两个端点都含进去、按 id 升序、limit 生效', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      at('太早', '2026-10-25T13:59:00.000Z'),
      at('起点', FROM),
      at('中间', '2026-10-25T14:30:00.000Z'),
      at('终点', TO),
      at('太晚', '2026-10-25T15:01:00.000Z'),
    ]);

    const rows = await conversations.loadBetween(KEY, FROM, TO, 10);
    expect(rows.map((row) => row.content)).toEqual(['起点', '中间', '终点']);
    // 行映射跟 loadAfter 同一套：createdAt/author 都得带出来
    expect(rows[0]?.createdAt).toBe(FROM);
    expect(rows[0]?.author).toBe('小明');
    const ids = rows.map((row) => row.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);

    const limited = await conversations.loadBetween(KEY, FROM, TO, 2);
    expect(limited.map((row) => row.content)).toEqual(['起点', '中间']);
  });

  it('跨频道不串：同一个服另一个频道落在同一时间段也不混进来', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [at('本频道', '2026-10-25T14:10:00.000Z')]);
    await conversations.append(OTHER, [at('别的频道', '2026-10-25T14:20:00.000Z')]);

    const rows = await conversations.loadBetween(KEY, FROM, TO, 10);
    expect(rows.map((row) => row.content)).toEqual(['本频道']);
  });

  it('范围外一条都没有时回空数组', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [at('太早', '2026-10-25T13:00:00.000Z')]);

    expect(await conversations.loadBetween(KEY, FROM, TO, 10)).toEqual([]);
  });
});

describe('ConversationStore.loadAfter', () => {
  it('只取 id 大于游标的消息，按时间正序', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '第一句', author: '小明', authorId: 'u-llp' },
      { role: 'assistant', content: '第二句', author: '示例机器人' },
      { role: 'user', content: '第三句', author: '小明', authorId: 'u-llp' },
    ]);

    const all = await conversations.loadAfter(KEY, 0);
    expect(all.map((message) => message.content)).toEqual(['第一句', '第二句', '第三句']);
    const ids = all.map((message) => message.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);

    const after = await conversations.loadAfter(KEY, ids[1]!);
    expect(after.map((message) => message.content)).toEqual(['第三句']);

    expect(await conversations.loadAfter(KEY, ids[2]!)).toEqual([]);
  });

  it('支持 limit，且 limit 作用在游标之后的结果上', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '一' },
      { role: 'user', content: '二' },
      { role: 'user', content: '三' },
    ]);

    const limited = await conversations.loadAfter(KEY, 0, 2);
    expect(limited.map((message) => message.content)).toEqual(['一', '二']);

    const all = await conversations.loadAfter(KEY, 0);
    const tail = await conversations.loadAfter(KEY, all[0]!.id, 1);
    expect(tail.map((message) => message.content)).toEqual(['二']);
  });

  it('不跨频道：同一 guild 的其他 channel 不参与游标', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [{ role: 'user', content: '本频道' }]);
    await conversations.append(OTHER, [{ role: 'user', content: '别的频道' }]);

    const rows = await conversations.loadAfter(KEY, 0);
    expect(rows.map((message) => message.content)).toEqual(['本频道']);
  });

  it('带回 id 与署名，供摘要游标和 transcript 使用', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [{ role: 'user', content: '在吗', author: '小明', authorId: 'u-llp' }]);
    await conversations.append(KEY, [{ role: 'assistant', content: '在', author: '示例机器人' }]);

    const rows = await conversations.loadAfter(KEY, 0);
    expect(rows[0]).toMatchObject({
      role: 'user',
      content: '在吗',
      author: '小明',
      authorId: 'u-llp',
    });
    expect(typeof rows[0]?.id).toBe('number');
    expect(rows[1]).toMatchObject({ role: 'assistant', content: '在', author: '示例机器人' });
    expect(rows[1]?.authorId).toBeUndefined();
  });
});

describe('ConversationStore.loadLatest', () => {
  it('空表返回空数组', async () => {
    const { conversations } = makeRepos();
    expect(await conversations.loadLatest(KEY, 10)).toEqual([]);
  });

  it('取最新 N 条并翻成正序：id 升序，且与 loadAfter 的同一批行完全一致', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '一' },
      { role: 'user', content: '二' },
      { role: 'user', content: '三' },
      { role: 'user', content: '四', author: '小明', authorId: 'u-llp' },
    ]);

    const latest = await conversations.loadLatest(KEY, 2);
    expect(latest.map((message) => message.content)).toEqual(['三', '四']);
    const ids = latest.map((message) => message.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(latest[1]).toMatchObject({ role: 'user', author: '小明', authorId: 'u-llp' });
    expect(typeof latest[1]?.id).toBe('number');

    // 列清单与 loadAfter 同源：同一批行读回来必须逐字相等，漏列会在这里露陷
    const all = await conversations.loadAfter(KEY, 0);
    expect(latest).toEqual(all.slice(-2));
  });

  it('limit 边界：够大取全部、1 只取最新、0 取空', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '一' },
      { role: 'user', content: '二' },
      { role: 'user', content: '三' },
    ]);

    const all = await conversations.loadLatest(KEY, 99);
    expect(all.map((message) => message.content)).toEqual(['一', '二', '三']);

    const newest = await conversations.loadLatest(KEY, 1);
    expect(newest.map((message) => message.content)).toEqual(['三']);

    // 后台楼层点选可能传 0：SQL 的 LIMIT 0 就是空，仓储层不加业务判断
    expect(await conversations.loadLatest(KEY, 0)).toEqual([]);
  });

  it('不跨频道：只取本频道最新几条', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [{ role: 'user', content: '本频道一' }]);
    await conversations.append(OTHER, [{ role: 'user', content: '别的频道' }]);

    const rows = await conversations.loadLatest(KEY, 10);
    expect(rows.map((message) => message.content)).toEqual(['本频道一']);
  });
});

describe('ConversationStore：时间序以 created_at 为准（门牌 summary-order-2）', () => {
  // 回灌进来的历史行：写入最晚、created_at 最早——这一段里 id 序与时间序是反的
  const T_EARLY = '2026-10-27T02:00:00.000Z';
  const T_LATE = '2026-10-28T10:41:29.184Z';
  const T_LATEST = '2026-10-28T12:00:00.000Z';

  /** 先写「晚」「更晚」两条，再补一条「早」的：id 更大的行，时间反而更早 */
  async function seedLateThenEarly() {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '晚', createdAt: T_LATE },
      { role: 'user', content: '更晚', createdAt: T_LATEST },
    ]);
    await conversations.append(KEY, [{ role: 'user', content: '早', createdAt: T_EARLY }]);
    // id 是 AUTOINCREMENT，绝对数字不写死；按内容认行
    const seeded = await conversations.loadAfter(KEY, 0);
    const idOf = (content: string): number => {
      const hit = seeded.find((message) => message.content === content);
      return hit === undefined ? -1 : hit.id;
    };
    return { conversations, idOf };
  }

  it('loadBetween 按 created_at 升序返回（同值时 id 破平），不是 id 序', async () => {
    const { conversations } = await seedLateThenEarly();

    const rows = await conversations.loadBetween(KEY, T_EARLY, T_LATEST, 10);

    expect(rows.map((row) => row.content)).toEqual(['早', '晚', '更晚']);
    expect(rows.map((row) => row.createdAt)).toEqual([T_EARLY, T_LATE, T_LATEST]);
    // 头一条就是「后写入的那条」：id 最大、时间最早
    expect(rows[0]?.id).toBe(Math.max(...rows.map((row) => row.id)));
  });

  it('loadAfter 按 created_at 升序返回，过滤条件仍是 id > 游标', async () => {
    const { conversations, idOf } = await seedLateThenEarly();

    const all = await conversations.loadAfter(KEY, 0);
    expect(all.map((message) => message.content)).toEqual(['早', '晚', '更晚']);
    // 游标语义没变：过滤按 id 走（「早」id 最大、时间最早）
    expect(idOf('早')).toBe(Math.max(...all.map((message) => message.id)));
    const after = await conversations.loadAfter(KEY, idOf('晚'));
    expect(after.map((message) => message.content)).toEqual(['早', '更晚']);
    expect(await conversations.loadAfter(KEY, idOf('早'))).toEqual([]);
  });

  it('loadLatest / loadRecent 的时间升序末条是时间最新的那条，不是 id 最大的那条', async () => {
    const { conversations } = await seedLateThenEarly();

    const latest = await conversations.loadLatest(KEY, 3);
    expect(latest.map((message) => message.content)).toEqual(['早', '晚', '更晚']);
    expect(latest[latest.length - 1]?.content).toBe('更晚');

    const recent = await conversations.loadRecent(KEY, 3);
    expect(recent.map((message) => message.content)).toEqual(['早', '晚', '更晚']);
    expect(recent[recent.length - 1]?.content).toBe('更晚');

    // 只要最新一条：id 最大的那条（「早」）必须被排除在外
    expect((await conversations.loadLatest(KEY, 1)).map((message) => message.content)).toEqual(['更晚']);
    expect((await conversations.loadRecent(KEY, 1)).map((message) => message.content)).toEqual(['更晚']);
  });
});

describe('SummaryStore', () => {
  const entry: ConversationSummary = {
    guildId: KEY.guildId,
    channelId: KEY.channelId,
    summary: '他喜欢猫，讨厌早起。',
    coveredUntilId: 7,
    updatedAt: '2026-10-25T00:00:00.000Z',
  };

  it('没写过时 get 返回 null', async () => {
    const { summaries } = makeRepos();
    expect(await summaries.get(KEY)).toBeNull();
  });

  it('put 后能原样读回', async () => {
    const { summaries } = makeRepos();
    await summaries.put(entry);
    expect(await summaries.get(KEY)).toEqual(entry);
  });

  it('同一频道重复 put 是覆盖写：游标前进且只留一行', async () => {
    const { summaries } = makeRepos();
    await summaries.put(entry);
    const next: ConversationSummary = {
      ...entry,
      summary: '他喜欢猫，讨厌早起，正在准备考试。',
      coveredUntilId: 15,
      updatedAt: '2026-10-25T01:00:00.000Z',
    };
    await summaries.put(next);

    expect(await summaries.get(KEY)).toEqual(next);
    expect(await countSummaries()).toBe(1);
  });

  it('覆盖时间段往返：写进 covered_from/covered_to，读回来一字不差', async () => {
    const { summaries } = makeRepos();
    const spanned: ConversationSummary = {
      ...entry,
      coveredFrom: '2026-10-25T14:40:00.000Z',
      coveredTo: '2026-10-25T23:59:00.000Z',
    };
    await summaries.put(spanned);

    expect(await summaries.get(KEY)).toEqual(spanned);

    // 没有时间段的老形状仍读得回来，且不凭空多出两个空串键
    const plain: ConversationSummary = { ...entry, coveredUntilId: 9 };
    await summaries.put(plain);
    const back = await summaries.get(KEY);
    expect(back).toEqual(plain);
    expect(back !== null && 'coveredFrom' in back).toBe(false);
  });

  it('按频道隔离，remove 只删自己那条', async () => {
    const { summaries } = makeRepos();
    const other: ConversationSummary = { ...entry, channelId: OTHER.channelId, summary: '别的频道' };
    await summaries.put(entry);
    await summaries.put(other);

    expect((await summaries.get(KEY))?.summary).toBe(entry.summary);
    expect((await summaries.get(OTHER))?.summary).toBe('别的频道');

    await summaries.remove(KEY);
    expect(await summaries.get(KEY)).toBeNull();
    expect((await summaries.get(OTHER))?.summary).toBe('别的频道');

    await summaries.remove(KEY);
    expect(await summaries.get(KEY)).toBeNull();
  });
});

describe('SummaryStore.list', () => {
  const THIRD: ChannelKey = { guildId: 'g2', channelId: 'c1' };

  function summaryAt(key: ChannelKey, summary: string, coveredUntilId: number): ConversationSummary {
    return {
      guildId: key.guildId,
      channelId: key.channelId,
      summary,
      coveredUntilId,
      updatedAt: '2026-10-25T00:00:00.000Z',
    };
  }

  it('空表返回空数组', async () => {
    const { summaries } = makeRepos();
    expect(await summaries.list()).toEqual([]);
  });

  it('全表按 guild_id、channel_id 升序：与插入顺序无关', async () => {
    const { summaries } = makeRepos();
    const g1c1 = summaryAt(KEY, 'g1c1', 1);
    const g1c2 = summaryAt(OTHER, 'g1c2', 2);
    const g2c1 = summaryAt(THIRD, 'g2c1', 3);

    // 故意倒着写：排序必须是 SQL 保证的，不能靠写入顺序碰运气
    await summaries.put(g2c1);
    await summaries.put(g1c2);
    await summaries.put(g1c1);

    expect(await summaries.list()).toEqual([g1c1, g1c2, g2c1]);
  });

  it('显式列名不漏列：每行与 get 读到的同一行逐字相等', async () => {
    const { summaries } = makeRepos();
    const entry = summaryAt(KEY, '他喜欢猫，讨厌早起。', 7);
    await summaries.put(entry);

    expect(await summaries.list()).toEqual([await summaries.get(KEY)]);
  });
});

