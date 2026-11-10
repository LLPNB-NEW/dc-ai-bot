import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CustomEmoji, EmojiDescribeResult } from '../src/core/types';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import type { KeyProber } from '../src/workers/http/ports';
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

interface AppOptions {
  now?: () => number;
  probeKey?: KeyProber;
  /** §23.6：认图执行器由装配层注入；不传就是「未接线」，describe 端点应回 501 */
  describeEmojis?: (guildId: string, options?: { force?: boolean }) => Promise<EmojiDescribeResult>;
  /** §24.6：真实表情清单由装配层注入；不传就是「未接线」，live 端点应回 501 */
  listEmojis?: (guildId: string) => Promise<CustomEmoji[]>;
}

function makeApp(options: AppOptions = {}) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    // §26.4：本文件不验记忆配置，只要 deps 齐了不报类型错，给 core 的默认 50/50 即可
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
  };
  if (options.now !== undefined) deps.now = options.now;
  if (options.probeKey !== undefined) deps.probeKey = options.probeKey;
  if (options.describeEmojis !== undefined) deps.describeEmojis = options.describeEmojis;
  if (options.listEmojis !== undefined) deps.listEmojis = options.listEmojis;
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

async function get(app: App, path: string, cookie: string): Promise<Response> {
  return await app.request(path, { headers: { cookie } });
}

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function itemsOf(app: App, path: string, cookie: string): Promise<Json[]> {
  return (await jsonOf(await get(app, path, cookie))).items as Json[];
}

async function setup(options: AppOptions = {}) {
  const app = makeApp(options);
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prompts'),
    env.DB.prepare('DELETE FROM prompt_segments'),
    env.DB.prepare('DELETE FROM routes'),
    env.DB.prepare('DELETE FROM provider_keys'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM emoji_descriptions'),
    env.DB.prepare('DELETE FROM emoji_aliases'),
    env.DB.prepare('DELETE FROM prompt_injections'),
    env.DB.prepare('DELETE FROM world_books'),
  ]);
});

/** 段的最小合法形状：位置由服务端按数组下标写，请求里不带 position */
function segmentOf(content: string, extra: Record<string, unknown> = {}) {
  return { name: '基本设定', role: 'system', content, enabled: true, placement: 'before', ...extra };
}

async function countSegments(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM prompt_segments').first<{ n: number }>();
  return row?.n ?? 0;
}

describe('admin prompts', () => {
  it('PUT → GET → DELETE 往返（段按 position 升序返回）', async () => {
    const { app, cookie } = await setup();

    const main = segmentOf('你是 {{bot_name}}', { id: 'main' });
    const persona = segmentOf('冷静克制', { id: 'persona', name: '人格', placement: 'after' });
    const claim = segmentOf('只回一句话', { id: 'claim', name: '指令', role: 'user', enabled: false });
    const put = await send(app, 'PUT', '/api/prompts', {
      scope: 'global',
      scopeId: '',
      temperature: 0.3,
      maxTokens: 512,
      segments: [main, persona, claim],
    }, cookie);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      scope: 'global',
      scopeId: '',
      temperature: 0.3,
      maxTokens: 512,
      segments: [
        { ...main, position: 0 },
        { ...persona, position: 1 },
        { ...claim, position: 2 },
      ],
    });

    // 不带 id 的段由服务端生成 id
    const channel = await send(app, 'PUT', '/api/prompts', {
      scope: 'channel',
      scopeId: 'c1',
      segments: [segmentOf('频道提示词', { name: '频道' })],
    }, cookie);
    expect(channel.status).toBe(200);
    const channelBody = (await channel.json()) as { scope: string; segments: Array<{ id: string; position: number }> };
    expect(channelBody.scope).toBe('channel');
    expect(channelBody.segments).toHaveLength(1);
    expect(channelBody.segments[0]?.id).not.toBe('');
    expect(channelBody.segments[0]?.position).toBe(0);

    // 同 key 覆盖写而不是新增：旧段整组被替换
    await send(app, 'PUT', '/api/prompts', {
      scope: 'global',
      scopeId: '',
      segments: [segmentOf('改写后', { id: 'main' })],
    }, cookie);
    const listed = await itemsOf(app, '/api/prompts', cookie);
    expect(listed).toHaveLength(2);
    expect(listed.find((item) => item.scope === 'global')).toEqual({
      scope: 'global',
      scopeId: '',
      segments: [{ ...segmentOf('改写后', { id: 'main' }), position: 0 }],
    });
    expect(await countSegments()).toBe(2);

    const del = await send(app, 'DELETE', '/api/prompts', { scope: 'global', scopeId: '' }, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    const after = await itemsOf(app, '/api/prompts', cookie);
    expect(after).toHaveLength(1);
    expect(after[0]?.segments).toHaveLength(1);
    expect(await countSegments()).toBe(1);
  });

  it('未知模板变量逐段 400 UNKNOWN_TEMPLATE_VAR + vars', async () => {
    const { app, cookie } = await setup();

    const unknown = await send(app, 'PUT', '/api/prompts', {
      scope: 'global',
      segments: [segmentOf('你好 {{nope}} / {{ user_name }} / {{bad}} / {{nope}}')],
    }, cookie);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'UNKNOWN_TEMPLATE_VAR', vars: ['nope', 'bad'] });

    // 第一段干净、第二段有未知变量，同样拦（每段都过 renderTemplate）
    const second = await send(app, 'PUT', '/api/prompts', {
      scope: 'global',
      segments: [segmentOf('正常'), segmentOf('{{oops}}', { name: '第二段' })],
    }, cookie);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'UNKNOWN_TEMPLATE_VAR', vars: ['oops'] });

    expect(await itemsOf(app, '/api/prompts', cookie)).toHaveLength(0);
  });

  it('段形状非法一律 400 BAD_PROMPT_SEGMENTS：空数组、缺字段、坏枚举、非布尔、空 name、重复 id', async () => {
    const { app, cookie } = await setup();

    const bodies: unknown[] = [
      { scope: 'global', segments: [] },
      { scope: 'global' },
      { scope: 'global', segments: 'nope' },
      { scope: 'global', segments: [segmentOf('x', { role: 'assistant' })] },
      { scope: 'global', segments: [segmentOf('x', { placement: 'middle' })] },
      { scope: 'global', segments: [segmentOf('x', { enabled: 'yes' })] },
      { scope: 'global', segments: [segmentOf('x', { name: '   ' })] },
      { scope: 'global', segments: [segmentOf('x', { content: 5 })] },
      { scope: 'global', segments: [segmentOf('x', { id: '' })] },
      { scope: 'global', segments: [segmentOf('a', { id: 'same' }), segmentOf('b', { id: 'same', name: '第二段' })] },
    ];
    for (const body of bodies) {
      const res = await send(app, 'PUT', '/api/prompts', body, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_PROMPT_SEGMENTS' });
    }

    const badScope = await send(app, 'PUT', '/api/prompts', { scope: 'team', segments: [segmentOf('x')] }, cookie);
    expect(badScope.status).toBe(400);
    expect(await badScope.json()).toEqual({ error: 'BAD_SCOPE' });

    const scopedWithoutId = await send(app, 'PUT', '/api/prompts', { scope: 'guild', segments: [segmentOf('x')] }, cookie);
    expect(scopedWithoutId.status).toBe(400);
    expect(await scopedWithoutId.json()).toEqual({ error: 'BAD_REQUEST' });

    const brokenJson = await app.request('/api/prompts', { method: 'PUT', headers: { ...JSON_HEADERS, cookie }, body: '{not json' });
    expect(brokenJson.status).toBe(400);

    // 被拒的写入一条都不能落库
    expect(await itemsOf(app, '/api/prompts', cookie)).toHaveLength(0);
    expect(await countSegments()).toBe(0);
  });

  it('temperature 只收 0..2、maxTokens 只收 1..100000 的整数', async () => {
    const { app, cookie } = await setup();
    const body = (extra: Record<string, unknown>) => ({
      scope: 'global',
      segments: [segmentOf('正常')],
      ...extra,
    });

    for (const extra of [
      { temperature: -1 },
      { temperature: 2.5 },
      { temperature: '0.3' },
      { maxTokens: 0 },
      { maxTokens: 1.5 },
      { maxTokens: 100001 },
    ]) {
      const res = await send(app, 'PUT', '/api/prompts', body(extra), cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_REQUEST' });
    }

    const low = await send(app, 'PUT', '/api/prompts', body({ temperature: 0, maxTokens: 1 }), cookie);
    expect(low.status).toBe(200);
    expect(await low.json()).toMatchObject({ temperature: 0, maxTokens: 1 });

    const high = await send(app, 'PUT', '/api/prompts', body({ temperature: 2, maxTokens: 100000 }), cookie);
    expect(high.status).toBe(200);
  });

  it('停用的段不查未知变量：启用了才拦', async () => {
    const { app, cookie } = await setup();

    const draft = await send(app, 'PUT', '/api/prompts', {
      scope: 'global',
      segments: [segmentOf('正常'), segmentOf('{{oops}}', { name: '草稿', enabled: false })],
    }, cookie);
    expect(draft.status).toBe(200);

    const live = await send(app, 'PUT', '/api/prompts', {
      scope: 'global',
      segments: [segmentOf('{{oops}}', { name: '草稿' })],
    }, cookie);
    expect(live.status).toBe(400);
    expect(await live.json()).toEqual({ error: 'UNKNOWN_TEMPLATE_VAR', vars: ['oops'] });
  });
});

