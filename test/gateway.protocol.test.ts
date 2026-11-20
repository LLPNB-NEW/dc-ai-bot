import { describe, expect, it } from 'vitest';
import {
  BACKOFF_JITTER_RATIO,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  EMPTY_GATEWAY_STATE,
  GATEWAY_INTENTS_FULL,
  GATEWAY_INTENTS_MINIMAL,
  GATEWAY_URL,
  CLOSE_CODE_DISALLOWED_INTENTS,
  HEARTBEAT_INTERVAL_RATIO,
  IDENTIFY_PROPERTIES,
  INITIAL_BACKOFF_MS,
  INTENTS_RETRY_AFTER_MS,
  INVALID_SESSION_MAX_DELAY_MS,
  INVALID_SESSION_MIN_DELAY_MS,
  MAX_BACKOFF_MS,
  PRESENCE,
  PRESENCE_ACTIVITY_NAME,
  backoffDelayMs,
  heartbeatDelayMs,
  identifyPayload,
  intentsFor,
  invalidSessionDelayMs,
  parseFrame,
  reduceGatewayEvent,
  resumable,
  resumeConnectUrl,
  resumePayload,
  restoreGatewayState,
  serializeGatewayState,
  type GatewayAction,
  type GatewayDeps,
  type GatewayFrame,
  type GatewayState,
  type PersistedGatewayState,
} from '../src/workers/gateway/protocol';

const noJitter: () => number = () => 0;
const fullJitter: () => number = () => 1;
const midJitter: () => number = () => 0.5;

function deps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return { token: 'unit-test-token', random: noJitter, ...overrides };
}

function frame(op: number, d: unknown, extra: { s?: number | null; t?: string | null } = {}): GatewayFrame {
  return { op, d, s: extra.s ?? null, t: extra.t ?? null };
}

/** 把上行载荷用我们自己的解析器读回来，避免测试里再写一遍 JSON 反序列化 */
function sentFrames(actions: GatewayAction[]): GatewayFrame[] {
  const frames: GatewayFrame[] = [];
  for (const action of actions) {
    if (action.type !== 'send') continue;
    const parsed = parseFrame(action.payload);
    if (parsed !== null) frames.push(parsed);
  }
  return frames;
}

function actionOfType<T extends GatewayAction['type']>(actions: GatewayAction[], type: T): Extract<GatewayAction, { type: T }> | null {
  for (const action of actions) {
    if (action.type === type) return action as Extract<GatewayAction, { type: T }>;
  }
  return null;
}

function scheduleDelays(actions: GatewayAction[]): number[] {
  const delays: number[] = [];
  for (const action of actions) {
    if (action.type === 'scheduleAlarm') delays.push(action.delayMs);
  }
  return delays;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('期望一个 JSON 对象');
  return value as Record<string, unknown>;
}

