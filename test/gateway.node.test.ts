/**
 * Node 宿主的定时器契约。真连 Discord 不可能也不该进 CI，所以这里 stub 掉全局 WebSocket，
 * 用假定时器把三条节奏都推一遍：看门狗（15s）、心跳（0.9×interval）、退避重连。
 *
 * 最要紧的一条断言是「同一时刻只有一个 timer」：靠 created - cleared - fired === 1 表达。
 * fired 必须算进消耗，否则定时器触发后宿主把 #timer 置空、下一拍 clearTimeout 早退，
 * 账面上会凭空多出一个活着的 timer。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeGateway, type NodeGateway } from '../src/node/gateway';
import {
  createGatewayEngine,
  GATEWAY_ENSURE_PATH,
  GATEWAY_INTERNAL_ORIGIN,
  GATEWAY_SHUTDOWN_PATH,
  type GatewayEngineHost,
} from '../src/workers/gateway/engine';
import type { SqlDatabase, SqlStatement } from '../src/core/db/sql';

const BOT_TOKEN = 'test-token';
/** Discord 默认的 op10 heartbeat_interval */
const HEARTBEAT_INTERVAL_MS = 41250;
/** 0.9 × interval：引擎排的心跳延迟 */
const HEARTBEAT_DELAY_MS = 37125;
const HANDSHAKE_WATCHDOG_MS = 15000;
/** 退避窗口上限：1000 × (1 + 0.25) 抖动，多给一点余量再断言重连发生 */
const BACKOFF_CEILING_MS = 1300;

interface FakeEvent {
  data?: unknown;
  type?: string;
  code?: number;
  reason?: string;
}

type FakeListener = (event: FakeEvent) => void;

/**
 * 只实现引擎真正用到的那一小撮：静态 readyState 常量、binaryType、addEventListener、send、close。
 * close() 故意不回放 close 事件：引擎在关连接前已经把 #socket 置空，真实宿主里那次回报也会被忽略。
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.instances = [];
  }

  readonly url: string;
  readyState = FakeSocket.OPEN;
  binaryType = 'blob';
  readonly sent: string[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  readonly #listeners = new Map<string, FakeListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: FakeListener): void {
    const list = this.#listeners.get(type);
    if (list === undefined) this.#listeners.set(type, [listener]);
    else list.push(listener);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeSocket.CLOSED;
    this.closes.push({ code, reason });
  }

  /** 测试专用：模拟 Discord 下行一帧 */
  emit(frame: Record<string, unknown>): void {
    for (const listener of this.#listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(frame) });
    }
  }

  opcodes(): number[] {
    return this.sent.map((payload) => (JSON.parse(payload) as { op: number }).op);
  }
}

function socketAt(index: number): FakeSocket {
  const socket = FakeSocket.instances[index];
  if (socket === undefined) throw new Error('第 ' + String(index + 1) + ' 个连接还没建立');
  return socket;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = (): void => {
      resolve();
    };
  });
  return { promise, resolve: release };
}

/** 假 SqlDatabase：只为「让一条 waitUntil 任务悬着」服务，仓储层的方法这里一个都不需要真跑 */
function createFakeDb(batch: (statements: SqlStatement[]) => Promise<unknown>): SqlDatabase {
  const statement: SqlStatement = {
    bind: (): SqlStatement => statement,
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => undefined,
  };
  return {
    prepare: (): SqlStatement => statement,
    batch: (statements: SqlStatement[]): Promise<unknown> => batch(statements),
  };
}

/** 引擎每次排期都新建一个 timer，这里把「建/清/触发」都数下来，好断言活着的永远只有一个 */
const timers = { created: 0, cleared: 0, fired: 0 };

function liveTimers(): number {
  return timers.created - timers.cleared - timers.fired;
}

let gateway: NodeGateway | null = null;

