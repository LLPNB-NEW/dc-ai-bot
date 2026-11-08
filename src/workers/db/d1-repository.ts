import type { SqlDatabase, SqlStatement } from '../../core/db/sql';
import type {
  BodyEmojiGuideStore,
  ChannelMemoryStore,
  ConversationStore,
  EmojiAliasStore,
  EmojiDescriptionStore,
  KeyRepository,
  PromptDefaultsStore,
  PromptRepository,
  ReactionGuideStore,
  ReactionModelStore,
  ReactionTemplateStore,
  ReplySettingsStore,
  RouteRepository,
  SecretBox,
  SummaryStore,
  TtsSettingsStore,
  TtsStyleStore,
  VisionSettingsStore,
  VoiceSettingsStore,
} from '../../core/ports';
import { isRevealSteps } from '../../core/chat/reply-view';
import { isPromptDefaultKey } from '../../core/prompt/defaults';
import { isInjectionDepth, isInjectionRole, type PromptInjectionStore } from '../../core/prompt/injection';
import type { WorldBook, WorldBookRecord, WorldBookStore, WorldEntry } from '../../core/prompt/worldbook';
import { VOICE_DIRECTOR_OFF, VOICE_SPEED_DEFAULT, isVoiceDirector, isVoiceMode, isVoiceSpeed } from '../../core/voice/settings';
import type {
  BodyEmojiGuideConfig,
  ChannelKey,
  ChannelMemoryConfig,
  ChatMessage,
  ConversationSummary,
  DecryptedKey,
  EmojiAlias,
  EmojiDescription,
  ModelRef,
  PromptConfig,
  PromptDefaultEntry,
  PromptDefaultKey,
  PromptDefaultsScope,
  PromptInjectionConfig,
  PromptPlacement,
  PromptRole,
  PromptSegment,
  ProviderId,
  ProviderKey,
  ReactionGuideConfig,
  ReactionModelConfig,
  ReactionTemplateConfig,
  ReplyRef,
  RevealStepsConfig,
  Role,
  RouteConfig,
  Scope,
  ScopedKey,
  StoredMessage,
  TtsSettingsInput,
  TtsSettingsSecret,
  TtsSettingsView,
  TtsStyleLayer,
  VisionSettingsConfig,
  VoiceSettingsConfig,
} from '../../core/types';

const PROVIDERS: readonly string[] = ['openai-compat', 'anthropic', 'gemini'];

/** prompts 表在 §11 之后只是「这一层有配置」的容器，正文全在 prompt_segments */
interface PromptRow {
  scope: string;
  scope_id: string;
  temperature: number | null;
  max_tokens: number | null;
}

interface PromptSegmentRow {
  id: string;
  scope: string;
  scope_id: string;
  position: number;
  name: string;
  role: string;
  content: string;
  enabled: number;
  placement: string;
}

const PROMPT_SEGMENT_COLUMNS = 'id, scope, scope_id, position, name, role, content, enabled, placement';
const PROMPT_ROW_COLUMNS = 'scope, scope_id, temperature, max_tokens';

/** 酒馆预设导入的原始存档：单行（id 恒为 'latest'），本阶段只写不读 */
interface PromptPresetRow {
  id: string;
  name: string;
  char_name: string;
  source_json: string;
  imported_at: string;
}

const PROMPT_PRESET_COLUMNS = 'id, name, char_name, source_json, imported_at';

// 两份兜底文案按 (key, scope, scope_id) 分行：key 只认 fallback / identity，别的 key 读出来就丢
interface PromptDefaultRow {
  key: string;
  scope: string;
  scope_id: string;
  content: string;
  updated_at: string;
}

const PROMPT_DEFAULT_COLUMNS = 'key, scope, scope_id, content, updated_at';

interface RouteRow {
  scope: string;
  scope_id: string;
  primary_provider: string;
  primary_model: string;
  fallbacks_json: string;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  top_k: number | null;
  seed: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
}

interface KeyRow {
  id: string;
  provider: string;
  label: string;
  base_url: string | null;
  ciphertext: string;
  key_hint: string;
  enabled: number;
  created_at: string;
  models: string | null;
}

interface MessageRow {
  role: string;
  content: string;
  author_name: string | null;
  user_id: string | null;
  created_at: string | null;
  // 四列 NOT NULL DEFAULT ''（migrations/0004），仍按可空读：迁移前的老行不该因一次读取直接崩
  reply_to_id: string | null;
  reply_to_author: string | null;
  reply_to_author_id: string | null;
  reply_to_content: string | null;
  /** 0004 迁移就有这一列，但一直没写过：后台删除功能起才落值（老行是 NULL） */
  discord_id?: string | null;
  /** 只有 getById 会选这一列：后台删单条时要按频道去 Discord 定位 */
  channel_id?: string | null;
}

interface StoredMessageRow extends MessageRow {
  id: number;
}

interface SummaryRow {
  guild_id: string;
  channel_id: string;
  summary: string;
  covered_until_id: number;
  covered_from: string | null;
  covered_to: string | null;
  updated_at: string;
}

// 读侧只回配置本身；get 按主键精确命中，身份由调用方给的 key 补（§26.2）
interface ChannelMemoryRow {
  history_max_messages: number;
  summary_every_messages: number;
  summary_max_chars: number;
  context_tool: number;
  updated_at: string;
}

// list 没有入参可比对，每行自带身份才能窄化成 ChannelMemoryConfig
interface ChannelMemoryListRow extends ChannelMemoryRow {
  guild_id: string;
  channel_id: string;
}

interface ReactionModelRow {
  enabled: number;
  provider: string;
  model: string;
}

/** 单行表：id 恒为 1，key_sealed / judge_key_sealed 是密文、*_hint 是掩码 */
interface TtsSettingsRow {
  url: string;
  key_sealed: string;
  key_hint: string;
  model: string;
  voice: string;
  /** 0023 才加的列；只当字符串读，取用时再收窄成两个合法值 */
  dialect: string;
  /** 0024 才加的三列：判断情绪用的上游，与 TTS key 同一套「密文 + 掩码」规则 */
  judge_url: string;
  judge_key_sealed: string;
  judge_key_hint: string;
  judge_model: string;
  updated_at: string;
}

/** 语气提示词：主键 (scope, scope_id)，global 的 scope_id 恒为 '' */
interface TtsStyleRow {
  scope: string;
  scope_id: string;
  content: string;
  updated_at: string;
}

interface ReactionGuideRow {
  scope: string;
  scope_id: string;
  prompt: string;
  updated_at: string;
}

interface BodyEmojiGuideRow {
  scope: string;
  scope_id: string;
  prompt: string;
  updated_at: string;
}

interface ReactionTemplateRow {
  scope: string;
  scope_id: string;
  template: string;
  updated_at: string;
}

interface ReplySettingsRow {
  scope: string;
  scope_id: string;
  reveal_steps: number;
  updated_at: string;
}

/**
 * 行 -> 配置（§28.10）：scope 列在库里是自由文本，窄化时只认三个枚举值，别的一律当作没有这一层。
 * 越界值只可能来自手改库，丢掉比抛错安全——提示词读失败不该拖住整轮回复。
 */
function toReactionGuideConfig(row: ReactionGuideRow): ReactionGuideConfig | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  return { scope: row.scope, scopeId: row.scope_id, prompt: row.prompt, updatedAt: row.updated_at };
}

/**
 * 行 -> 正文表情提示词：scope 列在库里是自由文本，窄化时只认三个枚举值，别的一律当作没有这一层。
 * 越界值只可能来自手改库，丢掉比抛错安全——提示词读失败不该拖住整轮回复。
 */
function toBodyEmojiGuideConfig(row: BodyEmojiGuideRow): BodyEmojiGuideConfig | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  return { scope: row.scope, scopeId: row.scope_id, prompt: row.prompt, updatedAt: row.updated_at };
}

/**
 * 行 -> 素材模板（§34.2）：scope 列在库里是自由文本，窄化时只认三个枚举值，别的一律当作没有这一层。
 * 越界值只可能来自手改库，丢掉比抛错安全——模板读失败不该拖住整轮回复。
 */
function toReactionTemplateConfig(row: ReactionTemplateRow): ReactionTemplateConfig | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  return { scope: row.scope, scopeId: row.scope_id, template: row.template, updatedAt: row.updated_at };
}

/**
 * 行 -> 切片次数（§38）：scope 列在库里是自由文本，窄化时只认三个枚举值，别的一律当作没有这一层。
 * reveal_steps 越界同理——越界值只可能来自手改库，丢掉比抛错安全，开关读失败不该拖住整轮回复。
 */
function toRevealStepsConfig(row: ReplySettingsRow): RevealStepsConfig | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  if (!isRevealSteps(row.reveal_steps)) return null;
  return { scope: row.scope, scopeId: row.scope_id, revealSteps: row.reveal_steps, updatedAt: row.updated_at };
}

interface VisionSettingsRow {
  scope: string;
  scope_id: string;
  enabled: number;
  updated_at: string;
}

