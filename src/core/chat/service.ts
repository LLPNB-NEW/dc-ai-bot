import { DEFAULT_HISTORY_MAX_MESSAGES, tailMessages } from '../memory/window';
import type {
  BodyEmojiGuideStore,
  ChannelMemoryStore,
  ConversationStore,
  KeyRepository,
  PromptDefaultsStore,
  PromptRepository,
  ReactionGuideStore,
  ReactionModelStore,
  ReactionTemplateStore,
  RouteRepository,
  SummaryStore,
} from '../ports';
import { formatIdentityBlock, pickScopedTemplate, renderIdentityTemplate, resolveFallbackPrompt } from '../prompt/defaults';
import { resolveInjection, withInjection, type PromptInjectionStore } from '../prompt/injection';
import { DEFAULT_PROMPT, resolvePrompt } from '../prompt/resolver';
import { renderTemplate } from '../prompt/template';
import {
  buildWorldBlock,
  resolveWorldBook,
  selectWorldEntries,
  type WorldBookRecord,
  type WorldBookStore,
} from '../prompt/worldbook';
import type { TemplateVars } from '../prompt/template';
import { orderKeysForModel } from '../providers/key-match';
import { resolveRoute } from '../routing/resolve';
import type {
  BackfillOutcome,
  BackfillPreview,
  BodyEmojiGuideConfig,
  ChannelKey,
  ChannelMemoryConfig,
  ChatMessage,
  ConversationSummary,
  CustomEmoji,
  LlmImage,
  LlmProvider,
  LlmRequest,
  LogEntry,
  LogLevel,
  LogScope,
  ModelRef,
  PromptConfig,
  PromptDefaults,
  PromptInjectionConfig,
  PromptDefaultsScope,
  PromptPlacement,
  PromptRole,
  PromptSegment,
  ProviderId,
  SummarySweepOutcome,
  ReactionGuideConfig,
  ReactionModelConfig,
  ReactionRequest,
  ReactionTemplateConfig,
  Scope,
  StoredMessage,
  SummaryOutcome,
  TimeRange,
  ToolCallDelta,
  TurnAttempt,
  TurnContext,
  TurnResult,
} from '../types';
import {
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_INPUT_MESSAGES,
  appendSegment,
  buildSummaryRequest,
  formatTranscript,
  normalizeSummary,
  renderSummaryBlock,
} from './summary';
import type { SummaryLine } from './summary';
import { AUTHOR_SEPARATOR, withAuthorPrefix } from './line';
import { buildMentionNames, dedupeMentions, renderMentionRule } from './mention-dedupe';
import { MAX_REACTIONS, reactionKey, splitReactDirectives, visibleText } from './react';
import {
  REACTION_HISTORY_MESSAGES,
  buildReactionRequest,
  isOnlyNoReactionMark,
  normalizeReactions,
  renderReactionTargets,
  stripNoReactionHead,
} from './reaction';
import { resolveReactionGuide } from './reaction-guide';
import { resolveBodyEmojiGuide } from './body-emoji';
import type { ResolvedReactionGuide } from './reaction-guide';
import { resolveReactionTemplate } from './reaction-template';
import type { ResolvedReactionTemplate } from './reaction-template';
import {
  CONTEXT_REPLY_SYSTEM_PREFIX,
  CONTEXT_TOOL_MAX_TOKENS,
  CONTEXT_TOOL_REASONING_EFFORT,
  CONTEXT_TOOL_SYSTEM,
  CONTEXT_TOOL_TURN,
  accumulateToolCalls,
  buildContextTools,
  budgetedHistory,
  composeContextBody,
  readToolReply,
  replyOnlyTools,
  taggedHistory,
} from './context-tool';
import { dropRefusalHistory } from './refusal-filter';
import { replyToolsFor } from './reply-tool';
import { STAMP_OFFSET_MINUTES, stripStamp } from './stamp';
import { unwrapToolReply, unwrapToolReplyStream } from './tool-shell';
import { stripWrapperTags } from './wrapper-tags';
import { stripVoiceDirective } from '../voice/directive';
import {
  CONTINUE_SENTINEL,
  CONTINUE_TOTAL_CHARS,
  MAX_CONTINUATIONS,
  continuationMessages,
  isTruncatedReply,
} from './truncation';

export interface ChatServiceDeps {
  prompts: PromptRepository;
  routes: RouteRepository;
  keys: KeyRepository;
  conversations: ConversationStore;
  /** 长期记忆存储；老调用方没接线时退化成「没有长期记忆」，不影响回复 */
  summaries?: SummaryStore;
  /** 频道级记忆配置（§26）；老调用方没接线时一律走 config / 代码默认，行为与接线前逐字一致 */
  channelMemory?: ChannelMemoryStore;
  /** 表情选择的独立模型（§21）；不接线 = 没有表情模型，行为完全退回 §18 的主模型自贴 */
  reactionModels?: ReactionModelStore;
  /** 贴表情提示词三层配置（§28.10）；没接线 = 三层都没有 = 用内置默认 */
  reactionGuides?: ReactionGuideStore;
  /** 正文表情提示词三层配置；没接线 = 整段不出现 = system 与描述体都与接线前逐字相同 */
  bodyEmojiGuides?: BodyEmojiGuideStore;
  /** 表情模型素材模板三层配置（§34.4）；没接线 = 三层都没有 = 用内置默认模板 */
  reactionTemplates?: ReactionTemplateStore;
  /** 后台可编辑的两份兜底文案；没接线 = 没配 = 三层全空仍走 DEFAULT_PROMPT、身份块仍由代码生成 */
  promptDefaults?: PromptDefaultsStore;
  /** 深度注入三层配置；没接线 = 三层都没有 = messages 与接线前逐字一致 */
  promptInjections?: PromptInjectionStore;
  /** 世界书三层配置；没接线 = 三层都没有 = system 与接线前逐字一致 */
  worldBooks?: WorldBookStore;
  providers: Record<ProviderId, LlmProvider>;
  /** 后台任务入口（Workers 里接 ctx.waitUntil）；缺省时任务直接丢弃，绝不影响本轮回复 */
  background?: (task: Promise<unknown>) => void;
  /** 运行日志钩子（§19.6）：只有四条事件；不接线时退化成 no-op，绝不影响回复 */
  log?: (entry: LogEntry) => void;
  /** 时钟：本轮的时间戳与落库时刻都取它，测试注入固定时刻才能断言前缀 */
  now?: () => Date;
  config: {
    /** 注入条数上限：只送最近 N 条原文，缺省 DEFAULT_HISTORY_MAX_MESSAGES = 50 */
    historyMaxMessages?: number;
    /** 摘要正文上限，缺省 SUMMARY_MAX_CHARS */
    summaryMaxChars?: number;
    /** 未总结消息累计到多少条就自动做一次大总结（用户与她自己的回复都算），缺省 DEFAULT_SUMMARY_EVERY_MESSAGES = 50 */
    summaryEveryMessages?: number;
  };
}

export interface TurnEvents {
  onProgress?: (partialText: string) => void | Promise<void>;
}

export interface ChatService {
  run(ctx: TurnContext, events?: TurnEvents): Promise<TurnResult>;
  reset(key: ChannelKey): Promise<void>;
  summarize(key: ChannelKey): Promise<SummaryOutcome | null>;
  /** §63 后台「连续总结」一批：固定吃满 500 条，并回报游标之后还剩多少条（前端据此接力） */
  summarizeSweep(key: ChannelKey): Promise<SummarySweepOutcome>;
  getSummary(key: ChannelKey): Promise<ConversationSummary | null>;
  /** §35 后台「选择性补记」预览：这段范围里有多少条、首尾各是什么；不调模型、不写库 */
  previewBackfill(key: ChannelKey, range: TimeRange): Promise<BackfillPreview>;
  /** §35 后台「选择性补记」：把这段历史压成一段新记忆追加到尾部，游标不动；没素材或未接线返回 null */
  backfill(key: ChannelKey, range: TimeRange): Promise<BackfillOutcome | null>;
}

/** 自动大总结的触发阈值：未总结消息攒到这么多条就总结一次（缺省 50） */
export const DEFAULT_SUMMARY_EVERY_MESSAGES = 50;
/** §19.6：错误文本进日志只留前 300 字；正文、口令、完整 Key 一律不入表 */
const LOG_ERROR_MAX_CHARS = 300;
/**
 * 同一候选模型连续空回的尝试次数上限（首次 + 2 次重试），用完才换下一个候选模型。
 * 空回多半是上游这一次没答上来、不是这把 Key 坏了，所以先原地重试而不是换 Key；
 * 重试之间不等待——同一把 Key、同一个请求，等一秒也只是白白加延迟。
 */
const EMPTY_REPLY_ATTEMPTS = 3;

// resolvePrompt 实现上永不返回 null，这里只为窄化契约声明的 `| null`
const FALLBACK_HIT: { cfg: PromptConfig; scope: Scope } = { cfg: DEFAULT_PROMPT, scope: 'global' };

/**
 * workerd 对 fetch 做 this 品牌校验：裸引用随对象传递、再以方法形式调用（rt.fetch(...)）
 * 会抛 'Illegal invocation: function called with incorrect this reference'，故固定经 globalThis 调用。
 */
const callGlobalFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);

/** ISO 串按字典序就是时间序；空串当「没有」，两边都空返回 undefined（键不出现） */
function earlierIso(a: string | undefined, b: string | undefined): string | undefined {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (left === '') return right === '' ? undefined : right;
  if (right === '') return left;
  return left <= right ? left : right;
}

function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (left === '') return right === '' ? undefined : right;
  if (right === '') return left;
  return left >= right ? left : right;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 本轮真正生效的三个数字（§26.3）：频道行 > config > 代码默认，逐字段独立回退。
 * 阈值 <= 0 一律折算成 0 = 关闭自动总结；正数沿用旧口径（至少 2 条），未接线时与接线前逐字一致。
 * 摘要预算 <= 0 与 NaN 都当「未设置」，一路退到 SUMMARY_MAX_CHARS（§26.4）。
 */
function resolveTurnMemory(
  settings: ChannelMemoryConfig | null,
  config: ChatServiceDeps['config'],
): { historyMaxMessages: number; summaryEveryMessages: number; summaryMaxChars: number } {
  const historyMaxMessages = settings?.historyMaxMessages ?? config.historyMaxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES;
  const rawSummaryEvery = settings?.summaryEveryMessages ?? config.summaryEveryMessages ?? DEFAULT_SUMMARY_EVERY_MESSAGES;
  const summaryEveryMessages = rawSummaryEvery > 0 ? Math.max(2, Math.floor(rawSummaryEvery)) : 0;
  const channelBudget = settings?.summaryMaxChars ?? 0;
  const configBudget = config.summaryMaxChars ?? 0;
  // 负数与 NaN 都过不了 > 0，自然落到下一级
  const summaryMaxChars =
    channelBudget > 0 ? channelBudget : configBudget > 0 ? configBudget : SUMMARY_MAX_CHARS;
  return { historyMaxMessages, summaryEveryMessages, summaryMaxChars };
}

