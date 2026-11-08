/**
 * §29：@ 路径的流式回复 —— 首个 token 到了才发第一条消息、边生成边 PATCH 同一条、最后必然是全文。
 *
 * 装配沿用 ./gateway.react.test.ts：FakeWebSocket 把 MESSAGE_CREATE 灌进 #dispatch，
 * vi.mock 把 chat service 与 D1 换成桩（这里要断言的是「发了哪些 HTTP」与「进度回调有没有接上」），
 * globalThis.fetch 换成按 URL 分派的捕获桩，就能看见那一次 POST ?wait=true（内容是正文开头，不是占位）与随后的 PATCH。
 *
 * 注意：渐进编辑用的是真时钟（SYSTEM_CLOCK），节流间隔取 MESSAGE_CHAT_CONFIG 的 1200ms，
 * 所以每个用例会有 1~3 秒的真实等待 —— 用例刻意只留很少几次进度回调。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatServiceDeps } from '../src/core/chat/service';
import type { ChatMessage, EmojiAlias, EmojiDescription, ReactionModelConfig, TurnContext, TurnResult } from '../src/core/types';
import { createChannelClient } from '../src/workers/gateway/channel-rest';
import { DEFAULT_API_BASE } from '../src/workers/discord/rest';
import type { GatewayEnv } from '../src/workers/gateway/durable-object';

const BOT_ID = '150000000000000001';
const SECRET = btoa('k'.repeat(32));
const MESSAGES_URL = DEFAULT_API_BASE + '/channels/chan-1/messages';
const WAIT_URL = MESSAGES_URL + '?wait=true';
const EDIT_URL = MESSAGES_URL + '/mid-1';
/** 服务器频道里每条回复开头的 @ 提问者：mentionPayload 的 author.id */
const ASKER_MENTION = '<@user-1> ';

const stub = vi.hoisted<{
  contexts: TurnContext[];
  text: string;
  runError: Error | null;
  /** 桩里依次回调的进度文本：模拟模型边吐边推 */
  progress: string[];
  /** 桩是否收到了 events（没接上就等于不流式） */
  sawEvents: boolean[];
}>(() => ({ contexts: [], text: '好的', runError: null, progress: [], sawEvents: [] }));

vi.mock('../src/core/chat/service', () => ({
  createChatService: (_deps: ChatServiceDeps) => ({
    run: (ctx: TurnContext, events?: { onProgress?: (text: string) => void | Promise<void> }): Promise<TurnResult> => {
      stub.contexts.push(ctx);
      stub.sawEvents.push(events?.onProgress !== undefined);
      // 先吐进度再失败：模拟「说了几个字之后模型挂了」
      for (const text of stub.progress) events?.onProgress?.(text);
      if (stub.runError !== null) return Promise.reject(stub.runError);
      return Promise.resolve({
        text: stub.text,
        model: { provider: 'openai-compat', model: 'stub' },
        attempts: [],
        promptScope: 'global',
        routeScope: 'global',
        reactions: [],
      });
    },
    reset: (): Promise<void> => Promise.resolve(),
  }),
}));

vi.mock('../src/workers/db/d1-repository', () => ({
  createRepositories: () => ({
    conversations: { append: (): Promise<void> => Promise.resolve() },
    reactionModels: {
      get: (): Promise<ReactionModelConfig | null> => Promise.resolve(null),
      put: (): Promise<void> => Promise.resolve(),
    },
    keys: { listEnabled: (): Promise<never[]> => Promise.resolve([]) },
    emojiDescriptions: {
      list: (): Promise<EmojiDescription[]> => Promise.resolve([]),
      putMany: (): Promise<void> => Promise.resolve(),
    },
    emojiAliases: {
      list: (): Promise<EmojiAlias[]> => Promise.resolve([]),
      put: (): Promise<void> => Promise.resolve(),
      remove: (): Promise<void> => Promise.resolve(),
    },
  }),
}));

let gateway: typeof import('../src/workers/gateway/durable-object');

beforeAll(async () => {
  vi.resetModules();
  gateway = await import('../src/workers/gateway/durable-object');
});

interface Captured {
  method: string;
  url: string;
  body: string | null;
}

type Responder = (method: string, url: string) => Response | undefined;

function jsonBody(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(calls: Captured[], responder?: Responder): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });
    const custom = responder?.(method, url);
    if (custom !== undefined) return Promise.resolve(custom);
    if (url.endsWith('/typing')) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(jsonBody({}));
  };
}

