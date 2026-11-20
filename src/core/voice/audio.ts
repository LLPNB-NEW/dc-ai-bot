import type { LlmAudio, TtsSettingsSecret, TurnAudio } from '../types';
import type { TtsSettingsStore } from '../ports';
import { resolveTimeout } from '../timeouts';
import { DEFAULT_ELEVENLABS_VOICE, elevenLabsApiRoot } from './tts';

/** ElevenLabs Music 的内置默认模型；后台留空时用它 */
export const MUSIC_MODEL_ID = 'music_v2_5';
/** 音效走 v2 的内置默认模型；后台留空时用它 */
export const SFX_MODEL_ID = 'eleven_text_to_sound_v2';
/** 变声用多语种模型的内置默认值；后台留空时用它 */
export const VOICE_CHANGER_MODEL_ID = 'eleven_multilingual_sts_v2';

export const MUSIC_MIN_MS = 3_000;
export const MUSIC_DEFAULT_MS = 60_000;
export const MUSIC_MAX_MS = 300_000;
export const MUSIC_HARD_MAX_MS = 600_000;
export const SFX_MIN_SECONDS = 0.5;
export const SFX_MAX_SECONDS = 30;
export const MUSIC_PROMPT_MAX_CHARS = 4_100;
export const MUSIC_LYRICS_MAX_CHARS = 4_000;

/** 音频工具不可用（没配 ElevenLabs、Key 空、上游报错）都归这一类；调用方只需要“这次没有音频” */
export class AudioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioUnavailableError';
  }
}

/** 一段音频工具配置；只有 dialect=elevenlabs 且 url/key 都非空才存在 */
interface AudioConfig {
  root: string;
  key: string;
  voice: string;
  musicDefaultMs: number;
  musicMaxMs: number;
  musicModel: string;
  soundEffectModel: string;
  voiceChangerModel: string;
}

