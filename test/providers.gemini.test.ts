import { createGeminiProvider } from '../src/core/providers/gemini';
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
  model: 'gemini-2.5-flash',
  system: 'SYS',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ],
  temperature: 0.4,
  maxTokens: 256,
};

const CONTENTS_WIRE = [
  { role: 'user', parts: [{ text: 'hi' }] },
  { role: 'model', parts: [{ text: 'hello' }] },
  { role: 'user', parts: [{ text: 'again' }] },
];

describe('gemini provider', () => {
  it('非流式 chat：key 在 query、systemInstruction、contents 角色映射、generationConfig', async () => {
    const fake = fakeFetch(() =>
      json({
        candidates: [{ content: { parts: [{ text: '你好' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      }),
    );

    const result = await createGeminiProvider().chat(REQUEST, runtime('AIza-test', fake.fetch));

    const call = fake.calls[0];
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-test',
    );
    expect(call.init.method).toBe('POST');
    expect(headersOf(call)['content-type']).toBe('application/json');

    const body = bodyOf(call);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(body.contents).toEqual(CONTENTS_WIRE);
    expect(body.generationConfig).toEqual({ temperature: 0.4, maxOutputTokens: 256 });

    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it('自定义 baseUrl 覆盖生效（非流式与流式路径）', async () => {
    const fake = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));

    await createGeminiProvider().chat(
      REQUEST,
      runtime('AIza-test', fake.fetch, { baseUrl: 'https://gemini-proxy.test/v1beta/' }),
    );
    expect(fake.calls[0].url).toBe(
      'https://gemini-proxy.test/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-test',
    );

    const streamFake = fakeFetch(() =>
      sse(['data: {"candidates":[{"content":{"parts":[{"text":"A"}]}}]}\n\n']),
    );
    await collect(
      createGeminiProvider().chatStream(
        REQUEST,
        runtime('AIza-test', streamFake.fetch, { baseUrl: 'https://gemini-proxy.test/v1beta' }),
      ),
    );
    expect(streamFake.calls[0].url).toBe(
      'https://gemini-proxy.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=AIza-test',
    );
    expect(headersOf(streamFake.calls[0])['content-type']).toBe('application/json');
  });

  it('chatStream：逐块取 candidates[0].content.parts[0].text，缺失块跳过', async () => {
    const fake = fakeFetch(() =>
      sse([
        ': heartbeat\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}]}\n\n',
        'data: {"candidates":[]}\n\n',
        'data: {oops}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"好"}]},"finishReason":null}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"呀"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    );

    const deltas = await collect(
      createGeminiProvider().chatStream(REQUEST, runtime('AIza-test', fake.fetch)),
    );

    expect(deltas).toEqual(['你', '好', '呀']);
    const body = bodyOf(fake.calls[0]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(body.contents).toEqual(CONTENTS_WIRE);
  });

  it('chatStream：正文为空但带 finishReason 的帧也要 yield 出来', async () => {
    const fake = fakeFetch(() =>
      sse([
        'data: {"candidates":[{"content":{"parts":[{"text":"前半"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":4}}\n\n',
      ]),
    );

    const chunks = await collectChunks(
      createGeminiProvider().chatStream(REQUEST, runtime('AIza-test', fake.fetch)),
    );

    expect(chunks).toEqual([{ delta: '前半' }, { delta: '', finishReason: 'STOP' }]);
  });

  it('chatStream：非流式退化路径按正常收尾 yield finishReason=stop', async () => {
    const fake = fakeFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: '整段文本' }] } }] }),
    );

    const chunks = await collectChunks(
      createGeminiProvider().chatStream(REQUEST, runtime('AIza-test', fake.fetch)),
    );

    expect(chunks).toEqual([{ delta: '整段文本', finishReason: 'stop' }]);
  });

  it('chatStream：响应头非 event-stream 时退化为一次性 yield', async () => {
    const fake = fakeFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: '整段文本' }] } }] }),
    );

    const deltas = await collect(
      createGeminiProvider().chatStream(REQUEST, runtime('AIza-test', fake.fetch)),
    );

    expect(deltas).toEqual(['整段文本']);
  });

  it('非 2xx 归一为 provider+status，body 截断到 300', async () => {
    const { payload, expected } = longBody();
    const fake = fakeFetch(() => new Response(payload, { status: 500 }));

    const error = await failure(
      createGeminiProvider().chat(REQUEST, runtime('AIza-test', fake.fetch)),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('gemini HTTP 500: ' + expected);
    expect(error.message).toHaveLength('gemini HTTP 500: '.length + 300);
  });

  it('chatStream：流里的错误帧抛错（code 是数字状态码）', async () => {
    const fake = fakeFetch(() =>
      sse(['data: {"error":{"code":400,"message":"bad"}}\n\n', 'data: [DONE]\n\n']),
    );

    const error = await failure(
      collect(createGeminiProvider().chatStream(REQUEST, runtime('AIza-test', fake.fetch))),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('gemini: 400: bad');
  });

  it('listModels：models[].name 去掉 models/ 前缀', async () => {
    const fake = fakeFetch(() =>
      json({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] }),
    );

    const models = await createGeminiProvider().listModels(runtime('AIza-test', fake.fetch));

    expect(fake.calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=AIza-test',
    );
    expect(fake.calls[0].init.method).toBe('GET');
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });
});

