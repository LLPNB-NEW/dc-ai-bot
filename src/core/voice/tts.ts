import type { TtsDialect, TtsSettingsSecret } from '../types';
import type { TtsSettingsStore } from '../ports';
import { isVoiceSpeed, VOICE_SPEED_DEFAULT } from './settings';
import { resolveTimeout } from '../timeouts';

/** 语音合成端口：输入一段要说的话，输出音频字节。谁调用谁决定要不要发出去。 */
export interface TtsPort {
  /**
   * tag 是本条语音的语气标签，形如 (怅然)（normalizeStyleTag 的产物，空串 = 没有语气）。
   * 只有 mimo 方言能表达它：贴在 assistant 消息最前面；openai / gemini 方言没有对应参数，会忽略。
   */
  synthesize(input: { text: string; voice?: string; speed?: number; tag?: string }): Promise<Uint8Array>;
  /**
   * 这个端口产出的文件形状：调用方据此决定附件文件名与 content-type。
   * 省略时调用方按自己的默认值处理（占位实现与只在内存里转发的实现没有产出，不需要声明）。
   */
  file?: { name: string; contentType: string };
}

/**
 * 合成失败（没配置、上游报错、超时）都归这一类。
 * 语音是锦上添花，调用方只需要「这次不发了」，不需要区分失败原因去改回复。
 */
export class TtsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsUnavailableError';
  }
}

/** 没配 TTS 时装配的占位实现：被调用才报错，装配期绝不抛（缺配置不该挡住部署） */
export function createUnconfiguredTts(): TtsPort {
  return {
    async synthesize(): Promise<Uint8Array> {
      throw new TtsUnavailableError('TTS_NOT_CONFIGURED');
    },
  };
}

/** 方言缺 model 时各自的默认模型：与后台展示的默认值同一口径，前端不抄常量 */
const DEFAULT_MODEL: Record<TtsDialect, string> = {
  openai: 'tts-1',
  mimo: 'mimo-v2.5-tts',
  gemini: 'gemini-3.8-flash-tts',
};

/**
 * 后台配置 -> 合成配置：url 或 key 空白都算未配置（返回 null）。
 * 后台是 TTS 的唯一来源，这里就是「一份配置怎么变成请求参数」的唯一规则；
 * dialect 决定请求形状，也决定 model 留空时补哪个默认值。
 */
export function ttsConfigFrom(settings: TtsSettingsSecret, fetchImpl?: typeof fetch): TtsConfig | null {
  const url = settings.url.trim();
  const key = settings.key.trim();
  if (url === '' || key === '') return null;
  // 库里只有三个合法值，脏数据一律按 openai（与仓储读侧同一口径）
  const dialect: TtsDialect =
    settings.dialect === 'mimo' ? 'mimo' : settings.dialect === 'gemini' ? 'gemini' : 'openai';
  // 模型不再由后台决定：一律按方言取内置默认，库里的 model 列只留作历史数据
  const voice = settings.voice.trim();
  const config: TtsConfig = { dialect, url, key, model: DEFAULT_MODEL[dialect] };
  if (voice !== '') config.voice = voice;
  if (fetchImpl !== undefined) config.fetchImpl = fetchImpl;
  return config;
}

/**
 * 仓储 -> 端口：每次合成现读一次库，后台改完下一条立刻生效，进程里不缓存明文。
 * 没配置就按「合成即抛」处理，与占位实现同一口径；读库失败也归到这一类（语音只是附加项）。
 */
export function createStoredTts(store: TtsSettingsStore, fetchImpl?: typeof fetch): TtsPort {
  return {
    async synthesize(input: {
      text: string;
      voice?: string;
      speed?: number;
      tag?: string;
    }): Promise<Uint8Array> {
      let settings: TtsSettingsSecret | null;
      try {
        settings = await store.get();
      } catch (error) {
        throw new TtsUnavailableError(
          'TTS_SETTINGS_UNAVAILABLE: ' + (error instanceof Error ? error.message : String(error)),
        );
      }
      if (settings === null) throw new TtsUnavailableError('TTS_NOT_CONFIGURED');
      const config = ttsConfigFrom(settings, fetchImpl);
      if (config === null) throw new TtsUnavailableError('TTS_NOT_CONFIGURED');
      return createTts(config).synthesize(input);
    },
  };
}

/** 一份合成配置：dialect 决定往哪儿发、body 长什么样，其余字段三种方言共用 */
export interface TtsConfig {
  /** 省略按 openai：只关心 OpenAI 形状的调用方不必被迫写这个字段 */
  dialect?: TtsDialect;
  /** 服务根地址（不带具体接口路径，末尾斜杠可有可无） */
  url: string;
  key: string;
  model: string;
  /** 默认音色；单次调用传了 voice 时以单次为准 */
  voice?: string;
  fetchImpl?: typeof fetch;
}

