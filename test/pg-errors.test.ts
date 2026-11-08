import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  clampPgErrorsLimit,
  createRelayErrorSource,
  createUnconfiguredErrorSource,
  PgErrorsUnavailableError,
  type PgErrorsSource,
} from '../src/core/pg-errors';
import type { PgErrorEntry } from '../src/core/types';
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

interface Seen {
  url: string;
  init?: RequestInit;
}

type FetchLike = typeof fetch;

function stubFetch(seen: Seen[], reply: (url: string) => Response | Promise<Response>): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({ url, init });
    return await reply(url);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (headers === undefined) return undefined;
  const bag = new Headers(headers);
  return bag.get(name) ?? undefined;
}

/** 失败原因一定是 PgErrorsUnavailableError；不是就直接炸，绝不静默放过 */
function detailOf(error: unknown): string {
  if (error instanceof PgErrorsUnavailableError) return error.detail;
  throw new Error('不是 PgErrorsUnavailableError：' + String(error));
}

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('本该失败却成功了');
    },
    (reason: unknown) => reason,
  );
}

const ENTRY: PgErrorEntry = {
  at: '2026-11-04T01:00:00.000Z',
  status: 502,
  code: 'executor_timeout',
  message: '执行器超时',
  model: 'gemini-4-argon',
  key: 'pg_sample…KEY1',
  durationMs: 45123,
  requestId: 'req-1',
};

describe('createRelayErrorSource', () => {
  it('拼出 /admin/errors?limit=N，并带上 Bearer 与 accept', async () => {
    const seen: Seen[] = [];
    const source = createRelayErrorSource({
      url: 'http://pg-relay:8787/',
      token: 'pg_secret_token',
      fetch: stubFetch(seen, () => jsonResponse({ limit: 50, dropped: 0, items: [] })),
    });

    const feed = await source.list(50);
    expect(feed).toEqual({ limit: 50, dropped: 0, items: [] });
    expect(source.configured).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://pg-relay:8787/admin/errors?limit=50');
    expect(headerOf(seen[0]?.init, 'authorization')).toBe('Bearer pg_secret_token');
    expect(headerOf(seen[0]?.init, 'accept')).toBe('application/json');
  });

  it('limit 越界时按夹紧后的值发请求', async () => {
    const seen: Seen[] = [];
    const source = createRelayErrorSource({
      url: 'http://pg-relay:8787',
      token: 'k',
      fetch: stubFetch(seen, () => jsonResponse({ limit: 1, dropped: 0, items: [] })),
    });

    await source.list(0);
    await source.list(9999);
    expect(seen.map((item) => item.url)).toEqual([
      'http://pg-relay:8787/admin/errors?limit=1',
      'http://pg-relay:8787/admin/errors?limit=200',
    ]);
  });

  it('中继回非 200 抛 PgErrorsUnavailableError（带状态码）', async () => {
    const source = createRelayErrorSource({
      url: 'http://pg-relay:8787',
      token: 'k',
      fetch: stubFetch([], () => new Response('boom', { status: 500 })),
    });
    expect(detailOf(await reasonOf(source.list(10)))).toContain('HTTP 500');
  });

  it('响应不是合法 JSON 抛 PgErrorsUnavailableError', async () => {
    const source = createRelayErrorSource({
      url: 'http://pg-relay:8787',
      token: 'k',
      fetch: stubFetch([], () => new Response('not json', { status: 200 })),
    });
    expect(detailOf(await reasonOf(source.list(10)))).toContain('JSON');
  });

  it('超时（TimeoutError）抛 PgErrorsUnavailableError', async () => {
    const timeoutFetch: FetchLike = async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    };
    const source = createRelayErrorSource({ url: 'http://pg-relay:8787', token: 'k', fetch: timeoutFetch });
    expect(detailOf(await reasonOf(source.list(10)))).toContain('超时');
  });

  it('连不上中继（网络错）抛 PgErrorsUnavailableError', async () => {
    const brokenFetch: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const source = createRelayErrorSource({ url: 'http://pg-relay:8787', token: 'k', fetch: brokenFetch });
    expect(detailOf(await reasonOf(source.list(10)))).toContain('连不上 PG 中继');
  });

  it('items 不是数组算形状不对', async () => {
    const source = createRelayErrorSource({
      url: 'http://pg-relay:8787',
      token: 'k',
      fetch: stubFetch([], () => jsonResponse({ limit: 1, dropped: 0, items: 'nope' })),
    });
    expect(detailOf(await reasonOf(source.list(10)))).toContain('形状');
  });

  it('坏行丢掉，只留约定字段，message 截到 500，limit/dropped 非法时回落', async () => {
    const longMessage = 'x'.repeat(600);
    const source = createRelayErrorSource({
      url: 'http://pg-relay:8787',
      token: 'k',
      fetch: stubFetch([], () =>
        jsonResponse({
          limit: 999,
          dropped: 'oops',
          items: [
            ENTRY,
            { at: '2026-11-04T01:00:00.000Z', status: 500, code: 'missing_message' },
            'not-an-object',
            { at: 42, status: 500, code: 'bad_at', message: 'x' },
            { ...ENTRY, requestId: 'req-2', message: longMessage, prompt: '不应该出现', extra: 1 },
          ],
        }),
      ),
    });

    const feed = await source.list(10);
    expect(feed.limit).toBe(200);
    expect(feed.dropped).toBe(0);
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toEqual(ENTRY);
    const second = feed.items[1];
    if (second === undefined) throw new Error('第二条好行被误丢');
    // prompt / extra 这类不在契约里的字段一律不显示
    expect(Object.keys(second).sort()).toEqual(['at', 'code', 'durationMs', 'key', 'message', 'model', 'requestId', 'status']);
    expect(second.message.length).toBe(500);
  });

  it('items 条数不超过 limit', async () => {
    const source = createRelayErrorSource({
      url: 'http://pg-relay:8787',
      token: 'k',
      fetch: stubFetch([], () => jsonResponse({ limit: 200, dropped: 0, items: [ENTRY, ENTRY, ENTRY] })),
    });
    expect((await source.list(2)).items).toHaveLength(2);
  });
});

