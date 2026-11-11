/// <reference types="node" />
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { markAllApplied, runMigrations } from '../src/node/db/migrate';
import { createSqliteDatabase } from '../src/node/db/sqlite';

// 不用 new URL：workers-types 与 node:url 的 URL 不是同一个类型，传字符串给 fileURLToPath 两边都认
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const EXPECTED_FILES = [
  '0001_init.sql',
  '0002_message_author.sql',
  '0003_conversation_summary.sql',
  '0004_message_reply.sql',
  '0005_runtime_logs.sql',
  '0006_key_models.sql',
  '0007_reaction_model.sql',
  '0008_emoji_descriptions.sql',
  '0009_emoji_aliases.sql',
  '0010_channel_memory.sql',
  '0011_summary_span.sql',
  '0012_memory_budget.sql',
  '0013_prompt_segments.sql',
  '0014_reaction_guides.sql',
  '0015_reaction_templates.sql',
  '0016_message_discord_id.sql',
  '0017_reply_settings.sql',
  '0018_vision_settings.sql',
  '0019_voice_settings.sql',
  '0020_prompt_defaults.sql',
  '0021_prompt_default_scope.sql',
  '0022_tts_settings.sql',
  '0023_tts_dialect.sql',
  '0024_tts_style.sql',
  '0025_director_mode.sql',
  '0026_prompt_presets.sql',
  '0027_route_sampling.sql',
  '0028_prompt_injections.sql',
  '0029_world_books.sql',
  '0030_context_tool_mode.sql',
  '0031_body_emoji_guides.sql',
  '0032_tts_gemini_dialect.sql',
  '0033_timeout_settings.sql',
  '0034_world_book_state.sql',
  '0035_world_books_multi.sql',
  '0036_image_settings.sql',
];

const ROOT = mkdtempSync(join(tmpdir(), 'dc-ai-bot-migrate-'));
let seq = 0;

function newDbPath(): string {
  seq += 1;
  return join(ROOT, 'case-' + String(seq), 'app.db');
}

afterAll(() => {
  // 同 node.sqlite.test.ts：库连接没有 close()，Windows 上删不掉就留给系统临时目录
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // EBUSY：连接还开着，忽略即可，不影响断言结果
  }
});

