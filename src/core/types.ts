export type ProviderId = 'openai-compat' | 'anthropic' | 'gemini';
export type Scope = 'global' | 'guild' | 'channel';
export type Role = 'system' | 'user' | 'assistant';

export interface ScopedKey { scope: Scope; scopeId: string }        // global 的 scopeId 恒为 ''

/** 一条消息回复了谁（Discord referenced_message 的摘要） */
export interface ReplyRef {
  /** 被回复消息 id */
  messageId: string;
  /** 被回复人显示名，可能为空串 */
  author: string;
  /** 被回复人 Discord 用户 ID，可能为空串 */
  authorId: string;
  /** 被回复原文（库里存全文，进提示词时由 core 截断到 REPLY_EXCERPT_CHARS） */
  content: string;
}

/** 服务器自定义表情（只保留可用的） */
export interface CustomEmoji {
  name: string;
  id: string;
  animated?: boolean;
  /** 认图生成的中文短描述（§23）；缺省表示还没认过，提示词里只出现名字 */
  description?: string;
  /** 管理员手工配的别名（§24），例如 laugh 也可以叫「奶龙」；缺省表示没有别名 */
  aliases?: string[];
}

/** 一个自定义表情的认图结果（§23.2）：按 (guildId, emojiId) 唯一 */
export interface EmojiDescription {
  emojiId: string;
  name: string;
  description: string;
  updatedAt: string;   // ISO
}

/** 一次认图任务的计数（§23.6）：给后台回执用，不区分「哪个失败」 */
export interface EmojiDescribeResult {
  described: number;
  failed: number;
}

/** 管理员手工配的表情别名（§24.2）：按 (guildId, alias) 唯一，一条别名指向一个真实表情 */
export interface EmojiAlias {
  /** 别名本身，例如「奶龙」 */
  alias: string;
  /** Discord 表情 ID */
  emojiId: string;
  /** 表情真实名字，例如 laugh */
  emojiName: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** 发言人名字；迁移前的老数据为 NULL，读侧留空（undefined），拼前缀时按「无名字」处理 */
  author?: string;
  /** 发言人 Discord 用户 ID；有值时前缀拼成「<名字>(<id>)：<正文>」，用来区分同名用户 */
  authorId?: string;
  /** 落库时刻（ISO 字符串）；有值时拼成「[MM-DD HH:mm] 」前缀，让模型分得清先后与间隔 */
  createdAt?: string;
  /** 这条消息回复了谁；非回复或老数据没有该键 */
  replyTo?: ReplyRef;
  /** Discord 里那条消息的 id；只用于后台删除时精确定位，迁移前的老行没有 */
  discordId?: string;
}
export interface ModelRef { provider: ProviderId; model: string }

/** messages 与 conversation_summaries 共同的维度键 */
export interface ChannelKey { guildId: string; channelId: string }

export interface ConversationSummary {
  guildId: string;
  channelId: string;
  summary: string;
  /** 已总结到 messages.id 的最大值：下次只捞比它新的消息，summary 才能接着往后长 */
  coveredUntilId: number;
  /** 这段记忆里最早一条消息的落库时刻（ISO）：摘要段头要写「这些话是什么时候说的」；老行可缺 */
  coveredFrom?: string;
  /** 这段记忆里最晚一条消息的落库时刻（ISO） */
  coveredTo?: string;
  updatedAt: string;   // ISO（摘要生成的时刻，只用于后台展示，不再进提示词）
}

/** 带主键的历史行：摘要游标要靠 id 递增才能只吃「新增」那一段 */
export interface StoredMessage extends ChatMessage {
  id: number;
  /** §62：单行读时带回所在频道（列表类 SELECT 不带）；后台删这条记忆要按它去 Discord 定位 */
  channelId?: string;
}

export interface SummaryOutcome {
  summary: string;
  coveredUntilId: number;
  summarizedMessages: number;
  model: string;
}

/**
 * §63 后台「连续总结」一批的结果：outcome 是本批做了什么（没有素材时是 null），
 * remaining 是游标之后还剩多少条没进记忆——前端只认这两个数，自己决定要不要接着发下一批。
 */
export interface SummarySweepOutcome {
  outcome: SummaryOutcome | null;
  remaining: number;
}

/**
 * §35 后台「选择性补记」预览：先让管理员看清这一段到底有多大、大概说到哪，
 * 再决定要不要花一次模型调用。samples 只是给人看的，绝不进提示词。
 */
