import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MULTIPLIER_MAX, MULTIPLIER_MIN, resetTimeouts, resolveTimeout, timeoutDefaults } from '../src/core/timeouts';
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

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

interface FieldJson {
  key: string;
  env: string;
  label: string;
  defaultMs: number;
  minMs: number;
  maxMs: number;
  valueMs: number;
  effectiveMs: number;
  overridden: boolean;
}

interface ShapeJson {
  fields: FieldJson[];
  multiplier: { value: number; default: number; min: number; max: number };
}

function fieldOf(shape: ShapeJson, key: string): FieldJson {
  const field = shape.fields.find((item) => item.key === key);
  if (field === undefined) throw new Error('缺字段 ' + key);
  return field;
}

/** 把整份字段按基线填好，再按需覆盖几项：PUT 必须整份给，少一项就是 400。 */
function fullBody(overrides: Record<string, number> = {}): Record<string, number> {
  const body: Record<string, number> = { multiplier: 1 };
  for (const [key, value] of Object.entries(timeoutDefaults())) body[key] = value;
  return { ...body, ...overrides };
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM timeout_settings')]);
  resetTimeouts();
});

afterEach(() => {
  resetTimeouts();
});

describe('GET /api/timeouts', () => {
  it('空库：九项都等于 .env 与内置默认，倍率 1，全部标成未覆盖', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'GET', '/api/timeouts', undefined, cookie);
    expect(res.status).toBe(200);
    const shape = (await jsonOf(res)) as unknown as ShapeJson;
    expect(shape.fields.map((field) => field.key)).toEqual([
      'llm',
      'image',
      'tts',
      'ttsGemini',
      'judgeFloor',
      'judgePerChar',
      'judgeCap',
      'pgErrors',
      'shutdown',
    ]);
    const defaults = timeoutDefaults();
    for (const field of shape.fields) {
      expect(field.defaultMs).toBe(defaults[field.key as keyof typeof defaults]);
      expect(field.valueMs).toBe(field.defaultMs);
      expect(field.effectiveMs).toBe(field.defaultMs);
      expect(field.overridden).toBe(false);
    }
    expect(shape.multiplier).toEqual({ value: 1, default: 1, min: MULTIPLIER_MIN, max: MULTIPLIER_MAX });
  });

  it('未登录 401', async () => {
    const app = makeApp();
    const res = await send(app, 'GET', '/api/timeouts');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/timeouts', () => {
  it('只存和基线不同的项；生效值立刻变，读回带 overridden', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'PUT', '/api/timeouts', fullBody({ llm: 240_000, multiplier: 2 }), cookie);
    expect(res.status).toBe(200);
    const shape = (await jsonOf(res)) as unknown as ShapeJson;

    // 240000 × 2 = 480000，没到 600000 的上限，所以生效值就是 480000
    expect(fieldOf(shape, 'llm').valueMs).toBe(240_000);
    expect(fieldOf(shape, 'llm').effectiveMs).toBe(480_000);
    expect(fieldOf(shape, 'llm').overridden).toBe(true);
    // 没改的项不该落库
    expect(fieldOf(shape, 'pgErrors').overridden).toBe(false);
    expect(shape.multiplier.value).toBe(2);
    expect(resolveTimeout('llm')).toBe(480_000);
    // 没改的项也吃倍率：5000 × 2
    expect(resolveTimeout('pgErrors')).toBe(10_000);

    const rows = await env.DB.prepare('SELECT name, value FROM timeout_settings ORDER BY name').all<{ name: string; value: number }>();
    expect(rows.results.map((row) => row.name)).toEqual(['llm', 'multiplier']);
  });

  it('改动被夹进该字段上下限之外的值直接 400，不悄悄改数', async () => {
    const { app, cookie } = await setup();
    const tooBig = await send(app, 'PUT', '/api/timeouts', fullBody({ llm: 600_001 }), cookie);
    expect(tooBig.status).toBe(400);
    expect((await jsonOf(tooBig))['error']).toBe('BAD_TIMEOUT_SETTINGS');

    const tooSmall = await send(app, 'PUT', '/api/timeouts', fullBody({ judgePerChar: 0 }), cookie);
    expect(tooSmall.status).toBe(400);

    const badMultiplier = await send(app, 'PUT', '/api/timeouts', fullBody({ multiplier: 99 }), cookie);
    expect(badMultiplier.status).toBe(400);
  });

  it('少给一项、给非数字、给空对象都是 400', async () => {
    const { app, cookie } = await setup();
    const missing = fullBody();
    delete missing['shutdown'];
    expect((await send(app, 'PUT', '/api/timeouts', missing, cookie)).status).toBe(400);
    expect((await send(app, 'PUT', '/api/timeouts', fullBody({ llm: '180000' as unknown as number }), cookie)).status).toBe(400);
    expect((await send(app, 'PUT', '/api/timeouts', {}, cookie)).status).toBe(400);
  });

  it('存过之后再改回基线，那一行会被删掉', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/timeouts', fullBody({ tts: 60_000 }), cookie);
    const back = await send(app, 'PUT', '/api/timeouts', fullBody(), cookie);
    expect(back.status).toBe(200);
    const shape = (await jsonOf(back)) as unknown as ShapeJson;
    expect(fieldOf(shape, 'tts').overridden).toBe(false);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM timeout_settings').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('DELETE /api/timeouts', () => {
  it('清掉覆盖并回默认形状，进程里的生效值也回默认', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/timeouts', fullBody({ image: 300_000 }), cookie);
    expect(resolveTimeout('image')).toBe(300_000);

    const res = await send(app, 'DELETE', '/api/timeouts', undefined, cookie);
    expect(res.status).toBe(200);
    const shape = (await jsonOf(res)) as unknown as ShapeJson;
    expect(fieldOf(shape, 'image').effectiveMs).toBe(180_000);
    expect(resolveTimeout('image')).toBe(180_000);

    // 本来就没有覆盖时也回 200，不报错
    const again = await send(app, 'DELETE', '/api/timeouts', undefined, cookie);
    expect(again.status).toBe(200);
  });
});
