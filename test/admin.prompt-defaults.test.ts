import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildIdentityBlock } from '../src/core/chat/service';
import { CODE_IDENTITY_TEMPLATE, SAMPLE_PROMPT_VARS } from '../src/core/prompt/defaults';
import { DEFAULT_PROMPT } from '../src/core/prompt/resolver';
import { renderTemplate } from '../src/core/prompt/template';
import type { TurnContext } from '../src/core/types';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

/** 与 SAMPLE_PROMPT_VARS 同一组示例值：GET 的 codeDefaults.identity.rendered 必须等于它装配出的身份块 */
const SAMPLE_CTX: TurnContext = {
  guildId: SAMPLE_PROMPT_VARS.guild_name,
  channelId: SAMPLE_PROMPT_VARS.channel_name,
  userId: SAMPLE_PROMPT_VARS.user_id,
  userName: SAMPLE_PROMPT_VARS.user_name,
  guildName: SAMPLE_PROMPT_VARS.guild_name,
  channelName: SAMPLE_PROMPT_VARS.channel_name,
  botName: SAMPLE_PROMPT_VARS.bot_name,
  userText: '在吗',
};

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

async function itemsOf(app: App, cookie: string): Promise<Json[]> {
  const body = await jsonOf(await app.request('/api/prompt-defaults', { headers: { cookie } }));
  return body.items as Json[];
}

async function rowCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM prompt_defaults').first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM prompt_defaults')]);
});

