/// <reference types="node" />
/**
 * scripts/import-discord.mjs 的契约：迁移 0016、消息映射、幂等、429 重试、以及「被 import 时不执行 main」。
 *
 * 文件名是 *.node.test.ts 才会进 Node 池（vitest.node.config.ts 的 include）；workerd 池给不了
 * node:sqlite / 真磁盘，vitest.config.ts 的 exclude 已经把这一组排掉，两边一一对应。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/node/db/migrate';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ROOT = mkdtempSync(join(tmpdir(), 'dc-ai-bot-import-discord-'));
let seq = 0;

function newDbPath(): string {
  seq += 1;
  return join(ROOT, 'case-' + String(seq), 'app.db');
}

afterAll(() => {
  // 同 node.migrate.test.ts：连接没 close 时 Windows 删不掉就留给系统临时目录
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // EBUSY：不影响断言结果
  }
});

const CHANNEL_ID = '150000000000000005';
const GUILD_ID = '1180000000000000000';
const TOKEN = 'test-token';
/** 线上库里最后一条消息的时刻，所以它之后的消息才是要回灌的那段 */
const AFTER_ISO = '2026-10-27T08:48:10.789Z';

interface RawAuthor {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

interface RawMessage {
  id: string;
  content: string;
  timestamp: string;
  author: RawAuthor;
  reference?: { message_id: string };
  referenced_message?: { id: string; content: string; author: RawAuthor } | null;
}

interface Row {
  guild_id: string;
  channel_id: string;
  user_id: string;
  role: string;
  content: string;
  author_name: string | null;
  created_at: string;
  discord_id: string;
  reply_to_id: string;
  reply_to_author: string;
  reply_to_author_id: string;
  reply_to_content: string;
}

interface RunOptions {
  token: string;
  channelId: string;
  afterIso: string;
  dbPath: string;
  maxPages?: number;
  dryRun?: boolean;
  guildId?: string;
}

interface Summary {
  channelId: string;
  guildId: string;
  pages: number;
  inserted: number;
  skipped: number;
  fetched: number;
  first: string | null;
  last: string | null;
  dryRun: boolean;
}

interface ScriptModule {
  toSnowflake(iso: string): string;
  mapMessage(message: RawMessage, guildId: string, channelId: string): Row;
  runImport(options: RunOptions): Promise<Summary>;
  readConfig(env: Record<string, string | undefined>): { missing: string[]; dbPath: string; maxPages: number; dryRun: boolean };
  setImportHooks(hooks: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void }): void;
  resetImportHooks(): void;
}

type FetchLike = (url: string) => Promise<Response>;

// 纯 JS 运维脚本不在 tsconfig 的 include 里（allowJs=false），类型只能在这边声明一小片；
// 两个 tsc 门槛都靠这行 @ts-expect-error 兜住「找不到声明文件」（TS7016 / TS2307）
// @ts-expect-error - scripts/import-discord.mjs 是纯 JS，不在 tsconfig 的 include 里
const script = (await import('../scripts/import-discord.mjs')) as unknown as ScriptModule;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 用时刻反推 snowflake：id 与 timestamp 自洽，after 过滤的行为才和真实 Discord 一致 */
function messageAt(iso: string, patch: Partial<RawMessage> = {}): RawMessage {
  return {
    id: script.toSnowflake(iso),
    content: '内容 ' + iso,
    timestamp: iso,
    author: { id: '42', username: 'alice' },
    ...patch,
  };
}

const BATCH: RawMessage[] = [
  messageAt('2026-10-27T09:00:00.000Z', {
    author: { id: '42', username: 'alice', global_name: '爱丽丝' },
    reference: { message_id: '999' },
    referenced_message: { id: '999', content: '在吗', author: { id: '7', username: 'bob' } },
  }),
  messageAt('2026-10-27T09:05:00.000Z', { content: '', author: { id: '77', username: 'dc-ai-bot', bot: true } }),
  messageAt('2026-10-27T09:10:00.000Z', { content: '最后一条', author: { id: '8', username: 'carol' } }),
];

