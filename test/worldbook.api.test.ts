import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface AppOptions {
  /** false = 模拟装配层没接世界书仓储：三条端点都应回 501 */
  wired?: boolean;
}

function makeApp(options: AppOptions = {}) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
  };
  if (options.wired === false) deps.worldBooks = undefined;
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function send(app: App, method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie !== undefined) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function itemsOf(app: App, cookie: string): Promise<Json[]> {
  return (await jsonOf(await app.request('/api/world-book', { headers: { cookie } }))).items as Json[];
}

async function setup(options: AppOptions = {}) {
  const app = makeApp(options);
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM world_books').run();
});

interface RawEntry {
  key: string[];
  content: string;
  comment: string;
}

/** 酒馆导出的世界书形状：entries 是以 uid 为键的对象，不是数组 */
function rawBook(name: string, entries: RawEntry[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  entries.forEach((entry, index) => {
    map[String(index)] = {
      uid: index,
      key: entry.key,
      keysecondary: [],
      comment: entry.comment,
      content: entry.content,
      constant: false,
      selective: true,
      selectiveLogic: 0,
      order: 100,
      disable: false,
      caseSensitive: null,
      matchWholeWords: null,
    };
  });
  return { name, entries: map };
}

const DRAGON = { key: ['龙', 'dragon'], content: '火龙的鳞片会发光', comment: '火龙设定' };
const WHALE = { key: ['鲸'], content: '🐉🔥', comment: '表情条目' };

describe('admin world book', () => {
  it('GET 空库回空清单，行数 0', async () => {
    const { app, cookie } = await setup();
    expect(await jsonOf(await app.request('/api/world-book', { headers: { cookie } }))).toEqual({ items: [] });
  });

  it('POST 导入成功：回条目数与解析摘要，GET 回摘要（不带正文）且 chars 按码点计', async () => {
    const { app, cookie } = await setup();

    const imported = await send(
      app,
      'POST',
      '/api/world-book/import',
      { scope: 'global', scopeId: '', book: rawBook('测试世界书', [DRAGON, WHALE]) },
      cookie,
    );
    expect(imported.status).toBe(200);
    expect(await jsonOf(imported)).toMatchObject({
      scope: 'global',
      scopeId: '',
      name: '测试世界书',
      entryCount: 2,
      // 首次导入这一层，没有旧书可覆盖
      replaced: 0,
    });

    const items = await itemsOf(app, cookie);
    expect(items.map((item) => [item.scope, item.scopeId, item.name, item.entryCount])).toEqual([
      ['global', '', '测试世界书', 2],
    ]);
    expect(typeof items[0]?.importedAt).toBe('string');

    const entries = items[0]?.entries as Json[];
    expect(entries).toHaveLength(2);
    // 正文不进列表：几千字一条的正文由 core 在触发时读，后台只显示 keys 与字数
    expect(entries.every((entry) => !('content' in entry))).toBe(true);
    expect(entries.map((entry) => entry.keys)).toEqual([['龙', 'dragon'], ['鲸']]);
    // emoji 按码点算：UTF-16 长度会是 4，后台显示的字数必须是 2
    expect(entries.map((entry) => entry.chars)).toEqual([8, 2]);
    // order / constant / enabled 原样带出，后台据此显示「常驻 / 停用」
    expect(entries.map((entry) => [entry.constant, entry.enabled, entry.order])).toEqual([
      [false, true, 100],
      [false, true, 100],
    ]);

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM world_books').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('同一层再导入：整本覆盖，replaced 是这一层原来的条数（别的层不算）', async () => {
    const { app, cookie } = await setup();

    await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: rawBook('全局旧书', [DRAGON, WHALE]) }, cookie);
    // 另一层有书也不该被算进 replaced
    await send(app, 'POST', '/api/world-book/import', { scope: 'guild', scopeId: 'g1', book: rawBook('服务器书', [DRAGON]) }, cookie);

    const again = await send(
      app,
      'POST',
      '/api/world-book/import',
      { scope: 'global', book: rawBook('全局新书', [WHALE]) },
      cookie,
    );
    expect(again.status).toBe(200);
    expect(await jsonOf(again)).toMatchObject({ scope: 'global', scopeId: '', name: '全局新书', entryCount: 1, replaced: 2 });

    const items = await itemsOf(app, cookie);
    // 一层一行：global 换成新书，guild 原样留着
    expect(items.map((item) => [item.scope, item.scopeId, item.name, item.entryCount])).toEqual([
      ['global', '', '全局新书', 1],
      ['guild', 'g1', '服务器书', 1],
    ]);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM world_books').first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it('400：BAD_SCOPE / BAD_WORLDBOOK / NO_WORLD_ENTRIES 各自带原因，且都不落库', async () => {
    const { app, cookie } = await setup();

    const badScope = await send(app, 'POST', '/api/world-book/import', { scope: 'team', book: rawBook('书', [DRAGON]) }, cookie);
    expect(badScope.status).toBe(400);
    expect(await badScope.json()).toEqual({ error: 'BAD_SCOPE' });

    const badBook = await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: '不是对象' }, cookie);
    expect(badBook.status).toBe(400);
    const badBookBody = await jsonOf(badBook);
    expect(badBookBody['error']).toBe('BAD_WORLDBOOK');
    expect(typeof badBookBody['detail']).toBe('string');

    const noEntries = await send(
      app,
      'POST',
      '/api/world-book/import',
      { scope: 'global', book: { name: '空书', entries: {} } },
      cookie,
    );
    expect(noEntries.status).toBe(400);
    const noEntriesBody = await jsonOf(noEntries);
    expect(noEntriesBody['error']).toBe('NO_WORLD_ENTRIES');
    expect(typeof noEntriesBody['detail']).toBe('string');

    expect(await itemsOf(app, cookie)).toEqual([]);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM world_books').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('DELETE 删这一层：命中与未命中都回 ok，只动指定的那一层', async () => {
    const { app, cookie } = await setup();
    await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: rawBook('全局书', [DRAGON]) }, cookie);
    await send(app, 'POST', '/api/world-book/import', { scope: 'guild', scopeId: 'g1', book: rawBook('服务器书', [WHALE]) }, cookie);

    const del = await send(app, 'DELETE', '/api/world-book', { scope: 'guild', scopeId: 'g1' }, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await itemsOf(app, cookie)).map((item) => item.scope)).toEqual(['global']);

    // 命中 0 行也算成功
    const again = await send(app, 'DELETE', '/api/world-book', { scope: 'guild', scopeId: 'g1' }, cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
  });

  it('库里坏行当这一层不存在：书解析不了 / 形状不对都不出现在 GET，重新导入直接覆盖它', async () => {
    const { app, cookie } = await setup();
    // 绕过接口写进去的坏数据：JSON 半截、形状对不上（entries 不是数组）
    await env.DB.prepare('INSERT INTO world_books (scope, scope_id, name, book_json, entry_count, imported_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('global', '', '半截书', '{"name":', 3, '2026-01-01T00:00:00.000Z')
      .run();
    await env.DB.prepare('INSERT INTO world_books (scope, scope_id, name, book_json, entry_count, imported_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('guild', 'g1', '怪形状', '{"name":"怪形状","entries":"不是数组","ignored":[],"warnings":[]}', 2, '2026-01-01T00:00:00.000Z')
      .run();

    expect(await itemsOf(app, cookie)).toEqual([]);

    // 坏行读不出来 = 这一层没书：replaced 不能让坏行里的 entry_count 冒出来
    const imported = await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: rawBook('好使的书', [DRAGON]) }, cookie);
    expect(imported.status).toBe(200);
    expect((await jsonOf(imported)).replaced).toBe(0);
    expect((await itemsOf(app, cookie)).map((item) => [item.scope, item.name])).toEqual([['global', '好使的书']]);
  });

  it('仓储未接线：GET / POST / DELETE 全部回 501 WORLDBOOK_UNAVAILABLE', async () => {
    const { app, cookie } = await setup({ wired: false });

    const listed = await app.request('/api/world-book', { headers: { cookie } });
    expect(listed.status).toBe(501);
    expect(await listed.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const imported = await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: rawBook('书', [DRAGON]) }, cookie);
    expect(imported.status).toBe(501);
    expect(await imported.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const removed = await send(app, 'DELETE', '/api/world-book', { scope: 'global' }, cookie);
    expect(removed.status).toBe(501);
    expect(await removed.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });
  });
});