export interface BackfillPreview {
  count: number;      // 命中条数；超过上限时只报到上限+1
  tooLarge: boolean;  // count > 一次上限（500）
  firstAt?: string;   // 首条 createdAt
  lastAt?: string;    // 末条 createdAt
  samples: string[];  // 首尾各最多 3 条，一行一条，形如「[2026-10-27 21:03] 苏朕莹：正文前 40 字」
}

/** §35 补记结果：只报「补了哪一段、补完记忆多长、用的哪个模型」，游标不在这里出现（它没动） */
export interface BackfillOutcome {
  summarizedMessages: number;
  from: string;
  to: string;
  summaryLength: number;      // 补记后该频道记忆总字数
  model: string;
}

/** 一段被挑中的历史：两个 ISO 端点，闭区间 */
export interface TimeRange { from: string; to: string }

/**
 * 频道级记忆配置（§26）：没有行 = 用代码默认（最近 50 条原文、每 50 条未总结消息总结一次）。
 * 有行就整行生效，不做逐字段合并（后台保存时两个字段一起提交）。
 */
export interface ChannelMemoryConfig {
  guildId: string;
  channelId: string;
  /** 注入最近多少条原文，≥ 2，不设上限 */
  historyMaxMessages: number;
  /** 未总结消息攒到多少条触发自动总结；0 = 关闭自动总结（/summary 手动仍可用），否则 ≥ 2，不设上限 */
  summaryEveryMessages: number;
  /** 摘要正文注入 system 的字符预算，500..20000；缺省 = 未设置（运行时用 SUMMARY_MAX_CHARS = 4000） */
  summaryMaxChars?: number;
  /** 频道级「上下文工具」模式（§55）：true = 预设/摘要/历史全塞进 context 工具描述、只发一条 user 轮次；缺省 = 老形状 */
  contextTool?: boolean;
  /** 保存时刻（ISO）；空串 = 这一行是按默认值临时拼出来的，库里还没有 */
  updatedAt: string;
}

export type PromptRole = 'system' | 'user';
/** 段放进 system 的位置：摘要块之前 / 之后；只有 role='system' 的段看它 */
export type PromptPlacement = 'before' | 'after';

/** 一层提示词由若干段拼成：每段可开关、可排序、可选角色与放置位置（§11） */
export interface PromptSegment {
  id: string;
  name: string;
  role: PromptRole;
  content: string;
  enabled: boolean;
  placement: PromptPlacement;
  position: number;
}

