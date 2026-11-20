import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REVEAL_STEPS, REVEAL_STEPS_MAX, REVEAL_STEPS_MIN } from '../src/core/chat/reply-view';
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
  await env.DB.batch([env.DB.prepare('DELETE FROM reply_settings')]);
});

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function getSettings(app: App, cookie: string): Promise<Json> {
  const res = await send(app, 'GET', '/api/reply-settings', undefined, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

interface ScopeCase {
  scope: 'global' | 'guild' | 'channel';
  scopeId: string;
}

const SCOPES: ScopeCase[] = [
  { scope: 'global', scopeId: '' },
  { scope: 'guild', scopeId: 'g1' },
  { scope: 'channel', scopeId: 'c1' },
];

describe('GET /api/reply-settings', () => {
  it('空库：items 空数组，带上默认值与合法区间', async () => {
    const { app, cookie } = await setup();

    expect(await getSettings(app, cookie)).toEqual({
      items: [],
      default: DEFAULT_REVEAL_STEPS,
      min: REVEAL_STEPS_MIN,
      max: REVEAL_STEPS_MAX,
    });
  });

  it('未登录 401：与其它 /api 路由同一道闸门', async () => {
    const app = makeApp();
    expect((await send(app, 'GET', '/api/reply-settings')).status).toBe(401);
    expect((await send(app, 'PUT', '/api/reply-settings', { scope: 'global', revealSteps: 3 })).status).toBe(401);
    expect((await send(app, 'DELETE', '/api/reply-settings', { scope: 'global' })).status).toBe(401);
  });
});

describe('PUT /api/reply-settings', () => {
  it('三层各存一次：200 回写后的对象，GET 能全部读回来（往返一致）', async () => {
    const { app, cookie } = await setup();

    for (const [index, item] of SCOPES.entries()) {
      const revealSteps = index + 1;
      const res = await send(app, 'PUT', '/api/reply-settings', { ...item, revealSteps }, cookie);
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({
        scope: item.scope,
        scopeId: item.scopeId,
        revealSteps,
        updatedAt: expect.any(String),
      });
    }

    const listed = await getSettings(app, cookie);
    expect(listed['items']).toEqual([
      { scope: 'channel', scopeId: 'c1', revealSteps: 3, updatedAt: expect.any(String) },
      { scope: 'global', scopeId: '', revealSteps: 1, updatedAt: expect.any(String) },
      { scope: 'guild', scopeId: 'g1', revealSteps: 2, updatedAt: expect.any(String) },
    ]);
  });

  it('revealSteps: 0（关闭假流式）能存也能读回：0 不是缺省值', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reply-settings', { scope: 'channel', scopeId: 'c1', revealSteps: 0 }, cookie);
    expect(res.status).toBe(200);
    expect((await jsonOf(res))['revealSteps']).toBe(0);

    const listed = await getSettings(app, cookie);
    expect(listed['items']).toEqual([
      { scope: 'channel', scopeId: 'c1', revealSteps: 0, updatedAt: expect.any(String) },
    ]);
  });

  it('越界、小数、字符串一律 400 BAD_REVEAL_STEPS', async () => {
    const { app, cookie } = await setup();

    for (const revealSteps of [REVEAL_STEPS_MAX + 1, REVEAL_STEPS_MIN - 1, 1.5, '6']) {
      const res = await send(app, 'PUT', '/api/reply-settings', { scope: 'global', revealSteps }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_REVEAL_STEPS' });
    }
    expect((await getSettings(app, cookie))['items']).toEqual([]);
  });

  it('scope 非法：400 BAD_SCOPE', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reply-settings', { scope: 'world', scopeId: 'w1', revealSteps: 3 }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_SCOPE' });
  });

  it('guild 缺 scopeId：400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reply-settings', { scope: 'guild', revealSteps: 3 }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_REQUEST' });
  });
});

describe('DELETE /api/reply-settings', () => {
  it('删掉那一层：200 ok，GET 不再有该行，别的层不受影响', async () => {
    const { app, cookie } = await setup();
    expect((await send(app, 'PUT', '/api/reply-settings', { scope: 'guild', scopeId: 'g1', revealSteps: 4 }, cookie)).status).toBe(200);
    expect((await send(app, 'PUT', '/api/reply-settings', { scope: 'global', revealSteps: 2 }, cookie)).status).toBe(200);

    const res = await send(app, 'DELETE', '/api/reply-settings', { scope: 'guild', scopeId: 'g1' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });

    expect((await getSettings(app, cookie))['items']).toEqual([
      { scope: 'global', scopeId: '', revealSteps: 2, updatedAt: expect.any(String) },
    ]);
  });

  it('删不存在的层也成功：后台连点两下不该报错', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'DELETE', '/api/reply-settings', { scope: 'channel', scopeId: 'c9' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
  });

  it('scope 非法：400 BAD_SCOPE', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'DELETE', '/api/reply-settings', { scope: 'world', scopeId: 'w1' }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_SCOPE' });
  });
});
