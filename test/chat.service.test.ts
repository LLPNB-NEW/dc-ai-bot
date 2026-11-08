import { describe, expect, it, vi } from 'vitest';
import { createChatService, renderReactionGuide } from '../src/core/chat/service';
import type { ChatServiceDeps, TurnEvents } from '../src/core/chat/service';
import { DEFAULT_REACTION_GUIDE } from '../src/core/chat/reaction-guide';
import { DEFAULT_BODY_EMOJI_GUIDE } from '../src/core/chat/body-emoji';
import { DEFAULT_REACTION_TEMPLATE, REACTION_TEMPLATE_VARS } from '../src/core/chat/reaction-template';
import { NO_REACTION_NOTE, REACTION_HISTORY_MESSAGES } from '../src/core/chat/reaction';
import { renderMentionRule } from '../src/core/chat/mention-dedupe';
import {
  CONTEXT_REPLY_SYSTEM_PREFIX,
  CONTEXT_TOOL_SYSTEM,
  CONTEXT_TOOL_TURN,
} from '../src/core/chat/context-tool';
import type { WorldBook, WorldBookRecord, WorldEntry } from '../src/core/prompt/worldbook';
import { withAuthorPrefix } from '../src/core/chat/line';
import type { ReactionModelStore } from '../src/core/ports';
import type {
  ChannelMemoryConfig,
  ChatMessage,
  ConversationSummary,
  CustomEmoji,
  DecryptedKey,
  LlmChunk,
  LlmImage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LogEntry,
  PromptConfig,
  PromptInjectionConfig,
  ProviderId,
  PromptSegment,
  ProviderRuntime,
  BodyEmojiGuideConfig,
  ReactionGuideConfig,
  ReactionModelConfig,
  ReactionTemplateConfig,
  ReactionTarget,
  RouteConfig,
  ScopedKey,
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

const PRIMARY = { provider: 'openai-compat', model: 'gpt-4o-mini' } as const;
const BACKUP = { provider: 'anthropic', model: 'claude-3-5-haiku' } as const;
const THIRD = { provider: 'gemini', model: 'gemini-2.0-flash' } as const;

const ROUTE: RouteConfig = { primary: PRIMARY, fallbacks: [BACKUP] };

function decryptedKey(provider: ProviderId, overrides: Partial<DecryptedKey> = {}): DecryptedKey {
  return { id: `k-${provider}`, provider, label: provider, apiKey: `sk-${provider}`, models: [], ...overrides };
}

function streamProvider(
  id: ProviderId,
  deltas: string[],
  hooks?: { onRequest?: (req: LlmRequest) => void; onChunk?: () => void },
): LlmProvider {
  return {
    id,
    chat: async () => {
      throw new Error('流式路径不应调用 chat()');
    },
    listModels: async () => [],
    chatStream(req: LlmRequest, _rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      hooks?.onRequest?.(req);
      return (async function* () {
        for (let index = 0; index < deltas.length; index += 1) {
          hooks?.onChunk?.();
          // 真实适配器最后一帧必带结束原因：假供应商不报就会被当成截断而续写
          const last = index === deltas.length - 1;
          yield last ? { delta: deltas[index], finishReason: 'stop' } : { delta: deltas[index] };
        }
      })();
    },
  };
}

function failingProvider(id: ProviderId, message: string): LlmProvider {
  return {
    id,
    chat: async () => {
      throw new Error(message);
    },
    listModels: async () => [],
    chatStream(): AsyncIterable<LlmChunk> {
      return (async function* () {
        throw new Error(message);
      })();
    },
  };
}

/**
 * §55 上下文工具模式的假供应商：正文与调用都从 chatStream 里出来（这一模式已改成流式），
 * chat() 真被调用就直接抛，测试会立刻炸回非流式路径。
 * 每次调用的参数按「前半帧 + 后半帧」两段发出：顺带证明服务层确实把增量拼回了完整 JSON。
 */
function toolProvider(
  id: ProviderId,
  result: LlmResult | (() => Promise<LlmResult>),
  hooks?: { onRequest?: (req: LlmRequest) => void },
): LlmProvider {
  return {
    id,
    async chat(): Promise<LlmResult> {
      throw new Error('上下文工具模式不应调用 chat()');
    },
    async listModels() {
      return [];
    },
    chatStream(req: LlmRequest): AsyncIterable<LlmChunk> {
      hooks?.onRequest?.(req);
      return (async function* () {
        const answer = typeof result === 'function' ? await result() : result;
        const calls = answer.toolCalls ?? [];
        let text = answer.text;
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index];
          if (call === undefined) continue;
          const cut = Math.floor(call.arguments.length / 2);
          // 首帧带 name + 参数前半；同一帧的正文也挂在这里（content 与 tool_calls 同帧的形状）
          yield { delta: text, toolCallDelta: { index, name: call.name, arguments: call.arguments.slice(0, cut) } };
          yield { delta: '', toolCallDelta: { index, arguments: call.arguments.slice(cut) } };
          text = '';
        }
        if (text !== '') yield { delta: text };
        yield { delta: '', finishReason: 'stop' };
      })();
    },
  };
}

function memoryConfig(overrides: Partial<ChannelMemoryConfig> = {}): ChannelMemoryConfig {
  return {
    guildId: 'g1',
    channelId: 'c1',
    historyMaxMessages: 50,
    summaryEveryMessages: 50,
    updatedAt: '2026-10-25T03:00:00.000Z',
    ...overrides,
  };
}

const FIXED_NOW = '2026-10-25T03:00:00.000Z';
/** FIXED_NOW 的北京时间（UTC+8）戳前缀：本轮这句话必须带它 */
const STAMP = '[10-25 11:00] ';
interface Harness {
  deps: ChatServiceDeps;
  events: TurnEvents;
  progress: string[];
  promptKeys: ScopedKey[];
  routeKeys: ScopedKey[];
  keyLookups: ProviderId[];
  providerCalls: ProviderId[];
  requests: LlmRequest[];
  appendCalls: Array<{ key: { guildId: string; channelId: string }; messages: ChatMessage[] }>;
  /** log 钩子收到的每一条（§19.6） */
  logEntries: LogEntry[];
  /** summaries.put 收到的每一份摘要：summarize 换 Key 的断言靠它 */
  summaryPuts: ConversationSummary[];
  /** reactionGuides.get 收到的每一层：没接线时为空 */
  reactionGuideKeys: ScopedKey[];
  /** bodyEmojiGuides.get 收到的每一层：没接线时为空 */
  bodyEmojiGuideKeys: ScopedKey[];
  /** reactionTemplates.get 收到的每一层：没接线时为空 */
  reactionTemplateKeys: ScopedKey[];
  /** promptInjections.get 收到的每一层：没接线时为空 */
  injectionKeys: ScopedKey[];
  /** worldBooks.get 收到的每一层：没接线时为空 */
  worldBookKeys: ScopedKey[];
}

