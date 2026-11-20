import { describe, expect, it } from 'vitest';
import type { ChatService } from '../src/core/chat/service';
import type {
  ConversationDirectory,
  ConversationStore,
  QQPresetStore,
  QqQuoteEntry,
  QqQuoteIndex,
  QqQuoteKey,
  QqQuoteScope,
} from '../src/core/ports';
import type {
  ChatMessage,
  ConversationLinkInput,
  ConversationRecord,
  PromptConfig,
  QQPreset,
  TurnContext,
  TurnResult,
} from '../src/core/types';
import {
  QQ_BOT_NAME,
  QQ_C2C_GUILD_ID,
  QQ_C2C_NAME,
  QQ_FAILURE_TEXT,
  QQ_GROUP_GUILD_ID,
  QQ_GROUP_NAME,
  QQ_IMAGE_NOTE,
  createQqGateway,
  type QqGateway,
  type QqSocket,
} from '../src/node/qq/index';
import {
  QQ_API_BASE,
  QQ_C2C_EVENT,
  QQ_GROUP_EVENT,
  QQ_GROUP_FULL_EVENT,
  QQ_INTENTS,
  QQ_REPLY_CHUNK_MAX,
  QQ_TOKEN_URL,
} from '../src/node/qq/protocol';

const TOKEN = 'TEST-TOKEN';
const GATEWAY_URL = 'wss://gateway.test/ws';

/** 假 socket：不连网，帧都留在 sent 里给断言看 */
class FakeSocket implements QqSocket {
  readonly url: string;
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  #open: () => void = () => {};
  #message: (data: string) => void = () => {};
  #close: (code: number, reason: string) => void = () => {};
  #error: (message: string) => void = () => {};

