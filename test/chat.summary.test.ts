import { describe, expect, it, vi } from 'vitest';
import { createChatService, summaryMaterial, RangeTooLargeError } from '../src/core/chat/service';
import type { ChatService, ChatServiceDeps } from '../src/core/chat/service';
import { appendSegment } from '../src/core/chat/summary';
import type { SummaryLine } from '../src/core/chat/summary';
import type {
  ChannelKey,
  ChatMessage,
  ConversationSummary,
  DecryptedKey,
  LlmChunk,
  LlmProvider,
  LlmRequest,
  LogEntry,
  PromptConfig,
  ProviderId,
  ProviderRuntime,
  RouteConfig,
  StoredMessage,
  TurnContext,
} from '../src/core/types';

const CTX: TurnContext = {
  guildId: 'g1',
  channelId: 'c1',
  userId: 'u-llp',
  userName: '小明',
  guildName: '示例服务器',
  channelName: '闲聊2',
  botName: '示例机器人',
  userText: '你还记得我喜欢什么吗',
};

const KEY: ChannelKey = { guildId: CTX.guildId, channelId: CTX.channelId };
const ROUTE: RouteConfig = { primary: { provider: 'openai-compat', model: 'gpt-4o-mini' }, fallbacks: [] };
const PROMPT: PromptConfig = {
  segments: [
    { id: 'main', name: '基本设定', role: 'system', content: '你是示例角色', enabled: true, placement: 'before', position: 0 },
  ],
};
const DECRYPTED: DecryptedKey = { id: 'k1', provider: 'openai-compat', label: 'k1', apiKey: 'sk-test', models: [] };

function stored(id: number, content: string, role: 'user' | 'assistant' = 'user'): StoredMessage {
  return { id, role, content, author: role === 'assistant' ? '示例机器人' : '小明', authorId: role === 'assistant' ? undefined : 'u-llp' };
}

function summaryOf(summary: string, coveredUntilId: number): ConversationSummary {
  return {
    guildId: KEY.guildId,
    channelId: KEY.channelId,
    summary,
    coveredUntilId,
    updatedAt: '2026-10-25T00:00:00.000Z',
  };
}

const storeKey = (key: ChannelKey): string => key.guildId + '/' + key.channelId;

interface Reply {
  text?: string;
  error?: string;
}

interface HarnessInput {
  /** loadAfter 的返回：库里游标之后的原文 */
  messages?: StoredMessage[];
  summary?: ConversationSummary | null;
  route?: RouteConfig | null;
  keys?: Partial<Record<ProviderId, DecryptedKey | null>>;
  replies?: Partial<Record<ProviderId, Reply>>;
  prompt?: PromptConfig | null;
  /** 摘要读库直接抛错：验证 getSummary 如实上抛、不吞成 null */
  summaryReadError?: string;
  /** 自动总结的条数阈值（缺省 50 条未总结消息） */
  summaryEveryMessages?: number;
  /** 摘要那次 chat() 先挂在这扇门上：用来断言 run 不等摘要 */
  chatGate?: Promise<void>;
  /** 第 n 次非流式摘要的回复正文：让两次 summarize 产出两段不同的记忆 */
  replyTexts?: string[];
  /** 注入摘要时的字数预算（缺省 4000） */
  summaryMaxChars?: number;
}

interface LoadAfterCall {
  key: ChannelKey;
  afterId: number;
  limit: number | undefined;
}

interface LoadBetweenCall {
  fromIso: string;
  toIso: string;
  limit: number;
}

interface Harness {
  service: ChatService;
  deps: ChatServiceDeps;
  store: Map<string, ConversationSummary>;
  chatRequests: Array<{ provider: ProviderId; request: LlmRequest }>;
  streamRequests: LlmRequest[];
  /** 调用次序：'chat:<provider>' 是非流式摘要，'stream' 是流式回复 */
  sequence: string[];
  loadAfterCalls: LoadAfterCall[];
  loadBetweenCalls: LoadBetweenCall[];
  cleared: ChannelKey[];
  removed: ChannelKey[];
  /** background 收到的后台任务：由测试自己决定什么时候 await */
  backgroundTasks: Promise<unknown>[];
  /** append 收到的每一批消息 */
  appended: ChatMessage[][];
  /** log 钩子收到的每一条（§19.6） */
  logEntries: LogEntry[];
}

