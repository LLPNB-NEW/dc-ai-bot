/**
 * MESSAGE_CREATE 的解析与「要不要回」判定 —— 纯函数，不碰网络也不碰 storage。
 *
 * DO 只负责 I/O：把网关事件里的 d 丢进来，拿到决定与真正要送给模型的文本；
 * 这样「私聊必回 / 服务器里只在 @提及 或回复我时回」这类策略可以被单测直接覆盖。
 */

import { narrowAttachments, type ImageRef } from './images';

/** 触发回复的场景；empty-addressed = 确实叫到了我但正文是空的（见 EMPTY_ADDRESSED_NOTE） */
export type RespondReason = 'dm' | 'mention' | 'reply' | 'empty-addressed';

/** respond=false 的原因，仅用于日志排查 */
export type IgnoreReason = 'self' | 'bot' | 'not-addressed';

export interface IncomingAuthor {
  id: string;
  bot: boolean;
  username: string | null;
  globalName: string | null;
  /** 服务器昵称（`member.nick`）：群里改过昵称的人只在整条载荷的 member 上，不在 author 上 */
  nickname: string | null;
}

/**
 * 展示名（§60）：服务器昵称 > 全局显示名 > 账号名。
 * 以前这里直接 `globalName ?? username`，机器人账号没有 global_name，于是它在被回复的原文里
 * 一直是账号名「示例机器人」，服务器昵称「示例角色」根本读不到——她把那个名字当成了外人。
 */
export function authorDisplayName(author: IncomingAuthor): string {
  const nickname = (author.nickname ?? '').trim();
  if (nickname !== '') return nickname;
  const globalName = (author.globalName ?? '').trim();
  if (globalName !== '') return globalName;
  const username = (author.username ?? '').trim();
  return username !== '' ? username : '未知用户';
}

export interface IncomingMessage {
  messageId: string;
  channelId: string;
  /** 私聊为 null */
  guildId: string | null;
  content: string;
  author: IncomingAuthor;
  /** 消息里 @ 到的用户 id（Discord 的 mentions 数组） */
  mentionedIds: string[];
  /** 被回复消息的作者 id；不是回复则是 null */
  referencedAuthorId: string | null;
  /**
   * 本条消息的图片附件（§22.5）：已按 §22.4 收窄（只留 image/*、单张 ≤5MB）。
   * 没有附图的老消息形状不变，只是这里给空数组。
   */
  attachments: ImageRef[];
  /** 被回复消息；不是回复或原消息已删除为 null（§18.6） */
  replyTo: {
    messageId: string;
    authorId: string;
    authorName: string;
    content: string;
    /** 被回复消息的图片附件，窄化规则与 attachments 相同；字段缺失时是空数组 */
    attachments?: ImageRef[];
  } | null;
}

export interface RespondDecision {
  respond: boolean;
  reason: RespondReason | IgnoreReason;
  /** respond=true 时交给模型的文本（已剥掉 @提及 前缀） */
  text: string;
  /** 只用于落库/进记忆的原文；缺省等于 text（空 @ 那轮 text 本身就是事实标记，不再另设） */
  storedText?: string;
}

/**
 * 「只 @ 了我但没写字」（或私聊里发来一条空消息）时，交给模型的唯一东西：一句事实标记。
 * 不替用户编话、也不替她决定怎么接——要不要问、说什么、说多长都由她自己判断。
 * 它作为 userText 走和正常消息**完全相同**的生成路径：写进 messages、受 chunkMessage/1900 上限约束。
 */
export const EMPTY_ADDRESSED_NOTE = '（对方只 @ 了你，没有写正文）';

/** Discord 硬上限：单条消息 2000 字符 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** 实际切分留一点余量，避免和 markdown 围栏一起超限 */
export const MESSAGE_CHUNK_LIMIT = 1900;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(source[key]);
}

