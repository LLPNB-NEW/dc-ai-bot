import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelKey } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const KEY: ChannelKey = { guildId: 'g1', channelId: 'c1' };
const OTHER: ChannelKey = { guildId: 'g1', channelId: 'c2' };
const THIRD: ChannelKey = { guildId: 'g2', channelId: 'c1' };

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

async function countSettings(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_memory_settings').first<{ n: number }>();
  return row?.n ?? -1;
}

// 同一毫秒内写两次 updated_at 会相等：写前等 5ms，断言的「变大」才是被测行为而不是时钟运气
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM channel_memory_settings').run();
});

describe('ChannelMemoryStore.get', () => {
  it('没写过时返回 null（= 用代码默认 50 / 50，§26.2）', async () => {
    const { channelMemory } = makeRepos();
    expect(await channelMemory.get(KEY)).toBeNull();
  });

  it('put 后整行读回，updatedAt 由仓储补且非空', async () => {
    const { channelMemory } = makeRepos();
    const saved = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 80,
      summaryEveryMessages: 120,
    });

    // 键集必须刚好这六个：多一个少一个都说明窄化函数与契约跑偏了
    expect(saved).toEqual({
      guildId: 'g1',
      channelId: 'c1',
      historyMaxMessages: 80,
      summaryEveryMessages: 120,
      contextTool: false,
      updatedAt: saved.updatedAt,
    });
    expect(saved.updatedAt).not.toBe('');
    expect(await channelMemory.get(KEY)).toEqual(saved);
  });

  it('summaryEveryMessages = 0 原样存（0 = 关闭自动总结，§26.1）', async () => {
    const { channelMemory } = makeRepos();
    await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 2,
      summaryEveryMessages: 0,
    });
    expect(await channelMemory.get(KEY)).toMatchObject({ historyMaxMessages: 2, summaryEveryMessages: 0 });
  });

  it('按频道隔离：只读到本频道那一行', async () => {
    const { channelMemory } = makeRepos();
    await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 10,
      summaryEveryMessages: 20,
    });
    await channelMemory.put({
      guildId: OTHER.guildId,
      channelId: OTHER.channelId,
      historyMaxMessages: 30,
      summaryEveryMessages: 40,
    });

    expect(await channelMemory.get(KEY)).toMatchObject({ historyMaxMessages: 10, summaryEveryMessages: 20 });
    expect(await channelMemory.get(OTHER)).toMatchObject({ historyMaxMessages: 30, summaryEveryMessages: 40 });
  });
});

describe('ChannelMemoryStore.put', () => {
  it('同一频道重复 put 是覆盖写：两个数字都换掉，updatedAt 变大，只留一行', async () => {
    const { channelMemory } = makeRepos();
    const first = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
    });
    await tick();
    const second = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 100,
      summaryEveryMessages: 60,
    });

    expect(second.historyMaxMessages).toBe(100);
    expect(second.summaryEveryMessages).toBe(60);
    expect(second.updatedAt > first.updatedAt).toBe(true);
    expect(await channelMemory.get(KEY)).toEqual(second);
    expect(await countSettings()).toBe(1);
  });

  it('返回值就是落库那一行：不再查库也不会与 get 分叉', async () => {
    const { channelMemory } = makeRepos();
    const saved = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 500,
      summaryEveryMessages: 1,
    });
    expect(await channelMemory.get(KEY)).toStrictEqual(saved);
  });
});

describe('ChannelMemoryStore.list', () => {
  it('空表返回空数组', async () => {
    const { channelMemory } = makeRepos();
    expect(await channelMemory.list()).toEqual([]);
  });

  it('全表按 guild_id、channel_id 升序：与插入顺序无关', async () => {
    const { channelMemory } = makeRepos();
    // 故意倒着写：排序必须是 SQL 保证的，不能靠写入顺序碰运气
    const g2c1 = await channelMemory.put({
      guildId: THIRD.guildId,
      channelId: THIRD.channelId,
      historyMaxMessages: 31,
      summaryEveryMessages: 32,
    });
    const g1c2 = await channelMemory.put({
      guildId: OTHER.guildId,
      channelId: OTHER.channelId,
      historyMaxMessages: 21,
      summaryEveryMessages: 22,
    });
    const g1c1 = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 11,
      summaryEveryMessages: 12,
    });

    expect(await channelMemory.list()).toEqual([g1c1, g1c2, g2c1]);
  });

  it('显式列名不漏列：每行与 get 读到的同一行逐字相等', async () => {
    const { channelMemory } = makeRepos();
    await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 70,
      summaryEveryMessages: 90,
    });

    expect(await channelMemory.list()).toEqual([await channelMemory.get(KEY)]);
  });
});

