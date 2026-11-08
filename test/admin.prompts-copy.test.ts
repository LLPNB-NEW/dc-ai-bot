import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT } from '../src/core/prompt/resolver';
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
type Json = Record<string, unknown>;

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

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

/** 段的服务端 id 由请求给定：复制前后逐字比对才有意义（不给 id 时服务端会随机生成） */
function segmentOf(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, name: '基本设定', role: 'system', content, enabled: true, placement: 'before', ...extra };
}

/** 服务端按数组下标补 position：请求里的段不带它 */
function withPositions(segments: Json[]): Json[] {
  return segments.map((segment, index) => ({ ...segment, position: index }));
}

async function putPrompt(
  app: App,
  cookie: string,
  key: { scope: string; scopeId: string },
  body: Record<string, unknown>,
): Promise<Response> {
  return send(app, 'PUT', '/api/prompts', { ...key, ...body }, cookie);
}

async function copyPrompt(app: App, cookie: string, body: Record<string, unknown>): Promise<Response> {
  return send(app, 'POST', '/api/prompts/copy', body, cookie);
}

async function itemsOf(app: App, cookie: string): Promise<Json[]> {
  const body = await jsonOf(await app.request('/api/prompts', { headers: { cookie } }));
  return body.items as Json[];
}

/** GET /api/prompts 里那一层（没配过给 undefined） */
async function storedOf(app: App, cookie: string, scope: string, scopeId: string): Promise<Json | undefined> {
  return (await itemsOf(app, cookie)).find((item) => item['scope'] === scope && item['scopeId'] === scopeId);
}

/** 频道→服务器的反查靠消息表：这条消息就是「C1 属于 G1」的唯一证据 */
async function seedMessage(guildId: string, channelId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO messages (guild_id, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(guildId, channelId, 'U1', 'user', '在吗', '2026-01-01T00:00:00.000Z')
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prompts'),
    env.DB.prepare('DELETE FROM prompt_segments'),
    env.DB.prepare('DELETE FROM prompt_defaults'),
    env.DB.prepare('DELETE FROM messages'),
  ]);
});

