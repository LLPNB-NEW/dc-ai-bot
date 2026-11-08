import type {
  BackupRequest,
  BackupSnapshot,
  BodyEmojiGuideConfig,
  ChannelKey,
  ChannelMemoryConfig,
  ReactionModelConfig,
  LogEntry,
  StoredLogEntry,
  ChatMessage,
  ConversationSummary,
  EmojiAlias,
  EmojiDescription,
  DecryptedKey,
  PromptConfig,
  PromptDefaultEntry,
  PromptDefaultKey,
  PromptDefaultsScope,
  ProviderId,
  ReactionGuideConfig,
  ReactionTemplateConfig,
  RevealStepsConfig,
  ProviderKey,
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
} from './types';

export interface PromptRepository {
  get(key: ScopedKey): Promise<PromptConfig | null>;
  list(): Promise<Array<PromptConfig & ScopedKey>>;
  put(key: ScopedKey, cfg: PromptConfig): Promise<void>;
  remove(key: ScopedKey): Promise<void>;
}

/**
 * 两份兜底文案（fallback / identity）三层配置：channel > guild > global，主键是 (key, scope, scope_id)。
 * 这一层没有行 = 往下层找，三层都没有才用代码里的默认（DEFAULT_PROMPT / 身份块），所以 remove 就是「恢复这一层的默认」。
 */
export interface PromptDefaultsStore {
  /** 读某一层；这层没配的 key 给 null，别的 key 直接忽略 */
  get(key: ScopedKey): Promise<PromptDefaultsScope>;
  /** 全部层的全部行，供后台列表；排序不重要 */
  list(): Promise<PromptDefaultEntry[]>;
  /** 覆盖写（同 key+scope+scopeId 覆盖）；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(entry: { key: PromptDefaultKey; scope: Scope; scopeId: string; content: string }): Promise<PromptDefaultEntry>;
  /** 恢复这一层的代码默认（删行）；不存在时静默成功 */
  remove(key: ScopedKey & { key: PromptDefaultKey }): Promise<void>;
}

export interface RouteRepository {
  get(key: ScopedKey): Promise<RouteConfig | null>;
  list(): Promise<Array<RouteConfig & ScopedKey>>;
  put(key: ScopedKey, cfg: RouteConfig): Promise<void>;
  remove(key: ScopedKey): Promise<void>;
}

export interface KeyRepository {
  list(): Promise<ProviderKey[]>;
  /**
   * 指定 provider 下**所有** enabled 的 key，按 created_at,id 升序（§20.2）。
   * 排序偏好（模型名单命中优先）由 core 的 orderKeysForModel 决定，仓储只负责取全。
   */
  listEnabled(provider: ProviderId): Promise<DecryptedKey[]>;
  getDecrypted(id: string): Promise<DecryptedKey | null>;
  create(input: {
    provider: ProviderId;
    label: string;
    baseUrl?: string;
    apiKey: string;
    models?: string[];
  }): Promise<ProviderKey>;
  remove(id: string): Promise<void>;
}

export interface ConversationStore {
  /** 最近的 limit 条，时间正序；author 为说话人名字，老数据缺失时留空 */
  loadRecent(key: ChannelKey, limit: number): Promise<ChatMessage[]>;
  /** 该频道全部消息，按 id 正序（进上下文前由字符安全阀裁剪，不做 LIMIT） */
  loadAll(key: ChannelKey): Promise<ChatMessage[]>;
  /** 追加写入；author 落到 author_name 列，未传或空白写 NULL */
  append(key: ChannelKey, messages: ChatMessage[]): Promise<void>;
  /** 清空该频道全部原文（/reset 用；摘要由 SummaryStore.remove 清） */
  clear(key: ChannelKey): Promise<void>;
  /** id 大于 afterId 的消息，时间正序，最多 limit 条（不传取全部）；带 id 供摘要游标使用 */
  loadAfter(key: ChannelKey, afterId: number, limit?: number): Promise<StoredMessage[]>;
  /** 最新 limit 条，返回时翻成正序（id 升序）；后台「楼层点选」用（§25.2） */
  loadLatest(key: ChannelKey, limit: number): Promise<StoredMessage[]>;
  /** createdAt 落在 [fromIso, toIso]（含端点）的消息，id 升序，最多 limit 条；后台「选择性补记」选范围用（§35） */
  loadBetween(key: ChannelKey, fromIso: string, toIso: string, limit: number): Promise<StoredMessage[]>;
  /**
   * §62 后台单条删除用的三个能力：可选 —— 只读/假仓储（测试、回放）不必实现，
   * 后台接口在缺这三个方法时直接回 501，而不是假装删掉了。
   */
  getById?(id: number): Promise<StoredMessage | null>;
  removeById?(id: number): Promise<boolean>;
  /** 给「刚落库的那条 assistant」补记 Discord 消息 id：按频道 + 正文精确命中最新一行，命中不到静默不动 */
  attachDiscordId?(key: ChannelKey, content: string, discordId: string): Promise<void>;
  /**
   * 这个频道最近一次落库时所在的服务器 id；从没说过话返回 null。
   * 复制提示词预设要从频道反查它属于哪个服务器（请求里只有频道 id）；假仓储可以不实现：缺了就当查不到，跳过服务器层
   */
  guildOfChannel?(channelId: string): Promise<string | null>;
}