const FIXED_NOW = '2026-10-25T03:00:00.000Z';
/** FIXED_NOW 的北京时间（UTC+8）戳前缀：本轮这句话必须带它 */
const STAMP = '[10-25 11:00] ';
function makeHarness(input: HarnessInput = {}): Harness {
  const messages = input.messages ?? [];
  const store = new Map<string, ConversationSummary>();
  if (input.summary) store.set(storeKey(input.summary), input.summary);
  const chatRequests: Harness['chatRequests'] = [];
  const streamRequests: LlmRequest[] = [];
  const sequence: string[] = [];
  const loadAfterCalls: LoadAfterCall[] = [];
  const loadBetweenCalls: LoadBetweenCall[] = [];
  const cleared: ChannelKey[] = [];
  const removed: ChannelKey[] = [];
  const backgroundTasks: Promise<unknown>[] = [];
  const appended: ChatMessage[][] = [];
  const logEntries: LogEntry[] = [];

  const makeProvider = (id: ProviderId): LlmProvider => ({
    id,
    async chat(request) {
      chatRequests.push({ provider: id, request });
      sequence.push('chat:' + id);
      // 摘要这条路要走完整段才能落库：门没开就停在这里
      if (input.chatGate !== undefined) await input.chatGate;
      const reply = input.replies?.[id];
      if (reply?.error !== undefined) throw new Error(reply.error);
      return { text: reply?.text ?? input.replyTexts?.[chatRequests.filter((call) => call.provider === id).length - 1] ?? '他喜欢猫。' };
    },
    async listModels() {
      return [];
    },
    chatStream(request: LlmRequest, _rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      streamRequests.push(request);
      sequence.push('stream');
      return (async function* () {
        yield { delta: '好的', finishReason: 'stop' };
      })();
    },
  });

  const deps: ChatServiceDeps = {
    prompts: {
      async get() {
        return input.prompt === undefined ? PROMPT : input.prompt;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    routes: {
      async get(key) {
        if (key.scope !== 'global') return null;
        return input.route === undefined ? ROUTE : input.route;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    keys: {
      async listEnabled(provider) {
        const custom = input.keys?.[provider];
        if (custom !== undefined) return custom === null ? [] : [custom];
        return provider === 'openai-compat' ? [DECRYPTED] : [];
      },
      async list() {
        return [];
      },
      async getDecrypted() {
        return null;
      },
      async create() {
        throw new Error('unused');
      },
      async remove() {},
    },
    conversations: {
      async loadRecent() {
        return [];
      },
      // run 现在吃全部历史：没有 LIMIT，也没有二次裁剪以外的取数逻辑
      async loadAll() {
        const noLimit: ChatMessage[] = messages.map((message) => ({
          role: message.role,
          content: message.content,
        }));
        return noLimit;
      },
      async append(_key, messages) {
        appended.push(messages);
      },
      async clear(key) {
        cleared.push(key);
      },
      async loadAfter(key, afterId, limit) {
        loadAfterCalls.push({ key, afterId, limit });
        const after = messages.filter((message) => message.id > afterId);
        return limit === undefined ? after : after.slice(0, limit);
      },
      async loadLatest(_key, limit) {
        return messages.slice(Math.max(0, messages.length - limit));
      },
      // §35：时间范围筛选跟 D1 同一口径——ISO 文本比较等价于时间比较，含端点、id 升序
      async loadBetween(_key, fromIso, toIso, limit) {
        loadBetweenCalls.push({ fromIso, toIso, limit });
        const from = Date.parse(fromIso);
        const to = Date.parse(toIso);
        const rows = messages.filter((message) => {
          const at = message.createdAt === undefined ? Number.NaN : Date.parse(message.createdAt);
          return Number.isFinite(at) && at >= from && at <= to;
        });
        return rows.slice(0, limit);
      },
    },
    summaries: {
      async get(key) {
        // 真读库是异步的：让抛错落在下一个微任务，别被 runner 记成 unhandled rejection
        await Promise.resolve();
        if (input.summaryReadError !== undefined) throw new Error(input.summaryReadError);
        return store.get(storeKey(key)) ?? null;
      },
      async list() {
        return [...store.values()];
      },
      async put(entry) {
        store.set(storeKey(entry), entry);
      },
      async remove(key) {
        removed.push(key);
        store.delete(storeKey(key));
      },
    },
    providers: {
      'openai-compat': makeProvider('openai-compat'),
      anthropic: makeProvider('anthropic'),
      gemini: makeProvider('gemini'),
    },
    // 后台任务交回测试：既能断言「有没有触发」，也能断言「run 没等它」
    background(task) {
      backgroundTasks.push(task);
    },
    now: () => new Date(FIXED_NOW),
    log(entry) {
      logEntries.push(entry);
    },
    config: {
      summaryMaxChars: input.summaryMaxChars ?? 4000,
      summaryEveryMessages: input.summaryEveryMessages,
    },
  };

  return {
    service: createChatService(deps),
    deps,
    store,
    chatRequests,
    streamRequests,
    sequence,
    loadAfterCalls,
    loadBetweenCalls,
    cleared,
    removed,
    backgroundTasks,
    appended,
    logEntries,
  };
}

const fiveMessages = (): StoredMessage[] => [
  stored(1, '第一句'),
  stored(2, '第二句', 'assistant'),
  stored(3, '第三句'),
  stored(4, '第四句', 'assistant'),
  stored(5, '第五句'),
];

/** 60 条连续消息，正文 m01..m60：字面量前缀便于断言「只送了最旧的一批 50 条」 */
const manyMessages = (count = 60): StoredMessage[] =>
  Array.from({ length: count }, (_unused, index) => stored(index + 1, 'm' + String(index + 1).padStart(2, '0')));

/** 50 条连续消息 = 正好落在自动总结的默认阈值上 */
const fiftyMessages = (): StoredMessage[] =>
  Array.from({ length: 50 }, (_unused, index) => stored(index + 1, '第' + String(index + 1) + '句'));

describe('summarize：游标与素材', () => {
  it('手动总结吃掉游标之后的全部原文，并把游标推到最新一条', async () => {
    const harness = makeHarness({ messages: fiveMessages() });

    const outcome = await harness.service.summarize(KEY);

    expect(outcome).toEqual({
      summary: '【记忆段】\n他喜欢猫。',
      coveredUntilId: 5,
      summarizedMessages: 5,
      model: 'gpt-4o-mini',
    });
    expect(harness.loadAfterCalls[0]).toEqual({ key: KEY, afterId: 0, limit: undefined });
    const content = harness.chatRequests[0]?.request.messages[0]?.content ?? '';
    expect(content).toContain('第五句');
    expect(content).toContain('示例机器人：第四句');
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(5);
  });

  it('从上一版游标之后取消息，旧摘要作为【已有记忆】参考，且不被改写', async () => {
    const harness = makeHarness({
      messages: [stored(5, '第五句'), stored(6, '第六句'), stored(7, '第七句')],
      summary: summaryOf('旧摘要：他喜欢猫', 4),
    });

    const outcome = await harness.service.summarize(KEY);

    expect(harness.loadAfterCalls[0]).toEqual({ key: KEY, afterId: 4, limit: undefined });
    expect(outcome).toMatchObject({ coveredUntilId: 7, summarizedMessages: 3 });
    const content = harness.chatRequests[0]?.request.messages[0]?.content ?? '';
    expect(content).toContain('旧摘要：他喜欢猫');
    expect(content).toContain('第七句');
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(7);
  });

  it('素材行带「↳ 回复」后缀：摘要与提示词共用同一套行格式', async () => {
    const harness = makeHarness({
      messages: [
        {
          ...stored(1, '我也想看电影'),
          replyTo: { messageId: 'm-0', author: '示例机器人', authorId: 'bot-1', content: '我们去看电影' },
        },
        stored(2, '好呀', 'assistant'),
      ],
    });

    await harness.service.summarize(KEY);

    const content = harness.chatRequests[0]?.request.messages[0]?.content ?? '';
    expect(content).toContain('小明(u-llp)：我也想看电影 ↳ 回复 示例机器人(bot-1)：「我们去看电影」');
    // assistant 行永不带回复链
    expect(content).toContain('示例机器人：好呀');
  });

  it('没有可总结内容时返回 null，不调模型也不写库', async () => {
    const harness = makeHarness({ messages: [] });

    expect(await harness.service.summarize(KEY)).toBeNull();
    expect(harness.chatRequests).toEqual([]);
    expect(harness.store.size).toBe(0);
  });

  it('空摘要不落库：抛 SUMMARY_EMPTY 且游标不动', async () => {
    const harness = makeHarness({ messages: fiveMessages(), replies: { 'openai-compat': { text: '   ' } } });

    await expect(harness.service.summarize(KEY)).rejects.toThrow('SUMMARY_EMPTY');
    expect(harness.store.size).toBe(0);
  });

  it('素材超过上限只送最旧的一批 50 条，游标只推到这批的最后一条（不跳过任何人）', async () => {
    const harness = makeHarness({ messages: manyMessages() });

    const outcome = await harness.service.summarize(KEY);

    expect(outcome).toMatchObject({ coveredUntilId: 50, summarizedMessages: 50 });
    const content = harness.chatRequests[0]?.request.messages[0]?.content ?? '';
    expect(content).toContain('m01');
    expect(content).toContain('m50');
    expect(content).not.toContain('m51');
  });

  it('批次上限跟着频道阈值走：阈值 200 时一批就吃满 200 条（2026-10-27 改口径）', async () => {
    const harness = makeHarness({ messages: manyMessages(300), summaryEveryMessages: 200 });

    const outcome = await harness.service.summarize(KEY);

    expect(outcome).toMatchObject({ coveredUntilId: 200, summarizedMessages: 200 });
    const content = harness.chatRequests[0]?.request.messages[0]?.content ?? '';
    expect(content).toContain('m200');
    expect(content).not.toContain('m201');
  });

  it('阈值比默认上限还小时单批仍按 50 条走', async () => {
    const harness = makeHarness({ messages: manyMessages(120), summaryEveryMessages: 20 });

    const outcome = await harness.service.summarize(KEY);

    expect(outcome).toMatchObject({ coveredUntilId: 50, summarizedMessages: 50 });
  });

  it('阈值 0（关掉自动总结）时手动跑一次吃满 500 条，不用人点几十次', async () => {
    const harness = makeHarness({ messages: manyMessages(800), summaryEveryMessages: 0 });

    const outcome = await harness.service.summarize(KEY);

    expect(outcome).toMatchObject({ coveredUntilId: 500, summarizedMessages: 500 });
  });

  it('单批硬上限 500 条：阈值 3000 时一次 summarize 只吃 500 条，游标推到 500', async () => {
    const harness = makeHarness({ messages: manyMessages(3000), summaryEveryMessages: 3000 });

    const outcome = await harness.service.summarize(KEY);

    expect(outcome).toMatchObject({ coveredUntilId: 500, summarizedMessages: 500 });
    const content = harness.chatRequests[0]?.request.messages[0]?.content ?? '';
    expect(content).toContain('m500');
    expect(content).not.toContain('m501');
  });
});

describe('summarize：路由与 key', () => {
  it('没有路由时抛 NO_ROUTE_CONFIGURED', async () => {
    const harness = makeHarness({ messages: fiveMessages(), route: null });

    await expect(harness.service.summarize(KEY)).rejects.toThrow('NO_ROUTE_CONFIGURED');
    expect(harness.chatRequests).toEqual([]);
  });

  it('primary 无 key 记 NO_KEY_FOR_PROVIDER，换 fallback 成功', async () => {
    const route: RouteConfig = {
      primary: { provider: 'anthropic', model: 'claude-3-haiku' },
      fallbacks: [{ provider: 'openai-compat', model: 'gpt-4o-mini' }],
    };
    const harness = makeHarness({ messages: fiveMessages(), route, keys: { anthropic: null } });

    const outcome = await harness.service.summarize(KEY);

    expect(outcome?.model).toBe('gpt-4o-mini');
    expect(harness.chatRequests.map((call) => call.provider)).toEqual(['openai-compat']);
    expect(harness.store.get(storeKey(KEY))?.summary).toBe('【记忆段】\n他喜欢猫。');
  });

  it('候选全失败时抛 ALL_PROVIDERS_FAILED 并带上每次尝试', async () => {
    const route: RouteConfig = {
      primary: { provider: 'anthropic', model: 'claude-3-haiku' },
      fallbacks: [{ provider: 'openai-compat', model: 'gpt-4o-mini' }],
    };
    const harness = makeHarness({
      messages: fiveMessages(),
      route,
      keys: { anthropic: null },
      replies: { 'openai-compat': { error: 'boom' } },
    });

    let message = '';
    await harness.service.summarize(KEY).catch((caught: unknown) => {
      message = caught instanceof Error ? caught.message : String(caught);
    });

    expect(message.startsWith('ALL_PROVIDERS_FAILED: ')).toBe(true);
    expect(message).toContain('NO_KEY_FOR_PROVIDER');
    expect(message).toContain('boom');
    expect(harness.store.size).toBe(0);
  });
});

describe('run 注入长期记忆摘要', () => {
  it('有摘要时 system 出现【长期记忆摘要】段，且该频道全部历史照样一条不少地进 messages', async () => {
    const harness = makeHarness({ messages: fiveMessages(), summary: summaryOf('旧摘要：他喜欢猫', 9) });

    const result = await harness.service.run(CTX);

    expect(result.text).toBe('好的');
    const system = harness.streamRequests[0]?.system ?? '';
    const turn = harness.streamRequests[0]?.messages.at(-1)?.content ?? '';
    // 顺序固定：预设模板 → 平台元信息；有预设段时身份块整段不出现（§52），摘要也不进 system
    expect(system.startsWith('你是示例角色')).toBe(true);
    expect(system).not.toContain('【当前对话】');
    expect(system).not.toContain('【长期记忆摘要】');
    expect(system).toContain('【提及】');
    expect(turn.startsWith('<recall>\n【长期记忆摘要】\n旧摘要：他喜欢猫\n</recall>\n\n')).toBe(true);
    // 摘要与被它总结的原文同时存在：两者都进，哪怕重复
    expect(harness.streamRequests[0]?.messages).toEqual([
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第二句' },
      { role: 'user', content: '第三句' },
      { role: 'assistant', content: '第四句' },
      { role: 'user', content: '第五句' },
      {
        role: 'user',
        content: '<recall>\n【长期记忆摘要】\n旧摘要：他喜欢猫\n</recall>\n\n' + STAMP + '小明(u-llp)：你还记得我喜欢什么吗',
      },
    ]);
    expect(harness.streamRequests[0]?.messages).toHaveLength(6);
    // 只有 stream 一次上游调用：5 条 < 50 条阈值，不触发后台总结
    expect(harness.sequence).toEqual(['stream']);
    expect(harness.backgroundTasks).toEqual([]);
    // 摘要原样躺在库里，run 不重写它
    expect(harness.store.get(storeKey(KEY))).toEqual(summaryOf('旧摘要：他喜欢猫', 9));
  });

  it('日志带 summaryLen：有摘要填正文长度，没摘要是 0', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });
    await makeHarness({ messages: fiveMessages(), summary: summaryOf('旧摘要：他喜欢猫', 9) }).service.run(CTX);
    await makeHarness({ messages: fiveMessages() }).service.run(CTX);
    spy.mockRestore();

    const turnLines = lines.filter((line) => line.startsWith('[chat] turn'));
    expect(turnLines).toHaveLength(2);
    expect(turnLines[0]).toContain('summaryLen=' + String('旧摘要：他喜欢猫'.length));
    expect(turnLines[1]).toContain('summaryLen=0');
  });
});

describe('run 自动摘要：阈值与后台化', () => {
  it('游标之后只有 49 条（未达 50）不触发后台总结', async () => {
    const harness = makeHarness({ messages: fiftyMessages().slice(0, 49) });

    await harness.service.run(CTX);

    expect(harness.backgroundTasks).toEqual([]);
    expect(harness.chatRequests).toEqual([]);
    expect(harness.streamRequests).toHaveLength(1);
    // 触发判定只发一次带 50 条上限的计数查询
    expect(harness.loadAfterCalls).toEqual([{ key: KEY, afterId: 0, limit: 50 }]);
  });

  it('游标之后满 50 条触发一次后台总结，且 run 不等摘要就返回', async () => {
    let openGate = (): void => {
      throw new Error('gate 未就绪');
    };
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const harness = makeHarness({ messages: fiftyMessages(), chatGate: gate });

    const result = await harness.service.run(CTX);

    // run 已经返回：摘要被丢进 background，还挂在这扇门上没跑完
    expect(result.text).toBe('好的');
    expect(harness.backgroundTasks).toHaveLength(1);
    expect(harness.store.size).toBe(0);

    openGate();
    await Promise.all(harness.backgroundTasks);

    const saved = harness.store.get(storeKey(KEY));
    expect(saved?.summary).toBe('【记忆段】\n他喜欢猫。');
    expect(saved?.coveredUntilId).toBe(50);
    // 第一次是触发判定（带 50 条上限），第二次是摘要自己的素材查询（不带上限），
    // 第三次是循环追平时数剩余（游标 50 之后没有消息，0 < 50 就收手）
    expect(harness.loadAfterCalls).toEqual([
      { key: KEY, afterId: 0, limit: 50 },
      { key: KEY, afterId: 0, limit: undefined },
      { key: KEY, afterId: 50, limit: 50 },
    ]);
  });

  it('游标按上一版摘要推进：只数游标之后的消息，20 条不触发', async () => {
    const harness = makeHarness({ messages: fiftyMessages(), summary: summaryOf('旧摘要', 20) });

    await harness.service.run(CTX);

    expect(harness.backgroundTasks).toEqual([]);
    expect(harness.loadAfterCalls).toEqual([{ key: KEY, afterId: 20, limit: 50 }]);
  });

  it('summaryEveryMessages 可覆盖：4 条未总结消息就触发一次', async () => {
    const harness = makeHarness({ messages: fiveMessages().slice(0, 4), summaryEveryMessages: 4 });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    expect(harness.backgroundTasks).toHaveLength(1);
    expect(harness.chatRequests).toHaveLength(1);
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(4);
  });

  it('阈值 200 且积压 500 条：一次触发循环追平两批，游标推到 400', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });
    const harness = makeHarness({ messages: manyMessages(500), summaryEveryMessages: 200 });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);
    spy.mockRestore();

    expect(harness.chatRequests).toHaveLength(2);
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(400);
    expect(lines.some((line) => line.includes('[chat] 自动摘要追平 batches=2'))).toBe(true);
  });

  it('阈值 1200 且积压 3000 条：单批 500 条连跑 4 批，把积压压到 1000 < 阈值就收手', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });
    const harness = makeHarness({ messages: manyMessages(3000), summaryEveryMessages: 1200 });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);
    spy.mockRestore();

    // 每批最多 500 条：3000 → 2500 → 2000 → 1500 → 1000，剩余 1000 < 1200 即停
    expect(harness.chatRequests).toHaveLength(4);
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(2000);
    expect(lines.some((line) => line.includes('[chat] 自动摘要追平 batches=4'))).toBe(true);
  });

  it('没接线 summaries 时 run 照常回复，也不触发自动总结', async () => {
    const harness = makeHarness({ messages: fiftyMessages() });
    const deps: ChatServiceDeps = { ...harness.deps };
    delete deps.summaries;

    const result = await createChatService(deps).run(CTX);

    expect(result.text).toBe('好的');
    expect(harness.backgroundTasks).toEqual([]);
    expect(harness.loadAfterCalls).toEqual([]);
  });
});