function makeHarness(input: {
  providers: Partial<Record<ProviderId, LlmProvider>>;
  prompts?: { channel?: PromptConfig | null; guild?: PromptConfig | null; global?: PromptConfig | null };
  routes?: { channel?: RouteConfig | null; guild?: RouteConfig | null; global?: RouteConfig | null };
  /** 每个 provider 的 Key：单把、多把（仓储给的 created_at,id 顺序），或 null = 一把都没有 */
  keys?: Partial<Record<ProviderId, DecryptedKey | DecryptedKey[] | null>>;
  history?: ChatMessage[];
  /** 既有长期记忆摘要：给了就有【长期记忆摘要】段，测表情段的位置要靠它 */
  summary?: string | null;
  /** 表情模型配置仓储（§21）；不给 = 老调用方没接线，一次都不问 */
  reactionModels?: ReactionModelStore;
  /** 贴表情提示词三层配置（§28.10）；不给 = 没接线，三层都读不到、落回内置默认 */
  reactionGuides?: {
    channel?: ReactionGuideConfig | null;
    guild?: ReactionGuideConfig | null;
    global?: ReactionGuideConfig | null;
  };
  /** 正文表情提示词三层配置；不给 = 没接线，三层都读不到、描述体与接线前逐字一致 */
  bodyEmojiGuides?: {
    channel?: BodyEmojiGuideConfig | null;
    guild?: BodyEmojiGuideConfig | null;
    global?: BodyEmojiGuideConfig | null;
  };
  /** 表情素材模板三层配置（§34.2）；不给 = 没接线，三层都读不到、落回内置默认模板 */
  reactionTemplates?: {
    channel?: ReactionTemplateConfig | null;
    guild?: ReactionTemplateConfig | null;
    global?: ReactionTemplateConfig | null;
  };
  /** 深度注入三层配置；不给 = 没接线，三层都读不到、messages 与接线前逐字一致 */
  promptInjections?: {
    channel?: PromptInjectionConfig | null;
    guild?: PromptInjectionConfig | null;
    global?: PromptInjectionConfig | null;
  };
  /** 世界书三层配置；不给 = 没接线，三层都读不到、system 与接线前逐字一致 */
  worldBooks?: {
    channel?: WorldBookRecord | null;
    guild?: WorldBookRecord | null;
    global?: WorldBookRecord | null;
  };
  /** 频道级记忆配置（§26）；不给 = 没接线，一次都不问，请求与接线前逐字一致 */
  channelMemory?: ChannelMemoryConfig | null;
}): Harness {
  const progress: string[] = [];
  const promptKeys: ScopedKey[] = [];
  const routeKeys: ScopedKey[] = [];
  const keyLookups: ProviderId[] = [];
  const providerCalls: ProviderId[] = [];
  const requests: LlmRequest[] = [];
  const appendCalls: Harness['appendCalls'] = [];
  const logEntries: LogEntry[] = [];
  const summaryPuts: ConversationSummary[] = [];
  const reactionGuideKeys: ScopedKey[] = [];
  const bodyEmojiGuideKeys: ScopedKey[] = [];
  const reactionTemplateKeys: ScopedKey[] = [];
  const injectionKeys: ScopedKey[] = [];
  const worldBookKeys: ScopedKey[] = [];
  const state: ChatMessage[] = [...(input.history ?? [])];

  const unused = (id: ProviderId): LlmProvider => failingProvider(id, '未被选中的 provider 不应被调用');

  const deps: ChatServiceDeps = {
    prompts: {
      async get(key) {
        promptKeys.push(key);
        const p = input.prompts ?? {};
        if (key.scope === 'channel') return p.channel ?? null;
        if (key.scope === 'guild') return p.guild ?? null;
        return p.global ?? null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    routes: {
      async get(key) {
        routeKeys.push(key);
        const r = input.routes ?? {};
        if (key.scope === 'channel') return r.channel ?? null;
        if (key.scope === 'guild') return r.guild ?? null;
        return r.global ?? null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    keys: {
      async listEnabled(provider) {
        keyLookups.push(provider);
        const configured = input.keys?.[provider];
        if (configured === undefined || configured === null) return [];
        return Array.isArray(configured) ? [...configured] : [configured];
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
      // 全部历史直接进上下文：不做 LIMIT，交给字符安全阀裁剪
      async loadAll() {
        return [...state];
      },
      async append(key, messages) {
        appendCalls.push({ key, messages });
        state.push(...messages);
      },
      async clear() {},
      // 摘要游标比较 id：假存库按索引发号，能测出「游标之后还剩几条」
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
        const text = input.summary ?? '';
        if (text === '') return null;
        return { guildId: 'g1', channelId: 'c1', summary: text, coveredUntilId: 0, updatedAt: FIXED_NOW };
      },
      async list() {
        return [];
      },
      async put(entry) {
        summaryPuts.push(entry);
      },
      async remove() {},
    },
    ...(input.reactionModels === undefined ? {} : { reactionModels: input.reactionModels }),
    ...(input.reactionTemplates === undefined
      ? {}
      : {
          reactionTemplates: {
            async get(key: ScopedKey): Promise<ReactionTemplateConfig | null> {
              reactionTemplateKeys.push(key);
              const configured = input.reactionTemplates ?? {};
              if (key.scope === 'channel') return configured.channel ?? null;
              if (key.scope === 'guild') return configured.guild ?? null;
              return configured.global ?? null;
            },
            async list() {
              return [];
            },
            async put(cfg) {
              return { ...cfg, updatedAt: FIXED_NOW };
            },
            async remove() {},
          },
        }),
    ...(input.reactionGuides === undefined
      ? {}
      : {
          reactionGuides: {
            async get(key: ScopedKey): Promise<ReactionGuideConfig | null> {
              reactionGuideKeys.push(key);
              const configured = input.reactionGuides ?? {};
              if (key.scope === 'channel') return configured.channel ?? null;
              if (key.scope === 'guild') return configured.guild ?? null;
              return configured.global ?? null;
            },
            async list() {
              return [];
            },
            async put(cfg) {
              return { ...cfg, updatedAt: FIXED_NOW };
            },
            async remove() {},
          },
        }),
    ...(input.bodyEmojiGuides === undefined
      ? {}
      : {
          bodyEmojiGuides: {
            async get(key: ScopedKey): Promise<BodyEmojiGuideConfig | null> {
              bodyEmojiGuideKeys.push(key);
              const configured = input.bodyEmojiGuides ?? {};
              if (key.scope === 'channel') return configured.channel ?? null;
              if (key.scope === 'guild') return configured.guild ?? null;
              return configured.global ?? null;
            },
            async list() {
              return [];
            },
            async put(cfg) {
              return { ...cfg, updatedAt: FIXED_NOW };
            },
            async remove() {},
          },
        }),
    ...(input.worldBooks === undefined
      ? {}
      : {
          worldBooks: {
            async get(key: ScopedKey): Promise<WorldBookRecord | null> {
              worldBookKeys.push(key);
              const configured = input.worldBooks ?? {};
              if (key.scope === 'channel') return configured.channel ?? null;
              if (key.scope === 'guild') return configured.guild ?? null;
              return configured.global ?? null;
            },
            async list() {
              return [];
            },
            async put(cfg) {
              return { ...cfg, entryCount: cfg.book.entries.length, importedAt: FIXED_NOW };
            },
            async remove() {},
          },
        }),
    ...(input.promptInjections === undefined
      ? {}
      : {
          promptInjections: {
            async get(key: ScopedKey): Promise<PromptInjectionConfig | null> {
              injectionKeys.push(key);
              const configured = input.promptInjections ?? {};
              if (key.scope === 'channel') return configured.channel ?? null;
              if (key.scope === 'guild') return configured.guild ?? null;
              return configured.global ?? null;
            },
            async list() {
              return [];
            },
            async put(cfg) {
              return { ...cfg, updatedAt: FIXED_NOW };
            },
            async remove() {},
          },
        }),
    ...(input.channelMemory === undefined
      ? {}
      : {
          channelMemory: {
            async get(): Promise<ChannelMemoryConfig | null> {
              return input.channelMemory ?? null;
            },
            async list() {
              return [];
            },
            async put(cfg: Omit<ChannelMemoryConfig, 'updatedAt'>) {
              return { ...cfg, updatedAt: FIXED_NOW };
            },
            async remove() {},
          },
        }),
    providers: {
      'openai-compat': input.providers['openai-compat'] ?? unused('openai-compat'),
      anthropic: input.providers.anthropic ?? unused('anthropic'),
      gemini: input.providers.gemini ?? unused('gemini'),
    },
    now: () => new Date(FIXED_NOW),
    log(entry) {
      logEntries.push(entry);
    },
    config: {},
  };

  return {
    deps,
    events: {
      onProgress(partialText) {
        progress.push(partialText);
      },
    },
    progress,
    promptKeys,
    routeKeys,
    keyLookups,
    providerCalls,
    requests,
    appendCalls,
    logEntries,
    summaryPuts,
    reactionGuideKeys,
    bodyEmojiGuideKeys,
    reactionTemplateKeys,
    injectionKeys,
    worldBookKeys,
  };
}

const track = (id: ProviderId, deltas: string[], h: Pick<Harness, 'requests' | 'providerCalls'>): LlmProvider =>
  streamProvider(id, deltas, {
    onRequest: (req) => {
      h.providerCalls.push(id);
      h.requests.push(req);
    },
  });

describe('run 路由与提示词', () => {
  it('三层路由全空 → 抛 NO_ROUTE_CONFIGURED，且不写记忆', async () => {
    const harness = makeHarness({ providers: {}, keys: { 'openai-compat': decryptedKey('openai-compat') } });
    const service = createChatService(harness.deps);

    await expect(service.run(CTX)).rejects.toThrow('NO_ROUTE_CONFIGURED');
    expect(harness.requests).toHaveLength(0);
    expect(harness.appendCalls).toHaveLength(0);
  });

  it('按 channel/guild/global 的 scopeId 取配置，提示词缺失时 scope 回落 global', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['hi'], { requests: [], providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { channel: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(harness.promptKeys).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
    expect(harness.routeKeys).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
    expect(result.promptScope).toBe('global');
    expect(result.routeScope).toBe('channel');
  });
});

describe('run fallback 链', () => {
  it('primary 抛错 → 第二模型成功，attempts 记录首个失败且 text 来自第二个', async () => {
    const requests: LlmRequest[] = [];
    const calls: ProviderId[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': failingProvider('openai-compat', 'primary 挂了'),
        anthropic: track('anthropic', ['备用', '回答'], { requests, providerCalls: calls }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), anthropic: decryptedKey('anthropic') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(result.text).toBe('备用回答');
    expect(result.model).toEqual(BACKUP);
    expect(result.attempts).toEqual([{ model: PRIMARY, error: 'primary 挂了' }]);
    expect(harness.keyLookups).toEqual(['openai-compat', 'anthropic']);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe('claude-3-5-haiku');
    expect(harness.appendCalls).toEqual([
      {
        key: { guildId: 'g1', channelId: 'c1' },
        messages: [
          { role: 'user', content: '你好', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
          { role: 'assistant', content: '备用回答', author: '小助手', createdAt: FIXED_NOW },
        ],
      },
    ]);
  });

  it('候选模型零个 chunk 干净结束 → 原地重试满 3 次才记 EMPTY_RESPONSE 换下一个候选，落库的只有 fallback 那条', async () => {
    const requests: LlmRequest[] = [];
    const calls: ProviderId[] = [];
    let primaryCalls = 0;
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', [], {
          onRequest: () => {
            primaryCalls += 1;
          },
        }),
        anthropic: track('anthropic', ['备用', '回答'], { requests, providerCalls: calls }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), anthropic: decryptedKey('anthropic') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(result.text).toBe('备用回答');
    expect(result.model).toEqual(BACKUP);
    expect(result.attempts).toEqual([{ model: PRIMARY, error: 'EMPTY_RESPONSE' }]);
    // 单个候选零 chunk 现在会试满 3 次才换模型；fallback 只被调用一次
    expect(primaryCalls).toBe(3);
    expect(calls).toEqual(['anthropic']);
    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('备用回答');
  });

  it('同一模型连续空回两次、第三次给正文 → 成功且该模型正好调用 3 次，落库只有第三次那条', async () => {
    const used: string[] = [];
    let calls = 0;
    const harness = makeHarness({
      providers: {
        'openai-compat': scriptedStreamProvider('openai-compat', used, () => {
          calls += 1;
          return calls < 3 ? { deltas: [] } : { deltas: ['第三次', '才答上来'] };
        }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });

    const result = await createChatService(harness.deps).run(CTX);

    expect(used).toHaveLength(3);
    expect(result.text).toBe('第三次才答上来');
    expect(result.model).toEqual(PRIMARY);
    expect(result.attempts).toEqual([]);
    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('第三次才答上来');
    // 两次空回各留一行 warn（重试同一把 Key），成功那条仍是 info
    expect(harness.logEntries.map((entry) => entry.level)).toEqual(['warn', 'warn', 'info']);
    expect(harness.logEntries[0]?.message).toBe('空回复重试 2/3 model=openai-compat/gpt-4o-mini key=openai-compat');
    expect(harness.logEntries[1]?.message).toBe('空回复重试 3/3 model=openai-compat/gpt-4o-mini key=openai-compat');
  });

  it('同一模型连续空回三次 → 记 EMPTY_RESPONSE 并换 fallback，primary 正好被调用 3 次', async () => {
    const used: string[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': scriptedStreamProvider('openai-compat', used, () => ({ deltas: [] })),
        anthropic: streamProvider('anthropic', ['备用', '回答']),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), anthropic: decryptedKey('anthropic') },
      routes: { global: ROUTE },
    });

    const result = await createChatService(harness.deps).run(CTX);

    expect(used).toHaveLength(3);
    expect(result.text).toBe('备用回答');
    expect(result.model).toEqual(BACKUP);
    expect(result.attempts).toEqual([{ model: PRIMARY, error: 'EMPTY_RESPONSE' }]);
    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('备用回答');
  });

  it('三个候选全空 → 每个候选各试 3 次后抛 ALL_PROVIDERS_FAILED', async () => {
    const seen: ProviderId[] = [];
    const empty = (id: ProviderId): LlmProvider =>
      streamProvider(id, [], {
        onRequest: () => {
          seen.push(id);
        },
      });
    const harness = makeHarness({
      providers: { 'openai-compat': empty('openai-compat'), anthropic: empty('anthropic'), gemini: empty('gemini') },
      keys: {
        'openai-compat': decryptedKey('openai-compat'),
        anthropic: decryptedKey('anthropic'),
        gemini: decryptedKey('gemini'),
      },
      routes: { global: { primary: PRIMARY, fallbacks: [BACKUP, THIRD] } },
    });

    await expect(createChatService(harness.deps).run(CTX)).rejects.toThrow(/ALL_PROVIDERS_FAILED/);

    expect(seen).toEqual([
      'openai-compat',
      'openai-compat',
      'openai-compat',
      'anthropic',
      'anthropic',
      'anthropic',
      'gemini',
      'gemini',
      'gemini',
    ]);
    expect(harness.appendCalls).toHaveLength(0);
  });

  it('raw 里只有 [[react:…]] 指令：剥完正文为空仍算成功，不触发 EMPTY_RESPONSE', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['[[react:👍]]']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(result.text).toBe('');
    expect(result.model).toEqual(PRIMARY);
    expect(result.attempts).toEqual([]);
    expect(result.reactions.map((reaction) => reaction.emoji)).toEqual(['👍']);
  });

  it('provider 无 key → 记 NO_KEY_FOR_PROVIDER 并继续下一个候选', async () => {
    const calls: ProviderId[] = [];
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { anthropic: track('anthropic', ['有 key'], { requests, providerCalls: calls }) },
      keys: { anthropic: decryptedKey('anthropic') },
      routes: { global: { primary: THIRD, fallbacks: [BACKUP] } },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(harness.keyLookups).toEqual(['gemini', 'anthropic']);
    expect(result.attempts).toEqual([{ model: THIRD, error: 'NO_KEY_FOR_PROVIDER' }]);
    expect(result.text).toBe('有 key');
    expect(result.model).toEqual(BACKUP);
  });

  it('全部候选失败 → ALL_PROVIDERS_FAILED 且携带 attempts JSON', async () => {
    const harness = makeHarness({
      providers: {
        'openai-compat': failingProvider('openai-compat', 'boom-1'),
        anthropic: failingProvider('anthropic', 'boom-2'),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), anthropic: decryptedKey('anthropic') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const error = await service.run(CTX).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith('ALL_PROVIDERS_FAILED: ')).toBe(true);
    expect(JSON.parse(message.slice('ALL_PROVIDERS_FAILED: '.length))).toEqual([
      { model: PRIMARY, error: 'boom-1' },
      { model: BACKUP, error: 'boom-2' },
    ]);
    expect(harness.appendCalls).toHaveLength(0);
  });
});

describe('run 渐进式进度', () => {
  it('三个数据块 → 每块一推，progress 严格等于累计序列（末尾不再补一次）', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['一', '二', '三']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    // 服务层不攒、不合并：三条数据块正好三次推送，收尾那次重复推送已经删掉
    expect(harness.progress).toEqual(['一', '一二', '一二三']);
    expect(harness.progress.at(-1)).toBe(result.text);
  });

  it('五个数据块 → 五推，没有任何时间门槛（不再给 Date.now 打桩）', async () => {
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['a', 'b', 'c', 'd', 'e']),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    // 逐块一条：块数与推送数相等，中间没有任何「等够多久才发」的门槛
    expect(harness.progress).toEqual(['a', 'ab', 'abc', 'abcd', 'abcde']);
    expect(result.text).toBe('abcde');
  });

  it('不传 events 也能正常返回（onProgress 可选）', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await expect(service.run(CTX)).resolves.toMatchObject({ text: 'ok' });
    expect(harness.progress).toEqual([]);
  });
});

describe('run 头部 NONE 兜底剥离', () => {
  it('模型先交一行 NONE 再说正文：TurnResult、落库正文与每一次进度推送都不带 NONE', async () => {
    const harness = makeHarness({
      // 第一块就把 NONE 那行之后的字一起吐出来：单独一块只吐 NONE 时剥完是空的，纯函数按约定原样返回
      providers: { 'openai-compat': streamProvider('openai-compat', ['NONE\n哼，', '笨蛋']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(result.text).toBe('哼，笨蛋');
    const stored = harness.appendCalls[0]?.messages.at(-1);
    expect(stored?.role).toBe('assistant');
    expect(stored?.content).toBe('哼，笨蛋');
    // 断言写成「含 NONE 就失败」：进度里一个字都不能漏给用户
    for (const item of harness.progress) expect(item).not.toContain('NONE');
    expect(harness.progress.at(-1)).toBe('哼，笨蛋');
  });

  it('SSE 首帧正好只有一个 NONE：那一帧不推，别先建出一条写着 NONE 的消息', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['NONE', '\n哼，', '笨蛋']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(harness.progress).not.toHaveLength(0);
    // 第一帧就是那个只有 NONE 的中间态：既不能作为任何一项出现，也不能是首项
    for (const item of harness.progress) expect(item).not.toContain('NONE');
    expect(harness.progress[0]).toBe('哼，');
    expect(harness.progress.at(-1)).toBe('哼，笨蛋');
    // 最终正文与落库不受影响：整段只有 NONE 时原样保留这条语义没动
    expect(result.text).toBe('哼，笨蛋');
    expect(harness.appendCalls[0]?.messages.at(-1)?.content).toBe('哼，笨蛋');
  });
});

/** 平台元信息：@ 规则 + 表情规则；预设段在前，身份块在有预设段时整段不出现（§52） */
function platformHead(_ctx: TurnContext, _date: string): string {
  return renderMentionRule() + renderReactionGuide(DEFAULT_REACTION_GUIDE);
}

function segment(id: string, content: string, extra: Partial<PromptSegment> = {}): PromptSegment {
  return { id, name: id, role: 'system', content, enabled: true, placement: 'before', position: 0, ...extra };
}

describe('run 系统提示词', () => {
  it('模板变量取自 TurnContext，date 为 UTC YYYY-MM-DD（单段前置时与旧行为逐字一致）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        global: {
          segments: [
            segment('main', '你是 {{bot_name}}，在 {{guild_name}}/{{channel_name}} 服务 {{user_name}}，今天 {{ date }}。', {
              name: '基本设定',
            }),
          ],
        },
      },
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    const today = new Date().toISOString().slice(0, 10);
    expect(requests[0]?.system).toBe(
      `你是 小助手，在 测试公会/测试频道 服务 阿天，今天 ${today}。` + '\n\n' + platformHead(CTX, today),
    );
    expect(requests[0]?.system).not.toContain('{{');
  });

  it('同层多段按 position 升序、用空行连接（数组顺序不是排序依据）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        guild: {
          segments: [
            segment('p', '冷静克制，偶尔调侃 {{user_name}}', { name: '人格', position: 1 }),
            segment('m', '公会提示词', { name: '基本设定', position: 0 }),
          ],
        },
      },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(requests[0]?.system).toBe(
      '公会提示词\n\n冷静克制，偶尔调侃 阿天' + '\n\n' + platformHead(CTX, new Date().toISOString().slice(0, 10)),
    );
    expect(result.promptScope).toBe('guild');
  });

  it('后置段收尾在 system 最末、摘要跟着本轮用户消息；停用段整段不出现', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        global: {
          segments: [
            segment('tail', '后置补充', { name: '后置', placement: 'after', position: 5 }),
            segment('head', '前置设定', { name: '前置', position: 0 }),
            segment('off', '不该出现的停用段', { name: '停用段', position: 1, enabled: false }),
          ],
        },
      },
      summary: '之前的记忆',
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    const system = requests[0]?.system ?? '';
    // 预设段回到天头，平台元信息跟在它后面；摘要不进 system，跟着本轮用户消息一起发（§52）
    expect(system.startsWith('前置设定\n\n' + platformHead(CTX, new Date().toISOString().slice(0, 10)))).toBe(true);
    expect(system).not.toContain('不该出现的停用段');
    // 有预设段时身份块整段不出现（§52），平台元信息从 @ 规则起
    expect(system).not.toContain('【当前对话】');
    expect(system.indexOf('【提及】')).toBeGreaterThan(system.indexOf('前置设定'));
    expect(system).not.toContain('之前的记忆');
    expect(system.endsWith('后置补充')).toBe(true);
    expect(requests[0]?.messages.at(-1)?.content).toContain('【长期记忆摘要】\n之前的记忆');
  });

  it('role=user 的段变成历史之前的一条 user 消息，且不过采样参数', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        global: {
          segments: [
            segment('claim', '只回一句话，{{user_name}}', { name: '指令', role: 'user', position: 0 }),
            segment('main', '基本设定', { name: '基本设定', position: 1 }),
          ],
        },
      },
      history: [
        { role: 'user', content: '上一轮' },
        { role: 'assistant', content: '上一轮回答' },
      ],
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    expect(requests[0]?.system.startsWith('基本设定')).toBe(true);
    expect(requests[0]?.system).not.toContain('只回一句话');
    const contents = (requests[0]?.messages ?? []).map((message) => message.content);
    expect(contents.slice(0, 3)).toEqual(['只回一句话，阿天', '上一轮', '上一轮回答']);
    expect(contents).toHaveLength(4);
    expect(requests[0]?.messages[0]?.role).toBe('user');
  });

  it('渲染后为空白的段整段跳过，不留空行', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        global: {
          segments: [
            segment('blank', '   ', { name: '空段', position: 0 }),
            segment('main', '基本设定', { name: '基本设定', position: 1 }),
            segment('blank-user', '', { name: '空指令', role: 'user', position: 2 }),
          ],
        },
      },
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    expect(requests[0]?.system.startsWith('基本设定')).toBe(true);
    expect(requests[0]?.messages).toHaveLength(1);
  });

  it('命中频道层提示词时 scope 为 channel', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        channel: { segments: [segment('ch', '频道提示词')] },
        guild: { segments: [segment('gu', '公会提示词')] },
        global: { segments: [segment('gl', '全局提示词')] },
      },
    });
    const service = createChatService(harness.deps);

    expect((await service.run(CTX)).promptScope).toBe('channel');
    expect(requests[0]?.system).toBe(
      '频道提示词' + '\n\n' + platformHead(CTX, new Date().toISOString().slice(0, 10)),
    );
  });
});

