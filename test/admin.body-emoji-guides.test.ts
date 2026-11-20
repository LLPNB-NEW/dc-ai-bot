import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BODY_EMOJI_SUGGESTION, DEFAULT_BODY_EMOJI_GUIDE } from '../src/core/chat/body-emoji';
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
  await env.DB.batch([env.DB.prepare('DELETE FROM body_emoji_guides')]);
});

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function getGuides(app: App, cookie: string): Promise<Json> {
  const res = await send(app, 'GET', '/api/body-emoji-guides', undefined, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

describe('GET /api/body-emoji-guides', () => {
  it('空库：items 是空数组，default 是空串（默认关），suggestion 是推荐文案', async () => {
    const { app, cookie } = await setup();

    const body = await getGuides(app, cookie);
    expect(body).toEqual({
      items: [],
      default: DEFAULT_BODY_EMOJI_GUIDE,
      suggestion: BODY_EMOJI_SUGGESTION,
    });
    // 默认关：内置文案必须真的是空串，而不是某个会被无脑注入的默认规则
    expect(body).toMatchObject({ default: '' });
    // 推荐文案非空，只给后台按钮「一键填入」，保存后才生效
    expect(typeof body.suggestion).toBe('string');
    expect((body.suggestion as string).length).toBeGreaterThan(0);
  });

  it('未登录 401：与其它 /api 路由同一道闸门', async () => {
    const app = makeApp();
    const res = await send(app, 'GET', '/api/body-emoji-guides');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/body-emoji-guides', () => {
  it('三层都能写、都能读回来（往返一致）', async () => {
    const { app, cookie } = await setup();

    // 期望顺序就是仓储的 ORDER BY scope ASC：channel → global → guild（按字符串升序）
    const rows = [
      { scope: 'channel', scopeId: 'c1', prompt: '频道这一份文案' },
      { scope: 'global', scopeId: '', prompt: '全局这一份文案' },
      { scope: 'guild', scopeId: 'g1', prompt: '公会这一份文案' },
    ];
    for (const row of rows) {
      const res = await send(app, 'PUT', '/api/body-emoji-guides', row, cookie);
      expect(res.status).toBe(200);
      const saved = await jsonOf(res);
      expect(saved).toMatchObject(row);
      expect(typeof saved.updatedAt).toBe('string');
    }

    const listed = await getGuides(app, cookie);
    expect(listed.items).toMatchObject(rows);
  });

  it('global 层的 scopeId 被钉成空串：请求里带什么都不会进库', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/body-emoji-guides', {
      scope: 'global',
      scopeId: 'ignored',
      prompt: '全局文案',
    }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ scope: 'global', scopeId: '' });
  });

  it('同一层再 PUT 一次是覆盖写，不是新增一行', async () => {
    const { app, cookie } = await setup();

    await send(app, 'PUT', '/api/body-emoji-guides', { scope: 'guild', scopeId: 'g1', prompt: '第一版' }, cookie);
    await send(app, 'PUT', '/api/body-emoji-guides', { scope: 'guild', scopeId: 'g1', prompt: '第二版' }, cookie);

    const listed = await getGuides(app, cookie);
    expect(listed.items).toHaveLength(1);
    expect((listed.items as Json[])[0]).toMatchObject({ scope: 'guild', scopeId: 'g1', prompt: '第二版' });
  });

  it('scope 不在枚举 → 400 BAD_SCOPE', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/body-emoji-guides', { scope: 'server', prompt: '文案' }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_SCOPE' });
  });

  it('guild / channel 缺 scopeId 或给空串 → 400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();

    for (const body of [
      { scope: 'guild', prompt: '文案' },
      { scope: 'guild', scopeId: '', prompt: '文案' },
      { scope: 'channel', scopeId: 42, prompt: '文案' },
    ]) {
      const res = await send(app, 'PUT', '/api/body-emoji-guides', body, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_REQUEST' });
    }
  });

  it('prompt 不是字符串、trim 后为空、超过 8000 字 → 400 BAD_BODY_EMOJI_GUIDE', async () => {
    const { app, cookie } = await setup();

    for (const prompt of [undefined, null, 42, '', '   \n\t ', '字'.repeat(8001)]) {
      const res = await send(app, 'PUT', '/api/body-emoji-guides', { scope: 'global', prompt }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_BODY_EMOJI_GUIDE' });
    }
    // 空串只有一种解释：这里一律拒，留空回上层走 DELETE
    expect((await getGuides(app, cookie)).items).toEqual([]);
  });

  it('正好 8000 字可以存：边界值算合法', async () => {
    const { app, cookie } = await setup();

    const prompt = '字'.repeat(8000);
    const res = await send(app, 'PUT', '/api/body-emoji-guides', { scope: 'global', prompt }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ prompt });
  });

  it('库里存的是 trim 过的文案：前后空行不落库', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/body-emoji-guides', { scope: 'global', prompt: '  文案  ' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ prompt: '文案' });
  });
});

describe('DELETE /api/body-emoji-guides', () => {
  it('删掉一层后回落：GET 里不再有那一行', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/body-emoji-guides', { scope: 'channel', scopeId: 'c1', prompt: '频道文案' }, cookie);

    const res = await send(app, 'DELETE', '/api/body-emoji-guides', { scope: 'channel', scopeId: 'c1' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect((await getGuides(app, cookie)).items).toEqual([]);
  });

  it('删不存在的行也是成功：后台连点两下不该报错', async () => {
    const { app, cookie } = await setup();

    const first = await send(app, 'DELETE', '/api/body-emoji-guides', { scope: 'guild', scopeId: 'g1' }, cookie);
    const second = await send(app, 'DELETE', '/api/body-emoji-guides', { scope: 'guild', scopeId: 'g1' }, cookie);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('scope 非法 → BAD_SCOPE；guild 缺 scopeId → BAD_REQUEST', async () => {
    const { app, cookie } = await setup();

    const badScope = await send(app, 'DELETE', '/api/body-emoji-guides', { scope: 'nope', scopeId: 'x' }, cookie);
    expect(badScope.status).toBe(400);
    expect(await jsonOf(badScope)).toEqual({ error: 'BAD_SCOPE' });

    const missing = await send(app, 'DELETE', '/api/body-emoji-guides', { scope: 'guild' }, cookie);
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('未登录 401', async () => {
    const app = makeApp();
    const res = await send(app, 'DELETE', '/api/body-emoji-guides', { scope: 'global', scopeId: '' });
    expect(res.status).toBe(401);
  });
});