beforeEach(() => {
  FakeSocket.reset();
  timers.created = 0;
  timers.cleared = 0;
  timers.fired = 0;
  vi.useFakeTimers();
  // 先取到假定时器本体，再挂 spy：spy 的实现必须委托给它，否则会自己调自己
  const fakeSetTimeout = globalThis.setTimeout;
  const fakeClearTimeout = globalThis.clearTimeout;
  // 参数与返回值的类型全部从平台定义里取：workerd 的 handle 是 number，Node 的 handle 是 Timeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof globalThis.setTimeout>
  ): ReturnType<typeof globalThis.setTimeout> => {
    timers.created += 1;
    const [handler, delay, ...rest] = args;
    const wrapped: Parameters<typeof globalThis.setTimeout>[0] =
      typeof handler === 'function'
        ? (...inner: unknown[]): void => {
            timers.fired += 1;
            (handler as (...passed: unknown[]) => void)(...inner);
          }
        : handler;
    return fakeSetTimeout(wrapped, delay, ...rest);
  }) as typeof globalThis.setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
    ...args: Parameters<typeof globalThis.clearTimeout>
  ): void => {
    timers.cleared += 1;
    fakeClearTimeout(...args);
  }) as typeof globalThis.clearTimeout);
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(async () => {
  if (gateway !== null) {
    await gateway.stop();
    gateway = null;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 引擎的 fetch 链是异步的，假定时器推进 0ms 顺便把微任务排干 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

function startGateway(db: SqlDatabase = createFakeDb(async () => undefined)): NodeGateway {
  const created = createNodeGateway({ db, botToken: BOT_TOKEN, applicationId: 'bot-1' });
  created.start();
  gateway = created;
  return created;
}

/** HELLO 之后必须紧跟 READY：没收到 READY 时引擎把 alarm 当握手看门狗，会重连而不是发心跳 */
async function handshake(socket: FakeSocket): Promise<void> {
  socket.emit(HELLO);
  socket.emit(READY);
  await flush();
}

const HELLO = { op: 10, d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS } };
const READY = {
  op: 0,
  t: 'READY',
  s: 1,
  d: { session_id: 'session-1', resume_gateway_url: 'wss://resume.example', user: { id: 'bot-1' } },
};

describe('Node 网关宿主', () => {
  it('start() 建 WebSocket，收到 op10 后用 token 发 IDENTIFY', async () => {
    const logSpy = vi.spyOn(console, 'log');
    startGateway();
    await flush();

    expect(FakeSocket.instances).toHaveLength(1);
    const socket = socketAt(0);
    expect(socket.url).toContain('gateway.discord.gg');
    expect(socket.url).toContain('v=10');
    expect(socket.binaryType).toBe('arraybuffer');
    // 握手没走完之前一个字节都不该发：op1 先到会被服务端直接断开
    expect(socket.opcodes()).toEqual([]);

    socket.emit(HELLO);
    await flush();
    expect(socket.opcodes()).toEqual([2]);
    const identify = JSON.parse(socket.sent[0] ?? '{}') as { op: number; d: { token: string } };
    expect(identify.d.token).toBe(BOT_TOKEN);

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[gateway] node host started build=draw-image-3');
  });

  it('op10 之后按 0.9 倍 interval 排心跳（而不是 interval 本身）', async () => {
    startGateway();
    await flush();
    const socket = socketAt(0);
    await handshake(socket);
    expect(socket.opcodes()).toEqual([2]);

    // 差 1ms 不发
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DELAY_MS - 1);
    expect(socket.opcodes()).toEqual([2]);

    await vi.advanceTimersByTimeAsync(1);
    expect(socket.opcodes()).toEqual([2, 1]);
    // 心跳排期把下一拍排上，仍然只有一个 timer
    expect(liveTimers()).toBe(1);
  });

  it('握手 15s 等不到 HELLO 时看门狗触发重连', async () => {
    startGateway();
    await flush();
    const first = socketAt(0);

    await vi.advanceTimersByTimeAsync(HANDSHAKE_WATCHDOG_MS - 1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(first.closes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(first.closes).toEqual([{ code: 1000, reason: 'REPLACED_BY_NEW_CONNECTION' }]);
    expect(FakeSocket.instances).toHaveLength(2);

    socketAt(1).emit(HELLO);
    await flush();
    expect(socketAt(1).opcodes()).toEqual([2]);
  });

  it('HELLO 之后一直没有 ACK：心跳超时关闭连接，退避窗口过后重连', async () => {
    startGateway();
    await flush();
    const socket = socketAt(0);
    await handshake(socket);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_DELAY_MS);
    expect(socket.opcodes()).toEqual([2, 1]);
    expect(socket.closes).toEqual([]);

    // 第二拍时 awaitingAck 还是 true：不发 op1，直接判死并排退避
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DELAY_MS);
    await flush();
    expect(socket.closes).toEqual([{ code: 1000, reason: 'HEARTBEAT_ACK_TIMEOUT' }]);
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(liveTimers()).toBe(1);
  });

  it('同一时刻只有一个 timer：每排一期都先清掉上一期', async () => {
    startGateway();
    await flush();
    // 看门狗
    expect(timers.created).toBe(1);
    expect(liveTimers()).toBe(1);

    const socket = socketAt(0);
    await handshake(socket);
    // 心跳替换掉看门狗：新建了第二个，但前一个已被清掉
    expect(timers.created).toBe(2);
    expect(liveTimers()).toBe(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_DELAY_MS);
    // 触发的那一拍记在 fired 上，新一排的心跳仍然只有一个
    expect(timers.created).toBe(3);
    expect(liveTimers()).toBe(1);
  });

  it('stop() 清 timer、关连接，并等完在飞的后台任务', async () => {
    const deferred = createDeferred();
    const created = startGateway(createFakeDb(() => deferred.promise));
    await flush();
    const socket = socketAt(0);
    await handshake(socket);
    // READY 触发引擎记一条运行日志：那条日志走 waitUntil，batch 悬着 => 有在飞的后台任务
    expect(socket.opcodes()).toEqual([2]);

    let settled = false;
    const stopping = created.stop().then(() => {
      settled = true;
    });
    // stop() 先清 timer 再关连接，两步都不该等后台任务
    await flush();
    expect(socket.closes).toEqual([{ code: 1000, reason: 'shutdown' }]);
    expect(liveTimers()).toBe(0);
    expect(settled).toBe(false);

    deferred.resolve();
    await stopping;
    expect(settled).toBe(true);

    // 停机之后连接层再怎么闹也不许再排期
    const createdBefore = timers.created;
    socket.emit(HELLO);
    await flush();
    expect(timers.created).toBe(createdBefore);
    expect(liveTimers()).toBe(0);
  });

  it('停机之后引擎自己也不再排期：直接对引擎调 alarm()/fetch() 都不建连接', async () => {
    const alarms: number[] = [];
    const state = new Map<string, unknown>();
    const host: GatewayEngineHost = {
      storage: {
        get: async <T,>(key: string): Promise<T | undefined> => state.get(key) as T | undefined,
        put: async <T,>(key: string, value: T): Promise<void> => {
          state.set(key, value);
        },
        getAlarm: async (): Promise<number | null> => alarms.at(-1) ?? null,
        setAlarm: async (at: number): Promise<void> => {
          alarms.push(at);
        },
      },
      // 引擎失败的任务不该在这里炸出来：宿主的职责是吞掉并记录，测试里跟着吞
      waitUntil: (task: Promise<unknown>): void => {
        void task.catch(() => undefined);
      },
      botToken: BOT_TOKEN,
    };
    const engine = createGatewayEngine(host);
    await engine.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_ENSURE_PATH, { method: 'POST' }));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(alarms).toHaveLength(1);

    await engine.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_SHUTDOWN_PATH, { method: 'POST' }));
    expect(socketAt(0).closes).toEqual([{ code: 1000, reason: 'shutdown' }]);

    const before = alarms.length;
    await engine.alarm();
    await engine.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_ENSURE_PATH, { method: 'POST' }));
    expect(alarms).toHaveLength(before);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
