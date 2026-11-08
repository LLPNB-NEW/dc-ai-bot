import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { VOICE_SPEED_DEFAULT, VOICE_SPEED_MAX, VOICE_SPEED_MIN } from '../src/core/voice/settings';
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

async function send(app: App, method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
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
  await env.DB.batch([env.DB.prepare('DELETE FROM voice_settings')]);
});

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function getSettings(app: App, cookie: string): Promise<Json> {
  const res = await send(app, 'GET', '/api/voice-settings', undefined, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

interface Row {
  scope: string;
  scopeId: string;
  mode: number;
  voice: string;
  speed: number;
  director: number;
}

async function items(app: App, cookie: string): Promise<Row[]> {
  const body = await getSettings(app, cookie);
  return (body.items ?? []) as Row[];
}

describe('GET /api/voice-settings', () => {
  it('空库返回空列表与默认值、合法取值域', async () => {
    const { app, cookie } = await setup();
    expect(await getSettings(app, cookie)).toEqual({
      items: [],
      default: { mode: 0, voice: '', speed: VOICE_SPEED_DEFAULT, director: 0 },
      modes: [0, 1, 2],
      directorModes: [0, 1, 2],
      speedMin: VOICE_SPEED_MIN,
      speedMax: VOICE_SPEED_MAX,
    });
  });

  it('未登录被拒', async () => {
    const app = makeApp();
    expect((await send(app, 'GET', '/api/voice-settings')).status).toBe(401);
  });
});

describe('PUT /api/voice-settings', () => {
  it('三层都能写，global 自动把 scopeId 归成空串', async () => {
    const { app, cookie } = await setup();
    const cases: { scope: string; scopeId?: string; mode: number; voice: string; speed: number }[] = [
      { scope: 'global', scopeId: 'ignored', mode: 2, voice: 'alloy', speed: 110 },
      { scope: 'guild', scopeId: 'g1', mode: 1, voice: 'nova', speed: 90 },
      { scope: 'channel', scopeId: 'c1', mode: 0, voice: '', speed: 100 },
    ];
    for (const item of cases) {
      const res = await send(app, 'PUT', '/api/voice-settings', item, cookie);
      expect(res.status).toBe(200);
      const saved = await jsonOf(res);
      expect(saved['scope']).toBe(item.scope);
      expect(saved['mode']).toBe(item.mode);
      expect(saved['voice']).toBe(item.voice);
      expect(saved['speed']).toBe(item.speed);
      expect(typeof saved['updatedAt']).toBe('string');
    }
    const rows = await items(app, cookie);
    expect(rows.map((row) => [row.scope, row.scopeId, row.mode])).toEqual([
      ['channel', 'c1', 0],
      ['global', '', 2],
      ['guild', 'g1', 1],
    ]);
  });

  it('voice/speed 缺省时用空串与默认语速；重复 PUT 是覆盖不是插入', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/voice-settings', { scope: 'channel', scopeId: 'c1', mode: 2, voice: 'nova', speed: 150 }, cookie);
    const res = await send(app, 'PUT', '/api/voice-settings', { scope: 'channel', scopeId: 'c1', mode: 1 }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ scope: 'channel', scopeId: 'c1', mode: 1, voice: '', speed: VOICE_SPEED_DEFAULT });
    const rows = await items(app, cookie);
    expect(rows).toHaveLength(1);
  });

  it('scope 非法 → 400 BAD_SCOPE', async () => {
    const { app, cookie } = await setup();
    for (const scope of ['workspace', '', 1]) {
      const res = await send(app, 'PUT', '/api/voice-settings', { scope, scopeId: 'x', mode: 1 }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_SCOPE' });
    }
  });

  it('mode 不是 0/1/2 → 400 BAD_VOICE_MODE', async () => {
    const { app, cookie } = await setup();
    for (const mode of [3, -1, 1.5, '1', undefined]) {
      const res = await send(app, 'PUT', '/api/voice-settings', { scope: 'channel', scopeId: 'c1', mode }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_VOICE_MODE' });
    }
  });

  it('speed 越界或不是整数 → 400 BAD_VOICE_SPEED', async () => {
    const { app, cookie } = await setup();
    for (const speed of [49, 201, 100.5, '100']) {
      const res = await send(app, 'PUT', '/api/voice-settings', { scope: 'channel', scopeId: 'c1', mode: 1, speed }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_VOICE_SPEED' });
    }
  });

  it('director 1 / 2 随 mode/voice/speed 一起落库，GET 能回读', async () => {
    const { app, cookie } = await setup();
    for (const director of [1, 2]) {
      const res = await send(
        app,
        'PUT',
        '/api/voice-settings',
        { scope: 'channel', scopeId: 'c1', mode: 1, voice: 'nova', speed: 120, director },
        cookie,
      );
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toMatchObject({ scope: 'channel', scopeId: 'c1', director });
      const rows = await items(app, cookie);
      expect(rows).toHaveLength(1);
      expect(rows.map((row) => row.director)).toEqual([director]);
    }
  });

  it('director 非法 → 400 BAD_DIRECTOR_MODE，且不落库', async () => {
    const { app, cookie } = await setup();
    for (const director of [9, -1, 1.5, '1', null]) {
      const res = await send(app, 'PUT', '/api/voice-settings', { scope: 'channel', scopeId: 'c1', mode: 1, director }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_DIRECTOR_MODE' });
    }
    expect(await items(app, cookie)).toEqual([]);
  });

  it('不填 director 就存成 0（关）', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'PUT', '/api/voice-settings', { scope: 'guild', scopeId: 'g1', mode: 1 }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ scope: 'guild', scopeId: 'g1', director: 0 });
    const rows = await items(app, cookie);
    expect(rows.map((row) => row.director)).toEqual([0]);
  });

  it('guild/channel 缺 scopeId → 400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();
    for (const scope of ['guild', 'channel']) {
      const res = await send(app, 'PUT', '/api/voice-settings', { scope, mode: 1 }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_REQUEST' });
    }
  });

  it('voice 不是字符串 → 400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'PUT', '/api/voice-settings', { scope: 'channel', scopeId: 'c1', mode: 1, voice: 3 }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('body 不是 JSON → 400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();
    const res = await app.request('/api/voice-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_REQUEST' });
  });
});

describe('DELETE /api/voice-settings', () => {
  it('删掉指定层，其他层不受影响', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/voice-settings', { scope: 'global', mode: 2 }, cookie);
    await send(app, 'PUT', '/api/voice-settings', { scope: 'channel', scopeId: 'c1', mode: 1 }, cookie);
    const res = await send(app, 'DELETE', '/api/voice-settings', { scope: 'channel', scopeId: 'c1' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect((await items(app, cookie)).map((row) => row.scope)).toEqual(['global']);
  });

  it('删不存在的层也返回 ok（幂等）', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'DELETE', '/api/voice-settings', { scope: 'guild', scopeId: 'gg' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
  });

  it('scope 非法 → 400 BAD_SCOPE；缺 scopeId → 400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();
    const bad = await send(app, 'DELETE', '/api/voice-settings', { scope: 'nope' }, cookie);
    expect(bad.status).toBe(400);
    expect(await jsonOf(bad)).toEqual({ error: 'BAD_SCOPE' });

    const missing = await send(app, 'DELETE', '/api/voice-settings', { scope: 'channel' }, cookie);
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toEqual({ error: 'BAD_REQUEST' });
  });
});
