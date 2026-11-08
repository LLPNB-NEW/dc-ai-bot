import { describe, expect, it, vi } from 'vitest';
import { SUMMARY_MAX_CHARS } from '../src/core/chat/summary';
import { createChatService } from '../src/core/chat/service';
import type { ChatServiceDeps } from '../src/core/chat/service';
import type {
  ChannelKey,
  ChannelMemoryConfig,
  ChatMessage,
  ConversationSummary,
  DecryptedKey,
  LlmChunk,
  LlmProvider,
  LlmRequest,
  ProviderId,
  ProviderRuntime,
  RouteConfig,
  TurnContext,
} from '../src/core/types';

const CTX: TurnContext = {
  guildId: 'g1',
  channelId: 'c1',
  userId: 'u1',
  userName: '阿天',
  guildName: '测试公会',
  channelName: '测试频道',
  botName: '小助手',
  userText: '你好',
};

const ROUTE: RouteConfig = { primary: { provider: 'openai-compat', model: 'gpt-4o-mini' }, fallbacks: [] };

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

interface MemoryHarness {
  deps: ChatServiceDeps;
  requests: LlmRequest[];
  loadAllCalls: Array<{ guildId: string; channelId: string }>;
  appendCalls: Array<{ key: { guildId: string; channelId: string }; messages: ChatMessage[] }>;
  clearCalls: Array<{ guildId: string; channelId: string }>;
}

