/**
 * 平台无关的 Discord 网关状态机。
 *
 * 为什么要这一层：同一条生命周期要在两个宿主上原样跑 ——
 *   Durable Object：只有 storage.setAlarm 能跨驱逐唤醒（DO 被驱逐后 setTimeout 全部作废）；
 *   Node：进程常驻，但同样只允许一个定时器（心跳 0.9×interval、15s 握手看门狗、重连退避共用同一条 alarm）。
 * 于是「下一次该在什么时候醒」统一表达成 host.storage.setAlarm(at)，由宿主自己决定它是 DO 的 alarm
 * 还是 Node 里那唯一一个 setTimeout。本文件因此不许 import node:/cloudflare: 模块，也不许 import src/node/**。
 *
 * 一条生命周期：
 *   /ensure → #connect() → wss://gateway.discord.gg/?v=10&encoding=json
 *   → op10 HELLO → IDENTIFY(op2)（有 session 则 RESUME(op6)）→ op0 READY 存 session
 *   → 每个 alarm 发一次 op1 心跳 → 收到 op11 才算这一拍活着
 *   → op7 / op9 / ACK 超时 / socket 关闭 → 关闭连接 → 退避后再 #connect()
 *
 * 协议细节（载荷、延迟、opcode 分发）都在 ./protocol.ts。
 *
 * 除了「在线」，同一个连接还负责「不用斜杠命令也能聊天」：op0 MESSAGE_CREATE 会被交给
 * ./message.ts 判定要不要回（私聊 / @提及 / 回复我），要回就调 M3 同一套 chat service，
 * 再用 ./channel-rest.ts 发回频道。业务处理走 host.waitUntil，不占心跳与重连的串行链。
 */
import {
  EMPTY_GATEWAY_STATE,
  GATEWAY_URL,
  heartbeatDelayMs,
  intentsFor,
  parseFrame,
  reduceGatewayEvent,
  resumable,
  resumeConnectUrl,
  restoreGatewayState,
  serializeGatewayState,
  type GatewayAction,
  type GatewayDeps,
  type GatewayEvent,
  type GatewayReduction,
  type GatewayState,
  type PersistedGatewayState,
} from './protocol';
import { createChatService } from '../../core/chat/service';
import { createProviders } from '../../core/providers/index';
import { expandBroadcast } from '../../core/chat/react';
import type { SqlDatabase } from '../../core/db/sql';
import type { EmojiAliasStore, LogStore } from '../../core/ports';
import type {
  ChatMessage,
  CustomEmoji,
  EmojiAlias,
  EmojiDescription,
  LlmImage,
  LlmProvider,
  LogEntry,
  LogLevel,
  ProviderId,
  ReactionRequest,
  ReactionTarget,
  ReplyRef,
  TtsDialect,
  TurnContext,
  TurnResult,
} from '../../core/types';
import { createSecretBox } from '../crypto/secretbox';
import { readRevealSteps } from '../../core/chat/reply-view';
import { VOICE_MODE_ON_REQUEST, readVoiceSettings } from '../../core/voice/settings';
import { isJudgeConfigured, resolveStylePrompt, type TtsStyleJudgeConfig } from '../../core/voice/style';
import { createTts, createUnconfiguredTts, ttsConfigFrom, type TtsPort } from '../../core/voice/tts';
import { readVisionEnabled } from '../../core/chat/vision-view';
import { createRepositories } from '../db/d1-repository';
import { createLogStore } from '../db/log-store';
import { addMessageReaction, listChannelMessages, listGuildEmojis } from '../discord/rest';
import { resolveBotDisplayName } from '../discord/bot-name';
import { describeGuildEmojis, type DescribeDeps } from '../emoji/describe';
import { resolveInlineEmojis, resolveReactionEmoji } from '../discord/emoji';
import { createChannelClient, type ChannelClient } from './channel-rest';
import { collectImageRefs, loadImages } from './images';
import {
  MESSAGE_CHUNK_LIMIT,
  authorDisplayName,
  chunkMessage,
  messageStats,
  parseIncomingMessage,
  shouldRecord,
  shouldRespond,
  type IncomingMessage,
} from './message';
import { createNameResolver, type NameResolver } from './names';
import { SYSTEM_CLOCK, createProgressiveEditor, type ProgressiveEditor } from '../discord/editor';
import { mentionPrefix, withMention } from '../discord/mention';
import { maybeSendVoice } from '../discord/voice-reply';

/** 宿主只需提供这三样：数据库、可排期的 KV、后台任务入口 */
export interface GatewayHost {
  readonly db?: SqlDatabase;                       // 来自 src/core/db/sql.ts
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };
  waitUntil(task: Promise<unknown>): void;
}

/**
 * 凭证不是「宿主能力」而是「部署事实」，所以不在 GatewayHost 契约里（那份接口只描述能做什么）。
 * 两个适配器各自按部署事实补上：DO 从 env 取，Node 从启动参数取。
 * 全空时引擎安静地不连 —— 与「没配 DISCORD_BOT_TOKEN」的老行为一致。
 */
export interface GatewayEngineHost extends GatewayHost {
  readonly botToken?: string;
  readonly applicationId?: string;
  readonly keyEncryptionSecret?: string;
  // 语音合成端口不再由宿主注入：后台配置是唯一来源，每轮消息自己读一次（见 #handleMessage）
}

