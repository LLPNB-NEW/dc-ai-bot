/**
 * Discord Interactions 的 Ed25519 验签（architecture §12）。
 * 被签名内容是 timestamp + 原始 body 字符串，必须逐字节还原，不能先 JSON 再 stringify。
 */
const SIGNATURE_HEADER = 'x-signature-ed25519';
const TIMESTAMP_HEADER = 'x-signature-timestamp';
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * @cloudflare/workers-types 尚未收录 Ed25519（index.d.ts 里搜不到 Ed25519），
 * 而 workerd 在 compatibility_date 2025-09-01 下已支持。这里用窄接口把它接进来，
 * 顺带把两条 workerd 约束固定在实现里：format 必须是字符串 'raw'，algorithm 用 { name: 'Ed25519' }。
 */
export interface Ed25519KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface Ed25519Crypto {
  generateKey(): Promise<Ed25519KeyPair>;
  exportRawPublicKey(key: CryptoKey): Promise<Uint8Array>;
  sign(privateKey: CryptoKey, message: Uint8Array): Promise<Uint8Array>;
  importRawPublicKey(raw: Uint8Array): Promise<CryptoKey>;
  verify(publicKey: CryptoKey, signature: Uint8Array, message: Uint8Array): Promise<boolean>;
}

interface Ed25519Algorithm {
  name: 'Ed25519';
}

interface SubtleEd25519 {
  generateKey(
    algorithm: Ed25519Algorithm,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<Ed25519KeyPair>;
  exportKey(format: 'raw', key: CryptoKey): Promise<ArrayBuffer>;
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: Ed25519Algorithm,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CryptoKey>;
  sign(algorithm: Ed25519Algorithm, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: Ed25519Algorithm,
    key: CryptoKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

const ALGORITHM: Ed25519Algorithm = { name: 'Ed25519' };
const SUBTLE = crypto.subtle as unknown as SubtleEd25519;

export const ed25519Crypto: Ed25519Crypto = {
  generateKey: () => SUBTLE.generateKey(ALGORITHM, true, ['sign', 'verify']),
  exportRawPublicKey: async (key) => new Uint8Array(await SUBTLE.exportKey('raw', key)),
  sign: async (privateKey, message) => new Uint8Array(await SUBTLE.sign(ALGORITHM, privateKey, message)),
  importRawPublicKey: (raw) => SUBTLE.importKey('raw', raw, ALGORITHM, false, ['verify']),
  verify: (publicKey, signature, message) => SUBTLE.verify(ALGORITHM, publicKey, signature, message),
};

export interface SignatureHeaders {
  signatureHex: string | null;
  timestamp: string | null;
}

export interface VerifyInput {
  publicKeyHex: string;
  signatureHex: string | null | undefined;
  timestamp: string | null | undefined;
  body: string;
}

/** 非法 hex（奇数长度或非 hex 字符）返回 null，由调用方当作验签失败 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function readSignatureHeaders(request: Request): SignatureHeaders {
  return {
    signatureHex: request.headers.get(SIGNATURE_HEADER),
    timestamp: request.headers.get(TIMESTAMP_HEADER),
  };
}

/** 任何缺失 / 非法 / 不匹配一律返回 false，绝不抛出，调用方统一回 401 */
export async function verifyEd25519Signature(input: VerifyInput): Promise<boolean> {
  const { signatureHex, timestamp } = input;
  if (!signatureHex || !timestamp) return false;
  const publicKeyBytes = hexToBytes(input.publicKeyHex);
  const signatureBytes = hexToBytes(signatureHex);
  if (!publicKeyBytes || publicKeyBytes.length !== ED25519_PUBLIC_KEY_BYTES) return false;
  if (!signatureBytes || signatureBytes.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    const key = await ed25519Crypto.importRawPublicKey(publicKeyBytes);
    const signed = new TextEncoder().encode(timestamp + input.body);
    return await ed25519Crypto.verify(key, signatureBytes, signed);
  } catch {
    return false;
  }
}
