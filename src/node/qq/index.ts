/**
 * QQ 机器人网关（Node 侧）：换 token → 读网关地址 → WebSocket 长连接 → 群/单聊消息 → ChatService → 回文本。
 *
 * 三条边界：
 *  - 记忆不在这里落地：TurnContext.memoryKey 指向会话目录给的 canonical key，这里只做搬运；
 *  - 提示词不在这里解析：会话选了命名预设就整份塞进 promptOverride，没选就走 core 的那三层；
 *  - 一个回合只在最后回一条文本（QQ 没有编辑消息，也没有流式），1800 字 / 最多 5 片。
 *
 * 与 src/node/gateway.ts 同一口径：不 import node: 模块（Node 22 自带 WebSocket / fetch），
 * socket 与 fetch 都能注入，单测因此不需要网络、不需要真凭证。
 */
import type { ChatService } from '../../core/chat/service';
import { replySuffix } from '../../core/chat/react';
import type { ConversationDirectory, ConversationStore, QQPresetStore, QqQuoteIndex } from '../../core/ports';
import type {
  ChatMessage,
  ConversationRecord,
  LogEntry,
  LogLevel,
  PromptConfig,
  ReplyRef,
  TurnContext,
  TurnResult,
} from '../../core/types';
import {
  QQ_API_BASE,
  QQ_C2C_EVENT,
  QQ_C2C_NAME,
  QQ_GROUP_EVENT,
  QQ_GROUP_NAME,
  QQ_INTENTS,
  QQ_TOKEN_URL,
  buildQqReplyBody,
  parseQqEvent,
  parseQqFrame,
  qqLinkDisplayName,
  qqReplyPath,
  readNumberField,
  readStringField,
  splitQqReply,
  type QqIncomingMessage,
} from './protocol';

/** QQ 机器人在提示词里的自称；与 Discord 侧的 BOT_NAME 是两回事 */
export const QQ_BOT_NAME = '小神鲸';
/** QQ 群会话的合成 guild id：路由/提示词查不到这两行，自然会落回 global */
export const QQ_GROUP_GUILD_ID = 'qq:group';
/** QQ 单聊会话的合成 guild id */
export const QQ_C2C_GUILD_ID = 'qq:c2c';
// 名字常量住在 protocol.ts（解析层要用它拼 displayName），这里转出去，index 仍是唯一入口
export { QQ_C2C_NAME, QQ_GROUP_NAME };
/** 回合失败时的安全文案：不含内部错误、请求细节或任何凭证 */
export const QQ_FAILURE_TEXT = '抱歉，我这边暂时出了点问题，请稍后再试。';
/** 生图结果在 QQ 侧只回一句说明：媒体上传不在这一版的范围内 */
export const QQ_IMAGE_NOTE = '（图片已生成，但 QQ 渠道暂时只回文字，图先不发了）';
/** 音频结果同理：QQ 这一版没有媒体上传，至少让用户知道歌/音效已经生成 */
export const QQ_AUDIO_NOTE = '（音频已生成，但 QQ 渠道暂时只回文字，音频先不发了）';

/** 提前 300 秒换 token：到点前就续上，别让一片回复里夹着一次 401 */
const TOKEN_REFRESH_MARGIN_SECONDS = 300;
/** 重连退避：1s 起、每次翻倍、封顶 60s */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
/** stop() 等 socket close 的上限：真关不掉也不能把停机流程挂住 */
const STOP_CLOSE_TIMEOUT_MS = 1000;
/** event id 去重的窗口：QQ 断线重连会重投，500 条足够覆盖一次抖动 */
const SEEN_EVENT_LIMIT = 500;
/** 日志里的错误文本上限：正文、口令、密钥、完整 Key 一律不入日志 */
const LOG_ERROR_MAX_CHARS = 200;
/** 引用索引只留 7 天：QQ 的历史消息本来也没有 msg_idx，过期后无法再还原 */
const QUOTE_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 索引里只存正文摘要，原文仍以 messages 为准 */
const QUOTE_CONTENT_MAX_CHARS = 200;
/** 索引里写回「本条 + 本条引用了谁」；事件里的引用链也按同一个箭头格式摊开 */
const QUOTE_CHAIN_MARK = '\n↳ 回复：';

