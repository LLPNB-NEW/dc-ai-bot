import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type {
  BackupStore,
  BodyEmojiGuideStore,
  ChannelMemoryStore,
  ConversationStore,
  EmojiAliasStore,
  EmojiDescriptionStore,
  KeyRepository,
  LogStore,
  PromptDefaultsStore,
  PromptRepository,
  ReactionGuideStore,
  ReactionModelStore,
  ReactionTemplateStore,
  ReplySettingsStore,
  RouteRepository,
  SummaryStore,
  TimeoutSettingsStore,
  TtsSettingsStore,
  TtsStyleStore,
  VisionSettingsStore,
  VoiceSettingsStore,
} from '../../core/ports';
import {
  INJECTION_CONTENT_MAX_CHARS,
  isInjectionDepth,
  isInjectionRole,
  type PromptInjectionStore,
} from '../../core/prompt/injection';
import {
  normalizeWorldEntry,
  parseWorldBook,
  readWorldPosition,
  uniqueWorldBookName,
  WORLD_DEPTH_MAX,
  WORLD_POSITIONS,
  WORLD_SCAN_DEPTH_MAX,
  type WorldBook,
  type WorldBookRecord,
  type WorldBookStore,
  type WorldEntry,
} from '../../core/prompt/worldbook';
import type { PresetImportStore } from '../db/d1-repository';
import { clampPgErrorsLimit, PG_ERRORS_DEFAULT_LIMIT, PgErrorsUnavailableError, type PgErrorsSource } from '../../core/pg-errors';
import {
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
  TIMEOUT_FIELDS,
  applyTimeoutOverrides,
  resetTimeouts,
  resolveTimeout,
  timeoutDefaults,
  timeoutSettings,
} from '../../core/timeouts';
import type {
  BackupRequest,
  BackfillOutcome,
  BodyEmojiGuideConfig,
  BackfillPreview,
  ChannelKey,
  ChannelMemoryConfig,
  ChatMessage,
  ConversationSummary,
  CustomEmoji,
  EmojiAlias,
  EmojiDescribeResult,
  ModelRef,
  PromptConfig,
  PromptDefaultEntry,
  PromptPlacement,
  PromptRole,
  PromptSegment,
  ProviderId,
  ProviderKey,
  ReactionGuideConfig,
  ReactionModelConfig,
  ReactionTemplateConfig,
  RevealStepsConfig,
  RouteConfig,
  Scope,
  ScopedKey,
  StoredMessage,
  SummaryOutcome,
  SummarySweepOutcome,
  TimeRange,
  TtsDialect,
  TtsSettingsSecret,
  TtsStyleLayer,
  VisionSettingsConfig,
  VoiceSettingsConfig,
} from '../../core/types';
import { DEFAULT_REACTION_GUIDE } from '../../core/chat/reaction-guide';
import { BODY_EMOJI_SUGGESTION, DEFAULT_BODY_EMOJI_GUIDE } from '../../core/chat/body-emoji';
import {
  DEFAULT_REACTION_TEMPLATE,
  REACTION_TEMPLATE_VARS,
  collectReactionTemplateVars,
} from '../../core/chat/reaction-template';
import {
  DEFAULT_REVEAL_STEPS,
  REVEAL_STEPS_MAX,
  REVEAL_STEPS_MIN,
  isRevealSteps,
} from '../../core/chat/reply-view';
import { SUMMARY_MAX_CHARS } from '../../core/chat/summary';
import { DEFAULT_VISION_ENABLED, isVisionEnabled } from '../../core/chat/vision-view';
import {
  CODE_IDENTITY_TEMPLATE,
  FALLBACK_PROMPT_VARS,
  IDENTITY_PROMPT_VARS,
  MAX_PROMPT_DEFAULT_CHARS,
  PROMPT_DEFAULT_KEYS,
  SAMPLE_PROMPT_VARS,
  findUnknownPromptDefaultVars,
  formatIdentityBlock,
  isPromptDefaultKey,
  previewPromptDefault,
  resolveFallbackPrompt,
} from '../../core/prompt/defaults';
import { DEFAULT_PROMPT, resolvePrompt } from '../../core/prompt/resolver';
import { importSillyTavernPreset } from '../../core/prompt/sillytavern';
import { findUnknownVars, renderTemplate } from '../../core/prompt/template';
import {
  VOICE_DIRECTOR_FREE,
  VOICE_DIRECTOR_OFF,
  VOICE_DIRECTOR_TAGS,
  VOICE_MODE_ALWAYS,
  VOICE_MODE_OFF,
  VOICE_MODE_ON_REQUEST,
  VOICE_SPEED_DEFAULT,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  isVoiceDirector,
  isVoiceMode,
  isVoiceSpeed,
} from '../../core/voice/settings';
import {
  TTS_STYLE_MAX_CHARS,
  composeVoiceSpeech,
  isJudgeConfigured,
  normalizeStyleTag,
  type TtsStyleJudgeConfig,
} from '../../core/voice/style';
import { createTts, ttsConfigFrom } from '../../core/voice/tts';
import { maskKeyHint } from '../db/d1-repository';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, createSessionAuth, type Clock } from './auth';
import type { KeyProber } from './ports';

const PROVIDERS: readonly ProviderId[] = ['openai-compat', 'anthropic', 'gemini'];

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const DEFAULT_CONVERSATION_LIMIT = 20;
const MAX_CONVERSATION_LIMIT = 200;

/** §19.8 轮询端点：after 缺省 0、limit 缺省 200 并夹在 1..500 */
const DEFAULT_LOG_LIMIT = 200;
const MIN_LOG_LIMIT = 1;
const MAX_LOG_LIMIT = 500;

/** §25.4：「最近消息」缺省 50 条、上限 200；正文 1..8000 字（模型侧 4000，手写留一倍余量）；
 * regenerate 的 detail 只回前 300 字，整段堆栈不往前端塞 */
const DEFAULT_SUMMARY_MESSAGE_LIMIT = 50;
const MAX_SUMMARY_MESSAGE_LIMIT = 200;
const MAX_SUMMARY_CHARS = 8000;
const MAX_SUMMARY_DETAIL_CHARS = 300;

/** §26.4：注入条数与自动总结阈值都 ≥ 2，不设上限（自动总结阈值另有 0 = 关闭） */
const MIN_MEMORY_MESSAGES = 2;

/** §26.4：注入 system 的摘要字符预算夹在 500..20000；0 或缺省 = 未设置，运行时用 SUMMARY_MAX_CHARS */
const MIN_SUMMARY_MAX_CHARS = 500;
const MAX_SUMMARY_MAX_CHARS = 20000;

/** §11：temperature 夹在 0..2（可小数）、maxTokens 夹在 1..100000 的整数。
 * 两个 PUT（提示词、路由）共用这把尺：存进去的脏数字会被原样塞进模型请求，让之后每一轮都失败 */
const TEMPERATURE_BOUNDS = { min: 0, max: 2, integer: false };
const MAX_TOKENS_BOUNDS = { min: 1, max: 100000, integer: true };
/** 采样参数：三个适配器各认一部分（Anthropic 只有 top_p，OpenAI 兼容没有 top_k），越界照样 400 */
const TOP_P_BOUNDS = { min: 0, max: 1, integer: false };
const TOP_K_BOUNDS = { min: 1, max: 1000, integer: true };
const SEED_BOUNDS = { min: 0, max: 2147483647, integer: true };
const PENALTY_BOUNDS = { min: -2, max: 2, integer: false };
/** §28.10：一份提示词最多 8000 字；超了多半是贴了整段对话进来，不是文案 */
const MAX_REACTION_GUIDE_CHARS = 8000;
/** 正文表情提示词同样是 8000 字上限；它只是贴在表情清单后的一句补充，超长多半是贴错了东西 */
const MAX_BODY_EMOJI_GUIDE_CHARS = 8000;
/** §34.5：一份素材模板最多 8000 字；超了多半是贴了整段对话进来，不是模板 */
const MAX_REACTION_TEMPLATE_CHARS = 8000;

