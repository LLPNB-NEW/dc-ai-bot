/**
 * bot 在某台服务器里的显示名（§64）：摘要素材与 {{bot_name}} 一直写着代码常量，「DC AI BOT」
 * 于是跟着进了长期记忆；这里按 guild 读一次成员资料，昵称 > 账号全局名 > 账号名三档回落。
 * 取不到就返回空串，由调用侧退回常量 —— 名字是锦上添花，绝不能让这条回复失败。
 */
import { channelRequest, type ChannelRestOptions } from './rest';

/** 负缓存窗口：机器人不在这个服（404）时不要每轮回复都为它再打一次 REST */
const EMPTY_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { name: string; at: number }>();

function pickName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 成员对象的显示名：nick 优先，其次 user.global_name，最后 user.username；缺字段就是空串 */
export function readMemberDisplayName(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const member = body as Record<string, unknown>;
  const nick = pickName(member.nick);
  if (nick !== '') return nick;
  const user = member.user;
  if (typeof user !== 'object' || user === null) return '';
  const account = user as Record<string, unknown>;
  return pickName(account.global_name) || pickName(account.username);
}

export interface BotNameOptions extends ChannelRestOptions {
  botId: string;
}

/** 测试用：清掉进程内缓存，免用例之间互相影响 */
export function resetBotNameCache(): void {
  cache.clear();
}

/**
 * GET /guilds/{guildId}/members/{botId}。私聊没有 guild、没配 token 都直接空串；
 * 请求失败只吞成空串，不抛 —— 调用点拿到的永远是可用的字符串。
 */
export async function resolveBotDisplayName(options: BotNameOptions, guildId: string): Promise<string> {
  const guild = guildId.trim();
  const botId = options.botId.trim();
  const token = options.botToken.trim();
  if (guild === '' || botId === '' || token === '') return '';
  const key = guild + '|' + botId;
  const hit = cache.get(key);
  if (hit !== undefined && (hit.name !== '' || Date.now() - hit.at < EMPTY_TTL_MS)) return hit.name;
  let name = '';
  try {
    const response = await channelRequest(
      options,
      'GET',
      `/guilds/${encodeURIComponent(guild)}/members/${encodeURIComponent(botId)}`,
    );
    name = readMemberDisplayName(await response.json());
  } catch {
    name = '';
  }
  cache.set(key, { name, at: Date.now() });
  return name;
}
