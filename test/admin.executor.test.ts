import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ExecutorControlStore } from '../src/core/ports';
import type { ExecutorConfig, ExecutorRequest, ExecutorSnapshot, ExecutorStatus } from '../src/core/types';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

// 执行器控制的三条后台路由：鉴权 / 未接线 501 / GET 原样 / PUT 校验 / POST 忙 409

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

const REQUEST_ID = '0123456789abcdef0123456789abcdef';
const REQUEST: ExecutorRequest = { id: REQUEST_ID, requestedAt: '2026-11-20T03:00:00.000Z' };
const STATUS: ExecutorStatus = {
  phase: 'idle',
  checkedAt: '2026-11-20T03:00:01.000Z',
  nextDueAt: '2026-11-20T03:30:00.000Z',
  last: {
    id: REQUEST_ID,
    source: 'manual',
    startedAt: '2026-11-20T02:59:00.000Z',
    finishedAt: '2026-11-20T02:59:12.000Z',
    ok: true,
    durationMs: 12000,
    before: { ok: true, pending: 0, connected: true, summary: 'ok requestsServed=3' },
    after: { ok: true, pending: 0, connected: true, summary: 'ok requestsServed=3' },
  },
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeApp(executorControl?: ExecutorControlStore) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
  };
  // 不传就是「没接线的部署」（Workers 没有文件系统），三条端点应回 501
  if (executorControl !== undefined) deps.executorControl = executorControl;
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;
type Json = Record<string, unknown>;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function login(app: App): Promise<string> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return 'admin_session=' + value;
}

function snapshot(overrides: Partial<ExecutorSnapshot> = {}): ExecutorSnapshot {
  return {
    config: { enabled: true, intervalMinutes: 30, updatedAt: '2026-11-20T02:00:00.000Z' },
    request: null,
    status: STATUS,
    ...overrides,
  };
}

function fixedStore(value: ExecutorSnapshot): ExecutorControlStore {
  return {
    read: async () => value,
    saveConfig: async () => {
      throw new Error('这个用例不该保存配置');
    },
    request: async () => {
      throw new Error('这个用例不该写请求');
    },
  };
}

function acceptingStore(): { store: ExecutorControlStore; calls: Array<ExecutorConfig> } {
  const calls: Array<ExecutorConfig> = [];
  return {
    calls,
    store: {
      read: async () => snapshot({ request: null }),
      saveConfig: async (input) => {
        const saved: ExecutorConfig = { ...input, updatedAt: '2026-11-20T03:05:00.000Z' };
        calls.push(saved);
        return saved;
      },
      request: async () => REQUEST,
    },
  };
}

function busyStore(): ExecutorControlStore {
  return {
    read: async () => snapshot({ request: REQUEST }),
    saveConfig: async () => {
      throw new Error('这个用例不该保存配置');
    },
    request: async () => {
      const error = new Error('已存在未处理的执行器刷新请求');
      error.name = 'ExecutorBusyError';
      throw error;
    },
  };
}

describe('执行器路由鉴权', () => {
  it('三条端点未登录一律 401', async () => {
    const app = makeApp(fixedStore(snapshot()));
    const calls: Array<[string, string]> = [
      ['GET', '/api/executor'],
      ['PUT', '/api/executor/config'],
      ['POST', '/api/executor/refresh'],
    ];
    for (const [method, path] of calls) {
      const res = await app.request(path, { method, headers: JSON_HEADERS });
      expect(res.status).toBe(401);
      expect(await jsonOf(res)).toEqual({ error: 'UNAUTHORIZED' });
    }
  });
});

describe('未接线部署（没有 executorControl 依赖）', () => {
  it('GET / PUT / POST 都回 501 EXECUTOR_UNAVAILABLE，不崩', async () => {
    const app = makeApp();
    const cookie = await login(app);
    const calls: Array<[string, string]> = [
      ['GET', '/api/executor'],
      ['PUT', '/api/executor/config'],
      ['POST', '/api/executor/refresh'],
    ];
    for (const [method, path] of calls) {
      const res = await app.request(path, { method, headers: { ...JSON_HEADERS, cookie } });
      expect(res.status).toBe(501);
      expect(await jsonOf(res)).toEqual({ error: 'EXECUTOR_UNAVAILABLE' });
    }
  });
});

describe('GET /api/executor', () => {
  it('把 config / request / status 原样透出', async () => {
    const value = snapshot({ request: REQUEST });
    const app = makeApp(fixedStore(value));
    const cookie = await login(app);

    const res = await app.request('/api/executor', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual(value);
  });
});

describe('PUT /api/executor/config', () => {
  it('保存启用状态与间隔，回显带 updatedAt 的 config', async () => {
    const { store, calls } = acceptingStore();
    const app = makeApp(store);
    const cookie = await login(app);

    const res = await app.request('/api/executor/config', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ enabled: false, intervalMinutes: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      config: { enabled: false, intervalMinutes: 5, updatedAt: '2026-11-20T03:05:00.000Z' },
    });
    expect(calls).toEqual([{ enabled: false, intervalMinutes: 5, updatedAt: '2026-11-20T03:05:00.000Z' }]);
  });

  it('缺字段 / 类型错 / 越界 / 非整数 / 坏 JSON 都是 400 BAD_EXECUTOR_CONFIG', async () => {
    const { store } = acceptingStore();
    const app = makeApp(store);
    const cookie = await login(app);
    const badBodies: unknown[] = [
      {},
      { enabled: 'yes', intervalMinutes: 30 },
      { enabled: true, intervalMinutes: 0 },
      { enabled: true, intervalMinutes: 1441 },
      { enabled: true, intervalMinutes: 1.5 },
      { enabled: true, intervalMinutes: '30' },
    ];
    for (const body of badBodies) {
      const res = await app.request('/api/executor/config', {
        method: 'PUT',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_EXECUTOR_CONFIG' });
    }

    const broken = await app.request('/api/executor/config', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, cookie },
      body: '{',
    });
    expect(broken.status).toBe(400);
    expect(await jsonOf(broken)).toEqual({ error: 'BAD_EXECUTOR_CONFIG' });
  });
});

describe('POST /api/executor/refresh', () => {
  it('没有未处理请求时写一份新请求并回 { ok: true, request }', async () => {
    const app = makeApp(acceptingStore().store);
    const cookie = await login(app);

    const res = await app.request('/api/executor/refresh', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, request: REQUEST });
  });

  it('已有未处理请求时 409 EXECUTOR_BUSY', async () => {
    const app = makeApp(busyStore());
    const cookie = await login(app);

    const res = await app.request('/api/executor/refresh', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: 'EXECUTOR_BUSY' });
  });
});
