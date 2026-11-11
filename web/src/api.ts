// 只依赖 docs/architecture.md §11 的 HTTP 契约，禁止 import src/**。

export type ProviderId = 'openai-compat' | 'anthropic' | 'gemini';
export type Scope = 'global' | 'guild' | 'channel';
export type Role = 'user' | 'assistant';

export const PROVIDER_IDS: ProviderId[] = ['openai-compat', 'anthropic', 'gemini'];
export const SCOPE_IDS: Scope[] = ['global', 'guild', 'channel'];
export const SCOPE_LABELS: Record<Scope, string> = {
  global: '全局（global）',
  guild: '服务器（guild）',
  channel: '频道（channel）',
};

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

// §11 提示词多段编辑（酒馆式）：一层 = 若干段，保存后服务端按数组顺序写 position。
export type PromptRole = 'system' | 'user';
/** system 段落进系统提示词的位置：累积摘要块之前 / 之后。 */
export type PromptPlacement = 'before' | 'after';

export const PROMPT_ROLE_IDS: PromptRole[] = ['system', 'user'];
export const PROMPT_ROLE_LABELS: Record<PromptRole, string> = {
  system: 'system 主体提示词',
  user: 'user 用户消息',
};
export const PROMPT_PLACEMENT_IDS: PromptPlacement[] = ['before', 'after'];
export const PROMPT_PLACEMENT_LABELS: Record<PromptPlacement, string> = {
  before: '摘要块之前',
  after: '摘要块之后',
};

export interface PromptSegment {
  id: string;
  name: string;
  role: PromptRole;
  content: string;
  enabled: boolean;
  placement: PromptPlacement;
  position: number;
}

export interface PromptItem {
  scope: Scope;
  scopeId: string;
  segments: PromptSegment[];
  temperature?: number;
  maxTokens?: number;
}

/** PUT /api/prompts 的段：id 与 position 由服务端生成，前端一律不传。 */
export interface PromptSegmentInput {
  name: string;
  role: PromptRole;
  content: string;
  enabled: boolean;
  placement: PromptPlacement;
}

export interface PromptSaveInput {
  scope: Scope;
  scopeId: string;
  temperature?: number;
  maxTokens?: number;
  segments: PromptSegmentInput[];
}

/** 契约 sillytavern-import：导入后落到目标层（global / guild / channel）的一段；id 与 position 由服务端生成，前端不传。 */
export interface PromptImportSegment {
  name: string;
  role: PromptRole;
  content: string;
  enabled: boolean;
  placement: PromptPlacement;
}

/**
 * 被跳过的条目：marker = 酒馆的占位标记，empty = 空正文，badRole = 角色不是 system / user，
 * （预设里本来就关着的段不再算忽略：它们作为停用段导进来，见 PresetImport。)
 */
export type PromptImportIgnoreReason = 'marker' | 'empty' | 'badRole';

export interface PromptImportIgnored {
  identifier: string;
  name: string;
  reason: PromptImportIgnoreReason;
}

/** 被搬去同层深度注入（层由请求的 scope / scopeId 决定）的段：它不在段表里，页面只能靠这里点名告诉用户它去哪了。 */
export interface PromptImportMoved {
  identifier: string;
  name: string;
}

/** 深度注入的写入结果：saved=false 时 chars/replaced 都是 0，页面据此提示「未能写入」。 */
export interface PromptImportInjection {
  saved: boolean;
  chars: number;
  replaced: boolean;
}

/**
 * POST /api/prompts/import 的 200：scope / scopeId 是本次实际写入的层（global 的 scopeId 为空串），
 * replaced 是被整层覆盖掉的旧段数；moved/injection 是写入同一层深度注入那条通道的结果
 * （preset 里没有历史后指令时两者都为空）。
 */
export interface PromptImportResult {
  segments: PromptImportSegment[];
  ignored: PromptImportIgnored[];
  moved: PromptImportMoved[];
  injection: PromptImportInjection;
  warnings: string[];
  charName: string;
  scope: Scope;
  scopeId: string;
  replaced: number;
}

/**
 * 请求体：preset 是前端 JSON.parse 出来的原样对象，charName 用于替换预设里的 {{char}}；
 * scope / scopeId 决定写哪一层，两个都不传 = 旧行为（scope 按 global、scopeId 为空串）。
 */
export interface PromptImportInput {
  preset: unknown;
  charName?: string;
  scope?: Scope;
  scopeId?: string;
}

/**
 * POST /api/prompts/copy 的请求：把 fromScope 那一层的预设整层搬到 toScope；global 的 scopeId 恒为空串，
 * 源与目标是同一条时后端回 400 SAME_TARGET。
 */
export interface PromptCopyInput {
  fromScope: Scope;
  fromScopeId: string;
  toScope: Scope;
  toScopeId: string;
}

/**
 * POST /api/prompts/copy 的 200：写入后的目标配置（段 / temperature / maxTokens 与 GET /api/prompts 同一形状），
 * 外加「内容其实来自哪一层」——目标层没配过时后端会沿优先级回溯，页面要把这一层点出来。
 */
export interface PromptCopyResult {
  segments: PromptSegment[];
  temperature?: number;
  maxTokens?: number;
  scope: Scope;
  scopeId: string;
  sourceScope: Scope;
  sourceScopeId: string;
}

export interface RouteItem {
  scope: Scope;
  scopeId: string;
  primary: ModelRef;
  fallbacks: ModelRef[];
  temperature?: number;
  maxTokens?: number;
  // 采样参数：缺省 = 这一层不设（后端存 NULL），0 是有效值
  topP?: number;
  topK?: number;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

// §20.2/§20.6：models 是「适用模型名单」，空数组 = 全部模型都可用。
export interface ProviderKeyItem {
  id: string;
  provider: ProviderId;
  label: string;
  baseUrl?: string;
  keyHint: string;
  enabled: boolean;
  createdAt: string;
  models: string[];
}

export interface ConversationItem {
  role: Role;
  content: string;
  createdAt: string;
}

// §19 实时日志：字段与后端 StoredLogEntry 逐字对齐（web 侧本地定义，不跨 web 根 import）。
export type LogLevel = 'info' | 'warn' | 'error';
export type LogScope = 'chat' | 'provider' | 'summary' | 'gateway' | 'admin';

export interface StoredLogEntry {
  id: number;
  createdAt: string;
  level: LogLevel;
  scope: LogScope;
  message: string;
}

export interface LogsResult {
  items: StoredLogEntry[];
  latest: number;
}

export interface KeyTestResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

// §21.5/§21.6 表情选择独立模型：enabled=false 表示不问表情模型，只剩主模型自己的 [[react:]]。
export interface ReactionModelConfig {
  enabled: boolean;
  provider: ProviderId;
  model: string;
}

/** §21.5 的「未配置」值：表为空时后端 GET 返回它，字段缺失时前端也回落到它。 */
export const REACTION_MODEL_DEFAULTS: ReactionModelConfig = {
  enabled: false,
  provider: 'openai-compat',
  model: '',
};

// §23.6 表情描述：emojiId 是 Discord 自定义表情 ID，description 是模型看图后写的中文文案。
export interface EmojiDescription {
  emojiId: string;
  name: string;
  description: string;
  updatedAt: string;
}

export interface ApiFailure {
  error?: unknown;
  vars?: unknown;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: ApiFailure;

  constructor(status: number, payload: ApiFailure, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }

  /** 服务端错误码（契约里的 error 字段）；502 测试失败时它承载的是人类可读信息。 */
  get code(): string {
    return typeof this.payload.error === 'string' ? this.payload.error : '';
  }

  get unknownVars(): string[] {
    const raw = this.payload.vars;
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
  }
}

export class UnauthorizedError extends ApiError {
  constructor(payload: ApiFailure) {
    super(401, payload, '登录已失效，请重新登录');
    this.name = 'UnauthorizedError';
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

interface RequestOptions {
  /** login / me 这类探测请求的 401 是业务结果，不应触发全局回登录页。 */
  anonymous?: boolean;
}

function parsePayload(text: string): ApiFailure {
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') return parsed as ApiFailure;
    return {};
  } catch {
    return {};
  }
}

function failureMessage(payload: ApiFailure, status: number): string {
  const code = typeof payload.error === 'string' ? payload.error : '';
  return code === '' ? '请求失败（HTTP ' + String(status) + '）' : code;
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, credentials: 'include', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(0, { error: 'NETWORK_ERROR' }, '无法连接服务：' + describeUnknown(error));
  }
  const payload = parsePayload(await response.text());
  if (response.status === 401 && options?.anonymous !== true) {
    const error = new UnauthorizedError(payload);
    if (unauthorizedHandler !== null) unauthorizedHandler();
    throw error;
  }
  if (!response.ok) throw new ApiError(response.status, payload, failureMessage(payload, response.status));
  return payload as T;
}

export const api = {
  me(): Promise<{ authed: boolean }> {
    return request<{ authed: boolean }>('GET', '/api/me', undefined, { anonymous: true });
  },

  login(password: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', '/api/login', { password }, { anonymous: true });
  },

  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', '/api/logout', undefined, { anonymous: true });
  },

  async listPrompts(): Promise<PromptItem[]> {
    const result = await request<{ items?: unknown[] }>('GET', '/api/prompts');
    const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
    const items: PromptItem[] = [];
    for (const entry of raw) {
      const item = toPromptItem(entry);
      if (item !== null) items.push(item);
    }
    return items;
  },

  savePrompt(input: PromptSaveInput): Promise<PromptItem> {
    return request<PromptItem>('PUT', '/api/prompts', input);
  },

  // 门牌 prompt-copy-1 酒馆预设导入：按 scope / scopeId 写目标层并整层覆盖该层的段；原始 JSON 按层另存一行，正则（阶段四）还要从这里读。
  // 世界书不走这条：它是单独一份 JSON，由 /api/world-book/import 整本覆盖某一层。
  async importPromptPreset(input: PromptImportInput): Promise<PromptImportResult> {
    return toPromptImportResult(await request<unknown>('POST', '/api/prompts/import', input));
  },

  // 门牌 prompt-scope-1 复制预设：整层复制到另一个作用域（目标层原有的段 / 采样参数会被覆盖），响应附带内容来源层。
  async copyPromptPreset(input: PromptCopyInput): Promise<PromptCopyResult> {
    return toPromptCopyResult(await request<unknown>('POST', '/api/prompts/copy', input));
  },

  deletePrompt(key: { scope: Scope; scopeId: string }): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', '/api/prompts', key);
  },

  async listRoutes(): Promise<RouteItem[]> {
    const result = await request<{ items?: RouteItem[] }>('GET', '/api/routes');
    return result.items ?? [];
  },

  saveRoute(input: RouteItem): Promise<RouteItem> {
    return request<RouteItem>('PUT', '/api/routes', input);
  },

  deleteRoute(key: { scope: Scope; scopeId: string }): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', '/api/routes', key);
  },

  async listKeys(): Promise<ProviderKeyItem[]> {
    const result = await request<{ items?: ProviderKeyItem[] }>('GET', '/api/keys');
    const items = result.items ?? [];
    // 后端 keyDto 万一漏带 models 时按 §20.3「缺省 = 空数组 = 全部」兜底，避免列表渲染 undefined.length
    return items.map((item) => ({ ...item, models: Array.isArray(item.models) ? item.models : [] }));
  },

  createKey(input: {
    provider: ProviderId;
    label: string;
    baseUrl?: string;
    apiKey: string;
    models?: string[];
  }): Promise<ProviderKeyItem> {
    return request<ProviderKeyItem>('POST', '/api/keys', input);
  },

  deleteKey(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', '/api/keys/' + encodeURIComponent(id));
  },

  testKey(id: string): Promise<KeyTestResult> {
    return request<KeyTestResult>('POST', '/api/keys/' + encodeURIComponent(id) + '/test');
  },

  async listConversations(query: { guildId: string; channelId: string; limit?: number }): Promise<ConversationItem[]> {
    const params = new URLSearchParams();
    params.set('guildId', query.guildId);
    params.set('channelId', query.channelId);
    if (typeof query.limit === 'number') params.set('limit', String(query.limit));
    const result = await request<{ items?: ConversationItem[] }>('GET', '/api/conversations?' + params.toString());
    return result.items ?? [];
  },

  health(): Promise<{ ok: boolean; version: string }> {
    return request<{ ok: boolean; version: string }>('GET', '/api/health', undefined, { anonymous: true });
  },
};

function toRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

// §11 后端改造在途：字段缺省时按最保守的值渲染，别让列表或编辑器读到 undefined。
function toScope(raw: unknown): Scope | null {
  for (const scope of SCOPE_IDS) {
    if (scope === raw) return scope;
  }
  return null;
}

// role / placement 不在枚举内时按第一项兜底，下拉框永远停在有选项的位置。
function toPromptRole(raw: unknown): PromptRole {
  return raw === 'user' ? 'user' : 'system';
}

function toPromptPlacement(raw: unknown): PromptPlacement {
  return raw === 'after' ? 'after' : 'before';
}

function toPromptSegment(raw: unknown, index: number): PromptSegment | null {
  const source = toRecord(raw);
  const id = typeof source.id === 'string' ? source.id : '';
  // id 是段卡片与排序的唯一定位，缺了这张卡片就没法稳定渲染，丢弃。
  if (id === '') return null;
  return {
    id,
    name: typeof source.name === 'string' ? source.name : '',
    role: toPromptRole(source.role),
    content: typeof source.content === 'string' ? source.content : '',
    // 缺省按启用处理：段默认是参与拼接的。
    enabled: source.enabled !== false,
    placement: toPromptPlacement(source.placement),
    position: typeof source.position === 'number' && Number.isFinite(source.position) ? source.position : index,
  };
}

function toPromptItem(raw: unknown): PromptItem | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  // scope 缺了就没法定位到哪一层，这条直接丢弃。
  if (scope === null) return null;
  const rawSegments: unknown[] = Array.isArray(source.segments) ? source.segments : [];
  const segments: PromptSegment[] = [];
  for (const entry of rawSegments) {
    const segment = toPromptSegment(entry, segments.length);
    if (segment !== null) segments.push(segment);
  }
  const item: PromptItem = {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    segments,
  };
  if (typeof source.temperature === 'number' && Number.isFinite(source.temperature)) {
    item.temperature = source.temperature;
  }
  if (typeof source.maxTokens === 'number' && Number.isFinite(source.maxTokens)) {
    item.maxTokens = source.maxTokens;
  }
  return item;
}

function toImportIgnoreReason(raw: unknown): PromptImportIgnoreReason | null {
  if (raw === 'marker' || raw === 'empty' || raw === 'badRole') return raw;
  return null;
}

function toPromptImportSegment(raw: unknown): PromptImportSegment {
  const source = toRecord(raw);
  return {
    name: typeof source.name === 'string' ? source.name : '',
    role: toPromptRole(source.role),
    content: typeof source.content === 'string' ? source.content : '',
    enabled: source.enabled !== false,
    placement: toPromptPlacement(source.placement),
  };
}

// 契约 sillytavern-import 的 200 响应；结果区要按 reason 分组、逐条列 warnings，字段缺省先兜底再渲染。
function toPromptImportResult(raw: unknown): PromptImportResult {
  const source = toRecord(raw);
  const rawSegments: unknown[] = Array.isArray(source.segments) ? source.segments : [];
  const rawIgnored: unknown[] = Array.isArray(source.ignored) ? source.ignored : [];
  const rawWarnings: unknown[] = Array.isArray(source.warnings) ? source.warnings : [];
  const rawMoved: unknown[] = Array.isArray(source.moved) ? source.moved : [];
  const ignored: PromptImportIgnored[] = [];
  const moved: PromptImportMoved[] = [];
  for (const entry of rawIgnored) {
    const item = toRecord(entry);
    const reason = toImportIgnoreReason(item.reason);
    // reason 认不出就没法分组，这条丢掉：分组只认契约里的四个值。
    if (reason === null) continue;
    ignored.push({
      identifier: typeof item.identifier === 'string' ? item.identifier : '',
      name: typeof item.name === 'string' ? item.name : '',
      reason,
    });
  }
  for (const entry of rawMoved) {
    const item = toRecord(entry);
    moved.push({
      identifier: typeof item.identifier === 'string' ? item.identifier : '',
      name: typeof item.name === 'string' ? item.name : '',
    });
  }
  // 注入结果三字段各自兜底：saved 只认 true，坏字数按 0 报，页面据此走「未能写入」分支
  const rawInjection = toRecord(source.injection);
  // 写入层：老后端不回 scope 时按 global 兜底，global 的 scopeId 恒为空串（与 normalizeScopeId 同一口径）。
  const scope = toScope(source.scope) ?? 'global';
  return {
    segments: rawSegments.map(toPromptImportSegment),
    ignored,
    moved,
    injection: {
      saved: rawInjection.saved === true,
      chars: typeof rawInjection.chars === 'number' && Number.isFinite(rawInjection.chars) ? rawInjection.chars : 0,
      replaced: rawInjection.replaced === true,
    },
    warnings: rawWarnings.filter((item): item is string => typeof item === 'string'),
    charName: typeof source.charName === 'string' ? source.charName : '',
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    replaced: typeof source.replaced === 'number' && Number.isFinite(source.replaced) ? source.replaced : 0,
  };
}

// 契约 prompt-copy 的 200：坏段按 GET /api/prompts 同一口径丢掉（id 缺了就渲染不出来），
// 目标层字段缺失时按 global + 空串兜底；sourceScope 认不出就退回目标层，结果行至少不会空着。
function toPromptCopyResult(raw: unknown): PromptCopyResult {
  const source = toRecord(raw);
  const scope = toScope(source.scope) ?? 'global';
  const rawSegments: unknown[] = Array.isArray(source.segments) ? source.segments : [];
  const segments: PromptSegment[] = [];
  for (const entry of rawSegments) {
    const segment = toPromptSegment(entry, segments.length);
    if (segment !== null) segments.push(segment);
  }
  const sourceScope = toScope(source.sourceScope) ?? scope;
  const result: PromptCopyResult = {
    segments,
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    sourceScope,
    sourceScopeId: normalizeScopeId(sourceScope, typeof source.sourceScopeId === 'string' ? source.sourceScopeId : ''),
  };
  if (typeof source.temperature === 'number' && Number.isFinite(source.temperature)) {
    result.temperature = source.temperature;
  }
  if (typeof source.maxTokens === 'number' && Number.isFinite(source.maxTokens)) {
    result.maxTokens = source.maxTokens;
  }
  return result;
}

