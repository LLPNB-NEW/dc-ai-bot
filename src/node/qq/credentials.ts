/// <reference types="node" />
/**
 * QQ 机器人凭证：先读环境变量 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET，
 * 两个都缺时退回本机 token 文件（缺省 "QQ bot.token"，已 gitignore）。
 *
 * 文件形状是两行 "Appid：123" / "AppSecret：xxx"，ASCII 冒号与全角冒号都认。
 * 这里绝不打印、绝不回传任何字段值：解析不出来就返回 null，由调用方决定怎么提示。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface QqCredentials {
  appId: string;
  appSecret: string;
}

/** 本机凭证文件的缺省名字（相对工作目录）；QQ*.token 在 .gitignore 里 */
export const QQ_DEFAULT_TOKEN_FILE = 'QQ bot.token';

const KEY_APP_ID = 'appid';
const KEY_APP_SECRET = 'appsecret';

/** 成对引号一起去掉（有人会从网页里连引号一起复制），其余字符原样保留 */
function cleanValue(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);
  if (trimmed.length >= 2 && (first === '"' || first === "'") && last === first) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 冒号位置：ASCII 与全角各找一个，取更靠前的那个；都没有返回 -1 */
function colonIndex(line: string): number {
  const ascii = line.indexOf(':');
  const wide = line.indexOf('：');
  if (ascii < 0) return wide;
  if (wide < 0) return ascii;
  return ascii < wide ? ascii : wide;
}

/**
 * 纯解析器（单测入口）：整段文件文本 → 凭证；缺任一字段返回 null。
 * 键名忽略大小写、空格、下划线、连字符（AppID / app_id / App Secret 都认）；
 * 空行、BOM、# 注释与不认识的键一律跳过；后出现的同名字段覆盖前面的。
 */
export function parseCredentialText(text: string): QqCredentials | null {
  let appId = '';
  let appSecret = '';

  for (const line of text.split(/\r\n|\n|\r/)) {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = colonIndex(trimmed);
    if (at < 0) continue;
    const key = trimmed.slice(0, at).replace(/[\s_-]/g, '').toLowerCase();
    const value = cleanValue(trimmed.slice(at + 1));
    if (key === KEY_APP_ID) appId = value;
    else if (key === KEY_APP_SECRET) appSecret = value;
  }

  if (appId === '' || appSecret === '') return null;
  return { appId, appSecret };
}

export interface ResolveQqCredentialsOptions {
  /** 缺省 process.env；测试传固定字典 */
  env?: Record<string, string | undefined>;
  /** 相对路径的基准目录，缺省 process.cwd() */
  cwd?: string;
  /** 读文件的口子（测试注入）；缺省 node:fs/promises 的 readFile，UTF-8 */
  readFile?: (path: string) => Promise<string>;
}

function readEnvValue(env: Record<string, string | undefined>, name: string): string {
  const raw = env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 解析凭证；拿不到完整一对就返回 null（= QQ 不接线，进程照常跑）。
 * 只配了半个环境变量时不混用文件：半个 env + 文件的另一半会拼出一对互相不匹配的凭证。
 */
export async function resolveQqCredentials(
  options: ResolveQqCredentialsOptions = {},
): Promise<QqCredentials | null> {
  const env = options.env ?? process.env;
  const envAppId = readEnvValue(env, 'QQ_BOT_APP_ID');
  const envAppSecret = readEnvValue(env, 'QQ_BOT_APP_SECRET');
  if (envAppId !== '' && envAppSecret !== '') return { appId: envAppId, appSecret: envAppSecret };
  if (envAppId !== '' || envAppSecret !== '') return null;

  const file = readEnvValue(env, 'QQ_BOT_TOKEN_FILE') || QQ_DEFAULT_TOKEN_FILE;
  const path = isAbsolute(file) ? file : join(options.cwd ?? process.cwd(), file);
  const reader = options.readFile ?? ((target: string): Promise<string> => readFile(target, 'utf8'));

  let text: string;
  try {
    text = await reader(path);
  } catch {
    // 文件不存在/读不动都只是「没配 QQ」：路径不是秘密，但这里也不打印，交给调用方提示
    return null;
  }
  return parseCredentialText(text);
}
