import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_BASE_URL_MAX_CHARS, IMAGE_MODEL_MAX_CHARS } from '../src/core/chat/image-settings';
import { IMAGE_MODEL_NAME } from '../src/core/chat/image-tool';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

const MASTER_KEY = toBase64(new Uint8Array(32).fill(13));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** overrides 用来造未接线部署：imageSettings: undefined 等价于没接这个仓储 */
function makeApp(overrides: Partial<AdminAppDeps> = {}) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
    ...overrides,
  };
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

async function setup() {
  const app = makeApp();
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM image_settings')]);
});

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function getSettings(app: App, cookie: string): Promise<Json> {
  const res = await send(app, 'GET', '/api/image-settings', undefined, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

describe('GET /api/image-settings', () => {
  it('空库：items 空数组，defaultModel 与两条长度上限一起回（后台不抄常量）', async () => {
    const { app, cookie } = await setup();

    expect(await getSettings(app, cookie)).toEqual({
      items: [],
      defaultModel: IMAGE_MODEL_NAME,
      limits: { model: IMAGE_MODEL_MAX_CHARS, baseUrl: IMAGE_BASE_URL_MAX_CHARS },
    });
    expect(IMAGE_MODEL_NAME).toBe('gemini-nano-banana-2.1');
    expect([IMAGE_MODEL_MAX_CHARS, IMAGE_BASE_URL_MAX_CHARS]).toEqual([200, 500]);
  });

  it('未登录 401：与其它 /api 路由同一道闸门', async () => {
    const app = makeApp();
    expect((await send(app, 'GET', '/api/image-settings')).status).toBe(401);
    expect((await send(app, 'PUT', '/api/image-settings', { scope: 'global' })).status).toBe(401);
    expect((await send(app, 'DELETE', '/api/image-settings', { scope: 'global' })).status).toBe(401);
  });
});

describe('PUT /api/image-settings', () => {
  it('global 往返：200 回写后的对象，keyHint 是掩码、响应里没有明文，GET 列表能读回同一行', async () => {
    const { app, cookie } = await setup();
    const apiKey = 'sk-image-SECRET-7777';

    const res = await send(
      app,
      'PUT',
      '/api/image-settings',
      { scope: 'global', model: '  gemini-custom  ', baseUrl: '  https://img.example.com/v1  ', apiKey },
      cookie,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(apiKey);
    expect(JSON.parse(text)).toEqual({
      scope: 'global',
      scopeId: '',
      model: 'gemini-custom',
      baseUrl: 'https://img.example.com/v1',
      keyHint: '…7777',
      updatedAt: expect.any(String),
    });

    const listed = (await getSettings(app, cookie))['items'] as Json[];
    expect(listed).toEqual([
      {
        scope: 'global',
        scopeId: '',
        model: 'gemini-custom',
        baseUrl: 'https://img.example.com/v1',
        keyHint: '…7777',
        updatedAt: expect.any(String),
      },
    ]);
    expect('apiKey' in listed[0]!).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(apiKey);
  });

  it('同层再次 PUT 省略 apiKey：旧掩码保留，只改 model', async () => {
    const { app, cookie } = await setup();
    const first = await send(app, 'PUT', '/api/image-settings', { scope: 'channel', scopeId: 'c1', model: 'old', baseUrl: '', apiKey: 'sk-image-8888' }, cookie);
    expect(first.status).toBe(200);

    const res = await send(app, 'PUT', '/api/image-settings', { scope: 'channel', scopeId: 'c1', model: 'next' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      scope: 'channel',
      scopeId: 'c1',
      model: 'next',
      baseUrl: '',
      keyHint: '…8888',
      updatedAt: expect.any(String),
    });
    expect(((await getSettings(app, cookie))['items'] as Json[])[0]?.['keyHint']).toBe('…8888');
  });

  it("apiKey 空串：清掉本层 Key，掩码一起变空", async () => {
    const { app, cookie } = await setup();
    expect((await send(app, 'PUT', '/api/image-settings', { scope: 'global', model: 'm', baseUrl: '', apiKey: 'sk-image-5555' }, cookie)).status).toBe(200);

    const res = await send(app, 'PUT', '/api/image-settings', { scope: 'global', model: 'm', baseUrl: '', apiKey: '' }, cookie);
    expect(res.status).toBe(200);
    expect((await jsonOf(res))['keyHint']).toBe('');
    expect(((await getSettings(app, cookie))['items'] as Json[])[0]?.['keyHint']).toBe('');
  });

  it('channel / guild / global 各写各的：列表按 scope 升序回三条', async () => {
    const { app, cookie } = await setup();

    expect((await send(app, 'PUT', '/api/image-settings', { scope: 'guild', scopeId: 'g1', model: 'guild-m' }, cookie)).status).toBe(200);
    expect((await send(app, 'PUT', '/api/image-settings', { scope: 'channel', scopeId: 'c1', model: 'channel-m' }, cookie)).status).toBe(200);
    expect((await send(app, 'PUT', '/api/image-settings', { scope: 'global', model: 'global-m' }, cookie)).status).toBe(200);

    const listed = (await getSettings(app, cookie))['items'] as Json[];
    expect(listed.map((item) => [item['scope'], item['scopeId'], item['model']])).toEqual([
      ['channel', 'c1', 'channel-m'],
      ['global', '', 'global-m'],
      ['guild', 'g1', 'guild-m'],
    ]);
  });

  it('scope 非法 400 BAD_SCOPE；guild 缺 scopeId 400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();

    const bad = await send(app, 'PUT', '/api/image-settings', { scope: 'world', scopeId: 'w1', model: 'm' }, cookie);
    expect(bad.status).toBe(400);
    expect(await jsonOf(bad)).toEqual({ error: 'BAD_SCOPE' });

    const missing = await send(app, 'PUT', '/api/image-settings', { scope: 'guild', model: 'm' }, cookie);
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toEqual({ error: 'BAD_REQUEST' });

    expect((await getSettings(app, cookie))['items']).toEqual([]);
  });

  it('model / baseUrl / apiKey 越界或类型错：400 BAD_IMAGE_SETTINGS + detail 指到字段', async () => {
    const { app, cookie } = await setup();

    const cases: Array<{ body: Json; detail: string }> = [
      { body: { scope: 'global', model: 'm'.repeat(IMAGE_MODEL_MAX_CHARS + 1) }, detail: 'model 不能超过 200 字' },
      { body: { scope: 'global', baseUrl: 'https://x.example/' + 'a'.repeat(IMAGE_BASE_URL_MAX_CHARS) }, detail: 'baseUrl 不能超过 500 字' },
      { body: { scope: 'global', model: 200 }, detail: 'model 必须是字符串' },
      { body: { scope: 'global', baseUrl: { url: 'x' } }, detail: 'baseUrl 必须是字符串' },
      { body: { scope: 'global', apiKey: 42 }, detail: 'apiKey 必须是字符串' },
    ];
    for (const item of cases) {
      const res = await send(app, 'PUT', '/api/image-settings', item.body, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_IMAGE_SETTINGS', detail: item.detail });
    }
    expect((await getSettings(app, cookie))['items']).toEqual([]);
  });
});

describe('DELETE /api/image-settings', () => {
  it('删掉那一层后列表里只剩别层', async () => {
    const { app, cookie } = await setup();
    expect((await send(app, 'PUT', '/api/image-settings', { scope: 'global', model: 'global-m' }, cookie)).status).toBe(200);
    expect((await send(app, 'PUT', '/api/image-settings', { scope: 'channel', scopeId: 'c1', model: 'channel-m' }, cookie)).status).toBe(200);

    const res = await send(app, 'DELETE', '/api/image-settings', { scope: 'channel', scopeId: 'c1' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });

    expect(((await getSettings(app, cookie))['items'] as Json[]).map((item) => item['scope'])).toEqual(['global']);
  });

  it('删不存在的层也成功：后台连点两下不该报错', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'DELETE', '/api/image-settings', { scope: 'channel', scopeId: 'c9' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
  });

  it('scope 非法 400 BAD_SCOPE', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'DELETE', '/api/image-settings', { scope: 'world' }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_SCOPE' });
  });
});

describe('imageSettings 未接线的部署', () => {
  it('三条路由都回 501 IMAGE_SETTINGS_UNAVAILABLE，而不是 500 或空列表', async () => {
    const app = makeApp({ imageSettings: undefined });
    const login = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    const value = /admin_session=([^;]*)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const cookie = 'admin_session=' + value;

    const get = await send(app, 'GET', '/api/image-settings', undefined, cookie);
    expect(get.status).toBe(501);
    expect(await jsonOf(get)).toEqual({ error: 'IMAGE_SETTINGS_UNAVAILABLE' });

    const put = await send(app, 'PUT', '/api/image-settings', { scope: 'global', model: 'm' }, cookie);
    expect(put.status).toBe(501);
    expect(await jsonOf(put)).toEqual({ error: 'IMAGE_SETTINGS_UNAVAILABLE' });

    const del = await send(app, 'DELETE', '/api/image-settings', { scope: 'global' }, cookie);
    expect(del.status).toBe(501);
    expect(await jsonOf(del)).toEqual({ error: 'IMAGE_SETTINGS_UNAVAILABLE' });
  });
});