describe('IDENTIFY / presence 载荷', () => {
  it('presence 文案是 /chat 或 @我 聊天，且只声明在线状态', () => {
    expect(PRESENCE_ACTIVITY_NAME).toBe('/chat 或 @我 聊天');
    expect(PRESENCE.status).toBe('online');
    expect(PRESENCE.since).toBeNull();
    expect(PRESENCE.afk).toBe(false);
    expect(PRESENCE.activities).toEqual([{ name: PRESENCE_ACTIVITY_NAME, type: 0 }]);
  });

  it('identifyPayload 生成 op2、默认全量 intents（含 MESSAGE_CONTENT）、properties 与 presence', () => {
    const payload = identifyPayload('bot-token');
    expect(payload.op).toBe(2);
    expect(payload.d.token).toBe('bot-token');
    // 默认请求全量档：GUILD_MESSAGES|DIRECT_MESSAGES|MESSAGE_CONTENT
    // 少了 MESSAGE_CONTENT，guild 频道里的 message.content 会被抹成空串（线上症状：跳过消息（empty））
    expect(payload.d.intents).toBe(GATEWAY_INTENTS_FULL);
    expect(GATEWAY_INTENTS_FULL & 32768).toBe(32768);
    expect(GATEWAY_INTENTS_FULL).toBe(512 + 4096 + 32768);
    expect(GATEWAY_INTENTS_FULL & 262144).toBe(0);
    // 降级档保留（不含 MESSAGE_CONTENT），只在 4014 之后「先连上」时使用
    expect(GATEWAY_INTENTS_MINIMAL).toBe(512 + 4096);
    expect(GATEWAY_INTENTS_MINIMAL & 32768).toBe(0);
    expect(payload.d.properties).toEqual(IDENTIFY_PROPERTIES);
    expect(IDENTIFY_PROPERTIES).toEqual({ os: 'linux', browser: 'dc-ai-bot', device: 'dc-ai-bot' });
    expect(payload.d.presence).toEqual(PRESENCE);

    const serialized = record(JSON.parse(JSON.stringify(payload)) as unknown);
    const d = record(serialized['d']);
    expect(d['intents']).toBe(GATEWAY_INTENTS_FULL);
    // 显式传 0 仍然可用（历史行为：只在线、不收事件）
    expect(identifyPayload('bot-token', 0).d.intents).toBe(0);
    expect(identifyPayload('bot-token', GATEWAY_INTENTS_MINIMAL).d.intents).toBe(GATEWAY_INTENTS_MINIMAL);
    const presence = record(d['presence']);
    expect(presence['status']).toBe('online');
    expect(presence['since']).toBeNull();
    expect(presence['afk']).toBe(false);
    const activities = presence['activities'];
    if (!Array.isArray(activities)) throw new Error('activities 必须是数组');
    expect(activities).toHaveLength(1);
    expect(record(activities[0])).toEqual({ name: '/chat 或 @我 聊天', type: 0 });
  });

  it('resumePayload 带上 session_id 与最近的 s', () => {
    const payload = resumePayload('bot-token', 'sess-1', 42);
    expect(payload.op).toBe(6);
    expect(payload.d).toEqual({ token: 'bot-token', session_id: 'sess-1', seq: 42 });
  });
});

describe('心跳间隔', () => {
  it('取 heartbeat_interval 的 0.9 倍，留出网络抖动余量', () => {
    expect(HEARTBEAT_INTERVAL_RATIO).toBe(0.9);
    expect(heartbeatDelayMs(41250)).toBe(Math.round(41250 * 0.9));
    expect(heartbeatDelayMs(1000)).toBe(900);
  });

  it('缺省或非法 interval 回落到 Discord 常见值', () => {
    expect(heartbeatDelayMs(0)).toBe(Math.round(DEFAULT_HEARTBEAT_INTERVAL_MS * 0.9));
    expect(heartbeatDelayMs(Number.NaN)).toBe(Math.round(DEFAULT_HEARTBEAT_INTERVAL_MS * 0.9));
    expect(heartbeatDelayMs(-5)).toBe(Math.round(DEFAULT_HEARTBEAT_INTERVAL_MS * 0.9));
  });
});

