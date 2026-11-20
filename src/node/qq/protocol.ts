/**
 * QQ 开放平台的协议细节：事件解析、正文清洗、回复分片与请求体构造。
 * 这里只有纯函数（不碰网络、环境变量、文件）：单测因此不需要真凭证，也不会把 token 带进快照。
 */
import type { ConversationLinkKind } from '../../core/types';

/** QQ 侧只认群与单聊这两种链接；Discord 频道的 kind 不属于这里 */
export type QqMessageKind = Extract<ConversationLinkKind, 'qq_group' | 'qq_c2c'>;

/** 群里 @ 机器人 / 单聊里的普通消息 */
export const QQ_GROUP_EVENT = 'GROUP_AT_MESSAGE_CREATE';
/** 群开了「接收所有消息」后，群里的每条消息都走这个事件（含 @ 机器人的那条） */
export const QQ_GROUP_FULL_EVENT = 'GROUP_MESSAGE_CREATE';
export const QQ_C2C_EVENT = 'C2C_MESSAGE_CREATE';

/** GROUP_AND_C2C_EVENT：只订群 + 单聊，不把频道等事件一起拉进来 */
export const QQ_INTENTS = 33554432;

/** 开放平台 API 根（换 token 的地址在 bots.qq.com，不在这个域下） */
export const QQ_API_BASE = 'https://api.sgroup.qq.com';
export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** QQ 单条正文上限 1800 字；一次回合最多回 5 条，超出的部分截断并留一个省略号 */
export const QQ_REPLY_CHUNK_MAX = 1800;
export const QQ_REPLY_MAX_CHUNKS = 5;

/** 空正文的占位：一句事实标记，不替用户编话（与 Discord 侧「空 @」同口径） */
export const QQ_EMPTY_TEXT = '（空消息）';
/** QQ 不保证给 username，缺省就叫「QQ用户」 */
export const QQ_DEFAULT_USER_NAME = 'QQ用户';
/** 群没有群名可用，后台列表靠 openid 末 6 位区分多个群（openid 不是秘密） */
const QQ_GROUP_TAIL_LENGTH = 6;
/** 合成会话名：既是 TurnContext 的 guildName/channelName，也是群链接的 displayName 前缀 */
export const QQ_GROUP_NAME = 'QQ群';
export const QQ_C2C_NAME = 'QQ私聊';

/** 网关解析出来的一条入站消息：平台无关，够拼 TurnContext 即可 */
export interface QqIncomingMessage {
  kind: QqMessageKind;
  /** 群 openid / 单聊用户 openid：QQ 会话的合成 channelId */
  externalId: string;
  userId: string;
  userName: string;
  /** 已 trim、已剥掉开头 @ 的正文；空消息是 QQ_EMPTY_TEXT */
  text: string;
  /** 事件 id：既做去重键，也做回复的 msg_id */
  eventId: string;
  /** 群里是否 @ 了机器人；单聊恒为 true。全量群消息为 false 时只记历史、不回复 */
  mentioned: boolean;
  /** QQ 的 msg_idx：后续消息可以用 ref_msg_idx 引用它 */
  msgIdx?: string;
  /** 这条消息引用的 msg_idx */
  refMsgIdx?: string;
  /** QQ 在 msg_elements 里给出的被引用正文；可能没有，靠本地索引补 */
  quoteText?: string;
  /** 被引用消息自己又引用了谁：按从外到内的顺序摊平，只放有正文的节点 */
  quoteChain?: string[];
}

/** 链接的展示名：群用「QQ群·末6位」让后台分得清是哪个群，单聊仍用发送者昵称 */
export function qqLinkDisplayName(message: QqIncomingMessage): string {
  if (message.kind !== 'qq_group') return message.userName;
  const tail = message.externalId.slice(-QQ_GROUP_TAIL_LENGTH);
  return tail === '' ? QQ_GROUP_NAME : QQ_GROUP_NAME + '·' + tail;
}

/** 一条 websocket 帧：op=10 Hello / 0 Dispatch / 1 Heartbeat / 7 Reconnect / 9 InvalidSession / 11 ACK */
export interface QqFrame {
  op: number;
  /** 序列号：只用来回心跳（op=1 的 d），缺省 null */
  s: number | null;
  /** 事件名，只有 op=0 时非空 */
  t: string;
  d: unknown;
}