/** 当前事件给的正文 + 更深一层的引用正文，重复片段不重复贴 */
function withQuoteChain(text: string, chain: readonly string[]): string {
  let out = text.trim();
  for (const part of chain) {
    const value = part.trim();
    if (value === '' || out.includes(value)) continue;
    out = out === '' ? value : out + QUOTE_CHAIN_MARK + value;
  }
  return out;
}

/** 事件与索引都可能有正文：一方是另一方前缀时取更长的，冲突时信当前事件 */
function richerQuoteText(eventText: string, storedText: string): string {
  const event = eventText.trim();
  const stored = storedText.trim();
  if (event === '') return stored;
  if (stored === '') return event;
  if (event.startsWith(stored)) return event;
  if (stored.startsWith(event)) return stored;
  return event;
}

/**
 * 一条连接所需的最小能力面。刻意不用 EventTarget：原生 WebSocket 与测试假件都只要五个方法，
 * 也就不用把 MessageEvent / CloseEvent 的类型差异带进来。
 */
export interface QqSocket {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (message: string) => void): void;
}

export type QqSocketFactory = (url: string) => QqSocket;

export interface QqGatewayOptions {
  appId: string;
  appSecret: string;
  directory: ConversationDirectory;
  /** 只记历史：未 @ 的全量群消息落到 canonical key，不调模型 */
  conversations: ConversationStore;
  presets: QQPresetStore;
  /** msg_idx → 发送者/摘要；引用消息到达时用它还原被引用的人 */
  quoteIndex: QqQuoteIndex;
  chat: ChatService;
  /** 运行日志钩子；缺省直接打 console（级别同名）。绝不在日志里放 token 或正文 */
  log?: (entry: LogEntry) => void;
  now?: () => Date;
  fetch?: typeof fetch;
  /** 建 socket 的口子；缺省用 Node 22 的全局 WebSocket */
  WebSocket?: QqSocketFactory;
}

export interface QqGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** 服务端错误正文只留一行前 120 字：够排障，不够塞进一整段正文 */
async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim();
    return 'detail=' + truncate(text, 120);
  } catch {
    return 'detail=';
  }
}

/** QQ 正文不接受思考块：成对块整段删掉，没闭合就从标签切到结尾 */
function stripThinking(text: string): string {
  return text.replace(/<\s*think_nya\s*>[\s\S]*?<\s*\/\s*think_nya\s*>/gi, '').replace(/<\s*think_nya\s*>[\s\S]*$/i, '').trim();
}

/** 回合正文：先剥掉模型思考块再 trim；图片/音频结果只补一句说明，不做媒体上传 */
function replyText(result: TurnResult): string {
  const text = stripThinking(result.text);
  const notes: string[] = [];
  if (result.image !== undefined) notes.push(QQ_IMAGE_NOTE);
  if (result.audio !== undefined) notes.push(QQ_AUDIO_NOTE);
  if (notes.length === 0) return text;
  return text === '' ? notes.join('\n') : text + '\n' + notes.join('\n');
}

/**
 * 组装 TurnContext：平台维度用合成键（qq:group / qq:c2c + openid），记忆维度用会话目录给的
 * canonical key。Discord 那边永远不传 memoryKey，所以两边的记忆互不串门。
 */
function buildTurnContext(
  message: QqIncomingMessage,
  record: ConversationRecord,
  preset: PromptConfig | undefined,
  replyTo: ReplyRef | undefined,
): TurnContext {
  const group = message.kind === 'qq_group';
  const name = group ? QQ_GROUP_NAME : QQ_C2C_NAME;
  const ctx: TurnContext = {
    guildId: group ? QQ_GROUP_GUILD_ID : QQ_C2C_GUILD_ID,
    channelId: message.externalId,
    userId: message.userId,
    userName: message.userName,
    guildName: name,
    channelName: name,
    botName: QQ_BOT_NAME,
    userText: message.text,
    storedUserText: message.text,
    // QQ 没有可贴表情的触发消息：这一轮不必多花一次表情模型调用
    wantReactions: false,
    platform: 'qq',
    platformKind: message.kind,
    memoryKey: { guildId: record.memoryGuildId, channelId: record.memoryChannelId },
  };
  // 选了命名预设就整份覆盖；没选（null）不设这个键，走 core 的 channel > guild > global
  if (preset !== undefined) ctx.promptOverride = preset;
  // ChatService 原样复制 ctx.replyTo：这里填上，提示词与落库历史都会带引用块
  if (replyTo !== undefined) ctx.replyTo = replyTo;
  return ctx;
}

