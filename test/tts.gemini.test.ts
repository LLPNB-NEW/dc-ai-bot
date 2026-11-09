import { describe, expect, it, vi } from 'vitest';
import type { TtsDialect, TtsSettingsSecret } from '../src/core/types';
import {
  createGeminiTts,
  createTts,
  createUnconfiguredTts,
  TtsUnavailableError,
  ttsConfigFrom,
} from '../src/core/voice/tts';

type FetchArgs = Parameters<typeof fetch>;

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal | null;
}

/** 记下每次请求、按 handler 返回假响应；与其它 tts 测试同一套 recorder，不改全局 fetch */
function recorder(handler: (url: string) => Response): { calls: Recorded[]; fetchImpl: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchImpl = (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      signal: init?.signal ?? null,
    });
    return Promise.resolve(handler(url));
  };
  return { calls, fetchImpl };
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(call.body) as Record<string, unknown>;
}

/** 44 字节 RIFF/WAVE 头 + 4 字节 PCM：够证明字节是原样回来的，不是从 JSON 里解出来的 */
const FAKE_WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x5d, 0x00, 0x00, 0x80, 0xbb, 0x00, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x08, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
]);

function settings(overrides: Partial<TtsSettingsSecret> = {}): TtsSettingsSecret {
  return {
    dialect: 'gemini',
    url: 'https://relay.example/pg/v1',
    key: 'sk-gemini-relay',
    model: '',
    voice: '',
    judgeUrl: '',
    judgeKey: '',
    judgeModel: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 从后台配置走到合成配置，顺带验证解析这一层，避免测试自己拼 TtsConfig 绕过 dialect 归一 */
function geminiConfig(fetchImpl: typeof fetch, voice?: string) {
  const config = ttsConfigFrom(settings(voice === undefined ? {} : { voice }), fetchImpl);
  if (config === null) throw new Error('配置不该是 null');
  return config;
}

describe('gemini 方言的解析与默认值', () => {
  it('ttsConfigFrom：dialect=gemini 落 gemini，模型补内置默认 gemini-3.8-flash-tts', () => {
    expect(ttsConfigFrom(settings({ voice: 'Kore' }))).toEqual({
      dialect: 'gemini',
      url: 'https://relay.example/pg/v1',
      key: 'sk-gemini-relay',
      model: 'gemini-3.8-flash-tts',
      voice: 'Kore',
    });
  });

  it('库里的历史 model 列不参与：填了别的模型也覆盖成内置默认', () => {
    expect(ttsConfigFrom(settings({ model: 'tts-1' }))?.model).toBe('gemini-3.8-flash-tts');
  });

  it('脏方言仍按 openai：不认识的词不会被带进运行时', () => {
    const config = ttsConfigFrom(settings({ dialect: 'legacy' as TtsDialect }));
    expect(config?.dialect).toBe('openai');
    expect(config?.model).toBe('tts-1');
  });
});

describe('createGeminiTts 的请求形状', () => {
  it('POST {url}/audio/speech：尾斜杠去掉，头和 body 照中继契约；speed 与 tag 不报错也不进 body', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(FAKE_WAV, { status: 200 }));
    const port = createTts(geminiConfig(fetchImpl));
    const bytes = await port.synthesize({ text: '晚安', speed: 120, tag: '(怅然)' });

    expect(Array.from(bytes)).toEqual(Array.from(FAKE_WAV));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://relay.example/pg/v1/audio/speech');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-gemini-relay');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(bodyOf(calls[0])).toEqual({
      model: 'gemini-3.8-flash-tts',
      input: '晚安',
      response_format: 'wav',
    });
    expect(calls[0].signal).not.toBeNull();
  });

  it('没有音色就不发 voice；配置音色兜底、单次 voice 优先、空白当没有', async () => {
    const none = recorder(() => new Response(FAKE_WAV, { status: 200 }));
    await createTts(geminiConfig(none.fetchImpl)).synthesize({ text: '晚安' });
    expect('voice' in bodyOf(none.calls[0])).toBe(false);

    const configured = recorder(() => new Response(FAKE_WAV, { status: 200 }));
    await createTts(geminiConfig(configured.fetchImpl, 'Kore')).synthesize({ text: '晚安' });
    expect(bodyOf(configured.calls[0])['voice']).toBe('Kore');

    const perCall = recorder(() => new Response(FAKE_WAV, { status: 200 }));
    await createTts(geminiConfig(perCall.fetchImpl, 'Kore')).synthesize({ text: '晚安', voice: 'Puck' });
    expect(bodyOf(perCall.calls[0])['voice']).toBe('Puck');

    const blank = recorder(() => new Response(FAKE_WAV, { status: 200 }));
    await createGeminiTts(geminiConfig(blank.fetchImpl, 'Kore')).synthesize({ text: '晚安', voice: '   ' });
    expect(bodyOf(blank.calls[0])['voice']).toBe('Kore');
  });

  it('gemini 的超时是 120 秒，openai / mimo 仍是 30 秒', async () => {
    const seen: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number): AbortSignal => {
      seen.push(ms);
      return original(ms);
    });
    try {
      const gemini = recorder(() => new Response(FAKE_WAV, { status: 200 }));
      await createTts(geminiConfig(gemini.fetchImpl)).synthesize({ text: '晚安' });
      const openai = recorder(() => new Response(FAKE_WAV, { status: 200 }));
      await createTts({ url: 'https://x/v1', key: 'k', model: 'tts-1', fetchImpl: openai.fetchImpl }).synthesize({
        text: '晚安',
      });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([120_000, 30_000]);
  });
});