// 门牌 summary-order-2 之后选区改成「按 id 取最老一批」，但这一组用例照旧成立：
// limit（阈值为 3 时是 50）比这三条都大，整批一条不少地被选中，coveredUntilId 仍是批内最大 id = 9。
describe('自动总结游标：后写入但时间更早的行（门牌 summary-order-2）', () => {
  // 仓储按 created_at 排序：回灌进来的那批 id 更大、时间更早，所以时间序里 id 是 9 → 1 → 5
  const outOfOrder = (): StoredMessage[] => [stored(9, '最早那句'), stored(1, '中间那句'), stored(5, '最晚那句')];

  it('这一批的 coveredUntilId 取批内最大 id，不是时间末行的 id', async () => {
    const harness = makeHarness({ messages: outOfOrder(), summaryEveryMessages: 3 });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    expect(harness.chatRequests).toHaveLength(1);
    // 时间末行是 id 5：取末行 id 会让游标从 9 退回 5，下一轮把同一批再吃一遍
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(9);
  });

  it('第二轮不再重复吃同一批：游标已是批内最大 id，后面的 loadAfter 一条不剩', async () => {
    const harness = makeHarness({ messages: outOfOrder(), summaryEveryMessages: 3 });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);
    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    // 只花了一次模型调用：第二轮游标之后没有未总结的消息，不再触发
    expect(harness.chatRequests).toHaveLength(1);
    expect(harness.backgroundTasks).toHaveLength(1);
    expect(harness.loadAfterCalls[harness.loadAfterCalls.length - 1]).toEqual({ key: KEY, afterId: 9, limit: 3 });
  });
});

