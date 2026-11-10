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
  /** 包一层仓储，用来观察路由到底把什么交给 put（整本还是单条） */
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

  it('仓储未接线：列表 / 单条 / 导入 / 删除全部回 501 WORLDBOOK_UNAVAILABLE', async () => {
    const { app, cookie } = await setup({ wired: false });

    const listed = await app.request('/api/world-book', { headers: { cookie } });
    expect(listed.status).toBe(501);
    expect(await listed.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const single = await app.request('/api/world-book/entry?scope=global&scopeId=&id=0', { headers: { cookie } });
    expect(single.status).toBe(501);
    expect(await single.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const saved = await send(app, 'PUT', '/api/world-book/entry', { scope: 'global', scopeId: '', entry: {} }, cookie);
    expect(saved.status).toBe(501);
    expect(await saved.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const imported = await send(app, 'POST', '/api/world-book/import', { scope: 'global', book: rawBook('书', [DRAGON]) }, cookie);
    expect(imported.status).toBe(501);
    expect(await imported.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });

    const removed = await send(app, 'DELETE', '/api/world-book', { scope: 'global' }, cookie);
    expect(removed.status).toBe(501);
    expect(await removed.json()).toEqual({ error: 'WORLDBOOK_UNAVAILABLE' });
  });
});

/** 导入一本两层条目的样本书，返回后所有单条用例都以它为前提 */
async function importSample(app: App, cookie: string): Promise<void> {
  const res = await send(
    app,
    'POST',
    '/api/world-book/import',
    { scope: 'global', scopeId: '', book: rawBook('测试世界书', [DRAGON, WHALE]) },
    cookie,
  );
  expect(res.status).toBe(200);
}