/** 摘要按 (guild, channel) 唯一：一个频道一条，覆盖写就是「记忆被重新压缩」 */
/** 频道级记忆配置（§26.2）：一个频道一行，没有行就用代码默认 */
export interface ChannelMemoryStore {
  get(key: ChannelKey): Promise<ChannelMemoryConfig | null>;
  list(): Promise<ChannelMemoryConfig[]>;
  /** 覆盖写；updatedAt 由仓储补写入时刻 */
  put(cfg: Omit<ChannelMemoryConfig, 'updatedAt'>): Promise<ChannelMemoryConfig>;
  /** 恢复默认（删行）；不存在时静默成功 */
  remove(key: ChannelKey): Promise<void>;
}

export interface SummaryStore {
  get(key: ChannelKey): Promise<ConversationSummary | null>;
  /** 全表，按 guild_id, channel_id 升序；后台摘要列表用（§25.2） */
  list(): Promise<ConversationSummary[]>;
  put(entry: ConversationSummary): Promise<void>;
  remove(key: ChannelKey): Promise<void>;
}

/** 运行日志（§19）：D1 环形表，只保留最近 keep 条；写失败绝不能影响业务 */
export interface LogStore {
  append(entries: LogEntry[]): Promise<void>;
  /** id 大于 afterId 的日志，按 id 升序，最多 limit 条 */
  list(afterId: number, limit: number): Promise<StoredLogEntry[]>;
}

/** 表情描述（§23.2）：按服务器维度存，认一次用很久；不认识的表情不会出现在这里 */
export interface EmojiDescriptionStore {
  list(guildId: string): Promise<EmojiDescription[]>;
  /** 覆盖写；updatedAt 由仓储按写入时刻补，调用方不用传 */
  putMany(guildId: string, rows: ReadonlyArray<Omit<EmojiDescription, 'updatedAt'>>): Promise<void>;
}

/** 表情别名（§24.2）：管理员手工配，一个别名只指向一个表情 */
export interface EmojiAliasStore {
  list(guildId: string): Promise<EmojiAlias[]>;
  /** 覆盖写：同 (guildId, alias) 重复添加只更新指向 */
  put(guildId: string, alias: EmojiAlias): Promise<void>;
  /** 别名不存在时静默成功 */
  remove(guildId: string, alias: string): Promise<void>;
}

export interface SecretBox {
  encrypt(plaintext: string): Promise<string>;   // 返回 "v1.<ivB64>.<ctB64>"
  decrypt(blob: string): Promise<string>;
}

/**
 * 贴表情提示词的三层配置（§28.10）：global / guild / channel 各至多一行，命中哪层整份用哪层。
 * 行不存在或正文 trim 为空都等于「这一层没有配置」，由 core 落回上一层。
 */
export interface ReactionGuideStore {
  get(key: ScopedKey): Promise<ReactionGuideConfig | null>;
  /** 全表，后台列表用 */
  list(): Promise<ReactionGuideConfig[]>;
  /** 覆盖写；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(cfg: Omit<ReactionGuideConfig, 'updatedAt'>): Promise<ReactionGuideConfig>;
  /** 恢复上层（删行）；不存在时静默成功 */
  remove(key: ScopedKey): Promise<void>;
}

/**
 * 正文表情提示词的三层配置：global / guild / channel 各至多一行，命中哪层整份用哪层。
 * 行不存在或正文 trim 为空都等于「这一层没有配置」，由 core 落回上一层。
 */
export interface BodyEmojiGuideStore {
  get(key: ScopedKey): Promise<BodyEmojiGuideConfig | null>;
  /** 全表，后台列表用 */
  list(): Promise<BodyEmojiGuideConfig[]>;
  /** 覆盖写；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(cfg: Omit<BodyEmojiGuideConfig, 'updatedAt'>): Promise<BodyEmojiGuideConfig>;
  /** 恢复上层（删行）；不存在时静默成功 */
  remove(key: ScopedKey): Promise<void>;
}

/**
 * 表情模型素材模板的三层配置（§34.2）：global / guild / channel 各至多一行，命中哪层整份用哪层。
 * 行不存在或模板 trim 为空都等于「这一层没有配置」，由 core 落回上一层。
 */
export interface ReactionTemplateStore {
  get(key: ScopedKey): Promise<ReactionTemplateConfig | null>;
  /** 全表，后台列表用 */
  list(): Promise<ReactionTemplateConfig[]>;
  /** 覆盖写；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(cfg: Omit<ReactionTemplateConfig, 'updatedAt'>): Promise<ReactionTemplateConfig>;
  /** 恢复上层（删行）；不存在时静默成功 */
  remove(key: ScopedKey): Promise<void>;
}