describe('重连退避', () => {
  it('1s 起步、逐次翻倍：attempt 0..3 的确定性值', () => {
    expect(INITIAL_BACKOFF_MS).toBe(1000);
    expect(backoffDelayMs(0, noJitter)).toBe(750);
    expect(backoffDelayMs(1, noJitter)).toBe(1500);
    expect(backoffDelayMs(2, noJitter)).toBe(3000);
    expect(backoffDelayMs(3, noJitter)).toBe(6000);
  });

  it('抖动落在基准值的 ±25% 之内', () => {
    expect(BACKOFF_JITTER_RATIO).toBe(0.25);
    expect(backoffDelayMs(0, fullJitter)).toBe(1250);
    expect(backoffDelayMs(2, fullJitter)).toBe(5000);
    expect(backoffDelayMs(2, midJitter)).toBe(4000);
  });

  it('封顶 60s，再怎么翻倍也不会突破', () => {
    expect(MAX_BACKOFF_MS).toBe(60000);
    for (let attempt = 0; attempt <= 20; attempt += 1) {
      const delay = backoffDelayMs(attempt, fullJitter);
      expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      expect(delay).toBeGreaterThan(0);
    }
    expect(backoffDelayMs(20, fullJitter)).toBe(MAX_BACKOFF_MS);
  });

  it('基准值随 attempt 单调不减（0.5 抖动下无随机性）', () => {
    let previous = 0;
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      const delay = backoffDelayMs(attempt, midJitter);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it('非法 attempt 当作第一次失败处理', () => {
    expect(backoffDelayMs(-3, noJitter)).toBe(750);
    expect(backoffDelayMs(Number.NaN, noJitter)).toBe(750);
  });
});

describe('INVALID_SESSION 延迟', () => {
  it('落在 Discord 要求的 1~5 秒之间', () => {
    expect(INVALID_SESSION_MIN_DELAY_MS).toBe(1000);
    expect(INVALID_SESSION_MAX_DELAY_MS).toBe(5000);
    expect(invalidSessionDelayMs(noJitter)).toBe(1000);
    expect(invalidSessionDelayMs(fullJitter)).toBe(5000);
    expect(invalidSessionDelayMs(midJitter)).toBe(3000);
  });
});

describe('连接 URL', () => {
  it('首次连接用 v10 + json 的固定地址', () => {
    expect(GATEWAY_URL).toBe('wss://gateway.discord.gg/?v=10&encoding=json');
  });

  it('RESUME 地址补上 v/encoding 查询参数', () => {
    const url = resumeConnectUrl('wss://gateway-us-east1-b.discord.gg');
    expect(url.startsWith('wss://gateway-us-east1-b.discord.gg/')).toBe(true);
    expect(url).toContain('v=10');
    expect(url).toContain('encoding=json');
  });

  it('拿不到合法地址时回落到默认网关', () => {
    expect(resumeConnectUrl('not a url')).toBe(GATEWAY_URL);
  });
});

describe('下行帧解析', () => {
  it('文本帧', () => {
    const parsed = parseFrame('{"op":0,"d":{"session_id":"s"},"s":7,"t":"READY"}');
    expect(parsed).not.toBeNull();
    expect(parsed?.op).toBe(0);
    expect(parsed?.s).toBe(7);
    expect(parsed?.t).toBe('READY');
  });

  it('二进制帧（ArrayBuffer）与文本帧等价', () => {
    const text = '{"op":11,"d":null}';
    const bytes = new TextEncoder().encode(text);
    const parsed = parseFrame(bytes.buffer as ArrayBuffer);
    expect(parsed?.op).toBe(11);
    expect(parsed?.s).toBeNull();
    expect(parsed?.t).toBeNull();
  });

  it('坏帧一律返回 null，不抛错', () => {
    expect(parseFrame('')).toBeNull();
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
    expect(parseFrame('"text"')).toBeNull();
    expect(parseFrame('42')).toBeNull();
    expect(parseFrame('{"d":{}}')).toBeNull();
    expect(parseFrame('{"op":"2"}')).toBeNull();
    expect(parseFrame('{"op":1.5}')).toBeNull();
  });
});

describe('opcode 分发', () => {
  it('HELLO 且无 session：发 IDENTIFY 并按 interval 排心跳', () => {
    const reduced = reduceGatewayEvent(EMPTY_GATEWAY_STATE, { kind: 'frame', frame: frame(10, { heartbeat_interval: 41250 }) }, deps());
    expect(reduced.state.heartbeatIntervalMs).toBe(41250);
    expect(reduced.state.awaitingAck).toBe(false);
    const sent = sentFrames(reduced.actions);
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe(2);
    expect(record(sent[0].d)['token']).toBe('unit-test-token');
    expect(scheduleDelays(reduced.actions)).toEqual([Math.round(41250 * 0.9)]);
  });

  it('HELLO 且已有 session、intents 一致：优先 RESUME(op6)', () => {
    const state: GatewayState = {
      ...EMPTY_GATEWAY_STATE,
      sessionId: 'sess-1',
      resumeUrl: 'wss://resume.discord.gg',
      sessionIntents: GATEWAY_INTENTS_FULL,
      seq: 55,
    };
    const reduced = reduceGatewayEvent(state, { kind: 'frame', frame: frame(10, { heartbeat_interval: 41250 }) }, deps());
    const sent = sentFrames(reduced.actions);
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe(6);
    expect(record(sent[0].d)).toEqual({ token: 'unit-test-token', session_id: 'sess-1', seq: 55 });
  });

  it('HELLO 缺 interval：关掉连接而不是硬发心跳', () => {
    const reduced = reduceGatewayEvent(EMPTY_GATEWAY_STATE, { kind: 'frame', frame: frame(10, {}) }, deps());
    expect(sentFrames(reduced.actions)).toHaveLength(0);
    expect(actionOfType(reduced.actions, 'closeSocket')?.reason).toBe('HELLO_WITHOUT_INTERVAL');
  });

  it('READY：存 session_id / resume_gateway_url 并把退避计数清零', () => {
    const state: GatewayState = { ...EMPTY_GATEWAY_STATE, reconnectAttempt: 4, pendingReconnect: true };
    const ready = frame(0, { session_id: 'sess-9', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg', user: { username: 'dc-ai-bot' } }, { s: 1, t: 'READY' });
    const reduced = reduceGatewayEvent(state, { kind: 'frame', frame: ready }, deps());
    expect(reduced.state.sessionId).toBe('sess-9');
    expect(reduced.state.resumeUrl).toBe('wss://gateway-us-east1-b.discord.gg');
    expect(reduced.state.seq).toBe(1);
    expect(reduced.state.connected).toBe(true);
    expect(reduced.state.pendingReconnect).toBe(false);
    expect(reduced.state.reconnectAttempt).toBe(0);
    const log = actionOfType(reduced.actions, 'log');
    expect(log?.level).toBe('info');
    expect(log?.message).toContain('dc-ai-bot');
  });

  it('RESUMED：确认恢复成功', () => {
    const resumed = frame(0, {}, { s: 12, t: 'RESUMED' });
    const reduced = reduceGatewayEvent({ ...EMPTY_GATEWAY_STATE, reconnectAttempt: 2 }, { kind: 'frame', frame: resumed }, deps());
    expect(reduced.state.connected).toBe(true);
    expect(reduced.state.seq).toBe(12);
    expect(reduced.state.reconnectAttempt).toBe(0);
  });

  it('普通 DISPATCH 只推进 s，不产生任何动作', () => {
    const dispatch = frame(0, { content: 'hi' }, { s: 21, t: 'MESSAGE_UPDATE' });
    const reduced = reduceGatewayEvent(EMPTY_GATEWAY_STATE, { kind: 'frame', frame: dispatch }, deps());
    expect(reduced.state.seq).toBe(21);
    expect(reduced.actions).toHaveLength(0);
  });

  it('op1 HEARTBEAT_ACK 只清掉未确认标记', () => {
    const reduced = reduceGatewayEvent({ ...EMPTY_GATEWAY_STATE, awaitingAck: true }, { kind: 'frame', frame: frame(11, null) }, deps());
    expect(reduced.state.awaitingAck).toBe(false);
    expect(reduced.actions).toHaveLength(0);
  });

  it('服务端主动要心跳（op1）时立刻回一拍，d 用最近的 s', () => {
    const reduced = reduceGatewayEvent({ ...EMPTY_GATEWAY_STATE, seq: 33 }, { kind: 'frame', frame: frame(1, null) }, deps());
    const sent = sentFrames(reduced.actions);
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe(1);
    expect(sent[0].d).toBe(33);
  });

  it('未知 opcode 只记一条日志，不动状态', () => {
    const reduced = reduceGatewayEvent(EMPTY_GATEWAY_STATE, { kind: 'frame', frame: frame(99, {}) }, deps());
    expect(reduced.state).toEqual(EMPTY_GATEWAY_STATE);
    expect(actionOfType(reduced.actions, 'log')?.level).toBe('error');
  });

  it('op7 RECONNECT：关闭连接并按退避排下一次重连', () => {
    const reduced = reduceGatewayEvent({ ...EMPTY_GATEWAY_STATE, connected: true }, { kind: 'frame', frame: frame(7, null) }, deps());
    expect(actionOfType(reduced.actions, 'closeSocket')?.reason).toBe('RECONNECT_OP7');
    expect(scheduleDelays(reduced.actions)).toEqual([750]);
    expect(reduced.state.pendingReconnect).toBe(true);
    expect(reduced.state.reconnectAttempt).toBe(1);
    expect(reduced.state.connected).toBe(false);
  });

  it('op9 INVALID_SESSION：丢弃 session（含 intents 凭据），1~5 秒后重新 IDENTIFY', () => {
    const state: GatewayState = {
      ...EMPTY_GATEWAY_STATE,
      sessionId: 'sess-1',
      resumeUrl: 'wss://resume.discord.gg',
      sessionIntents: GATEWAY_INTENTS_MINIMAL,
      seq: 9,
      connected: true,
      reconnectAttempt: 3,
    };
    const reduced = reduceGatewayEvent(state, { kind: 'frame', frame: frame(9, false) }, deps({ random: midJitter }));
    expect(reduced.state.sessionId).toBeNull();
    expect(reduced.state.resumeUrl).toBeNull();
    expect(reduced.state.sessionIntents).toBeNull();
    expect(resumable(reduced.state)).toBe(false);
    expect(reduced.state.seq).toBeNull();
    expect(reduced.state.connected).toBe(false);
    expect(reduced.state.reconnectAttempt).toBe(0);
    expect(reduced.state.pendingReconnect).toBe(true);
    expect(actionOfType(reduced.actions, 'closeSocket')?.reason).toBe('INVALID_SESSION');
    const delays = scheduleDelays(reduced.actions);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(INVALID_SESSION_MIN_DELAY_MS);
    expect(delays[0]).toBeLessThanOrEqual(INVALID_SESSION_MAX_DELAY_MS);
    // session 被清掉之后，下一个 HELLO 只能走 IDENTIFY
    const hello = reduceGatewayEvent(reduced.state, { kind: 'frame', frame: frame(10, { heartbeat_interval: 41250 }) }, deps());
    expect(sentFrames(hello.actions)[0].op).toBe(2);
  });
});

describe('心跳 tick 与连接关闭', () => {
  it('第一拍发 op1 并标记等待 ACK，同时排下一拍', () => {
    const state: GatewayState = { ...EMPTY_GATEWAY_STATE, seq: 7, heartbeatIntervalMs: 41250, connected: true };
    const reduced = reduceGatewayEvent(state, { kind: 'heartbeatTick' }, deps());
    const sent = sentFrames(reduced.actions);
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe(1);
    expect(sent[0].d).toBe(7);
    expect(reduced.state.awaitingAck).toBe(true);
    expect(scheduleDelays(reduced.actions)).toEqual([Math.round(41250 * 0.9)]);
  });

  it('没有 s 时心跳的 d 是 null', () => {
    const reduced = reduceGatewayEvent({ ...EMPTY_GATEWAY_STATE, heartbeatIntervalMs: 41250 }, { kind: 'heartbeatTick' }, deps());
    expect(sentFrames(reduced.actions)[0].d).toBeNull();
  });

  it('上一拍没 ACK：关掉连接改走退避重连', () => {
    const state: GatewayState = { ...EMPTY_GATEWAY_STATE, heartbeatIntervalMs: 41250, awaitingAck: true, connected: true };
    const reduced = reduceGatewayEvent(state, { kind: 'heartbeatTick' }, deps());
    expect(actionOfType(reduced.actions, 'closeSocket')?.reason).toBe('HEARTBEAT_ACK_TIMEOUT');
    expect(sentFrames(reduced.actions)).toHaveLength(0);
    expect(scheduleDelays(reduced.actions)).toEqual([750]);
    expect(reduced.state.pendingReconnect).toBe(true);
    expect(reduced.state.reconnectAttempt).toBe(1);
  });

  it('socket 关闭：按退避排一次重连', () => {
    const reduced = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, connected: true },
      { kind: 'socketClosed', reason: '1006', code: 1006 },
      deps(),
    );
    expect(scheduleDelays(reduced.actions)).toEqual([750]);
    expect(reduced.state.pendingReconnect).toBe(true);
    expect(reduced.state.connected).toBe(false);
  });

  it('已经排过重连的关闭事件不再重复排期（退避计数不会翻倍）', () => {
    const reduced = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, pendingReconnect: true, reconnectAttempt: 1 },
      { kind: 'socketClosed', reason: '1000', code: 1000 },
      deps(),
    );
    expect(scheduleDelays(reduced.actions)).toEqual([]);
    expect(reduced.state.reconnectAttempt).toBe(1);
    expect(actionOfType(reduced.actions, 'log')?.level).toBe('info');
  });
});

