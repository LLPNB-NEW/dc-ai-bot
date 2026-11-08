import type { ChatMessage } from '../types';
import { replySuffix } from './react';
import { stampPrefix } from './stamp';

/** 全角冒号：历史行拼成 `<名字>：<正文>`，与中文正文的标点风格一致 */
export const AUTHOR_SEPARATOR = '：';

/**
 * 拼一行注入给模型的记忆：`[MM-DD HH:mm] <名字>(<ID>)：<正文> ↳ 回复 …`。
 * 时间戳每行都有（assistant 轮次也有，模型才知道自己上次是什么时候回的）；
 * 名字只给 user 轮次，缺失或全空白时按「无名字」处理，不拼出「undefined：」「：」这种怪行。
 * 回复链后缀只挂在 user 行：assistant 行永远不携带 replyTo（§18.3）。
 *
 * 提示词与摘要素材（summary.ts 的 formatTranscript）共用这一份实现，行样式不可能分叉。
 */
export function withAuthorPrefix(message: ChatMessage): ChatMessage {
  const head = stampPrefix(message.createdAt);
  if (message.role !== 'user') return { role: message.role, content: head + message.content };
  const author = (message.author ?? '').trim();
  const id = (message.authorId ?? '').trim();
  const name = author === '' ? '' : id === '' ? author + AUTHOR_SEPARATOR : author + '(' + id + ')' + AUTHOR_SEPARATOR;
  return { role: 'user', content: head + name + message.content + replySuffix(message.replyTo) };
}
