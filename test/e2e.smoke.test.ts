/**
 * M6 端到端冒烟：从真实 Worker 入口（src/workers/index.ts）打穿登录 -> 配路由 -> 存密钥 ->
 * Discord 验签交互 -> 供应商出网 -> 回填结果 -> D1 落库 -> 记忆接线。
 *
 * 出网拦截说明：契约 §14/任务书写的是 cloudflare:test 的 fetchMock，但当前安装的
 * @cloudflare/vitest-pool-workers@0.23.0（已改名 @cloudflare/vitest-plugin）并不导出 fetchMock，
 * 因此改为替换 globalThis.fetch —— index.ts 里的 runtimeFetch 在调用时才读全局 fetch，
 * M5 的 chat 服务与 M3 的 REST 客户端也都是调用时取全局 fetch，所以这里能真实拦到。
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/workers/index';
import { ed25519Crypto } from '../src/workers/discord/verify';

const APP_ID = 'app-e2e';
const BOT_TOKEN = 'bot-token-e2e';
const ADMIN_PASSWORD = 'e2e-admin-password';
const SESSION_SECRET = 'e2e-session-secret';
const TIMESTAMP = '1735689600';
const OPENAI_BASE = 'https://openai.test/v1';
const API_KEY = 'sk-e2e-plaintext-1234';
const MODEL = 'mock-model';
const MOCK_REPLY = '你好，世界';
/** 服务器频道里每条回复开头的 @ 提问者：chatPayload 的 member.user.id */
const ASKER_MENTION = '<@user-1> ';
const GUILD_ID = 'guild-e2e';
const CHANNEL_ID = 'channel-e2e';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** createSecretBox 要求 32 字节的 base64 */
function masterKeyB64(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) % 256;
  return btoa(String.fromCharCode(...bytes));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(text: string): Response {
  const mid = Math.ceil(text.length / 2);
  const deltas = [text.slice(0, mid), text.slice(mid)];
  const payload =
    deltas
      .map((delta) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: delta } }] }) + '\n\n')
      .join('') +
    // 真实中继的收尾帧：正文为空、finish_reason 有值、带 usage，之后才是 [DONE]
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 4 } }) + '\n\n' +
    'data: [DONE]\n\n';
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface OutboundCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface MockUpstream {
  calls: OutboundCall[];
  impl: typeof fetch;
}

/** §24.6：上游 /guilds/{id}/emojis 的回包，用例按需改写（含故意失败），beforeEach 复位成空清单 */
let emojiListHandler: () => Response = (): Response => jsonResponse([]);

function createMockUpstream(): MockUpstream {
  const calls: OutboundCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });

    if (url.endsWith('/chat/completions')) return sseResponse(MOCK_REPLY);
    if (url.includes('/messages/@original')) return jsonResponse({ id: 'discord-message-1' });
    if (url.includes('/guilds/') && url.endsWith('/emojis')) return emojiListHandler();
    return jsonResponse({ error: 'UNEXPECTED_UPSTREAM' }, 404);
  };
  return { calls, impl: impl as typeof fetch };
}

/**
 * 只换「模型正文」的包装：/chat/completions 的响应换成 text，其余请求原样转给既有 mock，
 * 这样 upstream.calls 的记账语义（URL / 头 / body）与其它用例完全一致。
 */
function withReplyText(text: string): typeof fetch {
  const base = upstream.impl;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = await base(input, init);
    return url.endsWith('/chat/completions') ? sseResponse(text) : response;
  };
  return impl as typeof fetch;
}

interface TestContext {
  ctx: ExecutionContext;
  pending: Promise<unknown>[];
}

function createExecutionContext(): TestContext {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    DB: env.DB,
    ASSETS: {
      fetch: async () => jsonResponse({ error: 'NOT_FOUND' }, 404),
    } as unknown as Fetcher,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APPLICATION_ID: APP_ID,
    ADMIN_PASSWORD,
    SESSION_SECRET,
    KEY_ENCRYPTION_SECRET: masterKeyB64(),
  };
  return { ...base, ...overrides };
}

let publicKeyHex = '';
let privateKey: CryptoKey | null = null;
let upstream: MockUpstream;
const originalFetch = globalThis.fetch;

