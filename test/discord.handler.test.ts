import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReactionRequest, TurnContext, TurnResult } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import {
  createInteractionHandler,
  type Clock,
  type InteractionContext,
  type InteractionHandlerDeps,
} from '../src/workers/discord/handler';
import type { ChatRunner } from '../src/workers/discord/ports';
import { resetBotNameCache } from '../src/workers/discord/bot-name';
import { ed25519Crypto } from '../src/workers/discord/verify';

const API_BASE = 'https://discord.test/api/v10';
const APPLICATION_ID = 'app-123';
const INTERACTION_TOKEN = 'interaction-token-abc';
const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-1';
const OTHER_CHANNEL_ID = 'channel-2';
const ADMIN_BITS = '32';
const NO_BITS = '0';
const TIMESTAMP = '1735689600';
const MAX_CHARS = 1900;
/** 服务器频道里每条回复开头的 @ 提问者：commandPayload 的 member.user.id */
const ASKER_MENTION = '<@user-1> ';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

let publicKeyHex = '';
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await ed25519Crypto.generateKey();
  privateKey = pair.privateKey;
  publicKeyHex = toHex(await ed25519Crypto.exportRawPublicKey(pair.publicKey));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM routes'),
    env.DB.prepare('DELETE FROM prompts'),
    env.DB.prepare('DELETE FROM prompt_segments'),
  ]);
});

interface FakeClock extends Clock {
  at(): number;
}

function createFakeClock(): FakeClock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    at: () => current,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  at: number;
}

function createFetchRecorder(clock: FakeClock) {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url, method, body, at: clock.now() });
    return new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

interface CommandOptionInput {
  name: string;
  type: number;
  value: string | boolean;
}

interface PayloadOptions {
  permissionBits?: string | null;
  channelId?: string;
  omitToken?: boolean;
}

function commandPayload(name: string, options: CommandOptionInput[], payloadOptions: PayloadOptions = {}) {
  const member: Record<string, unknown> = {
    user: { id: 'user-1', username: 'alice', global_name: 'Alice' },
  };
  if (payloadOptions.permissionBits !== null) member.permissions = payloadOptions.permissionBits ?? NO_BITS;
  const payload: Record<string, unknown> = {
    id: 'interaction-1',
    application_id: APPLICATION_ID,
    type: 2,
    token: INTERACTION_TOKEN,
    guild_id: GUILD_ID,
    channel_id: payloadOptions.channelId ?? CHANNEL_ID,
    member,
    data: { name, options },
  };
  if (payloadOptions.omitToken) delete payload.token;
  return payload;
}

async function sign(timestamp: string, body: string): Promise<string> {
  return toHex(await ed25519Crypto.sign(privateKey, new TextEncoder().encode(timestamp + body)));
}

interface RequestOptions {
  /** 用于签名但实际不发送的 body（篡改用） */
  signedBody?: string;
  timestamp?: string;
  /** 覆盖实际发送的时间戳头（用于重放/过期校验），签名仍用 timestamp */
  headerTimestamp?: string;
  omitSignatureHeader?: boolean;
  omitTimestampHeader?: boolean;
  method?: string;
}

async function signedRequest(payload: unknown, options: RequestOptions = {}): Promise<Request> {
  const rawBody = JSON.stringify(payload);
  const timestamp = options.timestamp ?? TIMESTAMP;
  const signature = await sign(timestamp, options.signedBody ?? rawBody);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!options.omitSignatureHeader) headers['x-signature-ed25519'] = signature;
  if (!options.omitTimestampHeader) headers['x-signature-timestamp'] = options.headerTimestamp ?? timestamp;
  return new Request('https://bot.test/discord/interactions', {
    method: options.method ?? 'POST',
    headers,
    body: rawBody,
  });
}

function createContext() {
  const pending: Promise<unknown>[] = [];
  const ctx: InteractionContext = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };
  return { ctx, pending };
}

/** reactions 是 TurnResult 的必填字段；斜杠路径按契约忽略它，但假返回值必须完整 */
function turnResult(text: string, reactions: ReactionRequest[] = []): TurnResult {
  return {
    text,
    model: { provider: 'openai-compat', model: 'fake-model' },
    attempts: [],
    promptScope: 'global',
    routeScope: 'global',
    reactions,
  };
}

interface ChatSpy {
  chat: ChatRunner;
  contexts: TurnContext[];
  resets: Array<{ guildId: string; channelId: string }>;
}

