/**
 * Discord Gateway v10 纯协议层。
 *
 * 这一层只做四件事，全部是纯函数：构造上行载荷（IDENTIFY / RESUME / HEARTBEAT）、
 * 解析下行帧、算延迟（心跳间隔 / 指数退避 / INVALID_SESSION 抖动）、按 opcode 分发。
 * WebSocket 与 storage 都在 gateway/durable-object.ts 里，所以这里的心跳与重连时序
 * 可以在测试里完整复现，且不需要任何出网。
 *
 * 与 Discord 的约定（Gateway v10）：
 *   op10 HELLO          → 取 heartbeat_interval，随后按 session 有无发 IDENTIFY(op2) 或 RESUME(op6)
 *   op1  HEARTBEAT      → d = 最近一次收到的 s（没有则 null）
 *   op11 HEARTBEAT_ACK  → 上一拍心跳已被确认
 *   op0  DISPATCH       → t=READY 存 session_id / resume_gateway_url；t=RESUMED 表示恢复成功
 *   op7  RECONNECT      → 主动关闭 → 按退避重连
 *   op9  INVALID_SESSION→ 清 session 状态 → 1~5s 随机延迟后重新 IDENTIFY
 */

/** 首次连接（没有可恢复的 session 时）用的地址 */
export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

export const GATEWAY_API_VERSION = '10';
export const GATEWAY_ENCODING = 'json';

/** presence 里的活动文案；测试直接断言这个常量 */
export const PRESENCE_ACTIVITY_NAME = '/chat 或 @我 聊天';

export interface GatewayActivity {
  name: string;
  type: number;
}

export interface GatewayPresence {
  status: 'online';
  since: null;
  activities: GatewayActivity[];
  afk: boolean;
}

/** IDENTIFY 的 presence：只为了让 bot 在成员列表里显示在线，不订阅任何事件 */
export const PRESENCE: GatewayPresence = {
  status: 'online',
  since: null,
  activities: [{ name: PRESENCE_ACTIVITY_NAME, type: 0 }],
  afk: false,
};

export interface GatewayIdentifyProperties {
  os: string;
  browser: string;
  device: string;
}

export const IDENTIFY_PROPERTIES: GatewayIdentifyProperties = {
  os: 'linux',
  browser: 'dc-ai-bot',
  device: 'dc-ai-bot',
};

/** Gateway opcode（只列本 DO 用得到的） */
export const GatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export type GatewayOpcodeValue = (typeof GatewayOpcode)[keyof typeof GatewayOpcode];

/**
 * 降级档 = GUILD_MESSAGES(1<<9=512) | DIRECT_MESSAGES(1<<12=4096) = 4608。
 * 不含 MESSAGE_CONTENT(1<<15=32768)，所以 guild 频道里的 message.content 会被抹成空串
 * （线上实测：dispatch MESSAGE_CREATE 紧接 跳过消息（empty））。
 * 保留它只用于「宁可不收正文也要先连上」的场合，不再是默认档。
 */
export const GATEWAY_INTENTS_MINIMAL = 4608;

/**
 * 默认档 = GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT(1<<15=32768) = 37376。
 * MESSAGE_CONTENT 是特权位：必须在开发者门户 Bot 页签开启 MESSAGE CONTENT INTENT，
 * 否则 IDENTIFY 会被 4014 拒绝；被拒后先降级到 0 只保在线，冷却到期自动回到这一档重试。
 */
export const GATEWAY_INTENTS_FULL = 37376;

/** 关闭码 4014：请求的 intents 未被允许（通常是门户里没开 MESSAGE CONTENT） */
export const CLOSE_CODE_DISALLOWED_INTENTS = 4014;

/**
 * 4014 后的冷却时间：到期再回到全量档重试，避免一次门户配置问题把连接永久按在沉默档上。
 * 用户在门户勾上 MESSAGE CONTENT 之后，冷却一到期就会自动重新握手，不需要重新部署。
 */
export const INTENTS_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * 本次握手该申请哪一档 intents。
 * 默认全量档（含 MESSAGE_CONTENT）；只有被 4014 拒绝后的冷却窗口内退到 0（放弃所有事件、只保留在线状态），
 * 冷却结束再回到全量档重试——宁可少收事件，也不让连接被同一个码反复掐断。
 */
export function intentsFor(state: GatewayState, nowMs: number = Date.now()): number {
  if (!state.intentsDowngraded) return GATEWAY_INTENTS_FULL;
  if (state.intentsRetryAtMs !== null && nowMs >= state.intentsRetryAtMs) return GATEWAY_INTENTS_FULL;
  return 0;
}

