import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry, LogLevel, LogScope } from '../src/core/types';
import { DEFAULT_LOG_KEEP, createLogStore } from '../src/workers/db/log-store';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function entry(message: string, level: LogLevel = 'info', scope: LogScope = 'chat'): LogEntry {
  return { level, scope, message, createdAt: CREATED_AT };
}

// 迁移由 test/setup.ts 的 beforeAll 统一 apply，这里不再自己 apply
async function countRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM runtime_logs').first<{ n: number }>();
  return row?.n ?? -1;
}

async function maxId(): Promise<number> {
  const row = await env.DB.prepare('SELECT MAX(id) AS id FROM runtime_logs').first<{ id: number | null }>();
  return row?.id ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM runtime_logs').run();
});

describe('createLogStore', () => {
  it('默认保留 800 条，0005 迁移已生效', async () => {
    expect(DEFAULT_LOG_KEEP).toBe(800);
    expect(await countRows()).toBe(0);
  });

  it('append → list：id 升序、created_at 映射成 createdAt、只暴露五列', async () => {
    const store = createLogStore(env.DB);
    await store.append([entry('第一条'), entry('第二条', 'warn', 'provider'), entry('第三条', 'error', 'admin')]);

    const rows = await store.list(0, 10);
    expect(rows.map((row) => row.message)).toEqual(['第一条', '第二条', '第三条']);
    expect(rows.map((row) => row.level)).toEqual(['info', 'warn', 'error']);
    expect(rows.map((row) => row.scope)).toEqual(['chat', 'provider', 'admin']);
    expect(rows.map((row) => row.createdAt)).toEqual([CREATED_AT, CREATED_AT, CREATED_AT]);

    const ids = rows.map((row) => row.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(ids.at(-1)).toBe(await maxId());
    // 显式列名 + 显式映射：多一个字段都不该漏出去
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'level', 'message', 'scope']);
  });

  it('after 是 id 游标、limit 是 SQL LIMIT', async () => {
    const store = createLogStore(env.DB);
    await store.append([entry('a'), entry('b'), entry('c'), entry('d')]);
    const ids = (await store.list(0, 10)).map((row) => row.id);

    expect((await store.list(ids[0] ?? 0, 10)).map((row) => row.message)).toEqual(['b', 'c', 'd']);
    expect((await store.list(ids[1] ?? 0, 10)).map((row) => row.message)).toEqual(['c', 'd']);
    expect(await store.list(ids.at(-1) ?? 0, 10)).toEqual([]);
    expect((await store.list(0, 2)).map((row) => row.message)).toEqual(['a', 'b']);
  });

  it('单次 append 超出 keep 时同批 prune 掉最旧的，行数落在 keep', async () => {
    const store = createLogStore(env.DB, 3);
    await store.append([entry('a'), entry('b'), entry('c'), entry('d'), entry('e')]);

    expect(await countRows()).toBe(3);
    expect((await store.list(0, 10)).map((row) => row.message)).toEqual(['c', 'd', 'e']);
  });

  it('多次 append 累积也不会超过 keep', async () => {
    const store = createLogStore(env.DB, 3);
    for (const message of ['a', 'b', 'c', 'd', 'e']) await store.append([entry(message)]);

    expect(await countRows()).toBe(3);
    expect((await store.list(0, 10)).map((row) => row.message)).toEqual(['c', 'd', 'e']);
  });

  it('append 空数组不动表', async () => {
    const store = createLogStore(env.DB);
    await store.append([entry('唯一一条')]);
    await store.append([]);

    expect(await countRows()).toBe(1);
  });

  it('写入 900 条后表里只剩 800 条，且 id 最大的那条仍在', async () => {
    const store = createLogStore(env.DB);
    for (let round = 0; round < 9; round += 1) {
      await store.append(Array.from({ length: 100 }, (_unused, index) => entry('bulk-' + (round * 100 + index))));
    }

    expect(await countRows()).toBe(800);
    const rows = await store.list(0, 1000);
    expect(rows).toHaveLength(800);
    // 正好丢掉最旧的 100 条（bulk-0 … bulk-99），留下 bulk-100 … bulk-899
    expect(rows.map((row) => row.message)).toEqual(Array.from({ length: 800 }, (_unused, index) => 'bulk-' + (index + 100)));

    const firstId = rows.at(0)?.id ?? -1;
    const lastId = rows.at(-1)?.id ?? -1;
    expect(lastId - firstId).toBe(799);      // 留下的是连续的一段，不是随机/全清
    expect(lastId).toBe(await maxId());      // AUTOINCREMENT：最大 id 没被删掉，游标不回退
  });
});