function contentOf(call: Captured): string {
  return String((JSON.parse(call.body ?? '{}') as { content?: string }).content ?? '');
}

/** 去掉开头那个 @ 提问者：流式要比的是正文，前缀每一条都一模一样 */
function withoutMention(call: Captured): string {
  const content = contentOf(call);
  return content.startsWith(ASKER_MENTION) ? content.slice(ASKER_MENTION.length) : content;
}

function patches(calls: Captured[]): Captured[] {
  return calls.filter((call) => call.method === 'PATCH' && call.url === EDIT_URL);
}

/** 补发的分段（不带 ?wait=true，只关心发出去、不关心 id） */
function sends(calls: Captured[]): Captured[] {
  return calls.filter((call) => call.method === 'POST' && call.url === MESSAGES_URL);
}

/** §62 起整段发送也走 createMessage（?wait=true 拿消息 id 记 discord_id） */
function created(calls: Captured[]): Captured[] {
  return calls.filter((call) => call.method === 'POST' && call.url === WAIT_URL);
}

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly url: string;
  readyState = 1;
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
    this.readyState = 3;
  }
}

interface Harness {
  presence: InstanceType<typeof gateway.GatewayPresence>;
  pending: Promise<unknown>[];
}

function createHarness(): Harness {
  const pending: Promise<unknown>[] = [];
  const data = new Map<string, unknown>();
  const state = {
    storage: {
      get: (key: string): Promise<unknown> => Promise.resolve(data.get(key)),
      put: (key: string, value: unknown): Promise<void> => {
        data.set(key, value);
        return Promise.resolve();
      },
      getAlarm: (): Promise<number | null> => Promise.resolve(null),
      setAlarm: (): Promise<void> => Promise.resolve(),
    },
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  } as unknown as DurableObjectState;
  const env: Partial<GatewayEnv> = {
    DISCORD_BOT_TOKEN: 'tok',
    DISCORD_APPLICATION_ID: BOT_ID,
    KEY_ENCRYPTION_SECRET: SECRET,
    DB: {} as unknown as D1Database,
  };
  return { presence: new gateway.GatewayPresence(state, env), pending };
}

async function dispatchMessage(harness: Harness, raw: unknown): Promise<void> {
  const ensureUrl = gateway.GATEWAY_INTERNAL_ORIGIN + gateway.GATEWAY_ENSURE_PATH;
  await harness.presence.fetch(new Request(ensureUrl, { method: 'POST' }));
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (socket === undefined) throw new Error('前置失败：没有建立 WebSocket');
  for (const listener of socket.listeners.get('message') ?? []) {
    listener({ data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: raw }) });
  }
  for (let index = 0; index < 24; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.all(harness.pending);
}

function mentionPayload(content: string): Record<string, unknown> {
  return {
    id: 'msg-1',
    channel_id: 'chan-1',
    guild_id: 'guild-1',
    content: '<@' + BOT_ID + '> ' + content,
    author: { id: 'user-1', username: 'alice', global_name: 'Alice', bot: false },
    mentions: [{ id: BOT_ID }],
  };
}

