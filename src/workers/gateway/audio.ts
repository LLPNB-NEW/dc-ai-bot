/**
 * 网关侧的音频附件处理：Discord 语音/音频 → AudioRef → 变声工具用的 LlmAudio。
 * 与图片分开一条窄化链路：图片会进模型上下文，音频只在 change_voice 真被调用时下载，
 * 所以这里不把音频塞进每一轮请求。
 */
import type { LlmAudio } from '../../core/types';

/** 单条源音频上限：变声接口与 Discord 预览都够用；超出的直接跳过，绝不影响文字 */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** 一个待下载的音频附件 */
export interface AudioRef {
  url: string;
  mediaType: string;
  size: number;
  filename: string;
}

export interface AudioSource {
  attachments?: readonly AudioRef[];
  replyTo?: { attachments?: readonly AudioRef[] } | null;
}

const EXTENSION_MEDIA_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'audio/mp4'],
  ['.webm', 'audio/webm'],
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function urlPath(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

function guessMediaType(url: string): string | null {
  const path = urlPath(url).toLowerCase();
  for (const [extension, mediaType] of EXTENSION_MEDIA_TYPES) {
    if (path.endsWith(extension)) return mediaType;
  }
  return null;
}

/** content_type 优先；缺席才按扩展名猜；非 audio/* 一律丢掉，视频/文件不进这条链路 */
function resolveMediaType(contentType: string | null, url: string): string | null {
  if (contentType !== null && contentType !== '') {
    return contentType.startsWith('audio/') ? contentType.split(';')[0].trim().toLowerCase() : null;
  }
  return guessMediaType(url);
}

function usableSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_AUDIO_BYTES
    ? value
    : null;
}

function filenameOf(record: Record<string, unknown>, url: string, mediaType: string): string {
  const given = (readString(record, 'filename') ?? '').trim();
  if (given !== '') return given;
  const base = urlPath(url).split('/').pop() ?? '';
  if (base !== '') return base;
  return 'source.' + (mediaType === 'audio/wav' ? 'wav' : mediaType === 'audio/ogg' ? 'ogg' : mediaType === 'audio/mp4' ? 'm4a' : 'mp3');
}

/**
 * 把 Discord 的 attachments 数组窄化成 AudioRef[]。
 * 与图片的 narrowAttachments 同一套降级规则：字段缺失或被写坏都只是少一个附件，绝不抛错。
 */
export function narrowAudioAttachments(raw: unknown): AudioRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: AudioRef[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const url = readString(record, 'url');
    if (url === null || url === '') continue;
    const mediaType = resolveMediaType(readString(record, 'content_type'), url);
    if (mediaType === null) continue;
    const size = usableSize(record.size);
    if (size === null) continue;
    refs.push({ url, mediaType, size, filename: filenameOf(record, url, mediaType) });
  }
  return refs;
}

/** 当前消息的音频在前，被回复消息的音频在后；变声只取第一条，多余的明确丢弃 */
export function collectAudioRefs(source: AudioSource): AudioRef[] {
  const candidates: readonly AudioRef[] = [...(source.attachments ?? []), ...(source.replyTo?.attachments ?? [])];
  const refs: AudioRef[] = [];
  for (const candidate of candidates) {
    if (refs.length >= 1) break;
    if (candidate.url === '') continue;
    if (!(candidate.size > 0 && candidate.size <= MAX_AUDIO_BYTES)) continue;
    refs.push(candidate);
  }
  return refs;
}

/**
 * 下载源音频。非 2xx、空体、超限、抛错都只 warn 一声并跳过：
 * 变声是附加能力，源音频拿不到不该把这一轮回复弄失败。
 */
export async function loadAudio(refs: readonly AudioRef[], fetchImpl: typeof fetch): Promise<LlmAudio[]> {
  const audio: LlmAudio[] = [];
  for (const ref of refs) {
    try {
      const response = await fetchImpl(ref.url);
      if (!response.ok) {
        console.warn('[gateway] 音频下载失败：' + ref.url);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
        console.warn('[gateway] 音频下载失败：' + ref.url);
        continue;
      }
      audio.push({ data: bytes, mediaType: ref.mediaType, filename: ref.filename });
    } catch {
      console.warn('[gateway] 音频下载失败：' + ref.url);
    }
  }
  return audio;
}