describe('admin routes', () => {
  it('temperature / maxTokens 与提示词同一把尺：越界一律 400', async () => {
    const { app, cookie } = await setup();
    const base = {
      scope: 'global',
      primary: { provider: 'openai-compat', model: 'gpt-4o-mini' },
      fallbacks: [],
    };

    for (const extra of [{ temperature: -0.1 }, { temperature: 3 }, { maxTokens: 0 }, { maxTokens: 2.5 }]) {
      const res = await send(app, 'PUT', '/api/routes', { ...base, ...extra }, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_REQUEST' });
    }

    const ok = await send(app, 'PUT', '/api/routes', { ...base, temperature: 1.5, maxTokens: 4096 }, cookie);
    expect(ok.status).toBe(200);
  });

  it('采样参数越界 / 不是数字一律 400：topP 0–1、topK 1–1000、seed 0–2147483647、两个 penalty -2–2', async () => {
    const { app, cookie } = await setup();
    const base = {
      scope: 'global',
      primary: { provider: 'openai-compat', model: 'gpt-4o-mini' },
      fallbacks: [],
    };

    for (const extra of [
      { topP: -0.01 },
      { topP: 1.01 },
      { topP: 'high' },
      { topK: 0 },
      { topK: 1001 },
      { topK: 2.5 },
      { seed: -1 },
      { seed: 2147483648 },
      { seed: 1.5 },
      { frequencyPenalty: -2.01 },
      { frequencyPenalty: 2.01 },
      { presencePenalty: -2.01 },
      { presencePenalty: 2.01 },
      { presencePenalty: 'mild' },
    ]) {
      const res = await send(app, 'PUT', '/api/routes', { ...base, ...extra }, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_REQUEST' });
    }

    // 边界值本身是合法的：0 与两个端点都要放行
    const edge = await send(
      app,
      'PUT',
      '/api/routes',
      { ...base, topP: 0, topK: 1000, seed: 2147483647, frequencyPenalty: -2, presencePenalty: 2 },
      cookie,
    );
    expect(edge.status).toBe(200);
  });

  it('五个采样参数落库回读：0 原样存住，不传或 null = 这一层不设（库里 NULL）', async () => {
    const { app, cookie } = await setup();
    const primary = { provider: 'gemini', model: 'gemini-2.5-flash' };
    const sampling = { topP: 0.8, topK: 40, seed: 7, frequencyPenalty: 0.5, presencePenalty: -0.5 };

    const put = await send(app, 'PUT', '/api/routes', { scope: 'channel', scopeId: 'c1', primary, fallbacks: [], ...sampling }, cookie);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ scope: 'channel', scopeId: 'c1', primary, fallbacks: [], ...sampling });
    expect(await itemsOf(app, '/api/routes', cookie)).toEqual([{ scope: 'channel', scopeId: 'c1', primary, fallbacks: [], ...sampling }]);

    // 0 是用户填过的值：既不能当没填丢掉，也不能被 ?? 换成 NULL
    const zero = { topP: 0, topK: 1, seed: 0, frequencyPenalty: 0, presencePenalty: 0 };
    const putZero = await send(app, 'PUT', '/api/routes', { scope: 'guild', scopeId: 'g1', primary, fallbacks: [], ...zero }, cookie);
    expect(putZero.status).toBe(200);
    expect(await putZero.json()).toEqual({ scope: 'guild', scopeId: 'g1', primary, fallbacks: [], ...zero });

    // null 与缺省等价：回读里连键都没有
    const silent = await send(app, 'PUT', '/api/routes', { scope: 'global', primary, fallbacks: [], topP: null, seed: null }, cookie);
    expect(silent.status).toBe(200);
    expect(await silent.json()).toEqual({ scope: 'global', scopeId: '', primary, fallbacks: [] });

    const channel = await env.DB.prepare('SELECT top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes WHERE scope = ? AND scope_id = ?')
      .bind('channel', 'c1')
      .first();
    expect(channel).toEqual({ top_p: 0.8, top_k: 40, seed: 7, frequency_penalty: 0.5, presence_penalty: -0.5 });
    const zeroRow = await env.DB.prepare('SELECT top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes WHERE scope = ? AND scope_id = ?')
      .bind('guild', 'g1')
      .first();
    expect(zeroRow).toEqual({ top_p: 0, top_k: 1, seed: 0, frequency_penalty: 0, presence_penalty: 0 });
    const silentRow = await env.DB.prepare('SELECT top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes WHERE scope = ? AND scope_id = ?')
      .bind('global', '')
      .first();
    expect(silentRow).toEqual({ top_p: null, top_k: null, seed: null, frequency_penalty: null, presence_penalty: null });
  });

  it('三层各存各的采样：一层设了不会串到另一层', async () => {
    const { app, cookie } = await setup();
    const primary = { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' };

    const channel = { scope: 'channel', scopeId: 'c1', primary, fallbacks: [], topP: 0.1 };
    const guild = { scope: 'guild', scopeId: 'g1', primary, fallbacks: [], seed: 42 };
    const global = { scope: 'global', scopeId: '', primary, fallbacks: [], topK: 5 };
    for (const body of [channel, guild, global]) {
      const res = await send(app, 'PUT', '/api/routes', body, cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(body);
    }

    // 顺序按 scope 排序：channel < global < guild
    expect(await itemsOf(app, '/api/routes', cookie)).toEqual([channel, global, guild]);

    // 只改一层：另外两层的采样原样保留
    const again = await send(app, 'PUT', '/api/routes', { ...guild, seed: 43, presencePenalty: 1 }, cookie);
    expect(again.status).toBe(200);
    expect(await itemsOf(app, '/api/routes', cookie)).toEqual([channel, global, { ...guild, seed: 43, presencePenalty: 1 }]);
  });

  it('PUT → GET → DELETE 往返', async () => {
    const { app, cookie } = await setup();

    const cfg = {
      scope: 'channel',
      scopeId: 'c1',
      primary: { provider: 'openai-compat', model: 'gpt-4o-mini' },
      fallbacks: [
        { provider: 'anthropic', model: 'claude-3-5-haiku' },
        { provider: 'gemini', model: 'gemini-2.0-flash' },
      ],
      temperature: 0.5,
      maxTokens: 900,
    };
    const put = await send(app, 'PUT', '/api/routes', cfg, cookie);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(cfg);
    expect(await itemsOf(app, '/api/routes', cookie)).toEqual([cfg]);

    const globalCfg = { scope: 'global', scopeId: '', primary: { provider: 'gemini', model: 'gemini-2.0-flash' }, fallbacks: [] };
    const global = await send(app, 'PUT', '/api/routes', { scope: 'global', primary: { provider: 'gemini', model: 'gemini-2.0-flash' } }, cookie);
    expect(global.status).toBe(200);
    expect(await global.json()).toEqual(globalCfg);

    const del = await send(app, 'DELETE', '/api/routes', { scope: 'channel', scopeId: 'c1' }, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(await itemsOf(app, '/api/routes', cookie)).toHaveLength(1);
  });

  it("provider 非法（如 'gpt-4'）→ 400 BAD_PROVIDER；缺 primary → 400 BAD_REQUEST", async () => {
    const { app, cookie } = await setup();

    const badPrimary = await send(app, 'PUT', '/api/routes', { scope: 'global', primary: { provider: 'gpt-4', model: 'x' }, fallbacks: [] }, cookie);
    expect(badPrimary.status).toBe(400);
    expect(await badPrimary.json()).toEqual({ error: 'BAD_PROVIDER' });

    const badFallback = await send(
      app,
      'PUT',
      '/api/routes',
      { scope: 'global', primary: { provider: 'gemini', model: 'm' }, fallbacks: [{ provider: 'openai', model: 'm' }] },
      cookie,
    );
    expect(badFallback.status).toBe(400);
    expect(await badFallback.json()).toEqual({ error: 'BAD_PROVIDER' });

    const noPrimary = await send(app, 'PUT', '/api/routes', { scope: 'global', fallbacks: [] }, cookie);
    expect(noPrimary.status).toBe(400);
    expect(await noPrimary.json()).toEqual({ error: 'BAD_REQUEST' });

    const noModel = await send(app, 'PUT', '/api/routes', { scope: 'global', primary: { provider: 'gemini' } }, cookie);
    expect(noModel.status).toBe(400);
    expect(await noModel.json()).toEqual({ error: 'BAD_REQUEST' });

    expect(await itemsOf(app, '/api/routes', cookie)).toHaveLength(0);
  });
});

describe('admin keys', () => {
  it('POST 后 GET 只见 keyHint；响应全文不含明文；DELETE 生效', async () => {
    const { app, cookie } = await setup();
    const plain = 'sk-live-PLAINTEXT-abcd9876';

    const created = await send(app, 'POST', '/api/keys', { provider: 'openai-compat', label: '主力', baseUrl: 'https://api.deepseek.com/v1', apiKey: plain }, cookie);
    expect(created.status).toBe(201);
    const createdBody = await jsonOf(created);
    expect(createdBody.keyHint).toBe('…9876');
    expect(createdBody.provider).toBe('openai-compat');
    expect(createdBody.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(createdBody).not.toHaveProperty('apiKey');
    expect(createdBody).not.toHaveProperty('ciphertext');
    expect(JSON.stringify(createdBody).includes(plain)).toBe(false);
    // 缺省 models 当作 []（通用）
    expect(createdBody.models).toEqual([]);

    const list = await jsonOf(await get(app, '/api/keys', cookie));
    const items = list.items as Json[];
    expect(items).toHaveLength(1);
    expect(items[0]?.keyHint).toBe('…9876');
    expect(items[0]?.models).toEqual([]);
    expect(JSON.stringify(list).includes(plain)).toBe(false);
    expect(JSON.stringify(list)).not.toContain('ciphertext');

    // 库里落的是 v1. 密文，不是明文
    const row = await env.DB.prepare('SELECT ciphertext FROM provider_keys').first<{ ciphertext: string }>();
    expect(row?.ciphertext.startsWith('v1.')).toBe(true);
    expect(row?.ciphertext.includes(plain)).toBe(false);

    const badProvider = await send(app, 'POST', '/api/keys', { provider: 'gpt-4', label: 'x', apiKey: 'sk-1' }, cookie);
    expect(badProvider.status).toBe(400);
    expect(await badProvider.json()).toEqual({ error: 'BAD_PROVIDER' });

    const missingKey = await send(app, 'POST', '/api/keys', { provider: 'gemini', label: 'x' }, cookie);
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({ error: 'BAD_REQUEST' });

    const id = String(createdBody.id);
    const del = await send(app, 'DELETE', '/api/keys/' + id, undefined, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(await itemsOf(app, '/api/keys', cookie)).toHaveLength(0);
  });

  it('POST /api/keys/:id/test：无 probe 501；probe 抛错 502；成功 200 模型列表', async () => {
    const offline = await setup();
    const created = await jsonOf(await send(offline.app, 'POST', '/api/keys', { provider: 'openai-compat', label: 'k', apiKey: 'sk-test-1234' }, offline.cookie));
    const unavailable = await send(offline.app, 'POST', '/api/keys/' + String(created.id) + '/test', undefined, offline.cookie);
    expect(unavailable.status).toBe(501);
    expect(await unavailable.json()).toEqual({ ok: false, error: 'PROBE_UNAVAILABLE' });

    const failing = await setup({
      probeKey: async () => {
        throw new Error('provider HTTP 500: boom');
      },
    });
    const broken = await jsonOf(await send(failing.app, 'POST', '/api/keys', { provider: 'anthropic', label: 'k2', apiKey: 'sk-ant-5678' }, failing.cookie));
    const failed = await send(failing.app, 'POST', '/api/keys/' + String(broken.id) + '/test', undefined, failing.cookie);
    expect(failed.status).toBe(502);
    const failedBody = (await failed.json()) as { ok: boolean; error: string };
    expect(failedBody.ok).toBe(false);
    expect(failedBody.error).toContain('boom');

    // probe 拿到的必须是解密后的明文与 provider/baseUrl
    const seen: Array<{ provider: string; apiKey: string; baseUrl?: string }> = [];
    const healthy = await setup({
      probeKey: async (input) => {
        seen.push(input);
        return ['gemini-2.0-flash'];
      },
    });
    const ok = await jsonOf(
      await send(
        healthy.app,
        'POST',
        '/api/keys',
        { provider: 'gemini', label: 'k3', baseUrl: 'https://proxy.local/v1beta', apiKey: 'sk-gem-9012', models: ['gemini-2.0-flash'] },
        healthy.cookie,
      ),
    );
    const good = await send(healthy.app, 'POST', '/api/keys/' + String(ok.id) + '/test', undefined, healthy.cookie);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, models: ['gemini-2.0-flash'] });
    expect(seen).toEqual([{ provider: 'gemini', apiKey: 'sk-gem-9012', baseUrl: 'https://proxy.local/v1beta' }]);

    const unknownId = await send(healthy.app, 'POST', '/api/keys/does-not-exist/test', undefined, healthy.cookie);
    expect(unknownId.status).toBe(404);
    expect(await unknownId.json()).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('POST 带 models：保留原始大小写、小写去重，GET 原样返回，响应不含密钥', async () => {
    const { app, cookie } = await setup();
    const plain = 'sk-live-MODELS-4321';

    const created = await send(
      app,
      'POST',
      '/api/keys',
      {
        provider: 'openai-compat',
        label: 'DeepSeek',
        apiKey: plain,
        models: ['DeepSeek-Chat', 'deepseek-chat', 'deepseek-*', 'gpt-4o-mini'],
      },
      cookie,
    );
    expect(created.status).toBe(201);
    const body = await jsonOf(created);
    // keyDto 白名单：models 进得去，apiKey / ciphertext 进不来
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'enabled', 'id', 'keyHint', 'label', 'models', 'provider']);
    expect(body.models).toEqual(['DeepSeek-Chat', 'deepseek-*', 'gpt-4o-mini']);
    expect(JSON.stringify(body).includes(plain)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('ciphertext');

    const items = await itemsOf(app, '/api/keys', cookie);
    expect(items).toHaveLength(1);
    expect(items[0]?.models).toEqual(['DeepSeek-Chat', 'deepseek-*', 'gpt-4o-mini']);
    expect(JSON.stringify(items).includes(plain)).toBe(false);
    expect(JSON.stringify(items)).not.toContain('ciphertext');

    // 库里是逗号分隔原文
    const row = await env.DB.prepare('SELECT models FROM provider_keys').first<{ models: string }>();
    expect(row?.models).toBe('DeepSeek-Chat,deepseek-*,gpt-4o-mini');
  });

  it('非法 models 一律 400 BAD_MODELS（逐项举例），边界合法值放行', async () => {
    const { app, cookie } = await setup();
    const base = { provider: 'openai-compat', label: 'k', apiKey: 'sk-bad-0001' };

    const cases: Array<{ name: string; models: unknown }> = [
      { name: '超过 20 项', models: Array.from({ length: 21 }, (_, i) => 'm' + i) },
      { name: '空串项', models: [''] },
      { name: '超过 64 字符', models: ['a'.repeat(65)] },
      { name: '含空格', models: ['deepseek chat'] },
      { name: '含逗号', models: ['a,b'] },
      { name: '含斜杠', models: ['openai/gpt-4o'] },
      { name: '不是数组', models: 'deepseek-*' },
      { name: '含非字符串项', models: ['ok-model', 42] },
    ];

    for (const item of cases) {
      const res = await send(app, 'POST', '/api/keys', { ...base, models: item.models }, cookie);
      expect(res.status, item.name).toBe(400);
      expect(await res.json(), item.name).toEqual({ error: 'BAD_MODELS' });
    }

    // 非法请求一条都没落库
    expect(await itemsOf(app, '/api/keys', cookie)).toHaveLength(0);

    // 边界合法：正好 20 项、末项 64 字符
    const edge = [...Array.from({ length: 19 }, (_, i) => 'm' + i), 'a'.repeat(64)];
    const ok = await send(app, 'POST', '/api/keys', { ...base, models: edge }, cookie);
    expect(ok.status).toBe(201);
    expect((await jsonOf(ok)).models).toHaveLength(20);

    // 中文模型名合法：中继的「假流式-」别名要能写进名单，库里仍按逗号分隔原文
    const zh = await send(app, 'POST', '/api/keys', { ...base, label: 'zh', models: ['假流式-pg-gemini-4-argon'] }, cookie);
    expect(zh.status).toBe(201);
    expect((await jsonOf(zh)).models).toEqual(['假流式-pg-gemini-4-argon']);
    const zhRow = await env.DB.prepare("SELECT models FROM provider_keys WHERE label = 'zh'").first<{ models: string }>();
    expect(zhRow?.models).toBe('假流式-pg-gemini-4-argon');
  });
});

describe('admin conversations', () => {
  it('按 guildId+channelId 取记录；缺参数 400', async () => {
    const { app, cookie } = await setup();
    const repos = createRepositories(env.DB, createSecretBox(MASTER_KEY));
    await repos.conversations.append({ guildId: 'g1', channelId: 'c1' }, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
    await repos.conversations.append({ guildId: 'g1', channelId: 'c2' }, [{ role: 'user', content: '别人家的' }]);

    const res = await get(app, '/api/conversations?guildId=g1&channelId=c1&limit=10', cookie);
    expect(res.status).toBe(200);
    const items = (await jsonOf(res)).items as Array<{ role: string; content: string }>;
    expect(items.map((item) => [item.role, item.content])).toEqual([
      ['user', 'q1'],
      ['assistant', 'a1'],
    ]);

    const missingChannel = await get(app, '/api/conversations?guildId=g1', cookie);
    expect(missingChannel.status).toBe(400);
    expect(await missingChannel.json()).toEqual({ error: 'BAD_REQUEST' });

    // limit 非法时退默认值而不是 500
    const oddLimit = await get(app, '/api/conversations?guildId=g1&channelId=c1&limit=abc', cookie);
    expect(oddLimit.status).toBe(200);
    expect((await jsonOf(oddLimit)).items as unknown[]).toHaveLength(2);
  });
});

describe('admin emojis', () => {
  it('两条路由都在 ALL /api/* 鉴权之内：未登录 401', async () => {
    const app = makeApp();

    const anonGet = await app.request('/api/emojis?guildId=g1');
    expect(anonGet.status).toBe(401);
    expect(await anonGet.json()).toEqual({ error: 'UNAUTHORIZED' });

    const anonDescribe = await send(app, 'POST', '/api/emojis/describe', { guildId: 'g1' });
    expect(anonDescribe.status).toBe(401);
    expect(await anonDescribe.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('GET /api/emojis：缺 / 空 guildId 400 BAD_GUILD_ID，正常回 { items: [] }', async () => {
    const { app, cookie } = await setup();

    for (const path of ['/api/emojis', '/api/emojis?guildId=', '/api/emojis?guildId=%20']) {
      const res = await get(app, path, cookie);
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual({ error: 'BAD_GUILD_ID' });
    }

    const ok = await get(app, '/api/emojis?guildId=g1', cookie);
    expect(ok.status).toBe(200);
    expect(await jsonOf(ok)).toEqual({ items: [] });

    // 路由确实接到了 emojiDescriptions 仓储（不是写死空数组），并且只回本 guild 的行
    const repos = createRepositories(env.DB, createSecretBox(MASTER_KEY));
    await repos.emojiDescriptions.putMany('g1', [{ emojiId: '111', name: 'laugh', description: '黄胖小子咧嘴大笑' }]);
    await repos.emojiDescriptions.putMany('g2', [{ emojiId: '222', name: 'cry', description: '别人家的' }]);

    const items = await itemsOf(app, '/api/emojis?guildId=g1', cookie);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      emojiId: '111',
      name: 'laugh',
      description: '黄胖小子咧嘴大笑',
      updatedAt: expect.any(String),
    });
  });

  it('POST /api/emojis/describe：guildId 缺失或空 400 BAD_GUILD_ID，且一次都不调认图', async () => {
    let calls = 0;
    const { app, cookie } = await setup({
      describeEmojis: async () => {
        calls += 1;
        return { described: 0, failed: 0 };
      },
    });

    for (const body of [{}, { guildId: '' }, { guildId: '  ' }, { guildId: 42 }]) {
      const res = await send(app, 'POST', '/api/emojis/describe', body, cookie);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json(), JSON.stringify(body)).toEqual({ error: 'BAD_GUILD_ID' });
    }

    const brokenJson = await app.request('/api/emojis/describe', { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{not json' });
    expect(brokenJson.status).toBe(400);
    expect(await brokenJson.json()).toEqual({ error: 'BAD_GUILD_ID' });

    expect(calls).toBe(0);
  });

  it('POST /api/emojis/describe：未注入 describeEmojis → 501 DESCRIBE_UNAVAILABLE', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'POST', '/api/emojis/describe', { guildId: 'g1' }, cookie);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'DESCRIBE_UNAVAILABLE' });
  });

  it('POST /api/emojis/describe：注入实现后回 { described, failed }，实现被调用一次并收到 guildId/force', async () => {
    const calls: Array<{ guildId: string; options?: { force?: boolean } }> = [];
    const { app, cookie } = await setup({
      describeEmojis: async (guildId, options) => {
        calls.push(options === undefined ? { guildId } : { guildId, options });
        return { described: 4, failed: 1 };
      },
    });

    const res = await send(app, 'POST', '/api/emojis/describe', { guildId: 'g1', force: true }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ described: 4, failed: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ guildId: 'g1', options: { force: true } });
  });

  it('force 只认严格的 true：缺省、字符串 "true"、数字 1 都按「只补缺的」传递', async () => {
    const calls: Array<{ guildId: string; options?: { force?: boolean } }> = [];
    const { app, cookie } = await setup({
      describeEmojis: async (guildId, options) => {
        calls.push(options === undefined ? { guildId } : { guildId, options });
        return { described: 0, failed: 0 };
      },
    });

    for (const force of [undefined, 'true', 1]) {
      const res = await send(app, 'POST', '/api/emojis/describe', { guildId: 'g1', force }, cookie);
      expect(res.status, String(force)).toBe(200);
    }

    expect(calls).toEqual([{ guildId: 'g1' }, { guildId: 'g1' }, { guildId: 'g1' }]);
  });
});

describe('admin emoji aliases', () => {
  const LAUGH = '150000000000000003';
  const CRY = '150000000000000004';
  const ALIAS = '奶龙';

  function aliasQuery(alias: string): string {
    return encodeURIComponent(alias);
  }

  it('四条路由都在 ALL /api/* 鉴权之内：未登录 401', async () => {
    const app = makeApp();
    const cases: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/emojis/live?guildId=g1' },
      { method: 'GET', path: '/api/emoji-aliases?guildId=g1' },
      { method: 'PUT', path: '/api/emoji-aliases', body: { guildId: 'g1', alias: ALIAS, emojiId: LAUGH, emojiName: 'laugh' } },
      { method: 'DELETE', path: '/api/emoji-aliases?guildId=g1&alias=' + aliasQuery(ALIAS) },
    ];

    for (const item of cases) {
      const res = await send(app, item.method, item.path, item.body);
      expect(res.status, item.method + ' ' + item.path).toBe(401);
      expect(await res.json(), item.method + ' ' + item.path).toEqual({ error: 'UNAUTHORIZED' });
    }
  });

  it('GET /api/emojis/live：缺 / 空 guildId 400 BAD_GUILD_ID，一次都不调 listEmojis', async () => {
    let calls = 0;
    const { app, cookie } = await setup({
      listEmojis: async () => {
        calls += 1;
        return [];
      },
    });

    for (const path of ['/api/emojis/live', '/api/emojis/live?guildId=', '/api/emojis/live?guildId=%20']) {
      const res = await get(app, path, cookie);
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual({ error: 'BAD_GUILD_ID' });
    }

    expect(calls).toBe(0);
  });

  it('GET /api/emojis/live：未注入 listEmojis → 501 EMOJI_LIST_UNAVAILABLE', async () => {
    const { app, cookie } = await setup();

    const res = await get(app, '/api/emojis/live?guildId=g1', cookie);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'EMOJI_LIST_UNAVAILABLE' });
  });

  it('GET /api/emojis/live：listEmojis 抛错 → 502 EMOJI_LIST_FAILED', async () => {
    const { app, cookie } = await setup({
      listEmojis: async () => {
        throw new Error('discord GET /guilds/g1/emojis 500');
      },
    });

    const res = await get(app, '/api/emojis/live?guildId=g1', cookie);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'EMOJI_LIST_FAILED' });
  });

  it('GET /api/emojis/live：正常 200，按 name 升序，只带 id/name/animated（不是认图清单那条）', async () => {
    const seen: string[] = [];
    const { app, cookie } = await setup({
      listEmojis: async (guildId) => {
        seen.push(guildId);
        return [
          // 故意乱序传入，并且多带描述/别名：排序与裁剪都由路由负责
          { name: 'laugh', id: LAUGH, animated: true, description: '黄胖小子咧嘴大笑', aliases: [ALIAS] },
          { name: 'cry', id: CRY },
        ];
      },
    });

    const res = await get(app, '/api/emojis/live?guildId=g1', cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      items: [
        { id: CRY, name: 'cry', animated: false },
        { id: LAUGH, name: 'laugh', animated: true },
      ],
    });
    expect(seen).toEqual(['g1']);
  });

  it('GET /api/emoji-aliases：缺 / 空 guildId 400 BAD_GUILD_ID；空表回 { items: [] }', async () => {
    const { app, cookie } = await setup();

    for (const path of ['/api/emoji-aliases', '/api/emoji-aliases?guildId=', '/api/emoji-aliases?guildId=%20']) {
      const res = await get(app, path, cookie);
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual({ error: 'BAD_GUILD_ID' });
    }

    expect(await jsonOf(await get(app, '/api/emoji-aliases?guildId=g1', cookie))).toEqual({ items: [] });
  });

  it('PUT → GET 往返：200 回保存后的别名；同别名重复 PUT 只换指向；一个表情可配多个别名', async () => {
    const { app, cookie } = await setup();

    // 首尾空白由服务端 trim 掉，回给前端的也是 trim 后的那一份
    const put = await send(app, 'PUT', '/api/emoji-aliases', { guildId: 'g1', alias: '  ' + ALIAS + ' ', emojiId: LAUGH, emojiName: ' laugh ' }, cookie);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ alias: ALIAS, emojiId: LAUGH, emojiName: 'laugh' });
    expect(await itemsOf(app, '/api/emoji-aliases?guildId=g1', cookie)).toEqual([
      { alias: ALIAS, emojiId: LAUGH, emojiName: 'laugh' },
    ]);

    const again = await send(app, 'PUT', '/api/emoji-aliases', { guildId: 'g1', alias: ALIAS, emojiId: CRY, emojiName: 'cry' }, cookie);
    expect(again.status).toBe(200);
    expect(await itemsOf(app, '/api/emoji-aliases?guildId=g1', cookie)).toEqual([{ alias: ALIAS, emojiId: CRY, emojiName: 'cry' }]);

    await send(app, 'PUT', '/api/emoji-aliases', { guildId: 'g1', alias: '小黄龙', emojiId: CRY, emojiName: 'cry' }, cookie);
    expect((await itemsOf(app, '/api/emoji-aliases?guildId=g1', cookie)).map((item) => item.alias).sort()).toEqual([ALIAS, '小黄龙'].sort());
  });

  it('PUT 校验：BAD_GUILD_ID / BAD_ALIAS / BAD_EMOJI 逐条举例，被拒的请求一条都不落库', async () => {
    const { app, cookie } = await setup();
    const good = { guildId: 'g1', alias: ALIAS, emojiId: LAUGH, emojiName: 'laugh' };

    for (const body of [{ ...good, guildId: undefined }, { ...good, guildId: '' }, { ...good, guildId: '  ' }, { ...good, guildId: 42 }]) {
      const res = await send(app, 'PUT', '/api/emoji-aliases', body, cookie);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json(), JSON.stringify(body)).toEqual({ error: 'BAD_GUILD_ID' });
    }

    // body 坏掉与缺 guildId 同一个出口
    const brokenJson = await app.request('/api/emoji-aliases', { method: 'PUT', headers: { ...JSON_HEADERS, cookie }, body: '{not json' });
    expect(brokenJson.status).toBe(400);
    expect(await brokenJson.json()).toEqual({ error: 'BAD_GUILD_ID' });

    // trim 之后长度 1–24，且不得含冒号 / 空白 / 尖括号
    for (const alias of [undefined, '', '   ', 'a:b', '奶 龙', '有<尖>括号', 'x'.repeat(25)]) {
      const res = await send(app, 'PUT', '/api/emoji-aliases', { ...good, alias }, cookie);
      expect(res.status, String(alias)).toBe(400);
      expect(await res.json(), String(alias)).toEqual({ error: 'BAD_ALIAS' });
    }

    // emojiId 纯数字且 ≥15 位；emojiName 匹配 /^[A-Za-z0-9_~]{2,32}$/
    const badEmoji: Array<Record<string, unknown>> = [
      { emojiId: '123', emojiName: 'laugh' },
      { emojiId: '150000000000000003x', emojiName: 'laugh' },
      { emojiId: undefined, emojiName: 'laugh' },
      { emojiId: LAUGH, emojiName: 'a' },
      { emojiId: LAUGH, emojiName: 'la ugh' },
      { emojiId: LAUGH, emojiName: 'la-ugh' },
      { emojiId: LAUGH, emojiName: '奶龙' },
      { emojiId: LAUGH, emojiName: undefined },
    ];
    for (const patch of badEmoji) {
      const res = await send(app, 'PUT', '/api/emoji-aliases', { ...good, ...patch }, cookie);
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(await res.json(), JSON.stringify(patch)).toEqual({ error: 'BAD_EMOJI' });
    }

    expect(await itemsOf(app, '/api/emoji-aliases?guildId=g1', cookie)).toHaveLength(0);

    // 边界合法：别名正好 24 字、表情名正好 32 字
    const edge = await send(
      app,
      'PUT',
      '/api/emoji-aliases',
      { guildId: 'g1', alias: 'a'.repeat(24), emojiId: LAUGH, emojiName: 'b'.repeat(32) },
      cookie,
    );
    expect(edge.status).toBe(200);
  });

  it('DELETE /api/emoji-aliases：400 BAD_GUILD_ID / BAD_ALIAS；删掉后清单为空；删不存在的也 200', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/emoji-aliases', { guildId: 'g1', alias: ALIAS, emojiId: LAUGH, emojiName: 'laugh' }, cookie);

    for (const path of ['/api/emoji-aliases', '/api/emoji-aliases?guildId=', '/api/emoji-aliases?alias=' + aliasQuery(ALIAS)]) {
      const res = await send(app, 'DELETE', path, undefined, cookie);
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual({ error: 'BAD_GUILD_ID' });
    }

    for (const alias of ['', '%20', 'a%3Ab', 'x'.repeat(25)]) {
      const res = await send(app, 'DELETE', '/api/emoji-aliases?guildId=g1&alias=' + alias, undefined, cookie);
      expect(res.status, alias).toBe(400);
      expect(await res.json(), alias).toEqual({ error: 'BAD_ALIAS' });
    }

    // 被拒的 DELETE 一个都没删掉
    expect(await itemsOf(app, '/api/emoji-aliases?guildId=g1', cookie)).toHaveLength(1);

    const del = await send(app, 'DELETE', '/api/emoji-aliases?guildId=g1&alias=' + aliasQuery(ALIAS), undefined, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(await itemsOf(app, '/api/emoji-aliases?guildId=g1', cookie)).toHaveLength(0);

    // 连点两下：第二次命中 0 行也算成功
    const missing = await send(app, 'DELETE', '/api/emoji-aliases?guildId=g1&alias=' + aliasQuery(ALIAS), undefined, cookie);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true });
  });
});

