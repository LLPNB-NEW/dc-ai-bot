import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createChatService, withAuthorPrefix } from '../src/core/chat/service';
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
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const CTX: TurnContext = {
  guildId: 'g1',
  channelId: 'c1',
  userId: 'u-llp',
  userName: '小明',
  guildName: '示例服务器',
  channelName: '闲聊2',
  botName: '示例机器人',
  userText: '我也想看电影',
};

const KEY = { guildId: 'g1', channelId: 'c1' };
const ROUTE: RouteConfig = { primary: { provider: 'openai-compat', model: 'gpt-4o-mini' }, fallbacks: [] };

interface AuthorRow {
  role: string;
  content: string;
  author_name: string | null;
}

interface AuthorIdRow {
  role: string;
  content: string;
  user_id: string | null;
}

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

async function readAuthorRows(): Promise<AuthorRow[]> {
  // 显式列出列名，顺带钉住「读侧禁止 SELECT *」这条风格
  const { results } = await env.DB.prepare(
    'SELECT role, content, author_name FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY id ASC',
  )
    .bind(KEY.guildId, KEY.channelId)
    .all<AuthorRow>();
  return results ?? [];
}

async function readAuthorIdRows(): Promise<AuthorIdRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT role, content, user_id FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY id ASC',
  )
    .bind(KEY.guildId, KEY.channelId)
    .all<AuthorIdRow>();
  return results ?? [];
}

/** 模拟迁移前的老行：不写 author_name，让它落 NULL */
async function insertLegacyRow(role: string, content: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO messages (guild_id, channel_id, user_id, role, content, created_at) VALUES (?, ?, '', ?, ?, ?)",
  )
    .bind(KEY.guildId, KEY.channelId, role, content, new Date().toISOString())
    .run();
}

interface Harness {
  deps: ChatServiceDeps;
  requests: LlmRequest[];
}

function makeHarness(): Harness {
  const requests: LlmRequest[] = [];
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
        yield { delta: '收到', finishReason: 'stop' };
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

  const repos = makeRepos();
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
    // 真实 D1 存储：写入与读取两侧都走 d1-repository
    conversations: repos.conversations,
    summaries: repos.summaries,
    providers: {
      'openai-compat': provider,
      anthropic: unusedProvider('anthropic'),
      gemini: unusedProvider('gemini'),
    },
    config: {},
  };

  return { deps, requests };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM messages').run();
});

describe('withAuthorPrefix', () => {
  it('user 行拼成「名字：正文」，用全角冒号', () => {
    expect(withAuthorPrefix({ role: 'user', content: '在吗', author: '小明' })).toEqual({
      role: 'user',
      content: '小明：在吗',
    });
  });

  it('assistant 行永不加前缀（哪怕带了 author）', () => {
    expect(withAuthorPrefix({ role: 'assistant', content: '在的', author: '示例机器人' })).toEqual({
      role: 'assistant',
      content: '在的',
    });
  });

  it('authorId 有值时拼成「名字(id)：正文」，空白 id 不加括号', () => {
    expect(withAuthorPrefix({ role: 'user', content: '在吗', author: '小明', authorId: '123456789' })).toEqual({
      role: 'user',
      content: '小明(123456789)：在吗',
    });
    expect(withAuthorPrefix({ role: 'user', content: '在吗', author: '小明', authorId: '   ' })).toEqual({
      role: 'user',
      content: '小明：在吗',
    });
  });

  it('author 缺失或全空白时保持原样，不产生「undefined：」', () => {
    expect(withAuthorPrefix({ role: 'user', content: '老消息' })).toEqual({ role: 'user', content: '老消息' });
    expect(withAuthorPrefix({ role: 'user', content: '老消息', author: '' })).toEqual({ role: 'user', content: '老消息' });
    expect(withAuthorPrefix({ role: 'user', content: '老消息', author: '   ' })).toEqual({
      role: 'user',
      content: '老消息',
    });
  });

  it('replyTo 拼成「↳ 回复 <名字>(<id>)：「原文」」，只挂在 user 行', () => {
    const replyTo = { messageId: 'm-1', author: '示例机器人', authorId: 'bot-1', content: '我们去看电影' };
    expect(withAuthorPrefix({ role: 'user', content: '在吗', author: '小明', authorId: 'u-llp', replyTo })).toEqual({
      role: 'user',
      content: '小明(u-llp)：在吗 ↳ 回复 示例机器人(bot-1)：「我们去看电影」',
    });
    // assistant 行即便带了 replyTo 也不拼（§18.3）
    expect(withAuthorPrefix({ role: 'assistant', content: '在的', replyTo })).toEqual({
      role: 'assistant',
      content: '在的',
    });
  });

  it('没有名字的老行也带回复链，接在正文之后', () => {
    expect(
      withAuthorPrefix({
        role: 'user',
        content: '老消息',
        replyTo: { messageId: 'm-0', author: '', authorId: '', content: '' },
      }),
    ).toEqual({ role: 'user', content: '老消息 ↳ 回复一条更早的消息' });
  });
});