const IMAGES: LlmImage[] = [
  { mediaType: 'image/png', base64: 'QUJD' },
  { mediaType: 'image/jpeg', base64: 'REVG' },
];

describe('gemini provider — §22.3 本轮附图', () => {
  it('有图：2 张图按数组顺序变成 inlineData 附到最后一条 user 消息，文字在前', async () => {
    const fake = fakeFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await createGeminiProvider().chat({ ...REQUEST, images: IMAGES }, runtime('AIza-test', fake.fetch));

    const body = bodyOf(fake.calls[0]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      {
        role: 'user',
        parts: [
          { text: 'again' },
          { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
          { inlineData: { mimeType: 'image/jpeg', data: 'REVG' } },
        ],
      },
    ]);
  });

  it('有图：目标未必是数组最后一条，role 映射不变（user/model）', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '答二' },
    ];
    const fake = fakeFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await createGeminiProvider().chat(
      { ...REQUEST, messages, images: [IMAGES[0]] },
      runtime('AIza-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: '第一句' }] },
      { role: 'model', parts: [{ text: '答一' }] },
      {
        role: 'user',
        parts: [{ text: '第二句' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }],
      },
      { role: 'model', parts: [{ text: '答二' }] },
    ]);
  });

  it('images 缺省：parts 仍只有 [{text}]', async () => {
    const fake = fakeFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await createGeminiProvider().chat(REQUEST, runtime('AIza-test', fake.fetch));

    const body = bodyOf(fake.calls[0]);
    expect(body.contents).toEqual(CONTENTS_WIRE);
    expect(JSON.stringify(body.contents)).not.toContain('inlineData');
  });

  it('images 为空数组：等同缺省，形状不变', async () => {
    const fake = fakeFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await createGeminiProvider().chat(
      { ...REQUEST, images: [] },
      runtime('AIza-test', fake.fetch),
    );

    expect(bodyOf(fake.calls[0]).contents).toEqual(CONTENTS_WIRE);
  });

  it('有图但没有任何 user 消息：整段忽略，不抛错也不造消息', async () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: '只有助手' }];
    const fake = fakeFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    const result = await createGeminiProvider().chat(
      { ...REQUEST, messages, images: IMAGES },
      runtime('AIza-test', fake.fetch),
    );

    expect(result.text).toBe('ok');
    const body = bodyOf(fake.calls[0]);
    expect(body.contents).toEqual([{ role: 'model', parts: [{ text: '只有助手' }] }]);
    expect(JSON.stringify(body.contents)).not.toContain('inlineData');
  });

  it('chatStream 同样把图片附到最后一条 user 消息', async () => {
    const fake = fakeFetch(() =>
      sse(['data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}\n\n']),
    );

    const deltas = await collect(
      createGeminiProvider().chatStream(
        { ...REQUEST, images: IMAGES },
        runtime('AIza-test', fake.fetch),
      ),
    );

    expect(deltas).toEqual(['好']);
    expect(bodyOf(fake.calls[0]).contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      {
        role: 'user',
        parts: [
          { text: 'again' },
          { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
          { inlineData: { mimeType: 'image/jpeg', data: 'REVG' } },
        ],
      },
    ]);
  });

  it('采样参数：generationConfig 里带 topP / topK / seed / frequencyPenalty / presencePenalty', async () => {
    const fake = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const provider = createGeminiProvider();

    await provider.chat(
      { ...REQUEST, topP: 0.8, topK: 40, seed: 7, frequencyPenalty: 0.5, presencePenalty: 0.25 },
      runtime('AIza-test', fake.fetch),
    );
    expect(bodyOf(fake.calls[0]).generationConfig).toEqual({
      temperature: 0.4,
      maxOutputTokens: 256,
      topP: 0.8,
      topK: 40,
      seed: 7,
      frequencyPenalty: 0.5,
      presencePenalty: 0.25,
    });

    // 0 是有效值：topK=1、seed=0 都要留在配置里
    await provider.chat({ ...REQUEST, topK: 1, seed: 0 }, runtime('AIza-test', fake.fetch));
    expect(bodyOf(fake.calls[1]).generationConfig).toEqual({ temperature: 0.4, maxOutputTokens: 256, topK: 1, seed: 0 });
  });

  it('深度注入的 system 消息映射成 user：Gemini 的 contents 只认 user / model', async () => {
    const fake = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    await createGeminiProvider().chat(
      {
        ...REQUEST,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: '记住：保持简短' },
          { role: 'user', content: 'again' },
        ],
      },
      runtime('AIza-test', fake.fetch),
    );

    const body = bodyOf(fake.calls[0]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'user', parts: [{ text: '记住：保持简短' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
    // 顶层 systemInstruction 仍是 req.system
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
  });

  it('一个采样参数都不设时，线缆 body 与改动前逐字相同', async () => {
    const fake = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    await createGeminiProvider().chat(REQUEST, runtime('AIza-test', fake.fetch));

    expect(String(fake.calls[0].init.body)).toBe(
      '{"systemInstruction":{"parts":[{"text":"SYS"}]},"contents":[{"role":"user","parts":[{"text":"hi"}]},{"role":"model","parts":[{"text":"hello"}]},{"role":"user","parts":[{"text":"again"}]}],"generationConfig":{"temperature":0.4,"maxOutputTokens":256}}',
    );
  });
});