export interface PromptConfig {
  segments: PromptSegment[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * 两份兜底文案的 key：fallback = 三层全空时的「内置默认」层，identity = 每轮追加的「当前对话」块。
 * 库里只认这两个值，读侧遇到别的 key 直接忽略。
 */
export type PromptDefaultKey = 'fallback' | 'identity';

export interface PromptDefaultEntry {
  key: PromptDefaultKey;
  scope: Scope;
  /** global 恒为 ''，guild / channel 是 Discord 的服务器 / 频道 id */
  scopeId: string;
  /** 原样保存的模板正文（保留换行），不是一行摘要 */
  content: string;
  updatedAt: string;
}

/** 一层（channel / guild / global）里的两份兜底文案；这层没配的 key 给 null（= 往下一层或代码默认找） */
export interface PromptDefaultsScope {
  fallback: PromptDefaultEntry | null;
  identity: PromptDefaultEntry | null;
}

/** 三层兜底文案；装配顺序 channel > guild > global，三层都没有才用代码默认 */
export interface PromptDefaults {
  channel: PromptDefaultsScope;
  guild: PromptDefaultsScope;
  global: PromptDefaultsScope;
}

export interface RouteConfig {
  primary: ModelRef;
  fallbacks: ModelRef[];
  temperature?: number;
  maxTokens?: number;
  // 采样参数：缺省 = 这一层不设，线缆上不出现该键；0 是有效值，不能用 ?? 兜底
  topP?: number;
  topK?: number;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  // 思考强度：缺省 = 这一层不设；上下文工具模式仍回退到 low，普通模式不发这个键
  reasoningEffort?: string;
}

export interface ProviderKey {
  id: string;
  provider: ProviderId;
  label: string;
  baseUrl?: string;
  keyHint: string;      // 形如 "sk-…ab12"，永不包含完整密钥
  enabled: boolean;
  createdAt: string;    // ISO8601
  models: string[];     // 适用模型名单；空数组 = 全部模型都可用（§20.2）
}

export interface DecryptedKey {
  id: string;
  provider: ProviderId;
  label: string;        // 用户起的备注，可进日志（永不含密钥）
  baseUrl?: string;
  apiKey: string;
  models: string[];     // 适用模型名单（§20.2）
}

/**
 * 一张随本轮送给模型的内联图片（§22）。只给表情模型用：不落库、不进历史与摘要。
 * 用 base64 而不是 URL，是因为 Anthropic 只收 base64、Gemini 要 inlineData，只有 OpenAI 兼容能直传 URL。
 */
export interface LlmImage {
  /** MIME 类型，例如 image/png（网关按附件的 content_type 取，缺失时按扩展名猜） */
  mediaType: string;
  /** 原始字节的 base64；不带 data: 前缀、不含换行 */
  base64: string;
}

/** 一条函数工具定义：只有频道预设点名要时才随请求发上去（其余频道的请求体里不出现） */
export interface ChatToolFunction {
  name: string;
  description: string;
  /** JSON Schema（对象形状）：适配器原样序列化，不做校验也不做改写 */
  parameters: Record<string, unknown>;
}

export interface ChatTool {
  type: 'function';
  function: ChatToolFunction;
}

/**
 * 结构化输出（response_format）：openai-compat 适配器原样放进请求体，由中继翻成上游的
 * response_mime_type / response_schema；不发这个键的通道（Anthropic）静默忽略，解析侧仍须兜底纯文本。
 */
export type LlmResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        /** 上游用它给 schema 起名，只放 ASCII 字母数字与下划线 */
        name: string;
        /** JSON Schema 对象：适配器原样序列化，不做校验也不做改写 */
        schema: Record<string, unknown>;
      };
    };

export interface LlmRequest {
  model: string;
  system: string;
  messages: ChatMessage[];   // 不含 system
  temperature?: number;
  maxTokens?: number;
  // 采样参数：缺省 = 请求体里不出现该键（三个适配器各认一部分）；0 是有效值
  topP?: number;
  topK?: number;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** 推理强度（reasoning_effort）：缺省或空串 = 请求体里不出现该键；只有认这个键的适配器才发 */
  reasoningEffort?: string;
  /**
   * 本轮附带的图片（§22.3）：适配器只把它们附加到最后一条 role==='user' 的消息上；
   * 没有 user 消息时整段忽略（绝不凭空造一条消息）。缺省 = 纯文本，线缆形状与旧版完全一致。
   */
  images?: LlmImage[];
  /** 本轮可用的工具：缺省 / 空数组 = 请求体里不出现 tools（线缆形状与旧版逐字一致） */
  tools?: readonly ChatTool[];
  /**
   * 工具选择策略：只有 tools 非空时才可能上线缆（tools 为空时静默忽略）。
   * 对象形式 = 强制调用某一个函数；上游不一定支持（例如 DeepSeek 思考模式会 400）。
   */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  /**
   * 结构化输出：缺省 = 请求体里不出现 response_format，旧线缆形状逐字不变。
   * 只有认这个键的适配器（openai-compat）会发；拿不到结构化保证的通道回纯文本，解析侧必须留着老路。
   */
  responseFormat?: LlmResponseFormat;
}

/**
 * §55 流式分片里一次工具调用的增量：name 通常只在第一帧给，arguments 是半截 JSON，
 * 由上层按 index 拼回完整参数。
 */
export interface ToolCallDelta {
  index: number;
  /** 名字缺省 = 这一帧没带名字（只在第一次拿到非空值时才认） */
  name?: string;
  /** 参数分片，可能是半截 JSON；这一帧没带参数时是空串 */
  arguments: string;
}

export interface LlmChunk {
  delta: string;
  /**
   * 上游给的结束原因：stop / length / MAX_TOKENS / end_turn 等；没有就是没收到收尾帧。
   * 带结束原因的那一帧即使 delta 为空也会产出一次——「写完了」与「被掐断」只靠它区分。
   */
  finishReason?: string;
  /**
   * §55 工具调用增量：只有流里真的出现 tool_calls 分片时才带这个键。
   * 老消费者不看它，分片的形状与改动前逐字相同。
   */
  toolCallDelta?: ToolCallDelta;
}
/** 上游返回的一次工具调用：名字 + 原始 JSON 参数字符串（不解析、不改写） */
export interface ChatToolCall {
  name: string;
  arguments: string;
}

