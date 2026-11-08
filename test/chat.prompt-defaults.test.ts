import { describe, expect, it } from 'vitest';
import { buildIdentityBlock, createChatService, renderReactionGuide } from '../src/core/chat/service';
import { renderMentionRule } from '../src/core/chat/mention-dedupe';
import type { ChatServiceDeps } from '../src/core/chat/service';
import { DEFAULT_REACTION_GUIDE } from '../src/core/chat/reaction-guide';
import type { PromptDefaultsStore } from '../src/core/ports';
import { DEFAULT_PROMPT } from '../src/core/prompt/resolver';
import { renderTemplate } from '../src/core/prompt/template';
import type {
  LlmChunk,
  LlmProvider,
  LlmRequest,
  PromptConfig,
  PromptDefaultEntry,
  PromptDefaultKey,
  PromptDefaultsScope,
  PromptSegment,
  ProviderRuntime,
  Scope,
  TurnContext,
} from '../src/core/types';

const CTX: TurnContext = {
  guildId: 'g1',
  channelId: 'c1',
  userId: '150000000000000001',
  userName: '小明',
  guildName: '示例服务器',
  channelName: '闲聊2',
  botName: '示例机器人',
  userText: '在吗',
};

const UPDATED_AT = '2026-10-25T00:00:00.000Z';

function entryOf(
  key: PromptDefaultKey,
  scope: Scope,
  scopeId: string,
  content: string | undefined,
): PromptDefaultEntry | null {
  return content === undefined ? null : { key, scope, scopeId, content, updatedAt: UPDATED_AT };
}

/** 三层里某一层的配置；写哪个 key 就只有哪个 key 有行 */
interface LayerConfig {
  fallback?: string;
  identity?: string;
}

type LayersConfig = { channel?: LayerConfig; guild?: LayerConfig; global?: LayerConfig };

/** 内存版的兜底文案库：按 (scope, scopeId) 各给一层，只实现读 */
function storeOf(layers: LayersConfig, calls?: Array<{ scope: Scope; scopeId: string }>): PromptDefaultsStore {
  return {
    get: async ({ scope, scopeId }): Promise<PromptDefaultsScope> => {
      calls?.push({ scope, scopeId });
      const layer = layers[scope] ?? {};
      return {
        fallback: entryOf('fallback', scope, scopeId, layer.fallback),
        identity: entryOf('identity', scope, scopeId, layer.identity),
      };
    },
    list: async () => [],
    put: async () => {
      throw new Error('不该写兜底文案');
    },
    remove: async () => undefined,
  };
}

function segment(id: string, content: string, extra: Partial<PromptSegment> = {}): PromptSegment {
  return { id, name: id, role: 'system', content, enabled: true, placement: 'before', position: 0, ...extra };
}

interface HarnessOptions {
  prompts?: PromptConfig | null;
  promptDefaults?: PromptDefaultsStore;
}

function makeHarness(options: HarnessOptions = {}) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    id: 'openai-compat',
    chat: async () => ({ text: 'ok' }),
    listModels: async () => [],
    chatStream(req: LlmRequest, _rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      requests.push(req);
      return (async function* () {
        yield { delta: 'ok', finishReason: 'stop' };
      })();
    },
  };
  const deps: ChatServiceDeps = {
    prompts: {
      get: async () => options.prompts ?? null,
      list: async () => [],
      put: async () => undefined,
      remove: async () => undefined,
    },
    routes: {
      get: async () => ({ primary: { provider: 'openai-compat', model: 'm' }, fallbacks: [] }),
      list: async () => [],
      put: async () => undefined,
      remove: async () => undefined,
    },
    keys: {
      list: async () => [],
      listEnabled: async () => [{ id: 'k', provider: 'openai-compat', label: 'k', apiKey: 'sk-x', models: [] }],
      getDecrypted: async () => null,
      create: async () => {
        throw new Error('不该建 key');
      },
      remove: async () => undefined,
    },
    conversations: {
      loadRecent: async () => [],
      loadAll: async () => [],
      append: async () => undefined,
      clear: async () => undefined,
      loadAfter: async () => [],
      loadLatest: async () => [],
      loadBetween: async () => [],
    },
    summaries: {
      get: async () => null,
      list: async () => [],
      put: async () => undefined,
      remove: async () => undefined,
    },
    providers: { 'openai-compat': provider, anthropic: provider, gemini: provider },
    config: {},
  };
  if (options.promptDefaults !== undefined) deps.promptDefaults = options.promptDefaults;
  return { deps, requests };
}

/** 今天这段 system：预设段 + @ 规则 + 表情规则（有预设段时不追加身份块，§52） */
function todaySystem(ctx: TurnContext = CTX): string {
  const rendered = renderTemplate(DEFAULT_PROMPT.segments[0]?.content ?? '', {
    bot_name: ctx.botName,
    user_name: ctx.userName,
    guild_name: ctx.guildName,
    channel_name: ctx.channelName,
    date: newDate(),
  });
  return rendered + '\n\n' + renderMentionRule() + renderReactionGuide(DEFAULT_REACTION_GUIDE);
}