/**
 * 行 -> 识图开关（§41）：scope 列在库里是自由文本，窄化时只认三个枚举值，别的一律当作没有这一层。
 * enabled 只认 0 / 1（库里是 INTEGER）；越界值只可能来自手改库，丢掉比抛错安全，开关读失败不该拖住整轮回复。
 */
function toVisionSettingsConfig(row: VisionSettingsRow): VisionSettingsConfig | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  if (row.enabled !== 0 && row.enabled !== 1) return null;
  return { scope: row.scope, scopeId: row.scope_id, enabled: row.enabled === 1, updatedAt: row.updated_at };
}

interface VoiceSettingsRow {
  scope: string;
  scope_id: string;
  mode: number;
  voice: string;
  speed: number;
  director: number;
  updated_at: string;
}

/**
 * 行 -> 语音配置：scope 只认三个枚举；mode 不是 0/1/2 的整数就当没有这一行，读侧自然落回上一层。
 * speed 越界不丢整行（回落默认语速）、voice 原样带回（空串 = 没指定音色）：只改开关不该把另外两项一起清掉。
 * director 同理只回落单项：导演模式读坏了最多退化成逐字朗读，不该让整层配置失效。
 */
function toVoiceSettingsConfig(row: VoiceSettingsRow): VoiceSettingsConfig | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  if (!isVoiceMode(row.mode)) return null;
  return {
    scope: row.scope,
    scopeId: row.scope_id,
    mode: row.mode,
    voice: row.voice,
    speed: isVoiceSpeed(row.speed) ? row.speed : VOICE_SPEED_DEFAULT,
    // 只认 isVoiceDirector：脏值 / 缺列（NULL）都落回 0，返回值必须是数字，不能是 undefined
    director: isVoiceDirector(row.director) ? row.director : VOICE_DIRECTOR_OFF,
    updatedAt: row.updated_at,
  };
}

interface PromptInjectionRow {
  scope: string;
  scope_id: string;
  content: string;
  depth: number;
  role: string;
  updated_at: string;
}

/**
 * 行 -> 注入配置：role 读坏了退化成 system、depth 读坏了退化成 0，都不丢整行——
 * 后台改一个字段不该让另外两个字段一起消失；scope 不认识就当没有这一行（主键只能是三值之一）。
 */
function toPromptInjectionConfig(row: PromptInjectionRow): PromptInjectionConfig | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  return {
    scope: row.scope,
    scopeId: row.scope_id,
    content: typeof row.content === 'string' ? row.content : '',
    depth: isInjectionDepth(row.depth) ? row.depth : 0,
    role: isInjectionRole(row.role) ? row.role : 'system',
    updatedAt: row.updated_at,
  };
}

interface WorldBookRow {
  scope: string;
  scope_id: string;
  name: string;
  book_json: string;
  entry_count: number;
  imported_at: string;
}

/**
 * 行 -> 世界书：scope 不认识、book_json 解析不了、或形状不是本进程认的那一版，
 * 都当这一行不存在——一本坏书只能让这一层落回上一层，不能让整轮回复 500。
 */
function toWorldBookRecord(row: WorldBookRow): WorldBookRecord | null {
  if (row.scope !== 'global' && row.scope !== 'guild' && row.scope !== 'channel') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.book_json);
  } catch {
    return null;
  }
  if (!isWorldBook(parsed)) return null;
  return {
    scope: row.scope,
    scopeId: row.scope_id,
    name: typeof row.name === 'string' ? row.name : parsed.name,
    book: parsed,
    // 列只是导入时的缓存：书里条数才是这份 JSON 的真相，两者不一致时信 JSON
    entryCount: parsed.entries.length,
    importedAt: row.imported_at,
  };
}

/** 外部数据（手工补库、旧版本写下的行）的形状闸门：只查读侧真正会用到的那几个字段 */
function isWorldBook(value: unknown): value is WorldBook {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const book = value as Record<string, unknown>;
  if (typeof book['name'] !== 'string') return false;
  if (!Array.isArray(book['warnings']) || !Array.isArray(book['ignored'])) return false;
  const entries = book['entries'];
  if (!Array.isArray(entries)) return false;
  return entries.every((entry) => isWorldEntry(entry));
}

function isWorldEntry(value: unknown): value is WorldEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'number' &&
    typeof entry['content'] === 'string' &&
    Array.isArray(entry['keys']) &&
    Array.isArray(entry['secondaryKeys']) &&
    typeof entry['order'] === 'number'
  );
}

interface EmojiDescriptionRow {
  emoji_id: string;
  name: string;
  description: string;
  updated_at: string;
}

interface EmojiAliasRow {
  alias: string;
  emoji_id: string;
  emoji_name: string;
}

// role / placement 虽然带 CHECK 约束，读侧仍归一一次：手工改库留下的脏值不能让整轮回复炸掉
function toPromptSegment(row: PromptSegmentRow): PromptSegment {
  return {
    id: row.id,
    name: row.name,
    role: (row.role === 'user' ? 'user' : 'system') as PromptRole,
    content: row.content,
    enabled: row.enabled !== 0,
    placement: (row.placement === 'after' ? 'after' : 'before') as PromptPlacement,
    position: row.position,
  };
}

function promptScopeKey(scope: string, scopeId: string): string {
  return scope + '\u0000' + scopeId;
}

/** 全表的段按层归堆；SQL 已按 position 升序，同 position（不该出现）再按 id 保证顺序稳定 */
function groupPromptSegments(rows: readonly PromptSegmentRow[]): Map<string, PromptSegment[]> {
  const grouped = new Map<string, PromptSegment[]>();
  for (const row of rows) {
    const key = promptScopeKey(row.scope, row.scope_id);
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [toPromptSegment(row)]);
    else bucket.push(toPromptSegment(row));
  }
  return grouped;
}

function toPromptConfig(row: PromptRow, segments: PromptSegment[]): PromptConfig {
  const cfg: PromptConfig = { segments };
  if (row.temperature !== null) cfg.temperature = row.temperature;
  if (row.max_tokens !== null) cfg.maxTokens = row.max_tokens;
  return cfg;
}

function toScopedPrompt(row: PromptRow, segments: PromptSegment[]): PromptConfig & ScopedKey {
  return { ...toPromptConfig(row, segments), scope: row.scope as Scope, scopeId: row.scope_id };
}

function toPromptDefaultEntry(row: PromptDefaultRow, key: PromptDefaultKey): PromptDefaultEntry {
  return { key, scope: row.scope as Scope, scopeId: row.scope_id, content: row.content, updatedAt: row.updated_at };
}

function toTtsStyleLayer(row: TtsStyleRow): TtsStyleLayer {
  return { scope: row.scope as Scope, scopeId: row.scope_id, content: row.content, updatedAt: row.updated_at };
}

function toModelRef(provider: string, model: string): ModelRef {
  return { provider: provider as ProviderId, model };
}

// 手工改库或旧版本数据可能留下坏 JSON；读侧只降级为“无 fallback”，不让一次对话整体失败
function parseFallbacks(json: string): ModelRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const refs: ModelRef[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const provider = rec.provider;
    const model = rec.model;
    if (typeof provider !== 'string' || typeof model !== 'string') continue;
    if (!PROVIDERS.includes(provider)) continue;
    refs.push(toModelRef(provider, model));
  }
  return refs;
}

function toRouteConfig(row: RouteRow): RouteConfig {
  const cfg: RouteConfig = {
    primary: toModelRef(row.primary_provider, row.primary_model),
    fallbacks: parseFallbacks(row.fallbacks_json),
  };
  if (row.temperature !== null) cfg.temperature = row.temperature;
  if (row.max_tokens !== null) cfg.maxTokens = row.max_tokens;
  if (row.top_p !== null) cfg.topP = row.top_p;
  if (row.top_k !== null) cfg.topK = row.top_k;
  if (row.seed !== null) cfg.seed = row.seed;
  if (row.frequency_penalty !== null) cfg.frequencyPenalty = row.frequency_penalty;
  if (row.presence_penalty !== null) cfg.presencePenalty = row.presence_penalty;
  return cfg;
}

function toScopedRoute(row: RouteRow): RouteConfig & ScopedKey {
  return { ...toRouteConfig(row), scope: row.scope as Scope, scopeId: row.scope_id };
}

/** 逗号分隔的原始名单 → 数组：trim、丢空串、保留大小写；空列读成 []（§20.3） */
function parseModels(raw: string | null): string[] {
  if (raw === null) return [];
  const models: string[] = [];
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (trimmed !== '') models.push(trimmed);
  }
  return models;
}

function toProviderKey(row: KeyRow): ProviderKey {
  const key: ProviderKey = {
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    keyHint: row.key_hint,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    models: parseModels(row.models),
  };
  if (row.base_url !== null) key.baseUrl = row.base_url;
  return key;
}

function nowIso(): string {
  return new Date().toISOString();
}

// 四列全为空白就是「不知道回复了谁」（老行、普通消息都如此）：返回 null，上层只有「有键 / 没键」一条规则
function toReplyRef(row: MessageRow): ReplyRef | null {
  const messageId = (row.reply_to_id ?? '').trim();
  const author = (row.reply_to_author ?? '').trim();
  const authorId = (row.reply_to_author_id ?? '').trim();
  const content = row.reply_to_content ?? '';
  if (messageId === '' && author === '' && authorId === '' && content.trim() === '') return null;
  // content 不 trim：库里存全文，压缩空白与 40 字截断都在 core 的提示词侧做
  return { messageId, author, authorId, content };
}

