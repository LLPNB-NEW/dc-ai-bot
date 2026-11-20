/**
 * §22 网关侧的图片处理：Discord 附件 → ImageRef →（真要发请求时）base64 的 LlmImage。
 *
 * 这里只做纯数据加工加一次注入式下载。两条自我约束：
 *   1. 不 import ./message —— 收窄成窄接口 ImageSource 就够用，免得和 message.ts 成环；
 *   2. 不在模块顶层捕获 fetch —— workerd 会 brand-check 裸 fetch 引用，测试还要能替换全局。
 */
import type { LlmImage } from '../../core/types';

/** 一轮请求最多带几张图（§22.1） */
export const MAX_IMAGES = 4;

/** 单张上限 5MB：超出的直接跳过，绝不影响文字（§22.1） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 一个待下载的图片附件：Discord 的 url / content_type / size 三元组 */
export interface ImageRef {
  url: string;
  /** image/png；Discord 没给 content_type 时是按扩展名猜出来的（§22.4） */
  mediaType: string;
  /** 原始字节数，用来卡 5MB 上限 */
  size: number;
}

/**
 * collectImageRefs 的入参：结构类型，只要形状对就是 IncomingMessage。
 * 私聊/老消息里 replyTo 可能整个缺失，所以它可空、attachments 也可缺。
 */
export interface ImageSource {
  attachments: readonly ImageRef[];
  replyTo?: { attachments?: readonly ImageRef[] } | null;
}

/** 按扩展名兜底猜 MIME：只在 Discord 没给 content_type 时才用得上（§22.4） */
const EXTENSION_MEDIA_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
];

/** 一次 btoa 的字节数：分段拼，避免大图把整个数组铺成参数爆调用栈（§22.4） */
const BASE64_CHUNK_BYTES = 8 * 1024;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/** Discord 的附件 URL 带签名查询串，扩展名判定前先切掉 */
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

/**
 * content_type 优先；它缺席（缺字段或空串）时才按扩展名猜（§22.4）。
 * 给了非 image/* 的一律返回 null，即使扩展名像图片 —— §22.8「视频、文件、语音一律忽略」。
 */
function resolveMediaType(contentType: string | null, url: string): string | null {
  if (contentType !== null && contentType !== '') {
    return contentType.startsWith('image/') ? contentType : null;
  }
  return guessMediaType(url);
}

/** size 必须是正数且不超过上限；缺 size 的附件无法判定大小，只能丢 */
function usableSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value > 0 && value <= MAX_IMAGE_BYTES ? value : null;
}

/**
 * 把 Discord 的 attachments 数组窄化成 ImageRef[]（§22.4 的规则，message.ts 也用它）。
 * 字段缺失或被写坏都只是少一张图，绝不抛错；非数组一律当空数组。
 */
export function narrowAttachments(raw: unknown): ImageRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: ImageRef[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const url = readString(record, 'url');
    if (url === null || url === '') continue;
    const mediaType = resolveMediaType(readString(record, 'content_type'), url);
    if (mediaType === null) continue;
    const size = usableSize(record.size);
    if (size === null) continue;
    refs.push({ url, mediaType, size });
  }
  return refs;
}

/**
 * 本轮能看的图（§22.1/§22.4）：本条消息的附件在前，被回复消息的附件在后，最多 MAX_IMAGES 张。
 * 顺序是契约的一部分：模型按数组顺序看图，回复链里的那张比自己的更应该排在后面。
 */
export function collectImageRefs(source: ImageSource): ImageRef[] {
  const candidates: readonly ImageRef[] = [...source.attachments, ...(source.replyTo?.attachments ?? [])];
  const refs: ImageRef[] = [];
  for (const candidate of candidates) {
    if (refs.length >= MAX_IMAGES) break;
    if (candidate.url === '') continue;
    // 空串 mediaType = 上游没填，按扩展名兜底；填了就按填的判定
    const mediaType = resolveMediaType(candidate.mediaType === '' ? null : candidate.mediaType, candidate.url);
    if (mediaType === null) continue;
    if (!(candidate.size > 0 && candidate.size <= MAX_IMAGE_BYTES)) continue;
    refs.push({ url: candidate.url, mediaType, size: candidate.size });
  }
  return refs;
}

/**
 * ArrayBuffer → base64（不带 data: 前缀、不含换行）。
 * 分块是为了不把 5MB 一口气铺进 fromCharCode 的参数里（§22.4）。
 */
export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const chunks: string[] = [];
  for (let offset = 0; offset < view.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = Array.from(view.subarray(offset, offset + BASE64_CHUNK_BYTES));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}

/**
 * 逐个下载成 LlmImage（§22.4）：非 2xx、空体、抛错都只是「少一张图」，warn 一声继续。
 * fetchImpl 由调用方传：生产侧在调用时才读 globalThis.fetch，测试塞桩即可拦截出网。
 */
export async function loadImages(refs: readonly ImageRef[], fetchImpl: typeof fetch): Promise<LlmImage[]> {
  const images: LlmImage[] = [];
  for (const ref of refs) {
    try {
      const response = await fetchImpl(ref.url);
      if (!response.ok) {
        console.warn('[gateway] 图片下载失败：' + ref.url);
        continue;
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0) {
        console.warn('[gateway] 图片下载失败：' + ref.url);
        continue;
      }
      images.push({ mediaType: ref.mediaType, base64: toBase64(bytes) });
    } catch {
      // 超时/中断/URL 过期一律同待遇：图片缺席永远不该拖累文字回复
      console.warn('[gateway] 图片下载失败：' + ref.url);
    }
  }
  return images;
}