/**
 * §38 假流式切片次数的三层配置：global / guild / channel 各至多一行，命中哪层用哪层。
 * 行不存在或数值不在 0–10 都等于「这一层没有配置」，由 core 落回上一层。
 */
export interface ReplySettingsStore {
  get(key: ScopedKey): Promise<RevealStepsConfig | null>;
  /** 全表，后台列表用 */
  list(): Promise<RevealStepsConfig[]>;
  /** 覆盖写；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(cfg: Omit<RevealStepsConfig, 'updatedAt'>): Promise<RevealStepsConfig>;
  /** 恢复上层（删行）；不存在时静默成功 */
  remove(key: ScopedKey): Promise<void>;
}

/**
 * 语音回复的三层配置：global / guild / channel 各至多一行，命中哪层用哪层。
 * 行不存在或 mode 不是 0/1/2 都等于「这一层没有配置」，由 core 落回上一层。
 */
export interface VoiceSettingsStore {
  get(key: ScopedKey): Promise<VoiceSettingsConfig | null>;
  /** 全表，后台列表用 */
  list(): Promise<VoiceSettingsConfig[]>;
  /** 覆盖写；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(cfg: Omit<VoiceSettingsConfig, 'updatedAt'>): Promise<VoiceSettingsConfig>;
  /** 恢复上层（删行）；不存在时静默成功 */
  remove(key: ScopedKey): Promise<void>;
}

/**
 * 语音合成接口（TTS）的唯一配置：单行表，全局只有一套。
 * 没有行、url 空、key 空都等于「未配置」，由读侧落回「合成即抛」的占位实现。
 */
export interface TtsSettingsStore {
  /** 未配置返回 null；key 已在仓储内解密 */
  get(): Promise<TtsSettingsSecret | null>;
  /**
   * key 省略 = 保留原密文与 keyHint（库里没配过时由路由层挡成 400）；给了就重新加密并重算掩码。
   * dialect 省略 = 保留旧行方言（旧行为空按 openai）；显式给了就覆盖。
   */
  put(input: TtsSettingsInput): Promise<TtsSettingsView>;
  /** 删整行；没有行也静默成功 */
  remove(): Promise<void>;
}

/**
 * 每条语音先判断情绪用的语气提示词：channel / guild / global 各至多一行，命中哪层用哪层。
 * trim 空的内容由 HTTP 层转成删行；仓储只管原样存取，不做「空 = 没配」的合并。
 */
export interface TtsStyleStore {
  /** 读某一层；这层没有行给 null */
  get(key: ScopedKey): Promise<TtsStyleLayer | null>;
  /** 全表，后台列表用；排序由调用方决定 */
  list(): Promise<TtsStyleLayer[]>;
  /** 覆盖写（同 scope+scopeId 覆盖）；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(input: { scope: Scope; scopeId: string; content: string }): Promise<TtsStyleLayer>;
  /** 删这一层；不存在时静默成功 */
  remove(key: ScopedKey): Promise<void>;
}

/**
 * §41 主模型识图的三层开关：global / guild / channel 各至多一行，命中哪层用哪层。
 * 行不存在或 enabled 不是布尔都等于「这一层没有配置」，由 core 落回上一层。
 */
export interface VisionSettingsStore {
  get(key: ScopedKey): Promise<VisionSettingsConfig | null>;
  /** 全表，后台列表用 */
  list(): Promise<VisionSettingsConfig[]>;
  /** 覆盖写；updatedAt 由仓储补写入时刻，调用方不用传 */
  put(cfg: Omit<VisionSettingsConfig, 'updatedAt'>): Promise<VisionSettingsConfig>;
  /** 恢复上层（删行）；不存在时静默成功 */
  remove(key: ScopedKey): Promise<void>;
}

/** 表情选择的独立模型配置（§21）：单行表，全局只有一套 */
export interface ReactionModelStore {
  /** 未配置 / provider 不在枚举内 / model 空白，一律返回 null（= 没有表情模型） */
  get(): Promise<ReactionModelConfig | null>;
  put(cfg: ReactionModelConfig): Promise<void>;
}

/**
 * 手动备份的文件端口：后端只「写请求、读状态」，打包上传由宿主侧的 timer 干。
 * 实现依赖 node:fs，只在自托管 Node 侧接线；Workers 没有文件系统，装配层不给就整组端点回 501。
 */
export interface BackupStore {
  /** 两个文件各自读取、各自校验；读不到、坏形状一律当没有，永不抛 */
  read(): Promise<BackupSnapshot>;
  /**
   * 写下一次手动备份请求。
   * 已有未处理请求时抛 BackupBusyError（name 固定为 'BackupBusyError'）——HTTP 层不能 import
   * Node 侧实现，按这个名字认出「忙」并回 409。
   */
  request(): Promise<BackupRequest>;
}
