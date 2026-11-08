/**
 * §18.6 网关侧：回复链（referenced_message → TurnContext.replyTo / 落库 replyTo）+ 贴表情。
 *
 * 装配沿用 ./gateway.record.test.ts：FakeWebSocket 把 MESSAGE_CREATE 帧灌进 #dispatch，
 * ctx.waitUntil 里的 promise 收集起来等它跑完。两处不同：
 *   1. chat service 与 repository 换成桩 —— 要断言的是 TurnContext 与 ChatMessage 的形状，
 *      真跑模型与 D1 只会让用例变脆；
 *   2. globalThis.fetch 换成按 URL 分派的捕获桩 —— 贴表情到底打没打、打了几次、URL 长什么样。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatServiceDeps } from '../src/core/chat/service';
import type {
  ChatMessage,
  EmojiAlias,
  EmojiDescription,
  ReactionModelConfig,
  ReactionRequest,
  TurnContext,
  TurnResult,
} from '../src/core/types';
import { DEFAULT_API_BASE, addMessageReaction, listGuildEmojis } from '../src/workers/discord/rest';
import type { GatewayEnv } from '../src/workers/gateway/durable-object';

const BOT_ID = '150000000000000001';
/** 服务器频道里每条回复开头的 @ 提问者：就是 channelPayload 的 author.id */
const ASKER_MENTION = '<@user-1> ';
// createSecretBox 要求 32 字节 base64；这两条路径只用它构造成功，不做加解密
const SECRET = btoa('k'.repeat(32));
const MESSAGES_URL = DEFAULT_API_BASE + '/channels/chan-1/messages';
// §28.4：清单走的正是这条（GET + ?limit=10）
const MESSAGES_LIST_URL = MESSAGES_URL + '?limit=10';
const EMOJIS_URL = DEFAULT_API_BASE + '/guilds/guild-1/emojis';

interface AppendCall {
  key: { guildId: string; channelId: string };
  messages: ChatMessage[];
}

/** vi.mock 的工厂会被提升到 import 之前，共享状态只能走 vi.hoisted */
const stub = vi.hoisted<{
  contexts: TurnContext[];
  appends: AppendCall[];
  text: string;
  /** §28：TurnResult.reactions 现在是 ReactionRequest[]，不再是一串字符串 */
  reactions: ReactionRequest[];
  runError: Error | null;
  /** createChatService 收到的依赖：用来断言 DO 把仓储里的 reactionModels 真的透传下去了（§21.3） */
  chatDeps: ChatServiceDeps[];
  /** 表情模型配置仓储的读数（§21.5）；null = 未配置 */
  reactionModel: ReactionModelConfig | null;
  /** 密钥仓储收到的 listEnabled 查询：本案里该供应商一把可用 Key 都没有 */
  keyQueries: string[];
  /** §23.7：表情描述表里已有的行（仓储桩的返回值） */
  emojiRows: EmojiDescription[];
  /** 描述仓储收到的 list(guildId)：断言「并进缓存、不每消息一条查询」 */
  emojiQueries: string[];
  /** §24.7：别名表里已有的行 */
  aliasRows: EmojiAlias[];
  /** 别名仓储收到的 list(guildId)：断言与描述同一次装配、同样只读一次 */
  aliasQueries: string[];
  /** 非 null 时别名仓储直接抛错：验证「读别名失败只降级」 */
  aliasError: Error | null;
  /** 频道层语音开关：null = 三层都没配（= 不念）；1 = 按指令，2 = 每条都念，0 = 不念 */
  voiceMode: number | null;
}>(() => ({
  contexts: [],
  appends: [],
  text: '好的',
  reactions: [],
  runError: null,
  chatDeps: [],
  reactionModel: null,
  keyQueries: [],
  emojiRows: [],
  emojiQueries: [],
  aliasRows: [],
  aliasQueries: [],
  aliasError: null,
  voiceMode: null,
}));

vi.mock('../src/core/chat/service', () => ({
  createChatService: (deps: ChatServiceDeps) => {
    stub.chatDeps.push(deps);
    return {
      run: (ctx: TurnContext): Promise<TurnResult> => {
        stub.contexts.push(ctx);
        if (stub.runError !== null) return Promise.reject(stub.runError);
        return Promise.resolve({
          text: stub.text,
          model: { provider: 'openai-compat', model: 'stub' },
          attempts: [],
          promptScope: 'global',
          routeScope: 'global',
          reactions: stub.reactions,
        });
      },
      reset: (): Promise<void> => Promise.resolve(),
    };
  },
}));