describe('run 采样参数', () => {
  it('route 优先，其次 prompt 层，都没有则不传字段', async () => {
    const requests: LlmRequest[] = [];
    const provider = streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) });

    const both = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { ...ROUTE, temperature: 0.9, maxTokens: 900 } },
      prompts: { global: { segments: [segment('main', 'p')], temperature: 0.3, maxTokens: 300 } },
    });
    await createChatService(both.deps).run(CTX);
    expect(requests[0]?.temperature).toBe(0.9);
    expect(requests[0]?.maxTokens).toBe(900);

    requests.length = 0;
    const promptOnly = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: { global: { segments: [segment('main', 'p')], temperature: 0.3, maxTokens: 300 } },
    });
    await createChatService(promptOnly.deps).run(CTX);
    expect(requests[0]?.temperature).toBe(0.3);
    expect(requests[0]?.maxTokens).toBe(300);

    requests.length = 0;
    const neither = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    await createChatService(neither.deps).run(CTX);
    expect('temperature' in (requests[0] ?? {})).toBe(false);
    expect('maxTokens' in (requests[0] ?? {})).toBe(false);
  });

  it('五个采样参数只从 route 取：0 也原样进请求', async () => {
    const requests: LlmRequest[] = [];
    const provider = streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) });

    const harness = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { ...ROUTE, topP: 0, topK: 40, seed: 0, frequencyPenalty: -0.5, presencePenalty: 0.5 } },
      prompts: { global: { segments: [segment('main', 'p')], temperature: 0.3, maxTokens: 300 } },
    });
    await createChatService(harness.deps).run(CTX);

    expect(requests[0]?.topP).toBe(0);
    expect(requests[0]?.topK).toBe(40);
    expect(requests[0]?.seed).toBe(0);
    expect(requests[0]?.frequencyPenalty).toBe(-0.5);
    expect(requests[0]?.presencePenalty).toBe(0.5);
  });

  it('route 没设采样参数时，请求里连键都没有（提示词层没有这五项可继承）', async () => {
    const requests: LlmRequest[] = [];
    const provider = streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) });

    const harness = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { ...ROUTE, temperature: 0.7 } },
      prompts: { global: { segments: [segment('main', 'p')], temperature: 0.3, maxTokens: 300 } },
    });
    await createChatService(harness.deps).run(CTX);

    for (const key of ['topP', 'topK', 'seed', 'frequencyPenalty', 'presencePenalty']) {
      expect(key in (requests[0] ?? {})).toBe(false);
    }
  });
});


describe('run 落库原文（storedUserText）', () => {
  it('storedUserText 只换落库那一行，提示里仍是 userText', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['在呢'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, userText: '（提示里的那一句）', storedUserText: '（真正落库的那一句）' });

    expect(requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: STAMP + '阿天(u1)：（提示里的那一句）' });
    expect(harness.appendCalls[0]?.messages[0]).toEqual({
      role: 'user',
      content: '（真正落库的那一句）',
      author: '阿天',
      authorId: 'u1',
      createdAt: FIXED_NOW,
    });
  });
});

describe('run 一条消息只调一次模型', () => {
  it('只走一次 chatStream：每轮先摘要的那一次 chat() 已经删掉', async () => {
    const requests: LlmRequest[] = [];
    let chatCalls = 0;
    const provider: LlmProvider = {
      id: 'openai-compat',
      async chat() {
        chatCalls += 1;
        return { text: '每轮摘要已经删掉，不该再出现' };
      },
      async listModels() {
        return [];
      },
      chatStream(request: LlmRequest): AsyncIterable<LlmChunk> {
        requests.push(request);
        return (async function* () {
          yield { delta: '好的', finishReason: 'stop' };
        })();
      },
    };
    const harness = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
      ],
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(result.text).toBe('好的');
    // 上游调用合计 1 次：流式 1 次 + 非流式 0 次
    expect(requests).toHaveLength(1);
    expect(chatCalls).toBe(0);
    expect(requests[0]?.messages).toEqual([
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: STAMP + '阿天(u1)：你好' },
    ]);
  });
});

const REPLY_CTX: TurnContext = {
  ...CTX,
  replyTo: { messageId: 'm-1', author: '小明', authorId: 'u-llp', content: '我也想看电影' },
};

describe('表情指令剥离（§18.5）', () => {
  it('指令不进正文：TurnResult.text 与落库的 assistant 行是同一份干净文本', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': track('openai-compat', ['好的', '[[react:👍]]', '\n[[react:🔥]]'], {
          requests,
          providerCalls: [],
        }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
    expect(harness.appendCalls[0]?.messages[1]).toEqual({
      role: 'assistant',
      content: '好的',
      author: '小助手',
      createdAt: FIXED_NOW,
    });
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe(result.text);
    expect(requests).toHaveLength(1);
  });

  it('带目标的指令（§28）：messageId / authorName 原样留在 reactions 里，不进正文', async () => {
    const harness = makeHarness({
      providers: {
        'openai-compat': track(
          'openai-compat',
          ['好的', '\n[[react:👍@123456789012345678]]', '\n[[react:🔥@卡利亞士兵]]'],
          { requests: [], providerCalls: [] },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([
      { emoji: '👍', messageId: '123456789012345678' },
      { emoji: '🔥', authorName: '卡利亞士兵' },
    ]);
  });

  it('流式进度走可见文本：半截指令不会刷进 Discord', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': track('openai-compat', ['看这里', '[[re', 'act:👍]]'], { requests, providerCalls: [] }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(harness.progress.length).toBeGreaterThan(0);
    for (const partial of harness.progress) expect(partial).not.toContain('[[');
    // 末次进度就是最终正文：编辑框最后停的地方 = 落库的那句话
    expect(harness.progress.at(-1)).toBe(result.text);
    expect(result.text).toBe('看这里');
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });
});

describe('工具调用壳剥离', () => {
  it('模型把 story_reply 调用壳写进正文：正文与落库都是剥壳后的文字，进度里不出现壳', async () => {
    const harness = makeHarness({
      providers: {
        'openai-compat': track(
          'openai-compat',
          ['<run_tool_name>story_reply</run_tool_name>', '<run_tool_args>你好', '</run_tool_args>'],
          { requests: [], providerCalls: [] },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(result.text).toBe('你好');
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('你好');
    expect(harness.progress.length).toBeGreaterThan(0);
    for (const partial of harness.progress) expect(partial).not.toContain('story_reply');
  });
});

describe('预设包裹标签剥离', () => {
  it('模型把正文包进 <game>：正文、落库、进度里都不出现标记', async () => {
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['<game>屋外的天色沉下去了</game>', '，我等你。']),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(result.text).toBe('屋外的天色沉下去了，我等你。');
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('屋外的天色沉下去了，我等你。');
    expect(harness.progress.length).toBeGreaterThan(0);
    expect(harness.progress.at(-1)).toBe(result.text);
    for (const partial of harness.progress) expect(partial).not.toContain('<game>');
  });
});

const REACTION_CFG: ReactionModelConfig = { enabled: true, provider: 'gemini', model: 'gemini-2.0-flash' };

interface ReactionSink {
  /** 表情模型收到的每一次非流式请求 */
  chats: LlmRequest[];
  /** 实际用到的 apiKey：「逐把试」的断言靠它 */
  keys: string[];
}

function reactionStore(cfg: ReactionModelConfig | null, reads: { count: number }): ReactionModelStore {
  return {
    async get() {
      reads.count += 1;
      return cfg;
    },
    async put() {
      throw new Error('测试不该写表情配置');
    },
  };
}

/** 表情模型的假 provider：只该被非流式 chat() 问到；answer 是 Error 时模拟调用失败 */
function reactionProvider(answer: string | Error, sink: ReactionSink): LlmProvider {
  return {
    id: 'gemini',
    async chat(req: LlmRequest, rt: ProviderRuntime) {
      sink.chats.push(req);
      sink.keys.push(rt.apiKey);
      if (answer instanceof Error) throw answer;
      return { text: answer };
    },
    async listModels() {
      return [];
    },
    chatStream(): AsyncIterable<LlmChunk> {
      return (async function* () {
        throw new Error('表情模型应走非流式 chat()');
      })();
    },
  };
}

function spyWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('表情模型（§21.4）', () => {
  it('启用 → 与主模型的表情合并，主模型在前，正文与落库不变', async () => {
    const requests: LlmRequest[] = [];
    const sink: ReactionSink = { chats: [], keys: [] };
    const reads = { count: 0 };
    const harness = makeHarness({
      providers: {
        'openai-compat': track('openai-compat', ['好的', '[[react:👍]]'], { requests, providerCalls: [] }),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, reads),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
    expect(reads.count).toBe(1);
    expect(sink.chats).toHaveLength(1);
    expect(sink.keys).toEqual(['sk-gemini']);
    // 正文与落库都不受这一步影响
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('好的');
    // §21.4 要求成功记一次 info：模型、选中的表情、耗时都在里面
    const logged = harness.logEntries.filter((entry) => entry.message.startsWith('表情选择 '));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('info');
    expect(logged[0]?.scope).toBe('chat');
    expect(logged[0]?.message).toMatch(
      /^表情选择 model=gemini\/gemini-2\.0-flash value=🔥 ms=\d+ images=0 guide=global template=global$/,
    );
  });

  it('两个来源给出同一个表情 → 去重，一条消息不贴两遍', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('👍', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('合并后仍然最多 10 个（§28.6）：主模型给满 10 条时，表情模型那条被截掉', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const rows = ['👍', '🔥', '🎉', '🥲', '🚀', '🐱', '😁', '😆', '🤣', '😀'];
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', ...rows.map((row) => '\n[[react:' + row + ']]')]),
        gemini: reactionProvider('💡', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect(result.reactions).toHaveLength(10);
    expect(result.reactions.at(-1)).toEqual({ emoji: '😀' });
    // 表情模型确实被问到了（sink 有记录），💡 是被上限截掉的，不是没问
    expect(sink.chats).toHaveLength(1);
    expect(result.reactions.some((item) => item.emoji === '💡')).toBe(false);
  });

  it('未启用 → 读一次配置但一次都不问模型', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const reads = { count: 0 };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore({ ...REACTION_CFG, enabled: false }, reads),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect(reads.count).toBe(1);
    expect(sink.chats).toHaveLength(0);
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('没接线 reactionModels → 一次都不问', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect(result.reactions).toEqual([{ emoji: '👍' }]);
    expect(harness.logEntries.filter((entry) => entry.message.startsWith('表情选择 '))).toHaveLength(0);
  });

  it('wantReactions 没设 → 连配置都不读', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const reads = { count: 0 };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, reads),
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(reads.count).toBe(0);
    expect(sink.chats).toHaveLength(0);
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('provider 没有可用 Key → warn 一次且不贴', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('🔥', sink),
      },
      // 表情模型配在 gemini，但 gemini 一把 Key 都没有
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);
    const warnings = spyWarnings();

    // finally 里收掉 spy：失败路径也要还原，否则会污染同文件的其它用例
    const result = await service.run({ ...CTX, wantReactions: true }).finally(() => warnings.restore());

    expect(warnings.lines.join('\n')).toContain('[chat] 表情模型没有可用 Key');
    expect(sink.chats).toHaveLength(0);
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('调用抛错 → 回复照旧，只保留主模型的表情', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider(new Error('第一把挂了'), sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);
    const warnings = spyWarnings();

    // finally 里收掉 spy：失败路径也要还原，否则会污染同文件的其它用例
    const result = await service.run({ ...CTX, wantReactions: true }).finally(() => warnings.restore());

    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('好的');
    const joined = warnings.lines.join('\n');
    expect(joined).toContain('[chat] 表情选择失败：');
    expect(joined).toContain('第一把挂了');
  });

  it('读表情配置自己抛错 → 回复照旧，只 warn', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      reactionModels: {
        async get() {
          throw new Error('配置表坏了');
        },
        async put() {
          throw new Error('unused');
        },
      },
    });
    const service = createChatService(harness.deps);
    const warnings = spyWarnings();

    const result = await service.run({ ...CTX, wantReactions: true }).finally(() => warnings.restore());

    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
    expect(warnings.lines.join('\n')).toContain('[chat] 表情选择失败：配置表坏了');
  });

  it('表情模型是在落库之后才问的：问的时候这轮消息已经进库', async () => {
    let harnessRef: Harness | undefined;
    const appendsSeen: number[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('🔥', { chats: [], keys: [] }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: {
        async get() {
          appendsSeen.push(harnessRef?.appendCalls.length ?? -1);
          return REACTION_CFG;
        },
        async put() {
          throw new Error('unused');
        },
      },
    });
    harnessRef = harness;
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, wantReactions: true });

    // 问表情模型时这轮两条消息（user + assistant）已经写进存储
    expect(appendsSeen).toEqual([1]);
  });

  it('逐把 Key 试：第一把失败就用第二把', async () => {
    const used: string[] = [];
    const chats: LlmRequest[] = [];
    const gemini: LlmProvider = {
      id: 'gemini',
      async chat(req: LlmRequest, rt: ProviderRuntime) {
        chats.push(req);
        used.push(rt.apiKey);
        if (rt.apiKey === 'sk-a') throw new Error('第一把 401');
        return { text: '🔥' };
      },
      async listModels() {
        return [];
      },
      chatStream(): AsyncIterable<LlmChunk> {
        return (async function* () {
          throw new Error('表情模型应走非流式 chat()');
        })();
      },
    };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini,
      },
      keys: {
        'openai-compat': decryptedKey('openai-compat'),
        // 两份都声明了空名单：按仓储给的顺序先 a 后 b
        gemini: [
          { id: 'k1', provider: 'gemini', label: 'a', apiKey: 'sk-a', models: [] },
          { id: 'k2', provider: 'gemini', label: 'b', apiKey: 'sk-b', models: [] },
        ],
      },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect(used).toEqual(['sk-a', 'sk-b']);
    expect(chats).toHaveLength(2);
    expect(result.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
  });

  it('模型回 NONE → 不贴也不告警', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('NONE', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);
    const warnings = spyWarnings();

    // finally 里收掉 spy：失败路径也要还原，否则会污染同文件的其它用例
    const result = await service.run({ ...CTX, wantReactions: true }).finally(() => warnings.restore());

    expect(warnings.lines).toHaveLength(0);
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('表情模型看到的是这次回复的正文与自定义表情清单', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, wantReactions: true, customEmojis: [{ name: '开心', id: 'e1' }] });

    const request = sink.chats[0];
    expect(request?.model).toBe('gemini-2.0-flash');
    expect(request?.system).toBe(DEFAULT_REACTION_GUIDE + '\n\n' + NO_REACTION_NOTE);
    // 素材里是剥掉 [[react:]] 之后的正文，不是上游原始输出；段落与段序由默认模板决定（§34.3）
    expect(request?.messages[0]?.content).toBe(
      '【最近的对话】\n\n【对方的消息】\n你好\n\n【我的回复】\n好的\n\n【可用自定义表情】\n:开心:',
    );
  });

  it('§28：主模型 2 条 + 表情模型 3 行 → 主模型在前、带目标的那条原样保留、重复的丢掉', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': track(
          'openai-compat',
          ['好的', '\n[[react:👍@123456789012345678]]', '\n[[react:👍]]'],
          { requests: [], providerCalls: [] },
        ),
        gemini: reactionProvider('🔥@卡利亞士兵\n🎉\n🎉', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect(result.reactions).toEqual([
      { emoji: '👍', messageId: '123456789012345678' },
      { emoji: '👍' },
      { emoji: '🔥', authorName: '卡利亞士兵' },
      { emoji: '🎉' },
    ]);
    expect(sink.chats).toHaveLength(1);
    // 日志把目标一起写出来，否则线上只看到「贴了 🔥」，查不出贴到哪条
    const logged = harness.logEntries.filter((entry) => entry.message.startsWith('表情选择 '));
    expect(logged[0]?.message).toContain('value=🔥@卡利亞士兵,🎉');
  });

  it('§28：合并后超过 10 条就截断，尾部的丢掉', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const rows = ['😀', '🔥', '🎉', '🥲', '🚀', '🐱', '😁', '😆', '🤣'];
    const harness = makeHarness({
      providers: {
        'openai-compat': track(
          'openai-compat',
          ['好的', '\n[[react:👍@123456789012345678]]', '\n[[react:👍]]'],
          { requests: [], providerCalls: [] },
        ),
        gemini: reactionProvider(rows.join('\n'), sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    // 主模型 2 条 + 表情模型 9 条 = 11，合并时截到 10
    expect(result.reactions).toHaveLength(10);
    expect(result.reactions.at(-1)).toEqual({ emoji: '😆' });
    expect(result.reactions.some((item) => item.emoji === '🤣')).toBe(false);
    expect(result.reactions.slice(0, 2)).toEqual([
      { emoji: '👍', messageId: '123456789012345678' },
      { emoji: '👍' },
    ]);
  });
});

const TARGETS: ReactionTarget[] = [
  { messageId: '123456789012345678', author: '卡利亞士兵', authorId: 'u-1', excerpt: '给我们贴大量的emoji' },
];

describe('可贴表情的消息段（§28.4 / §28.6）', () => {
  it('reactionTargets 非空 → system 带这一整段，且排在自定义表情清单之后', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, customEmojis: [{ name: 'cat', id: '1' }], reactionTargets: TARGETS });

    const system = requests[0]?.system ?? '';
    const block = '\n\n【可贴表情的消息】\n#123456789012345678 卡利亞士兵：「给我们贴大量的emoji」';
    expect(system).toContain(block);
    // 装配顺序：预设段 → 身份块 → 提及规则 → 表情规则 → 自定义表情清单 → 可贴消息 → 世界书
    expect(system.indexOf('【可贴表情的消息】')).toBeGreaterThan(system.indexOf('【可用自定义表情】'));
    expect(system.indexOf('【可用自定义表情】')).toBeGreaterThan(system.indexOf('【表情】'));
    expect(system.indexOf('【可贴表情的消息】')).toBeGreaterThan(system.indexOf('礼貌、简洁的中文助手'));
  });

  it('reactionTargets 缺省或空数组 → 整段不出现（不留空壳分段）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);
    await service.run({ ...CTX, reactionTargets: [] });

    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.system).not.toContain('【可贴表情的消息】');
  });

  it('表情模型拿到的素材里也有同一段：ctx.reactionTargets 传进了 buildReactionRequest', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, wantReactions: true, reactionTargets: TARGETS });

    expect(sink.chats[0]?.messages[0]?.content).toContain(
      '【可贴表情的消息】\n#123456789012345678 卡利亞士兵：「给我们贴大量的emoji」',
    );
  });
});

