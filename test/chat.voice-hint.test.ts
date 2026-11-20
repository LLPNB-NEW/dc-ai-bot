/**
 * 语音提示段：只有「按指令」模式（mode 1）才出现，教模型写 [[voice]]。
 *
 * 缺口背景：三层开关与 [[voice]] 的解析早就有了，但提示词里从来没教过这种写法，
 * 模型不可能自己猜到，mode 1 因此永远不可能触发。这与表情规则块（renderReactionGuide）
 * 的来历完全一样：只有开关/清单不够，得把写法说给模型听。
 */
import { describe, expect, it } from 'vitest';
import { CONTEXT_TOOL_SYSTEM } from '../src/core/chat/context-tool';
import { createChatService, renderVoiceHint } from '../src/core/chat/service';
import type { ChatServiceDeps } from '../src/core/chat/service';
import type {
  ChatMessage,
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

const PRIMARY = { provider: 'openai-compat', model: 'gpt-4o-mini' } as const;
const ROUTE: RouteConfig = { primary: PRIMARY, fallbacks: [] };

/** 固定文案：模型靠这一句学会写法，正文一个字都不许漂 */
const VOICE_HINT =
  '\n\n【语音】\n想让这条回复被念出来，就在正文里单独写一行 [[voice]]；不念就不要写。这一行不会显示给对方。';

function decryptedKey(provider: ProviderId): DecryptedKey {
  return { id: 'k-' + provider, provider, label: provider, apiKey: 'sk-' + provider, models: [] };
}

function streamProvider(deltas: string[], requests: LlmRequest[]): LlmProvider {
  return {
    id: 'openai-compat',
    async chat() {
      throw new Error('流式路径不应调用 chat()');
    },
    async listModels() {
      return [];
    },
    chatStream(req: LlmRequest, _rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      requests.push(req);
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

function unusedProvider(id: ProviderId, reason: string): LlmProvider {
  const fail = (): never => {
    throw new Error(reason);
  };
  return {
    id,
    async chat() {
      return fail();
    },
    async listModels() {
      return [];
    },
    chatStream(): AsyncIterable<LlmChunk> {
      return (async function* () {
        fail();
      })();
    },
  };
}

/** 上下文工具模式只在频道记忆行显式点名时进入（§55）；这里按需装一份最小行 */
const CONTEXT_ROW = {
  guildId: 'g1',
  channelId: 'c1',
  historyMaxMessages: 50,
  summaryEveryMessages: 50,
  contextTool: true,
  updatedAt: '2026-10-25T03:00:00.000Z',
};

/** 预设只有一段时，它就是描述体/legacy system 里的第一段正文 */
function presetOf(content: string) {
  return {
    segments: [
      {
        id: 's1',
        name: '人设',
        role: 'system' as const,
        content,
        enabled: true,
        placement: 'before' as const,
        position: 0,
      },
    ],
  };
}

function makeHarness(
  contextTool = false,
  presetText?: string,
): { deps: ChatServiceDeps; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const state: ChatMessage[] = [];
  const deps: ChatServiceDeps = {
    prompts: {
      async get() {
        return presetText === undefined ? null : presetOf(presetText);
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
    providers: {
      'openai-compat': streamProvider(['好的'], requests),
      anthropic: unusedProvider('anthropic', '未被选中的 provider 不应被调用'),
      gemini: unusedProvider('gemini', '没有表情模型，不该有第二次调用'),
    },
    config: {},
    ...(contextTool
      ? {
          channelMemory: {
            async get() {
              return CONTEXT_ROW;
            },
            async list() {
              return [CONTEXT_ROW];
            },
            async put(cfg: typeof CONTEXT_ROW) {
              return cfg;
            },
            async remove() {},
          },
        }
      : {}),
  };
  return { deps, requests };
}

async function systemFor(ctx: TurnContext, contextTool = false, presetText?: string): Promise<string> {
  const harness = makeHarness(contextTool, presetText);
  const service = createChatService(harness.deps);
  await service.run(ctx);
  expect(harness.requests).toHaveLength(1);
  return harness.requests[0]?.system ?? '';
}

describe('renderVoiceHint 渲染', () => {
  it('为真时是以两个换行开头的固定文案块：标题行 + 正文', () => {
    expect(renderVoiceHint(true)).toBe(VOICE_HINT);
    expect(renderVoiceHint(true).startsWith('\n\n')).toBe(true);
    expect(renderVoiceHint(true)).toContain('【语音】');
    expect(renderVoiceHint(true)).toContain('[[voice]]');
  });

  it('false 与 undefined 都返回空串：其余模式下 system 与前一版逐字相同', () => {
    expect(renderVoiceHint(false)).toBe('');
    expect(renderVoiceHint(undefined)).toBe('');
  });
});

describe('voiceHint 决定 system 里有没有【语音】段', () => {
  it('voiceHint: true → system 里教模型写 [[voice]]', async () => {
    const system = await systemFor({ ...CTX, voiceHint: true });

    expect(system).toContain('【语音】');
    expect(system).toContain('[[voice]]');
    expect(system).toContain(VOICE_HINT);
  });

  it('缺省（不传字段）→ 整段不出现，只有【表情】那一段照旧', async () => {
    const system = await systemFor(CTX);

    expect(system).not.toContain('【语音】');
    expect(system).not.toContain('[[voice]]');
    expect(system).toContain('【表情】');
  });

  it('显式 false 与缺省逐字相同：连空行都不多一个', async () => {
    const absent = await systemFor(CTX);
    const explicit = await systemFor({ ...CTX, voiceHint: false });

    expect(explicit).toBe(absent);
  });

  it('§55 上下文工具模式：system 换成固定那份，【语音】段照旧接在末尾', async () => {
    const system = await systemFor({ ...CTX, voiceHint: true }, true);

    expect(system).toBe(CONTEXT_TOOL_SYSTEM + VOICE_HINT);
  });

  it('§55 上下文工具模式、没有语音提示时：system 与固定那份逐字相同', async () => {
    const system = await systemFor(CTX, true);

    expect(system).toBe(CONTEXT_TOOL_SYSTEM);
  });

  it('位置在表情规则块之后、自定义表情清单之前', async () => {
    const system = await systemFor({ ...CTX, voiceHint: true, customEmojis: [{ name: 'cat', id: '1' }] });

    expect(system.indexOf('【语音】')).toBeGreaterThan(system.indexOf('【表情】'));
    expect(system.indexOf('【可用自定义表情】')).toBeGreaterThan(system.indexOf('【语音】'));
  });
});

describe('预设优先：预设里写过 [[voice]] 就不再追加代码那段', () => {
  it('上下文模式下预设已提到 → system 回到固定那份，不重复', async () => {
    const system = await systemFor({ ...CTX, voiceHint: true }, true, '想说话就单独写一行 [[voice]]。');

    expect(system).toBe(CONTEXT_TOOL_SYSTEM);
  });

  it('普通模式下预设已提到 → 不追加【语音】段，预设正文照旧在', async () => {
    const preset = '想说话就单独写一行 [[voice]]。';
    const system = await systemFor({ ...CTX, voiceHint: true }, false, preset);

    expect(system).toContain(preset);
    expect(system).not.toContain('【语音】');
  });

  it('预设提到但模式没开：也照样不加（提示归预设管）', async () => {
    const system = await systemFor(CTX, true, '要念就写 [[voice]]');

    expect(system).toBe(CONTEXT_TOOL_SYSTEM);
  });
});
