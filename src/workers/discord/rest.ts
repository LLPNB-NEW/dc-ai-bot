/**
 * Discord REST 的最小子集：交互消息只需要这三件事（architecture §12）；
 * §18.6 追加的两个函数走 Bot token 直连频道/服务器端点——交互 client 绑死 interactionToken，
 * 只能改它自己那条原始消息，贴表情与取表情清单必须另开一条路，不能复用它。
 */
import type { CustomEmoji } from '../../core/types';

export const DEFAULT_API_BASE = 'https://discord.com/api/v10';

export interface DiscordRestOptions {
  applicationId: string;
  interactionToken: string;
  botToken?: string;
  apiBase?: string;
  /** 便于测试注入；默认全局 fetch */
  fetch?: typeof fetch;
}

export interface DiscordRestClient {
  /** PATCH /webhooks/{applicationId}/{interactionToken}/messages/@original，body 固定 {content} */
  editOriginalMessage(content: string): Promise<void>;
  /** POST /webhooks/{applicationId}/{interactionToken}；type=5 之后的补充消息 */
  createInitialResponse(content: string, opts?: { ephemeral?: boolean }): Promise<void>;
  /** DELETE /webhooks/{applicationId}/{interactionToken}/messages/{messageId} */
  deleteMessage(messageId?: string): Promise<void>;
}

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
}

export function createDiscordRestClient(options: DiscordRestOptions): DiscordRestClient {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const webhookPath = `/webhooks/${options.applicationId}/${options.interactionToken}`;
  const originalPath = `${webhookPath}/messages/@original`;

  const headers = (): Record<string, string> => {
    const result: Record<string, string> = { 'content-type': 'application/json' };
    // 交互 webhook 本身以 token 鉴权；有 Bot token 时一并带上，真实端点同样接受
    if (options.botToken) result.authorization = `Bot ${options.botToken}`;
    return result;
  };

  const request = async ({ method, path, body }: RequestOptions): Promise<void> => {
    const init: RequestInit = { method, headers: headers() };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await doFetch(`${apiBase}${path}`, init);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`discord HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
  };

  // 只解析用户提及：机器人正文里的 <@id> 该真 ping 到人，@everyone / @角色 一律不响
  const ALLOWED_MENTIONS: { parse: string[] } = { parse: ['users'] };

  return {
    async editOriginalMessage(content: string): Promise<void> {
      await request({
        method: 'PATCH',
        path: originalPath,
        body: { content, allowed_mentions: ALLOWED_MENTIONS },
      });
    },
    async createInitialResponse(content: string, opts?: { ephemeral?: boolean }): Promise<void> {
      const body: { content: string; flags?: number; allowed_mentions: { parse: string[] } } = {
        content,
        allowed_mentions: ALLOWED_MENTIONS,
      };
      if (opts?.ephemeral) body.flags = 64;
      await request({ method: 'POST', path: webhookPath, body });
    },
    async deleteMessage(messageId = '@original'): Promise<void> {
      await request({ method: 'DELETE', path: `${webhookPath}/messages/${messageId}` });
    },
  };
}

/** Bot token 直连频道/服务器端点的选项（与上面的交互 client 无关，§18.6） */
export interface ChannelRestOptions {
  botToken: string;
  apiBase?: string;
  /** 便于测试注入；默认全局 fetch */
  fetch?: typeof fetch;
}

/**
 * 注入点：生产留空时用箭头函数转调 globalThis.fetch —— 与 gateway/channel-rest.ts 同理，
 * 裸 fetch 引用被当方法调用会被 workerd brand-check 拦下。
 */
function channelFetch(options: ChannelRestOptions): typeof fetch {
  return (
    options.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init))
  );
}

/** 统一的 Bot token 请求：非 2xx 抛 `discord HTTP <status>: <body 前 200 字>` */
export async function channelRequest(options: ChannelRestOptions, method: string, path: string): Promise<Response> {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const response = await channelFetch(options)(apiBase + path, {
    method,
    headers: { authorization: `Bot ${options.botToken.trim()}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`discord HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return response;
}

/** 语音附件的固定形状：一条消息只放这一个文件，文件名与类型都由 Discord 直接预览 */
export const VOICE_FILENAME = 'voice.mp3';
export const VOICE_CONTENT_TYPE = 'audio/mpeg';

/** 附件的展示形状：语音是 mp3，画图是 image/jpeg（由调用方按 mime 传进来） */
export interface ChannelFileShape {
  name: string;
  contentType: string;
}

/**
 * 发一条附件到频道（Bot token 直连）：multipart 里 payload_json 放 body、files[0] 放文件。
 * 不给 shape 时按语音 mp3 发（既有调用点），给了就按它自己的文件名与类型发。
 * 不手写 content-type —— boundary 必须由运行时生成，手写一定会把请求写坏。
 * payload_json 的 allowed_mentions 显式清空：附件是纯附件，不该顺带 ping 到任何人。
 */
export async function sendChannelFile(
  options: ChannelRestOptions,
  channelId: string,
  audio: Uint8Array,
  shape?: ChannelFileShape,
): Promise<void> {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ allowed_mentions: { parse: [] } }));
  // 复制一份独立的 ArrayBuffer：Uint8Array 可能建在共享缓冲上，不是 BlobPart 能接受的那种
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append(
    'files[0]',
    new Blob([bytes], { type: shape?.contentType ?? VOICE_CONTENT_TYPE }),
    shape?.name ?? VOICE_FILENAME,
  );

  const response = await channelFetch(options)(apiBase + `/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${options.botToken.trim()}` },
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`discord HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}

/** 只窄读清单里用得到的三个字段；结构不对或缺 name/id 的条目直接丢弃 */
function readEmojiList(body: unknown): CustomEmoji[] {
  if (!Array.isArray(body)) return [];
  const entries: unknown[] = body;
  const emojis: CustomEmoji[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.available === false) continue;
    const id = typeof record.id === 'string' ? record.id : '';
    const name = typeof record.name === 'string' ? record.name : '';
    if (id === '' || name === '') continue;
    const emoji: CustomEmoji = { name, id };
    if (record.animated === true) emoji.animated = true;
    emojis.push(emoji);
  }
  return emojis;
}

