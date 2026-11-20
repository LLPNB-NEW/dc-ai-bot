/**
 * Discord 网关的 Node 宿主（自托管用）：进程常驻，所以不需要 DO 的「按 alarm 唤醒」，
 * 但**同样只允许一个定时器** —— 心跳 0.9×interval、15s 握手看门狗、重连退避是三条节奏，
 * 它们全都落进引擎的 storage.setAlarm，这里再把那条 alarm 折成 #timer 这一个 setTimeout。
 *
 * 为什么状态只放内存 Map（不落盘）：进程重启就是一次全新的 IDENTIFY，resume 在这条路径上换不到任何收益，
 * 反而要维护一份与 Discord 会话生命周期不一致的持久化状态。
 *
 * 为什么不 import node: 模块：这个仓库的 tsconfig 只挂了 workers 的类型，node: 名字在这里没有类型；
 * Node 22 本来就有 WebSocket / fetch / crypto 三个全局，宿主不需要任何 node: 能力。
 */
import {
  GATEWAY_BUILD,
  GATEWAY_ENSURE_PATH,
  GATEWAY_INTERNAL_ORIGIN,
  GATEWAY_SHUTDOWN_PATH,
  createGatewayEngine,
  type GatewayEngine,
  type GatewayEngineHost,
} from '../workers/gateway/engine';
import type { SqlDatabase } from '../core/db/sql';
import { createTaskTracker, type TaskTracker } from './wait-until';

export interface NodeGatewayOptions {
  db: SqlDatabase;
  botToken: string;
  applicationId?: string;
  /**
   * D1 时代的 KEY_ENCRYPTION_SECRET：只影响「能不能存 Key / 能不能回帖」，
   * 缺了网关照样在线（与 DO 那边缺绑定时的降级一致）。
   */
  keyEncryptionSecret?: string;
}

export interface NodeGateway {
  start(): void;
  stop(): Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/**
 * 单定时器宿主。实现成私有类而不是闭包，是因为「唯一那个 timer」必须是实例字段 ——
 * 闭包变量在测试里没法被观察，也容易被误写成两个。
 */
class NodeGatewayHost implements NodeGateway {
  readonly #engine: GatewayEngine;
  /** waitUntil 的账本：进集合、settle 后出集合，stop() 靠它把在飞的后台任务等干净 */
  readonly #tasks: TaskTracker;
  /** 唯一的定时器：任何一次排期都先清掉它，保证同一时刻至多一个 */
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** 下一次该醒的时刻（对应 DO 的 storage.getAlarm / setAlarm），null = 没排期 */
  #alarmAt: number | null = null;
  /** 引擎要的 KV：只在内存里，进程重启即清零 */
  readonly #state = new Map<string, unknown>();
  #started = false;
  #stopping = false;
  #stopPromise: Promise<void> | null = null;

  constructor(options: NodeGatewayOptions) {
    // 后台任务只有一个报错出口，且只 warn：未处理的 rejection 会直接把进程打死
    this.#tasks = createTaskTracker((error: unknown) => {
      console.warn('[gateway] 后台任务失败：' + describeError(error));
    });
    // 先把宿主装配成具名常量再递进去：凭证是引擎的扩展字段，字面量直接传会被多余属性检查拦下
    const host: GatewayEngineHost = {
      db: options.db,
      storage: {
        get: <T>(key: string): Promise<T | undefined> => Promise.resolve(this.#state.get(key) as T | undefined),
        put: <T>(key: string, value: T): Promise<void> => {
          this.#state.set(key, value);
          return Promise.resolve();
        },
        getAlarm: (): Promise<number | null> => Promise.resolve(this.#alarmAt),
        setAlarm: (at: number): Promise<void> => {
          this.#alarmAt = at;
          this.#schedule(at);
          return Promise.resolve();
        },
      },
      waitUntil: (task: Promise<unknown>): void => {
        this.#tasks.waitUntil(task);
      },
      botToken: options.botToken,
      applicationId: options.applicationId,
      keyEncryptionSecret: options.keyEncryptionSecret,
    };
    this.#engine = createGatewayEngine(host);
  }

  start(): void {
    // 停机之后 start 也不许复活：否则「stop 之后再无新定时器」这条承诺就守不住
    if (this.#started || this.#stopping) return;
    this.#started = true;
    console.log('[gateway] node host started build=' + GATEWAY_BUILD);
    void this.#ensure();
  }

  stop(): Promise<void> {
    if (this.#stopPromise === null) this.#stopPromise = this.#doStop();
    return this.#stopPromise;
  }

  async #doStop(): Promise<void> {
    // 先立停机标记再清 timer：中间任何一次排期都会被 #schedule 的早退挡掉
    this.#stopping = true;
    this.#clearTimer();
    // 契约面只有 fetch/alarm，所以「关 socket」走引擎的第三条内部路径
    try {
      await this.#engine.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_SHUTDOWN_PATH, { method: 'POST' }));
    } catch (error) {
      console.warn('[gateway] 停机时关闭连接失败：' + describeError(error));
    }
    await this.#tasks.drain();
    console.log('[gateway] node host stopped build=' + GATEWAY_BUILD);
  }

  /** 内部 /ensure：引擎看连接不在就会立刻连一次，并把握手看门狗排到 alarm 上 */
  async #ensure(): Promise<void> {
    try {
      await this.#engine.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_ENSURE_PATH, { method: 'POST' }));
    } catch (error) {
      // 连不上只是「这一拍没连成」：引擎那边已经排了退避 alarm，这里绝不能把进程带崩
      console.warn('[gateway] 启动连接失败：' + describeError(error));
    }
  }

  /**
   * 一次排期 = 先清旧 timer 再建新 timer。清旧的那一步是这套设计的关键：
   * 心跳、看门狗、退避三条节奏都调 setAlarm，谁最后排谁生效，绝不允许两个 timer 并存。
   */
  #schedule(at: number): void {
    if (this.#stopping) return;
    this.#clearTimer();
    const delayMs = Math.max(0, at - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // 与 DO 一致：alarm 一旦触发，getAlarm 就回到 null
      this.#alarmAt = null;
      void this.#tick();
    }, delayMs);
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #tick(): Promise<void> {
    try {
      await this.#engine.alarm();
    } catch (error) {
      console.warn('[gateway] alarm 处理失败：' + describeError(error));
    }
  }
}

/** 建一个 Node 宿主：start() 连、stop() 停，中间的定时全部收敛成那一个 setTimeout */
export function createNodeGateway(options: NodeGatewayOptions): NodeGateway {
  const host = new NodeGatewayHost(options);
  return {
    start: (): void => host.start(),
    stop: (): Promise<void> => host.stop(),
  };
}