vi.mock('../src/workers/db/d1-repository', () => ({
  createRepositories: () => ({
    conversations: {
      append: (key: { guildId: string; channelId: string }, messages: ChatMessage[]): Promise<void> => {
        stub.appends.push({ key, messages });
        return Promise.resolve();
      },
    },
    // §21.3：表情模型仓储由 createRepositories 自动注入，DO 这边只是 ... 展开，没有第二处接线
    reactionModels: {
      get: (): Promise<ReactionModelConfig | null> => Promise.resolve(stub.reactionModel),
      put: (): Promise<void> => Promise.resolve(),
    },
    // 该供应商一把可用 Key 都没有的密钥仓储：表情模型这一步必须安全降级（§21.4）
    keys: {
      listEnabled: (provider: string): Promise<never[]> => {
        stub.keyQueries.push(provider);
        return Promise.resolve([]);
      },
    },
    // §23.7：表情描述只读这一处（D1 表），写入由认图执行器负责，桩直接记调用
    emojiDescriptions: {
      list: (guildId: string): Promise<EmojiDescription[]> => {
        stub.emojiQueries.push(guildId);
        return Promise.resolve([...stub.emojiRows]);
      },
      putMany: (): Promise<void> => Promise.resolve(),
    },
    // §24.7：别名与描述同在一次装配里读，桩只记账 + 供数据
    emojiAliases: {
      list: (guildId: string): Promise<EmojiAlias[]> => {
        stub.aliasQueries.push(guildId);
        if (stub.aliasError !== null) return Promise.reject(stub.aliasError);
        return Promise.resolve([...stub.aliasRows]);
      },
      put: (): Promise<void> => Promise.resolve(),
      remove: (): Promise<void> => Promise.resolve(),
    },
    // 语音三层开关：只有频道层命中，其余两层读回 null —— 与线上「频道单独设了 1」一致
    voiceSettings: {
      get: (layer: { scope: string; scopeId: string }) =>
        Promise.resolve(
          stub.voiceMode === null || layer.scope !== 'channel'
            ? null
            : {
                scope: 'channel' as const,
                scopeId: layer.scopeId,
                mode: stub.voiceMode,
                voice: '',
                speed: 100,
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
        ),
    },
  }),
}));

/**
 * pool-workers 的 setup 会 import worker 入口（src/workers/index.ts），durable-object 模块在那时
 * 就带着真依赖缓存下来了 —— 静态 import 拿到的正是那一份，本文件的 vi.mock 对它无效。
 * 先 resetModules 再动态 import，DO 才会在「mock 已注册」的模块图里重新求值。
 */
let gateway: typeof import('../src/workers/gateway/durable-object');

beforeAll(async () => {
  vi.resetModules();
  gateway = await import('../src/workers/gateway/durable-object');
});

// -------------------------------------------------------------- 捕获桩

interface Captured {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

function readHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (init?.headers === undefined) return out;
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function jsonBody(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

type Responder = (method: string, url: string) => Response | undefined;

/** 没被 responder 接手的请求一律成功：取名与「发消息」这类调用只用 res.ok 判定 */
function stubFetch(calls: Captured[], responder?: Responder): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null, headers: readHeaders(init) });
    const custom = responder?.(method, url);
    if (custom !== undefined) return Promise.resolve(custom);
    if (url.endsWith('/typing')) return Promise.resolve(new Response(null, { status: 204 }));
    // §62：回复改成 createMessage（?wait=true 要回消息 id），桩给个 id 让发送算成功
    if (method === 'POST' && url.startsWith(MESSAGES_URL)) return Promise.resolve(jsonBody({ id: 'mid-9' }));
    return Promise.resolve(jsonBody({}));
  };
}

function reactionCalls(calls: Captured[]): Captured[] {
  return calls.filter((call) => call.method === 'PUT' && call.url.includes('/reactions/'));
}

function messageCalls(calls: Captured[]): Captured[] {
  // §62 起整段发送走 createMessage（?wait=true），两种 URL 都算发了一条
  return calls.filter((call) => call.method === 'POST' && (call.url === MESSAGES_URL || call.url === MESSAGES_URL + '?wait=true'));
}

function emojiCalls(calls: Captured[]): Captured[] {
  return calls.filter((call) => call.method === 'GET' && call.url === EMOJIS_URL);
}

// -------------------------------------------------------------- DO 装配

interface FakeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

function createFakeStorage(): FakeStorage {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async getAlarm(): Promise<number | null> {
      return null;
    },
    async setAlarm(): Promise<void> {},
  };
}

/** DO 的 #connect 会 new WebSocket(...)：这里只截住实例与监听器，绝不出网 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  binaryType = 'blob';

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

interface Harness {
  presence: InstanceType<typeof import('../src/workers/gateway/durable-object').GatewayPresence>;
  /** ctx.waitUntil 收到的 promise：#handleMessage 在这里面跑完 */
  pending: Promise<unknown>[];
}

function createHarness(env: Partial<GatewayEnv> = {}): Harness {
  const pending: Promise<unknown>[] = [];
  const state = {
    storage: createFakeStorage(),
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  } as unknown as DurableObjectState;
  const presence = new gateway.GatewayPresence(state, {
    DISCORD_BOT_TOKEN: 'tok',
    DISCORD_APPLICATION_ID: BOT_ID,
    KEY_ENCRYPTION_SECRET: SECRET,
    // createRepositories 是桩，这个 DB 只用来过「有没有绑定」的检查
    DB: {} as unknown as D1Database,
    ...env,
  });
  return { presence, pending };
}

async function flush(times = 24): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 先把 socket 建起来（只走 #ensure → #connect，无出网），再灌一帧 MESSAGE_CREATE 进 #handleMessage。
 * 只负责「让消息跑起来」，不 flush 也不等 waitUntil：#handleMessage 的 promise 会落在 harness.pending 里，
 * 要证明「回复不等后台任务」的用例必须用它，否则一 await 就把后台补认也等完了。
 */
async function dispatchFrame(harness: Harness, raw: unknown): Promise<void> {
  const ensureUrl = gateway.GATEWAY_INTERNAL_ORIGIN + gateway.GATEWAY_ENSURE_PATH;
  await harness.presence.fetch(new Request(ensureUrl, { method: 'POST' }));
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (socket === undefined) throw new Error('前置失败：没有建立 WebSocket');
  for (const listener of socket.listeners.get('message') ?? []) {
    listener({ data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: raw }) });
  }
}

/** 灌帧并等这条消息（含 waitUntil 里的一切）彻底跑完 */
async function dispatchMessage(harness: Harness, raw: unknown): Promise<void> {
  await dispatchFrame(harness, raw);
  await flush();
  await Promise.all(harness.pending);
}

function channelPayload(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    channel_id: 'chan-1',
    guild_id: 'guild-1',
    content,
    author: { id: 'user-1', username: 'alice', global_name: 'Alice', bot: false },
    mentions: [],
    ...overrides,
  };
}

function mentionPayload(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return channelPayload('<@' + BOT_ID + '> ' + content, { mentions: [{ id: BOT_ID }], ...overrides });
}

