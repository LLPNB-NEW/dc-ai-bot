const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cookie 名与有效期，与 §11 的 Set-Cookie 逐字对齐 */
export const SESSION_COOKIE = 'admin_session';
export const SESSION_MAX_AGE_SECONDS = 28800;

/** 时间源可注入：登录限速窗口与 Cookie 过期判定都要在测试里冻住 */
export type Clock = () => number;

export interface SessionAuthOptions {
  adminPassword: string;
  sessionSecret: string;
  now?: Clock;
}

export interface SessionAuth {
  /** 常数时间比较口令 */
  verifyPassword(input: string): Promise<boolean>;
  /** 签发 Cookie 值（<payload>.<signature>，不含 Cookie 属性） */
  issue(): Promise<string>;
  /** 校验 Cookie 值：格式错、签名不符、过期一律 false */
  verify(token: string | undefined): Promise<boolean>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function base64UrlToText(value: string): string | null {
  const bytes = base64UrlToBytes(value);
  return bytes === null ? null : decoder.decode(bytes);
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(encoder.encode(text));
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return new Uint8Array(digest);
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(signature);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // 长度先比会暴露长度，但长度不是秘密；内容比较逐字节异或累加，耗时与差异位置无关
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function createSessionAuth(options: SessionAuthOptions): SessionAuth {
  const now: Clock = options.now ?? (() => Date.now());

  async function verifyPassword(input: string): Promise<boolean> {
    // 空口令等于关门不设防，直接判失败而不是让空串通过
    if (options.adminPassword === '') return false;
    const [given, expected] = await Promise.all([sha256(input), sha256(options.adminPassword)]);
    return timingSafeEqual(given, expected);
  }

  async function issue(): Promise<string> {
    const exp = Math.floor(now() / 1000) + SESSION_MAX_AGE_SECONDS;
    const payload = textToBase64Url(JSON.stringify({ exp }));
    const signature = bytesToBase64Url(await hmacSha256(options.sessionSecret, payload));
    return payload + '.' + signature;
  }

  async function verify(token: string | undefined): Promise<boolean> {
    if (typeof token !== 'string' || token === '') return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const payload = parts[0] ?? '';
    const signature = parts[1] ?? '';
    if (payload === '' || signature === '') return false;

    const provided = base64UrlToBytes(signature);
    if (provided === null) return false;
    // 先验签再读 exp：伪造者无法靠改 exp 绕过
    if (!timingSafeEqual(provided, await hmacSha256(options.sessionSecret, payload))) return false;

    const decoded = base64UrlToText(payload);
    if (decoded === null) return false;
    try {
      const parsed: unknown = JSON.parse(decoded);
      if (typeof parsed !== 'object' || parsed === null) return false;
      const exp = (parsed as { exp?: unknown }).exp;
      if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
      return exp > Math.floor(now() / 1000);
    } catch {
      return false;
    }
  }

  return { verifyPassword, issue, verify };
}