describe('持久化投影', () => {
  const live: GatewayState = {
    sessionId: 'sess-1',
    resumeUrl: 'wss://resume.discord.gg',
    seq: 41,
    heartbeatIntervalMs: 41250,
    awaitingAck: true,
    connected: true,
    pendingReconnect: true,
    reconnectAttempt: 2,
    sessionIntents: GATEWAY_INTENTS_MINIMAL,
    botUserId: '150000000000000001',
    intentsDowngraded: true,
    intentsRetryAtMs: 1_700_000_600_000,
  };

  it('只落盘跨驱逐有意义的字段', () => {
    const persisted = serializeGatewayState(live);
    expect(persisted).toEqual({
      sessionId: 'sess-1',
      resumeUrl: 'wss://resume.discord.gg',
      sessionIntents: GATEWAY_INTENTS_MINIMAL,
      seq: 41,
      heartbeatIntervalMs: 41250,
      reconnectAttempt: 2,
      botUserId: '150000000000000001',
      intentsDowngraded: true,
      intentsRetryAtMs: 1_700_000_600_000,
    });
    expect(Object.keys(persisted).sort()).toEqual([
      'botUserId',
      'heartbeatIntervalMs',
      'intentsDowngraded',
      'intentsRetryAtMs',
      'reconnectAttempt',
      'resumeUrl',
      'seq',
      'sessionId',
      'sessionIntents',
    ]);
  });

  it('还原时瞬时标志一律复位，可恢复的字段保留', () => {
    const restored = restoreGatewayState(serializeGatewayState(live));
    expect(restored.sessionId).toBe('sess-1');
    expect(restored.seq).toBe(41);
    expect(restored.reconnectAttempt).toBe(2);
    expect(restored.awaitingAck).toBe(false);
    expect(restored.connected).toBe(false);
    expect(restored.pendingReconnect).toBe(false);
  });

  it('空/损坏的存储值退回空状态，不抛错', () => {
    expect(restoreGatewayState(undefined)).toEqual(EMPTY_GATEWAY_STATE);
    expect(restoreGatewayState(null)).toEqual(EMPTY_GATEWAY_STATE);
    const corrupted = {
      sessionId: '',
      resumeUrl: 5,
      seq: 'x',
      heartbeatIntervalMs: -1,
      reconnectAttempt: -2,
    } as unknown as PersistedGatewayState;
    expect(restoreGatewayState(corrupted)).toEqual(EMPTY_GATEWAY_STATE);
  });
});