describe('runMigrations', () => {
  it('36 个迁移文件在一个空库上全部执行，第二次调用全部 skipped', async () => {
    const filePath = newDbPath();
    const first = await runMigrations(filePath, MIGRATIONS_DIR);
    expect(first.applied).toEqual(EXPECTED_FILES);
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(filePath, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(EXPECTED_FILES);
  });

  it('账本表只记文件名，applied_at 是 ISO 时刻', async () => {
    const filePath = newDbPath();
    const { applied } = await runMigrations(filePath, MIGRATIONS_DIR);
    const db = createSqliteDatabase(filePath);
    const { results } = await db
      .prepare('SELECT name, applied_at FROM _migrations ORDER BY name ASC')
      .all<{ name: string; applied_at: string }>();
    expect(results.map((row) => row.name)).toEqual(applied);
    for (const row of results) {
      // 排序与幂等都靠 name 主键；applied_at 必须能被后台当成时间显示
      expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/);
    }
  });

  it('多语句文件整段执行：0011 的 ALTER TABLE 与回填 UPDATE 都落地了', async () => {
    const filePath = newDbPath();
    await runMigrations(filePath, MIGRATIONS_DIR);
    const db = createSqliteDatabase(filePath);
    // 0011 之前写下的摘要行在 0011 之后必须能看见两列（ALTER 生效，缺列会直接报 no such column）
    await db
      .prepare('INSERT INTO conversation_summaries (guild_id, channel_id, summary, covered_until_id, covered_from, covered_to, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('g1', 'c1', '摘要', 7, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
      .run();
    const row = await db
      .prepare('SELECT covered_from, covered_to FROM conversation_summaries WHERE guild_id = ? AND channel_id = ?')
      .bind('g1', 'c1')
      .first<{ covered_from: string; covered_to: string }>();
    expect(row).toEqual({ covered_from: '2026-01-01T00:00:00.000Z', covered_to: '2026-01-02T00:00:00.000Z' });
  });

  it('0012 在空库上补出 summary_max_chars 列：老行取默认 0 = 未设置', async () => {
    const filePath = newDbPath();
    await runMigrations(filePath, MIGRATIONS_DIR);
    const db = createSqliteDatabase(filePath);
    // 只写 0011 时代的五列：0012 的列只能由 ALTER 补出来，缺列会直接报 no such column
    await db
      .prepare('INSERT INTO channel_memory_settings (guild_id, channel_id, history_max_messages, summary_every_messages, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('g1', 'c1', 80, 120, '2026-01-01T00:00:00.000Z')
      .run();
    const row = await db
      .prepare('SELECT summary_max_chars FROM channel_memory_settings WHERE guild_id = ? AND channel_id = ?')
      .bind('g1', 'c1')
      .first<{ summary_max_chars: number }>();
    expect(row).toEqual({ summary_max_chars: 0 });
  });

  it('0027 给 routes 补出五列采样参数：老行一律 NULL，0 存得住', async () => {
    const filePath = newDbPath();
    await runMigrations(filePath, MIGRATIONS_DIR);
    const db = createSqliteDatabase(filePath);
    // 只写 0026 时代就有的列：五列只能由 ALTER 补出来，缺列会直接报 no such column
    await db
      .prepare('INSERT INTO routes (scope, scope_id, primary_provider, primary_model, fallbacks_json, temperature, max_tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('global', '', 'openai-compat', 'gpt-4o-mini', '[]', 0.3, 256, '2026-01-01T00:00:00.000Z')
      .run();
    const legacy = await db
      .prepare('SELECT top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes WHERE scope = ? AND scope_id = ?')
      .bind('global', '')
      .first();
    expect(legacy).toEqual({ top_p: null, top_k: null, seed: null, frequency_penalty: null, presence_penalty: null });

    const columns = await db.prepare('PRAGMA table_info(routes)').all<{ name: string; type: string; notnull: number }>();
    const added = columns.results.filter((column) =>
      ['top_p', 'top_k', 'seed', 'frequency_penalty', 'presence_penalty'].includes(column.name),
    );
    expect(added.map((column) => [column.name, column.type, column.notnull])).toEqual([
      ['top_p', 'REAL', 0],
      ['top_k', 'INTEGER', 0],
      ['seed', 'INTEGER', 0],
      ['frequency_penalty', 'REAL', 0],
      ['presence_penalty', 'REAL', 0],
    ]);

    // 0 是用户填过的有效值：必须原样存住，不能被当成「未设置」写成 NULL
    await db
      .prepare('UPDATE routes SET top_p = 0, top_k = 1, seed = 0, frequency_penalty = 0, presence_penalty = 0 WHERE scope = ? AND scope_id = ?')
      .bind('global', '')
      .run();
    const zeroed = await db
      .prepare('SELECT top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes WHERE scope = ? AND scope_id = ?')
      .bind('global', '')
      .first();
    expect(zeroed).toEqual({ top_p: 0, top_k: 1, seed: 0, frequency_penalty: 0, presence_penalty: 0 });
  });


  it('0028 建出 prompt_injections：三层一行、主键 (scope, scope_id) 可 upsert，坏 scope / role 被拒', async () => {
    const filePath = newDbPath();
    await runMigrations(filePath, MIGRATIONS_DIR);
    const db = createSqliteDatabase(filePath);

    const columns = await db
      .prepare('PRAGMA table_info(prompt_injections)')
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    expect(columns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['scope', 'TEXT', 1, 1],
      ['scope_id', 'TEXT', 1, 2],
      ['content', 'TEXT', 1, 0],
      ['depth', 'INTEGER', 1, 0],
      ['role', 'TEXT', 1, 0],
      ['updated_at', 'TEXT', 1, 0],
    ]);

    const insert = db.prepare(
      'INSERT INTO prompt_injections (scope, scope_id, content, depth, role, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, scope_id) DO UPDATE SET content = excluded.content, depth = excluded.depth, role = excluded.role, updated_at = excluded.updated_at',
    );
    await insert.bind('global', '', '全局层', 0, 'system', '2026-01-01T00:00:00.000Z').run();
    await insert.bind('guild', 'g1', '服务器层', 1, 'user', '2026-01-01T00:00:01.000Z').run();
    // 同一个 (scope, scope_id) 再写一次只改这一行，不新增
    await insert.bind('guild', 'g1', '服务器层改过', 3, 'assistant', '2026-01-01T00:00:02.000Z').run();
    const rows = await db
      .prepare('SELECT scope, scope_id, content, depth, role, updated_at FROM prompt_injections ORDER BY scope, scope_id')
      .all();
    expect(rows.results).toEqual([
      { scope: 'global', scope_id: '', content: '全局层', depth: 0, role: 'system', updated_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'guild', scope_id: 'g1', content: '服务器层改过', depth: 3, role: 'assistant', updated_at: '2026-01-01T00:00:02.000Z' },
    ]);

    // CHECK 是最后一道闸：绕过接口直接写脏值必须失败，不能落库后让读侧去猜
    await expect(insert.bind('team', '', 'x', 0, 'system', '2026-01-01T00:00:03.000Z').run()).rejects.toThrow();
    await expect(insert.bind('global', '', 'x', 0, 'tool', '2026-01-01T00:00:03.000Z').run()).rejects.toThrow();
  });

  it('0029 建出 world_books：三层一行、主键 (scope, scope_id) 可整本覆盖，坏 scope 被拒', async () => {
    // 0035 已经把主键换成 book_id，这一条只看 0029 落地时的形状
    const before = join(ROOT, 'migrations-before-0030');
    mkdirSync(before, { recursive: true });
    for (const name of EXPECTED_FILES.filter((file) => file < '0030')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(before, name));
    }
    const filePath = newDbPath();
    expect((await runMigrations(filePath, before)).applied).toHaveLength(29);
    const db = createSqliteDatabase(filePath);

    const columns = await db
      .prepare('PRAGMA table_info(world_books)')
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    expect(columns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['scope', 'TEXT', 1, 1],
      ['scope_id', 'TEXT', 1, 2],
      ['name', 'TEXT', 1, 0],
      ['book_json', 'TEXT', 1, 0],
      ['entry_count', 'INTEGER', 1, 0],
      ['imported_at', 'TEXT', 1, 0],
    ]);

    const insert = db.prepare(
      'INSERT INTO world_books (scope, scope_id, name, book_json, entry_count, imported_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, scope_id) DO UPDATE SET name = excluded.name, book_json = excluded.book_json, entry_count = excluded.entry_count, imported_at = excluded.imported_at',
    );
    await insert.bind('global', '', '全局书', '{"name":"全局书","entries":[]}', 0, '2026-01-01T00:00:00.000Z').run();
    await insert.bind('guild', 'g1', '旧书', '{"name":"旧书","entries":[]}', 1, '2026-01-01T00:00:01.000Z').run();
    // 同一个 (scope, scope_id) 再写一次是整本换掉，不新增第二行
    await insert.bind('guild', 'g1', '新书', '{"name":"新书","entries":[]}', 0, '2026-01-01T00:00:02.000Z').run();
    const rows = await db
      .prepare('SELECT scope, scope_id, name, book_json, entry_count, imported_at FROM world_books ORDER BY scope, scope_id')
      .all();
    expect(rows.results).toEqual([
      { scope: 'global', scope_id: '', name: '全局书', book_json: '{"name":"全局书","entries":[]}', entry_count: 0, imported_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'guild', scope_id: 'g1', name: '新书', book_json: '{"name":"新书","entries":[]}', entry_count: 0, imported_at: '2026-01-01T00:00:02.000Z' },
    ]);

    // CHECK 是最后一道闸：绕过接口直接写脏 scope 必须失败，不能落库后让读侧去猜
    await expect(insert.bind('team', '', 'x', '{}', 0, '2026-01-01T00:00:03.000Z').run()).rejects.toThrow();
  });

  it('0034 建出 world_book_state：主键 (guild_id, channel_id, entry_id)、两个计时列默认 0', async () => {
    // 0035 重建了这张表（主键加 book_id），这一条只看 0034 落地时的形状
    const before = join(ROOT, 'migrations-before-0035');
    mkdirSync(before, { recursive: true });
    for (const name of EXPECTED_FILES.filter((file) => file < '0035')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(before, name));
    }
    const filePath = newDbPath();
    expect((await runMigrations(filePath, before)).applied).toHaveLength(34);
    const db = createSqliteDatabase(filePath);

    const columns = await db
      .prepare('PRAGMA table_info(world_book_state)')
      .all<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>();
    expect(columns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['guild_id', 'TEXT', 1, 1],
      ['channel_id', 'TEXT', 1, 2],
      ['entry_id', 'INTEGER', 1, 3],
      ['sticky_until', 'INTEGER', 1, 0],
      ['cooldown_until', 'INTEGER', 1, 0],
      ['updated_at', 'TEXT', 1, 0],
    ]);
    expect(columns.results.map((column) => column.dflt_value)).toEqual([null, null, null, '0', '0', null]);

    // 行里只给主键与 updated_at：两个计时的 DEFAULT 0 生效（仓储有时只写「还有冷却」这一半）
    await db
      .prepare('INSERT INTO world_book_state (guild_id, channel_id, entry_id, updated_at) VALUES (?, ?, ?, ?)')
      .bind('', 'c1', 7, '2026-01-01T00:00:00.000Z')
      .run();
    await db
      .prepare(
        'INSERT INTO world_book_state (guild_id, channel_id, entry_id, sticky_until, cooldown_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('g1', 'c1', 7, 3, 4, '2026-01-01T00:00:01.000Z')
      .run();
    const rows = await db
      .prepare(
        'SELECT guild_id, channel_id, entry_id, sticky_until, cooldown_until, updated_at FROM world_book_state ORDER BY guild_id, channel_id, entry_id',
      )
      .all();
    expect(rows.results).toEqual([
      { guild_id: '', channel_id: 'c1', entry_id: 7, sticky_until: 0, cooldown_until: 0, updated_at: '2026-01-01T00:00:00.000Z' },
      { guild_id: 'g1', channel_id: 'c1', entry_id: 7, sticky_until: 3, cooldown_until: 4, updated_at: '2026-01-01T00:00:01.000Z' },
    ]);

    // 主键含 entry_id：同频道同条目再插一条必须失败，不能悄悄多出一行
    await expect(
      db
        .prepare(
          'INSERT INTO world_book_state (guild_id, channel_id, entry_id, sticky_until, cooldown_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('g1', 'c1', 7, 9, 9, '2026-01-01T00:00:02.000Z')
        .run(),
    ).rejects.toThrow();
  });

  it('0035 一层多本：book_id 变主键、老行按 scope:scope_id 搬过去，记账键加书、旧记账清空', async () => {
    // 先建出 0034 的形态（world_books 主键 (scope, scope_id)、world_book_state 主键不含 book_id），再单独跑 0035
    const before = join(ROOT, 'migrations-before-0035-books');
    mkdirSync(before, { recursive: true });
    for (const name of EXPECTED_FILES.filter((file) => file < '0035')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(before, name));
    }
    const filePath = newDbPath();
    expect((await runMigrations(filePath, before)).applied).toHaveLength(34);

    const db = createSqliteDatabase(filePath);
    await db
      .prepare('INSERT INTO world_books (scope, scope_id, name, book_json, entry_count, imported_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('guild', 'g1', '旧书', '{"name":"旧书","entries":[]}', 0, '2026-01-01T00:00:00.000Z')
      .run();
    await db
      .prepare('INSERT INTO world_books (scope, scope_id, name, book_json, entry_count, imported_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('global', '', '全局书', '{"name":"全局书","entries":[]}', 2, '2026-01-01T00:00:01.000Z')
      .run();
    await db
      .prepare('INSERT INTO world_book_state (guild_id, channel_id, entry_id, sticky_until, cooldown_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('g1', 'c1', 7, 3, 4, '2026-01-01T00:00:02.000Z')
      .run();

    const only = join(ROOT, 'migrations-0035-only');
    mkdirSync(only, { recursive: true });
    copyFileSync(join(MIGRATIONS_DIR, '0035_world_books_multi.sql'), join(only, '0035_world_books_multi.sql'));
    expect((await runMigrations(filePath, only)).applied).toEqual(['0035_world_books_multi.sql']);

    const columns = await db
      .prepare('PRAGMA table_info(world_books)')
      .all<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>();
    expect(columns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['book_id', 'TEXT', 1, 1],
      ['scope', 'TEXT', 1, 0],
      ['scope_id', 'TEXT', 1, 0],
      ['name', 'TEXT', 1, 0],
      ['book_json', 'TEXT', 1, 0],
      ['entry_count', 'INTEGER', 1, 0],
      ['enabled', 'INTEGER', 1, 0],
      ['imported_at', 'TEXT', 1, 0],
    ]);
    expect(columns.results.map((column) => column.dflt_value)).toEqual([null, null, "''", null, null, null, '1', null]);

    // 老行原样保留：book_id 由 scope 与 scope_id 拼出来，enabled 缺省 1
    const rows = await db
      .prepare('SELECT book_id, scope, scope_id, name, entry_count, enabled, imported_at FROM world_books ORDER BY book_id')
      .all();
    expect(rows.results).toEqual([
      { book_id: 'global:', scope: 'global', scope_id: '', name: '全局书', entry_count: 2, enabled: 1, imported_at: '2026-01-01T00:00:01.000Z' },
      { book_id: 'guild:g1', scope: 'guild', scope_id: 'g1', name: '旧书', entry_count: 0, enabled: 1, imported_at: '2026-01-01T00:00:00.000Z' },
    ]);

    // book_id 才是主键：同一层还能再放一本，整本停用只是一个列值
    await db
      .prepare('INSERT INTO world_books (book_id, scope, scope_id, name, book_json, entry_count, enabled, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('book-2', 'guild', 'g1', '第二本', '{"name":"第二本","entries":[]}', 0, 0, '2026-01-01T00:00:03.000Z')
      .run();
    const layer = await db
      .prepare('SELECT book_id, enabled FROM world_books WHERE scope = ? AND scope_id = ? ORDER BY book_id')
      .bind('guild', 'g1')
      .all();
    expect(layer.results).toEqual([
      { book_id: 'book-2', enabled: 0 },
      { book_id: 'guild:g1', enabled: 1 },
    ]);
    // CHECK 随重建一起回来
    await expect(
      db
        .prepare('INSERT INTO world_books (book_id, scope, scope_id, name, book_json, entry_count, enabled, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind('book-3', 'team', '', 'x', '{}', 0, 1, '2026-01-01T00:00:04.000Z')
        .run(),
    ).rejects.toThrow();

    // 记账键加书：旧行没法判断属于哪一本，整表清空而不是猜
    const stateColumns = await db
      .prepare('PRAGMA table_info(world_book_state)')
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    expect(stateColumns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['guild_id', 'TEXT', 1, 1],
      ['channel_id', 'TEXT', 1, 2],
      ['book_id', 'TEXT', 1, 3],
      ['entry_id', 'INTEGER', 1, 4],
      ['sticky_until', 'INTEGER', 1, 0],
      ['cooldown_until', 'INTEGER', 1, 0],
      ['updated_at', 'TEXT', 1, 0],
    ]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM world_book_state').first<{ n: number }>()).toEqual({ n: 0 });

    // 两本书各有一条 id=1 的条目：主键含 book_id，两行都能落
    await db
      .prepare('INSERT INTO world_book_state (guild_id, channel_id, book_id, entry_id, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('g1', 'c1', 'book-2', 1, '2026-01-01T00:00:05.000Z')
      .run();
    await db
      .prepare('INSERT INTO world_book_state (guild_id, channel_id, book_id, entry_id, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('g1', 'c1', 'guild:g1', 1, '2026-01-01T00:00:06.000Z')
      .run();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM world_book_state').first<{ n: number }>()).toEqual({ n: 2 });
    // 同一本书的同一个 id 仍然只有一行
    await expect(
      db
        .prepare('INSERT INTO world_book_state (guild_id, channel_id, book_id, entry_id, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind('g1', 'c1', 'guild:g1', 1, '2026-01-01T00:00:07.000Z')
        .run(),
    ).rejects.toThrow();
  });

  it('0036 建出 image_settings：7 列、主键 (scope, scope_id) 可 upsert、四列默认空串、坏 scope 被拒', async () => {
    const filePath = newDbPath();
    await runMigrations(filePath, MIGRATIONS_DIR);
    const db = createSqliteDatabase(filePath);

    const columns = await db
      .prepare('PRAGMA table_info(image_settings)')
      .all<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>();
    expect(columns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['scope', 'TEXT', 1, 1],
      ['scope_id', 'TEXT', 1, 2],
      ['model', 'TEXT', 1, 0],
      ['base_url', 'TEXT', 1, 0],
      ['key_sealed', 'TEXT', 1, 0],
      ['key_hint', 'TEXT', 1, 0],
      ['updated_at', 'TEXT', 1, 0],
    ]);
    // 只有 updated_at 必填：其余四个业务列省略时取空串 = 这一项沿用上层（默认值不由迁移写死）
    expect(columns.results.map((column) => column.dflt_value)).toEqual([null, "''", "''", "''", "''", "''", null]);

    await db
      .prepare('INSERT INTO image_settings (scope, scope_id, model, base_url, key_sealed, key_hint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('global', '', 'gemini-custom', 'https://img.example.com/v1', 'sealed', '…0001', '2026-01-01T00:00:00.000Z')
      .run();
    // 只给主键与 updated_at：四个业务列走 DEFAULT ''
    await db
      .prepare('INSERT INTO image_settings (scope, scope_id, updated_at) VALUES (?, ?, ?)')
      .bind('guild', 'g1', '2026-01-01T00:00:01.000Z')
      .run();
    const rows = await db
      .prepare('SELECT scope, scope_id, model, base_url, key_sealed, key_hint, updated_at FROM image_settings ORDER BY scope ASC, scope_id ASC')
      .all();
    expect(rows.results).toEqual([
      { scope: 'global', scope_id: '', model: 'gemini-custom', base_url: 'https://img.example.com/v1', key_sealed: 'sealed', key_hint: '…0001', updated_at: '2026-01-01T00:00:00.000Z' },
      { scope: 'guild', scope_id: 'g1', model: '', base_url: '', key_sealed: '', key_hint: '', updated_at: '2026-01-01T00:00:01.000Z' },
    ]);

    // 主键是 (scope, scope_id)：同层硬插第二行必须失败，仓储走的 ON CONFLICT 才是覆盖
    await expect(
      db
        .prepare('INSERT INTO image_settings (scope, scope_id, updated_at) VALUES (?, ?, ?)')
        .bind('guild', 'g1', '2026-01-01T00:00:02.000Z')
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        `INSERT INTO image_settings (scope, scope_id, model, base_url, key_sealed, key_hint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id) DO UPDATE SET
           model = excluded.model,
           base_url = excluded.base_url,
           key_sealed = excluded.key_sealed,
           key_hint = excluded.key_hint,
           updated_at = excluded.updated_at`,
      )
      .bind('guild', 'g1', 'next-model', '', '', '', '2026-01-01T00:00:02.000Z')
      .run();
    const upserted = await db
      .prepare('SELECT model, updated_at FROM image_settings WHERE scope = ? AND scope_id = ?')
      .bind('guild', 'g1')
      .first<{ model: string; updated_at: string }>();
    expect(upserted).toEqual({ model: 'next-model', updated_at: '2026-01-01T00:00:02.000Z' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM image_settings').first<{ n: number }>()).toEqual({ n: 2 });

    // CHECK 是最后一道闸：脏 scope 必须写不进去，不能落库后让读侧去猜
    await expect(
      db
        .prepare('INSERT INTO image_settings (scope, scope_id, updated_at) VALUES (?, ?, ?)')
        .bind('team', '', '2026-01-01T00:00:03.000Z')
        .run(),
    ).rejects.toThrow();
  });

  it('0032 重建 tts_settings：老行十二列原样保留，gemini 可写，脏方言被 CHECK 拒', async () => {
    // 先用 0001..0031 建出旧形态的库（CHECK 只认 openai/mimo），写进一行，再单独跑 0032
    const before = join(ROOT, 'migrations-before-0032');
    mkdirSync(before, { recursive: true });
    for (const name of EXPECTED_FILES.filter((file) => file < '0032')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(before, name));
    }
    const filePath = newDbPath();
    expect((await runMigrations(filePath, before)).applied).toHaveLength(31);

    const db = createSqliteDatabase(filePath);
    await db
      .prepare('INSERT INTO tts_settings (id, url, key_sealed, key_hint, model, voice, updated_at, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(
        1,
        'https://api.xiaomimimo.com/v1',
        'sealed-key',
        'sk-...abcd',
        'mimo-v2.5-tts',
        '冰糖',
        '2026-01-01T00:00:00.000Z',
        'mimo',
        'https://judge.example/v1',
        'sealed-judge',
        'sk-...efgh',
        'judge-model',
      )
      .run();

    const only = join(ROOT, 'migrations-0032-only');
    mkdirSync(only, { recursive: true });
    copyFileSync(join(MIGRATIONS_DIR, '0032_tts_gemini_dialect.sql'), join(only, '0032_tts_gemini_dialect.sql'));
    expect((await runMigrations(filePath, only)).applied).toEqual(['0032_tts_gemini_dialect.sql']);

    // 重建是 DROP + RENAME：十二列必须逐字搬过来，judge_* 这几列最容易在重建时漏掉
    const row = await db.prepare('SELECT * FROM tts_settings WHERE id = 1').first();
    expect(row).toEqual({
      id: 1,
      url: 'https://api.xiaomimimo.com/v1',
      key_sealed: 'sealed-key',
      key_hint: 'sk-...abcd',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      updated_at: '2026-01-01T00:00:00.000Z',
      dialect: 'mimo',
      judge_url: 'https://judge.example/v1',
      judge_key_sealed: 'sealed-judge',
      judge_key_hint: 'sk-...efgh',
      judge_model: 'judge-model',
    });

    const columns = await db.prepare('PRAGMA table_info(tts_settings)').all<{ name: string; notnull: number }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      'id',
      'url',
      'key_sealed',
      'key_hint',
      'model',
      'voice',
      'updated_at',
      'dialect',
      'judge_url',
      'judge_key_sealed',
      'judge_key_hint',
      'judge_model',
    ]);

    // 新 CHECK 收下 gemini
    await db.prepare('UPDATE tts_settings SET dialect = ? WHERE id = 1').bind('gemini').run();
    const gemini = await db.prepare('SELECT dialect FROM tts_settings WHERE id = 1').first<{ dialect: string }>();
    expect(gemini).toEqual({ dialect: 'gemini' });

    // CHECK 是最后一道闸：脏方言必须失败，不能落库后让读侧去猜
    await expect(db.prepare('UPDATE tts_settings SET dialect = ? WHERE id = 1').bind('openai2').run()).rejects.toThrow();
    // 单行约束随重建一起回来
    await expect(
      db.prepare('INSERT INTO tts_settings (id) VALUES (?)').bind(2).run(),
    ).rejects.toThrow();
  });

  it('0013 把旧的 system_prompt/persona 搬成两段，并 DROP 掉提示词表的两列', async () => {
    // 先用 0001..0012 建出旧形态的库，写进行，再单独跑 0013
    const before = join(ROOT, 'migrations-before-0013');
    mkdirSync(before, { recursive: true });
    for (const name of EXPECTED_FILES.filter((file) => file < '0013')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(before, name));
    }
    const filePath = newDbPath();
    expect((await runMigrations(filePath, before)).applied).toHaveLength(12);

    const db = createSqliteDatabase(filePath);
    await db
      .prepare('INSERT INTO prompts (scope, scope_id, persona, system_prompt, temperature, max_tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('global', '', '冷静克制', '你是 {{bot_name}}', 0.3, 256, '2026-01-01T00:00:00.000Z')
      .run();
    await db
      .prepare('INSERT INTO prompts (scope, scope_id, persona, system_prompt, temperature, max_tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('guild', 'g1', null, '公会提示词', null, null, '2026-01-01T00:00:00.000Z')
      .run();

    const only = join(ROOT, 'migrations-0013-only');
    mkdirSync(only, { recursive: true });
    copyFileSync(join(MIGRATIONS_DIR, '0013_prompt_segments.sql'), join(only, '0013_prompt_segments.sql'));
    expect((await runMigrations(filePath, only)).applied).toEqual(['0013_prompt_segments.sql']);

    const segments = await db
      .prepare('SELECT id, scope, scope_id, position, name, role, content, enabled, placement FROM prompt_segments ORDER BY scope ASC, scope_id ASC, position ASC')
      .all();
    expect(segments.results).toEqual([
      { id: 'legacy-main', scope: 'global', scope_id: '', position: 0, name: '基本设定', role: 'system', content: '你是 {{bot_name}}', enabled: 1, placement: 'before' },
      { id: 'legacy-persona', scope: 'global', scope_id: '', position: 1, name: '人格', role: 'system', content: '冷静克制', enabled: 1, placement: 'before' },
      { id: 'legacy-main', scope: 'guild', scope_id: 'g1', position: 0, name: '基本设定', role: 'system', content: '公会提示词', enabled: 1, placement: 'before' },
    ]);

    // 旧列被 DROP：prompts 行退化成「这一层有配置」的容器
    const columns = await db.prepare('PRAGMA table_info(prompts)').all();
    expect(columns.results.map((column) => (column as { name: string }).name).sort()).toEqual([
      'max_tokens',
      'scope',
      'scope_id',
      'temperature',
      'updated_at',
    ]);
    const rows = await db.prepare('SELECT scope, scope_id, temperature, max_tokens FROM prompts ORDER BY scope ASC, scope_id ASC').all();
    expect(rows.results).toEqual([
      { scope: 'global', scope_id: '', temperature: 0.3, max_tokens: 256 },
      { scope: 'guild', scope_id: 'g1', temperature: null, max_tokens: null },
    ]);
  });

  it('0021 把旧的单行 prompt_defaults 搬成 global 层，并按 (key, scope, scope_id) 拆表', async () => {
    // 先用 0001..0020 建出旧形态的库，写进两行，再单独跑 0021
    const before = join(ROOT, 'migrations-before-0021');
    mkdirSync(before, { recursive: true });
    for (const name of EXPECTED_FILES.filter((file) => file < '0021')) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(before, name));
    }
    const filePath = newDbPath();
    expect((await runMigrations(filePath, before)).applied).toHaveLength(20);

    const db = createSqliteDatabase(filePath);
    await db
      .prepare('INSERT INTO prompt_defaults (key, content, updated_at) VALUES (?, ?, ?)')
      .bind('fallback', '你是 {{bot_name}}，今天是 {{date}}。', '2026-01-01T00:00:00.000Z')
      .run();
    await db
      .prepare('INSERT INTO prompt_defaults (key, content, updated_at) VALUES (?, ?, ?)')
      .bind('identity', '【当前对话】\n和你说话的是 {{user_name}}', '2026-01-02T00:00:00.000Z')
      .run();

    const only = join(ROOT, 'migrations-0021-only');
    mkdirSync(only, { recursive: true });
    copyFileSync(join(MIGRATIONS_DIR, '0021_prompt_default_scope.sql'), join(only, '0021_prompt_default_scope.sql'));
    expect((await runMigrations(filePath, only)).applied).toEqual(['0021_prompt_default_scope.sql']);

    // 老行一律变成 global 层（scope_id 空串），原文与更新时间原样保留
    const rows = await db
      .prepare('SELECT key, scope, scope_id, content, updated_at FROM prompt_defaults ORDER BY key ASC')
      .all();
    expect(rows.results).toEqual([
      { key: 'fallback', scope: 'global', scope_id: '', content: '你是 {{bot_name}}，今天是 {{date}}。', updated_at: '2026-01-01T00:00:00.000Z' },
      { key: 'identity', scope: 'global', scope_id: '', content: '【当前对话】\n和你说话的是 {{user_name}}', updated_at: '2026-01-02T00:00:00.000Z' },
    ]);

    const columns = await db.prepare('PRAGMA table_info(prompt_defaults)').all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(['key', 'scope', 'scope_id', 'content', 'updated_at']);

    // 同一个 key 可以在三层各存一份；scope 只收三个枚举值
    await db
      .prepare('INSERT INTO prompt_defaults (key, scope, scope_id, content, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('fallback', 'guild', 'g1', '公会兜底', '2026-01-03T00:00:00.000Z')
      .run();
    await db
      .prepare('INSERT INTO prompt_defaults (key, scope, scope_id, content, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('fallback', 'channel', 'c1', '频道兜底', '2026-01-04T00:00:00.000Z')
      .run();
    const count = await db.prepare('SELECT COUNT(*) AS n FROM prompt_defaults').first<{ n: number }>();
    expect(count).toEqual({ n: 4 });

    let rejected = false;
    try {
      await db
        .prepare('INSERT INTO prompt_defaults (key, scope, scope_id, content, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind('fallback', 'server', 'g1', '越界层', '2026-01-05T00:00:00.000Z')
        .run();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('0014 只建表、不改旧表：同一份 SQL 重复执行幂等', async () => {
    const filePath = newDbPath();
    expect((await runMigrations(filePath, MIGRATIONS_DIR)).applied).toEqual(EXPECTED_FILES);

    const db = createSqliteDatabase(filePath);
    const sql = readFileSync(join(MIGRATIONS_DIR, '0014_reaction_guides.sql'), 'utf8');
    // 生产库里这一段可能被重放（手工补跑、D1 导入）：IF NOT EXISTS 必须让它扛住第二次
    await db.prepare(sql).run();
    await db.prepare(sql).run();

    const columns = await db.prepare('PRAGMA table_info(reaction_guides)').all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(['scope', 'scope_id', 'prompt', 'updated_at']);
  });

  it('0014 的 scope 只收三个枚举值，scope_id 缺省是空串（global 那一行不用特判）', async () => {
    const filePath = newDbPath();
    await runMigrations(filePath, MIGRATIONS_DIR);
    const db = createSqliteDatabase(filePath);

    await db
      .prepare('INSERT INTO reaction_guides (scope, prompt, updated_at) VALUES (?, ?, ?)')
      .bind('global', '全局文案', '2026-01-01T00:00:00.000Z')
      .run();
    const row = await db
      .prepare('SELECT scope, scope_id, prompt FROM reaction_guides WHERE scope = ?')
      .bind('global')
      .first<{ scope: string; scope_id: string; prompt: string }>();
    expect(row).toEqual({ scope: 'global', scope_id: '', prompt: '全局文案' });

    let rejected = false;
    try {
      await db
        .prepare('INSERT INTO reaction_guides (scope, scope_id, prompt, updated_at) VALUES (?, ?, ?, ?)')
        .bind('server', 'x', '文案', '2026-01-01T00:00:00.000Z')
        .run();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('markAllApplied 只记账不执行 SQL，之后 runMigrations 全部 skipped', async () => {
    const filePath = newDbPath();
    const marked = await markAllApplied(filePath, MIGRATIONS_DIR);
    expect(marked).toEqual(EXPECTED_FILES);

    const db = createSqliteDatabase(filePath);
    // 一条业务 DDL 都没跑：从 D1 导出的库已经建好表了，重放迁移会撞「表已存在」
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages', 'runtime_logs', 'prompts') ORDER BY name ASC")
      .all<{ name: string }>();
    expect(tables.results).toEqual([]);

    const after = await runMigrations(filePath, MIGRATIONS_DIR);
    expect(after.applied).toEqual([]);
    expect(after.skipped).toEqual(EXPECTED_FILES);
    // 幂等：已经记过的不会重复记账
    expect(await markAllApplied(filePath, MIGRATIONS_DIR)).toEqual([]);
  });

  it('单文件里出错就回滚到该文件之前，并把错误抛给调用方', async () => {
    const dir = join(ROOT, 'broken-migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok (id INTEGER PRIMARY KEY);\n');
    writeFileSync(
      join(dir, '0002_bad.sql'),
      'CREATE TABLE half (id INTEGER PRIMARY KEY);\nINSERT INTO missing_table (id) VALUES (1);\n',
    );

    const filePath = newDbPath();
    await expect(runMigrations(filePath, dir)).rejects.toThrow(/missing_table/);

    const db = createSqliteDatabase(filePath);
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
      .all<{ name: string }>();
    // 0001 已提交并记账；0002 里的半截 DDL 随 ROLLBACK 消失，账本里也不会出现它
    expect(tables.results.map((table) => table.name)).toEqual(['_migrations', 'ok']);
    const ledger = await db.prepare('SELECT name FROM _migrations ORDER BY name ASC').all<{ name: string }>();
    expect(ledger.results).toEqual([{ name: '0001_ok.sql' }]);
  });

  it('目录里没有 .sql 时什么都不做', async () => {
    const dir = join(ROOT, 'empty-migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'not a migration');
    const filePath = newDbPath();
    expect(await runMigrations(filePath, dir)).toEqual({ applied: [], skipped: [] });
    expect(await markAllApplied(filePath, dir)).toEqual([]);
  });
});