describe('自动总结选区：选取按 id、送模型按 created_at（门牌 summary-order-2）', () => {
  /** 带落库时刻的行：时间序由 createdAt 决定，id 只当游标与破平 */
  function timed(id: number, content: string, createdAt: string): StoredMessage {
    return { ...stored(id, content), createdAt };
  }
  const minute = (n: number): string => new Date(Date.UTC(2026, 9, 20, 0, n)).toISOString();
  /**
   * 生产 §35.7 的形状：回灌行 id 更大、时间更早。
   * 时间序先 count/2 条回灌行（id count..count/2+1），再 count/2 条在线行（id count/2..1）。
   */
  function backfilled(count: number): StoredMessage[] {
    const half = count / 2;
    const rows: StoredMessage[] = [];
    // 正文尾部带句号：断言「每条恰好出现一次」时，'在线 id 5' 才不会命中 '在线 id 50'
    for (let i = 0; i < half; i += 1) rows.push(timed(count - i, '回灌 id ' + (count - i) + '。', minute(i)));
    for (let i = 0; i < half; i += 1) rows.push(timed(half - i, '在线 id ' + (half - i) + '。', minute(half + i)));
    return rows;
  }
  const transcriptOf = (harness: Harness, index: number): string =>
    harness.chatRequests[index]?.request.messages[0]?.content ?? '';

  it('id 序与时间序交错的一批：选 id 最小的那批，transcript 里按时间先后出现，三条一条不落', async () => {
    // 仓储按 created_at 升序返回：id 3 时间最早、id 1 居中、id 2 最晚
    const messages = [timed(3, 'id3 最早', minute(0)), timed(1, 'id1 居中', minute(1)), timed(2, 'id2 最晚', minute(2))];
    const harness = makeHarness({ messages, summaryEveryMessages: 3 });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    // 选区落在游标域：按 id 取最老一批（1、2、3 全中），游标推到批内最大 id
    expect(harness.chatRequests).toHaveLength(1);
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(3);
    // 送模型的顺序按 created_at：id 序（1、2、3）读出来是倒的，必须是 3 → 1 → 2
    const transcript = transcriptOf(harness, 0);
    const at = (text: string): number => transcript.indexOf(text);
    expect(at('id3 最早')).toBeGreaterThan(-1);
    expect(at('id3 最早')).toBeLessThan(at('id1 居中'));
    expect(at('id1 居中')).toBeLessThan(at('id2 最晚'));

    // 下一轮从游标 3 继续：一条不剩，也不会把刚吃过的再吃一遍
    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);
    expect(harness.chatRequests).toHaveLength(1);
    expect(harness.loadAfterCalls[harness.loadAfterCalls.length - 1]?.afterId).toBe(3);
  });

  it('pending 比一批多：按 id 取最老一批（不是时间序前 limit 条），追平之后 60 条一条不漏、一条不重', async () => {
    // 60 条、阈值 3 → 一批 limit=50；时间序前 50 条是 id 60..11，按 id 取最老一批才是 id 1..50
    const messages = backfilled(60);
    const harness = makeHarness({ messages, summaryEveryMessages: 3 });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    // 一次触发循环追平：第一批 50 条（id 1..50），第二批把剩下的 id 51..60 全吃掉
    expect(harness.chatRequests).toHaveLength(2);
    const first = transcriptOf(harness, 0);
    const second = transcriptOf(harness, 1);
    // 选区按 id：第一批是 id 1..50（在线 1..30 + 回灌 31..50）；
    // 旧口径「时间序前 50 条」会选 id 60..11，max id 60 把 id 1..10 永久越过
    expect(second).not.toContain('在线 id');
    for (let id = 1; id <= 30; id += 1) expect(first).toContain('在线 id ' + id + '。');
    for (let id = 31; id <= 50; id += 1) expect(first).toContain('回灌 id ' + id + '。');
    for (let id = 51; id <= 60; id += 1) expect(second).toContain('回灌 id ' + id + '。');
    // 读序按时间：这批里 id 50 最早（00:10）、id 1 最晚（00:59），所以 transcript 首行是 id 50、末行是 id 1
    const firstLines = first.split('\n');
    expect(firstLines[1]).toContain('回灌 id 50');
    expect(firstLines[firstLines.length - 1]).toContain('在线 id 1');
    // 游标一路走到最大 id，60 条一条不漏（每条恰好出现一次）、一条不重
    expect(harness.store.get(storeKey(KEY))?.coveredUntilId).toBe(60);
    const seen = first + '\n' + second;
    for (let id = 1; id <= 60; id += 1) {
      const marker = (id > 30 ? '回灌 id ' : '在线 id ') + id + '。';
      expect(seen.split(marker).length - 1).toBe(1);
    }
  });
});

