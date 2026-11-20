import { beforeAll, describe, expect, it } from 'vitest';
import type { PromptRepository, RouteRepository } from '../src/core/ports';
import type { ChannelKey, ConversationSummary, SummaryOutcome, TurnResult } from '../src/core/types';
import {
  createInteractionHandler,
  type InteractionContext,
  type InteractionHandlerDeps,
} from '../src/workers/discord/handler';
import type { ChatRunner } from '../src/workers/discord/ports';
import { ed25519Crypto } from '../src/workers/discord/verify';

const API_BASE = 'https://discord.test/api/v10';
const APPLICATION_ID = 'app-123';
const INTERACTION_TOKEN = 'interaction-token-abc';
const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-1';
const TIMESTAMP = '1735689600';
const MAX_CHARS = 1900;
const TRUNCATION_SUFFIX = '…(已截断)';

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

let publicKeyHex = '';
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await ed25519Crypto.generateKey();
  privateKey = pair.privateKey;
  publicKeyHex = toHex(await ed25519Crypto.exportRawPublicKey(pair.publicKey));
});

/**
 * 这一层只测 Discord 的交互装配，摘要生成是 M2 的事：
 * 用假 ChatRunner 把 summarize/getSummary 的返回与异常直接摆出来。
 */
const routes: RouteRepository = {
  get: async () => null,
  list: async () => [],
  put: async () => {},
  remove: async () => {},
};

const prompts: PromptRepository = {
  get: async () => null,
  list: async () => [],
  put: async () => {},
  remove: async () => {},
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function createFetchRecorder() {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url, method, body });
    return new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

function commandPayload(
  name: string,
  options: Array<{ name: string; type: number; value: string | boolean }>,
  payloadOptions: { channelId?: string | null } = {},
) {
  const payload: Record<string, unknown> = {
    id: 'interaction-1',
    application_id: APPLICATION_ID,
    type: 2,
    token: INTERACTION_TOKEN,
    guild_id: GUILD_ID,
    member: { user: { id: 'user-1', username: 'alice', global_name: 'Alice' }, permissions: '0' },
    data: { name, options },
  };
  if (payloadOptions.channelId !== null) payload.channel_id = payloadOptions.channelId ?? CHANNEL_ID;
  return payload;
}

async function signedRequest(payload: unknown): Promise<Request> {
  const rawBody = JSON.stringify(payload);
  const signature = await ed25519Crypto.sign(privateKey, new TextEncoder().encode(TIMESTAMP + rawBody));
  return new Request('https://bot.test/discord/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': toHex(signature),
      'x-signature-timestamp': TIMESTAMP,
    },
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

function turnResult(text: string): TurnResult {
  return {
    text,
    model: { provider: 'openai-compat', model: 'fake-model' },
    attempts: [],
    promptScope: 'global',
    routeScope: 'global',
    reactions: [],
  };
}

interface SummaryBehaviour {
  summarize?: (key: ChannelKey) => Promise<SummaryOutcome | null>;
  getSummary?: (key: ChannelKey) => Promise<ConversationSummary | null>;
}

interface ChatSpy {
  chat: ChatRunner;
  summaryCalls: ChannelKey[];
  viewCalls: ChannelKey[];
}

function createChat(behaviour: SummaryBehaviour = {}): ChatSpy {
  const summaryCalls: ChannelKey[] = [];
  const viewCalls: ChannelKey[] = [];
  const chat: ChatRunner = {
    async run(): Promise<TurnResult> {
      return turnResult('不应调用');
    },
    async reset(): Promise<void> {},
    async summarize(key) {
      summaryCalls.push(key);
      if (behaviour.summarize) return await behaviour.summarize(key);
      return null;
    },
    async getSummary(key) {
      viewCalls.push(key);
      if (behaviour.getSummary) return await behaviour.getSummary(key);
      return null;
    },
  };
  return { chat, summaryCalls, viewCalls };
}

function makeHandler(chat: ChatRunner, extra: Partial<InteractionHandlerDeps> = {}) {
  const recorder = createFetchRecorder();
  const handler = createInteractionHandler({
    publicKeyHex,
    applicationId: APPLICATION_ID,
    botToken: 'bot-token',
    chat,
    routes,
    prompts,
    fetch: recorder.fetch,
    apiBase: API_BASE,
    log: () => {},
    ...extra,
  });
  return { handler, recorder };
}

const ORIGINAL_URL = API_BASE + '/webhooks/' + APPLICATION_ID + '/' + INTERACTION_TOKEN + '/messages/@original';

/** ACK 必须是 {type:5} 且只 defer 一次；结果一律靠编辑原消息送回 */
async function ackThenCollect(
  handler: ReturnType<typeof makeHandler>['handler'],
  recorder: ReturnType<typeof createFetchRecorder>,
  payload: unknown,
) {
  const { ctx, pending } = createContext();
  const response = await handler(await signedRequest(payload), ctx);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ type: 5, data: {} });
  expect(pending).toHaveLength(1);
  await Promise.all(pending);
  return lastPatchContent(recorder);
}

function lastPatchContent(recorder: ReturnType<typeof createFetchRecorder>): string {
  const patches = recorder.calls.filter((call) => call.method === 'PATCH');
  expect(patches.length).toBeGreaterThanOrEqual(1);
  const last = patches[patches.length - 1];
  expect(last.url).toBe(ORIGINAL_URL);
  expect(last.method).toBe('PATCH');
  return (last.body as { content: string }).content;
}

