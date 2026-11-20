import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VISION_ENABLED } from '../src/core/chat/vision-view';
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

function makeApp() {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
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
  await env.DB.batch([env.DB.prepare('DELETE FROM vision_settings')]);
});

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function getSettings(app: App, cookie: string): Promise<Json> {
  const res = await send(app, 'GET', '/api/vision-settings', undefined, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

/** 直接写库造脏值：走 HTTP 是写不进去的（读侧只认布尔） */
async function insertRaw(scope: string, scopeId: string, enabled: number): Promise<void> {
  await env.DB
    .prepare('INSERT INTO vision_settings (scope, scope_id, enabled, updated_at) VALUES (?, ?, ?, ?)')
    .bind(scope, scopeId, enabled, '2026-01-01T00:00:00.000Z')
    .run();
}

describe('GET /api/vision-settings', () => {
  it('空库：一次拿到 items 空数组与默认值（开）', async () => {
    const { app, cookie } = await setup();

    expect(await getSettings(app, cookie)).toEqual({ items: [], default: DEFAULT_VISION_ENABLED });
    expect(DEFAULT_VISION_ENABLED).toBe(true);
  });

  it('未登录 401：与其它 /api 路由同一道闸门', async () => {
    const app = makeApp();
    expect((await send(app, 'GET', '/api/vision-settings')).status).toBe(401);
    expect((await send(app, 'PUT', '/api/vision-settings', { scope: 'global', enabled: true })).status).toBe(401);
    expect((await send(app, 'DELETE', '/api/vision-settings', { scope: 'global' })).status).toBe(401);
  });
});

describe('PUT /api/vision-settings', () => {
  it('global 往返：200 回写后的对象，GET 读回同一行', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/vision-settings', { scope: 'global', enabled: true }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      scope: 'global',
      scopeId: '',
      enabled: true,
      updatedAt: expect.any(String),
    });

    expect((await getSettings(app, cookie))['items']).toEqual([
      { scope: 'global', scopeId: '', enabled: true, updatedAt: expect.any(String) },
    ]);
  });

  it('channel 往返：enabled=false 能存也能读回（关掉不是缺省值）', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/vision-settings', { scope: 'channel', scopeId: 'c1', enabled: false }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      scope: 'channel',
      scopeId: 'c1',
      enabled: false,
      updatedAt: expect.any(String),
    });

    expect((await getSettings(app, cookie))['items']).toEqual([
      { scope: 'channel', scopeId: 'c1', enabled: false, updatedAt: expect.any(String) },
    ]);
  });

  it('enabled 不是布尔：400 BAD_ENABLED（"true" / 1 / 0 / null 一律不认）', async () => {
    const { app, cookie } = await setup();

    for (const enabled of ['true', 'false', 1, 0, null]) {
      const res = await send(app, 'PUT', '/api/vision-settings', { scope: 'global', enabled }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_ENABLED' });
    }
    expect((await getSettings(app, cookie))['items']).toEqual([]);
  });

  it('scope 非法：400 BAD_SCOPE', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/vision-settings', { scope: 'world', scopeId: 'w1', enabled: true }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_SCOPE' });
  });

  it('guild 缺 scopeId：400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/vision-settings', { scope: 'guild', enabled: true }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_REQUEST' });
  });
});

describe('DELETE /api/vision-settings', () => {
  it('删掉那一层后列表变空', async () => {
    const { app, cookie } = await setup();
    expect((await send(app, 'PUT', '/api/vision-settings', { scope: 'global', enabled: false }, cookie)).status).toBe(200);

    const res = await send(app, 'DELETE', '/api/vision-settings', { scope: 'global' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });

    expect((await getSettings(app, cookie))['items']).toEqual([]);
  });

  it('删不存在的层也成功：后台连点两下不该报错', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'DELETE', '/api/vision-settings', { scope: 'channel', scopeId: 'c9' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
  });
});

describe('visionSettings 仓储：0/1 与布尔的映射（§41）', () => {
  it('1 -> true、0 -> false（写进去是整数，读出来是布尔）', async () => {
    const repos = createRepositories(env.DB, createSecretBox(MASTER_KEY));

    const saved = await repos.visionSettings.put({ scope: 'guild', scopeId: 'g1', enabled: false });
    expect(saved).toEqual({ scope: 'guild', scopeId: 'g1', enabled: false, updatedAt: expect.any(String) });
    const row = await env.DB
      .prepare('SELECT enabled FROM vision_settings WHERE scope = ? AND scope_id = ?')
      .bind('guild', 'g1')
      .first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);

    await repos.visionSettings.put({ scope: 'global', scopeId: '', enabled: true });
    const ordered = await repos.visionSettings.list();
    expect(ordered.map((item) => [item.scope, item.scopeId, item.enabled])).toEqual([
      ['global', '', true],
      ['guild', 'g1', false],
    ]);
  });

  it('脏值（enabled = 2）当这一层没配置：get 回 null，list 里也没有它', async () => {
    const repos = createRepositories(env.DB, createSecretBox(MASTER_KEY));
    await insertRaw('channel', 'c1', 2);

    expect(await repos.visionSettings.get({ scope: 'channel', scopeId: 'c1' })).toBeNull();
    expect(await repos.visionSettings.list()).toEqual([]);
  });

  it('remove 命中 0 行也算成功', async () => {
    const repos = createRepositories(env.DB, createSecretBox(MASTER_KEY));
    await expect(repos.visionSettings.remove({ scope: 'channel', scopeId: 'c404' })).resolves.toBeUndefined();
  });
});