// 供应商必须在枚举内（§21.5），否则按未配置的默认值渲染，绝不让下拉框停在无选项状态。
function toProviderId(raw: unknown): ProviderId {
  for (const provider of PROVIDER_IDS) {
    if (provider === raw) return provider;
  }
  return REACTION_MODEL_DEFAULTS.provider;
}

// GET 回 { config }、PUT 回配置本体（§21.5），两种形状都认。
function pickReactionConfig(payload: unknown): unknown {
  const record = toRecord(payload);
  return 'config' in record ? record.config : payload;
}

function normalizeReactionModel(payload: unknown): ReactionModelConfig {
  const source = toRecord(pickReactionConfig(payload));
  return {
    enabled: source.enabled === true,
    provider: toProviderId(source.provider),
    model: typeof source.model === 'string' ? source.model : '',
  };
}

export async function fetchReactionModel(): Promise<ReactionModelConfig> {
  return normalizeReactionModel(await request<unknown>('GET', '/api/reaction-model'));
}

export async function saveReactionModel(cfg: ReactionModelConfig): Promise<ReactionModelConfig> {
  return normalizeReactionModel(await request<unknown>('PUT', '/api/reaction-model', cfg));
}

function toEmojiDescription(raw: unknown): EmojiDescription | null {
  const source = toRecord(raw);
  const emojiId = typeof source.emojiId === 'string' ? source.emojiId : '';
  if (emojiId === '') return null;
  return {
    emojiId,
    name: typeof source.name === 'string' && source.name !== '' ? source.name : emojiId,
    description: typeof source.description === 'string' ? source.description : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

function toCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** §23.6：GET /api/emojis?guildId= 回 { items }；坏条目直接丢弃，不让列表渲染出 undefined。 */
export async function fetchEmojiDescriptions(guildId: string): Promise<EmojiDescription[]> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  const result = await request<{ items?: unknown[] }>('GET', '/api/emojis?' + params.toString());
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: EmojiDescription[] = [];
  for (const entry of raw) {
    const item = toEmojiDescription(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/** §23.6：force=true 覆盖已有描述，false 只认还没有描述的表情；返回本轮认成/失败的数量。 */
export async function describeEmojis(guildId: string, force: boolean): Promise<{ described: number; failed: number }> {
  const result = await request<{ described?: unknown; failed?: unknown }>('POST', '/api/emojis/describe', {
    guildId: guildId.trim(),
    force,
  });
  return { described: toCount(result.described), failed: toCount(result.failed) };
}

// §24.6 该服真实表情清单：管理员配别名时从下拉里选，不手抄 ID。
export interface LiveEmoji {
  id: string;
  name: string;
  animated?: boolean;
}

// §24.2 管理员手工配的表情别名：一个别名只指向一个表情。
export interface EmojiAlias {
  alias: string;
  emojiId: string;
  emojiName: string;
}

function toLiveEmoji(raw: unknown): LiveEmoji | null {
  const source = toRecord(raw);
  const id = typeof source.id === 'string' ? source.id : '';
  if (id === '') return null;
  const item: LiveEmoji = { id, name: typeof source.name === 'string' && source.name !== '' ? source.name : id };
  if (source.animated === true) item.animated = true;
  return item;
}

function toEmojiAlias(raw: unknown): EmojiAlias | null {
  const source = toRecord(raw);
  const alias = typeof source.alias === 'string' ? source.alias.trim() : '';
  const emojiId = typeof source.emojiId === 'string' ? source.emojiId : '';
  if (alias === '' || emojiId === '') return null;
  return {
    alias,
    emojiId,
    emojiName: typeof source.emojiName === 'string' && source.emojiName !== '' ? source.emojiName : emojiId,
  };
}

/** §24.6：GET /api/emojis/live?guildId= 回 { items }；坏条目丢弃，下拉里不出现空选项。 */
export async function fetchLiveEmojis(guildId: string): Promise<LiveEmoji[]> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  const result = await request<{ items?: unknown[] }>('GET', '/api/emojis/live?' + params.toString());
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: LiveEmoji[] = [];
  for (const entry of raw) {
    const item = toLiveEmoji(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/** §24.6：GET /api/emoji-aliases?guildId= 回 { items }。 */
export async function fetchEmojiAliases(guildId: string): Promise<EmojiAlias[]> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  const result = await request<{ items?: unknown[] }>('GET', '/api/emoji-aliases?' + params.toString());
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: EmojiAlias[] = [];
  for (const entry of raw) {
    const item = toEmojiAlias(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/** §24.6：PUT /api/emoji-aliases 覆盖写同 (guildId, alias) 的指向，回保存后的别名。 */
export async function saveEmojiAlias(input: {
  guildId: string;
  alias: string;
  emojiId: string;
  emojiName: string;
}): Promise<EmojiAlias> {
  const alias = input.alias.trim();
  const result = await request<unknown>('PUT', '/api/emoji-aliases', {
    guildId: input.guildId.trim(),
    alias,
    emojiId: input.emojiId,
    emojiName: input.emojiName,
  });
  // 后端回的是保存后的本体；万一字段缺失就按入参兜底，调用方不必处理 null。
  return toEmojiAlias(result) ?? { alias, emojiId: input.emojiId, emojiName: input.emojiName };
}

/** §24.6：DELETE /api/emoji-aliases?guildId=&alias=，别名不存在时后端也回 200。 */
export function deleteEmojiAlias(guildId: string, alias: string): Promise<{ ok: boolean }> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  params.set('alias', alias.trim());
  return request<{ ok: boolean }>('DELETE', '/api/emoji-aliases?' + params.toString());
}

// §25.2/§25.3 后台手动改摘要：字段与后端 ConversationSummary 逐字对齐（web 侧本地定义，不跨 web 根 import）。
export interface ConversationSummary {
  guildId: string;
  channelId: string;
  summary: string;
  /** 已总结到 messages.id 的这一条，下次只捞比它新的；0 = 从头重算。 */
  coveredUntilId: number;
  updatedAt: string;
}

/** §17.2 重新总结的返回：页面拿 summary / coveredUntilId 回填表单，另外两项只做提示。 */
export interface SummaryOutcome {
  summary: string;
  coveredUntilId: number;
  summarizedMessages: number;
  model: string;
}

/** §25.3 「最近消息」一行；后端没存下 author / createdAt 时这两个键不出现。 */
export interface SummaryMessage {
  id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  author?: string;
  createdAt?: string;
}

export interface SummarySaveInput {
  guildId: string;
  channelId: string;
  summary: string;
  coveredUntilId: number;
}

// 后端存的就是这三个角色（types.ts 的 Role），别的值按 user 兜底，不让列表渲染出空标签。
function toSummaryRole(raw: unknown): SummaryMessage['role'] {
  return raw === 'system' || raw === 'assistant' ? raw : 'user';
}

function toConversationSummary(raw: unknown): ConversationSummary | null {
  const source = toRecord(raw);
  const guildId = typeof source.guildId === 'string' ? source.guildId : '';
  const channelId = typeof source.channelId === 'string' ? source.channelId : '';
  // key 缺一个就没法定位到哪个频道，这条直接丢弃。
  if (guildId === '' || channelId === '') return null;
  return {
    guildId,
    channelId,
    summary: typeof source.summary === 'string' ? source.summary : '',
    coveredUntilId: toCount(source.coveredUntilId),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

function toSummaryMessage(raw: unknown): SummaryMessage | null {
  const source = toRecord(raw);
  // id 是楼层点选的唯一依据，缺了这条行就没法用，丢弃而不是渲染成 NaN。
  if (typeof source.id !== 'number' || !Number.isInteger(source.id) || source.id < 0) return null;
  const item: SummaryMessage = {
    id: source.id,
    role: toSummaryRole(source.role),
    content: typeof source.content === 'string' ? source.content : '',
  };
  if (typeof source.author === 'string' && source.author !== '') item.author = source.author;
  if (typeof source.createdAt === 'string' && source.createdAt !== '') item.createdAt = source.createdAt;
  return item;
}

function toSummaryOutcome(raw: unknown): SummaryOutcome | null {
  const source = toRecord(raw);
  // summary 是回填表单的主体，缺了就当这次没拿到结果。
  if (typeof source.summary !== 'string') return null;
  return {
    summary: source.summary,
    coveredUntilId: toCount(source.coveredUntilId),
    summarizedMessages: toCount(source.summarizedMessages),
    model: typeof source.model === 'string' ? source.model : '',
  };
}

/** §25.3：GET /api/summaries 回 { items }；坏条目丢弃，列表里不出现空 key。 */
export async function fetchSummaries(): Promise<ConversationSummary[]> {
  const result = await request<{ items?: unknown[] }>('GET', '/api/summaries');
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: ConversationSummary[] = [];
  for (const entry of raw) {
    const item = toConversationSummary(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/** §25.3：GET /api/summaries/messages?guildId=&channelId=&limit=，id 升序；不传 limit 由后端用 50。 */
export async function fetchSummaryMessages(
  guildId: string,
  channelId: string,
  limit?: number,
): Promise<SummaryMessage[]> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  params.set('channelId', channelId.trim());
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) params.set('limit', String(Math.floor(limit)));
  const result = await request<{ items?: unknown[] }>('GET', '/api/summaries/messages?' + params.toString());
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: SummaryMessage[] = [];
  for (const entry of raw) {
    const item = toSummaryMessage(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/** §62 删除单条短期记忆的结果：Discord 侧结局照实回，库里那行删没删看 deleted。 */
export interface DeletedHistoryMessage {
  deleted: boolean;
  /** deleted / not_found / ambiguous / no_token / failed / skipped */
  discord: string;
  detail: string;
}

/** §62：DELETE /api/messages/:id —— 先删 Discord 里那条，再删库里的行。 */
export async function deleteHistoryMessage(id: number): Promise<DeletedHistoryMessage> {
  const result = await request<{ deleted?: unknown; discord?: unknown; detail?: unknown }>(
    'DELETE',
    '/api/messages/' + String(Math.floor(id)),
  );
  return {
    deleted: result.deleted === true,
    discord: typeof result.discord === 'string' ? result.discord : 'skipped',
    detail: typeof result.detail === 'string' ? result.detail : '',
  };
}

/** §25.3：PUT /api/summaries 回保存后的本体；updatedAt 由服务端取，客户端不传时间。 */
export async function saveSummary(input: SummarySaveInput): Promise<ConversationSummary> {
  const guildId = input.guildId.trim();
  const channelId = input.channelId.trim();
  const saved = await request<unknown>('PUT', '/api/summaries', {
    guildId,
    channelId,
    // 正文里的换行原样上送（§25.7），trim 只发生在后端的长度校验里。
    summary: input.summary,
    coveredUntilId: input.coveredUntilId,
  });
  // 后端回的是保存后的本体；万一字段缺失按入参兜底，调用方不必处理 null。
  return (
    toConversationSummary(saved) ?? {
      guildId,
      channelId,
      summary: input.summary,
      coveredUntilId: input.coveredUntilId,
      updatedAt: '',
    }
  );
}

/** §25.3：DELETE /api/summaries?guildId=&channelId=，本来没有这条摘要也回 200。 */
export function deleteSummary(guildId: string, channelId: string): Promise<{ ok: boolean }> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  params.set('channelId', channelId.trim());
  return request<{ ok: boolean }>('DELETE', '/api/summaries?' + params.toString());
}

/** §25.3：POST /api/summaries/regenerate 回 { outcome }；无素材是 409 NO_SUMMARY_MATERIAL。 */
export async function regenerateSummary(guildId: string, channelId: string): Promise<SummaryOutcome> {
  const result = await request<{ outcome?: unknown }>('POST', '/api/summaries/regenerate', {
    guildId: guildId.trim(),
    channelId: channelId.trim(),
  });
  const outcome = toSummaryOutcome(result.outcome);
  // 契约把「无素材」表达成 409；万一真收到 200 + null，也走同一条错误映射，页面不必多一条分支。
  if (outcome === null) throw new ApiError(409, { error: 'NO_SUMMARY_MATERIAL' }, 'NO_SUMMARY_MATERIAL');
  return outcome;
}

/** §25.8 选择性补记：GET /api/summaries/range 的命中预览，samples 一行一条（首尾各最多 3 条）。 */
export interface BackfillPreview {
  count: number;
  tooLarge: boolean;
  firstAt?: string;
  lastAt?: string;
  samples: string[];
}

/** §25.8 POST /api/summaries/backfill 的结果：只报素材量与补记后的记忆长度，正文由页面再拉一次。 */
export interface BackfillOutcome {
  summarizedMessages: number;
  from: string;
  to: string;
  summaryLength: number;
  model: string;
}

/** §25.8 一次补记的条数上限；后端没在 body 里带 limit 时用它兜底文案。 */
const BACKFILL_RANGE_LIMIT = 500;

// §25.8 两条补记路由只回错误码，翻成中文再抛，页面直接显示 message 就是人话。
function describeBackfillError(error: ApiError): string {
  if (error.code === 'BAD_CHANNEL_KEY') return '缺少频道信息';
  if (error.code === 'BAD_TIME_RANGE') return '时间范围不合法';
  if (error.code === 'RANGE_TOO_LARGE') {
    // 真实上限写在 body 的 limit 里，不把 500 写死在前端。
    const limit = error.payload['limit'];
    const size =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? String(Math.floor(limit)) : String(BACKFILL_RANGE_LIMIT);
    return '这段超过 ' + size + ' 条，请把范围缩小';
  }
  if (error.code === 'NO_SUMMARY_MATERIAL') return '这段时间没有消息';
  if (error.code === 'SUMMARY_UNAVAILABLE') return '服务端没接摘要能力';
  if (error.code === 'SUMMARY_FAILED') {
    // 502 的 detail 是模型侧真实原因，带出来才好排查。
    const detail = error.payload['detail'];
    return typeof detail === 'string' && detail !== '' ? '补记失败：' + detail : '补记失败：服务端没有给出明细';
  }
  // 认不出的码（含 401 登录已失效、NETWORK_ERROR）原样用 request() 造好的中文 message。
  return error.message;
}

/** 补记的两条路由共用：错误按 §25.8 的错误码翻成中文，status 与 payload 原样保留。 */
async function requestBackfill<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await request<T>(method, path, body);
  } catch (error) {
    // 401 交给全局回登录页处理，不改写成普通 ApiError。
    if (error instanceof ApiError && !(error instanceof UnauthorizedError)) {
      throw new ApiError(error.status, error.payload, describeBackfillError(error));
    }
    throw error;
  }
}

/** §25.8：先算命中多少条、首尾长什么样，再决定补不补；坏形状按「0 条 / 超限 / 无样本」兜底。 */
export async function fetchBackfillRange(
  guildId: string,
  channelId: string,
  from: string,
  to: string,
): Promise<BackfillPreview> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  params.set('channelId', channelId.trim());
  params.set('from', from);
  params.set('to', to);
  const raw = await requestBackfill<unknown>('GET', '/api/summaries/range?' + params.toString());
  const source = toRecord(raw);
  const count = toCount(source.count);
  const samples: string[] = [];
  if (Array.isArray(source.samples)) {
    for (const entry of source.samples) {
      if (typeof entry === 'string' && entry !== '') samples.push(entry);
    }
  }
  const preview: BackfillPreview = {
    count,
    // 后端没表态时按上限判断：宁可多提示一次，也不让请求打过去才发现超了。
    tooLarge: typeof source.tooLarge === 'boolean' ? source.tooLarge : count > BACKFILL_RANGE_LIMIT,
    samples,
  };
  if (typeof source.firstAt === 'string' && source.firstAt !== '') preview.firstAt = source.firstAt;
  if (typeof source.lastAt === 'string' && source.lastAt !== '') preview.lastAt = source.lastAt;
  return preview;
}

/** §25.8：POST /api/summaries/backfill 把这段时间压成一段新记忆追加到末尾，自动总结进度不动。 */
export async function backfillSummaryRange(
  guildId: string,
  channelId: string,
  from: string,
  to: string,
): Promise<BackfillOutcome> {
  const result = await requestBackfill<{ outcome?: unknown }>('POST', '/api/summaries/backfill', {
    guildId: guildId.trim(),
    channelId: channelId.trim(),
    from,
    to,
  });
  const source = toRecord(result.outcome);
  // 字段缺失时按入参兜底：这一屏要回答的是「补了哪一段」，空着比错着更难查。
  return {
    summarizedMessages: toCount(source.summarizedMessages),
    from: typeof source.from === 'string' && source.from !== '' ? source.from : from,
    to: typeof source.to === 'string' && source.to !== '' ? source.to : to,
    summaryLength: toCount(source.summaryLength),
    model: typeof source.model === 'string' ? source.model : '',
  };
}

/**
 * §63 后台「连续总结」一批的结果：outcome 是本批做了什么（没有素材时是 null，页面据此停手），
 * remaining 是游标之后还剩多少条——页面只认它决定要不要接着发下一批。
 */
export interface SummarySweepResult {
  outcome: SummaryOutcome | null;
  remaining: number;
}

/**
 * §63：POST /api/summaries/sweep —— 一次一批（服务端硬上限 500 条）。
 * 409 NO_SUMMARY_MATERIAL 也会带 remaining，所以这里不抛错，把「没素材」当成一次正常回执。
 */
export async function summarizeSweep(guildId: string, channelId: string): Promise<SummarySweepResult> {
  let raw: unknown;
  try {
    raw = await request<unknown>('POST', '/api/summaries/sweep', {
      guildId: guildId.trim(),
      channelId: channelId.trim(),
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NO_SUMMARY_MATERIAL') {
      const remaining = typeof error.payload['remaining'] === 'number' ? error.payload['remaining'] : 0;
      return { outcome: null, remaining: Math.max(0, Math.floor(remaining)) };
    }
    if (error instanceof ApiError && !(error instanceof UnauthorizedError)) {
      const detail = error.payload['detail'];
      const message =
        error.code === 'SUMMARY_FAILED'
          ? '连续总结失败：' + (typeof detail === 'string' && detail !== '' ? detail : '服务端没有给出明细')
          : error.code === 'SUMMARY_UNAVAILABLE'
            ? '服务端没有接上摘要能力，暂时无法连续总结'
            : error.message;
      throw new ApiError(error.status, error.payload, message);
    }
    throw error;
  }
  const source = toRecord(raw);
  const remainingRaw = typeof source.remaining === 'number' ? source.remaining : 0;
  return {
    outcome: toSummaryOutcome(source.outcome),
    remaining: Math.max(0, Math.floor(remainingRaw)),
  };
}

export async function fetchLogs(after: number, limit: number): Promise<LogsResult> {
  const params = new URLSearchParams();
  params.set('after', String(after));
  params.set('limit', String(limit));
  const result = await request<{ items?: StoredLogEntry[]; latest?: number }>('GET', '/api/logs?' + params.toString());
  const items = result.items ?? [];
  const reported = result.latest;
  if (typeof reported === 'number' && Number.isFinite(reported)) return { items, latest: reported };
  return { items, latest: items.reduce((max, item) => (item.id > max ? item.id : max), after) };
}

/** §11 保存提示词时允许出现的占位符：服务端按同一份清单校验，多写一个就是 400。 */
export const TEMPLATE_VARS = ['{{bot_name}}', '{{user_name}}', '{{guild_name}}', '{{channel_name}}', '{{date}}'];

// §11 提示词接口的三个 400 码翻成中文再显示，不把码直接甩给用户。
function describePromptRejection(error: ApiError): string {
  if (error.code === 'BAD_SCOPE') {
    return '作用域不合法：scope 只能是 global / guild / channel，且 global 的 scopeId 必须是空串';
  }
  if (error.code === 'BAD_PROMPT_SEGMENTS') {
    return (
      '提示词分段不合法：至少要有一段，每段名称不能为空，角色只能是 system / user，' +
      '位置只能是 before / after，正文必须是文本'
    );
  }
  const vars = error.unknownVars;
  return (
    '模板中含不支持的变量：' +
    (vars.length === 0 ? '（服务端未返回变量名）' : vars.join('、')) +
    '。可用变量只有 ' +
    TEMPLATE_VARS.join(' ')
  );
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_SCOPE' || error.code === 'BAD_PROMPT_SEGMENTS' || error.code === 'UNKNOWN_TEMPLATE_VAR') {
      return describePromptRejection(error);
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '未知错误';
}

// 契约 sillytavern-import 的三个 400 码翻成中文再显示；认不出的码（含 401、NETWORK_ERROR）走 describeError。
export function describePromptImportError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_PRESET') {
      return '预设格式不对：这不是酒馆的提示词预设（认不出 prompts / prompt_order 这类结构），换个文件再试';
    }
    if (error.code === 'NO_SEGMENTS') {
      return '这份预设里没有可导入的文本段：剩下的全是占位标记或空段，导进来只会清空目标层，已拒绝';
    }
    if (error.code === 'UNKNOWN_TEMPLATE_VAR') {
      const vars = error.unknownVars;
      return (
        '预设里含不支持的占位符：' +
        (vars.length === 0 ? '（服务端未返回变量名）' : vars.join('、')) +
        '。可用变量只有 ' +
        TEMPLATE_VARS.join(' ')
      );
    }
  }
  return describeError(error);
}

// 契约 prompt-copy 的两个 400 码翻成中文再显示；其它错误（401 / NETWORK_ERROR 等）走 describeError。
// 既收 ApiError，也收调用方已经取出来的错误码字符串，字符串码走同一套文案。
export function describePromptCopyRejection(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : '';
  if (code === 'BAD_SCOPE') {
    return '作用域不合法：源 / 目标只能是 global / guild / channel，且 global 的 scopeId 必须是空串';
  }
  if (code === 'SAME_TARGET') {
    return '源作用域和目标作用域是同一条：同一层复制到同一层不会产生任何变化，换一个目标层再复制';
  }
  return describeError(error);
}

/** §20.7：逗号（含中文逗号）切分 → trim → 丢空串；去重与字符校验由后端 §20.6 负责。 */
export function parseModelPatterns(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

export function formatNumber(value?: number): string {
  return typeof value === 'number' ? String(value) : '';
}

export function normalizeScopeId(scope: Scope, raw: string): string {
  return scope === 'global' ? '' : raw.trim();
}

export function describeScopeTarget(scope: Scope, scopeId: string): string {
  return scope === 'global' ? 'global' : scope + ':' + scopeId;
}

// §26.2 频道级记忆配置：字段与后端 ChannelMemoryConfig 逐字对齐（web 侧本地定义，不跨 web 根 import）。
export interface ChannelMemoryConfig {
  guildId: string;
  channelId: string;
  /** 注入最近多少条原文，≥ 2，不设上限 */
  historyMaxMessages: number;
  /** 未总结消息攒到多少条触发自动总结；0 = 关闭，否则 ≥ 2，不设上限 */
  summaryEveryMessages: number;
  /** 记忆注入预算（字符）：非零 500..20000；0 = 未设置，运行时按 4000 */
  summaryMaxChars: number;
  /** 上下文工具模式（§55）：true = 预设/摘要/历史全塞进 context 工具、只发一条 user 轮次；缺省 = 关 */
  contextTool: boolean;
  /** 保存时刻（ISO）；空串 = 库里还没有这一行，回的是默认值 */
  updatedAt: string;
}

/** §26.2 服务端默认值：GET 没有行时回的就是这几个数字，字段真缺失时前端也回落到它们。 */
export const MEMORY_DEFAULTS: {
  historyMaxMessages: number;
  summaryEveryMessages: number;
  summaryMaxChars: number;
} = {
  historyMaxMessages: 50,
  summaryEveryMessages: 50,
  summaryMaxChars: 4000,
};

// 数字字段缺省时不能渲染成 undefined，按默认值兜底；0 是合法值（阈值 = 关闭自动总结）。
function toMemoryNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

function toChannelMemoryConfig(raw: unknown): ChannelMemoryConfig | null {
  const source = toRecord(raw);
  const guildId = typeof source.guildId === 'string' ? source.guildId.trim() : '';
  const channelId = typeof source.channelId === 'string' ? source.channelId.trim() : '';
  // key 缺一个就没法定位到哪个频道，这条直接丢弃。
  if (guildId === '' || channelId === '') return null;
  return {
    guildId,
    channelId,
    historyMaxMessages: toMemoryNumber(source.historyMaxMessages, MEMORY_DEFAULTS.historyMaxMessages),
    summaryEveryMessages: toMemoryNumber(source.summaryEveryMessages, MEMORY_DEFAULTS.summaryEveryMessages),
    summaryMaxChars: toMemoryNumber(source.summaryMaxChars, MEMORY_DEFAULTS.summaryMaxChars),
    // 老后端不回这个字段、或回了非 boolean：一律当关，页面不必处理 undefined
    contextTool: source.contextTool === true,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** §26.4：GET /api/memory-settings 回 { items }，只含已保存的行；坏条目丢弃，列表里不出现空 key。 */
export async function fetchMemorySettings(): Promise<ChannelMemoryConfig[]> {
  const result = await request<{ items?: unknown[] }>('GET', '/api/memory-settings');
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: ChannelMemoryConfig[] = [];
  for (const entry of raw) {
    const item = toChannelMemoryConfig(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/** §26.4：GET /api/memory-settings/channel 回 { config }；没有行时 updatedAt 为空串，数字是服务端默认值。 */
export async function fetchChannelMemory(guildId: string, channelId: string): Promise<ChannelMemoryConfig> {
  const guild = guildId.trim();
  const channel = channelId.trim();
  const params = new URLSearchParams();
  params.set('guildId', guild);
  params.set('channelId', channel);
  const result = await request<{ config?: unknown }>('GET', '/api/memory-settings/channel?' + params.toString());
  const config = toChannelMemoryConfig(result.config);
  // 后端回的形状坏掉时按入参 + 默认值拼一条，调用方不必处理 null。
  if (config === null) {
    return {
      guildId: guild,
      channelId: channel,
      historyMaxMessages: MEMORY_DEFAULTS.historyMaxMessages,
      summaryEveryMessages: MEMORY_DEFAULTS.summaryEveryMessages,
      summaryMaxChars: MEMORY_DEFAULTS.summaryMaxChars,
      contextTool: false,
      updatedAt: '',
    };
  }
  return config;
}

/** §26.4：PUT /api/memory-settings 回保存后的整行；updatedAt 由服务端取，客户端不传时间。 */
export async function saveChannelMemory(input: {
  guildId: string;
  channelId: string;
  historyMaxMessages: number;
  summaryEveryMessages: number;
  /** 记忆注入预算（字符）；0 = 按「未设置」提交，运行时用服务端默认 4000 */
  summaryMaxChars?: number;
  /** 上下文工具模式（§55）；缺省 = 关，与后端「不传即关」同一口径 */
  contextTool?: boolean;
}): Promise<ChannelMemoryConfig> {
  const guildId = input.guildId.trim();
  const channelId = input.channelId.trim();
  const summaryMaxChars = input.summaryMaxChars ?? 0;
  const contextTool = input.contextTool === true;
  const saved = await request<unknown>('PUT', '/api/memory-settings', {
    guildId,
    channelId,
    historyMaxMessages: input.historyMaxMessages,
    summaryEveryMessages: input.summaryEveryMessages,
    summaryMaxChars,
    contextTool,
  });
  // 后端回的是保存后的本体；万一字段缺失按入参兜底，调用方不必处理 null。
  return (
    toChannelMemoryConfig(saved) ?? {
      guildId,
      channelId,
      historyMaxMessages: input.historyMaxMessages,
      summaryEveryMessages: input.summaryEveryMessages,
      summaryMaxChars,
      contextTool,
      updatedAt: '',
    }
  );
}

/** §26.4：DELETE /api/memory-settings?guildId=&channelId=，本来没有这一行也回 200。 */
export function deleteChannelMemory(guildId: string, channelId: string): Promise<{ ok: boolean }> {
  const params = new URLSearchParams();
  params.set('guildId', guildId.trim());
  params.set('channelId', channelId.trim());
  return request<{ ok: boolean }>('DELETE', '/api/memory-settings?' + params.toString());
}

// 门牌 reaction-guide-1 贴表情提示词：global / guild / channel 三层整组覆盖，某层没有配置就落回上一层。
export interface ReactionGuideItem {
  scope: Scope;
  scopeId: string;
  prompt: string;
  updatedAt: string;
}

/** GET /api/reaction-guides 的形状：default 是三层都没有配置时的内置文案（只读，当 placeholder 用）。 */
export interface ReactionGuidesPayload {
  items: ReactionGuideItem[];
  default: string;
}

/** 契约 BAD_REACTION_GUIDE 的长度上限：prompt trim 后不能为空，也不能超过它。 */
export const REACTION_GUIDE_MAX_CHARS = 8000;

function toReactionGuideItem(raw: unknown): ReactionGuideItem | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  // scope 缺了就没法定位到哪一层，这条直接丢弃。
  if (scope === null) return null;
  // prompt 就是这一层的全部内容，不是字符串说明这条写坏了，丢弃。
  if (typeof source.prompt !== 'string') return null;
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    prompt: source.prompt,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** 契约 reaction-guide-1：GET /api/reaction-guides 回 { items, default }；坏条目丢弃，列表里不出现空 key。 */
export async function fetchReactionGuides(): Promise<ReactionGuidesPayload> {
  const result = await request<{ items?: unknown[]; default?: unknown }>('GET', '/api/reaction-guides');
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: ReactionGuideItem[] = [];
  for (const entry of raw) {
    const item = toReactionGuideItem(entry);
    if (item !== null) items.push(item);
  }
  return { items, default: typeof result.default === 'string' ? result.default : '' };
}

/** 契约 reaction-guide-1：PUT /api/reaction-guides 覆盖写这一层，回写后的对象（400 见 describeGuideRejection）。 */
export async function saveReactionGuide(input: {
  scope: Scope;
  scopeId?: string;
  prompt: string;
}): Promise<ReactionGuideItem> {
  const scopeId = normalizeScopeId(input.scope, input.scopeId ?? '');
  const saved = await request<unknown>('PUT', '/api/reaction-guides', {
    scope: input.scope,
    scopeId,
    // 正文里的换行原样上送，trim 只发生在后端的长度校验里。
    prompt: input.prompt,
  });
  // 后端回的是写后的本体；万一字段缺失按入参兜底，调用方不必处理 null。
  return toReactionGuideItem(saved) ?? { scope: input.scope, scopeId, prompt: input.prompt, updatedAt: '' };
}

/** 契约 reaction-guide-1：DELETE /api/reaction-guides 删掉这一层的配置 = 落回上一层；本来没有也回 200。 */
export function deleteReactionGuide(key: { scope: Scope; scopeId: string }): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('DELETE', '/api/reaction-guides', {
    scope: key.scope,
    scopeId: normalizeScopeId(key.scope, key.scopeId),
  });
}

// 契约 reaction-guide-1 的三个 400 码翻成中文再显示，不把码直接甩给用户；401 走 describeError 的中文提示。
export function describeGuideRejection(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_SCOPE') return '作用域不合法：scope 只能是 global / guild / channel';
    if (error.code === 'BAD_REQUEST') return 'guild / channel 层要填服务器或频道 ID';
    if (error.code === 'BAD_REACTION_GUIDE') {
      return '提示词不合法：trim 后不能为空，也不能超过 ' + String(REACTION_GUIDE_MAX_CHARS) + ' 字符';
    }
    // 401 的 message 本身就是中文（登录已失效），不再加前缀。
    if (error.status === 401) return describeError(error);
  }
  return '保存提示词失败：' + describeError(error);
}

// 门牌 reaction-template-1 表情素材模板：和贴表情提示词同一套三层模型，正文里插占位符，
// 运行时把出现的占位符整段展开，没出现的占位符那一段就不出现。
export interface ReactionTemplateItem {
  scope: Scope;
  scopeId: string;
  template: string;
  updatedAt: string;
}

/** GET /api/reaction-templates 的形状：default 是三层都没配置时的内置模板，vars 是合法占位符清单。 */
export interface ReactionTemplatesPayload {
  items: ReactionTemplateItem[];
  default: string;
  vars: string[];
}

/** 契约 BAD_REACTION_TEMPLATE 的上限：template trim 后不能为空，不能超过它，且至少要有一个已知占位符。 */
export const REACTION_TEMPLATE_MAX_CHARS = 8000;

/**
 * 契约里的 6 个合法占位符，名字不带花括号（与服务端 GET 的 vars、UNKNOWN_TEMPLATE_VAR 的 vars 同一套写法）；
 * 显示或写进模板时用 describeTemplateVar 补上 {{ }}。
 */
export const REACTION_TEMPLATE_VARS = ['最近对话', '对方的消息', '我的回复', '自定义表情', '可贴表情的消息', '表情规则'];

/** 抽占位符的形状与后端校验一致：花括号里 1–40 个不含花括号的字符。 */
const TEMPLATE_VAR_PATTERN = /\{\{([^{}]{1,40})\}\}/g;

/** 变量名 → 模板里的写法：占位符说明与报错都显示 {{名字}}，跟正文对齐。 */
export function describeTemplateVar(name: string): string {
  return '{{' + name + '}}';
}

/** 抽出一段正文里出现的全部占位符名（去重、保持出现顺序），用来本地拦截未知占位符。 */
export function listTemplateVars(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  // matchAll 内部复制了一份正则，模块级这个 /g 不会留下 lastIndex 脏状态。
  for (const match of template.matchAll(new RegExp(TEMPLATE_VAR_PATTERN.source, 'g'))) {
    const name = match[1] ?? '';
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 服务端回的 vars 是不带花括号的名字；哪天带上 {{ }} 也照收，免得整张卡片的校验凭空失效。 */
function toTemplateVarName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('{{') && trimmed.endsWith('}}') ? trimmed.slice(2, -2).trim() : trimmed;
}

function toReactionTemplateItem(raw: unknown): ReactionTemplateItem | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  // scope 缺了就没法定位到哪一层，这条直接丢弃。
  if (scope === null) return null;
  // template 就是这一层的全部内容，不是字符串说明这条写坏了，丢弃。
  if (typeof source.template !== 'string') return null;
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    template: source.template,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** 契约 reaction-template-1：GET /api/reaction-templates 回 { items, default, vars }；坏条目丢弃，列表里不出现空 key。 */
export async function fetchReactionTemplates(): Promise<ReactionTemplatesPayload> {
  const result = await request<{ items?: unknown[]; default?: unknown; vars?: unknown }>(
    'GET',
    '/api/reaction-templates',
  );
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: ReactionTemplateItem[] = [];
  for (const entry of raw) {
    const item = toReactionTemplateItem(entry);
    if (item !== null) items.push(item);
  }
  const vars = Array.isArray(result.vars)
    ? result.vars
        .filter((item): item is string => typeof item === 'string')
        .map(toTemplateVarName)
        .filter((name) => name !== '')
    : [];
  return {
    items,
    default: typeof result.default === 'string' ? result.default : '',
    // 服务端没给清单时落回契约里的 6 个，页面不至于一个占位符都列不出来。
    vars: vars.length === 0 ? REACTION_TEMPLATE_VARS : vars,
  };
}

/** 契约 reaction-template-1：PUT /api/reaction-templates 覆盖写这一层，回写后的对象（400 见 describeTemplateRejection）。 */
export async function saveReactionTemplate(input: {
  scope: Scope;
  scopeId?: string;
  template: string;
}): Promise<ReactionTemplateItem> {
  const scopeId = normalizeScopeId(input.scope, input.scopeId ?? '');
  const saved = await request<unknown>('PUT', '/api/reaction-templates', {
    scope: input.scope,
    scopeId,
    // 正文里的换行原样上送，trim 只发生在后端的长度校验里。
    template: input.template,
  });
  // 后端回的是写后的本体；万一字段缺失按入参兜底，调用方不必处理 null。
  return toReactionTemplateItem(saved) ?? { scope: input.scope, scopeId, template: input.template, updatedAt: '' };
}

/** 契约 reaction-template-1：DELETE /api/reaction-templates 删掉这一层的配置 = 落回上一层；本来没有也回 200。 */
export function deleteReactionTemplate(key: { scope: Scope; scopeId: string }): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('DELETE', '/api/reaction-templates', {
    scope: key.scope,
    scopeId: normalizeScopeId(key.scope, key.scopeId),
  });
}

// 契约 reaction-template-1 的四个 400 码翻成中文再显示，不把码直接甩给用户；401 走 describeError 的中文提示。
export function describeTemplateRejection(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_SCOPE') return '作用域不合法：scope 只能是 global / guild / channel';
    if (error.code === 'BAD_REQUEST') return 'guild / channel 层要填服务器或频道 ID';
    if (error.code === 'BAD_REACTION_TEMPLATE') {
      return (
        '模板不合法：trim 后不能为空，不能超过 ' +
        String(REACTION_TEMPLATE_MAX_CHARS) +
        ' 字符，并且至少要留一个占位符'
      );
    }
    if (error.code === 'UNKNOWN_TEMPLATE_VAR') {
      const vars = error.unknownVars.map(toTemplateVarName);
      return (
        '模板里有不支持的占位符：' +
        (vars.length === 0 ? '（服务端未返回占位符名）' : vars.map(describeTemplateVar).join('、')) +
        '。可用的占位符只有 ' +
        REACTION_TEMPLATE_VARS.map(describeTemplateVar).join(' ')
      );
    }
    // 401 的 message 本身就是中文（登录已失效），不再加前缀。
    if (error.status === 401) return describeError(error);
  }
  return '保存表情素材模板失败：' + describeError(error);
}

// 门牌 prompt-copy-1 正文表情：和贴表情提示词同一套三层整组覆盖，这一段决定正文里夹不夹 :名字:。
export interface BodyEmojiGuideItem {
  scope: Scope;
  scopeId: string;
  prompt: string;
  updatedAt: string;
}

/** GET /api/body-emoji-guides 的形状：default 固定空串（没配 = 关），suggestion 是后端给的推荐文案。 */
export interface BodyEmojiGuidesPayload {
  items: BodyEmojiGuideItem[];
  default: string;
  suggestion: string;
}

/** 契约 BAD_BODY_EMOJI_GUIDE 的长度上限：prompt trim 后不能为空，也不能超过它。 */
export const BODY_EMOJI_GUIDE_MAX_CHARS = 8000;

function toBodyEmojiGuideItem(raw: unknown): BodyEmojiGuideItem | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  // scope 缺了就没法定位到哪一层，这条直接丢弃。
  if (scope === null) return null;
  // prompt 就是这一层的全部内容，不是字符串说明这条写坏了，丢弃。
  if (typeof source.prompt !== 'string') return null;
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    prompt: source.prompt,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** 契约 prompt-copy-1：GET /api/body-emoji-guides 回 { items, default, suggestion }；坏条目丢弃，列表里不出现空 key。 */
export async function fetchBodyEmojiGuides(): Promise<BodyEmojiGuidesPayload> {
  const result = await request<{ items?: unknown[]; default?: unknown; suggestion?: unknown }>(
    'GET',
    '/api/body-emoji-guides',
  );
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: BodyEmojiGuideItem[] = [];
  for (const entry of raw) {
    const item = toBodyEmojiGuideItem(entry);
    if (item !== null) items.push(item);
  }
  return {
    items,
    default: typeof result.default === 'string' ? result.default : '',
    // 推荐文案缺失按空串兜底：按钮据此禁用，页面不自己编一段。
    suggestion: typeof result.suggestion === 'string' ? result.suggestion : '',
  };
}

/** 契约 prompt-copy-1：PUT /api/body-emoji-guides 覆盖写这一层，回写后的对象（400 见 describeBodyEmojiRejection）。 */
export async function saveBodyEmojiGuide(input: {
  scope: Scope;
  scopeId?: string;
  prompt: string;
}): Promise<BodyEmojiGuideItem> {
  const scopeId = normalizeScopeId(input.scope, input.scopeId ?? '');
  const saved = await request<unknown>('PUT', '/api/body-emoji-guides', {
    scope: input.scope,
    scopeId,
    // 正文里的换行原样上送，trim 只发生在后端的长度校验里。
    prompt: input.prompt,
  });
  // 后端回的是写后的本体；万一字段缺失按入参兜底，调用方不必处理 null。
  return toBodyEmojiGuideItem(saved) ?? { scope: input.scope, scopeId, prompt: input.prompt, updatedAt: '' };
}

/** 契约 prompt-copy-1：DELETE /api/body-emoji-guides 删掉这一层的配置 = 落回上一层；本来没有也回 200。 */
export function deleteBodyEmojiGuide(key: { scope: Scope; scopeId: string }): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('DELETE', '/api/body-emoji-guides', {
    scope: key.scope,
    scopeId: normalizeScopeId(key.scope, key.scopeId),
  });
}

// 契约 prompt-copy-1 的三个 400 码翻成中文再显示，不把码直接甩给用户；401 走 describeError 的中文提示。
export function describeBodyEmojiRejection(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_SCOPE') return '作用域不合法：scope 只能是 global / guild / channel';
    if (error.code === 'BAD_REQUEST') return 'guild / channel 层要填服务器或频道 ID';
    // 契约同形是 BAD_BODY_EMOJI_GUIDE；少一个后缀的那种写法一并认，免得只显示原始码。
    if (error.code === 'BAD_BODY_EMOJI_GUIDE' || error.code === 'BAD_BODY_EMOJI') {
      return '提示词不合法：trim 后不能为空，也不能超过 ' + String(BODY_EMOJI_GUIDE_MAX_CHARS) + ' 字符';
    }
    // 401 的 message 本身就是中文（登录已失效），不再加前缀。
    if (error.status === 401) return describeError(error);
  }
  return '保存正文表情提示词失败：' + describeError(error);
}

// 门牌 backup-ui-1：备份是宿主上的 systemd 任务，后台只读写两个 JSON 文件，不直接执行备份。
/** 契约 backup-ui-1：running 是开始阶段，done / failed 是结束阶段。 */
export type BackupPhase = 'running' | 'done' | 'failed';

/** 宿主写的 backup-status.json：结束阶段才有 finishedAt 及之后的字段，缺省就整键省略。 */
export interface BackupStatus {
  phase: BackupPhase;
  id: string;
  source: 'manual' | 'daily';
  startedAt: string;
  finishedAt?: string;
  file?: string;
  bytes?: number;
  keptRemote?: number;
  remote?: string;
  error?: string;
}

/** 后台写的 backup-request.json：宿主每 1 分钟检查一次，之后才真正开始执行。 */
export interface BackupRequest {
  id: string;
  requestedAt: string;
}

export interface BackupSnapshot {
  request: BackupRequest | null;
  status: BackupStatus | null;
}

const BACKUP_PHASES: BackupPhase[] = ['running', 'done', 'failed'];

function toBackupPhase(raw: unknown): BackupPhase | null {
  for (const phase of BACKUP_PHASES) {
    if (phase === raw) return phase;
  }
  return null;
}

function toNonEmptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

function toFiniteNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

// 坏形状一律当成 null：文件缺失、半截写入、字段被换成别的类型，都只让这一屏少一块，不能把页面搞崩。
function toBackupRequest(raw: unknown): BackupRequest | null {
  const source = toRecord(raw);
  const id = toNonEmptyString(source.id);
  const requestedAt = toNonEmptyString(source.requestedAt);
  return id === null || requestedAt === null ? null : { id, requestedAt };
}

function toBackupStatus(raw: unknown): BackupStatus | null {
  const source = toRecord(raw);
  const phase = toBackupPhase(source.phase);
  const startedAt = toNonEmptyString(source.startedAt);
  // 认不出 phase 或起始时间缺失，这份记录既推导不出徽标也说不清时间，整份丢。
  if (phase === null || startedAt === null) return null;
  const sourceKind = source.source === 'manual' || source.source === 'daily' ? source.source : null;
  if (sourceKind === null) return null;
  // running 阶段的 id 允许是空串（宿主还没领到请求），字段缺失也按空串算：这一屏不展示它。
  const status: BackupStatus = {
    phase,
    id: typeof source.id === 'string' ? source.id : '',
    source: sourceKind,
    startedAt,
  };
  const finishedAt = toNonEmptyString(source.finishedAt);
  if (finishedAt !== null) status.finishedAt = finishedAt;
  const file = toNonEmptyString(source.file);
  if (file !== null) status.file = file;
  const bytes = toFiniteNumber(source.bytes);
  if (bytes !== undefined) status.bytes = bytes;
  const keptRemote = toFiniteNumber(source.keptRemote);
  if (keptRemote !== undefined) status.keptRemote = keptRemote;
  const remote = toNonEmptyString(source.remote);
  if (remote !== null) status.remote = remote;
  const backupError = toNonEmptyString(source.error);
  if (backupError !== null) status.error = backupError;
  return status;
}

/** 契约 backup-ui-1：两个文件缺失或坏形状时字段都是 null，绝不抛错，页面照常渲染。 */
export async function fetchBackup(): Promise<BackupSnapshot> {
  const raw = await request<unknown>('GET', '/api/backup');
  const source = toRecord(raw);
  return { request: toBackupRequest(source.request), status: toBackupStatus(source.status) };
}

/** 契约 backup-ui-1：POST /api/backup/run 只写请求文件，宿主最迟 1 分钟后才真正开跑。 */
export async function runBackupNow(): Promise<BackupRequest> {
  const result = await request<{ request?: unknown }>('POST', '/api/backup/run');
  const created = toBackupRequest(result.request);
  // 200 却没回可用的请求编号时按失败处理：页面拿它当轮询开关，静默当成功会一直空转。
  if (created === null) throw new ApiError(200, { error: 'BACKUP_REQUEST_MISSING' }, '服务端没有返回备份请求编号');
  return created;
}

// 契约 backup-ui-1 的两个错误码翻成中文再显示，不把码直接甩给用户；401 走 describeError 的中文提示。
export function describeBackupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BACKUP_BUSY') return '已经有一个备份请求在排队，请等它跑完';
    if (error.code === 'BACKUP_UNAVAILABLE') return '当前部署不支持手动备份';
    if (error.status === 401) return describeError(error);
  }
  return '备份操作失败：' + describeError(error);
}

// 门牌 fake-stream-2 假流式切片次数：三层配置（channel > guild > global），0 = 关闭。
// scope 直接复用既有的 Scope（本来就是 'global' | 'guild' | 'channel'）；scopeId 与其它三层配置同一套规矩：
// global 固定空串，guild / channel 是 Discord ID。
export interface RevealStepsRow {
  scope: Scope;
  scopeId: string;
  revealSteps: number;
  updatedAt: string;
}

/** GET /api/reply-settings：items 只含已配置的层，三层都没配时才用 default / min / max。 */
export interface ReplySettingsSnapshot {
  items: RevealStepsRow[];
  default: number;
  min: number;
  max: number;
}

// 契约写死的缺省值与取值范围；接口回坏形状时按它兜底，页面才拿不到 NaN 的输入框上下限。
const REVEAL_STEPS_DEFAULT = 6;
const REVEAL_STEPS_MIN = 0;
const REVEAL_STEPS_MAX = 10;

function toIntegerOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && Number.isInteger(raw) ? raw : null;
}

// scope 与 revealSteps 是定位这一行的全部信息，缺一个就丢弃这条：列表里不该出现
// 「未知层 / NaN 次」这种既定位不了又没法操作的行。0–10 之外的值交给后端 BAD_REVEAL_STEPS 判。
function toRevealStepsRow(raw: unknown): RevealStepsRow | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  if (scope === null) return null;
  const revealSteps = toIntegerOrNull(source.revealSteps);
  if (revealSteps === null) return null;
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    revealSteps,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** GET /api/reply-settings；坏形状按「空列表 + 6 / 0 / 10」兜底，页面照常渲染。 */
export async function fetchReplySettings(): Promise<ReplySettingsSnapshot> {
  const raw = await request<unknown>('GET', '/api/reply-settings');
  const source = toRecord(raw);
  const items: RevealStepsRow[] = [];
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const row = toRevealStepsRow(entry);
      if (row !== null) items.push(row);
    }
  }
  return {
    items,
    default: toFiniteNumber(source.default) ?? REVEAL_STEPS_DEFAULT,
    min: toFiniteNumber(source.min) ?? REVEAL_STEPS_MIN,
    max: toFiniteNumber(source.max) ?? REVEAL_STEPS_MAX,
  };
}

// global 的定位键只有 scope 本身：契约这一层不带 scopeId，多送一个空串可能被判成坏 body。
function replySettingsKey(scope: Scope, scopeId?: string): { scope: Scope; scopeId?: string } {
  const normalized = normalizeScopeId(scope, typeof scopeId === 'string' ? scopeId : '');
  return normalized === '' ? { scope } : { scope, scopeId: normalized };
}

/** PUT /api/reply-settings：写某一层的切片次数，回保存后的这一行。 */
export async function saveReplySettings(input: {
  scope: Scope;
  scopeId?: string;
  revealSteps: number;
}): Promise<RevealStepsRow> {
  const key = replySettingsKey(input.scope, input.scopeId);
  const raw = await request<unknown>('PUT', '/api/reply-settings', { ...key, revealSteps: input.revealSteps });
  // 后端回的是保存后的本体；万一字段缺失就按入参兜底，调用方不必处理 null。
  return (
    toRevealStepsRow(raw) ?? {
      scope: key.scope,
      scopeId: normalizeScopeId(key.scope, input.scopeId ?? ''),
      revealSteps: input.revealSteps,
      updatedAt: '',
    }
  );
}

/** DELETE /api/reply-settings：删掉这一层 = 恢复上层，本来没配也回 200。 */
export async function clearReplySettings(input: { scope: Scope; scopeId?: string }): Promise<void> {
  await request<{ ok?: boolean }>('DELETE', '/api/reply-settings', replySettingsKey(input.scope, input.scopeId));
}

// 契约这两条路由只回错误码，翻成中文再显示，不把码直接甩给用户；
// 认不出的码（含 401 登录已失效、NETWORK_ERROR）走 describeError 已有的中文 message。
export function describeReplySettingsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_SCOPE') return '作用域不合法：只能是全局 / 服务器 / 频道';
    if (error.code === 'BAD_REVEAL_STEPS') {
      return (
        '切片次数不合法：请填 ' +
        String(REVEAL_STEPS_MIN) +
        '–' +
        String(REVEAL_STEPS_MAX) +
        ' 的整数（0 = 关闭）'
      );
    }
  }
  return describeError(error);
}

// 门牌 vision-2 识图（主模型看图）：三层配置（channel > guild > global），默认开。
// scope 同样复用 Scope；scopeId 规矩与其它三层配置一致：global 固定空串，guild / channel 是 Discord ID。
export interface VisionSettingsRow {
  scope: Scope;
  scopeId: string;
  enabled: boolean;
  updatedAt: string;
}

/** GET /api/vision-settings：items 只含已配置的层，三层都没配时才用 default（= 开）。 */
export interface VisionSettingsSnapshot {
  items: VisionSettingsRow[];
  default: boolean;
}

// 契约写死的缺省值：三层都没配 = 开。关掉只影响主对话模型，表情模型照旧能看图。
export const VISION_ENABLED_DEFAULT = true;

// scope 与 enabled 是定位并操作这一行的全部信息：未知层定位不了，非布尔的开关页面也画不出来，
// 所以各丢这一条，其余行照常显示，别整份报错。
function toVisionSettingsRow(raw: unknown): VisionSettingsRow | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  if (scope === null) return null;
  if (typeof source.enabled !== 'boolean') return null;
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    enabled: source.enabled,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** GET /api/vision-settings；坏形状按「空列表 + 开」兜底，页面照常渲染。 */
export async function fetchVisionSettings(): Promise<VisionSettingsSnapshot> {
  const raw = await request<unknown>('GET', '/api/vision-settings');
  const source = toRecord(raw);
  const items: VisionSettingsRow[] = [];
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const row = toVisionSettingsRow(entry);
      if (row !== null) items.push(row);
    }
  }
  return {
    items,
    default: typeof source.default === 'boolean' ? source.default : VISION_ENABLED_DEFAULT,
  };
}

