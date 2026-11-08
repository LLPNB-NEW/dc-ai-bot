import { createProviders } from '../src/core/providers/index';
import { createOpenAiCompatProvider } from '../src/core/providers/openai-compat';
import { describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  ChatTool,
  LlmChunk,
  LlmImage,
  LlmRequest,
  LlmResponseFormat,
  ProviderRuntime,
} from '../src/core/types';

interface FakeCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: FakeCall) => Response) {
  const calls: FakeCall[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const call: FakeCall = { url: typeof input === 'string' ? input : String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as ProviderRuntime['fetch'];
  return { fetch: fn, calls };
}

function runtime(apiKey: string, fetchImpl: ProviderRuntime['fetch'], extra: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return { apiKey, fetch: fetchImpl, ...extra };
}

function bodyOf(call: FakeCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headersOf(call: FakeCall): Record<string, string> {
  return call.init.headers as unknown as Record<string, string>;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(stream: AsyncIterable<{ delta: string }>): Promise<string[]> {
  const deltas: string[] = [];
  for await (const chunk of stream) deltas.push(chunk.delta);
  return deltas;
}

async function collectChunks(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error as Error,
  );
}

function longBody(): { payload: string; expected: string } {
  return { payload: 'E'.repeat(100) + 'X'.repeat(400), expected: 'E'.repeat(100) + 'X'.repeat(200) };
}

const REQUEST: LlmRequest = {
  model: 'gpt-4o-mini',
  system: 'SYS',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ],
  temperature: 0.3,
  maxTokens: 128,
};

const MESSAGES_WIRE = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'again' },
];