describe('ChannelMemoryStore 的摘要注入预算（§26.4）', () => {
  it('存 1200 读回 1200：get 与 list 都带上这个字段', async () => {
    const { channelMemory } = makeRepos();
    const saved = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 80,
      summaryEveryMessages: 20,
      summaryMaxChars: 1200,
    });

    expect(saved.summaryMaxChars).toBe(1200);
    expect(await channelMemory.get(KEY)).toMatchObject({ summaryMaxChars: 1200 });
    expect(await channelMemory.list()).toMatchObject([{ summaryMaxChars: 1200 }]);
  });

  it('存 0 与不传等价：列里落 0，读回来不带这个字段', async () => {
    const { channelMemory } = makeRepos();
    const zero = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 80,
      summaryEveryMessages: 20,
      summaryMaxChars: 0,
    });
    const plain = await channelMemory.put({
      guildId: OTHER.guildId,
      channelId: OTHER.channelId,
      historyMaxMessages: 80,
      summaryEveryMessages: 20,
    });

    // 0 与缺省都不建键：上层只看「有没有这个字段」，不必再做一次 > 0 判断
    expect('summaryMaxChars' in zero).toBe(false);
    expect('summaryMaxChars' in plain).toBe(false);
    // 列是 NOT NULL：两行都得真的写进 0，不能指望 NULL 兜底
    const rows = await env.DB.prepare('SELECT summary_max_chars AS n FROM channel_memory_settings ORDER BY channel_id ASC').all<{ n: number }>();
    expect(rows.results).toEqual([{ n: 0 }, { n: 0 }]);
    expect(await channelMemory.get(KEY)).not.toHaveProperty('summaryMaxChars');
  });

  it('覆盖写会清掉旧预算：先存 1200，再存不传该字段，列回到 0', async () => {
    const { channelMemory } = makeRepos();
    await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 80,
      summaryEveryMessages: 20,
      summaryMaxChars: 1200,
    });
    const second = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 80,
      summaryEveryMessages: 20,
    });

    // ON CONFLICT 那一支也必须写这一列，否则旧预算会留在行上继续生效
    expect('summaryMaxChars' in second).toBe(false);
    const row = await env.DB.prepare('SELECT summary_max_chars AS n FROM channel_memory_settings WHERE guild_id = ? AND channel_id = ?')
      .bind(KEY.guildId, KEY.channelId)
      .first<{ n: number }>();
    expect(row).toEqual({ n: 0 });
    expect(await channelMemory.get(KEY)).not.toHaveProperty('summaryMaxChars');
  });
});

describe('ChannelMemoryStore 的上下文工具模式（§55）', () => {
  it('不传 = 关：列里落 0，put / get / list 三处都是 false', async () => {
    const { channelMemory } = makeRepos();
    const saved = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
    });

    expect(saved.contextTool).toBe(false);
    // 列是 NOT NULL DEFAULT 0：省略这个字段也得真写进 0，不能指望 NULL 兜底
    const rows = await env.DB.prepare('SELECT context_tool AS n FROM channel_memory_settings').all<{ n: number }>();
    expect(rows.results).toEqual([{ n: 0 }]);
    expect(await channelMemory.get(KEY)).toMatchObject({ contextTool: false });
    expect(await channelMemory.list()).toMatchObject([{ contextTool: false }]);
  });

  it('存 true 读回 true：列里是 1，get / list 与 put 的返回值一致', async () => {
    const { channelMemory } = makeRepos();
    const saved = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 50,
      summaryEveryMessages: 0,
      contextTool: true,
    });

    expect(saved.contextTool).toBe(true);
    const row = await env.DB.prepare('SELECT context_tool AS n FROM channel_memory_settings WHERE guild_id = ? AND channel_id = ?')
      .bind(KEY.guildId, KEY.channelId)
      .first<{ n: number }>();
    expect(row).toEqual({ n: 1 });
    expect(await channelMemory.get(KEY)).toEqual(saved);
    expect(await channelMemory.list()).toEqual([saved]);
  });

  it('覆盖写会关掉旧开关：先存 true，再省略该字段，列回到 0', async () => {
    const { channelMemory } = makeRepos();
    await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
      contextTool: true,
    });
    const second = await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
    });

    // ON CONFLICT 那一支也必须写这一列，否则旧开关会留在行上继续生效
    expect(second.contextTool).toBe(false);
    const row = await env.DB.prepare('SELECT context_tool AS n FROM channel_memory_settings WHERE guild_id = ? AND channel_id = ?')
      .bind(KEY.guildId, KEY.channelId)
      .first<{ n: number }>();
    expect(row).toEqual({ n: 0 });
    expect(await channelMemory.get(KEY)).toMatchObject({ contextTool: false });
  });
});

describe('ChannelMemoryStore.remove', () => {
  it('remove 后 get 返回 null，且只删自己那条', async () => {
    const { channelMemory } = makeRepos();
    await channelMemory.put({
      guildId: KEY.guildId,
      channelId: KEY.channelId,
      historyMaxMessages: 10,
      summaryEveryMessages: 20,
    });
    await channelMemory.put({
      guildId: OTHER.guildId,
      channelId: OTHER.channelId,
      historyMaxMessages: 30,
      summaryEveryMessages: 40,
    });

    await channelMemory.remove(KEY);
    expect(await channelMemory.get(KEY)).toBeNull();
    expect(await channelMemory.get(OTHER)).not.toBeNull();
    expect(await countSettings()).toBe(1);
  });

  it('remove 不存在的行时静默成功（= 恢复默认，不抛错）', async () => {
    const { channelMemory } = makeRepos();
    await expect(channelMemory.remove(KEY)).resolves.toBeUndefined();
    await expect(channelMemory.remove(KEY)).resolves.toBeUndefined();
    expect(await countSettings()).toBe(0);
    expect(await channelMemory.get(KEY)).toBeNull();
  });
});
