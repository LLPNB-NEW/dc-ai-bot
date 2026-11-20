import { describe, expect, it } from 'vitest';
import { pruneDiscordMessage, snowflakeOf, type PruneTarget } from '../src/workers/discord/prune';

// §62：删单条短期记忆时把 Discord 里那条也删掉 —— 定位靠 discord_id，老行靠「时间窗 + 正文比对」

const TOKEN = 'bot-token';
const CHANNEL = '222222222222222222';
const CREATED = '2026-01-01T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

/** 假 fetch：按方法回预设响应，顺便把每次请求记下来给断言用 */
function fakeFetch(replies: Array<() => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method ?? 'GET', authorization: headers.get('authorization') });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return reply === undefined ? new Response('{}', { status: 200 }) : reply();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function target(patch: Partial<PruneTarget> = {}): PruneTarget {
  const base: PruneTarget = { channelId: CHANNEL, role: 'user', content: '今天也很困', authorId: 'u1', createdAt: CREATED };
  return { ...base, ...patch };
}

describe('snowflakeOf', () => {
  it('Discord 纪元那一刻回 0，一秒后回 1000 << 22', () => {
    expect(snowflakeOf('2015-01-01T00:00:00.000Z')).toBe('0');
    expect(snowflakeOf('2015-01-01T00:00:01.000Z')).toBe(String(1000 * 2 ** 22));
  });

  it('早于纪元或解析不出回 null', () => {
    expect(snowflakeOf('2014-12-31T23:59:59.000Z')).toBeNull();
    expect(snowflakeOf('不是时间')).toBeNull();
  });
});

describe('pruneDiscordMessage', () => {
  it('记了 discord_id 就直接删那条，并带上 Bot 鉴权', async () => {
    const { fetch, calls } = fakeFetch([() => new Response(null, { status: 204 })]);
    const result = await pruneDiscordMessage({ botToken: TOKEN, fetch }, target({ discordId: '9001' }));
    expect(result.outcome).toBe('deleted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/channels/' + CHANNEL + '/messages/9001');
    expect(calls[0]?.authorization).toBe('Bot ' + TOKEN);
  });

  it('直删回 404 当「早就删过了」，不报失败', async () => {
    const { fetch } = fakeFetch([() => json(404, { message: 'Unknown Message' })]);
    expect((await pruneDiscordMessage({ botToken: TOKEN, fetch }, target({ discordId: '9001' }))).outcome).toBe('not_found');
  });

  it('老行没有 id：按落库时刻开时间窗，正文与作者都对上才删', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        json(200, [
          { id: '7001', content: '别人的话', author: { id: 'u2' } },
          { id: '7002', content: '今天也很困', author: { id: 'u1' } },
        ]),
      () => new Response(null, { status: 204 }),
    ]);
    const result = await pruneDiscordMessage({ botToken: TOKEN, fetch }, target());
    expect(result.outcome).toBe('deleted');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/channels/' + CHANNEL + '/messages?around=');
    expect(calls[0]?.url).toContain('limit=50');
    expect(calls[1]?.url).toContain('/messages/7002');
  });

  it('时间窗里有多条一模一样的内容：不猜，回 ambiguous 且不发 DELETE', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        json(200, [
          { id: '7001', content: '今天也很困', author: { id: 'u1' } },
          { id: '7002', content: '今天也很困', author: { id: 'u1' } },
        ]),
    ]);
    const result = await pruneDiscordMessage({ botToken: TOKEN, fetch }, target());
    expect(result.outcome).toBe('ambiguous');
    expect(calls).toHaveLength(1);
  });

  it('正文相同但作者不是他：一条都不删', async () => {
    const { fetch, calls } = fakeFetch([() => json(200, [{ id: '7001', content: '今天也很困', author: { id: 'u2' } }])]);
    expect((await pruneDiscordMessage({ botToken: TOKEN, fetch }, target())).outcome).toBe('not_found');
    expect(calls).toHaveLength(1);
  });

  it('bot 的回复认 author.bot，不认用户 id', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        json(200, [
          { id: '7001', content: '喵', author: { id: 'someone-else' } },
          { id: '7002', content: '喵', author: { id: 'bot-1', bot: true } },
        ]),
      () => new Response(null, { status: 204 }),
    ]);
    const result = await pruneDiscordMessage({ botToken: TOKEN, fetch }, target({ role: 'assistant', content: '喵' }));
    expect(result.outcome).toBe('deleted');
    expect(calls[1]?.url).toContain('/messages/7002');
  });

  it('@提及 与空白不算差异：库里存的是剥掉提及的原文', async () => {
    const { fetch } = fakeFetch([
      () => json(200, [{ id: '7001', content: '<@bot-1>  今天也很困 ', author: { id: 'u1' } }]),
      () => new Response(null, { status: 204 }),
    ]);
    expect((await pruneDiscordMessage({ botToken: TOKEN, fetch }, target({ content: '<@bot-1> 今天也很困' }))).outcome).toBe('deleted');
  });

  it('没配 token：一个请求都不发', async () => {
    const { fetch, calls } = fakeFetch([() => json(200, [])]);
    const result = await pruneDiscordMessage({ botToken: '   ', fetch }, target({ discordId: '9001' }));
    expect(result.outcome).toBe('no_token');
    expect(calls).toHaveLength(0);
  });

  it('落库时刻解析不出来：无从开窗，回 not_found 不发请求', async () => {
    const { fetch, calls } = fakeFetch([() => json(200, [])]);
    const result = await pruneDiscordMessage({ botToken: TOKEN, fetch }, target({ createdAt: '不是时间' }));
    expect(result.outcome).toBe('not_found');
    expect(calls).toHaveLength(0);
  });

  it('DELETE 回 5xx：failed 带上状态与正文片段', async () => {
    const { fetch } = fakeFetch([() => json(500, { message: 'Discord 抽风了' })]);
    const result = await pruneDiscordMessage({ botToken: TOKEN, fetch }, target({ discordId: '9001' }));
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('500');
    expect(result.detail).toContain('Discord 抽风了');
  });

  it('读时间窗就失败：failed 不冒泡', async () => {
    const { fetch } = fakeFetch([() => json(403, { message: 'Missing Access' })]);
    const result = await pruneDiscordMessage({ botToken: TOKEN, fetch }, target());
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('403');
  });
});