// global 的定位键只有 scope 本身：契约这一层不带 scopeId，多送一个空串可能被判成坏 body。
function visionSettingsKey(scope: Scope, scopeId?: string): { scope: Scope; scopeId?: string } {
  const normalized = normalizeScopeId(scope, typeof scopeId === 'string' ? scopeId : '');
  return normalized === '' ? { scope } : { scope, scopeId: normalized };
}

/** PUT /api/vision-settings：写某一层的开关，回保存后的这一行。 */
export async function saveVisionSetting(input: {
  scope: Scope;
  scopeId?: string;
  enabled: boolean;
}): Promise<VisionSettingsRow> {
  const key = visionSettingsKey(input.scope, input.scopeId);
  const raw = await request<unknown>('PUT', '/api/vision-settings', { ...key, enabled: input.enabled });
  // 后端回的是保存后的本体；万一字段缺失就按入参兜底，调用方不必处理 null。
  return (
    toVisionSettingsRow(raw) ?? {
      scope: key.scope,
      scopeId: normalizeScopeId(key.scope, input.scopeId ?? ''),
      enabled: input.enabled,
      updatedAt: '',
    }
  );
}

/** DELETE /api/vision-settings：删掉这一层 = 恢复上层，本来没配也回 200。 */
export async function clearVisionSetting(input: { scope: Scope; scopeId?: string }): Promise<void> {
  await request<{ ok?: boolean }>('DELETE', '/api/vision-settings', visionSettingsKey(input.scope, input.scopeId));
}

