import { describe, expect, it } from 'vitest';
import type { TtsSettingsStore } from '../src/core/ports';
import type { TtsSettingsSecret } from '../src/core/types';
import { AudioUnavailableError, createStoredAudio } from '../src/core/voice/audio';

type FetchArgs = Parameters<typeof fetch>;

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

function recorder(handler: () => Response): { calls: Recorded[]; fetchImpl: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchImpl = (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body });
    return Promise.resolve(handler());
  };
  return { calls, fetchImpl };
}

function jsonBody(call: Recorded): Record<string, unknown> {
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

function settings(overrides: Partial<TtsSettingsSecret> = {}): TtsSettingsSecret {
  return {
    dialect: 'elevenlabs',
    url: 'https://api.elevenlabs.io',
    key: 'el-key',
    model: '',
    voice: 'voice-1',
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

function storeOf(secret: TtsSettingsSecret | null): TtsSettingsStore {
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

const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

function audioResponse(contentType = 'audio/mpeg'): Response {
  return new Response(AUDIO, { status: 200, headers: { 'content-type': contentType } });
}

describe('createStoredAudio 配置门槛', () => {
  it('没有行、非 elevenlabs、url/key 空都不可用', async () => {
    expect(await createStoredAudio(storeOf(null)).available()).toBe(false);
    expect(await createStoredAudio(storeOf(settings({ dialect: 'openai' }))).available()).toBe(false);
    expect(await createStoredAudio(storeOf(settings({ key: '  ' }))).available()).toBe(false);
    expect(await createStoredAudio(storeOf(settings({ url: '' }))).available()).toBe(false);
    expect(await createStoredAudio(storeOf(settings())).available()).toBe(true);
  });

  it('不可用时调用给出 AUDIO_NOT_CONFIGURED', async () => {
    const port = createStoredAudio(storeOf(null));
    await expect(port.music({ prompt: 'x' })).rejects.toMatchObject({
      name: 'AudioUnavailableError',
      message: 'AUDIO_NOT_CONFIGURED',
    });
    await expect(port.music({ prompt: 'x' })).rejects.toBeInstanceOf(AudioUnavailableError);
  });
});

describe('music', () => {
  it('POST /v1/music：默认时长、歌词、模型与 xi-api-key', async () => {
    const { calls, fetchImpl } = recorder(() => audioResponse());
    const result = await createStoredAudio(storeOf(settings()), fetchImpl).music({
      prompt: '  一首温柔的民谣  ',
      lyrics: '  月亮出来了  ',
    });

    expect(result).toMatchObject({ mime: 'audio/mpeg', name: 'music.mp3', kind: 'music', prompt: '一首温柔的民谣' });
    expect(Array.from(result.data)).toEqual(Array.from(AUDIO));
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/music');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('xi-api-key')).toBe('el-key');
    expect(jsonBody(calls[0])).toEqual({
      prompt: '一首温柔的民谣',
      lyrics_text: '月亮出来了',
      music_length_ms: 60_000,
      model_id: 'music_v2_5',
    });
  });

  it('三个音频模型都能覆盖内置默认', async () => {
    const custom = settings({
      musicModel: 'music-custom',
      soundEffectModel: 'sfx-custom',
      voiceChangerModel: 'sts-custom',
    });
    const music = recorder(() => audioResponse());
    await createStoredAudio(storeOf(custom), music.fetchImpl).music({ prompt: 'x' });
    expect(jsonBody(music.calls[0]).model_id).toBe('music-custom');

    const sfx = recorder(() => audioResponse());
    await createStoredAudio(storeOf(custom), sfx.fetchImpl).soundEffect({ prompt: 'x' });
    expect(jsonBody(sfx.calls[0]).model_id).toBe('sfx-custom');

    const change = recorder(() => audioResponse());
    await createStoredAudio(storeOf(custom), change.fetchImpl).changeVoice({
      source: { data: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg', filename: 'source.mp3' },
    });
    expect((change.calls[0].body as FormData).get('model_id')).toBe('sts-custom');
  });

  it('模型给的时长按后台上限夹住；prompt/歌词超长截断', async () => {
    const { calls, fetchImpl } = recorder(() => audioResponse());
    const port = createStoredAudio(storeOf(settings({ musicDefaultMs: 30_000, musicMaxMs: 120_000 })), fetchImpl);
    await port.music({ prompt: 'p'.repeat(4_200), lyrics: 'l'.repeat(4_200), durationSeconds: 999 });
    const body = jsonBody(calls[0]);
    expect(body.music_length_ms).toBe(120_000);
    expect(String(body.prompt)).toHaveLength(4_100);
    expect(String(body.lyrics_text)).toHaveLength(4_000);
  });

  it('URL 带 /v1 时不重复；非 audio content-type 按 mp3 命名', async () => {
    const { calls, fetchImpl } = recorder(() => audioResponse('application/octet-stream'));
    const result = await createStoredAudio(
      storeOf(settings({ url: 'https://api.elevenlabs.io/v1/' })),
      fetchImpl,
    ).music({ prompt: 'x' });
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/music');
    expect(result.mime).toBe('audio/mpeg');
    expect(result.name).toBe('music.mp3');
  });

  it('wav 响应按 wav 命名；HTTP 错误保留状态码', async () => {
    const wav = recorder(() => audioResponse('audio/wav'));
    const result = await createStoredAudio(storeOf(settings()), wav.fetchImpl).music({ prompt: 'x' });
    expect(result.name).toBe('music.wav');
    expect(result.mime).toBe('audio/wav');

    const bad = recorder(() => new Response('{"detail":"nope"}', { status: 401 }));
    await expect(createStoredAudio(storeOf(settings()), bad.fetchImpl).music({ prompt: 'x' })).rejects.toThrow(
      'AUDIO_HTTP 401',
    );
  });
});

describe('soundEffect', () => {
  it('POST /v1/sound-generation：不传时长就不带该字段；超界夹到 0.5–30', async () => {
    const none = recorder(() => audioResponse());
    await createStoredAudio(storeOf(settings()), none.fetchImpl).soundEffect({ prompt: '  雨声  ' });
    expect(jsonBody(none.calls[0])).toEqual({ text: '雨声', model_id: 'eleven_text_to_sound_v2' });

    const long = recorder(() => audioResponse());
    await createStoredAudio(storeOf(settings()), long.fetchImpl).soundEffect({ prompt: '雨声', durationSeconds: 99 });
    expect(jsonBody(long.calls[0])['duration_seconds']).toBe(30);

    const short = recorder(() => audioResponse());
    await createStoredAudio(storeOf(settings()), short.fetchImpl).soundEffect({ prompt: '雨声', durationSeconds: 0 });
    expect(jsonBody(short.calls[0])['duration_seconds']).toBe(0.5);
  });
});

describe('changeVoice', () => {
  it('POST /v1/voice-changer/{voice}：multipart 带 audio 与多语种 STS 模型', async () => {
    const { calls, fetchImpl } = recorder(() => audioResponse());
    const source = { data: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg', filename: 'source.mp3' };
    const result = await createStoredAudio(storeOf(settings()), fetchImpl).changeVoice({ source });

    expect(result).toMatchObject({ kind: 'voice_change', name: 'voice-change.mp3' });
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/voice-changer/voice-1');
    expect(calls[0].headers.get('xi-api-key')).toBe('el-key');
    expect(calls[0].headers.get('content-type')).toBeNull();
    const form = calls[0].body;
    expect(form).toBeInstanceOf(FormData);
    const body = form as FormData;
    expect(body.get('model_id')).toBe('eleven_multilingual_sts_v2');
    const file = body.get('audio');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('source.mp3');
    expect((file as File).type).toBe('audio/mpeg');
  });

  it('空源音频在发请求前就失败', async () => {
    const { calls, fetchImpl } = recorder(() => audioResponse());
    await expect(
      createStoredAudio(storeOf(settings()), fetchImpl).changeVoice({
        source: { data: new Uint8Array(), mediaType: 'audio/mpeg', filename: 'empty.mp3' },
      }),
    ).rejects.toThrow('AUDIO_SOURCE_EMPTY');
    expect(calls).toHaveLength(0);
  });
});
