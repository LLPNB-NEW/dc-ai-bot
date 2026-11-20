import { describe, expect, it } from 'vitest';
import type { TtsDialect, TtsSettingsSecret } from '../src/core/types';
import {
  DEFAULT_ELEVENLABS_VOICE,
  TtsUnavailableError,
  createElevenLabsTts,
  createTts,
  elevenLabsApiRoot,
  ttsConfigFrom,
} from '../src/core/voice/tts';

type FetchArgs = Parameters<typeof fetch>;

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function recorder(handler: () => Response): { calls: Recorded[]; fetchImpl: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchImpl = (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(handler());
  };
  return { calls, fetchImpl };
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(call.body) as Record<string, unknown>;
}

function settings(overrides: Partial<TtsSettingsSecret> = {}): TtsSettingsSecret {
  return {
    dialect: 'elevenlabs',
    url: 'https://api.elevenlabs.io',
    key: 'el-key',
    model: '',
    voice: '',
    musicDefaultMs: 60_000,
    musicMaxMs: 300_000,
    musicModel: '',
    soundEffectModel: '',
    voiceChangerModel: '',
    judgeUrl: '',
    judgeKey: '',
    judgeModel: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function configOf(fetchImpl: typeof fetch, overrides: Partial<TtsSettingsSecret> = {}) {
  const config = ttsConfigFrom(settings(overrides), fetchImpl);
  if (config === null) throw new Error('配置不该是 null');
  return config;
}

describe('ElevenLabs 方言解析', () => {
  it('ttsConfigFrom 认出 elevenlabs，模型内置 multilingual_v2，voice 原样带出', () => {
    expect(ttsConfigFrom(settings({ voice: 'voice-id' }))).toEqual({
      dialect: 'elevenlabs',
      url: 'https://api.elevenlabs.io',
      key: 'el-key',
      model: 'eleven_multilingual_v2',
      voice: 'voice-id',
    });
  });

  it('库里的 model 可以覆盖默认；脏方言仍落回 openai', () => {
    expect(ttsConfigFrom(settings({ model: 'custom-model' }))?.model).toBe('custom-model');
    expect(ttsConfigFrom(settings({ dialect: 'legacy' as TtsDialect }))?.dialect).toBe('openai');
  });

  it('api root 不会拼出 /v1/v1', () => {
    expect(elevenLabsApiRoot('https://api.elevenlabs.io///')).toBe('https://api.elevenlabs.io/v1');
    expect(elevenLabsApiRoot('https://api.elevenlabs.io/v1/')).toBe('https://api.elevenlabs.io/v1');
  });
});

describe('createElevenLabsTts 请求形状', () => {
  it('POST {root}/text-to-speech/{voice}，xi-api-key，body 只有 text/model_id', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const bytes = await createTts(configOf(fetchImpl, { voice: 'my-voice' })).synthesize({
      text: '晚安',
      speed: 120,
      tag: '(怅然)',
    });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/my-voice');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('xi-api-key')).toBe('el-key');
    expect(calls[0].headers.get('authorization')).toBeNull();
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(bodyOf(calls[0])).toEqual({ text: '晚安', model_id: 'eleven_multilingual_v2' });
  });

  it('voice 留空用 Rachel，单次 voice 优先，空白当没有', async () => {
    const none = recorder(() => new Response(new Uint8Array([1]), { status: 200 }));
    await createTts(configOf(none.fetchImpl)).synthesize({ text: '晚安' });
    expect(none.calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/' + DEFAULT_ELEVENLABS_VOICE);

    const perCall = recorder(() => new Response(new Uint8Array([1]), { status: 200 }));
    await createTts(configOf(perCall.fetchImpl, { voice: 'configured' })).synthesize({
      text: '晚安',
      voice: 'per-call',
    });
    expect(perCall.calls[0].url).toContain('/text-to-speech/per-call');

    const blank = recorder(() => new Response(new Uint8Array([1]), { status: 200 }));
    await createTts(configOf(blank.fetchImpl, { voice: 'configured' })).synthesize({
      text: '晚安',
      voice: '   ',
    });
    expect(blank.calls[0].url).toContain('/text-to-speech/configured');
  });

  it('base URL 已经带 /v1 时不再重复；voice 会做 URL 编码', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([1]), { status: 200 }));
    await createElevenLabsTts({
      dialect: 'elevenlabs',
      url: 'https://api.elevenlabs.io/v1/',
      key: 'k',
      model: 'eleven_multilingual_v2',
      voice: 'a/b',
      fetchImpl,
    }).synthesize({ text: '你好' });
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/a%2Fb');
  });

  it('文件声明 voice.mp3 / audio/mpeg', () => {
    expect(createTts({ dialect: 'elevenlabs', url: 'https://x', key: 'k', model: 'm' }).file).toEqual({
      name: 'voice.mp3',
      contentType: 'audio/mpeg',
    });
  });

  it('非 2xx 抛 TtsUnavailableError，保留状态码与正文', async () => {
    const { fetchImpl } = recorder(
      () => new Response(JSON.stringify({ detail: { message: 'bad key' } }), { status: 401 }),
    );
    await expect(createTts(configOf(fetchImpl)).synthesize({ text: '晚安' })).rejects.toMatchObject({
      name: 'TtsUnavailableError',
      message: expect.stringContaining('TTS_HTTP 401'),
    });
    await expect(createTts(configOf(fetchImpl)).synthesize({ text: '晚安' })).rejects.toBeInstanceOf(
      TtsUnavailableError,
    );
  });
});