export interface AudioToolPort {
  /** 当前配置能不能做音频工具；不能时调用方连工具定义都不该下发 */
  available(): Promise<boolean>;
  music(input: { prompt: string; lyrics?: string; durationSeconds?: number }): Promise<TurnAudio>;
  soundEffect(input: { prompt: string; durationSeconds?: number }): Promise<TurnAudio>;
  changeVoice(input: { source: LlmAudio }): Promise<TurnAudio>;
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

function resolveFetch(fetchImpl?: typeof fetch): FetchLike {
  return fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** 去尾斜杠，并把后台贴的 /v1 统一掉；与 TTS 共用 elevenLabsApiRoot 的规则 */
function apiRoot(url: string): string {
  return elevenLabsApiRoot(url);
}

/** 把库里的两列时长收窄到产品边界：默认不能超过上限，上限不能超过 ElevenLabs 硬上限 */
function normalizeLimits(settings: TtsSettingsSecret): { musicDefaultMs: number; musicMaxMs: number } {
  const musicMaxMs = clamp(settings.musicMaxMs, MUSIC_MIN_MS, MUSIC_HARD_MAX_MS);
  const musicDefaultMs = clamp(settings.musicDefaultMs, MUSIC_MIN_MS, musicMaxMs);
  return { musicDefaultMs, musicMaxMs };
}

async function readConfig(store: TtsSettingsStore): Promise<AudioConfig | null> {
  let settings: TtsSettingsSecret | null;
  try {
    settings = await store.get();
  } catch (error) {
    throw new AudioUnavailableError(
      'AUDIO_SETTINGS_UNAVAILABLE: ' + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (settings === null) return null;
  if (settings.dialect !== 'elevenlabs') return null;
  const url = settings.url.trim();
  const key = settings.key.trim();
  if (url === '' || key === '') return null;
  const limits = normalizeLimits(settings);
  return {
    root: apiRoot(url),
    key,
    voice: settings.voice.trim() === '' ? DEFAULT_ELEVENLABS_VOICE : settings.voice.trim(),
    ...limits,
    musicModel: settings.musicModel.trim() || MUSIC_MODEL_ID,
    soundEffectModel: settings.soundEffectModel.trim() || SFX_MODEL_ID,
    voiceChangerModel: settings.voiceChangerModel.trim() || VOICE_CHANGER_MODEL_ID,
  };
}

/** 上游报错正文可能很长（HTML 错误页），日志里只留前 200 字 */
function describeBody(body: string): string {
  return body.slice(0, 200);
}

/** 从 content-type 推一个 Discord 能预览的后缀；认不出就按 mp3 */
function extensionFor(mime: string): string {
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  if (mime === 'audio/ogg') return 'ogg';
  if (mime === 'audio/mp4' || mime === 'audio/m4a') return 'm4a';
  if (mime === 'audio/webm') return 'webm';
  return 'mp3';
}

/** 先读 text 再读字节：非 2xx 时才有原文可报；2xx 但空体按失败处理 */
async function readAudio(
  response: Response,
  kind: TurnAudio['kind'],
  prompt: string,
  baseName: string,
): Promise<TurnAudio> {
  if (!response.ok) {
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    throw new AudioUnavailableError('AUDIO_HTTP ' + String(response.status) + ': ' + describeBody(text));
  }
  const header = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  // 200 + text/html 通常是网关错误页；按失败处理，别把 HTML 当 mp3 发进 Discord
  if (header.startsWith('text/')) {
    const text = await response.text().catch(() => '');
    throw new AudioUnavailableError('AUDIO_BAD_RESPONSE: ' + describeBody(text));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new AudioUnavailableError('AUDIO_EMPTY');
  // ElevenLabs 正常都回 audio/*；如果中间层回成 application/octet-stream，按 mp3 处理而不是把它当失败
  const mime = header.startsWith('audio/') ? header : 'audio/mpeg';
  return { data: bytes, mime, name: baseName + '.' + extensionFor(mime), kind, prompt };
}

/** 音乐接口的时长：秒 -> 毫秒，夹在 row 的默认/上限之间；不传就用默认 */
function musicLengthMs(config: AudioConfig, durationSeconds?: number): number {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) return config.musicDefaultMs;
  return clamp(Math.round(durationSeconds * 1000), MUSIC_MIN_MS, config.musicMaxMs);
}

/** 音效接口的时长：不传让 ElevenLabs 自己猜；传了就夹在 0.5–30 秒 */
function sfxDuration(durationSeconds?: number): number | undefined {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) return undefined;
  return clamp(durationSeconds, SFX_MIN_SECONDS, SFX_MAX_SECONDS);
}

/**
 * 后台 TTS 那一行 -> 音频工具端口。
 * 每次调用现读一次库：后台改完，下一条消息立刻生效；没配 ElevenLabs 就抛 AUDIO_NOT_CONFIGURED。
 * 音乐 / 音效 / 变声共用同一把 Key 与同一个 base URL，避免再维护第二套密钥。
 */
export function createStoredAudio(store: TtsSettingsStore, fetchImpl?: typeof fetch): AudioToolPort {
  const doFetch = resolveFetch(fetchImpl);

  const requireConfig = async (): Promise<AudioConfig> => {
    const config = await readConfig(store);
    if (config === null) throw new AudioUnavailableError('AUDIO_NOT_CONFIGURED');
    return config;
  };

  return {
    async available(): Promise<boolean> {
      try {
        return (await readConfig(store)) !== null;
      } catch {
        return false;
      }
    },

    async music(input): Promise<TurnAudio> {
      const config = await requireConfig();
      const prompt = input.prompt.trim();
      if (prompt === '') throw new AudioUnavailableError('AUDIO_BAD_INPUT');
      const lyrics = (input.lyrics ?? '').trim();
      const body: Record<string, unknown> = {
        prompt: prompt.slice(0, MUSIC_PROMPT_MAX_CHARS),
        music_length_ms: musicLengthMs(config, input.durationSeconds),
        model_id: config.musicModel,
      };
      if (lyrics !== '') body.lyrics_text = lyrics.slice(0, MUSIC_LYRICS_MAX_CHARS);

      let response: Response;
      try {
        response = await doFetch(config.root + '/music', {
          method: 'POST',
          headers: {
            'xi-api-key': config.key,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(resolveTimeout('music')),
        });
      } catch (error) {
        throw new AudioUnavailableError(
          'AUDIO_REQUEST_FAILED: ' + (error instanceof Error ? error.message : String(error)),
        );
      }
      return readAudio(response, 'music', prompt, 'music');
    },

    async soundEffect(input): Promise<TurnAudio> {
      const config = await requireConfig();
      const prompt = input.prompt.trim();
      if (prompt === '') throw new AudioUnavailableError('AUDIO_BAD_INPUT');
      const seconds = sfxDuration(input.durationSeconds);
      const body: Record<string, unknown> = { text: prompt, model_id: config.soundEffectModel };
      if (seconds !== undefined) body.duration_seconds = seconds;

      let response: Response;
      try {
        response = await doFetch(config.root + '/sound-generation', {
          method: 'POST',
          headers: {
            'xi-api-key': config.key,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(resolveTimeout('tts')),
        });
      } catch (error) {
        throw new AudioUnavailableError(
          'AUDIO_REQUEST_FAILED: ' + (error instanceof Error ? error.message : String(error)),
        );
      }
      return readAudio(response, 'sound_effect', prompt, 'sound');
    },

    async changeVoice(input): Promise<TurnAudio> {
      const config = await requireConfig();
      if (input.source.data.byteLength === 0) throw new AudioUnavailableError('AUDIO_SOURCE_EMPTY');
      const bytes = new Uint8Array(input.source.data.byteLength);
      bytes.set(input.source.data);
      const form = new FormData();
      form.append('audio', new Blob([bytes], { type: input.source.mediaType }), input.source.filename);
      // 不写 content-type，boundary 必须由运行时生成
      form.append('model_id', config.voiceChangerModel);

      let response: Response;
      try {
        response = await doFetch(config.root + '/voice-changer/' + encodeURIComponent(config.voice), {
          method: 'POST',
          headers: { 'xi-api-key': config.key, accept: 'audio/mpeg' },
          body: form,
          signal: AbortSignal.timeout(resolveTimeout('tts')),
        });
      } catch (error) {
        throw new AudioUnavailableError(
          'AUDIO_REQUEST_FAILED: ' + (error instanceof Error ? error.message : String(error)),
        );
      }
      return readAudio(response, 'voice_change', 'voice change', 'voice-change');
    },
  };
}
