import { beforeEach, describe, expect, it } from 'vitest';
import { readMemberDisplayName, resetBotNameCache, resolveBotDisplayName } from '../src/workers/discord/bot-name';

const BOT_ID = '150000000000000001';
const GUILD_ID = '150000000000000002';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('服务器昵称的解析（§64）', () => {
  beforeEach(() => resetBotNameCache());

  it('成员对象里昵称优先，其次账号全局名，最后账号名', () => {
    expect(readMemberDisplayName({ nick: '示例角色', user: { global_name: '示例机器人', username: 'bot' } })).toBe('示例角色');
    expect(readMemberDisplayName({ nick: null, user: { global_name: '示例机器人', username: 'bot' } })).toBe('示例机器人');
    expect(readMemberDisplayName({ nick: '  ', user: { global_name: null, username: 'bot' } })).toBe('bot');
    expect(readMemberDisplayName({ user: { username: '  bot  ' } })).toBe('bot');
  });

  it('结构不对一律空串：非对象、没有 user、user 里没有任何名字', () => {
    expect(readMemberDisplayName(null)).toBe('');
    expect(readMemberDisplayName('示例角色')).toBe('');
    expect(readMemberDisplayName({ nick: '示例角色' })).toBe('示例角色');
    expect(readMemberDisplayName({ user: {} })).toBe('');
  });

  it('按 guild 取一次成员资料：路径带 Bot token，缓存命中后不再请求', async () => {
    const calls: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input) + ' ' + String(init?.headers && (init.headers as Record<string, string>).authorization));
      return jsonResponse({ nick: '示例角色', user: { username: '示例机器人' } });
    }) as typeof fetch;

    const options = { botToken: 'tok', botId: BOT_ID, fetch: fetchStub };
    expect(await resolveBotDisplayName(options, GUILD_ID)).toBe('示例角色');
    expect(await resolveBotDisplayName(options, GUILD_ID)).toBe('示例角色');
    expect(calls).toEqual([
      'https://discord.com/api/v10/guilds/' + GUILD_ID + '/members/' + BOT_ID + ' Bot tok',
    ]);
  });

  it('不同服务器的昵称分开缓存', async () => {
    const seen: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL) => {
      const guild = String(input).split('/guilds/')[1].split('/')[0];
      seen.push(guild);
      return jsonResponse({ nick: '示例角色-' + guild });
    }) as typeof fetch;
    const options = { botToken: 'tok', botId: BOT_ID, fetch: fetchStub };
    expect(await resolveBotDisplayName(options, '1')).toBe('示例角色-1');
    expect(await resolveBotDisplayName(options, '2')).toBe('示例角色-2');
    expect(seen).toEqual(['1', '2']);
  });

  it('没有 token / 没有 guild / 没有 botId 都直接空串，不发请求', async () => {
    let called = 0;
    const fetchStub = (async () => {
      called += 1;
      return jsonResponse({ nick: '示例角色' });
    }) as typeof fetch;
    expect(await resolveBotDisplayName({ botToken: '', botId: BOT_ID, fetch: fetchStub }, GUILD_ID)).toBe('');
    expect(await resolveBotDisplayName({ botToken: 'tok', botId: BOT_ID, fetch: fetchStub }, '  ')).toBe('');
    expect(await resolveBotDisplayName({ botToken: 'tok', botId: ' ', fetch: fetchStub }, GUILD_ID)).toBe('');
    expect(called).toBe(0);
  });

  it('机器人不在这个服（404）不抛错，空结果在窗口内也缓存', async () => {
    let called = 0;
    const fetchStub = (async () => {
      called += 1;
      return jsonResponse({ message: 'Unknown Guild' }, 404);
    }) as typeof fetch;
    const options = { botToken: 'tok', botId: BOT_ID, fetch: fetchStub };
    expect(await resolveBotDisplayName(options, GUILD_ID)).toBe('');
    expect(await resolveBotDisplayName(options, GUILD_ID)).toBe('');
    expect(called).toBe(1);
  });
});
