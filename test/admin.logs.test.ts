import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogStore } from '../src/core/ports';
import type { LogEntry, LogLevel, LogScope } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';
/** 冻结时钟：登录失败那条日志的 createdAt 必须可复现（§19.6 同一个 now 注入点） */
const FROZEN_NOW = 1_767_225_600_000;
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const CLIENT_IP = '203.0.113.9';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface AppOptions {
  logs?: LogStore;
}

function makeApp(options: AppOptions = {}) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: options.logs ?? createLogStore(env.DB),
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    now: () => FROZEN_NOW,
  };
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;
type Json = Record<string, unknown>;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function postJson(app: App, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
}

async function getWith(app: App, path: string, cookie: string): Promise<Response> {
  return app.request(path, { headers: { cookie } });
}

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function setup(): Promise<{ app: App; cookie: string }> {
  const app = makeApp();
  const res = await postJson(app, '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

function entry(message: string, level: LogLevel = 'info', scope: LogScope = 'chat'): LogEntry {
  return { level, scope, message, createdAt: CREATED_AT };
}

function seed(entries: LogEntry[]): Promise<void> {
  return createLogStore(env.DB).append(entries);
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM runtime_logs').run();
});

describe('GET /api/logs', () => {
  it('未登录 401，伪造 Cookie 也 401', async () => {
    const app = makeApp();

    const anon = await app.request('/api/logs');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'UNAUTHORIZED' });

    const forged = await app.request('/api/logs', { headers: { cookie: 'admin_session=not-a-token' } });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('空表的 items 为空、latest 回退成 after', async () => {
    const { app, cookie } = await setup();

    expect(await jsonOf(await getWith(app, '/api/logs', cookie))).toEqual({ items: [], latest: 0 });
    expect(await jsonOf(await getWith(app, '/api/logs?after=42', cookie))).toEqual({ items: [], latest: 42 });
  });

  it('正常返回：items 按 id 升序，latest 等于最后一条 id', async () => {
    const { app, cookie } = await setup();
    await seed([entry('日志一'), entry('日志二', 'warn', 'provider'), entry('日志三', 'error', 'admin')]);

    const body = await jsonOf(await getWith(app, '/api/logs', cookie));
    const items = body.items as Json[];
    expect(items.map((item) => item.message)).toEqual(['日志一', '日志二', '日志三']);

    const ids = items.map((item) => item.id as number);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(body.latest).toBe(ids.at(-1));
    expect(items.at(-1)).toEqual({
      id: ids.at(-1),
      createdAt: CREATED_AT,
      level: 'error',
      scope: 'admin',
      message: '日志三',
    });
  });

  it('after 增量：只回游标之后的新条目', async () => {
    const { app, cookie } = await setup();
    await seed([entry('日志一'), entry('日志二'), entry('日志三')]);

    const first = (await jsonOf(await getWith(app, '/api/logs', cookie))).items as Json[];
    const secondId = first[1]?.id as number;

    const delta = await jsonOf(await getWith(app, '/api/logs?after=' + secondId, cookie));
    expect((delta.items as Json[]).map((item) => item.message)).toEqual(['日志三']);
    expect(delta.latest).toBe(first.at(-1)?.id);

    // 轮询到表尾之后 latest 停在当前游标，不会回退
    const tail = await jsonOf(await getWith(app, '/api/logs?after=' + String(first.at(-1)?.id), cookie));
    expect(tail).toEqual({ items: [], latest: first.at(-1)?.id });
  });

  it('limit 非法值回落缺省、小于 1 夹到 1、超过 500 夹到 500', async () => {
    const { app, cookie } = await setup();
    await seed([entry('一'), entry('二'), entry('三')]);

    const itemsOf = async (path: string): Promise<Json[]> => (await jsonOf(await getWith(app, path, cookie))).items as Json[];

    expect(await itemsOf('/api/logs?limit=abc')).toHaveLength(3);
    expect(await itemsOf('/api/logs?limit=')).toHaveLength(3);
    expect(await itemsOf('/api/logs?after=abc')).toHaveLength(3);
    expect(await itemsOf('/api/logs?limit=0')).toHaveLength(1);
    expect(await itemsOf('/api/logs?limit=-5')).toHaveLength(1);

    // 上限 500：写满 523 条也只回 500 条，latest 是这 500 条里的最后一条
    await seed(Array.from({ length: 520 }, (_unused, index) => entry('bulk-' + index)));
    const capped = await jsonOf(await getWith(app, '/api/logs?limit=9999', cookie));
    expect((capped.items as Json[])).toHaveLength(500);
    expect(capped.latest).toBe((capped.items as Json[]).at(-1)?.id);
  });
});

describe('POST /api/login 失败留痕', () => {
  it('口令错写一条 warn/admin 日志，message 只有 IP，绝不含口令', async () => {
    const app = makeApp();
    const submitted = 'nope-do-not-log-me';

    const res = await postJson(app, '/api/login', { password: submitted }, { 'cf-connecting-ip': CLIENT_IP });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'BAD_PASSWORD' });

    const rows = await createLogStore(env.DB).list(0, 10);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.level).toBe('warn');
    expect(rows.at(0)?.scope).toBe('admin');
    expect(rows.at(0)?.message).toBe('登录失败 ip=' + CLIENT_IP);
    expect(rows.at(0)?.createdAt).toBe(CREATED_AT);
    expect(rows.at(0)?.message).not.toContain(submitted);
  });

  it('没有 cf-connecting-ip 时记 unknown；登录成功不写日志', async () => {
    const app = makeApp();

    await postJson(app, '/api/login', { password: 'nope' });
    const ok = await postJson(app, '/api/login', { password: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);

    const rows = await createLogStore(env.DB).list(0, 10);
    expect(rows.map((row) => row.message)).toEqual(['登录失败 ip=unknown']);
  });

  it('写日志失败只 console.warn，登录响应照旧（§19.1 硬边界）', async () => {
    const broken: LogStore = {
      append: () => Promise.reject(new Error('D1 挂了')),
      list: () => Promise.resolve([]),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = makeApp({ logs: broken });
      const res = await postJson(app, '/api/login', { password: 'nope' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'BAD_PASSWORD' });
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('[log] 写日志失败：D1 挂了');
    } finally {
      warn.mockRestore();
    }
  });
});