export interface LlmResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 非流式响应里的工具调用（§55）：只有上下文工具模式读它；缺省 = 上游没调工具 */
  toolCalls?: ChatToolCall[];
}

export interface ProviderRuntime {
  apiKey: string;
  baseUrl?: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: ProviderId;
  chat(req: LlmRequest, rt: ProviderRuntime): Promise<LlmResult>;
  chatStream(req: LlmRequest, rt: ProviderRuntime): AsyncIterable<LlmChunk>;
  listModels(rt: ProviderRuntime): Promise<string[]>;
}

/** 一次对话的输入上下文 */
export interface TurnContext {
  guildId: string;
  channelId: string;
  userId: string;
  userName: string;
  guildName: string;
  channelName: string;
  botName: string;
  /** 本轮真正发给模型的文本（空 @ 时是一句事实标记，不是替用户编的话） */
  userText: string;
  /**
   * 只用于落库/进记忆的原文；缺省等于 userText。
   * 留给「提示里的话与用户真说了什么不一致」的场合（空 @ 那轮已不编话，不再用它）。
   */
  storedUserText?: string;
  /** 本轮这条消息回复了谁（网关解析 referenced_message 得到）；非回复时缺省 */
  replyTo?: ReplyRef;
  /** 触发这一轮的那条 Discord 消息 id：跟着历史行落库，后台删单条时靠它精确删 Discord 那条 */
  userDiscordId?: string;
  /** 该服务器可用的自定义表情（网关注入，10 分钟缓存）；空或缺省时提示词里没有表情段 */
  customEmojis?: CustomEmoji[];
  /**
   * 是否为本轮额外问一次「表情模型」（§21）。只有网关普通消息路径设 true：
   * 斜杠命令没有可贴表情的触发消息，也就不必多花一次调用。
   */
  wantReactions?: boolean;
  /**
   * 懒加载本轮可看的图片（§22.4、§22.9）：主对话与表情模型共用同一个 promise（turn 级 memo），
   * 一轮只真实下载一次；没有图片引用时网关干脆不设这个键。抛错按「没有图」处理，绝不影响回复。
   */
  loadImages?: () => Promise<LlmImage[]>;
  /**
   * §41 主模型这一轮能不能看图：缺省当 true（开关没配 = 与加开关之前一致）。
   * false 时主请求不带 images，表情模型那一路不看这个字段，仍能看同一轮的图。
   */
  mainImages?: boolean;
  /**
   * 这一轮允许贴表情的候选消息（§28）：最近 10 条频道消息 + 触发那条 + 被回复那条。
   * 缺省=没有清单，模型只能用缺省目标（触发那条）；斜杠命令也不设。
   */
  reactionTargets?: ReactionTarget[];
  /**
   * 这一轮语音是「按指令」模式（mode 1）才挂 true：提示词里才会多出【语音】那段，
   * 教模型想被念出来就单独写一行 [[voice]]。
   * 缺省 = 不出现语音提示段，普通消息的提示词与加这个字段之前逐字相同。
   */
  voiceHint?: boolean;
}

/**
 * 一条「贴表情」请求（§28）：`[[react:😄]]` 只带表情，`[[react:😄@<消息ID>]]` 还带目标。
 * 表情名与目标是两个字段，网关不必再回头拆字符串。
 */
export interface ReactionRequest {
  emoji: string;
  /** 目标消息的 Discord ID；缺省=贴到触发这一轮的那条消息 */
  messageId?: string;
  /** 模型写的是 `@作者名`（§28.3）：core 不认人，原样带到网关由它按清单解析 */
  authorName?: string;
  /**
   * 模型点名「给大家贴」（`@all` 一类写法，§28.9）：由执行侧按最近发言者展开成每人一条。
   * 展开前不带 messageId / authorName；展开后这个字段不再出现。
   */
  broadcast?: boolean;
}