describe('摘要素材：这批满了就不带 extra（老口径，门牌 summary-order-2 未改）', () => {
  const line = (content: string): SummaryLine => ({ role: 'user', content, author: '小明', authorId: 'u-llp' });

  it('pending 已经用满 limit：extra 一条都不进素材，游标自然也不越过它', () => {
    const pending = [line('第一句旧话'), line('第二句旧话')];
    const extra = [line('本轮这句还没落库')];

    expect(summaryMaterial(pending, extra, 2).map((message) => message.content)).toEqual(['第一句旧话', '第二句旧话']);
  });

  it('pending 没到 limit：extra 补在最后，一起送进模型', () => {
    const pending = [line('第一句旧话')];
    const extra = [line('本轮这句还没落库')];

    expect(summaryMaterial(pending, extra, 2).map((message) => message.content)).toEqual(['第一句旧话', '本轮这句还没落库']);
  });
});

describe('run 自动摘要：失败只降级，不拖累回复', () => {
  it('后台摘要全候选失败：run 照常返回、两条照常落库，只打一行警告', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const harness = makeHarness({ messages: fiftyMessages(), replies: { 'openai-compat': { error: 'boom' } } });

    const result = await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);
    spy.mockRestore();

    expect(result.text).toBe('好的');
    // 回复照旧落库：用户 + 助手两条
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]).toHaveLength(2);
    // 摘要没写成，游标不动
    expect(harness.store.size).toBe(0);
    const failures = warnings.filter((line) => line.includes('[chat] 自动摘要失败：'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('boom');
  });

  it('摘要读库抛错：按「无摘要」继续，system 里没有摘要段，回复正常', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const harness = makeHarness({ messages: fiveMessages(), summaryReadError: 'db down' });

    const result = await harness.service.run(CTX);
    spy.mockRestore();

    expect(result.text).toBe('好的');
    expect(harness.streamRequests[0]?.system).not.toContain('【长期记忆摘要】');
    // 全部历史照样进上下文
    expect(harness.streamRequests[0]?.messages).toHaveLength(6);
    expect(harness.backgroundTasks).toEqual([]);
    expect(warnings.filter((line) => line.includes('[chat] 读取摘要失败，按无摘要继续：db down'))).toHaveLength(1);
  });
});