// 合成超时都走 core/timeouts：默认 30 秒，gemini 那条默认 120 秒（整段音频合成完才回），
// 两项都能在后台「超时」页改，也可能被全局倍率一起放大。

/** 去尾斜杠：后台常常把地址贴成末尾带斜杠的样子，两种方言共用这一段 */
function trimTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/u, '');
}

/** OpenAI 形状的接口路径 */
function speechUrl(url: string): string {
  return trimTrailingSlash(url) + '/audio/speech';
}

/** MiMo 的接口路径：和 OpenAI 的 chat 接口同形，但返回 JSON 而不是音频字节 */
function chatCompletionsUrl(url: string): string {
  return trimTrailingSlash(url) + '/chat/completions';
}

/** 上游报错的正文可能很长（HTML 错误页），日志里只留前 200 字 */
function describeBody(body: string): string {
  return body.slice(0, 200);
}

/** 没注入 fetchImpl 时才走全局 fetch：测试因此不必改全局，宿主也能换成自己的实现 */
type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

function resolveFetch(fetchImpl?: typeof fetch): FetchLike {
  return fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
}

/**
 * base64 -> 字节：用 atob 而不是 Buffer —— core 也要能跑在 workerd 上，Node 专有 API 在那里不存在。
 * atob 给的是「每字符一字节」的二进制串，逐字符塞进 Uint8Array。
 */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 只把真正的对象当前进：数组、null、标量都不算「有这一层」，缺层与类型不对同样按没有处理 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 取 choices[0].message.audio.data；缺任何一层都返回 null（结构照官方文档，不猜别的字段名） */
function readMimoAudioData(payload: unknown): string | null {
  const root = asRecord(payload);
  if (root === null) return null;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = asRecord(asRecord(choices[0])?.['message']);
  if (message === null) return null;
  const audio = asRecord(message['audio']);
  if (audio === null) return null;
  const data = audio['data'];
  return typeof data === 'string' && data !== '' ? data : null;
}

/**
 * OpenAI 形状的 TTS：POST {url}/audio/speech，body 里 speed 是倍数（我们存的是百分比），
 * voice 传了就用传的、否则用配置的、都没有就不带这个字段（让服务端用它的默认音色）。
 */
