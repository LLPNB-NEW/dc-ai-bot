/**
 * §23.4 worker 侧认图执行器：八步流程逐条钉住。
 *
 * 三处桩：listGuildEmojis（第 3 步，唯一会向上抛的一步）、providers/keys（第 7 步的两把试错）
 * 与 fetch（第 6 步的表情原图下载）。D1 不进这一层：描述仓储是接口，直接记调用。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESCRIBE_BATCH_SIZE } from '../src/core/chat/emoji-describe';
import type { EmojiDescriptionStore, KeyRepository, ReactionModelStore } from '../src/core/ports';
import type {
  CustomEmoji,
  DecryptedKey,
  EmojiDescription,
  EmojiDescribeResult,
  LlmChunk,
  LlmProvider,
  LlmRequest,
  ProviderId,
  ProviderRuntime,
  ReactionModelConfig,
} from '../src/core/types';
import type { DescribeDeps, DescribeOptions } from '../src/workers/emoji/describe';

/** vi.mock 的工厂会被提升到 import 之前，共享状态只能走 vi.hoisted */
const rest = vi.hoisted<{
  impl: (guildId: string) => Promise<CustomEmoji[]>;
  calls: string[];
}>(() => ({
  impl: () => Promise.resolve([]),
  calls: [],
}));

vi.mock('../src/workers/discord/rest', () => ({
  listGuildEmojis: (_options: { botToken: string }, guildId: string): Promise<CustomEmoji[]> => {
    rest.calls.push(guildId);
    return rest.impl(guildId);
  },
}));

/**
 * pool-workers 的 setup 会 import worker 入口（src/workers/index.ts），describe.ts 在那时
 * 就带着真依赖（包括真的 discord/rest）缓存下来了 —— 静态 import 拿到的正是那一份，vi.mock 无效。
 * 先 resetModules 再动态 import，recognizer 才会在「mock 已注册」的模块图里重新求值。
 */
let run: (deps: DescribeDeps, guildId: string, botToken: string, options?: DescribeOptions) => Promise<EmojiDescribeResult>;

beforeAll(async () => {
  vi.resetModules();
  const module = await import('../src/workers/emoji/describe');
  run = module.describeGuildEmojis;
});

const CFG: ReactionModelConfig = { enabled: true, provider: 'openai-compat', model: 'gpt-4o-mini' };
const GUILD = 'guild-1';
const TOKEN = 'bot-token';

function emoji(id: string, name: string, animated = false): CustomEmoji {
  return animated ? { id, name, animated: true } : { id, name };
}

function describedRow(emojiId: string, name: string, description: string): EmojiDescription {
  return { emojiId, name, description, updatedAt: '2026-10-26T00:00:00.000Z' };
}

function decryptedKey(id: string): DecryptedKey {
  return { id, provider: 'openai-compat', label: id, apiKey: 'sk-' + id, models: [] };
}

/** 表情原图下载的假 HTTP：只认 cdn.discordapp.com/emojis/<id>.<gif|png>，missing 里的 id 回 404 */
function createHttp(missing: readonly string[] = []): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const down = new Set(missing);
  const http: typeof fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const match = /\/emojis\/([^/.]+)\.(gif|png)$/.exec(url);
    const id = match?.[1] ?? '';
    if (down.has(id)) return Promise.resolve(new Response('not found', { status: 404 }));
    const mediaType = match?.[2] === 'gif' ? 'image/gif' : 'image/png';
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': mediaType } }),
    );
  };
  return { fetch: http, urls };
}

type PutCall = { guildId: string; rows: ReadonlyArray<Omit<EmojiDescription, 'updatedAt'>> };

interface Harness {
  deps: DescribeDeps;
  /** 模型请求：第 N 条 = 第 N 批（图片顺序也在里面） */
  requests: LlmRequest[];
  keyQueries: string[];
  configQueries: number;
  puts: PutCall[];
  urls: string[];
  providerCalls: ProviderId[];
}

interface HarnessInput {
  emojis?: CustomEmoji[];
  existing?: EmojiDescription[];
  cfg?: ReactionModelConfig | null;
  keys?: readonly DecryptedKey[];
  /** 第 index 次 chat 的返回值：字符串 = 成功，Error = 这次调用失败 */
  answer?: (request: LlmRequest, index: number) => string | Error;
  missing?: readonly string[];
}

/** 默认答案：把请求里点到的每个 id 都回一句描述（模拟模型照格式输出） */
function describeAll(request: LlmRequest): string {
  const text = request.messages[0]?.content ?? '';
  const ids = [...text.matchAll(/id ([^\s）]+)/g)].map((match) => match[1] ?? '');
  return ids.map((id) => id + '=黄胖小子咧嘴大笑').join('\n');
}

