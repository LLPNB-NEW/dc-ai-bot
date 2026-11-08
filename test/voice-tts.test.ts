import { describe, expect, it } from 'vitest';
import type { TtsSettingsStore } from '../src/core/ports';
import type { TtsSettingsSecret } from '../src/core/types';
import {
  TtsUnavailableError,
  createMimoTts,
  createOpenAiTts,
  createStoredTts,
  createTts,
  createUnconfiguredTts,
  ttsConfigFrom,
} from '../src/core/voice/tts';

type FetchArgs = Parameters<typeof fetch>;

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** 记下每次请求，按 handler 返回假响应；不改全局 fetch，workerd 里也不该改 */
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

/** MiMo 的响应形状：音频是 JSON 里 base64 的 choices[0].message.audio.data */
function mimoResponse(data: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { audio: { data } } }] }), { status: 200 });
}

const MIMO_TEXT_BASE64 = btoa('ID3xyz');

describe('createUnconfiguredTts', () => {
  it('合成即抛 TTS_NOT_CONFIGURED（装配期绝不抛）', async () => {
    const tts = createUnconfiguredTts();
    await expect(tts.synthesize({ text: '你好' })).rejects.toThrow('TTS_NOT_CONFIGURED');
    await expect(tts.synthesize({ text: '你好' })).rejects.toBeInstanceOf(TtsUnavailableError);
  });
});

/** 只有 get 会被合成的路径调用：put/remove 在这里只为凑齐端口形状 */
function storedSettings(secret: TtsSettingsSecret | null): TtsSettingsStore {
  return {
    async get(): Promise<TtsSettingsSecret | null> {
      return secret;
    },
    put() {
      return Promise.reject(new Error('NOT_USED'));
    },
    remove() {
      return Promise.reject(new Error('NOT_USED'));
    },
  };
}

const fullSettings: TtsSettingsSecret = {
  dialect: 'openai',
  url: 'https://tts.example/v1/',
  key: 'sk-tts',
  model: '',
  voice: '',
  judgeUrl: '',
  judgeKey: '',
  judgeModel: '',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ttsConfigFrom', () => {
  it('url 或 key 空白都算未配置；模型按方言内置默认（库里 model 不再生效）；voice 空就不带', () => {
    expect(ttsConfigFrom({ ...fullSettings, url: '  ' })).toBeNull();
    expect(ttsConfigFrom({ ...fullSettings, key: '  ' })).toBeNull();
    const config = ttsConfigFrom(fullSettings);
    expect(config?.dialect).toBe('openai');
    expect(config?.model).toBe('tts-1');
    // 库里的 model 是历史列：契约规定运行时一律忽略它，模型不暴露也不可改
    expect(ttsConfigFrom({ ...fullSettings, model: 'tts-1-hd' })?.model).toBe('tts-1');
    expect('voice' in (config ?? {})).toBe(false);
  });

  it('mimo 方言：model 缺省 mimo-v2.5-tts，方言原样带出', () => {
    const config = ttsConfigFrom({ ...fullSettings, dialect: 'mimo' });
    expect(config?.dialect).toBe('mimo');
    expect(config?.model).toBe('mimo-v2.5-tts');
  });
});

