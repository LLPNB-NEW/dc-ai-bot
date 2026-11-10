import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SqlDatabase, SqlStatement } from '../src/core/db/sql';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const secretBox = createSecretBox(MASTER_KEY);

/** 批次里的一条语句：假库不执行 SQL，只留下面试断言用的 sql 与绑定值 */
interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function recordingDb(loadRows: unknown[] = []): { db: SqlDatabase; batches: RecordedStatement[][] } {
  const batches: RecordedStatement[][] = [];
  const statement = (sql: string, values: unknown[]): SqlStatement & RecordedStatement => ({
    sql,
    values,
    bind: (...next: unknown[]) => statement(sql, next),
    // 读侧只走 all()；first()/run() 凑接口用，调用即视为没数据
    all: <T>(): Promise<{ results: T[] }> => Promise.resolve({ results: loadRows as T[] }),
    first: <T>(): Promise<T | null> => Promise.resolve(null),
    run: (): Promise<unknown> => Promise.resolve(undefined),
  });
  const db: SqlDatabase = {
    prepare: (sql: string) => statement(sql, []),
    batch: (statements: SqlStatement[]) => {
      batches.push(statements.map((item) => item as unknown as RecordedStatement));
      return Promise.resolve([]);
    },
  };
  return { db, batches };
}

const SAVE_DELETE = 'DELETE FROM world_book_state WHERE guild_id = ? AND channel_id = ?';

describe('worldBookState：发行语句的形状', () => {
  it('save([]) 只发一条按频道删的 DELETE，不多发 INSERT', async () => {
    const { db, batches } = recordingDb();
    await createRepositories(db, secretBox).worldBookState.save('', 'c1', []);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((item) => item.sql)).toEqual([SAVE_DELETE]);
    expect(batches[0]?.[0]?.values).toEqual(['', 'c1']);
  });

  it('save(rows) 整份覆盖：先 DELETE 再逐条 INSERT，同一批、同一次 updated_at，记账键带 book_id', async () => {
    const { db, batches } = recordingDb();
    await createRepositories(db, secretBox).worldBookState.save('g1', 'c1', [
      { bookId: 'book-a', entryId: 3, stickyUntil: 10, cooldownUntil: 0 },
      { bookId: 'book-b', entryId: 3, stickyUntil: 0, cooldownUntil: 12 },
    ]);

    expect(batches).toHaveLength(1);
    const [deleted, first, second] = batches[0] ?? [];
    expect(deleted?.sql).toBe(SAVE_DELETE);
    expect(deleted?.values).toEqual(['g1', 'c1']);
    expect(first?.sql).toBe(
      'INSERT INTO world_book_state (guild_id, channel_id, book_id, entry_id, sticky_until, cooldown_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    // 两本书都有 id=3 的条目：只差 book_id，绑定值必须各写各的
    expect(first?.values.slice(0, 6)).toEqual(['g1', 'c1', 'book-a', 3, 10, 0]);
    expect(second?.values.slice(0, 6)).toEqual(['g1', 'c1', 'book-b', 3, 0, 12]);
    // 一批一个事务：两个 INSERT 的 updated_at 必须是同一个时刻
    expect(typeof first?.values[6]).toBe('string');
    expect(second?.values[6]).toBe(first?.values[6]);
  });

  it('save 跳过没有 bookId 的行：旧调用点不会被写成空 book_id', async () => {
    const { db, batches } = recordingDb();
    await createRepositories(db, secretBox).worldBookState.save('g1', 'c1', [
      { bookId: '', entryId: 1, stickyUntil: 1, cooldownUntil: 0 },
      { bookId: 'book-a', entryId: 2, stickyUntil: 2, cooldownUntil: 0 },
    ]);

    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[1]?.values.slice(0, 4)).toEqual(['g1', 'c1', 'book-a', 2]);
  });

  it('load 把 entry_id 转成数字，非有限值的行整条丢弃，粘性/冷却脏值落回 0', async () => {
    const { db } = recordingDb([
      { book_id: 'book-a', entry_id: 3, sticky_until: 11, cooldown_until: 0 },
      { book_id: 'book-b', entry_id: 'bad', sticky_until: 1, cooldown_until: 2 },
      { book_id: 'book-b', entry_id: 5, sticky_until: null, cooldown_until: 9 },
    ]);
    const rows = await createRepositories(db, secretBox).worldBookState.load('', 'c1');

    expect(rows).toEqual([
      { bookId: 'book-a', entryId: 3, stickyUntil: 11, cooldownUntil: 0 },
      { bookId: 'book-b', entryId: 5, stickyUntil: 0, cooldownUntil: 9 },
    ]);
  });
});

