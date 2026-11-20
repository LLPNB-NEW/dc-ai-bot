import { describe, expect, it } from 'vitest';
import {
  NAME_CACHE_TTL_MS,
  NAME_FAILURE_TTL_MS,
  createNameResolver,
} from '../src/workers/gateway/names';

const KEY = 'Uqk3n0t-a-real-token';

interface Call {
  url: string;
  authorization: string | null;
}

/** 假 fetch：按 url 出队响应，并记录调用次数与鉴权头 */
function fakeFetch(handler: (url: string) => { ok?: boolean; status?: number; body?: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const doFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization') });
    const result = handler(url);
    const status = result.status ?? (result.ok === false ? 500 : 200);
    return new Response(JSON.stringify(result.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: doFetch as unknown as typeof fetch, calls };
}

describe('createNameResolver 缓存', () => {
  it('首次取值打一次 REST，命中缓存后不再打第二次', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith('/guilds/g1') ? { body: { name: '示例服务器' } } : { body: { name: '闲聊2' } },
    );
    const resolver = createNameResolver({ botToken: KEY, fetch });

    expect(await resolver.guildName('g1')).toBe('示例服务器');
    expect(await resolver.guildName('g1')).toBe('示例服务器');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/guilds/g1');
    expect(calls[0]?.authorization).toBe('Bot ' + KEY);

    // 频道是独立的缓存 key，会单独打一次
    expect(await resolver.channelName('c1')).toBe('闲聊2');
    expect(await resolver.channelName('c1')).toBe('闲聊2');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://discord.com/api/v10/channels/c1');
  });

  it('不同 id 各自缓存，互不串味', async () => {
    const { fetch, calls } = fakeFetch((url) => ({ body: { name: url.slice(url.lastIndexOf('/') + 1) } }));
    const resolver = createNameResolver({ botToken: KEY, fetch });
    expect(await resolver.guildName('a')).toBe('a');
    expect(await resolver.guildName('b')).toBe('b');
    expect(await resolver.guildName('a')).toBe('a');
    expect(calls).toHaveLength(2);
  });

  it('缓存 10 分钟后过期并重新取值', async () => {
    let nowMs = 1_000_000;
    let version = 1;
    const { fetch, calls } = fakeFetch(() => ({ body: { name: 'v' + String(version) } }));
    const resolver = createNameResolver({ botToken: KEY, fetch, now: () => nowMs });

    expect(await resolver.guildName('g1')).toBe('v1');
    expect(calls).toHaveLength(1);

    nowMs += NAME_CACHE_TTL_MS - 1;
    expect(await resolver.guildName('g1')).toBe('v1');
    expect(calls).toHaveLength(1);

    version = 2;
    nowMs += 1;
    expect(await resolver.guildName('g1')).toBe('v2');
    expect(calls).toHaveLength(2);
  });

  it('HTTP 失败回落空串，并在失败 TTL 内不再重试', async () => {
    let nowMs = 0;
    const { fetch, calls } = fakeFetch(() => ({ status: 403, body: { message: 'Missing Access' } }));
    const resolver = createNameResolver({ botToken: KEY, fetch, now: () => nowMs });

    expect(await resolver.guildName('g1')).toBe('');
    expect(await resolver.guildName('g1')).toBe('');
    expect(calls).toHaveLength(1);

    nowMs += NAME_FAILURE_TTL_MS;
    expect(await resolver.guildName('g1')).toBe('');
    expect(calls).toHaveLength(2);
  });

  it('fetch 抛网络异常也不外泄，只回空串', async () => {
    const throwing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const resolver = createNameResolver({ botToken: KEY, fetch: throwing });
    await expect(resolver.channelName('c1')).resolves.toBe('');
  });

  it('响应体没有 name 或 name 非字符串：回空串', async () => {
    const noName = fakeFetch(() => ({ body: { id: 'g1' } }));
    await expect(createNameResolver({ botToken: KEY, fetch: noName.fetch }).guildName('g1')).resolves.toBe('');

    const badName = fakeFetch(() => ({ body: { name: 42 } }));
    await expect(createNameResolver({ botToken: KEY, fetch: badName.fetch }).guildName('g1')).resolves.toBe('');
  });

  it('name 前后空白被裁掉', async () => {
    const { fetch } = fakeFetch(() => ({ body: { name: '  闲聊2  ' } }));
    await expect(createNameResolver({ botToken: KEY, fetch }).channelName('c1')).resolves.toBe('闲聊2');
  });

  it('没有 bot token 时直接空串，一次 REST 都不打', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { name: 'x' } }));
    const resolver = createNameResolver({ botToken: '   ', fetch });
    await expect(resolver.guildName('g1')).resolves.toBe('');
    await expect(resolver.channelName('c1')).resolves.toBe('');
    expect(calls).toHaveLength(0);
  });

  it('空 id 不触发请求', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { name: 'x' } }));
    const resolver = createNameResolver({ botToken: KEY, fetch });
    await expect(resolver.guildName('')).resolves.toBe('');
    expect(calls).toHaveLength(0);
  });
});