describe('messages.author_name 写入', () => {
  it('append 把 author 落到 author_name 列；未传或空白写 NULL', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '在吗', author: '小明' },
      { role: 'assistant', content: '在的', author: '示例机器人' },
      { role: 'user', content: '老调用方不传' },
      { role: 'user', content: '空白名', author: '   ' },
    ]);

    expect(await readAuthorRows()).toEqual([
      { role: 'user', content: '在吗', author_name: '小明' },
      { role: 'assistant', content: '在的', author_name: '示例机器人' },
      { role: 'user', content: '老调用方不传', author_name: null },
      { role: 'user', content: '空白名', author_name: null },
    ]);
  });

  it('append 把 authorId 落到 user_id 列；未传或空白写空串', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '在吗', author: '小明', authorId: 'u-llp' },
      { role: 'assistant', content: '在的', author: '示例机器人' },
      { role: 'user', content: '没 id', author: '小明' },
      { role: 'user', content: '空白 id', author: '小明', authorId: '  ' },
    ]);

    expect(await readAuthorIdRows()).toEqual([
      { role: 'user', content: '在吗', user_id: 'u-llp' },
      { role: 'assistant', content: '在的', user_id: '' },
      { role: 'user', content: '没 id', user_id: '' },
      { role: 'user', content: '空白 id', user_id: '' },
    ]);
  });

  it('loadRecent 回带 authorId；老行（user_id 空串）不产生 authorId 键', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [{ role: 'user', content: '在吗', author: '小明', authorId: 'u-llp' }]);
    await insertLegacyRow('user', '迁移前的老消息');

    const loaded = await conversations.loadRecent(KEY, 10);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ role: 'user', content: '在吗', author: '小明', authorId: 'u-llp' });
    expect(loaded[1]).toMatchObject({ role: 'user', content: '迁移前的老消息' });
    // 落库时刻读回时一并带回，值与写入时刻有关，故只钉「存在且是字符串」
    expect(typeof loaded[0]?.createdAt).toBe('string');
    expect('authorId' in loaded[1]).toBe(false);
  });

  it('run 成功后两条都带发言人名字，正文本身不加前缀', async () => {
    const harness = makeHarness();

    await createChatService(harness.deps).run(CTX);

    // 库里存原始正文，前缀只活在模型请求里
    expect(await readAuthorRows()).toEqual([
      { role: 'user', content: CTX.userText, author_name: '小明' },
      { role: 'assistant', content: '收到', author_name: '示例机器人' },
    ]);
  });
});

describe('历史里的发言人名字', () => {
  it('loadRecent 回带 author；老行（NULL）不产生 author 键', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [{ role: 'user', content: '在吗', author: '小明' }]);
    await insertLegacyRow('user', '迁移前的老消息');

    const loaded = await conversations.loadRecent(KEY, 10);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ role: 'user', content: '在吗', author: '小明' });
    expect(loaded[1]).toMatchObject({ role: 'user', content: '迁移前的老消息' });
    expect('author' in loaded[1]).toBe(false);
  });

  it('多条 user 行各带「名字(id)」，assistant 行不带前缀', async () => {
    const harness = makeHarness();
    await makeRepos().conversations.append(KEY, [
      { role: 'user', content: '有人吗', author: '小明', authorId: 'u-llp' },
      { role: 'assistant', content: '在的', author: '示例机器人' },
      { role: 'user', content: '最近看什么电影', author: '卡利亞士兵', authorId: 'u-kariya' },
      { role: 'assistant', content: '在聊老片', author: '示例机器人' },
    ]);

    await createChatService(harness.deps).run(CTX);

    // 历史行的时间戳来自落库时刻（不可预知），只钉「有戳」，署名与正文逐字比对
    const contents = (harness.requests[0]?.messages ?? []).map((message) => message.content);
    expect(contents).toHaveLength(5);
    expect(contents[0]).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 小明\(u-llp\)：有人吗$/);
    expect(contents[1]).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 在的$/);
    expect(contents[2]).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 卡利亞士兵\(u-kariya\)：最近看什么电影$/);
    expect(contents[3]).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 在聊老片$/);
    expect(contents[4]).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 小明\(u-llp\)：我也想看电影$/);
  });

  it('author 为 NULL 的老行不加前缀，也不出现 undefined', async () => {
    const harness = makeHarness();
    await insertLegacyRow('user', '迁移前的提问');
    await insertLegacyRow('assistant', '迁移前的回答');

    await createChatService(harness.deps).run(CTX);

    const messages: ChatMessage[] = harness.requests[0]?.messages ?? [];
    expect(messages).toHaveLength(3);
    // 老行没有名字：只剩时间戳 + 正文，不出现空名字片段
    expect(messages[0]?.content).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 迁移前的提问$/);
    expect(messages[1]?.content).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 迁移前的回答$/);
    expect(messages[2]?.content).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 小明\(u-llp\)：我也想看电影$/);
    for (const message of messages) expect(message.content).not.toContain('undefined');
  });

  it('当前轮的 user 消息也署名：LlmRequest.messages 末条带名字前缀', async () => {
    const harness = makeHarness();
    await makeRepos().conversations.append(KEY, [{ role: 'user', content: '旧问题', author: 'Cnvdkvg' }]);

    const other = { ...CTX, userName: 'Cnvdkvg', userText: '换个话题' };
    await createChatService(harness.deps).run(other);

    const last = harness.requests[0]?.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] Cnvdkvg\(u-llp\)：换个话题$/);
  });
});