describe('openai-compat provider', () => {
  it('createProviders 暴露三家适配器且 id 正确', () => {
    const providers = createProviders();
    expect(Object.keys(providers).sort()).toEqual(['anthropic', 'gemini', 'openai-compat']);
    expect(providers['openai-compat'].id).toBe('openai-compat');
    expect(providers.anthropic.id).toBe('anthropic');
    expect(providers.gemini.id).toBe('gemini');
  });

  it('非流式 chat：默认 baseUrl、鉴权头、system 在 messages[0]、usage 映射', async () => {
    const fake = fakeFetch(() =>
      json({
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    );

    const result = await createOpenAiCompatProvider().chat(REQUEST, runtime('sk-test', fake.fetch));

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(headersOf(call)['authorization']).toBe('Bearer sk-test');
    expect(headersOf(call)['content-type']).toBe('application/json');

    const body = bodyOf(call);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual(MESSAGES_WIRE);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(128);
    expect(body.stream).toBe(false);

    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });


  it('chat 解析 tool_calls：content 为 null 时 text 为空串，调用保留 name 与原始 arguments', async () => {
    const fake = fakeFetch(() =>
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'story_reply', arguments: '{"game_content":"正文"}' } },
                { id: 'call_2', type: 'function', function: { name: 'context', arguments: '' } },
              ],
            },
          },
        ],
      }),
    );

    const result = await createOpenAiCompatProvider().chat(REQUEST, runtime('sk-test', fake.fetch));

    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([
      { name: 'story_reply', arguments: '{"game_content":"正文"}' },
      { name: 'context', arguments: '' },
    ]);
  });

  it('chat 没有 tool_calls 时返回对象里连 toolCalls 这个键都不出现', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    const result = await createOpenAiCompatProvider().chat(REQUEST, runtime('sk-test', fake.fetch));

    expect('toolCalls' in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['text', 'usage']);
    expect('tools' in bodyOf(fake.calls[0] as FakeCall)).toBe(false);
  });

  it('chat 带 tools 时 body 里有 tools + tool_choice（上下文工具模式的线上形状）', async () => {
    const TOOL: ChatTool = {
      type: 'function',
      function: { name: 'context', description: '设定正文', parameters: { type: 'object' } },
    };
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, tools: [TOOL], toolChoice: 'auto' },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0] as FakeCall);
    expect(body.tools).toEqual([TOOL]);
    expect(body.tool_choice).toBe('auto');
    expect(body.stream).toBe(false);
  });

  it('对象形式 tool_choice 原样出现在请求体里（强制某个函数）', async () => {
    const TOOL: ChatTool = {
      type: 'function',
      function: { name: 'story_reply', description: '回复', parameters: { type: 'object' } },
    };
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      {
        ...REQUEST,
        tools: [TOOL],
        toolChoice: { type: 'function', function: { name: 'story_reply' } },
      },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0] as FakeCall);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'story_reply' } });
    expect(body.tools).toEqual([TOOL]);
  });

  it('带 reasoningEffort 时请求体出现 reasoning_effort，位置在 top_p 之后、seed 之前', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, topP: 0.9, seed: 7, reasoningEffort: 'low' },
      runtime('sk-test', fake.fetch),
    );

    const raw = String((fake.calls[0] as FakeCall).init.body);
    expect(bodyOf(fake.calls[0] as FakeCall).reasoning_effort).toBe('low');
    expect(raw.indexOf('"top_p"')).toBeLessThan(raw.indexOf('"reasoning_effort"'));
    expect(raw.indexOf('"reasoning_effort"')).toBeLessThan(raw.indexOf('"seed"'));
  });

  it('没给 reasoningEffort（或给空串）时请求体里连这个键都没有', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat({ ...REQUEST, topP: 0.9, seed: 7 }, runtime('sk-test', fake.fetch));
    await createOpenAiCompatProvider().chat({ ...REQUEST, reasoningEffort: '' }, runtime('sk-test', fake.fetch));

    for (const call of fake.calls) {
      expect('reasoning_effort' in bodyOf(call as FakeCall)).toBe(false);
    }
    expect(String((fake.calls[0] as FakeCall).init.body)).not.toContain('reasoning_effort');
  });

  it('自定义 baseUrl 去尾斜杠拼接，listModels 复用同一 baseUrl', async () => {
    const fake = fakeFetch(() => json({ data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }] }));

    const models = await createOpenAiCompatProvider().listModels(
      runtime('sk-test', fake.fetch, { baseUrl: 'https://proxy.example/v1/' }),
    );

    expect(fake.calls[0].url).toBe('https://proxy.example/v1/models');
    expect(fake.calls[0].init.method).toBe('GET');
    expect(headersOf(fake.calls[0])['authorization']).toBe('Bearer sk-test');
    expect(models).toEqual(['gpt-4o-mini', 'deepseek-chat']);
  });

  it('自定义 baseUrl 下 chat 路径无双斜杠', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      REQUEST,
      runtime('sk-test', fake.fetch, { baseUrl: 'https://proxy.example/v1/' }),
    );

    expect(fake.calls[0].url).toBe('https://proxy.example/v1/chat/completions');
  });

  it('chatStream：容忍注释行/空行/跨 chunk 断行/脏 JSON，[DONE] 结束', async () => {
    const fake = fakeFetch(() =>
      sse([
        ': keep-alive\n\n',
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choi',
        'ces":[{"delta":{"content":"好"}}]}\n\n',
        'data: {not-json}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"不该出现"}}]}\n\n',
      ]),
    );

    const deltas = await collect(createOpenAiCompatProvider().chatStream(REQUEST, runtime('sk-test', fake.fetch)));

    expect(deltas).toEqual(['你', '好']);
    const body = bodyOf(fake.calls[0]);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual(MESSAGES_WIRE);
    expect(headersOf(fake.calls[0])['authorization']).toBe('Bearer sk-test');
  });

  it('chatStream：结束帧（delta 为空、finish_reason 有值）也要 yield 出 finishReason', async () => {
    const fake = fakeFetch(() =>
      sse([
        'data: {"choices":[{"delta":{"content":"前半"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":4}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = await collectChunks(
      createOpenAiCompatProvider().chatStream(REQUEST, runtime('sk-test', fake.fetch)),
    );

    expect(chunks).toEqual([{ delta: '前半' }, { delta: '', finishReason: 'stop' }]);
  });

  it('chatStream 解析 tool_calls 增量：name 只在非空那一帧带，arguments 半截 JSON 分片照原样交出来', async () => {
    const fake = fakeFetch(() =>
      sse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"story_reply","arguments":"{\\"game_con"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"tent\\":\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"正文\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = await collectChunks(
      createOpenAiCompatProvider().chatStream(REQUEST, runtime('sk-test', fake.fetch)),
    );

    expect(chunks).toEqual([
      { delta: '', toolCallDelta: { index: 0, name: 'story_reply', arguments: '{"game_con' } },
      { delta: '', toolCallDelta: { index: 0, arguments: 'tent":"' } },
      { delta: '', toolCallDelta: { index: 0, arguments: '正文"}' } },
      { delta: '', finishReason: 'tool_calls' },
    ]);

    // 分片按到达顺序拼回去必须是一条完整 JSON：半截分片不许被适配器自己解析或改写
    const joined = chunks.map((chunk) => chunk.toolCallDelta?.arguments ?? '').join('');
    expect(JSON.parse(joined)).toEqual({ game_content: '正文' });
  });

  it('chatStream：同一帧既有 content 又有 tool_calls 时两者都交出来（一次 yield，不拆两条）', async () => {
    const fake = fakeFetch(() =>
      sse([
        'data: {"choices":[{"delta":{"content":"先说一句","tool_calls":[{"index":0,"function":{"name":"story_reply","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = await collectChunks(
      createOpenAiCompatProvider().chatStream(REQUEST, runtime('sk-test', fake.fetch)),
    );

    expect(chunks).toEqual([
      { delta: '先说一句', toolCallDelta: { index: 0, name: 'story_reply', arguments: '{}' } },
    ]);
  });

  it('chatStream：非流式退化路径按正常收尾 yield finishReason=stop', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: '整段文本' } }] }));

    const chunks = await collectChunks(
      createOpenAiCompatProvider().chatStream(REQUEST, runtime('sk-test', fake.fetch)),
    );

    expect(chunks).toEqual([{ delta: '整段文本', finishReason: 'stop' }]);
  });

  it('chatStream：响应头非 event-stream 时退化为一次性 yield', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: '整段文本' } }] }));

    const deltas = await collect(
      createOpenAiCompatProvider().chatStream(REQUEST, runtime('sk-test', fake.fetch)),
    );

    expect(deltas).toEqual(['整段文本']);
  });

  it('非 2xx 归一为 provider+status，body 截断到 300', async () => {
    const { payload, expected } = longBody();
    const fake = fakeFetch(() => new Response(payload, { status: 500 }));
    const provider = createOpenAiCompatProvider();

    const error = await failure(provider.chat(REQUEST, runtime('sk-test', fake.fetch)));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('openai-compat HTTP 500: ' + expected);
    expect(error.message).toHaveLength('openai-compat HTTP 500: '.length + 300);

    const streamError = await failure(
      collect(provider.chatStream(REQUEST, runtime('sk-test', fake.fetch))),
    );
    expect(streamError.message).toBe('openai-compat HTTP 500: ' + expected);
  });

  it('chatStream：流里只有错误帧也抛错，消息带上游 code 与原文', async () => {
    const fake = fakeFetch(() =>
      sse([
        'event: message\n',
        'data: {"error":{"code":"executor_timeout","message":"executor timed out after 60s","detail":"task 7"}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const error = await failure(
      collect(createOpenAiCompatProvider().chatStream(REQUEST, runtime('sk-test', fake.fetch))),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('openai-compat: executor_timeout: executor timed out after 60s');
  });

  it('chatStream：先产出正常 delta 再收到错误帧 → 先给 delta，随后抛错', async () => {
    const fake = fakeFetch(() =>
      sse([
        'data: {"choices":[{"delta":{"content":"前半"}}]}\n\n',
        'data: {"error":{"code":"executor_timeout","message":"上游中途超时"}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const deltas: string[] = [];
    let caught: Error | null = null;
    try {
      for await (const chunk of createOpenAiCompatProvider().chatStream(
        REQUEST,
        runtime('sk-test', fake.fetch),
      )) {
        deltas.push(chunk.delta);
      }
    } catch (error) {
      caught = error as Error;
    }

    expect(deltas).toEqual(['前半']);
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toBe('openai-compat: executor_timeout: 上游中途超时');
  });

  it('非流式 chat：200 里带 error 同样抛错', async () => {
    const fake = fakeFetch(() =>
      json({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }),
    );

    const error = await failure(
      createOpenAiCompatProvider().chat(REQUEST, runtime('sk-test', fake.fetch)),
    );

    expect(error.message).toBe('openai-compat: invalid_api_key: Incorrect API key provided');
  });
});

const IMAGES: LlmImage[] = [
  { mediaType: 'image/png', base64: 'QUJD' },
  { mediaType: 'image/jpeg', base64: 'REVG' },
];

describe('openai-compat provider — §22.3 本轮附图', () => {
  it('有图：2 张图按数组顺序附到最后一条 user 消息，文字在前', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, images: IMAGES },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'again' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,REVG' } },
        ],
      },
    ]);
  });

  it('有图：目标未必是数组最后一条（末条是 assistant 时仍挂在最后一条 user 上）', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '答二' },
    ];
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, messages, images: [IMAGES[0]] },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '答一' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '第二句' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      },
      { role: 'assistant', content: '答二' },
    ]);
  });

  it('images 缺省：messages 仍是旧版纯字符串形状', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(REQUEST, runtime('sk-test', fake.fetch));

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual(MESSAGES_WIRE);
    expect(JSON.stringify(body.messages)).not.toContain('image_url');
  });

  it('images 为空数组：等同缺省，形状不变', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, images: [] },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual(MESSAGES_WIRE);
  });

  it('有图但没有任何 user 消息：整段忽略，不抛错也不造消息', async () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: '只有助手' }];
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    const result = await createOpenAiCompatProvider().chat(
      { ...REQUEST, messages, images: IMAGES },
      runtime('sk-test', fake.fetch),
    );

    expect(result.text).toBe('ok');
    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'assistant', content: '只有助手' },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain('image_url');
  });

  it('chatStream 同样把图片附到最后一条 user 消息', async () => {
    const fake = fakeFetch(() => sse(['data: {"choices":[{"delta":{"content":"好"}}]}\n\n']));

    const deltas = await collect(
      createOpenAiCompatProvider().chatStream(
        { ...REQUEST, images: IMAGES },
        runtime('sk-test', fake.fetch),
      ),
    );

    expect(deltas).toEqual(['好']);
    expect(bodyOf(fake.calls[0]).messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'again' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,REVG' } },
        ],
      },
    ]);
  });

  it('采样参数：只有 top_p / frequency_penalty / presence_penalty / seed 上线缆，没有 top_k', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));
    const provider = createOpenAiCompatProvider();

    await provider.chat(
      { ...REQUEST, topP: 0.8, topK: 40, seed: 7, frequencyPenalty: 0.5, presencePenalty: 0.25 },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.top_p).toBe(0.8);
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.presence_penalty).toBe(0.25);
    expect(body.seed).toBe(7);
    // 兼容协议没有 top_k：填了也不发，免得每个请求都 400
    expect('top_k' in body).toBe(false);

    // 0 是有效值：不许被当成「没填」吞掉
    await provider.chat({ ...REQUEST, topP: 0, seed: 0 }, runtime('sk-test', fake.fetch));
    const zero = bodyOf(fake.calls[1]);
    expect(zero.top_p).toBe(0);
    expect(zero.seed).toBe(0);
    expect(zero.frequency_penalty).toBeUndefined();
  });

  it('深度注入的 system 消息原样发出：兼容协议允许 messages 里内联 system', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));
    await createOpenAiCompatProvider().chat(
      {
        ...REQUEST,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: '记住：保持简短' },
          { role: 'user', content: 'again' },
        ],
      },
      runtime('sk-test', fake.fetch),
    );

    expect(bodyOf(fake.calls[0]).messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: '记住：保持简短' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('一个采样参数都不设时，线缆 body 与改动前逐字相同', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));
    await createOpenAiCompatProvider().chat(REQUEST, runtime('sk-test', fake.fetch));

    expect(String(fake.calls[0].init.body)).toBe(
      '{"model":"gpt-4o-mini","messages":[{"role":"system","content":"SYS"},{"role":"user","content":"hi"},{"role":"assistant","content":"hello"},{"role":"user","content":"again"}],"temperature":0.3,"max_tokens":128,"stream":false}',
    );
  });
});