describe('普通消息（MESSAGE_CREATE）事件与 4014 降级', () => {
  const dispatchFrame = (t: string, d: unknown, s: number | null = 7): GatewayFrame => ({ op: 0, d, s, t });

  it('op0 MESSAGE_CREATE 产出一条 dispatch 动作，其余事件不产生动作', () => {
    const message = { id: 'm1', channel_id: 'c1', content: 'hi' };
    const reduced = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, connected: true },
      { kind: 'frame', frame: dispatchFrame('MESSAGE_CREATE', message) },
      deps(),
    );
    expect(reduced.state.seq).toBe(7);
    const dispatch = reduced.actions.find((action) => action.type === 'dispatch');
    expect(dispatch).toEqual({ type: 'dispatch', name: 'MESSAGE_CREATE', data: message });
    expect(reduced.state.connected).toBe(true);

    const other = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, connected: true },
      { kind: 'frame', frame: dispatchFrame('TYPING_START', {}) },
      deps(),
    );
    expect(other.actions).toEqual([]);
    expect(other.state.seq).toBe(7);
  });

  it('READY 记录 user.id，后面判「是不是 @我」要用', () => {
    const reduced = reduceGatewayEvent(
      EMPTY_GATEWAY_STATE,
      {
        kind: 'frame',
        frame: dispatchFrame('READY', {
          session_id: 'sess-9',
          resume_gateway_url: 'wss://resume.example',
          user: { id: '999', username: '示例机器人' },
        }),
      },
      deps(),
    );
    expect(reduced.state.botUserId).toBe('999');
    expect(reduced.state.sessionId).toBe('sess-9');
    expect(reduced.state.connected).toBe(true);
  });

  it('4014 关闭码降级到 intents=0（只保在线），冷却期内不再请求事件', () => {
    const reduced = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, connected: true },
      { kind: 'socketClosed', reason: 'code 4014', code: CLOSE_CODE_DISALLOWED_INTENTS },
      deps(),
    );
    expect(reduced.state.intentsDowngraded).toBe(true);
    expect(intentsFor(reduced.state)).toBe(0);
    // 仍然要退避重连，只是换了 intents
    expect(scheduleDelays(reduced.actions)).toEqual([750]);

    const hello = reduceGatewayEvent(
      { ...reduced.state, heartbeatIntervalMs: null },
      { kind: 'frame', frame: frame(10, { heartbeat_interval: 41250 }) },
      deps(),
    );
    const sent = sentFrames(hello.actions);
    expect(sent).toHaveLength(1);
    expect(record(sent[0].d)['intents']).toBe(0);
  });

  it('降级只发生一次：已在降级态时 4014 不再改写状态；默认档含 MESSAGE_CONTENT', () => {
    const reduced = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, connected: true, intentsDowngraded: true },
      { kind: 'socketClosed', reason: 'code 4014', code: CLOSE_CODE_DISALLOWED_INTENTS },
      deps(),
    );
    expect(reduced.state.intentsDowngraded).toBe(true);
    expect(reduced.state.intentsRetryAtMs).toBeNull();
    // 默认档是全量档，且确实带 MESSAGE_CONTENT 特权位
    expect(intentsFor(EMPTY_GATEWAY_STATE)).toBe(GATEWAY_INTENTS_FULL);
    expect(intentsFor(EMPTY_GATEWAY_STATE) & 32768).toBe(32768);
    expect(intentsFor(EMPTY_GATEWAY_STATE)).not.toBe(GATEWAY_INTENTS_MINIMAL);
  });
});