describe('/summary 命令注册', () => {
  it('/help 里能看到 /summary，且不需要管理权限', async () => {
    const spy = createChat();
    const { handler, recorder } = makeHandler(spy.chat);
    const { ctx } = createContext();

    const response = await handler(await signedRequest(commandPayload('help', [])), ctx);
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain('/summary');
    expect(body.data.content).toContain('view:true');
    expect(recorder.calls).toHaveLength(0);
  });
});

describe('/summary 总结路径', () => {
  it('先 ACK type 5 再 PATCH @original；文案含条数与模型，summarize 收到 force 与频道 key', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const spy = createChat({
      summarize: async () => {
        await gate;
        return {
          summary: '用户在讨论爬虫限流，结论是退避 3 秒。',
          coveredUntilId: 42,
          summarizedMessages: 20,
          model: 'gpt-4o-mini',
        };
      },
    });
    const { handler, recorder } = makeHandler(spy.chat);
    const { ctx, pending } = createContext();

    const response = await handler(await signedRequest(commandPayload('summary', [])), ctx);
    await expect(response.json()).resolves.toEqual({ type: 5, data: {} });
    // 摘要还卡着闸门：这一刻只可能已经 ACK，不可能已经编辑过原消息
    expect(recorder.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(pending).toHaveLength(1);

    open();
    await Promise.all(pending);
    const content = lastPatchContent(recorder);

    expect(content).toBe('已总结 20 条消息（模型 gpt-4o-mini）\n\n用户在讨论爬虫限流，结论是退避 3 秒。');
    expect(spy.summaryCalls).toHaveLength(1);
    expect(spy.summaryCalls).toEqual([{ guildId: GUILD_ID, channelId: CHANNEL_ID }]);
    expect(spy.viewCalls).toHaveLength(0);
  });

  it('summarize 返回 null（没有可总结内容）→ 固定中文提示', async () => {
    const spy = createChat({ summarize: async () => null });
    const { handler, recorder } = makeHandler(spy.chat);
    const content = await ackThenCollect(handler, recorder, commandPayload('summary', []));

    expect(content).toBe('这个频道还没有可总结的内容');
  });

  it('摘要超长 → 截断到 1900 字符并追加后缀', async () => {
    const spy = createChat({
      summarize: async () => ({
        summary: '乙'.repeat(3000),
        coveredUntilId: 7,
        summarizedMessages: 20,
        model: 'fake-model',
      }),
    });
    const { handler, recorder } = makeHandler(spy.chat);
    const content = await ackThenCollect(handler, recorder, commandPayload('summary', []));

    expect(content.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(content.length).toBe(MAX_CHARS + TRUNCATION_SUFFIX.length);
  });
});

describe('/summary view:true 路径', () => {
  it('有摘要 → 只调 getSummary，不重新总结，文案含摘要正文', async () => {
    const spy = createChat({
      getSummary: async () => ({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        summary: '频道里只聊过部署。',
        coveredUntilId: 12,
        updatedAt: '2026-10-25T00:00:00.000Z',
      }),
    });
    const { handler, recorder } = makeHandler(spy.chat);
    const content = await ackThenCollect(handler, recorder, commandPayload('summary', [{ name: 'view', type: 5, value: true }]));

    expect(content).toContain('频道里只聊过部署。');
    expect(content).toContain('12');
    expect(spy.viewCalls).toEqual([{ guildId: GUILD_ID, channelId: CHANNEL_ID }]);
    expect(spy.summaryCalls).toHaveLength(0);
  });

  it('没有摘要 → 「这个频道还没有摘要」', async () => {
    const spy = createChat({ getSummary: async () => null });
    const { handler, recorder } = makeHandler(spy.chat);
    const content = await ackThenCollect(handler, recorder, commandPayload('summary', [{ name: 'view', type: 5, value: true }]));

    expect(content).toBe('这个频道还没有摘要');
  });
});

describe('/summary 失败路径', () => {
  it('普通异常 → 「总结失败：」+ 原始 message，不静默', async () => {
    const spy = createChat({
      summarize: async () => {
        throw new Error('upstream 502 exploded');
      },
    });
    const { handler, recorder } = makeHandler(spy.chat);
    const content = await ackThenCollect(handler, recorder, commandPayload('summary', []));

    expect(content).toContain('总结失败');
    expect(content).toContain('upstream 502 exploded');
  });

  it('NO_ROUTE_CONFIGURED / SUMMARY_EMPTY → 中文可操作提示，不回显英文错误码', async () => {
    const noRoute = createChat({
      summarize: async () => {
        throw new Error('NO_ROUTE_CONFIGURED');
      },
    });
    const first = makeHandler(noRoute.chat);
    const noRouteContent = await ackThenCollect(first.handler, first.recorder, commandPayload('summary', []));
    expect(noRouteContent).toContain('路由');
    expect(noRouteContent).toContain('/model');
    expect(noRouteContent).not.toContain('NO_ROUTE_CONFIGURED');

    const emptySummary = createChat({
      summarize: async () => {
        throw new Error('SUMMARY_EMPTY');
      },
    });
    const second = makeHandler(emptySummary.chat);
    const emptyContent = await ackThenCollect(second.handler, second.recorder, commandPayload('summary', []));
    expect(emptyContent).toContain('空摘要');
    expect(emptyContent).not.toContain('SUMMARY_EMPTY');
  });

  it('缺 channel_id → 先 ACK 再给中文提示，不抛也不调 summarize', async () => {
    const spy = createChat();
    const { handler, recorder } = makeHandler(spy.chat);
    const content = await ackThenCollect(handler, recorder, commandPayload('summary', [], { channelId: null }));

    expect(content).toContain('频道');
    expect(spy.summaryCalls).toHaveLength(0);
    expect(spy.viewCalls).toHaveLength(0);
  });
});