// 契约这两条路由只回错误码，翻成中文再显示，不把码直接甩给用户；
// 认不出的码（含 401 登录已失效、NETWORK_ERROR）走 describeError 已有的中文 message。
export function describeVisionSettingsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_ENABLED') return '开关值不合法：只能是开 / 关';
    if (error.code === 'BAD_SCOPE') return '作用域不合法：只能是全局 / 服务器 / 频道';
    if (error.code === 'BAD_REQUEST') return '请求体不合法：可能缺了 scope / scopeId，或字段类型不对';
  }
  return describeError(error);
}

// 门牌 pg-errors-1 故障页：PG 中继最近 200 条报错的只读快照。
// at / status / code / message 是每行的定位信息；model / key / durationMs / requestId 中继不一定给。
export interface PgErrorEntry {
  at: string;
  status: number;
  code: string;
  message: string;
  model?: string;
  key?: string;
  durationMs?: number;
  requestId?: string;
}

/** GET /api/pg-errors 的形状：items 新→旧，dropped 是中继累计被挤掉的条数。 */
export interface PgErrorFeed {
  limit: number;
  dropped: number;
  items: PgErrorEntry[];
}

// 契约写死的上限：缺省 200，超过 200 也只给 200。
export const PG_ERRORS_LIMIT = 200;

