import { describe, expect, it } from 'vitest';
import { createChatService } from '../src/core/chat/service';
import type { ChatServiceDeps, TurnEvents } from '../src/core/chat/service';
import { CONTINUE_INSTRUCTION, CONTINUE_TOTAL_CHARS } from '../src/core/chat/truncation';
import type {
  ChatMessage,
  DecryptedKey,
  LlmChunk,
  LlmImage,
  LlmProvider,
  LlmRequest,
  LogEntry,
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
const KEY: DecryptedKey = { id: 'k1', provider: 'openai-compat', label: 'k1', apiKey: 'sk-test', models: [] };
const FIXED_NOW = '2026-10-25T03:00:00.000Z';

/** 首段故意停在词中间；续段把它补成一句完整的话 */
const SEG1 = '哼，笨蛋，你自己刚才明明就已经手动';
const CONT = '删过一遍了吧。';

/** 一次 chatStream 的剧本：先给这些正文，再按需给结束原因 / 抛错 */
interface Round {
  deltas: string[];
  finishReason?: string;
  error?: Error;
}

interface Harness {
  deps: ChatServiceDeps;
  events: TurnEvents;
  progress: string[];
  requests: LlmRequest[];
  keyLabels: string[];
  appended: ChatMessage[][];
  logs: LogEntry[];
}

function makeHarness(rounds: Round[], route: RouteConfig = ROUTE): Harness {
  const progress: string[] = [];
  const requests: LlmRequest[] = [];
  const keyLabels: string[] = [];
  const appended: ChatMessage[][] = [];
  const logs: LogEntry[] = [];

  const provider: LlmProvider = {
    id: 'openai-compat',
    chat: async () => {
      throw new Error('流式路径不应调用 chat()');
    },
    listModels: async () => [],
    chatStream(req: LlmRequest, rt: ProviderRuntime): AsyncIterable<LlmChunk> {
      requests.push(req);
      keyLabels.push(rt.apiKey);
      const index = requests.length - 1;
      return (async function* () {
        const round = rounds[index];
        // 剧本之外多问一次 = 续写次数超了，直接炸出来让断言看得见
        if (round === undefined) throw new Error('第 ' + String(index + 1) + ' 次 chatStream 超出了剧本');
        for (const delta of round.deltas) yield { delta };
        if (round.finishReason !== undefined) yield { delta: '', finishReason: round.finishReason };
        if (round.error !== undefined) throw round.error;
      })();
    },
  };

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
        return key.scope === 'global' ? route : null;
      },
      async list() {
        return [];
      },
      async put() {},
      async remove() {},
    },
    keys: {
      async listEnabled() {
        return [KEY];
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
      async loadAll() {
        return [];
      },
      async append(_key, messages) {
        appended.push(messages);
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
      'openai-compat': provider,
      anthropic: {
        id: 'anthropic',
        chat: async () => {
          throw new Error('未被选中的 provider 不应被调用');
        },
        listModels: async () => [],
        chatStream(): AsyncIterable<LlmChunk> {
          throw new Error('未被选中的 provider 不应被调用');
        },
      },
      gemini: {
        id: 'gemini',
        chat: async () => {
          throw new Error('未被选中的 provider 不应被调用');
        },
        listModels: async () => [],
        chatStream(): AsyncIterable<LlmChunk> {
          throw new Error('未被选中的 provider 不应被调用');
        },
      },
    },
    now: () => new Date(FIXED_NOW),
    log(entry) {
      logs.push(entry);
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
    requests,
    keyLabels,
    appended,
    logs,
  };
}

function replyLog(logs: LogEntry[]): string {
  const line = logs.find((entry) => entry.message.startsWith('回复成功'));
  return line === undefined ? '' : line.message;
}

describe('run 截断续写：同一条回复里接着写', () => {
  it('首段被掐断 → 发起一次续写、合并正文、onProgress 收到两段、落库与日志都算合并后', async () => {
    // 两段各自拆成两块到达：要证明的是「每来一块就推一次」，不是只推两段的边界
    const harness = makeHarness([
      { deltas: ['哼，笨蛋，', '你自己刚才明明就已经手动'] },
      { deltas: ['删过一遍了', '吧。'], finishReason: 'stop' },
    ]);
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    // 同一次尝试里问第二次，用的是同一把 Key 与同一个模型
    expect(harness.requests).toHaveLength(2);
    expect(harness.keyLabels).toEqual(['sk-test', 'sk-test']);
    expect(harness.requests[1]?.model).toBe(harness.requests[0]?.model);
    // 续写请求 = 原上下文 + 已写正文（assistant）+ 续写指令（user）
    const continued = harness.requests[1]?.messages ?? [];
    expect(continued).toHaveLength((harness.requests[0]?.messages ?? []).length + 2);
    expect(continued[continued.length - 2]).toEqual({ role: 'assistant', content: SEG1 });
    expect(continued[continued.length - 1]).toEqual({ role: 'user', content: CONTINUE_INSTRUCTION });

    const merged = SEG1 + CONT;
    expect(result.text).toBe(merged);
    // 每块必推、续写那两段也一样：四块 = 四次累计文本，全是同一条消息的中间态，不新开一条
    expect(harness.progress).toEqual(['哼，笨蛋，', SEG1, SEG1 + '删过一遍了', merged]);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.[1]?.content).toBe(merged);
    expect(replyLog(harness.logs)).toContain(' cont=1');
  });

  it('续写只回 [END] → 正文一个字都不追加、不再续第二次、日志里没有 cont=', async () => {
    const harness = makeHarness([
      { deltas: [SEG1] },
      { deltas: ['[END]'], finishReason: 'stop' },
      { deltas: ['不该再问第三次'] },
    ]);
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(harness.requests).toHaveLength(2);
    expect(result.text).toBe(SEG1);
    // 续写这一段只吐 [END]：哨兵不算正文，一个字都不推给用户（推出去只会先闪一下 [END]）
    expect(harness.progress).toEqual([SEG1]);
    expect(harness.appended[0]?.[1]?.content).toBe(SEG1);
    expect(replyLog(harness.logs)).not.toContain('cont=');
  });

  it('首段正常收尾且句子完整 → 一次续写请求都不发', async () => {
    const complete = '好的，我看完了。';
    const harness = makeHarness([{ deltas: [complete], finishReason: 'stop' }]);
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(harness.requests).toHaveLength(1);
    expect(result.text).toBe(complete);
    expect(harness.progress).toEqual([complete]);
    expect(replyLog(harness.logs)).not.toContain('cont=');
  });

  it('连掐两段 → 恰好续两次就收手', async () => {
    const harness = makeHarness([
      { deltas: ['第一段还没写完'] },
      { deltas: ['第二段也还没写完'] },
      { deltas: ['第三段收尾了。'], finishReason: 'stop' },
      { deltas: ['不该再问第四次'] },
    ]);
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(harness.requests).toHaveLength(3);
    expect(result.text).toBe('第一段还没写完第二段也还没写完第三段收尾了。');
    expect(replyLog(harness.logs)).toContain(' cont=2');
  });

  it('累计长度到 3000 字上限 → 不再续', async () => {
    const long = '甲'.repeat(2990) + '乙';
    const tail = '丙'.repeat(20);
    const harness = makeHarness([{ deltas: [long] }, { deltas: [tail], finishReason: 'stop' }]);
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(long.length).toBeLessThan(CONTINUE_TOTAL_CHARS);
    expect(harness.requests).toHaveLength(2);
    expect(result.text.length).toBe(long.length + tail.length);
    expect(result.text.length).toBeGreaterThanOrEqual(CONTINUE_TOTAL_CHARS);
    expect(replyLog(harness.logs)).toContain(' cont=1');
  });

  it('续写请求抛错 → 整轮仍然成功，正文是首段，只留一条 warn', async () => {
    const harness = makeHarness([{ deltas: [SEG1] }, { deltas: [], error: new Error('上游 502') }]);
    const service = createChatService(harness.deps);

    const result = await service.run(CTX, harness.events);

    expect(harness.requests).toHaveLength(2);
    expect(result.text).toBe(SEG1);
    expect(harness.progress).toEqual([SEG1]);
    const warnings = harness.logs.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('续写失败');
    expect(warnings[0]?.message).toContain('key=k1');
    expect(replyLog(harness.logs)).toContain('len=' + String(SEG1.length));
  });
});