describe('reset 与 getSummary', () => {
  it('reset 同时清消息与摘要', async () => {
    const harness = makeHarness({ summary: summaryOf('他喜欢猫。', 9) });

    await harness.service.reset(KEY);

    expect(harness.cleared).toEqual([KEY]);
    expect(harness.removed).toEqual([KEY]);
    expect(harness.store.size).toBe(0);
  });

  it('getSummary 读回摘要，没有时返回 null', async () => {
    const withSummary = makeHarness({ summary: summaryOf('他喜欢猫。', 9) });
    expect(await withSummary.service.getSummary(KEY)).toEqual(summaryOf('他喜欢猫。', 9));

    const empty = makeHarness();
    expect(await empty.service.getSummary(KEY)).toBeNull();
  });

  it('getSummary 如实抛错：读库失败不吞成 null', async () => {
    const harness = makeHarness({ summaryReadError: 'db down' });

    let message = '';
    await harness.service.getSummary(KEY).catch((caught: unknown) => {
      message = caught instanceof Error ? caught.message : String(caught);
    });

    expect(message).toBe('db down');
  });
});

describe('日志钩子（§19.6）：摘要两条事件', () => {
  it('自动摘要成功：一条 info/summary，message 逐字带 covered/msgs/len', async () => {
    const harness = makeHarness({ messages: fiftyMessages() });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    const entries = harness.logEntries.filter((entry) => entry.scope === 'summary');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].createdAt).toBe(FIXED_NOW);
    expect(entries[0].message).toBe('自动摘要完成 covered=50 msgs=50 len=11');
    // 同一轮还有且只有一条 chat 成功事件：两个 scope 各记各的
    expect(harness.logEntries.filter((entry) => entry.scope === 'chat')).toHaveLength(1);
  });

  it('自动摘要失败：一条 warn/summary，message 与全候选失败的抛错同源', async () => {
    const harness = makeHarness({ messages: fiftyMessages(), replies: { 'openai-compat': { error: 'boom' } } });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    const entries = harness.logEntries.filter((entry) => entry.scope === 'summary');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].createdAt).toBe(FIXED_NOW);
    expect(entries[0].message).toBe(
      '自动摘要失败 ALL_PROVIDERS_FAILED: ' + JSON.stringify([{ model: ROUTE.primary, error: 'boom' }]),
    );
  });

  it('失败原因进日志只留前 300 字', async () => {
    const harness = makeHarness({
      messages: fiftyMessages(),
      replies: { 'openai-compat': { error: 'x'.repeat(400) } },
    });

    await harness.service.run(CTX);
    await Promise.all(harness.backgroundTasks);

    const entries = harness.logEntries.filter((entry) => entry.scope === 'summary');
    expect(entries).toHaveLength(1);
    expect(entries[0].message.startsWith('自动摘要失败 ALL_PROVIDERS_FAILED: ')).toBe(true);
    expect(entries[0].message).toHaveLength('自动摘要失败 '.length + 300);
  });

  it('手动 summarize 成功也记一条 info/summary', async () => {
    const harness = makeHarness({ messages: fiveMessages() });

    await harness.service.summarize(KEY);

    expect(harness.logEntries).toHaveLength(1);
    expect(harness.logEntries[0].level).toBe('info');
    expect(harness.logEntries[0].scope).toBe('summary');
    expect(harness.logEntries[0].createdAt).toBe(FIXED_NOW);
    expect(harness.logEntries[0].message).toBe('自动摘要完成 covered=5 msgs=5 len=11');
  });

  it('没触发自动总结时只有 chat 一条日志', async () => {
    const harness = makeHarness({ messages: fiveMessages() });

    await harness.service.run(CTX);

    expect(harness.logEntries).toHaveLength(1);
    expect(harness.logEntries[0].scope).toBe('chat');
  });
});

/** 带落库时刻的消息：段头时间段靠它算 */
const stamped = (id: number, content: string, createdAt: string): StoredMessage => ({ ...stored(id, content), createdAt });

describe('summarize：覆盖时间段（§27）', () => {
  it('落库这批消息的最早/最晚时刻，段头据此写「说话的时间」', async () => {
    const harness = makeHarness({
      messages: [
        stamped(1, '第一句', '2026-10-25T14:40:00.000Z'),
        stamped(2, '第二句', '2026-10-25T20:00:00.000Z'),
        stamped(3, '第三句', '2026-10-25T23:59:00.000Z'),
      ],
    });

    await harness.service.summarize(KEY);

    const saved = await harness.service.getSummary(KEY);
    expect(saved?.coveredFrom).toBe('2026-10-25T14:40:00.000Z');
    expect(saved?.coveredTo).toBe('2026-10-25T23:59:00.000Z');
  });

  it('滚动总结时与上一版的时间段合并，区间只延展不回缩', async () => {
    const previous: ConversationSummary = {
      ...summaryOf('更早的摘要', 10),
      coveredFrom: '2026-10-20T01:00:00.000Z',
      coveredTo: '2026-10-21T02:00:00.000Z',
    };
    const harness = makeHarness({
      messages: [
        stamped(11, '新的第一句', '2026-10-25T14:40:00.000Z'),
        stamped(12, '新的第二句', '2026-10-25T23:59:00.000Z'),
      ],
      summary: previous,
    });

    await harness.service.summarize(KEY);

    const saved = await harness.service.getSummary(KEY);
    expect(saved?.coveredFrom).toBe('2026-10-20T01:00:00.000Z');
    expect(saved?.coveredTo).toBe('2026-10-25T23:59:00.000Z');
  });

  it('没有落库时刻的消息不写时间段，段头退回裸的【记忆段】', async () => {
    const harness = makeHarness({ messages: fiveMessages() });

    await harness.service.summarize(KEY);

    const saved = await harness.service.getSummary(KEY);
    expect(saved?.coveredFrom).toBeUndefined();
    expect(saved?.coveredTo).toBeUndefined();
  });
});

