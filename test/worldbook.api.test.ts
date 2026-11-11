import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import type { WorldBookStore } from '../src/core/prompt/worldbook';
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
  /** false = 模拟装配层没接世界书仓储：各条世界书端点都应回 501 */
  wired?: boolean;
  /** 包一层仓储，用来观察路由到底把什么交给 update（整本回写还是只改开关） */
  wrapStore?: (store: WorldBookStore) => WorldBookStore;
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
  if (options.wrapStore !== undefined && deps.worldBooks !== undefined) {
    deps.worldBooks = options.wrapStore(deps.worldBooks);
  }
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
  // 删书会连带删记账，但用例之间不该依赖这个顺序：两张表都清
  await env.DB.prepare('DELETE FROM world_book_state').run();
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

function bookIdOf(value: Json): string {
  const id = value['bookId'];
  if (typeof id !== 'string' || id === '') throw new Error('响应里没有 bookId');
  return id;
}

/** 导入一本必须成功：导入失败时后面的断言没有意义，就地报出状态码 */
async function importBook(app: App, cookie: string, body: unknown): Promise<Json> {
  const res = await send(app, 'POST', '/api/world-book/import', body, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

/** 单条读取的快捷入口：bookId + id 都由用例给（含非法值） */
async function singleOf(app: App, cookie: string, bookId: string, id: string): Promise<{ status: number; body: Json }> {
  const path = '/api/world-book/entry?bookId=' + encodeURIComponent(bookId) + '&id=' + encodeURIComponent(id);
  const res = await app.request(path, { headers: { cookie } });
  return { status: res.status, body: await jsonOf(res) };
}

/** 两本书各两条，条目 id 都是 0/1 而正文各不相同：跨书隔离的用例都从这份数据出发 */
async function importIsolationPair(app: App, cookie: string): Promise<{ a: string; b: string }> {
  const a = await importBook(app, cookie, {
    scope: 'global',
    book: rawBook('A 书', [DRAGON, { key: ['乙'], content: 'A 书的一号', comment: 'A1' }]),
  });
  const b = await importBook(app, cookie, {
    scope: 'global',
    book: rawBook('B 书', [
      { key: ['甲'], content: 'B 书零号', comment: 'B0' },
      { key: ['乙'], content: 'B 书一号', comment: 'B1' },
    ]),
  });
  return { a: bookIdOf(a), b: bookIdOf(b) };
}

describe('admin world book list and import', () => {
  it('GET 空库回空清单', async () => {
    const { app, cookie } = await setup();
    expect(await jsonOf(await app.request('/api/world-book', { headers: { cookie } }))).toEqual({ items: [] });
  });

  it('POST 导入：永远新增一本，回 bookId 与层内计数，GET 回摘要（不带正文）且 chars 按码点计', async () => {
    const { app, cookie } = await setup();

    const imported = await importBook(app, cookie, { scope: 'global', scopeId: '', book: rawBook('测试世界书', [DRAGON, WHALE]) });
    expect(imported).toMatchObject({
      scope: 'global',
      scopeId: '',
      name: '测试世界书',
      entryCount: 2,
      ignored: [],
      warnings: [],
      // 这一层原来没有书
      layerCount: 1,
    });
    const bookId = bookIdOf(imported);

    const items = await itemsOf(app, cookie);
    expect(items.map((item) => [item.scope, item.scopeId, item.bookId, item.name, item.enabled, item.entryCount])).toEqual([
      ['global', '', bookId, '测试世界书', true, 2],
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

  it('同一层连续导入：第二本名字带「（2）」，两本各自独立，停用的那本照样占名字与层内计数', async () => {
    const { app, cookie } = await setup();

    const first = await importBook(app, cookie, { scope: 'guild', scopeId: 'g1', book: rawBook('规则书', [DRAGON]) });
    // 停用只影响装配，不影响这一层的重名与计数
    const off = await send(app, 'PATCH', '/api/world-book', { bookId: bookIdOf(first), enabled: false }, cookie);
    expect(off.status).toBe(200);

    const second = await importBook(app, cookie, { scope: 'guild', scopeId: 'g1', book: rawBook('规则书', [WHALE]) });
    expect([first['name'], first['layerCount'], first['entryCount']]).toEqual(['规则书', 1, 1]);
    expect([second['name'], second['layerCount'], second['entryCount']]).toEqual(['规则书（2）', 2, 1]);
    expect(second['bookId']).not.toBe(first['bookId']);

    // 重名按层各算：另一层同名还是原样
    const other = await importBook(app, cookie, { scope: 'global', book: rawBook('规则书', [DRAGON]) });
    expect(other['name']).toBe('规则书');

    const items = await itemsOf(app, cookie);
    expect(items).toHaveLength(3);
    expect(
      items
        .filter((item) => item.scope === 'guild')
        .map((item) => [item.name, item.enabled])
        .sort(),
    ).toEqual([
      ['规则书', false],
      ['规则书（2）', true],
    ]);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM world_books').first<{ n: number }>();
    expect(rows?.n).toBe(3);
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

    const noEntries = await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: { name: '空书', entries: {} } }, cookie);
    expect(noEntries.status).toBe(400);
    const noEntriesBody = await jsonOf(noEntries);
    expect(noEntriesBody['error']).toBe('NO_WORLD_ENTRIES');
    expect(typeof noEntriesBody['detail']).toBe('string');

    expect(await itemsOf(app, cookie)).toEqual([]);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM world_books').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('DELETE 按 bookId 删一本：另一本原样留着，未命中算成功，坏 bookId 400', async () => {
    const { app, cookie } = await setup();
    const dragon = await importBook(app, cookie, { scope: 'global', book: rawBook('龙书', [DRAGON]) });
    const whale = await importBook(app, cookie, { scope: 'global', book: rawBook('鲸书', [WHALE]) });

    const del = await send(app, 'DELETE', '/api/world-book', { bookId: bookIdOf(dragon) }, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    expect((await itemsOf(app, cookie)).map((item) => [item.bookId, item.name])).toEqual([[bookIdOf(whale), '鲸书']]);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM world_books').first<{ n: number }>();
    expect(row?.n).toBe(1);

    // 再删同一本：命中 0 行也算成功
    const again = await send(app, 'DELETE', '/api/world-book', { bookId: bookIdOf(dragon) }, cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });

    for (const bad of [undefined, null, '', '   ', 42, 'x'.repeat(101)]) {
      const res = await send(app, 'DELETE', '/api/world-book', { bookId: bad }, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_BOOK_ID' });
    }
  });

  it('PATCH 整本开关：停用后 GET 列表 enabled=false，再开回 true，条目一个不动', async () => {
    const { app, cookie } = await setup();
    const imported = await importBook(app, cookie, { scope: 'global', book: rawBook('测试世界书', [DRAGON, WHALE]) });
    const bookId = bookIdOf(imported);

    const off = await send(app, 'PATCH', '/api/world-book', { bookId, enabled: false }, cookie);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ bookId, name: '测试世界书', enabled: false });
    expect((await itemsOf(app, cookie)).map((item) => [item.enabled, item.entryCount])).toEqual([[false, 2]]);
    // 停用只是不参与装配：书与条目都还在，单条照读
    expect((await singleOf(app, cookie, bookId, '0')).status).toBe(200);

    const on = await send(app, 'PATCH', '/api/world-book', { bookId, enabled: true }, cookie);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ bookId, name: '测试世界书', enabled: true });
    expect((await itemsOf(app, cookie)).map((item) => item.enabled)).toEqual([true]);

    const row = await env.DB.prepare('SELECT enabled, entry_count FROM world_books').first<{ enabled: number; entry_count: number }>();
    expect([row?.enabled, row?.entry_count]).toEqual([1, 2]);
  });

  it('PATCH 错误：坏 bookId 400 先于 enabled，enabled 非布尔 400，书不存在 404，且都不落库', async () => {
    const { app, cookie } = await setup();
    const imported = await importBook(app, cookie, { scope: 'global', book: rawBook('测试世界书', [DRAGON]) });
    const bookId = bookIdOf(imported);

    // bookId 先校验：坏 id 时连 enabled 都不看
    const badId = await send(app, 'PATCH', '/api/world-book', { bookId: '', enabled: 'yes' }, cookie);
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: 'BAD_BOOK_ID' });

    for (const enabled of ['yes', 1, 0, null]) {
      const res = await send(app, 'PATCH', '/api/world-book', { bookId, enabled }, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_BOOK_ENABLED' });
    }

    // 两个字段都不给不算合法更新：不猜调用方想干什么
    const empty = await send(app, 'PATCH', '/api/world-book', { bookId }, cookie);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'BAD_BOOK_UPDATE' });

    const missing = await send(app, 'PATCH', '/api/world-book', { bookId: '没这本书', enabled: false }, cookie);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'WORLD_BOOK_NOT_FOUND' });

    // 被拒的请求一次都没写
    expect((await itemsOf(app, cookie)).map((item) => item.enabled)).toEqual([true]);
  });

  it('PATCH 改名：trim 后落库，条目一字不动；enabled 可以同时改', async () => {
    const { app, cookie } = await setup();
    const imported = await importBook(app, cookie, { scope: 'global', book: rawBook('旧名字', [DRAGON, WHALE]) });
    const bookId = bookIdOf(imported);

    const res = await send(app, 'PATCH', '/api/world-book', { bookId, name: '  新名字  ' }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bookId, name: '新名字', enabled: true });
    expect((await itemsOf(app, cookie)).map((item) => [item.name, item.entryCount])).toEqual([['新名字', 2]]);
    expect((await singleOf(app, cookie, bookId, '0')).body['entry']).toMatchObject({ id: 0, name: '火龙设定' });

    const both = await send(app, 'PATCH', '/api/world-book', { bookId, name: '停用后改名', enabled: false }, cookie);
    expect(both.status).toBe(200);
    expect(await both.json()).toEqual({ bookId, name: '停用后改名', enabled: false });
    const row = await env.DB.prepare('SELECT name, enabled, entry_count FROM world_books WHERE book_id = ?')
      .bind(bookId)
      .first<{ name: string; enabled: number; entry_count: number }>();
    expect(row).toEqual({ name: '停用后改名', enabled: 0, entry_count: 2 });
  });

  it('PATCH 改名错误：空 / 超长 / 非字符串 400 BAD_BOOK_NAME，书不存在 404，原名不动', async () => {
    const { app, cookie } = await setup();
    const imported = await importBook(app, cookie, { scope: 'global', book: rawBook('原名', [DRAGON]) });
    const bookId = bookIdOf(imported);

    for (const name of ['', '   ', 'x'.repeat(81), 42, null]) {
      const res = await send(app, 'PATCH', '/api/world-book', { bookId, name }, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_BOOK_NAME' });
    }
    const missing = await send(app, 'PATCH', '/api/world-book', { bookId: '没这本书', name: '新名字' }, cookie);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'WORLD_BOOK_NOT_FOUND' });
    expect((await itemsOf(app, cookie)).map((item) => item.name)).toEqual(['原名']);
  });

  it('库里坏行当这本书不存在：坏 JSON / 形状不对都不出现在 GET，也不占下一本的名字', async () => {
    const { app, cookie } = await setup();
    // 绕过接口写进去的坏数据：JSON 半截、形状对不上（entries 不是数组）
    const insert = 'INSERT INTO world_books (book_id, scope, scope_id, name, book_json, entry_count, enabled, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    await env.DB.prepare(insert)
      .bind('bad-json', 'global', '', '半截书', '{"name":', 3, 1, '2026-01-01T00:00:00.000Z')
      .run();
    await env.DB.prepare(insert)
      .bind('bad-shape', 'global', '', '怪形状', '{"name":"怪形状","entries":"不是数组","ignored":[],"warnings":[]}', 2, 1, '2026-01-01T00:00:00.000Z')
      .run();

    expect(await itemsOf(app, cookie)).toEqual([]);

    const imported = await importBook(app, cookie, { scope: 'global', book: rawBook('好使的书', [DRAGON]) });
    // 坏行读不出来 = 这一层没书：既不占名字，也不算进 layerCount
    expect(imported['name']).toBe('好使的书');
    expect(imported['layerCount']).toBe(1);
    expect((await itemsOf(app, cookie)).map((item) => [item.scope, item.name])).toEqual([['global', '好使的书']]);
  });

  it('仓储未接线：列表 / 导入 / 删书 / 开关全部回 501 WORLDBOOK_UNAVAILABLE', async () => {
    const { app, cookie } = await setup({ wired: false });

    const listed = await app.request('/api/world-book', { headers: { cookie } });
    expect(listed.status).toBe(501);
    expect(await listed.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const imported = await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: rawBook('书', [DRAGON]) }, cookie);
    expect(imported.status).toBe(501);
    expect(await imported.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const removed = await send(app, 'DELETE', '/api/world-book', { bookId: 'any' }, cookie);
    expect(removed.status).toBe(501);
    expect(await removed.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const patched = await send(app, 'PATCH', '/api/world-book', { bookId: 'any', enabled: false }, cookie);
    expect(patched.status).toBe(501);
    expect(await patched.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });
  });
});