function createHarness(input: HarnessInput = {}): Harness {
  const http = createHttp(input.missing ?? []);
  const requests: LlmRequest[] = [];
  const keyQueries: string[] = [];
  const puts: PutCall[] = [];
  const providerCalls: ProviderId[] = [];
  const answer = input.answer ?? describeAll;
  let calls = 0;

  rest.impl = () => Promise.resolve(input.emojis ?? []);
  rest.calls.length = 0;

  const keys: KeyRepository = {
    async list() {
      return [];
    },
    async listEnabled(provider) {
      keyQueries.push(provider);
      return [...(input.keys ?? [])];
    },
    async getDecrypted() {
      return null;
    },
    async create() {
      throw new Error('认图不应创建 Key');
    },
    async remove() {},
  };

  const reactionModels: ReactionModelStore = {
    async get() {
      return input.cfg === undefined ? CFG : input.cfg;
    },
    async put() {},
  };

  const emojiDescriptions: EmojiDescriptionStore = {
    async list() {
      return [...(input.existing ?? [])];
    },
    async putMany(guildId, rows) {
      puts.push({ guildId, rows });
    },
  };

  const makeProvider = (id: ProviderId): LlmProvider => ({
    id,
    async chat(request: LlmRequest, _rt: ProviderRuntime) {
      requests.push(request);
      const index = calls;
      calls += 1;
      providerCalls.push(id);
      const produced = answer(request, index);
      if (produced instanceof Error) throw produced;
      return { text: produced };
    },
    chatStream(): AsyncIterable<LlmChunk> {
      throw new Error('认图只走非流式 chat()');
    },
    async listModels() {
      return [];
    },
  });

  const deps: DescribeDeps = {
    reactionModels,
    emojiDescriptions,
    keys,
    providers: {
      'openai-compat': makeProvider('openai-compat'),
      anthropic: makeProvider('anthropic'),
      gemini: makeProvider('gemini'),
    },
    fetch: http.fetch,
  };

  // configQueries 借 reactionModels.get 计一次：短路用例要证明「连配置都没问」
  const counted: DescribeDeps = {
    ...deps,
    reactionModels: {
      async get() {
        harness.configQueries += 1;
        return reactionModels.get();
      },
      put: reactionModels.put,
    },
  };

  const harness: Harness = {
    deps: counted,
    requests,
    keyQueries,
    configQueries: 0,
    puts,
    urls: http.urls,
    providerCalls,
  };
  return harness;
}

beforeEach(() => {
  rest.impl = () => Promise.resolve([]);
  rest.calls.length = 0;
});

describe('describeGuildEmojis 短路（§23.4 第 1、2 步）', () => {
  it('guildId 或 botToken 为空：零计数，配置都不问、清单都不取', async () => {
    const harness = createHarness({ emojis: [emoji('11', 'blob')] });

    await expect(run(harness.deps, '', TOKEN)).resolves.toEqual({ described: 0, failed: 0 });
    await expect(run(harness.deps, GUILD, '  ')).resolves.toEqual({ described: 0, failed: 0 });
    expect(harness.configQueries).toBe(0);
    expect(rest.calls).toEqual([]);
  });

  it('没配表情模型：零计数且不调 listGuildEmojis（不要求 enabled === true）', async () => {
    const harness = createHarness({ cfg: null, emojis: [emoji('11', 'blob')] });

    await expect(run(harness.deps, GUILD, TOKEN)).resolves.toEqual({ described: 0, failed: 0 });
    expect(harness.configQueries).toBe(1);
    expect(rest.calls).toEqual([]);
    expect(harness.requests).toEqual([]);
  });

  it('表情模型关着（enabled: false）也照样认：那次短路只看「有没有配置」', async () => {
    const harness = createHarness({
      cfg: { ...CFG, enabled: false },
      emojis: [emoji('11', 'blob')],
      keys: [decryptedKey('k1')],
    });

    await expect(run(harness.deps, GUILD, TOKEN)).resolves.toEqual({ described: 1, failed: 0 });
  });

  it('取清单抛错向上抛：这是整函数唯一允许冒泡的一步（调用方 try/catch）', async () => {
    const harness = createHarness({ emojis: [emoji('11', 'blob')] });
    rest.impl = () => Promise.reject(new Error('discord HTTP 403: Missing Access'));

    await expect(run(harness.deps, GUILD, TOKEN)).rejects.toThrow('discord HTTP 403');
    expect(harness.requests).toEqual([]);
  });
});