// 迁移前的老行 author_name 为 NULL：不写 author 键，上层才只能按「无名字」处理
function toChatMessage(row: MessageRow): ChatMessage {
  const message: ChatMessage = { role: row.role as Role, content: row.content };
  if (row.author_name !== null) {
    const author = row.author_name.trim();
    if (author !== '') message.author = author;
  }
  const authorId = (row.user_id ?? '').trim();
  if (authorId !== '') message.authorId = authorId;
  const createdAt = (row.created_at ?? '').trim();
  if (createdAt !== '') message.createdAt = createdAt;
  const replyTo = toReplyRef(row);
  if (replyTo !== null) message.replyTo = replyTo;
  const discordId = (row.discord_id ?? '').trim();
  if (discordId !== '') message.discordId = discordId;
  return message;
}

// 摘要游标要按 id 比较，历史行必须带 id 才能交给上层算「新增」
function toStoredMessage(row: StoredMessageRow): StoredMessage {
  const message: StoredMessage = { ...toChatMessage(row), id: row.id };
  // §62：只有单行读的 SELECT 带 channel_id；没带就是不建键，调用方按「不知道频道」处理
  const channelId = (row.channel_id ?? '').trim();
  if (channelId !== '') message.channelId = channelId;
  return message;
}

function toConversationSummary(row: SummaryRow): ConversationSummary {
  const entry: ConversationSummary = {
    guildId: row.guild_id,
    channelId: row.channel_id,
    summary: row.summary,
    coveredUntilId: row.covered_until_id,
    updatedAt: row.updated_at,
  };
  // 老行（0011 之前）两列是空串：不建键，上层一律按「不知道时间段」处理
  const from = (row.covered_from ?? '').trim();
  const to = (row.covered_to ?? '').trim();
  if (from !== '') entry.coveredFrom = from;
  if (to !== '') entry.coveredTo = to;
  return entry;
}

// 一行 = 一个频道的三个数字 + 上下文工具开关；updated_at 只给后台看，真正进提示词的只有前两个与预算（§26.2）
function toChannelMemoryConfig(row: ChannelMemoryRow, key: ChannelKey): ChannelMemoryConfig {
  // 0 = 这行没配过摘要预算：不建键，上层按「用默认 4000」处理（§26.4）
  return {
    guildId: key.guildId,
    channelId: key.channelId,
    historyMaxMessages: row.history_max_messages,
    summaryEveryMessages: row.summary_every_messages,
    ...(row.summary_max_chars > 0 ? { summaryMaxChars: row.summary_max_chars } : {}),
    // 列是 INTEGER 0/1（NOT NULL DEFAULT 0）：非 0 一律当开，老行天然是 false（§55）
    contextTool: row.context_tool !== 0,
    updatedAt: row.updated_at,
  };
}

// provider 不在枚举内或 model 全空白就是「没有表情模型」（老行、只开了开关没填模型都落这里）：
// 一律返回 null，上层只有「有 / 没有」一条规则，不必再判一次枚举（§21.2）
function toReactionModelConfig(row: ReactionModelRow): ReactionModelConfig | null {
  if (!PROVIDERS.includes(row.provider)) return null;
  const model = row.model.trim();
  if (model === '') return null;
  return { enabled: row.enabled !== 0, provider: row.provider as ProviderId, model };
}

function toEmojiDescription(row: EmojiDescriptionRow): EmojiDescription {
  return { emojiId: row.emoji_id, name: row.name, description: row.description, updatedAt: row.updated_at };
}

function toEmojiAlias(row: EmojiAliasRow): EmojiAlias {
  return { alias: row.alias, emojiId: row.emoji_id, emojiName: row.emoji_name };
}

// 用户 ID 一律写字符串（列 NOT NULL 无默认值的老写法是 ''），读侧「非空才算有 ID」
function authorIdColumn(message: ChatMessage): string {
  return (message.authorId ?? '').trim();
}

// 空白名字一律写 NULL，读侧「非空才算有名字」一条规则就够
function authorColumn(message: ChatMessage): string | null {
  const author = (message.author ?? '').trim();
  return author === '' ? null : author;
}

// 密钥掩码：provider_keys 与 tts_settings 共用一条规则，后台看到的永远是同一形状
export function maskKeyHint(secret: string): string {
  return '…' + secret.slice(-4);
}

// 上层给了时刻就用它（提示词里的时间戳与库里存的是同一个值），没给才取当前时刻
function createdAtColumn(message: ChatMessage, fallback: string): string {
  const createdAt = (message.createdAt ?? '').trim();
  return createdAt === '' ? fallback : createdAt;
}

/**
 * 最近一次酒馆预设导入的原始 JSON（migrations/0026_prompt_presets.sql）。
 * 本阶段只写不读：后续阶段要用它读世界书与正则，所以这里存的是整份 preset 原文。
 */
export interface PromptPresetRecord {
  id: string;
  name: string;
  charName: string;
  sourceJson: string;
  importedAt: string;
}

/** 单行存储：savePreset 覆盖写，latestPreset 取回那一行；没有行 = 从没导入过 */
export interface PresetImportStore {
  savePreset(record: Omit<PromptPresetRecord, 'importedAt'>): Promise<PromptPresetRecord>;
  latestPreset(): Promise<PromptPresetRecord | null>;
}

function toPromptPresetRecord(row: PromptPresetRow): PromptPresetRecord {
  return {
    id: row.id,
    name: row.name,
    charName: row.char_name,
    sourceJson: row.source_json,
    importedAt: row.imported_at,
  };
}