const FIXED_NOW = '2026-10-25T03:00:00.000Z';
/** FIXED_NOW 的北京时间（UTC+8）戳前缀：本轮这句话必须带它 */
const STAMP = '[10-25 11:00] ';
function makeHarness(input: { history: ChatMessage[]; reply: string }): MemoryHarness {
  const requests: LlmRequest[] = [];
  const loadAllCalls: MemoryHarness['loadAllCalls'] = [];
  const appendCalls: MemoryHarness['appendCalls'] = [];
  const clearCalls: MemoryHarness['clearCalls'] = [];
  const state: ChatMessage[] = [...input.history];

  const decrypted: DecryptedKey = { id: 'k1', provider: 'openai-compat', label: 'k1', apiKey: 'sk-test', models: [] };
  const provider: LlmProvider = {
    id: 'openai-compat',
    chat: async () => {
      throw new Error('流式路径不应调用 chat()');
    },
    listModels: async () => [],
    chatStream(req: LlmRequest, _rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      requests.push(req);
      return (async function* () {
        yield { delta: input.reply, finishReason: 'stop' };
      })();
    },
  };
  const unusedProvider = (id: ProviderId): LlmProvider => ({
    id,
    chat: async () => {
      throw new Error('未配置 key 的 provider 不应被调用');
    },
    listModels: async () => [],
    chatStream(): AsyncIterable<LlmChunk> {
      throw new Error('未配置 key 的 provider 不应被调用');
    },
  });

  const config: ChatServiceDeps['config'] = {};

  const deps: ChatServiceDeps = {
    prompts: {
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    routes: {
      async get(key) {
        return key.scope === 'global' ? ROUTE : null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    keys: {
      async listEnabled(providerId) {
        return providerId === 'openai-compat' ? [decrypted] : [];
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
      async loadRecent(_key, limit) {
        return state.slice(Math.max(0, state.length - limit));
      },
      async loadAll(key) {
        loadAllCalls.push(key);
        return [...state];
      },
      async append(key, messages) {
        appendCalls.push({ key, messages });
        state.push(...messages);
      },
      async clear(key) {
        clearCalls.push(key);
      },
      async loadAfter(_key, afterId) {
        return state.map((message, index) => ({ ...message, id: index + 1 })).filter((message) => message.id > afterId);
      },
      async loadLatest() {
        return [];
      },
      async loadBetween() {
        return [];
      },
    },
    summaries: {
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    providers: {
      'openai-compat': provider,
      anthropic: unusedProvider('anthropic'),
      gemini: unusedProvider('gemini'),
    },
    now: () => new Date(FIXED_NOW),
    config,
  };

  return { deps, requests, loadAllCalls, appendCalls, clearCalls };
}

describe('记忆接线：最近 50 条原文进上下文', () => {
  const history = [user('aaaaaa'), assistant('bbbbbb'), user('cc'), assistant('dd')];

  it('loadAll 取该频道全部历史，50 条以内原样送进请求，当前 userText 署名后追加为最后一条', async () => {
    const harness = makeHarness({ history, reply: '收到' });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    expect(harness.loadAllCalls).toEqual([{ guildId: 'g1', channelId: 'c1' }]);
    expect(harness.requests[0]?.messages).toEqual([...history, user(STAMP + '阿天(u1)：你好')]);
    expect(harness.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: STAMP + '阿天(u1)：你好' });
  });

  it('只注入最近 50 条原文：更早的省略，但库里一条不删（loadAll 仍读全部）', async () => {
    const many: ChatMessage[] = [];
    for (let index = 0; index < 60; index += 1) {
      many.push(index % 2 === 0 ? user('问' + String(index)) : assistant('答' + String(index)));
    }
    const harness = makeHarness({ history: many, reply: 'ok' });

    await createChatService(harness.deps).run(CTX);

    expect(harness.loadAllCalls).toHaveLength(1);
    const sent = harness.requests[0]?.messages ?? [];
    // 50 条历史 + 本轮这一条
    expect(sent).toHaveLength(51);
    // 丢掉的是最旧的 10 条（问0..答9），第一条留下的是「问10」
    expect(sent[0]?.content).toContain('问10');
  });

  it('成功后 append 用户+助手两条，不再有 prune 之类的删行动作', async () => {
    const harness = makeHarness({ history, reply: '收到' });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(result.text).toBe('收到');
    expect(harness.appendCalls).toEqual([
      {
        key: { guildId: 'g1', channelId: 'c1' },
        messages: [
          { role: 'user', content: '你好', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
          { role: 'assistant', content: '收到', author: '小助手', createdAt: FIXED_NOW },
        ],
      },
    ]);
  });

  it('reset 直接委托 conversations.clear', async () => {
    const harness = makeHarness({ history: [], reply: 'ok' });
    const service = createChatService(harness.deps);

    await service.reset({ guildId: 'g9', channelId: 'c9' });

    expect(harness.clearCalls).toEqual([{ guildId: 'g9', channelId: 'c9' }]);
    expect(harness.appendCalls).toEqual([]);
  });
});

interface ConfigHarness {
  deps: ChatServiceDeps;
  requests: LlmRequest[];
  summaryRequests: LlmRequest[];
  loadAfterCalls: Array<{ key: ChannelKey; afterId: number; limit: number | undefined }>;
  appendCalls: Array<{ key: ChannelKey; messages: ChatMessage[] }>;
  backgroundTasks: Promise<unknown>[];
  memoryGets: ChannelKey[];
  savedSummaries: ConversationSummary[];
}

interface ConfigHarnessInput {
  history: ChatMessage[];
  reply: string;
  /** 不传就用空配置：两个数字全部落到代码默认 */
  config?: ChatServiceDeps['config'];
  /** §26 频道行：null = 库里没有这一行 */
  channelMemoryRow?: ChannelMemoryConfig | null;
  /** 读配置直接抛错：验证降级到默认、回复照常 */
  channelMemoryError?: string;
  /** 干脆不接线 channelMemory：验证行为与接线前逐字一致 */
  noChannelMemory?: boolean;
  /** 摘要库有状态：get() 读回最近一次 put——循环追平全靠游标真的往前走来收敛 */
  trackSummaries?: boolean;
  /** 第 N 次之后的摘要 chat 直接抛错：验证循环中途失败只 warn 一次、不留未处理拒绝 */
  failSummaryAfter?: number;
  /** 摘要模型回的原文：预算截断的用例要看 model 回了多长 */
  summaryText?: string;
  /** 库里已有的摘要：注入侧按预算挑段全靠它 */
  summary?: ConversationSummary;
}

const MEMORY_KEY: ChannelKey = { guildId: 'g1', channelId: 'c1' };

const memoryRow = (historyMaxMessages: number, summaryEveryMessages: number): ChannelMemoryConfig => ({
  guildId: MEMORY_KEY.guildId,
  channelId: MEMORY_KEY.channelId,
  historyMaxMessages,
  summaryEveryMessages,
  updatedAt: '2026-10-25T00:00:00.000Z',
});

/** 带序号的成对历史：窗口断言直接看第一条留下的是谁 */
function numberedHistory(count: number): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    history.push(index % 2 === 0 ? user('问' + String(index)) : assistant('答' + String(index)));
  }
  return history;
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/** 跑一轮并把 [chat] turn 那一行捞出来：hist / sum 的断言全靠它 */
async function runTurn(harness: ConfigHarness): Promise<{ text: string; turnLine: string | undefined }> {
  const logs = captureLog();
  try {
    const result = await createChatService(harness.deps).run(CTX);
    return { text: result.text, turnLine: logs.lines.filter((line) => line.startsWith('[chat] turn'))[0] };
  } finally {
    logs.restore();
  }
}

function makeConfigHarness(input: ConfigHarnessInput): ConfigHarness {
  const requests: LlmRequest[] = [];
  const summaryRequests: LlmRequest[] = [];
  const loadAfterCalls: ConfigHarness['loadAfterCalls'] = [];
  const appendCalls: ConfigHarness['appendCalls'] = [];
  const backgroundTasks: Promise<unknown>[] = [];
  const memoryGets: ChannelKey[] = [];
  const savedSummaries: ConversationSummary[] = [];
  const state: ChatMessage[] = [...input.history];

  const decrypted: DecryptedKey = { id: 'k1', provider: 'openai-compat', label: 'k1', apiKey: 'sk-test', models: [] };
  const provider: LlmProvider = {
    id: 'openai-compat',
    async chat(request) {
      // 非流式这条路只有摘要会走：一次调用 = 一次摘要请求
      summaryRequests.push(request);
      // 循环中途失败（§26 追加语义）：第 failSummaryAfter 次之后一律报错
      if (input.failSummaryAfter !== undefined && summaryRequests.length > input.failSummaryAfter) {
        throw new Error('摘要模型 502');
      }
      return { text: input.summaryText ?? '摘要正文' };
    },
    async listModels() {
      return [];
    },
    chatStream(request: LlmRequest, _rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      requests.push(request);
      return (async function* () {
        yield { delta: input.reply, finishReason: 'stop' };
      })();
    },
  };
  const unusedProvider = (id: ProviderId): LlmProvider => ({
    id,
    chat: async () => {
      throw new Error('未配置 key 的 provider 不应被调用');
    },
    listModels: async () => [],
    chatStream(): AsyncIterable<LlmChunk> {
      throw new Error('未配置 key 的 provider 不应被调用');
    },
  });

  const deps: ChatServiceDeps = {
    prompts: {
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    routes: {
      async get(key) {
        return key.scope === 'global' ? ROUTE : null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    keys: {
      async listEnabled(providerId) {
        return providerId === 'openai-compat' ? [decrypted] : [];
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
      async loadRecent(_key, limit) {
        return state.slice(Math.max(0, state.length - limit));
      },
      async loadAll() {
        return [...state];
      },
      async append(key, messages) {
        appendCalls.push({ key, messages });
        state.push(...messages);
      },
      async clear() {},
      async loadAfter(key, afterId, limit) {
        loadAfterCalls.push({ key, afterId, limit });
        const rows = state
          .map((message, index) => ({ ...message, id: index + 1 }))
          .filter((message) => message.id > afterId);
        return limit === undefined ? rows : rows.slice(0, limit);
      },
      async loadLatest() {
        return [];
      },
      async loadBetween() {
        return [];
      },
    },
    summaries: {
      async get() {
        if (input.summary !== undefined) return input.summary;
        if (input.trackSummaries !== true) return null;
        return savedSummaries[savedSummaries.length - 1] ?? null;
      },
      async list() {
        return [];
      },
      async put(entry) {
        savedSummaries.push(entry);
      },
      async remove() {},
    },
    providers: {
      'openai-compat': provider,
      anthropic: unusedProvider('anthropic'),
      gemini: unusedProvider('gemini'),
    },
    background(task) {
      backgroundTasks.push(task);
    },
    now: () => new Date(FIXED_NOW),
    config: input.config ?? {},
  };

  if (input.noChannelMemory !== true) {
    deps.channelMemory = {
      async get(key) {
        memoryGets.push(key);
        if (input.channelMemoryError !== undefined) throw new Error(input.channelMemoryError);
        return input.channelMemoryRow ?? null;
      },
      async list() {
        return [];
      },
      async put() {
        throw new Error('unused');
      },
      async remove() {},
    };
  }

  return { deps, requests, summaryRequests, loadAfterCalls, appendCalls, backgroundTasks, memoryGets, savedSummaries };
}

describe('§26 频道记忆配置：每轮读一次、频道行优先', () => {
  it('频道行 30 / 0 压过 config 的 50 / 50：窗口只送 30 条，一次摘要请求都不发', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(60),
      reply: '收到',
      channelMemoryRow: memoryRow(30, 0),
      config: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    });

    const turn = await runTurn(harness);

    expect(turn.text).toBe('收到');
    // 每轮读一次，键就是本轮的频道
    expect(harness.memoryGets).toEqual([MEMORY_KEY]);
    // 窗口 = 最近 30 条 + 本轮这一条；丢掉的是最旧的 30 条（问0..答29）
    expect(harness.requests[0]?.messages).toHaveLength(31);
    expect(harness.requests[0]?.messages[0]?.content).toContain('问30');
    // 落库仍是本轮两条：窗口裁剪不动库里
    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.appendCalls[0]?.messages).toEqual([
      { role: 'user', content: '你好', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
      { role: 'assistant', content: '收到', author: '小助手', createdAt: FIXED_NOW },
    ]);
    // 0 = 关闭自动总结：不查 loadAfter、不调模型、不排后台任务
    expect(harness.loadAfterCalls).toEqual([]);
    expect(harness.summaryRequests).toEqual([]);
    expect(harness.backgroundTasks).toEqual([]);
    // 日志里的两个数字是本轮真正生效的，不是代码默认的 50
    expect(turn.turnLine).toContain(' hist=30 sum=0');
  });

  it('频道行 100 / 100：窗口 100 条，攒够 100 条才触发自动总结', async () => {
    const full = makeConfigHarness({
      history: numberedHistory(120),
      reply: '收到',
      channelMemoryRow: memoryRow(100, 100),
    });

    const turn = await runTurn(full);

    // 窗口 = 最近 100 条 + 本轮这一条（丢掉最旧的 20 条）
    expect(full.requests[0]?.messages).toHaveLength(101);
    expect(full.requests[0]?.messages[0]?.content).toContain('问20');
    expect(full.backgroundTasks).toHaveLength(1);
    await Promise.all(full.backgroundTasks);

    // 触发判定带 100 条上限，第二次是不带上限的素材查询；一批就吃掉 100 条，
    // 第三次从游标 100 数剩余（22 条 < 100）后收手，所以仍然只总结一批
    expect(full.loadAfterCalls).toEqual([
      { key: MEMORY_KEY, afterId: 0, limit: 100 },
      { key: MEMORY_KEY, afterId: 0, limit: undefined },
      { key: MEMORY_KEY, afterId: 100, limit: 100 },
    ]);
    expect(full.summaryRequests).toHaveLength(1);
    expect(full.savedSummaries).toHaveLength(1);
    expect(turn.turnLine).toContain(' hist=100 sum=100');

    // 差一条就不够阈值：本轮落库后库里共 99 条（97 条历史 + 本轮两条），不触发
    const under = makeConfigHarness({
      history: numberedHistory(97),
      reply: '收到',
      channelMemoryRow: memoryRow(100, 100),
    });

    await runTurn(under);

    // 窗口 100 > 库里 97 条，一条不丢；发送侧是 97 条历史 + 本轮这一条
    expect(under.requests[0]?.messages).toHaveLength(98);
    expect(under.loadAfterCalls).toEqual([{ key: MEMORY_KEY, afterId: 0, limit: 100 }]);
    expect(under.backgroundTasks).toEqual([]);
    expect(under.summaryRequests).toEqual([]);
  });

  it('注入只由条数决定：频道配 50、库里 200 条 → 历史正好 50 条 + 本轮，日志 dropped=150', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(200),
      reply: '收到',
      channelMemoryRow: memoryRow(50, 0),
    });

    const turn = await runTurn(harness);

    // 没有字符安全阀：200 条里只按条数丢掉最旧 150 条，留下的 50 条一条不少地进上下文
    const sent = harness.requests[0]?.messages ?? [];
    expect(sent).toHaveLength(51);
    expect(sent[0]?.content).toContain('问150');
    expect(turn.turnLine).toContain(' history=50 of=200 dropped=150');
  });

  it('库里没有这一行：退回 config 的 50 / 50', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(60),
      reply: '收到',
      channelMemoryRow: null,
      config: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    });

    const turn = await runTurn(harness);

    expect(harness.memoryGets).toEqual([MEMORY_KEY]);
    expect(harness.requests[0]?.messages).toHaveLength(51);
    expect(harness.requests[0]?.messages[0]?.content).toContain('问10');
    expect(harness.backgroundTasks).toHaveLength(1);
    await Promise.all(harness.backgroundTasks);

    expect(harness.loadAfterCalls).toEqual([
      { key: MEMORY_KEY, afterId: 0, limit: 50 },
      { key: MEMORY_KEY, afterId: 0, limit: undefined },
      { key: MEMORY_KEY, afterId: 50, limit: 50 },
    ]);
    expect(harness.summaryRequests).toHaveLength(1);
    expect(turn.turnLine).toContain(' hist=50 sum=50');
  });

  it('channelMemory 未接线：一次都不查，行为与接线前逐字一致（默认 50 / 50）', async () => {
    const harness = makeConfigHarness({ history: numberedHistory(60), reply: '收到', noChannelMemory: true });

    const turn = await runTurn(harness);

    expect(harness.memoryGets).toEqual([]);
    expect(harness.requests[0]?.messages).toHaveLength(51);
    expect(harness.requests[0]?.messages[0]?.content).toContain('问10');
    expect(harness.backgroundTasks).toHaveLength(1);
    await Promise.all(harness.backgroundTasks);

    expect(harness.loadAfterCalls).toEqual([
      { key: MEMORY_KEY, afterId: 0, limit: 50 },
      { key: MEMORY_KEY, afterId: 0, limit: undefined },
      { key: MEMORY_KEY, afterId: 50, limit: 50 },
    ]);
    expect(harness.summaryRequests).toHaveLength(1);
    expect(turn.turnLine).toContain(' hist=50 sum=50');
  });

  it('channelMemory.get 抛错：回复照常、阈值按默认 50、只留一条 warn', async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const harness = makeConfigHarness({
      history: numberedHistory(60),
      reply: '收到',
      channelMemoryError: 'D1 挂了',
    });

    let text = '';
    try {
      text = (await createChatService(harness.deps).run(CTX)).text;
    } finally {
      warnSpy.mockRestore();
    }

    expect(text).toBe('收到');
    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.appendCalls[0]?.messages).toHaveLength(2);
    // 降级到默认：窗口 50 条、触发判定带 50 条上限
    expect(harness.requests[0]?.messages).toHaveLength(51);
    expect(harness.backgroundTasks).toHaveLength(1);
    await Promise.all(harness.backgroundTasks);

    expect(harness.loadAfterCalls).toEqual([
      { key: MEMORY_KEY, afterId: 0, limit: 50 },
      { key: MEMORY_KEY, afterId: 0, limit: undefined },
      { key: MEMORY_KEY, afterId: 50, limit: 50 },
    ]);
    const memoryWarnings = warnings.filter((line) => line.includes('读取频道记忆配置失败'));
    expect(memoryWarnings).toEqual(['[chat] 读取频道记忆配置失败，按默认继续：D1 挂了']);
  });

  it('频道行 0 只关自动总结：手动 summarize 照旧总结并落库', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(20),
      reply: '收到',
      channelMemoryRow: memoryRow(30, 0),
    });
    const service = createChatService(harness.deps);

    const outcome = await service.summarize(MEMORY_KEY);

    expect(outcome?.summarizedMessages).toBe(20);
    expect(outcome?.coveredUntilId).toBe(20);
    expect(harness.summaryRequests).toHaveLength(1);
    expect(harness.savedSummaries).toHaveLength(1);

    // 手动那条路不受阈值影响；这一轮 run 仍然一次摘要都不发
    await runTurn(harness);
    expect(harness.summaryRequests).toHaveLength(1);
    expect(harness.loadAfterCalls).toEqual([{ key: MEMORY_KEY, afterId: 0, limit: undefined }]);
  });
});