// ---------------------------------------------------------------- 上行载荷

export interface IdentifyPayload {
  op: typeof GatewayOpcode.IDENTIFY;
  d: {
    token: string;
    /** 见 GATEWAY_INTENTS_FULL（默认）/ GATEWAY_INTENTS_MINIMAL（降级档） */
    intents: number;
    properties: GatewayIdentifyProperties;
    presence: GatewayPresence;
  };
}

export function identifyPayload(token: string, intents: number = GATEWAY_INTENTS_FULL): IdentifyPayload {
  return {
    op: GatewayOpcode.IDENTIFY,
    d: {
      token,
      intents,
      properties: IDENTIFY_PROPERTIES,
      presence: PRESENCE,
    },
  };
}

export interface ResumePayload {
  op: typeof GatewayOpcode.RESUME;
  d: { token: string; session_id: string; seq: number | null };
}

export function resumePayload(token: string, sessionId: string, seq: number | null): ResumePayload {
  return { op: GatewayOpcode.RESUME, d: { token, session_id: sessionId, seq } };
}

export interface HeartbeatPayload {
  op: typeof GatewayOpcode.HEARTBEAT;
  d: number | null;
}

export function heartbeatPayload(seq: number | null): HeartbeatPayload {
  return { op: GatewayOpcode.HEARTBEAT, d: seq };
}

export function encodePayload(payload: IdentifyPayload | ResumePayload | HeartbeatPayload): string {
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------- 延迟计算

/**
 * 心跳取 heartbeat_interval 的 0.9 倍：留 10% 余量给网络抖动，
 * 避免卡在 interval 边界上被服务端判定为「未按时心跳」而断连。
 */
export const HEARTBEAT_INTERVAL_RATIO = 0.9;

/** HELLO 之前（或存储里没有 interval 时）的兜底心跳间隔，Discord 常见值 41250ms */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 41250;

export function heartbeatDelayMs(intervalMs: number): number {
  const safe = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_HEARTBEAT_INTERVAL_MS;
  return Math.max(1, Math.round(safe * HEARTBEAT_INTERVAL_RATIO));
}

/** 重连退避：1s 起步，每次翻倍，封顶 60s，再叠 ±25% 随机抖动 */
export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60000;
export const BACKOFF_JITTER_RATIO = 0.25;

/** attempt 从 0 开始（0 = 第一次失败后的等待） */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** safeAttempt, MAX_BACKOFF_MS);
  const span = base * BACKOFF_JITTER_RATIO;
  const jittered = base - span + random() * span * 2;
  return Math.min(MAX_BACKOFF_MS, Math.max(1, Math.round(jittered)));
}

export const INVALID_SESSION_MIN_DELAY_MS = 1000;
export const INVALID_SESSION_MAX_DELAY_MS = 5000;

/** op9 之后 Discord 要求等 1~5 秒再重新 IDENTIFY */
export function invalidSessionDelayMs(random: () => number): number {
  const span = INVALID_SESSION_MAX_DELAY_MS - INVALID_SESSION_MIN_DELAY_MS;
  return Math.round(INVALID_SESSION_MIN_DELAY_MS + random() * span);
}

/** READY 给的 resume_gateway_url 只有主机名，必须自己拼上 v/encoding 查询参数 */
export function resumeConnectUrl(resumeUrl: string): string {
  try {
    const url = new URL(resumeUrl);
    url.searchParams.set('v', GATEWAY_API_VERSION);
    url.searchParams.set('encoding', GATEWAY_ENCODING);
    return url.toString();
  } catch {
    return GATEWAY_URL;
  }
}

/**
 * 能不能用 RESUME 复用旧会话。
 * 光有 sessionId/resumeUrl 不够：RESUME 不重新协商 intents，必须确认这个会话当初谈的档位
 * 与当前档位**完全一致**，否则要重新 IDENTIFY 重新协商（历史上的 intents=0 会话就是这么坏的）。
 */
export function resumable(state: GatewayState, nowMs: number = Date.now()): boolean {
  if (state.sessionId === null || state.resumeUrl === null) return false;
  return state.sessionIntents === intentsFor(state, nowMs);
}

// ---------------------------------------------------------------- 下行帧

