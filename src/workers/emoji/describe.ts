/**
 * §23.4 认图执行器：把服务器里的自定义表情发给「表情模型」看一遍，落一句中文短描述。
 *
 * 三条自我约束（与 §22 的图片路径同口径）：
 *   1. 除「取表情清单」之外的任何失败都只 warn 不抛：认图是锦上添花，绝不许把后台按钮或网关带垮；
 *   2. 不在模块顶层捕获 fetch：workerd 会 brand-check 裸 fetch 引用，测试还要能替换全局；
 *   3. 模型配置直接复用「表情」页那一条（§23.1），不另开一套配置。
 */
import {
  buildDescribeRequest,
  DESCRIBE_BATCH_SIZE,
  parseDescribeOutput,
  type DescribeTarget,
} from '../../core/chat/emoji-describe';
import type { EmojiDescriptionStore, KeyRepository, ReactionModelStore } from '../../core/ports';
import { orderKeysForModel } from '../../core/providers/key-match';
import type {
  CustomEmoji,
  EmojiDescription,
  EmojiDescribeResult,
  LlmImage,
  LlmProvider,
  ProviderId,
  ReactionModelConfig,
} from '../../core/types';
import { listGuildEmojis } from '../discord/rest';
import { toBase64 } from '../gateway/images';

export interface DescribeDeps {
  reactionModels: ReactionModelStore;
  emojiDescriptions: EmojiDescriptionStore;
  keys: KeyRepository;
  providers: Record<ProviderId, LlmProvider>;
  /** 便于测试注入；缺省时调用才读 globalThis.fetch（见 resolveFetch） */
  fetch?: typeof fetch;
}

export interface DescribeOptions {
  /** true = 不管有没有描述都重认（后台强制重认）；缺省只认缺的（§23.1 第 3 条） */
  force?: boolean;
  /** 本次最多认几个表情（网关补认传 12，后台按钮不传 = 全量） */
  limit?: number;
}

/** 表情原图的固定前缀：animated 走 gif，其余 png（§23.4 第 6 步） */
const EMOJI_CDN_PREFIX = 'https://cdn.discordapp.com/emojis/';

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/** 调到时才读全局 fetch：与入口的 runtimeFetch、网关节点的写法一致 */
function resolveFetch(deps: DescribeDeps): typeof fetch {
  const injected = deps.fetch;
  if (injected !== undefined) return injected;
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init);
}

/** 按 DESCRIBE_BATCH_SIZE 切批：一次塞太多张图，模型会把这些图对错号（§23.3） */
function chunkBatches(items: readonly CustomEmoji[], size: number): CustomEmoji[][] {
  const batches: CustomEmoji[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

function emojiImageUrl(emoji: CustomEmoji): string {
  return EMOJI_CDN_PREFIX + emoji.id + (emoji.animated === true ? '.gif' : '.png');
}

/**
 * mediaType 与下载下来的那份字节一致：CDN 声明了 image/* 就照抄，
 * 缺省或声明成别的（某些代理会回 application/octet-stream）时按扩展名兜底（§23.4 第 6 步）。
 */
function resolveMediaType(response: Response, emoji: CustomEmoji): string {
  const declared = (response.headers.get('content-type') ?? '').split(';')[0] ?? '';
  const base = declared.trim().toLowerCase();
  if (base.startsWith('image/')) return base;
  return emoji.animated === true ? 'image/gif' : 'image/png';
}

/** 下载一张表情原图；失败/空体/非 2xx 都只 warn 并返回 null，由调用方计 failed（§23.4 第 6 步） */
async function downloadEmoji(fetchImpl: typeof fetch, emoji: CustomEmoji): Promise<LlmImage | null> {
  const url = emojiImageUrl(emoji);
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      console.warn('[emoji] 下载表情失败：' + url + ' status=' + String(response.status));
      return null;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) {
      console.warn('[emoji] 下载表情失败：' + url + ' 空响应体');
      return null;
    }
    return { mediaType: resolveMediaType(response, emoji), base64: toBase64(bytes) };
  } catch (error) {
    console.warn('[emoji] 下载表情失败：' + url + ' ' + describeError(error));
    return null;
  }
}

/** 已认过的 id 集合：force 时用不到，其余情况把这一批从待认里剔掉（§23.4 第 4 步） */
async function readDescribedIds(deps: DescribeDeps, guildId: string): Promise<Set<string>> {
  try {
    const existing: EmojiDescription[] = await deps.emojiDescriptions.list(guildId);
    return new Set(existing.map((row) => row.emojiId));
  } catch (error) {
    // 读不出来只 warn：按「都没认过」继续，最坏是把已有的描述再覆盖一遍
    console.warn('[emoji] 读描述失败：' + describeError(error));
    return new Set<string>();
  }
}