describe('累计记忆：只追加不重写', () => {
  it('连续两次总结：库里攒成两段，第一段逐字未变，第二段段头只写这一批的时间段', async () => {
    const messages = [
      stamped(1, '第一句', '2026-10-25T14:40:00.000Z'),
      stamped(2, '第二句', '2026-10-25T20:00:00.000Z'),
    ];
    const harness = makeHarness({ messages, replyTexts: ['他喜欢猫。', '他养了两只猫。'] });

    await harness.service.summarize(KEY);
    const first = harness.store.get(storeKey(KEY))?.summary ?? '';
    expect(first.startsWith('【记忆段】')).toBe(true);
    expect(first).toContain('2026年10月25日22时40分');
    expect(first.endsWith('他喜欢猫。')).toBe(true);

    messages.push(stamped(3, '第三句', '2026-10-26T06:30:00.000Z'));
    await harness.service.summarize(KEY);

    const second = harness.store.get(storeKey(KEY))?.summary ?? '';
    // 老段一个字都不能动：第一段原样是新文本的前缀
    expect(second.startsWith(first)).toBe(true);
    expect(second.slice(first.length).startsWith('\n\n【记忆段】')).toBe(true);
    expect(second.endsWith('他养了两只猫。')).toBe(true);
    expect(second.match(/【记忆段】/g)).toHaveLength(2);
    expect(second).toContain('2026年10月26日14时30分');
    // 第二段的段头是这一批自己的时间段，不把第一次的起点也抄一遍
    expect(second.slice(first.length)).not.toContain('2026年10月25日22时40分');
    // 第二次请求把已有记忆整份当参考送过去
    expect(harness.chatRequests[1]?.request.messages[0]?.content).toContain('【已有记忆】\n' + first);
  });

  it('老数据（没有段头）之后再总结：新段接在尾部，老文本原样留在最前', async () => {
    const harness = makeHarness({
      messages: [stamped(6, '新的一句', '2026-10-26T06:30:00.000Z')],
      summary: summaryOf('老摘要正文：他喜欢猫', 5),
      replyTexts: ['他养了两只猫。'],
    });

    await harness.service.summarize(KEY);

    const saved = harness.store.get(storeKey(KEY))?.summary ?? '';
    expect(saved.startsWith('老摘要正文：他喜欢猫\n\n【记忆段】')).toBe(true);
    expect(saved.endsWith('他养了两只猫。')).toBe(true);
  });
});

describe('run 注入累计记忆：旧→新排序与字数预算', () => {
  const twoSegments = '【记忆段】\n老记忆：他喜欢猫\n\n【记忆段】\n新记忆：他养了两只猫';

  it('多段记忆按旧→新顺序进本轮用户消息，段头原样带出', async () => {
    const harness = makeHarness({ messages: fiveMessages(), summary: summaryOf(twoSegments, 9) });

    await harness.service.run(CTX);

    const turn = harness.streamRequests[0]?.messages.at(-1)?.content ?? '';
    expect(turn).toContain('【长期记忆摘要】\n【记忆段】\n老记忆：他喜欢猫\n\n【记忆段】\n新记忆：他养了两只猫');
    expect(turn.indexOf('老记忆：他喜欢猫')).toBeLessThan(turn.indexOf('新记忆：他养了两只猫'));
  });

  it('摘要超预算时只装最新的段，更老的内容不进本轮用户消息', async () => {
    const harness = makeHarness({
      messages: fiveMessages(),
      summary: summaryOf(twoSegments, 9),
      summaryMaxChars: 16,
    });

    await harness.service.run(CTX);

    const turn = harness.streamRequests[0]?.messages.at(-1)?.content ?? '';
    expect(turn).toContain('新记忆：他养了两只猫');
    expect(turn).not.toContain('老记忆');
  });
});