export interface GatewayFrame {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

/**
 * workerd 的 message 事件 data 是 string 或 ArrayBuffer（binaryType='arraybuffer'），
 * 两种都要能吃。这里把二进制统一解成文本；解不出来返回 null 由调用方当坏帧丢掉。
 */
export function decodeFrameText(raw: string | ArrayBuffer): string | null {
  if (typeof raw === 'string') return raw;
  try {
    return new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

/** 非 JSON / 非对象 / op 不是整数 → null（一律当坏帧，绝不抛错） */
export function parseFrame(raw: string | ArrayBuffer): GatewayFrame | null {
  const text = decodeFrameText(raw);
  if (text === null || text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const op = record['op'];
  if (typeof op !== 'number' || !Number.isInteger(op)) return null;
  const s = record['s'];
  const t = record['t'];
  return {
    op,
    d: record['d'],
    s: typeof s === 'number' ? s : null,
    t: typeof t === 'string' ? t : null,
  };
}

// ---------------------------------------------------------------- 窄类型读取

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (record === null) return null;
  return asRecord(record[key]);
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readPositiveNumber(record: Record<string, unknown> | null, key: string): number | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------- 状态与动作

export interface GatewayState {
  /** READY 里的 session_id，用于 RESUME */
  sessionId: string | null;
  /** READY 里的 resume_gateway_url（含主机名），用于 RESUME */
  resumeUrl: string | null;
  /**
   * 这个会话握手时实际用的 intents。RESUME **不会**重新协商 intents，
   * 所以只有它等于当前档位时才允许 RESUME，否则必须重新 IDENTIFY
   * （否则会静默沿用旧档，例如 intents=0 的旧会话永远收不到 MESSAGE_CREATE）。
   */
  sessionIntents: number | null;
  /** 最近一次 DISPATCH 的 s，心跳的 d 用它 */
  seq: number | null;
  /** HELLO 给的 heartbeat_interval（ms） */
  heartbeatIntervalMs: number | null;
  /** 心跳已发出、ACK 未到；下一拍 alarm 发现它还是 true 就判定连接已死 */
  awaitingAck: boolean;
  /** 已 READY / RESUMED */
  connected: boolean;
  /** 已经排了重连，后续 close 事件不必再排一次（避免退避次数被重复递增） */
  pendingReconnect: boolean;
  /** 连续失败次数，只影响退避档位 */
  reconnectAttempt: number;
  /** READY 里的 user.id：判断「这条消息是不是在 @我 / 回复我」要用 */
  botUserId: string | null;
  /** 已经因 4014 降到 intents=0；冷却到期后 reduceHello 会自动再试一次全量档 37376 */
  intentsDowngraded: boolean;
  /** 冷却到期时刻（epoch ms）：null 表示不打算再试全量 */
  intentsRetryAtMs: number | null;
}

export const EMPTY_GATEWAY_STATE: GatewayState = {
  sessionId: null,
  resumeUrl: null,
  sessionIntents: null,
  seq: null,
  heartbeatIntervalMs: null,
  awaitingAck: false,
  connected: false,
  pendingReconnect: false,
  reconnectAttempt: 0,
  botUserId: null,
  intentsDowngraded: false,
  intentsRetryAtMs: null,
};

/**
 * 只持久化「跨驱逐仍然有意义」的字段：连接是否活着、ACK 是否到齐这类
 * 属于单条 socket 的瞬时状态，DO 被驱逐后本来就该复位成默认值。
 */
export interface PersistedGatewayState {
  sessionId: string | null;
  resumeUrl: string | null;
  sessionIntents: number | null;
  seq: number | null;
  heartbeatIntervalMs: number | null;
  reconnectAttempt: number;
  botUserId: string | null;
  intentsDowngraded: boolean;
  intentsRetryAtMs: number | null;
}

export function serializeGatewayState(state: GatewayState): PersistedGatewayState {
  return {
    sessionId: state.sessionId,
    resumeUrl: state.resumeUrl,
    sessionIntents: state.sessionIntents,
    seq: state.seq,
    heartbeatIntervalMs: state.heartbeatIntervalMs,
    reconnectAttempt: state.reconnectAttempt,
    botUserId: state.botUserId,
    intentsDowngraded: state.intentsDowngraded,
    intentsRetryAtMs: state.intentsRetryAtMs,
  };
}

/** 存储里可能是空的/被写坏的：任何不合法的字段都退回默认值，绝不抛错 */
export function restoreGatewayState(stored: PersistedGatewayState | null | undefined): GatewayState {
  if (stored === null || stored === undefined || typeof stored !== 'object') {
    return { ...EMPTY_GATEWAY_STATE };
  }
  const attempt = stored.reconnectAttempt;
  return {
    sessionId: typeof stored.sessionId === 'string' && stored.sessionId !== '' ? stored.sessionId : null,
    resumeUrl: typeof stored.resumeUrl === 'string' && stored.resumeUrl !== '' ? stored.resumeUrl : null,
    sessionIntents:
      typeof stored.sessionIntents === 'number' && Number.isFinite(stored.sessionIntents) && stored.sessionIntents >= 0
        ? Math.floor(stored.sessionIntents)
        : null,
    seq: typeof stored.seq === 'number' && Number.isFinite(stored.seq) ? stored.seq : null,
    heartbeatIntervalMs:
      typeof stored.heartbeatIntervalMs === 'number' && Number.isFinite(stored.heartbeatIntervalMs) && stored.heartbeatIntervalMs > 0
        ? stored.heartbeatIntervalMs
        : null,
    awaitingAck: false,
    connected: false,
    pendingReconnect: false,
    reconnectAttempt: typeof attempt === 'number' && Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0,
    botUserId: typeof stored.botUserId === 'string' && stored.botUserId !== '' ? stored.botUserId : null,
    intentsDowngraded: stored.intentsDowngraded === true,
    intentsRetryAtMs:
      typeof stored.intentsRetryAtMs === 'number' && Number.isFinite(stored.intentsRetryAtMs)
        ? stored.intentsRetryAtMs
        : null,
  };
}

export type GatewayAction =
  /** 往上行 socket 写一帧（已经序列化好） */
  | { type: 'send'; payload: string }
  /** 关闭当前 socket（不排 alarm，由同一批动作里的 scheduleAlarm 负责） */
  | { type: 'closeSocket'; reason: string }
  /** 排下一次 state.storage.setAlarm —— DO 的全部调度都靠它 */
  | { type: 'scheduleAlarm'; delayMs: number }
  /** 把一条网关事件（目前只有 MESSAGE_CREATE）交给 DO 做业务处理 */
  | { type: 'dispatch'; name: string; data: unknown }
  | { type: 'log'; level: 'info' | 'error'; message: string };

export type GatewayEvent =
  /** 收到一帧（含 HELLO / READY / RECONNECT / INVALID_SESSION / ACK） */
  | { kind: 'frame'; frame: GatewayFrame }
  /** alarm 到点：发心跳，或在上一次心跳没 ACK 时判死重连 */
  | { kind: 'heartbeatTick' }
  /** socket 关闭（也可能是握手看门狗替我们关的）；code 是 Discord 的 close code */
  | { kind: 'socketClosed'; reason: string; code: number | null };

export interface GatewayDeps {
  /** DISCORD_BOT_TOKEN；IDENTIFY / RESUME 都要带 */
  token: string;
  /** 抖动源（生产是 Math.random，测试注入定值） */
  random: () => number;
  /** 时钟（epoch ms）；省略时退回 Date.now，测试可注入定值 */
  now?: () => number;
}

function depsNow(deps: GatewayDeps): number {
  return deps.now === undefined ? Date.now() : deps.now();
}

export interface GatewayReduction {
  state: GatewayState;
  actions: GatewayAction[];
}

export function reduceGatewayEvent(state: GatewayState, event: GatewayEvent, deps: GatewayDeps): GatewayReduction {
  if (event.kind === 'frame') return reduceFrame(state, event.frame, deps);
  if (event.kind === 'heartbeatTick') return reduceHeartbeatTick(state, deps);
  return reduceSocketClosed(state, event.reason, event.code, deps);
}

function reduceFrame(state: GatewayState, frame: GatewayFrame, deps: GatewayDeps): GatewayReduction {
  switch (frame.op) {
    case GatewayOpcode.HELLO:
      return reduceHello(state, frame, deps);
    case GatewayOpcode.DISPATCH:
      return reduceDispatch(state, frame);
    case GatewayOpcode.HEARTBEAT_ACK:
      return { state: { ...state, awaitingAck: false }, actions: [] };
    case GatewayOpcode.HEARTBEAT:
      // 服务端主动要一次心跳：立刻回，但 ACK 记账仍由周期 alarm 里那一拍负责，
      // 免得刚发完就被下一拍误判成「没 ACK」。
      return { state, actions: [{ type: 'send', payload: encodePayload(heartbeatPayload(state.seq)) }] };
    case GatewayOpcode.RECONNECT:
      return reduceReconnect(state, deps);
    case GatewayOpcode.INVALID_SESSION:
      return reduceInvalidSession(state, deps);
    default:
      return { state, actions: [{ type: 'log', level: 'error', message: 'gateway 未知 opcode ' + String(frame.op) }] };
  }
}

function reduceHello(state: GatewayState, frame: GatewayFrame, deps: GatewayDeps): GatewayReduction {
  const intervalMs = readPositiveNumber(asRecord(frame.d), 'heartbeat_interval');
  if (intervalMs === null) {
    return {
      state,
      actions: [
        { type: 'log', level: 'error', message: 'gateway HELLO 缺少可用的 heartbeat_interval' },
        { type: 'closeSocket', reason: 'HELLO_WITHOUT_INTERVAL' },
      ],
    };
  }

  const nowMs = depsNow(deps);
  // 冷却到期：清掉降级标记，这次握手回到全量档（再被 4014 拒绝会重新降级）
  const retryAfterCooldown = state.intentsDowngraded && intentsFor(state, nowMs) === GATEWAY_INTENTS_FULL;
  const base: GatewayState = retryAfterCooldown
    ? { ...state, intentsDowngraded: false, intentsRetryAtMs: null }
    : state;
  const intents = intentsFor(base, nowMs);
  const resuming = resumable(base, nowMs);
  const payload = resuming
    ? encodePayload(resumePayload(deps.token, base.sessionId ?? '', base.seq))
    : encodePayload(identifyPayload(deps.token, intents));

  return {
    // IDENTIFY 时就把这次协商的档位记进状态：READY 之后它就是可 RESUME 的凭据，
    // 以后任何 intents 变更都会让它对不上，从而自动重新握手而不是静默沿用旧档。
    state: {
      ...base,
      sessionIntents: resuming ? base.sessionIntents : intents,
      heartbeatIntervalMs: intervalMs,
      awaitingAck: false,
      pendingReconnect: false,
    },
    actions: [
      { type: 'send', payload },
      {
        type: 'log',
        level: 'info',
        message:
          'gateway HELLO heartbeat_interval=' +
          String(intervalMs) +
          'ms → ' +
          (resuming
            ? 'RESUME(op6)（沿用会话 intents=' + String(base.sessionIntents) + '，不重新协商）'
            : 'IDENTIFY(op2) intents=' + String(intents)),
      },
      { type: 'scheduleAlarm', delayMs: heartbeatDelayMs(intervalMs) },
    ],
  };
}

function reduceDispatch(state: GatewayState, frame: GatewayFrame): GatewayReduction {
  const sequenced: GatewayState = typeof frame.s === 'number' ? { ...state, seq: frame.s } : state;
  const d = asRecord(frame.d);

  if (frame.t === 'READY') {
    const sessionId = readString(d, 'session_id');
    const resumeUrl = readString(d, 'resume_gateway_url');
    const user = readRecord(d, 'user');
    const username = readString(user, 'username');
    const botUserId = readString(user, 'id');
    return {
      state: {
        ...sequenced,
        sessionId: sessionId ?? sequenced.sessionId,
        resumeUrl: resumeUrl ?? sequenced.resumeUrl,
        // 兜底：从旧版投影恢复出来的会话没有这个字段，READY 之后按当前档位补上，
        // 否则「永远不可 RESUME」会退化成每次重连都 IDENTIFY。
        sessionIntents: sequenced.sessionIntents ?? intentsFor(sequenced),
        botUserId: botUserId ?? sequenced.botUserId,
        connected: true,
        pendingReconnect: false,
        reconnectAttempt: 0,
      },
      actions: [{ type: 'log', level: 'info', message: 'gateway READY as ' + (username ?? '<unknown user>') }],
    };
  }

  if (frame.t === 'RESUMED') {
    return {
      state: { ...sequenced, connected: true, pendingReconnect: false, reconnectAttempt: 0 },
      actions: [{ type: 'log', level: 'info', message: 'gateway RESUMED' }],
    };
  }

  if (frame.t === 'MESSAGE_CREATE') {
    // 只把原始 d 往上抛：要不要回、发什么给模型都由 DO + ./message.ts 决定
    return { state: sequenced, actions: [{ type: 'dispatch', name: frame.t, data: frame.d }] };
  }

  return { state: sequenced, actions: [] };
}

function reduceReconnect(state: GatewayState, deps: GatewayDeps): GatewayReduction {
  const attempt = state.reconnectAttempt + 1;
  const delayMs = backoffDelayMs(attempt - 1, deps.random);
  return {
    state: { ...state, connected: false, awaitingAck: false, pendingReconnect: true, reconnectAttempt: attempt },
    actions: [
      { type: 'log', level: 'info', message: 'gateway 要求重连（op7 RECONNECT）' },
      { type: 'closeSocket', reason: 'RECONNECT_OP7' },
      { type: 'scheduleAlarm', delayMs },
    ],
  };
}

function reduceInvalidSession(state: GatewayState, deps: GatewayDeps): GatewayReduction {
  const delayMs = invalidSessionDelayMs(deps.random);
  return {
    // session 作废：sessionId / resumeUrl / seq / sessionIntents 全清，下一次 HELLO 只能走 IDENTIFY
    state: {
      ...state,
      sessionId: null,
      resumeUrl: null,
      sessionIntents: null,
      seq: null,
      connected: false,
      awaitingAck: false,
      pendingReconnect: true,
      reconnectAttempt: 0,
    },
    actions: [
      { type: 'log', level: 'error', message: 'gateway INVALID_SESSION（op9）：丢弃 session，' + String(delayMs) + 'ms 后重新 IDENTIFY' },
      { type: 'closeSocket', reason: 'INVALID_SESSION' },
      { type: 'scheduleAlarm', delayMs },
    ],
  };
}

function reduceHeartbeatTick(state: GatewayState, deps: GatewayDeps): GatewayReduction {
  if (state.awaitingAck) {
    // 上一拍没等到 op11：连接已经不可信，别继续发心跳，直接关掉走退避重连
    const attempt = state.reconnectAttempt + 1;
    const delayMs = backoffDelayMs(attempt - 1, deps.random);
    return {
      state: { ...state, awaitingAck: false, connected: false, pendingReconnect: true, reconnectAttempt: attempt },
      actions: [
        { type: 'log', level: 'error', message: 'gateway 心跳 ACK 超时，关闭连接后 ' + String(delayMs) + 'ms 重连' },
        { type: 'closeSocket', reason: 'HEARTBEAT_ACK_TIMEOUT' },
        { type: 'scheduleAlarm', delayMs },
      ],
    };
  }

  return {
    state: { ...state, awaitingAck: true },
    actions: [
      { type: 'send', payload: encodePayload(heartbeatPayload(state.seq)) },
      { type: 'scheduleAlarm', delayMs: heartbeatDelayMs(state.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS) },
    ],
  };
}

function reduceSocketClosed(state: GatewayState, reason: string, code: number | null, deps: GatewayDeps): GatewayReduction {
  // 4014：Discord 拒绝了本次 intents（默认档含 MESSAGE_CONTENT 特权位，门户没开就会走到这里）。
  // 处理：冷却窗口内退到 intents=0 只保在线，冷却后再试全量档 37376，
  // 这样用户在门户勾上之后会自动恢复，既不用重新部署，也不会让同一个码把连接反复掐断。
  const disallowed = code === CLOSE_CODE_DISALLOWED_INTENTS && !state.intentsDowngraded;
  const base: GatewayState = disallowed
    ? { ...state, intentsDowngraded: true, intentsRetryAtMs: depsNow(deps) + INTENTS_RETRY_AFTER_MS }
    : state;
  const downgrade: GatewayAction[] = disallowed
    ? [
        {
          type: 'log',
          level: 'error',
          message:
            'gateway 4014 DISALLOWED_INTENTS：Discord 拒绝了本次 intents（门户里 MESSAGE CONTENT 可能没开），冷却期内降级为 intents=0（只保在线）重连，' +
            String(INTENTS_RETRY_AFTER_MS) +
            'ms 后自动回到全量档 ' +
            String(GATEWAY_INTENTS_FULL) +
            ' 重试',
        },
      ]
    : [];

  if (base.pendingReconnect) {
    // op7 / op9 / ACK 超时已经排过重连了，这里只把瞬时状态收干净
    return {
      state: { ...base, connected: false, awaitingAck: false },
      actions: [...downgrade, { type: 'log', level: 'info', message: 'gateway 连接关闭（' + reason + '），重连已排期' }],
    };
  }

  const attempt = base.reconnectAttempt + 1;
  const delayMs = backoffDelayMs(attempt - 1, deps.random);
  return {
    state: { ...base, connected: false, awaitingAck: false, pendingReconnect: true, reconnectAttempt: attempt },
    actions: [
      ...downgrade,
      { type: 'log', level: 'error', message: 'gateway 连接关闭（' + reason + '），' + String(delayMs) + 'ms 后重连' },
      { type: 'scheduleAlarm', delayMs },
    ],
  };
}