describe('§26 追加语义：一次触发循环追平到剩余 < 阈值', () => {
  it('阈值 100、积压 202 条：一批吃满 100 条，连跑 2 批把剩余压到 2 < 100', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(200),
      reply: '收到',
      channelMemoryRow: memoryRow(100, 100),
      trackSummaries: true,
    });

    const turn = await runTurn(harness);
    expect(turn.text).toBe('收到');
    expect(harness.backgroundTasks).toHaveLength(1);
    await Promise.all(harness.backgroundTasks);

    // 单批上限跟着阈值走：202 条（200 历史 + 本轮两条）分两批吃完，第二批只剩 2 条
    expect(harness.summaryRequests).toHaveLength(2);
    expect(harness.savedSummaries.map((entry) => entry.coveredUntilId)).toEqual([100, 200]);
    const saved = harness.savedSummaries[harness.savedSummaries.length - 1];
    expect(saved?.coveredUntilId).toBe(200);
    // 追平后仍待总结的条数必须真的低于阈值——这正是旧实现永久落后的地方
    expect(202 - (saved?.coveredUntilId ?? 0)).toBeLessThan(100);

    // 每批的素材查询都从上一批推进后的游标起步，批与批之间不重不漏
    expect(harness.loadAfterCalls).toEqual([
      { key: MEMORY_KEY, afterId: 0, limit: 100 },
      { key: MEMORY_KEY, afterId: 0, limit: undefined },
      { key: MEMORY_KEY, afterId: 100, limit: 100 },
      { key: MEMORY_KEY, afterId: 100, limit: undefined },
      { key: MEMORY_KEY, afterId: 200, limit: 100 },
    ]);
  });

  it('阈值 60、积压 62：一批吃 60 条，剩 2 条不够阈值，只跑 1 批', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(60),
      reply: '收到',
      channelMemoryRow: memoryRow(100, 60),
      trackSummaries: true,
    });

    await runTurn(harness);
    expect(harness.backgroundTasks).toHaveLength(1);
    await Promise.all(harness.backgroundTasks);

    // 62 条里第一批吃掉 60 条，剩 2 条不够阈值：循环一次就退出，没有第二次模型调用
    expect(harness.summaryRequests).toHaveLength(1);
    expect(harness.savedSummaries.map((entry) => entry.coveredUntilId)).toEqual([60]);
    expect(harness.loadAfterCalls).toEqual([
      { key: MEMORY_KEY, afterId: 0, limit: 60 },
      { key: MEMORY_KEY, afterId: 0, limit: undefined },
      { key: MEMORY_KEY, afterId: 60, limit: 60 },
    ]);
  });

  it('上游游标不前进时只多问一次就收手：不会转成死循环', async () => {
    // 故意不打开 trackSummaries：get() 恒为 null，每批都从游标 0 重算，coveredUntilId 恒等于 100
    const harness = makeConfigHarness({
      history: numberedHistory(200),
      reply: '收到',
      channelMemoryRow: memoryRow(100, 100),
    });

    await runTurn(harness);
    await Promise.all(harness.backgroundTasks);

    // 第二批拿回来的 coveredUntilId(100) 没有越过已知游标(100) → 立刻退出，只多花一次模型调用
    expect(harness.summaryRequests).toHaveLength(2);
    expect(harness.savedSummaries.map((entry) => entry.coveredUntilId)).toEqual([100, 100]);
  });

  it('循环中途摘要抛错：run 照常返回、正文落库、后台任务不以拒绝态收场', async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const harness = makeConfigHarness({
      history: numberedHistory(200),
      reply: '收到',
      channelMemoryRow: memoryRow(100, 100),
      trackSummaries: true,
      // 第一批照常成功，第二批的模型调用一律 502
      failSummaryAfter: 1,
    });

    let text = '';
    try {
      text = (await createChatService(harness.deps).run(CTX)).text;
      // 后台任务全部收拢再断言：任何一条以拒绝态结束都会在这里炸成未处理拒绝
      await expect(Promise.all(harness.backgroundTasks)).resolves.toEqual([undefined]);
    } finally {
      warnSpy.mockRestore();
    }

    expect(text).toBe('收到');
    // 正文照旧落库：摘要失败只属于后台，回不到回复路径
    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.appendCalls[0]?.messages).toHaveLength(2);
    expect(harness.appendCalls[0]?.messages[1]).toEqual({
      role: 'assistant',
      content: '收到',
      author: '小助手',
      createdAt: FIXED_NOW,
    });
    // 失败即收手：第一批的游标留着，不重试也不再转圈
    expect(harness.savedSummaries.map((entry) => entry.coveredUntilId)).toEqual([100]);
    expect(harness.summaryRequests).toHaveLength(2);
    const summaryWarnings = warnings.filter((line) => line.startsWith('[chat] 自动摘要失败：'));
    expect(summaryWarnings).toHaveLength(1);
    expect(summaryWarnings[0]).toContain('ALL_PROVIDERS_FAILED');
  });
});