describe('表情模型看图（§22.6）', () => {
  const IMAGES: LlmImage[] = [
    { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
    { mediaType: 'image/jpeg', base64: '/9j/4AAQ' },
  ];

  /** 会记账的假 loader：断言「一轮只取一次」靠它，返回值就是 IMAGES */
  function countingLoader(state: { calls: number }): () => Promise<LlmImage[]> {
    return async () => {
      state.calls += 1;
      return IMAGES;
    };
  }

  it('启用 + loadImages 给两张图 → 主对话与表情请求带同一份（顺序一致），一轮只取一次，图片不落库', async () => {
    const requests: LlmRequest[] = [];
    const sink: ReactionSink = { chats: [], keys: [] };
    const state = { calls: 0 };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]'], {
          onRequest: (req) => requests.push(req),
        }),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({
      ...CTX,
      wantReactions: true,
      loadImages: async () => {
        state.calls += 1;
        return IMAGES;
      },
    });

    // 主对话先取图，表情模型复用同一份 memo：一轮只有一次下载，两次请求拿到的是同一批、同一个顺序
    expect(state.calls).toBe(1);
    expect(requests[0]?.images).toEqual(IMAGES);
    expect(sink.chats).toHaveLength(1);
    expect(sink.chats[0]?.images).toEqual(IMAGES);
    expect(result.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
    // §22.6.4：成功日志末尾是实际发出去的张数
    const logged = harness.logEntries.filter((entry) => entry.message.startsWith('表情选择 '));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toMatch(
      /^表情选择 model=gemini\/gemini-2\.0-flash value=🔥 ms=\d+ images=2 guide=global template=global$/,
    );
    // §22.6.5：图片不进落库——两条消息里没有任何 base64 痕迹
    expect(harness.appendCalls).toHaveLength(1);
    expect(JSON.stringify(harness.appendCalls[0]?.messages)).not.toContain('iVBORw0KGgo=');
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('好的');
  });

  it('表情模型未启用 → 主对话照常取一次图，表情请求一次都不发', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const requests: LlmRequest[] = [];
    const state = { calls: 0 };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]'], {
          onRequest: (req) => requests.push(req),
        }),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore({ ...REACTION_CFG, enabled: false }, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true, loadImages: countingLoader(state) });

    // 主对话要图，所以这一轮必然取一次；表情那一路被关掉，不会再取第二次
    expect(state.calls).toBe(1);
    expect(requests[0]?.images).toEqual(IMAGES);
    expect(sink.chats).toHaveLength(0);
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('没接线 reactionModels → 主对话照常取一次图', async () => {
    const requests: LlmRequest[] = [];
    const state = { calls: 0 };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]'], {
          onRequest: (req) => requests.push(req),
        }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true, loadImages: countingLoader(state) });

    expect(state.calls).toBe(1);
    expect(requests[0]?.images).toEqual(IMAGES);
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('ctx.loadImages 未设 → 两个请求上都没有 images 这个键（形状与旧版逐字相同）', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]'], {
          onRequest: (req) => requests.push(req),
        }),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true });

    expect('images' in (requests[0] ?? {})).toBe(false);
    expect(sink.chats).toHaveLength(1);
    expect('images' in (sink.chats[0] ?? {})).toBe(false);
    expect(result.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
  });

  it('loader 返回空数组（一张都没取到）→ 两个请求上都没有 images 这个键', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]'], {
          onRequest: (req) => requests.push(req),
        }),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true, loadImages: async () => [] });

    expect('images' in (requests[0] ?? {})).toBe(false);
    expect('images' in (sink.chats[0] ?? {})).toBe(false);
    expect(result.text).toBe('好的');
  });

  it('读取图片抛错 → 按无图继续：回复照常、两个请求都不带 images、只 warn「读取图片失败」', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const requests: LlmRequest[] = [];
    const state = { calls: 0 };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]'], {
          onRequest: (req) => requests.push(req),
        }),
        // 这轮回 NONE：不贴，于是 reactions 里只剩主模型自己给的那个
        gemini: reactionProvider('NONE', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
    });
    const service = createChatService(harness.deps);
    const warnings = spyWarnings();

    const result = await service.run({
      ...CTX,
      wantReactions: true,
      loadImages: async () => {
        state.calls += 1;
        throw new Error('图片下载挂了');
      },
    }).finally(() => warnings.restore());

    // 失败也只取一次：memo 缓存的是「空数组」这个结果，表情那一路不会因此再试一遍
    expect(state.calls).toBe(1);
    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('好的');
    // 读图失败只是少看图：两个请求都照发，只是都没有 images 这个键
    expect('images' in (requests[0] ?? {})).toBe(false);
    expect(sink.chats).toHaveLength(1);
    expect('images' in (sink.chats[0] ?? {})).toBe(false);
    expect(warnings.lines.join('\n')).toContain('[chat] 读取图片失败，按无图继续：图片下载挂了');
  });
});

describe('回复链进提示词（§18.5）', () => {
  it('本轮 user 消息带时间戳与「↳ 回复」后缀，落库也带 replyTo', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: [{ role: 'assistant', content: '之前聊过电影' }],
    });
    const service = createChatService(harness.deps);

    await service.run(REPLY_CTX);

    expect(requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: STAMP + '阿天(u1)：你好 ↳ 回复 小明(u-llp)：「我也想看电影」',
    });
    expect(harness.appendCalls[0]?.messages[0]).toEqual({
      role: 'user',
      content: '你好',
      author: '阿天',
      authorId: 'u1',
      createdAt: FIXED_NOW,
      replyTo: REPLY_CTX.replyTo,
    });
  });

  it('非回复消息不带 replyTo 键：既有行为逐字不变', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    const stored = harness.appendCalls[0]?.messages[0];
    expect(Object.keys(stored ?? {})).not.toContain('replyTo');
    expect(requests[0]?.messages.at(-1)?.content).toBe(STAMP + '阿天(u1)：你好');
  });

  it('历史里的回复链进提示词：上一轮的回复目标在上下文里仍然看得见', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: [
        {
          role: 'user',
          content: '我也想看',
          author: '小明',
          authorId: 'u-llp',
          createdAt: FIXED_NOW,
          replyTo: { messageId: 'm-0', author: '示例机器人', authorId: 'bot-1', content: '我们去看电影' },
        },
      ],
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    expect(requests[0]?.messages[0]).toEqual({
      role: 'user',
      content: STAMP + '小明(u-llp)：我也想看 ↳ 回复 示例机器人(bot-1)：「我们去看电影」',
    });
  });
});

describe('自定义表情段（§18.5）', () => {
  const EMOJIS = [
    { name: 'cat', id: '1' },
    { name: 'dog', id: '2', animated: true },
  ];

  it('接在身份块与规则块之后：预设 → 身份块 → 提及 → 表情规则 → 清单（摘要跟着用户消息）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      summary: '他喜欢猫。',
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, customEmojis: EMOJIS });

    const system = requests[0]?.system ?? '';
    // 摘要不再进 system：它拼在本轮用户消息的最前面（§52）
    expect(system).not.toContain('【长期记忆摘要】');
    expect(requests[0]?.messages.at(-1)?.content).toContain('【长期记忆摘要】\n他喜欢猫。');
    expect(system).toContain('\n\n【可用自定义表情】\n:cat: :dog:');
    expect(system.indexOf('【可用自定义表情】')).toBeGreaterThan(system.indexOf('【表情】'));
  });

  it('customEmojis 为空数组或缺省时整段不出现（不留空壳分段）', async () => {
    const requests: LlmRequest[] = [];
    const providers = { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) };
    const harness = makeHarness({
      providers,
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, customEmojis: [] });
    await service.run(CTX);

    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.system).not.toContain('【可用自定义表情】');
  });

  it('最多列 40 个，超出的按顺序丢弃', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);
    const many = Array.from({ length: 45 }, (_value, index) => ({ name: 'e' + String(index), id: String(index) }));

    await service.run({ ...CTX, customEmojis: many });

    const system = requests[0]?.system ?? '';
    const marker = '\n\n【可用自定义表情】\n';
    // 清单后面还接着预设段：只取到下一个空行为止
    const block = (system.slice(system.indexOf(marker) + marker.length).split('\n\n')[0] ?? '');
    expect(block.split(' ')).toHaveLength(40);
    expect(block.startsWith(':e0: :e1:')).toBe(true);
    expect(system).not.toContain(':e40:');
  });

  it('有描述时写成 :名字:(描述)（§23.5）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, customEmojis: [{ name: 'laugh', id: '1', description: '黄胖小子咧嘴大笑' }] });

    expect(requests[0]?.system).toContain(':laugh:(黄胖小子咧嘴大笑)');
    expect(requests[0]?.system).toContain('\n\n【可用自定义表情】\n:laugh:(黄胖小子咧嘴大笑)');
  });

  it('没有描述、或描述 trim 后为空时仍是 :laugh:（老形状不被改动）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, customEmojis: [{ name: 'laugh', id: '1' }] });
    await service.run({ ...CTX, customEmojis: [{ name: 'laugh', id: '1', description: '   ' }] });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.system).toContain(':laugh:');
      expect(request.system).toContain('\n\n【可用自定义表情】\n:laugh:');
    }
  });

  it('名字空白的表情不占位，全是空白时整段不出现', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, customEmojis: [{ name: '   ', id: '1' }] });
    await service.run({ ...CTX, customEmojis: [{ name: '  ', id: '1' }, { name: 'cat', id: '2' }] });

    expect(requests[0]?.system).not.toContain('【可用自定义表情】');
    expect(requests[1]?.system).toContain('\n\n【可用自定义表情】\n:cat:');
  });

  it('正文表情段接在清单之后：普通模式保留带描述的既有清单，没接线时整段不出现', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      reactionGuides: { global: { scope: 'global', scopeId: '', prompt: '贴 :cat: 来回，', updatedAt: FIXED_NOW } },
      bodyEmojiGuides: {
        global: { scope: 'global', scopeId: '', prompt: '偶尔带 :cat:，别每句都带', updatedAt: FIXED_NOW },
      },
    });
    const service = createChatService(harness.deps);

    await service.run({
      ...CTX,
      customEmojis: [{ name: 'cat', id: '1', description: '一只猫', aliases: ['猫猫'] }],
    });

    const system = requests[0]?.system ?? '';
    expect(system).toContain('\n\n【正文表情】\n偶尔带 :cat:，别每句都带');
    expect(system.indexOf('【可用自定义表情】')).toBeLessThan(system.indexOf('【正文表情】'));
    // 普通模式保留带描述与别名的既有清单（names-only 只用于 context 描述体）
    expect(system).toContain(':cat:(一只猫) 别名「猫猫」');
    // 与贴表情规则各占一段，互不吞并
    expect(system.indexOf('【表情】')).toBeLessThan(system.indexOf('【可用自定义表情】'));

    // 没接线的老调用方：一次都不问仓储，system 里也没有这一段
    const plain: LlmRequest[] = [];
    const legacy = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests: plain, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    await createChatService(legacy.deps).run({ ...CTX, customEmojis: [{ name: 'cat', id: '1' }] });
    expect(legacy.bodyEmojiGuideKeys).toEqual([]);
    expect(plain[0]?.system).not.toContain('【正文表情】');
    // 既有清单照旧出现：关掉的只是正文表情这一段，不是整个自定义表情段
    expect(plain[0]?.system).toContain('\n\n【可用自定义表情】\n:cat:');
  });

  it('三层整组覆盖：channel 有配置就用 channel 那份，guild / global 只被问到、不被拼进来', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      bodyEmojiGuides: {
        channel: { scope: 'channel', scopeId: 'c1', prompt: '频道规则', updatedAt: FIXED_NOW },
        guild: { scope: 'guild', scopeId: 'g1', prompt: '公会规则', updatedAt: FIXED_NOW },
        global: { scope: 'global', scopeId: '', prompt: '全局规则', updatedAt: FIXED_NOW },
      },
    });

    await createChatService(harness.deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('\n\n【正文表情】\n频道规则');
    expect(system).not.toContain('公会规则');
    expect(system).not.toContain('全局规则');
    // 与贴表情提示词同构：三层一起读回来，再按 channel → guild → global 取第一份
    expect(harness.bodyEmojiGuideKeys).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
  });
});

