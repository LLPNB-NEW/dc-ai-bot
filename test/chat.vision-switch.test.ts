import { describe, expect, it } from 'vitest';
import { createChatService } from '../src/core/chat/service';
import type { ChatServiceDeps } from '../src/core/chat/service';
import type { ReactionModelStore } from '../src/core/ports';
import type {
  ChatMessage,
  DecryptedKey,
  LlmChunk,
  LlmImage,
  LlmProvider,
  LlmRequest,
  LogEntry,
  ProviderId,
  ProviderRuntime,
  ReactionModelConfig,
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

const PRIMARY = { provider: 'openai-compat', model: 'gpt-4o-mini' } as const;
const ROUTE: RouteConfig = { primary: PRIMARY, fallbacks: [] };

const FIXED_NOW = '2026-10-25T03:00:00.000Z';

const IMAGES: LlmImage[] = [
  { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
  { mediaType: 'image/jpeg', base64: '/9j/4AAQ' },
];

const REACTION_CFG: ReactionModelConfig = { enabled: true, provider: 'gemini', model: 'gemini-2.0-flash' };

function decryptedKey(provider: ProviderId): DecryptedKey {
  return { id: `k-${provider}`, provider, label: provider, apiKey: `sk-${provider}`, models: [] };
}

function streamProvider(
  id: ProviderId,
  deltas: string[],
  hooks?: { onRequest?: (req: LlmRequest) => void },
): LlmProvider {
  return {
    id,
    async chat() {
      throw new Error('流式路径不应调用 chat()');
    },
    async listModels() {
      return [];
    },
    chatStream(req: LlmRequest, _rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      hooks?.onRequest?.(req);
      return (async function* () {
        for (let index = 0; index < deltas.length; index += 1) {
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
    async chat() {
      throw new Error(message);
    },
    async listModels() {
      return [];
    },
    chatStream(): AsyncIterable<LlmChunk> {
      return (async function* () {
        throw new Error(message);
      })();
    },
  };
}

function reactionStore(cfg: ReactionModelConfig | null): ReactionModelStore {
  return {
    async get() {
      return cfg;
    },
    async put() {
      throw new Error('测试不该写表情配置');
    },
  };
}

/** 表情模型的假 provider：只该被非流式 chat() 问到 */
function reactionProvider(answer: string, chats: LlmRequest[]): LlmProvider {
  return {
    id: 'gemini',
    async chat(req: LlmRequest) {
      chats.push(req);
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

/** 会记账的假 loader（§41）：断言「关掉时一次都不下载」靠它 */
function countingLoader(state: { calls: number }): () => Promise<LlmImage[]> {
  return async () => {
    state.calls += 1;
    return IMAGES;
  };
}

function throwingLoader(state: { calls: number }): () => Promise<LlmImage[]> {
  return async () => {
    state.calls += 1;
    throw new Error('图片下载挂了');
  };
}

interface Harness {
  deps: ChatServiceDeps;
  /** 主对话（流式）收到的每一次请求 */
  requests: LlmRequest[];
  /** 表情模型（非流式）收到的每一次请求 */
  reactionChats: LlmRequest[];
  logEntries: LogEntry[];
}

function makeHarness(input: {
  deltas: string[];
  /** 'on' = 表情模型启用；'off' = 未启用；'missing' = 没接线（老调用方的行为） */
  reaction?: 'on' | 'off' | 'missing';
}): Harness {
  const requests: LlmRequest[] = [];
  const reactionChats: LlmRequest[] = [];
  const logEntries: LogEntry[] = [];
  const state: ChatMessage[] = [];

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
      async get() {
        return ROUTE;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    keys: {
      async listEnabled(provider) {
        return [decryptedKey(provider)];
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
      async append(_key, messages) {
        state.push(...messages);
      },
      async clear() {},
      async loadAfter() {
        return [];
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
    ...(input.reaction === 'on'
      ? { reactionModels: reactionStore(REACTION_CFG) }
      : input.reaction === 'off'
        ? { reactionModels: reactionStore({ ...REACTION_CFG, enabled: false }) }
        : {}),
    providers: {
      'openai-compat': streamProvider('openai-compat', input.deltas, {
        onRequest: (req) => requests.push(req),
      }),
      anthropic: failingProvider('anthropic', '未被选中的 provider 不应被调用'),
      gemini: input.reaction === 'on' ? reactionProvider('[[react:🔥]]', reactionChats) : failingProvider('gemini', '表情模型不该被调用'),
    },
    now: () => new Date(FIXED_NOW),
    log(entry) {
      logEntries.push(entry);
    },
    config: {},
  };

  return { deps, requests, reactionChats, logEntries };
}

describe('主模型识图开关（§41）', () => {
  it('mainImages 缺省 → 主请求照旧带图（回归：不传这个字段等于开）', async () => {
    const state = { calls: 0 };
    const harness = makeHarness({ deltas: ['好的'] });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, loadImages: countingLoader(state) });

    expect(state.calls).toBe(1);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.images).toEqual(IMAGES);
    expect(result.text).toBe('好的');
  });

  it('mainImages=false → 主请求没有 images 键，表情请求仍带图，一轮只取一次图', async () => {
    const state = { calls: 0 };
    const harness = makeHarness({ deltas: ['好的', '[[react:👍]]'], reaction: 'on' });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true, mainImages: false, loadImages: countingLoader(state) });

    // 主对话这一轮一次都没取图，只有表情模型那一路取了一次
    expect(state.calls).toBe(1);
    // 主请求形状与「没有图」逐字相同：连 images 这个键都没有
    expect(harness.requests).toHaveLength(1);
    expect('images' in (harness.requests[0] as LlmRequest)).toBe(false);
    // 表情模型照旧看得到同一轮的图
    expect(harness.reactionChats).toHaveLength(1);
    expect(harness.reactionChats[0]?.images).toEqual(IMAGES);
    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
  });

  it('mainImages=false 且表情模型未启用 → 一次图都不下载', async () => {
    const state = { calls: 0 };
    const harness = makeHarness({ deltas: ['好的', '[[react:👍]]'], reaction: 'off' });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true, mainImages: false, loadImages: countingLoader(state) });

    expect(state.calls).toBe(0);
    expect('images' in (harness.requests[0] as LlmRequest)).toBe(false);
    expect(harness.reactionChats).toHaveLength(0);
    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('mainImages=false 且读图本身抛错 → 回复照常成功（读图失败绝不影响回复）', async () => {
    const state = { calls: 0 };
    const harness = makeHarness({ deltas: ['好的', '[[react:👍]]'], reaction: 'on' });
    const service = createChatService(harness.deps);

    const result = await service.run({ ...CTX, wantReactions: true, mainImages: false, loadImages: throwingLoader(state) });

    // 只有表情那一路真的去取了图，抛错在 memo 里被吞成空数组
    expect(state.calls).toBe(1);
    expect('images' in (harness.requests[0] as LlmRequest)).toBe(false);
    expect('images' in (harness.reactionChats[0] as LlmRequest)).toBe(false);
    expect(result.text).toBe('好的');
    expect(result.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
  });
});