/** 导入一本两条目的样本书，返回它的 bookId：单条用例都以它为前提 */
async function importSample(app: App, cookie: string): Promise<string> {
  const saved = await importBook(app, cookie, { scope: 'global', scopeId: '', book: rawBook('测试世界书', [DRAGON, WHALE]) });
  return bookIdOf(saved);
}

describe('admin world book single entry', () => {
  it('列表补出编辑用的新字段，且仍然不带正文', async () => {
    const { app, cookie } = await setup();
    await importSample(app, cookie);

    const entries = (await itemsOf(app, cookie))[0]?.entries as Json[];
    expect(entries).toHaveLength(2);
    // 导入的原始条目没有位置/概率这些字段：列表必须回补齐后的默认值，前端才敢直接拿去编辑
    expect(entries[0]).toMatchObject({
      id: 0,
      selective: true,
      selectiveLogic: 'andAny',
      caseSensitive: false,
      wholeWords: false,
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
    expect(entries.every((entry) => !('content' in entry))).toBe(true);
  });

  it('GET 单条：按 bookId + id 回正文与全部字段', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);

    const read = await singleOf(app, cookie, bookId, '0');
    expect(read.status).toBe(200);
    expect(read.body['entry']).toEqual({
      id: 0,
      name: '火龙设定',
      keys: ['龙', 'dragon'],
      secondaryKeys: [],
      content: '火龙的鳞片会发光',
      enabled: true,
      constant: false,
      selective: true,
      selectiveLogic: 'andAny',
      order: 100,
      caseSensitive: false,
      wholeWords: false,
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

  it('entry 路由按 bookId 隔离：两本书的 id=1 各取各的正文', async () => {
    const { app, cookie } = await setup();
    const { a, b } = await importIsolationPair(app, cookie);

    const fromA = (await singleOf(app, cookie, a, '1')).body['entry'] as Json;
    const fromB = (await singleOf(app, cookie, b, '1')).body['entry'] as Json;
    expect([fromA['id'], fromA['name'], fromA['content']]).toEqual([1, 'A1', 'A 书的一号']);
    expect([fromB['id'], fromB['name'], fromB['content']]).toEqual([1, 'B1', 'B 书一号']);

    // 列表里两本各自带自己的条目摘要与自己的 bookId
    const items = await itemsOf(app, cookie);
    expect(items.map((item) => item.bookId).sort()).toEqual([a, b].sort());
    for (const item of items) {
      const contents = (item.entries as Json[]).map((entry) => entry.name);
      expect(contents).toEqual(item.bookId === a ? ['火龙设定', 'A1'] : ['B0', 'B1']);
    }
  });

  it('GET 单条错误：坏 bookId 400（先于 id），书不存在 404，id 不合法 400，条目不存在 404', async () => {
    const { app, cookie } = await setup();

    // 缺 bookId 时连 id 都不看
    const noBookId = await app.request('/api/world-book/entry?id=0', { headers: { cookie } });
    expect(noBookId.status).toBe(400);
    expect(await noBookId.json()).toEqual({ error: 'BAD_BOOK_ID' });
    expect(await singleOf(app, cookie, '   ', 'abc')).toEqual({ status: 400, body: { error: 'BAD_BOOK_ID' } });

    expect(await singleOf(app, cookie, '没这本书', '0')).toEqual({ status: 404, body: { error: 'WORLD_BOOK_NOT_FOUND' } });

    const bookId = await importSample(app, cookie);
    expect(await singleOf(app, cookie, bookId, '99')).toEqual({ status: 404, body: { error: 'WORLD_ENTRY_NOT_FOUND' } });
    for (const bad of ['abc', '1.5', '-1', '', '0x1']) {
      expect(await singleOf(app, cookie, bookId, bad)).toEqual({ status: 400, body: { error: 'BAD_WORLD_ENTRY' } });
    }
  });

  it('PUT 单条：只换同 id 那一条并整本回写，另一条与书名原样，再 GET 读回同一份', async () => {
    const calls: Parameters<WorldBookStore['update']>[0][] = [];
    const recording = (store: WorldBookStore): WorldBookStore => ({
      list: () => store.list(),
      get: (bookId) => store.get(bookId),
      create: (input) => store.create(input),
      update: (input) => {
        calls.push(input);
        return store.update(input);
      },
      remove: (bookId) => store.remove(bookId),
    });
    const { app, cookie } = await setup({ wrapStore: recording });
    const bookId = await importSample(app, cookie);
    // 导入本身也走 create：清掉它，之后只数路由这一次
    calls.length = 0;

    const before = (await singleOf(app, cookie, bookId, '0')).body['entry'] as Json;
    // 另一条不参与编辑：PUT 之后它必须逐字不变，证明只替换了同 id 那一条
    const sibling = (await singleOf(app, cookie, bookId, '1')).body['entry'] as Json;

    const edited: Json = {
      ...before,
      name: '改名后的火龙',
      content: '新正文\n第二行',
      keys: ['龙'],
      secondaryKeys: ['dragon'],
      selective: false,
      selectiveLogic: 'notAny',
      constant: true,
      caseSensitive: true,
      wholeWords: true,
      order: 7,
      position: 'atDepth',
      depth: 2,
      role: 'user',
      probability: 40,
      useProbability: true,
      group: '设定',
      groupWeight: 30,
      sticky: 2,
      cooldown: 3,
      delay: 4,
      scanDepth: 6,
    };

    const res = await send(app, 'PUT', '/api/world-book/entry', { bookId, entry: edited }, cookie);
    expect(res.status).toBe(200);
    expect((await jsonOf(res))['entry']).toEqual(edited);

    // 落库走的是整本 update：书在、两条都在、同 id 那条被替换
    expect(calls).toHaveLength(1);
    const written = calls[0];
    expect(written?.bookId).toBe(bookId);
    expect(written?.enabled).toBeUndefined();
    const book = written?.book as { entries: Json[]; ignored: Json[]; warnings: Json[] } | undefined;
    expect(book?.entries).toHaveLength(2);
    expect(book?.entries[0]).toEqual(edited);
    expect(book?.entries[1]).toEqual(sibling);
    expect(book?.ignored).toEqual([]);
    expect(book?.warnings).toEqual([]);

    // D1 里只有同一行的 book_id：整本回写而不是插一行新的
    const rows = await env.DB.prepare('SELECT book_id, name, entry_count, book_json FROM world_books').all<{
      book_id: string;
      name: string;
      entry_count: number;
      book_json: string;
    }>();
    expect(rows.results).toHaveLength(1);
    expect([rows.results[0]?.book_id, rows.results[0]?.name, rows.results[0]?.entry_count]).toEqual([bookId, '测试世界书', 2]);
    const stored = JSON.parse(rows.results[0]?.book_json ?? '{}') as { entries: Json[] };
    expect(stored.entries[0]).toEqual(edited);
    expect(stored.entries[1]).toEqual(sibling);

    // PUT 之后单条与列表拿到的是同一份
    expect((await singleOf(app, cookie, bookId, '0')).body['entry']).toEqual(edited);
    const listed = (await itemsOf(app, cookie))[0]?.entries as Json[];
    expect(listed.map((entry) => [entry.id, entry.name, entry.position, entry.role, entry.scanDepth])).toEqual([
      [0, '改名后的火龙', 'atDepth', 'user', 6],
      [1, '表情条目', 'anTop', 'system', null],
    ]);
    expect(listed[0]?.chars).toBe(7);
    expect(listed.every((entry) => !('content' in entry))).toBe(true);
  });

  it('PUT 逐项校验各回 400 并指名哪一项，且一个字都不落库', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);
    const base = (await singleOf(app, cookie, bookId, '0')).body['entry'] as Json;

    const cases: { field: string; patch: Json }[] = [
      { field: 'position', patch: { position: 'middle' } },
      { field: 'role', patch: { role: 'tool' } },
      { field: 'keys', patch: { keys: ['龙', 1] } },
      { field: 'probability', patch: { probability: 101 } },
      { field: 'scanDepth', patch: { scanDepth: 0 } },
      { field: 'depth', patch: { depth: 51 } },
      { field: 'content', patch: { content: '   ' } },
      { field: 'name', patch: { name: '' } },
      { field: 'groupWeight', patch: { groupWeight: 1.5 } },
      { field: 'sticky', patch: { sticky: -1 } },
      // sticky/cooldown 与导入侧一样夹 0..10000，不能跟着 delay 放宽
      { field: 'sticky', patch: { sticky: 10001 } },
      { field: 'cooldown', patch: { cooldown: 10001 } },
      { field: 'delay', patch: { delay: 100001 } },
      { field: 'selectiveLogic', patch: { selectiveLogic: 'orAll' } },
      { field: 'enabled', patch: { enabled: 'yes' } },
    ];

    for (const item of cases) {
      const res = await send(app, 'PUT', '/api/world-book/entry', { bookId, entry: { ...base, ...item.patch } }, cookie);
      expect(res.status).toBe(400);
      const body = await jsonOf(res);
      expect(body['error']).toBe('BAD_WORLD_ENTRY');
      expect(body['detail']).toContain(item.field);
    }

    // 缺字段也是 400：PUT 是整条覆盖，不能靠「没传就沿用旧值」
    const missing: Json = { ...base };
    delete missing['enabled'];
    const missingRes = await send(app, 'PUT', '/api/world-book/entry', { bookId, entry: missing }, cookie);
    expect(missingRes.status).toBe(400);
    expect((await jsonOf(missingRes))['detail']).toContain('enabled');

    // 被拒的请求一次都没写：条目还是导入时那一份
    expect((await singleOf(app, cookie, bookId, '0')).body['entry']).toEqual(base);
    const rows = await env.DB.prepare('SELECT book_json FROM world_books WHERE book_id = ?').bind(bookId).all<{ book_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect((JSON.parse(rows.results[0]?.book_json ?? '{}') as { entries: Json[] }).entries[0]).toEqual(base);
  });

  it('PUT 单条：delay 到 100000 按原样落库并读回，上限与 sticky/cooldown 分开', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);
    const base = (await singleOf(app, cookie, bookId, '0')).body['entry'] as Json;

    const edited: Json = { ...base, delay: 100000, sticky: 10000, cooldown: 10000 };
    const res = await send(app, 'PUT', '/api/world-book/entry', { bookId, entry: edited }, cookie);
    expect(res.status).toBe(200);
    expect((await jsonOf(res))['entry']).toEqual(edited);

    const readBack = (await singleOf(app, cookie, bookId, '0')).body['entry'] as Json;
    expect([readBack['delay'], readBack['sticky'], readBack['cooldown']]).toEqual([100000, 10000, 10000]);

    const row = await env.DB.prepare('SELECT book_json FROM world_books WHERE book_id = ?').bind(bookId).first<{ book_json: string }>();
    const stored = (JSON.parse(row?.book_json ?? '{}') as { entries: Json[] }).entries[0];
    expect([stored?.['delay'], stored?.['sticky'], stored?.['cooldown']]).toEqual([100000, 10000, 10000]);
  });

  it('PUT 错误：坏 bookId 400，书不存在 404，条目不在本书 404，另一本同 id 条目不受影响', async () => {
    const { app, cookie } = await setup();
    const badId = await send(app, 'PUT', '/api/world-book/entry', { bookId: '', entry: {} }, cookie);
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: 'BAD_BOOK_ID' });

    const { a, b } = await importIsolationPair(app, cookie);
    const fromA = (await singleOf(app, cookie, a, '0')).body['entry'] as Json;
    const fromB = (await singleOf(app, cookie, b, '0')).body['entry'] as Json;

    // 合法条目 + 没有这本书：这是「书不存在」，不是 400
    const noBook = await send(app, 'PUT', '/api/world-book/entry', { bookId: '没这本书', entry: fromA }, cookie);
    expect(noBook.status).toBe(404);
    expect(await noBook.json()).toEqual({ error: 'WORLD_BOOK_NOT_FOUND' });

    // 书里有 id 0/1，没有 99：PUT 不做新增
    const noEntry = await send(app, 'PUT', '/api/world-book/entry', { bookId: a, entry: { ...fromA, id: 99 } }, cookie);
    expect(noEntry.status).toBe(404);
    expect(await noEntry.json()).toEqual({ error: 'WORLD_ENTRY_NOT_FOUND' });

    // 改 A 的 id=0：B 的 id=0 逐字不变
    const edited: Json = { ...fromA, content: 'A 书改过的零号' };
    const res = await send(app, 'PUT', '/api/world-book/entry', { bookId: a, entry: edited }, cookie);
    expect(res.status).toBe(200);
    expect((await singleOf(app, cookie, b, '0')).body['entry']).toEqual(fromB);
  });
});