describe('4014 降级的冷却与自愈', () => {
  const NOW = 1_700_000_000_000;

  it('冷却到期后回到默认档重试，并把降级标记清掉', () => {
    const downgraded = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, connected: true },
      { kind: 'socketClosed', reason: 'code 4014', code: CLOSE_CODE_DISALLOWED_INTENTS },
      deps({ now: () => NOW }),
    );
    expect(downgraded.state.intentsDowngraded).toBe(true);
    expect(downgraded.state.intentsRetryAtMs).toBe(NOW + INTENTS_RETRY_AFTER_MS);
    expect(intentsFor(downgraded.state, NOW + 1000)).toBe(0);

    const inCooldown = reduceGatewayEvent(
      downgraded.state,
      { kind: 'frame', frame: frame(10, { heartbeat_interval: 41250 }) },
      deps({ now: () => NOW + 1000 }),
    );
    expect(record(sentFrames(inCooldown.actions)[0].d)['intents']).toBe(0);
    expect(inCooldown.state.intentsDowngraded).toBe(true);

    const afterCooldown = reduceGatewayEvent(
      downgraded.state,
      { kind: 'frame', frame: frame(10, { heartbeat_interval: 41250 }) },
      deps({ now: () => NOW + INTENTS_RETRY_AFTER_MS }),
    );
    // 冷却到期必须回到全量档 37376（带 MESSAGE_CONTENT），不是降级档 4608
    expect(record(sentFrames(afterCooldown.actions)[0].d)['intents']).toBe(GATEWAY_INTENTS_FULL);
    expect(record(sentFrames(afterCooldown.actions)[0].d)['intents']).toBe(37376);
    expect(intentsFor(EMPTY_GATEWAY_STATE, NOW)).toBe(GATEWAY_INTENTS_FULL);
    expect(afterCooldown.state.intentsDowngraded).toBe(false);
    expect(afterCooldown.state.intentsRetryAtMs).toBeNull();
    expect(afterCooldown.state.sessionIntents).toBe(GATEWAY_INTENTS_FULL);
    // 冷却到期后 intentsFor 本身就回到全量档（下一轮握手即便有旧会话也会因 intents 不一致而重新 IDENTIFY）
    expect(intentsFor(downgraded.state, NOW + INTENTS_RETRY_AFTER_MS)).toBe(GATEWAY_INTENTS_FULL);
    expect(intentsFor(downgraded.state, NOW + INTENTS_RETRY_AFTER_MS)).toBe(37376);
  });
});


