import { describe, expect, it } from 'vitest';
import { createChatService } from '../src/core/chat/service';
import type { ChatServiceDeps } from '../src/core/chat/service';
import { renderMentionRule } from '../src/core/chat/mention-dedupe';
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
  TurnResult,
} from '../src/core/types';

/** 真实的 Discord snowflake 是 15~20 位数字，提及正则只认这个区间，用例里的 id 也必须是数字 */
const U1 = '111111111111111111';
const U2 = '222222222222222222';
const U3 = '333333333333333333';
const U9 = '999999999999999999';

/** 聊天记录里出现过的名字：正文里该写的就是这几个字 */
const U1_NAME = '阿天';
const U2_NAME = '小乙';
const U3_NAME = '老丙';

const PRIMARY = { provider: 'openai-compat', model: 'gpt-4o-mini' } as const;
const ROUTE: RouteConfig = { primary: PRIMARY, fallbacks: [] };
const FIXED_NOW = '2026-10-25T03:00:00.000Z';

/** 一条真实的提及标签 */
const tag = (id: string): string => '<@' + id + '>';

const CHANNEL_CTX: TurnContext = {
  guildId: 'g1',
  channelId: 'c1',
  userId: U1,
  userName: U1_NAME,
  guildName: '测试公会',
  channelName: '测试频道',
  botName: '小助手',
  userText: '你好',
};

/** 私聊：没有服务器频道，网关不加开头前缀，也没有「已经 @ 过」这回事 */
const DM_CTX: TurnContext = {
  ...CHANNEL_CTX,
  guildId: '',
  channelId: 'dm-1',
  guildName: '',
  channelName: '',
};

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

function failingProvider(id: ProviderId): LlmProvider {
  return {
    id,
    async chat() {
      throw new Error('未被选中的 provider 不应被调用');
    },
    async listModels() {
      return [];
    },
    chatStream(): AsyncIterable<LlmChunk> {
      return (async function* () {
        throw new Error('未被选中的 provider 不应被调用');
      })();
    },
  };
}

interface Harness {
  deps: ChatServiceDeps;
  requests: LlmRequest[];
  /** 进度事件收到的文本序列：用户先看到的就是这些 */
  progress: string[];
}

function makeHarness(input: { deltas: string[]; history?: ChatMessage[] }): Harness {
  const requests: LlmRequest[] = [];
  const progress: string[] = [];
  const state: ChatMessage[] = [...(input.history ?? [])];

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
        throw new Error('用例不该建 Key');
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
    providers: {
      'openai-compat': streamProvider(input.deltas, requests),
      anthropic: failingProvider('anthropic'),
      gemini: failingProvider('gemini'),
    },
    now: () => new Date(FIXED_NOW),
    config: {},
  };

  return { deps, requests, progress };
}

async function runTurn(harness: Harness, ctx: TurnContext): Promise<TurnResult> {
  const service = createChatService(harness.deps);
  return service.run(ctx, {
    onProgress(text) {
      harness.progress.push(text);
    },
  });
}

