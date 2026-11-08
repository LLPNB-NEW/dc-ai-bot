/**
 * Durable Object 适配器。真正的状态机在 ./engine.ts（平台无关），这里只做接线：
 *   ctx.storage → 引擎的 storage（get/put/getAlarm/setAlarm 四个成员，一个都不多要 ——
 *                  测试里的假 state 就只给了这四个，多要一个它们全红）
 *   ctx.waitUntil → 引擎的 waitUntil（**惰性**访问：那批假 state 里没有这个成员，
 *                   构造时摸一下就会 TypeError，所以包成箭头函数等到真的要用时才碰）
 *   env 的三个绑定 → 引擎的凭证
 *
 * 常量为什么出现在这个文件里：index.ts 从 './gateway/durable-object' 取 GATEWAY_DO_NAME 等四个常量，
 * 而 index.ts 一行都不许改，所以把引擎里的定义在这里 re-export 一次（唯一实现在 ./engine.ts）。
 */
import {
  createGatewayEngine,
  GATEWAY_BUILD,
  GATEWAY_ENSURE_PATH,
  GATEWAY_INTERNAL_ORIGIN,
  GATEWAY_STATE_KEY,
  GATEWAY_STATUS_PATH,
  type GatewayEngine,
  type GatewayEngineHost,
} from './engine';

export { GATEWAY_BUILD, GATEWAY_ENSURE_PATH, GATEWAY_INTERNAL_ORIGIN, GATEWAY_STATE_KEY, GATEWAY_STATUS_PATH };

/** DO 实例名：index.ts 用 idFromName(GATEWAY_DO_NAME) 取唯一实例，全局只能有一个网关连接 */
export const GATEWAY_DO_NAME = 'gateway-presence';

/** DO 的绑定来自环境变量（wrangler.toml 的 vars / secret），全部可选：缺 token 就安静地保持离线 */
export interface GatewayEnv {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_APPLICATION_ID?: string;
  KEY_ENCRYPTION_SECRET?: string;
  /** D1 绑定：缺了只等于「不能存 Key、不能回帖、日志不可用」，连接本身照跑 */
  DB?: D1Database;
}

/**
 * 一个 DO 实例 = 一条 Discord 网关连接。命名空间是单例（idFromName 固定名），
 * 所以整个 Worker 里同一时刻只有一个 IDENTIFY。
 */
export class GatewayPresence implements DurableObject {
  readonly #engine: GatewayEngine;

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    // 凭证是引擎的扩展字段（GatewayHost 只描述宿主能力），所以先装配成具名常量再递进去
    const host: GatewayEngineHost = {
      db: env.DB,
      storage: ctx.storage,
      // 惰性：假 state 没有 waitUntil，只有真的产生后台任务时才会被碰到
      waitUntil: (task: Promise<unknown>): void => ctx.waitUntil(task),
      botToken: env.DISCORD_BOT_TOKEN,
      applicationId: env.DISCORD_APPLICATION_ID,
      keyEncryptionSecret: env.KEY_ENCRYPTION_SECRET,
    };
    this.#engine = createGatewayEngine(host);
  }

  /** 内部路由：/ensure（定时保活）、/status（快照）、其余 404 */
  fetch(request: Request): Promise<Response> {
    return this.#engine.fetch(request);
  }

  /** 唯一的定时入口：握手看门狗 / 心跳 / 重连退避共用它 */
  alarm(): Promise<void> {
    return this.#engine.alarm();
  }
}