/** 待认清单：id 与 name 都必须非空（§23.4 第 3 步） */
function usableEmojis(emojis: readonly CustomEmoji[]): CustomEmoji[] {
  const usable: CustomEmoji[] = [];
  for (const emoji of emojis) {
    if (emoji.id.trim() === '' || emoji.name.trim() === '') continue;
    usable.push(emoji);
  }
  return usable;
}

/**
 * 逐批认图，返回计数。流程严格照 §23.4 的八步走：
 * 两道短路（空参、没配模型）→ 取清单（唯一会向上抛的一步）→ 剔掉已有 → 切批 →
 * 每批下载图片 → 逐把 Key 非流式试一次 → 解析 → 落库。
 * 单点失败只 warn：某一批失败了，后面的批次照样跑。
 */
export async function describeGuildEmojis(
  deps: DescribeDeps,
  guildId: string,
  botToken: string,
  options?: DescribeOptions,
): Promise<EmojiDescribeResult> {
  const result: EmojiDescribeResult = { described: 0, failed: 0 };

  // 1. 没有服务器或没有 token：连一次 REST 都不打
  if (guildId.trim() === '' || botToken.trim() === '') return result;

  // 2. 没配表情模型就不认（不要求 enabled === true：关着也能先把描述认好）
  let cfg: ReactionModelConfig | null;
  try {
    cfg = await deps.reactionModels.get();
  } catch (error) {
    console.warn('[emoji] 读表情模型配置失败：' + describeError(error));
    return result;
  }
  if (cfg === null) return result;

  // 3. 取清单：这一步的失败向上抛，由调用方 try/catch（§23.4 唯一允许抛出的地方）
  const listed = await listGuildEmojis({ botToken }, guildId);
  const emojis = usableEmojis(listed);
  if (emojis.length === 0) return result;

  // 4. force !== true 时把已有描述的剔掉
  const described = options?.force === true ? new Set<string>() : await readDescribedIds(deps, guildId);
  const pending = emojis.filter((emoji) => !described.has(emoji.id));
  if (pending.length === 0) return result;

  // 5. limit 限制的是总表情数（先截断再切批，批内不留空位）
  const limit = options?.limit;
  const limited = typeof limit === 'number' && limit >= 0 ? pending.slice(0, limit) : pending;
  const fetchImpl = resolveFetch(deps);

  for (const batch of chunkBatches(limited, DESCRIBE_BATCH_SIZE)) {
    // 6. 先把能下的图都下下来：下载失败的那几个当场计 failed 并从本批剔除
    const targets: DescribeTarget[] = [];
    for (const emoji of batch) {
      const image = await downloadEmoji(fetchImpl, emoji);
      if (image === null) {
        result.failed += 1;
        continue;
      }
      targets.push({ id: emoji.id, name: emoji.name, image });
    }
    if (targets.length === 0) continue;

    const request = buildDescribeRequest(cfg, targets);
    let output: string | null = null;
    let lastError = '';
    try {
      // 7. 逐把试非流式 chat：第一把成功即止，全失败 → 本批全计 failed
      const enabled = await deps.keys.listEnabled(cfg.provider);
      for (const key of orderKeysForModel(enabled, cfg.model)) {
        const provider = deps.providers[cfg.provider];
        if (provider === undefined) {
          lastError = 'UNKNOWN_PROVIDER: ' + String(cfg.provider);
          break;
        }
        try {
          const response = await provider.chat(request, { apiKey: key.apiKey, baseUrl: key.baseUrl, fetch: fetchImpl });
          output = response.text;
          break;
        } catch (error) {
          lastError = describeError(error);
        }
      }
    } catch (error) {
      lastError = describeError(error);
    }
    if (output === null) {
      result.failed += targets.length;
      console.warn('[emoji] 认图失败：' + lastError);
      continue;
    }

    // 8. 解析结果落库：name 用清单里的当前名字，写入条数计 described，解析不出的计 failed
    const parsed = parseDescribeOutput(output, targets);
    const names = new Map(targets.map((target) => [target.id, target.name]));
    const rows = parsed.map((entry) => ({
      emojiId: entry.emojiId,
      name: names.get(entry.emojiId) ?? '',
      description: entry.description,
    }));
    result.failed += targets.length - rows.length;
    if (rows.length === 0) continue;
    try {
      await deps.emojiDescriptions.putMany(guildId, rows);
      result.described += rows.length;
    } catch (error) {
      console.warn('[emoji] 写描述失败：' + describeError(error));
      result.failed += rows.length;
    }
  }

  return result;
}