const SUMMARY_HEADING = '【长期记忆摘要】';
const SEGMENT_HEADING = '【记忆段】';

/** 本轮用户消息里摘要块的正文：摘要拼在本轮那条 user 消息的最前面（§52） */
function summaryBlockText(turnContent: string): string {
  const at = turnContent.indexOf(SUMMARY_HEADING + '\n');
  return at < 0 ? '' : turnContent.slice(at + SUMMARY_HEADING.length + 1);
}

/** 两段记忆各约 715 字：默认 4000 装得下两段，1200 只装得下新的一段 */
function twoSegments(): string {
  return [
    SEGMENT_HEADING + '\nOLD_MARK ' + 'a'.repeat(700),
    SEGMENT_HEADING + '\nNEW_MARK ' + 'b'.repeat(700),
  ].join('\n\n');
}

/** system 里最长的一串 x：单段超长时 clipSegment 把正文截到「预算 - 段头 5 - 换行 1 - 省略号 1」 */
function longestXRun(system: string): number {
  return (system.match(/x+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
}

function storedSummary(summary: string): ConversationSummary {
  return {
    guildId: MEMORY_KEY.guildId,
    channelId: MEMORY_KEY.channelId,
    summary,
    coveredUntilId: 10,
    updatedAt: FIXED_NOW,
  };
}

function memoryRowWithBudget(budget: number): ChannelMemoryConfig {
  return { ...memoryRow(50, 0), summaryMaxChars: budget };
}

describe('§26.4 摘要注入预算：频道行 > config > 默认 4000', () => {
  it('频道没配预算时两段记忆全进本轮用户消息（默认 4000 装得下）', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(4),
      reply: '收到',
      channelMemoryRow: memoryRow(50, 0),
      summary: storedSummary(twoSegments()),
    });

    const turn = await runTurn(harness);

    expect(turn.text).toBe('收到');
    const block = summaryBlockText(harness.requests[0]?.messages.at(-1)?.content ?? '');
    expect(block).toContain('OLD_MARK');
    expect(block).toContain('NEW_MARK');
  });

  it('频道配 1200：更老那段整段不进上下文，只剩新的一段', async () => {
    const harness = makeConfigHarness({
      history: numberedHistory(4),
      reply: '收到',
      channelMemoryRow: memoryRowWithBudget(1200),
      summary: storedSummary(twoSegments()),
    });

    await runTurn(harness);

    const block = summaryBlockText(harness.requests[0]?.messages.at(-1)?.content ?? '');
    expect(block).toContain('NEW_MARK');
    // 老段不是被截半截，而是整段不进上下文：装不下就不装
    expect(block).not.toContain('OLD_MARK');
  });

  it('单段超长按预算截断：未配置恰好 4000 字，频道配 1200 恰好 1200 字', async () => {
    const huge = SEGMENT_HEADING + '\n' + 'x'.repeat(5000);

    const open = makeConfigHarness({
      history: numberedHistory(2),
      reply: '收到',
      channelMemoryRow: memoryRow(50, 0),
      summary: storedSummary(huge),
    });
    await runTurn(open);
    expect(longestXRun(open.requests[0]?.messages.at(-1)?.content ?? '')).toBe(SUMMARY_MAX_CHARS - 7);

    const capped = makeConfigHarness({
      history: numberedHistory(2),
      reply: '收到',
      channelMemoryRow: memoryRowWithBudget(1200),
      summary: storedSummary(huge),
    });
    await runTurn(capped);
    expect(longestXRun(capped.requests[0]?.messages.at(-1)?.content ?? '')).toBe(1200 - 7);
  });

  it('频道没配时 config.summaryMaxChars 仍然生效（1500）', async () => {
    const huge = SEGMENT_HEADING + '\n' + 'x'.repeat(5000);
    const harness = makeConfigHarness({
      history: numberedHistory(2),
      reply: '收到',
      channelMemoryRow: memoryRow(50, 0),
      config: { summaryMaxChars: 1500 },
      summary: storedSummary(huge),
    });

    await runTurn(harness);

    expect(longestXRun(harness.requests[0]?.messages.at(-1)?.content ?? '')).toBe(1500 - 7);
  });

  it('落库不按预算截断：频道配 500 也原样存下整段 700 字', async () => {
    const long = 'X'.repeat(700);

    const capped = makeConfigHarness({
      history: numberedHistory(4),
      reply: '收到',
      channelMemoryRow: memoryRowWithBudget(500),
      summaryText: long,
    });
    const outcome = await createChatService(capped.deps).summarize(MEMORY_KEY);
    // 段头单独一行；正文一个字不少——预算只管注入，不砍库里的字
    expect(outcome?.summary.split('\n').slice(1).join('\n')).toBe(long);

    const open = makeConfigHarness({
      history: numberedHistory(4),
      reply: '收到',
      channelMemoryRow: memoryRow(50, 0),
      summaryText: long,
    });
    const full = await createChatService(open.deps).summarize(MEMORY_KEY);
    expect(full?.summary.split('\n').slice(1).join('\n')).toBe(long);
  });
});