/** 单条读取的快捷入口：path 里的 scope 固定 global，id 由用例给（含非法值） */
async function singleOf(app: App, cookie: string, id: string): Promise<{ status: number; body: Json }> {
  const res = await app.request('/api/world-book/entry?scope=global&scopeId=&id=' + encodeURIComponent(id), {
    headers: { cookie },
  });
  return { status: res.status, body: await jsonOf(res) };
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

  it('GET 单条：回正文与全部字段', async () => {
    const { app, cookie } = await setup();
    await importSample(app, cookie);

    const read = await singleOf(app, cookie, '0');
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

  it('GET 单条：书不存在 / 条目不存在各回 404，id 不是非负整数回 400', async () => {
    const { app, cookie } = await setup();

    // 这一层没有书：按层的键区分，不跟别层混
    expect(await singleOf(app, cookie, '0')).toEqual({ status: 404, body: { error: 'WORLD_BOOK_NOT_FOUND' } });

    await importSample(app, cookie);
    expect(await singleOf(app, cookie, '99')).toEqual({ status: 404, body: { error: 'WORLD_ENTRY_NOT_FOUND' } });

    for (const bad of ['abc', '1.5', '-1', '', '0x1']) {
      expect(await singleOf(app, cookie, bad)).toEqual({ status: 400, body: { error: 'BAD_WORLD_ENTRY' } });
    }
  });

  it('PUT 单条：整本回写，同 id 替换、其余条目原样，再 GET 读回同一份', async () => {
    const puts: Parameters<WorldBookStore['put']>[0][] = [];
    const recording = (store: WorldBookStore): WorldBookStore => ({
      get: (key) => store.get(key),
      list: () => store.list(),
      put: (input) => {
        puts.push(input);
        return store.put(input);
      },
      remove: (key) => store.remove(key),
    });
    const { app, cookie } = await setup({ wrapStore: recording });
    await importSample(app, cookie);
    // 导入本身也走 put：清掉它，之后只数路由这一次
    puts.length = 0;

    const before = (await singleOf(app, cookie, '0')).body['entry'] as Json;
    // 另一条不参与编辑：PUT 之后它必须逐字不变，证明只替换了同 id 那一条
    const sibling = (await singleOf(app, cookie, '1')).body['entry'] as Json;

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

    const res = await send(app, 'PUT', '/api/world-book/entry', { scope: 'global', scopeId: '', entry: edited }, cookie);
    expect(res.status).toBe(200);
    const saved = (await jsonOf(res))['entry'] as Json;
    expect(saved).toEqual(edited);

    // 落库走的是整本 put：书在、两条都在、同 id 那条被替换
    expect(puts).toHaveLength(1);
    const written = puts[0];
    expect([written?.scope, written?.scopeId, written?.name]).toEqual(['global', '', '测试世界书']);
    const book = written?.book;
    expect(book?.entries).toHaveLength(2);
    expect(book?.entries[0]).toEqual(edited);
    expect(book?.entries[1]).toEqual(sibling);
    expect(book?.ignored).toEqual([]);
    expect(book?.warnings).toEqual([]);

    // D1 里只有一行：整本覆盖而不是插一行新的
    const rows = await env.DB.prepare('SELECT name, entry_count, book_json FROM world_books').all<{
      name: string;
      entry_count: number;
      book_json: string;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.name).toBe('测试世界书');
    expect(rows.results[0]?.entry_count).toBe(2);
    const stored = JSON.parse(rows.results[0]?.book_json ?? '{}') as { entries: Json[] };
    expect(stored.entries[0]).toEqual(edited);
    expect(stored.entries[1]).toEqual(sibling);

    // PUT 之后单条与列表拿到的是同一份
    expect((await singleOf(app, cookie, '0')).body['entry']).toEqual(edited);
    const listed = (await itemsOf(app, cookie))[0]?.entries as Json[];
    expect(listed.map((entry) => [entry.id, entry.name, entry.position, entry.role, entry.scanDepth])).toEqual([
      [0, '改名后的火龙', 'atDepth', 'user', 6],
      [1, '表情条目', 'anTop', 'system', null],
    ]);
    expect(listed[0]?.chars).toBe(7);
    expect(listed.every((entry) => !('content' in entry))).toBe(true);
  });

  it('PUT 单条：逐项校验各回 400 并指名哪一项，且一个字都不落库', async () => {
    const { app, cookie } = await setup();
    await importSample(app, cookie);
    const base = (await singleOf(app, cookie, '0')).body['entry'] as Json;

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
      const res = await send(
        app,
        'PUT',
        '/api/world-book/entry',
        { scope: 'global', scopeId: '', entry: { ...base, ...item.patch } },
        cookie,
      );
      expect(res.status).toBe(400);
      const body = await jsonOf(res);
      expect(body['error']).toBe('BAD_WORLD_ENTRY');
      expect(body['detail']).toContain(item.field);
    }

    // 缺字段也是 400：PUT 是整条覆盖，不能靠「没传就沿用旧值」
    const missing: Json = { ...base };
    delete missing['enabled'];
    const missingRes = await send(
      app,
      'PUT',
      '/api/world-book/entry',
      { scope: 'global', scopeId: '', entry: missing },
      cookie,
    );
    expect(missingRes.status).toBe(400);
    expect((await jsonOf(missingRes))['detail']).toContain('enabled');

    // 被拒的请求一次都没写：条目还是导入时那一份
    expect((await singleOf(app, cookie, '0')).body['entry']).toEqual(base);
    const rows = await env.DB.prepare('SELECT book_json FROM world_books').all<{ book_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect((JSON.parse(rows.results[0]?.book_json ?? '{}') as { entries: Json[] }).entries[0]).toEqual(base);
  });

  it('PUT 单条：delay 到 100000 按原样落库并读回，上限与 sticky/cooldown 分开', async () => {
    const { app, cookie } = await setup();
    await importSample(app, cookie);
    const base = (await singleOf(app, cookie, '0')).body['entry'] as Json;

    const edited: Json = { ...base, delay: 100000, sticky: 10000, cooldown: 10000 };
    const res = await send(app, 'PUT', '/api/world-book/entry', { scope: 'global', scopeId: '', entry: edited }, cookie);
    expect(res.status).toBe(200);
    expect((await jsonOf(res))['entry']).toEqual(edited);

    const readBack = (await singleOf(app, cookie, '0')).body['entry'] as Json;
    expect([readBack['delay'], readBack['sticky'], readBack['cooldown']]).toEqual([100000, 10000, 10000]);

    const row = await env.DB.prepare('SELECT book_json FROM world_books').first<{ book_json: string }>();
    const stored = (JSON.parse(row?.book_json ?? '{}') as { entries: Json[] }).entries[0];
    expect([stored?.['delay'], stored?.['sticky'], stored?.['cooldown']]).toEqual([100000, 10000, 10000]);
  });

  it('PUT 单条：书不存在 / 条目不存在回 404，非法层回 BAD_SCOPE', async () => {
    const { app, cookie } = await setup();
    await importSample(app, cookie);
    const base = (await singleOf(app, cookie, '0')).body['entry'] as Json;

    // 合法条目 + 没有书的层：这是「书不存在」，不是 400
    const noBook = await send(
      app,
      'PUT',
      '/api/world-book/entry',
      { scope: 'guild', scopeId: 'g1', entry: base },
      cookie,
    );
    expect(noBook.status).toBe(404);
    expect(await noBook.json()).toEqual({ error: 'WORLD_BOOK_NOT_FOUND' });

    // 书里有 id 0/1，没有 99：PUT 不做新增
    const noEntry = await send(
      app,
      'PUT',
      '/api/world-book/entry',
      { scope: 'global', scopeId: '', entry: { ...base, id: 99 } },
      cookie,
    );
    expect(noEntry.status).toBe(404);
    expect(await noEntry.json()).toEqual({ error: 'WORLD_ENTRY_NOT_FOUND' });

    const badScope = await send(
      app,
      'PUT',
      '/api/world-book/entry',
      { scope: 'team', scopeId: '', entry: base },
      cookie,
    );
    expect(badScope.status).toBe(400);
    expect(await badScope.json()).toEqual({ error: 'BAD_SCOPE' });
  });
});