export function createOpenAiTts(config: TtsConfig): TtsPort {
  const doFetch = resolveFetch(config.fetchImpl);
  const defaultVoice = config.voice !== undefined && config.voice.trim() !== '' ? config.voice : undefined;

  return {
    file: { name: 'voice.mp3', contentType: 'audio/mpeg' },
    async synthesize(input: {
      text: string;
      voice?: string;
      speed?: number;
      tag?: string;
    }): Promise<Uint8Array> {
      // /audio/speech 没有语气标签参数：tag 在这里被主动忽略（不是漏传），
      // 语气只能由音色与文案本身承担，硬塞进 input 反而会被念出来。
      const requested = input.voice !== undefined && input.voice.trim() !== '' ? input.voice : undefined;
      const voice = requested ?? defaultVoice;
      const speed = input.speed !== undefined && isVoiceSpeed(input.speed) ? input.speed : VOICE_SPEED_DEFAULT;

      const body: Record<string, unknown> = {
        model: config.model,
        input: input.text,
        response_format: 'mp3',
        speed: speed / 100,
      };
      if (voice !== undefined) body.voice = voice;

      let response: Response;
      try {
        response = await doFetch(speechUrl(config.url), {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + config.key,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(resolveTimeout('tts')),
        });
      } catch (error) {
        throw new TtsUnavailableError('TTS_REQUEST_FAILED: ' + (error instanceof Error ? error.message : String(error)));
      }

      if (!response.ok) {
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        throw new TtsUnavailableError('TTS_HTTP ' + String(response.status) + ': ' + describeBody(text));
      }

      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * 小米 MiMo 的 TTS：POST {url}/chat/completions，要念的文字放在 assistant 消息里，
 * 音频是响应 JSON 里 base64 编码的 choices[0].message.audio.data。
 * 官方形状是「标签 + 正文」同在一条 assistant 消息里，标签只标语气不会被念出来。
 * 它没有 speed 参数（语速只能由音色带），所以单次调用的 speed 在这里被忽略，body 里也不出现。
 */
export function createMimoTts(config: TtsConfig): TtsPort {
  const doFetch = resolveFetch(config.fetchImpl);
  const defaultVoice = config.voice !== undefined && config.voice.trim() !== '' ? config.voice : undefined;

  return {
    file: { name: 'voice.mp3', contentType: 'audio/mpeg' },
    async synthesize(input: {
      text: string;
      voice?: string;
      speed?: number;
      tag?: string;
    }): Promise<Uint8Array> {
      const requested = input.voice !== undefined && input.voice.trim() !== '' ? input.voice : undefined;
      const voice = requested ?? defaultVoice;
      // voice 空白就只给 format：让服务端用自己的默认音色，而不是发一个空串过去
      const audio: Record<string, unknown> = { format: 'mp3' };
      if (voice !== undefined) audio.voice = voice;
      // 官方文档：语气标签与朗读文本同放 assistant 消息，标签在前、正文在后。
      // 没有标签时 content 就是正文，线缆形状与旧版无语气时完全一致。
      const tag = input.tag === undefined ? '' : input.tag.trim();
      const messages: Array<{ role: 'assistant'; content: string }> = [
        { role: 'assistant', content: tag === '' ? input.text : tag + input.text },
      ];
      const body = { model: config.model, messages, audio };

      let response: Response;
      try {
        response = await doFetch(chatCompletionsUrl(config.url), {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + config.key,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(resolveTimeout('tts')),
        });
      } catch (error) {
        throw new TtsUnavailableError('TTS_REQUEST_FAILED: ' + (error instanceof Error ? error.message : String(error)));
      }

      // 先读 text 再 parse：失败时才有原文可报（response.json() 的报错不带正文）
      let text = '';
      try {
        text = await response.text();
      } catch {
        text = '';
      }
      if (!response.ok) {
        throw new TtsUnavailableError('TTS_HTTP ' + String(response.status) + ': ' + describeBody(text));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new TtsUnavailableError(
          'TTS_BAD_RESPONSE: 响应不是 JSON（' +
            (error instanceof Error ? error.message : String(error)) +
            '）：' +
            describeBody(text),
        );
      }
      const data = readMimoAudioData(payload);
      if (data === null) {
        throw new TtsUnavailableError('TTS_BAD_RESPONSE: 响应里没有 choices[0].message.audio.data：' + describeBody(text));
      }
      try {
        return decodeBase64(data);
      } catch (error) {
        throw new TtsUnavailableError(
          'TTS_BAD_RESPONSE: audio.data 不是合法 base64（' +
            (error instanceof Error ? error.message : String(error)) +
            '）：' +
            describeBody(data),
        );
      }
    },
  };
}

/**
 * Gemini 的 /audio/speech：路径与 openai 方言相同，但返回的是整段 WAV（RIFF 头 + PCM），
 * 不是 mp3、也不分块流式回。speed 与 tag 它都没有对应参数，这里显式忽略（不是漏传）：
 * 硬塞进 input 会被念出来，而 gemini 的语速只能由音色带。
 */
export function createGeminiTts(config: TtsConfig): TtsPort {
  const doFetch = resolveFetch(config.fetchImpl);
  const defaultVoice = config.voice !== undefined && config.voice.trim() !== '' ? config.voice : undefined;

  return {
    file: { name: 'voice.wav', contentType: 'audio/wav' },
    async synthesize(input: {
      text: string;
      voice?: string;
      speed?: number;
      tag?: string;
    }): Promise<Uint8Array> {
      const requested = input.voice !== undefined && input.voice.trim() !== '' ? input.voice : undefined;
      const voice = requested ?? defaultVoice;

      const body: Record<string, unknown> = {
        model: config.model,
        input: input.text,
        response_format: 'wav',
      };
      if (voice !== undefined) body.voice = voice;

      let response: Response;
      try {
        response = await doFetch(speechUrl(config.url), {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + config.key,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(resolveTimeout('ttsGemini')),
        });
      } catch (error) {
        throw new TtsUnavailableError('TTS_REQUEST_FAILED: ' + (error instanceof Error ? error.message : String(error)));
      }

      if (!response.ok) {
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        throw new TtsUnavailableError('TTS_HTTP ' + String(response.status) + ': ' + describeBody(text));
      }

      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * 统一入口：调用方（每轮回复、后台试听）只认这一个函数，上游有几种请求形状由这里分派，
 * 加一种方言时也只改这里，不必回头改调用点。
 */
export function createTts(config: TtsConfig): TtsPort {
  if (config.dialect === 'mimo') return createMimoTts(config);
  if (config.dialect === 'gemini') return createGeminiTts(config);
  return createOpenAiTts(config);
}