/** 引擎对外的两个入口：宿主只认这两个（以及 GATEWAY_SHUTDOWN_PATH 那条内部路径） */
export interface GatewayEngine {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

/** 引擎只对宿主开放：这几个路径不会出现在 default fetch 的任何公开路由里 */
export const GATEWAY_INTERNAL_ORIGIN = 'https://gateway.internal';
export const GATEWAY_ENSURE_PATH = '/ensure';
export const GATEWAY_STATUS_PATH = '/status';
/**
 * 契约里的引擎只有 fetch / alarm 两个入口，而 Node 宿主的 stop() 必须能把 socket 关掉，
 * 又不该为此加宽那个类型面，所以「停」做成第三条内部路径。
 * DO 永不调用它：DO 只会被驱逐，没有优雅停机这一步。
 */
export const GATEWAY_SHUTDOWN_PATH = '/shutdown';

/** 引擎版本标记：DO 在每次 alarm 打一次、Node 宿主启动时打一次，用来确认线上跑的是哪一版 */
export const GATEWAY_BUILD = 'image-settings-1';

/** 握手看门狗：连上了却一直没等到 HELLO 时，靠这次 alarm 把宿主再唤醒一次 */
const HANDSHAKE_WATCHDOG_MS = 15000;

/** 自定义表情清单缓存（§18.6/§18.7）：按服务器缓存 10 分钟，失败同样缓存 10 分钟 */
const EMOJI_CACHE_TTL_MS = 600_000;

/** §23.7：后台补认一次最多认几个表情（36 个表情约 6 次模型调用，分批消化） */
const EMOJI_DESCRIBE_LIMIT = 12;

/** §28.4：可贴表情的候选消息上限（最近 10 条 + 触发 + 被回复，去重后截到这么多条） */
const REACTION_TARGET_LIMIT = 10;

/** §28.4：候选消息的正文摘录长度（模型只用它认消息，长得像正文反而会被当成指令） */
const REACTION_EXCERPT_LENGTH = 30;

/** §29.3：一轮回复最多编辑几次第一条消息（Discord 对同一频道的 PATCH 有速率限制，留一点余量） */
const STREAM_MAX_EDITS = 20;

/** 持久化状态在 storage 里的 key（只存跨驱逐有意义的部分） */
export const GATEWAY_STATE_KEY = 'gateway:state';

/**
 * 与 index.ts 的 CHAT_CONFIG 同值（契约 §9/§6）：普通消息回复沿用同一套记忆配置，
 * 同样只注入最近 50 条原文、每 50 条未总结消息后台大总结一次。
 */
const MESSAGE_CHAT_CONFIG = { burstEditIntervalMs: 1200, historyMaxMessages: 50, summaryEveryMessages: 50 };

const MESSAGE_BOT_NAME = 'DC AI BOT';

/** 清单装配要的两份读取（§23.7 描述、§24.7 别名）；任一份失败都只是对应增强缺席 */
interface EmojiMetaDeps extends DescribeDeps {
  emojiAliases: EmojiAliasStore;
}

let providersCache: Record<ProviderId, LlmProvider> | null = null;

/** providers 无密钥、无请求态，isolate 内复用一份 */
function providers(): Record<ProviderId, LlmProvider> {
  const cached = providersCache;
  if (cached !== null) return cached;
  const created = createProviders();
  providersCache = created;
  return created;
}

/**
 * §24.7：把管理员配的别名按 emojiId 挂到对应表情上。指不到任何表情的别名就地丢弃
 * （表情后来被服务器删掉时别名静默失效，§24.9 第 4 条），不报错也不占位。
 */
function attachAliases(emojis: CustomEmoji[], rows: readonly EmojiAlias[]): CustomEmoji[] {
  const byEmojiId = new Map<string, string[]>();
  for (const row of rows) {
    const alias = row.alias.trim();
    if (alias === '') continue;
    const list = byEmojiId.get(row.emojiId);
    if (list === undefined) byEmojiId.set(row.emojiId, [alias]);
    else if (!list.includes(alias)) list.push(alias);
  }
  if (byEmojiId.size === 0) return emojis;
  return emojis.map((emoji): CustomEmoji => {
    const aliases = byEmojiId.get(emoji.id);
    return aliases === undefined ? emoji : { ...emoji, aliases };
  });
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/** 把聊天层的英文错误翻成用户能看懂的一句话，其余原样回显 */
function describeChatError(error: unknown): string {
  const message = describeError(error);
  if (message.startsWith('NO_ROUTE_CONFIGURED')) return '管理后台还没有配置可用的模型路由。';
  if (message.startsWith('ALL_PROVIDERS_FAILED')) return '所有模型都调用失败，请检查后台的 Key 与模型名。';
  return message;
}

/** 自定义表情清单缓存的形状：与 ./names.ts 的取值缓存同构 */
interface EmojiCacheEntry {
  emojis: CustomEmoji[];
  expiresAt: number;
}

/**
 * 回复的正是机器人自己时，名字写成这个（§60）。
 * 光是把昵称修对还不够：她自己的历史行不带署名，模型手里只剩一个「示例角色」的空名字，
 * 照样会把「她」当成第三个人；写「你自己」才能把这条回复认回自己身上。
 */
const SELF_REPLY_AUTHOR = '你自己';

/**
 * 网关字段 → core 的 ReplyRef（网关叫 authorName，core 侧叫 author）。
 * 不是回复时返回 undefined：TurnContext / ChatMessage 上连这个键都不该出现。
 */
function toReplyRef(message: IncomingMessage, botId: string): ReplyRef | undefined {
  const replyTo = message.replyTo;
  if (replyTo === null) return undefined;
  // 回复对象就是机器人自己：署名换成「你自己」，否则她会把那次回复读成外人的话（§60）
  const author = botId !== '' && replyTo.authorId === botId ? SELF_REPLY_AUTHOR : replyTo.authorName;
  return {
    messageId: replyTo.messageId,
    author,
    authorId: replyTo.authorId,
    content: replyTo.content,
  };
}

/** §28.4：清单里的摘录 = 正文前 30 字，换行折成空格（按码点切，别把 emoji 劈成半个代理对） */
function reactionExcerpt(content: string): string {
  const flat = content.replace(/\s+/gu, ' ').trim();
  return Array.from(flat).slice(0, REACTION_EXCERPT_LENGTH).join('');
}

/** §28.4：触发这一轮的那条消息永远是最合适的缺省目标，先把它放进清单 */
function triggerTarget(message: IncomingMessage): ReactionTarget {
  return {
    messageId: message.messageId,
    author: authorDisplayName(message.author),
    authorId: message.author.id,
    excerpt: reactionExcerpt(message.content),
  };
}

/**
 * §28.7 目标解析：messageId 命中清单就用它；否则按 authorName 找清单里同名作者的最新一条；
 * 两者都没有（模型没指定目标）就是触发这一轮的那条。
 * 返回 null = 「指定了但不在清单里」，调用侧跳过该条（§28.4 只允许贴清单里的消息）。
 */
function resolveReactionTarget(
  reaction: ReactionRequest,
  targets: readonly ReactionTarget[],
  triggerId: string,
): string | null {
  if (reaction.messageId !== undefined) {
    // 触发那条即便被 10 条上限截出清单也永远可贴：它就是本轮回复的原文
    if (reaction.messageId === triggerId) return triggerId;
    return targets.some((target) => target.messageId === reaction.messageId) ? reaction.messageId : null;
  }
  const authorName = reaction.authorName;
  if (authorName === undefined) return triggerId;
  const wanted = authorName.trim().toLowerCase();
  // 空目标名按「没指定」处理：只有 emoji 与一个空 @ 时，退化成触发那条
  if (wanted === '') return triggerId;
  // 清单是新的在前：第一个命中就是该作者「最新」的那条
  const hit = targets.find((target) => target.author.trim().toLowerCase() === wanted);
  return hit === undefined ? null : hit.messageId;
}

/** 贴表情计划的日志形态（§28.9）：只有表情与消息 ID，没有正文 */
function describeReactionPlan(plan: readonly ReactionRequest[], triggerId: string): string {
  // 没写目标不是「丢了目标」：约定里它就是贴在这一轮要回的那条上（resolveReactionTarget 的缺省分支），
  // 所以这里写「本回合」并带上那条的 ID——写 ? 会让人以为这条表情没贴出去。
  return plan.map((one) => one.emoji + '→' + (one.messageId ?? one.authorName ?? '本回合:' + triggerId)).join(',');
}

/** 越界告警只说「模型写了什么目标」，绝不带任何正文（§28.7 脱敏） */
function describeReactionTarget(reaction: ReactionRequest): string {
  if (reaction.messageId !== undefined) return 'messageId=' + reaction.messageId;
  if (reaction.authorName !== undefined) return 'authorName=' + reaction.authorName;
  return '（未指定）';
}

class GatewayEngineCore {
  readonly #host: GatewayEngineHost;
  #data: GatewayState = { ...EMPTY_GATEWAY_STATE };
  #socket: WebSocket | null = null;
  #loaded = false;
  #persistedJson = '';
  /** 串行化所有可能改状态的事件（fetch / alarm / message / close） */
  #queue: Promise<void> = Promise.resolve();
  /** 服务器名 / 频道名解析器：自带 TTL 缓存，必须跨消息复用 */
  #names: NameResolver | null = null;
  /** 服务器自定义表情清单：与 #names 同理，缓存必须跨消息复用，所以挂在实例上 */
  #emojis = new Map<string, EmojiCacheEntry>();
  /** 运行日志 sink（§19.9）：与入口共用同一份环形表，只建一次后复用 */
  #sink: ((entry: LogEntry) => void) | null = null;
  /** 宿主已喊停：之后一律不建 socket、不排 alarm（Node 进程退出前必须能彻底静止） */
  #stopped = false;

  constructor(host: GatewayEngineHost) {
    this.#host = host;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === GATEWAY_ENSURE_PATH) {
        await this.#serialize(() => this.#ensure());
        return jsonResponse({ ok: true, ...this.#snapshot() });
      }
      if (path === GATEWAY_STATUS_PATH) {
        await this.#serialize(async () => {
          await this.#ensureLoaded();
        });
        return jsonResponse({ ok: true, ...this.#snapshot() });
      }
      if (path === GATEWAY_SHUTDOWN_PATH) {
        await this.#serialize(() => this.#shutdown());
        return jsonResponse({ ok: true, ...this.#snapshot() });
      }
      return jsonResponse({ ok: false, error: 'not found' }, 404);
    } catch (error) {
      console.error('[gateway] 处理 ' + path + ' 失败：' + describeError(error));
      return jsonResponse({ ok: false, error: describeError(error) }, 500);
    }
  }

  async alarm(): Promise<void> {
    if (this.#stopped) return;
    try {
      console.log('[gateway] alarm build=' + GATEWAY_BUILD);
      await this.#serialize(async () => {
        await this.#ensureLoaded();
        const socket = this.#socket;
        const alive = socket !== null && socket.readyState === WebSocket.OPEN;
        if (!alive || !this.#data.connected) {
          // 两种情况都当作「握手/连接已不可信」：
          //   1) 没有活连接（被驱逐、被服务端掐断、还没连上）
          //   2) socket 活着但还没收到 READY（HELLO/READY 迟迟不来，看门狗超时）
          // 握手没走完就发 op1 会被服务端直接断开，所以这里一律重连而不是发心跳。
          await this.#connect();
          return;
        }
        await this.#apply(reduceGatewayEvent(this.#data, { kind: 'heartbeatTick' }, this.#deps()));
      });
    } catch (error) {
      console.error('[gateway] alarm 处理失败：' + describeError(error));
      await this.#scheduleReconnectSafely();
    }
  }

  // -------------------------------------------------------------- 连接管理

  /** 定时保活进来的入口：有活连接就只保证 alarm 还在，否则立刻（重）连 */
  async #ensure(): Promise<void> {
    await this.#ensureLoaded();
    if (this.#stopped) return;
    if (!this.#tokenConfigured()) {
      console.error('[gateway] 未配置 DISCORD_BOT_TOKEN，跳过 Gateway 连接（bot 将保持离线）');
      return;
    }
    const socket = this.#socket;
    const alive = socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
    if (!alive) {
      await this.#connect();
      return;
    }
    // 连接是好的：只补一次 alarm，避免把已在途的心跳拍子提前
    if ((await this.#host.storage.getAlarm()) === null) {
      const intervalMs = this.#data.heartbeatIntervalMs ?? 0;
      await this.#host.storage.setAlarm(Date.now() + heartbeatDelayMs(intervalMs));
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const token = this.#token();
    if (token === '') {
      console.error('[gateway] 缺少 DISCORD_BOT_TOKEN，放弃本次连接尝试');
      return;
    }

    this.#closeSocket('REPLACED_BY_NEW_CONNECTION');

    // RESUME 不会重新协商 intents：只有会话当初谈的档位与当前档位完全一致才复用它，
    // 否则一律重新 IDENTIFY（否则会静默沿用旧档——例如 intents=0 的旧会话永远收不到 MESSAGE_CREATE）。
    const nowMs = Date.now();
    const resuming = resumable(this.#data, nowMs);
    const intents = intentsFor(this.#data, nowMs);
    const resumeUrl = this.#data.resumeUrl;
    const url = resuming && resumeUrl !== null ? resumeConnectUrl(resumeUrl) : GATEWAY_URL;

    // 新 socket 一建立，重连排期就算被消费掉了（否则下一次 close 会误判成「已排期」而不排
    // alarm，宿主就再也不被唤醒）；一条新连接的存活确认也从零开始。
    // 不复用会话时把旧会话痕迹一并清掉，免得它继续影响 #snapshot 与后续判断。
    this.#data = resuming
      ? { ...this.#data, pendingReconnect: false, awaitingAck: false, connected: false }
      : {
          ...this.#data,
          sessionId: null,
          resumeUrl: null,
          sessionIntents: null,
          seq: null,
          pendingReconnect: false,
          awaitingAck: false,
          connected: false,
        };

    const socket = new WebSocket(url);
    // 2025-09-01 的 compatibility_date 默认就是 arraybuffer，这里写死以免行为随 flag 变
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      void this.#onMessage(event.data);
    });
    socket.addEventListener('close', (event) => {
      void this.#onClose(socket, event);
    });
    socket.addEventListener('error', (event) => {
      console.error('[gateway] 连接报错：' + event.type);
      this.#logGateway('error', '连接报错 ' + event.type);
    });
    this.#socket = socket;

    await this.#host.storage.setAlarm(Date.now() + HANDSHAKE_WATCHDOG_MS);
    console.log(
      resuming
        ? '[gateway] RESUME intents=' + String(intents) + '（沿用会话，不重新协商）→ ' + url
        : '[gateway] IDENTIFY intents=' + String(intents) + ' → ' + url,
    );
  }

  /** 宿主停机：关掉 socket 并让引擎之后彻底静止（不再建 socket、不再排 alarm） */
  async #shutdown(): Promise<void> {
    this.#stopped = true;
    this.#closeSocket('shutdown');
  }

  async #onMessage(raw: unknown): Promise<void> {
    const frame = typeof raw === 'string' || raw instanceof ArrayBuffer ? parseFrame(raw) : null;
    if (frame === null) {
      console.error('[gateway] 丢弃无法解析的下行帧');
      this.#logGateway('warn', '丢弃无法解析的下行帧');
      return;
    }
    try {
      await this.#serialize(async () => {
        await this.#ensureLoaded();
        await this.#apply(reduceGatewayEvent(this.#data, { kind: 'frame', frame }, this.#deps()));
      });
    } catch (error) {
      console.error('[gateway] 处理下行帧失败：' + describeError(error));
    }
  }

  async #onClose(socket: WebSocket, event: CloseEvent): Promise<void> {
    try {
      await this.#serialize(async () => {
        // 已经被新连接替换掉的旧 socket：它的 close 不该触发又一次重连
        if (this.#socket !== socket) return;
        this.#socket = null;
        await this.#ensureLoaded();
        const reduced = reduceGatewayEvent(
          this.#data,
          {
            kind: 'socketClosed',
            reason: 'code ' + String(event.code),
            code: typeof event.code === 'number' ? event.code : null,
          },
          this.#deps(),
        );
        await this.#apply(reduced);
      });
    } catch (error) {
      console.error('[gateway] 处理连接关闭失败：' + describeError(error));
    }
  }