const REPLY_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'story_reply',
    description: '把要发给用户的正文放在 content 里交付出去',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: '给用户看的正文（可以带 <think_nya> 思考块）' } },
      required: ['content'],
    },
  },
};

describe('openai-compat provider — tools 兼容性保留', () => {
  /** 工具这两个键的自检只认「有没有、排在哪」，不看其余字段：其余字段另有逐字断言 */
  const KEYS_WITHOUT_TOOLS = ['model', 'messages', 'temperature', 'max_tokens', 'stream'];

  it('tools + toolChoice 都进 body：数组原样序列化，tool_choice 紧随其后', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, tools: [REPLY_TOOL], toolChoice: 'auto' },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.tools).toEqual([REPLY_TOOL]);
    expect(body.tool_choice).toBe('auto');
    // 新键插在 stream 之前：其余字段的顺序与条件一个都没动
    expect(Object.keys(body)).toEqual([...KEYS_WITHOUT_TOOLS.slice(0, -1), 'tools', 'tool_choice', 'stream']);
  });

  it('只给 tools 不给 toolChoice：body 里没有 tool_choice', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, tools: [REPLY_TOOL] },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.tools).toEqual([REPLY_TOOL]);
    expect('tool_choice' in body).toBe(false);
  });

  it('都不给：body 里既没有 tools 也没有 tool_choice，键序与旧版一致', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(REQUEST, runtime('sk-test', fake.fetch));

    const body = bodyOf(fake.calls[0]);
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    expect(Object.keys(body)).toEqual(KEYS_WITHOUT_TOOLS);
  });

  it('tools: [] 等同缺省：不出现 tools（也不会出现 tool_choice）', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));

    await createOpenAiCompatProvider().chat(
      { ...REQUEST, tools: [], toolChoice: 'auto' },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    expect(String(fake.calls[0].init.body)).toBe(
      '{"model":"gpt-4o-mini","messages":[{"role":"system","content":"SYS"},{"role":"user","content":"hi"},{"role":"assistant","content":"hello"},{"role":"user","content":"again"}],"temperature":0.3,"max_tokens":128,"stream":false}',
    );
  });

  it('chatStream 同样带上 tools / tool_choice', async () => {
    const fake = fakeFetch(() => sse(['data: {"choices":[{"delta":{"content":"好"}}]}\n\n']));

    await collect(
      createOpenAiCompatProvider().chatStream(
        { ...REQUEST, tools: [REPLY_TOOL], toolChoice: 'auto' },
        runtime('sk-test', fake.fetch),
      ),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.tools).toEqual([REPLY_TOOL]);
    expect(body.tool_choice).toBe('auto');
    expect(body.stream).toBe(true);
  });
});