// 契约：缺省 200、上限 200、下限 1，越界夹紧不报错。前端先夹一层，别把坏参数发出去。
function clampPgErrorsLimit(raw: number): number {
  if (!Number.isFinite(raw)) return PG_ERRORS_LIMIT;
  const value = Math.trunc(raw);
  if (value < 1) return 1;
  return value > PG_ERRORS_LIMIT ? PG_ERRORS_LIMIT : value;
}

// at / code 缺了这一行就说不出「什么时候、为什么」，这条丢掉；其余字段缺了按可选处理，整表照常显示。
function toPgErrorEntry(raw: unknown): PgErrorEntry | null {
  const source = toRecord(raw);
  const at = typeof source.at === 'string' ? source.at : '';
  const code = typeof source.code === 'string' ? source.code : '';
  if (at === '' || code === '') return null;
  const status = toFiniteNumber(source.status);
  const durationMs = toFiniteNumber(source.durationMs);
  const entry: PgErrorEntry = {
    at,
    status: status === undefined ? 0 : status,
    code,
    message: typeof source.message === 'string' ? source.message : '',
  };
  const model = toNonEmptyString(source.model);
  if (model !== null) entry.model = model;
  const key = toNonEmptyString(source.key);
  if (key !== null) entry.key = key;
  if (durationMs !== undefined && durationMs >= 0) entry.durationMs = durationMs;
  const requestId = toNonEmptyString(source.requestId);
  if (requestId !== null) entry.requestId = requestId;
  return entry;
}

/** GET /api/pg-errors?limit=N：中继没配回 501、取不到回 502，两者都由 describePgErrorsError 翻成中文。 */
export async function fetchPgErrors(limit: number = PG_ERRORS_LIMIT): Promise<PgErrorFeed> {
  const params = new URLSearchParams();
  params.set('limit', String(clampPgErrorsLimit(limit)));
  const raw = await request<unknown>('GET', '/api/pg-errors?' + params.toString());
  const source = toRecord(raw);
  const wanted = clampPgErrorsLimit(limit);
  const reportedLimit = toFiniteNumber(source.limit);
  const dropped = toFiniteNumber(source.dropped);
  const items: PgErrorEntry[] = [];
  // 后端已把坏形状包成 502；走到这里 items 不是数组只说明字段缺了，按空列表兜底，页面照常渲染。
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const item = toPgErrorEntry(entry);
      if (item !== null) items.push(item);
    }
  }
  return {
    limit: reportedLimit === undefined ? wanted : clampPgErrorsLimit(reportedLimit),
    dropped: dropped === undefined || dropped < 0 ? 0 : Math.trunc(dropped),
    items,
  };
}

// 契约这两条路由只回错误码，翻成中文再显示，不把码直接甩给用户；
// 认不出的码（含 401 登录已失效、NETWORK_ERROR）走 describeError 已有的中文 message。
export function describePgErrorsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PG_ERRORS_UNAVAILABLE' || error.status === 501) {
      return '未配置 PG 中继：后台缺环境变量 PG_ERRORS_URL / PG_ERRORS_TOKEN，这一页暂时没有数据源';
    }
    if (error.code === 'PG_ERRORS_UPSTREAM' || error.status === 502) {
      const detail = error.payload.detail;
      const text = typeof detail === 'string' ? detail.trim() : '';
      return text === '' ? '中继暂时取不到报错，请稍后重试' : '中继暂时取不到报错：' + text;
    }
  }
  return describeError(error);
}

// 门牌 voice-1 语音回复：三层配置（channel > guild > global），默认 0（关闭）。
// 0 关闭 / 1 回复里出现 [[voice]] 才发 / 2 每条回复都发；语音是整段回复合成后作为单独一条 mp3 附件发出去。
export const VOICE_MODE_IDS: number[] = [0, 1, 2];
// 门牌 prompt-copy-1 导演模式：念稿时能改多远，0 关闭（逐字朗读）/ 1 只插标签 / 2 允许顺句改写。
// 它和 mode / voice / speed 一样存在每一层的整行里，没有 PATCH，保存就是整行 PUT。
export const VOICE_DIRECTOR_IDS: number[] = [0, 1, 2];
// 契约写死的语速范围（%）：越界由后端拒（BAD_VOICE_SPEED），前端先拦一层少一次往返。
export const VOICE_SPEED_DEFAULT = 100;
export const VOICE_SPEED_MIN = 50;
export const VOICE_SPEED_MAX = 200;
// 服务器 .env 里的默认音色不在这一份里：音色留空 = 用服务器的默认值，这几个只是给输入框的建议。
export const VOICE_SUGGESTIONS: string[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

export interface VoiceSettingsRow {
  scope: Scope;
  scopeId: string;
  mode: number;
  director: number;
  voice: string;
  speed: number;
  updatedAt: string;
}

/** GET /api/voice-settings 的 default：三层都没配时用这三个值。 */
export interface VoiceSettingsDefault {
  mode: number;
  director: number;
  voice: string;
  speed: number;
}

/** GET /api/voice-settings：items 只含已配置的层；modes / speedMin / speedMax 决定页面画哪些选项。 */
export interface VoiceSettingsSnapshot {
  items: VoiceSettingsRow[];
  default: VoiceSettingsDefault;
  modes: number[];
  directorModes: number[];
  speedMin: number;
  speedMax: number;
}

export const VOICE_SETTINGS_DEFAULT: VoiceSettingsDefault = {
  mode: 0,
  director: 0,
  voice: '',
  speed: VOICE_SPEED_DEFAULT,
};

// 画不出单选的档位（未知值、小数）这一行就说不清「什么时候发」，丢掉这一条，其余行照常显示。
function toVoiceMode(raw: unknown): number | null {
  const value = toFiniteNumber(raw);
  if (value === undefined) return null;
  return Number.isInteger(value) && VOICE_MODE_IDS.includes(value) ? value : null;
}

// 导演模式认不出的值（缺列的老数据、脏值）按「关闭」兜底，不能因为一列坏值把整行丢掉。
function toVoiceDirector(raw: unknown): number | null {
  const value = toFiniteNumber(raw);
  if (value === undefined) return null;
  return Number.isInteger(value) && VOICE_DIRECTOR_IDS.includes(value) ? value : null;
}

// 语速只认不小于 0 的整数；上下限以接口回来的 speedMin / speedMax 为准，别在客户端写死范围。
function toVoiceSpeed(raw: unknown): number | null {
  const value = toFiniteNumber(raw);
  if (value === undefined || value < 0) return null;
  return Math.trunc(value);
}

function toVoiceSpeedBound(raw: unknown, fallback: number): number {
  const value = toFiniteNumber(raw);
  if (value === undefined) return fallback;
  return value >= 1 ? Math.trunc(value) : fallback;
}

// modes 决定页面画哪几个单选；一个都认不出来就退回契约写死的 0/1/2，页面不能没有选项。
function toVoiceModes(raw: unknown): number[] {
  const modes: number[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const mode = toVoiceMode(entry);
      if (mode !== null && !modes.includes(mode)) modes.push(mode);
    }
  }
  return modes.length === 0 ? VOICE_MODE_IDS.slice() : modes;
}

// 导演模式的可选档位同理：一个都认不出来就退回契约写死的 0/1/2。
function toVoiceDirectorModes(raw: unknown): number[] {
  const directors: number[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const director = toVoiceDirector(entry);
      if (director !== null && !directors.includes(director)) directors.push(director);
    }
  }
  return directors.length === 0 ? VOICE_DIRECTOR_IDS.slice() : directors;
}

// scope 与 mode 是定位并操作这一行的全部信息：未知层定位不了，坏档位页面也画不出来，各丢这一条。
function toVoiceSettingsRow(raw: unknown): VoiceSettingsRow | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  if (scope === null) return null;
  const mode = toVoiceMode(source.mode);
  if (mode === null) return null;
  const speed = toVoiceSpeed(source.speed);
  const director = toVoiceDirector(source.director);
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    mode,
    director: director === null ? VOICE_SETTINGS_DEFAULT.director : director,
    voice: typeof source.voice === 'string' ? source.voice : '',
    speed: speed === null ? VOICE_SETTINGS_DEFAULT.speed : speed,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** GET /api/voice-settings；坏形状按「空列表 + 契约默认」兜底，页面照常渲染。 */
export async function fetchVoiceSettings(): Promise<VoiceSettingsSnapshot> {
  const raw = await request<unknown>('GET', '/api/voice-settings');
  const source = toRecord(raw);
  const items: VoiceSettingsRow[] = [];
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const row = toVoiceSettingsRow(entry);
      if (row !== null) items.push(row);
    }
  }
  const defaultSource = toRecord(source.default);
  const speedMin = toVoiceSpeedBound(source.speedMin, VOICE_SPEED_MIN);
  const speedMax = toVoiceSpeedBound(source.speedMax, VOICE_SPEED_MAX);
  // min 不小于 max 会让保存按钮永远点不动，这种空区间还是退回契约的 50–200。
  const range = speedMin < speedMax ? { speedMin, speedMax } : { speedMin: VOICE_SPEED_MIN, speedMax: VOICE_SPEED_MAX };
  return {
    items,
    default: {
      mode: toVoiceMode(defaultSource.mode) ?? VOICE_SETTINGS_DEFAULT.mode,
      director: toVoiceDirector(defaultSource.director) ?? VOICE_SETTINGS_DEFAULT.director,
      voice: typeof defaultSource.voice === 'string' ? defaultSource.voice : VOICE_SETTINGS_DEFAULT.voice,
      speed: toVoiceSpeed(defaultSource.speed) ?? VOICE_SETTINGS_DEFAULT.speed,
    },
    modes: toVoiceModes(source.modes),
    directorModes: toVoiceDirectorModes(source.directorModes),
    speedMin: range.speedMin,
    speedMax: range.speedMax,
  };
}

// global 的定位键只有 scope 本身：这一层不带 scopeId，同 vision-settings 的规矩。
function voiceSettingsKey(scope: Scope, scopeId?: string): { scope: Scope; scopeId?: string } {
  const normalized = normalizeScopeId(scope, typeof scopeId === 'string' ? scopeId : '');
  return normalized === '' ? { scope } : { scope, scopeId: normalized };
}

/** PUT /api/voice-settings：整行写某一层的档位 / 音色 / 语速，回保存后的这一行。 */
export async function saveVoiceSetting(input: {
  scope: Scope;
  scopeId?: string;
  mode: number;
  director?: number;
  voice?: string;
  speed?: number;
}): Promise<VoiceSettingsRow> {
  const key = voiceSettingsKey(input.scope, input.scopeId);
  // 四个字段一律显式带上：音色空串就是「用服务器的默认音色」，省掉字段会被当成「保留旧值」。
  const director = typeof input.director === 'number' ? input.director : VOICE_SETTINGS_DEFAULT.director;
  const voice = typeof input.voice === 'string' ? input.voice.trim() : '';
  const speed = typeof input.speed === 'number' ? input.speed : VOICE_SETTINGS_DEFAULT.speed;
  const raw = await request<unknown>('PUT', '/api/voice-settings', { ...key, mode: input.mode, director, voice, speed });
  // 后端回的是保存后的本体；万一字段缺失就按入参兜底，调用方不必处理 null。
  return (
    toVoiceSettingsRow(raw) ?? {
      scope: key.scope,
      scopeId: normalizeScopeId(key.scope, input.scopeId ?? ''),
      mode: input.mode,
      director,
      voice,
      speed,
      updatedAt: '',
    }
  );
}

/** DELETE /api/voice-settings：删掉这一层 = 恢复上层，本来没配也回 200。 */
export async function clearVoiceSetting(input: { scope: Scope; scopeId?: string }): Promise<void> {
  await request<{ ok?: boolean }>('DELETE', '/api/voice-settings', voiceSettingsKey(input.scope, input.scopeId));
}

// 档位文案列表与生效值两处共用：只有三档，加一档就在这里加一行。
export function describeVoiceMode(mode: number): string {
  if (mode === 0) return '关闭';
  if (mode === 1) return '她说了才发';
  if (mode === 2) return '每条回复都发';
  return '档位 ' + String(mode);
}

// 导演模式文案与下拉选项共用：三档的名字写死在这里，加一档就在 VOICE_DIRECTOR_IDS 和这里各加一行。
export function describeVoiceDirector(director: number): string {
  if (director === 0) return '关闭（逐字朗读）';
  if (director === 1) return '只插标签';
  if (director === 2) return '允许顺句改写';
  return '导演档 ' + String(director);
}

// 退回原因来自 src/core/voice/style.ts 的 VoiceDirectorRejection；翻成中文给排查用，不影响朗读。
export function describeVoiceDirectorRejection(reason: string): string {
  if (reason === 'empty') return '判断模型只回了风格组、没写正文';
  if (reason === 'verbatim') return '1 档候选改了字，不是原句';
  if (reason === 'residue') return '2 档候选残留 [[...]] 指令';
  if (reason === 'ratio') return '2 档字数越界';
  if (reason === 'judge') return '判断模型没答上来（超时或报错）';
  return reason;
}

// 契约这两条路由只回错误码，翻成中文再显示，不把码直接甩给用户；
// 认不出的码（含 401 登录已失效、NETWORK_ERROR）走 describeError 已有的中文 message。
export function describeVoiceSettingsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_VOICE_MODE') return '档位只能是 0/1/2';
    if (error.code === 'BAD_DIRECTOR_MODE') return '导演模式只能是 0/1/2';
    if (error.code === 'BAD_VOICE_SPEED') return '语速要在 50–200 之间';
    if (error.code === 'BAD_SCOPE') return '作用域不合法：只能是全局 / 服务器 / 频道';
    if (error.code === 'BAD_REQUEST') return '服务器或频道 ID 没填（global 层不用填），字段类型也要对上';
  }
  return describeError(error);
}

// 门牌 prompt-scope-1 内置默认提示词：代码里原本写死的两段默认文本（fallback / identity）改成三层可编辑。
// 三层优先级 channel > guild > global，三层都没配才用代码内置那一份；GET 的 items 只含「已配置」的层，
// codeDefaults 是代码内置原文 + 渲染预览（只读），sampleVars 是渲染预览用的示例值。
export type PromptDefaultKey = 'fallback' | 'identity';

export const PROMPT_DEFAULT_KEYS: PromptDefaultKey[] = ['fallback', 'identity'];

/** 契约写死的正文上限（20000）：GET 回来了以接口的 maxChars 为准，这份只是首屏兜底。 */
export const PROMPT_DEFAULT_MAX_CHARS = 20000;

/** 页面上三层的展示顺序（频道 → 服务器 → 全局）；接口回了 scopes 就按它过滤，顺序仍按这份走。 */
export const PROMPT_DEFAULT_SCOPES: Scope[] = ['channel', 'guild', 'global'];

/** 两张模板各自允许哪些占位符：GET 回来前先按这一份画 chip，回来后按后端白名单重画。 */
export const PROMPT_DEFAULTS_VARS: Record<PromptDefaultKey, string[]> = {
  fallback: ['bot_name', 'user_name', 'guild_name', 'channel_name', 'date'],
  identity: ['bot_name', 'user_name', 'user_id', 'guild_name', 'channel_name', 'date'],
};

export interface PromptDefaultEntry {
  key: PromptDefaultKey;
  scope: Scope;
  scopeId: string;
  content: string;
  updatedAt: string;
}

/** 代码内置的那一份：text 保留 {{}} 原样，rendered 是拿 sampleVars 渲染后的预览。 */
export interface PromptDefaultCodeDefault {
  text: string;
  rendered: string;
}

/** GET /api/prompt-defaults 的形状：items 最多 6 行（2 个 key × 3 层），没配的层没有对应行。 */
export interface PromptDefaultsSnapshot {
  items: PromptDefaultEntry[];
  vars: Record<PromptDefaultKey, string[]>;
  maxChars: number;
  scopes: Scope[];
  sampleVars: Record<string, string>;
  codeDefaults: Record<PromptDefaultKey, PromptDefaultCodeDefault>;
}

/** 定位「某一层的某一张模板」：scope=global 时 scopeId 固定空串。 */
export interface PromptDefaultTarget {
  key: PromptDefaultKey;
  scope: Scope;
  scopeId: string;
}

/** POST /api/prompt-defaults/preview 的结果：unknownVars 里是不认识的占位符名（不带花括号）。 */
export interface PromptDefaultPreview {
  key: PromptDefaultKey;
  rendered: string;
  unknownVars: string[];
}

function toPromptDefaultKey(raw: unknown): PromptDefaultKey | null {
  for (const key of PROMPT_DEFAULT_KEYS) {
    if (key === raw) return key;
  }
  return null;
}

// 认不出的 scope 按 global 兜底：这一行至少还看得见、还能改，不至于从列表里消失。
function toPromptDefaultScope(raw: unknown): Scope {
  return toScope(raw) ?? 'global';
}

// key 认不出来这一行就说不清「写的是哪张模板」，丢掉；content / updatedAt 缺了按空串兜底，页面照常渲染。
function toPromptDefaultEntry(raw: unknown): PromptDefaultEntry | null {
  const source = toRecord(raw);
  const key = toPromptDefaultKey(source.key);
  if (key === null) return null;
  const scope = toPromptDefaultScope(source.scope);
  return {
    key,
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    content: typeof source.content === 'string' ? source.content : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

// 占位符名统一成「不带花括号」：contract 回的名字可能已经带了 {{}}，脏数据抹掉，空名丢掉。
function toPromptDefaultVarNames(raw: unknown): string[] {
  const names: string[] = [];
  if (!Array.isArray(raw)) return names;
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.replace(/[{}]/g, '').trim();
    if (name !== '') names.push(name);
  }
  return names;
}

// 整份认不出来就退回契约白名单，页面不能没有 chip。
function toPromptDefaultVars(raw: unknown, key: PromptDefaultKey): string[] {
  const vars = toPromptDefaultVarNames(raw);
  return vars.length === 0 ? PROMPT_DEFAULTS_VARS[key] : vars;
}

function toPromptDefaultsMaxChars(raw: unknown): number {
  const value = toFiniteNumber(raw);
  if (value === undefined || value < 1) return PROMPT_DEFAULT_MAX_CHARS;
  return Math.trunc(value);
}

// 三层的顺序不可控：先按接口过滤，再按展示顺序重排，页面 tab 才不会跳。
function toPromptDefaultScopes(raw: unknown): Scope[] {
  const seen: Scope[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const scope = toScope(entry);
      if (scope !== null && !seen.includes(scope)) seen.push(scope);
    }
  }
  if (seen.length === 0) return PROMPT_DEFAULT_SCOPES;
  return PROMPT_DEFAULT_SCOPES.filter((scope) => seen.includes(scope));
}