/** 单批素材硬上限：一次总结调用最多吃这么多条，避免阈值填大后一次请求把模型撑爆 */
const SUMMARY_BATCH_SAFE_MAX = 500;

/**
 * 单批 = max(50, 阈值)，但不超过 500；阈值更大时靠 maybeSummarize 的循环多批追平（§26）。
 * 至少 50 是为了不让「阈值 20」退化成一堆 20 条的小请求。
 */
function summaryBatchLimit(summaryEveryMessages: number): number {
  // §26.4：阈值 0 = 关掉自动总结，此时手动 /summary 与后台「重新总结」一次吃满安全上限，
  // 否则积压几万条时要人点几百次才能追平。
  if (summaryEveryMessages <= 0) return SUMMARY_BATCH_SAFE_MAX;
  const wanted = summaryEveryMessages > SUMMARY_MAX_INPUT_MESSAGES ? summaryEveryMessages : SUMMARY_MAX_INPUT_MESSAGES;
  return wanted > SUMMARY_BATCH_SAFE_MAX ? SUMMARY_BATCH_SAFE_MAX : wanted;
}

/**
 * 摘要素材：游标之后已落库的那一批 + 本轮这条还没落库的用户消息。
 * 这批已经用满 limit 条就不带 extra：把还没落库的那条挤进来，会顶掉一条已落库的行，
 * 被顶掉的行这一轮没送进模型、下一轮又落在游标之后……可游标一推进就真漏了。
 * 所以「满了就不带」是刻意的老口径（§35.7）。上限由调用方给（summaryBatchLimit）。
 */
export function summaryMaterial(pending: SummaryLine[], extra: SummaryLine[], limit: number): SummaryLine[] {
  const all = pending.concat(extra);
  if (all.length <= limit) return all;
  return all.slice(0, limit);
}

/**
 * 送给模型的顺序按 created_at（§35.7）：选区按 id 走，读起来必须按时间走。
 * SummaryLine 不带 id，同刻（同一个 created_at）的先后从这批已落库的行里查；
 * extra 里本轮这条还没有 id，同时刻排在最后。没有 createdAt 的老行一律排在前面，同值按 id。
 */
export function orderSummaryMaterial(material: readonly SummaryLine[], chosen: readonly StoredMessage[]): SummaryLine[] {
  const idOf = new Map<SummaryLine, number>();
  for (const message of chosen) idOf.set(message, message.id);
  return material.slice().sort((a, b) => {
    const at = a.createdAt ?? '';
    const bt = b.createdAt ?? '';
    if (at < bt) return -1;
    if (at > bt) return 1;
    return (idOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (idOf.get(b) ?? Number.MAX_SAFE_INTEGER);
  });
}

/**
 * §35 一次「选择性补记」的条数上限沿用单批硬上限（SUMMARY_BATCH_SAFE_MAX），多要一条只为
 * 判断「是不是超额了」——不必把整段历史读进内存也能给出准确的拒绝。
 */
const BACKFILL_PROBE_LIMIT = SUMMARY_BATCH_SAFE_MAX + 1;
/** §35 预览样本：首尾各报 3 条 */
const BACKFILL_SAMPLE_EDGE = 3;
/** §35 预览样本的正文字数：只够认出「这段说的是什么」，多一个字符都不该跟前端抢带宽 */
const BACKFILL_SAMPLE_EXCERPT_CHARS = 40;

/**
 * §35 挑中的范围超过一次能吃的条数：limit 就是这一次的上限，HTTP 层据此回 400 RANGE_TOO_LARGE。
 * 单独一个类（而不是一句错误文本），是为了让调用方不必去猜字符串。
 */
export class RangeTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super('RANGE_TOO_LARGE: ' + String(limit));
    this.name = 'RangeTooLargeError';
    this.limit = limit;
  }
}

/**
 * §35 预览行：`[YYYY-MM-DD HH:mm] 名字：正文前 40 字`（北京时间，与记忆行的时刻口径同源）。
 * 带年份是因为补记可以先挑去年的那一段；只有人看，绝不进提示词，所以不跟 withAuthorPrefix 的分支耦合。
 */
function previewLine(message: StoredMessage): string {
  const ms = Date.parse((message.createdAt ?? '').trim());
  const stamp = Number.isFinite(ms) ? formatTimestamp(ms) : '';
  const author = (message.author ?? '').trim();
  const name = author === '' ? (message.role === 'assistant' ? 'Bot' : '用户') : author;
  // 一行一条：正文里的换行会把样本撑成好几行，前端按行渲染就散了
  const body = message.content.replace(/\s+/g, ' ').trim();
  const excerpt = body.length > BACKFILL_SAMPLE_EXCERPT_CHARS ? body.slice(0, BACKFILL_SAMPLE_EXCERPT_CHARS) : body;
  return stamp + name + AUTHOR_SEPARATOR + excerpt;
}

/** 毫秒 → 北京时间 `[YYYY-MM-DD HH:mm]`（前缀里自带一个空格，没有时刻就整段不出现） */
function formatTimestamp(ms: number): string {
  const shifted = new Date(ms + STAMP_OFFSET_MINUTES * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date =
    String(shifted.getUTCFullYear()) + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate());
  return '[' + date + ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + '] ';
}

/** §35 预览样本：首尾各最多 3 条，去重后拼接；不足 6 条就整份给出 */
function previewSamples(rows: readonly StoredMessage[]): string[] {
  const picked =
    rows.length <= BACKFILL_SAMPLE_EDGE * 2
      ? rows.map(previewLine)
      : [...rows.slice(0, BACKFILL_SAMPLE_EDGE).map(previewLine), ...rows.slice(-BACKFILL_SAMPLE_EDGE).map(previewLine)];
  return [...new Set(picked)];
}

/**
 * 身份块：渲染完模板之后再硬追加一段「正在跟谁、在哪说话」。
 * 不能依赖管理员在提示词里写 {{user_name}} 才生效——提示词里写死的名字会让模型认错人。
 * 空字段整段省略（私聊不留「服务器：」空壳）；user_name 为空则整块不出现。
 */
export function buildIdentityBlock(ctx: TurnContext, date: string): string {
  // 拼装实现放在 prompt/defaults，后台 GET 的 codeDefaults.identity.rendered 复用同一份，逐字一致
  return formatIdentityBlock({
    userName: ctx.userName,
    userId: ctx.userId,
    guildName: ctx.guildName,
    channelName: ctx.channelName,
    date,
  });
}

/**
 * 身份块的分支：配了自定义模板就走通用逐行渲染，没配（null / 全空白）仍是今天这段代码。
 * 没配时必须逐字不变——后台没动过的实例，system 与加这一层之前一个字都不差。
 */
export function resolveIdentityBlock(ctx: TurnContext, date: string, template: string | null): string {
  if (template === null || template.trim() === '') return buildIdentityBlock(ctx, date);
  return renderIdentityTemplate(template, {
    bot_name: ctx.botName,
    user_name: ctx.userName,
    user_id: ctx.userId,
    guild_name: ctx.guildName,
    channel_name: ctx.channelName,
    date,
  });
}

/**
 * 一层提示词的渲染结果：system 段被摘要块劈成 before/after 两截，user 段整段落进 messages。
 * date 一并带出来，是因为身份块与段模板必须用同一个日期。
 */
export interface RenderedPrompt {
  before: string;
  after: string;
  /** 放在历史之前的 user 消息（role='user' 的段，按 position 升序） */
  userMessages: ChatMessage[];
  date: string;
}

/**
 * 挑出「开了、角色对、位置对」的段，按 position 升序渲染。
 * 段要过 renderTemplate（5 个变量）；渲染后空白的段整段跳过，否则会多出一截空行。
 */
function collectSegments(
  segments: readonly PromptSegment[],
  role: PromptRole,
  placement: PromptPlacement | null,
  vars: TemplateVars,
): string[] {
  const picked = segments.filter(
    (segment) => segment.enabled && segment.role === role && (placement === null || segment.placement === placement),
  );
  // filter 已建新数组，就地排序不会动调用方的顺序
  picked.sort((left, right) => left.position - right.position);
  const contents: string[] = [];
  for (const segment of picked) {
    const rendered = renderTemplate(segment.content, vars);
    if (rendered.trim() === '') continue;
    contents.push(rendered);
  }
  return contents;
}

/**
 * 装配一层提示词（§11）：system 段按 placement 分到摘要块前后，段间空行连接；
 * user 段不参与 system，整段变成历史之前的一条 user 消息。
 */
function buildPromptParts(cfg: PromptConfig, ctx: TurnContext): RenderedPrompt {
  const date = new Date().toISOString().slice(0, 10);
  const vars: TemplateVars = {
    bot_name: ctx.botName,
    user_name: ctx.userName,
    guild_name: ctx.guildName,
    channel_name: ctx.channelName,
    date,
  };
  return {
    before: collectSegments(cfg.segments, 'system', 'before', vars).join('\n\n'),
    after: collectSegments(cfg.segments, 'system', 'after', vars).join('\n\n'),
    userMessages: collectSegments(cfg.segments, 'user', null, vars).map((content): ChatMessage => ({ role: 'user', content })),
    date,
  };
}

/**
 * withAuthorPrefix 搬到了 ./line：摘要素材（summary.ts 的 formatTranscript）要和提示词共用同一份行格式化，
 * 放在 service.ts 里会让 summary.ts 反过来 import service.ts、成环。这里继续导出，老的导入位置不受影响。
 */
export { withAuthorPrefix };

/** 提示词里最多列多少个自定义表情：全服几百个表情会把 system 撑爆，模型也挑不过来 */
const MAX_EMOJI_IN_PROMPT = 40;

/**
 * 一个清单项的最终写法（§23.5 / §24.4）：`:名字:` + 描述 `(…)` + 别名 ` 别名「a、b」`。
 * 描述与别名 trim 后为空就各自不出现——没认过、没配别名的表情与 §18.5 逐字相同；
 * 这里不二次截断（截断只发生在认图产出侧，§23.3 的 DESCRIBE_MAX_CHARS）。
 * 两处必须逐字一致：表情模型与主模型看的是同一份清单，写法一分叉就会互相教坏。
 */