/** 回复请求体：msg_id 指回触发那条，msg_seq 从 1 起递增（同一条消息的多片靠它排序） */
export interface QqReplyBody {
  content: string;
  msg_id: string;
  msg_seq: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 读一个字符串字段：非字符串或空白一律当没有 */
export function readStringField(value: unknown, key: string): string {
  const record = asRecord(value);
  if (record === null) return '';
  const raw = record[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 读一个数字字段：QQ 的 expires_in / heartbeat_interval 有时是字符串，两种都认 */
export function readNumberField(value: unknown, key: string): number | null {
  const record = asRecord(value);
  if (record === null) return null;
  const raw = record[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 一条 websocket 文本帧；不是 JSON 或缺 op 就当坏帧（null），由调用方只记一行 warn */
export function parseQqFrame(raw: string): QqFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const op = readNumberField(record, 'op');
  if (op === null) return null;
  return {
    op,
    s: readNumberField(record, 's'),
    t: typeof record.t === 'string' ? record.t : '',
    d: record.d,
  };
}

/**
 * 开头那个 @ 标记：群里 @ 机器人时正文常带 "<@!1234>"，也可能是 "＠机器人"。
 * 最多剥 3 个（偶尔会连着 @ 两次），剥完只动首尾空白，不动正文本身。
 */
const MENTION_TOKEN = /^(?:<@!?[^>\s]{1,64}>|[@＠][^\s]{1,64})/;

export function stripLeadingMention(text: string): string {
  let rest = text.trim();
  for (let round = 0; round < 3; round += 1) {
    const stripped = rest.replace(MENTION_TOKEN, '');
    if (stripped === rest) break;
    rest = stripped.trimStart();
  }
  return rest.trim();
}

/** 正文清洗：trim → 剥开头 @ → 空则占位。QQ 没有附件正文，只剩这一条路 */
export function normalizeQqText(content: unknown): string {
  const raw = typeof content === 'string' ? content : '';
  const text = stripLeadingMention(raw);
  return text === '' ? QQ_EMPTY_TEXT : text;
}

/**
 * message_scene.ext 是 []string 的 key=value（也接受一整串用逗号/空白分隔），
 * 我们只关心 msg_idx 与 ref_msg_idx；auth_token 一律不读、不落日志。
 */
function readSceneExt(payload: Record<string, unknown>): { msgIdx: string; refMsgIdx: string } {
  const scene = asRecord(payload.message_scene);
  const raw = scene?.ext;
  const items: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === 'string') items.push(item);
  } else if (typeof raw === 'string') {
    items.push(...raw.split(/[,\s]+/));
  }

  let msgIdx = '';
  let refMsgIdx = '';
  for (const item of items) {
    const cut = item.indexOf('=');
    if (cut <= 0) continue;
    const key = item.slice(0, cut).trim();
    const value = item.slice(cut + 1).trim();
    if (value === '') continue;
    if (key === 'msg_idx') msgIdx = value;
    else if (key === 'ref_msg_idx') refMsgIdx = value;
  }
  return { msgIdx, refMsgIdx };
}

/** msg_elements 是一棵树：当前消息（type=103）下面挂着它引用的消息，再下面可能还有一层 */
interface QuoteNode {
  msgIdx: string;
  messageType: number;
  content: string;
  children: QuoteNode[];
}

function collectQuoteNodes(value: unknown, out: QuoteNode[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectQuoteNodes(item, out);
    return;
  }
  const record = asRecord(value);
  if (record === null) return;
  const children: QuoteNode[] = [];
  collectQuoteNodes(record.msg_elements, children);
  out.push({
    msgIdx: readStringField(record, 'msg_idx'),
    messageType: readNumberField(record, 'message_type') ?? 0,
    content: readStringField(record, 'content'),
    children,
  });
}

function findQuoteNode(nodes: QuoteNode[], msgIdx: string): QuoteNode | null {
  for (const node of nodes) {
    if (node.msgIdx === msgIdx) return node;
    const nested = findQuoteNode(node.children, msgIdx);
    if (nested !== null) return nested;
  }
  return null;
}

function findType103(nodes: QuoteNode[]): QuoteNode | null {
  for (const node of nodes) {
    if (node.messageType === 103) return node;
    const nested = findType103(node.children);
    if (nested !== null) return nested;
  }
  return null;
}

/** 被引用节点所有后代的正文：外层是「他引用了谁」，里层是「那条又引用了谁」 */
function nestedQuoteTexts(node: QuoteNode): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    const content = child.content.trim();
    if (content !== '') out.push(content);
    out.push(...nestedQuoteTexts(child));
  }
  return out;
}

function readQuote(
  payload: Record<string, unknown>,
  refMsgIdx: string,
  currentText: string,
): { text: string; chain: string[] } {
  const roots: QuoteNode[] = [];
  collectQuoteNodes(payload.msg_elements, roots);

  let target = refMsgIdx === '' ? null : findQuoteNode(roots, refMsgIdx);
  if (target === null) {
    const outer = findType103(roots);
    if (outer === null) return { text: '', chain: [] };
    // 只有外层 content 确实是当前消息时，才把第一个子节点当引用目标；
    // 某些事件把引用正文直接放在 type=103 的节点里，没有子节点，不能下钻。
    const isCurrent = normalizeQqText(outer.content) === currentText;
    target = isCurrent && outer.children.length > 0 ? outer.children[0]! : outer;
  }
  return { text: target.content.trim(), chain: nestedQuoteTexts(target) };
}

/** 全量模式里 @ 了机器人 = 需要回复；@全体或 @ 别人都不算，只记历史 */
function mentionsBot(payload: Record<string, unknown>): boolean {
  const mentions = payload.mentions;
  if (!Array.isArray(mentions)) return false;
  return mentions.some((item) => {
    const record = asRecord(item);
    return record !== null && record.is_you === true;
  });
}