const REFERENCED = {
  id: 'msg-0',
  author: { id: 'user-2', username: 'bob', global_name: 'Bob' },
  content: '上一条原文',
};

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  stub.contexts.length = 0;
  stub.appends.length = 0;
  stub.text = '好的';
  stub.reactions = [];
  stub.runError = null;
  stub.chatDeps.length = 0;
  stub.reactionModel = null;
  stub.keyQueries.length = 0;
  stub.emojiRows = [];
  stub.emojiQueries.length = 0;
  stub.aliasRows = [];
  stub.aliasQueries.length = 0;
  stub.aliasError = null;
  stub.voiceMode = null;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DO 回复链：referenced_message → TurnContext.replyTo', () => {
  it('@bot 且带 referenced_message：replyTo 与 customEmojis 都被注入，回复照旧发出', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) => {
        if (method === 'GET' && url === EMOJIS_URL) {
          return jsonBody([
            { id: '111', name: 'blob', available: true },
            { id: '222', name: 'gone', available: false, animated: true },
            { id: '333', name: 'dance', available: true, animated: true },
          ]);
        }
        return undefined;
      }),
    );

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('接着说', { referenced_message: REFERENCED }));

    expect(stub.contexts).toHaveLength(1);
    const context = stub.contexts[0];
    expect(context.replyTo).toEqual({ messageId: 'msg-0', author: 'Bob', authorId: 'user-2', content: '上一条原文' });
    // available:false 的项不进清单；animated 只在为真时才出现
    expect(context.customEmojis).toEqual([
      { name: 'blob', id: '111' },
      { name: 'dance', id: '333', animated: true },
    ]);
    const sent = messageCalls(calls);
    expect(sent).toHaveLength(1);
    // 服务器频道：正文头顶一个 @ 提问者，allowed_mentions 只解析用户
    expect(JSON.parse(String(sent[0]?.body))).toEqual({
      content: ASKER_MENTION + '好的',
      allowed_mentions: { parse: ['users'] },
    });
  });

  it('被回复者设了服务器昵称：member.nick 进 replyTo（§60）', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    const harness = createHarness();
    await dispatchMessage(
      harness,
      mentionPayload('嗯', { referenced_message: { ...REFERENCED, member: { nick: '示例角色' } } }),
    );

    expect(stub.contexts[0]?.replyTo?.author).toBe('示例角色');
  });

  it('回复的正是机器人自己：署名换成「你自己」，不再出现账号名（§60）', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    const harness = createHarness();
    await dispatchMessage(
      harness,
      mentionPayload('什么鲸鱼？', {
        referenced_message: { id: 'msg-bot', author: { id: BOT_ID, username: '示例机器人' }, content: '好了啦 没事' },
      }),
    );

    expect(stub.contexts[0]?.replyTo).toEqual({
      messageId: 'msg-bot',
      author: '你自己',
      authorId: BOT_ID,
      content: '好了啦 没事',
    });
  });

  it('不是回复的 @bot 消息：TurnContext 上连 replyTo 键都没有', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    expect(stub.contexts).toHaveLength(1);
    expect('replyTo' in (stub.contexts[0] as TurnContext)).toBe(false);
    // 服务器表情清单为空时不注入，提示词里也就没有表情段
    expect(stub.contexts[0]?.customEmojis).toBeUndefined();
  });

  it('未 @ 的普通发言落库：replyTo 四值与解析结果一致，且不调模型也不发消息', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === EMOJIS_URL ? jsonBody([{ id: '111', name: 'blob', available: true }]) : undefined,
      ),
    );

    const harness = createHarness();
    await dispatchMessage(harness, channelPayload('今晚有人打排位吗', { referenced_message: REFERENCED }));

    expect(stub.contexts).toHaveLength(0);
    expect(stub.appends).toHaveLength(1);
    const row = stub.appends[0]?.messages[0];
    expect(row?.content).toBe('今晚有人打排位吗');
    expect(row?.replyTo).toEqual({ messageId: 'msg-0', author: 'Bob', authorId: 'user-2', content: '上一条原文' });
    expect(messageCalls(calls)).toHaveLength(0);
    // 不回复的路径压根不取表情清单
    expect(emojiCalls(calls)).toHaveLength(0);
  });

  it('未 @ 且不是回复：落库的行里没有 replyTo 键（老数据口径一致）', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    const harness = createHarness();
    await dispatchMessage(harness, channelPayload('随便聊聊'));

    const row = stub.appends[0]?.messages[0];
    expect(row?.content).toBe('随便聊聊');
    expect(row !== undefined && 'replyTo' in row).toBe(false);
  });
});

describe('DO 贴表情：result.reactions → 触发消息上的 reaction', () => {
  it("unicode 表情原样用：PUT .../reactions/%F0%9F%91%8D/@me，无 body", async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls));
    stub.reactions = [{ emoji: '👍' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('给你点个赞'));

    const reactions = reactionCalls(calls);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.url).toBe(MESSAGES_URL + '/msg-1/reactions/%F0%9F%91%8D/@me');
    expect(reactions[0]?.method).toBe('PUT');
    expect(reactions[0]?.body).toBeNull();
    expect(reactions[0]?.headers.authorization).toBe('Bot tok');
    // 回复先发出去，再说贴表情
    expect(messageCalls(calls)).toHaveLength(1);
  });

  it('多个表情逐个贴，顺序与 result.reactions 一致', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls));
    stub.reactions = [{ emoji: '👍' }, { emoji: '🎉' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('庆祝一下'));

    expect(reactionCalls(calls).map((call) => call.url)).toEqual([
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%91%8D/@me',
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%8E%89/@me',
    ]);
  });

  it(':name: 命中当轮清单 → name:id；未命中 → 跳过且不发请求', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === EMOJIS_URL ? jsonBody([{ id: '123', name: 'blob', available: true }]) : undefined,
      ),
    );
    stub.reactions = [{ emoji: ':blob:' }, { emoji: ':missing:' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('贴个表情'));

    const reactions = reactionCalls(calls);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.url).toBe(MESSAGES_URL + '/msg-1/reactions/blob%3A123/@me');
  });

  it('贴表情失败只 warn：回复照样发出去，用例也不炸', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'PUT' && url.includes('/reactions/') ? new Response('Missing Access', { status: 403 }) : undefined,
      ),
    );
    stub.reactions = [{ emoji: '👍' }];

    const harness = createHarness();
    await expect(dispatchMessage(harness, mentionPayload('点个赞'))).resolves.toBeUndefined();

    expect(reactionCalls(calls)).toHaveLength(1);
    expect(messageCalls(calls)).toHaveLength(1);
  });

  it('模型失败（run 抛错）：用错误文本回复，且一个表情都不贴', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls));
    stub.runError = new Error('ALL_PROVIDERS_FAILED');

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    expect(reactionCalls(calls)).toHaveLength(0);
    const sent = messageCalls(calls);
    expect(sent).toHaveLength(1);
    expect(String(JSON.parse(String(sent[0]?.body)).content)).toContain('回复生成失败');
  });
});