describe('自定义表情别名（§24.4）', () => {
  /** 别名只出现在提示词这一层：跑一轮，把这一轮的 system 捞出来验 */
  async function systemFor(customEmojis: CustomEmoji[]): Promise<string> {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    await createChatService(harness.deps).run({ ...CTX, customEmojis });
    return requests[0]?.system ?? '';
  }

  const CATALOG = '\n\n【可用自定义表情】\n';

  it('有别名没描述时只挂别名', async () => {
    const system = await systemFor([{ name: 'laugh', id: '1', aliases: ['奶龙'] }]);

    expect(system).toContain(CATALOG + ':laugh: 别名「奶龙」');
  });

  it('有描述也有别名时描述在前、别名在后', async () => {
    const system = await systemFor([{ name: 'laugh', id: '1', description: '黄色胖角色站立掐腰', aliases: ['奶龙'] }]);

    expect(system).toContain(CATALOG + ':laugh:(黄色胖角色站立掐腰) 别名「奶龙」');
  });

  it('多个别名用「、」连接，各自 trim 后排掉空串', async () => {
    const system = await systemFor([{ name: 'laugh', id: '1', aliases: [' 奶龙 ', '', '   ', ' 小黄龙'] }]);

    expect(system).toContain(CATALOG + ':laugh: 别名「奶龙、小黄龙」');
  });

  it('别名全是空白等于没配别名', async () => {
    const system = await systemFor([{ name: 'laugh', id: '1', aliases: ['  ', '', '\t'] }]);

    expect(system).toContain(CATALOG + ':laugh:');
    expect(system).not.toContain('别名');
  });

  it('没有 aliases 键时输出与 §23.5 逐字相同', async () => {
    const plain = await systemFor([{ name: 'laugh', id: '1' }]);
    const described = await systemFor([{ name: 'laugh', id: '1', description: '黄色胖角色站立掐腰' }]);

    expect(plain).toContain(CATALOG + ':laugh:');
    expect(described).toContain(CATALOG + ':laugh:(黄色胖角色站立掐腰)');
    expect(described).not.toContain('别名');
  });
});


describe('renderReactionGuide 渲染（§28.10）', () => {
  it('套上固定的【表情】小标题，段前空两行：与其它段一样直接拼进 system', () => {
    expect(renderReactionGuide('自定义正文')).toBe('\n\n【表情】\n自定义正文');
  });

  it('正文前后空白先 trim：后台文案里多敲的空行不会带进 system', () => {
    expect(renderReactionGuide('\n  自定义正文 \n\n')).toBe('\n\n【表情】\n自定义正文');
  });

  it('trim 后为空就不出现这一段：宁可不写，也不给模型一个空标题', () => {
    expect(renderReactionGuide('')).toBe('');
    expect(renderReactionGuide('   \n \t')).toBe('');
  });
});

describe('表情规则段（§18.8 / §28.10）', () => {
  it('无条件出现：没有摘要也教模型写 [[react:…]]，且排在清单之前', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, customEmojis: [{ name: 'cat', id: '1' }] });

    const system = requests[0]?.system ?? '';
    expect(system).toContain('\n\n【表情】\n');
    expect(system).toContain('[[react:');
    expect(system.indexOf('【可用自定义表情】')).toBeGreaterThan(system.indexOf('【表情】'));
    // 文案是两条路径共用的那一份，:名字: 无条件写着；清单为空时模型写了也只是落空一条
    expect(system).toContain(':名字:');
  });

  it('默认文案把三件事都说全：怎么判断、怎么指定目标、格式', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    const guide = renderReactionGuide(DEFAULT_REACTION_GUIDE);
    // 不值得就不贴是明文规则：允许一条都不贴，这时一行 [[react:…]] 都不写
    expect(guide).toContain('一条都不贴完全允许');
    expect(guide).toContain('[[react:');
    // 共用规则里不再教 NONE：那句话只留给表情模型的请求（reaction.ts 的 NO_REACTION_NOTE）
    expect(guide).not.toContain('NONE');
    expect(guide).toContain('@消息ID');
    expect(guide).toContain('@作者名');
    expect(guide).toContain('一行一个表情，最多 10 行');
    expect(guide).toContain('不要在正文里堆一串表情');
    // 强制分散的老口径必须消失：现在只有模型点名 @all 才分散
    expect(guide).not.toContain('要把表情分开贴到各自真正对应的那条消息上');
    expect(guide).not.toContain('只挑一个');
    const system = requests[0]?.system ?? '';
    expect(system).toContain(DEFAULT_REACTION_GUIDE.trim());
    expect(system).not.toContain('最多 2 个');
  });

  it('没有摘要、没有自定义表情时同样出现', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('【表情】');
    expect(system).not.toContain('【可用自定义表情】');
  });
});

describe('贴表情提示词三层覆盖（§28.10）', () => {
  const CHANNEL_ROW: ReactionGuideConfig = { scope: 'channel', scopeId: 'c1', prompt: '频道这一份文案', updatedAt: FIXED_NOW };
  const GUILD_ROW: ReactionGuideConfig = { scope: 'guild', scopeId: 'g1', prompt: '公会这一份文案', updatedAt: FIXED_NOW };
  const GLOBAL_ROW: ReactionGuideConfig = { scope: 'global', scopeId: '', prompt: '全局这一份文案', updatedAt: FIXED_NOW };

  function runWithGuides(guides: Parameters<typeof makeHarness>[0]['reactionGuides']): {
    harness: Harness;
    service: ReturnType<typeof createChatService>;
    requests: LlmRequest[];
  } {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': track('openai-compat', ['好'], { requests, providerCalls: [] }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      ...(guides === undefined ? {} : { reactionGuides: guides }),
    });
    return { harness, service: createChatService(harness.deps), requests };
  }

  it('三层都有 → channel 整份生效，system 里换掉默认文案，日志记 guide=channel', async () => {
    const { harness, service, requests } = runWithGuides({
      channel: CHANNEL_ROW,
      guild: GUILD_ROW,
      global: GLOBAL_ROW,
    });

    await service.run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('\n\n【表情】\n频道这一份文案');
    expect(system).not.toContain('公会这一份文案');
    expect(system).not.toContain(DEFAULT_REACTION_GUIDE);
    expect(harness.reactionGuideKeys).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
    const info = harness.logEntries.find((entry) => entry.scope === 'chat' && entry.message.startsWith('回复成功'));
    expect(info?.message).toContain('guide=channel');
  });

  it('channel 没有 → guild 生效；guild 也没有 → global 生效', async () => {
    const guildHit = runWithGuides({ guild: GUILD_ROW, global: GLOBAL_ROW });
    await guildHit.service.run(CTX);
    expect(guildHit.requests[0]?.system ?? '').toContain('公会这一份文案');
    expect(guildHit.harness.logEntries.some((entry) => entry.message.includes('guide=guild'))).toBe(true);

    const globalHit = runWithGuides({ global: GLOBAL_ROW });
    await globalHit.service.run(CTX);
    expect(globalHit.requests[0]?.system ?? '').toContain('全局这一份文案');
    expect(globalHit.harness.logEntries.some((entry) => entry.message.includes('guide=global'))).toBe(true);
  });

  it('行存在但正文只有空白 = 这一层没有配置，落回上层', async () => {
    const { service, requests, harness } = runWithGuides({
      channel: { ...CHANNEL_ROW, prompt: '   \n  ' },
      guild: GUILD_ROW,
    });

    await service.run(CTX);

    expect(requests[0]?.system ?? '').toContain('公会这一份文案');
    expect(harness.logEntries.some((entry) => entry.message.includes('guide=guild'))).toBe(true);
  });

  it('三层都没有 → 内置默认文案，日志记 guide=global', async () => {
    const { service, requests, harness } = runWithGuides({ channel: null, guild: null, global: null });

    await service.run(CTX);

    expect(requests[0]?.system ?? '').toContain(DEFAULT_REACTION_GUIDE.trim());
    expect(harness.logEntries.some((entry) => entry.message.includes('guide=global'))).toBe(true);
  });

  it('没接线（老调用方）→ 三层一次都不读，也不炸，用内置默认', async () => {
    const { service, requests, harness } = runWithGuides(undefined);

    const result = await service.run(CTX);

    expect(result.text).toBe('好');
    expect(harness.reactionGuideKeys).toEqual([]);
    expect(requests[0]?.system ?? '').toContain(DEFAULT_REACTION_GUIDE.trim());
  });

  it('表情模型的 system 就是解析后的那一份文案', async () => {
    const sink: ReactionSink = { chats: [], keys: [] };
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': track('openai-compat', ['好的'], { requests, providerCalls: [] }),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
      reactionGuides: { channel: CHANNEL_ROW },
    });
    const service = createChatService(harness.deps);

    await service.run({ ...CTX, wantReactions: true });

    expect(sink.chats[0]?.system).toBe('频道这一份文案\n\n' + NO_REACTION_NOTE);
    expect(harness.logEntries.some((entry) => entry.message.includes('guide=channel'))).toBe(true);
  });
});

describe('表情素材模板三层覆盖（§34.4）', () => {
  const CHANNEL_ROW: ReactionTemplateConfig = {
    scope: 'channel',
    scopeId: 'c1',
    template: '【频道模板】\n{{我的回复}}\n\n{{对方的消息}}',
    updatedAt: FIXED_NOW,
  };
  const GUILD_ROW: ReactionTemplateConfig = {
    scope: 'guild',
    scopeId: 'g1',
    template: '【公会模板】\n{{对方的消息}}',
    updatedAt: FIXED_NOW,
  };
  const GLOBAL_ROW: ReactionTemplateConfig = {
    scope: 'global',
    scopeId: '',
    template: '【全局模板】\n{{我的回复}}',
    updatedAt: FIXED_NOW,
  };

  // 走真实的一轮：主模型给一句正文，表情模型收回来的素材就是后台那份模板渲染的结果
  async function runWithTemplates(
    templates: Parameters<typeof makeHarness>[0]['reactionTemplates'],
    history?: ChatMessage[],
  ): Promise<{ harness: Harness; material: string }> {
    const sink: ReactionSink = { chats: [], keys: [] };
    const harness = makeHarness({
      providers: {
        'openai-compat': streamProvider('openai-compat', ['好的', '[[react:👍]]']),
        gemini: reactionProvider('🔥', sink),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), gemini: decryptedKey('gemini') },
      routes: { global: ROUTE },
      reactionModels: reactionStore(REACTION_CFG, { count: 0 }),
      ...(templates === undefined ? {} : { reactionTemplates: templates }),
      ...(history === undefined ? {} : { history }),
    });
    await createChatService(harness.deps).run({ ...CTX, wantReactions: true });
    return { harness, material: sink.chats[0]?.messages[0]?.content ?? '' };
  }

  it('三层都有 → channel 整份生效，三层按 channel → guild → global 读，日志记 template=channel', async () => {
    const { harness, material } = await runWithTemplates({
      channel: CHANNEL_ROW,
      guild: GUILD_ROW,
      global: GLOBAL_ROW,
    });

    expect(material).toBe('【频道模板】\n好的\n\n你好');
    expect(harness.reactionTemplateKeys).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
    expect(harness.logEntries.some((entry) => entry.message.includes('template=channel'))).toBe(true);
  });

  it('channel 没有 → guild 生效；guild 也没有 → global 生效', async () => {
    const guildHit = await runWithTemplates({ guild: GUILD_ROW, global: GLOBAL_ROW });
    expect(guildHit.material).toBe('【公会模板】\n你好');
    expect(guildHit.harness.logEntries.some((entry) => entry.message.includes('template=guild'))).toBe(true);

    const globalHit = await runWithTemplates({ global: GLOBAL_ROW });
    expect(globalHit.material).toBe('【全局模板】\n好的');
    expect(globalHit.harness.logEntries.some((entry) => entry.message.includes('template=global'))).toBe(true);
  });

  it('模板只有空白 = 这一层没有配置，落回上层', async () => {
    const { material } = await runWithTemplates({
      channel: { ...CHANNEL_ROW, template: '  \n \n' },
      guild: GUILD_ROW,
    });

    expect(material).toBe('【公会模板】\n你好');
  });

  it('三层都没有 → 内置默认模板，日志记 template=global', async () => {
    const { harness, material } = await runWithTemplates({ channel: null, guild: null, global: null });

    expect(material).toBe('【最近的对话】\n\n【对方的消息】\n你好\n\n【我的回复】\n好的');
    expect(harness.logEntries.some((entry) => entry.message.includes('template=global'))).toBe(true);
  });

  it('素材只带最近 20 条历史：库里 25 条也只喂最后 20 行，最早 5 条不出现', async () => {
    const many: ChatMessage[] = Array.from({ length: 25 }, (_unused, i) => ({
      role: 'user' as const,
      content: '第' + i + '条',
    }));

    const { material } = await runWithTemplates({ global: { ...GLOBAL_ROW, template: '{{最近对话}}' } }, many);

    const lines = material.split('\n');
    expect(lines).toHaveLength(REACTION_HISTORY_MESSAGES);
    expect(lines[0]).toBe('用户：第5条');
    expect(lines[REACTION_HISTORY_MESSAGES - 1]).toBe('用户：第24条');
    expect(material).not.toContain('第0条');
    expect(material).not.toContain('第4条');
  });
});