describe('admin prompts copy', () => {
  it('a) 源频道自己配过：整份复制到服务器层，源不动', async () => {
    const { app, cookie } = await setup();
    const segments = [
      segmentOf('seg-a', '频道设定 {{bot_name}}'),
      segmentOf('seg-b', '结尾提醒 {{user_name}}', { placement: 'after' }),
    ];
    const put = await putPrompt(app, cookie, { scope: 'channel', scopeId: 'C1' }, { segments, temperature: 0.4, maxTokens: 512 });
    expect(put.status).toBe(200);

    const res = await copyPrompt(app, cookie, {
      fromScope: 'channel',
      fromScopeId: 'C1',
      toScope: 'guild',
      toScopeId: 'G1',
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['scope']).toBe('guild');
    expect(body['scopeId']).toBe('G1');
    expect(body['sourceScope']).toBe('channel');
    expect(body['sourceScopeId']).toBe('C1');
    expect(body['segments']).toEqual(withPositions(segments));
    expect(body['temperature']).toBe(0.4);
    expect(body['maxTokens']).toBe(512);

    // 目标层从此有了自己的显式行，内容与源逐字一致
    const stored = await storedOf(app, cookie, 'guild', 'G1');
    expect(stored?.['segments']).toEqual(body['segments']);
    expect(stored?.['temperature']).toBe(0.4);
    expect(stored?.['maxTokens']).toBe(512);

    // 复制是深拷贝：源层一个字都没变
    expect((await storedOf(app, cookie, 'channel', 'C1'))?.['segments']).toEqual(withPositions(segments));
  });

  it('b) 源频道空：复制它所属服务器的那份，sourceScope 回报 guild', async () => {
    const { app, cookie } = await setup();
    await seedMessage('G1', 'C1');
    const guildSegments = [segmentOf('seg-g', '服务器设定 {{bot_name}}')];
    const put = await putPrompt(app, cookie, { scope: 'guild', scopeId: 'G1' }, { segments: guildSegments, temperature: 0.7, maxTokens: 300 });
    expect(put.status).toBe(200);

    const res = await copyPrompt(app, cookie, {
      fromScope: 'channel',
      fromScopeId: 'C1',
      toScope: 'channel',
      toScopeId: 'C2',
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['scope']).toBe('channel');
    expect(body['scopeId']).toBe('C2');
    expect(body['sourceScope']).toBe('guild');
    expect(body['sourceScopeId']).toBe('G1');
    expect(body['segments']).toEqual(withPositions(guildSegments));
    expect(body['temperature']).toBe(0.7);
    expect(body['maxTokens']).toBe(300);
    expect((await storedOf(app, cookie, 'channel', 'C2'))?.['segments']).toEqual(body['segments']);
  });

  it('b-2) 频道从没落库：跳过服务器层，落到 global', async () => {
    const { app, cookie } = await setup();
    // 全局与某个服务器的行都在，但 C9 没有任何消息：反查不到它属于哪个服务器
    const globalSegments = [segmentOf('seg-all', '全局设定 {{bot_name}}')];
    expect((await putPrompt(app, cookie, { scope: 'global', scopeId: '' }, { segments: globalSegments })).status).toBe(200);
    expect(
      (await putPrompt(app, cookie, { scope: 'guild', scopeId: 'G1' }, { segments: [segmentOf('seg-g1', '服务器设定')] })).status,
    ).toBe(200);

    const res = await copyPrompt(app, cookie, {
      fromScope: 'channel',
      fromScopeId: 'C9',
      toScope: 'channel',
      toScopeId: 'C10',
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['sourceScope']).toBe('global');
    expect(body['sourceScopeId']).toBe('');
    expect(body['segments']).toEqual(withPositions(globalSegments));
  });

  it('c) 三层全空：先复制后台内置默认，兜底也空则复制 DEFAULT_PROMPT', async () => {
    const { app, cookie } = await setup();
    const fallbackContent = '兜底设定：你是 {{bot_name}}。';
    const put = await send(
      app,
      'PUT',
      '/api/prompt-defaults',
      { key: 'fallback', scope: 'global', scopeId: '', content: fallbackContent },
      cookie,
    );
    expect(put.status).toBe(200);

    const first = await copyPrompt(app, cookie, { fromScope: 'global', fromScopeId: '', toScope: 'guild', toScopeId: 'G1' });
    expect(first.status).toBe(200);
    const firstBody = await jsonOf(first);
    expect(firstBody['sourceScope']).toBe('global');
    expect(firstBody['sourceScopeId']).toBe('');
    expect(firstBody['segments']).toEqual([
      { id: 'fallback', name: '内置默认', role: 'system', content: fallbackContent, enabled: true, placement: 'before', position: 0 },
    ]);
    // 兜底文案本身没有采样数字：目标层也不会凭空多出这两个键
    expect(firstBody['temperature']).toBeUndefined();
    expect(firstBody['maxTokens']).toBeUndefined();

    const del = await send(app, 'DELETE', '/api/prompt-defaults?key=fallback&scope=global&scopeId=', undefined, cookie);
    expect(del.status).toBe(200);

    const second = await copyPrompt(app, cookie, { fromScope: 'global', fromScopeId: '', toScope: 'guild', toScopeId: 'G2' });
    expect(second.status).toBe(200);
    const secondBody = await jsonOf(second);
    expect(secondBody['sourceScope']).toBe('global');
    expect(secondBody['sourceScopeId']).toBe('');
    expect(secondBody['segments']).toEqual(DEFAULT_PROMPT.segments);
  });

  it('d) 目标原有配置被整份覆盖（旧段与旧数字都不留）', async () => {
    const { app, cookie } = await setup();
    const globalSegments = [segmentOf('seg-new', '新设定 {{bot_name}}')];
    expect((await putPrompt(app, cookie, { scope: 'global', scopeId: '' }, { segments: globalSegments, temperature: 0.2 })).status).toBe(200);
    const oldSegments = [segmentOf('seg-old', '旧设定')];
    expect(
      (await putPrompt(app, cookie, { scope: 'channel', scopeId: 'C2' }, { segments: oldSegments, temperature: 0.9, maxTokens: 900 })).status,
    ).toBe(200);

    const res = await copyPrompt(app, cookie, { fromScope: 'global', fromScopeId: '', toScope: 'channel', toScopeId: 'C2' });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['segments']).toEqual(withPositions(globalSegments));
    expect(body['temperature']).toBe(0.2);
    // 源没配 maxTokens：旧目标层的 900 必须消失，而不是被保留
    expect(body['maxTokens']).toBeUndefined();
    const stored = await storedOf(app, cookie, 'channel', 'C2');
    expect(stored?.['segments']).toEqual(withPositions(globalSegments));
    expect(stored?.['maxTokens']).toBeUndefined();
  });

  it('e) 源与目标同一层：SAME_TARGET', async () => {
    const { app, cookie } = await setup();
    const sameChannel = await copyPrompt(app, cookie, {
      fromScope: 'channel',
      fromScopeId: 'C1',
      toScope: 'channel',
      toScopeId: 'C1',
    });
    expect(sameChannel.status).toBe(400);
    expect(await jsonOf(sameChannel)).toEqual({ error: 'SAME_TARGET' });

    const sameGlobal = await copyPrompt(app, cookie, {
      fromScope: 'global',
      fromScopeId: '',
      toScope: 'global',
      toScopeId: '',
    });
    expect(sameGlobal.status).toBe(400);
    expect(await jsonOf(sameGlobal)).toEqual({ error: 'SAME_TARGET' });
  });

  it('f) 非法作用域 BAD_SCOPE；缺 scopeId / 类型不对是 BAD_REQUEST', async () => {
    const { app, cookie } = await setup();
    const badFrom = await copyPrompt(app, cookie, {
      fromScope: 'world',
      fromScopeId: 'X',
      toScope: 'global',
      toScopeId: '',
    });
    expect(badFrom.status).toBe(400);
    expect(await jsonOf(badFrom)).toEqual({ error: 'BAD_SCOPE' });

    const badTo = await copyPrompt(app, cookie, {
      fromScope: 'global',
      fromScopeId: '',
      toScope: 'world',
      toScopeId: 'X',
    });
    expect(badTo.status).toBe(400);
    expect(await jsonOf(badTo)).toEqual({ error: 'BAD_SCOPE' });

    const missingId = await copyPrompt(app, cookie, { fromScope: 'channel', toScope: 'global', toScopeId: '' });
    expect(missingId.status).toBe(400);
    expect(await jsonOf(missingId)).toEqual({ error: 'BAD_REQUEST' });

    const wrongType = await copyPrompt(app, cookie, {
      fromScope: 'global',
      fromScopeId: '',
      toScope: 'guild',
      toScopeId: 42,
    });
    expect(wrongType.status).toBe(400);
    expect(await jsonOf(wrongType)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('未登录：401，且不写库', async () => {
    const app = makeApp();
    const res = await app.request('/api/prompts/copy', {
      method: 'POST',
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ fromScope: 'global', fromScopeId: '', toScope: 'global', toScopeId: '' }),
    });
    expect(res.status).toBe(401);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM prompts').first<{ n: number }>();
    expect(row?.n ?? 0).toBe(0);
  });
});