describe('§28 贴表情：一次多个 + 指定目标消息', () => {
  /** Discord 的 GET /channels/{id}/messages 回包：新的在前，字段与真实回包同形 */
  function messageRow(
    id: string,
    authorId: string,
    author: string,
    content: string,
    bot = false,
  ): Record<string, unknown> {
    return {
      id,
      channel_id: 'chan-1',
      content,
      author: { id: authorId, username: author, global_name: author, bot },
    };
  }

  const ROWS = [
    messageRow('msg-1', 'user-1', 'Alice', '给我贴大量的emoji'),
    messageRow('msg-2', 'user-2', 'Bob', '看这条'),
    messageRow('msg-3', 'user-3', 'Carol', '还有这条'),
  ];

  function listResponder(rows: Record<string, unknown>[]): Responder {
    return (method, url) => (method === 'GET' && url === MESSAGES_LIST_URL ? jsonBody(rows) : undefined);
  }

  function listCalls(calls: Captured[]): Captured[] {
    return calls.filter((call) => call.method === 'GET' && call.url === MESSAGES_LIST_URL);
  }

  it('多个表情都没带目标：全部贴在触发那条，不再替模型分散到别人身上', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, listResponder(ROWS)));
    stub.reactions = [{ emoji: '👍' }, { emoji: '🎉' }, { emoji: '😄' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('贴几个'));

    // §28.10：没点名 @all 就一条都不分配——三个表情都在触发那条（Alice）上
    expect(reactionCalls(calls).map((call) => call.url)).toEqual([
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%91%8D/@me',
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%8E%89/@me',
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%98%84/@me',
    ]);
    // 清单只在 #handleMessage 里组装一次：一轮一个 REST 请求，不随表情个数增长
    expect(listCalls(calls)).toHaveLength(1);
    expect(stub.contexts[0]?.reactionTargets).toEqual([
      { messageId: 'msg-1', author: 'Alice', authorId: 'user-1', excerpt: '给我贴大量的emoji', bot: false },
      { messageId: 'msg-2', author: 'Bob', authorId: 'user-2', excerpt: '看这条', bot: false },
      { messageId: 'msg-3', author: 'Carol', authorId: 'user-3', excerpt: '还有这条', bot: false },
    ]);
  });

  it('点名 @all：按聊天记录里最近说过话的次序一人一条，机器人自己的消息跳过', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(
        calls,
        listResponder([
          messageRow('msg-1', 'user-1', 'Alice', '谢谢'),
          messageRow('msg-7', 'bot-9', '示例角色', '我的上一条回复', true),
          messageRow('msg-2', 'user-2', 'Bob', '看这条'),
        ]),
      ),
    );
    stub.reactions = [
      { emoji: '👍', broadcast: true },
      { emoji: '🎉', broadcast: true },
    ];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('给大家都贴一个'));

    // 每个 @all 表情都按「最近说过话的人各一条」展开：两个表情 × 两个真人 = 四条，
    // msg-7 是机器人自己的消息，不进池子（所以 Alice 与 Bob 各拿到两个）
    expect(reactionCalls(calls).map((call) => call.url)).toEqual([
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%91%8D/@me',
      MESSAGES_URL + '/msg-2/reactions/%F0%9F%91%8D/@me',
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%8E%89/@me',
      MESSAGES_URL + '/msg-2/reactions/%F0%9F%8E%89/@me',
    ]);
    expect(stub.contexts[0]?.reactionTargets?.[1]?.bot).toBe(true);
  });

  it('线上那种情况：模型连着给同一个人点三次，就贴在那一人身上，不再替它挪到别人身上', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, listResponder(ROWS)));
    // 2026-10-27 生产日志：主模型三条都写 @Alice——现在照它的意思贴，不重分配
    stub.reactions = [
      { emoji: '😄', authorName: 'Alice' },
      { emoji: '🎉', authorName: 'Alice' },
      { emoji: '❤️', authorName: 'Alice' },
    ];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('给我们都贴上表情'));

    expect(reactionCalls(calls).map((call) => call.url)).toEqual([
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%98%84/@me',
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%8E%89/@me',
      MESSAGES_URL + '/msg-1/reactions/%E2%9D%A4%EF%B8%8F/@me',
    ]);
  });

  it('带 messageId 的目标：贴到清单里那条指定的消息，而不是触发那条', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, listResponder(ROWS)));
    stub.reactions = [{ emoji: '👍', messageId: 'msg-2' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('贴给 Bob'));

    const reactions = reactionCalls(calls);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.url).toBe(MESSAGES_URL + '/msg-2/reactions/%F0%9F%91%8D/@me');
  });

  it('带 authorName 的目标：贴到该作者最新一条（大小写不敏感）', async () => {
    const calls: Captured[] = [];
    // Bob 在清单里出现两次（msg-2 是新的那条）：必须取新→旧顺序里第一个命中的
    vi.stubGlobal(
      'fetch',
      stubFetch(
        calls,
        listResponder([
          messageRow('msg-1', 'user-1', 'Alice', '给我贴'),
          messageRow('msg-2', 'user-2', 'Bob', '新的一条'),
          messageRow('msg-5', 'user-2', 'Bob', '旧的一条'),
          messageRow('msg-6', 'user-3', 'Carol', '别人的'),
        ]),
      ),
    );
    stub.reactions = [{ emoji: '🎉', authorName: 'BOB' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('贴给 Bob'));

    const reactions = reactionCalls(calls);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.url).toBe(MESSAGES_URL + '/msg-2/reactions/%F0%9F%8E%89/@me');
  });

  it('目标不在清单里：跳过该条并 warn（脱敏），其余表情照贴', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, listResponder(ROWS)));
    stub.reactions = [
      { emoji: '👍', messageId: 'msg-999' },
      { emoji: '❤️', authorName: 'nobody' },
      { emoji: '🎉' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('贴一下'));

    // 越界的两条一条请求都不发；没带目标的那条按 §28.9 分给最近说过话的 Alice（触发那条，msg-1）
    expect(reactionCalls(calls).map((call) => call.url)).toEqual([MESSAGES_URL + '/msg-1/reactions/%F0%9F%8E%89/@me']);
    expect(warn).toHaveBeenCalledWith('[gateway] 贴表情目标不在清单里，跳过：messageId=msg-999');
    expect(warn).toHaveBeenCalledWith('[gateway] 贴表情目标不在清单里，跳过：authorName=nobody');
    // 脱敏：告警里不许出现任何正文
    for (const line of warn.mock.calls) {
      expect(String(line[0])).not.toContain('给我贴大量的emoji');
      expect(String(line[0])).not.toContain('看这条');
    }
    warn.mockRestore();
  });

  it('某条贴失败不影响后续：403 只 warn，后面的表情继续贴', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) => {
        if (method === 'GET' && url === MESSAGES_LIST_URL) return jsonBody(ROWS);
        if (method === 'PUT' && url.includes('/messages/msg-2/reactions/')) return new Response('Missing Access', { status: 403 });
        return undefined;
      }),
    );
    stub.reactions = [{ emoji: '👍', messageId: 'msg-2' }, { emoji: '🎉' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const harness = createHarness();
    await expect(dispatchMessage(harness, mentionPayload('贴两个'))).resolves.toBeUndefined();

    // 👍 被显式指到 msg-2（403 失败），🎉 按 §28.9 落到最近说过话、还没被占用的 Alice（msg-1）
    expect(reactionCalls(calls).map((call) => call.url)).toEqual([
      MESSAGES_URL + '/msg-2/reactions/%F0%9F%91%8D/@me',
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%8E%89/@me',
    ]);
    expect(warn).toHaveBeenCalledWith('[gateway] 贴表情失败（👍）：discord HTTP 403: Missing Access');
    warn.mockRestore();
  });

  it('读最近消息失败：回复照发，清单退化成「触发 + 被回复」两条', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === MESSAGES_LIST_URL ? new Response('boom', { status: 500 }) : undefined,
      ),
    );
    stub.reactions = [{ emoji: '👍' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const harness = createHarness();
    await expect(
      dispatchMessage(harness, mentionPayload('庆祝一下', { referenced_message: REFERENCED })),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[gateway] 读最近消息失败：discord HTTP 500: boom');
    // 回复照旧发出去，表情贴到触发那条
    expect(messageCalls(calls)).toHaveLength(1);
    expect(reactionCalls(calls).map((call) => call.url)).toEqual([
      MESSAGES_URL + '/msg-1/reactions/%F0%9F%91%8D/@me',
    ]);
    // 退化清单：触发在前，被回复的在后
    expect(stub.contexts[0]?.reactionTargets?.map((target) => target.messageId)).toEqual(['msg-1', 'msg-0']);
    expect(listCalls(calls)).toHaveLength(1);
    warn.mockRestore();
  });

  it('摘录 = 正文前 30 字，换行折成空格', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(
        calls,
        listResponder([
          messageRow('msg-1', 'user-1', 'Alice', '给我贴'),
          messageRow('msg-2', 'user-2', 'Bob', '第一行\n第二行' + '填'.repeat(40)),
        ]),
      ),
    );

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    const excerpt = stub.contexts[0]?.reactionTargets?.[1]?.excerpt ?? '';
    expect(excerpt.startsWith('第一行 第二行')).toBe(true);
    expect(excerpt).not.toContain('\n');
    expect(Array.from(excerpt)).toHaveLength(30);
  });

  it('清单截到 10 条：11 条最近消息 + 触发去重后只留前 10', async () => {
    const calls: Captured[] = [];
    const rows = Array.from({ length: 10 }, (_unused, index) =>
      messageRow('recent-' + String(index), 'user-' + String(index), 'N' + String(index), '第' + String(index)),
    );
    vi.stubGlobal('fetch', stubFetch(calls, listResponder(rows)));

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    const targets = stub.contexts[0]?.reactionTargets ?? [];
    expect(targets).toHaveLength(10);
    expect(targets[0]?.messageId).toBe('recent-0');
    expect(targets[9]?.messageId).toBe('recent-9');
  });
});