// 示例值只用来渲染预览：非字符串项直接丢掉，键上的花括号抹掉以便和占位符名对齐。
function toPromptDefaultSampleVars(raw: unknown): Record<string, string> {
  const samples: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(toRecord(raw))) {
    if (typeof value !== 'string') continue;
    const name = rawName.replace(/[{}]/g, '').trim();
    if (name !== '') samples[name] = value;
  }
  return samples;
}

function toPromptDefaultCodeDefault(raw: unknown): PromptDefaultCodeDefault {
  const source = toRecord(raw);
  return {
    text: typeof source.text === 'string' ? source.text : '',
    rendered: typeof source.rendered === 'string' ? source.rendered : '',
  };
}

/** GET /api/prompt-defaults：坏形状按「空列表 + 契约变量 + 契约上限」兜底，页面照常渲染。 */
export async function fetchPromptDefaults(): Promise<PromptDefaultsSnapshot> {
  const raw = await request<unknown>('GET', '/api/prompt-defaults');
  const source = toRecord(raw);
  const items: PromptDefaultEntry[] = [];
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const item = toPromptDefaultEntry(entry);
      if (item !== null) items.push(item);
    }
  }
  const varsSource = toRecord(source.vars);
  const codeSource = toRecord(source.codeDefaults);
  return {
    items,
    vars: {
      fallback: toPromptDefaultVars(varsSource.fallback, 'fallback'),
      identity: toPromptDefaultVars(varsSource.identity, 'identity'),
    },
    maxChars: toPromptDefaultsMaxChars(source.maxChars),
    scopes: toPromptDefaultScopes(source.scopes),
    sampleVars: toPromptDefaultSampleVars(source.sampleVars),
    codeDefaults: {
      fallback: toPromptDefaultCodeDefault(codeSource.fallback),
      identity: toPromptDefaultCodeDefault(codeSource.identity),
    },
  };
}

/** PUT /api/prompt-defaults：只写「当前层这一张模板」，回保存后的这一行。 */
export async function savePromptDefault(
  input: PromptDefaultTarget & { content: string },
): Promise<PromptDefaultEntry> {
  const scopeId = normalizeScopeId(input.scope, input.scopeId);
  const raw = await request<unknown>('PUT', '/api/prompt-defaults', {
    key: input.key,
    scope: input.scope,
    scopeId,
    content: input.content,
  });
  // 后端回的是保存后的本体；万一字段缺失就按入参兜底，调用方不必处理 null。
  return (
    toPromptDefaultEntry(raw) ?? {
      key: input.key,
      scope: input.scope,
      scopeId,
      content: input.content,
      updatedAt: '',
    }
  );
}

/** DELETE /api/prompt-defaults?key=&scope=&scopeId=：删掉这一层的这张模板 = 回落到上一层 / 代码内置，本来没配也回 200。 */
export async function clearPromptDefault(target: PromptDefaultTarget): Promise<void> {
  const params = new URLSearchParams();
  params.set('key', target.key);
  params.set('scope', target.scope);
  params.set('scopeId', normalizeScopeId(target.scope, target.scopeId));
  await request<{ ok?: boolean }>('DELETE', '/api/prompt-defaults?' + params.toString());
}

/** POST /api/prompt-defaults/preview：按当前正文渲染一遍；空白正文后端回 rendered 空串，不报错。 */
export async function previewPromptDefault(input: {
  key: PromptDefaultKey;
  content: string;
}): Promise<PromptDefaultPreview> {
  const raw = await request<unknown>('POST', '/api/prompt-defaults/preview', {
    key: input.key,
    content: input.content,
  });
  const source = toRecord(raw);
  return {
    key: toPromptDefaultKey(source.key) ?? input.key,
    rendered: typeof source.rendered === 'string' ? source.rendered : '',
    unknownVars: toPromptDefaultVarNames(source.unknownVars),
  };
}

// 契约这几条路由只回错误码，翻成中文再显示，不把码直接甩给用户；
// 认不出的码（含 401 登录已失效、NETWORK_ERROR）走 describeError 已有的中文 message。
export function describePromptDefaultsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_PROMPT_KEY') {
      return '模板键不合法：只能是 fallback（三层都没配时用这段）或 identity（每轮身份块模板）';
    }
    if (error.code === 'BAD_SCOPE') {
      return '作用域不合法：只能是频道 / 服务器 / 全局，且全局层的 scopeId 必须是空串';
    }
    if (error.code === 'BAD_REQUEST') {
      return '请求参数不合法：模板键、作用域、意图作用域 ID 与正文都要对上，频道 / 服务器层必须填 ID';
    }
    if (error.code === 'BAD_PROMPT_CONTENT') {
      return (
        '正文不合法：必须是文本、不能为空，且不超过 ' +
        String(PROMPT_DEFAULT_MAX_CHARS) +
        ' 字（正式上限以接口回的 maxChars 为准）'
      );
    }
    if (error.code === 'UNKNOWN_TEMPLATE_VAR') {
      const vars = error.unknownVars;
      return (
        '模板中含不支持的占位符：' +
        (vars.length === 0 ? '（服务端未返回占位符名）' : vars.join('、')) +
        '。占位符要写成 {{名字}}，且只能用这张模板变量列表里的名字'
      );
    }
  }
  return describeError(error);
}

// 门牌 prompt-copy-1 语音合成接口：后台是 TTS 的唯一来源，GET 只回掩码 keyHint；dialect 决定请求形状。
// 环境变量 VOICE_TTS_* 这一版不参与取值，envPresent 只用来提示「服务器上还留着，可以删」。
// model 已从契约移除：合成用哪个模型由后端按方言决定，页面既不显示也不提交。
/** 上游方言：openai 走 POST /audio/speech（mp3），mimo 走小米 MiMo 的 chat/completions，gemini 走 /audio/speech（WAV）。 */
export type TtsDialect = 'openai' | 'mimo' | 'gemini';

/** defaults.dialects 的一项：下拉文案、地址占位与音色建议都挂在方言上。 */
export interface TtsDialectOption {
  id: TtsDialect;
  label: string;
  urlPlaceholder: string;
  voices: string[];
}

export interface TtsSettingsDefaults {
  urlPlaceholder: string;
  voices: string[];
  /** 可选的三套上游方言；页面照它画「接口类型」下拉与各输入框的占位 / 音色建议。 */
  dialects: TtsDialectOption[];
  defaultDialect: TtsDialect;
}

/** GET /api/tts-settings：configured = 地址与密钥都配过；keyHint / judgeKeyHint 都是掩码，绝不含明文。 */
export interface TtsSettingsSnapshot {
  configured: boolean;
  url: string;
  keyHint: string;
  voice: string;
  /** 这一行存的是哪套方言；接口给了非法值时已按 defaultDialect 归一。 */
  dialect: TtsDialect;
  /** 情绪判断模型：三项都填了 judgeConfigured 才是真，合成前先让它读回复写一行语气指令。 */
  judgeUrl: string;
  judgeKeyHint: string;
  judgeModel: string;
  judgeConfigured: boolean;
  updatedAt: string;
  defaults: TtsSettingsDefaults;
  /** 服务器上还有非空的 VOICE_TTS_URL / VOICE_TTS_KEY：只用于提示，不参与取值。 */
  envPresent: boolean;
}

export interface TtsSettingsInput {
  url: string;
  /** 省略 = 保留原密文与 keyHint；库里没配过时后端回 BAD_TTS_KEY。 */
  key?: string;
  voice?: string;
  /** 省略或空串按 openai 存；非法值后端回 400 BAD_TTS_DIALECT。 */
  dialect?: TtsDialect;
  /** 空串 = 清掉判断模型地址；非 http(s) 或超长后端回 400 BAD_TTS_JUDGE。 */
  judgeUrl?: string;
  /** 省略或空串 = 保留原密文与 judgeKeyHint。 */
  judgeKey?: string;
  /** 空串 = 清掉判断模型名。 */
  judgeModel?: string;
}

/** POST /api/tts-settings/test：audioBase64 是 mp3 原文，页面自己还原成 Blob 播放。 */
export interface TtsTestResult {
  ok: boolean;
  bytes: number;
  durationMs: number;
  contentType: string;
  audioBase64: string;
  /** 实际发送的标签，带括号（如 (怅然)）；这次没带标签时是 null。 */
  styleUsed: string | null;
  /** 最终念的正文：正文原样，含 [音频标签]；老响应没有这个字段，页面按缺省处理。 */
  speechUsed?: string;
  /** 这次试听走的导演档；老响应没有这个字段。 */
  director?: number;
  /** 判断模型这次回的那一行原文（完整、不截断）；它没回话就是 null，老响应没有这个字段。 */
  judgeLine?: string | null;
  /** 导演档把候选退回原文的原因；这次没退回就是 null，老响应没有这个字段。 */
  directorRejected?: string | null;
}

// 三套方言的内置定义：接口 defaults 坏掉时页面也画得出来，中文音色必须逐字对上契约。
const TTS_OPENAI_VOICES: string[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const TTS_MIMO_VOICES: string[] = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
const TTS_GEMINI_VOICES: string[] = [
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
const TTS_DIALECT_FALLBACKS: TtsDialectOption[] = [
  {
    id: 'openai',
    label: 'OpenAI 兼容（/audio/speech）',
    urlPlaceholder: 'https://api.openai.com/v1',
    voices: TTS_OPENAI_VOICES,
  },
  {
    id: 'mimo',
    label: '小米 MiMo（chat/completions）',
    urlPlaceholder: 'https://api.xiaomimimo.com/v1',
    voices: TTS_MIMO_VOICES,
  },
  {
    id: 'gemini',
    label: 'Gemini（/audio/speech，WAV）',
    urlPlaceholder: 'https://example.com/pg/v1',
    voices: TTS_GEMINI_VOICES,
  },
];

// 契约写死的默认值：GET 回来前先按这份画表单，回来后按接口的 defaults 重画。
export const TTS_SETTINGS_DEFAULTS: TtsSettingsDefaults = {
  urlPlaceholder: 'https://api.openai.com/v1',
  voices: TTS_OPENAI_VOICES,
  dialects: TTS_DIALECT_FALLBACKS,
  defaultDialect: 'openai',
};

function toTtsString(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

// 方言 id 只认这三个：其它值后端一定 400，页面也不该画出来让用户选。
function isTtsDialect(raw: unknown): raw is TtsDialect {
  return raw === 'openai' || raw === 'mimo' || raw === 'gemini';
}

function toTtsDialect(raw: unknown, fallback: TtsDialect): TtsDialect {
  return isTtsDialect(raw) ? raw : fallback;
}

function ttsDialectFallback(id: TtsDialect): TtsDialectOption {
  const found = TTS_DIALECT_FALLBACKS.find((option) => option.id === id);
  return found === undefined ? TTS_DIALECT_FALLBACKS[0] : found;
}

// voices 决定 datalist 给哪些建议；一个都认不出来就退回这组内置的，输入框不能没有建议。
function toTtsVoices(raw: unknown, fallback: string[] = TTS_OPENAI_VOICES): string[] {
  const voices: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry !== '' && !voices.includes(entry)) voices.push(entry);
    }
  }
  return voices.length === 0 ? fallback.slice() : voices;
}

function toTtsDialectOptions(raw: unknown): TtsDialectOption[] {
  const options: TtsDialectOption[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const source = toRecord(entry);
      const id = source.id;
      if (!isTtsDialect(id)) continue;
      // 同一个 id 只认先来的那一项：下拉里出现两行一样的选项，用户选哪个都说不清。
      if (options.some((option) => option.id === id)) continue;
      const builtin = ttsDialectFallback(id);
      const label = toTtsString(source.label);
      const urlPlaceholder = toTtsString(source.urlPlaceholder);
      options.push({
        id,
        label: label === '' ? builtin.label : label,
        urlPlaceholder: urlPlaceholder === '' ? builtin.urlPlaceholder : urlPlaceholder,
        voices: toTtsVoices(source.voices, builtin.voices),
      });
    }
  }
  if (options.length > 0) return options;
  // 形状坏就整份退回内置两份：下拉空了，页面就没法选类型。
  return TTS_DIALECT_FALLBACKS.map((option) => ({ ...option, voices: option.voices.slice() }));
}

function toTtsDefaults(raw: unknown): TtsSettingsDefaults {
  const source = toRecord(raw);
  const urlPlaceholder = toTtsString(source.urlPlaceholder);
  return {
    urlPlaceholder: urlPlaceholder === '' ? TTS_SETTINGS_DEFAULTS.urlPlaceholder : urlPlaceholder,
    voices: toTtsVoices(source.voices),
    dialects: toTtsDialectOptions(source.dialects),
    defaultDialect: toTtsDialect(source.defaultDialect, TTS_SETTINGS_DEFAULTS.defaultDialect),
  };
}

// 字段缺一个也要能渲染：缺的按空串 / 契约默认兜底，页面不去读 undefined。
function toTtsSnapshot(raw: unknown): TtsSettingsSnapshot {
  const source = toRecord(raw);
  const defaults = toTtsDefaults(source.defaults);
  return {
    configured: source.configured === true,
    url: toTtsString(source.url),
    keyHint: toTtsString(source.keyHint),
    voice: toTtsString(source.voice),
    dialect: toTtsDialect(source.dialect, defaults.defaultDialect),
    judgeUrl: toTtsString(source.judgeUrl),
    judgeKeyHint: toTtsString(source.judgeKeyHint),
    judgeModel: toTtsString(source.judgeModel),
    judgeConfigured: source.judgeConfigured === true,
    updatedAt: toTtsString(source.updatedAt),
    defaults,
    envPresent: source.envPresent === true,
  };
}

/** GET /api/tts-settings；坏形状按「未配置 + 契约默认」兜底，页面照常渲染。 */
export async function fetchTtsSettings(): Promise<TtsSettingsSnapshot> {
  return toTtsSnapshot(await request<unknown>('GET', '/api/tts-settings'));
}

/** PUT /api/tts-settings：整行写一份配置，回与 GET 相同的形状。 */
export async function saveTtsSettings(input: TtsSettingsInput): Promise<TtsSettingsSnapshot> {
  const body: Record<string, string> = {
    url: input.url,
    voice: typeof input.voice === 'string' ? input.voice : '',
    // 判断模型这两项显式带：空串就是「清掉」，省掉字段会被当成「保留旧值」。
    judgeUrl: typeof input.judgeUrl === 'string' ? input.judgeUrl : '',
    judgeModel: typeof input.judgeModel === 'string' ? input.judgeModel : '',
  };
  // 空串不能带：后端把「省略 key」当成保留原密文，带空串会被当成给了个空 Key。
  if (typeof input.key === 'string' && input.key !== '') body.key = input.key;
  // judgeKey 同样是「空白 = 不改」，空白就不带。
  if (typeof input.judgeKey === 'string' && input.judgeKey !== '') body.judgeKey = input.judgeKey;
  // 省略 = 后端按 openai 存；页面永远显式带当前选中的那一项。
  if (isTtsDialect(input.dialect)) body.dialect = input.dialect;
  return toTtsSnapshot(await request<unknown>('PUT', '/api/tts-settings', body));
}

/** DELETE /api/tts-settings：删整行 = 未配置；本来没配也回 200。 */
export async function clearTtsSettings(): Promise<void> {
  await request<{ ok?: boolean }>('DELETE', '/api/tts-settings');
}

/** POST /api/tts-settings/test：缺省字段省掉，后端回落到库里已存的值（key 用解密值）。 */
export async function testTtsSettings(input: {
  url?: string;
  key?: string;
  voice?: string;
  /** 省略 = 后端回落库里已存的方言。 */
  dialect?: TtsDialect;
  text?: string;
  /** 直接指定这次要带的语气指令；省略 = 后端按三层语气提示词取第一个非空的。 */
  style?: string;
  /** 这次试听走的导演档；省略 = 后端按 0（关闭）处理。 */
  director?: number;
}): Promise<TtsTestResult> {
  const body: Record<string, string | number> = {};
  for (const field of ['url', 'key', 'voice', 'dialect', 'text', 'style'] as const) {
    const value = input[field];
    if (typeof value === 'string' && value !== '') body[field] = value;
  }
  if (typeof input.director === 'number') body.director = input.director;
  const raw = await request<unknown>('POST', '/api/tts-settings/test', body);
  const source = toRecord(raw);
  const bytes = toFiniteNumber(source.bytes);
  const durationMs = toFiniteNumber(source.durationMs);
  const contentType = toTtsString(source.contentType);
  const styleUsed = toTtsString(source.styleUsed);
  const speechUsed = toTtsString(source.speechUsed);
  const result: TtsTestResult = {
    ok: source.ok === true,
    bytes: bytes === undefined || bytes < 0 ? 0 : Math.trunc(bytes),
    durationMs: durationMs === undefined || durationMs < 0 ? 0 : Math.round(durationMs),
    contentType: contentType === '' ? 'audio/mpeg' : contentType,
    audioBase64: toTtsString(source.audioBase64),
    // 没带标签落成 null：页面靠它区分「这次没标签」，不用去猜空串。
    styleUsed: styleUsed === '' ? null : styleUsed,
  };
  // 老响应没有 speechUsed：整个字段省掉，页面按缺省退回原文，不留一个空正文。
  if (speechUsed !== '') result.speechUsed = speechUsed;
  // 导演档这两个字段是 director-2 才有的：老响应缺字段就整个省掉，页面按「这次没走导演档」显示。
  if (typeof source.director === 'number' && Number.isFinite(source.director)) {
    result.director = Math.trunc(source.director);
  }
  if (source.judgeLine === null) result.judgeLine = null;
  else if (typeof source.judgeLine === 'string' && source.judgeLine !== '') result.judgeLine = source.judgeLine;
  if (source.directorRejected === null) result.directorRejected = null;
  else if (typeof source.directorRejected === 'string' && source.directorRejected !== '') {
    result.directorRejected = source.directorRejected;
  }
  return result;
}