describe('describeGuildEmojis 待认清单（§23.4 第 3-5 步）', () => {
  it('force 缺省：已有描述的表情不再认，只补缺的那些', async () => {
    const harness = createHarness({
      emojis: [emoji('11', 'blob'), emoji('22', 'wow')],
      existing: [describedRow('22', 'wow', '旧描述')],
      keys: [decryptedKey('k1')],
    });

    const result = await run(harness.deps, GUILD, TOKEN);

    expect(result).toEqual({ described: 1, failed: 0 });
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.images).toHaveLength(1);
    expect(harness.requests[0]?.messages[0]?.content).toContain('blob');
    expect(harness.requests[0]?.messages[0]?.content).not.toContain('wow');
    expect(harness.puts[0]?.rows.map((row) => row.emojiId)).toEqual(['11']);
    expect(harness.puts[0]?.guildId).toBe(GUILD);
  });

  it('force: true：连已有描述的也重认一遍', async () => {
    const harness = createHarness({
      emojis: [emoji('11', 'blob'), emoji('22', 'wow')],
      existing: [describedRow('11', 'blob', '旧描述'), describedRow('22', 'wow', '旧描述')],
      keys: [decryptedKey('k1')],
    });

    const result = await run(harness.deps, GUILD, TOKEN, { force: true });

    expect(result).toEqual({ described: 2, failed: 0 });
    expect(harness.requests[0]?.images).toHaveLength(2);
    expect(harness.puts[0]?.rows.map((row) => row.emojiId)).toEqual(['11', '22']);
  });

  it('按 DESCRIBE_BATCH_SIZE 分批：8 个表情 → 6 张图 + 2 张图两次请求', async () => {
    const emojis = Array.from({ length: 8 }, (_unused, index) => emoji(String(index + 1), 'e' + String(index + 1)));
    const harness = createHarness({ emojis, keys: [decryptedKey('k1')] });

    const result = await run(harness.deps, GUILD, TOKEN);

    expect(DESCRIBE_BATCH_SIZE).toBe(6);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]?.images).toHaveLength(DESCRIBE_BATCH_SIZE);
    expect(harness.requests[1]?.images).toHaveLength(2);
    expect(result).toEqual({ described: 8, failed: 0 });
  });

  it('limit 限制总表情数：limit 2 只认清单里的前 2 个', async () => {
    const harness = createHarness({
      emojis: [emoji('11', 'blob'), emoji('22', 'wow'), emoji('33', 'dance')],
      keys: [decryptedKey('k1')],
    });

    const result = await run(harness.deps, GUILD, TOKEN, { limit: 2 });

    expect(result).toEqual({ described: 2, failed: 0 });
    expect(harness.requests[0]?.images).toHaveLength(2);
    expect(harness.puts[0]?.rows.map((row) => row.emojiId)).toEqual(['11', '22']);
    expect(harness.urls).toHaveLength(2);
  });

  it('动画表情下 gif、静态下 png（第 6 步的扩展名）', async () => {
    const harness = createHarness({
      emojis: [emoji('11', 'blob'), emoji('22', 'dance', true)],
      keys: [decryptedKey('k1')],
    });

    await run(harness.deps, GUILD, TOKEN);

    expect(harness.urls).toEqual([
      'https://cdn.discordapp.com/emojis/11.png',
      'https://cdn.discordapp.com/emojis/22.gif',
    ]);
    expect(harness.requests[0]?.images).toEqual([
      { mediaType: 'image/png', base64: expect.any(String) },
      { mediaType: 'image/gif', base64: expect.any(String) },
    ]);
  });
});