function withEmojiDescription(emoji: CustomEmoji): string {
  const token = ':' + emoji.name.trim() + ':';
  const descText = (emoji.description ?? '').trim();
  const aliasText = (emoji.aliases ?? [])
    .map((alias) => alias.trim())
    .filter((alias) => alias !== '')
    .join('、');
  const head = descText === '' ? token : token + '(' + descText + ')';
  return aliasText === '' ? head : head + ' 别名「' + aliasText + '」';
}

/**
 * 自定义表情清单：接在摘要块之后，模型才知道这服里有哪些 `:名字:` 可以贴。
 * 空数组或缺省返回空串，system 里不会留下一个空壳分段。
 */
export function renderEmojiBlock(customEmojis: CustomEmoji[] | undefined): string {
  if (customEmojis === undefined) return '';
  const names: string[] = [];
  // 去重仍按 `:名字:` 判：描述只是后缀，同名表情不能因为描述不同就列两遍（§23.5 规则不变）
  const seen = new Set<string>();
  for (const emoji of customEmojis) {
    const name = emoji.name.trim();
    if (name === '') continue;
    const token = ':' + name + ':';
    if (seen.has(token)) continue;
    seen.add(token);
    names.push(withEmojiDescription(emoji));
    if (names.length >= MAX_EMOJI_IN_PROMPT) break;
  }
  return names.length === 0 ? '' : '\n\n【可用自定义表情】\n' + names.join(' ');
}

/**
 * 表情规则块（§18.8 / §28.10）：无条件接在摘要块之后、自定义表情清单之前。
 * 只有清单是不够的——清单里只有名字、没有用法，模型不会自己猜到有 [[react:…]] 这种写法；
 * 缺了这一段，线上表现就是「清单在提示词里，但她从不贴表情」。
 *
 * 正文本身来自三层配置（channel > guild > global，整组覆盖）或内置默认，两条路径共用同一份；
 * 这里只管套上固定的【表情】小标题——标题属于渲染，不属于可配置文案。
 * trim 后为空就不出现这一段：调用方给的是一份「没有正文的配置」时，宁可不写也别写个空标题。
 */
export function renderReactionGuide(guide: string): string {
  const body = guide.trim();
  if (body === '') return '';
  return '\n\n【表情】\n' + body;
}

/**
 * 正文表情清单：只列 `:名字:`，不带 (描述) 与别名。
 * 描述是表情模型看图写的元描述，进剧情提示词只会污染叙述；正文侧知道有几个名字就够了。
 * 与 renderEmojiBlock 同口径：trim 空跳过、按 `:名字:` 去重、最多 MAX_EMOJI_IN_PROMPT 个。
 */
export function renderEmojiNames(customEmojis: CustomEmoji[] | undefined): string {
  if (customEmojis === undefined) return '';
  const names: string[] = [];
  const seen = new Set<string>();
  for (const emoji of customEmojis) {
    const name = emoji.name.trim();
    if (name === '') continue;
    const token = ':' + name + ':';
    if (seen.has(token)) continue;
    seen.add(token);
    names.push(token);
    if (names.length >= MAX_EMOJI_IN_PROMPT) break;
  }
  return names.length === 0 ? '' : '\n\n【可用自定义表情】\n' + names.join(' ');
}

/**
 * 正文表情提示段：接在自定义表情清单之后，只教「怎么在正文里用」，清单由 renderEmojiNames 出。
 * 与表情规则块同理：标题属于渲染，不属于可配置文案；trim 后为空就不出现这一段。
 */
export function renderBodyEmojiGuide(guide: string): string {
  const body = guide.trim();
  if (body === '') return '';
  return '\n\n【正文表情】\n' + body;
}

/**
 * 语音指令提示段：只在「按指令」模式（mode 1）出现，教模型 `[[voice]]` 这种写法。
 * 与表情规则块同理——光有开关不够，模型不会自己猜到有这一行可写，模式 1 就永远不会触发。
 * 为假时返回空串，普通消息的 system 与加这个字段之前逐字相同。
 */
