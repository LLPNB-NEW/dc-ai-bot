/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../src/core/db/sql';
import type { SecretBox } from '../src/core/ports';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';
import { runMigrations } from '../src/node/db/migrate';
import { createSqliteDatabase } from '../src/node/db/sqlite';

// 不用 new URL：workers-types 与 node:url 的 URL 不是同一个类型，传字符串给 fileURLToPath 两边都认
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// 每个用例一个独立库文件：同进程里多个实例各自持有连接，互不干扰
const ROOT = mkdtempSync(join(tmpdir(), 'dc-ai-bot-sqlite-'));
let seq = 0;

function newDbPath(): string {
  seq += 1;
  // 故意带一层不存在的子目录：顺带验证 createSqliteDatabase 自己会 mkdir -p
  return join(ROOT, 'case-' + String(seq), 'app.db');
}

// 仓储层只从 SecretBox 取 encrypt/decrypt：这里给个恒等替身，加解密不是本 track 的验收点
const identitySecretBox: SecretBox = {
  async encrypt(plaintext: string): Promise<string> {
    return plaintext;
  },
  async decrypt(blob: string): Promise<string> {
    return blob;
  },
};

afterAll(() => {
  // SqlDatabase 契约没有 close()，Windows 上仍被打开的库文件删不掉：临时目录留给系统清理
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // EBUSY：连接还开着，忽略即可，不影响断言结果
  }
});

interface MessageColumns {
  role: string;
  content: string;
  author_name: string | null;
  user_id: string;
  created_at: string;
  reply_to_id: string;
  reply_to_author: string;
  reply_to_author_id: string;
  reply_to_content: string;
}

describe('createSqliteDatabase 复刻 D1 语义', () => {
  it('bind 返回新实例：同一个基础语句交替 bind 两组参数，两次结果各自正确', async () => {
    const db = createSqliteDatabase(newDbPath());
    await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)').run();
    const base = db.prepare('INSERT INTO t (name) VALUES (?)');
    // log-store 就是这么用的：基础语句只在构造期取一次，之后每次请求都 bind 新参数（src/workers/db/log-store.ts:30-31）
    await db.batch([base.bind('first'), base.bind('second')]);
    await db.batch([base.bind('third'), base.bind('fourth')]);
    const { results } = await db.prepare('SELECT name FROM t ORDER BY id ASC').all<{ name: string }>();
    // bind 若原地改状态，这里会退化成 second, second, fourth, fourth
    expect(results.map((row) => row.name)).toEqual(['first', 'second', 'third', 'fourth']);
    const one = await db.prepare('SELECT name FROM t WHERE name = ?').bind('fourth').first<{ name: string }>();
    expect(one === null ? '' : one.name).toBe('fourth');
  });

  it('batch 是单事务：第二条失败时第一条也不入库', async () => {
    const db = createSqliteDatabase(newDbPath());
    await db.prepare('CREATE TABLE m (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL)').run();
    const insert = db.prepare('INSERT INTO m (role) VALUES (?)');
    // 第二条把 NOT NULL 列绑成 NULL：D1 与 SQLite 一样整批失败
    await expect(db.batch([insert.bind('user'), insert.bind(null)])).rejects.toThrow(/NOT NULL/);
    const { results } = await db.prepare('SELECT COUNT(*) AS n FROM m').all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
    // 回滚之后连接必须还能用（ROLLBACK 没有把事务留在打开状态）
    await insert.bind('user').run();
    const after = await db.prepare('SELECT COUNT(*) AS n FROM m').all<{ n: number }>();
    expect(after.results[0]?.n).toBe(1);
  });

  it('first 未命中返回 null 而不是 undefined', async () => {
    const db = createSqliteDatabase(newDbPath());
    await db.prepare('CREATE TABLE f (id INTEGER PRIMARY KEY, v TEXT NOT NULL)').run();
    await db.prepare('INSERT INTO f (id, v) VALUES (?, ?)').bind(1, 'x').run();
    // d1-repository.ts:320 用 row === null 判空：返回 undefined 会让「没有这一行」漏成坏对象
    expect(await db.prepare('SELECT v FROM f WHERE id = ?').bind(404).first()).toBeNull();
    expect(await db.prepare('SELECT id, v FROM f WHERE id = ?').bind(1).first<{ id: number; v: string }>()).toEqual({
      id: 1,
      v: 'x',
    });
  });

  it('all 返回 { results } 且列名保持 snake_case', async () => {
    const db = createSqliteDatabase(newDbPath());
    await db.prepare('CREATE TABLE a (user_id TEXT NOT NULL, created_at TEXT NOT NULL)').run();
    await db.prepare('INSERT INTO a (user_id, created_at) VALUES (?, ?)').bind('u1', '2026-01-01T00:00:00.000Z').run();
    const page = await db.prepare('SELECT user_id, created_at FROM a').all();
    expect(Object.keys(page)).toEqual(['results']);
    expect(page.results).toEqual([{ user_id: 'u1', created_at: '2026-01-01T00:00:00.000Z' }]);
  });

  it('undefined 落成 NULL，null 与 false/0 原样入库', async () => {
    const db = createSqliteDatabase(newDbPath());
    // 列上带类型才符合线上表形状：node:sqlite 绑 JS number 一律落 REAL，靠 INTEGER 亲和把它收回整数
    await db.prepare('CREATE TABLE v (a TEXT, b TEXT, c INTEGER, d INTEGER, e INTEGER, f TEXT)').run();
    await db.prepare('INSERT INTO v (a, b, c, d, e, f) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(undefined, null, false, true, 0, '')
      .run();
    const row = await db.prepare('SELECT a, b, typeof(a) AS ta, c, d, typeof(c) AS tc, e, f FROM v').first();
    // node:sqlite 不接受直接绑 undefined/boolean，shim 必须自己折算；0 与空串不能被当成「没值」
    expect(row).toEqual({ a: null, b: null, ta: 'null', c: 0, d: 1, tc: 'integer', e: 0, f: '' });
  });

  it('空 batch 直接返回空数组，不碰连接', async () => {
    const db = createSqliteDatabase(newDbPath());
    expect(await db.batch([])).toEqual([]);
  });

  it('并发 batch 排队执行：两次同时进来不会撞「cannot start a transaction within a transaction」', async () => {
    const db = createSqliteDatabase(newDbPath());
    await db.prepare('CREATE TABLE q (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)').run();
    const insert = db.prepare('INSERT INTO q (v) VALUES (?)');
    // 线上就是回复落库与 runtime_logs 写入同时发生：两次 batch 各自的 BEGIN 不能重叠
    await Promise.all([db.batch([insert.bind('a')]), db.batch([insert.bind('b')])]);
    const { results } = await db.prepare('SELECT v FROM q ORDER BY id ASC').all<{ v: string }>();
    expect(results.map((row) => row.v)).toEqual(['a', 'b']);
    // 前一批失败不能把后一批也带停：链上只传完成信号，错误仍归各自调用方
    const notNull = db.prepare('INSERT INTO q (v) VALUES (?)');
    const [failed, ok] = await Promise.allSettled([
      db.batch([notNull.bind(null)]),
      db.batch([insert.bind('c')]),
    ]);
    expect(failed.status).toBe('rejected');
    expect(ok.status).toBe('fulfilled');
    const after = await db.prepare('SELECT v FROM q ORDER BY id ASC').all<{ v: string }>();
    expect(after.results.map((row) => row.v)).toEqual(['a', 'b', 'c']);
  });
});

