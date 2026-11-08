import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REACTION_TEMPLATE, REACTION_TEMPLATE_VARS } from '../src/core/chat/reaction-template';
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
  await env.DB.batch([env.DB.prepare('DELETE FROM reaction_templates')]);
});

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function getTemplates(app: App, cookie: string): Promise<Json> {
  const res = await send(app, 'GET', '/api/reaction-templates', undefined, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

describe('GET /api/reaction-templates', () => {
  it('空库：items 空数组，default 是内置模板，vars 给全 6 个占位符', async () => {
    const { app, cookie } = await setup();

    expect(await getTemplates(app, cookie)).toEqual({
      items: [],
      default: DEFAULT_REACTION_TEMPLATE,
      vars: [...REACTION_TEMPLATE_VARS],
    });
  });

  it('未登录 401：与其它 /api 路由同一道闸门', async () => {
    const app = makeApp();
    expect((await send(app, 'GET', '/api/reaction-templates')).status).toBe(401);
  });
});

describe('PUT /api/reaction-templates', () => {
  it('channel 层：200 回写后的对象，GET 能读回来（往返一致）', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reaction-templates', {
      scope: 'channel',
      scopeId: 'c1',
      template: '{{我的回复}}',
    }, cookie);
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    expect(saved).toMatchObject({ scope: 'channel', scopeId: 'c1', template: '{{我的回复}}' });
    expect(typeof saved.updatedAt).toBe('string');

    expect((await getTemplates(app, cookie)).items).toEqual([saved]);
  });

  it('global 层的 scopeId 被钉成空串：请求里带什么都不会进库', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reaction-templates', {
      scope: 'global',
      scopeId: 'ignored',
      template: '{{最近对话}}',
    }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ scope: 'global', scopeId: '' });
  });

  it('同一层再 PUT 一次是覆盖写，不是新增一行', async () => {
    const { app, cookie } = await setup();

    await send(app, 'PUT', '/api/reaction-templates', { scope: 'guild', scopeId: 'g1', template: '{{我的回复}}' }, cookie);
    await send(app, 'PUT', '/api/reaction-templates', { scope: 'guild', scopeId: 'g1', template: '{{对方的消息}}' }, cookie);

    const listed = await getTemplates(app, cookie);
    expect(listed.items).toHaveLength(1);
    expect((listed.items as Json[])[0]).toMatchObject({ scope: 'guild', scopeId: 'g1', template: '{{对方的消息}}' });
  });

  it('scope 不在枚举 → 400 BAD_SCOPE；guild 缺 scopeId → 400 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();

    const badScope = await send(app, 'PUT', '/api/reaction-templates', { scope: 'server', template: '{{我的回复}}' }, cookie);
    expect(badScope.status).toBe(400);
    expect(await jsonOf(badScope)).toEqual({ error: 'BAD_SCOPE' });

    const missing = await send(app, 'PUT', '/api/reaction-templates', { scope: 'guild', template: '{{我的回复}}' }, cookie);
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('template 不是字符串、trim 后为空 → 400 BAD_REACTION_TEMPLATE，且不入库', async () => {
    const { app, cookie } = await setup();

    for (const template of [undefined, null, 42, '', '   \n\t ']) {
      const res = await send(app, 'PUT', '/api/reaction-templates', { scope: 'global', template }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_REACTION_TEMPLATE' });
    }
    // 空模板只有一种解释：这一层回上层，走 DELETE
    expect((await getTemplates(app, cookie)).items).toEqual([]);
  });

  it('超过 8000 字 → 400 BAD_REACTION_TEMPLATE；正好 8000 字可以存', async () => {
    const { app, cookie } = await setup();

    const tooLong = '{{我的回复}}' + '字'.repeat(8000 - '{{我的回复}}'.length + 1);
    const rejected = await send(app, 'PUT', '/api/reaction-templates', { scope: 'global', template: tooLong }, cookie);
    expect(rejected.status).toBe(400);
    expect(await jsonOf(rejected)).toEqual({ error: 'BAD_REACTION_TEMPLATE' });

    const exact = '{{我的回复}}' + '字'.repeat(8000 - '{{我的回复}}'.length);
    const accepted = await send(app, 'PUT', '/api/reaction-templates', { scope: 'global', template: exact }, cookie);
    expect(accepted.status).toBe(200);
    expect(await jsonOf(accepted)).toMatchObject({ template: exact });
  });

  it('写了白名单外的占位符 → 400 UNKNOWN_TEMPLATE_VAR，body.vars 只列那些错名字', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reaction-templates', {
      scope: 'global',
      template: '{{我的回复}}\n{{乱写}}\n{{对方的消息}}\n{{也乱写}}',
    }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'UNKNOWN_TEMPLATE_VAR', vars: ['乱写', '也乱写'] });
    expect((await getTemplates(app, cookie)).items).toEqual([]);
  });

  it('一个已知占位符都没有 → 400 BAD_REACTION_TEMPLATE：全是死文字，模型没得判断', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reaction-templates', {
      scope: 'global',
      template: '【对方的消息】\n你好\n\n【我的回复】\n好的',
    }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_REACTION_TEMPLATE' });
  });

  it('库里存的是 trim 过的模板：前后空行不落库', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'PUT', '/api/reaction-templates', { scope: 'global', template: '  {{我的回复}}  ' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ template: '{{我的回复}}' });
  });
});

describe('DELETE /api/reaction-templates', () => {
  it('删掉一层后回落：GET 里不再有那一行', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/reaction-templates', { scope: 'channel', scopeId: 'c1', template: '{{我的回复}}' }, cookie);

    const res = await send(app, 'DELETE', '/api/reaction-templates', { scope: 'channel', scopeId: 'c1' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect((await getTemplates(app, cookie)).items).toEqual([]);
  });

  it('删不存在的行也是成功：后台连点两下不该报错', async () => {
    const { app, cookie } = await setup();

    const first = await send(app, 'DELETE', '/api/reaction-templates', { scope: 'guild', scopeId: 'g1' }, cookie);
    const second = await send(app, 'DELETE', '/api/reaction-templates', { scope: 'guild', scopeId: 'g1' }, cookie);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('scope 非法 → BAD_SCOPE；guild 缺 scopeId → BAD_REQUEST', async () => {
    const { app, cookie } = await setup();

    const badScope = await send(app, 'DELETE', '/api/reaction-templates', { scope: 'nope', scopeId: 'x' }, cookie);
    expect(badScope.status).toBe(400);
    expect(await jsonOf(badScope)).toEqual({ error: 'BAD_SCOPE' });

    const missing = await send(app, 'DELETE', '/api/reaction-templates', { scope: 'guild' }, cookie);
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('未登录 401', async () => {
    const app = makeApp();
    expect((await send(app, 'DELETE', '/api/reaction-templates', { scope: 'global', scopeId: '' })).status).toBe(401);
  });
});