// 语音合成接口只有一套全局配置：默认值与上限由 HTTP 层回给后台，前端不抄常量。
// 模型不再暴露（后台也改不了）：三种方言各自用 core 里的内置默认，这里不再有 model 常量。
const TTS_URL_PLACEHOLDER = 'https://api.openai.com/v1';
const TTS_VOICES: readonly string[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
// 第二种上游方言：小米 MiMo 走 OpenAI 形状的 chat/completions，音频在 JSON 里、没有 speed 参数
const TTS_MIMO_URL_PLACEHOLDER = 'https://api.xiaomimimo.com/v1';
// 音色名由 MiMo 定义，中文音色就写中文；后台原样展示，不替用户翻译
const TTS_MIMO_VOICES: readonly string[] = [
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
];
// 第三种上游方言：同一个 /audio/speech 路径，但返回整段 WAV，中继侧要几十秒才回
const TTS_GEMINI_URL_PLACEHOLDER = 'https://example.com/pg/v1';
// 音色名由 Gemini 预置音色定义，后台原样展示，不替用户翻译
const TTS_GEMINI_VOICES: readonly string[] = [
  'Kore',
  'Puck',
  'Charon',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
];

/** 一种方言的全部默认值：后台按它切换占位地址与音色清单，前端不抄常量（模型内置在 core，不回给后台） */
interface TtsDialectOption {
  id: TtsDialect;
  label: string;
  urlPlaceholder: string;
  voices: readonly string[];
}

/** 缺省方言：没有行、老请求不带这个字段、库里值为空，三种情况都落在这里 */
const TTS_DEFAULT_DIALECT: TtsDialect = 'openai';

// 顺序即后台下拉顺序：openai 在前，老配置照旧落在第一项
const TTS_DIALECTS: readonly TtsDialectOption[] = [
  {
    id: 'openai',
    label: 'OpenAI 兼容（/audio/speech）',
    urlPlaceholder: TTS_URL_PLACEHOLDER,
    voices: TTS_VOICES,
  },
  {
    id: 'mimo',
    label: '小米 MiMo（chat/completions）',
    urlPlaceholder: TTS_MIMO_URL_PLACEHOLDER,
    voices: TTS_MIMO_VOICES,
  },
  {
    id: 'gemini',
    label: 'Gemini（/audio/speech，WAV）',
    urlPlaceholder: TTS_GEMINI_URL_PLACEHOLDER,
    voices: TTS_GEMINI_VOICES,
  },
];
const TTS_MAX_URL_CHARS = 500;
const TTS_MAX_KEY_CHARS = 500;
const TTS_MAX_FIELD_CHARS = 100;
/** 语气提示词的 scope 顺序即后台列表顺序：channel → guild → global */
const TTS_STYLE_SCOPES: readonly Scope[] = ['channel', 'guild', 'global'];
const TTS_TEST_TEXT = '你好，我是示例机器人，这是一段语音测试。';

/** 后台「超时」页要的一屏数据：每项的基线、生效值、上下限，加上倍率与三个端点共用的这份形状 */
function timeoutShape(stored: Record<string, number>): {
  fields: Array<{
    key: string;
    env: string;
    label: string;
    detail: string;
    defaultMs: number;
    minMs: number;
    maxMs: number;
    valueMs: number;
    effectiveMs: number;
    overridden: boolean;
  }>;
  multiplier: { value: number; default: number; min: number; max: number };
} {
  const settings = timeoutSettings();
  const defaults = timeoutDefaults();
  return {
    fields: TIMEOUT_FIELDS.map((field) => ({
      key: field.key,
      env: field.env,
      label: field.label,
      detail: field.detail,
      defaultMs: defaults[field.key],
      minMs: field.minMs,
      maxMs: field.maxMs,
      valueMs: settings[field.key],
      // 生效值已经乘过倍率并被夹进上下限，后台照着它显示「实际等多久」
      effectiveMs: resolveTimeout(field.key),
      // 只有库里真的存过这一项才算后台覆盖；和默认相同的值在 PUT 时不会落库
      overridden: typeof stored[field.key] === 'number',
    })),
    multiplier: {
      value: settings.multiplier,
      default: defaults.multiplier,
      min: MULTIPLIER_MIN,
      max: MULTIPLIER_MAX,
    },
  };
}

export interface AdminAppDeps {
  prompts: PromptRepository;
  /** §ST：最近一次酒馆预设导入的原始 JSON（后续阶段读世界书/正则）；HTTP 层只写不读 */
  presetImports: PresetImportStore;
  routes: RouteRepository;
  keys: KeyRepository;
  conversations: ConversationStore;
  /** §19.8：日志只读轮询；写入口在装配层（Worker 的 sink），HTTP 层只读 */
  logs: LogStore;
  /** §21.5：表情模型只有一套（单行表），既没有 scope 也不进 list */
  reactionModels: ReactionModelStore;
  /** §28.10：贴表情提示词三层配置；GET 连默认文案一起回，后台不用另存一份内置文案 */
  reactionGuides: ReactionGuideStore;
  /** 正文表情提示词三层配置；GET 连内置默认文案一起回，后台不用另存一份 */
  bodyEmojiGuides: BodyEmojiGuideStore;
  /** §34.5：表情模型素材模板三层配置；GET 连默认模板与 6 个占位符一起回，后台不用另存一份内置文案 */
  reactionTemplates: ReactionTemplateStore;
  /** §43：两份可编辑兜底文案（内置默认提示词 / 当前对话身份块）；没有行 = 用代码里的默认 */
  promptDefaults: PromptDefaultsStore;
  /** §38：假流式切片次数三层配置；GET 连默认值与合法区间一起回，后台不用另存一份常量 */
  replySettings: ReplySettingsStore;
  /** §41：主模型识图的三层开关；GET 连默认值一起回，后台不用另存一份常量 */
  visionSettings: VisionSettingsStore;
  /** 语音回复的三层配置；GET 连默认值、模式枚举与语速区间一起回，后台不用另存一份常量 */
  voiceSettings: VoiceSettingsStore;
  /** 超时配置的后台覆盖值：一张 name → value 的平表，缺的项由 core 落回 .env 与内置默认 */
  timeoutSettings: TimeoutSettingsStore;
  /** 语音合成接口：唯一来源是这张单行表，环境变量只用于提示「可以删了」 */
  ttsSettings: TtsSettingsStore;
  /** 每条语音先判断情绪用的三层语气提示词；GET 连上限一起回，后台不抄常量 */
  ttsStyles: TtsStyleStore;
  /** 深度注入的三层配置（一层一行，channel > guild > global）；未接线时整组端点回 501 */
  promptInjections?: PromptInjectionStore;
  /** 世界书三层整本覆盖（channel > guild > global）；未接线时整组端点回 501 */
  worldBooks?: WorldBookStore;
  /** 服务器上是否还留着 VOICE_TTS_URL / VOICE_TTS_KEY：只用于提示，不参与取值 */
  ttsEnvPresent?: boolean;
  /** §23.6：表情描述只读 + 触发认图；描述本身由认图执行器写，HTTP 层不写 */
  emojiDescriptions: EmojiDescriptionStore;
  /** §23.4：认图执行器由装配层注入；未接线时 describe 端点回 501，不影响其它路由 */
  describeEmojis?: (guildId: string, options?: { force?: boolean }) => Promise<EmojiDescribeResult>;
  /** §24.6：别名是管理员手写的数据，读写都在 HTTP 层；一条别名只指向一个表情 */
  emojiAliases: EmojiAliasStore;
  /** §24.6：拉该服真实表情清单供后台下拉选；未注入时 live 端点回 501 */
  listEmojis?: (guildId: string) => Promise<CustomEmoji[]>;
  /** §25.5：后台手改摘要正文与覆盖楼层，读写都在 HTTP 层完成 */
  summaries: SummaryStore;
  /** §25.5：重新总结走与 /summary 命令同一份 summarize；未接线时 regenerate 回 501 */
  summarizeChannel?: (key: ChannelKey) => Promise<SummaryOutcome | null>;
  /** §63 后台「连续总结」：一批 500 条，并回报还剩多少条；未接线时 sweep 端点回 501 */
  summarizeSweep?: (key: ChannelKey) => Promise<SummarySweepOutcome>;
  /** 手动备份的文件端口：Workers 没有文件系统，装配层不给就整组端点回 501 */
  backup?: BackupStore;
  /** §35：后台「选择性补记」预览；未接线时 range 端点回 501 */
  previewBackfill?: (key: ChannelKey, range: TimeRange) => Promise<BackfillPreview>;
  /** §35：按时间范围补记一段记忆（不动游标）；未接线时 backfill 端点回 501 */
  backfillSummary?: (key: ChannelKey, range: TimeRange) => Promise<BackfillOutcome | null>;
  /** §26.4：频道级记忆配置；没有行时按 memoryDefaults 临时拼一份（updatedAt 空串） */
  channelMemory: ChannelMemoryStore;
  /** §26.4：默认值由装配层从 core 常量传入，HTTP 层不 import src/core/chat/service.ts（§16.5） */
  memoryDefaults: { historyMaxMessages: number; summaryEveryMessages: number };
  adminPassword: string;
  sessionSecret: string;
  appVersion: string;
  /** §16.4：连通性测试走注入窄接口，M4 不 import src/core/providers/** */
  probeKey?: KeyProber;
  /** PG 中继最近报错（只读）：未注入或中继没配时 pg-errors 端点回 501，不影响其它路由 */
  pgErrors?: PgErrorsSource;
  /** 注入时钟：登录限速窗口与 Cookie 过期判定都用它，测试可冻结 */
  now?: Clock;
  /**
   * §62：删单条短期记忆时把 Discord 里那条也删掉；未注入或没配 token 时由它自己回一句原因，
   * 端点照样把库里的行删掉（Discord 侧的结果照实回给后台）。
   */
  pruneDiscordMessage?: (target: StoredMessage) => Promise<{ outcome: string; detail: string }>;
}

interface OptionalString {
  value?: string;
  invalid: boolean;
}

interface OptionalNumber {
  value?: number;
  invalid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalString(body: Record<string, unknown>, key: string): OptionalString {
  const value = body[key];
  if (value === undefined || value === null) return { invalid: false };
  return typeof value === 'string' ? { value, invalid: false } : { invalid: true };
}

interface NumberBounds {
  min: number;
  max: number;
  integer: boolean;
}

/** 缺省/显式 null 都算没填；填了就必须是区间内的有限数字（maxTokens 还要整数） */
function readOptionalNumber(
  body: Record<string, unknown>,
  key: string,
  bounds: NumberBounds,
): OptionalNumber {
  const value = body[key];
  if (value === undefined || value === null) return { invalid: false };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { invalid: true };
  if (value < bounds.min || value > bounds.max) return { invalid: true };
  if (bounds.integer && !Number.isInteger(value)) return { invalid: true };
  return { value, invalid: false };
}

/** 轮询端点不返回 400：缺省、空串、NaN 一律按缺省值处理（§19.8） */
function readQueryInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** §23.6：guildId 必填，空串与全空白都算缺参数；返回 trim 后的值（snowflake 没有内部空白） */
function readGuildId(raw: string | undefined): string | null {
  const guildId = (raw ?? '').trim();
  return guildId === '' ? null : guildId;
}

/** §25.4：guildId / channelId 都是雪花，1..32 位纯数字；带空白或符号就是调用方拼错了，不做宽容处理 */
const SNOWFLAKE_PATTERN = /^\d{1,32}$/;

function readChannelKey(guildId: string | undefined, channelId: string | undefined): ChannelKey | null {
  if (guildId === undefined || channelId === undefined) return null;
  if (!SNOWFLAKE_PATTERN.test(guildId) || !SNOWFLAKE_PATTERN.test(channelId)) return null;
  return { guildId, channelId };
}

/** 备份实现只存在于 Node 侧（node:fs），这边不能 import 它，只能按错误名认出「已经有一份没处理的请求」 */
function isBackupBusy(error: unknown): boolean {
  return error instanceof Error && error.name === 'BackupBusyError';
}

/** §35：from/to 必须都能被 Date.parse 认出来，端点顺序也不能反；null 就是 400 BAD_TIME_RANGE */
function readTimeRange(from: unknown, to: unknown): TimeRange | null {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  if (fromMs > toMs) return null;
  return { from, to };
}

/** §35：HTTP 层不 import core 的 RangeTooLargeError（§16.5），只认它带出来的 limit */
function rangeLimitOf(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const limit = error['limit'];
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
}

/** §24.6：别名要能塞进 `:名字:` 语法，冒号/空白/尖括号会把它撕成两半，长度 1–24 是后台输入框的容量 */
const MAX_ALIAS_CHARS = 24;
const ALIAS_FORBIDDEN = /[:\s<>]/;

function readAlias(raw: string | undefined): string | null {
  const alias = (raw ?? '').trim();
  if (alias === '' || alias.length > MAX_ALIAS_CHARS) return null;
  return ALIAS_FORBIDDEN.test(alias) ? null : alias;
}

/** §24.6：emojiId 是 Discord 雪花，短于 15 位的一定不是；emojiName 必须能当 `:名字:` 用 */
const MIN_EMOJI_ID_CHARS = 15;
const EMOJI_ID_PATTERN = /^\d+$/;
const EMOJI_NAME_PATTERN = /^[A-Za-z0-9_~]{2,32}$/;

function readEmojiRef(
  rawId: string | undefined,
  rawName: string | undefined,
): { emojiId: string; emojiName: string } | null {
  const emojiId = (rawId ?? '').trim();
  const emojiName = (rawName ?? '').trim();
  if (emojiId.length < MIN_EMOJI_ID_CHARS || !EMOJI_ID_PATTERN.test(emojiId)) return null;
  if (!EMOJI_NAME_PATTERN.test(emojiName)) return null;
  return { emojiId, emojiName };
}

function readScope(value: unknown): Scope | null {
  return value === 'global' || value === 'guild' || value === 'channel' ? value : null;
}

/** §20.6：models 是「适用模型名单」，空数组 = 通用 */
const MAX_KEY_MODELS = 20;
const MAX_KEY_MODEL_CHARS = 64;
/** 逗号是库里的分隔符，空白会破坏 trim 语义，二者永远不收；字母按 unicode 算，中文模型名（`假流式-…`）能进名单 */
const KEY_MODEL_PATTERN = /^[\p{L}\p{N}._:*-]+$/u;

/** null = 不合法（非数组/超 20 项/项长越界/字符集外）；合法时按小写去重、保留第一份的原始大小写 */
function readKeyModels(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_KEY_MODELS) return null;

  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    if (item.length < 1 || item.length > MAX_KEY_MODEL_CHARS) return null;
    if (!KEY_MODEL_PATTERN.test(item)) return null;
    const folded = item.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    models.push(item);
  }
  return models;
}

function readProvider(value: unknown): ProviderId | 'BAD_PROVIDER' {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
    ? (value as ProviderId)
    : 'BAD_PROVIDER';
}

/** global 的 scopeId 恒为 ''；guild/channel 缺 scopeId 视为缺必填字段 */
function readScopeKey(body: Record<string, unknown>): ScopedKey | 'BAD_SCOPE' | null {
  const scope = readScope(body['scope']);
  if (scope === null) return 'BAD_SCOPE';
  const raw = body['scopeId'];
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return null;
  const scopeId = scope === 'global' ? '' : typeof raw === 'string' ? raw : '';
  if (scope !== 'global' && scopeId === '') return null;
  return { scope, scopeId };
}

/**
 * 导入接口的目标层：两个字段都不传 = 旧行为写 global；
 * 传了就交给 readScopeKey 统一校验——非法层与 missing scopeId 都归成 BAD_SCOPE，调用方先校验再写库
 */
function readImportScopeKey(body: Record<string, unknown>): ScopedKey | 'BAD_SCOPE' {
  if (body['scope'] === undefined || body['scope'] === null) return { scope: 'global', scopeId: '' };
  return readScopeKey(body) ?? 'BAD_SCOPE';
}

/** 三层兜底文案的合法 scope；GET 的 scopes 字段与后台下拉共用这一份 */
const PROMPT_DEFAULT_SCOPES: readonly Scope[] = ['channel', 'guild', 'global'];

/** 语气提示词的列表顺序固定：channel → guild → global，再按 scopeId，前端与测试才好断言 */
function sortTtsStyles(items: TtsStyleLayer[]): TtsStyleLayer[] {
  return [...items].sort((a, b) => {
    const byScope = TTS_STYLE_SCOPES.indexOf(a.scope) - TTS_STYLE_SCOPES.indexOf(b.scope);
    if (byScope !== 0) return byScope;
    return a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0;
  });
}

/** 后台列表顺序固定：fallback → identity，再 channel → guild → global，最后按 scopeId，前端与测试才好断言 */
function sortPromptDefaults(items: PromptDefaultEntry[]): PromptDefaultEntry[] {
  const weight = (item: PromptDefaultEntry): number =>
    PROMPT_DEFAULT_KEYS.indexOf(item.key) * 100 + PROMPT_DEFAULT_SCOPES.indexOf(item.scope);
  return [...items].sort((a, b) => {
    const byKeyAndScope = weight(a) - weight(b);
    if (byKeyAndScope !== 0) return byKeyAndScope;
    return a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0;
  });
}

async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type WorldEntryInput = { ok: true; entry: WorldEntry } | { ok: false; detail: string };

/** 空层新建时用户自己起的书名：够用就行，只挡空串与离谱长串 */
const WORLD_BOOK_NAME_MAX = 80;

/** bookId 由服务端生成（UUID），这里只挡空串与离谱长串，不校验具体格式 */
const WORLD_BOOK_ID_MAX = 100;

function readWorldBookId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id === '' || id.length > WORLD_BOOK_ID_MAX ? null : id;
}

/** 条目摘要：正文上千字，列表不回正文；长度按码点算，emoji 与中文混排才和后台显示对得上 */
function worldEntrySummary(entry: WorldEntry): Record<string, unknown> {
  const normalized = normalizeWorldEntry(entry);
  return {
    id: normalized.id,
    name: normalized.name,
    keys: normalized.keys,
    secondaryKeys: normalized.secondaryKeys,
    constant: normalized.constant,
    enabled: normalized.enabled,
    order: normalized.order,
    chars: Array.from(normalized.content).length,
    selective: normalized.selective,
    selectiveLogic: normalized.selectiveLogic,
    caseSensitive: normalized.caseSensitive,
    wholeWords: normalized.wholeWords,
    position: normalized.position,
    depth: normalized.depth,
    role: normalized.role,
    probability: normalized.probability,
    useProbability: normalized.useProbability,
    group: normalized.group,
    groupWeight: normalized.groupWeight,
    sticky: normalized.sticky,
    cooldown: normalized.cooldown,
    delay: normalized.delay,
    scanDepth: normalized.scanDepth,
  };
}

/** 关键词列表与导入解析同一口径：去空白、丢掉空串（constant 条目可以本来就是空数组） */
function readWorldKeyList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const text = item.trim();
    if (text !== '') keys.push(text);
  }
  return keys;
}

/** 有界整数：保存是整份覆盖，越界不夹取而是拒掉——夹取会让后台以为存进去的是原值 */
function readBoundedWorldInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value < min || value > max ? null : value;
}

/**
 * PUT /api/world-book/entry 的单条校验：可编辑字段一个都不能少，detail 直接点名是第一项不合格的。
 * 合法值统一交给 normalizeWorldEntry 收口（trim、位置/角色的兜底都在那里）。
 */