export function renderVoiceHint(hint: boolean | undefined): string {
  if (hint !== true) return '';
  return '\n\n【语音】\n想让这条回复被念出来，就在正文里单独写一行 [[voice]]；不念就不要写。这一行不会显示给对方。';
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { prompts, routes, keys, conversations, providers, config } = deps;
  // 摘要存储是本轮新增的依赖：老调用方没接线时退化成「没有长期记忆」，不能把整轮对话拖失败
  const summaries: SummaryStore | undefined = deps.summaries;
  // 表情模型同样是可选依赖：没接线就一次都不问，与 §18 逐字一致
  const reactionModels: ReactionModelStore | undefined = deps.reactionModels;
  const now = deps.now ?? ((): Date => new Date());
  // 不接线也不炸（§19.6）；钩子是外部实现，真抛错也只能在 emit 里吞掉，绝不带崩回复链路
  const log = deps.log ?? ((): void => undefined);
  // 后台任务：缺省不 await、不冒泡；任务本身已在调用点挂过 catch，这里是双保险
  const background =
    deps.background ??
    ((task: Promise<unknown>): void => {
      void task.catch((error: unknown) => {
        console.warn('[chat] 后台任务失败：' + describeError(error));
      });
    });
  // 频道级记忆配置（§26）：没接线就一次都不查，取值退回 config / 代码默认
  const channelMemory: ChannelMemoryStore | undefined = deps.channelMemory;
  // 贴表情提示词三层配置（§28.10）：没接线就三层都当没有，直接用内置默认
  const reactionGuides: ReactionGuideStore | undefined = deps.reactionGuides;
  // 正文表情提示词三层配置：没接线就整段不渲染（连内置默认也不出现），行为与接线前逐字相同
  const bodyEmojiGuides: BodyEmojiGuideStore | undefined = deps.bodyEmojiGuides;
  // 表情模型素材模板三层配置（§34.4）：同样没接线就三层都当没有，直接用内置默认模板
  const reactionTemplates: ReactionTemplateStore | undefined = deps.reactionTemplates;
  // 两份可编辑兜底文案（§43）：没接线就一次都不查，行为与加这一层之前逐字相同
  const promptDefaults: PromptDefaultsStore | undefined = deps.promptDefaults;
  // 深度注入三层配置：没接线就一次都不查，messages 的构成与接线前逐字相同
  const promptInjections: PromptInjectionStore | undefined = deps.promptInjections;
  // 世界书三层配置：没接线就一次都不查，system 的构成与接线前逐字相同
  const worldBooks: WorldBookStore | undefined = deps.worldBooks;

  /**
   * 四个事件都从这里出去：createdAt 一律取注入的 now，测试才能断言固定时刻。
   * 写日志绝不影响业务（§19.1）：钩子抛错只落一行 console.warn，不冒泡、不回滚回复。
   */
  function emit(level: LogLevel, scope: LogScope, message: string): void {
    try {
      log({ level, scope, message, createdAt: now().toISOString() });
    } catch (error) {
      console.warn('[chat] 写日志失败：' + describeError(error));
    }
  }

  /**
   * 一次非流式摘要请求：三层路由（channel > guild > global）→ 候选模型（primary + fallbacks）→
   * 该供应商的每把 Key 轮试，第一个成功即用（§20.5）。
   * 自动总结与后台「选择性补记」共用这一条路径（§35）：入口可以多，模型看到的请求只有一份。
   */
  async function requestSummaryText(
    key: ChannelKey,
    previous: string,
    transcript: string,
  ): Promise<{ raw: string; model: string }> {
    const [channelRoute, guildRoute, globalRoute] = await Promise.all([
      routes.get({ scope: 'channel', scopeId: key.channelId }),
      routes.get({ scope: 'guild', scopeId: key.guildId }),
      routes.get({ scope: 'global', scopeId: '' }),
    ]);
    const routeHit = resolveRoute(channelRoute, guildRoute, globalRoute);
    if (!routeHit) throw new Error('NO_ROUTE_CONFIGURED');

    const attempts: TurnAttempt[] = [];
    const variants: ModelRef[] = [routeHit.cfg.primary, ...routeHit.cfg.fallbacks];

    let raw: string | null = null;
    let picked: ModelRef | null = null;
    for (const model of variants) {
      const all = await keys.listEnabled(model.provider);
      if (all.length === 0) {
        attempts.push({ model, error: 'NO_KEY_FOR_PROVIDER' });
        continue;
      }

      // 非流式：这个供应商的每把 Key 都试一遍，一把不行再换下一把（§20.5）
      let lastError: string | null = null;
      for (const decrypted of orderKeysForModel(all, model.model)) {
        try {
          // 摘要不需要流式：整段出来再落库，半截摘要没有意义
          const result = await providers[model.provider].chat(buildSummaryRequest(model, previous, transcript), {
            apiKey: decrypted.apiKey,
            baseUrl: decrypted.baseUrl,
            fetch: callGlobalFetch,
          });
          raw = result.text;
          picked = model;
          break;
        } catch (error) {
          lastError = describeError(error);
        }
      }

      if (picked !== null) break;
      // 候选模型失败只记**最后一把** Key 的原始错误（§20.5）
      if (lastError !== null) attempts.push({ model, error: lastError });
    }

    if (picked === null || raw === null) throw new Error('ALL_PROVIDERS_FAILED: ' + JSON.stringify(attempts));
    return { raw, model: picked.model };
  }

  /**
   * 一次摘要：只看游标之后那一批原文，产出一段新记忆追加到已有记忆尾部（老段不改写）。
   * 选取与读序是两件事，必须分开（§35.7）：
   * - **选取按 id**取最老的一批。游标是 id 水位线（`loadAfter` 的 `id > ?`），只有按 id 连续地吃，
   *   推进之后才不会留下「id 比游标小、可这一轮又没被总结」的死角。按时间挑前 limit 条就会留下死角：
   *   回灌进来的行 id 更大、时间更早，这批的最大 id 会越过时间序里排在后面的小 id 行，那些行永远进不了下一轮。
   * - **送给模型时按 created_at 重排**。id 序读出来是倒的，模型得按说话的先后看这段对话。
   * 游标只推进到已落库这批的最大 id——extra 里本轮这条还没写进库，推过去会让它永远进不了下一次总结。
   */
  async function summarizeCore(
    key: ChannelKey,
    options: { extra: SummaryLine[]; skipWhenEmpty: boolean; batchLimit?: number },
  ): Promise<SummaryOutcome | null> {
    const store = summaries;
    if (store === undefined) return null;
    const limit = options.batchLimit ?? SUMMARY_MAX_INPUT_MESSAGES;

    const current = await store.get(key);
    const cursor = current?.coveredUntilId ?? 0;
    const pending = await conversations.loadAfter(key, cursor);
    // 频道刚开张：没有原文也没有旧摘要，为一句「你好」多花一次调用没有意义
    if (options.skipWhenEmpty && pending.length === 0 && current === null) return null;

    // 选区落在游标域里：按 id 升序取最老的一批，游标才能连续推进、一条不漏
    const byId = pending.slice().sort((a, b) => a.id - b.id);
    const chosen = byId.slice(0, limit);
    const material = summaryMaterial(chosen, options.extra, limit);
    if (material.length === 0) return null;

    // 送模型前才重排成时间序：读起来是这段对话的先后，跟选取口径无关
    const ordered = orderSummaryMaterial(material, chosen);
    const transcript = formatTranscript(ordered);
    const previous = current?.summary ?? '';
    const { raw, model } = await requestSummaryText(key, previous, transcript);

    const segment = normalizeSummary(raw);
    // 空摘要不能落库：一条空记忆会把游标推过去，那批原文就再也总结不回来了
    if (segment === '') throw new Error('SUMMARY_EMPTY');

    // 游标 = 这批已落库行的最大 id（chosen 已按 id 升序，取最大等价于取末条）：
    // extra 没落库，绝不能算进去——推过去它就再也进不了下一次总结。空批回落成游标不动。
    const coveredUntilId = chosen.reduce((max, message) => (message.id > max ? message.id : max), cursor);
    // 这一批的最早/最晚落库时刻：取时间序的首末行；库里的 coveredFrom/coveredTo 再与上一版合并成一条连续区间
    const firstAt = ordered[0]?.createdAt;
    const lastAt = ordered[ordered.length - 1]?.createdAt;
    // 段头写的是**这一批**的时刻：累了很多段以后，外层再压一个总区间反而让每段都读不出自己的时间
    const summary = appendSegment(previous, segment, firstAt, lastAt);
    await store.put({
      guildId: key.guildId,
      channelId: key.channelId,
      summary,
      coveredUntilId,
      coveredFrom: earlierIso(current?.coveredFrom, firstAt),
      coveredTo: laterIso(current?.coveredTo, lastAt),
      updatedAt: new Date().toISOString(),
    });
    return { summary, coveredUntilId, summarizedMessages: material.length, model };
  }

  /** 一批摘要 + 两条日志：单批上限由调用方给，自动路径复用 run 已解析好的值，不重复读频道行 */
  async function summarizeBatch(key: ChannelKey, batchLimit: number): Promise<SummaryOutcome | null> {
    const outcome = await summarizeCore(key, { extra: [], skipWhenEmpty: false, batchLimit });
    if (outcome !== null) {
      console.log(
        '[chat] 自动摘要完成 covered=' + String(outcome.coveredUntilId) +
        ' msgs=' + String(outcome.summarizedMessages) +
        ' len=' + String(outcome.summary.length),
      );
      emit(
        'info',
        'summary',
        '自动摘要完成 covered=' + String(outcome.coveredUntilId) +
        ' msgs=' + String(outcome.summarizedMessages) +
        ' len=' + String(outcome.summary.length),
      );
    }
    return outcome;
  }

  /** 手动 /summary：单批上限与自动路径同一口径（频道行 > config > 默认 50） */
  async function summarize(key: ChannelKey): Promise<SummaryOutcome | null> {
    const settings = await readChannelMemory(key);
    const { summaryEveryMessages } = resolveTurnMemory(settings, config);
    return summarizeBatch(key, summaryBatchLimit(summaryEveryMessages));
  }

  /**
   * §63 后台「连续总结」一批：固定吃满安全上限（500 条），不读频道阈值——
   * 管理员点这个按钮就是为了追平积压，一次 500 条、没完前端接着发下一批。
   * remaining 现算：summarizeCore 已经把游标推到这批的最后一条，所以这个数就是下一批能吃的量，
   * 不会把本批重复算进去；前端只认它，剩 0 才停手。
   */
  async function summarizeSweep(key: ChannelKey): Promise<SummarySweepOutcome> {
    const outcome = await summarizeBatch(key, SUMMARY_BATCH_SAFE_MAX);
    const current = summaries === undefined ? null : await summaries.get(key);
    const pending = await conversations.loadAfter(key, current?.coveredUntilId ?? 0);
    const remaining = pending.length;
    if (outcome !== null) {
      emit(
        'info',
        'summary',
        '连续总结 covered=' + String(outcome.coveredUntilId) +
        ' msgs=' + String(outcome.summarizedMessages) +
        ' 剩余=' + String(remaining),
      );
    }
    return { outcome, remaining };
  }

  /**
   * §35 后台「选择性补记」预览：只数条数、给首尾几条样本。
   * summaries 没接线也能用——这一步一次都不碰摘要存储，也不会花掉一次模型调用。
   */
  async function previewBackfill(key: ChannelKey, range: TimeRange): Promise<BackfillPreview> {
    // 多要一条就够判超额：501 与 50000 条对预览是同一件事，没必要把整段读进来
    const rows = await conversations.loadBetween(key, range.from, range.to, BACKFILL_PROBE_LIMIT);
    const preview: BackfillPreview = {
      count: rows.length,
      tooLarge: rows.length > SUMMARY_BATCH_SAFE_MAX,
      samples: previewSamples(rows),
    };
    const first = rows[0]?.createdAt;
    const last = rows[rows.length - 1]?.createdAt;
    if (first !== undefined) preview.firstAt = first;
    if (last !== undefined) preview.lastAt = last;
    return preview;
  }

  /**
   * §35 后台「选择性补记」：把挑中的那段历史压成**一段新记忆**追加到该频道记忆尾部。
   * 三条铁律：素材与提示词跟自动总结同源（requestSummaryText）；段头写这段自己的起止时刻；
   * 游标与 coveredFrom/coveredTo 一律不动——补记是往回补，不该让自动总结以为这段已经总结过了。
   */
  async function backfill(key: ChannelKey, range: TimeRange): Promise<BackfillOutcome | null> {
    const store = summaries;
    if (store === undefined) return null;

    const rows = await conversations.loadBetween(key, range.from, range.to, BACKFILL_PROBE_LIMIT);
    if (rows.length === 0) return null;
    // 超上限不截断也不分批：截断会悄悄丢掉管理员挑的后半段，分批则会让一段记忆分成好几段
    if (rows.length > SUMMARY_BATCH_SAFE_MAX) throw new RangeTooLargeError(SUMMARY_BATCH_SAFE_MAX);

    const transcript = formatTranscript(rows);
    const current = await store.get(key);
    const { raw, model } = await requestSummaryText(key, current?.summary ?? '', transcript);

    const segment = normalizeSummary(raw);
    // 空补记同样不能落库：多一个空段只是让下次注入白花预算
    if (segment === '') throw new Error('SUMMARY_EMPTY');

    const firstAt = rows[0]?.createdAt;
    const lastAt = rows[rows.length - 1]?.createdAt;
    const summary = appendSegment(current?.summary ?? '', segment, firstAt, lastAt);
    await store.put({
      guildId: key.guildId,
      channelId: key.channelId,
      summary,
      // 游标原地不动：补记的这段未必接着游标之后，推过去就是永久跳过一批原文
      coveredUntilId: current?.coveredUntilId ?? 0,
      coveredFrom: current?.coveredFrom,
      coveredTo: current?.coveredTo,
      updatedAt: now().toISOString(),
    });
    console.log(
      '[chat] 补记完成 from=' + range.from + ' to=' + range.to +
      ' msgs=' + String(rows.length) +
      ' len=' + String(summary.length),
    );
    emit(
      'info',
      'summary',
      '[chat] 补记完成 msgs=' + String(rows.length) +
      ' len=' + String(summary.length) +
      ' model=' + model,
    );
    return { summarizedMessages: rows.length, from: range.from, to: range.to, summaryLength: summary.length, model };
  }

  /** 读摘要注入 system：读失败只降级成「没有长期记忆」，绝不让这一轮回复失败 */
  async function readSummary(key: ChannelKey): Promise<ConversationSummary | null> {
    if (summaries === undefined) return null;
    try {
      return await summaries.get(key);
    } catch (error) {
      console.warn('[chat] 读取摘要失败，按无摘要继续：' + describeError(error));
      return null;
    }
  }

  /**
   * 频道级记忆配置（§26.3）：读失败只降级成「按默认走」，绝不让这一轮回复失败。
   * 没接线时不发这次查询，行为与 §26 之前逐字一致。
   */
  async function readChannelMemory(key: ChannelKey): Promise<ChannelMemoryConfig | null> {
    if (channelMemory === undefined) return null;
    try {
      return await channelMemory.get(key);
    } catch (error) {
      console.warn('[chat] 读取频道记忆配置失败，按默认继续：' + describeError(error));
      return null;
    }
  }

  /**
   * 一层贴表情提示词（§28.10）：读失败只当这一层没有、落回上一层，绝不让这一轮回复失败。
   * 没接线时不发这次查询，行为与接线前逐字一致。
   */
  async function readReactionGuide(scope: Scope, scopeId: string): Promise<ReactionGuideConfig | null> {
    if (reactionGuides === undefined) return null;
    try {
      return await reactionGuides.get({ scope, scopeId });
    } catch (error) {
      console.warn('[chat] 读取贴表情提示词失败，按上层继续：' + describeError(error));
      return null;
    }
  }

  /**
   * 一层正文表情提示词：读失败只当这一层没有、落回上一层，绝不让这一轮回复失败。
   * 没接线时不发这次查询，行为与接线前逐字一致。
   */
  async function readBodyEmojiGuide(scope: Scope, scopeId: string): Promise<BodyEmojiGuideConfig | null> {
    if (bodyEmojiGuides === undefined) return null;
    try {
      return await bodyEmojiGuides.get({ scope, scopeId });
    } catch (error) {
      console.warn('[chat] 读取正文表情提示词失败，按上层继续：' + describeError(error));
      return null;
    }
  }

  /**
   * 一层素材模板（§34.4）：读失败只当这一层没有、落回上一层，绝不让这一轮回复失败。
   * 没接线时不发这次查询，行为与接线前逐字一致。
   */
  async function readReactionTemplate(scope: Scope, scopeId: string): Promise<ReactionTemplateConfig | null> {
    if (reactionTemplates === undefined) return null;
    try {
      return await reactionTemplates.get({ scope, scopeId });
    } catch (error) {
      console.warn('[chat] 读取表情素材模板失败，按上层继续：' + describeError(error));
      return null;
    }
  }

  /**
   * 一层世界书：读失败只当这一层没有、落回上一层，绝不让这一轮回复失败。
   * 没接线时不发这次查询，system 与接线前逐字一致。
   */
  async function readWorldBook(scope: Scope, scopeId: string): Promise<WorldBookRecord | null> {
    if (worldBooks === undefined) return null;
    try {
      return await worldBooks.get({ scope, scopeId });
    } catch (error) {
      console.warn('[chat] 读取世界书失败，按上层继续：' + describeError(error));
      return null;
    }
  }

  /**
   * 一层深度注入：读失败只当这一层没有、落回上一层，绝不让这一轮回复失败。
   * 没接线时不发这次查询，行为与接线前逐字一致。
   */
  async function readInjection(scope: Scope, scopeId: string): Promise<PromptInjectionConfig | null> {
    if (promptInjections === undefined) return null;
    try {
      return await promptInjections.get({ scope, scopeId });
    } catch (error) {
      console.warn('[chat] 读取深度注入失败，按上层继续：' + describeError(error));
      return null;
    }
  }

  /**
   * 攒够阈值条游标之后的原文就触发一次后台大总结；一次触发会循环追平，
   * 直到剩余待总结 < 阈值——单批上限跟着阈值走，积压到两倍阈值才跑第二轮（§26 追加语义）。
   * 只 await 一次廉价计数查询；摘要本体丢进 background，失败就地吞掉——回复路径不承担摘要风险。
   */
  async function maybeSummarize(
    key: ChannelKey,
    current: ConversationSummary | null,
    summaryEveryMessages: number,
  ): Promise<void> {
    // §26.3：阈值 <= 0 = 关闭自动总结；手动 /summary 与后台「重新总结」走 summarize()，不受影响
    if (summaryEveryMessages <= 0) return;
    if (summaries === undefined) return;
    try {
      const cursor = current?.coveredUntilId ?? 0;
      const pending = await conversations.loadAfter(key, cursor, summaryEveryMessages);
      if (pending.length < summaryEveryMessages) return;
      const batchLimit = summaryBatchLimit(summaryEveryMessages);
      // 单批最多 500 条，阈值更大时这里会连着跑几轮，直到积压 < 阈值
      // （§26 追加语义）。整段循环一个 try/catch，失败只 warn 一次就收手：
      // 不重试、不让回复路径承担摘要风险，task 也不会以拒绝态交给 background。
      const task = (async (): Promise<void> => {
        let covered = cursor;
        let remaining = pending.length;
        let batches = 0;
        try {
          while (remaining >= summaryEveryMessages) {
            const outcome = await summarizeBatch(key, batchLimit);
            // 没有可总结内容：再转一圈也还是 null
            if (outcome === null) break;
            // 上游没推进游标（摘要没落库成功等）就立刻收手：这是唯一的死循环入口
            if (outcome.coveredUntilId <= covered) break;
            covered = outcome.coveredUntilId;
            batches += 1;
            const rest = await conversations.loadAfter(key, covered, summaryEveryMessages);
            remaining = rest.length;
          }
        } catch (error) {
          console.warn('[chat] 自动摘要失败：' + describeError(error));
          emit('warn', 'summary', '自动摘要失败 ' + describeError(error).slice(0, LOG_ERROR_MAX_CHARS));
          return;
        }
        // 追平常态是一批到底，只有真追平了才留一行痕迹，免得多批时无从判断跑了几次
        if (batches > 1) {
          console.log('[chat] 自动摘要追平 batches=' + String(batches) + ' covered=' + String(covered));
        }
      })();
      background(task);
    } catch (error) {
      console.warn('[chat] 自动摘要触发失败（不影响回复）：' + describeError(error));
    }
  }

  /**
   * 合并主模型与表情模型的表情（§21.4 Q3-B / §28.6）：主模型的排前面、按 `表情|目标` 去重保序，
   * 上限仍是 MAX_REACTIONS。上限在合并之后判：两个来源各自都能给 10 个，但一条消息最多贴 10 个。
   * 去重键与 §28.3 同源（reactionKey）：同一个表情贴到不同目标是两条，不能互相吃掉。
   */
  function mergeReactions(primary: readonly ReactionRequest[], extra: readonly ReactionRequest[]): ReactionRequest[] {
    const merged: ReactionRequest[] = [];
    const keys = new Set<string>();
    for (const request of [...primary, ...extra]) {
      if (merged.length >= MAX_REACTIONS) break;
      const key = reactionKey(request);
      if (keys.has(key)) continue;
      keys.add(key);
      merged.push(request);
    }
    return merged;
  }

/**
   * 日志里的一条表情（§28.6）：`😄`、`😄@<消息ID>`、`😄@<作者名>`。目标必须看得见，
   * 否则线上只看到「贴了 🔥」，查不出这一条到底贴到哪去了。
   */
  function describeReactions(values: readonly ReactionRequest[]): string {
    const parts: string[] = [];
    for (const value of values) {
      const target = value.messageId ?? value.authorName;
      parts.push(target === undefined ? value.emoji : value.emoji + '@' + target);
    }
    return parts.join(',');
  }

  /**
   * 本轮可看的图片（§22.6）：一次性 memo —— 主对话与表情模型共用同一份结果，一轮只下载一次。
   * 没接线当作没有图；读图失败也只是少看几张图——按「没有图」继续，绝不吃掉这一轮回复。
   */
  function turnImages(ctx: TurnContext): () => Promise<LlmImage[]> {
    let cached: Promise<LlmImage[]> | undefined;
    return (): Promise<LlmImage[]> => {
      cached ??= loadTurnImages(ctx);
      return cached;
    };
  }

  /** memo 背后真正的取图：任何异常都吞成空数组，绝不让这条回复失败 */
  async function loadTurnImages(ctx: TurnContext): Promise<LlmImage[]> {
    if (ctx.loadImages === undefined) return [];
    try {
      return await ctx.loadImages();
    } catch (error) {
      console.warn('[chat] 读取图片失败，按无图继续：' + describeError(error));
      return [];
    }
  }

  /**
   * 三层兜底文案各读一次（channel > guild > global），三条 SELECT 并行发。
   * 没接线或某一层读库失败都只当「那一层没配」，读兜底提示词失败绝不能把这一轮回复弄失败
   * ——与摘要、频道记忆的容错口径一致。
   */
  async function readPromptDefaults(channelId: string, guildId: string): Promise<PromptDefaults> {
    const empty: PromptDefaultsScope = { fallback: null, identity: null };
    const store = promptDefaults;
    if (store === undefined) return { channel: empty, guild: empty, global: empty };

    const readLayer = async (scope: Scope, scopeId: string): Promise<PromptDefaultsScope> => {
      try {
        return await store.get({ scope, scopeId });
      } catch (error) {
        console.warn('[chat] 读取兜底提示词失败，按未配置继续：' + describeError(error));
        return { fallback: null, identity: null };
      }
    };
    const [channel, guild, global] = await Promise.all([
      readLayer('channel', channelId),
      readLayer('guild', guildId),
      readLayer('global', ''),
    ]);
    return { channel, guild, global };
  }

  /**
   * 问一次表情模型（§21.4）：逐把 Key 试非流式 chat，回不来或不贴都返回空数组。本函数只 warn，从不抛错。
   * §28.5：模型可以一次给多行，解析交给 normalizeReactions；可贴的候选消息由 reactionTargets 带进提示词。
   */
  async function askReactionModel(
    cfg: ReactionModelConfig,
    ctx: TurnContext,
    botReply: string,
    guide: ResolvedReactionGuide,
    template: ResolvedReactionTemplate,
    history: readonly string[],
    loadImages: () => Promise<LlmImage[]>,
  ): Promise<ReactionRequest[]> {
    const startedAt = Date.now();
    const all = await keys.listEnabled(cfg.provider);
    if (all.length === 0) {
      console.warn('[chat] 表情模型没有可用 Key');
      return [];
    }

    // §22.6：同一个 turn 级 memo——主对话已经下过的那几张，这里直接复用，不新增下载通路
    const images = await loadImages();

    const request = buildReactionRequest(cfg, {
      userText: ctx.userText,
      botReply,
      // 与主模型 system 里那一段同源（§28.10）：两条路径共用同一份可自定义文案
      guide: guide.prompt,
      // 素材这一段完全由模板决定（§34.3）：历史行也从这里进，段序不再写死在代码里
      template: template.template,
      history,
      customEmojis: ctx.customEmojis,
      images,
      targets: ctx.reactionTargets,
    });

    // 表情模型没有 fallbacks（§21.8）：换成同一供应商的另一把 Key 就够了，模型挂了这轮就是不贴
    let lastError: string | null = null;
    for (const decrypted of orderKeysForModel(all, cfg.model)) {
      try {
        // 非流式：只要一个表情，流式只是多几次往返与半截输出的麻烦
        const result = await providers[cfg.provider].chat(request, {
          apiKey: decrypted.apiKey,
          baseUrl: decrypted.baseUrl,
          fetch: callGlobalFetch,
        });
        const values = normalizeReactions(result.text);
        if (values.length === 0) return [];
        // §21.4 要求成功记 info：日志里有模型、选中的表情与耗时，线上才能回答「这轮为什么不贴」。
        // §22.6 再补这次真发出去的张数，0 张也写：否则「没图」和「读图失败」在日志里长得一样
        emit(
          'info',
          'chat',
          '表情选择 model=' + cfg.provider + '/' + cfg.model +
          ' value=' + describeReactions(values) +
          ' ms=' + String(Date.now() - startedAt) +
          ' images=' + String(images.length) +
          ' guide=' + guide.scope +
          ' template=' + template.scope,
        );
        return values;
      } catch (error) {
        lastError = describeError(error);
      }
    }

    console.warn('[chat] 表情选择失败：' + (lastError ?? 'NO_KEY'));
    return [];
  }

  /**
   * 表情选择的总闸门（§21.4）：没接线、没配置、没启用都直接跳过。
   * 整段包在 try 里——读配置的仓储自己也可能抛错，而这一步在任何情况下都不许把这一轮回复带崩。
   */
  async function selectReaction(
    ctx: TurnContext,
    botReply: string,
    guide: ResolvedReactionGuide,
    template: ResolvedReactionTemplate,
    history: readonly string[],
    loadImages: () => Promise<LlmImage[]>,
  ): Promise<ReactionRequest[]> {
    if (reactionModels === undefined) return [];
    try {
      const cfg = await reactionModels.get();
      // 未配置 / 未启用 = 只剩主模型自己的 [[react:]]，行为与 §18 逐字一致
      if (cfg === null || cfg.enabled !== true) return [];
      return await askReactionModel(cfg, ctx, botReply, guide, template, history, loadImages);
    } catch (error) {
      console.warn('[chat] 表情选择失败：' + describeError(error));
      return [];
    }
  }

  async function run(ctx: TurnContext, events?: TurnEvents): Promise<TurnResult> {
    const key = { guildId: ctx.guildId, channelId: ctx.channelId };
    // §22.6 本轮图片只取一次：主对话与表情模型共用这一个 memo，读图失败一律当「没有图」
    const loadTurnImagesOnce = turnImages(ctx);

    // 摘要、频道记忆配置、三层贴表情提示词、三层素材模板与三层深度注入并行查：多这几趟读库不增加回复延迟
    const [
      channelPrompt,
      guildPrompt,
      globalPrompt,
      channelRoute,
      guildRoute,
      globalRoute,
      summary,
      memorySettings,
      channelGuide,
      guildGuide,
      globalGuide,
      channelBodyEmoji,
      guildBodyEmoji,
      globalBodyEmoji,
      channelTemplate,
      guildTemplate,
      globalTemplate,
      defaults,
      channelInjection,
      guildInjection,
      globalInjection,
      channelWorldBook,
      guildWorldBook,
      globalWorldBook,
    ] = await Promise.all([
      prompts.get({ scope: 'channel', scopeId: ctx.channelId }),
      prompts.get({ scope: 'guild', scopeId: ctx.guildId }),
      prompts.get({ scope: 'global', scopeId: '' }),
      routes.get({ scope: 'channel', scopeId: ctx.channelId }),
      routes.get({ scope: 'guild', scopeId: ctx.guildId }),
      routes.get({ scope: 'global', scopeId: '' }),
      readSummary(key),
      readChannelMemory(key),
      readReactionGuide('channel', ctx.channelId),
      readReactionGuide('guild', ctx.guildId),
      readReactionGuide('global', ''),
      readBodyEmojiGuide('channel', ctx.channelId),
      readBodyEmojiGuide('guild', ctx.guildId),
      readBodyEmojiGuide('global', ''),
      readReactionTemplate('channel', ctx.channelId),
      readReactionTemplate('guild', ctx.guildId),
      readReactionTemplate('global', ''),
      readPromptDefaults(ctx.channelId, ctx.guildId),
      readInjection('channel', ctx.channelId),
      readInjection('guild', ctx.guildId),
      readInjection('global', ''),
      readWorldBook('channel', ctx.channelId),
      readWorldBook('guild', ctx.guildId),
      readWorldBook('global', ''),
    ]);

    // 本轮真正生效的三个数字：频道行 > config > 代码默认；sum = 0 表示这一轮不自动总结
    const { historyMaxMessages, summaryEveryMessages, summaryMaxChars } = resolveTurnMemory(memorySettings, config);
    // §55 上下文工具模式：只有频道行显式点名才进；缺省（含老行没有这个字段）走老形状，请求与日志逐字不变
    const contextToolMode = memorySettings?.contextTool === true;

    // 第四层是后台可编辑的「内置默认」，本身也分层 channel > guild > global；
    // 三层都没有才回落到代码里的 DEFAULT_PROMPT（§43）
    const fallback = resolveFallbackPrompt(
      defaults.channel.fallback?.content ?? null,
      defaults.guild.fallback?.content ?? null,
      defaults.global.fallback?.content ?? null,
    );
    const promptHit = resolvePrompt(channelPrompt, guildPrompt, globalPrompt, fallback) ?? FALLBACK_HIT;
    // 三层整组覆盖（§28.10）：命中哪层整份用哪层，三层都没有就用内置默认（scope 记 global）
    const guide = resolveReactionGuide(channelGuide, guildGuide, globalGuide);
    // 正文表情提示词同样是三层整组覆盖：接了仓储才渲染，没接线时整段不出现（连内置默认也不出现）
    const bodyEmojiGuide =
      bodyEmojiGuides === undefined
        ? null
        : resolveBodyEmojiGuide(channelBodyEmoji, guildBodyEmoji, globalBodyEmoji);
    const bodyEmojiPart = bodyEmojiGuide === null ? '' : renderBodyEmojiGuide(bodyEmojiGuide.prompt);
    // 正文表情整组（清单 + 规则）只在规则非空时才出现：空配置就是「没开」，一个字都不加。
    // names-only 只用于 context 描述体：清单里只列名字（renderEmojiNames）——认图描述是表情模型写的元叙述，进剧情会污染叙述；
    // 普通模式（legacySystem）仍用 renderEmojiBlock 带描述与别名，那是既有的挑表情行为，不动基线。
    const bodyEmojiSection = bodyEmojiPart === '' ? '' : renderEmojiNames(ctx.customEmojis) + bodyEmojiPart;
    // 素材模板同样是三层整组覆盖（§34.4）：命中哪层就整份照那一层渲染
    const template = resolveReactionTemplate(channelTemplate, guildTemplate, globalTemplate);
    // 深度注入（channel > guild > global）：空正文的那一层等于关着，三层都空 / 都没配就什么都不插
    const injection = resolveInjection(channelInjection, guildInjection, globalInjection);
    // 世界书同样是三层整本覆盖（channel > guild > global）：命中哪层就整本用哪层，不做条目级合并
    const worldBookHit: WorldBookRecord | null = resolveWorldBook(channelWorldBook, guildWorldBook, globalWorldBook);
    const routeHit = resolveRoute(channelRoute, guildRoute, globalRoute);
    if (!routeHit) throw new Error('NO_ROUTE_CONFIGURED');
    const route = routeHit.cfg;

    // 一条消息只调一次模型，system = 预设段 → 平台元信息 → 世界书 → 收尾段（after）。
    // 预设段压在最前：模型从天头起就先读人设，平台元信息（身份块 → 提及规则 → 表情规则块 →
    // 语音提示段 → 自定义表情清单 → 可贴表情的消息）排在它后面，结尾停在预设的 after 段上。
    // 长期记忆摘要不进 system，改为拼进本轮那条用户消息（见下面的 summaryBlock）。
    // （§28.6 / §28.10；清单与目标清单为空时各自整段不出现，规则块正文来自三层配置；
    //   语音提示段只在模式 1 出现，其余模式下整段不出现）
    const promptParts = buildPromptParts(promptHit.cfg, ctx);
    // 「已经 @ 过谁」只在服务器频道成立：私聊不加开头前缀，也就没有这一条口径可言
    const mentionSeed = ctx.guildId !== '' && ctx.userId !== '' ? [ctx.userId] : [];
    const mentionRule = mentionSeed.length === 0 ? '' : renderMentionRule();
    // 有预设段时不再追加身份块（§52）：预设里的角色卡已经交代了「我是谁、这是谁在说话」，
    // 再叠一层平台口吻的身份行，等于把对话拽回「你在某个聊天平台上当机器人」。
    // 预设为空时它照旧兜底——那时主模型除了这几行没有任何来历（身份块仍可分层、仍走同一份模板）。
    const identityBlock =
      promptParts.before === ''
        ? resolveIdentityBlock(
            ctx,
            promptParts.date,
            pickScopedTemplate(
              defaults.channel.identity?.content ?? null,
              defaults.guild.identity?.content ?? null,
              defaults.global.identity?.content ?? null,
            ),
          )
        : '';
    // 库里永久保留全部历史；注入侧只由条数决定，更早的内容由累积记忆兜底（§31）。
    // 世界书要按「最近几条原文」判触发，所以历史比 system 早读一步
    const history = await conversations.loadAll(key);
    const tail = tailMessages(history, historyMaxMessages);
    // 名字前缀照旧拼上；当前这一轮同样署名
    // 上一轮的拒答会把这一轮继续拽向拒答（§61）：装配前滤掉，库里的正文不动
    const kept = dropRefusalHistory(tail.kept).map(withAuthorPrefix);
    // 扫描窗口取未署名的原文：带头上的「时刻+作者名」会让拿人名当关键词的条目每轮必中
    const worldWindow = [...tail.kept, { role: 'user', content: ctx.userText }];
    // 命中的那本书按关键词选条目再合成一段；没书 / 一条没中时是空串，system 与旧版逐字相同
    const worldBlock = worldBookHit === null ? '' : buildWorldBlock(selectWorldEntries(worldBookHit.book, worldWindow));
    // 段自带「【世界书】」标题且不带换行：这里补两个换行，才不贴在前置段末尾、也不挤进身份块的标题行
    const worldPart = worldBlock === '' ? '' : '\n\n' + worldBlock;
    // 预设段又回到天头（§52）：它自己不带前导空行，用两个换行和后面的平台元信息分开
    const presetHead = promptParts.before === '' ? '' : promptParts.before + '\n\n';
    const presetAfter = promptParts.after === '' ? '' : '\n\n' + promptParts.after;
    // 身份块自带两个前导换行（当年当天头时的分隔约定）；只有预设为空、它真出现在天头时才需要削掉
    const legacySystem =
      presetHead +
      identityBlock.replace(/^\n+/, '') +
      mentionRule +
      renderReactionGuide(guide.prompt) +
      renderVoiceHint(ctx.voiceHint) +
      renderEmojiBlock(ctx.customEmojis) +
      bodyEmojiPart +
      renderReactionTargets(ctx.reactionTargets) +
      worldPart +
      presetAfter;
    // §55：这一模式不发任何平台元信息——预设正文、摘要与历史整体搬进 context 工具的描述，
    // system 只留那一句「正文在哪、怎么交付」，线上形状与酒馆那条重放一致
    const system = contextToolMode ? CONTEXT_TOOL_SYSTEM : legacySystem;
    // 工具定义只跟着 system 走：预设点名 story_reply 才有一条，其余频道是空数组（请求体里连键都没有）
    const tools = replyToolsFor(system);
    // 空工具集连键都不放：请求对象与加这一层之前逐字相同（不是 tools: []）
    const toolFields: Pick<LlmRequest, 'tools' | 'toolChoice'> =
      tools.length > 0 ? { tools, toolChoice: 'auto' } : {};
    // 记忆块跟着本轮用户消息一起发（§52）：它说的是「过去的对话」，不该冒充 system 指令。
    // 空摘要返回空串，这一轮的消息与旧版逐字相同
    const summaryBlock = renderSummaryBlock(summary?.summary ?? '', summaryMaxChars);
    // 表情模型的最近对话（§34.1）：kept 是历史（不含本轮），末尾就是最新的那几条。
    // 行样式复用摘要那份 formatTranscript，自己那几行同样署名，模型才分得清谁说的
    const reactionHistory: string[] = tail.kept
      .slice(-REACTION_HISTORY_MESSAGES)
      .map((message) => formatTranscript([message]));
    const droppedCount = tail.droppedCount;
    // 本轮这条也要时刻：库里写的和提示词里拼的必须是同一个值，否则同一句话两处时间不一致
    const turnIso = now().toISOString();
    const turnUser: ChatMessage = {
      role: 'user',
      content: ctx.userText,
      author: ctx.userName,
      authorId: ctx.userId,
      createdAt: turnIso,
    };
    // 有回复目标才带这个键：非回复消息的提示词行与旧版逐字一致
    if (ctx.replyTo !== undefined) turnUser.replyTo = ctx.replyTo;
    // 记忆块拼在本轮这条消息的开头：一条 user 消息里先旧记忆、后这一句，署名与时刻仍在最后一行
    const turnPrompt: ChatMessage = withAuthorPrefix(turnUser);
    // §55：记忆块在这一模式里已经进了 context 的描述，不再挤进这条 user 消息
    if (!contextToolMode && summaryBlock !== '')
      turnPrompt.content = summaryBlock.replace(/^\n+/, '') + '\n\n' + turnPrompt.content;
    // role='user' 的段排在历史之前：它们是这一轮额外夹带进去的指令，不是对话内容。
    // 深度注入插在倒数第 depth 条之前；没有注入时 withInjection 原样返回同一个数组
    // §55：上下文工具模式顶层只发一句固定的「请继续」，用户原话（时刻+名字+正文）进描述体最后一段——
    // 线上实测把用户原话当顶层 user 会触发拒答，同一份内容藏进工具描述就进角色。
    // 历史与摘要同理都已经在描述里，一条都不再进 messages
    const messages: ChatMessage[] = contextToolMode
      ? [{ role: 'user', content: CONTEXT_TOOL_TURN }]
      : withInjection([...promptParts.userMessages, ...kept, turnPrompt], injection);
    // §55 描述体 = 预设段（before 再 after，保持原顺序）+ 世界书 + 长期记忆摘要 + 最近历史（署名行，一行一条）
    // + 本轮用户那一行（时刻 + 名字 + 正文，原样，放在最后一段）。
    // 世界书命中才有一段，所以没书时描述体与接线前逐字相同；位置在记忆之前——设定先立、记忆后叙（§65）
    // 历史按 8000 字裁：historyMaxMessages 可以设到上千条，描述体不能跟着涨成十万字；
    // 两个工具定义在这里一次建好：候选循环里换 Key 不该重建这两万字的描述
    const contextBody = contextToolMode
      ? composeContextBody([
          promptParts.before,
          promptParts.after,
          worldBlock,
          // 正文侧的自定义表情清单 + 正文表情规则合成一段：规则为空时整段是空串，会被 composeContextBody 滤掉
          bodyEmojiSection,
          summaryBlock.replace(/^\n+/, ''),
          // 署名行本身就是完整的一行（时刻 + 名字 + 正文），拼描述时只取正文里那一行；
          // 套 <recent>：与上面的 <recall> 分开，模型才不会把旧台词当这一轮的输入
          taggedHistory(budgetedHistory(kept.map((message) => message.content))),
          // 本轮这句话不再当顶层 user 发，而是藏进描述体：模型读到的是「设定里的下一句」
          turnPrompt.content,
        ])
      : '';
    const contextToolFields: Pick<LlmRequest, 'tools' | 'toolChoice'> = contextToolMode
      ? { tools: buildContextTools(contextBody), toolChoice: 'auto' }
      : {};
    // §59 补交付回合：模型只调了 context 就收尾时，改用「上下文进 system、只留回复工具」再问一次
    const contextReplyFields: Pick<LlmRequest, 'tools' | 'toolChoice'> = contextToolMode
      ? { tools: replyOnlyTools(), toolChoice: 'auto' }
      : {};
    const contextReplySystem = contextToolMode ? CONTEXT_REPLY_SYSTEM_PREFIX + contextBody : '';
    // 一轮里同一个人只许 @ 一次：开头那个前缀算一次，正文里第一次出现的标签也算一次。
    // 名字从整个频道的全部历史里找（不只注入窗口那 50 条），很久没说话的人也能换出名字
    const mentionNames = buildMentionNames([...history, turnUser]);
    // 进度与最终正文用同一份判定（用户看到的和落库的必须一字不差）；私聊整段不动
    const mentionSafe = (text: string): string =>
      ctx.guildId === '' ? text : dedupeMentions(text, { alreadyPinged: mentionSeed, names: mentionNames });
    // 排障用一行：能直接回答「模型到底有没有拿到说话人身份 / 用哪层提示词 / 丢了多少历史」
    console.log(
      '[chat] turn prompt=' + promptHit.scope +
      ' identity=' + (ctx.userName.trim() === '' ? 'off' : 'on') +
      ' user=' + ctx.userName +
      ' guild=' + (ctx.guildName === '' ? '-' : ctx.guildName) +
      ' channel=' + (ctx.channelName === '' ? '-' : ctx.channelName) +
      ' history=' + String(kept.length) +
      ' of=' + String(history.length) +
      ' dropped=' + String(droppedCount) +
      ' summaryLen=' + String(summary?.summary.length ?? 0) +
      ' systemLen=' + system.length +
      ' guide=' + guide.scope +
      ' hist=' + String(historyMaxMessages) +
      ' sum=' + String(summaryEveryMessages),
    );
    const temperature = route.temperature ?? promptHit.cfg.temperature;
    // §55：这一模式照抄酒馆的 max_tokens；显式配过就尊重配置（路由 > 提示词层 > 65535）
    const maxTokens = contextToolMode
      ? route.maxTokens ?? promptHit.cfg.maxTokens ?? CONTEXT_TOOL_MAX_TOKENS
      : route.maxTokens ?? promptHit.cfg.maxTokens;
    // 采样参数只从路由取（提示词层没有这五项）。空对象 = 五个键都不进请求体；
    // 0 是用户填过的有效值，所以判 undefined 而不是判真假
    const sampling: Pick<LlmRequest, 'topP' | 'topK' | 'seed' | 'frequencyPenalty' | 'presencePenalty'> = {};
    if (route.topP !== undefined) sampling.topP = route.topP;
    if (route.topK !== undefined) sampling.topK = route.topK;
    if (route.seed !== undefined) sampling.seed = route.seed;
    if (route.frequencyPenalty !== undefined) sampling.frequencyPenalty = route.frequencyPenalty;
    if (route.presencePenalty !== undefined) sampling.presencePenalty = route.presencePenalty;
    // 本轮主对话要看的图（§22.6）：有 ctx.loadImages 才可能非空；异常已在 memo 里吞成空数组。
    // §41：这一层把主模型识图关掉时连取图都不取 —— 主对话这一轮 images 恒为空数组，主请求连键都不带；
    // 表情模型那一路自己调 memo，同一轮的图它照旧看得到，且关掉时不会多下载一次。
    const images = ctx.mainImages === false ? [] : await loadTurnImagesOnce();

    const attempts: TurnAttempt[] = [];
    const variants: ModelRef[] = [route.primary, ...route.fallbacks];
    // 日志里的 ms：进模型调用到出干净正文的实际耗时（fallback 的等待也算在里面）
    const callStartedAt = Date.now();

    // 进度侧不推只含约定的中间态：SSE 首帧经常正好只有一个 NONE，推出去会先建出一条写着 NONE 的消息
    const emitProgress = async (text: string): Promise<void> => {
      if (isOnlyNoReactionMark(text)) return;
      await events?.onProgress?.(text);
    };

    for (const model of variants) {
      const all = await keys.listEnabled(model.provider);
      if (all.length === 0) {
        attempts.push({ model, error: 'NO_KEY_FOR_PROVIDER' });
        continue;
      }

      let lastError: string | null = null;
      // 空回计数按候选模型算：攒满 EMPTY_REPLY_ATTEMPTS 次才判这个模型失败、换下一个候选
      let empties = 0;
      // 名单命中优先、同 rank 保持 created_at,id 顺序，三档全部留在候选里（§20.4）
      const ordered = orderKeysForModel(all, model.model);
      // 用下标而不是 for…of：空回要停在同一个下标上重试同一把 Key，只有别的失败才往前走
      let index = 0;
      while (index < ordered.length) {
        const decrypted = ordered[index];
        let raw = '';
        // 区分「抛错」与「空回」：空回是这次没答上来（可以重试），网络/鉴权错误是这把 Key 不行（换 Key）
        let emptyReply = false;
        try {
          // 有图才带这个键：无图时对象形状与旧版逐字相同（既不是 images: []，也不是 images: undefined）
          const request: LlmRequest = {
            model: model.model,
            system,
            messages,
            ...(images.length > 0 ? { images } : {}),
            ...sampling,
            // §55：这一模式用自己那份工具（context + 回复工具），老模式逐字不变
            ...(contextToolMode ? contextToolFields : toolFields),
            // §55：酒馆那条实发请求里的 reasoning_effort，只有这一模式带上
            ...(contextToolMode ? { reasoningEffort: CONTEXT_TOOL_REASONING_EFFORT } : {}),
          };
          if (temperature !== undefined) request.temperature = temperature;
          if (maxTokens !== undefined) request.maxTokens = maxTokens;

          // 最后一帧带来的结束原因；一直没有 = 上游没给收尾帧（流被掐断）
          let finishReason: string | undefined;
          // §55 流式取回：tool_calls 的参数增量由适配器从流里带出来，这里按 index 攒回完整调用。
          // 整段攒完才交付——中途一次进度事件都不发，用户看不到中间态（这一模式的要求）。
          // 先拼回调用再取正文：只有 tool_calls、content 为空时 readToolReply 已经给出正文，
          // 不会被下面那条「一个字都没有」的判定误判成空回
          const streamContext = async (
            target: LlmRequest,
          ): Promise<{ text: string; calls: number; finishReason?: string }> => {
            let accumulated = '';
            let finish: string | undefined;
            const toolDeltas: ToolCallDelta[] = [];
            for await (const chunk of providers[model.provider].chatStream(target, {
              apiKey: decrypted.apiKey,
              baseUrl: decrypted.baseUrl,
              fetch: callGlobalFetch,
            })) {
              accumulated += chunk.delta;
              if (chunk.toolCallDelta !== undefined) toolDeltas.push(chunk.toolCallDelta);
              if (chunk.finishReason !== undefined) finish = chunk.finishReason;
            }
            const calls = accumulateToolCalls(toolDeltas);
            return {
              text: readToolReply(calls, accumulated),
              calls: calls.length,
              ...(finish === undefined ? {} : { finishReason: finish }),
            };
          };
          if (contextToolMode) {
            const first = await streamContext(request);
            raw = first.text;
            finishReason = first.finishReason;
            // §59 补交付：一个字正文都没交、却调过工具（线上就是只调了 context 交白卷）——
            // 再问一次，这一回合没有 context 可调，只能把正文写进 story_reply。
            // 仍然空才交给下面那条空回判定（原地重试，见 catch）
            if (raw.trim() === '' && first.calls > 0) {
              emit(
                'warn',
                'chat',
                '空回补交付 model=' + model.provider + '/' + model.model + ' key=' + decrypted.label,
              );
              const retry: LlmRequest = {
                model: model.model,
                system: contextReplySystem,
                messages,
                ...(images.length > 0 ? { images } : {}),
                ...sampling,
                ...contextReplyFields,
                reasoningEffort: CONTEXT_TOOL_REASONING_EFFORT,
              };
              if (temperature !== undefined) retry.temperature = temperature;
              if (maxTokens !== undefined) retry.maxTokens = maxTokens;
              const second = await streamContext(retry);
              raw = second.text;
              finishReason = second.finishReason;
            }
          } else {
            for await (const chunk of providers[model.provider].chatStream(request, {
              apiKey: decrypted.apiKey,
              baseUrl: decrypted.baseUrl,
              fetch: callGlobalFetch,
            })) {
              raw += chunk.delta;
              if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
              // 每块必推：服务层不攒、不按时间节流，合流与 Discord 速率全交给编辑器一侧串行化
              // 推之前先剥壳：壳还没收尾时它先返回空串，不让半截标记先刷进 Discord
              if (chunk.delta !== '') {
                await emitProgress(
                  mentionSafe(
                    stripNoReactionHead(stripStamp(visibleText(stripVoiceDirective(stripWrapperTags(unwrapToolReplyStream(raw))).text))),
                  ),
                );
              }
            }
          }
          // 上游把流干净地关掉却一个字都没给（上下文工具模式则在拼回调用之后仍然没有正文）：
          // 这不是成功，按空回处理（原地重试，见 catch）
          if (raw.trim() === '') {
            emptyReply = true;
            throw new Error('EMPTY_RESPONSE');
          }
          // 截断续写：被掐断就让模型接着写，新文字并进同一条 raw——Discord 那条消息靠既有渐进编辑
          // 继续被改，不新开一条；同一次尝试内用同一个模型、同一把 Key。续写请求自己失败不毁这一轮回复
          let continued = 0;
          // §55：这一模式靠工具调用一次性交付整段正文，不按文本截断续写——现在也走流式、
          // 拿得到 finishReason，但「接着写」对一次工具调用没有意义，续写循环整段跳过
          while (
            !contextToolMode &&
            continued < MAX_CONTINUATIONS &&
            raw.length < CONTINUE_TOTAL_CHARS &&
            isTruncatedReply(raw, finishReason)
          ) {
            let extra = '';
            let extraFinish: string | undefined;
            try {
              // 续写请求不带图：适配器会把图片挂到最后一条 role==='user' 的消息上，而续写时那条是
              // 「继续写」的指令——挂上去既浪费也可能干扰。新对象只继承首段的取词参数，绝不 ...request
              const continueRequest: LlmRequest = {
                model: model.model,
                system,
                messages: continuationMessages(messages, raw),
                ...sampling,
                // 同一轮的工具集跟着续写一起发：两段请求对模型给出同一套可用工具
                ...toolFields,
              };
              if (temperature !== undefined) continueRequest.temperature = temperature;
              if (maxTokens !== undefined) continueRequest.maxTokens = maxTokens;
              for await (const chunk of providers[model.provider].chatStream(
                continueRequest,
                { apiKey: decrypted.apiKey, baseUrl: decrypted.baseUrl, fetch: callGlobalFetch },
              )) {
                extra += chunk.delta;
                if (chunk.finishReason !== undefined) extraFinish = chunk.finishReason;
                // 续写这段也边收边改同一条消息：每块都推，不再等整段收完才刷一次
                // 正在吐 [END] 自撤标记时不推：那几块下文一个字都不会并进正文，推出去只会让用户先看到哨兵
                if (chunk.delta !== '' && !CONTINUE_SENTINEL.startsWith(extra.trim())) {
                  await emitProgress(
                    mentionSafe(
                      stripNoReactionHead(
                        stripStamp(visibleText(stripVoiceDirective(stripWrapperTags(unwrapToolReplyStream(raw + extra))).text)),
                      ),
                    ),
                  );
                }
              }
            } catch (error) {
              emit(
                'warn',
                'chat',
                '续写失败 model=' + model.provider + '/' + model.model +
                ' key=' + decrypted.label +
                ' ' + describeError(error).slice(0, LOG_ERROR_MAX_CHARS),
              );
              break;
            }
            finishReason = extraFinish;
            // 自撤：模型认为上段已经写完就只回 [END]（或者干脆空）——保留已写内容，一个字都不追加
            const piece = extra.trim();
            if (piece === '' || piece === CONTINUE_SENTINEL) break;
            raw += extra;
            continued += 1;
          }

          // 指令只为贴表情服务：TurnResult 与落库都用同一份剥干净的文本，用户永远看不到 [[react:…]]
          // 模型还会模仿历史行在开头写 [MM-DD HH:mm]，同样剥掉，否则每次回复都以一个假时刻开头
          // 头部单独一行的 NONE 一并剥掉：模型偶尔把「不贴表情就回一行 NONE」的约定当成正文写出来
          // 预设要求模型把正文包进 story_reply 的调用壳，模型就把壳一起写进了正文：先剥壳再走原链路
          // 预设的 <game> 包裹标签同理：先剥工具壳、再剥成对标记，中间正文一个字不动
          // §55 的正文来自工具参数，本来就没有「模型自写的调用壳」，直接进成对标记的剥离
          const unwrappedRaw = stripWrapperTags(contextToolMode ? raw : unwrapToolReply(raw).text);
          const { text: directiveStripped, reactions } = splitReactDirectives(unwrappedRaw);
          // 语音指令同样是内部约定：正文与落库都不能留 [[voice]]，只把「要不要念」带出去
          const { text: voiceStripped, wanted: voiceRequested } = stripVoiceDirective(directiveStripped);
          const text = mentionSafe(stripNoReactionHead(stripStamp(voiceStripped)));
          const result: TurnResult = {
            text,
            model,
            attempts,
            promptScope: promptHit.scope,
            routeScope: routeHit.scope,
            // §28：指令侧直接产出 ReactionRequest（表情 + 可选目标），这里不再二次映射
            reactions,
          };
          // 只有真出现过才挂字段：没写指令的轮次保持原样，既有断言与调用方都不用关心它
          if (voiceRequested) result.voiceRequested = true;
          const storedUser: ChatMessage = {
            role: 'user',
            content: ctx.storedUserText ?? ctx.userText,
            author: ctx.userName,
            authorId: ctx.userId,
            createdAt: turnIso,
          };
          if (ctx.replyTo !== undefined) storedUser.replyTo = ctx.replyTo;
          // §62：带上本条发言的 Discord 消息 id，后台删这条记忆时才能精确删掉群里那条
          if (ctx.userDiscordId !== undefined) storedUser.discordId = ctx.userDiscordId;
          await conversations.append(key, [
            storedUser,
            { role: 'assistant', content: text, author: ctx.botName, createdAt: now().toISOString() },
          ]);
          // 成功事件在 append 之后：用户看到的那条已经落库，日志里才报成功
          emit(
            'info',
            'chat',
            '回复成功 model=' + model.provider + '/' + model.model +
            ' history=' + String(kept.length) +
            ' of=' + String(history.length) +
            ' dropped=' + String(droppedCount) +
            ' ms=' + String(Date.now() - callStartedAt) +
            ' len=' + String(text.length) +
            // 只有真的接进过文字才加这个字段：没续写时日志逐字与旧版一致
            (continued > 0 ? ' cont=' + String(continued) : '') +
            // 同上：有图才写张数，无图时这一行与旧版逐字相同
            (images.length > 0 ? ' images=' + String(images.length) : '') +
            ' guide=' + guide.scope +
            ' key=' + decrypted.label +
            // §55：只有上下文工具模式才有这一项，老形状的这一行日志逐字不变
            (contextToolMode ? ' mode=context' : ''),
          );
          // 落库之后再判触发：游标只吃到已落库的消息，本轮这条留给下一次
          await maybeSummarize(key, summary, summaryEveryMessages);
          // 表情模型（§21）：附带的第二次调用，放在落库之后才问——正文已经确定，问不问得到都不改它；
          // 也放在摘要触发之后，别让这一步的网络等待拖后自动摘要
          if (ctx.wantReactions === true) {
            let extra: ReactionRequest[] = [];
            try {
              extra = await selectReaction(ctx, text, guide, template, reactionHistory, loadTurnImagesOnce);
            } catch (error) {
              // 这里是候选循环的 try 里面：表情这一步漏出去的错会被当成「这把 Key 失败」再重问一遍模型，
              // 用户会收到同一句话两次。selectReaction 自己已经兜住一切，这层是结构上的第二道保险
              console.warn('[chat] 表情选择失败：' + describeError(error));
            }
            if (extra.length > 0) result.reactions = mergeReactions(result.reactions, extra);
          }
          return result;
        } catch (error) {
          lastError = describeError(error);
          // 流式铁律（§20.5）：已经产出可见文本就停止换 Key，改为把该候选模型计为失败——
          // 否则会把同一条消息从头重写一遍，用户看到文字跳变；这条对空回重试同样成立，一个字都不重写
          if (stripStamp(visibleText(raw)).trim() !== '') break;
          // 空回：停在原地重试同一把 Key；攒满上限才 break 出去换候选模型。
          // 每次重试留一行 warn，线上才回答得了「这句为什么比平时久」
          if (emptyReply) {
            empties += 1;
            if (empties >= EMPTY_REPLY_ATTEMPTS) break;
            emit(
              'warn',
              'chat',
              '空回复重试 ' + String(empties + 1) + '/' + String(EMPTY_REPLY_ATTEMPTS) +
              ' model=' + model.provider + '/' + model.model +
              ' key=' + decrypted.label,
            );
            continue;
          }
          // 其它失败（网络、HTTP 非 2xx、超时、错误帧）：换同供应商的下一把 Key，不消耗空回次数
          index += 1;
        }
      }
      // 候选模型失败只记**最后一把** Key 的原始错误（§20.5）
      if (lastError !== null) attempts.push({ model, error: lastError });
    }

    const failure = 'ALL_PROVIDERS_FAILED: ' + JSON.stringify(attempts);
    // 抛错前记一条：后台读到的错误文本与调用方拿到的同源，且只留前 300 字
    emit('error', 'chat', '回复失败 ' + failure.slice(0, LOG_ERROR_MAX_CHARS));
    throw new Error(failure);
  }

  async function reset(key: ChannelKey): Promise<void> {
    await conversations.clear(key);
    if (summaries !== undefined) await summaries.remove(key);
  }

  async function getSummary(key: ChannelKey): Promise<ConversationSummary | null> {
    // 显式查询要如实报错：吞掉会让管理员以为「还没有摘要」而不是「查询失败」
    return summaries === undefined ? null : summaries.get(key);
  }

  return { run, reset, summarize, summarizeSweep, getSummary, previewBackfill, backfill };
}