/** 这一轮允许贴表情的候选消息（§28）。网关把最近消息注入提示词，模型只能在这里面挑 */
export interface ReactionTarget {
  /** Discord 消息 ID（不是 D1 的行 id） */
  messageId: string;
  /** 展示名，用于「@作者名」这种兜底写法 */
  author: string;
  authorId: string;
  /** 正文前 30 字，给模型认消息用 */
  excerpt: string;
  /** 这条是不是机器人（含我们自己）发的：自动分散时跳过，别把表情贴到自己的消息上（§28.9） */
  bot?: boolean;
}

export interface TurnAttempt { model: ModelRef; error: string }
export interface TurnResult {
  text: string;
  model: ModelRef;
  attempts: TurnAttempt[];     // 失败过的候选，按尝试顺序
  promptScope: Scope;          // 实际命中的提示词层级
  routeScope: Scope;           // 实际命中的路由层级
  /** 模型要求贴的表情，去重保序，最多 MAX_REACTIONS 个；空数组表示不贴（§28） */
  reactions: ReactionRequest[];
  /** 本轮模型写了 [[voice]]：语音开关为「按指令」时靠它决定要不要念 */
  voiceRequested?: boolean;
  /** 本轮模型调了 draw_image：图已生成，网关直接以附件发出（text 通常为空） */
  image?: { data: Uint8Array; mime: string; prompt: string };
}

/** 运行日志级别（§19） */
export type LogLevel = 'info' | 'warn' | 'error';

/** 日志域：固定这几个值，后台按域过滤；新增域要先改这里 */
export type LogScope = 'chat' | 'provider' | 'summary' | 'gateway' | 'admin';

/** 写入日志表的一行；严禁写入消息正文、口令、密钥、完整 Key */
export interface LogEntry {
  level: LogLevel;
  scope: LogScope;
  message: string;
  createdAt: string;   // ISO
}

/** 读出的一条日志；id 单调递增，后台按 after=id 增量轮询 */
export interface StoredLogEntry extends LogEntry { id: number }
/** 贴表情提示词的一层配置（§28.10）：三层整组覆盖，正文非空才算有配置 */
export interface ReactionGuideConfig {
  scope: Scope;
  scopeId: string;
  prompt: string;
  updatedAt: string;
}

/** 正文表情提示词的一层配置：三层整组覆盖，正文非空才算有配置 */
export interface BodyEmojiGuideConfig {
  scope: Scope;
  scopeId: string;
  prompt: string;
  updatedAt: string;
}

/** 表情模型素材模板的一层配置（§34.2）：三层整组覆盖，模板非空才算有配置 */
export interface ReactionTemplateConfig {
  scope: Scope;
  scopeId: string;
  template: string;
  updatedAt: string;
}

/** §38 假流式切片次数的三层配置：0 = 关闭，0–10；行不存在 = 这一层没配置，由 core 落回上一层 */
export interface RevealStepsConfig {
  scope: Scope;
  scopeId: string;
  revealSteps: number;
  updatedAt: string;
}

/**
 * 语音回复的三层配置：行不存在 = 这一层没配置，由 core 落回上一层；mode 0 = 不念，1 = 按指令，2 = 每条都念。
 * director 决定念之前要不要先按导演规则改写：0 = 关（逐字朗读），1 = 只许插标签，2 = 允许顺句改写。
 */
export interface VoiceSettingsConfig {
  scope: Scope;
  scopeId: string;
  mode: number;
  voice: string;
  speed: number;
  director: number;
  updatedAt: string;
}

/**
 * 语音合成的上游方言：openai = POST {url}/audio/speech（mp3），
 * mimo = POST {url}/chat/completions（JSON 里的 base64 mp3），
 * gemini = POST {url}/audio/speech（整段 WAV，超时放宽）。
 */
export type TtsDialect = 'openai' | 'mimo' | 'gemini';

/** 语音合成接口（TTS）的运行时配置：key / judgeKey 是解密后的明文，只在仓储内部与运行时出现 */
export interface TtsSettingsSecret {
  /** 决定请求形状与内置默认模型（后台不再能改这个值） */
  dialect: TtsDialect;
  url: string;
  key: string;
  /** 历史列：读侧仍带出，合成时一律按方言取内置默认，不再参与请求 */
  model: string;
  voice: string;
  /** 判断情绪用的 OpenAI 兼容地址；三字段都非空才算配好了 judge */
  judgeUrl: string;
  /** judge 的明文密钥，只在仓储内部与运行时出现 */
  judgeKey: string;
  judgeModel: string;
  updatedAt: string;
}