function respondWait(): Responder {
  // 带不带 ?wait=true 都可能要 id：流式首条与整段发送都走 createMessage
  return (method, url) =>
    method === 'POST' && (url === WAIT_URL || url === MESSAGES_URL) ? jsonBody({ id: 'mid-1' }) : undefined;
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  stub.contexts.length = 0;
  stub.text = '好的';
  stub.runError = null;
  stub.progress = [];
  stub.sawEvents.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('@ 路径流式：首个 token 到了才建消息 → 逐次 PATCH → 最终全文', () => {
  it('有字了才发消息，之后同一条被改成最新内容，最后一定是最终全文', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, respondWait()));
    stub.progress = ['你好', '你好，世界'];
    stub.text = '你好，世界！';

    await dispatchMessage(createHarness(), mentionPayload('说点啥'));

    expect(stub.sawEvents).toEqual([true]);
    const final = '你好，世界！';
    // 建消息用的是第一个进度文本（POST ?wait=true 拿 id），不是空的占位
    const created = calls.filter((call) => call.method === 'POST' && call.url === WAIT_URL);
    expect(created).toHaveLength(1);
    // 首条正文头顶固定一个 @ 提问者：前缀不参与进度，只占配额
    expect(contentOf(created[0] as Captured).startsWith(ASKER_MENTION)).toBe(true);
    const opening = withoutMention(created[0] as Captured);
    expect(opening).not.toBe('…');
    expect(opening.length).toBeGreaterThan(0);
    expect(final.startsWith(opening)).toBe(true);
    // 之后全是 PATCH 同一条消息，最后一次是最终全文
    const contents = patches(calls).map(withoutMention);
    expect(contents.length).toBeGreaterThan(0);
    expect(contents[contents.length - 1]).toBe(final);
    for (const [index, content] of contents.entries()) {
      expect(final.startsWith(content)).toBe(true);
      if (index > 0) expect(content.length).toBeGreaterThanOrEqual(contents[index - 1]!.length);
    }
    expect(sends(calls)).toHaveLength(0);
  });

  it('一直没有字（秒回 / 空回复）：不建消息、不留占位，直接发一条', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, respondWait()));
    stub.text = '好的';

    await dispatchMessage(createHarness(), mentionPayload('说点啥'));

    expect(patches(calls)).toHaveLength(0);
    // 没有流式首条；整段发送本身也走 createMessage（§62 要拿 id 记 discord_id），所以是一条 ?wait=true
    const sent = created(calls);
    expect(sent).toHaveLength(1);
    expect(sends(calls)).toHaveLength(0);
    expect(contentOf(sent[0] as Captured)).toBe(ASKER_MENTION + '好的');
  });

  it('一个字都没吐就失败：没有消息产生，只发一条失败提示', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, respondWait()));
    stub.runError = new Error('ALL_PROVIDERS_FAILED');

    await dispatchMessage(createHarness(), mentionPayload('说点啥'));

    expect(patches(calls)).toHaveLength(0);
    const sent = created(calls);
    expect(sent).toHaveLength(1);
    expect(contentOf(sent[0] as Captured)).toContain('回复生成失败');
  });

  // 失败提示超过「不做动画」的阈值时也走假流式：分片之间是真实 intervalMs（1200ms），
  // 最坏多花约 8 秒，默认 5 秒超时不够；放宽超时而不是把线上节奏改短。
  it('吐了几个字之后失败：那条消息被改成失败提示，不会留下半句', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, respondWait()));
    stub.progress = ['你好'];
    stub.runError = new Error('ALL_PROVIDERS_FAILED');

    await dispatchMessage(createHarness(), mentionPayload('说点啥'));

    const edited = patches(calls);
    expect(edited.length).toBeGreaterThan(0);
    const last = contentOf(edited[edited.length - 1] as Captured);
    expect(last).toContain('回复生成失败');
  }, 20000);

  // 首条 1900 字由假流式分 6 片挤出去，片间隔真实 1200ms（约 7 秒），默认 5 秒超时不够。
  it('超长回复：第一条流式写满，剩下的等生成完再补发', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, respondWait()));
    stub.progress = ['A'.repeat(500)];
    stub.text = 'A'.repeat(4000);

    await dispatchMessage(createHarness(), mentionPayload('写长点'));

    const edited = patches(calls);
    expect(contentOf(edited[edited.length - 1] as Captured)).toHaveLength(1900);
    // 4000 字切成 1890 + 1890 + 220（1890 = 1900 上限减去 @ 前缀的配额）：首条滚动显示，剩下两段等生成完补发
    const extra = sends(calls);
    expect(extra).toHaveLength(2);
    // 首条得先摘掉 @ 前缀再算：前缀不算正文，把它算进去会掩盖首段被削掉的那几个字
    const joined = withoutMention(edited[edited.length - 1] as Captured);
    expect(joined.length + extra.reduce((sum, call) => sum + contentOf(call).length, 0)).toBe(4000);
  }, 20000);

  // 回归（mention-2）：@ 前缀的配额必须先扣掉再切段。以前先按 1900 切、拼完前缀再被 withMention
  // 削到 1889，首段尾巴的十来个字掉在地上，后面的段又从错误的位置接 —— 拼回来不等于原文。
  it('超长回复：@ 前缀不再挤掉首段尾巴，全部段落按顺序拼回来逐字等于原文', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, respondWait()));
    const body = '甲'.repeat(2500);
    stub.progress = ['甲'.repeat(400)];
    stub.text = body;

    await dispatchMessage(createHarness(), mentionPayload('写长点'));

    // 建消息那条：前缀在开头，整条 content 仍在 Discord 的上限内
    const created = calls.filter((call) => call.method === 'POST' && call.url === WAIT_URL);
    expect(created).toHaveLength(1);
    const first = contentOf(created[0] as Captured);
    expect(first.startsWith(ASKER_MENTION)).toBe(true);
    expect(first.length).toBeLessThanOrEqual(1900);

    // 首段就是那条消息的最终形态（最后一次 PATCH）；剩下的等生成完裸发，不带前缀
    const edited = patches(calls);
    expect(edited.length).toBeGreaterThan(0);
    const head = contentOf(edited[edited.length - 1] as Captured);
    expect(head.startsWith(ASKER_MENTION)).toBe(true);
    expect(head.length).toBeLessThanOrEqual(1900);
    const extra = sends(calls);
    expect(extra.length).toBeGreaterThan(0);
    for (const call of extra) expect(contentOf(call).startsWith(ASKER_MENTION)).toBe(false);

    // 不钉具体切分点（chunkMessage 会优先在换行处断）：只钉「拼起来一字不差」
    const joined = withoutMention(edited[edited.length - 1] as Captured) + extra.map(contentOf).join('');
    expect(joined).toBe(body);
  }, 20000);

  it('首条消息发不出去（403）：退回整段发送，一次 POST 发全文，不做 PATCH', async () => {
    const calls: Captured[] = [];
    // 只拒绝第一次建消息：退回整段发送时仍然要 POST（§62 要拿 id），Discord 那边不该第二次也拒
    let waitAttempts = 0;
    vi.stubGlobal(
      'fetch',
      stubFetch(calls, (method, url) => {
        if (method !== 'POST' || url !== WAIT_URL) return undefined;
        waitAttempts += 1;
        return waitAttempts === 1 ? new Response('denied', { status: 403 }) : jsonBody({ id: 'mid-2' });
      }),
    );
    stub.progress = ['你好', '你好，世界'];
    stub.text = '你好，世界！';

    await dispatchMessage(createHarness(), mentionPayload('说点啥'));

    expect(patches(calls)).toHaveLength(0);
    const sent = created(calls).slice(1);
    expect(sent).toHaveLength(1);
    expect(contentOf(sent[0] as Captured)).toBe(ASKER_MENTION + '你好，世界！');
  });

  it('网关侧真的把 @ 提问者 写进了请求体：createMessage 的 content 以「<@提问者id> 」开头', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', stubFetch(calls, respondWait()));
    stub.progress = ['你好'];
    stub.text = '你好呀';

    await dispatchMessage(createHarness(), mentionPayload('说点啥'));

    const created = calls.filter((call) => call.method === 'POST' && call.url === WAIT_URL);
    expect(created).toHaveLength(1);
    const body = JSON.parse(String(created[0]?.body)) as {
      content: string;
      allowed_mentions: { parse: string[] };
    };
    // 提问者 id 取自消息作者：前缀进了线缆，且 allowed_mentions 只解析用户 —— 这个 <@id> 才会真的 ping
    expect(body.content).toBe(ASKER_MENTION + '你好');
    expect(body.content.startsWith('<@user-1> ')).toBe(true);
    expect(body.allowed_mentions).toEqual({ parse: ['users'] });
  });
});

describe('频道 REST：createMessage / editMessage（§29）', () => {
  it('createMessage 走 POST ?wait=true 并返回消息 id', async () => {
    const calls: Captured[] = [];
    const client = createChannelClient({ botToken: 'tok', fetch: stubFetch(calls, respondWait()) });
    await expect(client.createMessage('chan-1', '你好')).resolves.toBe('mid-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WAIT_URL);
    expect(contentOf(calls[0] as Captured)).toBe('你好');
  });

  it('没有返回 id 时抛错（调用方据此退回整段发送）', async () => {
    const calls: Captured[] = [];
    const client = createChannelClient({ botToken: 'tok', fetch: stubFetch(calls) });
    await expect(client.createMessage('chan-1', '你好')).rejects.toThrow('discord 没有返回消息 id');
  });

  it('editMessage 是 PATCH 到那条消息，并带上 allowed_mentions 只解析用户提及', async () => {
    const calls: Captured[] = [];
    const client = createChannelClient({ botToken: 'tok', fetch: stubFetch(calls) });
    await client.editMessage('chan-1', 'mid-1', '正文');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(EDIT_URL);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ content: '正文', allowed_mentions: { parse: ['users'] } });
  });
});
