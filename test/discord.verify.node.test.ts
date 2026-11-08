import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { verifyEd25519Signature } from '../src/workers/discord/verify';

/**
 * 这里刻意不用 crypto.subtle：要证明的正是"真实 Node 的 node:crypto 产出的密钥/签名
 * 能被生产环境的验签函数接受"，而生产验签内部走的才是 webcrypto。
 */

const ED25519_RAW_PUBLIC_KEY_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Signer {
  publicKeyHex: string;
  sign(timestamp: string, body: string): string;
}

function createSigner(): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // SPKI DER 的尾部就是 32 字节 raw 公钥，前面是固定的 Ed25519 算法标识
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = new Uint8Array(der).subarray(der.length - ED25519_RAW_PUBLIC_KEY_BYTES);
  const signMessage = (message: Uint8Array, key: KeyObject): string =>
    toHex(new Uint8Array(sign(null, message, key)));

  return {
    publicKeyHex: toHex(raw),
    sign(timestamp: string, body: string): string {
      // 与 verify.ts 的拼接口径一致：UTF-8(timestamp + body)
      return signMessage(new TextEncoder().encode(timestamp + body), privateKey);
    },
  };
}

const TIMESTAMP = '1700000000';
const BODY = JSON.stringify({ type: 1 });

describe('verifyDiscordRequest 在 Node 密钥下可用', () => {
  it('真实 Node 生成的密钥与签名应通过', async () => {
    const signer = createSigner();
    await expect(
      verifyEd25519Signature({
        publicKeyHex: signer.publicKeyHex,
        signatureHex: signer.sign(TIMESTAMP, BODY),
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(true);
  });

  it('请求体改一个字节即失败', async () => {
    const signer = createSigner();
    const signatureHex = signer.sign(TIMESTAMP, BODY);
    await expect(
      verifyEd25519Signature({
        publicKeyHex: signer.publicKeyHex,
        signatureHex,
        timestamp: TIMESTAMP,
        body: `${BODY} `,
      }),
    ).resolves.toBe(false);
  });

  it('签名改一个字节即失败', async () => {
    const signer = createSigner();
    const signatureHex = signer.sign(TIMESTAMP, BODY);
    const flipped = `${signatureHex.slice(0, -2)}${signatureHex.slice(-2) === '00' ? '01' : '00'}`;
    await expect(
      verifyEd25519Signature({
        publicKeyHex: signer.publicKeyHex,
        signatureHex: flipped,
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(false);
  });

  it('过期时间戳的旧签名冒充新请求即失败（时间窗由上层按 header 判定）', async () => {
    const signer = createSigner();
    const staleSignature = signer.sign('1600000000', BODY);
    await expect(
      verifyEd25519Signature({
        publicKeyHex: signer.publicKeyHex,
        signatureHex: staleSignature,
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(false);
  });

  it('换一对密钥即失败', async () => {
    const signer = createSigner();
    const other = createSigner();
    await expect(
      verifyEd25519Signature({
        publicKeyHex: other.publicKeyHex,
        signatureHex: signer.sign(TIMESTAMP, BODY),
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(false);
  });

  it('公钥长度不是 32 字节即失败', async () => {
    const signer = createSigner();
    await expect(
      verifyEd25519Signature({
        publicKeyHex: signer.publicKeyHex.slice(2),
        signatureHex: signer.sign(TIMESTAMP, BODY),
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(false);
  });
});