describe('run 的图片（§22.6）：只有首段带图', () => {
  const IMAGES: LlmImage[] = [
    { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
    { mediaType: 'image/jpeg', base64: '/9j/4AAQ' },
  ];

  it('首段被掐断 → 首段请求带这两张（顺序一致）、续写请求上没有 images 键、一轮只取一次图', async () => {
    const harness = makeHarness([
      { deltas: [SEG1] },
      { deltas: [CONT], finishReason: 'stop' },
    ]);
    const service = createChatService(harness.deps);
    let calls = 0;

    const result = await service.run(
      {
        ...CTX,
        loadImages: async () => {
          calls += 1;
          return IMAGES;
        },
      },
      harness.events,
    );

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]?.images).toEqual(IMAGES);
    // 续写那条 user 消息是「继续写」的指令：适配器会把图挂到它身上，既浪费也可能干扰
    expect('images' in (harness.requests[1] ?? {})).toBe(false);
    expect(calls).toBe(1);
    expect(result.text).toBe(SEG1 + CONT);
    expect(replyLog(harness.logs)).toContain(' cont=1');
    // 有图才追加这个字段，位置在 cont= 之后
    expect(replyLog(harness.logs)).toContain(' images=2');
  });

  it('无图 → 首段与续写请求上都没有 images 这个键，日志里也没有 images=', async () => {
    const harness = makeHarness([
      { deltas: [SEG1] },
      { deltas: [CONT], finishReason: 'stop' },
    ]);
    const service = createChatService(harness.deps);

    await service.run(CTX, harness.events);

    expect(harness.requests).toHaveLength(2);
    for (const request of harness.requests) expect('images' in request).toBe(false);
    expect(replyLog(harness.logs)).not.toContain('images=');
  });
});

describe('run 的采样参数：首段与续写同源', () => {
  it('route 上的五项原样进两段请求，0 不被吞掉', async () => {
    const harness = makeHarness(
      [{ deltas: [SEG1] }, { deltas: [CONT], finishReason: 'stop' }],
      { ...ROUTE, topP: 0, topK: 40, seed: 0, frequencyPenalty: -0.5, presencePenalty: 0.5 },
    );
    await createChatService(harness.deps).run(CTX, harness.events);

    expect(harness.requests).toHaveLength(2);
    for (const request of harness.requests) {
      expect(request.topP).toBe(0);
      expect(request.topK).toBe(40);
      expect(request.seed).toBe(0);
      expect(request.frequencyPenalty).toBe(-0.5);
      expect(request.presencePenalty).toBe(0.5);
    }
  });

  it('route 没设采样 → 两段请求里连键都没有', async () => {
    const harness = makeHarness([{ deltas: [SEG1] }, { deltas: [CONT], finishReason: 'stop' }]);
    await createChatService(harness.deps).run(CTX, harness.events);

    expect(harness.requests).toHaveLength(2);
    for (const request of harness.requests) {
      for (const key of ['topP', 'topK', 'seed', 'frequencyPenalty', 'presencePenalty']) {
        expect(key in request).toBe(false);
      }
    }
  });
});