interface SocketRecord {
  socket: QqSocket;
  /** true = 这条连接已经作废（主动关或对端关）：之后它的事件一律忽略，也不再重连 */
  closed: boolean;
  /** stop() 等「连接真的关了」的挂点：close 事件或 1s 兜底都会叫醒 */
  waiters: Set<() => void>;
}

class QqGatewayHost implements QqGateway {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #directory: ConversationDirectory;
  readonly #conversations: ConversationStore;
  readonly #presets: QQPresetStore;
  readonly #quoteIndex: QqQuoteIndex;
  readonly #chat: ChatService;
  readonly #socketFactory: QqSocketFactory;
  readonly #fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly #clock: () => Date;
  readonly #logHook: ((entry: LogEntry) => void) | undefined;

  #token: { value: string; expiresAt: number } | null = null;
  #record: SocketRecord | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #reconnect: ReturnType<typeof setTimeout> | null = null;
  /** 最后一次收到的序列号：心跳 op=1 的 d 就是它 */
  #lastSeq: number | null = null;
  /** 重连退避的指数（1s → 2s → 4s …）；READY 之后清零 */
  #attempt = 0;
  #connecting = false;
  #started = false;
  #stopping = false;
  #stopPromise: Promise<void> | null = null;
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];

  constructor(options: QqGatewayOptions) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#directory = options.directory;
    this.#conversations = options.conversations;
    this.#presets = options.presets;
    this.#quoteIndex = options.quoteIndex;
    this.#chat = options.chat;
    this.#logHook = options.log;
    this.#clock = options.now ?? ((): Date => new Date());
    this.#socketFactory = options.WebSocket ?? ((url: string): QqSocket => createWebSocket(url));
    // 一律用裸引用调用 fetch：workerd 对 fetch 做 this 品牌校验，把宿主对象当 this 会抛 Illegal invocation
    const injected = options.fetch;
    this.#fetch =
      injected === undefined
        ? (input: string, init: RequestInit): Promise<Response> => globalThis.fetch(input, init)
        : (input: string, init: RequestInit): Promise<Response> => injected(input, init);
  }

  async start(): Promise<void> {
    // 停机之后 start 也不许复活：否则「stop 之后再无新定时器」这条承诺就守不住
    if (this.#started || this.#stopping) return;
    this.#started = true;
    this.#log('info', 'start');
    await this.#connect();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#doStop();
    return this.#stopPromise;
  }

  async #doStop(): Promise<void> {
    this.#stopping = true;
    this.#clearReconnect();
    this.#stopHeartbeat();

    const record = this.#record;
    this.#record = null;
    if (record !== null) {
      // 先挂等待再 close：假 socket 可能同步回调 close 事件
      const closed = this.#waitForClose(record);
      record.closed = true;
      try {
        record.socket.close(1000, 'stop');
      } catch {
        // 已经关掉的 socket 会抛：这一步只是尽力而为
      }
      await closed;
    }
    this.#log('info', 'stopped');
  }

  // ---- 连接与鉴权 -------------------------------------------------------

  async #connect(): Promise<void> {
    if (this.#stopping || this.#connecting) return;
    this.#connecting = true;
    try {
      const token = await this.#accessToken();
      const url = await this.#gatewayUrl(token);
      // 换 token / 取地址都可能在停机之后才回来：这一步之后什么都不许再开
      if (this.#stopping) return;
      if (this.#record !== null && !this.#record.closed) return;
      this.#openSocket(url);
    } catch (error) {
      if (this.#stopping) return;
      this.#log('error', 'connect failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
      this.#scheduleReconnect();
    } finally {
      this.#connecting = false;
    }
  }

  async #accessToken(): Promise<string> {
    const cached = this.#token;
    if (cached !== null && this.#clock().getTime() < cached.expiresAt) return cached.value;

    const response = await this.#fetch(QQ_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.#appId, clientSecret: this.#appSecret }),
    });
    if (!response.ok) throw new Error('QQ_TOKEN_HTTP_' + String(response.status));

    const payload = (await response.json()) as unknown;
    const token = readStringField(payload, 'access_token');
    const expiresIn = readNumberField(payload, 'expires_in');
    if (token === '') throw new Error('QQ_TOKEN_MISSING');
    if (expiresIn === null || expiresIn <= 0) throw new Error('QQ_TOKEN_EXPIRES_INVALID');

    // 正常是 7200s，提前 300s 换；服务端给的有效期本身不足 300s 时按真实有效期缓存，
    // 否则每发一片回复都要重新换一次 token
    const cacheSeconds =
      expiresIn > TOKEN_REFRESH_MARGIN_SECONDS ? expiresIn - TOKEN_REFRESH_MARGIN_SECONDS : expiresIn;
    this.#token = { value: token, expiresAt: this.#clock().getTime() + cacheSeconds * 1000 };
    this.#log('info', 'token refreshed ttl=' + String(cacheSeconds) + 's');
    return token;
  }

  async #gatewayUrl(token: string): Promise<string> {
    const response = await this.#fetch(QQ_API_BASE + '/gateway', {
      headers: { authorization: 'QQBot ' + token },
    });
    if (!response.ok) throw new Error('QQ_GATEWAY_HTTP_' + String(response.status));
    const payload = (await response.json()) as unknown;
    const url = readStringField(payload, 'url');
    if (url === '') throw new Error('QQ_GATEWAY_URL_MISSING');
    return url;
  }

  // ---- socket 生命周期 ---------------------------------------------------

  #openSocket(url: string): void {
    if (this.#stopping) return;
    const previous = this.#record;
    if (previous !== null) {
      previous.closed = true;
      this.#stopHeartbeat();
      try {
        previous.socket.close(1000, 'reconnect');
      } catch {
        // 同上：旧连接关不掉也不影响新连接
      }
    }

    const socket = this.#socketFactory(url);
    const record: SocketRecord = { socket, closed: false, waiters: new Set() };
    this.#record = record;
    // 新连接一律从「没有序列号」开始：心跳里绝不能带上一代的 s
    this.#lastSeq = null;

    socket.onOpen(() => {
      if (record.closed) return;
      this.#log('info', 'socket open');
    });

    socket.onMessage((data) => {
      if (record.closed) return;
      this.#onFrame(data);
    });

    socket.onClose((code, reason) => {
      const waiters = [...record.waiters];
      record.waiters.clear();
      for (const waiter of waiters) waiter();
      if (record.closed) return;
      record.closed = true;
      if (this.#record === record) this.#record = null;
      this.#stopHeartbeat();
      if (this.#stopping) return;
      this.#log('warn', 'socket closed code=' + String(code) + (reason === '' ? '' : ' reason=' + truncate(reason, 80)));
      this.#scheduleReconnect();
    });

    socket.onError((message) => {
      if (record.closed) return;
      // 错误对象里可能带请求上下文：只留一句短文本
      this.#log('warn', 'socket error: ' + truncate(message, LOG_ERROR_MAX_CHARS));
    });
  }

  #onFrame(raw: string): void {
    const frame = parseQqFrame(raw);
    if (frame === null) {
      this.#log('warn', 'bad frame ignored');
      return;
    }
    if (frame.s !== null) this.#lastSeq = frame.s;

    switch (frame.op) {
      case 10:
        this.#onHello(frame.d);
        break;
      case 0:
        this.#onDispatch(frame.t, frame.d);
        break;
      case 7:
        this.#log('warn', 'reconnect requested by server');
        this.#reconnectNow();
        break;
      case 9:
        this.#log('warn', 'invalid session, token dropped');
        this.#token = null;
        this.#reconnectNow();
        break;
      default:
        // 11 = 心跳 ACK，1 = 心跳回显：都不需要处理
        break;
    }
  }

  #onHello(data: unknown): void {
    const interval = readNumberField(data, 'heartbeat_interval');
    // QQ 实际给 41250 左右；异常值退回 30s，绝不因为一个字段把连接判死
    this.#startHeartbeat(interval !== null && interval >= 1000 ? interval : 30_000);
    void this.#identify();
  }

  async #identify(): Promise<void> {
    try {
      const token = await this.#accessToken();
      if (this.#stopping) return;
      this.#send({ op: 2, d: { token: 'QQBot ' + token, intents: QQ_INTENTS, shard: [0, 1] } });
      // 只记「发了 Identify」：token 一个字都不进日志
      this.#log('info', 'identify sent');
    } catch (error) {
      if (this.#stopping) return;
      this.#log('error', 'identify failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
      this.#reconnectNow();
    }
  }

  #startHeartbeat(intervalMs: number): void {
    this.#stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      this.#send({ op: 1, d: this.#lastSeq });
    }, intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat === null) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #send(payload: unknown): void {
    const record = this.#record;
    if (record === null || record.closed) return;
    try {
      record.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.#log('warn', 'send failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
    }
  }

  #onDispatch(type: string, data: unknown): void {
    if (type === 'READY') {
      this.#attempt = 0;
      this.#log('info', 'ready');
      return;
    }
    const message = parseQqEvent(type, data);
    if (message === null) return;
    // 日志只到「事件名 + 正文长度 + 是否 @」：正文本身绝不进日志
    const mention = message.kind === 'qq_group' ? ' mention=' + (message.mentioned ? '1' : '0') : '';
    this.#log('info', 'event ' + type + ' textLen=' + String(message.text.length) + mention);
    void this.#handle(message);
  }

  // ---- 一条消息 ---------------------------------------------------------

  async #handle(message: QqIncomingMessage): Promise<void> {
    if (!this.#remember(message.eventId)) {
      this.#log('info', 'duplicate event skipped');
      return;
    }
    const replyTo = await this.#resolveReply(message);
    await this.#rememberQuote(message, replyTo);
    // 未 @ 的群消息只进记忆，不调用模型，也不回话
    if (!message.mentioned) {
      await this.#recordHistory(message, replyTo);
      return;
    }
    try {
      const text = await this.#runTurn(message, replyTo);
      await this.#deliver(message, text);
    } catch (error) {
      this.#log('error', 'turn failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
      // 失败只回一句安全文案：内部错误、请求细节与凭证都不进聊天
      await this.#deliver(message, QQ_FAILURE_TEXT);
    }
  }

  /**
   * 只做记忆落库：不调模型、不回话。
   * 与 Discord 的 #recordMessage 同口径，让连续群聊也能进上下文。
   */
  async #recordHistory(message: QqIncomingMessage, replyTo: ReplyRef | undefined): Promise<void> {
    try {
      const record = await this.#directory.ensureLink({
        platform: 'qq',
        kind: message.kind,
        externalId: message.externalId,
        displayName: qqLinkDisplayName(message),
      });
      const row: ChatMessage = {
        role: 'user',
        content: message.text,
        author: message.userName,
        authorId: message.userId,
        createdAt: this.#clock().toISOString(),
        platform: 'qq',
        platformKind: message.kind,
      };
      if (replyTo !== undefined) row.replyTo = replyTo;
      await this.#conversations.append(
        { guildId: record.memoryGuildId, channelId: record.memoryChannelId },
        [row],
      );
      this.#log('info', 'history recorded kind=' + message.kind);
    } catch (error) {
      // 记忆写失败不影响后续消息与回复路径
      this.#log('warn', 'history record failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
    }
  }

  async #runTurn(message: QqIncomingMessage, replyTo: ReplyRef | undefined): Promise<string> {
    // 首条消息自动登记链接：QQ 侧不需要任何预先配置
    const record = await this.#directory.ensureLink({
      platform: 'qq',
      kind: message.kind,
      externalId: message.externalId,
      displayName: qqLinkDisplayName(message),
    });
    const preset = record.presetId === null ? null : await this.#presets.get(record.presetId);
    if (record.presetId !== null && preset === null) {
      // 预设 id 不是秘密（预设正文才是），这里点名是哪个 id 方便后台排查
      this.#log('warn', 'preset missing id=' + record.presetId);
    }
    const result = await this.#chat.run(buildTurnContext(message, record, preset?.config, replyTo));
    return replyText(result);
  }

  /**
   * 引用消息才需要查索引：ref_msg_idx 是硬线索，quoteText 是 QQ 已经给出的补充。
   * ref 对不上时按正文前缀兜底；同文多条由仓储返回 null，宁可没有作者也不认错人。
   * 查不到也返回一个只有 id/正文的 ReplyRef，replySuffix 会落成「一条更早的消息」。
   */
  async #resolveReply(message: QqIncomingMessage): Promise<ReplyRef | undefined> {
    const refMsgIdx = message.refMsgIdx ?? '';
    const quoteText = message.quoteText ?? '';
    const chain = message.quoteChain ?? [];
    if (refMsgIdx === '' && quoteText === '' && chain.length === 0) return undefined;

    const nowIso = this.#clock().toISOString();
    let hit: Awaited<ReturnType<QqQuoteIndex['find']>> = null;
    if (refMsgIdx !== '') {
      try {
        hit = await this.#quoteIndex.find(
          {
            accountId: this.#appId,
            kind: message.kind,
            chatId: message.externalId,
            msgIdx: refMsgIdx,
          },
          nowIso,
        );
      } catch (error) {
        // 索引坏掉不能挡住回复：退化成「只显示正文/一条更早的消息」
        this.#log('warn', 'quote lookup failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
      }
    }
    if (hit === null && quoteText !== '') {
      try {
        hit = await this.#quoteIndex.findByText(
          {
            accountId: this.#appId,
            kind: message.kind,
            chatId: message.externalId,
          },
          quoteText,
          nowIso,
        );
      } catch (error) {
        this.#log('warn', 'quote text lookup failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
      }
    }
    return {
      messageId: hit?.msgIdx ?? refMsgIdx,
      author: hit?.userName ?? '',
      authorId: hit?.userId ?? '',
      content: richerQuoteText(withQuoteChain(quoteText, chain), hit?.content ?? ''),
    };
  }

  /** 每条入站消息都记一份；正文里带上它自己引用了谁，失败只 warn，不影响本轮回复 */
  async #rememberQuote(message: QqIncomingMessage, replyTo: ReplyRef | undefined): Promise<void> {
    const msgIdx = message.msgIdx ?? '';
    if (msgIdx === '') return;
    const now = this.#clock();
    try {
      await this.#quoteIndex.record({
        accountId: this.#appId,
        kind: message.kind,
        chatId: message.externalId,
        msgIdx,
        platformMessageId: message.eventId,
        userId: message.userId,
        userName: message.userName,
        content: truncate(message.text + replySuffix(replyTo), QUOTE_CONTENT_MAX_CHARS),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + QUOTE_INDEX_TTL_MS).toISOString(),
      });
    } catch (error) {
      this.#log('warn', 'quote index write failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
    }
  }

  async #deliver(message: QqIncomingMessage, text: string): Promise<void> {
    const chunks = splitQqReply(text);
    if (chunks.length === 0) {
      this.#log('warn', 'empty reply skipped kind=' + message.kind);
      return;
    }
    for (let position = 0; position < chunks.length; position += 1) {
      const sent = await this.#sendChunk(message, chunks[position] ?? '', position + 1);
      // 前一片没发出去就停手：只补后面几片，用户看到的是半截话
      if (!sent) return;
    }
    this.#log('info', 'reply sent chunks=' + String(chunks.length) + ' kind=' + message.kind);
  }

  async #sendChunk(message: QqIncomingMessage, content: string, seq: number): Promise<boolean> {
    const body = JSON.stringify(buildQqReplyBody(content, message.eventId, seq));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const token = await this.#accessToken();
        const response = await this.#fetch(QQ_API_BASE + qqReplyPath(message.kind, message.externalId), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'QQBot ' + token },
          body,
        });
        if (response.ok) return true;
        // token 被服务端提前作废时，清缓存后用同一片重试一次；不重试整回合，避免重复发前面几片
        if (response.status === 401 && attempt === 0) {
          this.#token = null;
          this.#log('warn', 'reply unauthorized, refreshing token');
          continue;
        }
        this.#log('warn', 'reply failed status=' + String(response.status) + ' ' + (await errorDetail(response)));
        return false;
      } catch (error) {
        this.#log('warn', 'reply failed: ' + truncate(describeError(error), LOG_ERROR_MAX_CHARS));
        return false;
      }
    }
    return false;
  }

  /** 去重窗口：Set 查重、数组保序，超过上限就按最老的淘汰 */
  #remember(eventId: string): boolean {
    if (this.#seen.has(eventId)) return false;
    this.#seen.add(eventId);
    this.#seenOrder.push(eventId);
    while (this.#seenOrder.length > SEEN_EVENT_LIMIT) {
      const dropped = this.#seenOrder.shift();
      if (dropped !== undefined) this.#seen.delete(dropped);
    }
    return true;
  }

  // ---- 重连与停机 -------------------------------------------------------

  #scheduleReconnect(): void {
    if (this.#stopping) return;
    this.#clearReconnect();
    const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#log('warn', 'reconnect in ' + String(delayMs) + 'ms');
    this.#reconnect = setTimeout(() => {
      this.#reconnect = null;
      void this.#connect();
    }, delayMs);
  }

  #clearReconnect(): void {
    if (this.#reconnect === null) return;
    clearTimeout(this.#reconnect);
    this.#reconnect = null;
  }

  /** 服务端点名重连（op 7/9）：立刻重来一轮，不走退避——退避留给真正的连接失败 */
  #reconnectNow(): void {
    if (this.#stopping) return;
    this.#attempt = 0;
    this.#clearReconnect();
    this.#stopHeartbeat();
    const record = this.#record;
    this.#record = null;
    if (record !== null) {
      record.closed = true;
      try {
        record.socket.close(1000, 'reconnect');
      } catch {
        // 已经关掉：忽略
      }
    }
    void this.#connect();
  }

  /** 等 close 事件；1s 兜底兜住「对端不给 close 帧」的情况，两条路都会清掉那个 timer */
  #waitForClose(record: SocketRecord): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        record.waiters.delete(done);
        resolve();
      };
      record.waiters.add(done);
      timer = setTimeout(done, STOP_CLOSE_TIMEOUT_MS);
    });
  }

  // ---- 日志 -------------------------------------------------------------

  #log(level: LogLevel, message: string): void {
    const line = '[qq] ' + message;
    const hook = this.#logHook;
    if (hook === undefined) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
      return;
    }
    try {
      hook({ level, scope: 'gateway', message: line, createdAt: this.#clock().toISOString() });
    } catch {
      // 写日志失败绝不能影响连接：与 core 的 emit 同口径
    }
  }
}