describe('§35 选择性补记：追加一段新记忆、游标一个字节都不动', () => {
  const RANGE = { from: '2026-10-25T14:00:00.000Z', to: '2026-10-25T15:00:00.000Z' };
  const inRange = (): StoredMessage[] => [
    stamped(11, '第一句旧话', '2026-10-25T14:10:00.000Z'),
    stamped(12, '第二句旧话', '2026-10-25T14:30:00.000Z'),
    stamped(13, '第三句旧话', '2026-10-25T14:50:00.000Z'),
  ];

  it('补记 3 条：尾部多一段、段头写这一段的起止时刻、游标与覆盖区间原样不动', async () => {
    const harness = makeHarness({
      messages: inRange(),
      summary: summaryOf('他喜欢猫。', 5),
      replyTexts: ['那段时间他家的猫叫橘子。'],
    });

    const outcome = await harness.service.backfill(KEY, RANGE);

    const expected = appendSegment(
      '他喜欢猫。',
      '那段时间他家的猫叫橘子。',
      '2026-10-25T14:10:00.000Z',
      '2026-10-25T14:50:00.000Z',
    );
    const saved = harness.store.get(storeKey(KEY));
    expect(saved?.summary).toBe(expected);
    // 段头是这一段自己的覆盖时间段（北京时间 22:10 ~ 22:50），不是「现在」
    expect(saved?.summary).toContain('2026年10月25日22时10分');
    expect(saved?.summary).toContain('22时50分');
    // 关键是这三行：补记是往回补，不能骗自动总结说这段已经总结过了
    expect(saved?.coveredUntilId).toBe(5);
    expect(saved?.coveredFrom).toBeUndefined();
    expect(saved?.coveredTo).toBeUndefined();
    expect(saved?.updatedAt).toBe(FIXED_NOW);

    // 提示词与自动总结同源：既有记忆当参考、这 3 条原文进 transcript
    expect(harness.chatRequests[0]?.request.messages[0]?.content).toContain('【已有记忆】\n他喜欢猫。');
    expect(harness.chatRequests[0]?.request.messages[0]?.content).toContain('第二句旧话');

    expect(outcome).toEqual({
      summarizedMessages: 3,
      from: RANGE.from,
      to: RANGE.to,
      summaryLength: expected.length,
      model: 'gpt-4o-mini',
    });
    expect(harness.logEntries.at(-1)?.message).toBe(
      '[chat] 补记完成 msgs=3 len=' + String(expected.length) + ' model=gpt-4o-mini',
    );
    // 少于 6 条时预览整份给出
    expect((await harness.service.previewBackfill(KEY, RANGE)).samples).toHaveLength(3);
  });

  it('范围内一条都没有：返回 null，一次模型调用都不发', async () => {
    const harness = makeHarness({
      messages: [stamped(1, '第一句', '2026-10-20T00:00:00.000Z')],
      summary: summaryOf('他喜欢猫。', 1),
    });

    expect(await harness.service.backfill(KEY, RANGE)).toBeNull();
    expect(harness.chatRequests).toEqual([]);
    expect(harness.store.get(storeKey(KEY))?.summary).toBe('他喜欢猫。');
  });

  it('summaries 未接线：backfill 返回 null（与 summarize 同口径）', async () => {
    const harness = makeHarness({ messages: inRange() });
    const service = createChatService({ ...harness.deps, summaries: undefined });

    expect(await service.backfill(KEY, RANGE)).toBeNull();
    expect(harness.chatRequests).toEqual([]);
  });

  it('范围 501 条：抛 RangeTooLargeError(500)，记忆与游标都不动', async () => {
    const rows = Array.from({ length: 501 }, (_unused, index) =>
      stamped(index + 1, '旧话' + String(index + 1), '2026-10-25T14:00:00.000Z'),
    );
    const harness = makeHarness({ messages: rows, summary: summaryOf('他喜欢猫。', 0) });

    const thrown = await harness.service.backfill(KEY, RANGE).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RangeTooLargeError);
    expect(thrown instanceof RangeTooLargeError ? thrown.limit : null).toBe(500);
    expect(harness.chatRequests).toEqual([]);
    expect(harness.store.get(storeKey(KEY))?.summary).toBe('他喜欢猫。');
  });

  it('previewBackfill：数条数、首尾各 3 条样本、单次最多读 501 条', async () => {
    const rows = Array.from({ length: 8 }, (_unused, index) =>
      stamped(index + 1, '旧话' + String(index + 1), '2026-10-25T14:0' + String(index) + ':00.000Z'),
    );
    const harness = makeHarness({ messages: rows });

    const preview = await harness.service.previewBackfill(KEY, RANGE);

    expect(harness.loadBetweenCalls[0]).toEqual({ fromIso: RANGE.from, toIso: RANGE.to, limit: 501 });
    expect(preview.count).toBe(8);
    expect(preview.tooLarge).toBe(false);
    expect(preview.firstAt).toBe('2026-10-25T14:00:00.000Z');
    expect(preview.lastAt).toBe('2026-10-25T14:07:00.000Z');
    expect(preview.samples).toEqual([
      '[2026-10-25 22:00] 小明：旧话1',
      '[2026-10-25 22:01] 小明：旧话2',
      '[2026-10-25 22:02] 小明：旧话3',
      '[2026-10-25 22:05] 小明：旧话6',
      '[2026-10-25 22:06] 小明：旧话7',
      '[2026-10-25 22:07] 小明：旧话8',
    ]);
    // 预览不花一次模型调用，也不碰记忆
    expect(harness.chatRequests).toEqual([]);
    expect(harness.store.size).toBe(0);
  });

  it('previewBackfill 超额：count 只报到上限 + 1，tooLarge 为真', async () => {
    const rows = Array.from({ length: 520 }, (_unused, index) =>
      stamped(index + 1, '旧话', '2026-10-25T14:00:00.000Z'),
    );
    const harness = makeHarness({ messages: rows });

    const preview = await harness.service.previewBackfill(KEY, RANGE);

    expect(preview.count).toBe(501);
    expect(preview.tooLarge).toBe(true);
  });

  it('没有可用路由：抛 NO_ROUTE_CONFIGURED，记忆一个字都不写', async () => {
    const harness = makeHarness({ messages: inRange(), route: null });

    const thrown = await harness.service.backfill(KEY, RANGE).catch((error: unknown) => error);

    expect(thrown instanceof Error ? thrown.message : '').toBe('NO_ROUTE_CONFIGURED');
    expect(harness.store.size).toBe(0);
  });
});

describe('§63 连续总结：一批 500 条、回报剩余、没完接着来', () => {
  /** 正文带序号：能看出每一批送进模型的是哪 500 条，也能看出记忆是按段追加的 */
  const rows = (count: number): StoredMessage[] =>
    Array.from({ length: count }, (_unused, index) => stored(index + 1, 'x' + String(index + 1)));

  it('1200 条分三批吃完（500 / 500 / 200）：剩余 700 / 200 / 0，第四批没有素材', async () => {
    const harness = makeHarness({ messages: rows(1200), replyTexts: ['第一批', '第二批', '第三批'] });

    const first = await harness.service.summarizeSweep(KEY);
    expect(first.outcome?.summarizedMessages).toBe(500);
    expect(first.outcome?.coveredUntilId).toBe(500);
    expect(first.remaining).toBe(700);

    const second = await harness.service.summarizeSweep(KEY);
    expect(second.outcome?.summarizedMessages).toBe(500);
    expect(second.outcome?.coveredUntilId).toBe(1000);
    expect(second.remaining).toBe(200);

    const third = await harness.service.summarizeSweep(KEY);
    expect(third.outcome?.summarizedMessages).toBe(200);
    expect(third.remaining).toBe(0);

    // 记忆只追加不重写：三批都在，游标停在最后一条
    const saved = harness.store.get(storeKey(KEY));
    expect(saved?.coveredUntilId).toBe(1200);
    expect(saved?.summary).toContain('第一批');
    expect(saved?.summary).toContain('第三批');

    // 第二批从第一批的游标之后开始，不是从头再来
    expect(harness.chatRequests[1]?.request.messages[0]?.content).toContain('x501');
    expect(harness.chatRequests[1]?.request.messages[0]?.content).not.toContain('x500');

    const empty = await harness.service.summarizeSweep(KEY);
    expect(empty).toEqual({ outcome: null, remaining: 0 });
    expect(harness.chatRequests).toHaveLength(3);
  });

  it('不吃频道阈值：summaryEveryMessages=20 时一批仍吃满 500 条', async () => {
    const harness = makeHarness({ messages: rows(600), summaryEveryMessages: 20 });

    const result = await harness.service.summarizeSweep(KEY);

    expect(result.outcome?.summarizedMessages).toBe(500);
    expect(result.remaining).toBe(100);
  });
});