  /** alarm 自己炸了以后的兜底：无论状态如何都再排一次 alarm，别让宿主静默躺平 */
  async #scheduleReconnectSafely(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#host.storage.setAlarm(Date.now() + HANDSHAKE_WATCHDOG_MS);
    } catch (error) {
      console.error('[gateway] 兜底排期失败：' + describeError(error));
    }
  }

  // -------------------------------------------------------------- 状态

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    let stored: PersistedGatewayState | undefined;
    try {
      stored = await this.#host.storage.get<PersistedGatewayState>(GATEWAY_STATE_KEY);
    } catch (error) {
      console.error('[gateway] 读取持久化状态失败，按空状态处理：' + describeError(error));
      stored = undefined;
    }
    this.#data = restoreGatewayState(stored);
    this.#persistedJson = JSON.stringify(serializeGatewayState(this.#data));
    this.#loaded = true;
  }

  async #persist(): Promise<void> {
    const snapshot = serializeGatewayState(this.#data);
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.#persistedJson) return;
    this.#persistedJson = serialized;
    try {
      await this.#host.storage.put(GATEWAY_STATE_KEY, snapshot);
    } catch (error) {
      console.error('[gateway] 写入持久化状态失败：' + describeError(error));
    }
  }

  // -------------------------------------------------------------- 普通消息

  /** bot 自己的 id：READY 给的优先，否则用 DISCORD_APPLICATION_ID（两者本应相等） */
  #botId(): string {
    if (this.#data.botUserId !== null) return this.#data.botUserId;
    const configured = this.#host.applicationId;
    return typeof configured === 'string' ? configured.trim() : '';
  }

  /**
   * 日志字段：只有 id 与量纲，绝不放正文。
   * rawLen=0 说明 Discord 压根没给 content（缺 MESSAGE_CONTENT 特权位）；
   * rawLen>0 而 textLen=0 说明正文只是「一个 @ 提及」。
   */
  #logFields(message: IncomingMessage): string {
    const stats = messageStats(message, this.#botId());
    return (
      ' guild=' +
      (message.guildId ?? 'dm') +
      ' channel=' +
      message.channelId +
      ' mentions=' +
      String(stats.mentions) +
      ' textLen=' +
      String(stats.textLen) +
      ' rawLen=' +
      String(stats.rawLen)
    );
  }

  /** 网关事件不参与 #queue：模型 + REST 可能跑十几秒，串进去会卡住心跳与重连 */
  #dispatch(name: string, data: unknown): void {
    if (name !== 'MESSAGE_CREATE') return;
    const message = parseIncomingMessage(data);
    if (message === null) {
      console.error('[gateway] dispatch MESSAGE_CREATE 无法解析，已丢弃');
      return;
    }
    console.log('[gateway] dispatch build=' + GATEWAY_BUILD + this.#logFields(message));
    this.#host.waitUntil(this.#handleMessage(message));
  }

  async #handleMessage(message: IncomingMessage): Promise<void> {
    try {
      const decision = shouldRespond(message, this.#botId());
      if (!decision.respond) {
        // 与「压根没收到事件」区分开：这条日志说明网关投递到了，是我们主动不回
        console.log('[gateway] 跳过消息（' + decision.reason + '）' + this.#logFields(message));
        // 不回，但人类在频道里说的话仍要进记忆；被 @ / 被回复的回合由 chat service 落库，
        // shouldRecord 会在那个分支返回 false，所以这里绝不会重复写。
        if (shouldRecord(message, decision)) await this.#recordMessage(message);
        return;
      }

      const token = this.#token();
      const db = this.#host.db;
      const secret = this.#secret();
      if (token === '') return;
      if (db === undefined || secret === '') {
        console.error('[gateway] 缺少 DB / KEY_ENCRYPTION_SECRET 绑定，无法回复普通消息');
        return;
      }

      if (decision.reason === 'empty-addressed') {
        // 只 @ 了一下（或私聊空消息）：不再静默，只交一句事实标记，怎么接由她自己判断
        console.log('[gateway] 空正文 → 她自己接（empty-addressed）' + this.#logFields(message));
      }

      // 服务器名 / 频道名走 REST（带 10 分钟缓存）：模型靠它知道「这是哪儿」。
      // 私聊没有服务器，频道名也保持空串，身份块里那两段会被整段省略。
      let guildName = '';
      let channelName = '';
      if (message.guildId !== null) {
        try {
          const names = this.#nameResolver();
          const [guild, room] = await Promise.all([
            names.guildName(message.guildId),
            names.channelName(message.channelId),
          ]);
          guildName = guild;
          channelName = room;
        } catch (error) {
          // 取名失败绝不影响回复：回落空串继续
          console.error('[gateway] 取名失败，回落空串：' + describeError(error));
          this.#logGateway('warn', '取名失败 ' + describeError(error));
        }
      }

      // 自定义表情清单（同样 10 分钟缓存）：提示词里那一段与 :name: 的解析都靠它。
      // 私聊没有服务器，取不到就是空清单——表情这事绝不许拖累回复。
      const customEmojis = message.guildId === null ? [] : await this.#emojiCatalog(message.guildId);

      const channel = createChannelClient({ botToken: token });
      try {
        // 先打 typing：模型首包通常要几秒，用户能看到「正在输入」
        await channel.sendTyping(message.channelId);
      } catch (error) {
        console.error('[gateway] typing 失败：' + describeError(error));
      }

      // §38：切片次数的三层配置也在同一套仓储里，先拿到手再交给 chat service
      const repos = createRepositories(db, createSecretBox(secret));
      const chat = createChatService({
        ...repos,
        providers: providers(),
        config: MESSAGE_CHAT_CONFIG,
        // 自动摘要走宿主的 waitUntil：回复已经发出，摘要不占回复时延
        background: (task: Promise<unknown>) => this.#host.waitUntil(task),
        // 回复成功/失败由 ChatService 记（scope chat），网关这边不重复记（§19.9）
        log: this.#logSink(),
      });
      // §41：主模型识图开关也每条消息解析一次（channel > guild > global），改完下一条消息立刻生效，不缓存。
      // readVisionEnabled 内部吞掉读库异常并落默认值（开）—— 开关读不出来绝不能把这条回复弄失败。
      const visionOn = await readVisionEnabled(repos.visionSettings, {
        guildId: message.guildId ?? '',
        channelId: message.channelId,
      });
      // §28.4：候选清单只在「要贴表情的那一轮」组装 —— 普通消息路径的 wantReactions 恒为 true，
      // 斜杠命令走 index.ts，不经过这里。REST 失败只 warn，清单退化成「触发 + 被回复」，绝不影响回复。
      const reactionTargets = await this.#reactionTargets(message);
      // §64：群里挂的是服务器昵称，摘要与 {{bot_name}} 都该用它；取不到才退回代码常量
      const botDisplayName =
        (await resolveBotDisplayName(
          { botToken: this.#token(), botId: this.#botId() },
          message.guildId ?? '',
        )) || MESSAGE_BOT_NAME;
      const context: TurnContext = {
        guildId: message.guildId ?? '',
        channelId: message.channelId,
        userId: message.author.id,
        userName: authorDisplayName(message.author),
        guildName,
        channelName,
        botName: botDisplayName,
        userText: decision.text,
        storedUserText: decision.storedText,
        // §21：普通消息允许表情模型额外挑一个表情（斜杠命令路径不设这个开关）
        wantReactions: true,
        // §41：关掉只掐主对话那一路请求；表情模型那一路不看这个字段，照旧能看同一轮的图
        mainImages: visionOn,
      };
      // §62：本条发言的 Discord 消息 id 随上下文带给落库，后台删这条记忆时才能精确删掉群里那条
      context.userDiscordId = message.messageId;
      // 回复链：不是回复时连键都不设，普通消息的提示词与老行为完全一致
      const replyTo = toReplyRef(message, this.#botId());
      if (replyTo !== undefined) context.replyTo = replyTo;
      if (customEmojis.length > 0) context.customEmojis = customEmojis;
      // 清单永远非空（触发那条必在里面）：模型不指定目标时网关也能贴回原文
      if (reactionTargets.length > 0) context.reactionTargets = reactionTargets;
      // §22.4：带图才挂懒加载钩子 —— 空数组时连键都不设，纯文字路径与旧版逐字相同。
      // fetch 照 ./channel-rest 与 ./names 的写法在调用时读 globalThis.fetch：裸引用会被 workerd brand-check。
      const imageRefs = collectImageRefs(message);
      if (imageRefs.length > 0) {
        const imageFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
          globalThis.fetch(input, init);
        // §22.4 同轮 memo：主对话与表情模型各调一次 loadImages，但一轮只下载一次
        let cachedImages: Promise<LlmImage[]> | undefined;
        context.loadImages = (): Promise<LlmImage[]> => (cachedImages ??= loadImages(imageRefs, imageFetch));
      }

      // §38：切片次数每条消息按当前频道解析一次（channel > guild > global），改完下一条消息立刻生效。
      // readRevealSteps 内部吞掉读库异常并落默认值 —— 开关读不出来绝不能把这条回复弄失败。
      const revealSteps = await readRevealSteps(repos.replySettings, {
        guildId: message.guildId ?? '',
        channelId: message.channelId,
      });
      // 语音回复的三层配置同批读出：读失败落 null（= 不念），绝不拖住回复
      const voiceSettings = await readVoiceSettings(repos.voiceSettings, {
        guildId: message.guildId ?? '',
        channelId: message.channelId,
      });
      // 只有「按指令」模式才挂提示段：其余模式连键都不设，普通消息的提示词与加这个字段之前逐字相同
      if (voiceSettings?.mode === VOICE_MODE_ON_REQUEST) context.voiceHint = true;

      // TTS 配置每轮现读一次：后台改完下一条消息就生效，进程里不缓存明文。
      // 读失败只 warn 并当作未配置 —— 语音是附加项，绝不能把这一轮回复弄失败。
      let tts: TtsPort = createUnconfiguredTts();
      // 判断语气的模型：judge 三字段都非空才算配好，否则这条语音只走固定提示词
      let judge: TtsStyleJudgeConfig | null = null;
      // 方言同样现读：gemini 要用英文标签指令，否则 judge 写的中文标签会被念出来
      let ttsDialect: TtsDialect | undefined;
      try {
        const storedTts = await repos.ttsSettings.get();
        if (storedTts !== null) {
          ttsDialect = storedTts.dialect;
          const ttsConfig = ttsConfigFrom(storedTts);
          if (ttsConfig !== null) tts = createTts(ttsConfig);
          const candidate = { url: storedTts.judgeUrl, key: storedTts.judgeKey, model: storedTts.judgeModel };
          if (isJudgeConfigured(candidate)) judge = candidate;
        }
      } catch (error) {
        this.#logGateway('warn', '读取语音合成配置失败，本轮不发语音：' + describeError(error));
      }

      // §29：@ 路径也流式 —— 首个 token 到了才建消息，之后边生成边把这条消息改成最新内容
      // 回复开头 @ 提问者：服务器频道才点名（私聊点名没有意义），失败兜底文案在下面把前缀清空
      const mention = message.guildId === null ? '' : mentionPrefix(message.author.id);
      const stream = await this.#openStream(message.channelId, channel, revealSteps, mention);
      let text: string;
      let image: TurnResult['image'];
      let reactions: ReactionRequest[] = [];
      // 故障提示不是聊天回复：finish 用它把 @ 前缀覆盖成空串
      let mentionOverride: string | undefined;
      // 本轮模型写没写 [[voice]]：只有这个字段为真，「按指令」模式才会念
      let voiceRequested = false;
      // §62：落库正文（chat.run 存进库的就是它），后面按它把 Discord 消息 id 贴到那一行上
      let storedReplyText: string | undefined;
      try {
        const result = await chat.run(context, { onProgress: (partial) => stream.push(partial) });
        image = result.image;
        if (result.text.trim() !== '') storedReplyText = result.text;
        // 只发图的那轮正文是空的：不写兜底文案，这条文字消息根本不该存在
        text = result.text.trim() === '' ? (result.image === undefined ? '（模型没有返回内容）' : '') : result.text;
        reactions = result.reactions;
        // 空回复的兜底文案不是模型的话，不能念
        voiceRequested = result.voiceRequested === true && result.text.trim() !== '';
      } catch (error) {
        console.error('[gateway] 回复生成失败（' + decision.reason + '）：' + describeError(error));
        text = '回复生成失败：' + describeChatError(error);
        mentionOverride = '';
      }

      // 画图：模型调 draw_image 的那轮没有正文，图由服务层生成，这里直接以附件发出。
      // 只发图时连一条空文字消息都不建（stream 没 push 过，还只是空壳）
      const imageOnly = image !== undefined && text.trim() === '';
      let imageSent = false;
      if (image !== undefined) {
        const sendImage = channel.sendFile;
        if (sendImage !== undefined) {
          try {
            await sendImage.call(channel, message.channelId, image.data, {
              // Discord 按后缀预览：jpeg 用 .jpg，其余按 mime 推断一个能预览的后缀
              name: image.mime === 'image/png' ? 'image.png' : image.mime === 'image/webp' ? 'image.webp' : 'image.jpg',
              contentType: image.mime,
            });
            imageSent = true;
          } catch (error) {
            this.#logGateway('warn', '发送图片失败：' + describeError(error));
          }
        }
        // 图没发出去又没别的正文：给一句话，别让这一轮彻底空着
        if (!imageSent && imageOnly) text = '（图片没发出去）';
      }
      if (!imageOnly || !imageSent) {
      // 正文里的 :名字: 先渲染成 <:名字:id> 再切段：切的是最终文本，标记不会被切成两半
      // 切段上限先扣掉 @ 前缀：先按 1900 切再拼前缀，withMention 会把首段尾巴削掉、第二段接不上
      const chunkLimit = Math.max(1, MESSAGE_CHUNK_LIMIT - mention.length);
      const chunks = chunkMessage(resolveInlineEmojis(text, customEmojis), chunkLimit);
      const replyId = await stream.finish(chunks[0] ?? '（空回复）', mentionOverride);
      // §62：正文本轮已落库（chat.run 内 append），按正文把刚发出的那条 Discord 消息 id 补进这一行。
      // 记不上只影响后台能不能一键删群里那条，绝不影响已经发出去的回复。
      if (replyId !== '' && storedReplyText !== undefined) {
        try {
          await repos.conversations.attachDiscordId?.(
            { guildId: message.guildId ?? '', channelId: message.channelId },
            storedReplyText,
            replyId,
          );
        } catch (error) {
          this.#logGateway('warn', '记录回复的 Discord 消息 id 失败：' + describeError(error));
        }
      }
      for (const chunk of chunks.slice(1)) {
        await channel.sendMessage(message.channelId, chunk);
      }
      }
      // 回复已经发出去了：贴表情是锦上添花，失败只 warn，绝不影响回复与后续流程
      await this.#react(message, reactions, customEmojis, reactionTargets);

      // 三层语气提示词：channel > guild > global。只有真到要发语音时才被调用（闭包里也不提前读库），
      // 读库失败只 warn 并返回空串 —— 语气是附加项，语音照发。
      const stylePrompt = async (): Promise<string> => {
        try {
          const channelLayer = await repos.ttsStyles.get({ scope: 'channel', scopeId: message.channelId });
          const guildId = message.guildId ?? '';
          const guildLayer = guildId === '' ? null : await repos.ttsStyles.get({ scope: 'guild', scopeId: guildId });
          const globalLayer = await repos.ttsStyles.get({ scope: 'global', scopeId: '' });
          return resolveStylePrompt({ channel: channelLayer, guild: guildLayer, global: globalLayer });
        } catch (error) {
          this.#logGateway('warn', '读取语气提示词失败，本条语音按无提示词处理：' + describeError(error));
          return '';
        }
      };

      // 语音同样是附加项：单独一条附件消息，任何失败只 warn（maybeSendVoice 内部兜住）
      const sendVoiceFile = channel.sendFile;
      if (sendVoiceFile !== undefined) {
        await maybeSendVoice({
          settings: voiceSettings,
          tts,
          text,
          wanted: voiceRequested,
          judge,
          ...(ttsDialect === undefined ? {} : { dialect: ttsDialect }),
          stylePrompt,
          send: async (audio: Uint8Array): Promise<void> => {
            // 附件形状由端口声明：gemini 是 WAV、其余是 mp3，发送层不该自己猜
            await sendVoiceFile.call(channel, message.channelId, audio, tts.file);
          },
          log: (line: string): void => this.#logGateway('warn', line),
          // 成功也留一条 info：事后才知道这条到底发没发、用了什么标签（只记标签与字节数，不记正文）
          logInfo: (line: string): void => this.#logGateway('info', line),
        });
      }
    } catch (error) {
      console.error('[gateway] 处理普通消息失败：' + describeError(error));
    }
  }

  /**
   * §29：把「流式进度 ⇒ 同一条消息的反复编辑」包成 push / finish 两个方法。
   *
   * 消息是**首个 token 到了才建的**：不推空的占位，第一条内容就是正文开头。建好之后一直 PATCH 这一条。
   *
   * 建消息失败（没权限、REST 抖动）时退回整段发送：之后 push 变空操作，finish 直接发全文，
   * 行为与流式之前完全一致 —— 流式是观感优化，不许因为它让回复变得发不出去。
   *
   * mention 是「回复开头 @ 提问者」的前缀（私聊传空串）：三条发送口都要带上，观感不能中途掉。
   * finish 的第二参数覆盖它 —— 错误兜底文案不是聊天回复，不该点名。
   */
  async #openStream(
    channelId: string,
    channel: ChannelClient,
    revealSteps: number,
    mention: string,
  ): Promise<{ push(text: string): void; finish(text: string, mentionOverride?: string): Promise<string> }> {
    let latest: string | null = null;
    let editor: ProgressiveEditor | null = null;
    let abandoned = false;
    let activeMention = mention;
    // §62：这一轮最终落在哪条 Discord 消息上（首条建的、或整段发的），落库时记进 discord_id
    let messageId = '';
    // push 是同步回调（core 的 onProgress 不等它），建消息却是 async：排队串起来，finish 再等它落定
    let chain: Promise<void> = Promise.resolve();

    const push = (text: string): void => {
      // 预算用参数 mention（整条回复恒定），不用 activeMention：finish 会把它覆盖成空串
      const first = chunkMessage(text, Math.max(1, MESSAGE_CHUNK_LIMIT - mention.length))[0];
      if (first === undefined || first === '') return;
      latest = first;
      if (abandoned) return;
      chain = chain.then(async () => {
        if (abandoned) return;
        const content = latest ?? first;
        if (editor === null) {
          let id: string;
          try {
            id = await channel.createMessage(channelId, withMention(content, activeMention, MESSAGE_CHUNK_LIMIT));
            messageId = id;
          } catch (error) {
            abandoned = true;
            console.error('[gateway] 首条消息发送失败，退回整段发送：' + describeError(error));
            return;
          }
          editor = createProgressiveEditor({
            send: (next: string) =>
              channel.editMessage(channelId, id, withMention(next, activeMention, MESSAGE_CHUNK_LIMIT)),
            clock: SYSTEM_CLOCK,
            intervalMs: MESSAGE_CHAT_CONFIG.burstEditIntervalMs,
            maxEdits: STREAM_MAX_EDITS,
            maxChars: MESSAGE_CHUNK_LIMIT,
            revealSteps,
            onError: (error) => console.error('[gateway] 流式编辑失败：' + describeError(error)),
          });
          // 建消息用的就是此刻最新的文本，不必再 PATCH 一次同样的内容
          return;
        }
        editor.push(content);
      });
    };

    const finish = async (text: string, mentionOverride?: string): Promise<string> => {
      // 先等排队的 push 走完（它们用聊天前缀），再换成这一条要用的前缀
      await chain;
      if (mentionOverride !== undefined) activeMention = mentionOverride;
      if (editor !== null) {
        await editor.finish(text);
        return messageId;
      }
      // §62：整段发送也走 createMessage：多要一个 `?wait=true`，换回消息 id 记进历史行
      messageId = await channel.createMessage(channelId, withMention(text, activeMention, MESSAGE_CHUNK_LIMIT));
      return messageId;
    };

    return { push, finish };
  }

  /**
   * 只做记忆落库：不调 Discord REST、不调模型。
   * 频道里没被 @ 的人类发言靠它进 messages；调用点已在 waitUntil 里，数据库的写不影响心跳与回复时延。
   */
  async #recordMessage(message: IncomingMessage): Promise<void> {
    try {
      const db = this.#host.db;
      const secret = this.#secret();
      if (db === undefined || secret === '') {
        console.error('[gateway] 缺少 DB / KEY_ENCRYPTION_SECRET 绑定，无法记录频道消息');
        return;
      }
      const repos = createRepositories(db, createSecretBox(secret));
      const row: ChatMessage = {
        role: 'user',
        content: message.content,
        author: authorDisplayName(message.author),
        authorId: message.author.id,
        // §62：后台删这条记忆时要能精确删掉群里那条
        discordId: message.messageId,
      };
      // 没 @ 到 bot 的普通消息也要把「回复了谁」带进记忆，否则回复链在记忆里断掉
      const replyTo = toReplyRef(message, this.#botId());
      if (replyTo !== undefined) row.replyTo = replyTo;
      await repos.conversations.append({ guildId: message.guildId ?? '', channelId: message.channelId }, [row]);
      console.log('[gateway] 记录消息（not-addressed）' + this.#logFields(message));
    } catch (error) {
      // 记忆写失败绝不冒泡：回复路径与心跳都不该被它带垮
      console.error('[gateway] 记录消息失败：' + describeError(error));
      this.#logGateway('error', '记录消息失败 ' + describeError(error));
    }
  }

  // -------------------------------------------------------------- 自定义表情 / 贴表情

  /**
   * 该服务器可用的自定义表情（§18.6）：按服务器内存缓存 10 分钟，失败只在日志里留一句并回落空清单。
   * 没配 token / 私聊（guildId 空）直接空清单，连 REST 都不打。
   * §23.7：清单取回来后把库里的描述并进来，所以命中缓存时一次库都不读。
   */
  async #emojiCatalog(guildId: string): Promise<CustomEmoji[]> {
    const token = this.#token();
    if (token === '' || guildId === '') return [];
    const nowMs = Date.now();
    const cached = this.#emojis.get(guildId);
    if (cached !== undefined && cached.expiresAt > nowMs) return cached.emojis;

    let emojis: CustomEmoji[] = [];
    try {
      emojis = await this.#withDescriptions(guildId, await listGuildEmojis({ botToken: token }, guildId));
    } catch (error) {
      console.warn('[gateway] 取自定义表情失败：' + describeError(error));
    }
    // 失败也进缓存：网络/权限没恢复之前，不必每条消息都去打一次注定失败的 REST
    this.#emojis.set(guildId, { emojis, expiresAt: nowMs + EMOJI_CACHE_TTL_MS });
    return emojis;
  }

  /**
   * §23.7 第 1、2 条 + §24.7：把库里的描述与管理员配的别名并进清单，并顺手挂一次后台补认。
   * 三步都不许影响回复：读描述失败只 warn（清单退回「只有名字」的老行为）、读别名失败同样只 warn
   * （按没有别名继续），补认走 waitUntil 不 await。两次读都只发生在这条 10 分钟缓存里。
   */
  async #withDescriptions(guildId: string, emojis: CustomEmoji[]): Promise<CustomEmoji[]> {
    const deps = this.#describeDeps();
    if (deps === null) return emojis;
    let merged = emojis;
    try {
      const rows: EmojiDescription[] = await deps.emojiDescriptions.list(guildId);
      const byId = new Map(rows.map((row) => [row.emojiId, row.description]));
      merged = emojis.map((emoji): CustomEmoji => {
        const description = byId.get(emoji.id);
        if (description === undefined || description.trim() === '') return emoji;
        return { ...emoji, description };
      });
      if (merged.some((emoji) => emoji.description === undefined)) this.#describeInBackground(deps, guildId);
    } catch (error) {
      // 读不出描述就别补认：写库多半同样不可用，下一轮缓存到期再试
      console.warn('[emoji] 读描述失败：' + describeError(error));
    }
    try {
      return attachAliases(merged, await deps.emojiAliases.list(guildId));
    } catch (error) {
      console.warn('[emoji] 读别名失败：' + describeError(error));
      return merged;
    }
  }

  /** 认图与别名的依赖：DB / secret 缺失或仓储建不起来时返回 null（两者都是可选增强，缺了不影响聊天） */
  #describeDeps(): EmojiMetaDeps | null {
    const db = this.#host.db;
    const secret = this.#secret();
    if (db === undefined || secret === '') return null;
    try {
      const repos = createRepositories(db, createSecretBox(secret));
      return {
        reactionModels: repos.reactionModels,
        emojiDescriptions: repos.emojiDescriptions,
        emojiAliases: repos.emojiAliases,
        keys: repos.keys,
        providers: providers(),
      };
    } catch (error) {
      console.warn('[emoji] 认图依赖不可用：' + describeError(error));
      return null;
    }
  }

  /**
   * §23.7 第 2 条：清单里有表情缺描述就补认缺的那些（limit 12），绝不 await。
   * describeGuildEmojis 只在「取清单」这一步抛，这里 catch 住只 warn，回复早已发出。
   */
  #describeInBackground(deps: DescribeDeps, guildId: string): void {
    const token = this.#token();
    if (token === '') return;
    try {
      this.#host.waitUntil(
        describeGuildEmojis(deps, guildId, token, { limit: EMOJI_DESCRIBE_LIMIT }).catch((error: unknown) => {
          console.warn('[emoji] 后台补认失败：' + describeError(error));
        }),
      );
    } catch (error) {
      console.warn('[emoji] 后台补认排不进 waitUntil：' + describeError(error));
    }
  }

  /**
   * §28.4：这一轮允许贴表情的候选清单 —— 最近 10 条频道消息（REST，新的在前）+ 触发那一条 +
   * 被回复的那一条，按 messageId 去重后截到 10 条。
   *
   * 读最近消息失败只 warn 并退化成「触发 + 被回复」：这张清单只决定「模型能不能挑到别的消息」，
   * 少了它最多少贴几个表情，绝不许影响回复本身，也不许把整条消息处理带崩。
   * REST 一轮只打一次：清单在 #handleMessage 里组装一次，之后 #react 只用它的结果。
   */
  async #reactionTargets(message: IncomingMessage): Promise<ReactionTarget[]> {
    const merged: ReactionTarget[] = [];
    const add = (target: ReactionTarget): void => {
      if (merged.some((item) => item.messageId === target.messageId)) return;
      merged.push(target);
    };

    const token = this.#token();
    if (token !== '') {
      try {
        for (const row of await listChannelMessages({ botToken: token }, message.channelId, REACTION_TARGET_LIMIT)) {
          add({
            messageId: row.messageId,
            author: row.author,
            authorId: row.authorId,
            excerpt: reactionExcerpt(row.content),
            bot: row.bot,
          });
        }
      } catch (error) {
        console.warn('[gateway] 读最近消息失败：' + describeError(error));
      }
    }

    add(triggerTarget(message));
    const replyTo = message.replyTo;
    if (replyTo !== null) {
      add({
        messageId: replyTo.messageId,
        author: replyTo.authorName,
        authorId: replyTo.authorId,
        excerpt: reactionExcerpt(replyTo.content),
      });
    }
    return merged.slice(0, REACTION_TARGET_LIMIT);
  }

  /**
   * 把模型要求的每个表情贴到它的目标消息上（§28.6/§28.7）。
   * 表情：:name: 用当轮清单解析成 name:id，解析不到就 warn 跳过；其它值（unicode）原样用。
   * 目标：见 resolveReactionTarget —— 只可能落在清单里（或触发那条），越界一律跳过并 warn。
   * 每条各自 try：贴表情失败只 warn，绝不影响已经发出的回复，也不打断后面那几个。
   */
  async #react(
    message: IncomingMessage,
    reactions: ReactionRequest[],
    catalog: CustomEmoji[],
    targets: ReactionTarget[],
  ): Promise<void> {
    if (reactions.length === 0) return;
    const token = this.#token();
    if (token === '') return;
    // §28.9 / §28.10：只有模型点名 @all 才分散——那个表情按最近发言的不同人各贴一条；
    // 没点名的一条都不分配（落到它自己的目标，缺省就是触发那条），不再「按顺序硬摊给最近说话的人」
    const plan = expandBroadcast(reactions, targets, message.messageId);
    this.#logGateway('info', '贴表情 计划 ' + describeReactionPlan(plan, message.messageId));
    const options = { botToken: token };
    for (const reaction of plan) {
      try {
        const emoji = resolveReactionEmoji(reaction.emoji, catalog);
        if (emoji === null) {
          console.warn('[gateway] 表情不在该服务器的清单里，跳过：' + reaction.emoji);
          continue;
        }
        const targetId = resolveReactionTarget(reaction, targets, message.messageId);
        if (targetId === null) {
          console.warn('[gateway] 贴表情目标不在清单里，跳过：' + describeReactionTarget(reaction));
          continue;
        }
        await addMessageReaction(options, message.channelId, targetId, emoji);
      } catch (error) {
        console.warn('[gateway] 贴表情失败（' + reaction.emoji + '）：' + describeError(error));
        this.#logGateway('warn', '贴表情失败 ' + reaction.emoji + ' ' + describeError(error));
      }
    }
  }

  // -------------------------------------------------------------- 运行日志

  /**
   * §19.9：网关与入口共用同一份 store（环形表），sink 走宿主自己的 waitUntil。
   * DB 在宿主接口里是可选的（缺绑定只等于日志不可用）：没绑定就退化成 no-op，绝不在这里抛错。
   */
  #logSink(): (entry: LogEntry) => void {
    const cached = this.#sink;
    if (cached !== null) return cached;
    const sink = this.#createSink();
    this.#sink = sink;
    return sink;
  }

  /**
   * store 的构造本身就可能抛（DB 绑定半残时 prepare 不可用），
   * 所以这里也整段 try 住并缓存 no-op：失败只 warn 一次，绝不重试到把业务路径拖垮（§19.1）。
   */
  #createSink(): (entry: LogEntry) => void {
    const noop = (): void => undefined;
    const db = this.#host.db;
    if (db === undefined) return noop;
    let store: LogStore;
    try {
      store = createLogStore(db);
    } catch (error) {
      console.warn('[log] 写日志失败：' + describeError(error));
      return noop;
    }
    return (entry: LogEntry): void => {
      try {
        this.#host.waitUntil(
          store.append([entry]).catch((error: unknown) => {
            console.warn('[log] 写日志失败：' + describeError(error));
          }),
        );
      } catch (error) {
        console.warn('[log] 写日志失败：' + describeError(error));
      }
    };
  }

  /**
   * §19.9 的 gateway 事件：只写事件、id 与量纲，绝不写消息正文（§19.1）。
   * 整段 try 住：store 万一同步抛（绑定半残）也只 warn，不许把业务路径带垮。
   */
  #logGateway(level: LogLevel, message: string): void {
    try {
      this.#logSink()({ level, scope: 'gateway', message, createdAt: new Date().toISOString() });
    } catch (error) {
      console.warn('[log] 写日志失败：' + describeError(error));
    }
  }

  #deps(): GatewayDeps {
    return { token: this.#token(), random: Math.random, now: () => Date.now() };
  }

  /** 取名解析器带内存缓存，必须跨消息复用，所以挂在实例上懒创建 */
  #nameResolver(): NameResolver {
    if (this.#names === null) this.#names = createNameResolver({ botToken: this.#token() });
    return this.#names;
  }

  #token(): string {
    const token = this.#host.botToken;
    return typeof token === 'string' ? token.trim() : '';
  }

  /** 数据库加解密用的密钥：Node 宿主的启动参数里可缺（缺了只等于「不能存 Key、不能回帖」） */
  #secret(): string {
    const secret = this.#host.keyEncryptionSecret;
    return typeof secret === 'string' ? secret.trim() : '';
  }

  #tokenConfigured(): boolean {
    return this.#token() !== '';
  }

  // -------------------------------------------------------------- 动作执行

  async #apply(reduction: GatewayReduction): Promise<void> {
    const wasConnected = this.#data.connected;
    this.#data = reduction.state;
    await this.#persist();
    // READY / RESUMED 把 connected 抬起来的那一刻就是「就绪」，每次连上只记一条
    if (!wasConnected && this.#data.connected) this.#logGateway('info', 'Gateway 连接就绪');
    for (const action of reduction.actions) {
      await this.#execute(action);
    }
  }

  async #execute(action: GatewayAction): Promise<void> {
    if (action.type === 'send') {
      this.#send(action.payload);
      return;
    }
    if (action.type === 'closeSocket') {
      this.#closeSocket(action.reason);
      return;
    }
    if (action.type === 'dispatch') {
      this.#dispatch(action.name, action.data);
      return;
    }
    if (action.type === 'scheduleAlarm') {
      // 停机后任何一拍都不许再续命：Node 宿主的 stop() 承诺「之后不再出现新定时器」
      if (this.#stopped) return;
      const delayMs = Number.isFinite(action.delayMs) && action.delayMs > 0 ? Math.round(action.delayMs) : HANDSHAKE_WATCHDOG_MS;
      await this.#host.storage.setAlarm(Date.now() + delayMs);
      return;
    }
    if (action.level === 'error') {
      console.error(action.message);
      return;
    }
    console.log(action.message);
  }

  #send(payload: string): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      console.error('[gateway] 连接未就绪，丢弃上行载荷');
      return;
    }
    try {
      socket.send(payload);
    } catch (error) {
      console.error('[gateway] 上行失败：' + describeError(error));
    }
  }

  #closeSocket(reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null) return;
    try {
      socket.close(1000, reason);
    } catch (error) {
      console.error('[gateway] 关闭连接失败：' + describeError(error));
    }
  }

  #snapshot(): Record<string, unknown> {
    const socket = this.#socket;
    return {
      connected: this.#data.connected,
      socketState:
        socket === null
          ? 'none'
          : socket.readyState === WebSocket.OPEN
            ? 'open'
            : socket.readyState === WebSocket.CONNECTING
              ? 'connecting'
              : 'closed',
      sessionId: this.#data.sessionId,
      hasResumeUrl: this.#data.resumeUrl !== null,
      seq: this.#data.seq,
      heartbeatIntervalMs: this.#data.heartbeatIntervalMs,
      awaitingAck: this.#data.awaitingAck,
      reconnectAttempt: this.#data.reconnectAttempt,
      botUserId: this.#data.botUserId,
      intentsDowngraded: this.#data.intentsDowngraded,
      sessionIntents: this.#data.sessionIntents,
      resumable: resumable(this.#data),
      tokenConfigured: this.#tokenConfigured(),
    };
  }

  /** 事件可能同时到达（message / close / alarm），统一串成一条链跑，避免交错改状态 */
  #serialize(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * 建一个引擎：同一份状态机，两个宿主各注入自己的 storage / waitUntil / 凭证。
 * 返出去的对象只有 fetch 与 alarm 两个方法（契约面），内部状态全部关在核心实例里。
 */
export function createGatewayEngine(host: GatewayHost): GatewayEngine {
  const core = new GatewayEngineCore(host);
  return {
    fetch: (request: Request): Promise<Response> => core.fetch(request),
    alarm: (): Promise<void> => core.alarm(),
  };
}
