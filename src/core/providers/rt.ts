import type { LlmResult, ProviderId, ProviderRuntime } from '../types';
import { resolveTimeout } from '../timeouts';

/** §19.7：一次调用最多两次尝试——只加一层重试，不做指数退避队列 */
export const MAX_ATTEMPTS = 2;
/** 两次尝试之间的固定等待 */
export const RETRY_DELAY_MS = 800;
/** 只有这些状态码值得重试：429 限流与上游 5xx；其余 4xx 是确定性错误，重试也不会变 */
export const RETRYABLE_STATUS: readonly number[] = [429, 500, 502, 503, 504];

/** workerd 的 AbortSignal 静态能力随版本起伏，故按可选能力探测。 */
type AbortSignalStatics = {
  timeout?: (milliseconds: number) => AbortSignal;
  any?: (signals: AbortSignal[]) => AbortSignal;
};

interface SignalHandle {
  signal: AbortSignal;
  release(): void;
}

const noop = (): void => undefined;

/**
 * 默认 180s（3 分钟，后台「超时」可改）与调用方 signal 合并。release 在响应头到达后立即解绑：
 * 超时只约束建连与首字节——全量历史下深度思考模型常要 25s 以上才吐第一个字节，30s 会误杀；
 * 响应头一到就解绑，长 SSE 流不会被中途砍断。
 */
export function createRequestSignal(rt: ProviderRuntime): SignalHandle {
  const statics = AbortSignal as unknown as AbortSignalStatics;
  const timeoutMs = resolveTimeout('llm');
  const timeout = statics.timeout?.(timeoutMs);
  const external = rt.signal;
  if (timeout && !external) return { signal: timeout, release: noop };
  if (timeout && external && statics.any) return { signal: statics.any([timeout, external]), release: noop };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout after ' + String(timeoutMs) + 'ms')), timeoutMs);
  const forward = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) forward();
    else external.addEventListener('abort', forward);
  }
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', forward);
    },
  };
}

/**
 * §7 错误归一：`<provider> HTTP <status>: <body 前 300 字符>`。
 * message 与旧版逐字一致，多带的 status 只给 §19.7 的重试判定用，既有断言不受影响。
 */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 我们自己 180s（3 分钟）建连超时与调用方取消：重试只会把等待翻倍，一律不重试 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 重试条件只有两类：rt.fetch 直接抛（传输层），或 HTTP 状态 ∈ RETRYABLE_STATUS */
function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof HttpStatusError) return RETRYABLE_STATUS.includes(error.status);
  return true;
}

/** 单次尝试：每次各自建 signal 并 release（超时只约束建连，不砍长 SSE 流） */
async function sendOnce(id: ProviderId, rt: ProviderRuntime, url: string, init: RequestInit): Promise<Response> {
  const handle = createRequestSignal(rt);
  try {
    const res = await rt.fetch(url, { ...init, signal: handle.signal });
    await ensureOk(id, res);
    return res;
  } finally {
    handle.release();
  }
}

/** 所有出网请求的唯一入口：只有 rt.fetch 才可注入，禁止全局 fetch。 */
export async function sendRequest(
  id: ProviderId,
  rt: ProviderRuntime,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await sendOnce(id, rt, url, init);
    } catch (error) {
      // 第二次仍失败就抛这一次的原始错误：不加工、不回显「重试过」，由 ChatService 记日志
      lastError = error;
      if (!isRetryable(error)) break;
      if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/** §7 错误归一：`<provider> HTTP <status>: <body 前 300 字符>` */
export async function ensureOk(id: ProviderId, res: Response): Promise<void> {
  if (res.ok) return;
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  throw new HttpStatusError(id + ' HTTP ' + res.status + ': ' + body.slice(0, 300), res.status);
}

export function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/event-stream');
}

/** 去掉 baseUrl 尾部斜杠，避免拼出 `//chat/completions` */
export function resolveBaseUrl(baseUrl: string | undefined, fallback: string): string {
  return (baseUrl ?? fallback).replace(/\/+$/, '');
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  return asRecord(asRecord(source)?.[key]);
}

export function readArray(source: unknown, key: string): unknown[] {
  const value = asRecord(source)?.[key];
  return Array.isArray(value) ? value : [];
}

export function readString(source: unknown, key: string): string | undefined {
  const value = asRecord(source)?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(source: unknown, key: string): number | undefined {
  const value = asRecord(source)?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function toUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): LlmResult['usage'] {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}