  constructor(url: string) {
    this.url = url;
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code, reason };
    this.#close(code ?? 1000, reason ?? '');
  }

  onOpen(handler: () => void): void {
    this.#open = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.#close = handler;
  }

  onError(handler: (message: string) => void): void {
    this.#error = handler;
  }

  emitOpen(): void {
    this.#open();
  }

  emitMessage(frame: unknown): void {
    this.#message(JSON.stringify(frame));
  }

  emitClose(code = 1006, reason = ''): void {
    this.#close(code, reason);
  }

  emitError(message: string): void {
    this.#error(message);
  }
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeRecord(presetId: string | null = null): ConversationRecord {
  return {
    id: 'conversation-1',
    name: 'QQ 会话',
    presetId,
    memoryGuildId: 'memory-guild',
    memoryChannelId: 'memory-channel',
    links: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function makePreset(id: string, config: PromptConfig): QQPreset {
  return { id, name: '预设 ' + id, config, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
}

function quoteKeyOf(key: QqQuoteKey): string {
  return [key.accountId, key.kind, key.chatId, key.msgIdx].join('\u0000');
}

function turnResult(text: string, image?: TurnResult['image']): TurnResult {
  const result: TurnResult = {
    text,
    model: { provider: 'openai-compat', model: 'test-model' },
    attempts: [],
    promptScope: 'global',
    routeScope: 'global',
    reactions: [],
  };
  if (image !== undefined) result.image = image;
  return result;
}

const wait = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in ' + String(timeoutMs) + 'ms');
    await wait(20);
  }
}

function bodyOf(request: RecordedRequest): { content: string; msg_id: string; msg_seq: number } {
  const raw = request.init.body;
  if (typeof raw !== 'string') throw new Error('request body is not a string');
  return JSON.parse(raw) as { content: string; msg_id: string; msg_seq: number };
}

function setup(overrides: {
  record?: ConversationRecord;
  presets?: QQPreset[];
  run?: (ctx: TurnContext) => Promise<TurnResult>;
  replyStatus?: number[];
} = {}) {
  const record = overrides.record ?? makeRecord();
  const ensureCalls: Array<ConversationLinkInput & { name?: string }> = [];
  const directory: ConversationDirectory = {
    list: async () => [record],
    get: async () => record,
    getByLink: async () => record,
    ensureLink: async (input) => {
      ensureCalls.push(input);
      return record;
    },
    update: async () => record,
    bind: async () => record,
    unbind: async () => true,
    merge: async () => record,
    remove: async () => true,
  };

  const appended: ChatMessage[] = [];
  const appendKeys: Array<{ guildId: string; channelId: string }> = [];
  const conversations: ConversationStore = {
    loadRecent: async () => [],
    loadAll: async () => [],
    append: async (key, messages) => {
      appendKeys.push(key);
      appended.push(...messages);
    },
    clear: async () => {},
    loadAfter: async () => [],
    loadLatest: async () => [],
    loadBetween: async () => [],
  };

  const presetList = overrides.presets ?? [];
  const presets: QQPresetStore = {
    list: async () => presetList,
    get: async (id) => presetList.find((preset) => preset.id === id) ?? null,
    put: async (input) => makePreset(input.id ?? 'new', input.config),
    remove: async () => {},
  };

  const quoteEntries = new Map<string, QqQuoteEntry>();
  const quoteIndex: QqQuoteIndex = {
    record: async (entry): Promise<void> => {
      quoteEntries.set(quoteKeyOf(entry), entry);
    },
    find: async (key, nowIso): Promise<QqQuoteEntry | null> => {
      const entry = quoteEntries.get(quoteKeyOf(key));
      if (entry === undefined || entry.expiresAt <= nowIso) return null;
      return entry;
    },
    findByText: async (scope: QqQuoteScope, text, nowIso): Promise<QqQuoteEntry | null> => {
      const candidates = [...quoteEntries.values()].filter(
        (entry) =>
          entry.accountId === scope.accountId &&
          entry.kind === scope.kind &&
          entry.chatId === scope.chatId &&
          entry.expiresAt > nowIso &&
          entry.content.startsWith(text),
      );
      return candidates.length === 1 ? candidates[0]! : null;
    },
  };

  const chatCalls: TurnContext[] = [];
  const run = overrides.run ?? (async (): Promise<TurnResult> => turnResult('收到'));
  // 只有 run 会被这一层调用；其余方法留着占位，故整块断言成 ChatService
  const chat = {
    run: async (ctx: TurnContext): Promise<TurnResult> => {
      chatCalls.push(ctx);
      // 刻意 await：workerd 池会把“不 await 直接返回的 rejected promise”误报成 unhandled
      return await run(ctx);
    },
    reset: async () => {},
    summarize: async () => null,
    summarizeSweep: async () => ({}),
    getSummary: async () => null,
    previewBackfill: async () => ({}),
    backfill: async () => null,
  } as unknown as ChatService;

  const requests: RecordedRequest[] = [];
  const replyStatus = overrides.replyStatus ?? [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init: init ?? {} });
    if (url === QQ_TOKEN_URL) return jsonResponse({ access_token: TOKEN, expires_in: 7200 });
    if (url === QQ_API_BASE + '/gateway') return jsonResponse({ url: GATEWAY_URL });
    const status = replyStatus.shift();
    if (status !== undefined) return jsonResponse({ message: 'rejected' }, status);
    return jsonResponse({ id: 'qq-reply-1' });
  };

  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const gateway: QqGateway = createQqGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    directory,
    conversations,
    presets,
    quoteIndex,
    chat,
    fetch: fetchStub,
    WebSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    log: (entry) => {
      logs.push(entry.message);
    },
    now: () => new Date('2024-01-01T00:00:00.000Z'),
  });

  return {
    gateway,
    sockets,
    requests,
    logs,
    ensureCalls,
    appended,
    appendKeys,
    quoteEntries,
    chatCalls,
    replies: (): RecordedRequest[] => requests.filter((request) => request.url.includes('/messages')),
    start: (): Promise<void> => gateway.start(),
    stop: (): Promise<void> => gateway.stop(),
  };
}

async function boot(options: {
  record?: ConversationRecord;
  presets?: QQPreset[];
  run?: (ctx: TurnContext) => Promise<TurnResult>;
  replyStatus?: number[];
} = {}) {
  const harness = setup(options);
  await harness.start();
  const socket = harness.sockets[0];
  if (socket === undefined) throw new Error('no socket was created');
  socket.emitOpen();
  socket.emitMessage({ op: 10, d: { heartbeat_interval: 60_000 } });
  await wait(0);
  return { harness, socket };
}