describe('RESUME 与 intents 版本绑定', () => {
  const hello = (): GatewayFrame => frame(10, { heartbeat_interval: 41250 });

  it('会话 intents 与当前档一致才 RESUME，且 RESUME 不改写凭据', () => {
    const state: GatewayState = {
      ...EMPTY_GATEWAY_STATE,
      sessionId: 'sess-1',
      resumeUrl: 'wss://resume.discord.gg',
      sessionIntents: GATEWAY_INTENTS_FULL,
      seq: 7,
    };
    expect(resumable(state)).toBe(true);
    const reduced = reduceGatewayEvent(state, { kind: 'frame', frame: hello() }, deps());
    const sent = sentFrames(reduced.actions);
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe(6);
    expect(reduced.state.sessionIntents).toBe(GATEWAY_INTENTS_FULL);
  });

  it('会话 intents 是降级档（旧的 4608 会话）时也必须重新 IDENTIFY 拿正文', () => {
    const state: GatewayState = {
      ...EMPTY_GATEWAY_STATE,
      sessionId: 'sess-legacy',
      resumeUrl: 'wss://resume.discord.gg',
      // 线上历史会话：上一个版本用 4608 谈的，正文因此是空串
      sessionIntents: GATEWAY_INTENTS_MINIMAL,
      seq: 11,
      connected: true,
    };
    expect(resumable(state)).toBe(false);
    const reduced = reduceGatewayEvent(state, { kind: 'frame', frame: hello() }, deps());
    const sent = sentFrames(reduced.actions);
    expect(sent[0].op).toBe(2);
    expect(record(sent[0].d)['intents']).toBe(GATEWAY_INTENTS_FULL);
    expect(reduced.state.sessionIntents).toBe(GATEWAY_INTENTS_FULL);
  });

  it('intents 变了（旧会话是 intents=0）就强制 IDENTIFY 重新协商', () => {
    const state: GatewayState = {
      ...EMPTY_GATEWAY_STATE,
      sessionId: 'sess-old',
      resumeUrl: 'wss://resume.discord.gg',
      sessionIntents: 0,
      seq: 3,
      connected: true,
    };
    expect(resumable(state)).toBe(false);
    const reduced = reduceGatewayEvent(state, { kind: 'frame', frame: hello() }, deps());
    const sent = sentFrames(reduced.actions);
    expect(sent[0].op).toBe(2);
    expect(record(sent[0].d)['intents']).toBe(GATEWAY_INTENTS_FULL);
    expect(reduced.state.sessionIntents).toBe(GATEWAY_INTENTS_FULL);
    expect(actionOfType(reduced.actions, 'log')?.message).toContain('IDENTIFY(op2) intents=' + String(GATEWAY_INTENTS_FULL));
  });

  it('旧版投影没有 sessionIntents（null）时也只能 IDENTIFY', () => {
    const state: GatewayState = {
      ...EMPTY_GATEWAY_STATE,
      sessionId: 'sess-x',
      resumeUrl: 'wss://resume.discord.gg',
    };
    expect(state.sessionIntents).toBeNull();
    expect(resumable(state)).toBe(false);
    expect(sentFrames(reduceGatewayEvent(state, { kind: 'frame', frame: hello() }, deps()).actions)[0].op).toBe(2);
  });

  it('READY 之后凭据落盘，驱逐恢复后仍然可以 RESUME', () => {
    const identified = reduceGatewayEvent(
      { ...EMPTY_GATEWAY_STATE, sessionId: 'sess-old', resumeUrl: 'wss://resume.discord.gg', sessionIntents: 0 },
      { kind: 'frame', frame: hello() },
      deps(),
    );
    const ready = frame(
      0,
      { session_id: 'sess-new', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg', user: { id: '999', username: 'dc-ai-bot' } },
      { s: 1, t: 'READY' },
    );
    const reduced = reduceGatewayEvent(identified.state, { kind: 'frame', frame: ready }, deps());
    expect(reduced.state.sessionId).toBe('sess-new');
    expect(reduced.state.sessionIntents).toBe(GATEWAY_INTENTS_FULL);
    expect(resumable(reduced.state)).toBe(true);
    const restored = restoreGatewayState(serializeGatewayState(reduced.state));
    expect(restored.sessionIntents).toBe(GATEWAY_INTENTS_FULL);
    expect(resumable(restored)).toBe(true);
  });

  it('4014 降级到 intents=0 后，旧会话凭据不再允许 RESUME', () => {
    const state: GatewayState = {
      ...EMPTY_GATEWAY_STATE,
      sessionId: 'sess-1',
      resumeUrl: 'wss://resume.discord.gg',
      sessionIntents: GATEWAY_INTENTS_FULL,
      intentsDowngraded: true,
      intentsRetryAtMs: Date.now() + 60_000,
    };
    expect(intentsFor(state)).toBe(0);
    expect(resumable(state)).toBe(false);
    const reduced = reduceGatewayEvent(state, { kind: 'frame', frame: hello() }, deps());
    expect(record(sentFrames(reduced.actions)[0].d)['intents']).toBe(0);
    expect(reduced.state.sessionIntents).toBe(0);
  });
});