describe('createStoredTts', () => {
  it('库里没有配置就抛 TTS_NOT_CONFIGURED（装配期不抛）', async () => {
    const tts = createStoredTts(storedSettings(null));
    await expect(tts.synthesize({ text: '你好' })).rejects.toBeInstanceOf(TtsUnavailableError);
    await expect(tts.synthesize({ text: '你好' })).rejects.toThrow('TTS_NOT_CONFIGURED');
  });

  it('每次合成现读一次库：按 OpenAI 形状发出去，模型缺省 tts-1', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const tts = createStoredTts(storedSettings(fullSettings), fetchImpl);
    const audio = await tts.synthesize({ text: '你好' });
    expect(audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0]?.url).toBe('https://tts.example/v1/audio/speech');
    expect(bodyOf(calls[0] as Recorded)['model']).toBe('tts-1');
  });

  it('库里是 mimo 就走 chat/completions，并把 base64 解成字节', async () => {
    const { calls, fetchImpl } = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    const tts = createStoredTts(storedSettings({ ...fullSettings, dialect: 'mimo' }), fetchImpl);
    const audio = await tts.synthesize({ text: '你好' });
    expect(audio).toEqual(new TextEncoder().encode('ID3xyz'));
    expect(calls[0]?.url).toBe('https://tts.example/v1/chat/completions');
    expect(bodyOf(calls[0] as Recorded)['model']).toBe('mimo-v2.5-tts');
  });

  it('读库失败也归到 TtsUnavailableError（语音失败不许拖住回复）', async () => {
    const tts = createStoredTts({
      get() {
        return Promise.reject(new Error('d1 down'));
      },
      put() {
        return Promise.reject(new Error('NOT_USED'));
      },
      remove() {
        return Promise.reject(new Error('NOT_USED'));
      },
    });
    await expect(tts.synthesize({ text: 'x' })).rejects.toThrow('TTS_SETTINGS_UNAVAILABLE: d1 down');
  });
});

describe('createOpenAiTts', () => {
  it('URL 末尾斜杠先去掉再补 /audio/speech', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([0]), { status: 200 }));
    const tts = createOpenAiTts({ url: 'https://tts.example/v1///', key: 'secret', model: 'tts-1-hd', fetchImpl });
    await tts.synthesize({ text: '你好' });
    expect(calls[0]?.url).toBe('https://tts.example/v1/audio/speech');
  });

  it('请求体字段与 speed 换算：100 存的是百分比，发出去是 1', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([0]), { status: 200 }));
    const tts = createOpenAiTts({ url: 'https://tts.example/v1', key: 'secret', model: 'tts-1', fetchImpl });
    await tts.synthesize({ text: '晚安', voice: 'nova', speed: 120 });

    const call = calls[0] as Recorded;
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer secret');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(bodyOf(call)).toEqual({ model: 'tts-1', input: '晚安', voice: 'nova', response_format: 'mp3', speed: 1.2 });
  });

  it('单次 voice 优先于配置音色；两边都没有就不带 voice 字段', async () => {
    const a = recorder(() => new Response(new Uint8Array([0]), { status: 200 }));
    await createOpenAiTts({ url: 'https://tts.example/v1', key: 'k', model: 'tts-1', voice: 'alloy', fetchImpl: a.fetchImpl })
      .synthesize({ text: 'x', voice: 'nova' });
    expect(bodyOf(a.calls[0] as Recorded)['voice']).toBe('nova');

    const b = recorder(() => new Response(new Uint8Array([0]), { status: 200 }));
    await createOpenAiTts({ url: 'https://tts.example/v1', key: 'k', model: 'tts-1', fetchImpl: b.fetchImpl })
      .synthesize({ text: 'x' });
    expect('voice' in bodyOf(b.calls[0] as Recorded)).toBe(false);
  });

  it('speed 越界回落到 100（发 1.0）', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([0]), { status: 200 }));
    await createOpenAiTts({ url: 'https://tts.example/v1', key: 'k', model: 'tts-1', fetchImpl }).synthesize({
      text: 'x',
      speed: 500,
    });
    expect(bodyOf(calls[0] as Recorded)['speed']).toBe(1);
  });

  it('非 2xx 抛 TtsUnavailableError，消息带状态码与截断正文', async () => {
    const { fetchImpl } = recorder(() => new Response('upstream exploded', { status: 502 }));
    const tts = createOpenAiTts({ url: 'https://tts.example/v1', key: 'k', model: 'tts-1', fetchImpl });
    await expect(tts.synthesize({ text: 'x' })).rejects.toBeInstanceOf(TtsUnavailableError);
    await expect(tts.synthesize({ text: 'x' })).rejects.toThrow('TTS_HTTP 502: upstream exploded');
  });

  it('fetch 本身失败也包成 TtsUnavailableError', async () => {
    const failing = (): Promise<Response> => Promise.reject(new Error('socket hang up'));
    const tts = createOpenAiTts({ url: 'https://tts.example/v1', key: 'k', model: 'tts-1', fetchImpl: failing });
    await expect(tts.synthesize({ text: 'x' })).rejects.toThrow('TTS_REQUEST_FAILED: socket hang up');
  });
});