function createChat(
  behaviour: (
    ctx: TurnContext,
    events?: { onProgress?: (text: string) => void | Promise<void> },
  ) => Promise<TurnResult>,
): ChatSpy {
  const contexts: TurnContext[] = [];
  const resets: Array<{ guildId: string; channelId: string }> = [];
  return {
    contexts,
    resets,
    chat: {
      async run(ctx, events) {
        contexts.push(ctx);
        // 显式 await：workerd 里 async 函数直接 return 一个已 reject 的 promise 会被记成 unhandled
        return await behaviour(ctx, events);
      },
      async reset(key) {
        resets.push(key);
      },
      // ChatRunner 的 §17.5 扩展：本文件只测 /chat 与命令装配，这两条保持空实现
      async summarize() {
        return null;
      },
      async getSummary() {
        return null;
      },
    },
  };
}

function makeHandler(chat: ChatRunner, clock: FakeClock = createFakeClock(), extra: Partial<InteractionHandlerDeps> = {}) {
  const recorder = createFetchRecorder(clock);
  const repos = makeRepos();
  const handler = createInteractionHandler({
    publicKeyHex,
    applicationId: APPLICATION_ID,
    botToken: 'bot-token',
    chat,
    routes: repos.routes,
    prompts: repos.prompts,
    fetch: recorder.fetch,
    apiBase: API_BASE,
    clock,
    log: () => {},
    ...extra,
  });
  return { handler, recorder, clock, repos };
}