async function migratedDatabase(): Promise<SqlDatabase> {
  const filePath = newDbPath();
  const result = await runMigrations(filePath, MIGRATIONS_DIR);
  expect(result.skipped).toEqual([]);
  return createSqliteDatabase(filePath);
}

describe('跑完 migrations 后的真实数据形状', () => {
  it('仓储层写入 messages（含 created_at / reply_to_*）后读回来字段一致', async () => {
    const db = await migratedDatabase();
    const repositories = createRepositories(db, identitySecretBox);
    const key = { guildId: 'g1', channelId: 'c1' };
    await repositories.conversations.append(key, [
      {
        role: 'user',
        content: '你上次说的那个方案还在吗',
        author: '小明',
        authorId: 'u1',
        createdAt: '2026-02-03T04:05:06.000Z',
        replyTo: { messageId: 'm-42', author: '小红', authorId: 'u2', content: '方案 A 先做' },
      },
      { role: 'assistant', content: '在的', author: '机器人', createdAt: '2026-02-03T04:05:07.000Z' },
    ]);

    // 第一层：直接看列，snake_case 原样、reply_to_* 四列都落了真实值
    const row = await db
      .prepare(
        'SELECT role, content, author_name, user_id, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY id ASC LIMIT 1',
      )
      .bind('g1', 'c1')
      .first<MessageColumns>();
    expect(row).toEqual({
      role: 'user',
      content: '你上次说的那个方案还在吗',
      author_name: '小明',
      user_id: 'u1',
      created_at: '2026-02-03T04:05:06.000Z',
      reply_to_id: 'm-42',
      reply_to_author: '小红',
      reply_to_author_id: 'u2',
      reply_to_content: '方案 A 先做',
    });

    // 第二层：仓储读回来，role/content/author/createdAt/replyTo 一个不少
    expect(await repositories.conversations.loadAfter(key, 0)).toEqual([
      {
        id: 1,
        role: 'user',
        content: '你上次说的那个方案还在吗',
        author: '小明',
        authorId: 'u1',
        createdAt: '2026-02-03T04:05:06.000Z',
        replyTo: { messageId: 'm-42', author: '小红', authorId: 'u2', content: '方案 A 先做' },
      },
      { id: 2, role: 'assistant', content: '在的', author: '机器人', createdAt: '2026-02-03T04:05:07.000Z' },
    ]);
  });

  it('channel_memory_settings 的 ON CONFLICT DO UPDATE 真能覆盖旧行', async () => {
    const db = await migratedDatabase();
    const { channelMemory } = createRepositories(db, identitySecretBox);
    const key = { guildId: 'g1', channelId: 'c1' };
    await channelMemory.put({ ...key, historyMaxMessages: 30, summaryEveryMessages: 40 });
    const overwritten = await channelMemory.put({ ...key, historyMaxMessages: 120, summaryEveryMessages: 0 });

    expect(overwritten.historyMaxMessages).toBe(120);
    const row = await db
      .prepare('SELECT history_max_messages, summary_every_messages FROM channel_memory_settings WHERE guild_id = ? AND channel_id = ?')
      .bind('g1', 'c1')
      .first<{ history_max_messages: number; summary_every_messages: number }>();
    expect(row).toEqual({ history_max_messages: 120, summary_every_messages: 0 });
    const { results } = await db
      .prepare('SELECT COUNT(*) AS n FROM channel_memory_settings')
      .all<{ n: number }>();
    // 覆盖写而不是插第二行：主键 (guild_id, channel_id) 上只有一条
    expect(results[0]?.n).toBe(1);
    expect(await channelMemory.get(key)).toMatchObject({ historyMaxMessages: 120, summaryEveryMessages: 0 });
  });

  it('log-store 跨请求复用构造期 bind 的 prune 语句，只留最近 keep 条', async () => {
    const db = await migratedDatabase();
    const store = createLogStore(db, 3);
    const entry = (letter: string, minute: number) => ({
      level: 'info' as const,
      scope: 'chat' as const,
      message: letter,
      createdAt: '2026-02-03T04:' + (minute < 10 ? '0' + String(minute) : String(minute)) + ':00.000Z',
    });

    await store.append([entry('a', 0), entry('b', 1), entry('c', 2), entry('d', 3), entry('e', 4)]);
    expect((await store.list(0, 100)).map((item) => item.message)).toEqual(['c', 'd', 'e']);

    // 第二次请求只 bind insert 的参数，prune 仍是构造期那一个实例：状态不能被上一次请求污染
    await store.append([entry('f', 5), entry('g', 6)]);
    expect((await store.list(0, 100)).map((item) => item.message)).toEqual(['e', 'f', 'g']);
  });

  it('§62：getById 带回频道、removeById 认 node:sqlite 的 changes、attachDiscordId 只改最新一条', async () => {
    const db = await migratedDatabase();
    const { conversations } = createRepositories(db, identitySecretBox);
    const key = { guildId: 'g1', channelId: 'c1' };
    await conversations.append(key, [
      { role: 'assistant', content: '同一句', author: '机器人', createdAt: '2026-02-03T04:05:06.000Z' },
      { role: 'user', content: '人类那句', author: '小明', authorId: 'u1', createdAt: '2026-02-03T04:05:07.000Z', discordId: '8001' },
      { role: 'assistant', content: '同一句', author: '机器人', createdAt: '2026-02-03T04:05:08.000Z' },
    ]);
    const rows = await conversations.loadAfter(key, 0);
    const [first, second, third] = rows;
    // 带 id 的行读回来一字不差；没带的老行是 undefined（列里是 NULL，不是空串）
    expect(second?.discordId).toBe('8001');
    expect(first?.discordId).toBeUndefined();

    // 单行读：只有这一条 SELECT 带 channel_id，Discord 定位要靠它
    const single = await conversations.getById!(second!.id);
    expect(single).toMatchObject({ id: second!.id, channelId: 'c1', role: 'user', content: '人类那句' });

    // 回填只认「同频道 + assistant + 正文逐字相等」的最新一条
    await conversations.attachDiscordId!(key, '同一句', '9002');
    expect((await conversations.getById!(first!.id))?.discordId).toBeUndefined();
    expect((await conversations.getById!(third!.id))?.discordId).toBe('9002');

    // node:sqlite 的 run() 回 { changes }（不是 D1 的 meta.changes）：第一次删得掉，第二次 false
    expect(await conversations.removeById!(second!.id)).toBe(true);
    expect(await conversations.removeById!(second!.id)).toBe(false);
    expect(await conversations.getById!(second!.id)).toBeNull();
  });
});