/** GET /api/tts-settings 的形状：key 只给掩码（keyHint），绝不含明文 */
export interface TtsSettingsView {
  /** 方言原样回显，后台据此切换默认值与音色清单 */
  dialect: TtsDialect;
  url: string;
  keyHint: string;
  voice: string;
  judgeUrl: string;
  judgeKeyHint: string;
  judgeModel: string;
  updatedAt: string;
}

/** PUT /api/tts-settings 的入参：key / judgeKey 省略 = 保留库里已有的密文与掩码；dialect 省略 = 不改方言（旧值为空按 openai） */
export interface TtsSettingsInput {
  dialect?: string;
  url: string;
  key?: string;
  /** 历史字段：HTTP 与仓储都不再写它，库里旧值原样保留，只为形状兼容留着 */
  model?: string;
  voice?: string;
  judgeUrl?: string;
  judgeKey?: string;
  judgeModel?: string;
}

/** 语气提示词的一层：channel / guild / global 各至多一行，读侧按 channel -> guild -> global 取第一个非空 */
export interface TtsStyleLayer {
  scope: Scope;
  scopeId: string;
  content: string;
  updatedAt: string;
}

/**
 * 深度注入的一层（SillyTavern depth_prompt 语义）：往本轮 messages 的倒数第 depth 条之前插一条合成消息。
 * content 空白 = 这一层关着，读侧继续往下找；三层都没有就什么都不插。
 */
export interface PromptInjectionConfig {
  scope: Scope;
  scopeId: string;
  content: string;
  depth: number;
  role: Role;
  updatedAt: string;
}

/** §41 主模型识图的三层开关：行不存在 = 这一层没配置，由 core 落回上一层 */
export interface VisionSettingsConfig {
  scope: Scope;
  scopeId: string;
  enabled: boolean;
  updatedAt: string;
}

/**
 * 生图自定义的一层：model / baseUrl 为空 = 这一项沿用上层或默认值；
 * keyHint 是 apiKey 的掩码，GET 与列表只回它，明文只出现在 ImageSettingsSecret 里。
 */
export interface ImageSettingsView {
  scope: Scope;
  scopeId: string;
  model: string;
  baseUrl: string;
  keyHint: string;
  updatedAt: string;
}

/** 运行时读出来的这一层：apiKey 是解密后的明文，绝不能进 HTTP 响应 */
export interface ImageSettingsSecret extends ImageSettingsView {
  apiKey: string;
}

/** PUT /api/image-settings 的入参：apiKey 省略 = 保留原密文；空串 = 清掉本层 Key */
export interface ImageSettingsInput {
  scope: Scope;
  scopeId: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/** 表情选择的独立模型（§21）：enabled=false 表示不问表情模型，只剩主模型自己的 [[react:]] */
export interface ReactionModelConfig {
  enabled: boolean;
  provider: ProviderId;
  model: string;
}

/**
 * 手动备份的请求文件（宿主 <data>/backup-request.json）：后台只写这一份，
 * 真正的打包与上传由宿主侧每分钟的 timer 跑 scripts/backup-to-drive.sh。
 */
export interface BackupRequest {
  id: string;
  requestedAt: string;
}

/** 一次备份的进度：running 由脚本开跑时写，done / failed 是终态 */
export type BackupPhase = 'running' | 'done' | 'failed';

/** 状态文件（宿主 <data>/backup-status.json）：终态才带 finishedAt 之后的字段，缺省就整键省略 */
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

/** GET /api/backup 的整份快照：两个文件各自独立，读不到的那一半是 null */
export interface BackupSnapshot {
  request: BackupRequest | null;
  status: BackupStatus | null;
}
/**
 * PG 中继最近一条报错（后台只读列表）：只带排错要用的字段，
 * 不含 prompt 正文、图片 base64、完整 key 与 Authorization 头。
 */
export interface PgErrorEntry {
  /** ISO 时间串 */
  at: string;
  status: number;
  code: string;
  /** 已截断到 500 字符 */
  message: string;
  model?: string;
  /** 中继侧已用 maskKey 处理过的短 key */
  key?: string;
  durationMs?: number;
  requestId?: string;
}

/** GET /api/pg-errors 的整份快照：items 新→旧，条数 ≤ limit，dropped 是累计被挤掉的条数 */
export interface PgErrorFeed {
  limit: number;
  dropped: number;
  items: PgErrorEntry[];
}

