import type { TtsDialect, VoiceSettingsConfig } from '../../core/types';
import { toSpeechText } from '../../core/voice/speech-text';
import { VOICE_MODE_OFF, VOICE_MODE_ON_REQUEST } from '../../core/voice/settings';
import { composeVoiceSpeech } from '../../core/voice/style';
import type { TtsStyleJudgeConfig, VoiceSpeech } from '../../core/voice/style';
import type { TtsPort } from '../../core/voice/tts';

export interface VoiceReplyInput {
  /** 三层合并后的配置；null = 三层都没配（等于不念） */
  settings: VoiceSettingsConfig | null;
  tts: TtsPort;
  /** 已经剥掉指令的最终回复正文 */
  text: string;
  /** 本轮模型写没写 [[voice]] */
  wanted: boolean;
  send: (audio: Uint8Array) => Promise<void>;
  /**
   * 三层语气提示词的出口：只有确认这条要发语音之后才调用，不念的时候一次都不调。
   * 缺省 = 没有配置（按空提示词继续）；抛错按空提示词继续，语音照发。
   */
  stylePrompt?: () => Promise<string>;
  /** 判断情绪用的模型；null / 缺省 = 不判断，直接拿 stylePrompt 当语气 */
  judge?: TtsStyleJudgeConfig | null;
  /** 合成方言：gemini 时 judge 只写英文标签（中文标签会被它当正文念出来） */
  dialect?: TtsDialect;
  /** 日志出口；默认 console.warn，测试可注入静默实现 */
  log?: (message: string) => void;
  /**
   * 成功日志出口；默认 console.log。
   * 成功路径以前一个字都不留，事后没法回答「这条到底发没发、用了什么标签」，所以补这一行。
   */
  logInfo?: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 回复已经发出去了，这里只决定「要不要再加一条语音」。
 * 任何失败都只记 warn 并返回 sent:false —— 语音是附加项，绝不能让它把一条已经成功的回复变成失败。
 */
export async function maybeSendVoice(input: VoiceReplyInput): Promise<{ sent: boolean }> {
  const { settings, tts, text, wanted, send } = input;
  if (settings === null || settings.mode === VOICE_MODE_OFF) return { sent: false };
  // 「按指令」模式：模型没写 [[voice]] 就不念
  if (settings.mode === VOICE_MODE_ON_REQUEST && !wanted) return { sent: false };

  const spoken = toSpeechText(text);
  // 念不出东西（纯表情 / 纯提及）就别白调一次合成接口
  if (spoken === '') return { sent: false };

  const log = input.log ?? ((message: string): void => console.warn(message));
  const logInfo = input.logInfo ?? ((message: string): void => console.log(message));

  // 到这里才准备语气：先读三层提示词，再让 judge 针对这句话写一行「(标签)原文」。
  // 两步都在 try 里：读库失败或判断失败只让语气退化成空标签，语音本身照发。
  let prompt = '';
  try {
    prompt = input.stylePrompt === undefined ? '' : (await input.stylePrompt()).trim();
  } catch (error) {
    log('[voice] 读取语气提示词失败 ' + describeError(error));
  }

  // 兜底是「没有标签 + 原文照念」：判断失败、超时、正文被动过一个字，都退回这一份
  let speech: VoiceSpeech = { tag: '', text: spoken, styleLabel: '' };
  // judge 那一行的原文（完整、不截断）：成功日志带上它，事后才看得出「它到底写了什么」
  let judgeLine = '';
  try {
    speech = await composeVoiceSpeech({
      text: spoken,
      prompt,
      judge: input.judge ?? null,
      // 导演模式读三层合并后的配置：0 = 逐字朗读，1 = 只许插标签，2 = 允许改写
      director: settings.director,
      ...(input.dialect === undefined ? {} : { dialect: input.dialect }),
      onJudgeLine: (line: string): void => {
        judgeLine = line;
      },
    });
  } catch (error) {
    // composeVoiceSpeech 契约上不抛；这里兜住是为了「语音照发」这条永远成立
    log('[voice] 判断语气失败 ' + describeError(error));
    speech = { tag: '', text: spoken, styleLabel: '' };
  }

  let bytes = 0;
  try {
    const audio = await tts.synthesize({
      text: speech.text,
      voice: settings.voice === '' ? undefined : settings.voice,
      speed: settings.speed,
      ...(speech.tag === '' ? {} : { tag: speech.tag }),
    });
    await send(audio);
    bytes = audio.byteLength;
  } catch (error) {
    log('[voice] 语音发送失败 ' + describeError(error));
    return { sent: false };
  }

  // 记标签、字节数、字数与 judge 那一整行（不截断，便于事后看它写歪在哪）；写日志失败也不改变「已经发出去了」这个事实
  // 标签优先取导演模式的 styleLabel：那时 tag 必为空串，风格组只在正文开头出现一次
  const tagForLog = speech.styleLabel === '' ? speech.tag : speech.styleLabel;
  try {
    logInfo(
      '[voice] 已发送 tag=' +
        (tagForLog === '' ? '无' : tagForLog) +
        ' bytes=' +
        bytes +
        ' 字数=' +
        // 字数按真正送进合成的那份文本算：导演模式下就是改写过的那份
        Array.from(speech.text).length +
        ' mode=' +
        settings.mode +
        ' director=' +
        settings.director +
        (speech.directorRejected === undefined ? '' : ' rejected=' + speech.directorRejected) +
        (judgeLine === '' ? '' : ' judge=' + judgeLine),
    );
  } catch {
    // 记日志不该把一条已经发出去的语音变成失败
  }
  return { sent: true };
}
