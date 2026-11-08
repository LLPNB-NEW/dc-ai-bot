import { beforeAll, describe, expect, it } from 'vitest';
import {
  ed25519Crypto,
  hexToBytes,
  readSignatureHeaders,
  verifyEd25519Signature,
} from '../src/workers/discord/verify';

const TIMESTAMP = '1735689600';
const BODY = JSON.stringify({ type: 1, id: 'interaction-1', application_id: 'app-1', token: 'tok' });

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

let publicKeyHex = '';
let privateKey: CryptoKey;
let otherPublicKeyHex = '';

async function sign(timestamp: string, body: string): Promise<string> {
  return toHex(await ed25519Crypto.sign(privateKey, encode(timestamp + body)));
}

beforeAll(async () => {
  const pair = await ed25519Crypto.generateKey();
  privateKey = pair.privateKey;
  publicKeyHex = toHex(await ed25519Crypto.exportRawPublicKey(pair.publicKey));
  const other = await ed25519Crypto.generateKey();
  otherPublicKeyHex = toHex(await ed25519Crypto.exportRawPublicKey(other.publicKey));
});

describe('Ed25519 验签', () => {
  it('workerd 可导出 32 字节 raw 公钥、64 字节签名', async () => {
    expect(publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(await sign(TIMESTAMP, BODY)).toMatch(/^[0-9a-f]{128}$/);
  });

  it('签名正确 → true', async () => {
    const signatureHex = await sign(TIMESTAMP, BODY);
    await expect(
      verifyEd25519Signature({ publicKeyHex, signatureHex, timestamp: TIMESTAMP, body: BODY }),
    ).resolves.toBe(true);
  });

  it('篡改 body → false', async () => {
    const signatureHex = await sign(TIMESTAMP, BODY);
    const tampered = BODY.replace('interaction-1', 'interaction-2');
    await expect(
      verifyEd25519Signature({ publicKeyHex, signatureHex, timestamp: TIMESTAMP, body: tampered }),
    ).resolves.toBe(false);
  });

  it('改时间戳 → false', async () => {
    const signatureHex = await sign(TIMESTAMP, BODY);
    await expect(
      verifyEd25519Signature({ publicKeyHex, signatureHex, timestamp: '1735689601', body: BODY }),
    ).resolves.toBe(false);
  });

  it('换另一把公钥 → false', async () => {
    const signatureHex = await sign(TIMESTAMP, BODY);
    await expect(
      verifyEd25519Signature({
        publicKeyHex: otherPublicKeyHex,
        signatureHex,
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(false);
  });

  it('缺签名头 / 缺时间戳头 → false', async () => {
    const signatureHex = await sign(TIMESTAMP, BODY);
    await expect(
      verifyEd25519Signature({ publicKeyHex, signatureHex: null, timestamp: TIMESTAMP, body: BODY }),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519Signature({ publicKeyHex, signatureHex, timestamp: null, body: BODY }),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519Signature({ publicKeyHex, signatureHex: '', timestamp: '', body: BODY }),
    ).resolves.toBe(false);
  });

  it('非法 hex / 长度不对的公钥或签名 → false 而不是抛错', async () => {
    const signatureHex = await sign(TIMESTAMP, BODY);
    await expect(
      verifyEd25519Signature({ publicKeyHex, signatureHex: 'zz', timestamp: TIMESTAMP, body: BODY }),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519Signature({
        publicKeyHex: 'abc',
        signatureHex,
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519Signature({
        publicKeyHex,
        // 63 字节（长度不足 64）
        signatureHex: signatureHex.slice(0, 126),
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519Signature({
        publicKeyHex,
        signatureHex,
        timestamp: TIMESTAMP,
        body: BODY,
      }),
    ).resolves.toBe(true);
  });
});

describe('hex 与请求头工具', () => {
  it('hexToBytes 往返', () => {
    const bytes = hexToBytes('00ff10');
    expect(bytes && Array.from(bytes)).toEqual([0, 255, 16]);
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
    expect(hexToBytes('abc')).toBeNull();
    expect(hexToBytes('zz')).toBeNull();
  });

  it('readSignatureHeaders 缺头返回 null', () => {
    const withHeaders = new Request('https://bot.test/discord/interactions', {
      method: 'POST',
      headers: { 'X-Signature-Ed25519': 'aabb', 'X-Signature-Timestamp': '123' },
    });
    expect(readSignatureHeaders(withHeaders)).toEqual({ signatureHex: 'aabb', timestamp: '123' });

    const withoutHeaders = new Request('https://bot.test/discord/interactions', { method: 'POST' });
    expect(readSignatureHeaders(withoutHeaders)).toEqual({ signatureHex: null, timestamp: null });
  });
});