const REACTION_FORMAT: LlmResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'reaction_choice',
    schema: {
      type: 'object',
      properties: { reaction: { type: 'string' } },
      required: ['reaction'],
    },
  },
};

describe('openai-compat provider — response_format（结构化输出）', () => {
  it('responseFormat 原样进 body：新键排在 stream 之前，旧字段顺序一个没动', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: '{"reaction":":laugh:"}' } }] }));

    const result = await createOpenAiCompatProvider().chat(
      { ...REQUEST, responseFormat: REACTION_FORMAT },
      runtime('sk-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.response_format).toEqual(REACTION_FORMAT);
    expect(Object.keys(body)).toEqual([
      'model',
      'messages',
      'temperature',
      'max_tokens',
      'response_format',
      'stream',
    ]);
    // 中继把 content 原样回给我们，解析交给 normalizeReactions
    expect(result.text).toBe('{"reaction":":laugh:"}');
  });

  it('json_object 同样透传；不给 responseFormat 时键不出现', async () => {
    const fake = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));
    const provider = createOpenAiCompatProvider();

    await provider.chat({ ...REQUEST, responseFormat: { type: 'json_object' } }, runtime('sk-test', fake.fetch));
    expect(bodyOf(fake.calls[0]).response_format).toEqual({ type: 'json_object' });

    await provider.chat(REQUEST, runtime('sk-test', fake.fetch));
    expect('response_format' in bodyOf(fake.calls[1])).toBe(false);
  });

  it('chatStream 走同一个 bodyOf：流式也带 response_format', async () => {
    const fake = fakeFetch(() => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']));

    await collect(
      createOpenAiCompatProvider().chatStream(
        { ...REQUEST, responseFormat: REACTION_FORMAT },
        runtime('sk-test', fake.fetch),
      ),
    );

    expect(bodyOf(fake.calls[0]).response_format).toEqual(REACTION_FORMAT);
  });
});