describe('验签与基础应答', () => {
  it('PING → {type:1}', async () => {
    const { handler, recorder } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();
    const response = await handler(await signedRequest({ type: 1 }), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
    expect(recorder.calls).toHaveLength(0);
  });

  it('签名错误 / 篡改 body / 缺头 → 401', async () => {
    const { handler } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const payload = commandPayload('help', []);

    const cases: Request[] = [
      await signedRequest(payload, { signedBody: JSON.stringify({ type: 1 }) }),
      await signedRequest(payload, { headerTimestamp: '1735689601' }),
      await signedRequest(payload, { omitSignatureHeader: true }),
      await signedRequest(payload, { omitTimestampHeader: true }),
    ];

    for (const request of cases) {
      const { ctx } = createContext();
      const response = await handler(request, ctx);
      expect(response.status).toBe(401);
    }
  });

  it('非 POST → 405', async () => {
    const { handler } = makeHandler(createChat(async () => turnResult('x')).chat);
    const { ctx } = createContext();
    const request = new Request('https://bot.test/discord/interactions', { method: 'GET' });
    const response = await handler(request, ctx);
    expect(response.status).toBe(405);
  });
});

describe('/chat 渐进编辑', () => {
  it('defer 为 {type:5}、调用 waitUntil，并 PATCH @original', async () => {
    const spy = createChat(async (_ctx, events) => {
      await events?.onProgress?.('半句话');
      return turnResult('最终回复');
    });
    const { handler, recorder } = makeHandler(spy.chat);
    const { ctx, pending } = createContext();

    const response = await handler(
      await signedRequest(commandPayload('chat', [{ name: 'prompt', type: 3, value: '你好' }])),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 5, data: {} });
    expect(pending).toHaveLength(1);

    await Promise.all(pending);

    expect(spy.contexts).toHaveLength(1);
    expect(spy.contexts[0].userText).toBe('你好');
    expect(spy.contexts[0].channelId).toBe(CHANNEL_ID);
    expect(spy.contexts[0].guildId).toBe(GUILD_ID);

    expect(recorder.calls.length).toBeGreaterThanOrEqual(1);
    const last = recorder.calls[recorder.calls.length - 1];
    expect(last.url).toBe(API_BASE + '/webhooks/' + APPLICATION_ID + '/' + INTERACTION_TOKEN + '/messages/@original');
    expect(last.method).toBe('PATCH');
    // 服务器频道：正文头顶一个 @ 提问者，allowed_mentions 只解析用户
    expect(last.body).toEqual({ content: ASKER_MENTION + '最终回复', allowed_mentions: { parse: ['users'] } });
  });

  it('节流 >=1200ms、总编辑 <=12 次、最后一次是全量文本', async () => {
    const clock = createFakeClock();
    const chunks = Array.from({ length: 30 }, (_, index) => '片段' + (index + 1) + '·');
    const fullText = chunks.join('');
    const spy = createChat(async (_ctx, events) => {
      let accumulated = '';
      for (const chunk of chunks) {
        accumulated += chunk;
        await events?.onProgress?.(accumulated);
        await clock.sleep(1000);
      }
      return turnResult(accumulated);
    });
    const { handler, recorder } = makeHandler(spy.chat, clock);
    const { ctx, pending } = createContext();

    await handler(await signedRequest(commandPayload('chat', [{ name: 'prompt', type: 3, value: '数一数' }])), ctx);
    await Promise.all(pending);

    const patches = recorder.calls.filter((call) => call.method === 'PATCH');
    expect(patches.length).toBeGreaterThan(1);
    expect(patches.length).toBeLessThanOrEqual(12);
    expect(patches[patches.length - 1].body).toEqual({
      content: ASKER_MENTION + fullText,
      allowed_mentions: { parse: ['users'] },
    });

    for (let index = 1; index < patches.length; index += 1) {
      expect(patches[index].at - patches[index - 1].at).toBeGreaterThanOrEqual(1200);
    }
  });

  it('超长文本连同 @ 前缀一起截到 1900 字符', async () => {
    const longText = '甲'.repeat(3000);
    const spy = createChat(async () => turnResult(longText));
    const { handler, recorder } = makeHandler(spy.chat);
    const { ctx, pending } = createContext();

    await handler(await signedRequest(commandPayload('chat', [{ name: 'prompt', type: 3, value: '长文' }])), ctx);
    await Promise.all(pending);

    const last = recorder.calls[recorder.calls.length - 1];
    const content = (last.body as { content: string }).content;
    // 正文预算扣掉了「前缀 + 后缀」两段，所以编辑器截断后正好填满 withMention 的配额：
    // 整条 = 前缀 + 正文（甲…）+ 「…(已截断)」，一共正好 1900 —— 前缀和后缀都完整，谁都没被再切一次
    expect(content.length).toBe(MAX_CHARS);
    expect(content.startsWith(ASKER_MENTION)).toBe(true);
    expect(content.endsWith('…(已截断)')).toBe(true);
    expect(content).toBe(
      ASKER_MENTION + '甲'.repeat(MAX_CHARS - ASKER_MENTION.length - '…(已截断)'.length) + '…(已截断)',
    );
  });

  it('斜杠路径忽略 reactions：不发贴表情请求，正文里不出现 [[react:', async () => {
    // core 在交给 handler 之前就剥掉指令、把表情放进 reactions；handler 只该用 text
    const spy = createChat(async () => turnResult('好的，收到', [{ emoji: '👍' }, { emoji: '🎉' }]));
    const { handler, recorder } = makeHandler(spy.chat);
    const { ctx, pending } = createContext();

    await handler(await signedRequest(commandPayload('chat', [{ name: 'prompt', type: 3, value: '贴个表情' }])), ctx);
    await Promise.all(pending);

    // 贴表情是网关路径的特性：斜杠路径按契约忽略 reactions，一条贴表情请求都不许发
    expect(recorder.calls.filter((call) => call.url.includes('/reactions/'))).toHaveLength(0);

    const last = recorder.calls[recorder.calls.length - 1];
    expect(last.method).toBe('PATCH');
    const content = (last.body as { content: string }).content;
    expect(content).toBe(ASKER_MENTION + '好的，收到');
    expect(content).not.toContain('[[react:');
  });

  it('ChatRunner 抛错 → error.message 进原消息，不静默', async () => {
    const spy = createChat(async () => {
      throw new Error('upstream 502 exploded');
    });
    const { handler, recorder } = makeHandler(spy.chat);
    const { ctx, pending } = createContext();

    await handler(await signedRequest(commandPayload('chat', [{ name: 'prompt', type: 3, value: '出错' }])), ctx);
    await Promise.all(pending);

    const content = (recorder.calls[recorder.calls.length - 1].body as { content: string }).content;
    expect(content).toContain('upstream 502 exploded');
  });

  it('NO_ROUTE_CONFIGURED → 中文可操作提示', async () => {
    const spy = createChat(async () => {
      throw new Error('NO_ROUTE_CONFIGURED');
    });
    const { handler, recorder } = makeHandler(spy.chat);
    const { ctx, pending } = createContext();

    await handler(await signedRequest(commandPayload('chat', [{ name: 'prompt', type: 3, value: '在吗' }])), ctx);
    await Promise.all(pending);

    const content = (recorder.calls[recorder.calls.length - 1].body as { content: string }).content;
    expect(content).toContain('路由');
    expect(content).toContain('/model');
    expect(content).not.toContain('NO_ROUTE_CONFIGURED');
  });
});