describe('gemini 端口的文件形状', () => {
  it('声明 voice.wav / audio/wav；openai 与 mimo 仍是 voice.mp3 / audio/mpeg', () => {
    expect(createTts({ dialect: 'gemini', url: 'https://x/v1', key: 'k', model: 'm' }).file).toEqual({
      name: 'voice.wav',
      contentType: 'audio/wav',
    });
    // engine 把这个属性原样交给 sendFile（src/workers/gateway/engine.ts 的 send 闭包），
    // 所以这里断言的就是发送链最终拿到的文件名与 content-type。
    expect(createTts({ url: 'https://x/v1', key: 'k', model: 'tts-1' }).file).toEqual({
      name: 'voice.mp3',
      contentType: 'audio/mpeg',
    });
    expect(createTts({ dialect: 'mimo', url: 'https://x/v1', key: 'k', model: 'mimo-v2.5-tts' }).file).toEqual({
      name: 'voice.mp3',
      contentType: 'audio/mpeg',
    });
    // 占位实现没有产出，不声明形状
    expect(createUnconfiguredTts().file).toBeUndefined();
  });
});

describe('gemini 的失败路径', () => {
  it('非 2xx 抛 TtsUnavailableError，消息含状态码与上游正文', async () => {
    const { fetchImpl } = recorder(
      () => new Response(JSON.stringify({ error: { code: 'upstream', message: 'relay boom' } }), { status: 503 }),
    );
    const error = await createGeminiTts(geminiConfig(fetchImpl))
      .synthesize({ text: '晚安' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TtsUnavailableError);
    expect((error as Error).name).toBe('TtsUnavailableError');
    expect((error as Error).message).toContain('TTS_HTTP 503');
    expect((error as Error).message).toContain('relay boom');
  });

  it('超长错误页只留前 200 字', async () => {
    const { fetchImpl } = recorder(() => new Response('x'.repeat(500), { status: 500 }));
    const error = await createGeminiTts(geminiConfig(fetchImpl))
      .synthesize({ text: '晚安' })
      .catch((caught: unknown) => caught);
    const message = (error as Error).message;
    expect(message.startsWith('TTS_HTTP 500: ')).toBe(true);
    expect(message.slice('TTS_HTTP 500: '.length)).toHaveLength(200);
  });

  it('请求本身失败（断连 / 超时）也归 TtsUnavailableError，不抛裸错误', async () => {
    const failing = (): Promise<Response> => Promise.reject(new Error('socket hang up'));
    const error = await createGeminiTts({
      dialect: 'gemini',
      url: 'https://x/v1',
      key: 'k',
      model: 'gemini-3.8-flash-tts',
      fetchImpl: failing as unknown as typeof fetch,
    })
      .synthesize({ text: '晚安' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TtsUnavailableError);
    expect((error as Error).message).toContain('TTS_REQUEST_FAILED');
  });
});