describe('DO 表情模型（§21）：普通消息才开 wantReactions，配了也绝不影响回复', () => {
  it('@bot 的普通消息：TurnContext.wantReactions === true，且仓储里的 reactionModels 透传给了 chat service', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls));
    stub.reactionModel = { enabled: true, provider: 'openai-compat', model: 'gpt-x' };

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    expect(stub.contexts).toHaveLength(1);
    expect(stub.contexts[0]?.wantReactions).toBe(true);
    // 接线完全靠 createRepositories 的 ... 展开（DO 里没有第二处手写 reactionModels）
    expect(stub.chatDeps).toHaveLength(1);
    await expect(stub.chatDeps[0]?.reactionModels?.get()).resolves.toEqual({
      enabled: true,
      provider: 'openai-compat',
      model: 'gpt-x',
    });
    expect(messageCalls(calls)).toHaveLength(1);
  });

  it('表情模型开着但没有可用 Key：回复照常发出，只贴主模型决定的那一个表情', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls));
    stub.reactionModel = { enabled: true, provider: 'openai-compat', model: 'gpt-x' };
    // 主模型自己 [[react:]] 决定的那个：表情模型这一路不该再补任何一笔
    stub.reactions = [{ emoji: '👍' }];

    const harness = createHarness();
    await expect(dispatchMessage(harness, mentionPayload('给你点个赞'))).resolves.toBeUndefined();

    // 前提：该供应商一把可用 Key 都没有（服务侧据此直接跳过，不出网）
    await expect(stub.chatDeps[0]?.keys.listEnabled('openai-compat')).resolves.toEqual([]);
    expect(stub.keyQueries).toEqual(['openai-compat']);

    const sent = messageCalls(calls);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]?.body))).toEqual({
      content: ASKER_MENTION + '好的',
      allowed_mentions: { parse: ['users'] },
    });
    // reaction 请求数与主模型的决定一致：只有那一个 👍，没有多贴、也没有贴错
    const reactions = reactionCalls(calls);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.url).toBe(MESSAGES_URL + '/msg-1/reactions/%F0%9F%91%8D/@me');
    expect(stub.contexts[0]?.wantReactions).toBe(true);
  });
});