// 契约的失败体是 { ok: false, code, message }：码不在 error 字段里，两处都认，认不出再退回 describeError。
function ttsFailureCode(error: ApiError): string {
  const code = error.payload.code;
  return typeof code === 'string' && code !== '' ? code : error.code;
}

function ttsFailureMessage(error: ApiError): string {
  const message = error.payload.message;
  const text = typeof message === 'string' ? message.trim() : '';
  return text === '' ? error.message : text;
}

export function describeTtsError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = ttsFailureCode(error);
    if (code === 'TTS_NOT_CONFIGURED') return '还没配地址或 Key';
    if (code === 'TTS_UPSTREAM') return '上游报错：' + ttsFailureMessage(error);
    if (code === 'BAD_TTS_URL') return '地址不合法：要 http:// 或 https:// 开头，500 字以内';
    if (code === 'BAD_TTS_KEY') return 'Key 不合法：第一次配置必须填，之后可以留空不改';
    if (code === 'BAD_TTS_DIALECT') return '接口类型不合法，请重新选择';
    if (code === 'BAD_TTS_JUDGE') return '判断模型不合法：地址要 http:// 或 https:// 开头，Key 不超过 500 字，模型名不超过 100 字';
    if (code === 'BAD_TTS_STYLE') return '语气提示词不合法：单层不能超过接口回的 maxChars 字，也不能带坏字符';
    if (code === 'BAD_SCOPE') return '作用域不合法：只能是全局 / 服务器 / 频道';
    if (code === 'BAD_REQUEST') return '字段不合法：服务器 / 频道层要填 scopeId（global 不用），音色与判断模型名各不超过 100 字';
  }
  return describeError(error);
}

// 门牌 prompt-copy-1 朗读语气提示词：三层（channel > guild > global）各存一段原文，
// 合成时取第一个非空的；GET 的 items 只含「已配置」的层，maxChars 是单层正文上限。
/** 一层语气提示词：scope + scopeId 定位，content 是原文（空白 = 这一层没有）。 */
export interface TtsStyleLayer {
  scope: Scope;
  scopeId: string;
  content: string;
  updatedAt: string;
}

/** GET /api/tts-style 的响应体：items 顺序 channel, guild, global；maxChars 决定字数计数。 */
export interface TtsStyleLayersResponse {
  items: TtsStyleLayer[];
  maxChars: number;
}

/** 契约写死的单层上限（2000）：GET 回来了以接口的 maxChars 为准，这份只是首屏兜底。 */
export const TTS_STYLE_MAX_CHARS = 2000;

// 列表按生效优先级排：channel 在最上面，第一条就是真正生效的那一层。
const TTS_STYLE_SCOPE_RANK: Record<Scope, number> = { channel: 0, guild: 1, global: 2 };

function toTtsStyleLayer(raw: unknown): TtsStyleLayer | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  if (scope === null) return null;
  return {
    scope,
    scopeId: normalizeScopeId(scope, toTtsString(source.scopeId)),
    content: toTtsString(source.content),
    updatedAt: toTtsString(source.updatedAt),
  };
}

/** GET /api/tts-style；坏形状按「空列表 + 契约上限」兜底，页面照常渲染。 */
export async function fetchTtsStyleLayers(): Promise<TtsStyleLayersResponse> {
  const raw = await request<unknown>('GET', '/api/tts-style');
  const source = toRecord(raw);
  const items: TtsStyleLayer[] = [];
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const layer = toTtsStyleLayer(entry);
      if (layer !== null) items.push(layer);
    }
  }
  // 接口本来就按 channel, guild, global 回；这里再排一次，顺序坏了页面也不会把优先级画反。
  items.sort((left, right) => TTS_STYLE_SCOPE_RANK[left.scope] - TTS_STYLE_SCOPE_RANK[right.scope]);
  const maxChars = toFiniteNumber(source.maxChars);
  return {
    items,
    maxChars: maxChars === undefined || maxChars < 1 ? TTS_STYLE_MAX_CHARS : Math.trunc(maxChars),
  };
}

/** PUT /api/tts-style 的结果：content 空白时后端删掉这一层，此时 removed 为真、layer 为 null。 */
export interface TtsStyleSaveResult {
  removed: boolean;
  layer: TtsStyleLayer | null;
}

/** PUT /api/tts-style：content 空白也照发（后端靠它删这一层），非空回保存后的这一行。 */
export async function saveTtsStyleLayer(input: {
  scope: Scope;
  scopeId?: string;
  content: string;
}): Promise<TtsStyleSaveResult> {
  const scopeId = normalizeScopeId(input.scope, typeof input.scopeId === 'string' ? input.scopeId : '');
  const raw = await request<unknown>('PUT', '/api/tts-style', { scope: input.scope, scopeId, content: input.content });
  const source = toRecord(raw);
  const removed = source.removed === true;
  return { removed, layer: removed ? null : toTtsStyleLayer(raw) };
}

/** DELETE /api/tts-style?scope=&scopeId=：删这一层 = 恢复下一层，本来没配也回 200。 */
export async function clearTtsStyleLayer(scope: Scope, scopeId?: string): Promise<void> {
  const target = normalizeScopeId(scope, typeof scopeId === 'string' ? scopeId : '');
  const query = '?scope=' + encodeURIComponent(scope) + '&scopeId=' + encodeURIComponent(target);
  await request<{ ok?: boolean }>('DELETE', '/api/tts-style' + query);
}

// 深度注入（SillyTavern depth_prompt）：三层各一行，聊天装配时按 channel > guild > global 取第一个非空。
// content 空白 = 这一层关着；depth 是「倒数第几条之前」，0 = 紧接本轮用户消息之前。
/** 注入消息的角色：三个值原样透传给模型，页面只负责不让它变成别的值。 */
export type InjectionRole = 'system' | 'user' | 'assistant';

export const INJECTION_ROLES: readonly InjectionRole[] = ['system', 'user', 'assistant'];

export const INJECTION_ROLE_LABELS: Record<InjectionRole, string> = {
  system: 'system（系统指令）',
  user: 'user（用户口吻）',
  assistant: 'assistant（自己口吻）',
};

/** 与后端 INJECTION_DEPTH_MAX / INJECTION_CONTENT_MAX_CHARS 同值：页面只用于计数与提示。 */
export const INJECTION_DEPTH_MAX = 50;
export const INJECTION_CONTENT_MAX_CHARS = 20000;

/** 一层深度注入：scope + scopeId 定位，没有行就是这一层没配置。 */
export interface PromptInjectionLayer {
  scope: Scope;
  scopeId: string;
  content: string;
  depth: number;
  role: InjectionRole;
  updatedAt: string;
}

function toInjectionRole(raw: unknown): InjectionRole {
  return raw === 'user' || raw === 'assistant' ? raw : 'system';
}

function toInjectionLayer(raw: unknown): PromptInjectionLayer | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  if (scope === null) return null;
  const depth = toFiniteNumber(source.depth);
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    content: typeof source.content === 'string' ? source.content : '',
    depth: depth === undefined || depth < 0 || depth > INJECTION_DEPTH_MAX ? 0 : Math.trunc(depth),
    role: toInjectionRole(source.role),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

/** GET /api/prompt-injections：坏形状按空列表兜底，页面照常渲染。 */
export async function fetchPromptInjections(): Promise<PromptInjectionLayer[]> {
  const raw = await request<unknown>('GET', '/api/prompt-injections');
  const source = toRecord(raw);
  const items: PromptInjectionLayer[] = [];
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const layer = toInjectionLayer(entry);
      if (layer !== null) items.push(layer);
    }
  }
  return items;
}

/** PUT /api/prompt-injections：空 content 也照发（那是「关掉这一层」的写法），成功回保存后的这一行。 */
export async function savePromptInjection(input: {
  scope: Scope;
  scopeId?: string;
  content: string;
  depth: number;
  role: InjectionRole;
}): Promise<PromptInjectionLayer> {
  const scopeId = normalizeScopeId(input.scope, typeof input.scopeId === 'string' ? input.scopeId : '');
  const raw = await request<unknown>('PUT', '/api/prompt-injections', {
    scope: input.scope,
    scopeId,
    content: input.content,
    depth: input.depth,
    role: input.role,
  });
  const layer = toInjectionLayer(raw);
  if (layer === null) throw new ApiError(0, { error: 'BAD_RESPONSE' }, '保存成功，但接口回的形状不认识');
  return layer;
}

/** DELETE /api/prompt-injections：删这一层 = 恢复下一层，本来没配也回 200。 */
export async function clearPromptInjection(scope: Scope, scopeId?: string): Promise<void> {
  const target = normalizeScopeId(scope, typeof scopeId === 'string' ? scopeId : '');
  await request<{ ok?: boolean }>('DELETE', '/api/prompt-injections', { scope, scopeId: target });
}

/** 三个 400 码翻成中文再显示；认不出的码（含 BAD_SCOPE）走 describeError。 */
export function describePromptInjectionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_INJECTION_CONTENT') {
      return '注入正文不合法：要是文本，且不超过 ' + String(INJECTION_CONTENT_MAX_CHARS) + ' 字';
    }
    if (error.code === 'BAD_INJECTION_DEPTH') return '深度不合法：填 0–' + String(INJECTION_DEPTH_MAX) + ' 的整数';
    if (error.code === 'BAD_INJECTION_ROLE') return '角色不合法：只能是 system / user / assistant';
  }
  return describeError(error);
}

// 阶段三「世界书」（SillyTavern lorebook）：一层可以有多本，层内各自独立、启用中的同时参与装配。
// GET 只下发条目摘要（正文留在库里给装配读），所以条目类型叫 Summary。
/** 被跳过的条目：empty = 正文空白，noKeys = 没有关键词且不是常驻，disabled = 条目本身停用。 */
export type WorldBookIgnoreReason = 'empty' | 'noKeys' | 'disabled';

/** 结果区按这个顺序分组，取值清单放这里，页面只负责文案。 */
export const WORLD_BOOK_IGNORE_REASONS: readonly WorldBookIgnoreReason[] = ['empty', 'noKeys', 'disabled'];

/** 插入位置：与酒馆五档一一对应，只有 atDepth 进历史消息（落库时是数字码 0..4）。 */
export type WorldPosition = 'beforeChar' | 'afterChar' | 'anTop' | 'anBottom' | 'atDepth';

export const WORLD_POSITIONS: readonly WorldPosition[] = ['beforeChar', 'afterChar', 'anTop', 'anBottom', 'atDepth'];

export const WORLD_POSITION_LABELS: Record<WorldPosition, string> = {
  beforeChar: '↑Char（角色设定之前）',
  afterChar: '↓Char（角色设定之后）',
  anTop: '↑AN（作者注释顶部）',
  anBottom: '↓AN（作者注释底部）',
  atDepth: '@D（按深度插入历史）',
};

/** 副关键词的组合算法：any/all 是「命中」，not 是「不命中」。 */
export type WorldSelectiveLogic = 'andAny' | 'andAll' | 'notAny' | 'notAll';

export const WORLD_SELECTIVE_LOGICS: readonly WorldSelectiveLogic[] = ['andAny', 'andAll', 'notAny', 'notAll'];

export const WORLD_SELECTIVE_LOGIC_LABELS: Record<WorldSelectiveLogic, string> = {
  andAny: 'AND ANY（副关键词任一命中）',
  andAll: 'AND ALL（副关键词全部命中）',
  notAny: 'NOT ANY（副关键词一个都没命中）',
  notAll: 'NOT ALL（副关键词没有全部命中）',
};

/** 条目以谁的口吻插入历史：与模型消息的 role 同值，页面只负责不让它变成别的值。 */
export type WorldEntryRole = 'system' | 'user' | 'assistant';

export const WORLD_ENTRY_ROLES: readonly WorldEntryRole[] = ['system', 'user', 'assistant'];

export const WORLD_ENTRY_ROLE_LABELS: Record<WorldEntryRole, string> = {
  system: 'system（系统指令）',
  user: 'user（用户口吻）',
  assistant: 'assistant（自己口吻）',
};

/**
 * 与后端同值的范围：页面只用于校验与提示，落库仍由后端收口。
 * 注意 delay：导入侧 clamp 与 PUT /api/world-book/entry 的校验都是 0..100000；
 * sticky / cooldown 仍是 0..10000，两者别跟着放宽。
 */
export const WORLD_SCAN_DEPTH_DEFAULT = 4;
export const WORLD_SCAN_DEPTH_MAX = 20;
export const WORLD_DEPTH_MAX = 50;
export const WORLD_PROBABILITY_DEFAULT = 100;
export const WORLD_GROUP_WEIGHT_DEFAULT = 100;
export const WORLD_GROUP_WEIGHT_MAX = 100000;
export const WORLD_STICKY_MAX = 10000;
export const WORLD_COOLDOWN_MAX = 10000;
export const WORLD_DELAY_MAX = 100000;

/** 新建世界书时书名的长度上限：与 POST /api/world-book/entry 的 BAD_BOOK_NAME 同口径（trim 后 1..80 字）。 */
export const WORLD_BOOK_NAME_MAX = 80;

/** 页内校验与 BAD_BOOK_NAME 共用这一句，别写两份文案。 */
export const WORLD_BOOK_NAME_RULE = '世界书名字必填，且不超过 80 字';

/** 一条完整条目：GET /api/world-book/entry 的 entry 与 PUT 的 entry 都是这个形状。 */
export interface WorldBookEntry {
  id: number;
  name: string;
  /** 主关键词：命中任意一个就触发（常驻条目不靠关键词）。 */
  keys: string[];
  /** 副关键词：与 selectiveLogic 一起决定「关键词都命中了还要不要这条」。 */
  secondaryKeys: string[];
  content: string;
  /** true = 常驻，每轮都注入。 */
  constant: boolean;
  /** 停用的条目后端不参与装配，页面上也不按可用条目展示。 */
  enabled: boolean;
  selective: boolean;
  selectiveLogic: WorldSelectiveLogic;
  order: number;
  caseSensitive: boolean;
  wholeWords: boolean;
  position: WorldPosition;
  /** 只对 atDepth 有意义：从倒数第几条之前插入。 */
  depth: number;
  /** 只对 atDepth 有意义：这条消息以谁的口吻出现。 */
  role: WorldEntryRole;
  /** 触发概率 0–100；useProbability 关掉时按必中处理。 */
  probability: number;
  useProbability: boolean;
  group: string;
  groupWeight: number;
  sticky: number;
  cooldown: number;
  delay: number;
  /** null = 用书级默认（4）。 */
  scanDepth: number | null;
}

/** 列表条目：完整条目去掉正文，换成正文字数（正文可能有几千字，列表不下发）。 */
export interface WorldBookEntrySummary extends Omit<WorldBookEntry, 'content'> {
  /** 正文字数：正文不下发，列表只给规模。 */
  chars: number;
}

/** 一本世界书：GET /api/world-book 的每一项。一层可以有多本，scope + scopeId 只说明它属于哪一层。 */
export interface WorldBook {
  scope: Scope;
  scopeId: string;
  /** 稳定 id：条目 id 只在书内唯一，读写某一条都必须带上它。 */
  bookId: string;
  name: string;
  /** 整本开关：停用只是不参与装配，书与条目都还留在库里。 */
  enabled: boolean;
  /** 后端口径的条目总数（含停用），entries 被截断时也以它为准。 */
  entryCount: number;
  importedAt: string;
  entries: WorldBookEntrySummary[];
}

export interface WorldBookIgnored {
  identifier: string;
  name: string;
  reason: WorldBookIgnoreReason;
}

/** POST /api/world-book/import 的 200：导入永远新增一本，不覆盖这一层已有的书。 */
export interface WorldBookImportResult {
  scope: Scope;
  scopeId: string;
  bookId: string;
  /** 实际落库的书名：同层重名时后端会加「（2）」后缀。 */
  name: string;
  entryCount: number;
  ignored: WorldBookIgnored[];
  warnings: string[];
  /** 这一层现在一共几本（含刚新增的这本）。 */
  layerCount: number;
}

function toStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const items: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') items.push(entry);
  }
  return items;
}

/** 条目 id：契约里是数字，但老接口下发过字符串，两种都收。 */
function readWorldEntryId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

/** 位置认名字也认酒馆数字码（0..4）；认不出按 anTop，与后端 normalizeWorldEntry 一致。 */
function toWorldPosition(raw: unknown): WorldPosition {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const code = Math.floor(raw);
    if (code === 0) return 'beforeChar';
    if (code === 1) return 'afterChar';
    if (code === 3) return 'anBottom';
    if (code === 4) return 'atDepth';
    return 'anTop';
  }
  for (const position of WORLD_POSITIONS) {
    if (position === raw) return position;
  }
  return 'anTop';
}

function toWorldEntryRole(raw: unknown): WorldEntryRole {
  if (raw === 'user' || raw === 'assistant') return raw;
  return 'system';
}

/** 数字码 0=AND ANY、1=NOT ALL、2=NOT ANY、3=AND ALL，与后端 readSelectiveLogic 同口径。 */
function toWorldSelectiveLogic(raw: unknown): WorldSelectiveLogic {
  for (const logic of WORLD_SELECTIVE_LOGICS) {
    if (logic === raw) return logic;
  }
  if (raw === 1) return 'notAll';
  if (raw === 2) return 'notAny';
  if (raw === 3) return 'andAll';
  return 'andAny';
}

/** 关键词：数组照抄；单个逗号串拆开（酒馆导出两种写法都有）。 */
function toWorldKeyList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return toStringList(raw)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function toNumeric(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
  return Number.NaN;
}