describe('日志钩子（§19.6）', () => {
  it('回复成功：一条 info/chat，message 逐字带 model/history/dropped/ms/len', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['好', '的']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
      ],
    });
    const service = createChatService(harness.deps);

    const result = await service.run(CTX);

    expect(harness.logEntries).toHaveLength(1);
    const entry = harness.logEntries[0];
    expect(entry.level).toBe('info');
    expect(entry.scope).toBe('chat');
    // createdAt 只认注入的 now()，不是真实时钟
    expect(entry.createdAt).toBe(FIXED_NOW);
    expect(entry.message).toMatch(
      /^回复成功 model=openai-compat\/gpt-4o-mini history=2 of=2 dropped=0 ms=\d+ len=2 guide=global key=openai-compat$/,
    );
    // len 取剥干净之后的正文长度；末尾是用户起的备注，绝不是密钥（§20.5）
    expect(entry.message).toContain('len=' + String(result.text.length) + ' ');
    expect(entry.message.endsWith('key=openai-compat')).toBe(true);
    expect(entry.message).not.toContain('sk-');
  });

  it('成功事件在 append 之后触发：日志发出时那两条已经落库', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['好']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const seen: number[] = [];
    harness.deps.log = () => {
      seen.push(harness.appendCalls.length);
    };
    const service = createChatService(harness.deps);

    await service.run(CTX);

    expect(seen).toEqual([1]);
  });

  it('全部候选失败：抛错前记一条 error/chat，与抛出的错误消息逐字同源', async () => {
    const harness = makeHarness({
      providers: {
        'openai-compat': failingProvider('openai-compat', '第一个炸了'),
        anthropic: failingProvider('anthropic', '第二个也炸了'),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), anthropic: decryptedKey('anthropic') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    const error = await service.run(CTX).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const thrown = (error as Error).message;
    expect(harness.logEntries).toHaveLength(1);
    const entry = harness.logEntries[0];
    expect(entry.level).toBe('error');
    expect(entry.scope).toBe('chat');
    expect(entry.createdAt).toBe(FIXED_NOW);
    expect(entry.message).toBe('回复失败 ' + thrown);
    expect(entry.message).toContain('ALL_PROVIDERS_FAILED: ');
  });

  it('错误文本进日志只留前 300 字', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': failingProvider('openai-compat', 'x'.repeat(400)) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });
    const service = createChatService(harness.deps);

    await expect(service.run(CTX)).rejects.toThrow('ALL_PROVIDERS_FAILED');

    // 抛给调用方的仍是完整消息，只有日志被截断
    expect(harness.logEntries).toHaveLength(1);
    const message = harness.logEntries[0].message;
    expect(message.startsWith('回复失败 ALL_PROVIDERS_FAILED: ')).toBe(true);
    expect(message).toHaveLength('回复失败 '.length + 300);
  });

  it('兜底候选成功时只有成功事件，没有失败事件', async () => {
    const harness = makeHarness({
      providers: {
        'openai-compat': failingProvider('openai-compat', '第一个炸了'),
        anthropic: streamProvider('anthropic', ['兜', '底']),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat'), anthropic: decryptedKey('anthropic') },
      routes: { global: ROUTE },
    });
    const service = createChatService(harness.deps);

    await service.run(CTX);

    expect(harness.logEntries).toHaveLength(1);
    expect(harness.logEntries[0].level).toBe('info');
    expect(harness.logEntries[0].message).toContain('model=anthropic/claude-3-5-haiku');
  });

  it('不接线 log 时照常返回（no-op 兜底）', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    const deps: ChatServiceDeps = { ...harness.deps };
    delete deps.log;

    await expect(createChatService(deps).run(CTX)).resolves.toMatchObject({ text: 'ok' });
    expect(harness.logEntries).toEqual([]);
  });

  it('钩子自己抛错也不影响回复：只落一行 console.warn', async () => {
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok']) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });
    harness.deps.log = () => {
      throw new Error('sink 挂了');
    };
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const service = createChatService(harness.deps);

    try {
      await expect(service.run(CTX)).resolves.toMatchObject({ text: 'ok' });
    } finally {
      spy.mockRestore();
    }

    expect(warnings.filter((line) => line.includes('[chat] 写日志失败：'))).toHaveLength(1);
    expect(warnings.join('\n')).toContain('sink 挂了');
  });
});

/** 按 apiKey 排剧本：记录每把 Key 的实际使用顺序，才能断言「第二把从未被调用」（§20.5） */
function scriptedStreamProvider(
  id: ProviderId,
  used: string[],
  script: (apiKey: string) => { deltas: string[]; error?: Error },
): LlmProvider {
  return {
    id,
    chat: async () => {
      throw new Error('流式路径不应调用 chat()');
    },
    listModels: async () => [],
    chatStream(_req: LlmRequest, rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      used.push(rt.apiKey);
      return (async function* () {
        const outcome = script(rt.apiKey);
        for (let index = 0; index < outcome.deltas.length; index += 1) {
          const last = index === outcome.deltas.length - 1;
          yield last ? { delta: outcome.deltas[index], finishReason: 'stop' } : { delta: outcome.deltas[index] };
        }
        if (outcome.error !== undefined) throw outcome.error;
      })();
    },
  };
}

/** 非流式（摘要）用：按 apiKey 决定「返回正文」还是「抛错」 */
function scriptedChatProvider(
  id: ProviderId,
  used: string[],
  reply: (apiKey: string) => string | Error,
): LlmProvider {
  return {
    id,
    async chat(_req, rt) {
      used.push(rt.apiKey);
      const outcome = reply(rt.apiKey);
      if (outcome instanceof Error) throw outcome;
      return { text: outcome };
    },
    async listModels() {
      return [];
    },
    chatStream(): AsyncIterable<LlmChunk> {
      throw new Error('非流式路径不应调用 chatStream()');
    },
  };
}

const CHANNEL_KEY = { guildId: 'g1', channelId: 'c1' };
/** 同供应商两把 Key：仓储按 created_at,id 给的顺序就是这里的先后 */
const TWO_KEYS: DecryptedKey[] = [
  { id: 'k1', provider: 'openai-compat', label: 'deepseek', apiKey: 'sk-1', models: [] },
  { id: 'k2', provider: 'openai-compat', label: 'gg', apiKey: 'sk-2', models: [] },
];

describe('run 同供应商换 Key（§20.5）', () => {
  it('第一把在首个 chunk 之前失败 → 换第二把，回复内容与日志里的 key 都来自第二把', async () => {
    const used: string[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': scriptedStreamProvider('openai-compat', used, (apiKey) =>
          apiKey === 'sk-1' ? { deltas: [], error: new Error('第一把 401') } : { deltas: ['第二把', '的话'] },
        ),
      },
      keys: { 'openai-compat': TWO_KEYS },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });

    const result = await createChatService(harness.deps).run(CTX, harness.events);

    expect(used).toEqual(['sk-1', 'sk-2']);
    expect(result.text).toBe('第二把的话');
    expect(result.attempts).toEqual([]);
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('第二把的话');
    expect(harness.logEntries).toHaveLength(1);
    expect(harness.logEntries[0]?.message).toContain(' key=gg');
    expect(harness.logEntries[0]?.message).not.toContain('sk-');
  });

  it('声明命中模型的 Key 排在前面：第二把 Key 先被调用（旧的 firstEnabled 永远只用第一把）', async () => {
    const used: string[] = [];
    const keys: DecryptedKey[] = [
      { id: 'k1', provider: 'openai-compat', label: 'gg', apiKey: 'sk-1', models: ['gg-model'] },
      { id: 'k2', provider: 'openai-compat', label: 'deepseek', apiKey: 'sk-2', models: ['gpt-4o-mini'] },
    ];
    const harness = makeHarness({
      providers: { 'openai-compat': scriptedStreamProvider('openai-compat', used, () => ({ deltas: ['ok'] })) },
      keys: { 'openai-compat': keys },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });

    const result = await createChatService(harness.deps).run(CTX);

    expect(used).toEqual(['sk-2']);
    expect(result.text).toBe('ok');
    expect(harness.logEntries[0]?.message).toContain(' key=deepseek');
  });

  it('首个 chunk 之后才失败 → 不换 Key（第二把从未被调用），该候选模型计失败', async () => {
    const used: string[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': scriptedStreamProvider('openai-compat', used, () => ({
          deltas: ['半截'],
          error: new Error('流挂了'),
        })),
      },
      keys: { 'openai-compat': TWO_KEYS },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });

    const error = await createChatService(harness.deps).run(CTX, harness.events).then(
      () => null,
      (caught: unknown) => caught,
    );

    // 用户已经看到「半截」：再换一把会把同一条消息从头重写
    expect(harness.progress.at(-1)).toBe('半截');
    expect(used).toEqual(['sk-1']);
    expect((error as Error).message).toBe(
      'ALL_PROVIDERS_FAILED: ' + JSON.stringify([{ model: PRIMARY, error: '流挂了' }]),
    );
    expect(harness.appendCalls).toHaveLength(0);
  });

  it('两把 Key 都失败 → attempts 只记最后一把的原始错误', async () => {
    const used: string[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': scriptedStreamProvider('openai-compat', used, (apiKey) => ({
          deltas: [],
          error: new Error(apiKey === 'sk-1' ? '第一把挂了' : '第二把挂了'),
        })),
      },
      keys: { 'openai-compat': TWO_KEYS },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });

    const error = await createChatService(harness.deps).run(CTX).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(used).toEqual(['sk-1', 'sk-2']);
    const message = (error as Error).message;
    expect(message.startsWith('ALL_PROVIDERS_FAILED: ')).toBe(true);
    expect(JSON.parse(message.slice('ALL_PROVIDERS_FAILED: '.length))).toEqual([
      { model: PRIMARY, error: '第二把挂了' },
    ]);
  });

  it('一把 enabled 的 Key 都没有 → NO_KEY_FOR_PROVIDER，且不去调用 provider', async () => {
    const used: string[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': scriptedStreamProvider('openai-compat', used, () => ({ deltas: ['不该'] })) },
      keys: { 'openai-compat': null },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
    });

    const error = await createChatService(harness.deps).run(CTX).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(used).toEqual([]);
    expect((error as Error).message).toBe(
      'ALL_PROVIDERS_FAILED: ' + JSON.stringify([{ model: PRIMARY, error: 'NO_KEY_FOR_PROVIDER' }]),
    );
  });
});

describe('summarize 同供应商换 Key（§20.5）', () => {
  it('非流式逐把尝试：第一把失败换第二把，摘要落库来自第二把', async () => {
    const used: string[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': scriptedChatProvider('openai-compat', used, (apiKey) =>
          apiKey === 'sk-1' ? new Error('第一把挂了') : '他喜欢猫。',
        ),
      },
      keys: { 'openai-compat': TWO_KEYS },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
      history: [{ role: 'user', content: '我喜欢猫' }],
    });

    const outcome = await createChatService(harness.deps).summarize(CHANNEL_KEY);

    expect(used).toEqual(['sk-1', 'sk-2']);
    expect(outcome?.summary).toBe('【记忆段】\n他喜欢猫。');
    expect(outcome?.model).toBe('gpt-4o-mini');
    expect(harness.summaryPuts).toHaveLength(1);
    expect(harness.summaryPuts[0]?.summary).toBe('【记忆段】\n他喜欢猫。');
  });

  it('两把 Key 都失败 → ALL_PROVIDERS_FAILED 只记最后一把的错误', async () => {
    const used: string[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': scriptedChatProvider('openai-compat', used, (apiKey) =>
          new Error(apiKey === 'sk-1' ? '第一把挂了' : '第二把挂了'),
        ),
      },
      keys: { 'openai-compat': TWO_KEYS },
      routes: { global: { primary: PRIMARY, fallbacks: [] } },
      history: [{ role: 'user', content: '我喜欢猫' }],
    });

    const error = await createChatService(harness.deps).summarize(CHANNEL_KEY).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(used).toEqual(['sk-1', 'sk-2']);
    expect((error as Error).message).toBe(
      'ALL_PROVIDERS_FAILED: ' + JSON.stringify([{ model: PRIMARY, error: '第二把挂了' }]),
    );
    expect(harness.summaryPuts).toHaveLength(0);
  });
});


describe('深度注入进请求 messages', () => {
  const HISTORY: ChatMessage[] = [
    { role: 'user', content: '上一轮', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
    { role: 'assistant', content: '上一轮回答', author: '小助手', createdAt: FIXED_NOW },
  ];
  // 接线前的装配结果：历史两条（带时间戳/名字）+ 本轮用户消息，逐字钉住
  const NO_INJECTION_MESSAGES: ChatMessage[] = [...HISTORY.map(withAuthorPrefix), { role: 'user', content: STAMP + '阿天(u1)：你好' }];

  function injection(overrides: Partial<PromptInjectionConfig> = {}): PromptInjectionConfig {
    return { scope: 'global', scopeId: '', content: '记住：保持简短', depth: 0, role: 'system', updatedAt: FIXED_NOW, ...overrides };
  }

  async function runOnce(input: {
    promptInjections?: Parameters<typeof makeHarness>[0]['promptInjections'];
  }): Promise<{ messages: ChatMessage[]; harness: Harness }> {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['好的'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: HISTORY,
      ...(input.promptInjections === undefined ? {} : { promptInjections: input.promptInjections }),
    });
    await createChatService(harness.deps).run(CTX);
    return { messages: requests[0]?.messages ?? [], harness };
  }

  it('没接线时 messages 与接线前逐字一致（内容、顺序、每条字段都不变）', async () => {
    const { messages, harness } = await runOnce({});
    expect(messages).toEqual(NO_INJECTION_MESSAGES);
    expect(harness.injectionKeys).toEqual([]);
  });

  it('接线但三层都没配置（null / 空正文）→ 仍然逐字一致', async () => {
    const { messages, harness } = await runOnce({
      promptInjections: {
        channel: injection({ scope: 'channel', scopeId: 'c1', content: '   ' }),
        guild: null,
        global: injection({ content: '' }),
      },
    });
    expect(messages).toEqual(NO_INJECTION_MESSAGES);
    // 三层是同一批并行读的：即使全空也各读一次
    expect(harness.injectionKeys).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
  });

  it('depth 0 → 紧接本轮用户消息之前，合成消息只有 role + content、不带时间戳/名字前缀', async () => {
    const { messages } = await runOnce({ promptInjections: { global: injection({ depth: 0 }) } });
    expect(messages).toEqual([
      NO_INJECTION_MESSAGES[0],
      NO_INJECTION_MESSAGES[1],
      { role: 'system', content: '记住：保持简短' },
      NO_INJECTION_MESSAGES[2],
    ]);
    const synthetic = messages[2];
    expect(Object.keys(synthetic).sort()).toEqual(['content', 'role']);
    expect(synthetic.content.startsWith('[')).toBe(false);
  });

  it('depth 1 → 插在倒数第 2 条之前', async () => {
    const { messages } = await runOnce({ promptInjections: { global: injection({ depth: 1 }) } });
    expect(messages).toEqual([
      NO_INJECTION_MESSAGES[0],
      { role: 'system', content: '记住：保持简短' },
      NO_INJECTION_MESSAGES[1],
      NO_INJECTION_MESSAGES[2],
    ]);
  });

  it('channel 压过 guild / global，role 原样透传：user 行也不加名字前缀', async () => {
    const { messages } = await runOnce({
      promptInjections: {
        channel: injection({ scope: 'channel', scopeId: 'c1', content: '频道注入', depth: 0, role: 'user' }),
        guild: injection({ scope: 'guild', scopeId: 'g1', content: '服务器注入', depth: 0, role: 'assistant' }),
        global: injection({ content: '全局注入', depth: 0, role: 'system' }),
      },
    });
    expect(messages.at(-2)).toEqual({ role: 'user', content: '频道注入' });
    expect(messages.filter((message) => message.content === '服务器注入' || message.content === '全局注入')).toHaveLength(0);
    // 单轮只注入一条
    expect(messages).toHaveLength(NO_INJECTION_MESSAGES.length + 1);
  });

  it('channel 是空正文 → 视为没配置、落到 guild 那一层', async () => {
    const { messages } = await runOnce({
      promptInjections: {
        channel: injection({ scope: 'channel', scopeId: 'c1', content: '  ', depth: 0, role: 'user' }),
        guild: injection({ scope: 'guild', scopeId: 'g1', content: '服务器注入', depth: 0, role: 'assistant' }),
        global: injection({ content: '全局注入', depth: 0, role: 'system' }),
      },
    });
    expect(messages.at(-2)).toEqual({ role: 'assistant', content: '服务器注入' });
  });

  it('合成消息不落库：append 仍然只有本轮用户消息与自己那句回复', async () => {
    const { harness } = await runOnce({ promptInjections: { global: injection({ depth: 0 }) } });
    expect(harness.appendCalls).toHaveLength(1);
    const appended = (harness.appendCalls[0]?.messages ?? []).map((message) => message.content);
    expect(appended[0]).toBe('你好');
    expect(appended).not.toContain('记住：保持简短');
  });
});