describe('DO 自定义表情清单：失败不阻断回复，10 分钟内不重复请求', () => {
  it('清单请求失败：回复仍然成功，且 10 分钟内只请求一次', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === EMOJIS_URL ? new Response('Missing Access', { status: 403 }) : undefined,
      ),
    );

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('第一条'));
    await dispatchMessage(harness, mentionPayload('第二条'));

    expect(emojiCalls(calls)).toHaveLength(1);
    expect(stub.contexts).toHaveLength(2);
    // 取不到就是空清单：提示词里不出现表情段
    for (const context of stub.contexts) expect(context.customEmojis).toBeUndefined();
    expect(messageCalls(calls)).toHaveLength(2);
  });

  it('清单请求成功：第二次回复复用缓存，不再打 REST', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === EMOJIS_URL ? jsonBody([{ id: '123', name: 'blob', available: true }]) : undefined,
      ),
    );

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('第一条'));
    await dispatchMessage(harness, mentionPayload('第二条'));

    expect(emojiCalls(calls)).toHaveLength(1);
    expect(stub.contexts[1]?.customEmojis).toEqual([{ name: 'blob', id: '123' }]);
  });

  it('私聊（guild_id 为 null）：不取表情清单，replyTo 仍注入', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls));

    const harness = createHarness();
    await dispatchMessage(harness, channelPayload('私聊说一句', { guild_id: null, referenced_message: REFERENCED }));

    expect(emojiCalls(calls)).toHaveLength(0);
    expect(stub.contexts).toHaveLength(1);
    expect(stub.contexts[0]?.customEmojis).toBeUndefined();
    expect(stub.contexts[0]?.replyTo).toEqual({ messageId: 'msg-0', author: 'Bob', authorId: 'user-2', content: '上一条原文' });
    // 私聊点自己没有意义：正文原样发出，不挂 <@id>
    const sent = messageCalls(calls);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]?.body)).content).toBe('好的');
  });

  it('没有 bot token：#ensure 连 socket 都不建（表情清单自然也不会取）', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls));

    const harness = createHarness({ DISCORD_BOT_TOKEN: '' });
    await harness.presence.fetch(
      new Request(gateway.GATEWAY_INTERNAL_ORIGIN + gateway.GATEWAY_ENSURE_PATH, { method: 'POST' }),
    );

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(emojiCalls(calls)).toHaveLength(0);
  });
});

describe('rest.ts：贴表情与表情清单（§18.6）', () => {
  it('addMessageReaction：PUT /reactions/<encodeURIComponent(emoji)>/@me，无 body', async () => {
    const calls: Captured[] = [];
    await addMessageReaction({ botToken: 'tok', fetch: stubFetch(calls) }, 'chan-1', 'msg-1', '👍');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(DEFAULT_API_BASE + '/channels/chan-1/messages/msg-1/reactions/%F0%9F%91%8D/@me');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toBeNull();
    expect(calls[0]?.headers.authorization).toBe('Bot tok');
  });

  it('addMessageReaction：name:id 里的冒号同样被编码', async () => {
    const calls: Captured[] = [];
    await addMessageReaction({ botToken: 'tok', fetch: stubFetch(calls) }, 'chan-1', 'msg-1', 'blob:123');
    expect(calls[0]?.url).toBe(DEFAULT_API_BASE + '/channels/chan-1/messages/msg-1/reactions/blob%3A123/@me');
  });

  it('addMessageReaction：非 2xx 抛 discord HTTP <status>: <body 前 200 字>', async () => {
    const body = 'x'.repeat(500);
    const fetchStub = stubFetch([], () => new Response(body, { status: 403 }));
    await expect(addMessageReaction({ botToken: 'tok', fetch: fetchStub }, 'chan-1', 'msg-1', '👍')).rejects.toThrow(
      'discord HTTP 403: ' + body.slice(0, 200),
    );
  });

  it('listGuildEmojis：GET /guilds/<id>/emojis，只收 available !== false 且保序', async () => {
    const calls: Captured[] = [];
    const fetchStub = stubFetch(calls, () =>
      jsonBody([
        { id: '1', name: 'blob', available: true },
        { id: '2', name: 'gone', available: false },
        { id: '3', name: 'dance', available: true, animated: true },
        { id: '4', name: 'no-flag' },
        { id: '5' },
        { name: 'no-id' },
        'nope',
      ]),
    );

    const emojis = await listGuildEmojis({ botToken: 'tok', fetch: fetchStub }, 'guild-1');
    expect(emojis).toEqual([
      { name: 'blob', id: '1' },
      { name: 'dance', id: '3', animated: true },
      { name: 'no-flag', id: '4' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EMOJIS_URL);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBe('Bot tok');
  });

  it('listGuildEmojis：失败抛同风格错误', async () => {
    const fetchStub = stubFetch([], () => new Response('boom', { status: 500 }));
    await expect(listGuildEmojis({ botToken: 'tok', fetch: fetchStub }, 'guild-1')).rejects.toThrow(
      'discord HTTP 500: boom',
    );
  });

  it('listGuildEmojis：响应不是数组时按空清单处理', async () => {
    const fetchStub = stubFetch([], () => jsonBody({ message: 'Not Found', code: 0 }));
    await expect(listGuildEmojis({ botToken: 'tok', fetch: fetchStub }, 'guild-1')).resolves.toEqual([]);
  });
});

describe('DO 正文自定义表情：:名字: → <:名字:id>（§18.8）', () => {
  it('命中清单的名字渲染成真表情，未命中的保持原样，且只发一条', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === EMOJIS_URL
          ? jsonBody([
              { id: '123', name: 'blob', available: true },
              { id: '456', name: 'dance', available: true, animated: true },
            ])
          : undefined,
      ),
    );
    stub.text = '好的 :blob: :dance: :missing:';

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('发个表情'));

    const sent = messageCalls(calls);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]?.body)).content).toBe(ASKER_MENTION + '好的 <:blob:123> <a:dance:456> :missing:');
  });
});

