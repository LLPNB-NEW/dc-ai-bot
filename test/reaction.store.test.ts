import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactionModelConfig } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';

// §21.2 / §21.5：表情模型单行表的仓储语义 + 两条管理路由

const MASTER_KEY = toBase64(new Uint8Array(32).fill(5));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';
const DEFAULT_CONFIG: ReactionModelConfig = { enabled: false, provider: 'openai-compat', model: '' };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

function makeApp() {
  const deps: AdminAppDeps = {
    ...makeRepos(),
    logs: createLogStore(env.DB),
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
  };
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;
type Json = Record<string, unknown>;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function send(app: App, method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie !== undefined) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

async function get(app: App, path: string, cookie: string): Promise<Response> {
  return await app.request(path, { headers: { cookie } });
}

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function setup(): Promise<{ app: App; cookie: string }> {
  const app = makeApp();
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

async function countRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM reaction_model').first<{ n: number }>();
  return row?.n ?? 0;
}

/** 绕过仓储直接写行：provider 非法、model 全空白这类坏数据只有手工改库才会出现 */
async function insertRaw(provider: string, model: string, enabled = 1): Promise<void> {
  await env.DB.prepare('INSERT INTO reaction_model (id, enabled, provider, model, updated_at) VALUES (1, ?, ?, ?, ?)')
    .bind(enabled, provider, model, '2026-01-01T00:00:00.000Z')
    .run();
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reaction_model').run();
});

describe('reaction_model 仓储', () => {
  it('空表 get 回 null', async () => {
    expect(await countRows()).toBe(0);
    expect(await makeRepos().reactionModels.get()).toBeNull();
  });

  it('put → get 往返；enabled 落成 0/1，且始终只有一行', async () => {
    const { reactionModels } = makeRepos();

    await reactionModels.put({ enabled: true, provider: 'anthropic', model: 'claude-3-5-haiku' });
    expect(await reactionModels.get()).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-3-5-haiku' });

    await reactionModels.put({ enabled: false, provider: 'gemini', model: 'gemini-2.0-flash' });
    expect(await reactionModels.get()).toEqual({ enabled: false, provider: 'gemini', model: 'gemini-2.0-flash' });

    expect(await countRows()).toBe(1);
    const row = await env.DB.prepare('SELECT id, enabled FROM reaction_model').first<{ id: number; enabled: number }>();
    expect(row).toEqual({ id: 1, enabled: 0 });
  });

  it('provider 不在枚举内 → null', async () => {
    await insertRaw('openai', 'gpt-4o-mini');
    expect(await makeRepos().reactionModels.get()).toBeNull();
  });

  it('model 全空白 → null', async () => {
    await insertRaw('openai-compat', '   ');
    expect(await makeRepos().reactionModels.get()).toBeNull();
  });

  it('重复 put 覆盖同一行，不报错也不新增', async () => {
    const { reactionModels } = makeRepos();

    await reactionModels.put({ enabled: true, provider: 'openai-compat', model: 'deepseek-chat' });
    await reactionModels.put({ enabled: false, provider: 'openai-compat', model: 'deepseek-chat' });
    await reactionModels.put({ enabled: true, provider: 'gemini', model: 'gemini-2.0-flash' });

    expect(await countRows()).toBe(1);
    expect(await reactionModels.get()).toEqual({ enabled: true, provider: 'gemini', model: 'gemini-2.0-flash' });
  });

  it('CHECK (id = 1) 挡住第二行', async () => {
    await insertRaw('openai-compat', 'deepseek-chat');
    await expect(
      env.DB.prepare('INSERT INTO reaction_model (id, enabled, provider, model, updated_at) VALUES (2, 1, ?, ?, ?)')
        .bind('openai-compat', 'deepseek-chat', '2026-01-01T00:00:00.000Z')
        .run(),
    ).rejects.toThrow();
    expect(await countRows()).toBe(1);
  });
});