/** 新建用的合法条目：新建时 id 由服务端给，所以这里不带 id */
function entryInput(overrides: Json = {}): Json {
  return {
    name: '手工条目',
    keys: ['手写'],
    secondaryKeys: [],
    content: '手写正文',
    enabled: true,
    constant: false,
    selective: true,
    selectiveLogic: 'andAny',
    order: 100,
    caseSensitive: false,
    wholeWords: false,
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
    ...overrides,
  };
}

describe('admin world book create and delete entry', () => {
  it('POST 到指定 bookId：id 给本书 max+1，其余条目逐字不变，bookName 不参与', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);
    const sibling = (await singleOf(app, cookie, bookId, '1')).body['entry'] as Json;

    // 已有书时 bookName 是噪声：这里故意传 null，新建照走 bookId
    const res = await send(
      app,
      'POST',
      '/api/world-book/entry',
      { bookId, bookName: null, entry: entryInput({ name: '手写第二条' }) },
      cookie,
    );
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    const entry = saved['entry'] as Json;
    // 导入的两条 id 是 0/1，新条目接在 2
    expect(entry['id']).toBe(2);
    expect(entry['name']).toBe('手写第二条');
    expect(saved['bookId']).toBe(bookId);
    expect(saved['createdBook']).toBe(false);
    expect(saved['name']).toBe('测试世界书');
    expect(saved['entryCount']).toBe(3);

    const read = await singleOf(app, cookie, bookId, '2');
    expect(read.status).toBe(200);
    expect(read.body['entry']).toEqual(entry);
    expect((await singleOf(app, cookie, bookId, '1')).body['entry']).toEqual(sibling);
  });

  it('删掉中间那条再新建：新 id 接在本书当前 max+1，不回头补空出来的号', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);
    await send(app, 'POST', '/api/world-book/entry', { bookId, entry: entryInput({ name: '第三条' }) }, cookie);
    expect((await singleOf(app, cookie, bookId, '2')).status).toBe(200);

    const del = await send(app, 'DELETE', '/api/world-book/entry', { bookId, id: 1 }, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, entryCount: 2, removedBook: false });

    const res = await send(app, 'POST', '/api/world-book/entry', { bookId, entry: entryInput({ name: '新的一条' }) }, cookie);
    expect(res.status).toBe(200);
    // 当前最大 id 是 2，删掉的 1 不再回头补
    expect(((await jsonOf(res))['entry'] as Json)['id']).toBe(3);
    expect((await singleOf(app, cookie, bookId, '1')).status).toBe(404);
  });

  it('删掉当前最大号再新建：id 继续往上加，不复用刚删掉的号', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);
    const created = await send(app, 'POST', '/api/world-book/entry', { bookId, entry: entryInput({ name: '会被删掉的' }) }, cookie);
    expect(((await jsonOf(created))['entry'] as Json)['id']).toBe(2);
    const del = await send(app, 'DELETE', '/api/world-book/entry', { bookId, id: 2 }, cookie);
    expect(del.status).toBe(200);

    const res = await send(app, 'POST', '/api/world-book/entry', { bookId, entry: entryInput({ name: '后来的' }) }, cookie);
    expect(res.status).toBe(200);
    // 计数器记在 book_json：本书当前 max 是 1，但 2 已经发出去过，接着发 3
    expect(((await jsonOf(res))['entry'] as Json)['id']).toBe(3);
    expect((await singleOf(app, cookie, bookId, '2')).status).toBe(404);
  });

  it('POST 不带 bookId：在指定层新开一本，bookName 去空白，id 从 1 开始', async () => {
    const { app, cookie } = await setup();
    const res = await send(
      app,
      'POST',
      '/api/world-book/entry',
      { scope: 'guild', scopeId: 'g1', bookName: '  我自己的书  ', entry: entryInput() },
      cookie,
    );
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    const bookId = bookIdOf(saved);
    expect(saved['createdBook']).toBe(true);
    expect(saved['name']).toBe('我自己的书');
    expect(saved['entryCount']).toBe(1);
    expect((saved['entry'] as Json)['id']).toBe(1);

    const items = await itemsOf(app, cookie);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ scope: 'guild', scopeId: 'g1', bookId, name: '我自己的书', enabled: true, entryCount: 1 });
    expect((await singleOf(app, cookie, bookId, '1')).body['entry']).toEqual(saved['entry']);
  });

  it('同一层再建一本同名书：书名加「（2）」，两本各自从 id=1 开始', async () => {
    const { app, cookie } = await setup();
    const create = async (name: string): Promise<Json> => {
      const res = await send(
        app,
        'POST',
        '/api/world-book/entry',
        { scope: 'global', scopeId: '', bookName: '手写书', entry: entryInput({ name }) },
        cookie,
      );
      expect(res.status).toBe(200);
      return jsonOf(res);
    };

    const first = await create('第一条');
    const second = await create('第二条');
    expect([first['name'], second['name']]).toEqual(['手写书', '手写书（2）']);
    expect(first['bookId']).not.toBe(second['bookId']);
    // 条目 id 只在书内唯一：两本都是 1
    expect([(first['entry'] as Json)['id'], (second['entry'] as Json)['id']]).toEqual([1, 1]);
    expect(await itemsOf(app, cookie)).toHaveLength(2);
  });

  it('POST 不带 bookId 缺书名 / 空白 / 超长 / 非字符串：400 BAD_BOOK_NAME，一本都不落库', async () => {
    const { app, cookie } = await setup();
    for (const bookName of [null, '   ', 'x'.repeat(81), 42]) {
      const res = await send(app, 'POST', '/api/world-book/entry', { scope: 'global', scopeId: '', bookName, entry: entryInput() }, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_BOOK_NAME' });
    }
    expect(await itemsOf(app, cookie)).toEqual([]);
  });

  it('POST 条目不合法：400 BAD_WORLD_ENTRY 并点名，缺 id 不算错（新建时由服务端分配）', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);

    const noName = await send(app, 'POST', '/api/world-book/entry', { bookId, entry: entryInput({ name: '   ' }) }, cookie);
    expect(noName.status).toBe(400);
    expect(await noName.json()).toEqual({ error: 'BAD_WORLD_ENTRY', detail: 'name 不能为空' });

    const badDepth = await send(app, 'POST', '/api/world-book/entry', { bookId, entry: entryInput({ depth: 51 }) }, cookie);
    expect(badDepth.status).toBe(400);
    expect(((await badDepth.json()) as Json)['detail']).toBe('depth 必须是 0..50 的整数');

    // 失败不落库：导入的两条还在
    expect(((await itemsOf(app, cookie))[0] as Json)['entryCount']).toBe(2);
  });

  it('POST 请求里的 id 被忽略：新 id 仍然接在本书最大 id 之后', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);
    const res = await send(app, 'POST', '/api/world-book/entry', { bookId, entry: entryInput({ id: 99 }) }, cookie);
    expect(res.status).toBe(200);
    expect(((await jsonOf(res))['entry'] as Json)['id']).toBe(2);
  });

  it('POST 带坏 bookId：不存在 404，空串 / 非字符串 400，且都不落库', async () => {
    const { app, cookie } = await setup();
    const bookId = await importSample(app, cookie);

    const missing = await send(app, 'POST', '/api/world-book/entry', { bookId: '没这本书', entry: entryInput() }, cookie);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'WORLD_BOOK_NOT_FOUND' });

    for (const bad of [42, '', '   ', 'x'.repeat(101)]) {
      const res = await send(app, 'POST', '/api/world-book/entry', { bookId: bad, entry: entryInput() }, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_BOOK_ID' });
    }

    expect(((await itemsOf(app, cookie))[0] as Json)['entryCount']).toBe(2);
    expect((await singleOf(app, cookie, bookId, '2')).status).toBe(404);
  });

  it('DELETE 中间一条：只少这一条，其余逐字不变，另一本同 id 条目还在', async () => {
    const { app, cookie } = await setup();
    const { a, b } = await importIsolationPair(app, cookie);
    const first = (await singleOf(app, cookie, a, '0')).body['entry'] as Json;
    const other = (await singleOf(app, cookie, b, '1')).body['entry'] as Json;

    const res = await send(app, 'DELETE', '/api/world-book/entry', { bookId: a, id: 1 }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, entryCount: 1, removedBook: false });

    expect((await singleOf(app, cookie, a, '1')).status).toBe(404);
    expect((await singleOf(app, cookie, a, '0')).body['entry']).toEqual(first);
    // B 书同 id 的条目没被牵连
    expect((await singleOf(app, cookie, b, '1')).body['entry']).toEqual(other);
  });

  it('DELETE 逐条删空：倒数第二条只少一条，最后一条连书一起移除', async () => {
    const { app, cookie } = await setup();
    const { a, b } = await importIsolationPair(app, cookie);

    const first = await send(app, 'DELETE', '/api/world-book/entry', { bookId: a, id: 0 }, cookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, entryCount: 1, removedBook: false });

    const last = await send(app, 'DELETE', '/api/world-book/entry', { bookId: a, id: 1 }, cookie);
    expect(last.status).toBe(200);
    expect(await last.json()).toEqual({ ok: true, entryCount: 0, removedBook: true });

    // A 书没了，B 书一个字都没动
    expect(await singleOf(app, cookie, a, '0')).toEqual({ status: 404, body: { error: 'WORLD_BOOK_NOT_FOUND' } });
    expect((await itemsOf(app, cookie)).map((item) => item.bookId)).toEqual([b]);
    expect((await singleOf(app, cookie, b, '1')).body['entry']).toMatchObject({ id: 1, content: 'B 书一号' });
  });

  it('DELETE 最后一条：书停在一条条目时删掉它，整本书一起移除，另一本原样留着', async () => {
    const { app, cookie } = await setup();
    const one = await importBook(app, cookie, { scope: 'channel', scopeId: 'c1', book: rawBook('临时书', [DRAGON]) });
    const keep = await importBook(app, cookie, { scope: 'global', book: rawBook('留着的书', [WHALE]) });

    const res = await send(app, 'DELETE', '/api/world-book/entry', { bookId: bookIdOf(one), id: 0 }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, entryCount: 0, removedBook: true });

    expect((await itemsOf(app, cookie)).map((item) => [item.bookId, item.name])).toEqual([[bookIdOf(keep), '留着的书']]);
    expect(await singleOf(app, cookie, bookIdOf(one), '0')).toEqual({ status: 404, body: { error: 'WORLD_BOOK_NOT_FOUND' } });
  });

  it('DELETE 错误：坏 bookId 400，书不存在 / 条目不存在 404，id 不是非负整数 400', async () => {
    const { app, cookie } = await setup();
    const noBookId = await send(app, 'DELETE', '/api/world-book/entry', { id: 0 }, cookie);
    expect(noBookId.status).toBe(400);
    expect(await noBookId.json()).toEqual({ error: 'BAD_BOOK_ID' });

    const noBook = await send(app, 'DELETE', '/api/world-book/entry', { bookId: '没这本书', id: 0 }, cookie);
    expect(noBook.status).toBe(404);
    expect(await noBook.json()).toEqual({ error: 'WORLD_BOOK_NOT_FOUND' });

    const bookId = await importSample(app, cookie);
    const noEntry = await send(app, 'DELETE', '/api/world-book/entry', { bookId, id: 99 }, cookie);
    expect(noEntry.status).toBe(404);
    expect(await noEntry.json()).toEqual({ error: 'WORLD_ENTRY_NOT_FOUND' });

    for (const id of ['1', -1, 1.5, null]) {
      const res = await send(app, 'DELETE', '/api/world-book/entry', { bookId, id }, cookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Json)['error']).toBe('BAD_WORLD_ENTRY');
    }
  });

  it('仓储未接线：单条读取 / 保存 / 新建 / 删除全部回 501', async () => {
    const { app, cookie } = await setup({ wired: false });

    const single = await app.request('/api/world-book/entry?bookId=any&id=0', { headers: { cookie } });
    expect(single.status).toBe(501);
    expect(await single.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const saved = await send(app, 'PUT', '/api/world-book/entry', { bookId: 'any', entry: {} }, cookie);
    expect(saved.status).toBe(501);
    expect(await saved.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    for (const method of ['POST', 'DELETE']) {
      const res = await send(
        app,
        method,
        '/api/world-book/entry',
        { bookId: 'any', scope: 'global', scopeId: '', bookName: '书', entry: entryInput(), id: 0 },
        cookie,
      );
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });
    }
  });
});
