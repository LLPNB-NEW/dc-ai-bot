import type { ChatMessage } from '../types';

/** 注入提示词的条数上限：只送最近 N 条原文，更早的内容由累积记忆兜底；库里一条不删 */
export const DEFAULT_HISTORY_MAX_MESSAGES = 50;

export interface HistoryWindow {
  kept: ChatMessage[];
  droppedCount: number;
}

/** 只保留最近 max 条（时间正序的尾部）；max 非正数视为不保留 */
export function tailMessages(messages: ChatMessage[], max: number): HistoryWindow {
  if (!Number.isFinite(max) || max <= 0) return { kept: [], droppedCount: messages.length };
  const limit = Math.floor(max);
  if (messages.length <= limit) return { kept: messages.slice(), droppedCount: 0 };
  return { kept: messages.slice(messages.length - limit), droppedCount: messages.length - limit };
}