describe('DO 图片：带图消息 → TurnContext.loadImages（§22.4/§22.7）', () => {
  const IMAGE_URL = 'https://cdn.test/own.png';
  const REPLY_IMAGE_URL = 'https://cdn.test/reply.jpg';

  function attachment(url: string, contentType: string, size: number): Record<string, unknown> {
    return { url, content_type: contentType, size };
  }

  function imageResponse(values: number[]): Response {
    return new Response(new Uint8Array(values), { status: 200, headers: { 'content-type': 'image/png' } });
  }

  it('带图消息：loadImages 已定义且是懒的，调用后拿到预期的 LlmImage[]', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) => (method === 'GET' && url === IMAGE_URL ? imageResponse([104, 105]) : undefined)),
    );

    const harness = createHarness();
    await dispatchMessage(
      harness,
      mentionPayload('看这张', { attachments: [attachment(IMAGE_URL, 'image/png', 2048)] }),
    );

    expect(stub.contexts).toHaveLength(1);
    const context = stub.contexts[0] as TurnContext;
    expect(context.loadImages).toBeDefined();
    // §22.6.3：表情模型还没轮到之前，一个字节都不该下载
    expect(calls.filter((call) => call.url === IMAGE_URL)).toHaveLength(0);

    const images = context.loadImages === undefined ? [] : await context.loadImages();
    expect(images).toEqual([{ mediaType: 'image/png', base64: 'aGk=' }]);
    // 桩 fetch 返回的假字节原样变成 base64，且只下这一次
    expect(calls.filter((call) => call.url === IMAGE_URL)).toHaveLength(1);
    expect(messageCalls(calls)).toHaveLength(1);
  });

  it('纯文字消息：context 上不存在 loadImages 键（老行为逐字不变）', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    expect(stub.contexts).toHaveLength(1);
    expect('loadImages' in (stub.contexts[0] as TurnContext)).toBe(false);
  });

  it('自己 + 被回复消息各一张图：顺序是自己在前，两张都下载成功', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) => {
        if (method !== 'GET') return undefined;
        if (url === IMAGE_URL) return imageResponse([104, 105]);
        if (url === REPLY_IMAGE_URL) return imageResponse([1, 2, 3]);
        return undefined;
      }),
    );

    const harness = createHarness();
    await dispatchMessage(
      harness,
      mentionPayload('这两张', {
        attachments: [attachment(IMAGE_URL, 'image/png', 2048)],
        referenced_message: { ...REFERENCED, attachments: [attachment(REPLY_IMAGE_URL, 'image/jpeg', 4096)] },
      }),
    );

    const context = stub.contexts[0] as TurnContext;
    const images = context.loadImages === undefined ? [] : await context.loadImages();
    expect(images.map((image) => image.mediaType)).toEqual(['image/png', 'image/jpeg']);
    expect(images[0]?.base64).toBe('aGk=');
    expect(images[1]?.base64).toBe(btoa(String.fromCharCode(1, 2, 3)));
  });

  it('下载失败不拖垮回复：图片缺席，正文照发且只 warn', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === IMAGE_URL ? new Response('boom', { status: 500 }) : undefined,
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const harness = createHarness();
    await dispatchMessage(
      harness,
      mentionPayload('看这张', { attachments: [attachment(IMAGE_URL, 'image/png', 2048)] }),
    );

    const context = stub.contexts[0] as TurnContext;
    const images = context.loadImages === undefined ? [] : await context.loadImages();
    expect(images).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[gateway] 图片下载失败：' + IMAGE_URL);
    expect(messageCalls(calls)).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('DO 表情描述（§23.7）：并进清单缓存，缺描述的后台补认不拦回复', () => {
  const CDN_PREFIX = 'https://cdn.discordapp.com/emojis/';

  function cdnCalls(calls: Captured[]): Captured[] {
    return calls.filter((call) => call.method === 'GET' && call.url.startsWith(CDN_PREFIX));
  }

  function pngBytes(values: number[]): Response {
    return new Response(new Uint8Array(values), { status: 200, headers: { 'content-type': 'image/png' } });
  }

  it('D1 里有描述：合并进 TurnContext.customEmojis，且描述只读一次（并进 10 分钟缓存）', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) =>
        method === 'GET' && url === EMOJIS_URL
          ? jsonBody([
              { id: '111', name: 'laugh', available: true },
              { id: '222', name: 'wow', available: true, animated: true },
            ])
          : undefined,
      ),
    );
    stub.emojiRows = [
      { emojiId: '111', name: 'laugh', description: '黄脸咧嘴大笑', updatedAt: '2026-10-26T00:00:00.000Z' },
      { emojiId: '222', name: 'wow', description: '瞪眼张嘴', updatedAt: '2026-10-26T00:00:00.000Z' },
    ];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('第一条'));
    await dispatchMessage(harness, mentionPayload('第二条'));

    expect(stub.contexts[0]?.customEmojis).toEqual([
      { name: 'laugh', id: '111', description: '黄脸咧嘴大笑' },
      { name: 'wow', id: '222', animated: true, description: '瞪眼张嘴' },
    ]);
    // 描述跟着清单一起进了 10 分钟缓存：第二条消息既不读 D1、也不重打 REST、更不排补认
    expect(stub.emojiQueries).toEqual(['guild-1']);
    expect(emojiCalls(calls)).toHaveLength(1);
    expect(cdnCalls(calls)).toHaveLength(0);
  });

  it('清单里有表情缺描述：waitUntil 里只排一次后台补认，回复不等它', async () => {
    const calls: Captured[] = [];
    stub.reactionModel = { enabled: true, provider: 'openai-compat', model: 'gpt-x' };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gateSettled = false;
    const base = stubFetch(calls, (method, url) =>
      method === 'GET' && url === EMOJIS_URL ? jsonBody([{ id: '333', name: 'dance', available: true }]) : undefined,
    );
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith(CDN_PREFIX)) return base(input, init);
      calls.push({ method: 'GET', url, body: null, headers: {} });
      return gate.then(() => {
        gateSettled = true;
        return pngBytes([1, 2, 3]);
      });
    });

    const harness = createHarness();
    await dispatchFrame(harness, mentionPayload('跳一个'));
    await flush();

    // 补认确实被排进了 waitUntil：第二次取清单 + 一次表情原图下载（此刻正卡在 gate 上）
    expect(emojiCalls(calls)).toHaveLength(2);
    expect(cdnCalls(calls)).toHaveLength(1);
    // 而回复早就发出去了：gate 还没放行，说明它没有等补认
    expect(gateSettled).toBe(false);
    expect(stub.contexts[0]?.customEmojis).toEqual([{ name: 'dance', id: '333' }]);
    expect(messageCalls(calls)).toHaveLength(1);

    release();
    await flush();
    await Promise.all(harness.pending);

    // 只排过一次：放行后不会再多一轮下载
    expect(gateSettled).toBe(true);
    expect(cdnCalls(calls)).toHaveLength(1);
    expect(emojiCalls(calls)).toHaveLength(2);
  });
});