describe('createMimoTts', () => {
  it('URL 末尾斜杠先去掉再补 /chat/completions；body 按 MiMo 形状且没有 speed', async () => {
    const { calls, fetchImpl } = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    const tts = createMimoTts({
      url: 'https://api.xiaomimimo.com/v1///',
      key: 'secret',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      fetchImpl,
    });
    await tts.synthesize({ text: '晚安', speed: 150 });

    const call = calls[0] as Recorded;
    expect(call.url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer secret');
    expect(bodyOf(call)).toEqual({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: '晚安' }],
      audio: { format: 'mp3', voice: '冰糖' },
    });
    // MiMo 没有语速参数：调用方给了也不能出现在 body 里
    expect('speed' in bodyOf(call)).toBe(false);
  });

  it('单次 voice 优先于配置音色；都没有时 audio 里只给 format', async () => {
    const a = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    await createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', voice: '茉莉', fetchImpl: a.fetchImpl })
      .synthesize({ text: 'x', voice: '苏打' });
    expect(bodyOf(a.calls[0] as Recorded)['audio']).toEqual({ format: 'mp3', voice: '苏打' });

    const b = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    await createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl: b.fetchImpl })
      .synthesize({ text: 'x' });
    expect(bodyOf(b.calls[0] as Recorded)['audio']).toEqual({ format: 'mp3' });
  });

  it('响应 JSON 里的 base64 解成字节（不用 Buffer 也成立）', async () => {
    const { fetchImpl } = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    const tts = createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl });
    await expect(tts.synthesize({ text: 'x' })).resolves.toEqual(new TextEncoder().encode('ID3xyz'));
  });

  it('非 2xx 抛 TTS_HTTP，消息带状态码与截断正文', async () => {
    const { fetchImpl } = recorder(() => new Response('mimo exploded', { status: 502 }));
    const tts = createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl });
    await expect(tts.synthesize({ text: 'x' })).rejects.toBeInstanceOf(TtsUnavailableError);
    await expect(tts.synthesize({ text: 'x' })).rejects.toThrow('TTS_HTTP 502: mimo exploded');
  });

  it('响应没有 audio.data 抛 TTS_BAD_RESPONSE', async () => {
    const { fetchImpl } = recorder(
      () => new Response(JSON.stringify({ choices: [{ message: { audio: {} } }] }), { status: 200 }),
    );
    const tts = createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl });
    await expect(tts.synthesize({ text: 'x' })).rejects.toBeInstanceOf(TtsUnavailableError);
    await expect(tts.synthesize({ text: 'x' })).rejects.toThrow('TTS_BAD_RESPONSE');
  });

  it('响应不是 JSON 也抛 TTS_BAD_RESPONSE', async () => {
    const { fetchImpl } = recorder(() => new Response('not json at all', { status: 200 }));
    const tts = createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl });
    await expect(tts.synthesize({ text: 'x' })).rejects.toThrow('TTS_BAD_RESPONSE');
  });
});

describe('createTts', () => {
  it('按 dialect 分派：mimo 打 /chat/completions，省略方言时仍打 /audio/speech', async () => {
    const mimo = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    await createTts({ dialect: 'mimo', url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl: mimo.fetchImpl })
      .synthesize({ text: 'x' });
    expect(mimo.calls[0]?.url).toBe('https://api.xiaomimimo.com/v1/chat/completions');

    const openai = recorder(() => new Response(new Uint8Array([1]), { status: 200 }));
    await createTts({ url: 'https://tts.example/v1', key: 'k', model: 'tts-1', fetchImpl: openai.fetchImpl })
      .synthesize({ text: 'x' });
    expect(openai.calls[0]?.url).toBe('https://tts.example/v1/audio/speech');
  });
});