/** 一个够用的假 Discord：/channels/{id} 给 guild_id，/messages 按 after 返回「更新的那些」，新 → 旧 */
function fakeDiscord(messages: RawMessage[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (!parsed.pathname.includes('/messages')) {
      return jsonResponse({ id: CHANNEL_ID, guild_id: GUILD_ID });
    }
    const after = parsed.searchParams.get('after') ?? '0';
    const limit = Number(parsed.searchParams.get('limit') ?? '100');
    const newer = messages
      .filter((message) => BigInt(message.id) > BigInt(after))
      .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? 1 : -1));
    return jsonResponse(newer.slice(0, limit));
  };
  return { fetchImpl, calls };
}

function countMessages(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

afterEach(() => {
  script.resetImportHooks();
});

describe('migrations/0016_message_discord_id.sql', () => {
  it('给 messages 加可空的 discord_id 与唯一索引，老行不用回填也能各自留着 NULL', async () => {
    const dbPath = newDbPath();
    const result = await runMigrations(dbPath, MIGRATIONS_DIR);
    // 0001…0016 全部按文件名顺序落地（跑不动这里会直接抛）
    expect(result.applied).toContain('0016_message_discord_id.sql');
    expect(result.skipped).toEqual([]);

    const db = new DatabaseSync(dbPath);
    try {
      const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; notnull: number }>;
      const discordId = columns.find((column) => column.name === 'discord_id');
      expect(discordId).toBeDefined();
      // 可空是关键：运行时写入不填这一列，唯一索引允许多个 NULL 才不用回填 1900 多行
      expect(discordId?.notnull).toBe(0);

      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain('idx_messages_discord_id');

      const legacy = db.prepare('INSERT INTO messages (guild_id, channel_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
      legacy.run(GUILD_ID, CHANNEL_ID, 'user', '老行一', '2026-10-27T08:00:00.000Z');
      legacy.run(GUILD_ID, CHANNEL_ID, 'assistant', '老行二', '2026-10-27T08:10:00.000Z');
      const nulls = db.prepare('SELECT count(*) AS n FROM messages WHERE discord_id IS NULL').get() as { n: number };
      expect(nulls.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('重复 discord_id 被 ON CONFLICT DO NOTHING 吞掉；绕过它的裸 INSERT 会撞唯一索引', async () => {
    const dbPath = newDbPath();
    await runMigrations(dbPath, MIGRATIONS_DIR);
    const db = new DatabaseSync(dbPath);
    try {
      const insert = db.prepare(
        'INSERT INTO messages (guild_id, channel_id, user_id, role, content, author_name, created_at, discord_id, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(discord_id) DO NOTHING',
      );
      const args = [GUILD_ID, CHANNEL_ID, '42', 'user', '一次', null, '2026-10-27T09:00:00.000Z', '1300000000000000000', '', '', '', ''];
      expect(Number(insert.run(...args).changes)).toBe(1);
      expect(Number(insert.run(...args).changes)).toBe(0);

      const bare = db.prepare(
        'INSERT INTO messages (guild_id, channel_id, role, content, created_at, discord_id) VALUES (?, ?, ?, ?, ?, ?)',
      );
      expect(() =>
        bare.run(GUILD_ID, CHANNEL_ID, 'user', '二次', '2026-10-27T09:00:01.000Z', '1300000000000000000'),
      ).toThrow(/UNIQUE|constraint/i);
    } finally {
      db.close();
    }
  });
});

describe('mapMessage', () => {
  it('bot 记 assistant、时间戳归一化成 …Z、回复三列跟着 referenced_message', () => {
    const row = script.mapMessage(
      {
        id: '1300000000000000001',
        content: '晚安',
        // Discord 给的就是六位小数 + 偏移量的形态，必须归一化成运行时那个 …Z
        timestamp: '2026-10-27T08:58:47.475000+00:00',
        author: { id: '42', username: 'alice', global_name: '爱丽丝', bot: true },
        reference: { message_id: '1300000000000000000' },
        referenced_message: { id: '1300000000000000000', content: '在吗', author: { id: '7', username: 'bob' } },
      },
      GUILD_ID,
      CHANNEL_ID,
    );

    expect(row).toEqual({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      user_id: '42',
      role: 'assistant',
      content: '晚安',
      author_name: '爱丽丝',
      created_at: '2026-10-27T08:58:47.475Z',
      discord_id: '1300000000000000001',
      reply_to_id: '1300000000000000000',
      reply_to_author: 'bob',
      reply_to_author_id: '7',
      reply_to_content: '在吗',
    });
  });

  it('真人记 user；纯图片消息 content 记空串；没有回复时四列都是空串（列是 NOT NULL）', () => {
    const row = script.mapMessage(
      {
        id: '1300000000000000002',
        content: '',
        timestamp: '2026-10-27T09:00:00.000000+00:00',
        author: { id: '8', username: 'carol', global_name: null },
      },
      GUILD_ID,
      CHANNEL_ID,
    );

    expect(row.role).toBe('user');
    expect(row.content).toBe('');
    // global_name 为 null 时退回 username；空白名字写 NULL（读侧「非空才算有名字」）
    expect(row.author_name).toBe('carol');
    expect(row.created_at).toBe('2026-10-27T09:00:00.000Z');
    expect(row.reply_to_id).toBe('');
    expect(row.reply_to_author).toBe('');
    expect(row.reply_to_author_id).toBe('');
    expect(row.reply_to_content).toBe('');
  });

  it('原消息被删（有 reference 但 referenced_message 为 null）时只留 id', () => {
    const row = script.mapMessage(
      {
        id: '1300000000000000003',
        content: '回复一条已删除的消息',
        timestamp: '2026-10-27T09:01:00.000000+00:00',
        author: { id: '8', username: 'carol' },
        reference: { message_id: '1300000000000000000' },
        referenced_message: null,
      },
      GUILD_ID,
      CHANNEL_ID,
    );

    expect(row.reply_to_id).toBe('1300000000000000000');
    expect(row.reply_to_author).toBe('');
    expect(row.reply_to_author_id).toBe('');
    expect(row.reply_to_content).toBe('');
  });
});

describe('runImport', () => {
  it('同一批消息跑两次：第二次 inserted=0、skipped=N，库里仍是 N 行', async () => {
    const dbPath = newDbPath();
    await runMigrations(dbPath, MIGRATIONS_DIR);
    const discord = fakeDiscord(BATCH);
    script.setImportHooks({ fetch: discord.fetchImpl, sleep: async () => {}, log: () => {} });

    const options: RunOptions = {
      token: TOKEN,
      channelId: CHANNEL_ID,
      afterIso: AFTER_ISO,
      dbPath,
      maxPages: 5,
      dryRun: false,
      guildId: '',
    };
    const first = await script.runImport(options);
    expect(first.guildId).toBe(GUILD_ID);
    expect(first.pages).toBe(1);
    expect(first.fetched).toBe(3);
    expect(first.inserted).toBe(3);
    expect(first.skipped).toBe(0);
    expect(first.first).toBe('2026-10-27T09:00:00.000Z');
    expect(first.last).toBe('2026-10-27T09:10:00.000Z');
    expect(countMessages(dbPath)).toBe(3);

    const second = await script.runImport(options);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
    expect(countMessages(dbPath)).toBe(3);

    // 频道详情只问一次/每次一页：两次都真的去抓过 Discord（确认不是本地空转）
    expect(discord.calls.filter((url) => url.includes('/messages')).length).toBe(2);
  });

  it('429 按 retry_after 睡一次再重试同一页，不会退避成整秒', async () => {
    const dbPath = newDbPath();
    await runMigrations(dbPath, MIGRATIONS_DIR);
    const sleeps: number[] = [];
    let pageCalls = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (!url.includes('/messages')) return jsonResponse({ id: CHANNEL_ID, guild_id: GUILD_ID });
      pageCalls += 1;
      if (pageCalls === 1) {
        return jsonResponse({ message: 'You are being rate limited.', retry_after: 0.01, global: false }, 429);
      }
      const after = new URL(url).searchParams.get('after') ?? '0';
      return jsonResponse(BATCH.filter((message) => BigInt(message.id) > BigInt(after)));
    };
    script.setImportHooks({
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => {},
    });

    const result = await script.runImport({
      token: TOKEN,
      channelId: CHANNEL_ID,
      afterIso: AFTER_ISO,
      dbPath,
      maxPages: 5,
      dryRun: false,
      guildId: '',
    });

    expect(pageCalls).toBe(2);
    expect(result.inserted).toBe(3);
    // 只睡过 429 那一次，且是按 retry_after=0.01s 来的（不是网络错误的 1s 退避、也不是 300ms 页间隔）
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(10);
    expect(sleeps[0]).toBeLessThan(1000);
  });

  it('DRY_RUN 只统计不写库：连库文件都不会建出来', async () => {
    const dbPath = newDbPath();
    script.setImportHooks({ fetch: fakeDiscord(BATCH).fetchImpl, sleep: async () => {}, log: () => {} });

    const result = await script.runImport({
      token: TOKEN,
      channelId: CHANNEL_ID,
      afterIso: AFTER_ISO,
      dbPath,
      maxPages: 5,
      dryRun: true,
      guildId: '',
    });

    expect(result.dryRun).toBe(true);
    expect(result.fetched).toBe(3);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('频道详情拿不到时退回 GUILD_ID；两者都没有就抛中文错误', async () => {
    const dbPath = newDbPath();
    await runMigrations(dbPath, MIGRATIONS_DIR);
    const fetchImpl: FetchLike = async (url) => {
      if (!url.includes('/messages')) return jsonResponse({ message: 'Missing Access', code: 50001 }, 403);
      return jsonResponse(BATCH);
    };
    script.setImportHooks({ fetch: fetchImpl, sleep: async () => {}, log: () => {} });

    const fallback = await script.runImport({
      token: TOKEN,
      channelId: CHANNEL_ID,
      afterIso: AFTER_ISO,
      dbPath,
      maxPages: 5,
      guildId: 'fallback-guild',
    });
    expect(fallback.guildId).toBe('fallback-guild');
    expect(fallback.inserted).toBe(3);

    const otherDb = newDbPath();
    await runMigrations(otherDb, MIGRATIONS_DIR);
    await expect(
      script.runImport({ token: TOKEN, channelId: CHANNEL_ID, afterIso: AFTER_ISO, dbPath: otherDb, maxPages: 5, guildId: '' }),
    ).rejects.toThrow(/GUILD_ID/);
  });
});

describe('readConfig', () => {
  it('三个必填变量缺哪个就报哪个；可选值有默认', () => {
    const config = script.readConfig({});
    expect(config.missing).toEqual(['DISCORD_BOT_TOKEN', 'CHANNEL_ID', 'AFTER_ISO']);
    expect(config.dbPath).toBe('/data/dc-ai-bot.sqlite3');
    expect(config.maxPages).toBe(400);
    expect(config.dryRun).toBe(false);

    const full = script.readConfig({
      DISCORD_BOT_TOKEN: TOKEN,
      CHANNEL_ID,
      AFTER_ISO,
      DB_PATH: '/tmp/x.sqlite3',
      MAX_PAGES: '7',
      DRY_RUN: '1',
    });
    expect(full.missing).toEqual([]);
    expect(full.dbPath).toBe('/tmp/x.sqlite3');
    expect(full.maxPages).toBe(7);
    expect(full.dryRun).toBe(true);
  });
});

describe('入口守卫', () => {
  it('被 import 时不会执行 main：一个请求都不发', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      throw new Error('测试里不该真的发请求');
    }) as typeof globalThis.fetch;
    try {
      // 换个 query 让模块重新求值：入口守卫在新实例上再跑一次
      // @ts-expect-error - 带 ?query 的写法 tsc 解析不了（同上：纯 JS 脚本没有声明文件）
      const fresh = (await import('../scripts/import-discord.mjs?no-main')) as unknown as ScriptModule;
      expect(typeof fresh.runImport).toBe('function');
      expect(typeof fresh.mapMessage).toBe('function');
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