describe('DO 表情别名（§24.7）：并进清单缓存，读失败只降级', () => {
  const LAUGH_ID = '150000000000000003';
  const STAMP = '2026-10-26T00:00:00.000Z';
  const CATALOG_ROWS = [
    { id: LAUGH_ID, name: 'laugh', available: true },
    { id: '222', name: 'wow', available: true, animated: true },
  ];

  function emojiResponder(method: string, url: string): Response | undefined {
    return method === 'GET' && url === EMOJIS_URL ? jsonBody(CATALOG_ROWS) : undefined;
  }

  it('按 emojiId 挂到对应表情上（与描述同一次装配），两条消息只读一次 D1', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, emojiResponder));
    stub.emojiRows = [
      { emojiId: LAUGH_ID, name: 'laugh', description: '黄色胖角色站立掐腰', updatedAt: STAMP },
      { emojiId: '222', name: 'wow', description: '瞪眼张嘴', updatedAt: STAMP },
    ];
    stub.aliasRows = [{ alias: '奶龙', emojiId: LAUGH_ID, emojiName: 'laugh' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('第一条'));
    await dispatchMessage(harness, mentionPayload('第二条'));

    expect(stub.contexts[0]?.customEmojis).toEqual([
      { name: 'laugh', id: LAUGH_ID, description: '黄色胖角色站立掐腰', aliases: ['奶龙'] },
      { name: 'wow', id: '222', animated: true, description: '瞪眼张嘴' },
    ]);
    // 别名跟描述一起进了 10 分钟缓存：第二条消息既不读 D1 也不重打 REST
    expect(stub.aliasQueries).toEqual(['guild-1']);
    expect(stub.emojiQueries).toEqual(['guild-1']);
    expect(emojiCalls(calls)).toHaveLength(1);
  });

  it('别名指向的表情不在清单里：就地丢弃，不给任何表情挂空数组', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, emojiResponder));
    stub.emojiRows = [
      { emojiId: LAUGH_ID, name: 'laugh', description: '黄色胖角色站立掐腰', updatedAt: STAMP },
    ];
    stub.aliasRows = [{ alias: '奶龙', emojiId: '999', emojiName: 'ghost' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('第一条'));

    const catalog = stub.contexts[0]?.customEmojis ?? [];
    expect(catalog).toHaveLength(2);
    for (const emoji of catalog) expect('aliases' in emoji).toBe(false);
    expect(messageCalls(calls)).toHaveLength(1);
  });

  it('读别名失败只 warn：描述照旧生效，回复照常发出', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, emojiResponder));
    stub.emojiRows = [
      { emojiId: LAUGH_ID, name: 'laugh', description: '黄色胖角色站立掐腰', updatedAt: STAMP },
      { emojiId: '222', name: 'wow', description: '瞪眼张嘴', updatedAt: STAMP },
    ];
    stub.aliasError = new Error('D1 down');
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const harness = createHarness();
    await expect(dispatchMessage(harness, mentionPayload('第一条'))).resolves.toBeUndefined();

    expect(stub.contexts[0]?.customEmojis).toEqual([
      { name: 'laugh', id: LAUGH_ID, description: '黄色胖角色站立掐腰' },
      { name: 'wow', id: '222', animated: true, description: '瞪眼张嘴' },
    ]);
    expect(warn).toHaveBeenCalledWith('[emoji] 读别名失败：D1 down');
    expect(messageCalls(calls)).toHaveLength(1);
    warn.mockRestore();
  });

  it('别名一路到线缆：正文 :奶龙: 与 [[react:奶龙]] 都换成真的 laugh:id', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, emojiResponder));
    stub.emojiRows = [
      { emojiId: LAUGH_ID, name: 'laugh', description: '黄色胖角色站立掐腰', updatedAt: STAMP },
      { emojiId: '222', name: 'wow', description: '瞪眼张嘴', updatedAt: STAMP },
    ];
    stub.aliasRows = [{ alias: '奶龙', emojiId: LAUGH_ID, emojiName: 'laugh' }];
    stub.text = '好的 :奶龙:';
    stub.reactions = [{ emoji: '奶龙' }];

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('贴个奶龙'));

    const sent = messageCalls(calls);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]?.body)).content).toBe(ASKER_MENTION + '好的 <:laugh:' + LAUGH_ID + '>');
    const reactions = reactionCalls(calls);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.url).toBe(MESSAGES_URL + '/msg-1/reactions/laugh%3A' + LAUGH_ID + '/@me');
  });
});

describe('DO 语音提示：只有「按指令」模式（mode 1）才挂 TurnContext.voiceHint', () => {
  it('频道层 mode = 1 → 这一轮挂 voiceHint: true（提示词因此多出【语音】那段）', async () => {
    vi.stubGlobal('fetch', stubFetch([]));
    stub.voiceMode = 1;

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    expect(stub.contexts).toHaveLength(1);
    expect(stub.contexts[0]?.voiceHint).toBe(true);
  });

  it('mode = 2（每条都念）与 mode = 0（不念）都不挂这个键：提示段整段不出现', async () => {
    for (const mode of [2, 0]) {
      vi.stubGlobal('fetch', stubFetch([]));
      stub.voiceMode = mode;
      stub.contexts.length = 0;

      const harness = createHarness();
      await dispatchMessage(harness, mentionPayload('在吗'));

      expect(stub.contexts).toHaveLength(1);
      expect('voiceHint' in (stub.contexts[0] as TurnContext)).toBe(false);
    }
  });

  it('三层都没配 → 连键都没有，普通消息的提示词与前一版逐字相同', async () => {
    vi.stubGlobal('fetch', stubFetch([]));

    const harness = createHarness();
    await dispatchMessage(harness, mentionPayload('在吗'));

    expect(stub.contexts).toHaveLength(1);
    expect('voiceHint' in (stub.contexts[0] as TurnContext)).toBe(false);
  });
});