async function sign(timestamp: string, body: string): Promise<string> {
  if (privateKey === null) throw new Error('key pair not ready');
  return toHex(await ed25519Crypto.sign(privateKey, new TextEncoder().encode(timestamp + body)));
}

async function interactionRequest(payload: unknown): Promise<Request> {
  const raw = JSON.stringify(payload);
  return new Request('https://bot.test/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': await sign(TIMESTAMP, raw),
      'x-signature-timestamp': TIMESTAMP,
    },
    body: raw,
  });
}

function chatPayload(prompt: string, token: string): Record<string, unknown> {
  return {
    id: 'interaction-' + token,
    application_id: APP_ID,
    type: 2,
    token,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: { user: { id: 'user-1', username: 'alice', global_name: 'Alice' } },
    data: { name: 'chat', options: [{ name: 'prompt', type: 3, value: prompt }] },
  };
}

async function send(payload: unknown, testEnv: Env): Promise<{ response: Response; pending: Promise<unknown>[] }> {
  const { ctx, pending } = createExecutionContext();
  const response = await worker.fetch(await interactionRequest(payload), testEnv, ctx);
  return { response, pending };
}

async function login(testEnv: Env): Promise<string> {
  const response = await worker.fetch(
    new Request('https://bot.test/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    }),
    testEnv,
    createExecutionContext().ctx,
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  expect(cookie.startsWith('admin_session=')).toBe(true);
  return cookie;
}

async function callApi(
  testEnv: Env,
  path: string,
  init: { method: string; body?: unknown; cookie?: string },
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  return worker.fetch(
    new Request('https://bot.test' + path, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    testEnv,
    createExecutionContext().ctx,
  );
}

async function configure(testEnv: Env): Promise<string> {
  const cookie = await login(testEnv);

  const route = await callApi(testEnv, '/api/routes', {
    method: 'PUT',
    cookie,
    body: { scope: 'global', primary: { provider: 'openai-compat', model: MODEL }, fallbacks: [] },
  });
  expect(route.status).toBe(200);

  const key = await callApi(testEnv, '/api/keys', {
    method: 'POST',
    cookie,
    body: { provider: 'openai-compat', label: 'e2e', apiKey: API_KEY, baseUrl: OPENAI_BASE },
  });
  expect(key.status).toBe(201);

  return cookie;
}

function chatCalls(): OutboundCall[] {
  return upstream.calls.filter((call) => call.url.endsWith('/chat/completions'));
}

function patchCalls(): OutboundCall[] {
  return upstream.calls.filter((call) => call.url.includes('/messages/@original'));
}

function bodyOf(call: OutboundCall): Record<string, unknown> {
  return JSON.parse(call.body ?? '{}') as Record<string, unknown>;
}

function messagesOf(call: OutboundCall): Array<{ role: string; content: string }> {
  const messages = bodyOf(call)['messages'];
  return Array.isArray(messages) ? (messages as Array<{ role: string; content: string }>) : [];
}

interface MessageRow {
  role: string;
  content: string;
}

async function readMessages(): Promise<MessageRow[]> {
  const result = await env.DB.prepare('SELECT role, content FROM messages ORDER BY id ASC').all<MessageRow>();
  return result.results;
}

beforeEach(async () => {
  const pair = await ed25519Crypto.generateKey();
  publicKeyHex = toHex(await ed25519Crypto.exportRawPublicKey(pair.publicKey));
  privateKey = pair.privateKey;

  upstream = createMockUpstream();
  globalThis.fetch = upstream.impl;

  await env.DB.prepare('DELETE FROM messages').run();
  await env.DB.prepare('DELETE FROM routes').run();
  await env.DB.prepare('DELETE FROM prompts').run();
  await env.DB.prepare('DELETE FROM prompt_segments').run();
  await env.DB.prepare('DELETE FROM provider_keys').run();
  // 摘要也要清：否则残留摘要会让「system 里不该有长期记忆摘要」的断言失去前提
  await env.DB.prepare('DELETE FROM conversation_summaries').run();
  // 运行日志（§19）同样要清：它是跨请求共享的环形表，残留行会让游标断言拿到上一轮的数据
  await env.DB.prepare('DELETE FROM runtime_logs').run();
  // 表情模型的单行表（§21）也要清：否则上一轮 PUT 的配置会让「默认配置」断言失去前提
  await env.DB.prepare('DELETE FROM reaction_model').run();
  // 表情描述表（§23）同理：残留行会让「空清单」断言拿到上一轮认图的结果
  await env.DB.prepare('DELETE FROM emoji_descriptions').run();
  // 别名表（§24）同理：残留别名会让「先空后满」的断言拿到上一轮 PUT 的行
  await env.DB.prepare('DELETE FROM emoji_aliases').run();
  emojiListHandler = () => jsonResponse([]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('M6 端到端冒烟', () => {
  it('一条完整链路：登录/配路由/存密钥 -> Discord 验签 -> 供应商 -> 回填 -> D1 -> 记忆', async () => {
    const testEnv = buildEnv();
    await configure(testEnv);

    const first = await send(chatPayload('第一问', 'token-1'), testEnv);
    expect(first.response.status).toBe(200);
    const ack = (await first.response.json()) as { type: number };
    expect(ack.type).toBe(5);

    await Promise.all(first.pending);

    // 供应商出网：URL / 头 / body
    const chat = chatCalls();
    expect(chat).toHaveLength(1);
    const firstChat = chat[0] as OutboundCall;
    expect(firstChat.url).toBe(OPENAI_BASE + '/chat/completions');
    expect(firstChat.method).toBe('POST');
    expect(firstChat.headers['authorization']).toBe('Bearer ' + API_KEY);
    expect(firstChat.headers['content-type']).toContain('application/json');

    const requestBody = bodyOf(firstChat);
    expect(requestBody['model']).toBe(MODEL);
    expect(requestBody['stream']).toBe(true);
    const firstMessages = messagesOf(firstChat);
    expect(firstMessages[0]?.role).toBe('system');
    // 当前这一轮的 user 消息也署名（Discord 显示名 member.nick → global_name → username）
    const STAMP_PATTERN = /^\[\d\d-\d\d \d\d:\d\d\] /;
    expect(firstMessages[firstMessages.length - 1]?.content).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] Alice\(user-1\)：第一问$/);

    // 回填：PATCH .../messages/@original 带最终全文
    const patches = patchCalls();
    expect(patches.length).toBeGreaterThanOrEqual(1);
    const lastPatch = patches[patches.length - 1] as OutboundCall;
    expect(lastPatch.method).toBe('PATCH');
    expect(lastPatch.url).toBe(
      'https://discord.com/api/v10/webhooks/' + APP_ID + '/token-1/messages/@original',
    );
    expect(lastPatch.headers['authorization']).toBe('Bot ' + BOT_TOKEN);
    expect(bodyOf(lastPatch)['content']).toBe(ASKER_MENTION + MOCK_REPLY);

    // D1 落库：user + assistant 两条
    const rows = await readMessages();
    expect(rows).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: MOCK_REPLY },
    ]);

    // 第二轮：历史被注入到出网请求里
    const second = await send(chatPayload('第二问', 'token-2'), testEnv);
    expect(second.response.status).toBe(200);
    await Promise.all(second.pending);

    // 每条消息只调 1 次模型：两轮共 2 次，且都是流式
    const allCalls = chatCalls();
    expect(allCalls).toHaveLength(2);
    for (const call of allCalls) expect(bodyOf(call)['stream']).toBe(true);

    // 全量历史直接注入：system 之后 = 第一问 / 回复 / 第二问，且没有摘要块
    // 摘要阈值 50 条未总结消息（summaryEveryMessages 50），2 轮共 4 条远不足以触发，
    // 因此库中不会有摘要，system 里也就不得凭空出现【长期记忆摘要】段。
    const secondMessages = messagesOf(allCalls[1] as OutboundCall);
    expect(secondMessages[0]?.role).toBe('system');
    expect(secondMessages[0]?.content ?? '').not.toContain('长期记忆摘要');
    expect(messagesOf(allCalls[0] as OutboundCall)[0]?.content ?? '').not.toContain('长期记忆摘要');
    // 每行都带落库时刻的戳（真人时钟，只能钉形状），署名与正文逐字比对
    const history = secondMessages.slice(1);
    expect(history).toHaveLength(3);
    for (const message of history) expect(message.content).toMatch(STAMP_PATTERN);
    expect(history[0]?.content).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] Alice\(user-1\)：第一问$/);
    expect(history[1]?.content).toMatch(new RegExp('^\\[\\d\\d-\\d\\d \\d\\d:\\d\\d\\] ' + MOCK_REPLY + '$'));
    expect(history[2]?.content).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] Alice\(user-1\)：第二问$/);

    const afterSecond = await readMessages();
    expect(afterSecond).toHaveLength(4);
  });

  it('模型在正文里写 [[react:👍]]：PATCH 里看不到指令，斜杠路径也不贴表情', async () => {
    const testEnv = buildEnv();
    await configure(testEnv);
    globalThis.fetch = withReplyText('收到啦[[react:👍]]');

    const sent = await send(chatPayload('帮我回一句', 'token-react'), testEnv);
    expect(sent.response.status).toBe(200);
    const ack = (await sent.response.json()) as { type: number };
    expect(ack.type).toBe(5);
    await Promise.all(sent.pending);

    // ① 指令在 core 就被剥掉，不许漏进 Discord 的任何一次编辑
    const patches = patchCalls();
    expect(patches.length).toBeGreaterThanOrEqual(1);
    for (const call of patches) expect(String(bodyOf(call)['content'])).not.toContain('[[react:');
    // 剥得干净：最终正文就是去掉指令后的那半句
    expect(bodyOf(patches[patches.length - 1] as OutboundCall)['content']).toBe(ASKER_MENTION + '收到啦');

    // ② 斜杠路径按契约忽略 reactions：一条贴表情请求都不该有
    expect(upstream.calls.filter((call) => call.url.includes('/reactions/'))).toHaveLength(0);
  });

  it('未签名与错签名的交互一律 401', async () => {
    const testEnv = buildEnv();
    const payload = chatPayload('你好', 'token-x');
    const raw = JSON.stringify(payload);

    const unsigned = await worker.fetch(
      new Request('https://bot.test/interactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature-timestamp': TIMESTAMP },
        body: raw,
      }),
      testEnv,
      createExecutionContext().ctx,
    );
    expect(unsigned.status).toBe(401);

    const tampered = await worker.fetch(
      new Request('https://bot.test/interactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-timestamp': TIMESTAMP,
          'x-signature-ed25519': await sign(TIMESTAMP, JSON.stringify({ ...payload, id: 'other' })),
        },
        body: raw,
      }),
      testEnv,
      createExecutionContext().ctx,
    );
    expect(tampered.status).toBe(401);
    expect(chatCalls()).toHaveLength(0);
  });

  it('health 免鉴权 200，其余 /api/* 无 Cookie 401', async () => {
    const testEnv = buildEnv();

    const health = await callApi(testEnv, '/api/health', { method: 'GET' });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: '0.1.0' });

    const prompts = await callApi(testEnv, '/api/prompts', { method: 'GET' });
    expect(prompts.status).toBe(401);
    expect(await prompts.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('实时日志：登录后 GET /api/logs 拿到 { items, latest }，未带 Cookie 401', async () => {
    const testEnv = buildEnv();

    const anonymous = await callApi(testEnv, '/api/logs', { method: 'GET' });
    expect(anonymous.status).toBe(401);

    const cookie = await login(testEnv);
    const response = await callApi(testEnv, '/api/logs', { method: 'GET', cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; latest: number };
    // 轮询端点永远回 200 + 数组 + 数字游标（空表时 latest 就等于 after=0）
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.latest).toBe('number');
  });

  it('§25 摘要：未带 Cookie 的 /api/summaries 401', async () => {
    const testEnv = buildEnv();
    const anonymous = await callApi(testEnv, '/api/summaries', { method: 'GET' });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('§25 摘要：登录后 GET /api/summaries 回 { items }', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);
    const response = await callApi(testEnv, '/api/summaries', { method: 'GET', cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    // 表已在 beforeEach 清空：这里同时验证 §25.2 的 summaries.list() 真接进了 D1 仓储
    expect(body.items).toEqual([]);
  });

  it('§26 记忆配置：未带 Cookie 的 /api/memory-settings 401', async () => {
    const testEnv = buildEnv();
    const anonymous = await callApi(testEnv, '/api/memory-settings', { method: 'GET' });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('§26 记忆配置：登录后 GET /api/memory-settings 回 { items }', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);
    const response = await callApi(testEnv, '/api/memory-settings', { method: 'GET', cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    // 没有任何用例写过 channel_memory_settings：这里同时验证 §26.2 的 channelMemory 真接进了 D1 仓储
    expect(body.items).toEqual([]);
  });

  it('缺 secret 时不抛顶层错：health 仍 200，受保护接口回 500 MISSING_SECRET', async () => {
    const testEnv = buildEnv({ ADMIN_PASSWORD: undefined });

    const health = await callApi(testEnv, '/api/health', { method: 'GET' });
    expect(health.status).toBe(200);

    const prompts = await callApi(testEnv, '/api/prompts', { method: 'GET' });
    expect(prompts.status).toBe(500);
    expect(await prompts.json()).toEqual({ error: 'MISSING_SECRET', name: 'ADMIN_PASSWORD' });

    const interaction = await send(chatPayload('你好', 'token-m'), buildEnv({ DISCORD_PUBLIC_KEY: undefined }));
    expect(interaction.response.status).toBe(500);
    expect(await interaction.response.json()).toEqual({ error: 'MISSING_SECRET', name: 'DISCORD_PUBLIC_KEY' });
  });
});

describe('§21 表情模型配置：GET / PUT /api/reaction-model', () => {
  it('未保存过：GET 回默认配置（关闭 + 默认提供方 + 空模型）', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);

    const response = await callApi(testEnv, '/api/reaction-model', { method: 'GET', cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ config: { enabled: false, provider: 'openai-compat', model: '' } });
  });

  it('PUT 回配置本体，随后 GET 用 { config } 形状读回（§21.5 两种形状不同）', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);
    const config = { enabled: true, provider: 'openai-compat', model: 'gpt-x' };

    const saved = await callApi(testEnv, '/api/reaction-model', { method: 'PUT', cookie, body: config });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(config);

    const read = await callApi(testEnv, '/api/reaction-model', { method: 'GET', cookie });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ config });
  });

  it('开着却给空白模型名：400 BAD_REACTION_MODEL', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);

    const response = await callApi(testEnv, '/api/reaction-model', {
      method: 'PUT',
      cookie,
      body: { enabled: true, provider: 'openai-compat', model: '   ' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'BAD_REACTION_MODEL' });
  });

  it('匿名 GET：401', async () => {
    const testEnv = buildEnv();

    const response = await callApi(testEnv, '/api/reaction-model', { method: 'GET' });
    expect(response.status).toBe(401);
  });
});

