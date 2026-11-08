import { describe, expect, it } from 'vitest';
import { buildIdentityBlock, createChatService } from '../src/core/chat/service';
import type { ChatServiceDeps } from '../src/core/chat/service';
import type { LlmChunk, LlmProvider, LlmRequest, ProviderRuntime, TurnContext } from '../src/core/types';

const DATE = '2026-10-25';

const CHANNEL_CTX: TurnContext = {
  guildId: 'g1',
  channelId: 'c1',
  userId: '150000000000000001',
  userName: '小明',
  guildName: '示例服务器',
  channelName: '闲聊2',
  botName: '示例机器人',
  userText: '在吗',
};

const DM_CTX: TurnContext = {
  ...CHANNEL_CTX,
  guildId: '',
  channelId: 'dm-1',
  guildName: '',
  channelName: '',
};

describe('buildIdentityBlock', () => {
  it('频道场景：用户 + id + 服务器 + 频道 + 日期，一段话拼接', () => {
    expect(buildIdentityBlock(CHANNEL_CTX, DATE)).toBe(
      '\n\n【当前对话】和你说话的是 小明（ID 150000000000000001）；这里：示例服务器 · 闲聊2；今天 2026-10-25。',
    );
  });

  it('私聊场景：服务器与频道两项整段省略，不留空壳', () => {
    const block = buildIdentityBlock(DM_CTX, DATE);
    expect(block).toBe('\n\n【当前对话】和你说话的是 小明（ID 150000000000000001）；今天 2026-10-25。');
    expect(block).not.toContain('服务器：');
    expect(block).not.toContain('频道：');
    expect(block).not.toContain('#');
  });

  it('只有服务器名时只省略频道段', () => {
    const block = buildIdentityBlock({ ...CHANNEL_CTX, channelName: '  ' }, DATE);
    expect(block).toContain('这里：示例服务器');
    expect(block).not.toContain('频道：');
  });

  it('user_name 缺失时整块不追加', () => {
    expect(buildIdentityBlock({ ...CHANNEL_CTX, userName: '' }, DATE)).toBe('');
    expect(buildIdentityBlock({ ...CHANNEL_CTX, userName: '   ' }, DATE)).toBe('');
  });

  it('user_id 缺失时省略括号但仍保留身份', () => {
    expect(buildIdentityBlock({ ...CHANNEL_CTX, userId: '' }, DATE)).toContain('和你说话的是 小明；这里：');
  });

  it('日期缺失时省略「今天」', () => {
    expect(buildIdentityBlock(CHANNEL_CTX, '')).toBe(
      '\n\n【当前对话】和你说话的是 小明（ID 150000000000000001）；这里：示例服务器 · 闲聊2。',
    );
  });

  it('身份块跟在预设段之后（不看 {{user_name}} 是否被用到）', async () => {
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
        get: async () => ({
          segments: [
            {
              id: 'fixed',
              name: '基本设定',
              role: 'system',
              content: '你是写死名字的示例角色',
              enabled: true,
              placement: 'before',
              position: 0,
            },
          ],
        }),
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
    await createChatService(deps).run(CHANNEL_CTX);
    const system = requests[0]?.system ?? '';
    // 有预设段时身份块整段不出现（§52）：角色卡自己交代了「我是谁、这是谁在说话」
    expect(system.startsWith('你是写死名字的示例角色')).toBe(true);
    expect(system).not.toContain('【当前对话】');
    expect(system).not.toContain('这里：示例服务器 · 闲聊2');
  });
});