describe('reaction_model 管理路由', () => {
  it('两条路由都在 ALL /api/* 鉴权之内：未登录 401', async () => {
    const app = makeApp();

    const anonGet = await app.request('/api/reaction-model');
    expect(anonGet.status).toBe(401);
    expect(await anonGet.json()).toEqual({ error: 'UNAUTHORIZED' });

    const anonPut = await send(app, 'PUT', '/api/reaction-model', { enabled: false, provider: 'openai-compat', model: '' });
    expect(anonPut.status).toBe(401);
    expect(await anonPut.json()).toEqual({ error: 'UNAUTHORIZED' });
    expect(await countRows()).toBe(0);
  });

  it('未配置时 GET 回缺省形状', async () => {
    const { app, cookie } = await setup();

    const res = await get(app, '/api/reaction-model', cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ config: DEFAULT_CONFIG });
  });

  it('PUT 200 回配置本体，随后 GET 与之一致', async () => {
    const { app, cookie } = await setup();
    const cfg: ReactionModelConfig = { enabled: true, provider: 'gemini', model: 'gemini-2.0-flash' };

    const put = await send(app, 'PUT', '/api/reaction-model', cfg, cookie);
    expect(put.status).toBe(200);
    expect(await jsonOf(put)).toEqual(cfg);

    expect(await jsonOf(await get(app, '/api/reaction-model', cookie))).toEqual({ config: cfg });
    // 落库的也是同一份
    expect(await makeRepos().reactionModels.get()).toEqual(cfg);
  });

  it('模型名两端空白被 trim 后落库', async () => {
    const { app, cookie } = await setup();

    const put = await send(app, 'PUT', '/api/reaction-model', { enabled: true, provider: 'anthropic', model: '  claude-3-5-haiku  ' }, cookie);
    expect(put.status).toBe(200);
    expect(await jsonOf(put)).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-3-5-haiku' });
    expect(await jsonOf(await get(app, '/api/reaction-model', cookie))).toEqual({
      config: { enabled: true, provider: 'anthropic', model: 'claude-3-5-haiku' },
    });
  });

  it('enabled:true 时 model 空 / 全空白 → 400 BAD_REACTION_MODEL，且一条都不落库', async () => {
    const { app, cookie } = await setup();

    for (const model of ['', '   ']) {
      const res = await send(app, 'PUT', '/api/reaction-model', { enabled: true, provider: 'openai-compat', model }, cookie);
      expect(res.status, JSON.stringify(model)).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_REACTION_MODEL' });
    }
    expect(await countRows()).toBe(0);
  });

  it('provider 非法、字段缺失或类型不对 → 400 BAD_REACTION_MODEL', async () => {
    const { app, cookie } = await setup();

    const cases: Array<{ name: string; body: unknown }> = [
      { name: 'provider 不在枚举内', body: { enabled: true, provider: 'openai', model: 'gpt-4o-mini' } },
      { name: 'provider 非字符串', body: { enabled: true, provider: 42, model: 'm' } },
      { name: '缺 provider', body: { enabled: true, model: 'm' } },
      { name: '缺 enabled', body: { provider: 'openai-compat', model: 'm' } },
      { name: 'enabled 非布尔', body: { enabled: 'true', provider: 'openai-compat', model: 'm' } },
      { name: '缺 model', body: { enabled: true, provider: 'openai-compat' } },
      { name: 'model 非字符串', body: { enabled: true, provider: 'openai-compat', model: 123 } },
    ];

    for (const item of cases) {
      const res = await send(app, 'PUT', '/api/reaction-model', item.body, cookie);
      expect(res.status, item.name).toBe(400);
      expect(await res.json(), item.name).toEqual({ error: 'BAD_REACTION_MODEL' });
    }

    // 被拒的写入一条都不能落库
    expect(await countRows()).toBe(0);
    expect(await jsonOf(await get(app, '/api/reaction-model', cookie))).toEqual({ config: DEFAULT_CONFIG });
  });

  it('关掉时允许空 model：存在库里但读侧仍当「没有表情模型」', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reaction-model', { enabled: false, provider: 'openai-compat', model: '' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual(DEFAULT_CONFIG);
    // model 空白 = 没有表情模型（§21.2），GET 因此回缺省形状
    expect(await jsonOf(await get(app, '/api/reaction-model', cookie))).toEqual({ config: DEFAULT_CONFIG });
  });
});