describe('一轮回复里同一个人只 @ 一次（服务器频道）', () => {
  it('重复写同一个 <@id>：正文与进度里都只留第一次，第二次换成聊天记录里的名字', async () => {
    const harness = makeHarness({
      // 分块吐：每一帧进度都拿全量累积文本重算一次，第二处一出现就该被换掉
      deltas: [tag(U2) + ' 甲 ', tag(U2), ' 乙。'],
      history: [{ role: 'user', content: '我是小乙', author: U2_NAME, authorId: U2, createdAt: FIXED_NOW }],
    });

    const result = await runTurn(harness, CHANNEL_CTX);

    // 她写了两遍 <@U2>，用户最终只看到一个，第二次变成名字
    expect(result.text).toBe(tag(U2) + ' 甲 ' + U2_NAME + ' 乙。');
    expect(result.text.split(tag(U2))).toHaveLength(2);
    expect(result.text).not.toContain('@' + U2_NAME);
    // 进度侧走的是同一份判定：没有任何一帧会出现两个标签
    for (const item of harness.progress) {
      expect(item.split(tag(U2)).length - 1).toBeLessThanOrEqual(1);
    }
    expect(harness.progress.at(-1)).toBe(result.text);
  });

  it('开头已经 @ 过提问的人：正文里连第一处也换成名字，一个标签都不剩', async () => {
    const harness = makeHarness({ deltas: [tag(U1) + ' 你好 ' + tag(U1) + '。'] });

    const result = await runTurn(harness, CHANNEL_CTX);

    expect(result.text).toBe(U1_NAME + ' 你好 ' + U1_NAME + '。');
    expect(result.text).not.toContain('<@');
  });

  it('名字查不到就整段删标签，不留双空格与标点前的空格', async () => {
    const harness = makeHarness({ deltas: [tag(U2) + ' 甲 ' + tag(U2) + ' ，'] });

    const result = await runTurn(harness, CHANNEL_CTX);

    expect(result.text).toBe(tag(U2) + ' 甲，');
  });

  it('名字只在很早以前的历史里（注入窗口之外）：仍然换成名字', async () => {
    // 61 条历史 → 那条「我是老丙」早被挤出最近 50 条的注入窗口
    const old: ChatMessage = { role: 'user', content: '我是老丙', author: U3_NAME, authorId: U3, createdAt: FIXED_NOW };
    const filler: ChatMessage[] = Array.from({ length: 60 }, (_item, index) => ({
      role: 'user' as const,
      content: '垫话' + index,
      author: '路人' + index,
      authorId: String(100000000000000000 + index),
      createdAt: FIXED_NOW,
    }));
    const harness = makeHarness({ deltas: [tag(U3) + ' 甲 ' + tag(U3) + '。'], history: [old, ...filler] });

    const result = await runTurn(harness, CHANNEL_CTX);

    const promptText = (harness.requests[0]?.messages ?? []).map((message) => message.content).join('\n');
    expect(promptText).not.toContain('我是老丙');
    expect(result.text).toBe(tag(U3) + ' 甲 ' + U3_NAME + '。');
  });
});

describe('私聊：与今天逐字一致', () => {
  it('私聊不去重、system 里也没有提及规则块', async () => {
    const harness = makeHarness({ deltas: [tag(U9) + ' 甲 ' + tag(U9) + '。'] });

    const result = await runTurn(harness, DM_CTX);

    // 私聊不加开头前缀，也就没有「已经 @ 过」的种子：正文原样，两个标签都在
    expect(result.text).toBe(tag(U9) + ' 甲 ' + tag(U9) + '。');
    const system = harness.requests[0]?.system ?? '';
    expect(system).not.toContain('同一个人最多 @ 一次');
    expect(system).not.toContain('【提及】');
  });
});

describe('system 里的提及规则', () => {
  it('服务器频道：system 带上这条规则，且排在表情规则块之前', async () => {
    const harness = makeHarness({ deltas: ['好的'] });

    await runTurn(harness, CHANNEL_CTX);

    const system = harness.requests[0]?.system ?? '';
    const rule = renderMentionRule().trim();
    expect(system).toContain('同一个人最多 @ 一次');
    expect(system).toContain(rule);
    // 提及与「怎么回话」同属正文纪律：粘在表情规则前面，而不是挂在 system 最末
    expect(system.indexOf(rule)).toBeLessThan(system.indexOf('【表情】'));
  });

  it('私聊：同一条 system 里一个提及字样都没有', async () => {
    const harness = makeHarness({ deltas: ['好的'] });

    await runTurn(harness, DM_CTX);

    const system = harness.requests[0]?.system ?? '';
    expect(system).not.toContain(renderMentionRule().trim());
    expect(system).not.toContain('【提及】');
  });
});