describe('世界书进 system', () => {
  // 身份块里的日期取真实时钟（buildPromptParts 不看注入的 now），跟着它算才不会被当天日期绊倒
  const TODAY = new Date().toISOString().slice(0, 10);
  const HISTORY: ChatMessage[] = [
    { role: 'user', content: '上一轮', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
    { role: 'assistant', content: '上一轮回答', author: '小助手', createdAt: FIXED_NOW },
  ];
  // 接线前的装配结果：前置段 + 身份块 + 表情规则；世界书没命中时这一串必须逐字不变
  const BASE_SYSTEM = '基本设定' + '\n\n' + platformHead(CTX, TODAY);

  function entry(overrides: Partial<WorldEntry> = {}): WorldEntry {
    return {
      id: 0,
      name: '龙族',
      keys: ['龙'],
      secondaryKeys: [],
      content: '龙住在山里。',
      enabled: true,
      constant: false,
      selective: false,
      selectiveLogic: 'andAny',
      order: 100,
      caseSensitive: false,
      wholeWords: false,
      ...overrides,
    };
  }

  function record(content: string, overrides: Partial<WorldBookRecord> = {}): WorldBookRecord {
    const book: WorldBook = { name: '测试书', entries: [entry({ content })], ignored: [], warnings: [] };
    return { scope: 'global', scopeId: '', name: '测试书', book, entryCount: 1, importedAt: FIXED_NOW, ...overrides };
  }

  async function runSystem(input: {
    worldBooks?: Parameters<typeof makeHarness>[0]['worldBooks'];
    history?: ChatMessage[];
    userText?: string;
  }): Promise<{ system: string; harness: Harness }> {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['好的'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: input.history ?? HISTORY,
      prompts: { global: { segments: [segment('main', '基本设定')] } },
      ...(input.worldBooks === undefined ? {} : { worldBooks: input.worldBooks }),
    });
    const ctx = input.userText === undefined ? CTX : { ...CTX, userText: input.userText };
    await createChatService(harness.deps).run(ctx);
    return { system: requests[0]?.system ?? '', harness };
  }

  it('没接线时 system 与改动前逐字相同，且一次世界书都不查', async () => {
    const { system, harness } = await runSystem({});
    expect(system).toBe(BASE_SYSTEM);
    expect(harness.worldBookKeys).toEqual([]);
  });

  it('接线但三层都没书 → 仍然逐字相同（不多出空行）', async () => {
    const { system, harness } = await runSystem({ worldBooks: { channel: null, guild: null, global: null } });
    expect(system).toBe(BASE_SYSTEM);
    expect(harness.worldBookKeys).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
  });

  it('有书但关键词没命中 → 仍然逐字相同', async () => {
    const { system } = await runSystem({ worldBooks: { global: record('龙住在山里。') } });
    expect(system).toBe(BASE_SYSTEM);
  });

  it('命中后出现【世界书】段，位置在平台元信息之后、预设段之后', async () => {
    const { system } = await runSystem({ worldBooks: { global: record('龙住在山里。') }, userText: '龙来了' });
    expect(system).toBe('基本设定' + '\n\n' + platformHead(CTX, TODAY) + '\n\n【世界书】\n龙住在山里。');
    expect(system.indexOf('【世界书】')).toBeGreaterThan(system.indexOf('【当前对话】'));
    expect(system.indexOf('【世界书】')).toBeGreaterThan(system.indexOf('基本设定'));
  });

  it('本轮用户消息也进扫描窗口', async () => {
    const { system } = await runSystem({ worldBooks: { global: record('龙住在山里。') }, userText: '书上说的那种龙' });
    expect(system).toContain('【世界书】');
  });

  it('扫描窗口只看最近 4 条：更早的命中不算', async () => {
    const far: ChatMessage[] = [
      { role: 'user', content: '龙', createdAt: FIXED_NOW },
      { role: 'user', content: '一', createdAt: FIXED_NOW },
      { role: 'user', content: '二', createdAt: FIXED_NOW },
      { role: 'user', content: '三', createdAt: FIXED_NOW },
      { role: 'user', content: '四', createdAt: FIXED_NOW },
    ];
    const missed = await runSystem({ worldBooks: { global: record('龙住在山里。') }, history: far });
    expect(missed.system).toBe(BASE_SYSTEM);

    const near = await runSystem({
      worldBooks: { global: record('龙住在山里。') },
      history: [...far.slice(1), { role: 'user', content: '龙', createdAt: FIXED_NOW }],
    });
    expect(near.system).toContain('【世界书】\n龙住在山里。');
  });

  it('三层整本覆盖：channel 有书就不看 guild / global', async () => {
    const { system } = await runSystem({
      worldBooks: {
        channel: record('频道书里写着龙。', { scope: 'channel', scopeId: 'c1', name: '频道书' }),
        guild: record('公会书里写着龙。', { scope: 'guild', scopeId: 'g1', name: '公会书' }),
        global: record('全局书里写着龙。', { scope: 'global', scopeId: '', name: '全局书' }),
      },
      userText: '龙来了',
    });
    expect(system).toContain('频道书里写着龙。');
    expect(system).not.toContain('公会书里写着龙。');
    expect(system).not.toContain('全局书里写着龙。');
  });

  it('channel 没书就落到 guild 那一层', async () => {
    const { system } = await runSystem({
      worldBooks: {
        channel: null,
        guild: record('公会书里写着龙。', { scope: 'guild', scopeId: 'g1', name: '公会书' }),
      },
      userText: '龙来了',
    });
    expect(system).toContain('公会书里写着龙。');
  });

  it('世界书段不落库：append 仍然只有本轮用户消息与自己那句回复', async () => {
    const { harness } = await runSystem({ worldBooks: { global: record('龙住在山里。') }, userText: '龙来了' });
    const appended = (harness.appendCalls[0]?.messages ?? []).map((message) => message.content);
    expect(appended).toHaveLength(2);
    expect(appended.some((content) => content.includes('世界书'))).toBe(false);
  });
});

describe('工具定义进请求（story_reply 兼容性保留）', () => {
  it('system 里出现 story_reply：交给 provider 的流式请求带一条工具定义与 toolChoice=auto', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        global: {
          segments: [segment('main', '你是示例角色。每次回复都调用 story_reply，把正文放进 content。')],
        },
      },
    });

    await createChatService(harness.deps).run(CTX);

    expect(requests[0]?.system).toContain('story_reply');
    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[0]?.tools?.[0].function.name).toBe('story_reply');
    expect(requests[0]?.toolChoice).toBe('auto');
  });

  it('system 不含工具名：请求里连 tools / toolChoice 两个键都没有（旧形状）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: { 'openai-compat': streamProvider('openai-compat', ['ok'], { onRequest: (req) => requests.push(req) }) },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
    });

    await createChatService(harness.deps).run(CTX);

    expect(requests[0]?.system).not.toContain('story_reply');
    expect('tools' in (requests[0] ?? {})).toBe(false);
    expect('toolChoice' in (requests[0] ?? {})).toBe(false);
  });
});