export function createRepositories(
  db: SqlDatabase,
  secretBox: SecretBox,
): {
  prompts: PromptRepository;
  presetImports: PresetImportStore;
  routes: RouteRepository;
  keys: KeyRepository;
  conversations: ConversationStore;
  summaries: SummaryStore;
  channelMemory: ChannelMemoryStore;
  reactionModels: ReactionModelStore;
  ttsSettings: TtsSettingsStore;
  ttsStyles: TtsStyleStore;
  reactionGuides: ReactionGuideStore;
  reactionTemplates: ReactionTemplateStore;
  promptDefaults: PromptDefaultsStore;
  replySettings: ReplySettingsStore;
  bodyEmojiGuides: BodyEmojiGuideStore;
  visionSettings: VisionSettingsStore;
  voiceSettings: VoiceSettingsStore;
  emojiDescriptions: EmojiDescriptionStore;
  emojiAliases: EmojiAliasStore;
  promptInjections: PromptInjectionStore;
  worldBooks: WorldBookStore;
} {
  const prompts: PromptRepository = {
    // 行和段两边都空才是「这一层没有提示词」；只剩行（段被清空）仍算有配置，与 PUT 的容器语义一致
    async get(key: ScopedKey): Promise<PromptConfig | null> {
      const [row, segmentRows] = await Promise.all([
        db
          .prepare('SELECT ' + PROMPT_ROW_COLUMNS + ' FROM prompts WHERE scope = ? AND scope_id = ?')
          .bind(key.scope, key.scopeId)
          .first<PromptRow>(),
        db
          .prepare(
            'SELECT ' + PROMPT_SEGMENT_COLUMNS + ' FROM prompt_segments WHERE scope = ? AND scope_id = ? ORDER BY position ASC, id ASC',
          )
          .bind(key.scope, key.scopeId)
          .all<PromptSegmentRow>(),
      ]);
      const segments = (segmentRows.results ?? []).map(toPromptSegment);
      if (row === null) return segments.length === 0 ? null : { segments };
      return toPromptConfig(row, segments);
    },

    async list(): Promise<Array<PromptConfig & ScopedKey>> {
      const [heads, segmentRows] = await Promise.all([
        db.prepare('SELECT ' + PROMPT_ROW_COLUMNS + ' FROM prompts ORDER BY scope, scope_id').all<PromptRow>(),
        db
          .prepare(
            'SELECT ' + PROMPT_SEGMENT_COLUMNS + ' FROM prompt_segments ORDER BY scope, scope_id, position ASC, id ASC',
          )
          .all<PromptSegmentRow>(),
      ]);
      const grouped = groupPromptSegments(segmentRows.results ?? []);
      return (heads.results ?? []).map((row) =>
        toScopedPrompt(row, grouped.get(promptScopeKey(row.scope, row.scope_id)) ?? []),
      );
    },

    // 行 + 段必须写在同一个 batch 里：段表先删后插，半批失败会留下「行在、段没了」的层
    async put(key: ScopedKey, cfg: PromptConfig): Promise<void> {
      const updatedAt = nowIso();
      const statements: SqlStatement[] = [
        db
          .prepare(
            `INSERT INTO prompts (scope, scope_id, temperature, max_tokens, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (scope, scope_id) DO UPDATE SET
               temperature = excluded.temperature,
               max_tokens = excluded.max_tokens,
               updated_at = excluded.updated_at`,
          )
          .bind(key.scope, key.scopeId, cfg.temperature ?? null, cfg.maxTokens ?? null, updatedAt),
        db.prepare('DELETE FROM prompt_segments WHERE scope = ? AND scope_id = ?').bind(key.scope, key.scopeId),
      ];
      // position 以数组顺序为准：调用方排好的顺序就是最终顺序，不再单独传 position
      cfg.segments.forEach((segment, index) => {
        statements.push(
          db
            .prepare(
              'INSERT INTO prompt_segments (id, scope, scope_id, position, name, role, content, enabled, placement, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              segment.id,
              key.scope,
              key.scopeId,
              index,
              segment.name,
              segment.role,
              segment.content,
              segment.enabled ? 1 : 0,
              segment.placement,
              updatedAt,
            ),
        );
      });
      await db.batch(statements);
    },

    async remove(key: ScopedKey): Promise<void> {
      await db.batch([
        db.prepare('DELETE FROM prompts WHERE scope = ? AND scope_id = ?').bind(key.scope, key.scopeId),
        db.prepare('DELETE FROM prompt_segments WHERE scope = ? AND scope_id = ?').bind(key.scope, key.scopeId),
      ]);
    },
  };

  // 导入成功才落这一行：解析失败/没段的请求不覆盖上一次的存档
  const presetImports: PresetImportStore = {
    async savePreset(record: Omit<PromptPresetRecord, 'importedAt'>): Promise<PromptPresetRecord> {
      const importedAt = nowIso();
      // 单行语义：同一个 id 覆盖写，库里永远只留最近一次导入
      await db
        .prepare(
          `INSERT INTO prompt_presets (id, name, char_name, source_json, imported_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             char_name = excluded.char_name,
             source_json = excluded.source_json,
             imported_at = excluded.imported_at`,
        )
        .bind(record.id, record.name, record.charName, record.sourceJson, importedAt)
        .run();
      // 回写手里的这一行，不再查一次库
      return { ...record, importedAt };
    },

    async latestPreset(): Promise<PromptPresetRecord | null> {
      const row = await db
        .prepare('SELECT ' + PROMPT_PRESET_COLUMNS + ' FROM prompt_presets ORDER BY imported_at DESC, id ASC')
        .first<PromptPresetRow>();
      return row === null ? null : toPromptPresetRecord(row);
    },
  };

  const routes: RouteRepository = {
    async get(key: ScopedKey): Promise<RouteConfig | null> {
      const row = await db
        .prepare('SELECT scope, scope_id, primary_provider, primary_model, fallbacks_json, temperature, max_tokens, top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<RouteRow>();
      return row === null ? null : toRouteConfig(row);
    },

    async list(): Promise<Array<RouteConfig & ScopedKey>> {
      const { results } = await db
        .prepare('SELECT scope, scope_id, primary_provider, primary_model, fallbacks_json, temperature, max_tokens, top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes ORDER BY scope, scope_id')
        .all<RouteRow>();
      return (results ?? []).map(toScopedRoute);
    },

    async put(key: ScopedKey, cfg: RouteConfig): Promise<void> {
      await db
        .prepare(
          `INSERT INTO routes (scope, scope_id, primary_provider, primary_model, fallbacks_json, temperature, max_tokens, top_p, top_k, seed, frequency_penalty, presence_penalty, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             primary_provider = excluded.primary_provider,
             primary_model = excluded.primary_model,
             fallbacks_json = excluded.fallbacks_json,
             temperature = excluded.temperature,
             max_tokens = excluded.max_tokens,
             top_p = excluded.top_p,
             top_k = excluded.top_k,
             seed = excluded.seed,
             frequency_penalty = excluded.frequency_penalty,
             presence_penalty = excluded.presence_penalty,
             updated_at = excluded.updated_at`,
        )
        .bind(
          key.scope,
          key.scopeId,
          cfg.primary.provider,
          cfg.primary.model,
          JSON.stringify(cfg.fallbacks ?? []),
          cfg.temperature ?? null,
          cfg.maxTokens ?? null,
          cfg.topP ?? null,
          cfg.topK ?? null,
          cfg.seed ?? null,
          cfg.frequencyPenalty ?? null,
          cfg.presencePenalty ?? null,
          nowIso(),
        )
        .run();
    },

    async remove(key: ScopedKey): Promise<void> {
      await db.prepare('DELETE FROM routes WHERE scope = ? AND scope_id = ?').bind(key.scope, key.scopeId).run();
    },
  };

  const keys: KeyRepository = {
    async list(): Promise<ProviderKey[]> {
      const { results } = await db
        .prepare('SELECT id, provider, label, base_url, ciphertext, key_hint, enabled, created_at, models FROM provider_keys ORDER BY created_at, id')
        .all<KeyRow>();
      return (results ?? []).map(toProviderKey);
    },

    async listEnabled(provider: ProviderId): Promise<DecryptedKey[]> {
      // 取全不 LIMIT：模型名单的偏好排序在 core（orderKeysForModel），仓储只钉住 created_at,id（§20.2/§20.4）
      const { results } = await db
        .prepare('SELECT id, provider, label, base_url, ciphertext, key_hint, enabled, created_at, models FROM provider_keys WHERE provider = ? AND enabled = 1 ORDER BY created_at, id')
        .bind(provider)
        .all<KeyRow>();
      return Promise.all((results ?? []).map(decryptedKey));
    },

    async getDecrypted(id: string): Promise<DecryptedKey | null> {
      const row = await db
        .prepare('SELECT id, provider, label, base_url, ciphertext, key_hint, enabled, created_at, models FROM provider_keys WHERE id = ?')
        .bind(id)
        .first<KeyRow>();
      return row === null ? null : decryptedKey(row);
    },

    async create(input: {
      provider: ProviderId;
      label: string;
      baseUrl?: string;
      apiKey: string;
      models?: string[];
    }): Promise<ProviderKey> {
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      const keyHint = maskKeyHint(input.apiKey);
      const ciphertext = await secretBox.encrypt(input.apiKey);
      const modelsRaw = (input.models ?? []).join(',');
      await db
        .prepare(
          `INSERT INTO provider_keys (id, provider, label, base_url, ciphertext, key_hint, enabled, created_at, models)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(id, input.provider, input.label, input.baseUrl ?? null, ciphertext, keyHint, createdAt, modelsRaw)
        .run();
      const created: ProviderKey = {
        id,
        provider: input.provider,
        label: input.label,
        keyHint,
        enabled: true,
        createdAt,
        models: parseModels(modelsRaw),
      };
      if (input.baseUrl !== undefined) created.baseUrl = input.baseUrl;
      return created;
    },

    async remove(id: string): Promise<void> {
      await db.prepare('DELETE FROM provider_keys WHERE id = ?').bind(id).run();
    },
  };

  async function decryptedKey(row: KeyRow): Promise<DecryptedKey> {
    const key: DecryptedKey = {
      id: row.id,
      provider: row.provider as ProviderId,
      label: row.label,
      apiKey: await secretBox.decrypt(row.ciphertext),
      models: parseModels(row.models),
    };
    if (row.base_url !== null) key.baseUrl = row.base_url;
    return key;
  }

  const conversations: ConversationStore = {
    async loadRecent(key: { guildId: string; channelId: string }, limit: number): Promise<ChatMessage[]> {
      // 倒序 LIMIT 才是「最近 N 条」，再反转成时间正序：时间序由 created_at 决定，id 只用来破平
      const { results } = await db
        .prepare(
          'SELECT role, content, author_name, user_id, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content, discord_id FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .bind(key.guildId, key.channelId, limit)
        .all<MessageRow>();
      return (results ?? []).map(toChatMessage).reverse();
    },

    async loadAll(key: { guildId: string; channelId: string }): Promise<ChatMessage[]> {
      // 全部历史交给上层字符安全阀裁剪：这里不带 LIMIT，按 created_at 正序；id 只是写入顺序（回灌的历史行会更大更早），只用来破平
      const { results } = await db
        .prepare(
          'SELECT role, content, author_name, user_id, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content, discord_id FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY created_at ASC, id ASC',
        )
        .bind(key.guildId, key.channelId)
        .all<MessageRow>();
      return (results ?? []).map(toChatMessage);
    },

    async loadAfter(key: ChannelKey, afterId: number, limit?: number): Promise<StoredMessage[]> {
      // SQLite 不支持「LIMIT 可选」的占位符：不传 limit 就换一条不带 LIMIT 的语句，别用 -1 之类的魔法值
      // 过滤条件 id > ? 是游标（写入顺序）必须保留；排序才是时间序：created_at 优先，id 只用来破平
      const columns =
        'SELECT id, role, content, author_name, user_id, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content, discord_id FROM messages WHERE guild_id = ? AND channel_id = ? AND id > ? ORDER BY created_at ASC, id ASC';
      const { results } =
        limit === undefined
          ? await db.prepare(columns).bind(key.guildId, key.channelId, afterId).all<StoredMessageRow>()
          : await db.prepare(columns + ' LIMIT ?').bind(key.guildId, key.channelId, afterId, limit).all<StoredMessageRow>();
      return (results ?? []).map(toStoredMessage);
    },

    async loadLatest(key: ChannelKey, limit: number): Promise<StoredMessage[]> {
      // 后台「楼层点选」只关心最新几层：倒序 LIMIT 再翻正序，调用方拿到的永远是时间正序（§25.2）；同秒的行靠 id 破平
      const { results } = await db
        .prepare(
          'SELECT id, role, content, author_name, user_id, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content, discord_id FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .bind(key.guildId, key.channelId, limit)
        .all<StoredMessageRow>();
      return (results ?? []).map(toStoredMessage).reverse();
    },

    async loadBetween(key: ChannelKey, fromIso: string, toIso: string, limit: number): Promise<StoredMessage[]> {
      // created_at 是 ISO 文本（定长、UTC），字典序即时间序：范围比较直接交给 SQL，含两个端点；排序也只认它，id 用来破平
      const { results } = await db
        .prepare(
          'SELECT id, role, content, author_name, user_id, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content, discord_id FROM messages WHERE guild_id = ? AND channel_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC, id ASC LIMIT ?',
        )
        .bind(key.guildId, key.channelId, fromIso, toIso, limit)
        .all<StoredMessageRow>();
      return (results ?? []).map(toStoredMessage);
    },

    async guildOfChannel(channelId: string): Promise<string | null> {
      // 频道 id 全局唯一，取该频道最近一行就够；消息表之外没有别的 channel→guild 映射可查
      const row = await db
        .prepare('SELECT guild_id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1')
        .bind(channelId)
        .first<{ guild_id: string }>();
      return row?.guild_id ?? null;
    },

    async append(key: { guildId: string; channelId: string }, messages: ChatMessage[]): Promise<void> {
      if (messages.length === 0) return;
      const fallbackCreatedAt = nowIso();
      // discord_id 上有唯一索引（迁移 0016）：不知道时只能写 NULL，写空串会让第二行就撞唯一约束（§62）
      const discordColumn = (message: ChatMessage): string | null => {
        const value = message.discordId?.trim() ?? '';
        return value === '' ? null : value;
      };
      // 四列 NOT NULL：没有 replyTo 时就写空串（=「不知道」），读侧据此不产生 replyTo 键
      const statement = db.prepare(
        'INSERT INTO messages (guild_id, channel_id, user_id, role, content, author_name, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content, discord_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      await db.batch(
        messages.map((message) =>
          statement.bind(
            key.guildId,
            key.channelId,
            authorIdColumn(message),
            message.role,
            message.content,
            authorColumn(message),
            createdAtColumn(message, fallbackCreatedAt),
            message.replyTo?.messageId ?? '',
            message.replyTo?.author ?? '',
            message.replyTo?.authorId ?? '',
            message.replyTo?.content ?? '',
            discordColumn(message),
          ),
        ),
      );
    },

    async clear(key: { guildId: string; channelId: string }): Promise<void> {
      await db.prepare('DELETE FROM messages WHERE guild_id = ? AND channel_id = ?').bind(key.guildId, key.channelId).run();
    },

    // §62：后台「历史」页的单条删除走这三条 —— 先按 id 取（拿正文/作者/落库时刻去对 Discord 那条），再删行。
    // 三列的 SELECT 与 loadLatest 同形状，discord_id 缺列时按「没记」处理，老行不会因为一次读取崩掉。
    async getById(id: number): Promise<StoredMessage | null> {
      const row = await db
        .prepare(
          'SELECT id, role, content, author_name, user_id, created_at, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content, discord_id, channel_id FROM messages WHERE id = ?',
        )
        .bind(id)
        .first<StoredMessageRow>();
      return row === null ? null : toStoredMessage(row);
    },

    async removeById(id: number): Promise<boolean> {
      // run() 的返回在两套实现里形状不同：D1 是 { meta: { changes } }，node:sqlite 是 { changes }。
      // 只读 meta 会让线上（node 宿主）每次都回 false —— 行删掉了却报没删。
      const result = (await db.prepare('DELETE FROM messages WHERE id = ?').bind(id).run()) as {
        meta?: { changes?: number };
        changes?: number;
      };
      return (result.meta?.changes ?? result.changes ?? 0) > 0;
    },

    async attachDiscordId(key: ChannelKey, content: string, discordId: string): Promise<void> {
      const trimmed = discordId.trim();
      if (trimmed === '' || content === '') return;
      // 正文精确相等才认：同一频道里 bot 自己刚写下的那段是唯一的，匹配不到就静默不动（不影响回复）
      await db
        .prepare(
          'UPDATE messages SET discord_id = ? WHERE id = (SELECT id FROM messages WHERE guild_id = ? AND channel_id = ? AND role = ? AND content = ? ORDER BY id DESC LIMIT 1)',
        )
        .bind(trimmed, key.guildId, key.channelId, 'assistant', content)
        .run();
    },
  };

  const summaries: SummaryStore = {
    async get(key: ChannelKey): Promise<ConversationSummary | null> {
      const row = await db
        .prepare(
          'SELECT guild_id, channel_id, summary, covered_until_id, covered_from, covered_to, updated_at FROM conversation_summaries WHERE guild_id = ? AND channel_id = ?',
        )
        .bind(key.guildId, key.channelId)
        .first<SummaryRow>();
      return row === null ? null : toConversationSummary(row);
    },

    async list(): Promise<ConversationSummary[]> {
      // 后台摘要页一次列全表，排序交给 SQL：调用方拿到的就是 (guild, channel) 升序（§25.2）
      const { results } = await db
        .prepare(
          'SELECT guild_id, channel_id, summary, covered_until_id, covered_from, covered_to, updated_at FROM conversation_summaries ORDER BY guild_id ASC, channel_id ASC',
        )
        .all<SummaryRow>();
      return (results ?? []).map(toConversationSummary);
    },

    async put(entry: ConversationSummary): Promise<void> {
      // 一个频道只有一条摘要：覆盖写才对得上「把上一版和新增对话合并」的语义
      await db
        .prepare(
          `INSERT INTO conversation_summaries (guild_id, channel_id, summary, covered_until_id, covered_from, covered_to, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, channel_id) DO UPDATE SET
             summary = excluded.summary,
             covered_until_id = excluded.covered_until_id,
             covered_from = excluded.covered_from,
             covered_to = excluded.covered_to,
             updated_at = excluded.updated_at`,
        )
        .bind(
          entry.guildId,
          entry.channelId,
          entry.summary,
          entry.coveredUntilId,
          (entry.coveredFrom ?? '').trim(),
          (entry.coveredTo ?? '').trim(),
          entry.updatedAt,
        )
        .run();
    },

    async remove(key: ChannelKey): Promise<void> {
      await db
        .prepare('DELETE FROM conversation_summaries WHERE guild_id = ? AND channel_id = ?')
        .bind(key.guildId, key.channelId)
        .run();
    },
  };

  const channelMemory: ChannelMemoryStore = {
    async get(key: ChannelKey): Promise<ChannelMemoryConfig | null> {
      // 没有行 = 用代码默认（§26.2），这里不拼默认值：拼默认是 core 的事
      const row = await db
        .prepare(
          'SELECT history_max_messages, summary_every_messages, summary_max_chars, context_tool, updated_at FROM channel_memory_settings WHERE guild_id = ? AND channel_id = ?',
        )
        .bind(key.guildId, key.channelId)
        .first<ChannelMemoryRow>();
      return row === null ? null : toChannelMemoryConfig(row, key);
    },

    async list(): Promise<ChannelMemoryConfig[]> {
      // 后台记忆页一次列全表：排序交给 SQL，调用方拿到的就是 (guild, channel) 升序
      const { results } = await db
        .prepare(
          'SELECT guild_id, channel_id, history_max_messages, summary_every_messages, summary_max_chars, context_tool, updated_at FROM channel_memory_settings ORDER BY guild_id ASC, channel_id ASC',
        )
        .all<ChannelMemoryListRow>();
      return (results ?? []).map((row) =>
        toChannelMemoryConfig(row, { guildId: row.guild_id, channelId: row.channel_id }),
      );
    },

    async put(cfg: Omit<ChannelMemoryConfig, 'updatedAt'>): Promise<ChannelMemoryConfig> {
      // 一个频道一行：后台保存时三个字段一起提交，覆盖写才不会留下半新半旧的配置
      const updatedAt = nowIso();
      // 没配过预算就落 0（列是 NOT NULL），读侧再按「未设置」还原（§26.4）
      const summaryMaxChars = cfg.summaryMaxChars !== undefined && cfg.summaryMaxChars > 0 ? cfg.summaryMaxChars : 0;
      await db
        .prepare(
          `INSERT INTO channel_memory_settings (guild_id, channel_id, history_max_messages, summary_every_messages, summary_max_chars, context_tool, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, channel_id) DO UPDATE SET
             history_max_messages = excluded.history_max_messages,
             summary_every_messages = excluded.summary_every_messages,
             summary_max_chars = excluded.summary_max_chars,
             context_tool = excluded.context_tool,
             updated_at = excluded.updated_at`,
        )
        .bind(
          cfg.guildId,
          cfg.channelId,
          cfg.historyMaxMessages,
          cfg.summaryEveryMessages,
          summaryMaxChars,
          // 列是 INTEGER 0/1：与 reaction_model.enabled 同一写法，未传 = 关（§55）
          cfg.contextTool === true ? 1 : 0,
          updatedAt,
        )
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值，多一次往返只是给并发留缝隙
      return {
        guildId: cfg.guildId,
        channelId: cfg.channelId,
        historyMaxMessages: cfg.historyMaxMessages,
        summaryEveryMessages: cfg.summaryEveryMessages,
        ...(summaryMaxChars > 0 ? { summaryMaxChars } : {}),
        contextTool: cfg.contextTool === true,
        updatedAt,
      };
    },

    async remove(key: ChannelKey): Promise<void> {
      // DELETE 命中 0 行也是成功：没有行的频道本来就等于「用默认值」
      await db
        .prepare('DELETE FROM channel_memory_settings WHERE guild_id = ? AND channel_id = ?')
        .bind(key.guildId, key.channelId)
        .run();
    },
  };

  const reactionModels: ReactionModelStore = {
    async get(): Promise<ReactionModelConfig | null> {
      const row = await db
        .prepare('SELECT enabled, provider, model FROM reaction_model WHERE id = 1')
        .first<ReactionModelRow>();
      return row === null ? null : toReactionModelConfig(row);
    },

    async put(cfg: ReactionModelConfig): Promise<void> {
      // id 恒为 1（表上 CHECK 兜底）：后台每次保存都是「改那一行」，不是新增一套配置
      await db
        .prepare(
          `INSERT INTO reaction_model (id, enabled, provider, model, updated_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             enabled = excluded.enabled,
             provider = excluded.provider,
             model = excluded.model,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.enabled ? 1 : 0, cfg.provider, cfg.model.trim(), nowIso())
        .run();
    },
  };

  const reactionGuides: ReactionGuideStore = {
    async get(key: ScopedKey): Promise<ReactionGuideConfig | null> {
      // 没有行 = 这一层没配置，读侧落回上一层（§28.10）；这里不拼默认值：拼默认是 core 的事
      const row = await db
        .prepare('SELECT scope, scope_id, prompt, updated_at FROM reaction_guides WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<ReactionGuideRow>();
      return row === null ? null : toReactionGuideConfig(row);
    },

    async list(): Promise<ReactionGuideConfig[]> {
      // 后台一次列全表：排序钉在 (scope, scope_id) 升序，前端按三层渲染时顺序稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, prompt, updated_at FROM reaction_guides ORDER BY scope ASC, scope_id ASC')
        .all<ReactionGuideRow>();
      const out: ReactionGuideConfig[] = [];
      for (const row of results ?? []) {
        const config = toReactionGuideConfig(row);
        if (config !== null) out.push(config);
      }
      return out;
    },

    async put(cfg: Omit<ReactionGuideConfig, 'updatedAt'>): Promise<ReactionGuideConfig> {
      // 一层一行：后台保存就是整份覆盖，不存在「只改半段」（§28.10 整组覆盖）
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO reaction_guides (scope, scope_id, prompt, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             prompt = excluded.prompt,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.scope, cfg.scopeId, cfg.prompt, updatedAt)
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值
      return { scope: cfg.scope, scopeId: cfg.scopeId, prompt: cfg.prompt, updatedAt };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没有配置，读侧自然落回上一层；命中 0 行也算成功，后台连点两下不该报错
      await db
        .prepare('DELETE FROM reaction_guides WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const bodyEmojiGuides: BodyEmojiGuideStore = {
    async get(key: ScopedKey): Promise<BodyEmojiGuideConfig | null> {
      // 没有行 = 这一层没配置，读侧落回上一层；这里不拼默认值：拼默认是 core 的事
      const row = await db
        .prepare('SELECT scope, scope_id, prompt, updated_at FROM body_emoji_guides WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<BodyEmojiGuideRow>();
      return row === null ? null : toBodyEmojiGuideConfig(row);
    },

    async list(): Promise<BodyEmojiGuideConfig[]> {
      // 后台一次列全表：排序钉在 (scope, scope_id) 升序，前端按三层渲染时顺序稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, prompt, updated_at FROM body_emoji_guides ORDER BY scope ASC, scope_id ASC')
        .all<BodyEmojiGuideRow>();
      const out: BodyEmojiGuideConfig[] = [];
      for (const row of results ?? []) {
        const config = toBodyEmojiGuideConfig(row);
        if (config !== null) out.push(config);
      }
      return out;
    },

    async put(cfg: Omit<BodyEmojiGuideConfig, 'updatedAt'>): Promise<BodyEmojiGuideConfig> {
      // 一层一行：后台保存就是整份覆盖，不存在「只改半段」（整组覆盖）
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO body_emoji_guides (scope, scope_id, prompt, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             prompt = excluded.prompt,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.scope, cfg.scopeId, cfg.prompt, updatedAt)
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值
      return { scope: cfg.scope, scopeId: cfg.scopeId, prompt: cfg.prompt, updatedAt };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没有配置，读侧自然落回上一层；命中 0 行也算成功，后台连点两下不该报错
      await db
        .prepare('DELETE FROM body_emoji_guides WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const reactionTemplates: ReactionTemplateStore = {
    async get(key: ScopedKey): Promise<ReactionTemplateConfig | null> {
      // 没有行 = 这一层没配置，读侧落回上一层（§34.2）；这里不拼默认模板：拼默认是 core 的事
      const row = await db
        .prepare('SELECT scope, scope_id, template, updated_at FROM reaction_templates WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<ReactionTemplateRow>();
      return row === null ? null : toReactionTemplateConfig(row);
    },

    async list(): Promise<ReactionTemplateConfig[]> {
      // 后台一次列全表：排序钉在 (scope, scope_id) 升序，前端按三层渲染时顺序稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, template, updated_at FROM reaction_templates ORDER BY scope ASC, scope_id ASC')
        .all<ReactionTemplateRow>();
      const out: ReactionTemplateConfig[] = [];
      for (const row of results ?? []) {
        const config = toReactionTemplateConfig(row);
        if (config !== null) out.push(config);
      }
      return out;
    },

    async put(cfg: Omit<ReactionTemplateConfig, 'updatedAt'>): Promise<ReactionTemplateConfig> {
      // 一层一行：后台保存就是整份覆盖，模板只有「整份生效」这一种语义
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO reaction_templates (scope, scope_id, template, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             template = excluded.template,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.scope, cfg.scopeId, cfg.template, updatedAt)
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值
      return { scope: cfg.scope, scopeId: cfg.scopeId, template: cfg.template, updatedAt };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没有配置，读侧自然落回上一层；命中 0 行也算成功，后台连点两下不该报错
      await db
        .prepare('DELETE FROM reaction_templates WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const replySettings: ReplySettingsStore = {
    async get(key: ScopedKey): Promise<RevealStepsConfig | null> {
      // 没有行 = 这一层没配置，读侧落回上一层（§38）；默认值由 core 拼，仓储不猜
      const row = await db
        .prepare('SELECT scope, scope_id, reveal_steps, updated_at FROM reply_settings WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<ReplySettingsRow>();
      return row === null ? null : toRevealStepsConfig(row);
    },

    async list(): Promise<RevealStepsConfig[]> {
      // 后台一次列全表：排序钉在 (scope, scope_id) 升序，前端按三层渲染时顺序稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, reveal_steps, updated_at FROM reply_settings ORDER BY scope ASC, scope_id ASC')
        .all<ReplySettingsRow>();
      const out: RevealStepsConfig[] = [];
      for (const row of results ?? []) {
        const config = toRevealStepsConfig(row);
        if (config !== null) out.push(config);
      }
      return out;
    },

    async put(cfg: Omit<RevealStepsConfig, 'updatedAt'>): Promise<RevealStepsConfig> {
      // 一层一行：后台保存就是整份覆盖，切片次数只有「这一层用一个数」这一种语义
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO reply_settings (scope, scope_id, reveal_steps, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             reveal_steps = excluded.reveal_steps,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.scope, cfg.scopeId, cfg.revealSteps, updatedAt)
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值
      return { scope: cfg.scope, scopeId: cfg.scopeId, revealSteps: cfg.revealSteps, updatedAt };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没有配置，读侧自然落回上一层；命中 0 行也算成功，后台连点两下不该报错
      await db
        .prepare('DELETE FROM reply_settings WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const visionSettings: VisionSettingsStore = {
    async get(key: ScopedKey): Promise<VisionSettingsConfig | null> {
      // 没有行 = 这一层没配置，读侧落回上一层（§41）；默认值由 core 拼，仓储不猜
      const row = await db
        .prepare('SELECT scope, scope_id, enabled, updated_at FROM vision_settings WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<VisionSettingsRow>();
      return row === null ? null : toVisionSettingsConfig(row);
    },

    async list(): Promise<VisionSettingsConfig[]> {
      // 后台一次列全表：排序钉在 (scope, scope_id) 升序，前端按三层渲染时顺序稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, enabled, updated_at FROM vision_settings ORDER BY scope ASC, scope_id ASC')
        .all<VisionSettingsRow>();
      const out: VisionSettingsConfig[] = [];
      for (const row of results ?? []) {
        const config = toVisionSettingsConfig(row);
        if (config !== null) out.push(config);
      }
      return out;
    },

    async put(cfg: Omit<VisionSettingsConfig, 'updatedAt'>): Promise<VisionSettingsConfig> {
      // 一层一行：后台保存就是整份覆盖，开关只有「这一层开/关」这一种语义
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO vision_settings (scope, scope_id, enabled, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.scope, cfg.scopeId, cfg.enabled ? 1 : 0, updatedAt)
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值
      return { scope: cfg.scope, scopeId: cfg.scopeId, enabled: cfg.enabled, updatedAt };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没有配置，读侧自然落回上一层；命中 0 行也算成功，后台连点两下不该报错
      await db
        .prepare('DELETE FROM vision_settings WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const voiceSettings: VoiceSettingsStore = {
    async get(key: ScopedKey): Promise<VoiceSettingsConfig | null> {
      // 没有行 = 这一层没配置，读侧落回上一层；默认值（mode 0 / 语速 100）由 core 拼，仓储不猜
      const row = await db
        .prepare('SELECT scope, scope_id, mode, voice, speed, director, updated_at FROM voice_settings WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<VoiceSettingsRow>();
      return row === null ? null : toVoiceSettingsConfig(row);
    },

    async list(): Promise<VoiceSettingsConfig[]> {
      // 排序钉在 (scope, scope_id) 升序，前端按三层渲染时顺序稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, mode, voice, speed, director, updated_at FROM voice_settings ORDER BY scope ASC, scope_id ASC')
        .all<VoiceSettingsRow>();
      const out: VoiceSettingsConfig[] = [];
      for (const row of results ?? []) {
        const config = toVoiceSettingsConfig(row);
        if (config !== null) out.push(config);
      }
      return out;
    },

    async put(cfg: Omit<VoiceSettingsConfig, 'updatedAt'>): Promise<VoiceSettingsConfig> {
      // 一层一行：保存就是整份覆盖（开关 + 音色 + 语速 + 导演模式一起写）
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO voice_settings (scope, scope_id, mode, voice, speed, director, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             mode = excluded.mode,
             voice = excluded.voice,
             speed = excluded.speed,
             director = excluded.director,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.scope, cfg.scopeId, cfg.mode, cfg.voice, cfg.speed, cfg.director, updatedAt)
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值
      return {
        scope: cfg.scope,
        scopeId: cfg.scopeId,
        mode: cfg.mode,
        voice: cfg.voice,
        speed: cfg.speed,
        director: cfg.director,
        updatedAt,
      };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没有配置，读侧自然落回上一层；命中 0 行也算成功
      await db
        .prepare('DELETE FROM voice_settings WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const promptInjections: PromptInjectionStore = {
    async get(key: ScopedKey): Promise<PromptInjectionConfig | null> {
      // 没有行 = 这一层没配置，由 core 继续往下找；仓储不猜上游想插在哪
      const row = await db
        .prepare('SELECT scope, scope_id, content, depth, role, updated_at FROM prompt_injections WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<PromptInjectionRow>();
      return row === null ? null : toPromptInjectionConfig(row);
    },

    async list(): Promise<PromptInjectionConfig[]> {
      // 排序钉在 (scope, scope_id) 升序：后台三层现状的渲染顺序因此稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, content, depth, role, updated_at FROM prompt_injections ORDER BY scope ASC, scope_id ASC')
        .all<PromptInjectionRow>();
      const out: PromptInjectionConfig[] = [];
      for (const row of results ?? []) {
        const config = toPromptInjectionConfig(row);
        if (config !== null) out.push(config);
      }
      return out;
    },

    async put(cfg: Omit<PromptInjectionConfig, 'updatedAt'>): Promise<PromptInjectionConfig> {
      // 一层一行：保存就是整份覆盖（正文 + 深度 + 角色一起写），空正文也照存——那是「关掉这一层」的写法
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO prompt_injections (scope, scope_id, content, depth, role, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             content = excluded.content,
             depth = excluded.depth,
             role = excluded.role,
             updated_at = excluded.updated_at`,
        )
        .bind(cfg.scope, cfg.scopeId, cfg.content, cfg.depth, cfg.role, updatedAt)
        .run();
      // 回写手里的这一行，不再查一次库：落库的就是这几个值
      return {
        scope: cfg.scope,
        scopeId: cfg.scopeId,
        content: cfg.content,
        depth: cfg.depth,
        role: cfg.role,
        updatedAt,
      };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没配置，读侧落回上一层；命中 0 行也算成功
      await db
        .prepare('DELETE FROM prompt_injections WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const worldBooks: WorldBookStore = {
    async get(key: ScopedKey): Promise<WorldBookRecord | null> {
      // 没有行 = 这一层没导入过，由 core 继续往下找；仓储不替 core 决定回退到哪一层
      const row = await db
        .prepare('SELECT scope, scope_id, name, book_json, entry_count, imported_at FROM world_books WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<WorldBookRow>();
      return row === null ? null : toWorldBookRecord(row);
    },

    async list(): Promise<WorldBookRecord[]> {
      // 排序钉在 (scope, scope_id) 升序：后台三层的渲染顺序因此稳定
      const { results } = await db
        .prepare('SELECT scope, scope_id, name, book_json, entry_count, imported_at FROM world_books ORDER BY scope ASC, scope_id ASC')
        .all<WorldBookRow>();
      const out: WorldBookRecord[] = [];
      for (const row of results ?? []) {
        const record = toWorldBookRecord(row);
        if (record !== null) out.push(record);
      }
      return out;
    },

    async put(input: { scope: Scope; scopeId: string; name: string; book: WorldBook }): Promise<WorldBookRecord> {
      // 一层一本：整本覆盖，旧条目一条不留——半本旧书混进新书比丢掉旧书更难查
      const importedAt = nowIso();
      const entryCount = input.book.entries.length;
      await db
        .prepare(
          `INSERT INTO world_books (scope, scope_id, name, book_json, entry_count, imported_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             name = excluded.name,
             book_json = excluded.book_json,
             entry_count = excluded.entry_count,
             imported_at = excluded.imported_at`,
        )
        .bind(input.scope, input.scopeId, input.name, JSON.stringify(input.book), entryCount, importedAt)
        .run();
      // 回写手里的这份，不再查一次库：落库的就是这几个值
      return {
        scope: input.scope,
        scopeId: input.scopeId,
        name: input.name,
        book: input.book,
        entryCount,
        importedAt,
      };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉 = 这一层没有世界书，读侧落回上一层；命中 0 行也算成功
      await db
        .prepare('DELETE FROM world_books WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  const emojiDescriptions: EmojiDescriptionStore = {
    async list(guildId: string): Promise<EmojiDescription[]> {
      // 显式列名：guild_id 只当过滤条件，回来后上层用不到；排序钉在 emoji_id 升序，网关合并清单时顺序稳定
      const { results } = await db
        .prepare('SELECT emoji_id, name, description, updated_at FROM emoji_descriptions WHERE guild_id = ? ORDER BY emoji_id ASC')
        .bind(guildId)
        .all<EmojiDescriptionRow>();
      return (results ?? []).map(toEmojiDescription);
    },

    async putMany(guildId: string, rows: ReadonlyArray<Omit<EmojiDescription, 'updatedAt'>>): Promise<void> {
      if (rows.length === 0) return;
      // 一批认图结果同刻落库：updated_at 只取一次「现在」，批内各行时间戳一致
      const updatedAt = nowIso();
      const statement = db.prepare(
        `INSERT INTO emoji_descriptions (guild_id, emoji_id, name, description, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, emoji_id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           updated_at = excluded.updated_at`,
      );
      // db.batch 而不是逐条 run：整批一次往返、原子提交，和 conversations.append 的批量写同一手法
      await db.batch(rows.map((row) => statement.bind(guildId, row.emojiId, row.name, row.description, updatedAt)));
    },
  };

  const emojiAliases: EmojiAliasStore = {
    async list(guildId: string): Promise<EmojiAlias[]> {
      // 显式列名：guild_id / created_at 都不进上层；ORDER BY 钉住别名升序，后台列表顺序稳定
      const { results } = await db
        .prepare('SELECT alias, emoji_id, emoji_name FROM emoji_aliases WHERE guild_id = ? ORDER BY alias ASC')
        .bind(guildId)
        .all<EmojiAliasRow>();
      return (results ?? []).map(toEmojiAlias);
    },

    async put(guildId: string, alias: EmojiAlias): Promise<void> {
      // ON CONFLICT 只换指向：created_at 一旦落下就不再重写，改别名指向不该洗掉「什么时候配的」
      await db
        .prepare(
          `INSERT INTO emoji_aliases (guild_id, alias, emoji_id, emoji_name, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, alias) DO UPDATE SET
             emoji_id = excluded.emoji_id,
             emoji_name = excluded.emoji_name`,
        )
        .bind(guildId, alias.alias, alias.emojiId, alias.emojiName, nowIso())
        .run();
    },

    async remove(guildId: string, alias: string): Promise<void> {
      // DELETE 命中 0 行也是成功：管理页可能连点两下，第二次不该报错
      await db.prepare('DELETE FROM emoji_aliases WHERE guild_id = ? AND alias = ?').bind(guildId, alias).run();
    },
  };

  const promptDefaults: PromptDefaultsStore = {
    // 只查这一层：一层最多两行（fallback / identity）
    async get(key: ScopedKey): Promise<PromptDefaultsScope> {
      const { results } = await db
        .prepare('SELECT ' + PROMPT_DEFAULT_COLUMNS + ' FROM prompt_defaults WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .all<PromptDefaultRow>();
      const defaults: PromptDefaultsScope = { fallback: null, identity: null };
      for (const row of results ?? []) {
        // 别的 key 直接忽略：读侧永不因为库里有脏 key 而报错
        const rowKey = row.key;
        if (!isPromptDefaultKey(rowKey)) continue;
        defaults[rowKey] = toPromptDefaultEntry(row, rowKey);
      }
      return defaults;
    },

    // 后台列表一次取全表：行数是「两份文案 × 配过的层」，量级很小
    async list(): Promise<PromptDefaultEntry[]> {
      const { results } = await db
        .prepare('SELECT ' + PROMPT_DEFAULT_COLUMNS + ' FROM prompt_defaults')
        .all<PromptDefaultRow>();
      const entries: PromptDefaultEntry[] = [];
      for (const row of results ?? []) {
        if (!isPromptDefaultKey(row.key)) continue;
        entries.push(toPromptDefaultEntry(row, row.key));
      }
      return entries;
    },

    async put(entry: {
      key: PromptDefaultKey;
      scope: Scope;
      scopeId: string;
      content: string;
    }): Promise<PromptDefaultEntry> {
      const updatedAt = nowIso();
      // content 原样存：模板正文里的换行与缩进都是语义的一部分
      await db
        .prepare(
          `INSERT INTO prompt_defaults (key, scope, scope_id, content, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (key, scope, scope_id) DO UPDATE SET
             content = excluded.content,
             updated_at = excluded.updated_at`,
        )
        .bind(entry.key, entry.scope, entry.scopeId, entry.content, updatedAt)
        .run();
      return { key: entry.key, scope: entry.scope, scopeId: entry.scopeId, content: entry.content, updatedAt };
    },

    async remove(key: ScopedKey & { key: PromptDefaultKey }): Promise<void> {
      // 删掉即恢复这一层的代码默认；命中 0 行也算成功（后台连点两下不该报错）
      await db
        .prepare('DELETE FROM prompt_defaults WHERE key = ? AND scope = ? AND scope_id = ?')
        .bind(key.key, key.scope, key.scopeId)
        .run();
    },
  };

  const ttsSettings: TtsSettingsStore = {
    async get(): Promise<TtsSettingsSecret | null> {
      const row = await db
        .prepare(
          'SELECT url, key_sealed, key_hint, model, voice, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model, updated_at FROM tts_settings WHERE id = 1',
        )
        .first<TtsSettingsRow>();
      if (row === null) return null;
      // *_sealed 为空 = 没配过密钥（列 NOT NULL DEFAULT ''），此时没有明文可解
      const key = row.key_sealed === '' ? '' : await secretBox.decrypt(row.key_sealed);
      const judgeKey = row.judge_key_sealed === '' ? '' : await secretBox.decrypt(row.judge_key_sealed);
      // 列上已有 CHECK，仍在这里收窄：脏数据最多让请求走回 openai，而不是把未知方言带进运行时
      const dialect = row.dialect === 'mimo' ? 'mimo' : 'openai';
      return {
        dialect,
        url: row.url,
        key,
        model: row.model,
        voice: row.voice,
        judgeUrl: row.judge_url,
        judgeKey,
        judgeModel: row.judge_model,
        updatedAt: row.updated_at,
      };
    },

    async put(input: TtsSettingsInput): Promise<TtsSettingsView> {
      // id 恒为 1：后台每次保存都是改那一行。省略 key 就原样搬回旧密文与旧掩码
      const previous = await db
        .prepare(
          'SELECT key_sealed, key_hint, model, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model FROM tts_settings WHERE id = 1',
        )
        .first<{
          key_sealed: string;
          key_hint: string;
          model: string;
          dialect: string;
          judge_url: string;
          judge_key_sealed: string;
          judge_key_hint: string;
          judge_model: string;
        }>();
      let keySealed = previous?.key_sealed ?? '';
      let keyHint = previous?.key_hint ?? '';
      if (input.key !== undefined) {
        keySealed = await secretBox.encrypt(input.key);
        keyHint = maskKeyHint(input.key);
      }
      // judgeKey 与 key 同一条规则：省略 = 原样保留旧密文与旧掩码，给了就重新加密
      let judgeKeySealed = previous?.judge_key_sealed ?? '';
      let judgeKeyHint = previous?.judge_key_hint ?? '';
      if (input.judgeKey !== undefined) {
        judgeKeySealed = await secretBox.encrypt(input.judgeKey);
        judgeKeyHint = maskKeyHint(input.judgeKey);
      }
      // judgeUrl / judgeModel 省略 = 保留旧值（老前端保存时不会带这两个字段，不能顺手把 judge 清空）；
      // 显式传空串才是「清掉这一项」
      const judgeUrl = input.judgeUrl === undefined ? (previous?.judge_url ?? '') : input.judgeUrl.trim();
      const judgeModel = input.judgeModel === undefined ? (previous?.judge_model ?? '') : input.judgeModel.trim();
      // 省略 dialect = 不改方言（老前端只改 url/model 时不该把 MiMo 打回 openai）；旧行为空按 openai
      const storedDialect = previous?.dialect === 'mimo' ? 'mimo' : 'openai';
      const requestedDialect = (input.dialect ?? '').trim();
      // 显式给了就用给的；不认识的词进不了库（路由层已挡 400，列上还有 CHECK），这里只做兜底收窄
      const dialect = requestedDialect === '' ? storedDialect : requestedDialect === 'mimo' ? 'mimo' : 'openai';
      const updatedAt = nowIso();
      // model 列保留不动：后台已不再传它，旧值原样留着，合成侧也不会读
      const model = previous?.model ?? '';
      const voice = (input.voice ?? '').trim();
      await db
        .prepare(
          `INSERT INTO tts_settings (id, url, key_sealed, key_hint, model, voice, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             url = excluded.url,
             key_sealed = excluded.key_sealed,
             key_hint = excluded.key_hint,
             model = excluded.model,
             voice = excluded.voice,
             dialect = excluded.dialect,
             judge_url = excluded.judge_url,
             judge_key_sealed = excluded.judge_key_sealed,
             judge_key_hint = excluded.judge_key_hint,
             judge_model = excluded.judge_model,
             updated_at = excluded.updated_at`,
        )
        .bind(input.url, keySealed, keyHint, model, voice, dialect, judgeUrl, judgeKeySealed, judgeKeyHint, judgeModel, updatedAt)
        .run();
      return { dialect, url: input.url, keyHint, voice, judgeUrl, judgeKeyHint, judgeModel, updatedAt };
    },

    async remove(): Promise<void> {
      // 删整行 = 回到「未配置」；命中 0 行也算成功
      await db.prepare('DELETE FROM tts_settings WHERE id = 1').run();
    },
  };

  const ttsStyles: TtsStyleStore = {
    // 只查这一层：channel / guild / global 各至多一行
    async get(key: ScopedKey): Promise<TtsStyleLayer | null> {
      const row = await db
        .prepare('SELECT scope, scope_id, content, updated_at FROM tts_style_prompts WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .first<TtsStyleRow>();
      return row === null ? null : toTtsStyleLayer(row);
    },

    // 后台列表一次取全表：行数是「配过的层」，量级很小；排序交给调用方
    async list(): Promise<TtsStyleLayer[]> {
      const { results } = await db
        .prepare('SELECT scope, scope_id, content, updated_at FROM tts_style_prompts')
        .all<TtsStyleRow>();
      return (results ?? []).map(toTtsStyleLayer);
    },

    async put(input: { scope: Scope; scopeId: string; content: string }): Promise<TtsStyleLayer> {
      const updatedAt = nowIso();
      await db
        .prepare(
          `INSERT INTO tts_style_prompts (scope, scope_id, content, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, scope_id) DO UPDATE SET
             content = excluded.content,
             updated_at = excluded.updated_at`,
        )
        .bind(input.scope, input.scopeId, input.content, updatedAt)
        .run();
      return { scope: input.scope, scopeId: input.scopeId, content: input.content, updatedAt };
    },

    async remove(key: ScopedKey): Promise<void> {
      // 删掉即这一层回到「没配」；命中 0 行也算成功（后台连点两下不该报错）
      await db
        .prepare('DELETE FROM tts_style_prompts WHERE scope = ? AND scope_id = ?')
        .bind(key.scope, key.scopeId)
        .run();
    },
  };

  return {
    prompts,
    presetImports,
    routes,
    keys,
    conversations,
    summaries,
    channelMemory,
    reactionModels,
    ttsSettings,
    ttsStyles,
    reactionGuides,
    reactionTemplates,
    promptDefaults,
    replySettings,
    bodyEmojiGuides,
    visionSettings,
    voiceSettings,
    emojiDescriptions,
    emojiAliases,
    promptInjections,
    worldBooks,
  };
}