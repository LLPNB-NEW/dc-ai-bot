import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const OTHER_SESSION_SECRET = 'other-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface AppOptions {
  now?: () => number;
  sessionSecret?: string;
}

function makeApp(options: AppOptions = {}) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: options.sessionSecret ?? SESSION_SECRET,
    appVersion: APP_VERSION,
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
  };
  if (options.now !== undefined) deps.now = options.now;
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;

const JSON_HEADERS = { 'content-type': 'application/json' };

function initFor(method: string, cookie?: string): RequestInit {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie !== undefined) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = '{}';
  return init;
}

async function postJson(app: App, path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie !== undefined) headers.cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function sessionCookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const value = /admin_session=([^;]*)/.exec(raw)?.[1] ?? '';
  if (value === '') throw new Error('Set-Cookie 里没有 admin_session：' + raw);
  return 'admin_session=' + value;
}

async function loginCookie(app: App, password: string = ADMIN_PASSWORD): Promise<string> {
  const res = await postJson(app, '/api/login', { password });
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

/** 改中间某个字符：base64url 末位只有填充比特，翻转它不保证改到真实字节 */
function corrupt(value: string): string {
  const at = 4;
  const replacement = value[at] === 'A' ? 'B' : 'A';
  return value.slice(0, at) + replacement + value.slice(at + 1);
}

const PROTECTED_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/me' },
  { method: 'GET', path: '/api/prompts' },
  { method: 'PUT', path: '/api/prompts' },
  { method: 'DELETE', path: '/api/prompts' },
  { method: 'GET', path: '/api/routes' },
  { method: 'PUT', path: '/api/routes' },
  { method: 'DELETE', path: '/api/routes' },
  { method: 'GET', path: '/api/keys' },
  { method: 'POST', path: '/api/keys' },
  { method: 'PATCH', path: '/api/keys/any-id' },
  { method: 'DELETE', path: '/api/keys/any-id' },
  { method: 'POST', path: '/api/keys/any-id/test' },
  { method: 'GET', path: '/api/image-settings' },
  { method: 'PUT', path: '/api/image-settings' },
  { method: 'DELETE', path: '/api/image-settings' },
  { method: 'GET', path: '/api/conversations?guildId=g1&channelId=c1' },
  { method: 'POST', path: '/api/logout' },
];

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prompts'),
    env.DB.prepare('DELETE FROM prompt_segments'),
    env.DB.prepare('DELETE FROM routes'),
    env.DB.prepare('DELETE FROM provider_keys'),
    env.DB.prepare('DELETE FROM messages'),
  ]);
});

describe('admin auth', () => {
  it('/api/* 未带 Cookie 一律 401，health 与 login 免鉴权', async () => {
    const app = makeApp();

    for (const route of PROTECTED_ROUTES) {
      const label = route.method + ' ' + route.path;
      const res = await app.request(route.path, initFor(route.method));
      expect(label + ' -> ' + res.status).toBe(label + ' -> 401');
      expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' });
    }

    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: APP_VERSION });

    const login = await postJson(app, '/api/login', { password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ ok: true });
  });

  it('错误口令 401 BAD_PASSWORD；正确口令 200 且 Cookie 属性齐全、可复用、logout 清除', async () => {
    const app = makeApp();

    const wrong = await postJson(app, '/api/login', { password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'BAD_PASSWORD' });
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const ok = await postJson(app, '/api/login', { password: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('admin_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=28800');

    // 值必须是 base64url(JSON{exp}).base64url(HMAC) 两段
    const value = /admin_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
    const parts = value.split('.');
    expect(parts).toHaveLength(2);
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(atob((parts[0] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { exp: number };
    const expectedExp = Math.floor(Date.now() / 1000) + 28800;
    expect(Math.abs(payload.exp - expectedExp)).toBeLessThanOrEqual(5);

    const cookie = 'admin_session=' + value;
    expect((await app.request('/api/prompts', { headers: { cookie } })).status).toBe(200);
    const me = await app.request('/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ authed: true });

    const logout = await app.request('/api/logout', { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    const cleared = logout.headers.get('set-cookie') ?? '';
    expect(cleared).toContain('admin_session=');
    expect(cleared).toContain('Max-Age=0');
  });

  it('同 IP 5 分钟内前 10 次按口令判、第 11 次 429', async () => {
    const app = makeApp({ now: () => 1_700_000_000_000 });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const res = await postJson(app, '/api/login', { password: 'wrong' });
      expect(res.status).toBe(401);
    }

    const blocked = await postJson(app, '/api/login', { password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'TOO_MANY_ATTEMPTS' });

    // 正确口令也先被限速挡住
    expect((await postJson(app, '/api/login', { password: ADMIN_PASSWORD })).status).toBe(429);
  });

  it('限速按 IP 分桶，且窗口外的旧尝试不计入', async () => {
    let clock = 1_700_000_000_000;
    const app = makeApp({ now: () => clock });

    const spam = async (ip: string) => {
      const headers: Record<string, string> = { ...JSON_HEADERS, 'cf-connecting-ip': ip };
      return app.request('/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) });
    };

    for (let attempt = 1; attempt <= 10; attempt += 1) expect((await spam('1.1.1.1')).status).toBe(401);
    expect((await spam('1.1.1.1')).status).toBe(429);
    // 另一个 IP 不受牵连
    expect((await spam('2.2.2.2')).status).toBe(401);

    clock += 5 * 60 * 1000;
    expect((await spam('1.1.1.1')).status).toBe(401);
  });

  it('过期 Cookie → 401；有效期内仍可用', async () => {
    const issuedAt = 1_700_000_000_000;
    const cookie = await loginCookie(makeApp({ now: () => issuedAt }));

    const inside = makeApp({ now: () => issuedAt + 3600 * 1000 });
    expect((await inside.request('/api/prompts', { headers: { cookie } })).status).toBe(200);

    const expired = makeApp({ now: () => issuedAt + (28800 + 1) * 1000 });
    const res = await expired.request('/api/prompts', { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('签名被篡改、payload 被改、换密钥签发、格式非法 → 401', async () => {
    const app = makeApp();
    const token = (await loginCookie(app)).slice('admin_session='.length);
    const [payload = '', signature = ''] = token.split('.');

    const check = (candidate: string) =>
      app.request('/api/prompts', { headers: { cookie: 'admin_session=' + candidate } });

    expect((await check(payload + '.' + corrupt(signature))).status).toBe(401);
    expect((await check(corrupt(payload) + '.' + signature)).status).toBe(401);
    expect((await check(payload)).status).toBe(401);
    expect((await check(payload + '.')).status).toBe(401);
    expect((await check('not-a-token')).status).toBe(401);
    expect((await check(payload + '.' + signature + '.extra')).status).toBe(401);

    // 用另一个 sessionSecret 签发的同形 Cookie 不认
    const forged = await loginCookie(makeApp({ sessionSecret: OTHER_SESSION_SECRET }));
    expect((await app.request('/api/prompts', { headers: { cookie: forged } })).status).toBe(401);

    // 正版仍然可用，排除“一律拒绝”的假绿
    expect((await app.request('/api/prompts', { headers: { cookie: 'admin_session=' + token } })).status).toBe(200);
  });
});