/**
 * 事件 → 平台无关消息；类型不认识或关键字段缺失返回 null（不该回一句话把网关带崩）。
 * 群：GROUP_AT_MESSAGE_CREATE，或开了全量模式后的 GROUP_MESSAGE_CREATE（所有人类消息都解析，
 * mentioned 标记是否 @ 了机器人）；externalId = group_openid，用户 = author.member_openid（退回 author.id）。
 * 单聊：externalId = author.user_openid（退回 author.id），用户与它是同一个人，mentioned 恒为 true。
 */
export function parseQqEvent(type: unknown, data: unknown): QqIncomingMessage | null {
  const kind: QqMessageKind | null =
    type === QQ_GROUP_EVENT || type === QQ_GROUP_FULL_EVENT
      ? 'qq_group'
      : type === QQ_C2C_EVENT
        ? 'qq_c2c'
        : null;
  if (kind === null) return null;

  const payload = asRecord(data);
  if (payload === null) return null;
  // 全量模式推所有人类消息；未 @ 的也要解析出来，网关只落库不回复
  const mentioned = type === QQ_GROUP_FULL_EVENT ? mentionsBot(payload) : true;
  const author = asRecord(payload.author);
  // 全量模式会把机器人自己的回复也推回来；不挡就会自问自答
  if (author !== null && (author.bot === true || author.bot === 'true')) return null;

  const eventId = readStringField(payload, 'id');
  if (eventId === '') return null;
  const text = normalizeQqText(payload.content);
  const userName = readStringField(author, 'username') || QQ_DEFAULT_USER_NAME;
  const scene = readSceneExt(payload);
  const quote = readQuote(payload, scene.refMsgIdx, text);
  const withQuote = (message: QqIncomingMessage): QqIncomingMessage => {
    // 缺字段时不加键：老事件的解析结果保持原形状，既有断言与调用方都不受影响
    if (scene.msgIdx !== '') message.msgIdx = scene.msgIdx;
    if (scene.refMsgIdx !== '') message.refMsgIdx = scene.refMsgIdx;
    if (quote.text !== '') message.quoteText = quote.text;
    if (quote.chain.length > 0) message.quoteChain = quote.chain;
    return message;
  };

  if (kind === 'qq_group') {
    const externalId = readStringField(payload, 'group_openid');
    if (externalId === '') return null;
    const userId = readStringField(author, 'member_openid') || readStringField(author, 'id');
    return withQuote({ kind, externalId, userId, userName, text, eventId, mentioned });
  }

  const externalId = readStringField(author, 'user_openid') || readStringField(author, 'id');
  if (externalId === '') return null;
  return withQuote({ kind, externalId, userId: externalId, userName, text, eventId, mentioned });
}

/** 回复路由：群与单聊是两个不同的端点，openid 一律转义后再拼 */
export function qqReplyPath(kind: QqMessageKind, externalId: string): string {
  const id = encodeURIComponent(externalId);
  return kind === 'qq_group' ? '/v2/groups/' + id + '/messages' : '/v2/users/' + id + '/messages';
}

/**
 * 切点别落在代理对中间：QQ 里 emoji 很常见，切出半个字符会变成替换符。
 */
function safeCut(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const code = text.charCodeAt(cut - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return isHighSurrogate ? cut - 1 : cut;
}

/**
 * 把整段回复切成 QQ 能收的几片：每片 ≤ limit，优先断在换行（且只认后半段的换行，
 * 否则一句话会被切成很短的碎片）；最多 maxChunks 片，剩下的截断并以省略号收尾。
 */
export function splitQqReply(
  text: string,
  limit: number = QQ_REPLY_CHUNK_MAX,
  maxChunks: number = QQ_REPLY_MAX_CHUNKS,
): string[] {
  const source = text.trim();
  if (source === '' || limit <= 0 || maxChunks <= 0) return [];

  const chunks: string[] = [];
  let rest = source;
  while (rest !== '' && chunks.length < maxChunks) {
    if (rest.length <= limit) {
      chunks.push(rest);
      rest = '';
      break;
    }
    const window = rest.slice(0, limit);
    const newline = window.lastIndexOf('\n');
    const cut = newline > limit / 2 ? newline : safeCut(rest, limit);
    const take = cut > 0 ? cut : limit;
    chunks.push(rest.slice(0, take));
    // 断在换行上时把换行本身也吃掉，下一片不从空行开始
    rest = rest.slice(take).replace(/^[\r\n]+/, '');
  }

  if (rest !== '') {
    const last = chunks[chunks.length - 1] ?? '';
    chunks[chunks.length - 1] = last.slice(0, Math.max(0, limit - 1)) + '…';
  }
  return chunks.filter((chunk) => chunk !== '');
}

/** 回复请求体；空正文在这一层直接拒掉，绝不会发出一条 content 为空的 POST */
export function buildQqReplyBody(content: string, eventId: string, seq: number): QqReplyBody {
  if (content.trim() === '') throw new Error('QQ_REPLY_EMPTY');
  return { content, msg_id: eventId, msg_seq: seq };
}