describe('clampPgErrorsLimit', () => {
  it('非有限数回落 200，其余夹到 1..200 并取整', () => {
    expect(clampPgErrorsLimit(Number.NaN)).toBe(200);
    expect(clampPgErrorsLimit(Number.POSITIVE_INFINITY)).toBe(200);
    expect(clampPgErrorsLimit(0)).toBe(1);
    expect(clampPgErrorsLimit(-5)).toBe(1);
    expect(clampPgErrorsLimit(1)).toBe(1);
    expect(clampPgErrorsLimit(7.9)).toBe(7);
    expect(clampPgErrorsLimit(200)).toBe(200);
    expect(clampPgErrorsLimit(201)).toBe(200);
    expect(clampPgErrorsLimit(9999)).toBe(200);
  });
});

describe('createUnconfiguredErrorSource', () => {
  it('configured=false，取列表必抛「没有配置 PG 中继」', async () => {
    const source = createUnconfiguredErrorSource();
    expect(source.configured).toBe(false);
    expect(detailOf(await reasonOf(source.list(10)))).toContain('没有配置 PG 中继');
  });
});

interface AppOptions {
  pgErrors?: PgErrorsSource;
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
  if (options.pgErrors !== undefined) deps.pgErrors = options.pgErrors;
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;

async function login(app: App): Promise<string> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return 'admin_session=' + value;
}

async function getFeed(app: App, path: string, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/pg-errors', () => {
  it('未登录回 401（沿用管理后台那套鉴权）', async () => {
    const app = makeApp();
    const res = await app.request('/api/pg-errors');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('200 原样透传 items/limit/dropped，并把 limit 夹到 1..200 再交给端口', async () => {
    const calls: number[] = [];
    const pgErrors: PgErrorsSource = {
      configured: true,
      list: (limit) => {
        calls.push(limit);
        return Promise.resolve({ limit, dropped: 2, items: [ENTRY] });
      },
    };
    const app = makeApp({ pgErrors });
    const cookie = await login(app);

    const wide = await getFeed(app, '/api/pg-errors?limit=9999', cookie);
    expect(wide.status).toBe(200);
    expect(wide.body).toEqual({ limit: 200, dropped: 2, items: [ENTRY] });

    const low = await getFeed(app, '/api/pg-errors?limit=0', cookie);
    expect(low.body['limit']).toBe(1);

    const broken = await getFeed(app, '/api/pg-errors?limit=abc', cookie);
    expect(broken.status).toBe(200);
    expect(broken.body['limit']).toBe(200);

    expect(calls).toEqual([200, 1, 200]);
  });

  it('中继没配（deps 里没有 pgErrors）回 501 PG_ERRORS_UNAVAILABLE', async () => {
    const app = makeApp();
    const cookie = await login(app);
    const res = await getFeed(app, '/api/pg-errors', cookie);
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'PG_ERRORS_UNAVAILABLE' });
  });

  it('装的是「永远抛」占位时也回 501，不会误报 502', async () => {
    const app = makeApp({ pgErrors: createUnconfiguredErrorSource() });
    const cookie = await login(app);
    const res = await getFeed(app, '/api/pg-errors', cookie);
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'PG_ERRORS_UNAVAILABLE' });
  });

  it('已配但取不到：502 PG_ERRORS_UPSTREAM 带中文 detail', async () => {
    const pgErrors: PgErrorsSource = {
      configured: true,
      list: () => Promise.reject(new PgErrorsUnavailableError('PG 中继返回 HTTP 500')),
    };
    const app = makeApp({ pgErrors });
    const cookie = await login(app);
    const res = await getFeed(app, '/api/pg-errors', cookie);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'PG_ERRORS_UPSTREAM', detail: 'PG 中继返回 HTTP 500' });
  });

  it('端口抛的不是 PgErrorsUnavailableError 时也回 502，detail 用兜底那句', async () => {
    const pgErrors: PgErrorsSource = {
      configured: true,
      list: () => Promise.reject(new Error('boom')),
    };
    const app = makeApp({ pgErrors });
    const cookie = await login(app);
    const res = await getFeed(app, '/api/pg-errors', cookie);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'PG_ERRORS_UPSTREAM', detail: 'PG 中继请求失败' });
  });
});