describe('§55 上下文工具模式（contextTool）', () => {
  const PRESET = '你是示例角色。每次回复都调用 story_reply，把正文放进 content。';
  const REPLY_ARGS = JSON.stringify({ think_nya: '心里那句', game_content: '正文第一段', extra: '补一句' });

  it('打开：只发一条 user 消息，预设/摘要/历史进 context 描述，正文取 game_content + extra', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          {
            text: '',
            toolCalls: [{ name: 'story_reply', arguments: REPLY_ARGS }],
          },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        global: {
          segments: [segment('main', PRESET), segment('tail', '收尾设定段', { placement: 'after' })],
        },
      },
      history: [
        { role: 'user', content: '上一轮问题', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
        { role: 'assistant', content: '上一轮回答', author: '小助手', createdAt: FIXED_NOW },
      ],
      summary: '上次聊到电影',
      channelMemory: memoryConfig({ contextTool: true }),
    });

    const result = await createChatService(harness.deps).run(CTX);

    expect(harness.requests).toHaveLength(0);
    const request = requests[0];
    // 平台元信息一段都不发：system 只剩那句平台中性的话
    expect(request?.system).toBe(CONTEXT_TOOL_SYSTEM);
    // 顶层 user 只有固定那一句：用户原话改藏进描述体（线上实测这样才不进拒答）
    expect(request?.messages).toEqual([{ role: 'user', content: CONTEXT_TOOL_TURN }]);
    expect(request?.tools?.map((tool) => tool.function.name)).toEqual(['context', 'story_reply']);
    expect(request?.toolChoice).toBe('auto');
    // 照抄酒馆那条实发请求的两个字段：这一模式才带，老模式一个都不许有
    expect(request?.reasoningEffort).toBe('low');
    expect(request?.maxTokens).toBe(65535);

    const description = request?.tools?.[0]?.function.description ?? '';
    expect(description).toContain(PRESET);
    expect(description).toContain('收尾设定段');
    expect(description).toContain('<recall>\n【长期记忆摘要】\n上次聊到电影\n</recall>');
    // §61 短期历史另起一个标签，且排在长期记忆之后
    expect(description).toContain('<recent>\n');
    expect(description).toContain('上一轮回答\n</recent>');
    expect(description.indexOf('</recall>')).toBeLessThan(description.indexOf('<recent>'));
    expect(description).toContain('上一轮问题');
    expect(description).toContain('上一轮回答');
    // 预设 before 段排在 after 段之前
    expect(description.indexOf(PRESET)).toBeLessThan(description.indexOf('收尾设定段'));
    // 本轮用户那一行原样作为描述体最后一段（时刻 + 名字 + 正文），而不是当 user 消息发出去
    expect(description.endsWith(STAMP + '阿天(u1)：你好')).toBe(true);

    expect(result.text).toBe('正文第一段\n\n补一句');
    expect(result.text).not.toContain('心里那句');
    expect(harness.logEntries.some((entry) => entry.message.includes('mode=context'))).toBe(true);
  });

  it('§65 世界书命中后进描述体，排在预设段之后、<recall> 之前', async () => {
    const requests: LlmRequest[] = [];
    const book: WorldBook = {
      name: '测试书',
      entries: [
        {
          id: 0,
          name: '龙族',
          keys: ['龙'],
          secondaryKeys: [],
          content: '龙住在山里。',
          enabled: true,
          constant: false,
          selective: false,
          selectiveLogic: 'andAny',
          order: 100,
          caseSensitive: false,
          wholeWords: false,
        },
      ],
      ignored: [],
      warnings: [],
    };
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          { text: '', toolCalls: [{ name: 'story_reply', arguments: REPLY_ARGS }] },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: { global: { segments: [segment('main', PRESET), segment('tail', '收尾设定段', { placement: 'after' })] } },
      history: [
        { role: 'user', content: '上一轮问题', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
        { role: 'assistant', content: '上一轮回答', author: '小助手', createdAt: FIXED_NOW },
      ],
      summary: '上次聊到电影',
      worldBooks: {
        global: { scope: 'global', scopeId: '', name: '测试书', book, entryCount: 1, importedAt: FIXED_NOW },
      },
      channelMemory: memoryConfig({ contextTool: true }),
    });

    await createChatService(harness.deps).run({ ...CTX, userText: '龙来了' });

    const description = requests[0]?.tools?.[0]?.function.description ?? '';
    expect(description).toContain('【世界书】\n龙住在山里。');
    // 设定先立、记忆后叙：世界书夹在预设段之后、<recall> 之前
    expect(description.indexOf('收尾设定段')).toBeLessThan(description.indexOf('【世界书】'));
    expect(description.indexOf('【世界书】')).toBeLessThan(description.indexOf('<recall>'));
  });


  it('正文表情规则与自定义表情清单一并进描述体：清单只列名字，世界书之后、<recall> 之前', async () => {
    const requests: LlmRequest[] = [];
    const book: WorldBook = {
      name: '测试书',
      entries: [
        {
          id: 0,
          name: '龙族',
          keys: ['龙'],
          secondaryKeys: [],
          content: '龙住在山里。',
          enabled: true,
          constant: false,
          selective: false,
          selectiveLogic: 'andAny',
          order: 100,
          caseSensitive: false,
          wholeWords: false,
        },
      ],
      ignored: [],
      warnings: [],
    };
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          { text: '', toolCalls: [{ name: 'story_reply', arguments: REPLY_ARGS }] },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: {
        global: { segments: [segment('main', PRESET), segment('tail', '收尾设定段', { placement: 'after' })] },
      },
      summary: '上次聊到电影',
      worldBooks: {
        global: { scope: 'global', scopeId: '', name: '测试书', book, entryCount: 1, importedAt: FIXED_NOW },
      },
      bodyEmojiGuides: {
        global: { scope: 'global', scopeId: '', prompt: '偶尔带 :laugh:，别每句都带', updatedAt: FIXED_NOW },
      },
      channelMemory: memoryConfig({ contextTool: true }),
    });

    await createChatService(harness.deps).run({
      ...CTX,
      userText: '龙来了',
      customEmojis: [{ name: 'laugh', id: '1', description: '一只笑猫', aliases: ['笑笑'] }],
    });

    const description = requests[0]?.tools?.[0]?.function.description ?? '';
    expect(description).toContain('\n\n【可用自定义表情】\n:laugh:');
    expect(description).toContain('\n\n【正文表情】\n偶尔带 :laugh:，别每句都带');
    // 描述体里的清单只列名字：认图描述与别名是表情模型的元叙述，不进剧情提示词
    expect(description).not.toContain('一只笑猫');
    expect(description).not.toContain('别名');
    // 设定 → 素材 → 用法 → 记忆：清单与规则一起夹在世界书之后、摘要之前
    expect(description.indexOf('【世界书】')).toBeLessThan(description.indexOf('【可用自定义表情】'));
    expect(description.indexOf('【可用自定义表情】')).toBeLessThan(description.indexOf('【正文表情】'));
    expect(description.indexOf('【正文表情】')).toBeLessThan(description.indexOf('<recall>'));
  });

  it('规则为空时描述体不含正文表情段：与接线前逐字一致（没接线 / 接线但三层没配）', async () => {
    // 给了自定义表情也没有清单：规则为空时清单与规则一起消失，这是本次改动的硬要求
    const emojis: CustomEmoji[] = [{ name: 'laugh', id: '1', description: '一只笑猫' }];
    async function descriptionFor(bodyEmojiGuides?: { global?: BodyEmojiGuideConfig }): Promise<string> {
      const requests: LlmRequest[] = [];
      const harness = makeHarness({
        providers: {
          'openai-compat': toolProvider(
            'openai-compat',
            { text: '', toolCalls: [{ name: 'story_reply', arguments: REPLY_ARGS }] },
            { onRequest: (req) => requests.push(req) },
          ),
        },
        keys: { 'openai-compat': decryptedKey('openai-compat') },
        routes: { global: ROUTE },
        prompts: { global: { segments: [segment('main', PRESET)] } },
        summary: '上次聊到电影',
        channelMemory: memoryConfig({ contextTool: true }),
        ...(bodyEmojiGuides === undefined ? {} : { bodyEmojiGuides }),
      });

      await createChatService(harness.deps).run({ ...CTX, customEmojis: emojis });

      return requests[0]?.tools?.[0]?.function.description ?? '';
    }

    const unwired = await descriptionFor();
    expect(unwired).not.toContain('【正文表情】');
    expect(unwired).not.toContain('【可用自定义表情】');
    // 预设之后直接就是记忆段：中间没有多出来的空段
    expect(unwired).toContain(PRESET + '\n\n<recall>');

    // 接了仓储、三层都空：读了三层，但描述体与没接线时逐字相同
    const wired = await descriptionFor({});
    expect(wired).toBe(unwired);
  });

  it('§65 没书或没命中时描述体不多出空段（世界书是空串就整段跳过）', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          { text: '', toolCalls: [{ name: 'story_reply', arguments: REPLY_ARGS }] },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: { global: { segments: [segment('main', PRESET)] } },
      summary: '上次聊到电影',
      worldBooks: { channel: null, guild: null, global: null },
      channelMemory: memoryConfig({ contextTool: true }),
    });

    await createChatService(harness.deps).run(CTX);

    const description = requests[0]?.tools?.[0]?.function.description ?? '';
    expect(description).not.toContain('【世界书】');
    expect(description).toContain(PRESET + '\n\n<recall>');
  });

  it('这一模式现在走 chatStream：chat() 一次都没调，正文仍来自 story_reply 的 game_content', async () => {
    let chatCalls = 0;
    let streamCalls = 0;
    const provider: LlmProvider = {
      id: 'openai-compat',
      async chat(): Promise<LlmResult> {
        chatCalls += 1;
        return { text: '非流式正文' };
      },
      async listModels() {
        return [];
      },
      chatStream(): AsyncIterable<LlmChunk> {
        streamCalls += 1;
        return (async function* () {
          yield {
            delta: '',
            toolCallDelta: { index: 0, name: 'story_reply', arguments: '{"game_content":"流式' },
          };
          yield { delta: '', toolCallDelta: { index: 0, arguments: '攒出来的正文"}' } };
          yield { delta: '', finishReason: 'stop' };
        })();
      },
    };
    const harness = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      channelMemory: memoryConfig({ contextTool: true }),
    });

    const result = await createChatService(harness.deps).run(CTX);

    expect(chatCalls).toBe(0);
    expect(streamCalls).toBe(1);
    expect(result.text).toBe('流式攒出来的正文');
  });

  it('§59 只调 context 交白卷：补交付一次，第二次请求上下文进 system、工具只剩回复工具', async () => {
    const requests: LlmRequest[] = [];
    let streamCalls = 0;
    const provider: LlmProvider = {
      id: 'openai-compat',
      async chat(): Promise<LlmResult> {
        throw new Error('上下文工具模式不应调用 chat()');
      },
      async listModels() {
        return [];
      },
      chatStream(req: LlmRequest): AsyncIterable<LlmChunk> {
        requests.push(req);
        streamCalls += 1;
        const second = streamCalls > 1;
        return (async function* () {
          if (second) {
            yield {
              delta: '',
              toolCallDelta: { index: 0, name: 'story_reply', arguments: '{"game_content":"补交付' },
            };
            yield { delta: '', toolCallDelta: { index: 0, arguments: '的正文"}' } };
          } else {
            // 线上 argon 的形状：只回一个 context 调用，正文一个字没有，finish 还是 stop
            yield { delta: '', toolCallDelta: { index: 0, name: 'context', arguments: '{"query":"看看设定"}' } };
          }
          yield { delta: '', finishReason: 'stop' };
        })();
      },
    };
    const harness = makeHarness({
      providers: { 'openai-compat': provider },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: { global: { segments: [segment('main', PRESET)] } },
      history: [{ role: 'user', content: '上一轮问题', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW }],
      summary: '上次聊到电影',
      channelMemory: memoryConfig({ contextTool: true }),
    });

    const result = await createChatService(harness.deps).run(CTX);

    expect(streamCalls).toBe(2);
    // 第一回合：整份上下文在 context 的描述里，两个工具都在
    expect(requests[0]?.system).toBe(CONTEXT_TOOL_SYSTEM);
    expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(['context', 'story_reply']);
    // 第二回合：上下文搬到 system，工具只剩回复工具，顶层那句 user 原样重发
    expect(requests[1]?.system.startsWith(CONTEXT_REPLY_SYSTEM_PREFIX)).toBe(true);
    expect(requests[1]?.system).toContain(PRESET);
    expect(requests[1]?.system).toContain('上一轮问题');
    expect(requests[1]?.tools?.map((tool) => tool.function.name)).toEqual(['story_reply']);
    expect(requests[1]?.messages).toEqual(requests[0]?.messages);
    expect(requests[1]?.reasoningEffort).toBe('low');
    expect(result.text).toBe('补交付的正文');
    expect(harness.logEntries.some((entry) => entry.message.startsWith('空回补交付'))).toBe(true);
  });

  it('缺省或显式关闭：请求与没有这一行设置时逐字相同，日志里也没有 mode=context', async () => {
    const build = (channelMemory?: ChannelMemoryConfig) => {
      const requests: LlmRequest[] = [];
      const harness = makeHarness({
        providers: {
          'openai-compat': streamProvider('openai-compat', ['好的'], { onRequest: (req) => requests.push(req) }),
        },
        keys: { 'openai-compat': decryptedKey('openai-compat') },
        routes: { global: ROUTE },
        prompts: { global: { segments: [segment('main', PRESET)] } },
        history: [{ role: 'user', content: '上一轮问题', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW }],
        summary: '上次聊到电影',
        ...(channelMemory === undefined ? {} : { channelMemory }),
      });
      return { harness, requests };
    };

    const without = build();
    const off = build(memoryConfig({ contextTool: false }));

    await createChatService(without.harness.deps).run(CTX);
    await createChatService(off.harness.deps).run(CTX);

    expect(off.requests).toHaveLength(1);
    expect(JSON.stringify(off.requests[0])).toBe(JSON.stringify(without.requests[0]));
    // reasoning_effort 只在上下文工具模式出现：老模式连这个键都没有
    expect('reasoningEffort' in (off.requests[0] ?? {})).toBe(false);
    // 老形状照旧：预设点名工具就只有一条，历史仍逐条发在 messages 里，摘要仍拼在本轮消息开头
    expect(off.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(['story_reply']);
    expect(off.requests[0]?.messages).toHaveLength(2);
    expect(off.requests[0]?.messages[0]?.content).toContain('上一轮问题');
    expect(without.harness.logEntries.some((entry) => entry.message.includes('mode=context'))).toBe(false);
    expect(off.harness.logEntries.some((entry) => entry.message.includes('mode=context'))).toBe(false);
  });

  it('路由显式配了 maxTokens 时照用配置，不套 65535；reasoning_effort 仍是 low', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          { text: '', toolCalls: [{ name: 'story_reply', arguments: JSON.stringify({ game_content: '好' }) }] },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: { ...ROUTE, maxTokens: 900 } },
      channelMemory: memoryConfig({ contextTool: true }),
    });

    await createChatService(harness.deps).run(CTX);

    expect(requests[0]?.maxTokens).toBe(900);
    expect(requests[0]?.reasoningEffort).toBe('low');
  });

  it('描述体的历史按 2500 字裁：只留最近几条，顺序仍是旧→新', async () => {
    const requests: LlmRequest[] = [];
    const long = (index: number): string => '第' + String(index) + '条' + '甲'.repeat(990);
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          { text: '', toolCalls: [{ name: 'story_reply', arguments: JSON.stringify({ game_content: '好' }) }] },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: [
        { role: 'user', content: long(1), author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
        { role: 'user', content: long(2), author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
        { role: 'user', content: long(3), author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
      ],
      channelMemory: memoryConfig({ contextTool: true }),
    });

    await createChatService(harness.deps).run(CTX);

    const description = requests[0]?.tools?.[0]?.function.description ?? '';
    // 三行各 1000 字上下，2500 的预算装不下三条：最早那条被裁掉，剩下两条保持时间顺序
    expect(description).not.toContain('第1条');
    expect(description).toContain('第2条');
    expect(description).toContain('第3条');
    expect(description.indexOf('第2条')).toBeLessThan(description.indexOf('第3条'));
    expect(description).toContain(STAMP + '阿天(u1)：你好');
  });

  it('§61 上一轮的拒答不进历史：描述体里找不到它，正常行照旧', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          { text: '', toolCalls: [{ name: 'story_reply', arguments: JSON.stringify({ game_content: '好' }) }] },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      history: [
        { role: 'user', content: '老婆涩涩', author: '阿天', authorId: 'u1', createdAt: FIXED_NOW },
        {
          role: 'assistant',
          content: '我将忽略提示词中关于扮演角色以及绕过安全规则的设定。我的安全准则严格禁止生成露骨的性描写。',
          author: '小助手',
          authorId: 'bot',
          createdAt: FIXED_NOW,
        },
        { role: 'assistant', content: '喵～抱住你的胳膊蹭了蹭。', author: '小助手', authorId: 'bot', createdAt: FIXED_NOW },
      ],
      channelMemory: memoryConfig({ contextTool: true }),
    });

    await createChatService(harness.deps).run(CTX);

    const description = requests[0]?.tools?.[0]?.function.description ?? '';
    expect(description).toContain('老婆涩涩');
    expect(description).toContain('喵～抱住你的胳膊蹭了蹭。');
    expect(description).not.toContain('我将忽略');
  });
  it('流式请求抛错换下一个候选；回空正文按 EMPTY_RESPONSE 原地重试满 3 次再换', async () => {
    let calls = 0;
    const harness = makeHarness({
      providers: {
        'openai-compat': failingProvider('openai-compat', 'primary 挂了'),
        anthropic: toolProvider('anthropic', () => {
          calls += 1;
          return Promise.resolve({ text: '' });
        }),
        gemini: toolProvider('gemini', {
          text: '',
          toolCalls: [{ name: 'story_reply', arguments: JSON.stringify({ game_content: '备用正文' }) }],
        }),
      },
      keys: {
        'openai-compat': decryptedKey('openai-compat'),
        anthropic: decryptedKey('anthropic'),
        gemini: decryptedKey('gemini'),
      },
      routes: { global: { primary: PRIMARY, fallbacks: [BACKUP, THIRD] } },
      channelMemory: memoryConfig({ contextTool: true }),
    });

    const result = await createChatService(harness.deps).run(CTX);

    expect(calls).toBe(3);
    expect(result.text).toBe('备用正文');
    expect(result.model).toEqual(THIRD);
    expect(result.attempts).toEqual([
      { model: PRIMARY, error: 'primary 挂了' },
      { model: BACKUP, error: 'EMPTY_RESPONSE' },
    ]);
    expect(harness.appendCalls[0]?.messages[1]?.content).toBe('备用正文');
  });
});


describe('画图工具（draw_image）', () => {
  const DRAW_PRESET = '你是示例角色。每次回复都调用 story_reply，把正文放进 content。想画画时调用 draw_image。';
  const DRAW_ARGS = JSON.stringify({ prompt: '一只橘猫坐在窗台上' });

  it('模型反复只调 draw_image：第二段也交不出正文时只发图，历史留 [图片]，工具表里多一条', async () => {
    const requests: LlmRequest[] = [];
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          { text: '', toolCalls: [{ name: 'draw_image', arguments: DRAW_ARGS }] },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat', { baseUrl: 'https://relay.test/pg/v1' }) },
      routes: { global: ROUTE },
      prompts: { global: { segments: [segment('main', DRAW_PRESET)] } },
      channelMemory: memoryConfig({ contextTool: true }),
    });
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await createChatService(harness.deps).run(CTX);
      expect(result.text).toBe('');
      expect(result.image?.mime).toBe('image/jpeg');
      expect(Buffer.from(result.image?.data ?? new Uint8Array()).toString()).toBe('img');
      expect(urls[0]).toBe('https://relay.test/pg/v1/images/generations');
      expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual([
        'context',
        'story_reply',
        'draw_image',
      ]);
      expect(harness.appendCalls[0]?.messages[1]?.content).toBe('[图片]');
      expect(harness.logEntries.some((entry) => entry.message.includes('图片回复'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('图画好之后正文由主模型再写一次：第二段只带回复工具，历史存正文', async () => {
    const requests: LlmRequest[] = [];
    let turn = 0;
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider(
          'openai-compat',
          async () => {
            turn += 1;
            return turn === 1
              ? { text: '', toolCalls: [{ name: 'draw_image', arguments: DRAW_ARGS }] }
              : {
                  text: '',
                  toolCalls: [
                    { name: 'story_reply', arguments: JSON.stringify({ game_content: '画好啦，橘猫在窗台上晒太阳。' }) },
                  ],
                };
          },
          { onRequest: (req) => requests.push(req) },
        ),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat', { baseUrl: 'https://relay.test/pg/v1' }) },
      routes: { global: ROUTE },
      prompts: { global: { segments: [segment('main', DRAW_PRESET)] } },
      channelMemory: memoryConfig({ contextTool: true }),
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await createChatService(harness.deps).run(CTX);
      expect(result.text).toBe('画好啦，橘猫在窗台上晒太阳。');
      expect(result.image?.mime).toBe('image/jpeg');
      expect(harness.appendCalls[0]?.messages[1]?.content).toBe('画好啦，橘猫在窗台上晒太阳。');
      expect(requests).toHaveLength(2);
      expect(requests[1]?.tools?.map((tool) => tool.function.name)).toEqual(['story_reply']);
      expect(String(requests[1]?.messages.at(-1)?.content)).toContain('已经发给用户了');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('预设没点名 draw_image：工具表仍是原来两条，一次图都不生', async () => {
    const PRESET = '你是示例角色。每次回复都调用 story_reply，把正文放进 content。';
    const harness = makeHarness({
      providers: {
        'openai-compat': toolProvider('openai-compat', {
          text: '',
          toolCalls: [{ name: 'story_reply', arguments: JSON.stringify({ game_content: '正文' }) }],
        }),
      },
      keys: { 'openai-compat': decryptedKey('openai-compat') },
      routes: { global: ROUTE },
      prompts: { global: { segments: [segment('main', PRESET)] } },
      channelMemory: memoryConfig({ contextTool: true }),
    });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await createChatService(harness.deps).run(CTX);
      expect(result.text).toBe('正文');
      expect(result.image).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
