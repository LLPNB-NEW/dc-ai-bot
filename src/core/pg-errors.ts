import type { PgErrorEntry, PgErrorFeed } from './types';
import { resolveTimeout } from './timeouts';

/** 中继与后台共用的条数区间：缺省 200、上限 200、下限 1 */
export const PG_ERRORS_DEFAULT_LIMIT = 200;
export const PG_ERRORS_MAX_LIMIT = 200;
export const PG_ERRORS_MIN_LIMIT = 1;

/** message 只是给人看的一句话，超过这个长度就不再往后台搬 */
export const PG_ERRORS_MESSAGE_MAX_CHARS = 500;

/** 越界夹紧而不是报错：坏数字回落到缺省值，其余夹到 1..200 */
export function clampPgErrorsLimit(value: number): number {
  if (!Number.isFinite(value)) return PG_ERRORS_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), PG_ERRORS_MIN_LIMIT), PG_ERRORS_MAX_LIMIT);
}

/** 后台的只读端口：configured=false 表示中继没配，路由据此回 501 而不是 502 */
export interface PgErrorsSource {
  readonly configured: boolean;
  list(limit: number): Promise<PgErrorFeed>;
}

/** 取不到中继那份列表：detail 是一句中文原因，直接给后台看，不含 key / token */
export class PgErrorsUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'PgErrorsUnavailableError';
    this.detail = detail;
  }
}

export interface RelayErrorSourceOptions {
  /** 中继根地址，例如 http://pg-relay:8787；末尾斜杠会被去掉 */
  url: string;
  /** 中继的 Bearer key，只进请求头，绝不进日志与响应 */
  token: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(item: Record<string, unknown>, key: string): number | undefined {
  const value = item[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 坏行（缺必需字段 / 类型不对）返回 null；可选字段类型不对就整键不显示 */
function readEntry(value: unknown): PgErrorEntry | null {
  if (!isRecord(value)) return null;
  const at = readOptionalString(value, 'at');
  const status = readOptionalNumber(value, 'status');
  const code = readOptionalString(value, 'code');
  const message = readOptionalString(value, 'message');
  if (at === undefined || status === undefined || code === undefined || message === undefined) return null;

  const entry: PgErrorEntry = { at, status, code, message: message.slice(0, PG_ERRORS_MESSAGE_MAX_CHARS) };
  const model = readOptionalString(value, 'model');
  if (model !== undefined) entry.model = model;
  const key = readOptionalString(value, 'key');
  if (key !== undefined) entry.key = key;
  const durationMs = readOptionalNumber(value, 'durationMs');
  if (durationMs !== undefined) entry.durationMs = durationMs;
  const requestId = readOptionalString(value, 'requestId');
  if (requestId !== undefined) entry.requestId = requestId;
  return entry;
}

/** limit / dropped 非法时回落到 200 / 0；items 不是数组就是形状不符；条数再按调用方要的上限收一次 */
function readFeed(payload: unknown, maxItems: number): PgErrorFeed {
  if (!isRecord(payload) || !Array.isArray(payload['items'])) {
    throw new PgErrorsUnavailableError('PG 中继返回的数据形状不对');
  }

  const limit = clampPgErrorsLimit(readOptionalNumber(payload, 'limit') ?? PG_ERRORS_DEFAULT_LIMIT);
  const dropped = Math.max(Math.trunc(readOptionalNumber(payload, 'dropped') ?? 0), 0);

  const cap = Math.min(limit, maxItems);
  const items: PgErrorEntry[] = [];
  for (const raw of payload['items']) {
    if (items.length >= cap) break;
    const entry = readEntry(raw);
    if (entry !== null) items.push(entry);
  }
  return { limit, dropped, items };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

/**
 * 中继报错列表的只读来源：GET <url>/admin/errors?limit=<n>，带 Bearer token。
 * 非 200 / 网络错 / 超时 / JSON 坏 / 形状不符一律 PgErrorsUnavailableError，detail 给后台直接显示。
 */
export function createRelayErrorSource(options: RelayErrorSourceOptions): PgErrorsSource {
  const base = options.url.trim().replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? resolveTimeout('pgErrors');

  return {
    configured: true,
    async list(limit: number): Promise<PgErrorFeed> {
      const wanted = clampPgErrorsLimit(limit);
      const target = base + '/admin/errors?limit=' + String(wanted);

      let response: Response;
      try {
        response = await options.fetch(target, {
          method: 'GET',
          headers: { authorization: 'Bearer ' + options.token, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (isTimeout(error)) {
          throw new PgErrorsUnavailableError('PG 中继请求超时（' + String(timeoutMs) + 'ms）');
        }
        throw new PgErrorsUnavailableError('连不上 PG 中继：' + describeError(error));
      }

      if (response.status !== 200) {
        throw new PgErrorsUnavailableError('PG 中继返回 HTTP ' + String(response.status));
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new PgErrorsUnavailableError('PG 中继返回的不是合法 JSON');
      }
      return readFeed(payload, wanted);
    },
  };
}

/** 中继没配时的占位：永远抛 PgErrorsUnavailableError，路由因 configured=false 回 501 */
export function createUnconfiguredErrorSource(): PgErrorsSource {
  return {
    configured: false,
    list(): Promise<PgErrorFeed> {
      return Promise.reject(new PgErrorsUnavailableError('没有配置 PG 中继（PG_ERRORS_URL / PG_ERRORS_TOKEN）'));
    },
  };
}