function newDate(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('run 兜底文案分层', () => {
  it('三层全空 + 全局配了 fallback：system 用这份正文（变量照常渲染）', async () => {
    const today = newDate();
    const { deps, requests } = makeHarness({
      promptDefaults: storeOf({ global: { fallback: '你是 {{bot_name}}，今天是 {{date}}。' } }),
    });

    await createChatService(deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('你是 示例机器人，今天是 ' + today + '。');
    // 配了就不该再出现代码里的内置提示词
    expect(system).not.toContain('礼貌、简洁的中文助手');
  });

  it('三层全空：system 与升级前逐字相同', async () => {
    const { deps, requests } = makeHarness({ promptDefaults: storeOf({}) });

    await createChatService(deps).run(CTX);

    expect(requests[0]?.system).toBe(todaySystem());
  });

  it('没接线 promptDefaults：system 也与今天逐字相同', async () => {
    const { deps, requests } = makeHarness();

    await createChatService(deps).run(CTX);

    expect(requests[0]?.system).toBe(todaySystem());
  });

  it('三层里有值时照旧整组覆盖：配了 fallback 也不参与', async () => {
    const { deps, requests } = makeHarness({
      prompts: { segments: [segment('g', '公会层正文')] },
      promptDefaults: storeOf({ global: { fallback: '兜底正文不该出现' } }),
    });

    await createChatService(deps).run(CTX);

    expect(requests[0]?.system).toBe(
      '公会层正文' + '\n\n' + renderMentionRule() + renderReactionGuide(DEFAULT_REACTION_GUIDE),
    );
    expect(requests[0]?.system).not.toContain('兜底正文不该出现');
  });

  it('频道层优先于服务器层：两处都配了 fallback 时用频道层', async () => {
    const { deps, requests } = makeHarness({
      promptDefaults: storeOf({
        channel: { fallback: '频道兜底 {{bot_name}}' },
        guild: { fallback: '服务器兜底 {{bot_name}}' },
        global: { fallback: '全局兜底 {{bot_name}}' },
      }),
    });

    await createChatService(deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('频道兜底 示例机器人');
    expect(system).not.toContain('服务器兜底');
    expect(system).not.toContain('全局兜底');
  });

  it('频道层含未知变量时跳过频道层，落到服务器层', async () => {
    const { deps, requests } = makeHarness({
      promptDefaults: storeOf({
        channel: { fallback: '频道兜底 {{nickname}}' },
        guild: { fallback: '服务器兜底 {{bot_name}}' },
      }),
    });

    await createChatService(deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('服务器兜底 示例机器人');
    expect(system).not.toContain('频道兜底');
  });

  it('频道层全空白时同样跳过，落到服务器层', async () => {
    const { deps, requests } = makeHarness({
      promptDefaults: storeOf({ channel: { fallback: '   \n  ' }, guild: { fallback: '服务器兜底' } }),
    });

    await createChatService(deps).run(CTX);

    expect(requests[0]?.system).toContain('服务器兜底');
  });

  it('读兜底文案失败：按没配继续，回复不受影响', async () => {
    const { deps, requests } = makeHarness({
      promptDefaults: {
        get: async () => {
          throw new Error('D1 down');
        },
        list: async () => [],
        put: async () => {
          throw new Error('不该写兜底文案');
        },
        remove: async () => undefined,
      },
    });

    const result = await createChatService(deps).run(CTX);

    expect(result.text).toBe('ok');
    expect(requests[0]?.system).toBe(todaySystem());
  });

  it('只坏一层：坏掉的层当没配，别的层照常生效', async () => {
    const { deps, requests } = makeHarness({
      prompts: { segments: [] },
      promptDefaults: {
        get: async ({ scope, scopeId }) => {
          if (scope === 'guild') throw new Error('D1 down');
          const content = scope === 'channel' ? '【当前对话】\n和你说话的是 {{user_name}}\n频道层' : undefined;
          return {
            fallback: null,
            identity: entryOf('identity', scope, scopeId, content),
          };
        },
        list: async () => [],
        put: async () => {
          throw new Error('不该写兜底文案');
        },
        remove: async () => undefined,
      },
    });

    const result = await createChatService(deps).run(CTX);

    expect(result.text).toBe('ok');
    const system = requests[0]?.system ?? '';
    expect(system).toContain('【当前对话】\n和你说话的是 小明\n频道层');
    expect(system).not.toContain('服务器：示例服务器');
  });

  it('三条 SELECT 各按自己那层的 scopeId 发', async () => {
    const calls: Array<{ scope: Scope; scopeId: string }> = [];
    const { deps } = makeHarness({ promptDefaults: storeOf({}, calls) });

    await createChatService(deps).run(CTX);

    expect(calls).toEqual([
      { scope: 'channel', scopeId: CTX.channelId },
      { scope: 'guild', scopeId: CTX.guildId },
      { scope: 'global', scopeId: '' },
    ]);
  });
});

describe('run 身份块（只在没有预设段时兜底）', () => {
  it('有预设段时整段不出现：三层身份块都不进 system', async () => {
    const { deps, requests } = makeHarness({
      promptDefaults: storeOf({
        channel: { identity: '【当前对话】\n频道层 和你说话的是 {{user_name}}' },
        guild: { identity: '【当前对话】\n服务器层 和你说话的是 {{user_name}}' },
        global: { identity: '【当前对话】\n全局层 和你说话的是 {{user_name}}' },
      }),
    });

    await createChatService(deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).not.toContain('【当前对话】');
    expect(system).not.toContain('频道层');
    expect(system).not.toContain('服务器层');
    expect(system).not.toContain('全局层');
    expect(system.startsWith('你是 示例机器人，一个礼貌、简洁的中文助手')).toBe(true);
  });

  it('预设段为空时照旧分层：频道层优先于服务器层与全局层', async () => {
    const { deps, requests } = makeHarness({
      prompts: { segments: [] },
      promptDefaults: storeOf({
        channel: { identity: '【当前对话】\n频道层 和你说话的是 {{user_name}}' },
        guild: { identity: '【当前对话】\n服务器层 和你说话的是 {{user_name}}' },
        global: { identity: '【当前对话】\n全局层 和你说话的是 {{user_name}}' },
      }),
    });

    await createChatService(deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('【当前对话】\n频道层 和你说话的是 小明');
    expect(system).not.toContain('服务器层');
    expect(system).not.toContain('全局层');
  });

  it('预设段为空时：频道层没配用服务器层，服务器层也没有才用全局层', async () => {
    const guildOnly = makeHarness({
      prompts: { segments: [] },
      promptDefaults: storeOf({ guild: { identity: '【当前对话】\n和你说话的是 {{user_name}}\n服务器层' } }),
    });
    await createChatService(guildOnly.deps).run(CTX);
    expect(guildOnly.requests[0]?.system).toContain('【当前对话】\n和你说话的是 小明\n服务器层');

    const globalOnly = makeHarness({
      prompts: { segments: [] },
      promptDefaults: storeOf({ global: { identity: '【当前对话】\n和你说话的是 {{user_name}}\n全局层' } }),
    });
    await createChatService(globalOnly.deps).run(CTX);
    expect(globalOnly.requests[0]?.system).toContain('【当前对话】\n和你说话的是 小明\n全局层');
  });

  it('预设段为空且配了 identity：system 里换成自定义块，代码块整段不出现', async () => {
    const { deps, requests } = makeHarness({
      prompts: { segments: [] },
      promptDefaults: storeOf({
        global: { identity: '【当前对话】\n和你说话的是 {{user_name}}\nDiscord ID：{{user_id}}' },
      }),
    });

    await createChatService(deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(system).toContain('【当前对话】\n和你说话的是 小明\nDiscord ID：150000000000000001');
    expect(system).not.toContain('服务器：示例服务器');
    expect(system).not.toContain('；频道：#闲聊2');
  });

  it('只配了收尾段（没有前置段）且没配 identity：身份块照旧兜底，排在收尾段前面', async () => {
    const today = newDate();
    const { deps, requests } = makeHarness({
      prompts: { segments: [segment('a', '收尾补充', { placement: 'after' })] },
      promptDefaults: storeOf({}),
    });

    await createChatService(deps).run(CTX);

    const system = requests[0]?.system ?? '';
    expect(
      system.startsWith(
        buildIdentityBlock(CTX, today).replace(/^\n+/, '') + renderMentionRule() + renderReactionGuide(DEFAULT_REACTION_GUIDE),
      ),
    ).toBe(true);
    expect(system.endsWith('\n\n收尾补充')).toBe(true);
    expect(system).toContain('【当前对话】和你说话的是 小明（ID 150000000000000001）；这里：示例服务器 · 闲聊2；今天 ' + today + '。');
  });

  it('预设段为空时模板里变量为空的行整行丢掉，其余行照常出现', async () => {
    const today = newDate();
    const { deps, requests } = makeHarness({
      prompts: { segments: [] },
      promptDefaults: storeOf({ global: { identity: '【当前对话】\n和你说话的是 {{user_name}}\n今天 {{date}}' } }),
    });

    await createChatService(deps).run({ ...CTX, userName: '' });

    const system = requests[0]?.system ?? '';
    expect(system).toContain('【当前对话】\n今天 ' + today);
    expect(system).not.toContain('和你说话的是');
  });
});
