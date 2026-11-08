/**
 * Node 运行的配置来源是进程环境，而 Workers 由 wrangler secret 注入，两者形状不同；
 * 这一层把"启动期就该失败"的校验集中起来：缺 secret 直接抛错，别让进程带着半份配置跑起来、
 * 再让每个请求各自回 500。
 */

export interface NodeEnv {
  dbPath: string;
  port: number;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  KEY_ENCRYPTION_SECRET: string;
}

/** 与 src/workers/index.ts 的名单逐项一致：只有用到的分支才要求对应 secret */
export const API_SECRETS: readonly string[] = ['KEY_ENCRYPTION_SECRET', 'ADMIN_PASSWORD', 'SESSION_SECRET'];
export const DISCORD_SECRETS: readonly string[] = [
  'KEY_ENCRYPTION_SECRET',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_APPLICATION_ID',
];

/** 六项 secret 在 Node 侧没有"用到才校验"的余地：进程启动即全部就位，否则一律不启动 */
const SECRET_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_APPLICATION_ID',
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
  'KEY_ENCRYPTION_SECRET',
] as const satisfies readonly (keyof NodeEnv)[];

type SecretKey = (typeof SECRET_KEYS)[number];

const DEFAULT_PORT = 8787;
const DEFAULT_DB_PATH = '/data/dc-ai-bot.sqlite3';
const MIN_PORT = 1;
const MAX_PORT = 65535;

function isSecretKey(name: string): name is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(name);
}

/** 空串与全空白都算没配：.env 里 `PORT=` 这种写法等于没写 */
function readOptional(source: Record<string, string | undefined>, name: string): string | null {
  const value = source[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requireSecret(source: Record<string, string | undefined>, name: SecretKey): string {
  const value = readOptional(source, name);
  if (value === null) throw new Error(`缺环境变量：${name}`);
  return value;
}

/** 报错必须带上原值：不然只看 "PORT 非法" 根本不知道 .env 里被写成了什么 */
function readPort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`PORT 不是合法端口（1-${MAX_PORT}）：${raw}`);
  }
  return port;
}

export function readNodeEnv(source: Record<string, string | undefined>): NodeEnv {
  const port = readPort(readOptional(source, 'PORT') ?? String(DEFAULT_PORT));
  const dbPath = readOptional(source, 'DB_PATH') ?? DEFAULT_DB_PATH;
  return {
    dbPath,
    port,
    DISCORD_BOT_TOKEN: requireSecret(source, 'DISCORD_BOT_TOKEN'),
    DISCORD_PUBLIC_KEY: requireSecret(source, 'DISCORD_PUBLIC_KEY'),
    DISCORD_APPLICATION_ID: requireSecret(source, 'DISCORD_APPLICATION_ID'),
    ADMIN_PASSWORD: requireSecret(source, 'ADMIN_PASSWORD'),
    SESSION_SECRET: requireSecret(source, 'SESSION_SECRET'),
    KEY_ENCRYPTION_SECRET: requireSecret(source, 'KEY_ENCRYPTION_SECRET'),
  };
}

/**
 * readNodeEnv 已经保证六项都在，这个函数留给"从别处装配出来的 NodeEnv"：
 * 名单可以只含某个分支要用的名字，返回第一个空值（与 Workers 侧同名函数同判据）。
 */
export function firstMissingSecret(env: NodeEnv, names: readonly string[]): string | null {
  for (const name of names) {
    if (!isSecretKey(name)) return name;
    if (env[name].trim() === '') return name;
  }
  return null;
}
