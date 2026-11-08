/**
 * 服务器名 / 频道名的解析器（带内存缓存）。
 *
 * 为什么需要它：模型只能看见提示词，不知道「现在是谁在跟我说话、这是哪个服务器哪个频道」，
 * 于是只能照提示词里写死的名字猜身份。把 guild / channel 的名字取回来交给 system prompt 的身份块，
 * 它才认得出人。（用户 id 由消息本身带，不用 REST。）
 *
 * 缓存：一个解析器实例一个 Map，key = 'guild:<id>' / 'channel:<id>'。
 *   命中成功 -> 缓存 NAME_CACHE_TTL_MS（10 分钟）；
 *   取名失败（网络 / 权限 / 404）-> 负缓存 NAME_FAILURE_TTL_MS（60 秒），
 *   免得每条消息都去打一次注定失败的 REST，同时网络恢复后一分钟内就能自愈。
 * 任何失败都回落空串：取名绝不能拖累回复。
 */
import { DISCORD_API_BASE } from './channel-rest';

export const NAME_CACHE_TTL_MS = 600_000;
export const NAME_FAILURE_TTL_MS = 60_000;

export interface NameResolverOptions {
  botToken: string;
  apiBase?: string;
  /**
   * 注入点：测试传假 fetch。生产留空时用箭头函数转调 globalThis.fetch ——
   * 与 ./channel-rest.ts 同理，裸 fetch 引用被当方法调用会被 workerd brand-check 拦下。
   */
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
}

export interface NameResolver {
  /** 取不到（未配置 token / 失败 / 无此字段）一律返回空串 */
  guildName(guildId: string): Promise<string>;
  channelName(channelId: string): Promise<string>;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Discord 的 guild / channel 对象都只有一个字符串 name，这里只窄读它 */
function readName(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const name = (body as Record<string, unknown>).name;
  return typeof name === 'string' ? name.trim() : '';
}

export function createNameResolver(options: NameResolverOptions): NameResolver {
  const apiBase = options.apiBase ?? DISCORD_API_BASE;
  const doFetch =
    options.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init));
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? NAME_CACHE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? NAME_FAILURE_TTL_MS;
  const authorization = 'Bot ' + options.botToken.trim();
  const configured = options.botToken.trim() !== '';
  const cache = new Map<string, CacheEntry>();

  async function lookup(key: string, path: string): Promise<string> {
    const nowMs = now();
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > nowMs) return cached.value;

    let value = '';
    try {
      const res = await doFetch(apiBase + path, { headers: { authorization } });
      if (res.ok) {
        const body: unknown = await res.json();
        value = readName(body);
      }
    } catch {
      // 网络异常同样按「取不到」处理，负缓存过期后自动重试
      value = '';
    }
    cache.set(key, { value, expiresAt: nowMs + (value === '' ? failureTtlMs : ttlMs) });
    return value;
  }

  return {
    guildName: (guildId: string): Promise<string> =>
      configured && guildId !== '' ? lookup('guild:' + guildId, '/guilds/' + guildId) : Promise.resolve(''),
    channelName: (channelId: string): Promise<string> =>
      configured && channelId !== '' ? lookup('channel:' + channelId, '/channels/' + channelId) : Promise.resolve(''),
  };
}