/**
 * 原生 WebSocket → QqSocket。Node 22 自带 WebSocket，worker/workerd 也有：
 * 这里不 import node: 模块，所以 tsconfig 只挂 workers 类型也能编。
 */
function createWebSocket(url: string): QqSocket {
  const socket = new WebSocket(url);
  return {
    send: (payload: string): void => socket.send(payload),
    close: (code?: number, reason?: string): void => socket.close(code, reason),
    onOpen: (handler: () => void): void => {
      socket.addEventListener('open', () => handler());
    },
    onMessage: (handler: (data: string) => void): void => {
      socket.addEventListener('message', (event) => {
        // QQ 只发文本帧；二进制帧当没收到（不猜编码）
        const data = (event as MessageEvent).data;
        if (typeof data === 'string') handler(data);
      });
    },
    onClose: (handler: (code: number, reason: string) => void): void => {
      socket.addEventListener('close', (event) => {
        const detail = event as CloseEvent;
        handler(detail.code, detail.reason ?? '');
      });
    },
    onError: (handler: (message: string) => void): void => {
      socket.addEventListener('error', () => handler('socket error'));
    },
  };
}

export function createQqGateway(options: QqGatewayOptions): QqGateway {
  const host = new QqGatewayHost(options);
  return {
    start: (): Promise<void> => host.start(),
    stop: (): Promise<void> => host.stop(),
  };
}