describe('§23.6 表情描述：GET /api/emojis 鉴权与空清单', () => {
  it('匿名 GET /api/emojis?guildId=x：401，读不到任何描述', async () => {
    const testEnv = buildEnv();

    const response = await callApi(testEnv, '/api/emojis?guildId=guild-1', { method: 'GET' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('带 Cookie：200 且形状是 { items: [] }（表空时不编造条目）', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);

    const response = await callApi(testEnv, '/api/emojis?guildId=guild-1', { method: 'GET', cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });
});

describe('§24.6 表情别名：四条后台接口的 200 / 400 / 401', () => {
  const ALIAS = '奶龙';
  const EMOJI_ID = '150000000000000003';
  const ALIASES_PATH = '/api/emoji-aliases';
  const LIVE_PATH = '/api/emojis/live';

  it('匿名打四条接口：全部 401，且一次上游都没碰', async () => {
    const testEnv = buildEnv();
    const requests: Array<{ path: string; method: string; body?: unknown }> = [
      { path: LIVE_PATH + '?guildId=' + GUILD_ID, method: 'GET' },
      { path: ALIASES_PATH + '?guildId=' + GUILD_ID, method: 'GET' },
      {
        path: ALIASES_PATH,
        method: 'PUT',
        body: { guildId: GUILD_ID, alias: ALIAS, emojiId: EMOJI_ID, emojiName: 'laugh' },
      },
      { path: ALIASES_PATH + '?guildId=' + GUILD_ID + '&alias=' + encodeURIComponent(ALIAS), method: 'DELETE' },
    ];

    for (const item of requests) {
      const response = await callApi(testEnv, item.path, { method: item.method, body: item.body });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it('GET /api/emojis/live：200 且按 name 升序、不可用的不出现', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);
    emojiListHandler = () =>
      jsonResponse([
        { id: '300', name: 'zeta', animated: true },
        { id: '100', name: 'alpha' },
        { id: '200', name: 'mid', available: false },
      ]);

    const response = await callApi(testEnv, LIVE_PATH + '?guildId=' + GUILD_ID, { method: 'GET', cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { id: '100', name: 'alpha', animated: false },
        { id: '300', name: 'zeta', animated: true },
      ],
    });
  });

  it('GET /api/emojis/live 缺 guildId：400，且不去打上游', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);

    const response = await callApi(testEnv, LIVE_PATH + '?guildId=', { method: 'GET', cookie });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'BAD_GUILD_ID' });
    expect(upstream.calls.filter((call) => call.url.endsWith('/emojis'))).toHaveLength(0);
  });

  it('上游拉清单失败：502 EMOJI_LIST_FAILED，不回错误原文', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);
    emojiListHandler = () => jsonResponse({ error: 'DISCORD_500', detail: '内部细节不该外泄' }, 500);

    const response = await callApi(testEnv, LIVE_PATH + '?guildId=' + GUILD_ID, { method: 'GET', cookie });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'EMOJI_LIST_FAILED' });
  });

  it('PUT -> GET -> DELETE 走完一轮：200 / 200 / 200，返回体是存下来的那一份', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);

    const put = await callApi(testEnv, ALIASES_PATH, {
      method: 'PUT',
      cookie,
      body: { guildId: GUILD_ID, alias: '  ' + ALIAS + '  ', emojiId: EMOJI_ID, emojiName: ' laugh ' },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ alias: ALIAS, emojiId: EMOJI_ID, emojiName: 'laugh' });

    const list = await callApi(testEnv, ALIASES_PATH + '?guildId=' + GUILD_ID, { method: 'GET', cookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [{ alias: ALIAS, emojiId: EMOJI_ID, emojiName: 'laugh' }] });

    const removed = await callApi(
      testEnv,
      ALIASES_PATH + '?guildId=' + GUILD_ID + '&alias=' + encodeURIComponent(ALIAS),
      { method: 'DELETE', cookie },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });

    const after = await callApi(testEnv, ALIASES_PATH + '?guildId=' + GUILD_ID, { method: 'GET', cookie });
    expect(await after.json()).toEqual({ items: [] });
  });

  it('PUT / DELETE 非法入参：BAD_ALIAS 与 BAD_EMOJI 各自 400，一行都不落库', async () => {
    const testEnv = buildEnv();
    const cookie = await login(testEnv);
    const ok = { guildId: GUILD_ID, alias: ALIAS, emojiId: EMOJI_ID, emojiName: 'laugh' };

    const cases: Array<{ body: Record<string, unknown>; error: string }> = [
      // 冒号会把 :名字: 撕成两半，直接不收
      { body: { ...ok, alias: '奶:龙' }, error: 'BAD_ALIAS' },
      // 超过 24 字（后台输入框容量）
      { body: { ...ok, alias: 'a'.repeat(25) }, error: 'BAD_ALIAS' },
      // emojiId 短于 15 位的一定不是雪花
      { body: { ...ok, emojiId: '123' }, error: 'BAD_EMOJI' },
      // emojiName 带冒号就不是可回填的表情名
      { body: { ...ok, emojiName: 'laugh:x' }, error: 'BAD_EMOJI' },
    ];

    for (const item of cases) {
      const response = await callApi(testEnv, ALIASES_PATH, { method: 'PUT', cookie, body: item.body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: item.error });
    }

    const badDelete = await callApi(
      testEnv,
      ALIASES_PATH + '?guildId=' + GUILD_ID + '&alias=' + encodeURIComponent('奶 龙'),
      { method: 'DELETE', cookie },
    );
    expect(badDelete.status).toBe(400);
    expect(await badDelete.json()).toEqual({ error: 'BAD_ALIAS' });

    const list = await callApi(testEnv, ALIASES_PATH + '?guildId=' + GUILD_ID, { method: 'GET', cookie });
    expect(await list.json()).toEqual({ items: [] });
  });
});