/**
 * 给一条已成消息贴一个表情（§18.6）：PUT /channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me。
 * 无 body；失败抛 `discord HTTP <status>: <body 前 200 字>`，由调用侧决定吞掉还是记日志。
 */
export async function addMessageReaction(
  options: ChannelRestOptions,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await channelRequest(
    options,
    'PUT',
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
  );
}

/**
 * 服务器自定义表情清单（§18.6）：GET /guilds/{guildId}/emojis。
 * 只收 available !== false 的项并保持 Discord 返回顺序；失败抛与贴表情同一风格的错误。
 */
export async function listGuildEmojis(options: ChannelRestOptions, guildId: string): Promise<CustomEmoji[]> {
  const response = await channelRequest(options, 'GET', `/guilds/${guildId}/emojis`);
  const body: unknown = await response.json();
  return readEmojiList(body);
}

/** 一次最多读几条最近消息（§28.4）：候选清单本身就只留 10 条，多要没用 */
const MAX_LIST_MESSAGES = 10;

/** listChannelMessages 的一项：只窄读清单用得到的四个字段 */
type ChannelMessageSummary = { messageId: string; author: string; authorId: string; content: string; bot: boolean };

/**
 * 与 readEmojiList 同理：逐项窄化，缺 id / 作者 / 正文的条目直接丢弃——
 * 一条坏数据不该让整张清单消失（那会连带把「最近消息」整段从提示词里抹掉）。
 */
function readChannelMessages(body: unknown): ChannelMessageSummary[] {
  if (!Array.isArray(body)) return [];
  const entries: unknown[] = body;
  const messages: ChannelMessageSummary[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const messageId = typeof record.id === 'string' ? record.id : '';
    const content = typeof record.content === 'string' ? record.content : null;
    const author = typeof record.author === 'object' && record.author !== null ? (record.author as Record<string, unknown>) : null;
    if (messageId === '' || content === null || author === null) continue;
    const authorId = typeof author.id === 'string' ? author.id : '';
    // 展示名优先 global_name（Discord 的「昵称」），没有才回落 username
    const globalName = typeof author.global_name === 'string' ? author.global_name.trim() : '';
    const username = typeof author.username === 'string' ? author.username.trim() : '';
    const authorName = globalName !== '' ? globalName : username;
    if (authorId === '' || authorName === '') continue;
    // author.bot 是 Discord 给的机器人标记：自动分散靠它把表情留给真人（§28.9）
    messages.push({ messageId, author: authorName, authorId, content, bot: author.bot === true });
  }
  return messages;
}

/**
 * 频道最近消息（§28.4）：GET /channels/{channelId}/messages?limit=<n>，Discord 按新→旧返回。
 * limit 收窄到 1..10；非 2xx 抛 `discord HTTP <status>: <body 前 200 字>`，由调用侧决定吞掉还是记日志。
 */
export async function listChannelMessages(
  options: ChannelRestOptions,
  channelId: string,
  limit: number,
): Promise<Array<{ messageId: string; author: string; authorId: string; content: string; bot: boolean }>> {
  const size = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_MESSAGES)
    : MAX_LIST_MESSAGES;
  const response = await channelRequest(options, 'GET', `/channels/${channelId}/messages?limit=${String(size)}`);
  const body: unknown = await response.json();
  return readChannelMessages(body);
}