const KEY = { guildId: 'g1', channelId: 'c1' };

describe('worldBookState：真实 D1 往返', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM world_book_state').run();
    await env.DB.prepare('DELETE FROM messages').run();
    await env.DB.prepare('DELETE FROM world_books').run();
  });

  it('按频道各存一份：私聊的 guildId 是空串，整份覆盖后多出来的条目一条不留', async () => {
    const { worldBookState } = createRepositories(env.DB, secretBox);

    // 私聊（guild_id 空串）与服务器频道即使 channel_id 同名也互不影响
    await worldBookState.save('', 'c1', [{ bookId: 'book-a', entryId: 1, stickyUntil: 5, cooldownUntil: 0 }]);
    await worldBookState.save('g1', 'c1', [
      { bookId: 'book-a', entryId: 2, stickyUntil: 0, cooldownUntil: 9 },
      { bookId: 'book-a', entryId: 4, stickyUntil: 7, cooldownUntil: 0 },
    ]);

    expect(await worldBookState.load('', 'c1')).toEqual([{ bookId: 'book-a', entryId: 1, stickyUntil: 5, cooldownUntil: 0 }]);
    // 固定按 (book_id, entry_id) 升序回来
    expect(await worldBookState.load('g1', 'c1')).toEqual([
      { bookId: 'book-a', entryId: 2, stickyUntil: 0, cooldownUntil: 9 },
      { bookId: 'book-a', entryId: 4, stickyUntil: 7, cooldownUntil: 0 },
    ]);
    expect(await worldBookState.load('g1', 'other')).toEqual([]);

    // 整份覆盖：第二次只给一条，entry 2 必须消失
    await worldBookState.save('g1', 'c1', [{ bookId: 'book-a', entryId: 4, stickyUntil: 8, cooldownUntil: 0 }]);
    expect(await worldBookState.load('g1', 'c1')).toEqual([{ bookId: 'book-a', entryId: 4, stickyUntil: 8, cooldownUntil: 0 }]);
    // 私聊那份没被这次写碰到
    expect(await worldBookState.load('', 'c1')).toHaveLength(1);

    // save([]) 落到真库上也只清空这一个频道
    await worldBookState.save('g1', 'c1', []);
    expect(await worldBookState.load('g1', 'c1')).toEqual([]);
    expect(await worldBookState.load('', 'c1')).toHaveLength(1);
  });

  it('同一层的两本书各有一条 id=1：粘性与冷却按 (bookId, entryId) 各记各的，互不串账', async () => {
    const { worldBookState } = createRepositories(env.DB, secretBox);

    await worldBookState.save('g1', 'c1', [
      { bookId: 'book-dragon', entryId: 1, stickyUntil: 100, cooldownUntil: 0 },
      { bookId: 'book-whale', entryId: 1, stickyUntil: 0, cooldownUntil: 200 },
    ]);

    expect(await worldBookState.load('g1', 'c1')).toEqual([
      { bookId: 'book-dragon', entryId: 1, stickyUntil: 100, cooldownUntil: 0 },
      { bookId: 'book-whale', entryId: 1, stickyUntil: 0, cooldownUntil: 200 },
    ]);

    // 只改龙书那条：鲸书同 id 的那条必须原样留着
    await worldBookState.save('g1', 'c1', [
      { bookId: 'book-dragon', entryId: 1, stickyUntil: 0, cooldownUntil: 300 },
      { bookId: 'book-whale', entryId: 1, stickyUntil: 0, cooldownUntil: 200 },
    ]);
    expect(await worldBookState.load('g1', 'c1')).toEqual([
      { bookId: 'book-dragon', entryId: 1, stickyUntil: 0, cooldownUntil: 300 },
      { bookId: 'book-whale', entryId: 1, stickyUntil: 0, cooldownUntil: 200 },
    ]);
  });

  it('清空频道连带删记账：同一批里消息与状态一起没，别的频道不受影响', async () => {
    const { conversations, worldBookState } = createRepositories(env.DB, secretBox);
    const OTHER = { guildId: 'g1', channelId: 'c2' };

    await conversations.append(KEY, [
      { role: 'user', content: '在吗', author: '阿天', createdAt: '2026-10-25T03:00:00.000Z' },
    ]);
    await conversations.append(OTHER, [
      { role: 'user', content: '另一个频道', author: '阿天', createdAt: '2026-10-25T03:00:01.000Z' },
    ]);
    await worldBookState.save(KEY.guildId, KEY.channelId, [{ bookId: 'book-a', entryId: 3, stickyUntil: 20, cooldownUntil: 0 }]);
    await worldBookState.save(OTHER.guildId, OTHER.channelId, [{ bookId: 'book-a', entryId: 3, stickyUntil: 30, cooldownUntil: 0 }]);

    await conversations.clear(KEY);

    expect(await conversations.loadAfter(KEY, 0)).toEqual([]);
    // 轮次从头数：旧的粘性记账留着会让下一轮按不存在的历史算
    expect(await worldBookState.load(KEY.guildId, KEY.channelId)).toEqual([]);
    expect(await conversations.loadAfter(OTHER, 0)).toHaveLength(1);
    expect(await worldBookState.load(OTHER.guildId, OTHER.channelId)).toEqual([
      { bookId: 'book-a', entryId: 3, stickyUntil: 30, cooldownUntil: 0 },
    ]);
  });

  it('老库的 book_json 读侧补齐新字段：缺 position/sticky/scanDepth 的书读回来是完整形状', async () => {
    // 上一版规范化的产物：只有闸门认的那几个字段，position/probability/sticky 一概没有
    const oldBook = {
      name: '旧书',
      entries: [{ id: 1, name: '龙族', keys: ['龙'], secondaryKeys: [], content: '龙住在山里。', order: 100 }],
      ignored: [],
      warnings: [],
    };
    // 0035 之后主键换成 book_id，老行落库时 book_id 是 scope + ':' + scope_id
    await env.DB.prepare(
      'INSERT INTO world_books (book_id, scope, scope_id, name, book_json, entry_count, enabled, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('global:', 'global', '', '旧书', JSON.stringify(oldBook), 1, 1, '2026-01-01T00:00:00.000Z')
      .run();

    const record = await createRepositories(env.DB, secretBox).worldBooks.get('global:');
    expect(record?.bookId).toBe('global:');
    expect(record?.enabled).toBe(true);
    expect(record?.entryCount).toBe(1);
    expect(record?.book.entries[0]).toMatchObject({
      position: 'anTop',
      depth: 4,
      role: 'system',
      probability: 100,
      useProbability: false,
      group: '',
      groupWeight: 100,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      scanDepth: null,
    });
  });

  it('同一层存两本：list() 两行都在，remove(bookId) 只删指定书与它的记账', async () => {
    const { worldBooks, worldBookState } = createRepositories(env.DB, secretBox);
    const book = { name: '书', entries: [], ignored: [], warnings: [] };
    const first = await worldBooks.create({ scope: 'guild', scopeId: 'g1', name: '龙书', book });
    const second = await worldBooks.create({ scope: 'guild', scopeId: 'g1', name: '鲸书', book });
    expect(first.bookId).not.toBe(second.bookId);

    expect((await worldBooks.list()).map((item) => item.bookId).sort()).toEqual([first.bookId, second.bookId].sort());

    await worldBookState.save('g1', 'c1', [
      { bookId: first.bookId, entryId: 1, stickyUntil: 5, cooldownUntil: 0 },
      { bookId: second.bookId, entryId: 1, stickyUntil: 0, cooldownUntil: 6 },
    ]);
    await worldBooks.remove(first.bookId);

    expect((await worldBooks.list()).map((item) => item.bookId)).toEqual([second.bookId]);
    expect(await worldBookState.load('g1', 'c1')).toEqual([
      { bookId: second.bookId, entryId: 1, stickyUntil: 0, cooldownUntil: 6 },
    ]);
  });
});
