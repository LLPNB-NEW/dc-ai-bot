/**
 * §62：后台「历史」页删一条短期记忆时，Discord 里那条也一起删掉。
 *
 * 定位顺序：先看 messages.discord_id（新行才有）；老行没记 id 就按「落库时刻 → snowflake」
 * 拉一段时间窗，只在「作者对得上 + 正文逐字相同」且唯一命中时才动手 —— 多命中一律放弃，
 * 宁可少删一条，也不能删错别人说的话。
 */

import { DEFAULT_API_BASE, type ChannelRestOptions } from './rest';

export type DiscordPruneOutcome = 'deleted' | 'not_found' | 'ambiguous' | 'no_token' | 'failed';

/** 要删的那条历史行：只用得上定位需要的几列 */
export interface PruneTarget {
  channelId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 发言人 Discord 用户 ID（人类行靠它对作者）；assistant 行不需要 */
  authorId?: string;
  /** 落库时刻（ISO）：没有 discord_id 时用它开时间窗 */
  createdAt?: string;
  /** 落库时记下的 Discord 消息 id（新行才有） */
  discordId?: string;
}

export interface PruneResult {
  outcome: DiscordPruneOutcome;
  /** 给后台看的一句话；outcome 是 deleted 时也照样给（删了哪条） */
  detail: string;
}

/** Discord snowflake 的纪元：ms 差值左移 22 位就是那条消息附近的 id */
const SNOWFLAKE_EPOCH_MS = 1420070400000;
/** 时间窗一次拉多少条：around 会以目标为中心给前后各若干条 */
const LOOKUP_WINDOW = 50;

/** ISO 时刻 → snowflake；解析不了回 null（老行 created_at 可能缺） */
export function snowflakeOf(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const delta = BigInt(Math.trunc(ms) - SNOWFLAKE_EPOCH_MS);
  if (delta < 0n) return null;
  return (delta << 22n).toString();
}

/** 比对正文前先把 @提及 与空白拉平：库里存的是剥掉提及的原文，Discord 那边还带着 <@id> */
function normalizeContent(text: string): string {
  return text
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RawMessage {
  id: string;
  content: string;
  authorId: string;
  bot: boolean;
}

function readMessages(body: unknown): RawMessage[] {
  if (!Array.isArray(body)) return [];
  const out: RawMessage[] = [];
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const content = typeof record.content === 'string' ? record.content : '';
    const author = typeof record.author === 'object' && record.author !== null ? (record.author as Record<string, unknown>) : null;
    if (id === '' || author === null) continue;
    out.push({
      id,
      content,
      authorId: typeof author.id === 'string' ? author.id : '',
      bot: author.bot === true,
    });
  }
  return out;
}

function apiBaseOf(options: ChannelRestOptions): string {
  return (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
}

function doFetchOf(options: ChannelRestOptions): typeof fetch {
  // 与 ./rest 同理：裸 fetch 引用被当方法调用会被 workerd brand-check 拦下
  return options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init));
}

async function deleteOnce(options: ChannelRestOptions, channelId: string, messageId: string): Promise<PruneResult> {
  const url = apiBaseOf(options) + '/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId);
  const response = await doFetchOf(options)(url, {
    method: 'DELETE',
    headers: { authorization: 'Bot ' + options.botToken.trim() },
  });
  if (response.ok) return { outcome: 'deleted', detail: 'Discord 那条已删除' };
  // 404 = 早就被删了（或 id 不属于这个频道）：对使用者来说结果一样，不必报警
  if (response.status === 404) return { outcome: 'not_found', detail: 'Discord 上已找不到这条（可能早被删了）' };
  const text = await response.text().catch(() => '');
  return { outcome: 'failed', detail: '删除 Discord 消息失败（' + String(response.status) + '）：' + text.slice(0, 160) };
}

/**
 * 删掉这条历史行在 Discord 里的对应消息。
 * 失败与歧义都只回结果、不抛错：库里的行该不该删由调用方决定（本函数的语义只覆盖 Discord 这一侧）。
 */
export async function pruneDiscordMessage(options: ChannelRestOptions, target: PruneTarget): Promise<PruneResult> {
  if (options.botToken.trim() === '') return { outcome: 'no_token', detail: '没配 DISCORD_BOT_TOKEN，Discord 侧没动' };
  if (target.channelId.trim() === '') return { outcome: 'not_found', detail: '这行没记频道 id，Discord 侧没法定位' };

  const known = (target.discordId ?? '').trim();
  if (known !== '') {
    try {
      return await deleteOnce(options, target.channelId, known);
    } catch (error) {
      return { outcome: 'failed', detail: '删除 Discord 消息时出错：' + String((error as Error)?.message ?? error).slice(0, 160) };
    }
  }

  const createdAt = (target.createdAt ?? '').trim();
  const snowflake = createdAt === '' ? null : snowflakeOf(createdAt);
  if (snowflake === null) return { outcome: 'not_found', detail: '这行没记 Discord 消息 id，也没有可用的落库时刻' };

  let listed: RawMessage[];
  try {
    const url =
      apiBaseOf(options) +
      '/channels/' +
      encodeURIComponent(target.channelId) +
      '/messages?around=' +
      encodeURIComponent(snowflake) +
      '&limit=' +
      String(LOOKUP_WINDOW);
    const response = await doFetchOf(options)(url, {
      method: 'GET',
      headers: { authorization: 'Bot ' + options.botToken.trim() },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { outcome: 'failed', detail: '读取 Discord 消息失败（' + String(response.status) + '）：' + text.slice(0, 160) };
    }
    listed = readMessages(await response.json());
  } catch (error) {
    return { outcome: 'failed', detail: '读取 Discord 消息时出错：' + String((error as Error)?.message ?? error).slice(0, 160) };
  }

  const wanted = normalizeContent(target.content);
  const authorId = (target.authorId ?? '').trim();
  const matches = listed.filter((message) => {
    if (normalizeContent(message.content) !== wanted) return false;
    // assistant 行认「bot 发的」，人类行认作者 id：同名同文的两个人也不会互相误删
    return target.role === 'assistant' ? message.bot : authorId !== '' && message.authorId === authorId;
  });
  if (matches.length === 0) return { outcome: 'not_found', detail: '时间窗里没找到正文一致的那条（可能早被删了）' };
  if (matches.length > 1) {
    return { outcome: 'ambiguous', detail: '时间窗里有 ' + String(matches.length) + ' 条一模一样的内容，没敢猜是哪条' };
  }
  try {
    const result = await deleteOnce(options, target.channelId, matches[0]!.id);
    return result;
  } catch (error) {
    return { outcome: 'failed', detail: '删除 Discord 消息时出错：' + String((error as Error)?.message ?? error).slice(0, 160) };
  }
}