function toWorldInt(raw: unknown, min: number, max: number, fallback: number): number {
  const value = toNumeric(raw);
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

/** null = 用书级默认：后端只把 1–20 的整数当自己的扫描深度。 */
function toWorldScanDepth(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = toNumeric(raw);
  if (!Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  if (floored > WORLD_SCAN_DEPTH_MAX) return WORLD_SCAN_DEPTH_MAX;
  return floored;
}

/** 除正文外的全部字段：列表与详情共用这一份解析，字段口径只写一次。 */
function readWorldEntryFields(source: Record<string, unknown>): Omit<WorldBookEntry, 'content'> | null {
  const id = readWorldEntryId(source.id);
  // id 是表格行的 key，缺了就没法稳定渲染，丢弃。
  if (id === null) return null;
  const probability = toWorldInt(source.probability, 0, 100, WORLD_PROBABILITY_DEFAULT);
  return {
    id,
    name: typeof source.name === 'string' ? source.name : '',
    keys: toWorldKeyList(source.keys),
    secondaryKeys: toWorldKeyList(source.secondaryKeys),
    // 缺省按启用处理：停用是显式标记，没写就是参与装配的。
    enabled: source.enabled !== false,
    constant: source.constant === true,
    selective: source.selective === true,
    selectiveLogic: toWorldSelectiveLogic(source.selectiveLogic),
    order: toWorldInt(source.order, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0),
    caseSensitive: source.caseSensitive === true,
    wholeWords: source.wholeWords === true,
    position: toWorldPosition(source.position),
    depth: toWorldInt(source.depth, 0, WORLD_DEPTH_MAX, WORLD_SCAN_DEPTH_DEFAULT),
    role: toWorldEntryRole(source.role),
    probability,
    // 老导出只有 probability：概率小于 100 就是「要用概率」，与导入时的缺省一致。
    useProbability: typeof source.useProbability === 'boolean' ? source.useProbability : probability < WORLD_PROBABILITY_DEFAULT,
    group: typeof source.group === 'string' ? source.group : '',
    groupWeight: toWorldInt(source.groupWeight, 0, WORLD_GROUP_WEIGHT_MAX, WORLD_GROUP_WEIGHT_DEFAULT),
    sticky: toWorldInt(source.sticky, 0, WORLD_STICKY_MAX, 0),
    cooldown: toWorldInt(source.cooldown, 0, WORLD_COOLDOWN_MAX, 0),
    delay: toWorldInt(source.delay, 0, WORLD_DELAY_MAX, 0),
    scanDepth: toWorldScanDepth(source.scanDepth),
  };
}

function toWorldBookEntry(raw: unknown): WorldBookEntrySummary | null {
  const source = toRecord(raw);
  const fields = readWorldEntryFields(source);
  if (fields === null) return null;
  return { ...fields, chars: toCount(source.chars) };
}

/** 详情与保存回执都回完整条目（含正文）；形状不认识返回 null，由调用方决定抛错。 */
function toWorldBookEntryDetail(raw: unknown): WorldBookEntry | null {
  const source = toRecord(raw);
  const fields = readWorldEntryFields(source);
  if (fields === null) return null;
  return { ...fields, content: typeof source.content === 'string' ? source.content : '' };
}

function toWorldBookIgnoreReason(raw: unknown): WorldBookIgnoreReason | null {
  if (raw === 'empty' || raw === 'noKeys' || raw === 'disabled') return raw;
  return null;
}

function toWorldBookIgnored(raw: unknown): WorldBookIgnored | null {
  const source = toRecord(raw);
  const reason = toWorldBookIgnoreReason(source.reason);
  // reason 认不出就没法分组，这条丢掉：结果区只认契约里的三种原因。
  if (reason === null) return null;
  return {
    identifier: typeof source.identifier === 'string' ? source.identifier : '',
    name: typeof source.name === 'string' ? source.name : '',
    reason,
  };
}

function toWorldBook(raw: unknown): WorldBook | null {
  const source = toRecord(raw);
  const scope = toScope(source.scope);
  // scope 缺了就不知道属于哪一层，这条直接丢弃。
  if (scope === null) return null;
  const bookId = typeof source.bookId === 'string' ? source.bookId.trim() : '';
  // 没有 bookId 的行没法定位到具体一本书，读写条目都发不出请求，丢弃。
  if (bookId === '') return null;
  const entries: WorldBookEntrySummary[] = [];
  if (Array.isArray(source.entries)) {
    for (const entry of source.entries) {
      const item = toWorldBookEntry(entry);
      if (item !== null) entries.push(item);
    }
  }
  const entryCount = toCount(source.entryCount);
  return {
    scope,
    scopeId: normalizeScopeId(scope, typeof source.scopeId === 'string' ? source.scopeId : ''),
    bookId,
    name: typeof source.name === 'string' ? source.name : '',
    // 缺省按启用处理：停用是显式标记，没写就是参与装配的。
    enabled: source.enabled !== false,
    // 后端没给总数时按解析出的条数兜底，标题上的「N 条」不至于凭空变 0。
    entryCount: entryCount === 0 ? entries.length : entryCount,
    importedAt: typeof source.importedAt === 'string' ? source.importedAt : '',
    entries,
  };
}

/** 契约 world-book：GET /api/world-book 回 { items }，一项一本；坏条目丢弃，列表里不出现空 scope / 空 bookId。 */
export async function fetchWorldBook(): Promise<WorldBook[]> {
  const result = await request<{ items?: unknown[] }>('GET', '/api/world-book');
  const raw: unknown[] = Array.isArray(result.items) ? result.items : [];
  const items: WorldBook[] = [];
  for (const entry of raw) {
    const book = toWorldBook(entry);
    if (book !== null) items.push(book);
  }
  return items;
}

/**
 * 契约 world-book：POST /api/world-book/import 永远新增一本，不覆盖这一层已有的书。
 * book 是前端 JSON.parse 出来的原样对象，是不是世界书由后端判定（BAD_WORLDBOOK / NO_WORLD_ENTRIES 带 detail）。
 */
export async function importWorldBook(input: {
  scope: Scope;
  scopeId?: string;
  book: unknown;
}): Promise<WorldBookImportResult> {
  const scopeId = normalizeScopeId(input.scope, typeof input.scopeId === 'string' ? input.scopeId : '');
  const raw = await request<unknown>('POST', '/api/world-book/import', {
    scope: input.scope,
    scopeId,
    book: input.book,
  });
  const source = toRecord(raw);
  const ignored: WorldBookIgnored[] = [];
  if (Array.isArray(source.ignored)) {
    for (const entry of source.ignored) {
      const item = toWorldBookIgnored(entry);
      if (item !== null) ignored.push(item);
    }
  }
  const warnings = Array.isArray(source.warnings)
    ? source.warnings.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    scope: toScope(source.scope) ?? input.scope,
    scopeId: normalizeScopeId(input.scope, typeof source.scopeId === 'string' ? source.scopeId : scopeId),
    bookId: typeof source.bookId === 'string' ? source.bookId : '',
    name: typeof source.name === 'string' ? source.name : '',
    entryCount: toCount(source.entryCount),
    ignored,
    warnings,
    layerCount: toCount(source.layerCount),
  };
}

/** 契约 world-book：DELETE /api/world-book body { bookId } 只删这一本，同层其它书不动。 */
export function deleteWorldBook(bookId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', '/api/world-book', { bookId });
}

/** 契约 world-book：PATCH /api/world-book body { bookId, enabled } 只改这一本的整本开关。 */
export async function updateWorldBookEnabled(
  bookId: string,
  enabled: boolean,
): Promise<{ bookId: string; enabled: boolean }> {
  const raw = await request<unknown>('PATCH', '/api/world-book', { bookId, enabled });
  const source = toRecord(raw);
  return {
    bookId: typeof source.bookId === 'string' ? source.bookId : bookId,
    // 回执没写就按请求值收：切换已经成功，界面不该因为少一个字段回跳。
    enabled: typeof source.enabled === 'boolean' ? source.enabled : enabled,
  };
}

/**
 * 契约 world-book：PATCH /api/world-book body { bookId, name } 只改这一本的书名。
 * name 在这里 trim（后端同样 trim，空 / 超 80 字回 BAD_BOOK_NAME）；回执缺 name / enabled 就是坏回执。
 */
export async function renameWorldBook(
  bookId: string,
  name: string,
): Promise<{ bookId: string; name: string; enabled: boolean }> {
  const raw = await request<unknown>('PATCH', '/api/world-book', { bookId, name: name.trim() });
  const source = toRecord(raw);
  const renamed = typeof source.name === 'string' ? source.name : '';
  // 书名只有后端说了算：回执里没有它（或只有空白）就没法更新列表，别拿请求值顶上。
  if (renamed.trim() === '' || typeof source.enabled !== 'boolean') {
    throw new ApiError(0, { error: 'BAD_RESPONSE' }, '重命名成功，但接口回的形状不认识');
  }
  return {
    bookId: typeof source.bookId === 'string' && source.bookId !== '' ? source.bookId : bookId,
    name: renamed,
    enabled: source.enabled,
  };
}

/**
 * 契约 world-book：GET /api/world-book/entry?bookId&id 回 { entry }（含正文）。
 * 条目 id 只在书内唯一，bookId 才是定位键；404 WORLD_BOOK_NOT_FOUND / WORLD_ENTRY_NOT_FOUND 交给 describeWorldBookEntryError。
 */
export async function fetchWorldBookEntry(bookId: string, id: number): Promise<WorldBookEntry> {
  const params = new URLSearchParams();
  params.set('bookId', bookId);
  params.set('id', String(id));
  const raw = await request<unknown>('GET', '/api/world-book/entry?' + params.toString());
  const entry = toWorldBookEntryDetail(toRecord(raw).entry);
  if (entry === null) throw new ApiError(0, { error: 'BAD_RESPONSE' }, '读取成功，但接口回的条目形状不认识');
  return entry;
}

/**
 * 契约 world-book：PUT /api/world-book/entry body { bookId, entry } 回 { entry }。
 * entry 传完整条目（含正文与 id）；400 BAD_WORLD_ENTRY 带 detail，页面原样显示。
 */
export async function saveWorldBookEntry(bookId: string, entry: WorldBookEntry): Promise<WorldBookEntry> {
  const raw = await request<unknown>('PUT', '/api/world-book/entry', { bookId, entry });
  const saved = toWorldBookEntryDetail(toRecord(raw).entry);
  if (saved === null) throw new ApiError(0, { error: 'BAD_RESPONSE' }, '保存成功，但接口回的形状不认识');
  return saved;
}

/** POST /api/world-book/entry 的 200：新建一条，id 由服务端分配（这本书现有 max id + 1）。 */
export interface WorldBookCreateResult {
  entry: WorldBookEntry;
  /** 写进的是哪一本：带 bookId 时原样回来，新建书时是后端刚分配的 id。 */
  bookId: string;
  /** 这本书现在的名字：createdBook 为 true 时就是这次建出来的名字（可能带重名后缀）。 */
  name: string;
  entryCount: number;
  importedAt: string;
  /** true = 这一层原来没有世界书，这次顺带建了一本。 */
  createdBook: boolean;
}

/**
 * 契约 world-book：POST /api/world-book/entry。
 * 带 bookId：body 只有 { bookId, entry }，直接写进这本书。
 * 不带 bookId：body { scope, scopeId, bookName, entry }，按层新建一本，bookName 必填。
 * 请求里的 entry.id 被后端忽略（新建传 0 即可）。
 */
export async function createWorldBookEntry(input: {
  scope: Scope;
  scopeId: string;
  bookId?: string | null;
  bookName?: string | null;
  entry: WorldBookEntry;
}): Promise<WorldBookCreateResult> {
  const bookId = typeof input.bookId === 'string' ? input.bookId.trim() : '';
  const bookName = typeof input.bookName === 'string' ? input.bookName.trim() : '';
  const raw = await request<unknown>(
    'POST',
    '/api/world-book/entry',
    bookId === ''
      ? {
          scope: input.scope,
          scopeId: normalizeScopeId(input.scope, typeof input.scopeId === 'string' ? input.scopeId : ''),
          bookName: bookName === '' ? null : bookName,
          entry: input.entry,
        }
      : { bookId, entry: input.entry },
  );
  const source = toRecord(raw);
  const entry = toWorldBookEntryDetail(source.entry);
  if (entry === null) throw new ApiError(0, { error: 'BAD_RESPONSE' }, '新建成功，但接口回的条目形状不认识');
  return {
    entry,
    bookId: typeof source.bookId === 'string' ? source.bookId : bookId,
    name: typeof source.name === 'string' ? source.name : '',
    entryCount: toCount(source.entryCount),
    importedAt: typeof source.importedAt === 'string' ? source.importedAt : '',
    createdBook: source.createdBook === true,
  };
}

/**
 * 契约 world-book：DELETE /api/world-book/entry body { bookId, id }（与 DELETE /api/world-book 一样走 JSON body）。
 * removedBook: true = 删掉的是这本书最后一条，整本书被移除，同层其它书不动。
 */
export async function deleteWorldBookEntry(input: {
  bookId: string;
  id: number;
}): Promise<{ ok: true; entryCount: number; removedBook: boolean }> {
  const raw = await request<unknown>('DELETE', '/api/world-book/entry', { bookId: input.bookId, id: input.id });
  const source = toRecord(raw);
  return {
    ok: true,
    entryCount: toCount(source.entryCount),
    removedBook: source.removedBook === true,
  };
}

/** 世界书的 400 / 501 码翻成中文再显示；BAD_SCOPE 与 401 交给 describeError，别写两套文案。 */
export function describeWorldBookError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_WORLDBOOK') {
      const detail = error.payload['detail'];
      return typeof detail === 'string' && detail !== ''
        ? '这份 JSON 不是世界书：' + detail
        : '这份 JSON 不是世界书：认不出世界书或角色卡 character_book 的结构，换个文件再试';
    }
    if (error.code === 'NO_WORLD_ENTRIES') {
      const detail = error.payload['detail'];
      return typeof detail === 'string' && detail !== ''
        ? '这份世界书没有可用条目：' + detail
        : '这份世界书没有可用条目：导进来只会多一本空书，已拒绝';
    }
    if (error.code === 'WORLDBOOK_UNAVAILABLE') {
      return '服务端没接世界书能力（501）：先把库表和接口接上再导';
    }
  }
  return describeError(error);
}

/** 逐条编辑的 400 / 404 码翻成中文；认不出的码（含 BAD_SCOPE、401）交给 describeError。 */
export function describeWorldBookEntryError(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = typeof error.payload['detail'] === 'string' ? error.payload['detail'] : '';
    if (error.code === 'BAD_WORLD_ENTRY') {
      return detail !== '' ? '条目没保存：' + detail : '条目没保存：后端说字段不合法，检查一下数值范围和必填项';
    }
    if (error.code === 'BAD_BOOK_NAME') {
      return WORLD_BOOK_NAME_RULE;
    }
    if (error.code === 'BAD_BOOK_ID') {
      return '这本书的 bookId 不合法（400）：列表可能刚变过，收起表单刷新后再试';
    }
    if (error.code === 'BAD_BOOK_ENABLED') {
      return '整本开关只接受开 / 关两种值（400）：刷新页面后再试';
    }
    if (error.code === 'BAD_BOOK_UPDATE') {
      return '这次没改到任何东西（400）：enabled 与 name 至少要给一个';
    }
    if (error.code === 'WORLD_BOOK_NOT_FOUND') {
      return '这本书不见了（404）：可能刚被删除，刷新后再试';
    }
    if (error.code === 'WORLD_ENTRY_NOT_FOUND') {
      return '这条条目不见了（404）：可能刚被删除，刷新后再试';
    }
  }
  return describeError(error);
}


// 契约 timeout-settings-1：超时全部可在后台改；GET / PUT / DELETE 回同一份形状。
export interface TimeoutFieldView {
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
}

/** 全局倍率：一次把所有超时放大或缩小，单项还会被夹在它自己的上下限里。 */
export interface TimeoutMultiplierView {
  value: number;
  default: number;
  min: number;
  max: number;
}

export interface TimeoutsPayload {
  fields: TimeoutFieldView[];
  multiplier: TimeoutMultiplierView;
}

function toTimeoutNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

// 缺 key 的条目没法定位到具体项，直接丢弃；其余字段按 0 / 空串兜底，页面照常渲染。
function toTimeoutFieldView(raw: unknown): TimeoutFieldView | null {
  const source = toRecord(raw);
  const key = typeof source.key === 'string' ? source.key : '';
  if (key === '') return null;
  return {
    key,
    env: typeof source.env === 'string' ? source.env : '',
    label: typeof source.label === 'string' && source.label !== '' ? source.label : key,
    detail: typeof source.detail === 'string' ? source.detail : '',
    defaultMs: toTimeoutNumber(source.defaultMs, 0),
    minMs: toTimeoutNumber(source.minMs, 0),
    maxMs: toTimeoutNumber(source.maxMs, 0),
    valueMs: toTimeoutNumber(source.valueMs, 0),
    // 生效值由后端乘过倍率，前端不自己算，免得两边口径漂移
    effectiveMs: toTimeoutNumber(source.effectiveMs, 0),
    overridden: source.overridden === true,
  };
}

function toTimeoutsPayload(raw: unknown): TimeoutsPayload {
  const source = toRecord(raw);
  const rawFields = Array.isArray(source.fields) ? source.fields : [];
  const fields: TimeoutFieldView[] = [];
  for (const item of rawFields) {
    const field = toTimeoutFieldView(item);
    if (field !== null) fields.push(field);
  }
  const multiplier = toRecord(source.multiplier);
  return {
    fields,
    multiplier: {
      value: toTimeoutNumber(multiplier.value, 1),
      default: toTimeoutNumber(multiplier.default, 1),
      min: toTimeoutNumber(multiplier.min, 0.1),
      max: toTimeoutNumber(multiplier.max, 10),
    },
  };
}

/** GET /api/timeouts：每项的基线 / 生效值 / 上下限，加全局倍率。 */
export async function fetchTimeouts(): Promise<TimeoutsPayload> {
  return toTimeoutsPayload(await request<unknown>('GET', '/api/timeouts'));
}

/** PUT /api/timeouts：整份九项 + multiplier 一起提交，少一项后端就回 400。 */
export async function saveTimeouts(values: Record<string, number>): Promise<TimeoutsPayload> {
  return toTimeoutsPayload(await request<unknown>('PUT', '/api/timeouts', values));
}

/** DELETE /api/timeouts：清掉所有覆盖 = 恢复 .env 与内置默认，回同一份形状。 */
export async function resetTimeouts(): Promise<TimeoutsPayload> {
  return toTimeoutsPayload(await request<unknown>('DELETE', '/api/timeouts'));
}

// 契约 timeout-settings-1 唯一的 400 码翻成中文；401 走 describeError 的中文提示。
export function describeTimeoutRejection(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_TIMEOUT_SETTINGS') {
      return '超时值不合法：每项都要是数字并落在它自己的范围里，倍率在 0.1–10 之间';
    }
    if (error.status === 401) return describeError(error);
  }
  return '保存超时配置失败：' + describeError(error);
}