describe('QQ 网关', () => {
  it('换 token → 取地址 → Identify，并给群消息回一条文本', async () => {
    const { harness, socket } = await boot();

    expect(harness.requests[0]?.url).toBe(QQ_TOKEN_URL);
    expect(JSON.parse(String(harness.requests[0]?.init.body))).toEqual({ appId: 'app-id', clientSecret: 'app-secret' });
    expect(harness.requests[1]?.url).toBe(QQ_API_BASE + '/gateway');
    expect((harness.requests[1]?.init.headers as Record<string, string>).authorization).toBe('QQBot ' + TOKEN);
    expect(socket.url).toBe(GATEWAY_URL);

    const identify = socket.sent.find((frame) => frame.op === 2);
    expect(identify?.d).toEqual({ token: 'QQBot ' + TOKEN, intents: QQ_INTENTS, shard: [0, 1] });

    socket.emitMessage({
      op: 0,
      s: 1,
      t: QQ_GROUP_EVENT,
      d: {
        id: 'EVENT-1',
        content: '<@!1> 你好',
        group_openid: 'GROUP-OPENID-abc123',
        author: { member_openid: 'USER-1', username: '小明' },
      },
    });
    await until(() => harness.replies().length === 1);

    expect(harness.ensureCalls).toEqual([
      { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-OPENID-abc123', displayName: 'QQ群·abc123' },
    ]);
    const ctx = harness.chatCalls[0];
    if (ctx === undefined) throw new Error('chat.run was not called');
    expect(ctx).toMatchObject({
      guildId: QQ_GROUP_GUILD_ID,
      channelId: 'GROUP-OPENID-abc123',
      guildName: QQ_GROUP_NAME,
      channelName: QQ_GROUP_NAME,
      botName: QQ_BOT_NAME,
      userId: 'USER-1',
      userName: '小明',
      userText: '你好',
      storedUserText: '你好',
      wantReactions: false,
      platform: 'qq',
      platformKind: 'qq_group',
      memoryKey: { guildId: 'memory-guild', channelId: 'memory-channel' },
    });
    expect(ctx.promptOverride).toBeUndefined();
    expect('userDiscordId' in ctx).toBe(false);

    const reply = harness.replies()[0];
    expect(reply?.url).toBe(QQ_API_BASE + '/v2/groups/GROUP-OPENID-abc123/messages');
    expect((reply?.init.headers as Record<string, string>).authorization).toBe('QQBot ' + TOKEN);
    expect(reply === undefined ? null : bodyOf(reply)).toEqual({ content: '收到', msg_id: 'EVENT-1', msg_seq: 1 });

    // 日志只有状态，没有 token，也没有正文
    const logText = harness.logs.join('\n');
    expect(logText).not.toContain(TOKEN);
    expect(logText).not.toContain('你好');

    await harness.stop();
  });

  it('群开了全量模式后，未 @ 消息只落库，@ 消息才回复', async () => {
    const { harness, socket } = await boot();
    const base = {
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-FULL-1',
        content: '普通群消息',
        group_openid: 'GROUP-FULL',
        author: { member_openid: 'USER-1', username: '小明' },
        mentions: [{ is_you: false, scope: 'all' }],
      },
    };

    socket.emitMessage(base);
    await until(() => harness.appended.length === 1);
    expect(harness.chatCalls).toHaveLength(0);
    expect(harness.replies()).toHaveLength(0);
    expect(harness.appended[0]).toMatchObject({
      role: 'user',
      content: '普通群消息',
      author: '小明',
      authorId: 'USER-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      platform: 'qq',
      platformKind: 'qq_group',
    });
    expect(harness.appendKeys[0]).toEqual({ guildId: 'memory-guild', channelId: 'memory-channel' });
    expect(harness.logs.join('\n')).not.toContain('普通群消息');
    expect(harness.logs).toContain('[qq] history recorded kind=qq_group');

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-FULL-2',
        content: '<@!BOT> 在吗',
        group_openid: 'GROUP-FULL',
        author: { member_openid: 'USER-1', username: '小明' },
        mentions: [{ is_you: true, scope: 'single' }],
      },
    });
    await until(() => harness.replies().length === 1);

    expect(harness.chatCalls[0]?.userText).toBe('在吗');
    expect(harness.appended).toHaveLength(1);
    expect(bodyOf(harness.replies()[0] as RecordedRequest)).toEqual({
      content: '收到',
      msg_id: 'EVENT-FULL-2',
      msg_seq: 1,
    });

    await harness.stop();
  });

  it('引用消息按 ref_msg_idx 找到被引用的人，并写进 TurnContext', async () => {
    const { harness, socket } = await boot();

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-QUOTE-1',
        content: '原来的话',
        group_openid: 'GROUP-QUOTE',
        author: { member_openid: 'USER-1', username: '小明' },
        message_scene: { ext: ['msg_idx=MSG-1'] },
        mentions: [{ is_you: false, scope: 'all' }],
      },
    });
    await until(() => harness.appended.length === 1);

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-QUOTE-2',
        content: '<@!BOT> 你记得吗',
        group_openid: 'GROUP-QUOTE',
        author: { member_openid: 'USER-2', username: '阿花' },
        message_scene: { ext: ['msg_idx=MSG-2', 'ref_msg_idx=MSG-1'] },
        msg_elements: [
          {
            msg_idx: 'MSG-2',
            message_type: 103,
            content: '你记得吗',
            msg_elements: [{ msg_idx: 'MSG-1', message_type: 0, content: '原来的话' }],
          },
        ],
        mentions: [{ is_you: true, scope: 'single' }],
      },
    });
    await until(() => harness.replies().length === 1);

    expect(harness.chatCalls[0]?.replyTo).toEqual({
      messageId: 'MSG-1',
      author: '小明',
      authorId: 'USER-1',
      content: '原来的话',
    });

    await harness.stop();
  });

  it('ref_msg_idx 对不上时按引用正文找到作者', async () => {
    const { harness, socket } = await boot();

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-TEXT-1',
        content: '原来的话',
        group_openid: 'GROUP-TEXT',
        author: { member_openid: 'USER-1', username: '小明' },
        message_scene: { ext: ['msg_idx=MSG-TEXT-1'] },
        mentions: [{ is_you: false, scope: 'all' }],
      },
    });
    await until(() => harness.appended.length === 1);

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-TEXT-2',
        content: '<@!BOT> 你记得吗',
        group_openid: 'GROUP-TEXT',
        author: { member_openid: 'USER-2', username: '阿花' },
        message_scene: { ext: ['msg_idx=MSG-TEXT-2', 'ref_msg_idx=MSG-TEXT-MISSING'] },
        msg_elements: [
          {
            msg_idx: 'MSG-TEXT-2',
            message_type: 103,
            content: '你记得吗',
            msg_elements: [{ msg_idx: 'MSG-TEXT-MISSING', message_type: 0, content: '原来的话' }],
          },
        ],
        mentions: [{ is_you: true, scope: 'single' }],
      },
    });
    await until(() => harness.replies().length === 1);

    expect(harness.chatCalls[0]?.replyTo).toEqual({
      messageId: 'MSG-TEXT-1',
      author: '小明',
      authorId: 'USER-1',
      content: '原来的话',
    });

    await harness.stop();
  });

  it('引用一条本身也是引用的消息时，索引里带上内层正文', async () => {
    const { harness, socket } = await boot();

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-NESTED-1',
        content: '原来的话',
        group_openid: 'GROUP-NESTED',
        author: { member_openid: 'USER-1', username: '小明' },
        message_scene: { ext: ['msg_idx=MSG-NESTED-1'] },
        mentions: [{ is_you: false, scope: 'all' }],
      },
    });
    await until(() => harness.appended.length === 1);

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-NESTED-2',
        content: '我引用他',
        group_openid: 'GROUP-NESTED',
        author: { member_openid: 'USER-2', username: '阿花' },
        message_scene: { ext: ['msg_idx=MSG-NESTED-2', 'ref_msg_idx=MSG-NESTED-1'] },
        msg_elements: [
          {
            msg_idx: 'MSG-NESTED-2',
            message_type: 103,
            content: '我引用他',
            msg_elements: [{ msg_idx: 'MSG-NESTED-1', message_type: 0, content: '原来的话' }],
          },
        ],
        mentions: [{ is_you: false, scope: 'all' }],
      },
    });
    await until(() => harness.appended.length === 2);

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-NESTED-3',
        content: '<@!BOT> 什么？',
        group_openid: 'GROUP-NESTED',
        author: { member_openid: 'USER-3', username: '小红' },
        message_scene: { ext: ['msg_idx=MSG-NESTED-3', 'ref_msg_idx=MSG-NESTED-2'] },
        msg_elements: [
          {
            msg_idx: 'MSG-NESTED-3',
            message_type: 103,
            content: '什么？',
            msg_elements: [
              {
                msg_idx: 'MSG-NESTED-2',
                message_type: 103,
                content: '我引用他',
                msg_elements: [{ msg_idx: 'MSG-NESTED-1', message_type: 0, content: '原来的话' }],
              },
            ],
          },
        ],
        mentions: [{ is_you: true, scope: 'single' }],
      },
    });
    await until(() => harness.replies().length === 1);

    const replyTo = harness.chatCalls[0]?.replyTo;
    expect(replyTo?.messageId).toBe('MSG-NESTED-2');
    expect(replyTo?.author).toBe('阿花');
    expect(replyTo?.authorId).toBe('USER-2');
    expect(replyTo?.content).toContain('我引用他');
    expect(replyTo?.content).toContain('原来的话');

    await harness.stop();
  });

  it('未 @ 的引用消息也把 replyTo 写进历史', async () => {
    const { harness, socket } = await boot();

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-QUOTE-H1',
        content: '第一句',
        group_openid: 'GROUP-QUOTE-H',
        author: { member_openid: 'USER-1', username: '小明' },
        message_scene: { ext: ['msg_idx=H1'] },
        mentions: [{ is_you: false, scope: 'all' }],
      },
    });
    await until(() => harness.appended.length === 1);

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-QUOTE-H2',
        content: '第二句',
        group_openid: 'GROUP-QUOTE-H',
        author: { member_openid: 'USER-2', username: '阿花' },
        message_scene: { ext: ['msg_idx=H2', 'ref_msg_idx=H1'] },
        mentions: [{ is_you: false, scope: 'all' }],
      },
    });
    await until(() => harness.appended.length === 2);

    expect(harness.chatCalls).toHaveLength(0);
    expect(harness.appended[1]?.replyTo).toEqual({
      messageId: 'H1',
      author: '小明',
      authorId: 'USER-1',
      content: '第一句',
    });

    await harness.stop();
  });

  it('全量模式里机器人自己的消息不落库也不回复', async () => {
    const { harness, socket } = await boot();

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-BOT',
        content: '机器人自己的回复',
        group_openid: 'GROUP-BOT',
        author: { member_openid: 'BOT-OPENID', bot: true },
        mentions: [{ is_you: true, scope: 'single' }],
      },
    });
    await wait(80);

    expect(harness.appended).toHaveLength(0);
    expect(harness.chatCalls).toHaveLength(0);

    await harness.stop();
  });

  it('回复 401 时清掉 token，用同一片重试一次', async () => {
    const { harness, socket } = await boot({ replyStatus: [401] });

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_EVENT,
      d: { id: 'EVENT-401', content: '重试', group_openid: 'GROUP-401', author: { member_openid: 'U' } },
    });
    await until(() => harness.replies().length === 2);

    const tokenCalls = harness.requests.filter((request) => request.url === QQ_TOKEN_URL);
    expect(tokenCalls).toHaveLength(2);
    expect(bodyOf(harness.replies()[0]!)).toEqual(bodyOf(harness.replies()[1]!));
    expect(harness.logs).toContain('[qq] reply unauthorized, refreshing token');

    await harness.stop();
  });

  it('单聊用合成键；选了命名预设就整份覆盖提示词', async () => {
    const config: PromptConfig = { segments: [], temperature: 0.3 };
    const { harness, socket } = await boot({ record: makeRecord('preset-1'), presets: [makePreset('preset-1', config)] });

    socket.emitMessage({
      op: 0,
      t: QQ_C2C_EVENT,
      d: { id: 'EVENT-2', content: '在吗', author: { user_openid: 'USER-9', username: '阿花' } },
    });
    await until(() => harness.replies().length === 1);

    const ctx = harness.chatCalls[0];
    expect(ctx?.guildId).toBe(QQ_C2C_GUILD_ID);
    expect(ctx?.channelName).toBe(QQ_C2C_NAME);
    expect(ctx?.guildName).toBe(QQ_C2C_NAME);
    expect(ctx?.platform).toBe('qq');
    expect(ctx?.platformKind).toBe('qq_c2c');
    expect(ctx?.promptOverride).toEqual(config);
    expect(harness.ensureCalls[0]?.kind).toBe('qq_c2c');
    expect(harness.ensureCalls[0]?.displayName).toBe('阿花');
    expect(harness.replies()[0]?.url).toBe(QQ_API_BASE + '/v2/users/USER-9/messages');

    await harness.stop();
  });

  it('长回复切成最多 5 片，msg_seq 从 1 递增', async () => {
    const { harness, socket } = await boot({ run: async () => turnResult('x'.repeat(12_000)) });

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_EVENT,
      d: { id: 'EVENT-3', content: '来点长的', group_openid: 'GROUP-3', author: { member_openid: 'U' } },
    });
    await until(() => harness.replies().length === 5);

    const bodies = harness.replies().map((request) => bodyOf(request));
    expect(bodies.map((body) => body.msg_seq)).toEqual([1, 2, 3, 4, 5]);
    for (const body of bodies) expect(body.content.length).toBeLessThanOrEqual(QQ_REPLY_CHUNK_MAX);
    expect(bodies[4]?.msg_id).toBe('EVENT-3');

    await harness.stop();
  });

  it('回合抛错时只回安全文案，错误细节不进聊天', async () => {
    const { harness, socket } = await boot({
      run: async () => {
        throw new Error('upstream key sk-live-should-not-leak');
      },
    });

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_EVENT,
      d: { id: 'EVENT-4', content: '你好', group_openid: 'GROUP-4', author: { member_openid: 'U' } },
    });
    await until(() => harness.replies().length === 1);

    expect(bodyOf(harness.replies()[0] as RecordedRequest).content).toBe(QQ_FAILURE_TEXT);
    const sent = harness.replies().map((request) => String(request.init.body)).join('\n');
    expect(sent).not.toContain('sk-live');
    expect(harness.logs.join('\n')).not.toContain(TOKEN);

    await harness.stop();
  });

  it('回复里的 <think_nya> 思考块不发给 QQ', async () => {
    const { harness, socket } = await boot({
      run: async () => turnResult('<think_nya>\n内部推理\n</think_nya>\n\n给用户看的正文'),
    });

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_EVENT,
      d: { id: 'EVENT-THINK', content: '你好', group_openid: 'GROUP-THINK', author: { member_openid: 'U' } },
    });
    await until(() => harness.replies().length === 1);

    const body = bodyOf(harness.replies()[0] as RecordedRequest);
    expect(body.content).toBe('给用户看的正文');
    expect(body.content).not.toContain('内部推理');
    expect(body.content).not.toContain('think_nya');

    await harness.stop();
  });

  it('生图结果只补一句说明，绝不尝试上传媒体', async () => {
    const { harness, socket } = await boot({
      run: async () => turnResult('画好了', { data: new Uint8Array([1, 2, 3]), mime: 'image/png', prompt: '猫' }),
    });

    socket.emitMessage({
      op: 0,
      t: QQ_GROUP_EVENT,
      d: { id: 'EVENT-5', content: '画只猫', group_openid: 'GROUP-5', author: { member_openid: 'U' } },
    });
    await until(() => harness.replies().length === 1);

    expect(bodyOf(harness.replies()[0] as RecordedRequest).content).toBe('画好了\n' + QQ_IMAGE_NOTE);
    for (const request of harness.requests) {
      const known = request.url === QQ_TOKEN_URL || request.url === QQ_API_BASE + '/gateway' || request.url.endsWith('/messages');
      expect(known).toBe(true);
    }

    await harness.stop();
  });

  it('重投的同一事件只处理一次', async () => {
    const { harness, socket } = await boot();
    const frame = {
      op: 0,
      t: QQ_GROUP_EVENT,
      d: { id: 'EVENT-SAME', content: '你好', group_openid: 'GROUP-6', author: { member_openid: 'U' } },
    };

    socket.emitMessage(frame);
    await until(() => harness.replies().length === 1);
    socket.emitMessage(frame);
    await wait(80);

    expect(harness.chatCalls).toHaveLength(1);
    expect(harness.replies()).toHaveLength(1);

    await harness.stop();
  });

  it('重投的非 @ 群消息只落库一次', async () => {
    const { harness, socket } = await boot();
    const frame = {
      op: 0,
      t: QQ_GROUP_FULL_EVENT,
      d: {
        id: 'EVENT-FULL-SAME',
        content: '重投的普通群消息',
        group_openid: 'GROUP-7',
        author: { member_openid: 'U' },
        mentions: [{ is_you: false, scope: 'all' }],
      },
    };

    socket.emitMessage(frame);
    await until(() => harness.appended.length === 1);
    socket.emitMessage(frame);
    await wait(80);

    expect(harness.appended).toHaveLength(1);
    expect(harness.chatCalls).toHaveLength(0);

    await harness.stop();
  });

  it('心跳带上最后一次序列号', async () => {
    const { harness, socket } = await boot();
    socket.emitMessage({ op: 0, s: 7, t: 'READY', d: {} });
    socket.emitMessage({ op: 10, d: { heartbeat_interval: 1000 } });

    await until(() => socket.sent.some((frame) => frame.op === 1), 2500);
    const beat = socket.sent.find((frame) => frame.op === 1);
    expect(beat?.d).toBe(7);

    await harness.stop();
  });

  it('断线后退避重连，缓存 token 不重复换', async () => {
    const { harness, socket } = await boot();
    socket.emitClose(1006, 'network');

    await until(() => harness.sockets.length === 2, 3000);
    expect(harness.sockets[1]?.url).toBe(GATEWAY_URL);
    expect(harness.requests.filter((request) => request.url === QQ_TOKEN_URL)).toHaveLength(1);
    expect(harness.logs.join('\n')).toContain('reconnect in 1000ms');

    await harness.stop();
  });

  it('stop() 后心跳与重连都不再动作', async () => {
    const { harness, socket } = await boot();
    socket.emitMessage({ op: 10, d: { heartbeat_interval: 1000 } });
    await until(() => socket.sent.some((frame) => frame.op === 1), 2500);

    await harness.stop();
    expect(socket.closedWith === null).toBe(false);

    const frames = socket.sent.length;
    const requests = harness.requests.length;
    await wait(1200);
    expect(socket.sent.length).toBe(frames);
    expect(harness.requests.length).toBe(requests);
    expect(harness.sockets).toHaveLength(1);
  });

  it('op 9 无效会话会丢掉缓存 token 并重新鉴权', async () => {
    const { harness, socket } = await boot();
    socket.emitMessage({ op: 9, d: false });

    await until(() => harness.sockets.length === 2, 2000);
    expect(harness.requests.filter((request) => request.url === QQ_TOKEN_URL)).toHaveLength(2);

    await harness.stop();
  });

  it('stop() 之后再 start() 不会复活连接', async () => {
    const { harness } = await boot();
    await harness.stop();
    await harness.start();
    await wait(80);
    expect(harness.sockets).toHaveLength(1);
  });
});