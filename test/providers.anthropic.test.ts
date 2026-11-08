import { ANTHROPIC_FALLBACK_MODELS, createAnthropicProvider } from '../src/core/providers/anthropic';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, LlmChunk, LlmImage, LlmRequest, ProviderRuntime } from '../src/core/types';

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
  model: 'claude-3-5-sonnet-20241022',
  system: 'SYS',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ],
};

const MESSAGES_WIRE = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'again' },
];

describe('anthropic provider', () => {
  it('非流式 chat：x-api-key/anthropic-version 头、system 在顶层、max_tokens 默认 1024', async () => {
    const fake = fakeFetch(() =>
      json({
        content: [{ type: 'text', text: '你好' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );

    const result = await createAnthropicProvider().chat(REQUEST, runtime('sk-ant-test', fake.fetch));

    const call = fake.calls[0];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.method).toBe('POST');
    expect(headersOf(call)['x-api-key']).toBe('sk-ant-test');
    expect(headersOf(call)['anthropic-version']).toBe('2023-06-01');
    expect(headersOf(call)['content-type']).toBe('application/json');

    const body = bodyOf(call);
    expect(body.model).toBe('claude-3-5-sonnet-20241022');
    expect(body.system).toBe('SYS');
    expect(body.messages).toEqual(MESSAGES_WIRE);
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBeUndefined();
    expect(body.stream).toBe(false);

    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('自定义 baseUrl 与显式 maxTokens/temperature 生效', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));

    await createAnthropicProvider().chat(
      { ...REQUEST, temperature: 0.2, maxTokens: 256 },
      runtime('sk-ant-test', fake.fetch, { baseUrl: 'https://anthropic-proxy.test/' }),
    );

    expect(fake.calls[0].url).toBe('https://anthropic-proxy.test/v1/messages');
    const body = bodyOf(fake.calls[0]);
    expect(body.system).toBe('SYS');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.2);
  });

  it('chatStream：CRLF + ping 事件，累计 content_block_delta 至 message_stop', async () => {
    const fake = fakeFetch(() =>
      sse([
        'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\n',
        ': ping\r\n\r\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\r\n\r\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}\r\n\r\n',
        'data: {"type":"message_stop"}\r\n\r\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Z"}}\r\n\r\n',
      ]),
    );

    const deltas = await collect(
      createAnthropicProvider().chatStream(REQUEST, runtime('sk-ant-test', fake.fetch)),
    );

    // 结束帧现在也要产出：正文为空、finishReason=end_turn（这是刻意的破坏性变更）
    expect(deltas).toEqual(['A', 'B', '']);
    const body = bodyOf(fake.calls[0]);
    expect(body.stream).toBe(true);
    expect(body.system).toBe('SYS');
    expect(body.messages).toEqual(MESSAGES_WIRE);
  });

  it('chatStream：message_delta 的 stop_reason 变成 finishReason，message_stop 不重复报', async () => {
    const fake = fakeFetch(() =>
      sse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"前半"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );

    const chunks = await collectChunks(
      createAnthropicProvider().chatStream(REQUEST, runtime('sk-ant-test', fake.fetch)),
    );

    expect(chunks).toEqual([{ delta: '前半' }, { delta: '', finishReason: 'end_turn' }]);
  });

  it('chatStream：只有 message_stop 没有 stop_reason 时也报一次正常收尾', async () => {
    const fake = fakeFetch(() =>
      sse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"整段"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );

    const chunks = await collectChunks(
      createAnthropicProvider().chatStream(REQUEST, runtime('sk-ant-test', fake.fetch)),
    );

    expect(chunks).toEqual([{ delta: '整段' }, { delta: '', finishReason: 'end_turn' }]);
  });

  it('chatStream：非流式退化路径按正常收尾 yield finishReason=stop', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: '整段文本' }] }));

    const chunks = await collectChunks(
      createAnthropicProvider().chatStream(REQUEST, runtime('sk-ant-test', fake.fetch)),
    );

    expect(chunks).toEqual([{ delta: '整段文本', finishReason: 'stop' }]);
  });

  it('chatStream：响应头非 event-stream 时退化为一次性 yield', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: '整段文本' }] }));

    const deltas = await collect(
      createAnthropicProvider().chatStream(REQUEST, runtime('sk-ant-test', fake.fetch)),
    );

    expect(deltas).toEqual(['整段文本']);
  });

  it('非 2xx 归一为 provider+status，body 截断到 300', async () => {
    const { payload, expected } = longBody();
    const fake = fakeFetch(() => new Response(payload, { status: 500 }));

    const error = await failure(
      createAnthropicProvider().chat(REQUEST, runtime('sk-ant-test', fake.fetch)),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('anthropic HTTP 500: ' + expected);
    expect(error.message).toHaveLength('anthropic HTTP 500: '.length + 300);
  });

  it('chatStream：{"type":"error"} 帧不再被 continue 掉，而是抛错', async () => {
    const fake = fakeFetch(() =>
      sse([
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );

    const error = await failure(
      collect(createAnthropicProvider().chatStream(REQUEST, runtime('sk-ant-test', fake.fetch))),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('anthropic: overloaded_error: Overloaded');
  });

  it('listModels：data[].id 解析；失败回内置常量列表', async () => {
    const fake = fakeFetch(() => json({ data: [{ id: 'claude-3-5-haiku-20241022' }] }));

    const models = await createAnthropicProvider().listModels(
      runtime('sk-ant-test', fake.fetch),
    );

    expect(fake.calls[0].url).toBe('https://api.anthropic.com/v1/models');
    expect(fake.calls[0].init.method).toBe('GET');
    expect(headersOf(fake.calls[0])['x-api-key']).toBe('sk-ant-test');
    expect(models).toEqual(['claude-3-5-haiku-20241022']);

    const failing = fakeFetch(() => new Response('boom', { status: 500 }));
    const fallback = await createAnthropicProvider().listModels(
      runtime('sk-ant-test', failing.fetch, { baseUrl: 'https://anthropic-proxy.test/' }),
    );

    expect(failing.calls[0].url).toBe('https://anthropic-proxy.test/v1/models');
    expect(fallback).toEqual([...ANTHROPIC_FALLBACK_MODELS]);
    expect(fallback.length).toBeGreaterThan(0);
  });
});

const IMAGES: LlmImage[] = [
  { mediaType: 'image/png', base64: 'QUJD' },
  { mediaType: 'image/jpeg', base64: 'REVG' },
];

describe('anthropic provider — §22.3 本轮附图', () => {
  it('有图：2 张图按数组顺序变成 image blocks 附到最后一条 user 消息，文字在前', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));

    await createAnthropicProvider().chat(
      { ...REQUEST, images: IMAGES },
      runtime('sk-ant-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'again' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
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
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));

    await createAnthropicProvider().chat(
      { ...REQUEST, messages, images: [IMAGES[0]] },
      runtime('sk-ant-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual([
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '答一' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '第二句' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        ],
      },
      { role: 'assistant', content: '答二' },
    ]);
  });

  it('images 缺省：messages 仍是旧版纯字符串形状', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));

    await createAnthropicProvider().chat(REQUEST, runtime('sk-ant-test', fake.fetch));

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual(MESSAGES_WIRE);
    expect(JSON.stringify(body.messages)).not.toContain('image');
  });

  it('images 为空数组：等同缺省，形状不变', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));

    await createAnthropicProvider().chat(
      { ...REQUEST, images: [] },
      runtime('sk-ant-test', fake.fetch),
    );

    expect(bodyOf(fake.calls[0]).messages).toEqual(MESSAGES_WIRE);
  });

  it('有图但没有任何 user 消息：整段忽略，不抛错也不造消息', async () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: '只有助手' }];
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));

    const result = await createAnthropicProvider().chat(
      { ...REQUEST, messages, images: IMAGES },
      runtime('sk-ant-test', fake.fetch),
    );

    expect(result.text).toBe('ok');
    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual([{ role: 'assistant', content: '只有助手' }]);
    expect(JSON.stringify(body.messages)).not.toContain('image');
  });

  it('chatStream 同样把图片附到最后一条 user 消息', async () => {
    const fake = fakeFetch(() =>
      sse(['data: {"type":"content_block_delta","delta":{"text":"好"}}\r\n\r\n']),
    );

    const deltas = await collect(
      createAnthropicProvider().chatStream(
        { ...REQUEST, images: IMAGES },
        runtime('sk-ant-test', fake.fetch),
      ),
    );

    expect(deltas).toEqual(['好']);
    expect(bodyOf(fake.calls[0]).messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'again' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
        ],
      },
    ]);
  });

  it('采样参数：Anthropic 只认 top_p，top_k / seed / 两个 penalty 一律不发', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));
    const provider = createAnthropicProvider();

    await provider.chat(
      { ...REQUEST, topP: 0.8, topK: 40, seed: 7, frequencyPenalty: 0.5, presencePenalty: 0.25 },
      runtime('sk-ant-test', fake.fetch),
    );
    const body = bodyOf(fake.calls[0]);
    expect(body.top_p).toBe(0.8);
    expect(['top_k', 'seed', 'frequency_penalty', 'presence_penalty'].filter((key) => key in body)).toEqual([]);

    // 0 是有效值：topP=0 仍要发上去
    await provider.chat({ ...REQUEST, topP: 0 }, runtime('sk-ant-test', fake.fetch));
    expect(bodyOf(fake.calls[1]).top_p).toBe(0);
  });

  it('深度注入的 system 消息在线缆上发成 user：Anthropic 不接受 messages[].role=system', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));
    await createAnthropicProvider().chat(
      {
        ...REQUEST,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: '记住：保持简短' },
          { role: 'user', content: 'again' },
        ],
      },
      runtime('sk-ant-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: '记住：保持简短' },
      { role: 'user', content: 'again' },
    ]);
    // 顶层 system 仍取 req.system：历史里那条只是被降级成 user，不会顶替它
    expect(body.system).toBe('SYS');
  });

  it('一个采样参数都不设时，线缆 body 与改动前逐字相同', async () => {
    const fake = fakeFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));
    await createAnthropicProvider().chat(REQUEST, runtime('sk-ant-test', fake.fetch));

    expect(String(fake.calls[0].init.body)).toBe(
      '{"model":"claude-3-5-sonnet-20241022","system":"SYS","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"},{"role":"user","content":"again"}],"max_tokens":1024,"stream":false}',
    );
  });
});