function readWorldEntryInput(value: unknown, options: { requireId?: boolean } = {}): WorldEntryInput {
  if (!isRecord(value)) return { ok: false, detail: 'entry 缺失或不是对象' };
  const fail = (field: string, rule: string): WorldEntryInput => ({ ok: false, detail: field + ' ' + rule });

  // 新建时 id 由服务端分配（本层 max + 1），请求里缺 id 不算错；PUT 仍然要带 id
  let id = 0;
  const rawId = value['id'];
  if (rawId === undefined && options.requireId === false) {
    id = 0;
  } else if (typeof rawId !== 'number' || !Number.isSafeInteger(rawId)) {
    return fail('id', '必须是整数');
  } else {
    id = rawId;
  }

  const name = value['name'];
  if (typeof name !== 'string' || name.trim() === '') return fail('name', '不能为空');

  const content = value['content'];
  if (typeof content !== 'string' || content.trim() === '') return fail('content', '不能为空');

  const keys = readWorldKeyList(value['keys']);
  if (keys === null) return fail('keys', '必须是字符串数组');
  const secondaryKeys = readWorldKeyList(value['secondaryKeys']);
  if (secondaryKeys === null) return fail('secondaryKeys', '必须是字符串数组');

  const enabled = value['enabled'];
  const constant = value['constant'];
  const selective = value['selective'];
  const caseSensitive = value['caseSensitive'];
  const wholeWords = value['wholeWords'];
  const useProbability = value['useProbability'];
  if (typeof enabled !== 'boolean') return fail('enabled', '必须是布尔值');
  if (typeof constant !== 'boolean') return fail('constant', '必须是布尔值');
  if (typeof selective !== 'boolean') return fail('selective', '必须是布尔值');
  if (typeof caseSensitive !== 'boolean') return fail('caseSensitive', '必须是布尔值');
  if (typeof wholeWords !== 'boolean') return fail('wholeWords', '必须是布尔值');
  if (typeof useProbability !== 'boolean') return fail('useProbability', '必须是布尔值');

  const selectiveLogic = value['selectiveLogic'];
  if (
    selectiveLogic !== 'andAny' &&
    selectiveLogic !== 'andAll' &&
    selectiveLogic !== 'notAny' &&
    selectiveLogic !== 'notAll'
  ) {
    return fail('selectiveLogic', '必须是 andAny/andAll/notAny/notAll');
  }

  const order = value['order'];
  if (typeof order !== 'number' || !Number.isSafeInteger(order)) return fail('order', '必须是有限整数');

  const position = value['position'];
  if (typeof position !== 'string' || !(WORLD_POSITIONS as readonly string[]).includes(position)) {
    return fail('position', '必须是 ' + WORLD_POSITIONS.join('/'));
  }

  const role = value['role'];
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    return fail('role', '必须是 system/user/assistant');
  }

  const depth = readBoundedWorldInt(value['depth'], 0, WORLD_DEPTH_MAX);
  if (depth === null) return fail('depth', '必须是 0..' + String(WORLD_DEPTH_MAX) + ' 的整数');

  const probability = value['probability'];
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 100) {
    return fail('probability', '必须是 0..100 的数字');
  }

  const group = value['group'];
  if (typeof group !== 'string') return fail('group', '必须是字符串');

  const groupWeight = readBoundedWorldInt(value['groupWeight'], 0, 100000);
  if (groupWeight === null) return fail('groupWeight', '必须是 0..100000 的整数');

  const sticky = readBoundedWorldInt(value['sticky'], 0, 10000);
  if (sticky === null) return fail('sticky', '必须是 0..10000 的整数');
  const cooldown = readBoundedWorldInt(value['cooldown'], 0, 10000);
  if (cooldown === null) return fail('cooldown', '必须是 0..10000 的整数');
  // delay 与导入侧同口径到 100000；sticky/cooldown 仍是 0..10000，别跟着放宽
  const delay = readBoundedWorldInt(value['delay'], 0, 100000);
  if (delay === null) return fail('delay', '必须是 0..100000 的整数');

  // scanDepth 的 null 是「用书级默认」，必须显式写出来，缺字段不当成 null
  const rawScanDepth = value['scanDepth'];
  let scanDepth: number | null;
  if (rawScanDepth === null) {
    scanDepth = null;
  } else {
    scanDepth = readBoundedWorldInt(rawScanDepth, 1, WORLD_SCAN_DEPTH_MAX);
    if (scanDepth === null) {
      return fail('scanDepth', '必须是 null 或 1..' + String(WORLD_SCAN_DEPTH_MAX) + ' 的整数');
    }
  }

  return {
    ok: true,
    entry: normalizeWorldEntry({
      id,
      // 名字与正文 trim 的规则与导入一致：只判空白，正文原样存（保留换行与缩进）
      name: name.trim(),
      keys,
      secondaryKeys,
      content,
      enabled,
      constant,
      selective,
      selectiveLogic,
      order,
      caseSensitive,
      wholeWords,
      position: readWorldPosition(position),
      depth,
      role,
      probability,
      useProbability,
      group,
      groupWeight,
      sticky,
      cooldown,
      delay,
      scanDepth,
    }),
  };
}