describe('权限与管理命令', () => {
  it('非 ManageGuild 调 /model set → ephemeral 拒绝（flags 64）且不落库', async () => {
    const { handler, repos } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx, pending } = createContext();

    const response = await handler(
      await signedRequest(
        commandPayload(
          'model',
          [
            { name: 'provider', type: 3, value: 'anthropic' },
            { name: 'model', type: 3, value: 'claude-3-5-sonnet' },
          ],
          { permissionBits: NO_BITS },
        ),
      ),
      ctx,
    );

    const body = (await response.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('权限');
    expect(pending).toHaveLength(0);
    await expect(repos.routes.get({ scope: 'channel', scopeId: CHANNEL_ID })).resolves.toBeNull();
  });

  it('ManageGuild 调 /model set → 写入频道级路由', async () => {
    const { handler, repos } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();

    const response = await handler(
      await signedRequest(
        commandPayload(
          'model',
          [
            { name: 'provider', type: 3, value: 'anthropic' },
            { name: 'model', type: 3, value: 'claude-3-5-sonnet' },
          ],
          { permissionBits: ADMIN_BITS },
        ),
      ),
      ctx,
    );

    const body = (await response.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('claude-3-5-sonnet');

    const stored = await repos.routes.get({ scope: 'channel', scopeId: CHANNEL_ID });
    expect(stored?.primary).toEqual({ provider: 'anthropic', model: 'claude-3-5-sonnet' });
    expect(stored?.fallbacks).toEqual([]);
  });

  it('/model view 不需要管理权限，且读不到配置时给用法提示', async () => {
    const { handler } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();

    const response = await handler(
      await signedRequest(commandPayload('model', [{ name: 'view', type: 5, value: true }], { permissionBits: NO_BITS })),
      ctx,
    );
    const body = (await response.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('/model');
  });

  it('/persona set 无权限 → ephemeral 拒绝', async () => {
    const { handler } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();

    const response = await handler(
      await signedRequest(
        commandPayload('persona', [{ name: 'persona', type: 3, value: '温柔助手' }], { permissionBits: NO_BITS }),
      ),
      ctx,
    );
    const body = (await response.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.data.flags).toBe(64);
  });

  it('/persona set 有权限 → 写入本频道提示词的两个固定段', async () => {
    const { handler, repos } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();

    const response = await handler(
      await signedRequest(
        commandPayload(
          'persona',
          [
            { name: 'persona', type: 3, value: '温柔助手' },
            { name: 'system', type: 3, value: '你是 {{user_name}} 的助手' },
          ],
          { permissionBits: ADMIN_BITS },
        ),
      ),
      ctx,
    );
    const body = (await response.json()) as { type: number; data: { content: string } };
    expect(body.data.content).toBe('已更新本频道的人格与基本设定。');

    const stored = await repos.prompts.get({ scope: 'channel', scopeId: CHANNEL_ID });
    expect(stored?.segments).toEqual([
      { id: 'slash-persona', name: '人格', role: 'system', content: '温柔助手', enabled: true, placement: 'before', position: 0 },
      { id: 'slash-main', name: '基本设定', role: 'system', content: '你是 {{user_name}} 的助手', enabled: true, placement: 'before', position: 1 },
    ]);
  });

  it('/persona set 在频道没有自己的行时以继承层为底复制，再改固定段', async () => {
    const { handler, repos } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();
    await repos.prompts.put({ scope: 'guild', scopeId: GUILD_ID }, {
      segments: [
        { id: 'guild-main', name: '基本设定', role: 'system', content: '公会提示词', enabled: true, placement: 'before', position: 0 },
        { id: 'guild-extra', name: '补充', role: 'user', content: '只回一句话', enabled: true, placement: 'before', position: 1 },
      ],
      temperature: 0.4,
      maxTokens: 256,
    });

    await handler(
      await signedRequest(
        commandPayload('persona', [{ name: 'persona', type: 3, value: '温柔助手' }], { permissionBits: ADMIN_BITS }),
      ),
      ctx,
    );

    const stored = await repos.prompts.get({ scope: 'channel', scopeId: CHANNEL_ID });
    expect(stored).toEqual({
      segments: [
        { id: 'guild-main', name: '基本设定', role: 'system', content: '公会提示词', enabled: true, placement: 'before', position: 0 },
        { id: 'guild-extra', name: '补充', role: 'user', content: '只回一句话', enabled: true, placement: 'before', position: 1 },
        { id: 'slash-persona', name: '人格', role: 'system', content: '温柔助手', enabled: true, placement: 'before', position: 2 },
      ],
      temperature: 0.4,
      maxTokens: 256,
    });
  });

  it('/persona 不带参数 → 返回当前提示词视图，不写库', async () => {
    const { handler, repos } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();

    const empty = await handler(await signedRequest(commandPayload('persona', [], { permissionBits: ADMIN_BITS })), ctx);
    const emptyBody = (await empty.json()) as { type: number; data: { content: string } };
    expect(emptyBody.type).toBe(4);
    expect(emptyBody.data.content).toBe(
      '本频道还没有自定义提示词，当前使用内置默认。用法：/persona persona:温柔助手 system:你是一位{{user_name}}的助手',
    );

    await repos.prompts.put({ scope: 'guild', scopeId: GUILD_ID }, {
      segments: [
        { id: 'long', name: '基本设定', role: 'system', content: '长'.repeat(130) + '月', enabled: true, placement: 'before', position: 0 },
        { id: 'tail', name: '后置', role: 'system', content: '收尾', enabled: false, placement: 'after', position: 1 },
        { id: 'claim', name: '指令', role: 'user', content: '简短', enabled: true, placement: 'before', position: 2 },
      ],
    });

    const response = await handler(await signedRequest(commandPayload('persona', [], { permissionBits: ADMIN_BITS })), ctx);
    const body = (await response.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toBe(
      [
        '当前提示词（来源：服务器）',
        '· 基本设定［system/前置］启用：' + '长'.repeat(120) + '…',
        '· 后置［system/后置］已停用：收尾',
        '· 指令［user］启用：简短',
      ].join('\n'),
    );
    expect(await repos.prompts.get({ scope: 'channel', scopeId: CHANNEL_ID })).toBeNull();
  });

  it('/reset 有权限 → 调 ChatRunner.reset；无权限 → 拒绝', async () => {
    const spy = createChat(async () => turnResult('不应调用'));
    const { handler } = makeHandler(spy.chat);

    const denied = await handler(
      await signedRequest(commandPayload('reset', [], { permissionBits: NO_BITS })),
      createContext().ctx,
    );
    expect(((await denied.json()) as { data: { flags: number } }).data.flags).toBe(64);
    expect(spy.resets).toHaveLength(0);

    const allowed = await handler(
      await signedRequest(commandPayload('reset', [], { permissionBits: ADMIN_BITS })),
      createContext().ctx,
    );
    const body = (await allowed.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('记忆');
    expect(spy.resets).toEqual([{ guildId: GUILD_ID, channelId: CHANNEL_ID }]);
  });

  it('/help 返回中文用法说明', async () => {
    const { handler } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();

    const response = await handler(await signedRequest(commandPayload('help', [], { permissionBits: NO_BITS })), ctx);
    const body = (await response.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('/chat');
    expect(body.data.content).toContain('/model');
    expect(body.data.content).toContain('/persona');
    expect(body.data.content).toContain('/reset');
    expect(body.data.content).toContain('/help');
  });

  it('未知命令 → ephemeral 提示', async () => {
    const { handler } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx } = createContext();

    const response = await handler(await signedRequest(commandPayload('nope', [])), ctx);
    const body = (await response.json()) as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('未知命令');
  });

  it('/chat 缺少 prompt → ephemeral 提示，不 defer', async () => {
    const { handler } = makeHandler(createChat(async () => turnResult('不应调用')).chat);
    const { ctx, pending } = createContext();

    const response = await handler(await signedRequest(commandPayload('chat', [])), ctx);
    const body = (await response.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('prompt');
    expect(pending).toHaveLength(0);
  });

  it('记忆按频道隔离：不同 channelId 的 /reset 只清自己那条', async () => {
    const spy = createChat(async () => turnResult('不应调用'));
    const { handler } = makeHandler(spy.chat);

    await handler(
      await signedRequest(commandPayload('reset', [], { permissionBits: ADMIN_BITS, channelId: OTHER_CHANNEL_ID })),
      createContext().ctx,
    );

    expect(spy.resets).toEqual([{ guildId: GUILD_ID, channelId: OTHER_CHANNEL_ID }]);
  });
});
describe('服务器昵称（§64）', () => {
  it('/chat 的 ctx.botName 用该服昵称，取不到才留常量', async () => {
    resetBotNameCache();
    const spy = createChat(async () => turnResult('回复'));
    const fetchStub = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = url.includes('/members/')
        ? { nick: '示例角色', user: { username: '示例机器人' } }
        : { id: 'message-1' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { handler } = makeHandler(spy.chat, createFakeClock(), { fetch: fetchStub });
    const { ctx, pending } = createContext();

    await handler(await signedRequest(commandPayload('chat', [{ name: 'prompt', type: 3, value: '你好' }])), ctx);
    await Promise.all(pending);

    expect(spy.contexts).toHaveLength(1);
    expect(spy.contexts[0].botName).toBe('示例角色');
  });
});
