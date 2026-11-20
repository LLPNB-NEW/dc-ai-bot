import type { ChatTool, ChatToolCall, LlmAudio, TurnAudio } from '../types';
import { AudioUnavailableError, type AudioToolPort } from '../voice/audio';

/** 模型工具名：预设里写了哪个名字，哪个工具才会下发给模型 */
export const MUSIC_TOOL_NAME = 'compose_music';
export const SFX_TOOL_NAME = 'sound_effect';
export const VOICE_CHANGE_TOOL_NAME = 'change_voice';

const AUDIO_TOOL_NAMES: readonly string[] = [MUSIC_TOOL_NAME, SFX_TOOL_NAME, VOICE_CHANGE_TOOL_NAME];

/** 音乐 prompt / 歌词上限与 ElevenLabs Music 的请求体一致；超了截断，不因此判整轮失败 */
export const MUSIC_PROMPT_TOOL_MAX = 4_100;
export const MUSIC_LYRICS_TOOL_MAX = 4_000;
export const SFX_PROMPT_TOOL_MAX = 1_000;

export function musicTool(): ChatTool {
  return {
    type: 'function',
    function: {
      name: MUSIC_TOOL_NAME,
      description:
        '生成一首歌并直接发到频道。用户让你唱歌、写歌、来一段音乐、配乐时调用；prompt 写风格、情绪、乐器、节奏与语言，lyrics 可选，用户给了歌词就原样放进去，没给可以自己写。duration_seconds 可选，默认按后台配置，超过上限会被夹住。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '歌曲风格与内容要求：流派、情绪、乐器、节奏、语言' },
          lyrics: { type: 'string', description: '可选歌词；不填就由模型按 prompt 生成' },
          duration_seconds: { type: 'number', description: '可选时长（秒），不填用后台默认；上限由后台配置' },
        },
        required: ['prompt'],
      },
    },
  };
}

export function soundEffectTool(): ChatTool {
  return {
    type: 'function',
    function: {
      name: SFX_TOOL_NAME,
      description:
        '生成一段音效并直接发到频道。用户要环境声、拟音、转场音效、提示音时调用；prompt 写清声音本身，不写剧情。duration_seconds 可选，范围 0.5–30 秒。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要生成的声音：材质、动作、空间、远近' },
          duration_seconds: { type: 'number', description: '可选时长（秒），0.5–30；不填由上游决定' },
        },
        required: ['prompt'],
      },
    },
  };
}

export function voiceChangeTool(): ChatTool {
  return {
    type: 'function',
    function: {
      name: VOICE_CHANGE_TOOL_NAME,
      description:
        '把用户上传的音频换成另一个音色。只有当前消息或它回复的消息里带音频附件时才调用；没有源音频不要调用。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  };
}

/** 预设正文里点名了哪个工具就下发哪个；三个都没写就是空数组（与 draw_image 同一套门控） */
export function audioToolsFor(preset: string): ChatTool[] {
  const tools: ChatTool[] = [];
  if (preset.includes(MUSIC_TOOL_NAME)) tools.push(musicTool());
  if (preset.includes(SFX_TOOL_NAME)) tools.push(soundEffectTool());
  if (preset.includes(VOICE_CHANGE_TOOL_NAME)) tools.push(voiceChangeTool());
  return tools;
}

export function presetMentionsAudioTool(preset: string): boolean {
  return AUDIO_TOOL_NAMES.some((name) => preset.includes(name));
}

export type AudioCall =
  | { kind: 'music'; prompt: string; lyrics?: string; durationSeconds?: number }
  | { kind: 'sound_effect'; prompt: string; durationSeconds?: number }
  | { kind: 'voice_change' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 从拼回的调用里取第一个音频工具；参数坏、prompt 为空都返回 null，让这一轮按普通回复处理 */
export function audioCallOf(calls: readonly ChatToolCall[]): AudioCall | null {
  const call = calls.find((item) => AUDIO_TOOL_NAMES.includes(item.name));
  if (call === undefined) return null;

  if (call.name === VOICE_CHANGE_TOOL_NAME) return { kind: 'voice_change' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const rawPrompt = record.prompt;
  const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
  if (prompt === '') return null;
  const durationSeconds = readDuration(record.duration_seconds);
  if (call.name === MUSIC_TOOL_NAME) {
    const rawLyrics = record.lyrics;
    const lyrics = typeof rawLyrics === 'string' ? rawLyrics.trim() : '';
    return {
      kind: 'music',
      prompt: prompt.slice(0, MUSIC_PROMPT_TOOL_MAX),
      ...(lyrics === '' ? {} : { lyrics: lyrics.slice(0, MUSIC_LYRICS_TOOL_MAX) }),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
  }
  return {
    kind: 'sound_effect',
    prompt: prompt.slice(0, SFX_PROMPT_TOOL_MAX),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

/**
 * 执行一条音频调用。变声的源音频由平台层的 loadAudio 懒加载；没有源音频就抛错，
 * 让服务层只记一条 warn，不把这一轮正文弄失败。
 */
export async function executeAudioCall(
  port: AudioToolPort,
  call: AudioCall,
  loadAudio?: () => Promise<LlmAudio[]>,
): Promise<TurnAudio> {
  if (call.kind === 'music') {
    return port.music({ prompt: call.prompt, ...(call.lyrics === undefined ? {} : { lyrics: call.lyrics }), ...(call.durationSeconds === undefined ? {} : { durationSeconds: call.durationSeconds }) });
  }
  if (call.kind === 'sound_effect') {
    return port.soundEffect({ prompt: call.prompt, ...(call.durationSeconds === undefined ? {} : { durationSeconds: call.durationSeconds }) });
  }
  const sources = loadAudio === undefined ? [] : await loadAudio();
  if (sources.length === 0) throw new AudioUnavailableError('AUDIO_SOURCE_MISSING');
  return port.changeVoice({ source: sources[0] });
}