/** 查询串里的 id：纯十进制数字，小数/空串/负号一律按 400 处理 */
function readWorldEntryId(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 每段 content 都会过 renderTemplate，未知变量必须逐段拦 */
function collectUnknownVars(...templates: Array<string | undefined>): string[] {
  const unknown = new Set<string>();
  for (const template of templates) {
    if (template === undefined) continue;
    for (const name of findUnknownVars(template)) unknown.add(name);
  }
  return [...unknown];
}

const PROMPT_ROLES: readonly string[] = ['system', 'user'];
const PROMPT_PLACEMENTS: readonly string[] = ['before', 'after'];

/**
 * §11：PUT /api/prompts 的段校验。形状不对一律 BAD_PROMPT_SEGMENTS（前端只认这一种码）。
 * id 可以缺省（服务端生成），给了就必须非空且同一次请求内不重复；position 由数组顺序决定。
 */
function readPromptSegments(value: unknown): PromptSegment[] | null {
  // 空数组不等于「这一层没有提示词」：删空必须走 DELETE，否则会留下一个空层
  if (!Array.isArray(value) || value.length === 0) return null;

  const segments: PromptSegment[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return null;
    const name = entry['name'];
    const role = entry['role'];
    const content = entry['content'];
    const enabled = entry['enabled'];
    const placement = entry['placement'];
    if (typeof name !== 'string' || name.trim() === '') return null;
    if (typeof role !== 'string' || !PROMPT_ROLES.includes(role)) return null;
    if (typeof content !== 'string') return null;
    if (typeof enabled !== 'boolean') return null;
    if (typeof placement !== 'string' || !PROMPT_PLACEMENTS.includes(placement)) return null;

    const rawId = entry['id'];
    const id = rawId === undefined || rawId === null ? 'seg-' + crypto.randomUUID() : rawId;
    if (typeof id !== 'string' || id.trim() === '') return null;
    if (seen.has(id)) return null;
    seen.add(id);

    segments.push({
      id,
      name,
      role: role as PromptRole,
      content,
      enabled,
      placement: placement as PromptPlacement,
      position: index,
    });
  }
  return segments;
}

/** 酒馆预设存档永远只有这一行：后续阶段要的是「最近一次」，不是历史 */
const LATEST_PRESET_ID = 'latest';

/** 解析器契约不返回预设名：取 preset.name 当可读标识，取不到就用占位（name 列 NOT NULL） */
function readPresetName(preset: Record<string, unknown>): string {
  const name = preset['name'];
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : '未命名预设';
}

function promptDto(key: ScopedKey, cfg: PromptConfig): PromptConfig & ScopedKey {
  return { ...cfg, scope: key.scope, scopeId: key.scopeId };
}

function routeDto(key: ScopedKey, cfg: RouteConfig): RouteConfig & ScopedKey {
  return { ...cfg, scope: key.scope, scopeId: key.scopeId };
}

/** 白名单复制：即便仓储多带字段，也绝不可能把 ciphertext 漏进响应 */
function keyDto(key: ProviderKey): ProviderKey {
  const dto: ProviderKey = {
    id: key.id,
    provider: key.provider,
    label: key.label,
    keyHint: key.keyHint,
    enabled: key.enabled,
    createdAt: key.createdAt,
    models: [...key.models],
  };
  if (key.baseUrl !== undefined) dto.baseUrl = key.baseUrl;
  return dto;
}

/** §11 的 items 带 createdAt，但 §6.2 的 ConversationStore 只回 role/content；
 * 存储实现若额外带上 createdAt 就原样透出，不改契约、不在 HTTP 层再造一次查询 */
function conversationDto(row: ChatMessage): { role: string; content: string; createdAt?: string } {
  const dto: { role: string; content: string; createdAt?: string } = { role: row.role, content: row.content };
  const createdAt = (row as ChatMessage & { createdAt?: unknown }).createdAt;
  if (typeof createdAt === 'string') dto.createdAt = createdAt;
  return dto;
}

interface SummaryMessageDto {
  id: number;
  role: string;
  author?: string;
  content: string;
  createdAt?: string;
}

/** §25.3：作者 / 时间缺失时干脆不出键，前端据此区分「没记」与「空串」 */
function summaryMessageDto(row: StoredMessage): SummaryMessageDto {
  const dto: SummaryMessageDto = { id: row.id, role: row.role, content: row.content };
  const author = (row.author ?? '').trim();
  if (author !== '') dto.author = author;
  const createdAt = (row.createdAt ?? '').trim();
  if (createdAt !== '') dto.createdAt = createdAt;
  return dto;
}

/** §25.4：coveredUntilId 是 messages.id，非负整数；后台数字输入框可能回传纯数字串，照收 */
function readCoveredUntilId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** §26.4：条数从严收：整数或纯数字串（与 readCoveredUntilId 同一口径），小数/负数/布尔一律不合法 */
function readMemoryCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** §26.4：注入条数 ≥ 2，不设上限（2026-10-27 起） */
function isHistoryMaxMessages(value: number): boolean {
  return value >= MIN_MEMORY_MESSAGES;
}

/** §26.4：自动总结阈值 0（关闭）或 ≥ 2，不设上限 —— 1 无意义，所以要拒 */
function isSummaryEveryMessages(value: number): boolean {
  return value === 0 || isHistoryMaxMessages(value);
}

/** §26.4：摘要注入预算 500..20000 */
function isSummaryMaxChars(value: number): boolean {
  return value >= MIN_SUMMARY_MAX_CHARS && value <= MAX_SUMMARY_MAX_CHARS;
}

/** §26.4：摘要注入预算；缺省与 0 都算「未设置」，其余必须落在 500..20000，非法回 null（= 400） */
function readSummaryMaxChars(value: unknown): number | null {
  if (value === undefined) return 0;
  const parsed = readMemoryCount(value);
  if (parsed === null) return null;
  if (parsed === 0) return 0;
  return isSummaryMaxChars(parsed) ? parsed : null;
}

/** §55：上下文工具模式开关；缺省 = 关，只认真正的 boolean（1 / "true" 这类一律 400） */
function readContextTool(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === 'boolean' ? value : null;
}

/** §25.4：上界 = 该频道当前最大 messages.id，空频道算 0（loadLatest 已翻成正序） */
async function latestMessageId(conversations: ConversationStore, key: ChannelKey): Promise<number> {
  const rows = await conversations.loadLatest(key, 1);
  const last = rows.at(-1);
  return last === undefined ? 0 : last.id;
}

function badRequest(c: Context): Response {
  return c.json({ error: 'BAD_REQUEST' }, 400);
}

/** dialect 只认清单里的两个值：用户输入的任意字符串不许进库 */
function isTtsDialect(value: string): value is TtsDialect {
  return TTS_DIALECTS.some((option) => option.id === value);
}

/** TTS 的 url 必须是 http/https：别的协议 createTts 也发不出去，早点挡在保存这一步 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** 空白一律存空串（= 用服务端默认），有内容就原样存，不替用户改大小写与首尾空格 */
function normalizeTtsField(raw: string): string {
  return raw.trim() === '' ? '' : raw;
}

/** mp3 字节转 base64：分段喂 fromCharCode，几 MB 的音频也不会炸栈 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x2000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** §21.5：未配置时 GET 也要给出完整形状，前端不必再兜一层缺省 */
const DEFAULT_REACTION_MODEL: ReactionModelConfig = { enabled: false, provider: 'openai-compat', model: '' };

interface LoginLimiter {
  /** 记一次尝试；额度用尽返回 true */
  hit(ip: string): boolean;
}

function createLoginLimiter(now: Clock): LoginLimiter {
  const attempts = new Map<string, number[]>();
  return {
    hit(ip: string): boolean {
      const at = now();
      // 只留窗口内的记录，避免 Map 随 IP 数与时间无界增长
      const recent = (attempts.get(ip) ?? []).filter((stamp) => at - stamp < LOGIN_WINDOW_MS);
      if (recent.length >= LOGIN_MAX_ATTEMPTS) {
        attempts.set(ip, recent);
        return true;
      }
      recent.push(at);
      attempts.set(ip, recent);
      return false;
    },
  };
}

/** 登录失败要留痕，但写日志失败只 warn、绝不改变登录响应（§19.1、§19.8）；message 里只有 IP，没有口令 */
async function recordLoginFailure(logs: LogStore, now: Clock, ip: string): Promise<void> {
  try {
    await logs.append([
      { level: 'warn', scope: 'admin', message: '登录失败 ip=' + ip, createdAt: new Date(now()).toISOString() },
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[log] 写日志失败：' + message);
  }
}

export function createAdminApp(deps: AdminAppDeps): Hono {
  const now: Clock = deps.now ?? (() => Date.now());
  const auth = createSessionAuth({ adminPassword: deps.adminPassword, sessionSecret: deps.sessionSecret, now });
  const loginLimiter = createLoginLimiter(now);
  const probe = deps.probeKey;
  const app = new Hono();

  // login 与 health 是唯一的免鉴权入口，其余 /api/* 一律先验 Cookie
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/login' || path === '/api/health') {
      await next();
      return;
    }
    if (!(await auth.verify(getCookie(c, SESSION_COOKIE)))) {
      return c.json({ error: 'UNAUTHORIZED' }, 401);
    }
    await next();
  });

  // 仓储/加密异常不该以 Hono 默认的纯文本 500 冒到 SPA
  app.onError((_error, c) => c.json({ error: 'INTERNAL' }, 500));

  app.get('/api/health', (c) => c.json({ ok: true, version: deps.appVersion }));

  app.post('/api/login', async (c) => {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    if (loginLimiter.hit(ip)) return c.json({ error: 'TOO_MANY_ATTEMPTS' }, 429);

    const body = await readJsonBody(c);
    const password = body === null ? undefined : readString(body, 'password');
    if (password === undefined) return badRequest(c);
    if (!(await auth.verifyPassword(password))) {
      await recordLoginFailure(deps.logs, now, ip);
      return c.json({ error: 'BAD_PASSWORD' }, 401);
    }

    setCookie(c, SESSION_COOKIE, await auth.issue(), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return c.json({ ok: true });
  });

  app.post('/api/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'Strict' });
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => c.json({ authed: true }));

  app.get('/api/prompts', async (c) => c.json({ items: await deps.prompts.list() }));

  app.put('/api/prompts', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    const temperature = readOptionalNumber(body, 'temperature', TEMPERATURE_BOUNDS);
    const maxTokens = readOptionalNumber(body, 'maxTokens', MAX_TOKENS_BOUNDS);
    if (temperature.invalid || maxTokens.invalid) return badRequest(c);

    const segments = readPromptSegments(body['segments']);
    if (segments === null) return c.json({ error: 'BAD_PROMPT_SEGMENTS' }, 400);

    // 逐段查未知变量：某一段写错一个 {{var}} 就整次拒绝，别让半截模板进库。
    // 停用的段不查：它根本不进 prompt，写错一个字不该把整组挡在门外
    const vars = collectUnknownVars(
      ...segments.filter((segment) => segment.enabled).map((segment) => segment.content),
    );
    if (vars.length > 0) return c.json({ error: 'UNKNOWN_TEMPLATE_VAR', vars }, 400);

    const cfg: PromptConfig = { segments };
    if (temperature.value !== undefined) cfg.temperature = temperature.value;
    if (maxTokens.value !== undefined) cfg.maxTokens = maxTokens.value;

    await deps.prompts.put(key, cfg);
    return c.json(promptDto(key, cfg));
  });

  app.delete('/api/prompts', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    await deps.prompts.remove(key);
    return c.json({ ok: true });
  });

  /**
   * 把源作用域「此刻真正生效」的整份预设写成目标层的显式配置。
   * 解析链与线上逐层一致（channel > guild > global > 后台内置默认 > DEFAULT_PROMPT），
   * 所以源层是空的时候复制到的是它正在借用的那一层，而不是一份空配置。
   */
  app.post('/api/prompts/copy', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);

    const from = readScopeKey({ scope: body['fromScope'], scopeId: body['fromScopeId'] });
    if (from === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (from === null) return badRequest(c);
    const to = readScopeKey({ scope: body['toScope'], scopeId: body['toScopeId'] });
    if (to === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (to === null) return badRequest(c);
    if (from.scope === to.scope && from.scopeId === to.scopeId) {
      return c.json({ error: 'SAME_TARGET' }, 400);
    }

    // 频道作源时请求里没有服务器 id：拿这个频道在消息表里最近一次出现的服务器反查；
    // 频道从没说过话就拿不到，此时跳过 guild 层继续往下（不报错，响应里的 sourceScope 如实说明落到哪层）
    const guildId =
      from.scope === 'guild'
        ? from.scopeId
        : from.scope === 'channel'
          ? (await deps.conversations.guildOfChannel?.(from.scopeId)) ?? null
          : null;

    const [channelCfg, guildCfg, globalCfg] = await Promise.all([
      from.scope === 'channel' ? deps.prompts.get({ scope: 'channel', scopeId: from.scopeId }) : Promise.resolve(null),
      guildId === null ? Promise.resolve(null) : deps.prompts.get({ scope: 'guild', scopeId: guildId }),
      deps.prompts.get({ scope: 'global', scopeId: '' }),
    ]);

    // 第四层是后台可编辑的内置默认，本身也分层：源是频道就查频道→guild→global，源是服务器就查 guild→global
    const defaultLayers: ScopedKey[] = [];
    if (from.scope === 'channel') defaultLayers.push({ scope: 'channel', scopeId: from.scopeId });
    if (guildId !== null) defaultLayers.push({ scope: 'guild', scopeId: guildId });
    defaultLayers.push({ scope: 'global', scopeId: '' });
    const defaultRows = await Promise.all(defaultLayers.map((key) => deps.promptDefaults.get(key)));
    const defaultContent = new Map<Scope, string>();
    defaultLayers.forEach((key, index) => {
      const content = defaultRows[index]?.fallback?.content;
      if (content !== undefined) defaultContent.set(key.scope, content);
    });
    const fallback = resolveFallbackPrompt(
      defaultContent.get('channel') ?? null,
      defaultContent.get('guild') ?? null,
      defaultContent.get('global') ?? null,
    );

    const hit = resolvePrompt(channelCfg, guildCfg, globalCfg, fallback);
    // resolvePrompt 实现上永不返回 null；类型上仍写着 null，这里显式挡掉而不是靠断言
    if (hit === null) return badRequest(c);

    // 深拷贝：段对象来自仓储或内置常量，原样塞给 put 会让两层的段绑在同一批对象上
    const cfg: PromptConfig = { segments: hit.cfg.segments.map((segment) => ({ ...segment })) };
    if (hit.cfg.temperature !== undefined) cfg.temperature = hit.cfg.temperature;
    if (hit.cfg.maxTokens !== undefined) cfg.maxTokens = hit.cfg.maxTokens;

    await deps.prompts.put(to, cfg);
    // 落到内置默认或 DEFAULT_PROMPT 时 scope 记 global、scopeId 记 ''（与 resolvePrompt 的约定一致）
    const sourceScopeId = hit.scope === 'channel' ? from.scopeId : hit.scope === 'guild' ? (guildId ?? '') : '';
    return c.json({ ...promptDto(to, cfg), sourceScope: hit.scope, sourceScopeId });
  });

  app.get('/api/prompt-injections', async (c) => {
    const store = deps.promptInjections;
    if (store === undefined) return c.json({ error: 'INJECTION_UNAVAILABLE' }, 501);
    return c.json({ items: await store.list() });
  });

  app.put('/api/prompt-injections', async (c) => {
    const store = deps.promptInjections;
    if (store === undefined) return c.json({ error: 'INJECTION_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 空正文是合法值：它是「这一层关掉」的写法，解析层会把空串当没配置继续往下找
    const content = body['content'];
    if (typeof content !== 'string' || content.length > INJECTION_CONTENT_MAX_CHARS) {
      return c.json({ error: 'BAD_INJECTION_CONTENT' }, 400);
    }
    const depth = body['depth'];
    if (!isInjectionDepth(depth)) return c.json({ error: 'BAD_INJECTION_DEPTH' }, 400);
    const role = body['role'];
    if (!isInjectionRole(role)) return c.json({ error: 'BAD_INJECTION_ROLE' }, 400);

    const saved = await store.put({ scope: key.scope, scopeId: key.scopeId, content, depth, role });
    return c.json(saved);
  });

  app.delete('/api/prompt-injections', async (c) => {
    const store = deps.promptInjections;
    if (store === undefined) return c.json({ error: 'INJECTION_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    await store.remove(key);
    return c.json({ ok: true });
  });

  // 世界书（酒馆 lorebook）：一层可以有多本，导入永远新增一本；core 按 channel > guild > global 选层，层内启用的全参与。
  // GET 只回条目摘要：正文可能有几千字，后台列表用不上，正文只在触发时由 core 读
  app.get('/api/world-book', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const records = await store.list();
    return c.json({
      items: records.map((record) => ({
        scope: record.scope,
        scopeId: record.scopeId,
        bookId: record.bookId,
        name: record.name,
        enabled: record.enabled,
        entryCount: record.entryCount,
        importedAt: record.importedAt,
        entries: record.book.entries.map(worldEntrySummary),
      })),
    });
  });

  // 导入永远新增一本：同名不覆盖，重名由 uniqueWorldBookName 加「（2）」区分（只给后台看，不参与匹配）
  app.post('/api/world-book/import', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 解析失败就整本拒绝：半本进库后查起来比「没导入成功」难得多
    const parsed = parseWorldBook(body['book']);
    if (!parsed.ok) return c.json({ error: parsed.error, detail: parsed.detail }, 400);

    const records = await store.list();
    const sameLayer = records.filter((record) => record.scope === key.scope && record.scopeId === key.scopeId);
    const name = uniqueWorldBookName(sameLayer.map((record) => record.name), parsed.value.name);
    const saved = await store.create({ scope: key.scope, scopeId: key.scopeId, name, book: parsed.value });
    return c.json({
      scope: saved.scope,
      scopeId: saved.scopeId,
      bookId: saved.bookId,
      name: saved.name,
      entryCount: saved.entryCount,
      ignored: parsed.value.ignored,
      warnings: parsed.value.warnings,
      layerCount: sameLayer.length + 1,
    });
  });

  // 删一本书：整本连同它的粘性/冷却记账一起移除（store.remove 里同批删）
  app.delete('/api/world-book', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const bookId = readWorldBookId(body['bookId']);
    if (bookId === null) return c.json({ error: 'BAD_BOOK_ID' }, 400);

    await store.remove(bookId);
    return c.json({ ok: true });
  });

  // 整本改动：enabled 切开关、name 改名，两个字段可以一起给；停用只是不参与装配，书还留在库里
  app.patch('/api/world-book', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const bookId = readWorldBookId(body['bookId']);
    if (bookId === null) return c.json({ error: 'BAD_BOOK_ID' }, 400);

    const rawEnabled = body['enabled'];
    const rawName = body['name'];
    if (rawEnabled === undefined && rawName === undefined) return c.json({ error: 'BAD_BOOK_UPDATE' }, 400);
    if (rawEnabled !== undefined && typeof rawEnabled !== 'boolean') return c.json({ error: 'BAD_BOOK_ENABLED' }, 400);
    let name: string | undefined;
    if (rawName !== undefined) {
      if (typeof rawName !== 'string') return c.json({ error: 'BAD_BOOK_NAME' }, 400);
      const wanted = rawName.trim();
      if (wanted === '' || wanted.length > WORLD_BOOK_NAME_MAX) return c.json({ error: 'BAD_BOOK_NAME' }, 400);
      name = wanted;
    }

    const saved = await store.update({ bookId, enabled: rawEnabled as boolean | undefined, name });
    if (saved === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    return c.json({ bookId: saved.bookId, name: saved.name, enabled: saved.enabled });
  });

  // 单条读取：列表为了截断不回正文，编辑弹窗要正文就只能按 bookId + id 单取一条
  app.get('/api/world-book/entry', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const bookId = readWorldBookId(c.req.query('bookId'));
    if (bookId === null) return c.json({ error: 'BAD_BOOK_ID' }, 400);

    const entryId = readWorldEntryId(c.req.query('id'));
    if (entryId === null) return c.json({ error: 'BAD_WORLD_ENTRY' }, 400);

    const record = await store.get(bookId);
    if (record === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    const entry = record.book.entries.find((item) => item.id === entryId);
    if (entry === undefined) return c.json({ error: 'WORLD_ENTRY_NOT_FOUND' }, 404);
    // 老库里的条目缺字段：读侧规范化后再回，弹窗拿到的形状与保存时完全一致
    return c.json({ entry: normalizeWorldEntry(entry) });
  });

  // 单条保存：只换同 id 那一条，整本回写；其余条目与 ignored/warnings 原样带过去
  app.put('/api/world-book/entry', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const bookId = readWorldBookId(body['bookId']);
    if (bookId === null) return c.json({ error: 'BAD_BOOK_ID' }, 400);

    // 校验先于查库：坏条目与「书不存在」无关，400 比 404 更容易定位
    const parsed = readWorldEntryInput(body['entry']);
    if (!parsed.ok) return c.json({ error: 'BAD_WORLD_ENTRY', detail: parsed.detail }, 400);
    const entry = parsed.entry;

    const record = await store.get(bookId);
    if (record === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    // 只允许改书里已有的条目：PUT 不做新增
    if (!record.book.entries.some((item) => item.id === entry.id)) {
      return c.json({ error: 'WORLD_ENTRY_NOT_FOUND' }, 404);
    }

    const saved = await store.update({
      bookId,
      book: {
        ...record.book,
        entries: record.book.entries.map((item) => (item.id === entry.id ? entry : item)),
      },
    });
    if (saved === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    return c.json({ entry });
  });

  // 新建单条：id 由服务端分配（本书 max + 1）；不带 bookId 时按层新建一本，bookName 必填
  app.post('/api/world-book/entry', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const rawBookId = body['bookId'];
    const hasBookId = rawBookId !== undefined && rawBookId !== null;
    let key: ScopedKey | null = null;
    if (!hasBookId) {
      const parsedKey = readScopeKey(body);
      if (parsedKey === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
      if (parsedKey === null) return badRequest(c);
      key = parsedKey;
    }

    // 校验先于查库：坏条目与「书不存在」无关，400 比 404 更好定位
    const parsed = readWorldEntryInput(body['entry'], { requireId: false });
    if (!parsed.ok) return c.json({ error: 'BAD_WORLD_ENTRY', detail: parsed.detail }, 400);

    let record: WorldBookRecord | null = null;
    if (hasBookId) {
      const bookId = readWorldBookId(rawBookId);
      if (bookId === null) return c.json({ error: 'BAD_BOOK_ID' }, 400);
      record = await store.get(bookId);
      if (record === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    }

    let bookName = record === null ? '' : record.name;
    let sameLayer: WorldBookRecord[] = [];
    if (record === null && key !== null) {
      // 这一层还没有这本书：书名是用户自己填的（导入那条路仍由酒馆的书名决定）
      const raw = body['bookName'];
      const wanted = typeof raw === 'string' ? raw.trim() : '';
      if (wanted === '' || wanted.length > WORLD_BOOK_NAME_MAX) return c.json({ error: 'BAD_BOOK_NAME' }, 400);
      const records = await store.list();
      sameLayer = records.filter((item) => item.scope === key.scope && item.scopeId === key.scopeId);
      bookName = uniqueWorldBookName(sameLayer.map((item) => item.name), wanted);
    }

    // 新 id 只在本书内唯一且只增不减：计数器落进 book_json 的 nextEntryId，
    // 删掉最大号再新建也不会复用——粘性/冷却按 entryId 记账，复用会把旧账串给新条目
    const maxId = record === null ? 0 : record.book.entries.reduce((max, item) => Math.max(max, item.id), 0);
    const nextId = Math.max(record === null ? 0 : record.book.nextEntryId ?? 0, maxId + 1, 1);
    const entry: WorldEntry = { ...parsed.entry, id: nextId };
    const base: WorldBook = record === null ? { name: bookName, entries: [], ignored: [], warnings: [] } : record.book;
    const book: WorldBook = { ...base, entries: [...base.entries, entry], nextEntryId: nextId + 1 };

    const saved =
      record === null && key !== null
        ? await store.create({ scope: key.scope, scopeId: key.scopeId, name: bookName, book })
        : record === null
          ? null
          : await store.update({ bookId: record.bookId, book });
    if (saved === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    return c.json({
      entry,
      bookId: saved.bookId,
      name: saved.name,
      entryCount: saved.entryCount,
      importedAt: saved.importedAt,
      createdBook: record === null,
    });
  });

  // 删除单条：删到一条不剩就连整本书一起移除，这一层才不会留一本空书
  app.delete('/api/world-book/entry', async (c) => {
    const store = deps.worldBooks;
    if (store === undefined) return c.json({ error: 'WORLDBOOK_UNAVAILABLE' }, 501);
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const bookId = readWorldBookId(body['bookId']);
    if (bookId === null) return c.json({ error: 'BAD_BOOK_ID' }, 400);

    // 删除走 JSON body，id 是数字；读查询参数那套字符串口径在这不适用
    const entryId = readBoundedWorldInt(body['id'], 0, Number.MAX_SAFE_INTEGER);
    if (entryId === null) return c.json({ error: 'BAD_WORLD_ENTRY', detail: 'id 必须是非负整数' }, 400);

    const record = await store.get(bookId);
    if (record === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    if (!record.book.entries.some((item) => item.id === entryId)) {
      return c.json({ error: 'WORLD_ENTRY_NOT_FOUND' }, 404);
    }

    const entries = record.book.entries.filter((item) => item.id !== entryId);
    if (entries.length === 0) {
      await store.remove(bookId);
      return c.json({ ok: true, entryCount: 0, removedBook: true });
    }
    const saved = await store.update({ bookId, book: { ...record.book, entries } });
    if (saved === null) return c.json({ error: 'WORLD_BOOK_NOT_FOUND' }, 404);
    return c.json({ ok: true, entryCount: saved.entryCount, removedBook: false });
  });

  // 酒馆预设导入：整层覆盖目标层（global / guild / channel）的段，采样参数按同一层读旧值原样带过去。
  // 原始 JSON 按层各存一行（global 仍是 'latest'，其它层 'latest:<scope>:<scopeId>'），
  // 后续阶段读世界书与正则都从目标层那一行来
  app.post('/api/prompts/import', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return c.json({ error: 'BAD_PRESET', detail: '请求体必须是 JSON 对象' }, 400);
    // 层级先校验：非法层或缺 scopeId 时一段不写、一行存档不落（本请求后面全是写库）
    const key = readImportScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    const preset = body['preset'];
    if (!isRecord(preset)) return c.json({ error: 'BAD_PRESET', detail: 'preset 缺失或不是对象' }, 400);
    // charName 缺省按空串交给解析器：接口不替用户编名字，解析器会自己记一条 warning
    const charName = readString(body, 'charName') ?? '';

    const result = importSillyTavernPreset(preset, charName);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, 400);
    const imported = result.value;

    // 与 PUT /api/prompts 同一口径：停用的段不查，写错一个宏不该把整份预设挡在门外
    const vars = collectUnknownVars(
      ...imported.segments.filter((segment) => segment.enabled).map((segment) => segment.content),
    );
    if (vars.length > 0) return c.json({ error: 'UNKNOWN_TEMPLATE_VAR', vars }, 400);

    // 覆盖前先读目标层的旧值：只换段，temperature / maxTokens 原样带过去
    const existing = await deps.prompts.get(key);
    const cfg: PromptConfig = {
      segments: imported.segments.map((segment, index) => ({
        id: 'seg-' + crypto.randomUUID(),
        name: segment.name,
        role: segment.role,
        content: segment.content,
        enabled: segment.enabled,
        placement: segment.placement,
        position: index,
      })),
    };
    if (existing !== null && existing.temperature !== undefined) cfg.temperature = existing.temperature;
    if (existing !== null && existing.maxTokens !== undefined) cfg.maxTokens = existing.maxTokens;

    await deps.prompts.put(key, cfg);
    // 存的是请求里那份原文：后续阶段要按原结构读世界书与正则。
    // 存档 id 按层编码（global 沿用 'latest'），各层各占一行、互不覆盖
    const presetId =
      key.scope === 'global' ? LATEST_PRESET_ID : LATEST_PRESET_ID + ':' + key.scope + ':' + key.scopeId;
    await deps.presetImports.savePreset({
      id: presetId,
      name: readPresetName(preset),
      charName: imported.charName,
      sourceJson: JSON.stringify(preset),
    });

    // 历史后指令改由深度注入通道送出去：段已经落库，走到这里才轮到它；写的也是目标层的那一格。
    // 正文为空时一个字都不碰——用户手写在目标层的注入不该被一次「没有 jailbreak 的预设」抹掉
    let injection = { saved: false, chars: 0, replaced: false };
    const injectionStore = deps.promptInjections;
    if (injectionStore !== undefined && imported.postHistory.trim() !== '') {
      const previous = await injectionStore.get(key);
      await injectionStore.put({
        scope: key.scope,
        scopeId: key.scopeId,
        content: imported.postHistory,
        depth: 0,
        role: 'system',
      });
      // 空串是「这一层关着」而不是用户写过内容：只有旧值真有正文才算覆盖
      const replaced = previous !== null && previous.content.trim() !== '';
      // 按码点报字数：与导入侧的 20000 字截断同一个口径，别把 emoji 数成两个
      injection = { saved: true, chars: Array.from(imported.postHistory).length, replaced };
    }

    return c.json({
      segments: cfg.segments,
      ignored: imported.ignored,
      moved: imported.moved,
      injection,
      warnings: imported.warnings,
      charName: imported.charName,
      scope: key.scope,
      scopeId: key.scopeId,
      replaced: existing === null ? 0 : existing.segments.length,
    });
  });

  // §43 两份兜底文案按 channel > guild > global 三层存：GET 一次回全部层 + 变量表 + 代码默认原文/预览，
  // 后台不用另存一份常量，也不会把「渲染预览」写成第二份拼装逻辑
  app.get('/api/prompt-defaults', async (c) => {
    const items = sortPromptDefaults(await deps.promptDefaults.list());
    const codeFallback = DEFAULT_PROMPT.segments[0]?.content ?? '';
    return c.json({
      items,
      vars: { fallback: [...FALLBACK_PROMPT_VARS], identity: [...IDENTITY_PROMPT_VARS] },
      maxChars: MAX_PROMPT_DEFAULT_CHARS,
      scopes: [...PROMPT_DEFAULT_SCOPES],
      sampleVars: SAMPLE_PROMPT_VARS,
      codeDefaults: {
        fallback: { text: codeFallback, rendered: renderTemplate(codeFallback, SAMPLE_PROMPT_VARS) },
        identity: {
          text: CODE_IDENTITY_TEMPLATE,
          // 与线上装配同一个拼装函数：不是拿 CODE_IDENTITY_TEMPLATE 渲染冒充，两者字面不一致
          rendered: formatIdentityBlock({
            userName: SAMPLE_PROMPT_VARS.user_name,
            userId: SAMPLE_PROMPT_VARS.user_id,
            guildName: SAMPLE_PROMPT_VARS.guild_name,
            channelName: SAMPLE_PROMPT_VARS.channel_name,
            date: SAMPLE_PROMPT_VARS.date,
          }),
        },
      },
    });
  });

  app.put('/api/prompt-defaults', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);

    // 校验顺序固定：key → scope → content → 未知变量；后台按这个顺序提示错误
    const key = readString(body, 'key');
    if (key === undefined || !isPromptDefaultKey(key)) return c.json({ error: 'BAD_PROMPT_KEY' }, 400);

    const scoped = readScopeKey(body);
    if (scoped === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (scoped === null) return badRequest(c);

    const content = readString(body, 'content');
    if (content === undefined || content.trim() === '' || content.length > MAX_PROMPT_DEFAULT_CHARS) {
      return c.json({ error: 'BAD_PROMPT_CONTENT' }, 400);
    }

    // 拼错的 {{}} 在保存时就挡掉：进库以后每轮都要渲染，错一个变量名整块就没了
    const vars = findUnknownPromptDefaultVars(key, content);
    if (vars.length > 0) return c.json({ error: 'UNKNOWN_TEMPLATE_VAR', vars }, 400);

    // content 原样存（保留换行）：模板正文不是一行摘要
    const entry = await deps.promptDefaults.put({ key, scope: scoped.scope, scopeId: scoped.scopeId, content });
    return c.json(entry);
  });

  app.delete('/api/prompt-defaults', async (c) => {
    const key = c.req.query('key');
    if (key === undefined || !isPromptDefaultKey(key)) return c.json({ error: 'BAD_PROMPT_KEY' }, 400);

    // 查询串与 PUT 的 body 同一套口径：global 的 scopeId 恒为 ''，其余层缺 scopeId 就是缺必填
    const scoped = readScopeKey({ scope: c.req.query('scope'), scopeId: c.req.query('scopeId') });
    if (scoped === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (scoped === null) return badRequest(c);

    await deps.promptDefaults.remove({ key, scope: scoped.scope, scopeId: scoped.scopeId });
    return c.json({ ok: true });
  });

  // 预览不落库：后台边打字边看渲染结果，未知变量点名返回而不是整段失败
  app.post('/api/prompt-defaults/preview', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);

    const key = readString(body, 'key');
    if (key === undefined || !isPromptDefaultKey(key)) return c.json({ error: 'BAD_PROMPT_KEY' }, 400);

    const content = readString(body, 'content');
    if (content === undefined) return c.json({ error: 'BAD_PROMPT_CONTENT' }, 400);

    // 空白正文是合法预览：后台刚清空输入框时不该报错
    if (content.trim() === '') return c.json({ key, rendered: '', unknownVars: [] });

    const preview = previewPromptDefault(key, content, SAMPLE_PROMPT_VARS);
    return c.json({ key, rendered: preview.rendered, unknownVars: preview.unknownVars });
  });

  app.get('/api/routes', async (c) => c.json({ items: await deps.routes.list() }));

  app.put('/api/routes', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    const temperature = readOptionalNumber(body, 'temperature', TEMPERATURE_BOUNDS);
    const maxTokens = readOptionalNumber(body, 'maxTokens', MAX_TOKENS_BOUNDS);
    const topP = readOptionalNumber(body, 'topP', TOP_P_BOUNDS);
    const topK = readOptionalNumber(body, 'topK', TOP_K_BOUNDS);
    const seed = readOptionalNumber(body, 'seed', SEED_BOUNDS);
    const frequencyPenalty = readOptionalNumber(body, 'frequencyPenalty', PENALTY_BOUNDS);
    const presencePenalty = readOptionalNumber(body, 'presencePenalty', PENALTY_BOUNDS);
    if (
      temperature.invalid ||
      maxTokens.invalid ||
      topP.invalid ||
      topK.invalid ||
      seed.invalid ||
      frequencyPenalty.invalid ||
      presencePenalty.invalid
    ) {
      return badRequest(c);
    }

    const rawPrimary = body['primary'];
    if (!isRecord(rawPrimary)) return badRequest(c);
    const primaryProvider = readProvider(rawPrimary['provider']);
    if (primaryProvider === 'BAD_PROVIDER') return c.json({ error: 'BAD_PROVIDER' }, 400);
    const primaryModel = readString(rawPrimary, 'model');
    if (primaryModel === undefined) return badRequest(c);

    const fallbacks: ModelRef[] = [];
    const rawFallbacks = body['fallbacks'];
    if (rawFallbacks !== undefined && rawFallbacks !== null) {
      if (!Array.isArray(rawFallbacks)) return badRequest(c);
      for (const item of rawFallbacks) {
        if (!isRecord(item)) return badRequest(c);
        const provider = readProvider(item['provider']);
        if (provider === 'BAD_PROVIDER') return c.json({ error: 'BAD_PROVIDER' }, 400);
        const model = readString(item, 'model');
        if (model === undefined) return badRequest(c);
        fallbacks.push({ provider, model });
      }
    }

    const cfg: RouteConfig = { primary: { provider: primaryProvider, model: primaryModel }, fallbacks };
    if (temperature.value !== undefined) cfg.temperature = temperature.value;
    if (maxTokens.value !== undefined) cfg.maxTokens = maxTokens.value;
    if (topP.value !== undefined) cfg.topP = topP.value;
    if (topK.value !== undefined) cfg.topK = topK.value;
    if (seed.value !== undefined) cfg.seed = seed.value;
    if (frequencyPenalty.value !== undefined) cfg.frequencyPenalty = frequencyPenalty.value;
    if (presencePenalty.value !== undefined) cfg.presencePenalty = presencePenalty.value;

    await deps.routes.put(key, cfg);
    return c.json(routeDto(key, cfg));
  });

  app.delete('/api/routes', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    await deps.routes.remove(key);
    return c.json({ ok: true });
  });

  app.get('/api/keys', async (c) => c.json({ items: (await deps.keys.list()).map(keyDto) }));

  app.post('/api/keys', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const provider = readProvider(body['provider']);
    if (provider === 'BAD_PROVIDER') return c.json({ error: 'BAD_PROVIDER' }, 400);

    const label = readString(body, 'label');
    const apiKey = readString(body, 'apiKey');
    const baseUrl = readOptionalString(body, 'baseUrl');
    if (label === undefined || label === '' || apiKey === undefined || apiKey === '' || baseUrl.invalid) {
      return badRequest(c);
    }

    const models = readKeyModels(body['models']);
    if (models === null) return c.json({ error: 'BAD_MODELS' }, 400);

    const input: { provider: ProviderId; label: string; baseUrl?: string; apiKey: string; models: string[] } = {
      provider,
      label,
      apiKey,
      models,
    };
    if (baseUrl.value !== undefined && baseUrl.value !== '') input.baseUrl = baseUrl.value;

    return c.json(keyDto(await deps.keys.create(input)), 201);
  });

  app.patch('/api/keys/:id', async (c) => {
    // §81：只翻启用位，不动密钥本身；仓储没实现这个能力时明确回 501，不假装改过
    const setEnabled = deps.keys.setEnabled;
    if (setEnabled === undefined) return c.json({ error: 'KEY_UPDATE_UNAVAILABLE' }, 501);

    const body = await readJsonBody(c);
    if (body === null || typeof body['enabled'] !== 'boolean') return c.json({ error: 'BAD_ENABLED' }, 400);

    const saved = await setEnabled.call(deps.keys, c.req.param('id'), body['enabled']);
    if (saved === null) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json(keyDto(saved));
  });

  app.delete('/api/keys/:id', async (c) => {
    await deps.keys.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/keys/:id/test', async (c) => {
    if (probe === undefined) return c.json({ ok: false, error: 'PROBE_UNAVAILABLE' }, 501);

    const decrypted = await deps.keys.getDecrypted(c.req.param('id'));
    if (decrypted === null) return c.json({ ok: false, error: 'NOT_FOUND' }, 404);

    const input: { provider: ProviderId; apiKey: string; baseUrl?: string } = {
      provider: decrypted.provider,
      apiKey: decrypted.apiKey,
    };
    if (decrypted.baseUrl !== undefined) input.baseUrl = decrypted.baseUrl;

    try {
      return c.json({ ok: true, models: await probe(input) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 502);
    }
  });

  app.get('/api/conversations', async (c) => {
    const guildId = c.req.query('guildId');
    const channelId = c.req.query('channelId');
    if (guildId === undefined || guildId === '' || channelId === undefined || channelId === '') {
      return badRequest(c);
    }

    const rawLimit = c.req.query('limit');
    const parsedLimit = rawLimit === undefined ? Number.NaN : Number.parseInt(rawLimit, 10);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_CONVERSATION_LIMIT)
        : DEFAULT_CONVERSATION_LIMIT;

    const rows = await deps.conversations.loadRecent({ guildId, channelId }, limit);
    return c.json({ items: rows.map(conversationDto) });
  });

  // §62：删一条短期记忆 —— 先删 Discord 那条（库里删掉就没正文可比对了），再删库里的行
  app.delete('/api/messages/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return c.json({ ok: false, error: 'BAD_MESSAGE_ID' }, 400);
    }

    const store = deps.conversations;
    if (store.getById === undefined || store.removeById === undefined) {
      return c.json({ ok: false, error: 'HISTORY_DELETE_UNAVAILABLE' }, 501);
    }

    const row = await store.getById(id);
    if (row === null) return c.json({ ok: false, error: 'MESSAGE_NOT_FOUND' }, 404);

    // Discord 侧删不掉（歧义 / 早被删 / 没 token）也照样删库：后台把 Discord 的真实结局回给使用者
    let discord = 'skipped';
    let detail = '没接线 Discord 删除，只在库里删掉了';
    if (deps.pruneDiscordMessage !== undefined) {
      try {
        const result = await deps.pruneDiscordMessage(row);
        discord = result.outcome;
        detail = result.detail;
      } catch (error) {
        discord = 'failed';
        detail = '删除 Discord 消息时出错：' + (error instanceof Error ? error.message : String(error));
      }
    }

    const deleted = await store.removeById(id);
    return c.json({ ok: true, deleted, discord, detail, message: summaryMessageDto(row) });
  });

  // 增量轮询：items 按 id 升序，latest 是最后一条的 id（空结果时回退成 after）
  app.get('/api/logs', async (c) => {
    const after = readQueryInt(c.req.query('after'), 0);
    const limit = Math.min(Math.max(readQueryInt(c.req.query('limit'), DEFAULT_LOG_LIMIT), MIN_LOG_LIMIT), MAX_LOG_LIMIT);
    const items = await deps.logs.list(after, limit);
    const last = items.at(-1);
    return c.json({ items, latest: last === undefined ? after : last.id });
  });

  // PG 中继报错：只读透传，key 已在中继侧 mask；中继没配回 501，取不到回 502 带一句中文原因
  app.get('/api/pg-errors', async (c) => {
    const source = deps.pgErrors;
    if (source === undefined || !source.configured) {
      return c.json({ error: 'PG_ERRORS_UNAVAILABLE' }, 501);
    }
    const limit = clampPgErrorsLimit(readQueryInt(c.req.query('limit'), PG_ERRORS_DEFAULT_LIMIT));
    try {
      return c.json(await source.list(limit));
    } catch (error) {
      const detail = error instanceof PgErrorsUnavailableError ? error.detail : 'PG 中继请求失败';
      return c.json({ error: 'PG_ERRORS_UPSTREAM', detail }, 502);
    }
  });

  app.get('/api/reaction-model', async (c) => {
    const cfg = await deps.reactionModels.get();
    return c.json({ config: cfg ?? DEFAULT_REACTION_MODEL });
  });

  app.put('/api/reaction-model', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);

    const provider = readProvider(body['provider']);
    const enabled = body['enabled'];
    const model = readString(body, 'model');
    if (provider === 'BAD_PROVIDER' || typeof enabled !== 'boolean' || model === undefined) {
      return c.json({ error: 'BAD_REACTION_MODEL' }, 400);
    }

    // 开着却没有模型名 = 每轮都白发一次上游调用，直接拒；关掉时允许留空
    const trimmed = model.trim();
    if (enabled && trimmed === '') return c.json({ error: 'BAD_REACTION_MODEL' }, 400);

    const cfg: ReactionModelConfig = { enabled, provider, model: trimmed };
    await deps.reactionModels.put(cfg);
    return c.json(cfg);
  });

  app.get('/api/reaction-guides', async (c) => {
    // default 一起回：后台展示「三层都没有时长什么样」要用的就是这一份，前端不再抄一遍
    const items = await deps.reactionGuides.list();
    return c.json({ items, default: DEFAULT_REACTION_GUIDE });
  });

  app.put('/api/reaction-guides', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 空串一律拒（§28.10）：留空 = 回上层的语义由 DELETE 表达，一个动作只有一种叫法
    const raw = body['prompt'];
    const prompt = typeof raw === 'string' ? raw.trim() : '';
    if (typeof raw !== 'string' || prompt === '' || prompt.length > MAX_REACTION_GUIDE_CHARS) {
      return c.json({ error: 'BAD_REACTION_GUIDE' }, 400);
    }

    const saved: ReactionGuideConfig = await deps.reactionGuides.put({
      scope: key.scope,
      scopeId: key.scopeId,
      prompt,
    });
    return c.json(saved);
  });

  app.delete('/api/reaction-guides', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 删行 = 这一层回到没有配置，读侧自然落回上一层（§28.10）
    await deps.reactionGuides.remove(key);
    return c.json({ ok: true });
  });

  app.get('/api/body-emoji-guides', async (c) => {
    // default 一起回：后台展示「三层都没有时长什么样」要用的就是这一份，前端不再抄一遍。
    // suggestion 是推荐文案，只给「一键填入」按钮用，保存后才生效（default 空串 = 默认关）
    const items = await deps.bodyEmojiGuides.list();
    return c.json({
      items,
      default: DEFAULT_BODY_EMOJI_GUIDE,
      suggestion: BODY_EMOJI_SUGGESTION,
    });
  });

  app.put('/api/body-emoji-guides', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 空串一律拒：留空 = 回上层的语义由 DELETE 表达，一个动作只有一种叫法
    const raw = body['prompt'];
    const prompt = typeof raw === 'string' ? raw.trim() : '';
    if (typeof raw !== 'string' || prompt === '' || prompt.length > MAX_BODY_EMOJI_GUIDE_CHARS) {
      return c.json({ error: 'BAD_BODY_EMOJI_GUIDE' }, 400);
    }

    const saved: BodyEmojiGuideConfig = await deps.bodyEmojiGuides.put({
      scope: key.scope,
      scopeId: key.scopeId,
      prompt,
    });
    return c.json(saved);
  });

  app.delete('/api/body-emoji-guides', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 删行 = 这一层回到没有配置，读侧自然落回上一层
    await deps.bodyEmojiGuides.remove(key);
    return c.json({ ok: true });
  });

  app.get('/api/timeouts', async (c) => {
    // 顺手把库里的值重新装进进程：多 isolate / 多进程下这个 isolate 之前可能是旧值
    const stored = await deps.timeoutSettings.get();
    applyTimeoutOverrides(stored);
    return c.json(timeoutShape(stored));
  });

  app.put('/api/timeouts', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const defaults = timeoutDefaults();
    const next: Record<string, number> = {};
    // 整份给：少一项就是 400，避免「只提交改过的项」把别的项悄悄打回默认
    for (const field of TIMEOUT_FIELDS) {
      const raw = body[field.key];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return c.json({ error: 'BAD_TIMEOUT_SETTINGS' }, 400);
      if (raw < field.minMs || raw > field.maxMs) return c.json({ error: 'BAD_TIMEOUT_SETTINGS' }, 400);
      next[field.key] = raw;
    }
    const rawMultiplier = body['multiplier'];
    if (typeof rawMultiplier !== 'number' || !Number.isFinite(rawMultiplier)) {
      return c.json({ error: 'BAD_TIMEOUT_SETTINGS' }, 400);
    }
    if (rawMultiplier < MULTIPLIER_MIN || rawMultiplier > MULTIPLIER_MAX) {
      return c.json({ error: 'BAD_TIMEOUT_SETTINGS' }, 400);
    }
    next['multiplier'] = rawMultiplier;

    // 只落库「和基线不一样」的项：改回默认就删行，以后 .env 变了还能重新露出来
    const stored: Record<string, number> = {};
    for (const field of TIMEOUT_FIELDS) {
      const value = next[field.key] ?? 0;
      if (value !== defaults[field.key]) stored[field.key] = value;
    }
    if (rawMultiplier !== defaults.multiplier) stored['multiplier'] = rawMultiplier;

    await deps.timeoutSettings.put(stored);
    applyTimeoutOverrides(stored);
    return c.json(timeoutShape(stored));
  });

  app.delete('/api/timeouts', async (c) => {
    // 清空 = 恢复 .env 与内置默认；本来没有覆盖也回 200
    await deps.timeoutSettings.clear();
    resetTimeouts();
    const stored = await deps.timeoutSettings.get();
    return c.json(timeoutShape(stored));
  });

  app.get('/api/reaction-templates', async (c) => {
    // default 与 vars 一起回：后台要展示「三层都没有时时什么样」、还要给 6 个可插入的占位符，前端不再抄一遍
    const items = await deps.reactionTemplates.list();
    return c.json({ items, default: DEFAULT_REACTION_TEMPLATE, vars: REACTION_TEMPLATE_VARS });
  });

  app.put('/api/reaction-templates', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 空串一律拒（§34.5）：留空 = 回上层的语义由 DELETE 表达，一个动作只有一种叫法
    const raw = body['template'];
    const template = typeof raw === 'string' ? raw.trim() : '';
    if (typeof raw !== 'string' || template === '' || template.length > MAX_REACTION_TEMPLATE_CHARS) {
      return c.json({ error: 'BAD_REACTION_TEMPLATE' }, 400);
    }

    // 占位符写错一个字就得拒：未知变量渲染成空串，模型会以为那一段本来就没有内容
    const vars = collectReactionTemplateVars(template);
    const unknown = vars.filter((name) => !(REACTION_TEMPLATE_VARS as readonly string[]).includes(name));
    if (unknown.length > 0) return c.json({ error: 'UNKNOWN_TEMPLATE_VAR', vars: unknown }, 400);
    // 一个已知占位符都没有 = 素材里全是死文字，表情模型没得判断，贴不出来
    if (vars.length === 0) return c.json({ error: 'BAD_REACTION_TEMPLATE' }, 400);

    const saved: ReactionTemplateConfig = await deps.reactionTemplates.put({
      scope: key.scope,
      scopeId: key.scopeId,
      template,
    });
    return c.json(saved);
  });

  app.delete('/api/reaction-templates', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 删行 = 这一层回到没有配置，读侧自然落回上一层（§34.5）
    await deps.reactionTemplates.remove(key);
    return c.json({ ok: true });
  });

  app.get('/api/reply-settings', async (c) => {
    // default / min / max 一起回（§38）：后台要展示「三层都没配时是多少」与能填的区间，前端不抄常量
    const items = await deps.replySettings.list();
    return c.json({ items, default: DEFAULT_REVEAL_STEPS, min: REVEAL_STEPS_MIN, max: REVEAL_STEPS_MAX });
  });

  app.put('/api/reply-settings', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 0 是合法值（= 关闭假流式），只能按 isRevealSteps 判：用真假值判会把「关掉」当成没填
    const revealSteps = body['revealSteps'];
    if (!isRevealSteps(revealSteps)) return c.json({ error: 'BAD_REVEAL_STEPS' }, 400);

    const saved: RevealStepsConfig = await deps.replySettings.put({
      scope: key.scope,
      scopeId: key.scopeId,
      revealSteps,
    });
    return c.json(saved);
  });

  app.delete('/api/reply-settings', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 删行 = 这一层回到没有配置，读侧自然落回上一层（§38）
    await deps.replySettings.remove(key);
    return c.json({ ok: true });
  });

  app.get('/api/vision-settings', async (c) => {
    // default 一起回（§41）：后台要展示「三层都没配时是开还是关」，前端不抄常量
    const items = await deps.visionSettings.list();
    return c.json({ items, default: DEFAULT_VISION_ENABLED });
  });

  app.put('/api/vision-settings', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // false 是合法值（= 关掉主模型识图），只能按 isVisionEnabled 判：用真假值判会把「关掉」当成没填
    const enabled = body['enabled'];
    if (!isVisionEnabled(enabled)) return c.json({ error: 'BAD_ENABLED' }, 400);

    const saved: VisionSettingsConfig = await deps.visionSettings.put({
      scope: key.scope,
      scopeId: key.scopeId,
      enabled,
    });
    return c.json(saved);
  });

  app.delete('/api/vision-settings', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 删行 = 这一层回到没有配置，读侧自然落回上一层（§41）
    await deps.visionSettings.remove(key);
    return c.json({ ok: true });
  });

  app.get('/api/voice-settings', async (c) => {
    // 默认值、模式枚举、语速区间、导演模式一起回：后台不抄常量，前端也就不可能和 core 的判定跑偏
    const items = await deps.voiceSettings.list();
    return c.json({
      items,
      default: { mode: VOICE_MODE_OFF, voice: '', speed: VOICE_SPEED_DEFAULT, director: VOICE_DIRECTOR_OFF },
      modes: [VOICE_MODE_OFF, VOICE_MODE_ON_REQUEST, VOICE_MODE_ALWAYS],
      directorModes: [VOICE_DIRECTOR_OFF, VOICE_DIRECTOR_TAGS, VOICE_DIRECTOR_FREE],
      speedMin: VOICE_SPEED_MIN,
      speedMax: VOICE_SPEED_MAX,
    });
  });

  app.put('/api/voice-settings', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 0 是合法值（= 不念），只能按 isVoiceMode 判：用真假值判会把「关掉」当成没填
    const mode = body['mode'];
    if (!isVoiceMode(mode)) return c.json({ error: 'BAD_VOICE_MODE' }, 400);

    // 不填音色 = 用服务端默认音色；填了就必须是字符串（空格串等于没填）
    const rawVoice = body['voice'];
    if (rawVoice !== undefined && typeof rawVoice !== 'string') return badRequest(c);
    const voice = typeof rawVoice === 'string' ? rawVoice.trim() : '';

    // 不填语速 = 原速；填了就必须落在 50–200 的整数上
    const rawSpeed = body['speed'];
    const speed = rawSpeed === undefined ? VOICE_SPEED_DEFAULT : rawSpeed;
    if (!isVoiceSpeed(speed)) return c.json({ error: 'BAD_VOICE_SPEED' }, 400);

    // 不填导演模式 = 关（0）；0 本身合法，所以「填没填」只看 undefined，合法性只按 isVoiceDirector 判
    const rawDirector = body['director'];
    const director = rawDirector === undefined ? VOICE_DIRECTOR_OFF : rawDirector;
    if (!isVoiceDirector(director)) return c.json({ error: 'BAD_DIRECTOR_MODE' }, 400);

    const saved: VoiceSettingsConfig = await deps.voiceSettings.put({
      scope: key.scope,
      scopeId: key.scopeId,
      mode,
      voice,
      speed,
      director,
    });
    return c.json(saved);
  });

  app.delete('/api/voice-settings', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);

    // 删行 = 这一层回到没有配置，读侧自然落回上一层
    await deps.voiceSettings.remove(key);
    return c.json({ ok: true });
  });

  // 语音合成接口：后台是唯一来源（环境变量留着也不生效），GET 只回掩码，明文永不进响应
  const ttsDefaults = {
    // 顶层字段保持 openai 那份：老前端只认它们，加方言不该让老页面炸
    urlPlaceholder: TTS_URL_PLACEHOLDER,
    voices: TTS_VOICES,
    // 新前端按 dialects 切换整套默认值，defaultDialect 决定首次打开时停在哪一项
    dialects: TTS_DIALECTS,
    defaultDialect: TTS_DEFAULT_DIALECT,
  };

  const ttsView = async (): Promise<Record<string, unknown>> => {
    const stored = await deps.ttsSettings.get();
    const url = stored?.url ?? '';
    const key = stored?.key ?? '';
    const judgeKey = stored?.judgeKey ?? '';
    return {
      // 没有行 / url 空 / key 空，三者任一都是未配置（与仓储、运行时的判定同一口径）
      configured: stored !== null && url.trim() !== '' && key.trim() !== '',
      // 没有行时按 openai：老配置没写方言，行为与加这个字段之前一致
      dialect: stored?.dialect ?? TTS_DEFAULT_DIALECT,
      url,
      // get() 只回明文与其余字段（契约里 TtsSettingsSecret 不含掩码），掩码按同一函数现算
      keyHint: key.trim() === '' ? '' : maskKeyHint(key),
      // model 不再回显：合成时按方言取内置默认，库里的历史列只留给迁移与排错
      voice: stored?.voice ?? '',
      // judge 三字段都非空才算配好；key 只回掩码，明文永不出现在响应里
      judgeUrl: stored?.judgeUrl ?? '',
      judgeKeyHint: judgeKey.trim() === '' ? '' : maskKeyHint(judgeKey),
      judgeModel: stored?.judgeModel ?? '',
      judgeConfigured: isJudgeConfigured({ url: stored?.judgeUrl ?? '', key: judgeKey, model: stored?.judgeModel ?? '' }),
      updatedAt: stored?.updatedAt ?? '',
      defaults: ttsDefaults,
      envPresent: deps.ttsEnvPresent === true,
    };
  };

  app.get('/api/tts-settings', async (c) => c.json(await ttsView()));

  app.put('/api/tts-settings', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);

    // 顺序照契约：url -> dialect -> key -> model/voice，先报哪个错是后台提示文案的依据
    const rawUrl = body['url'];
    if (typeof rawUrl !== 'string') return c.json({ error: 'BAD_TTS_URL' }, 400);
    const url = rawUrl.trim();
    if (url === '' || url.length > TTS_MAX_URL_CHARS || !isHttpUrl(url)) {
      return c.json({ error: 'BAD_TTS_URL' }, 400);
    }

    const rawDialect = body['dialect'];
    if (rawDialect !== undefined && rawDialect !== null && typeof rawDialect !== 'string') {
      return c.json({ error: 'BAD_TTS_DIALECT' }, 400);
    }
    // 省略或空串 = openai：方言是后加的字段，不带它的请求行为与加字段之前完全一致
    const dialectField = typeof rawDialect === 'string' ? rawDialect.trim() : '';
    if (dialectField !== '' && !isTtsDialect(dialectField)) {
      return c.json({ error: 'BAD_TTS_DIALECT' }, 400);
    }
    const dialect: TtsDialect = dialectField === '' ? TTS_DEFAULT_DIALECT : dialectField;

    const rawKey = body['key'];
    if (rawKey !== undefined && rawKey !== null && typeof rawKey !== 'string') {
      return c.json({ error: 'BAD_TTS_KEY' }, 400);
    }
    // 空白 key 与「没给」等价：后台编辑时留空表示不改密钥
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (key !== '' && key.length > TTS_MAX_KEY_CHARS) return c.json({ error: 'BAD_TTS_KEY' }, 400);
    if (key === '') {
      const stored = await deps.ttsSettings.get();
      // 首次必须给 key；库里已有的可以省略，仓储会原样保留密文与掩码
      if (stored === null || stored.key.trim() === '') return c.json({ error: 'BAD_TTS_KEY' }, 400);
    }

    // model 不再是可写字段：传了就忽略，不报错（老前端还在发它，不该因此保存失败）
    const voiceField = readOptionalString(body, 'voice');
    const judgeUrlField = readOptionalString(body, 'judgeUrl');
    const judgeKeyField = readOptionalString(body, 'judgeKey');
    const judgeModelField = readOptionalString(body, 'judgeModel');
    if (voiceField.invalid) return badRequest(c);
    if (judgeUrlField.invalid || judgeKeyField.invalid || judgeModelField.invalid) {
      return c.json({ error: 'BAD_TTS_JUDGE' }, 400);
    }
    const voice = normalizeTtsField(voiceField.value ?? '');
    if (voice.trim().length > TTS_MAX_FIELD_CHARS) return badRequest(c);

    // judgeUrl：省略 = 保留旧值；空串 = 清掉；非空必须是 http/https 且不超过上限
    let judgeUrl: string | undefined;
    if (judgeUrlField.value !== undefined) {
      const trimmed = judgeUrlField.value.trim();
      if (trimmed.length > TTS_MAX_URL_CHARS || (trimmed !== '' && !isHttpUrl(trimmed))) {
        return c.json({ error: 'BAD_TTS_JUDGE' }, 400);
      }
      judgeUrl = trimmed;
    }
    // judgeKey：空白 = 保留旧密文（与 key 同一条规则），非空才重新加密
    const judgeKey = (judgeKeyField.value ?? '').trim();
    if (judgeKey.length > TTS_MAX_KEY_CHARS) return c.json({ error: 'BAD_TTS_JUDGE' }, 400);
    // judgeModel：省略 = 保留旧值，空串 = 清掉，非空不超过上限
    let judgeModel: string | undefined;
    if (judgeModelField.value !== undefined) {
      const trimmed = judgeModelField.value.trim();
      if (trimmed.length > TTS_MAX_FIELD_CHARS) return c.json({ error: 'BAD_TTS_JUDGE' }, 400);
      judgeModel = trimmed;
    }

    await deps.ttsSettings.put({
      url,
      dialect,
      ...(key === '' ? {} : { key }),
      ...(judgeUrl === undefined ? {} : { judgeUrl }),
      ...(judgeKey === '' ? {} : { judgeKey }),
      ...(judgeModel === undefined ? {} : { judgeModel }),
      voice,
    });
    return c.json(await ttsView());
  });

  app.delete('/api/tts-settings', async (c) => {
    // 删整行 = 回到未配置；不回显任何旧值
    await deps.ttsSettings.remove();
    return c.json({ ok: true });
  });

  app.post('/api/tts-settings/test', async (c) => {
    // body 整体可缺省：不带字段就用库里已存的（key 是解密值），带字段就只测这一份，不落库
    const body = (await readJsonBody(c)) ?? {};
    const urlField = readOptionalString(body, 'url');
    const dialectField = readOptionalString(body, 'dialect');
    const keyField = readOptionalString(body, 'key');
    const voiceField = readOptionalString(body, 'voice');
    const textField = readOptionalString(body, 'text');
    // style 是本次试听直接用的标签或语气词；不给就按 global 提示词 + 库里 judge 现算
    const styleField = readOptionalString(body, 'style');
    // model 不再是入参：老前端还在发，静默忽略
    if (
      urlField.invalid ||
      dialectField.invalid ||
      keyField.invalid ||
      voiceField.invalid ||
      textField.invalid ||
      styleField.invalid
    ) {
      return badRequest(c);
    }
    const rawStyle = (styleField.value ?? '').trim();
    if (rawStyle.length > TTS_STYLE_MAX_CHARS) return c.json({ error: 'BAD_TTS_STYLE' }, 400);

    const stored = await deps.ttsSettings.get();
    // body 带了方言就测这一份，没带就测库里存的；带了个不认识的词要明确报错，不能静默换成 openai
    const requestedDialect = (dialectField.value ?? '').trim();
    if (requestedDialect !== '' && !isTtsDialect(requestedDialect)) {
      return c.json({ error: 'BAD_TTS_DIALECT' }, 400);
    }
    const dialect: TtsDialect =
      requestedDialect === '' ? (stored?.dialect ?? TTS_DEFAULT_DIALECT) : requestedDialect;

    const effective: TtsSettingsSecret = {
      dialect,
      url: (urlField.value ?? stored?.url ?? '').trim(),
      key: (keyField.value ?? stored?.key ?? '').trim(),
      // 历史列：契约仍要求 secret 带它，合成侧已不再读
      model: stored?.model ?? '',
      voice: normalizeTtsField(voiceField.value ?? stored?.voice ?? ''),
      // judge 只能来自库里：试听接口不该临时收一份判断模型的密钥
      judgeUrl: stored?.judgeUrl ?? '',
      judgeKey: stored?.judgeKey ?? '',
      judgeModel: stored?.judgeModel ?? '',
      updatedAt: stored?.updatedAt ?? '',
    };

    // url 与 key 都得有，且 url 得能发出去；不满足就是「没配置」，不是上游的锅
    if (effective.url === '' || effective.key === '' || !isHttpUrl(effective.url)) {
      return c.json(
        {
          ok: false,
          code: 'TTS_NOT_CONFIGURED',
          message: effective.key === '' ? '还没有配置语音合成的密钥' : '还没有配置可用的语音合成地址',
        },
        400,
      );
    }

    const config = ttsConfigFrom(effective);
    if (config === null) {
      return c.json({ ok: false, code: 'TTS_NOT_CONFIGURED', message: '还没有配置语音合成接口' }, 400);
    }

    const rawText = (textField.value ?? '').trim() === '' ? TTS_TEST_TEXT : (textField.value ?? '');
    // 试听不设字数上限：念多长由上游接口自己的上限决定，这里只去掉首尾空白
    const text = rawText.trim();
    // speechUsed = 最终念出去的正文（可能带 judge 插进来的 [音频标签]）；
    // styleUsed = 实际标签（含括号），没有标签就是 null。
    // body 给了 style 就把它当标签/语气词归一化，正文一个字都不动；
    // 没给就走跟真实回复同一条 composeVoiceSpeech：global 提示词 + 库里 judge。
    // 导演档可选：带了就按那一档走 judge（后台试听导演效果用），不带仍按 0 档
    const rawDirector = body['director'];
    const director = rawDirector === undefined ? 0 : rawDirector;
    if (!isVoiceDirector(director)) return c.json({ error: 'BAD_DIRECTOR_MODE' }, 400);
    let speechUsed = text;
    let styleUsed: string | null = null;
    let directorRejected: string | null = null;
    // judge 那一行的原文（完整、不截断）：试听直接回显，不用翻库才知道它写了什么
    let judgeLine: string | null = null;
    if (rawStyle !== '') {
      const tag = normalizeStyleTag(rawStyle);
      styleUsed = tag === '' ? null : tag;
    } else {
      let prompt = '';
      try {
        const layer = await deps.ttsStyles.get({ scope: 'global', scopeId: '' });
        prompt = layer === null ? '' : layer.content;
      } catch {
        prompt = '';
      }
      const judge: TtsStyleJudgeConfig | null = isJudgeConfigured({
        url: effective.judgeUrl,
        key: effective.judgeKey,
        model: effective.judgeModel,
      })
        ? { url: effective.judgeUrl, key: effective.judgeKey, model: effective.judgeModel }
        : null;
      const speech = await composeVoiceSpeech({
        text,
        prompt,
        judge,
        director,
        dialect: effective.dialect,
        onJudgeLine: (line: string): void => {
          judgeLine = line;
        },
      });
      speechUsed = speech.text;
      styleUsed = speech.tag === '' ? null : speech.tag;
      directorRejected = speech.directorRejected ?? null;
    }
    const startedAt = Date.now();
    try {
      const port = createTts(config);
      const bytes = await port.synthesize({
        text: speechUsed,
        ...(styleUsed === null ? {} : { tag: styleUsed }),
      });
      return c.json({
        ok: true,
        bytes: bytes.length,
        durationMs: Date.now() - startedAt,
        // 试听页按这个 type 造 Blob：mp3 与 wav 都由端口自己声明
        contentType: port.file?.contentType ?? 'audio/mpeg',
        audioBase64: encodeBase64(bytes),
        speechUsed,
        styleUsed,
        director,
        directorRejected,
        judgeLine,
      });
    } catch (error) {
      // 上游报错与超时都归这一类：后台只需要「换地址/换 key/稍后再试」
      return c.json(
        {
          ok: false,
          code: 'TTS_UPSTREAM',
          message: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        },
        502,
      );
    }
  });

  // 三层语气提示词：channel > guild > global；GET 连上限一起回，后台不抄常量
  app.get('/api/tts-style', async (c) => {
    const items = sortTtsStyles(await deps.ttsStyles.list());
    return c.json({ items, maxChars: TTS_STYLE_MAX_CHARS });
  });

  app.put('/api/tts-style', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return badRequest(c);
    const key = readScopeKey(body);
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);
    const rawContent = body['content'];
    // 类型不对与超长同一条错误码：后台只需要「这段提示词没存进去」
    if (typeof rawContent !== 'string' || rawContent.length > TTS_STYLE_MAX_CHARS) {
      return c.json({ error: 'BAD_TTS_STYLE' }, 400);
    }
    const content = rawContent.trim();
    // trim 空 = 恢复这一层的默认（删行），与 prompt_defaults 的容器语义一致
    if (content === '') {
      await deps.ttsStyles.remove(key);
      return c.json({ ok: true, removed: true });
    }
    return c.json(await deps.ttsStyles.put({ scope: key.scope, scopeId: key.scopeId, content }));
  });

  app.delete('/api/tts-style', async (c) => {
    const key = readScopeKey({ scope: c.req.query('scope'), scopeId: c.req.query('scopeId') });
    if (key === 'BAD_SCOPE') return c.json({ error: 'BAD_SCOPE' }, 400);
    if (key === null) return badRequest(c);
    await deps.ttsStyles.remove(key);
    return c.json({ ok: true });
  });

  // §24.6：/api/emojis/live 这条更长的固定路径先于 /api/emojis 注册，谁也不抢谁
  app.get('/api/emojis/live', async (c) => {
    const guildId = readGuildId(c.req.query('guildId'));
    if (guildId === null) return c.json({ error: 'BAD_GUILD_ID' }, 400);

    const listEmojis = deps.listEmojis;
    if (listEmojis === undefined) return c.json({ error: 'EMOJI_LIST_UNAVAILABLE' }, 501);

    let emojis: CustomEmoji[];
    try {
      emojis = await listEmojis(guildId);
    } catch {
      // 上游（Discord）故障对上只体现成「清单拉不到」，不回错误原文
      return c.json({ error: 'EMOJI_LIST_FAILED' }, 502);
    }

    // 后台下拉的顺序：按 name 升序，同名的相对次序不保证，直接比字符串免得受 locale 影响
    const items = [...emojis]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((emoji) => ({ id: emoji.id, name: emoji.name, animated: emoji.animated === true }));
    return c.json({ items });
  });

  app.get('/api/emoji-aliases', async (c) => {
    const guildId = readGuildId(c.req.query('guildId'));
    if (guildId === null) return c.json({ error: 'BAD_GUILD_ID' }, 400);
    return c.json({ items: await deps.emojiAliases.list(guildId) });
  });

  app.put('/api/emoji-aliases', async (c) => {
    const body = await readJsonBody(c);
    // body 坏掉与缺 guildId 走同一个出口（与 §23.6 的 describe 同一口径）
    if (body === null) return c.json({ error: 'BAD_GUILD_ID' }, 400);
    const guildId = readGuildId(readString(body, 'guildId'));
    if (guildId === null) return c.json({ error: 'BAD_GUILD_ID' }, 400);

    const alias = readAlias(readString(body, 'alias'));
    if (alias === null) return c.json({ error: 'BAD_ALIAS' }, 400);

    const ref = readEmojiRef(readString(body, 'emojiId'), readString(body, 'emojiName'));
    if (ref === null) return c.json({ error: 'BAD_EMOJI' }, 400);

    // 回保存后的那一份：别名已 trim、表情名已 trim，前端不必再猜服务端存了什么
    const saved: EmojiAlias = { alias, emojiId: ref.emojiId, emojiName: ref.emojiName };
    await deps.emojiAliases.put(guildId, saved);
    return c.json(saved);
  });

  app.delete('/api/emoji-aliases', async (c) => {
    const guildId = readGuildId(c.req.query('guildId'));
    if (guildId === null) return c.json({ error: 'BAD_GUILD_ID' }, 400);

    const alias = readAlias(c.req.query('alias'));
    if (alias === null) return c.json({ error: 'BAD_ALIAS' }, 400);

    await deps.emojiAliases.remove(guildId, alias);
    return c.json({ ok: true });
  });

  app.get('/api/emojis', async (c) => {
    const guildId = readGuildId(c.req.query('guildId'));
    if (guildId === null) return c.json({ error: 'BAD_GUILD_ID' }, 400);
    return c.json({ items: await deps.emojiDescriptions.list(guildId) });
  });

  // §23.6 这条端点只有 BAD_GUILD_ID / DESCRIBE_UNAVAILABLE 两种失败：body 坏掉、缺 guildId 都按缺参数处理
  app.post('/api/emojis/describe', async (c) => {
    const body = await readJsonBody(c);
    const guildId = readGuildId(body === null ? undefined : readString(body, 'guildId'));
    if (guildId === null) return c.json({ error: 'BAD_GUILD_ID' }, 400);

    const describe = deps.describeEmojis;
    if (describe === undefined) return c.json({ error: 'DESCRIBE_UNAVAILABLE' }, 501);

    // force 只认严格的 true：缺省、字符串、1 一律当「只补缺的」，不会意外触发全量重认
    const force = body !== null && body['force'] === true;
    const result = await describe(guildId, force ? { force: true } : undefined);
    return c.json({ described: result.described, failed: result.failed });
  });

  // §25.3：五条后台路由都挂在 ALL /api/* 鉴权之后；更长的固定路径先注册（与 §24.6 同一口径）
  app.get('/api/summaries/messages', async (c) => {
    const key = readChannelKey(c.req.query('guildId'), c.req.query('channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    // §25.4：limit 非法或 ≤0 用缺省 50，超过 200 按 200 —— 读端点不跟参数较劲，永远回一份升序列表
    const parsed = readQueryInt(c.req.query('limit'), DEFAULT_SUMMARY_MESSAGE_LIMIT);
    const limit = parsed <= 0 ? DEFAULT_SUMMARY_MESSAGE_LIMIT : Math.min(parsed, MAX_SUMMARY_MESSAGE_LIMIT);
    const rows = await deps.conversations.loadLatest(key, limit);
    return c.json({ items: rows.map(summaryMessageDto) });
  });

  app.get('/api/summaries/range', async (c) => {
    const key = readChannelKey(c.req.query('guildId'), c.req.query('channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    const range = readTimeRange(c.req.query('from'), c.req.query('to'));
    if (range === null) return c.json({ error: 'BAD_TIME_RANGE' }, 400);

    // 预览一次都不花模型调用，但没接线就还是 501：不给前端一个「看起来能用」的假象
    const preview = deps.previewBackfill;
    if (preview === undefined) return c.json({ error: 'SUMMARY_UNAVAILABLE' }, 501);

    return c.json(await preview(key, range));
  });

  app.get('/api/summaries', async (c) => c.json({ items: await deps.summaries.list() }));

  app.put('/api/summaries', async (c) => {
    const body = await readJsonBody(c);
    // body 坏掉与缺 channel key 走同一个出口（与 §23.6 的 describe 同一口径）
    if (body === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);
    const key = readChannelKey(readString(body, 'guildId'), readString(body, 'channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    // §25.4：trim 后 1..8000；空白正文等于「留个空摘要」，注入侧会当成没有记忆，直接拒
    const summary = (readString(body, 'summary') ?? '').trim();
    if (summary.length < 1 || summary.length > MAX_SUMMARY_CHARS) return c.json({ error: 'BAD_SUMMARY' }, 400);

    const coveredUntilId = readCoveredUntilId(body['coveredUntilId']);
    if (coveredUntilId === null) return c.json({ error: 'BAD_COVERED_UNTIL' }, 400);
    // 游标越过最新消息后自动总结会长期不触发，且日志里看不出原因，超上界必须拒
    if (coveredUntilId > (await latestMessageId(deps.conversations, key))) {
      return c.json({ error: 'BAD_COVERED_UNTIL' }, 400);
    }

    // 手改正文不该把「这段记忆覆盖哪段时间」弄丢：时间段没有输入口，沿用库里那一行（§27）
    const previous = await deps.summaries.get(key);
    // §25.4：updatedAt 取服务端时刻，客户端传什么都不认
    const saved: ConversationSummary = {
      guildId: key.guildId,
      channelId: key.channelId,
      summary,
      coveredUntilId,
      coveredFrom: previous?.coveredFrom,
      coveredTo: previous?.coveredTo,
      updatedAt: new Date().toISOString(),
    };
    await deps.summaries.put(saved);
    return c.json(saved);
  });

  app.delete('/api/summaries', async (c) => {
    const key = readChannelKey(c.req.query('guildId'), c.req.query('channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    // 本来没有摘要也回 200：DELETE 的语义是「确保它不在」，前端不必先查一遍
    await deps.summaries.remove(key);
    return c.json({ ok: true });
  });

  app.post('/api/summaries/regenerate', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);
    const key = readChannelKey(readString(body, 'guildId'), readString(body, 'channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    const summarize = deps.summarizeChannel;
    if (summarize === undefined) return c.json({ error: 'SUMMARY_UNAVAILABLE' }, 501);

    let outcome: SummaryOutcome | null;
    try {
      outcome = await summarize(key);
    } catch (error) {
      // §25.4：detail 只回前 300 字，整段堆栈不进前端
      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'SUMMARY_FAILED', detail: detail.slice(0, MAX_SUMMARY_DETAIL_CHARS) }, 502);
    }
    if (outcome === null) return c.json({ error: 'NO_SUMMARY_MATERIAL', outcome: null }, 409);
    return c.json({ outcome });
  });

  // §63 连续总结：一次一批（硬上限 500 条），回本批结果 + 「游标之后还剩多少条」。
  // 接力由前端做（每批一次请求，失败可续），服务端不养后台任务、也不建跨请求进度表。
  app.post('/api/summaries/sweep', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);
    const key = readChannelKey(readString(body, 'guildId'), readString(body, 'channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    const sweep = deps.summarizeSweep;
    if (sweep === undefined) return c.json({ error: 'SUMMARY_UNAVAILABLE' }, 501);

    let result: SummarySweepOutcome;
    try {
      result = await sweep(key);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'SUMMARY_FAILED', detail: detail.slice(0, MAX_SUMMARY_DETAIL_CHARS) }, 502);
    }
    // 「没有素材」也把 remaining 带上：前端拿它判断是「真的做完了」还是「这里本来就没东西」
    if (result.outcome === null) {
      return c.json({ error: 'NO_SUMMARY_MATERIAL', outcome: null, remaining: result.remaining }, 409);
    }
    return c.json({ outcome: result.outcome, remaining: result.remaining });
  });

  app.post('/api/summaries/backfill', async (c) => {
    const body = await readJsonBody(c);
    if (body === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);
    const key = readChannelKey(readString(body, 'guildId'), readString(body, 'channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    const range = readTimeRange(body['from'], body['to']);
    if (range === null) return c.json({ error: 'BAD_TIME_RANGE' }, 400);

    const backfill = deps.backfillSummary;
    if (backfill === undefined) return c.json({ error: 'SUMMARY_UNAVAILABLE' }, 501);

    let outcome: BackfillOutcome | null;
    try {
      outcome = await backfill(key, range);
    } catch (error) {
      // §35：挑得太宽是调用方的事，回上限让它自己收窄，别跟「模型挂了」混成一个 502
      const limit = rangeLimitOf(error);
      if (limit !== null) return c.json({ error: 'RANGE_TOO_LARGE', limit }, 400);
      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'SUMMARY_FAILED', detail: detail.slice(0, MAX_SUMMARY_DETAIL_CHARS) }, 502);
    }
    if (outcome === null) return c.json({ error: 'NO_SUMMARY_MATERIAL', outcome: null }, 409);
    return c.json({ outcome });
  });

  // 手动备份：后台只写请求文件、读状态文件，打包上传由宿主侧的 timer 干（容器里没有 systemd/rclone）。
  // 两条都挂在 ALL /api/* 鉴权之后；未接线的部署（Workers）回 501，不给前端一个「看起来能用」的假象
  app.get('/api/backup', async (c) => {
    const backup = deps.backup;
    if (backup === undefined) return c.json({ error: 'BACKUP_UNAVAILABLE' }, 501);

    // read() 自己把「文件缺失/坏形状」吃成 null，所以这里没有 500 分支
    const snapshot = await backup.read();
    return c.json({ request: snapshot.request, status: snapshot.status });
  });

  app.post('/api/backup/run', async (c) => {
    const backup = deps.backup;
    if (backup === undefined) return c.json({ error: 'BACKUP_UNAVAILABLE' }, 501);

    let request: BackupRequest;
    try {
      request = await backup.request();
    } catch (error) {
      // 上一份请求还没被宿主 timer 处理掉：409 让前端提示「等这一轮跑完」，而不是排第二份
      if (isBackupBusy(error)) return c.json({ error: 'BACKUP_BUSY' }, 409);
      throw error;
    }
    return c.json({ ok: true, request });
  });

  // §26.4：四条记忆配置路由同样挂在 ALL /api/* 鉴权之后；更长的固定路径先注册（与 §24.6/§25.3 同一口径）
  app.get('/api/memory-settings/channel', async (c) => {
    const key = readChannelKey(c.req.query('guildId'), c.req.query('channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    const saved = await deps.channelMemory.get(key);
    // 没有行 = 按服务端默认临时拼一份：updatedAt 留空串，前端据此区分「没配过」与「配过」
    const config: ChannelMemoryConfig = saved ?? {
      guildId: key.guildId,
      channelId: key.channelId,
      historyMaxMessages: deps.memoryDefaults.historyMaxMessages,
      summaryEveryMessages: deps.memoryDefaults.summaryEveryMessages,
      summaryMaxChars: SUMMARY_MAX_CHARS,
      // 没配过 = 老形状：上下文工具模式关（§55）
      contextTool: false,
      updatedAt: '',
    };
    return c.json({ config });
  });

  // 只列已保存的行：没配过的频道不进列表，默认值走 channel 那条端点
  app.get('/api/memory-settings', async (c) => c.json({ items: await deps.channelMemory.list() }));

  app.put('/api/memory-settings', async (c) => {
    const body = await readJsonBody(c);
    // body 坏掉与缺 channel key 走同一个出口（与 §23.6/§25.4 同一口径）
    if (body === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);
    const key = readChannelKey(readString(body, 'guildId'), readString(body, 'channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    // §55：开关类型不对单独一个错误码，免得与数字越界混成 BAD_MEMORY_SETTINGS；缺省 = 关
    const contextTool = readContextTool(body['contextTool']);
    if (contextTool === null) return c.json({ error: 'BAD_CONTEXT_TOOL' }, 400);

    const historyMaxMessages = readMemoryCount(body['historyMaxMessages']);
    const summaryEveryMessages = readMemoryCount(body['summaryEveryMessages']);
    const summaryMaxChars = readSummaryMaxChars(body['summaryMaxChars']);
    if (
      historyMaxMessages === null ||
      summaryEveryMessages === null ||
      summaryMaxChars === null ||
      !isHistoryMaxMessages(historyMaxMessages) ||
      !isSummaryEveryMessages(summaryEveryMessages)
    ) {
      return c.json({ error: 'BAD_MEMORY_SETTINGS' }, 400);
    }

    // §26.4：updatedAt 由仓储按写入时刻补，客户端传什么都不认；回保存后的整行。
    // 预算 0 = 未设置，不建这个键（列里仍落 0），与读侧口径一致
    const saved = await deps.channelMemory.put({
      guildId: key.guildId,
      channelId: key.channelId,
      historyMaxMessages,
      summaryEveryMessages,
      ...(summaryMaxChars > 0 ? { summaryMaxChars } : {}),
      contextTool,
    });
    return c.json(saved);
  });

  app.delete('/api/memory-settings', async (c) => {
    const key = readChannelKey(c.req.query('guildId'), c.req.query('channelId'));
    if (key === null) return c.json({ error: 'BAD_CHANNEL_KEY' }, 400);

    // 本来没有这一行也回 200：DELETE 的语义是「确保回到默认」，前端不必先查一遍
    await deps.channelMemory.remove(key);
    return c.json({ ok: true });
  });

  return app;
}
