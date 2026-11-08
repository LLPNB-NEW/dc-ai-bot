/**
 * 截断续写（§截断续写）：一次回复被上游提前掐断时，让模型接着写，把新文字接进同一条回复。
 * 纯函数，无 IO：判据、上限与续写请求的形状都在这里，service 只负责循环与落库。
 */
import type { ChatMessage } from '../types';

/** 最多续几次（共 3 段）：两次已经够把半句话补完，再多就是模型在灌水 */
export const MAX_CONTINUATIONS = 2;
/** 合并后的累计上限：超过就不再续，别把一条消息灌成小作文 */
export const CONTINUE_TOTAL_CHARS = 3000;
/** 短于这么多字一律当「完整」：太短的回复没法判断是否停在词中间，误判的代价比漏判大 */
export const TRUNCATION_MIN_CHARS = 12;
/** 续写请求的自撤口令：模型认为上段已经写完就只回它 */
export const CONTINUE_SENTINEL = '[END]';

export const CONTINUE_INSTRUCTION =
  '接着上面已写的内容继续写下去：不要重复已经写过的部分，不要任何解释或开场白，直接从断掉的半个字接着写。' +
  '如果上面那段其实已经写完整了，就只回 [END]，不要回别的内容。';

/** 正常收尾白名单：这些结束原因说明上游认为句子写完了，剩下的交给文本层兜底 */
const NORMAL_FINISH_REASONS: readonly string[] = ['stop', 'STOP', 'end_turn', 'stop_sequence'];

/** 词内字符：Unicode 字母（含汉字 / 假名 / 谚文）与数字；标点、引号、表情、代码围栏都不算 */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * 文本层兜底：去掉首尾空白后够长，且最后一个码点是词内字符——即停在词中间。
 * 只说「末字是词内字符」会放过多达标点结尾的正常句子，所以先卡最小长度。
 */
export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < TRUNCATION_MIN_CHARS) return false;
  const points = Array.from(trimmed);
  const last = points[points.length - 1];
  return last !== undefined && WORD_CHAR.test(last);
}

/**
 * 双信号判据：协议层没收到结束原因（或收到的是 length 之类非正常收尾）就算可疑；
 * 收到正常收尾时再看文本层——停在词中间同样算可疑。
 */
export function isTruncatedReply(text: string, finishReason: string | undefined): boolean {
  if (finishReason === undefined) return true;
  if (NORMAL_FINISH_REASONS.includes(finishReason)) return looksUnfinished(text);
  return true;
}

/**
 * 续写请求的消息序列：原 messages + 已写正文（assistant）+ 续写指令（user）。
 * 已写正文当助手的前半段喂回去，模型才会从断点接着写而不是从头重写；不改动入参数组。
 */
export function continuationMessages(messages: readonly ChatMessage[], soFar: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: soFar },
    { role: 'user', content: CONTINUE_INSTRUCTION },
  ];
}