/** 身份字段：v10 是字符串，历史版本可能给数字，两种都收 */
function readId(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/**
 * 被回复消息的摘要：referenced_message 缺失或给 null（原消息已被删除）时返回 null。
 * 字段缺省一律回落空串，退化口径见 §18.3——记忆行会自己处理「没名字 / 没 id / 没原文」。
 */
function readReplyTo(payload: Record<string, unknown>): IncomingMessage['replyTo'] {
  const referenced = payload.referenced_message;
  if (typeof referenced !== 'object' || referenced === null) return null;
  const record = readRecord(payload, 'referenced_message');
  const author = readRecord(record, 'author');
  return {
    messageId: readId(record, 'id') ?? '',
    authorId: readId(author, 'id') ?? '',
    // 服务器昵称真的优先（member.nick），再退回全局显示名与账号名（§60）
    authorName:
      readString(readRecord(record, 'member'), 'nick') ??
      readString(author, 'global_name') ??
      readString(author, 'username') ??
      '',
    content: readString(record, 'content') ?? '',
    // 被回复那条消息自己的图（§22.5）：同样窄化，缺字段就是空数组
    attachments: narrowAttachments(record.attachments),
  };
}

/** 解析不了（字段缺失/被写坏）就返回 null，调用方直接丢弃这一帧 */
export function parseIncomingMessage(raw: unknown): IncomingMessage | null {
  const payload = asRecord(raw);
  const author = readRecord(payload, 'author');
  const authorId = readId(author, 'id');
  const channelId = readId(payload, 'channel_id');
  const messageId = readId(payload, 'id');
  if (authorId === null || channelId === null || messageId === null) return null;

  const mentioned = payload.mentions;
  const mentionedIds: string[] = [];
  if (Array.isArray(mentioned)) {
    for (const entry of mentioned) {
      const id = readId(asRecord(entry), 'id');
      if (id !== null) mentionedIds.push(id);
    }
  }

  return {
    messageId,
    channelId,
    guildId: readId(payload, 'guild_id'),
    content: readString(payload, 'content') ?? '',
    author: {
      id: authorId,
      bot: readBoolean(author, 'bot'),
      username: readString(author, 'username'),
      globalName: readString(author, 'global_name'),
      nickname: readString(readRecord(payload, 'member'), 'nick'),
    },
    mentionedIds,
    // 本条消息的图（§22.5）：只要附件，视频/文件在窄化时就被丢掉
    attachments: narrowAttachments(payload.attachments),
    // referenced_message 是完整的被引用消息；被删掉时 Discord 给 null
    referencedAuthorId: readId(readRecord(readRecord(payload, 'referenced_message'), 'author'), 'id'),
    replyTo: readReplyTo(payload),
  };
}

/** 这条消息里有没有 @ 到指定用户（mentions 数组优先，退回原文匹配 <@id> 与 <@!id> 两种写法） */
export function isMentioned(message: IncomingMessage, userId: string): boolean {
  if (userId === '') return false;
  if (message.mentionedIds.includes(userId)) return true;
  return message.content.includes('<@' + userId + '>') || message.content.includes('<@!' + userId + '>');
}

/** 去掉 @提及 前缀（含 <@!id> 变体）并压掉多余空白 */
export function stripMentions(content: string, userId: string): string {
  let text = content;
  if (userId !== '') {
    text = text.split('<@' + userId + '>').join(' ');
    text = text.split('<@!' + userId + '>').join(' ');
  }
  return text.replace(/[ \t]+/g, ' ').trim();
}

/**
 * 回复策略：
 *   私聊 -> 一律回；服务器频道 -> 只在 @我 或 回复我的消息 时回。
 *   「叫到了我但正文是空的」不再静默跳过：只交一句事实标记（EMPTY_ADDRESSED_NOTE），怎么接由她自己判断。
 * 机器人的消息（含自己）一律跳过，避免自激循环。
 * 频道里既没 @我 也没回复我的消息 -> not-addressed（正文被抹成空串也走这里）。
 */
export function shouldRespond(message: IncomingMessage, botUserId: string): RespondDecision {
  if (message.author.bot) return { respond: false, reason: 'bot', text: '' };
  if (botUserId !== '' && message.author.id === botUserId) return { respond: false, reason: 'self', text: '' };

  const text = stripMentions(message.content, botUserId);
  const empty = text === '';

  // 私聊：一律回；只 @ 了一下或干脆空消息，也给一句事实标记让她自己接，而不是装死
  if (message.guildId === null) {
    return empty
      ? { respond: true, reason: 'empty-addressed', text: EMPTY_ADDRESSED_NOTE }
      : { respond: true, reason: 'dm', text };
  }

  const mentioned = isMentioned(message, botUserId);
  const repliedToMe = botUserId !== '' && message.referencedAuthorId === botUserId;
  if (!mentioned && !repliedToMe) return { respond: false, reason: 'not-addressed', text: '' };
  if (empty) {
    return { respond: true, reason: 'empty-addressed', text: EMPTY_ADDRESSED_NOTE };
  }
  return { respond: true, reason: mentioned ? 'mention' : 'reply', text };
}

/**
 * 不回复、但应当写进频道记忆的消息：人类发的、有正文、且不是 @我/回复我。
 * 只决定「记不记」，回复判定仍由 shouldRespond 独占（选中的回合由 chat service 写库，
 * 这里只补上那些我们没回的发言，绝不重复落库）。
 */
export function shouldRecord(message: IncomingMessage, decision: RespondDecision): boolean {
  return (
    decision.respond === false &&
    decision.reason === 'not-addressed' &&
    message.author.bot === false &&
    message.content.trim() !== ''
  );
}

/** 日志用的量纲：只有 id 与计数，绝不带正文 */
export interface MessageStats {
  /** mentions 数组里的人数（不区分是谁） */
  mentions: number;
  /** 剥掉对我的 @ 之后的正文字符数 */
  textLen: number;
  /** 原始 content 的字符数：0 通常意味着 Discord 没给正文（缺 MESSAGE_CONTENT 特权位） */
  rawLen: number;
}

export function messageStats(message: IncomingMessage, botUserId: string): MessageStats {
  return {
    mentions: message.mentionedIds.length,
    textLen: stripMentions(message.content, botUserId).length,
    rawLen: message.content.length,
  };
}

/** 按 Discord 2000 字符上限切分，优先在换行处断，保证每段都非空 */
export function chunkMessage(text: string, limit: number = MESSAGE_CHUNK_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const size = limit > 0 ? limit : MESSAGE_CHUNK_LIMIT;
  if (trimmed.length <= size) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const breakAt = window.lastIndexOf('\n');
    // 换行太靠前就不值得为它留半截，直接硬切
    const cut = breakAt > size / 2 ? breakAt : size;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}