describe('admin prompt defaults', () => {
  it('GET：空库时 items 为空，变量表/上限/层清单/示例变量/代码默认原文与预览一起回', async () => {
    const { app, cookie } = await setup();

    const res = await app.request('/api/prompt-defaults', { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items).toEqual([]);
    expect(body.vars).toEqual({
      fallback: ['bot_name', 'user_name', 'guild_name', 'channel_name', 'date'],
      identity: ['bot_name', 'user_name', 'user_id', 'guild_name', 'channel_name', 'date'],
    });
    expect(body.maxChars).toBe(20000);
    expect(body.scopes).toEqual(['channel', 'guild', 'global']);
    expect(body.sampleVars).toEqual(SAMPLE_PROMPT_VARS);

    const code = body.codeDefaults as Json;
    const codeFallback = code.fallback as Json;
    const codeIdentity = code.identity as Json;
    const codeFallbackText = DEFAULT_PROMPT.segments[0]?.content ?? '';
    expect(codeFallback.text).toBe(codeFallbackText);
    expect(codeFallback.rendered).toBe(renderTemplate(codeFallbackText, SAMPLE_PROMPT_VARS));
    expect(codeIdentity.text).toBe(CODE_IDENTITY_TEMPLATE);
    // 关键：identity 的 rendered 是线上装配函数拼出来的，不是把六行模板渲染一遍冒充
    expect(codeIdentity.rendered).toBe(buildIdentityBlock(SAMPLE_CTX, SAMPLE_PROMPT_VARS.date));
    expect(codeIdentity.rendered).toBe(
      '\n\n【当前对话】和你说话的是 ' +
        SAMPLE_PROMPT_VARS.user_name +
        '（ID ' +
        SAMPLE_PROMPT_VARS.user_id +
        '）；这里：' +
        SAMPLE_PROMPT_VARS.guild_name +
        ' · ' +
        SAMPLE_PROMPT_VARS.channel_name +
        '；今天 ' +
        SAMPLE_PROMPT_VARS.date +
        '。',
    );
  });

  it('PUT → GET → DELETE 往返：按 (key, scope, scopeId) 落行，content 原样存', async () => {
    const { app, cookie } = await setup();
    const content = '【当前对话】\n和你说话的是 {{user_name}}\n今天 {{date}}';

    const put = await send(app, 'PUT', '/api/prompt-defaults', { key: 'identity', scope: 'global', content }, cookie);
    expect(put.status).toBe(200);
    const putBody = await jsonOf(put);
    expect(putBody.key).toBe('identity');
    expect(putBody.scope).toBe('global');
    expect(putBody.scopeId).toBe('');
    expect(putBody.content).toBe(content);
    expect(typeof putBody.updatedAt).toBe('string');

    const items = await itemsOf(app, cookie);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ key: 'identity', scope: 'global', scopeId: '', content, updatedAt: putBody.updatedAt });

    // 同 key 同层覆盖写：仍只有一行，内容换成新的
    const again = await send(app, 'PUT', '/api/prompt-defaults', { key: 'identity', scope: 'global', content: '只有 {{bot_name}}' }, cookie);
    expect(again.status).toBe(200);
    expect(await rowCount()).toBe(1);
    expect((await itemsOf(app, cookie))[0]?.content).toBe('只有 {{bot_name}}');

    // 两个 key 都在时按 fallback → identity 的固定顺序返回
    await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope: 'global', content: '你是 {{bot_name}}，今天是 {{date}}。' }, cookie);
    const both = await itemsOf(app, cookie);
    expect(both.map((item) => item.key)).toEqual(['fallback', 'identity']);

    const del = await send(app, 'DELETE', '/api/prompt-defaults?key=identity&scope=global', undefined, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await itemsOf(app, cookie)).map((item) => item.key)).toEqual(['fallback']);

    // 删第二次命中 0 行也算成功
    const missing = await send(app, 'DELETE', '/api/prompt-defaults?key=identity&scope=global', undefined, cookie);
    expect(await missing.json()).toEqual({ ok: true });
  });

  it('三层分行：GET 顺序固定为 channel → guild → global；DELETE 只删指定层', async () => {
    const { app, cookie } = await setup();
    const content = '【当前对话】\n和你说话的是 {{user_name}}';

    for (const body of [
      { key: 'identity', scope: 'channel', scopeId: 'c1', content },
      { key: 'identity', scope: 'guild', scopeId: 'g1', content },
      { key: 'identity', scope: 'global', content },
    ]) {
      const res = await send(app, 'PUT', '/api/prompt-defaults', body, cookie);
      expect(res.status).toBe(200);
    }
    expect(await rowCount()).toBe(3);

    const all = await itemsOf(app, cookie);
    expect(all.map((item) => item.scope)).toEqual(['channel', 'guild', 'global']);
    expect(all.map((item) => item.scopeId)).toEqual(['c1', 'g1', '']);

    // 删服务器层：频道层与全局层仍在
    const del = await send(app, 'DELETE', '/api/prompt-defaults?key=identity&scope=guild&scopeId=g1', undefined, cookie);
    expect(del.status).toBe(200);
    const left = await itemsOf(app, cookie);
    expect(left.map((item) => item.scope)).toEqual(['channel', 'global']);
    expect(await rowCount()).toBe(2);
  });

  it('PUT 400：key → scope → content → 未知变量的四类错误码', async () => {
    const { app, cookie } = await setup();

    for (const key of ['global', 'Fallback', '', 42, null]) {
      const res = await send(app, 'PUT', '/api/prompt-defaults', { key, scope: 'global', content: '正文' }, cookie);
      expect(res.status, String(key)).toBe(400);
      expect(await res.json(), String(key)).toEqual({ error: 'BAD_PROMPT_KEY' });
    }

    for (const scope of ['server', '', 42, null, undefined]) {
      const res = await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope, content: '正文' }, cookie);
      expect(res.status, String(scope)).toBe(400);
      expect(await res.json(), String(scope)).toEqual({ error: 'BAD_SCOPE' });
    }

    // 非 global 缺 scopeId（或 scopeId 不是字符串）= 缺必填字段，走 BAD_REQUEST
    for (const body of [
      { key: 'fallback', scope: 'guild', content: '正文' },
      { key: 'fallback', scope: 'channel', scopeId: 42, content: '正文' },
    ]) {
      const res = await send(app, 'PUT', '/api/prompt-defaults', body, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_REQUEST' });
    }

    for (const content of ['', '   ', 42, null, undefined]) {
      const res = await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope: 'global', content }, cookie);
      expect(res.status, String(content)).toBe(400);
      expect(await res.json(), String(content)).toEqual({ error: 'BAD_PROMPT_CONTENT' });
    }

    const tooLong = await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope: 'global', content: 'a'.repeat(20001) }, cookie);
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: 'BAD_PROMPT_CONTENT' });

    // 上限本身是合法的
    const atLimit = await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope: 'global', content: 'a'.repeat(20000) }, cookie);
    expect(atLimit.status).toBe(200);

    const unknown = await send(app, 'PUT', '/api/prompt-defaults', { key: 'identity', scope: 'global', content: '昵称：{{nickname}}' }, cookie);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'UNKNOWN_TEMPLATE_VAR', vars: ['nickname'] });

    // 变量表按 key 各自生效：兜底提示词不认识 user_id
    const wrongKeyVars = await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope: 'global', content: 'ID：{{user_id}}' }, cookie);
    expect(wrongKeyVars.status).toBe(400);
    expect(await wrongKeyVars.json()).toEqual({ error: 'UNKNOWN_TEMPLATE_VAR', vars: ['user_id'] });

    // 被拒的请求一行都没多写（只有 atLimit 那一行）
    expect(await itemsOf(app, cookie)).toHaveLength(1);
  });

  it('DELETE 400：key 非法 / scope 非法 / 非 global 缺 scopeId', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope: 'global', content: '正文' }, cookie);
    await send(app, 'PUT', '/api/prompt-defaults', { key: 'identity', scope: 'channel', scopeId: 'c1', content: '正文' }, cookie);

    for (const query of ['', '?key=', '?key=global', '?key=IDENTITY']) {
      const res = await send(app, 'DELETE', '/api/prompt-defaults' + query, undefined, cookie);
      expect(res.status, query).toBe(400);
      expect(await res.json(), query).toEqual({ error: 'BAD_PROMPT_KEY' });
    }

    const badScope = await send(app, 'DELETE', '/api/prompt-defaults?key=fallback&scope=server', undefined, cookie);
    expect(badScope.status).toBe(400);
    expect(await badScope.json()).toEqual({ error: 'BAD_SCOPE' });

    const missingScope = await send(app, 'DELETE', '/api/prompt-defaults?key=fallback', undefined, cookie);
    expect(missingScope.status).toBe(400);
    expect(await missingScope.json()).toEqual({ error: 'BAD_SCOPE' });

    // 非 global 缺 scopeId：BAD_REQUEST（不是 BAD_SCOPE）
    const missingId = await send(app, 'DELETE', '/api/prompt-defaults?key=identity&scope=channel', undefined, cookie);
    expect(missingId.status).toBe(400);
    expect(await missingId.json()).toEqual({ error: 'BAD_REQUEST' });

    // 一次都没删掉
    expect(await itemsOf(app, cookie)).toHaveLength(2);
  });

  it('POST preview：渲染 + 未知变量点名；不写库', async () => {
    const { app, cookie } = await setup();

    const rendered = await send(app, 'POST', '/api/prompt-defaults/preview', { key: 'fallback', content: '你是 {{bot_name}}，今天 {{date}}。' }, cookie);
    expect(rendered.status).toBe(200);
    expect(await rendered.json()).toEqual({
      key: 'fallback',
      rendered: '你是 示例机器人，今天 2026-11-05。',
      unknownVars: [],
    });

    const unknown = await send(app, 'POST', '/api/prompt-defaults/preview', { key: 'identity', content: '【当前对话】\n昵称：{{nickname}}\n和你说话的是 {{user_name}}' }, cookie);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({
      key: 'identity',
      rendered: '\n\n【当前对话】\n和你说话的是 示例用户',
      unknownVars: ['nickname'],
    });

    // 空白正文是合法预览：清空输入框不该报错
    const blank = await send(app, 'POST', '/api/prompt-defaults/preview', { key: 'identity', content: '   \n ' }, cookie);
    expect(blank.status).toBe(200);
    expect(await blank.json()).toEqual({ key: 'identity', rendered: '', unknownVars: [] });

    const badKey = await send(app, 'POST', '/api/prompt-defaults/preview', { key: 'global', content: '正文' }, cookie);
    expect(badKey.status).toBe(400);
    expect(await badKey.json()).toEqual({ error: 'BAD_PROMPT_KEY' });

    const badContent = await send(app, 'POST', '/api/prompt-defaults/preview', { key: 'identity', content: 42 }, cookie);
    expect(badContent.status).toBe(400);
    expect(await badContent.json()).toEqual({ error: 'BAD_PROMPT_CONTENT' });

    // 预览不落库
    expect(await rowCount()).toBe(0);
    expect(await itemsOf(app, cookie)).toHaveLength(0);
  });

  it('鉴权：没 cookie 时四条路由都是 401', async () => {
    const app = makeApp();

    const get = await app.request('/api/prompt-defaults');
    expect(get.status).toBe(401);
    expect(await get.json()).toEqual({ error: 'UNAUTHORIZED' });

    const put = await send(app, 'PUT', '/api/prompt-defaults', { key: 'fallback', scope: 'global', content: '正文' });
    expect(put.status).toBe(401);
    expect(await put.json()).toEqual({ error: 'UNAUTHORIZED' });

    const del = await send(app, 'DELETE', '/api/prompt-defaults?key=fallback&scope=global');
    expect(del.status).toBe(401);
    expect(await del.json()).toEqual({ error: 'UNAUTHORIZED' });

    const preview = await send(app, 'POST', '/api/prompt-defaults/preview', { key: 'fallback', content: '正文' });
    expect(preview.status).toBe(401);
    expect(await preview.json()).toEqual({ error: 'UNAUTHORIZED' });

    expect(await rowCount()).toBe(0);
  });
});