describe('describeGuildEmojis 单点失败（§23.4 第 6-8 步）', () => {
  it('图片下载 404：该表情计 failed，同批其余的照常认', async () => {
    const harness = createHarness({
      emojis: [emoji('11', 'blob'), emoji('22', 'wow')],
      keys: [decryptedKey('k1')],
      missing: ['11'],
    });

    const result = await run(harness.deps, GUILD, TOKEN);

    expect(result).toEqual({ described: 1, failed: 1 });
    expect(harness.requests[0]?.images).toHaveLength(1);
    expect(harness.requests[0]?.messages[0]?.content).not.toContain('blob');
    expect(harness.puts[0]?.rows.map((row) => row.emojiId)).toEqual(['22']);
  });

  it('某批模型全失败：该批全部计 failed 且继续下一批', async () => {
    const emojis = Array.from({ length: 7 }, (_unused, index) => emoji(String(index + 1), 'e' + String(index + 1)));
    const harness = createHarness({
      emojis,
      keys: [decryptedKey('k1')],
      // 第 1 批（6 张图）失败，第 2 批（1 张图）成功
      answer: (request, index) => (index === 0 ? new Error('ALL_PROVIDERS_FAILED: quota') : describeAll(request)),
    });

    const result = await run(harness.deps, GUILD, TOKEN);

    expect(result).toEqual({ described: 1, failed: 6 });
    expect(harness.requests).toHaveLength(2);
    expect(harness.puts).toHaveLength(1);
    expect(harness.puts[0]?.rows.map((row) => row.emojiId)).toEqual(['7']);
  });

  it('一把 Key 都没有：本批全部计 failed，不落库', async () => {
    const harness = createHarness({ emojis: [emoji('11', 'blob')], keys: [] });

    const result = await run(harness.deps, GUILD, TOKEN);

    expect(result).toEqual({ described: 0, failed: 1 });
    expect(harness.keyQueries).toEqual(['openai-compat']);
    expect(harness.requests).toEqual([]);
    expect(harness.puts).toEqual([]);
  });

  it('逐把 Key 试非流式 chat：第一把失败第二把成功，同一个请求重发一次', async () => {
    const harness = createHarness({
      emojis: [emoji('11', 'blob')],
      keys: [decryptedKey('k1'), decryptedKey('k2')],
      answer: (_request, index) => (index === 0 ? new Error('401 Unauthorized') : '11=黄胖小子咧嘴大笑'),
    });

    const result = await run(harness.deps, GUILD, TOKEN);

    expect(result).toEqual({ described: 1, failed: 0 });
    // 同一批只构建一次请求：换 Key 时把同一份 request 再发一遍
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]).toBe(harness.requests[1]);
    expect(harness.providerCalls).toEqual(['openai-compat', 'openai-compat']);
  });

  it('第一把就成功：后面的 Key 一次都不试', async () => {
    const harness = createHarness({
      emojis: [emoji('11', 'blob')],
      keys: [decryptedKey('k1'), decryptedKey('k2')],
    });

    await run(harness.deps, GUILD, TOKEN);

    expect(harness.providerCalls).toEqual(['openai-compat']);
  });

  it('解析不出描述的计 failed，解析出来的按清单里的当前名字落库', async () => {
    const harness = createHarness({
      emojis: [emoji('11', '新名字'), emoji('22', 'wow')],
      // 库里存的是改名前的旧名字：putMany 必须写清单里此刻的名字
      existing: [describedRow('11', '旧名字', '老描述')],
      keys: [decryptedKey('k1')],
      // 只认出一个：另一个「宁可漏也不要编」
      answer: () => '11=黄胖小子咧嘴大笑',
    });

    const result = await run(harness.deps, GUILD, TOKEN, { force: true });

    expect(result).toEqual({ described: 1, failed: 1 });
    expect(harness.puts[0]?.rows).toEqual([
      { emojiId: '11', name: '新名字', description: '黄胖小子咧嘴大笑' },
    ]);
  });

  it('id 或 name 为空的清单项直接丢掉，不下载也不计 failed', async () => {
    const harness = createHarness({
      emojis: [{ id: '', name: 'ghost' }, { id: '22', name: '   ' }, emoji('33', 'dance')],
      keys: [decryptedKey('k1')],
    });

    const result = await run(harness.deps, GUILD, TOKEN);

    expect(result).toEqual({ described: 1, failed: 0 });
    expect(harness.urls).toHaveLength(1);
  });
});

describe('describeGuildEmojis 细节', () => {
  it('图片 mediaType 跟着 CDN 的 content-type 走，缺省才按扩展名回落（第 6 步）', async () => {
    const urls: string[] = [];
    const http: typeof fetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      // 一个声明 image/webp，另一个干脆不声明
      const headers: Record<string, string> = url.endsWith('11.png')
        ? { 'content-type': 'image/webp; charset=binary' }
        : {};
      return Promise.resolve(new Response(new Uint8Array([1, 2]), { status: 200, headers }));
    };
    const harness = createHarness({ emojis: [emoji('11', 'blob'), emoji('22', 'dance', true)], keys: [decryptedKey('k1')] });
    const deps: DescribeDeps = { ...harness.deps, fetch: http };

    await run(deps, GUILD, TOKEN);

    expect(urls).toHaveLength(2);
    expect(harness.requests[0]?.images).toEqual([
      { mediaType: 'image/webp', base64: expect.any(String) },
      { mediaType: 'image/gif', base64: expect.any(String) },
    ]);
  });

  it('写描述失败：这几条计 failed，函数照常返回（不抛）', async () => {
    const harness = createHarness({ emojis: [emoji('11', 'blob')], keys: [decryptedKey('k1')] });
    const deps: DescribeDeps = {
      ...harness.deps,
      emojiDescriptions: {
        list: async () => [],
        putMany: () => Promise.reject(new Error('D1_ERROR: no such table')),
      },
    };

    await expect(run(deps, GUILD, TOKEN)).resolves.toEqual({ described: 0, failed: 1 });
  });
});
