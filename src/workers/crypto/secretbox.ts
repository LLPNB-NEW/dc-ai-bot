import type { SecretBox } from '../../core/ports';

const BLOB_VERSION = 'v1';
const IV_BYTES = 12;      // GCM 推荐 96 bit；固定长度才能把 iv 与密文一并塞进 blob
const MASTER_KEY_BYTES = 32;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** masterKeyB64 必须是 32 字节 base64；AES-256-GCM，IV 12 字节随机 */
export function createSecretBox(masterKeyB64: string): SecretBox {
  const rawKey = base64ToBytes(masterKeyB64);
  // 密钥长度错误必须在使用前炸掉，否则会写出一批永远解不开的密文
  if (rawKey.length !== MASTER_KEY_BYTES) {
    throw new Error(`KEY_ENCRYPTION_SECRET 必须是 ${MASTER_KEY_BYTES} 字节 base64，实际 ${rawKey.length} 字节`);
  }
  const key = crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    async encrypt(plaintext: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key, encoder.encode(plaintext));
      return `${BLOB_VERSION}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
    },

    async decrypt(blob: string): Promise<string> {
      const parts = blob.split('.');
      if (parts.length !== 3 || parts[0] !== BLOB_VERSION) throw new Error('BAD_SECRET_BLOB');
      const iv = base64ToBytes(parts[1] as string);
      const cipher = base64ToBytes(parts[2] as string);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key, cipher);
      return decoder.decode(plain);
    },
  };
}