describe('admin prompt injections', () => {
  // updatedAt 由仓储自己取当前时钟（与 voiceSettings 一致），这里只钉「有值且是字符串」。
  async function savedAt(res: Response): Promise<string> {
    const body = await jsonOf(res);
    expect(typeof body.updatedAt).toBe('string');
    return body.updatedAt as string;
  }

  it('PUT → GET → DELETE 往返：一层一行、同 key 覆盖写、空正文允许', async () => {
    const { app, cookie } = await setup();

    const put = await send(app, 'PUT', '/api/prompt-injections', { scope: 'global', scopeId: '', content: '全局注入', depth: 0, role: 'system' }, cookie);
    expect(put.status).toBe(200);
    const firstAt = await savedAt(put);
    expect(firstAt).not.toBe('');

    await send(app, 'PUT', '/api/prompt-injections', { scope: 'channel', scopeId: 'c1', content: '频道注入', depth: 3, role: 'user' }, cookie);
    await send(app, 'PUT', '/api/prompt-injections', { scope: 'guild', scopeId: 'g1', content: '服务器注入', depth: 1, role: 'assistant' }, cookie);

    const listed = await itemsOf(app, '/api/prompt-injections', cookie);
    expect(listed.map((item) => [item.scope, item.scopeId, item.depth, item.role])).toEqual([
      ['channel', 'c1', 3, 'user'],
      ['global', '', 0, 'system'],
      ['guild', 'g1', 1, 'assistant'],
    ]);

    // 同 key 覆盖写：行数不变，内容/深度/角色/更新时间整行换掉
    const overwrite = await send(app, 'PUT', '/api/prompt-injections', { scope: 'global', scopeId: '', content: '改写后', depth: 5, role: 'user' }, cookie);
    expect(overwrite.status).toBe(200);
    const overwritten = await jsonOf(overwrite);
    expect(typeof overwritten.updatedAt).toBe('string');
    expect(overwritten).toMatchObject({
      scope: 'global',
      scopeId: '',
      content: '改写后',
      depth: 5,
      role: 'user',
    });
    expect(await itemsOf(app, '/api/prompt-injections', cookie)).toHaveLength(3);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM prompt_injections').first<{ n: number }>();
    expect(rows?.n).toBe(3);

    // 空正文是「关掉这一层」的合法写法
    const empty = await send(app, 'PUT', '/api/prompt-injections', { scope: 'global', scopeId: '', content: '', depth: 0, role: 'system' }, cookie);
    expect(empty.status).toBe(200);
    expect((await jsonOf(empty)).content).toBe('');

    const del = await send(app, 'DELETE', '/api/prompt-injections', { scope: 'guild', scopeId: 'g1' }, cookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(await itemsOf(app, '/api/prompt-injections', cookie)).toHaveLength(2);

    // 命中 0 行也算成功
    const again = await send(app, 'DELETE', '/api/prompt-injections', { scope: 'guild', scopeId: 'g1' }, cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
  });

  it('PUT 的四类 400：BAD_SCOPE / BAD_INJECTION_CONTENT / BAD_INJECTION_DEPTH / BAD_INJECTION_ROLE', async () => {
    const { app, cookie } = await setup();
    const base: Record<string, unknown> = { scope: 'global', scopeId: '', content: 'x', depth: 0, role: 'system' };

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, scope: 'team' }, 'BAD_SCOPE'],
      [{ ...base, scope: 'guild', scopeId: '' }, 'BAD_REQUEST'],
      [{ ...base, content: 123 }, 'BAD_INJECTION_CONTENT'],
      [{ ...base, content: 'x'.repeat(20001) }, 'BAD_INJECTION_CONTENT'],
      [{ ...base, content: undefined }, 'BAD_INJECTION_CONTENT'],
      [{ ...base, depth: -1 }, 'BAD_INJECTION_DEPTH'],
      [{ ...base, depth: 51 }, 'BAD_INJECTION_DEPTH'],
      [{ ...base, depth: 1.5 }, 'BAD_INJECTION_DEPTH'],
      [{ ...base, depth: '3' }, 'BAD_INJECTION_DEPTH'],
      [{ ...base, role: 'tool' }, 'BAD_INJECTION_ROLE'],
      [{ ...base, role: undefined }, 'BAD_INJECTION_ROLE'],
    ];
    for (const [body, code] of cases) {
      const res = await send(app, 'PUT', '/api/prompt-injections', body, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: code });
    }

    const broken = await app.request('/api/prompt-injections', { method: 'PUT', headers: { ...JSON_HEADERS, cookie }, body: '{not json' });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'BAD_REQUEST' });

    expect(await itemsOf(app, '/api/prompt-injections', cookie)).toHaveLength(0);
  });

  it('读侧容错：库里 depth 越界的旧行按 0 读出（role 由表 CHECK 保证三值之一）', async () => {
    const { app, cookie } = await setup();
    await env.DB.prepare('INSERT INTO prompt_injections (scope, scope_id, content, depth, role, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('channel', 'c9', '旧行', 99, 'assistant', '2026-01-01T00:00:00.000Z')
      .run();

    const listed = await itemsOf(app, '/api/prompt-injections', cookie);
    expect(listed).toEqual([
      { scope: 'channel', scopeId: 'c9', content: '旧行', depth: 0, role: 'assistant', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('未登录 401：GET / PUT / DELETE 都拦在登录之后', async () => {
    const { app } = await setup();
    expect((await get(app, '/api/prompt-injections', '')).status).toBe(401);
    const put = await send(app, 'PUT', '/api/prompt-injections', { scope: 'global', scopeId: '', content: 'x', depth: 0, role: 'system' });
    expect(put.status).toBe(401);
    const del = await send(app, 'DELETE', '/api/prompt-injections', { scope: 'global', scopeId: '' });
    expect(del.status).toBe(401);
  });
});

describe('admin route table', () => {
  it('注册的业务路由与 §11 表格一一对应', async () => {
    const { app } = await setup();
    const pairs = app.routes
      .filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/'))
      .map((route) => route.method + ' ' + route.path)
      .sort();

    const expected = [
      'GET /api/backup',
      'GET /api/body-emoji-guides',
      'GET /api/conversations',
      'GET /api/emoji-aliases',
      'GET /api/emojis',
      'GET /api/emojis/live',
      'GET /api/health',
      'GET /api/keys',
      'GET /api/logs',
      'GET /api/me',
      'GET /api/memory-settings',
      'GET /api/memory-settings/channel',
      'GET /api/pg-errors',
      'GET /api/prompt-defaults',
      'GET /api/prompt-injections',
      'GET /api/prompts',
      'GET /api/reaction-guides',
      'GET /api/reaction-model',
      'GET /api/reaction-templates',
      'GET /api/reply-settings',
      'GET /api/vision-settings',
      'GET /api/tts-settings',
      'GET /api/tts-style',
      'GET /api/voice-settings',
      'GET /api/world-book',
      'GET /api/world-book/entry',
      'GET /api/routes',
      'GET /api/summaries',
      'GET /api/summaries/messages',
      'GET /api/summaries/range',
      'GET /api/timeouts',
      'POST /api/backup/run',
      'POST /api/emojis/describe',
      'POST /api/keys',
      'POST /api/keys/:id/test',
      'POST /api/login',
      'POST /api/prompt-defaults/preview',
      'POST /api/prompts/copy',
      'POST /api/prompts/import',
      'POST /api/logout',
      'POST /api/summaries/backfill',
      'POST /api/summaries/regenerate',
      'POST /api/summaries/sweep',
      'POST /api/tts-settings/test',
      'POST /api/world-book/import',
      'PUT /api/body-emoji-guides',
      'PUT /api/emoji-aliases',
      'PUT /api/memory-settings',
      'PUT /api/prompt-defaults',
      'PUT /api/prompt-injections',
      'PUT /api/prompts',
      'PUT /api/reaction-guides',
      'PUT /api/reaction-model',
      'PUT /api/reaction-templates',
      'PUT /api/reply-settings',
      'PUT /api/vision-settings',
      'PUT /api/tts-settings',
      'PUT /api/tts-style',
      'PUT /api/voice-settings',
      'PUT /api/world-book/entry',
      'PUT /api/routes',
      'PUT /api/timeouts',
      'PUT /api/summaries',
      'DELETE /api/timeouts',
      'DELETE /api/body-emoji-guides',
      'DELETE /api/emoji-aliases',
      'DELETE /api/keys/:id',
      'DELETE /api/memory-settings',
      'DELETE /api/messages/:id',
      'DELETE /api/prompt-defaults',
      'DELETE /api/prompt-injections',
      'DELETE /api/prompts',
      'DELETE /api/reaction-guides',
      'DELETE /api/reaction-templates',
      'DELETE /api/reply-settings',
      'DELETE /api/vision-settings',
      'DELETE /api/tts-settings',
      'DELETE /api/tts-style',
      'DELETE /api/voice-settings',
      'DELETE /api/world-book',
      'DELETE /api/routes',
      'DELETE /api/summaries',
    ].sort();

    expect(pairs).toEqual(expected);
  });
});
