# 架构设计 · DC AI BOT

> 本文是并行实现的唯一契约来源。实现者只读本文即可开工；与本文冲突的直觉以本文为准。
> 访谈结论见 `docs/plan.md` 的「决策记录」。

## 1. 目标与非目标

**目标（v1）**
1. 一个 Discord Bot，通过**斜杠命令**对话，支持多家大模型供应商。
2. 提示词**可配置 + 可运行时调整**：分层（global / guild / channel），双入口（Web 后台、斜杠命令）。
3. 频道级模型与多段提示词切换（§32）、频道级会话记忆、看得见的"渐进式流式"回复。
4. 全部跑在一个 Cloudflare Worker 上（Interactions 端点 + D1 + 静态 SPA）。

**非目标（v1 明确不做）**
- Gateway 长连接、@提及与普通消息触发（无长连接能力）。
- 图像生成、语音、RAG/向量检索、联网搜索、工具调用/函数调用。
- 多租户分权、多管理员账号、OAuth 登录。
- 真实 CF 部署与真实 Discord 端点联调（缺凭据）。

## 2. 硬约束（来自访谈，不可单方面更改）

| # | 约束 |
|---|---|
| C1 | 运行时=Cloudflare Workers（workerd）。`src/` 内**禁止** `node:*` 与 `better-sqlite3` 等原生模块。 |
| C2 | Discord 只走 HTTP Interactions：`POST /discord/interactions`，Ed25519 验签，3 秒内必须回应。 |
| C3 | 对话入口只有斜杠命令；"流式"= type 5 deferred 后对同一条消息做渐进编辑。 |
| C4 | 供应商= `openai-compat` / `anthropic` / `gemini` 三个适配器；openai-compat 的 baseURL 可配。 |
| C5 | 厂商 API key 加密入库（AES-256-GCM），主密钥来自 Worker Secret；后台只回显脱敏提示。 |
| C6 | 提示词优先级 channel > guild > global。 |
| C7 | 可移植性：`src/core/**` 不得引用 `cloudflare:*`、`node:*`、Hono、React；只能引用 `src/core/**` 与全局 `fetch` 类型。 |

## 3. 分层与依赖方向

```
src/core/**            纯 TypeScript 领域层（无平台 API）——可被 Node/AWS 直接复用
   ↑ 依赖
src/workers/**         Cloudflare 适配层（fetch 入口、D1 仓储、Web Crypto、Hono 路由、Discord 协议）
web/**                 React SPA（只依赖 /api 契约，不 import src/**）
```

依赖只允许**从外向内**：`workers` → `core`。`core` 反向引用即违约，验收会 grep 检查。

## 4. 请求流

### 4.1 斜杠命令对话
```
Discord → POST /discord/interactions
  ├─ 验签失败 → 401
  ├─ type=1 (PING) → {"type":1}
  ├─ type=2 APPLICATION_COMMAND → 立刻回 {"type":5}  (deferred, 内联消息)
  └─ ctx.waitUntil( run() )
        run(): 解析 scope → 取路由 → 取 key（解密）→ 载入记忆 → 渲染提示词
               → provider.chatStream() → 每 ≥1200ms 一次 PATCH 原消息 → 最终 PATCH
               → 落库 user/assistant 消息 → 裁剪
```

### 4.2 管理后台
```
浏览器 → GET /                → 静态 SPA（assets binding）
浏览器 → /api/*               → Worker Hono 路由（验 Cookie → 业务 → JSON）
```

## 5. 目录结构与文件归属

| 归属任务 | 路径 |
|---|---|
| **M0 基座** | `package.json` `tsconfig.json` `wrangler.toml` `vitest.config.ts` `.gitignore` `migrations/0001_init.sql` `src/core/types.ts` `src/core/ports.ts` `src/core/prompt/template.ts` `src/workers/db/d1-repository.ts` `src/workers/crypto/secretbox.ts` `test/foundation.test.ts` |
| **M1 供应商** | `src/core/providers/**` `test/providers.*.test.ts` |
| **M2 对话核心** | `src/core/chat/**` `src/core/prompt/resolver.ts` `src/core/memory/**` `src/core/routing/**` `test/chat.*.test.ts` |
| **M3 Discord** | `src/workers/discord/**` `test/discord.*.test.ts` |
| **M4 后台 API** | `src/workers/http/**` `test/admin.*.test.ts` |
| **M5 SPA** | `web/**` |
| **M6 集成** | `src/workers/index.ts` `test/e2e.test.ts` `README.md` `docs/operations.md` `.env.example` `scripts/register-commands.mjs` |

**同一波次内禁止修改他人归属文件**；缺什么就在自己的目录内建私有辅助文件，或报告阻塞。

## 6. 核心契约（逐字实现，签名不可改）

### 6.1 `src/core/types.ts`
```ts
export type ProviderId = 'openai-compat' | 'anthropic' | 'gemini';
export type Scope = 'global' | 'guild' | 'channel';
export type Role = 'system' | 'user' | 'assistant';

export interface ScopedKey { scope: Scope; scopeId: string }        // global 的 scopeId 恒为 ''

export interface ChatMessage {
  role: Role;
  content: string;
  author?: string;      // Discord 显示名；缺省 = 无名字，行里不出现名字片段
  authorId?: string;    // Discord 用户 ID；缺省 = 无 ID，行里不出现括号
  createdAt?: string;   // 落库时刻 ISO；有值时行首拼 `[MM-DD HH:mm] `（北京时间），见 §9
}
export interface ModelRef { provider: ProviderId; model: string }

export type PromptRole = 'system' | 'user';
export type PromptPlacement = 'before' | 'after';

export interface PromptSegment {
  id: string;                 // 同一 (scope, scopeId) 内唯一
  name: string;               // 显示名，trim 后不能为空
  role: PromptRole;           // system 段进 system 提示词，user 段进 messages（§32.3）
  content: string;
  enabled: boolean;
  placement: PromptPlacement; // 只对 role='system' 有意义：身份/记忆块之前 or 之后
  position: number;           // 组内顺序，升序
}

export interface PromptConfig {
  segments: PromptSegment[];
  temperature?: number;
  maxTokens?: number;
}

export interface RouteConfig {
  primary: ModelRef;
  fallbacks: ModelRef[];
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderKey {
  id: string;
  provider: ProviderId;
  label: string;
  baseUrl?: string;
  keyHint: string;      // 形如 "sk-…ab12"，永不包含完整密钥
  enabled: boolean;
  createdAt: string;    // ISO8601
}

export interface DecryptedKey {
  id: string;
  provider: ProviderId;
  baseUrl?: string;
  apiKey: string;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: ChatMessage[];   // 不含 system
  temperature?: number;
  maxTokens?: number;
}

export interface LlmChunk { delta: string }
export interface LlmResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
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
  userText: string;
  /** 只用于落库/进记忆的原文；缺省等于 userText */
  storedUserText?: string;
}

export interface TurnAttempt { model: ModelRef; error: string }
export interface TurnResult {
  text: string;
  model: ModelRef;
  attempts: TurnAttempt[];     // 失败过的候选，按尝试顺序
  promptScope: Scope;          // 实际命中的提示词层级
  routeScope: Scope;           // 实际命中的路由层级
}
```

### 6.2 `src/core/ports.ts`（仓储与加密端口；适配层实现）
```ts
import type { ChatMessage, DecryptedKey, PromptConfig, ProviderId, ProviderKey, RouteConfig, ScopedKey } from './types';

export interface PromptRepository {
  get(key: ScopedKey): Promise<PromptConfig | null>;
  list(): Promise<Array<PromptConfig & ScopedKey>>;
  put(key: ScopedKey, cfg: PromptConfig): Promise<void>;
  remove(key: ScopedKey): Promise<void>;
}

export interface RouteRepository {
  get(key: ScopedKey): Promise<RouteConfig | null>;
  list(): Promise<Array<RouteConfig & ScopedKey>>;
  put(key: ScopedKey, cfg: RouteConfig): Promise<void>;
  remove(key: ScopedKey): Promise<void>;
}

export interface KeyRepository {
  list(): Promise<ProviderKey[]>;
  /** 指定 provider 下第一把 enabled 的 key；无则 null */
  firstEnabled(provider: ProviderId): Promise<DecryptedKey | null>;
  getDecrypted(id: string): Promise<DecryptedKey | null>;
  create(input: { provider: ProviderId; label: string; baseUrl?: string; apiKey: string }): Promise<ProviderKey>;
  remove(id: string): Promise<void>;
}

export interface ConversationStore {
  loadRecent(key: { guildId: string; channelId: string }, limit: number): Promise<ChatMessage[]>;
  /** 该频道全部历史，时间正序；全量注入用（§9 安全阀在 core 里裁，不在这里） */
  loadAll(key: { guildId: string; channelId: string }): Promise<ChatMessage[]>;
  append(key: { guildId: string; channelId: string }, messages: ChatMessage[]): Promise<void>;
  clear(key: { guildId: string; channelId: string }): Promise<void>;
}

export interface SecretBox {
  encrypt(plaintext: string): Promise<string>;   // 返回 "v1.<ivB64>.<ctB64>"
  decrypt(blob: string): Promise<string>;
}
```

### 6.3 `src/core/prompt/template.ts`
```ts
export const TEMPLATE_VARS = ['bot_name', 'user_name', 'guild_name', 'channel_name', 'date'] as const;
export type TemplateVars = Partial<Record<(typeof TEMPLATE_VARS)[number], string>>;

/** 返回模板里出现但不在白名单中的变量名（去重）；用于保存时校验 */
export function findUnknownVars(template: string): string[];

/** 渲染 {{var}}；未提供的变量渲染为空串；未知变量抛 Error('UNKNOWN_TEMPLATE_VAR: <name>') */
export function renderTemplate(template: string, vars: TemplateVars): string;
```

### 6.4 `src/workers/crypto/secretbox.ts`
```ts
import type { SecretBox } from '../../core/ports';
/** masterKeyB64 必须是 32 字节 base64；AES-256-GCM，IV 12 字节随机 */
export function createSecretBox(masterKeyB64: string): SecretBox;
```

### 6.5 `src/workers/db/d1-repository.ts`
```ts
export function createRepositories(db: D1Database, secretBox: SecretBox): {
  prompts: PromptRepository; routes: RouteRepository; keys: KeyRepository; conversations: ConversationStore;
};
```

### 6.6 对话核心（M2 交付）

> **注（`memory-nolimit-1`）**：下面这段是 M2 交付时的契约原样，保留作历史；其中 `DEFAULT_HISTORY_MAX_CHARS` / `trimToCharBudget` 已在 `memory-nolimit-1` 去掉，注入只由条数决定（§31.8）。

```ts
// src/core/prompt/resolver.ts
export function resolvePrompt(channel: PromptConfig | null, guild: PromptConfig | null, global: PromptConfig | null): { cfg: PromptConfig; scope: Scope } | null;

// src/core/routing/resolve.ts
export function resolveRoute(channel: RouteConfig | null, guild: RouteConfig | null, global: RouteConfig | null): { cfg: RouteConfig; scope: Scope } | null;

// src/core/memory/window.ts
export const DEFAULT_HISTORY_MAX_CHARS = 200000;
export interface HistoryWindow { kept: ChatMessage[]; droppedCount: number }
/** 字符口径 = 每条 content.length 之和；从最旧整轮（user+assistant 成对）丢弃直到 <= maxChars；maxChars<=0 返回空 */
export function trimToCharBudget(messages: ChatMessage[], maxChars: number): HistoryWindow;

// src/core/chat/service.ts
export interface ChatServiceDeps {
  prompts: PromptRepository; routes: RouteRepository; keys: KeyRepository;
  conversations: ConversationStore;
  providers: Record<ProviderId, LlmProvider>;
  config: { historyMaxChars?: number; summaryMaxChars?: number };  // burstEditIntervalMs 已删：§29.7 起服务层不再节流
}
export interface TurnEvents { onProgress?: (partialText: string) => void | Promise<void> }
export interface ChatService {
  run(ctx: TurnContext, events?: TurnEvents): Promise<TurnResult>;
  reset(key: { guildId: string; channelId: string }): Promise<void>;
}
export function createChatService(deps: ChatServiceDeps): ChatService;
```

**`run` 语义（必须逐条满足）**
1. 读 channel/guild/global 三层 PromptConfig 与 RouteConfig；三层全空 → 抛 `Error('NO_ROUTE_CONFIGURED')`。
2. `variants = [route.primary, ...route.fallbacks]`；按序尝试。
3. 每次尝试：取该 provider 的第一把 enabled key（无 key 记 `NO_KEY_FOR_PROVIDER` 并试下一个），用 `chatStream` 累计文本，**每收到一个数据块就立刻**触发一次 `events.onProgress(累计文本)`（§29.7 起服务层不再节流，原来的 `burstEditIntervalMs` 配置项已删除）；抛错→记录 attempts→试下一个。
4. 全部失败 → 抛 `Error('ALL_PROVIDERS_FAILED: ' + JSON.stringify(attempts))`。
5. 成功：`append` 用户消息与助手消息，**append 后不裁剪，历史全留**，返回 TurnResult。落库的用户原文取 `ctx.storedUserText ?? ctx.userText`；发给模型的本轮 user 消息仍用 `ctx.userText`。
6. 系统提示词 = 命中层的段按 §32.3 拼装：`role=system` 的 `before` 段（天头）→ 身份块（前导换行削掉）→ 提及规则 → 表情规则 / 语音提示 / 自定义表情清单 / 可贴表情目标 → 世界书 → `role=system` 的 `after` 段（收尾）；长期记忆摘要不进 `system`，拼在本轮那条 user 消息最前面（§52）；`role=user` 的段不进 system，按 `position` 变成 `messages` 里排在历史之前的一批 user 消息。每段都过 `renderTemplate`（5 个变量取自 TurnContext，`date=YYYY-MM-DD UTC`），渲染后为空的段整段跳过。段模型、回填与命中规则见 §32。
7. 记忆 = 该频道**全部历史**（`loadAll`，按字符安全阀从最旧整轮丢，默认 `DEFAULT_HISTORY_MAX_CHARS = 200000`；`memory-nolimit-1` 起这道阀已去掉、注入只由条数决定，见 §31.8），作为 `messages` 传给 provider，**不含**当前 userText；当前 userText 追加为最后一条 user。

## 7. 三个供应商适配器（线缆细节，必须照此实现）

所有适配器**必须**通过 `rt.fetch` 发请求（禁止全局 fetch），便于测试注入。统一超时 180s（3 分钟，AbortSignal.timeout 可用则用，否则自建）。

### 7.1 openai-compat
- URL：`${baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
- Headers：`authorization: Bearer <key>`、`content-type: application/json`
- Body：`{ model, messages: [{role:'system',content:system}, ...messages], temperature?, max_tokens?, stream }`
- 流式：`text/event-stream`，行 `data: {json}`，取 `choices[0].delta.content`；`data: [DONE]` 结束。
- 列表模型：`GET ${baseUrl}/models` → `data[].id`。

### 7.2 anthropic
- URL：`${baseUrl ?? 'https://api.anthropic.com'}/v1/messages`
- Headers：`x-api-key`、`anthropic-version: 2023-06-01`、`content-type: application/json`
- Body：`{ model, system, messages, max_tokens: maxTokens ?? 1024, temperature?, stream }`
- 流式：SSE，`content_block_delta` → `delta.text`；`message_stop` 结束。
- 非流式：`content[0].text`。
- 列表模型：`GET /v1/models` → `data[].id`（失败时返回内置常量列表）。

### 7.3 gemini
- URL：`${baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${model}:streamGenerateContent?alt=sse&key=<key>`（非流式用 `:generateContent`）
- Body：`{ systemInstruction: { parts: [{ text: system }] }, contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { temperature?, maxOutputTokens? } }`
- 流式：SSE，每块取 `candidates[0].content.parts[0].text`（缺失则跳过）。
- 列表模型：`GET /models?key=...` → `models[].name`，去掉 `models/` 前缀。

**错误归一**：非 2xx 抛 `Error('<provider> HTTP <status>: ' + body.slice(0, 300))`；网络异常原样抛。

## 8. 提示词分层与变量

- 存储粒度：`(scope, scopeId)` 唯一。`global` 的 scopeId 为空串。
- 解析：channel 命中即用；否则 guild；否则 global；都没有 → 用内置默认（`` 内置 DEFAULT_PROMPT 常量放在 `src/core/prompt/resolver.ts`，内容：助手型中文回复，礼貌简洁）。**注意**：提示词缺失不算错误，只有路由缺失才算。
- 变量白名单见 §6.3；保存时用 `findUnknownVars` 拒绝未知变量（HTTP 400）。

## 9. 记忆策略

- 维度：`(guildId, channelId)`，多用户共享同一频道上下文（v1 假设）。
- **注入窗口 = 最近 50 条原文（2026-10-26 四次改口径）**：`loadAll` 仍取该频道全部历史，注入前用 `tailMessages`
  只留最近 50 条（`config.historyMaxMessages`，缺省 `DEFAULT_HISTORY_MAX_MESSAGES = 50`），频道级可配、**≥ 2 无上限**）；注入只由条数决定
  （`memory-nolimit-1` 起那道字符安全阀已去掉，不再从最旧整轮丢，§31.8）。
- 写：一轮成功后写入 user 与 assistant 两条。
- **频道全量记忆**：频道内**所有人**的消息（含未被 @ 的人类发言）都会写入 messages（`shouldRecord` → DO 的
  `#recordMessage`，只写库、不调 REST 也不调模型）；回复判定不变（只在被 @ / 被回复 / 私聊时调模型），
  被 @ 的回合仍由 chat service 一次性写 user+assistant，两条路径互斥、不重复落库。
- **不再 prune**：D1 消息永久保留，除 `/reset` 外没有删除路径；token 预算口径取消，只按字符算。
- **后台自动大总结（累积记忆口径，§31）**：每 50 条未总结消息（`config.summaryEveryMessages`，含她自己的
  回复）**后台自动生成一段新记忆**：每次只总结游标**之后**的新对话，产出一段
  `【记忆段】（覆盖 10-25 22:40 ~ 10-26 14:30，最后一句约在 10-26 下午两点半）` 形式的文本，**追加**到该频道
  摘要正文的尾部——老段原文永不改写、永不截断丢失（§31.2）。段头写的是被总结那些话的落库时刻（北京时间）；
  注入 system 时按字数预算**从新到旧**装满：预算 = 频道级 `summaryMaxChars`（500..20000，`0`/缺省 = 默认
  `SUMMARY_MAX_CHARS = 4000`），预算外的老段只留在库里、不进上下文；段内顺序永远是旧→新（§31.3）。
- 最近 50 条原文与这段累积记忆同时注入（**重复是刻意的**：记忆是压缩过的线索，原文是兜底）；
  D1 消息永久保留，除 `/reset` 外没有删除路径——被窗口挡在外面的旧内容由累积记忆兜底。
- `/reset` 清空该频道的**消息与整段长期记忆摘要**（回复文案：「已清空本频道的对话记录与长期记忆摘要。」）。

## 10. D1 schema（`migrations/0001_init.sql`，逐字）

```sql
CREATE TABLE IF NOT EXISTS prompts (
  scope TEXT NOT NULL CHECK (scope IN ('global','guild','channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  persona TEXT,
  system_prompt TEXT NOT NULL,
  temperature REAL,
  max_tokens INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

> **注（`prompt-segments-1`，§32.2）**：这段 SQL 是 `0001_init.sql` 的历史原样，不再代表当前 schema。`migrations/0013_prompt_segments.sql` 把提示词正文搬到新表 `prompt_segments`，随后删掉 `prompts` 的 `persona` / `system_prompt` 两列——那一行退化成「这一层配置存在」的容器，只剩 `temperature` / `max_tokens` / `updated_at`。

CREATE TABLE IF NOT EXISTS routes (
  scope TEXT NOT NULL CHECK (scope IN ('global','guild','channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  primary_provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  fallbacks_json TEXT NOT NULL DEFAULT '[]',
  temperature REAL,
  max_tokens INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  ciphertext TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys (provider, enabled);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (guild_id, channel_id, id);
```

## 11. 管理 API 契约（Hono，全部 JSON；除 login 外均需会话 Cookie）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/login` | `{password}` | 200 `{ok:true}` + `Set-Cookie: admin_session=…; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`；口令错 401 `{error:'BAD_PASSWORD'}` |
| POST | `/api/logout` | — | 200 `{ok:true}` 清 Cookie |
| GET | `/api/me` | — | 200 `{authed:true}` / 401 |
| GET | `/api/prompts` | — | `{items:[{scope,scopeId,temperature,maxTokens,segments:[{id,name,role,content,enabled,placement,position}]}]}`（`segments` 按 `position` 升序） |
| PUT | `/api/prompts` | `{scope,scopeId?,temperature?,maxTokens?,segments:[{id?,name,role,content,enabled,placement}]}` | 200 回写后的对象（`id` / `position` 由服务端补齐）；400 `BAD_SCOPE`（scope 枚举）/ `BAD_REQUEST`（scopeId 缺失或为空；`temperature` 不在 0..2、`maxTokens` 不是 1..100000 的整数）/ `BAD_PROMPT_SEGMENTS` / `UNKNOWN_TEMPLATE_VAR`（只查启用的段，`vars` 列出出错的变量名），细则见 §32.4 |
| DELETE | `/api/prompts` | `{scope,scopeId}` | 200 `{ok:true}`；清空这一层只能用它，`segments: []` 会被 400 拒掉（§32.4） |
| GET | `/api/routes` | — | `{items:[{scope,scopeId,primary:{provider,model},fallbacks:[],temperature,maxTokens}]}` |
| PUT | `/api/routes` | 同上结构 | 200；provider 非法 400 `{error:'BAD_PROVIDER'}` |
| DELETE | `/api/routes` | `{scope,scopeId}` | 200 |
| GET | `/api/keys` | — | `{items: ProviderKey[]}`（只含 keyHint） |
| POST | `/api/keys` | `{provider,label,baseUrl?,apiKey}` | 201 `ProviderKey`（不含明文） |
| DELETE | `/api/keys/:id` | — | 200 |
| POST | `/api/keys/:id/test` | — | 200 `{ok:true, models:string[]}` / 502 `{ok:false,error}` |
| GET | `/api/conversations?guildId&channelId&limit` | — | `{items:[{role,content,createdAt}]}` |
| GET | `/api/health` | — | `{ok:true,version}` |
| GET | `/api/backup` | — | 200 `{request, status}`（各自可为 `null`）：状态文件与请求文件缺失或坏形状就是 `null`，绝不 500（§36.2） |
| POST | `/api/backup/run` | — | 200 `{ok:true, request}`；409 `{error:'BACKUP_BUSY'}`（已有一份没处理的请求）/ 501 `{error:'BACKUP_UNAVAILABLE'}`（宿主没接文件系统）；写请求文件，由宿主 timer 执行（§36.2、§36.3） |
| GET | `/api/reply-settings` | — | 200 `{items:[{scope,scopeId,revealSteps,updatedAt}],default,min,max}`（`default`=6、`min`=0、`max`=10；只列原始行、不合并，§38.3） |
| PUT | `/api/reply-settings` | `{scope,scopeId?,revealSteps}` | 200 回写后的那一行；400 `{error:'BAD_SCOPE'}`（scope 不是 global/guild/channel）/ 400 `{error:'BAD_REQUEST'}`（guild / channel 层的 `scopeId` 缺失或为空）/ 400 `{error:'BAD_REVEAL_STEPS'}`（不是 0..10 的整数，0 合法，§38.3） |
| DELETE | `/api/reply-settings` | `{scope,scopeId?}` | 200 `{ok:true}`；只删这一层那一行、不级联（删掉就回落到上一层，§38.2） |
| GET | `/api/vision-settings` | — | 200 `{items:[{scope,scopeId,enabled,updatedAt}],default:true}`（`default` 恒为 `true`：三层都没配就是开；只列原始行、不合并，§41.3） |
| PUT | `/api/vision-settings` | `{scope,scopeId?,enabled}` | 200 回写后的那一行；400 `{error:'BAD_SCOPE'}`（scope 不是 global/guild/channel）/ 400 `{error:'BAD_REQUEST'}`（guild / channel 层的 `scopeId` 缺失或为空）/ 400 `{error:'BAD_ENABLED'}`（`enabled` 不是布尔，§41.3） |
| DELETE | `/api/vision-settings` | `{scope,scopeId?}` | 200 `{ok:true}`；只删这一层那一行、不级联（删掉就回落到上一层，§41.1） |
| GET | `/api/voice-settings` | — | 200 `{items:[{scope,scopeId,mode,voice,speed,updatedAt}],default:{mode:0,voice:'',speed:100},modes:[0,1,2],speedMin:50,speedMax:200}`（`items` 只列原始行、不合并；`default` 是三层都没配时的取值，`modes` / `speedMin` / `speedMax` 决定页面画哪些选项——前端不抄常量，§44.1、§44.4） |
| PUT | `/api/voice-settings` | `{scope,scopeId?,mode,voice?,speed?}` | 200 回写后的那一行；400 `{error:'BAD_SCOPE'}`（scope 不是 global/guild/channel）/ 400 `{error:'BAD_REQUEST'}`（guild / channel 层的 `scopeId` 缺失或为空）/ 400 `{error:'BAD_VOICE_MODE'}`（`mode` 不是 0..2 的整数）/ 400 `{error:'BAD_VOICE_SPEED'}`（`speed` 不是 50..200 的整数，§44.1） |
| DELETE | `/api/voice-settings` | `{scope,scopeId?}` | 200 `{ok:true}`；只删这一层那一行、不级联（删掉就回落到上一层，§44.1） |
| GET | `/api/pg-errors?limit` | — | 200 `{limit,dropped,items:[PgErrorEntry]}`（中继 `GET /admin/errors` 那份原样返回：`items` 新→旧、条数 ≤ `limit`，`dropped` 是中继累计被挤掉的条数，§43.3）；501 `{error:'PG_ERRORS_UNAVAILABLE'}`（`PG_ERRORS_URL` / `PG_ERRORS_TOKEN` 任一缺失）；502 `{error:'PG_ERRORS_UPSTREAM',detail}`（中继不可达 / 非 200 / 形状坏，`detail` 是一句中文原因）；`limit` 缺省 200、夹在 1..200 不报错（§43.4）
| GET | `/api/prompt-defaults` | — | 200 `{items,vars:{fallback,identity},maxChars}`：`items` 只列**已配置**的行（`key` / `content` / `updatedAt`），`maxChars` 是 20000（§45.4） |
| PUT | `/api/prompt-defaults` | `{key,content}` | 200 回写后的那一行；400 `BAD_PROMPT_KEY` / `BAD_PROMPT_CONTENT` / `UNKNOWN_TEMPLATE_VAR`（带 `vars`，§45.4） |
| DELETE | `/api/prompt-defaults?key=<fallback\|identity>` | — | 200 `{ok:true}`；400 `BAD_PROMPT_KEY`（「恢复默认」只删所在那一层，§45.4） |

Cookie 格式：`base64url(JSON{exp}) + '.' + base64url(HMAC-SHA256(payload, SESSION_SECRET))`；过期或签名不符 → 401。口令比较必须常数时间。

## 12. Discord 交互层

- `POST /discord/interactions`：验签 `X-Signature-Ed25519` + `X-Signature-Timestamp` + 原始 body，公钥 `DISCORD_PUBLIC_KEY`（hex → Web Crypto `Ed25519`）。失败 401。
- `type=1` → `{type:1}`。`type=2` → 立刻 `{type:5}`（`flags` 不设），把实际工作交给 `ctx.waitUntil`。
- 渐进编辑：`PATCH /webhooks/{applicationId}/{interactionToken}/messages/@original`，body `{content}`；间隔 ≥ `1200ms`；最多 12 次编辑；最后一次必须是最终文本。
- 文本上限 1900 字符（Discord 2000 限制留余量），超出截断并附 `…(已截断)`。
- 命令集（`scripts/register-commands.mjs` 与之保持一致）：
  | 命令 | 选项 | 说明 | 权限 |
  |---|---|---|---|
  | `/chat` | `prompt`(string, required) | 与模型对话 | 所有人 |
  | `/model` | `view`(bool) / `provider`(choice) / `model`(string) | 查看或设置本频道模型 | set 需 ManageGuild |
  | `/persona` | `view`(bool) / `persona`(string) / `system`(string) | 查看或设置本频道层的提示词（选项还是这两个，落库已是 §32.2 的段模型：不再有「人格 / 系统提示词」两列） | 需 ManageGuild |
  | `/reset` | — | 清空本频道记忆 | 需 ManageGuild |
  | `/help` | — | 用法说明 | 所有人 |
- 无权限 → ephemeral（`flags: 64`）拒绝文案。

## 13. 安全模型

- Secrets（`wrangler secret put`）：`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`DISCORD_APPLICATION_ID`、`ADMIN_PASSWORD`、`SESSION_SECRET`（≥32 字符）、`KEY_ENCRYPTION_SECRET`（32 字节 base64）。
- 后台鉴权：单口令 → HMAC 签名 Cookie；所有 `/api/*`（除 login/health）中间件校验。
- 密钥加密：AES-256-GCM，12 字节随机 IV，入库 `v1.<ivB64>.<ctB64>`；`key_hint` 仅存末 4 位。
- 明文密钥只允许出现在：解密后的 `ProviderRuntime` 与 provider 测试响应里；**永不**进日志、永不进 API 响应。
- 登录限速：同 isolate 内存计数，10 次/5 分钟，超出 429。

## 14. 测试策略（`npm test` 必须全绿）

1. `@cloudflare/vitest-pool-workers`（真 workerd + 本地 D1，migrations 用 `applyD1Migrations`）。
2. 适配器：注入假 `fetch`，断言 URL/headers/body 与 SSE 解析；覆盖三个 provider + 错误归一。
3. 对话核心：假仓储 + 假 provider，覆盖 fallback 链、`NO_ROUTE_CONFIGURED`、`ALL_PROVIDERS_FAILED`、onProgress 节流、记忆写入与裁剪。
4. Discord：用 `crypto.subtle.generateKey('Ed25519')` 生成密钥对自签请求，断言 PING/PONG、deferred、渐进编辑调用序列；伪造签名 → 401。
5. 后台：未带 Cookie → 401；登录 → 正确口令 200 / 错误 401；密钥 POST 后 GET 只见 hint，DB 内存 ciphertext ≠ 明文；模板未知变量 → 400。
6. E2E：登录 → 配置 route 与 key → 自签 `/chat` 交互（provider fetch 被打桩）→ 断言最终消息被 PATCH 且库里有两条记忆。

## 15. 约定

- TypeScript strict；`src/core` 不用 `any`（`unknown` + 窄化）。
- 不许引入除以下之外的运行时依赖：`hono`。开发依赖：`typescript` `wrangler` `vitest` `@cloudflare/vitest-pool-workers` `react` `react-dom` `@vitejs/plugin-react` `vite` `@cloudflare/workers-types`。
- 代码标识符英文；**用户可见文案（Discord 回复、SPA 界面）中文**；README/docs 中文。
- 注释只写"为什么"，不写"是什么"。
- 每个任务完成时必须自跑 `npm run typecheck` 与 `npm test` 并贴出结果。

## 16. 并行解耦约定（W2 五路同时开工，违反即返工）

1. 已就绪的共享文件只有：`src/core/types.ts`、`src/core/ports.ts`、`src/core/prompt/template.ts`、`src/workers/db/d1-repository.ts`、`src/workers/crypto/secretbox.ts`。
2. **M2** 拥有 `src/core/chat/service.ts`，导出 §6.6 的 `ChatService` / `createChatService`。
3. **M3 禁止 import `src/core/chat/**`**；在自己的 `src/workers/discord/ports.ts` 声明结构化窄接口：
   ```ts
   export interface ChatRunner {
     run(ctx: TurnContext, events?: { onProgress?: (text: string) => void | Promise<void> }): Promise<TurnResult>;
     reset(key: { guildId: string; channelId: string }): Promise<void>;
   }
   ```
4. **M4 禁止 import `src/core/providers/**`**；key 连通性测试走注入的窄接口（在 `src/workers/http/ports.ts`）：
   ```ts
   export type KeyProber = (input: { provider: ProviderId; apiKey: string; baseUrl?: string }) => Promise<string[]>;
   ```
5. **M5** 不得 import `src/**`，只依赖 §11 的 HTTP 契约。
6. 任何人不得修改他人归属文件；缺能力就在自己目录内加私有辅助文件或窄接口，并在报告中声明。
7. 每路只跑自己的测试（`npx vitest run test/<own>.test.ts`）。全局 `npm run typecheck` 中**他人文件**的报错一律忽略并在报告里列出；全局收敛由 M6 与验收段负责。
8. 测试基础设施（W1 实测结论）：D1 用 `import { env } from 'cloudflare:test'` 取 `env.DB`；迁移已在 `test/setup.ts` 自动应用，**不要再 apply**；同一测试文件内用例共享库，须 `beforeEach` 清表；workerd 里只有 Web 标准 API（无 `node:fs`）；额外 env 变量走 `vitest.config.ts` 的 miniflare.bindings，勿改 wrangler.toml 的 secret 段。


## 17. 记忆总结（conversation-summaries，2026-10-25 追加）

> **2026-10-25 二次改口径（以本段为准）**：不再每轮摘要、不再注入摘要，改为**全量历史直接注入**（§9）；
> 摘要只剩手动 `/summary` 一条路径，`conversation_summaries` 表与 `/summary` 命令保留。
> 下面 §17.1 记录的是初版口径，凡与二次口径冲突处一律以本段与 §17.4 为准。
>
> **2026-10-25 三次改口径**：恢复自动摘要（阈值 20 轮＝40 条未总结消息）并注入 system，与全量历史并存
> （见 §9）。摘要不再只剩手动路径：后台 `waitUntil` 触发，不占回复时延；system 里的【长期记忆摘要】段
> 与全量历史一起出现是有意为之，不是重复注入的 bug。
>
> **2026-10-26 四次改口径（以本段为准）**：注入侧不再全量——每轮只送**最近 50 条原文**
> （`DEFAULT_HISTORY_MAX_MESSAGES = 50`，`config.historyMaxMessages` 可覆盖），更早的内容靠摘要兜底；
> 自动摘要阈值从「20 轮＝40 条」改成「**50 条未总结消息**」（`config.summaryEveryMessages`）；摘要每次生成后

### 17.1 需求口径（已定）

- **每条消息只调 1 次模型**（2026-10-25 二次改口径）：直接 `loadAll` 取该频道全部历史，一次**流式**调用生成回复（当初还叠加过一次字符安全阀，
  `memory-nolimit-1` 起那个阀已去掉、注入只由条数决定，§31.8）。初版的「先摘要再回答 = 每条回复 2 次上游调用」已作废。
- **不再注入摘要**：system prompt 里没有「【长期记忆摘要】」段，每轮摘要的开关字段已从 config 彻底删除。
- 摘要入口有两个：手动 `/summary`（`summarize` / `getSummary`）与 §26 的自动总结（§35 起后台还有第三条入口「选择性补记」：按时间范围挑一段历史直接追加一段记忆，不动游标）；单批素材上限 = `min(500, max(SUMMARY_MAX_INPUT_MESSAGES=50, 频道阈值))`（`summaryBatchLimit`，§26 追加语义）：一次总结调用最多吃 500 条，阈值更大时靠循环多批追平（§31.8）。
- 原文不再裁剪（无 `prune`），D1 消息永久保留，因此手动总结的游标才有「未总结增量」可谈。
- 手动入口：Discord 斜杠命令 `/summary`（`view:true` 只看当前摘要，否则总结全部未总结消息）。
- 生成模型：复用当前生效路由（channel > guild > global）的 primary，失败走 fallbacks（仅手动路径）。
- 摘要按 (guild_id, channel_id) 存储，与 messages 同维度；`/reset` 同时清空消息与摘要。

### 17.2 数据契约

```sql
CREATE TABLE IF NOT EXISTS conversation_summaries (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  covered_until_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);
```

`src/core/types.ts` 新增：

```ts
export interface ChannelKey { guildId: string; channelId: string; }
export interface ConversationSummary {
  guildId: string;
  channelId: string;
  summary: string;
  coveredUntilId: number;   // 已总结到 messages.id 的最大值，摘要游标
  coveredFrom?: string;     // §27：这段记忆里最早一条消息的 created_at（ISO），缺省=不知道
  coveredTo?: string;       // §27：最晚一条消息的 created_at（ISO）
  updatedAt: string;        // ISO，摘要生成的时刻：只给后台看，不进提示词
}
export interface StoredMessage extends ChatMessage { id: number; }
export interface SummaryOutcome {
  summary: string;
  coveredUntilId: number;
  summarizedMessages: number;
  model: string;
}
```

`src/core/ports.ts`：

```ts
export interface ConversationStore {
  loadRecent(key: ChannelKey, limit: number): Promise<ChatMessage[]>;   // 不变
  loadAll(key: ChannelKey): Promise<ChatMessage[]>;                     // 全部历史；注入侧只取最近 50 条（§9）
  append(key: ChannelKey, messages: ChatMessage[]): Promise<void>;      // 不变
  clear(key: ChannelKey): Promise<void>;                               // 不变
  /** id 大于 afterId 的消息，时间正序，最多 limit 条（不传取全部）；带 id 供手动摘要游标使用 */
  loadAfter(key: ChannelKey, afterId: number, limit?: number): Promise<StoredMessage[]>;
}

export interface SummaryStore {
  get(key: ChannelKey): Promise<ConversationSummary | null>;
  put(entry: ConversationSummary): Promise<void>;
  remove(key: ChannelKey): Promise<void>;
}
```

`createRepositories(db, secretBox)` 返回值新增 `summaries: SummaryStore`（其余四项不变）。

### 17.3 摘要生成（纯逻辑，`src/core/chat/summary.ts`，禁 IO）

```ts
export const SUMMARY_SYSTEM_PROMPT: string;  // 中文；要求「只把这段新增对话写成一段新记忆」，禁止改写已有记忆、禁止加解释性开场白
export const SUMMARY_MAX_CHARS = 4000;        // 注入预算默认值（频道级 summaryMaxChars 可覆盖）：正文只增不减，超预算的老段留在库里、不进上下文（§31.3）
export const SUMMARY_MAX_INPUT_MESSAGES = 50;  // 单批素材下限；超出只取最旧的一批，频道阈值更大时一批跟阈值走
export type SummaryLine = Pick<ChatMessage, 'role' | 'content' | 'author' | 'authorId' | 'createdAt'>;  // 可含尚未落库的本轮消息
export function formatTranscript(messages: SummaryLine[]): string;              // 每行 `[MM-DD HH:mm] <名字(ID)或名字>：<正文>`，assistant 行名字取 author 或 'Bot'
export function buildSummaryRequest(route: ModelRef, previous: string, transcript: string): LlmRequest;
export function normalizeSummary(raw: string): string;                            // trim、剥 ```围栏；写侧不按长度截断（写多长就存多长），长度只由注入预算约束（§31.3）
export function renderSummaryBlock(summary: string, coveredFrom?: string, coveredTo?: string): string;
                                                                                  // 累积正文按 `【记忆段】` 切段，按字数预算**从新到旧**装满（预算 = 频道 summaryMaxChars 非零 ? 它 : config.summaryMaxChars 非零 ? 它 : SUMMARY_MAX_CHARS），段内旧→新；预算外的老段不进上下文（§31.3）。拼出来长这样：

【记忆段】（覆盖 10-25 22:40 ~ 10-26 14:30，最后一句约在 10-26 下午两点半）
<这一段的记忆>

【记忆段】（覆盖 10-26 14:31 ~ 10-27 09:05，最后一句约在 10-27 上午九点零五分）
<这一段的记忆>
                                                                                  // 段头取**这一段**覆盖的消息的 created_at（§27），只有一头时写「覆盖到 …」，都空就只留 `【记忆段】`；没有段头的老正文（老数据 / 后台手改）整体当一段，此时才用 coveredFrom/coveredTo 兜底；空摘要返回 ''
```

### 17.4 ChatService 扩展

```ts
export interface ChatServiceDeps {
  prompts; routes; keys; conversations;
  summaries: SummaryStore;                    // 新增，必填
  providers: Record<ProviderId, LlmProvider>;
  config: {
    historyMaxChars?: number;                 // 已删：memory-nolimit-1 起注入只由条数决定（§31.8）
    // burstEditIntervalMs 已删：stream-edit-1 起服务层不再节流，模型每来一块就立刻推（§29.7）
    summaryMaxChars?: number;                 // 全局兜底；默认 SUMMARY_MAX_CHARS，频道级非零值优先
  };
}

export interface ChatService {
  run(ctx: TurnContext, events?: TurnEvents): Promise<TurnResult>;
  reset(key: ChannelKey): Promise<void>;                                   // messages.clear + summaries.remove
  summarize(key: ChannelKey): Promise<SummaryOutcome | null>;   // 手动 /summary，总结全部未总结消息
  getSummary(key: ChannelKey): Promise<ConversationSummary | null>;
}
```

`run` 的语义增量（原有 7 条不变）：

1. **run 不读、不写、不注入摘要**：system prompt 装配顺序只有「渲染模板 → 追加身份块」，没有 `renderSummaryBlock`，run 全程不碰 `summaries`。
2. `summarize` / `getSummary` 仅供手动 `/summary` 命令调用，run 不会触发它们。
3. 每条消息只调 1 次模型（流式）；历史来自 `loadAll` + `historyMaxChars` 安全阀，append 成功后直接 return，既无 prune 也无后台摘要任务。

`summarize(key, { force })` 语义：

1. `cursor = (await summaries.get(key))?.coveredUntilId ?? 0`；`pending = await conversations.loadAfter(key, cursor)`。
2. 素材 = `pending`（只有手动路径，没有「本轮这条尚未落库的 user 行」）；`pending` 为空又无旧摘要时返回 `null`；素材超过单批上限（`summaryBatchLimit`：至少 `SUMMARY_MAX_INPUT_MESSAGES`(50)，频道阈值更大时跟阈值）时只取**最旧**的一批，游标也只推进到这批的最后一条（`summaryMaterial`）——下一轮接着总结，任何一条都不跳过。
3. 路由走 `resolveRoute`（channel > guild > global）；无路由 `throw new Error('NO_ROUTE_CONFIGURED')`。
4. 候选 = primary + fallbacks：`keys.firstEnabled(provider)` 取 key，`provider.chat(buildSummaryRequest(...))`（**非流式**）；无 key 记 `'NO_KEY_FOR_PROVIDER'`，异常记 `describeError`，成功即止；全失败 `throw new Error('ALL_PROVIDERS_FAILED: ' + JSON.stringify(attempts))`。
5. `normalizeSummary` 后为空 → `throw new Error('SUMMARY_EMPTY')`。
6. `summaries.put({ guildId, channelId, summary, coveredUntilId, updatedAt: new Date().toISOString() })`（`coveredUntilId` = 这次真正送进素材的最后一条已落库消息的 id——素材被单批上限截断时就是这批的最后一条；本轮新消息还没落库故不推动游标，没有新增则沿用旧游标），返回 `SummaryOutcome`。

### 17.5 Discord `/summary`

命令定义（`src/workers/discord/commands.ts`，追加到 `COMMANDS` 末尾，type 1，中文 description）：`summary`，选项 `view`（BOOLEAN，「只看当前摘要，不重新总结」）。

- 处理：先 ACK `{type: 5}`，再 `chat.summarize(key)` 或 `chat.getSummary(key)`，把结果用 PATCH `/webhooks/{appId}/{token}/messages/@original` 编辑进原消息（沿用 §12 的 rest 客户端与 1900 字符截断）。
- 文案：成功「已总结 N 条消息（模型 X）

<摘要>」；`null`「这个频道还没有可总结的内容」；`view` 无摘要「这个频道还没有摘要」；异常「总结失败：<message>」。

`src/workers/discord/ports.ts` 的 `ChatRunner` 增加：

```ts
summarize(key: ChannelKey): Promise<SummaryOutcome | null>;
getSummary(key: ChannelKey): Promise<ConversationSummary | null>;
```

类型从 `src/core/types` 导入（Discord 层禁止 import `src/core/chat/**`，§16.3）。
---

## 18. 回复链与表情（reaction）


### 18.1 数据契约（§6 增补，已落在 `src/core/types.ts`）

```ts
export interface ReplyRef {
  messageId: string;   // 被回复消息 id
  author: string;      // 被回复人显示名，可能 ''
  authorId: string;    // 被回复人 Discord 用户 ID，可能 ''
  content: string;     // 被回复原文：库里存全文，进提示词时由 core 截断
}

export interface CustomEmoji { name: string; id: string; animated?: boolean }

export interface ChatMessage {
  role: Role;
  content: string;
  author?: string;
  authorId?: string;
  createdAt?: string;
  /** 这条消息回复了谁；非回复或老数据没有该键 */
  replyTo?: ReplyRef;
}

export interface TurnContext {
  /* …既有字段不变… */
  /** 本轮这条消息回复了谁（网关解析 referenced_message 得到） */
  replyTo?: ReplyRef;
  /** 该服务器可用的自定义表情（网关注入，10 分钟缓存）；空或缺省时提示词里没有表情段 */
  customEmojis?: CustomEmoji[];
}

export interface TurnResult {
  text: string;          // **已剥掉表情指令**的干净正文
  model: ModelRef;
  attempts: TurnAttempt[];
  promptScope: Scope;
  routeScope: Scope;
  /** 模型要求贴的表情，去重保序，最多 MAX_REACTIONS 个；空数组表示不贴 */
  reactions: string[];
}
```

### 18.2 存储（`migrations/0004_message_reply.sql`）

四列全部 `TEXT NOT NULL DEFAULT ''`（D1 每句只加一列，写四条 `ALTER TABLE`）；老行为空串，不回填，语义等价「不知道」：

`reply_to_id` / `reply_to_author` / `reply_to_author_id` / `reply_to_content`。

`append` 写入，`loadRecent` / `loadAll` / `loadAfter` 读回；四列皆空时**不产生** `replyTo` 键（与老数据一致）。`reply_to_content` 存原文全文，截断只发生在提示词侧。

### 18.3 记忆行（`withAuthorPrefix`）

`[MM-DD HH:mm] <名字>(<id>)：<正文>`，有 `replyTo` 时在正文之后追加：

` ↳ 回复 <名字>(<id>)：「<原文前 40 字>」`

退化规则（按顺序判定）：

| 情形 | 后缀 |
| --- | --- |
| 名字与 id 都有 | `↳ 回复 小明(u1)：「…」` |
| 只有名字 | `↳ 回复 小明：「…」` |
| 只有 id | `↳ 回复 u1：「…」` |
| 名字与 id 都空 | `↳ 回复一条更早的消息：「…」` |
| 原文为空或全空白 | 省略 `：「…」` 部分，其余同前 |

截断规则：`content` 先把连续空白（含换行）压成单个空格、trim，再取前 `REPLY_EXCERPT_CHARS = 40` 个 UTF-16 code unit，超出补 `…`（与项目其它截断口径一致）。assistant 行永不带 `replyTo`，本轮 user 消息的 `replyTo` 来自 `TurnContext.replyTo`。

### 18.4 表情指令（新文件 `src/core/chat/react.ts`）

```ts
export const MAX_REACTIONS = 2;
export const REPLY_EXCERPT_CHARS = 40;
export const REACT_DIRECTIVE_PREFIX = '[[react:';
/** 剥掉所有 [[react: X]] 指令：返回干净正文与去重保序的表情，最多 MAX_REACTIONS 个 */
export function splitReactDirectives(raw: string): { text: string; emojis: string[] };
/** 流式用：截到第一个未闭合的 '[[' 之前，避免半截指令刷进 Discord */
export function visibleText(raw: string): string;
```

语义：
- 指令语法 `[[react:` + 1..64 个非 `]`、非换行字符 + `]]`；可与正文同行、可独占一行、可出现多次。
- 剥离后逐行 trim 行尾、连续空行压成一个换行、整体 trim；全部是空白则为 `''`。
- 空白指令 `[[react:  ]]` 剥掉但不产出表情；超出 `MAX_REACTIONS` 的按出现顺序丢弃，不报错。
- 不做语法校验（unicode 与 `:name:` 都可能合法），解析/贴失败在执行侧静默记日志。
- `visibleText` 亦用于「末尾未闭合的 `[[` 半截指令」处理；返回前 trim。

### 18.5 ChatService 语义（§6.6 增补）

1. 流式期间 `events.onProgress?.(visibleText(rawSoFar))`：进度里绝不出现半截指令。
2. 本轮结束 `const { text, emojis } = splitReactDirectives(raw);`；`TurnResult.text` 与**落库的 assistant 行**都用干净文本；`TurnResult.reactions = emojis`。
   - 剥完指令（以及 `stripStamp` 剥掉行首假时刻）之后，none-head-1 起还要过一道 `stripNoReactionHead`（`src/core/chat/reaction.ts`）：只剥回复**开头单独一行**的 `NONE`（`none` / `无` / `不贴` 同义），`TurnResult.text`、落库正文、流式进度三处都过它；整条回复只有 `NONE` 时原样保留，不会变成空串（§33.6、`docs/operations.md` §28.6）。
3. 本轮 user 消息（提示词末条与 `append` 两处）带 `replyTo: ctx.replyTo`（有才带）。
4. system 装配顺序固定：模板 → 身份块 → 累积记忆段（`【记忆段】…`，§31.3）→ `【表情】` → `【可用自定义表情】`。
   - `【表情】` = `renderReactionGuide(解析后的文案)`（§18.8 / §33.4），**无条件**出现：标题由渲染层补，正文按 channel > guild > global > 内置默认取一份；它是唯一教模型 `[[react:…]]` 与 `:名字:` 两种写法的地方。
   - `【可用自定义表情】` = `'\n\n【可用自定义表情】\n' + 最多 40 个 :name:（空格分隔）`；`customEmojis` 为空或缺省时返回 `''`，不出现空壳段。
5. 摘要素材 `formatTranscript` 每行同样走 `withAuthorPrefix`，回复链自动进入素材。

### 18.6 网关与 Discord REST

`src/workers/gateway/message.ts` 的 `IncomingMessage` 新增：

```ts
  /** 被回复消息；不是回复或原消息已删除为 null */
  replyTo: { messageId: string; authorId: string; authorName: string; content: string } | null;
```

解析自 `referenced_message`（`id`、`author.id`、`author.global_name ?? author.username ?? ''`、`content`）。既有 `referencedAuthorId` 保持不变（`shouldRespond` 仍用它判断「回复的是不是 bot」）。

`src/workers/discord/rest.ts` 新增两个**与交互无关**的独立函数（interaction client 绑定 interactionToken，不能复用）：

```ts
export interface ChannelRestOptions { botToken: string; apiBase?: string; fetch?: typeof fetch }
export async function addMessageReaction(opts: ChannelRestOptions, channelId: string, messageId: string, emoji: string): Promise<void>;
export async function listGuildEmojis(opts: ChannelRestOptions, guildId: string): Promise<CustomEmoji[]>;
```

- 贴表情：`PUT /channels/{channelId}/messages/{messageId}/reactions/{encodeURIComponent(emoji)}/@me`（Create Reaction 的动词是 PUT；用 POST 会被 Discord 回 405），无 body；非 2xx 抛 `discord HTTP <status>: <body 前 200 字>`。
- 取表情：`GET /guilds/{guildId}/emojis`，只收 `available !== false` 的项并保持返回顺序；失败抛同一风格错误（调用侧吞掉当空清单）。

网关 DO（`src/workers/gateway/durable-object.ts`）：

- `customEmojis` 由 `#emojiCatalog(guildId)` 提供：内存缓存 10 分钟，失败返回 `[]` 并 `console.warn('[gateway] 取自定义表情失败：')`，绝不阻断回复。
- `replyTo` 由 `message.replyTo` 映射成 `ReplyRef` 注入 `TurnContext`。
- 回复成功后对 `result.reactions` 逐个贴到**触发本轮的那条消息**（`message.channelId` / `message.messageId`）：值可以是 unicode 表情，也可以是清单里的名字（`名字`、`:名字:`、`名字:id`、`<:名字:id>`，名字不分大小写）；`src/workers/discord/emoji.ts` 的 `resolveReactionEmoji` 统一解析成 `name:id` 或 unicode，解析不出来的（不在清单里的英文名）直接跳过——贴上去 Discord 只会回 400 Unknown Emoji；失败只 warn，绝不影响已发出的回复。
- `#recordMessage`（未 @ 到 bot 的普通消息）同样带 `replyTo` 落库。
- `GATEWAY_BUILD` 递增为 `'reply-emoji-1'`。

### 18.7 已知边界

- 斜杠命令（`/chat` 等）没有「触发它的用户消息」可贴，`TurnResult.reactions` 在交互路径一律忽略。
- 老数据四列为空串，历史行没有 `↳ 回复` 段，与「不知道」等价，不回填。
- 自定义表情清单按服务器缓存 10 分钟：刚上传的表情最多 10 分钟后才进提示词。
- 被回复消息被删除时 Discord 不返回 `referenced_message`，此时 `replyTo` 为 `null`，退化为普通消息。

### 18.8 表情规则块与正文自定义表情渲染

两件事一起补，缺一件表情就只是「清单在提示词里，但她从不用」：

1. **规则块**：这段文案不再写死，改成**可自定义**（§33）：`resolveReactionGuide` 挑出这一轮该用的文案（channel > guild > global > 内置默认 `DEFAULT_REACTION_GUIDE`，§33.3 / §33.6），`renderReactionGuide(guide: string): string`（`src/core/chat/service.ts:304`）渲染——**在文案前补 `'\n\n【表情】\n'` 这一段标题**（所以文案本身不含【表情】标题，§33.4）——再接在系统提示词尾部。
   §18 落地时这里是 `renderEmojiGuide(withCustomEmojis: boolean)` 写死在 `src/core/chat/service.ts:298` 的两句话（还带一个「只在有自定义表情时才提 `:名字:` 写法」的开关），这个函数本版已删除；`[[react:…]]` 这套语法与本节第 2 条的正文渲染一个字没改，变的只是「教它怎么用」这段话从哪来。
   不依赖 `customEmojis` 这一点仍然成立：三层都没配就是内置默认文案，没有清单也出现——模型原本只能靠猜这套语法。
2. **正文渲染**：`resolveInlineEmojis(text: string, catalog: readonly CustomEmoji[]): string`（`src/workers/discord/emoji.ts`）。
   - 一次扫两种形态：`/<a?:[A-Za-z0-9_~]{2,32}:\d+>|:([A-Za-z0-9_~]{2,32}):/g`；已经成型的 `<:名字:id>` / `<a:名字:id>` 原样返回，避免把 `:名字:` 再替换一次拼出坏标记。
   - 命中 catalog → `(animated ? '<a:' : '<:') + 名字 + ':' + id + '>'`；未命中保留原文（不许凭空发明表情）。
   - 名字两端 `trim()`，同名取第一个，空名字不入表；`text === ''` 或清单为空直接返回原文。
   - 调用点在网关 DO：`chunkMessage(resolveInlineEmojis(text, customEmojis))`——**先渲染再切段**，1900 字符的切点落在最终文本上，标记不会被切成两半。
   - 放 `src/workers/discord/` 而不是 core：尖括号标记是 Discord 线缆格式，core 只管内容不管平台语法（C7）。
3. 斜杠命令路径（`src/workers/discord/handler.ts`）没有表情清单注入，正文里的 `:名字:` 在该路径下保持原文字面（§18.7）。
---

## 19. 运行日志与重试（后台「实时日志」）

### 19.1 需求与硬边界

用户在后台网页里要看**实时日志**，并且供应商调用要**自动重试**。两条硬边界：

1. **正文绝不整段进日志**：日志只写事件、模型名、条数、时长、状态码、Discord 的 guild/channel/user id 与错误文本。正文、口令、完整 Key、Cookie 一律不入表（后台能看日志，日志里出现聊天内容等于绕过管理员之外的隐私边界）。唯一例外是 `director-4` 起语音那条成功日志末尾的可选 `judge=` 段：它带 judge 那一行的完整一行、不截断（`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出），用于排查导演模式退回；正文仍绝不整段进日志（§44.3、§47.8）。
2. **写日志绝不影响业务**：`append` 失败只 `console.warn('[log] 写日志失败：' + …)`，不冒泡、不回滚任何回复。

存储选 D1 环形表而不是内存：入口 Worker 与网关 DO 是不同实例，只有 D1 能同时看到两边的事件；内存方案在驱逐后丢失。保留最近 800 条，每次写入顺带清理。

### 19.2 数据契约（`src/core/types.ts`，逐字）

```ts
export type LogLevel = 'info' | 'warn' | 'error';
export type LogScope = 'chat' | 'provider' | 'summary' | 'gateway' | 'admin';
export interface LogEntry { level: LogLevel; scope: LogScope; message: string; createdAt: string }
export interface StoredLogEntry extends LogEntry { id: number }
```

### 19.3 Port（`src/core/ports.ts`，逐字）

```ts
export interface LogStore {
  append(entries: LogEntry[]): Promise<void>;
  list(afterId: number, limit: number): Promise<StoredLogEntry[]>;
}
```

- `append` 必须「写完顺带清理」，保证表行数稳定在 keep 附近；一次 append 多条用一个 `batch`。
- `list` 按 **id 升序**返回，id 是轮询游标；`afterId=0` 表示从头取。

### 19.4 迁移 `migrations/0005_runtime_logs.sql`

```sql
CREATE TABLE IF NOT EXISTS runtime_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL
);
```

`AUTOINCREMENT` 不能省：普通 `INTEGER PRIMARY KEY` 在删行后会复用 id，轮询游标 `after=id` 会漏条目。

### 19.5 存储实现（`src/workers/db/log-store.ts`）

```ts
export const DEFAULT_LOG_KEEP = 800;
export function createLogStore(db: D1Database, keep?: number): LogStore
```

- insert：`INSERT INTO runtime_logs (created_at, level, scope, message) VALUES (?, ?, ?, ?)`，逐条 prepare 进同一个 batch。
- prune（同批最后一条）：`DELETE FROM runtime_logs WHERE id <= (SELECT MAX(id) - ? FROM runtime_logs)`。行数不足 keep 时右值为负或 NULL，天然不删，无需先 COUNT。
- list：`SELECT id, created_at, level, scope, message FROM runtime_logs WHERE id > ? ORDER BY id ASC LIMIT ?`（显式列名，不用 `SELECT *`），映射成 `StoredLogEntry`（`created_at → createdAt`）。

### 19.6 ChatService 日志钩子（`src/core/chat/service.ts`）

`ChatServiceDeps` 新增 `log?: (entry: LogEntry) => void`，内部 `const log = deps.log ?? ((): void => undefined);`（不接线也不炸）。事件固定四条，message 模板逐字：

| 时机 | level | scope | message |
| --- | --- | --- | --- |
| 本轮回复成功（append 之后） | info | chat | `回复成功 model=<provider>/<model> history=<n> dropped=<n> ms=<duration> len=<n>` |
| 全部候选失败（抛错前） | error | chat | `回复失败 <errorMessage 前 300 字>` |
| 自动摘要成功 | info | summary | `自动摘要完成 covered=<id> msgs=<n> len=<n>` |
| 自动摘要失败 | warn | summary | `自动摘要失败 <errorMessage 前 300 字>` |

`createdAt` 一律 `now().toISOString()`（同一个 `now` 注入点，测试可固定）。

### 19.7 供应商重试（`src/core/providers/rt.ts`）

```ts
export const MAX_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 800;
const RETRYABLE_STATUS: readonly number[] = [429, 500, 502, 503, 504];
```

- 重试条件只有两类：① `rt.fetch` 直接抛（网络/连接层，含 TypeError 与 AbortError 之外的传输错误）；② HTTP 状态 ∈ `RETRYABLE_STATUS`。
- **不重试**：400 / 401 / 403 / 404 / 422 等确定性错误、AbortError（我们自己 180 秒建连超时，重试只会把等待翻倍）。
- 每次尝试各自 `createRequestSignal(rt)` 并在 `finally` 里 `release()`；两次尝试之间 `await delay(RETRY_DELAY_MS)`。
- 错误串格式**完全不变**：仍是 `<provider> HTTP <status>: <body 前 300 字>`；为了让重试能读到状态码，`ensureOk` 抛 `HttpStatusError extends Error`（`readonly status: number`），message 与旧字符串一致，既有测试不必改。
- 第二次仍失败：抛第二次的原始错误（不回显「重试过」字样，日志里由 ChatService 记）。

### 19.8 管理 API（`src/workers/http/app.ts`）

`AdminAppDeps` 新增 `logs: LogStore`。新增一条路由（`/api/*` 中间件已覆盖鉴权）：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/logs?after=<id>&limit=<n>` | 取 `id > after` 的日志；`after` 缺省 0，`limit` 缺省 200、夹在 1..500；非法数字按缺省值处理（轮询端点不返回 400）。响应 `{ items: StoredLogEntry[], latest: number }`，`items` 按 id 升序，`latest` = 最后一条的 id（空结果时等于 `after`）。 |

后台登录失败（`POST /api/login` 口令错）额外记一条：level `warn`、scope `admin`、message `登录失败 ip=<CF-Connecting-IP 或 'unknown'>`——**不记输入的口令**。

### 19.9 装配（`src/workers/index.ts`、`src/workers/gateway/durable-object.ts`）

- 入口：`const logStore = createLogStore(env.DB);`，`const sink = (entry: LogEntry): void => { ctx.waitUntil(logStore.append([entry]).catch((error) => { console.warn('[log] 写日志失败：' + describeError(error)); })); };` 传给 `createChatService({ log: sink })` 与 `createAdminApp({ logs: logStore })`。
- 网关 DO：同一份 `createLogStore(this.#env.DB)`，sink 用 `this.#ctx.waitUntil`；`GATEWAY_BUILD` 递增为 `'live-logs-1'`。
- `scheduled`（cron）没有 `ctx`，需要记日志时直接 `await logStore.append([...])` 并自带 try/catch。
- gateway 事件（scope `gateway`）：`Gateway 连接就绪`(info)、`连接报错 <type>`(error)、`丢弃无法解析的下行帧`(warn)、`记录消息失败 <msg>`(error)、`贴表情失败 <raw> <msg>`(warn)、`取名失败 <msg>`(warn)。回复失败由 ChatService 记（scope chat），gateway 不再重复记。

### 19.10 前端（`web/src/pages/LogsPage.tsx`）

- 侧栏/顶栏新增「实时日志」页；挂载即 `after=0&limit=200` 拉一次，之后每 2 秒 `GET /api/logs?after=<最后一条 id>` 增量追加。
- 内存里最多保留 500 条（超出丢最旧）；「暂停」停止轮询但不清空；「清空视图」只清前端。
- 级别过滤：全部 / 信息 / 警告 / 错误；按 scope 再过滤一次（用已拉到的 scope 去重生成选项，不额外请求）。
- 单行 `HH:mm:ss`（`toLocaleTimeString('zh-CN', { hour12: false })`）+ 级别徽标 + scope + message，等宽字体；未暂停时自动滚到底部。
- 轮询失败只页内提示，不弹 401 全局跳转（沿用 api.ts 现有 401 处理即可）。

### 19.11 已知边界

- 日志是**表**不是流：最细粒度 2 秒，且只保留最近 800 条，超出即被覆盖。
- 高频事件（每条频道消息）不记，只在关键节点记，避免把 D1 写满。
- 重试只加一层（共 2 次尝试），不做指数退避队列；持续故障时用户看到的仍是「所有模型都调用失败」，但后台日志里能读到每次的真实错误。

## 20. Key 与模型的对应（适用模型名单 + 同供应商换 Key）

### 20.1 需求与病根

- 需求：路由里写了哪个供应商的模型，就用**那把供应商的 Key**；一把不行再在**同一个供应商内**换下一把。
- 病根：旧的 `KeyRepository.firstEnabled` 按 `created_at, id LIMIT 1` 取「最早启用的那一把」，Key 表里也没有「它服务哪些模型」的信息 —— 于是两把 `openai-compat`（DeepSeek 与 gg）永远只用最早那把，第二把形同虚设。

### 20.2 数据契约（`src/core/types.ts` / `src/core/ports.ts`，逐字）

```ts
export interface ProviderKey {
  id: string; provider: ProviderId; label: string; baseUrl?: string;
  keyHint: string; enabled: boolean; createdAt: string;
  models: string[];   // 适用模型名单；空数组 = 全部模型都可用
}

export interface DecryptedKey {
  id: string; provider: ProviderId; label: string; baseUrl?: string;
  apiKey: string; models: string[];
}

export interface KeyRepository {
  list(): Promise<ProviderKey[]>;
  listEnabled(provider: ProviderId): Promise<DecryptedKey[]>;  // enabled=1，按 created_at,id 升序
  getDecrypted(id: string): Promise<DecryptedKey | null>;
  create(input: {
    provider: ProviderId; label: string; baseUrl?: string; apiKey: string; models?: string[];
  }): Promise<ProviderKey>;
  remove(id: string): Promise<void>;
}
```

`firstEnabled` 删除。仓储只负责「取全并按创建时间排序」，偏好排序在 core（§20.4）——排序规则要能被单测钉住，不能藏在 SQL 里。

### 20.3 存储（`migrations/0006_key_models.sql`）

```sql
ALTER TABLE provider_keys ADD COLUMN models TEXT NOT NULL DEFAULT '';
```

- 列里存**逗号分隔的原始名单**，`''` 表示空数组；读写都 trim + 丢弃空串，**保留原始大小写**（匹配时才统一小写）。
- `create` 的 INSERT 显式列出 `models`；三处 SELECT（`list` / `listEnabled` / `getDecrypted`）都显式列名并带上 `models`。
- 老数据不动：`DEFAULT ''` 让既有 Key 自动成为「通用」，无需回填。

### 20.4 匹配与排序（`src/core/providers/key-match.ts`）

```ts
export function normalizeModelPatterns(raw: readonly string[]): string[]
export type KeyRank = 0 | 1 | 2;
export function rankKey(patterns: readonly string[], model: string): KeyRank;
export function orderKeysForModel(keys: readonly DecryptedKey[], model: string): DecryptedKey[];
```

- 归一化：trim → 丢空 → 去重（小写比较）→ 去尾部 `*` 之外的非法字符（只允许字母、数字、`._:-` 与结尾 `*`；字母按 unicode 算，所以中文模型名如 `假流式-pg-gemini-4-argon` 能原样进名单）。
- `rankKey`：**0** = 显式命中（名单里有一项小写后等于模型名，或以 `*` 结尾且模型名以该前缀开头）；**1** = 通用（名单为空，或只剩 `*`）；**2** = 声明了别的模型。
- `orderKeysForModel`：按 `(rank, 原序)` 稳定排序，同 rank 保持 `created_at,id` 顺序。三档**全部保留在候选里**——名单是偏好不是硬约束，新模型没来得及声明时仍能跑通。

### 20.5 ChatService 换 Key 循环（`src/core/chat/service.ts`）

- `run()`：`const all = await keys.listEnabled(model.provider)`；空 → `attempts.push({ model, error: 'NO_KEY_FOR_PROVIDER' })`；否则 `orderKeysForModel(all, model.model)` 逐把尝试。
- **流式铁律**：只有在**首个 chunk 之前**失败才换下一把 Key；一旦已经产出可见文本就停止换 Key、把该候选模型计为失败——否则同一条消息会被从头重写一遍（用户会看到文字跳变）。
- `summarize()`：非流式，逐把 Key 全部尝试。
- 失败归集：候选模型失败时记**最后一把 Key** 的原始错误，`ALL_PROVIDERS_FAILED: <json>` 形状不变；`NO_KEY_FOR_PROVIDER` 只在「该供应商一把 enabled 的 Key 都没有」时出现。
- 成功日志（§19.6）追加 ` key=<label>`（用户自己起的备注，永不含密钥）；失败日志不变。

### 20.6 管理 API（`src/workers/http/app.ts`）

- `GET /api/keys`：每项新增 `models: string[]`（`keyDto` 白名单复制，**不得**多带 ciphertext/明文）。
- `POST /api/keys`：接受 `models?: string[]`；校验 ≤20 项、每项 1..64 字符、字符集 `[\p{L}\p{N}._:*-]`（`app.ts:404` 的 `KEY_MODEL_PATTERN`，带 `u` 标志；逗号与空白永远不收——前者是库里的分隔符）、去重（小写比较）、保存原始大小写；不合法 → `400 { error: 'BAD_MODELS' }`。缺省当作 `[]`（通用）。
- `POST /api/keys/:id/test`（探测）不变。

### 20.7 前端（`web/src/pages/KeysPage.tsx`）

- 新增输入「适用模型（逗号分隔，留空 = 全部；支持 `deepseek-*` 通配）」，提交时按逗号切开成 `string[]`。
- 列表行显示 `适用模型：全部` 或 `适用模型：deepseek-*、gpt-4o-mini`。

### 20.8 已知边界

- 名单是**排序偏好**不是硬约束：所有 enabled 的 Key 都在候选里，声明命中只是排前面。
- 单次回复最坏上游调用数 = `len(候选模型) × len(同供应商 Key) × 2`（每把各自重试一次，§19.7），时延随 Key 数线性增长。
- 换 Key 只在同一 `provider` 内发生；跨供应商仍靠路由的 `fallbacks`。
- 用户删掉名字里带通配的 Key 后，路由不会自动改写——名单只影响选择，不影响路由存了什么。
- 网关侧跑的是同一份 ChatService（Durable Object 内）：GATEWAY_BUILD 递增为 'timeout-3min-1'，[gateway] alarm build=timeout-3min-1 出现才代表 @ 路径也走新逻辑（§13 的换码延迟同样适用）。
## 21. 表情选择独立模型

> 本段把它拆成一次独立调用：主模型不必再惦记表情，另有一个（通常更便宜的）模型专门决定贴什么。
> 用户四点选择：①后台新增「表情」页配置；②每轮回复后都问一次、可回答不贴；③主模型与表情模型两边都贴、合并最多 2 个；④表情模型看「对方消息 + 我的回复正文 + 表情清单」。

### 21.1 数据契约（`src/core/types.ts`）

```ts
export interface ReactionModelConfig {
  enabled: boolean;      // false = 不问表情模型，只剩主模型自己的 [[react:]]
  provider: ProviderId;  // 复用现有三种供应商
  model: string;         // 供应商原始模型名，不做别名映射
}
```

`TurnContext` 新增 `wantReactions?: boolean`：只有网关普通消息路径设 `true`；斜杠命令不设（没有可贴表情的触发消息，省一次调用）。

### 21.2 存储（`migrations/0007_reaction_model.sql`）

```sql
CREATE TABLE IF NOT EXISTS reaction_model (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表：全局只有一套表情模型
  enabled INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
```

端口（`src/core/ports.ts`）：

```ts
export interface ReactionModelStore {
  /** 未配置 / provider 不在枚举内 / model 空白 都返回 null（= 没有表情模型） */
  get(): Promise<ReactionModelConfig | null>;
  put(cfg: ReactionModelConfig): Promise<void>;
}
```

`createRepositories(...)` 的返回值新增 `reactionModels: ReactionModelStore`。

### 21.3 纯逻辑（`src/core/chat/reaction.ts`）

```ts
export const REACTION_TARGETS_HEADER = '【可贴表情的消息】';
export function renderReactionTargets(targets: readonly ReactionTarget[] | undefined): string;
export const REACTION_MAX_CATALOG = 40;      // 清单最多列 40 个，与 §18 的 renderEmojiBlock 一致
export function buildReactionRequest(
  cfg: ReactionModelConfig,
  input: {
    userText: string;
    botReply: string;
    /** 贴表情提示词（§33.4）：三层解析后的那一份，与主模型 system 里的段落同源 */
    guide: string;
    customEmojis?: CustomEmoji[];
    images?: LlmImage[];
    targets?: readonly ReactionTarget[];
  },
): LlmRequest;
export function normalizeReactions(raw: string): ReactionRequest[];
```

`REACTION_SYSTEM_PROMPT` 这个写死常量本版已删除（§33）：`buildReactionRequest` 收的是**解析后的文案**（`input.guide`，`src/core/chat/reaction.ts:117`），与主模型那段【表情】共用同一份（§33.4）。内置默认文案（`DEFAULT_REACTION_GUIDE`，§33.6）仍写死三件事：只输出表情本身（unicode 或清单里的名字）、**不值得贴就一行 `[[react:…]]` 都不写**、不要解释 / 不要标点 / 不要代码围栏。none-head-1 起这份共用文案里不再提 `NONE`——「回一行 `NONE`」只作为 `NO_REACTION_NOTE` 拼在表情请求的 system 末尾（§33.6），主模型那一侧看不到。

`buildReactionRequest`：`model = cfg.model`、`system` = 解析后的文案（三层都没配时是 `DEFAULT_REACTION_GUIDE`，§33.4）**再拼一行 `NO_REACTION_NOTE`**（`guide + '\n\n' + NO_REACTION_NOTE`；`guide` 为空时只发 `NO_REACTION_NOTE`，§33.6）、
`messages[0] = { role:'user', content: ['【对方的消息】', userText, '【我的回复】', botReply, 清单段].join('\n') }`；
清单段为空（没有自定义表情）时整段不出现；`temperature` 不设，走供应商默认。

`normalizeReactions(raw)`：§21 时这里是单值版 `normalizeReaction(raw): string | null`（取第一行并 trim → 整段是 `[[react:X]]` 就取 X（复用 §18.4 的 `splitReactDirectives`）→ 去掉包裹的反引号与引号 → 空 / `NONE` / `none` / `无` / `不贴` 返回 `null` → 含空白只取第一个 token → 长度 > 64 返回 `null`）；**§28.6 起改成逐行解析、返回 `ReactionRequest[]`**，规则见 §28.7；本版只把文案来源换掉，解析边界一个字没动（§33.8）。

### 21.4 ChatService（`src/core/chat/service.ts`）

- deps 新增 `reactionModels?: ReactionModelStore`；没接线 = 没有表情模型，不报错。
- `run` 成功产出正文后（`conversations.append` 之后、`return` 之前），当 `ctx.wantReactions === true` 且 `reactionModels` 已接线时问一次：
  - `get()` 为 null 或 `enabled !== true` → 不调用；
  - `keys.listEnabled(cfg.provider)` 为空 → warn `[chat] 表情模型没有可用 Key`，不贴；
  - 用 `orderKeysForModel` 排序后逐把试（非流式 `providers[cfg.provider].chat(...)`），一把失败换下一把；全失败只 warn `[chat] 表情选择失败：…`；
  - 成功：`normalizeReactions(result.text)` 为空数组 → 不贴；否则记 info `[chat] 表情选择 model=<provider>/<model> value=<一个或多个表情> ms=<毫秒> images=<张数> guide=<layer>`（§28.1 / §33.4）。
- 合并（Q3-B）：`reactions = dedupe([...主模型的, ...表情模型的]).slice(0, MAX_REACTIONS)`，主模型的排前面，上限是 `MAX_REACTIONS = 10`（§28.1 把 §18.4 的 2 提到 10，常量在 `src/core/chat/react.ts:4`）。
- 表情模型**任何时候都不许抛错**，不许影响正文、落库、摘要。

### 21.5 管理 API（`src/workers/http/app.ts`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/reaction-model` | `{ config: ReactionModelConfig }`；未配置时 `{ enabled:false, provider:'openai-compat', model:'' }` |
| PUT | `/api/reaction-model` | body `{ enabled, provider, model }`；provider 必须在枚举内、`enabled:true` 时 model trim 后非空，否则 400 `{ error:'BAD_REACTION_MODEL' }`；成功回配置本体 |

`AdminAppDeps` 新增 `reactionModels: ReactionModelStore`。

### 21.6 前端（`web/src/pages/ReactionPage.tsx`）

新增「表情」tab：启用开关、供应商下拉（openai-compat / anthropic / gemini）、模型名输入、保存按钮；保存成功显示「已保存」；
顶部一行说明「每轮回复后会单独问一次这个模型要不要贴表情；不启用就只用主模型自己的表情指令」。§33 起这一页下面多一节「贴表情提示词」（global / guild / channel 三层文案，接口见 §33.7）。

### 21.7 网关（`src/workers/gateway/durable-object.ts`）

- 组装 `TurnContext` 时加 `wantReactions: true`。
- 注入 `reactionModels`（`createRepositories` 多出来的那个字段）。
- 门牌在 §21 落地时是 `'react-model-1'`，§23/§24 之后升到 `'emoji-alias-1'`，§26 之后升到 `'memory-config-1'`，摘要段头第一版 `'summary-time-1'`，§27 改成覆盖时间段后升到 `'summary-span-1'`，§28 升到 `'react-spread-3'`，§29 起是 `'stream-reply-1'`，改成「首字到了才发」后是 `'stream-reply-2'`；门牌是历史值，永远以 `src/workers/gateway/engine.ts:129` 的值为准；§30 起 `'self-host-1'`（自托管移植，同一枚门牌两个宿主都在打）→ `'self-host-2'`（摘要单批跟阈值），`'memory-append-1'`（累积记忆，§31）→ `'memory-budget-1'`（注入预算频道级可配，§31.3）→ `'memory-nocap-1'`（写侧不再设上限，§31.7）→ `'memory-nolimit-1'`（注入条数与自动总结阈值都不设上限，§31.8）→ `'prompt-segments-1'`（提示词改成多段，§32）→ `'prompt-bounds-1'`（提示词保存补上数值范围、停用段不再挡保存，§32.8）→ `'reaction-guide-1'`（贴表情文案三层可自定义、取消强制分散，§33.9）→ **`'reaction-template-1'`**（表情素材模板三层可自定义、表情模型能看最近 20 条历史，§34.7）→ **`'summary-backfill-1'`**（选择性补记：后台按时间范围挑段追加一段记忆、游标不动，§35）→ **`'summary-order-1'`**（读消息改按 `created_at` 排序、自动总结游标取批内最大 id，§35.7）→ **`'summary-order-2'`**（选区按 id、送模型按时间序，§35.7 的漏行归零）→ **`'backup-ui-1'`**（网页后台一键手动备份：请求/状态文件 + 每分钟 timer，§36）→ **`'reply-error-1'`**（流里的错误帧抛错、零字正文按候选失败处理，§37）→ **`'reply-error-2'`**（空回复时同一候选模型重试 3 次才换候选，§37）→ **`'fake-stream-1'`**（假流式：整段到手后切片挤出去，§29.6）→ **`'fake-stream-2'`**（假流式的片数做成三层可配、0 = 关闭，§38）→ **`'mention-1'`**（服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户，`@everyone` / `@here` / `@角色` 仍不解析，§39，前一版）→ **`'mention-2'`**（@ 前缀与「…(已截断)」都先从正文预算里扣掉，正文打满 1900 时不再吃掉尾部与截断提示，§39.2，前一版）→ **`'reply-continue-1'`**（被掐断的半句自动续上：协议层 + 文本层双信号判定、把已写正文当 assistant 前缀让模型接着说，最多续 2 次、合并累计上限 3000 字，续段接在同一条消息里，§40，前一版）→ **`'stream-edit-1'`**（边说边编辑：服务层不再节流、模型每来一块就立刻推给同一条消息，真正的节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推，§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，更早）→ **`'prompt-defaults-1'`**（同一套两块模板只有一份全局的：`prompt_defaults` 单行表，解析顺序 `channel > guild > global > 内置默认 > 代码常量`，迁移 `0020`，§45，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7。
- 斜杠命令路径不设 `wantReactions`，仍按 §18.7 忽略 reactions。

### 21.8 已知边界

- 每轮多一次上游调用（仅网关普通消息路径）；提示词与主对话完全隔离，不写进 messages、也不进摘要。
- 表情模型没有 fallbacks：选的模型挂了，这轮就是不贴。
- 名字不在清单里仍会被 §18.6 丢弃，日志里能看到 `表情不在该服务器的清单里`。
- 未配置（表空）时行为与 §18 完全一致。


## 22. 多模态图片（主对话与表情模型都能看图）

### 22.1 需求口径

用户 2026-10-26 决定（四问全选推荐项）：

- **只有表情模型看图**（2026-10-26 当时的决定）；主对话模型仍是纯文本，历史、摘要素材、回复正文都不受图片影响。
  - **`vision-main-1` 起这一条被扩展了**：主对话模型也接同一轮那几张图，但只进首段请求、续写不带图（§22.9）。上面这行保留为历史口径。
- 网关先把 Discord 附件下载成 base64 再内联：Anthropic 只收 base64、Gemini 要 inlineData，只有 OpenAI 兼容能直传 URL，内联是三家唯一通用的形状。
- 看图范围 = 被 @ 那条消息的图片附件 + 它回复的那条消息的图片附件，按此顺序。
- 每个请求最多 4 张、单张 ≤5MB；超出与抓取失败的直接跳过，不影响文字。

### 22.2 数据契约（src/core/types.ts，已先行落地）

```ts
export interface LlmImage {
  mediaType: string;   // image/png；按附件的 content_type 取，缺失时按扩展名猜
  base64: string;      // 原始字节的 base64，不带 data: 前缀、不含换行
}
```

- `LlmRequest.images?: LlmImage[]`：适配器只把它们附加到**最后一条** `role === 'user'` 的消息上；没有 user 消息时整段忽略（绝不凭空造消息）。缺省 = 纯文本，线缆形状与旧版逐字相同。
- `TurnContext.loadImages?: () => Promise<LlmImage[]>`：懒加载。§22 落地时只有「表情模型已启用且请求真的要发」才会被调用；`vision-main-1` 起主对话也会调它，但一轮只触发一次真实下载（§22.9）。抛错按「没有图」处理。

### 22.3 三个适配器的线缆（无图时形状不变）

| 供应商 | 有图时该条 user 消息承载内容的方式 |
| --- | --- |
| openai-compat | `content` 变成 `[{type:'text',text}, {type:'image_url',image_url:{url:'data:<mediaType>;base64,<base64>'}}]` |
| anthropic | 该条消息 `content` 变成 blocks `[{type:'text',text}, {type:'image',source:{type:'base64',media_type,data}}]` |
| gemini | `parts` 变成 `[{text}, {inlineData:{mimeType,data}}]` |

顺序：文字在前，图片按数组顺序随后；图片不参与 role 变换（gemini 仍按原 role 映射 user/model）。

### 22.4 网关（新建 src/workers/gateway/images.ts）

- `MAX_IMAGES = 4`、`MAX_IMAGE_BYTES = 5 * 1024 * 1024`、`ImageRef { url: string; mediaType: string; size: number }`。
- `collectImageRefs(message)`：先取本条消息的 `attachments`，再取 `replyTo.attachments`；只留 `mediaType` 以 `image/` 开头（缺失时按扩展名 .png/.jpg/.jpeg/.webp/.gif 猜）且 `size <= MAX_IMAGE_BYTES` 的，取前 `MAX_IMAGES` 个。
- `loadImages(refs, fetchImpl)`：逐个下载 → `arrayBuffer()` → `toBase64`；单个失败或空体跳过并 `console.warn('[gateway] 图片下载失败：' + url)`；返回成功的那些（可能为空数组）。
- `toBase64(bytes: ArrayBuffer)`：分块 `String.fromCharCode` 再 `btoa`，避免大图一次性展开爆栈。
- `IncomingMessage.attachments: ImageRef[]`、`IncomingMessage.replyTo.attachments?: ImageRef[]`。

### 22.5 解析（src/workers/gateway/message.ts）

- `payload.attachments` 与 `payload.referenced_message.attachments` 都按 §22.4 的规则窄化；字段缺失一律当空数组，老消息形状不变。

### 22.6 表情请求（src/core/chat/reaction.ts + service.ts）

1. `buildReactionRequest(cfg, { userText, botReply, customEmojis?, images? })`：`images` 非空才写进 `LlmRequest.images`。
2. `askReactionModel` 在发请求之前取图：`ctx.loadImages === undefined ? [] : await ctx.loadImages()`，整段 try/catch，失败 `console.warn('[chat] 读取图片失败，按无图继续：…')`。
3. 只有走到 `askReactionModel` 才会触发下载——未接线、未配置、未启用三种情况绝不下载任何字节。
4. 成功日志末尾追加 ` images=<张数>`（§21.4 那行的扩展）。
5. 图片不进 `conversations.append`、不进历史、不进摘要：`LlmImage` 只存在于这一次请求里。
6. `vision-main-1` 起这一份取图由 turn 级 memo 提供（§22.9）：表情这一侧拿到的与主对话是**同一个 promise**，不再各下一遍；未接线 / 未启用 / 没 Key 三种情况仍然一个字节都不下载。

### 22.7 斜杠命令与门牌

- 斜杠命令路径不设 `loadImages`（与 `wantReactions` 同源：没有可贴表情的触发消息）。
- `GATEWAY_BUILD = 'vision-1'` 是 §22 落地时那一版的门牌（只有表情模型看图）；`vision-main-1` 起主对话也接图（§22.9），当前门牌见 §33.9。

### 22.8 已知边界

- 只能看图：视频、文件、语音一律忽略（`content_type` 非 `image/*`）。
- Discord 附件 URL 带签名会过期，所以必须即时下载，不做缓存。
- 单轮 token 成本上升：大图会被上游重新编码计费，建议只开给支持读图的小模型。
- 图片不落库，「以后让它回看那张图」做不到——要的话得先加附件表。

### 22.9 主对话接图（`vision-main-1` 起）

> 编号说明：§22.4 / §22.6 被 `src/workers/gateway/images.ts` 与 `src/core/chat/service.ts` 的注释直接引用，所以这一节排在 §22.8 之后、前面几节的编号不重排。

2026-11-01 的这一版把「看图」从表情模型扩到主对话模型（commit `0c45f0b`）：**同一轮里主对话的首段请求与表情请求共用同一份图片；续写请求不带图。**

取图链路（一轮只下载一份）：

1. 网关收到消息只收集**引用**、不下载：`collectImageRefs(message)` 拿到 `imageRefs`（`src/workers/gateway/engine.ts:667`），**非空才挂** `context.loadImages`（`:668-674`）；空数组时连键都不设，纯文字路径与旧版逐字相同。
2. 网关那枚钩子自带同轮 memo：`let cachedImages: Promise<LlmImage[]> | undefined` + `cachedImages ??= loadImages(imageRefs, imageFetch)`（`src/workers/gateway/engine.ts:672-673`）——主对话与表情模型各调一次，但一轮只下载一次（下载本身见 §22.4）。
3. 服务层再包一层 turn 级 memo：`turnImages(ctx)` 返回闭包，`cached ??= loadTurnImages(ctx)`（`src/core/chat/service.ts:820-826`）；真正取图在 `loadTurnImages`（`:829-837`）——`ctx.loadImages === undefined` 直接返回空数组，任何异常先 `console.warn('[chat] 读取图片失败，按无图继续：' + describeError(error))` 再返回空数组。**读图失败只等于没有图，绝不吃掉这一轮回复。**
4. 同一份 memo 三处共用：`const loadTurnImagesOnce = turnImages(ctx)`（`src/core/chat/service.ts:936`）；主对话在 `:1037` 取一次，位置在**模型 / Key 循环之外**（换候选模型、换 Key 都不重新读图）；表情那一路 `selectReaction(ctx, text, guide, template, reactionHistory, loadTurnImagesOnce)`（`:1197`）→ `askReactionModel` 里 `const images = await loadImages()`（`:860`）。「一轮只下一份」靠的是同一个 promise，不是调用点自觉（§22.6 第 6 条）。

请求形状（无图时逐字不变）：

- 首段：`src/core/chat/service.ts:1071-1076` 用条件展开 `{ model, system, messages, ...(images.length > 0 ? { images } : {}) }`——没有图时既不是 `images: []` 也不是 `images: undefined`，请求与旧版逐字相同（§22.3 三个适配器的线缆不变）。
- 续写：`src/core/chat/service.ts:1108-1116` 另建 `continueRequest`，**绝不 `...request`**，只继承 `model` / `system` / `messages`（`continuationMessages(messages, raw)`）与取词参数。理由在代码注释里：适配器把图片挂到**最后一条** `role === 'user'` 的消息上，而续写时那条正好是「继续写」的指令，挂上去既浪费也可能干扰。
- 日志：成功那行按需追加 ` images=<张数>`，位置紧跟 `cont=`（`src/core/chat/service.ts:1183-1186`，条件 `images.length > 0`）——无图时整行与旧版逐字相同；有图时一眼能看出真带了几张。
- 表情请求那条日志的 `images=` 仍是 §22.6 第 4 条（`src/core/chat/service.ts:895`，0 张也照写）。

没变的部分：

- 上限没变：`MAX_IMAGES = 4`（`src/workers/gateway/images.ts:11`）、`MAX_IMAGE_BYTES = 5 * 1024 * 1024`（`:14`），只认 `image/*`（§22.1）。
- 图片仍**不落库**：不进 `conversations`、不进历史注入、不进摘要素材、不进续写请求（§22.6 第 5 条、§22.8）。
- 斜杠命令路径仍不设 `loadImages`（§22.7），命令里附的图依旧看不到。
- 主对话模型支不支持读图仍是供应商的事：配一个纯文本模型，图片发过去会被忽略或被上游拒（与 §22.8 同一条口径，运维侧排错见 `docs/operations.md` §28.7）。

---

## 23. 表情自动认图（表情描述）

### 23.1 需求口径（2026-10-26 定）

起因：服务器里没有任何自定义表情叫「奶龙」，但有两个长得像的（`laugh`、`e94c105494eef01fe3ee53dea6fe9925`）。机器人只拿到「名字 + id」，看不到图，所以「给我贴奶龙」永远只能回「没有这个表情」。

选定做法：**让表情模型看表情图自己认**。三条规定：
1. 认图模型**复用「表情」页配的那个模型**（`reaction_model` 行里的 provider/model），不另开一套配置。
2. 认图产物是**一句中文短描述**，落 D1，注入提示词时写成 `:laugh:`(黄胖小子咧嘴大笑)。
3. 触发两条：后台按钮手动认（可强制全量重认）；网关发现清单里有表情没描述时**后台补认缺的**（不重认已有的）。

### 23.2 数据契约

`src/core/types.ts`：
```ts
export interface CustomEmoji { name: string; id: string; animated?: boolean; description?: string }
export interface EmojiDescription { emojiId: string; name: string; description: string; updatedAt: string }
export interface EmojiDescribeResult { described: number; failed: number }
```
`src/core/ports.ts`：
```ts
export interface EmojiDescriptionStore {
  list(guildId: string): Promise<EmojiDescription[]>;
  putMany(guildId: string, rows: ReadonlyArray<Omit<EmojiDescription, 'updatedAt'>>): Promise<void>;
}
```
迁移 `migrations/0008_emoji_descriptions.sql`：
```sql
CREATE TABLE IF NOT EXISTS emoji_descriptions (
  guild_id    TEXT NOT NULL,
  emoji_id    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, emoji_id)
);
```
`createRepositories` 返回值新增 `emojiDescriptions`。`putMany` 用 `ON CONFLICT (guild_id, emoji_id) DO UPDATE`，`updated_at` 由仓储按写入时刻补（ISO）。

### 23.3 core 纯逻辑：`src/core/chat/emoji-describe.ts`（新建）

```ts
export const DESCRIBE_MAX_CHARS = 20;        // 一句描述的上限（UTF-16 code unit，超出截断）
export const DESCRIBE_BATCH_SIZE = 6;        // 一次请求塞几张图：多了模型会对错号
export interface DescribeTarget { id: string; name: string; image: LlmImage }
export function buildDescribeRequest(cfg: ReactionModelConfig, batch: readonly DescribeTarget[]): LlmRequest
export function parseDescribeOutput(raw: string, batch: readonly DescribeTarget[]): Array<{ emojiId: string; description: string }>
```
`buildDescribeRequest`：system 放 `DESCRIBE_SYSTEM_PROMPT`（见下）；user 消息文本逐行 `N. <名字>（id <id>）`，末尾一行要求「每行输出 `id=描述`」；`images` 按 batch 顺序编号（第 1 张 = 第 1 行）。不设 temperature/maxTokens。

`DESCRIBE_SYSTEM_PROMPT` 必须包含这几条：只描述画面上看到的东西（角色外形、表情、动作、文字）；每个表情一句中文，不超过 20 字；不要解释不要代码围栏不要标点结尾；只输出 `id=描述` 形式的行，宁可漏也不要编。

`parseDescribeOutput`：按行切；每行必须形如 `<batch 里出现过的 id>=<描述>`（`=` 前后空白忽略，全角 `＝` 也认）；描述剥掉反引号/引号后再截 `DESCRIBE_MAX_CHARS`；空描述、id 不在 batch 里的行丢弃；同一 id 取第一次出现。返回顺序按 batch 顺序。

### 23.4 worker 侧执行器：`src/workers/emoji/describe.ts`（新建）

```ts
export interface DescribeDeps {
  reactionModels: ReactionModelStore;
  emojiDescriptions: EmojiDescriptionStore;
  keys: KeyRepository;
  providers: Record<ProviderId, LlmProvider>;
  fetch?: typeof fetch;              // 调用时才读 globalThis.fetch
}
export interface DescribeOptions { force?: boolean; limit?: number }
export async function describeGuildEmojis(
  deps: DescribeDeps, guildId: string, botToken: string, options?: DescribeOptions,
): Promise<EmojiDescribeResult>
```
流程（逐条实现，不许跳）：
1. `guildId === ''` 或 `botToken === ''` → 直接返回 `{ described: 0, failed: 0 }`。
2. `const cfg = await deps.reactionModels.get();` 为 null → 返回零计数（没配模型就不认）。**不要求 `enabled === true`**：后台想在一个关闭的表情模型上先认好描述也允许。
3. `const emojis = await listGuildEmojis({ botToken }, guildId)`（复用 `src/workers/discord/rest.ts`），抛错向上抛（调用方 try/catch）。只留 `id` 与 `name` 都非空的。
4. `const existing = await deps.emojiDescriptions.list(guildId)`；`options.force !== true` 时把已有 id 从待认里剔掉。
5. 按 `DESCRIBE_BATCH_SIZE` 分批；`options.limit` 限制**总表情数**（网关补认传 12，后台按钮不传=全量）。
6. 每批：下载图片 `https://cdn.discordapp.com/emojis/<id>.<gif|png>`（`animated === true` 用 gif，否则 png）→ `LlmImage`（mediaType 与下载一致；下载失败/空体/非 2xx → 该 emoji 计 `failed` 并从本批剔除；整批都不剩就跳过）。
7. 调模型：`orderKeysForModel(await deps.keys.listEnabled(cfg.provider), cfg.model)` 逐把试**非流式** `deps.providers[cfg.provider].chat(request, { apiKey, baseUrl, fetch })`，第一把成功即止；全失败 → 本批全部计 `failed`、`console.warn('[emoji] 认图失败：' + 最后一把的错误)`，继续下一批。
8. `parseDescribeOutput` 结果 `putMany`（`name` 用清单里的当前名字）；写入条数累加 `described`，解析不出描述的计 `failed`。整函数不 throw（除第 3 步），任何单点失败只 warn。

### 23.5 注入形态

有描述时，两个渲染点都写成 `:名字:`(描述)：
- `src/core/chat/service.ts` 的 `renderEmojiBlock`（现 :155-167）：`:name:` → `:name:(描述)`，描述 trim 后为空则不加括号。
- `src/core/chat/reaction.ts` 的 `renderCatalog`（现 :43）：同上，表情模型看的是同一份清单。
两处的 `MAX` 上限（40）与去重规则不变；描述本身超过 20 字一律截断（core 侧 `DESCRIBE_MAX_CHARS` 只约束认图产出，注入侧不再二次截断）。

### 23.6 管理 API（`src/workers/http/app.ts`）

- `GET /api/emojis?guildId=<id>` → `{ items: EmojiDescription[] }`；`guildId` 空 → 400 `{ error: 'BAD_GUILD_ID' }`。
- `POST /api/emojis/describe`，body `{ guildId: string, force?: boolean }` → `{ described, failed }`；`guildId` 空 → 400 `BAD_GUILD_ID`；`AdminAppDeps.describeEmojis` 未注入 → 501 `{ error: 'DESCRIBE_UNAVAILABLE' }`。
- `AdminAppDeps` 新增两字段：`emojiDescriptions: EmojiDescriptionStore`、`describeEmojis?: (guildId: string, options?: { force?: boolean }) => Promise<EmojiDescribeResult>`。
- 两条都在既有 `ALL /api/*` 鉴权中间件之后，匿名一律 401。

### 23.7 网关（`src/workers/gateway/durable-object.ts`）

1. 取清单之后把描述合并进 `CustomEmoji`：新增 D1 读，但**并入既有 10 分钟缓存**（不新增每消息一条查询）。
2. 清单里有表情缺描述时 `this.#ctx.waitUntil(describeGuildEmojis(...).catch(warn))`，`limit: 12`，绝不阻塞回复、绝不影响本轮。
3. `GATEWAY_BUILD` 升为 `'emoji-vision-2'`（先落 -1，加了第 5 条 prompt 又回退时升到 -2，见 §23.9）。

### 23.8 已知边界

- 认图是**一次性成本**：36 个表情约 6 次模型调用；之后只在有新表情时补认。
- 描述只影响提示词，不落进消息、不进摘要、不影响正文。
- 模型不支持读图时，认图只会失败并留 `[emoji] 认图失败：…`，表情清单退回「只有名字」的老行为。
- 表情改名不会自动重认（描述按 emoji id 存），需要后台点一次强制重认。
- 动画表情只取一帧（gif 原图交给模型）。

### 23.9 上线实录与一次回退

- 上线实测：一次 `POST /api/emojis/describe`（`force: false`）返回 `described: 36` / `failed: 0`，耗时 25272 毫秒（约 25.3 秒，6 批 × 6 个）。
- 试过在 `DESCRIBE_SYSTEM_PROMPT` 里加第 5 条「认得出知名形象就把名字写在最前面」：奶龙仍认不出（二创像素图），且 `force: true` 重认时 36 个里 12 个解析失败（`described: 24` / `failed: 12`）——多出来的那一列让模型写起解释，`id=描述` 的行被挤掉。已回退成四条口径（`src/core/chat/emoji-describe.ts:26-31`）。
- 被否掉的实验留了记录，免得下次再试一遍：`src/core/chat/emoji-describe.ts:23-24` 的注释与 `test/emoji.describe.test.ts:40` 的用例注释。
- 网关门牌从 `emoji-vision-1` 升到 `emoji-vision-2`（`src/workers/gateway/durable-object.ts:71`），§24 之后又升到 `emoji-alias-1`。


---

## 24. 表情别名（管理员手工配）

### 24.1 需求口径


§23 的认图解决的是「模型看得见图」，解决不了「这个表情其实叫奶龙」——`laugh` 的描述是「黄色胖角色站立掐腰」，
模型认不出它就是奶龙二创。别名是人工补的那一层：管理员把「奶龙」指到 `laugh`，模型从此两种叫法都认。


1. **写进提示词 + 解析层都生效**：清单里同时出现 `:laugh:` 与别名「奶龙」，模型挑表情就能对上号；
   万一它写 `:奶龙:` 或 `[[react:奶龙]]`，解析层也要换得到真正的 `laugh:id`。
2. **目标表情从该服表情列表下拉选**：后台拉一次 Discord 的 `/guilds/{id}/emojis`，管理员选真实表情、填别名，不手抄 ID。
3. 上线后由 dispatcher 把「奶龙 → laugh」写进生产库，用户回 Discord 直接验证，不用自己点。

### 24.2 数据契约

`src/core/types.ts`：

```ts
/** 服务器自定义表情（只保留可用的） */
export interface CustomEmoji {
  name: string;
  id: string;
  animated?: boolean;
  description?: string;   // §23
  aliases?: string[];     // §24，管理员手工配；缺省表示没有别名
}

/** 管理员手工配的表情别名（§24.2）：按 (guildId, alias) 唯一，一条别名指向一个真实表情 */
export interface EmojiAlias {
  alias: string;      // 别名本身，例如「奶龙」
  emojiId: string;    // Discord 表情 ID
  emojiName: string;  // 表情真实名字，例如 laugh
}
```

`src/core/ports.ts`：

```ts
export interface EmojiAliasStore {
  list(guildId: string): Promise<EmojiAlias[]>;
  /** 覆盖写：同 (guildId, alias) 重复添加只更新指向 */
  put(guildId: string, alias: EmojiAlias): Promise<void>;
  /** 别名不存在时静默成功 */
  remove(guildId: string, alias: string): Promise<void>;
}
```

### 24.3 迁移

新建 `migrations/0009_emoji_aliases.sql`，逐字：

```sql
-- 表情别名（§24.3）：管理员手工配，一个别名只指向一个表情
CREATE TABLE IF NOT EXISTS emoji_aliases (
  guild_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  emoji_id TEXT NOT NULL,
  emoji_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, alias)
);
```

`src/workers/db/d1-repository.ts`：

- `createRepositories(...)` 的返回值新增 `emojiAliases: EmojiAliasStore`（与 `emojiDescriptions` 并列，同一函数里构造）。
- `list`：显式列名 `SELECT alias, emoji_id, emoji_name FROM emoji_aliases WHERE guild_id = ? ORDER BY alias ASC`。
- `put`：`INSERT INTO emoji_aliases (guild_id, alias, emoji_id, emoji_name, created_at) VALUES (?, ?, ?, ?, ?)`
  + `ON CONFLICT (guild_id, alias) DO UPDATE SET emoji_id = excluded.emoji_id, emoji_name = excluded.emoji_name`（**不覆盖 created_at**）。
  `created_at` 用仓储里的 `nowIso()` 补。
- `remove`：`DELETE FROM emoji_aliases WHERE guild_id = ? AND alias = ?`。

### 24.4 提示词渲染（core）

`src/core/chat/service.ts` 与 `src/core/chat/reaction.ts` 里那两份**必须逐字一致**的 `withEmojiDescription`
统一改签名为 `withEmojiDescription(emoji: CustomEmoji): string`（调用点传整个 emoji 对象），规则：

1. `token = ':' + emoji.name.trim() + ':'`。
2. `descText = (emoji.description ?? '').trim()`；非空时 `token + '(' + descText + ')'`。
3. `aliasText = (emoji.aliases ?? []).map(a => a.trim()).filter(a => a !== '').join('、')`；非空时再拼 ` + ' 别名「' + aliasText + '」'`。
4. 没描述没别名时结果与 §23.5 逐字相同（只有 `:名字:`）。

例：`:laugh:`(黄色胖角色站立掐腰) 别名「奶龙」／`:laugh:` 别名「奶龙」／`:laugh:`(黄色胖角色站立掐腰)。
去重与条数上限（`MAX_EMOJI_IN_PROMPT = 40`、`REACTION_MAX_CATALOG = 40`）都不变，仍按 `:名字:` 判重。

### 24.5 解析层（Discord 线缆）

`src/workers/discord/emoji.ts` 两个函数都要认别名，且**真实表情名优先于别名**
（别名撞到某个表情的真名时，真名说了算，否则同名表情会被别名抢走）。

- `EMOJI_TOKEN` 的 `:名字:` 分支从 `[A-Za-z0-9_~]{2,32}` 放宽成 `[^\s:<>]{2,32}`：中文别名（奶龙）不是 ASCII，
  不放开正则根本匹配不到；尖括号分支 `<a?:[A-Za-z0-9_~]{2,32}:\d+>` 保持不变（先匹配先返回，不会被二次替换）。
- `resolveInlineEmojis`：查表顺序「真名 → 别名」，命中后**永远输出真实表情名**：`<:laugh:<ID-5>>`，
  绝不用别名当 name 拼标记（Discord 只认真实名字）。
- `resolveReactionEmoji`：先按现有规则查真名（大小写不敏感），没命中再查别名（大小写不敏感，同样先剥首尾冒号），
  命中返回 `真实名字 + ':' + id`；都查不到才走 unicode 判断与原样 null。

### 24.6 管理 API

`src/workers/http/app.ts` 的 `AdminAppDeps` 新增：

```ts
emojiAliases: EmojiAliasStore;                                  // 必填
listEmojis?: (guildId: string) => Promise<CustomEmoji[]>;        // 可选：拉该服真实表情清单
```

新增四条路由（都在既有的 `ALL /api/*` 鉴权中间件之后）：

| 方法与路径 | 入参 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET /api/emojis/live?guildId=` | `guildId` | `{ items: [{ id, name, animated }] }`（按 name 升序） | 400 `BAD_GUILD_ID`；501 `EMOJI_LIST_UNAVAILABLE`（没注入 `listEmojis`）；502 `EMOJI_LIST_FAILED`（Discord 调用抛错） |
| `GET /api/emoji-aliases?guildId=` | `guildId` | `{ items: EmojiAlias[] }` | 400 `BAD_GUILD_ID` |
| `PUT /api/emoji-aliases` | body `{ guildId, alias, emojiId, emojiName }` | 200 保存后的 `{ alias, emojiId, emojiName }` | 400 `BAD_GUILD_ID` / `BAD_ALIAS` / `BAD_EMOJI` |
| `DELETE /api/emoji-aliases?guildId=&alias=` | query | 200 `{ ok: true }` | 400 `BAD_GUILD_ID` / `BAD_ALIAS` |

校验（`BAD_ALIAS`）：`alias.trim()` 长度 1–24，不得含 `:`、空白、`<`、`>`。
校验（`BAD_EMOJI`）：`emojiId` 必须纯数字且长度 ≥ 15；`emojiName.trim()` 匹配 `/^[A-Za-z0-9_~]{2,32}$/`。

### 24.7 网关

- `src/workers/index.ts`：`createAdminApp` 的入参补 `emojiAliases: data.emojiAliases` 与
  `listEmojis: (guildId) => listGuildEmojis({ botToken: env.DISCORD_BOT_TOKEN ?? '' }, guildId)`。
- `src/workers/gateway/durable-object.ts`：表情清单装配处（现有 `#withDescriptions`）在同一次装配里再读一次
  `emojiAliases.list(guildId)`，按 `emojiId` 把 `aliases` 挂到对应 `CustomEmoji` 上（找不到对应表情的别名丢弃）。
  读别名失败只 `console.warn`，按没有别名继续（与读描述同一口径），仍在既有 10 分钟缓存之内，不新增每消息一次查询。
- 门牌：`GATEWAY_BUILD` 由 `'emoji-vision-2'` 升为 `'emoji-alias-1'`。

### 24.8 后台页面

`web/src/pages/ReactionPage.tsx` 在「自定义表情认图」下面加一段「表情别名」：

- 服务器 ID 复用页面已有的输入框（同一个 `guildId` 状态）。
- 一行：别名输入框（placeholder「例如：奶龙」）+ 目标表情下拉（选项文本 `name (id)`，数据来自 `GET /api/emojis/live`）+ 「添加」按钮。
- 下方列表：`别名 → name (id)` + 每行「删除」按钮；列表数据来自 `GET /api/emoji-aliases`。
- 一句说明文字：「配了别名之后，模型看到 `:laugh:` 也知道它叫「奶龙」，你直接让它贴奶龙就行。」
- 空清单/未填服务器 ID 时禁用按钮；新增或删除后重新拉列表；失败在页面上显示错误文案（不弹 alert 盖住结果）。

`web/src/api.ts` 新增：`EmojiAlias` 类型、`fetchLiveEmojis(guildId)`、`fetchEmojiAliases(guildId)`、
`saveEmojiAlias(input)`、`deleteEmojiAlias(guildId, alias)`（名字与既有 `fetchEmojiDescriptions` / `describeEmojis` 同风格）。

### 24.9 已知边界

1. 别名只在**服务器维度**配：同一个表情在不同服务器要各配一次。
2. 别名不会改动 Discord 里的表情名，只改我们提示词与解析。
3. 一个别名只指向一个表情；同一个表情可以配多个别名（奶龙、小黄龙）。
4. 别名指向的表情后来被服务器删掉：清单里没有它，别名静默失效（不报错）。
5. 斜杠命令路径照旧不注入表情清单（§23.8），别名对它也没影响。
6. 网关的别名与描述同在 10 分钟缓存里，改了别名最多 10 分钟才对 @ 路径生效（斜杠以外）；
   想立刻生效可等缓存过期，或看门牌（当前值见 §28.7）确认新码已加载。


## 25. 后台手动改摘要（正文与覆盖楼层）

### 25.1 需求口径

- 摘要由模型自动生成并注入 system（§17），但网页后台**看不到也改不了**：一旦写歪（漏人名、把事实记错、覆盖楼层卡在错误位置），只能等下一轮覆盖或去改库。
- 目标：后台新增「摘要」页，能**查**（全部摘要 + 某频道最近消息）、能**改**（正文 + 覆盖楼层）、能**删**、能**立即重算**。
- 不新增表、不新增迁移：直接读写既有的 `conversation_summaries`（§17.2）。
- 「覆盖楼层」= `ConversationSummary.coveredUntilId`，语义是「已总结到 `messages.id` 的这一条，下次只捞比它新的」。

### 25.2 仓储契约

`src/core/ports.ts` 两处扩展（不新增仓储）：

```ts
export interface ConversationStore {
  // …既有方法不变…
  /** 最新 limit 条，返回时翻成正序（时间升序，同值 id 升序）；后台「楼层点选」用 */
  loadLatest(key: ChannelKey, limit: number): Promise<StoredMessage[]>;
}

export interface SummaryStore {
  // …既有 get / put / remove 不变…
  /** 全表，按 guild_id, channel_id 升序；后台摘要列表用 */
  list(): Promise<ConversationSummary[]>;
}
```

- `loadLatest` 的 SQL 是 `ORDER BY created_at DESC, id DESC LIMIT ?`，返回前 `reverse()`，调用方永远拿到时间升序数组（与 `loadRecent`/`loadAfter`/`loadBetween` 一致；时间序以 `created_at` 为准，见 §35.7）。
- `list()` 用显式列名 `guild_id, channel_id, summary, covered_until_id, updated_at`，禁止 `SELECT *`。

### 25.3 五条后台路由（全部在 `ALL /api/*` 鉴权之后）

| 方法 | 路径 | 入参 | 成功 |
| --- | --- | --- | --- |
| GET | `/api/summaries` | 无 | `{ items: ConversationSummary[] }`（没有摘要时 `[]`） |
| GET | `/api/summaries/messages` | `guildId`、`channelId`、`limit`（缺省 50，上限 200） | `{ items: [{ id, role, author, content, createdAt }] }`，`author`/`createdAt` 缺失时不出现该键 |
| PUT | `/api/summaries` | body `{ guildId, channelId, summary, coveredUntilId }` | 200，保存后的 `ConversationSummary` |
| DELETE | `/api/summaries` | `guildId`、`channelId` | `{ ok: true }`；本来没有也回 200 |
| POST | `/api/summaries/regenerate` | body `{ guildId, channelId }` | `{ outcome: SummaryOutcome }`；没有可总结素材时 `{ outcome: null }` 并回 409 `NO_SUMMARY_MATERIAL` |

`SummaryOutcome` 沿用 §17.2：`{ summary, coveredUntilId, summarizedMessages, model }`。

### 25.4 校验与错误码

- `guildId` / `channelId`：非空且 `/^\d{1,32}$/`，否则 400 `BAD_CHANNEL_KEY`。
- `summary`：`trim()` 后长度 1..8000，否则 400 `BAD_SUMMARY`（4000 是注入预算默认值 `SUMMARY_MAX_CHARS`，频道级 `summaryMaxChars` 可覆盖；手写留一倍余量；超预算不拒，注入时从新到旧装，§31.3）。
- `coveredUntilId`：非负整数（同时接受纯数字串：后台数字输入框天然回字符串），且 **≤ 该频道当前最大 `messages.id`**，否则 400 `BAD_COVERED_UNTIL`（允许 0 = 从头重算）。超上界必须拒：游标越过最新消息后，自动总结会长期不触发，且日志里看不出原因。空串、小数、负号一律拒。
- `PUT` 的 `updatedAt` 由服务端取当前时刻，**不接受客户端时间**。
- `POST /api/summaries/regenerate`：没注入 `summarizeChannel` → 501 `SUMMARY_UNAVAILABLE`；`summarize` 抛错 → 502 `{ error: 'SUMMARY_FAILED', detail }`（`detail` 截前 300 字）；`summarize` 返回 null（无素材）→ 409 `{ error: 'NO_SUMMARY_MATERIAL', outcome: null }`。
- 请求体不是 JSON 对象（或 PUT/POST 缺 `guildId`/`channelId`）与缺参数同出口：400 `BAD_CHANNEL_KEY`。
- `GET /api/summaries/messages` 的 `limit` 非法或 ≤0 时用缺省 50；超过 200 按 200。

### 25.5 `AdminAppDeps` 与入口装配

```ts
export interface AdminAppDeps {
  // …既有字段不变…
  summaries: SummaryStore;
  summarizeChannel?: (key: ChannelKey) => Promise<SummaryOutcome | null>;
}
```

`src/workers/index.ts` 的 `handleApi` 里：

- `summaries: data.summaries`（`createRepositories` 已带）。
- `summarizeChannel: (key) => createChatService({ ...data, providers: providers(), config: CHAT_CONFIG }).summarize(key)`：每次调用新建，无跨请求状态；走的是与 `/summary` 命令**完全相同**的 `summarize`（§17.4），不另写一套总结逻辑。

### 25.6 后台页面（新增「摘要」tab）

`web/src/pages/SummaryPage.tsx`：

1. 顶部：`guildId` + `channelId` 两个输入 + 「读取」按钮；右侧是全部摘要列表（`频道 ID · 覆盖到 #id · 更新时间`），点一行把它载入表单。
2. 表单：正文 `textarea`（行数足够，可滚动）、`coveredUntilId` 数字输入（旁注「0 = 从头重算」）；三个按钮「保存」「重新总结」「删除」。
3. 表单下方：「最近消息」列表（`#id · 发言人 · 正文前 30 字`），点一行把它们填进 `coveredUntilId`。
4. 反馈：保存成功显示「已保存」；删除成功清空表单；重新总结成功把返回的 `summary` / `coveredUntilId` 写回表单，失败显示中文错误（映射 §25.4 错误码）。
5. 交互约束（实现时加的，属契约一部分）：三张卡片装上面四件事；写操作要求表单**先绑定到某个频道**（点「读取」或点列表行），改过 ID 后绑定失效并提示重新读取——否则会把 A 的正文写进 B；同一时刻只允许一件事在跑（`busy` 单飞）；「删除」与「重新总结（正文非空时）」都要二次确认。

`web/src/api.ts` 新增：`ConversationSummary` 类型、`SummaryMessage`、`fetchSummaries()`、`fetchSummaryMessages(guildId, channelId, limit?)`、`saveSummary(input)`、`deleteSummary(guildId, channelId)`、`regenerateSummary(guildId, channelId)`。

### 25.7 语义与边界

1. 手改只影响该频道，写入后立即生效：下一轮 `run` 的 `readSummary` 直接读到新值（无需重启、无需等缓存；摘要只有网关那边的表情缓存，摘要本身不缓存）。
2. 楼层改小 = 把一段原文重新纳入「待总结」；改大 = 主动放弃那一段（不写摘要、也不进提示词）。
3. 删掉摘要后自动总结从 0 重来（`coveredUntilId` 为空即 `0`），已删除的原文不会回来（`messages` 里还剩什么就总结什么）。
4. 「重新总结」不吃单批上限以外的消息：它按当前游标往后取，与 `/summary` 同一代码路径，一次只总结一批（单批上限 = `min(500, max(50, 频道阈值))`，§17.4、§26 追加语义）。
5. 并发保存按后写覆盖（无版本号）；两个管理员同时改会互相覆盖，属已知边界（YAGNI）。
6. 页面不校验频道是否存在：填一个空频道只会读到空摘要与空消息列表。
7. 摘要正文里的换行原样保存与注入，不做 markdown 处理。
8. 正文是**整段替换**：保存时提交的是整段累积正文，段头（`【记忆段】（覆盖 …）`）要自己留着；没有段头的正文下次注入时整体当一段（§31.4）。

## 26. 频道级记忆配置（注入条数 + 自动总结阈值 + 注入预算）

### 26.1 需求口径

- 访谈结论：**每个频道各自一套**；后台**新增「记忆」页**；自动总结阈值**允许 0 = 关闭**；注入条数**最小 2**；上限当时订的是 500——`memory-nolimit-1` 起两个数字都取消上限（§31.8）。
- 现状写死两处：`src/workers/index.ts:58` 的 `CHAT_CONFIG = { burstEditIntervalMs: 1200, historyMaxMessages: 50, summaryEveryMessages: 50 }` 与 `src/workers/gateway/durable-object.ts:89` 同形的 `MESSAGE_CHAT_CONFIG`（`burstEditIntervalMs` 这一项后来在 `stream-edit-1` 里删掉了，服务层不再节流，见 §29.7；`historyMaxMessages` 的去向见 §31.8）。
- core 早已支持这两个字段（`src/core/chat/service.ts:68` `historyMaxMessages?`、`:74` `summaryEveryMessages?`），本版只是把「取值来源」从常量换成 D1。

### 26.2 数据契约

```ts
export interface ChannelMemoryConfig {
  guildId: string;
  channelId: string;
  /** 注入最近多少条原文，≥ 2，不设上限（memory-nolimit-1） */
  historyMaxMessages: number;
  /** 未总结消息攒到多少条触发自动总结；0 = 关闭，否则 ≥ 2，不设上限（memory-nolimit-1） */
  summaryEveryMessages: number;
  /** 摘要正文注入 system 的字符预算；0 或缺失 = 未设置（运行时 4000），非零 500..20000（§31.3） */
  summaryMaxChars?: number;
  /** 保存时刻（ISO）；空串 = 按默认值临时拼出来的，库里还没有 */
  updatedAt: string;
}

export interface ChannelMemoryStore {
  get(key: ChannelKey): Promise<ChannelMemoryConfig | null>;
  list(): Promise<ChannelMemoryConfig[]>;
  put(cfg: Omit<ChannelMemoryConfig, 'updatedAt'>): Promise<ChannelMemoryConfig>;
  remove(key: ChannelKey): Promise<void>;
}
```

迁移 `migrations/0010_channel_memory.sql`：

```sql
CREATE TABLE IF NOT EXISTS channel_memory_settings (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  history_max_messages INTEGER NOT NULL,
  summary_every_messages INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, channel_id)
);
```

迁移 `migrations/0012_memory_budget.sql`（本版新增，注入预算列）：

```sql
-- 0012: 摘要注入 system 的字符预算；0 = 未设置，运行时用默认 4000（SUMMARY_MAX_CHARS）
ALTER TABLE channel_memory_settings ADD COLUMN summary_max_chars INTEGER NOT NULL DEFAULT 0;
```

- `createRepositories` 返回值加 `channelMemory`。
- `list()` 用显式列名，按 `guild_id, channel_id` 升序；`put()` 用 `ON CONFLICT (guild_id, channel_id) DO UPDATE`，`updated_at` 由仓储补，并回写保存后的整行。
- **没有行 = 默认值**（50 / 50，预算 4000），不做逐字段合并：后台保存时三个字段一起提交；`summaryMaxChars` 为 0 时不建这个键（列里仍落 0），读侧一律按「未设置」处理。

### 26.3 core 取值语义（`src/core/chat/service.ts`）

- `ChatServiceDeps` 加 `channelMemory?: ChannelMemoryStore`（可选；未接线时行为与今天完全一致）。
- `run()` 里把 `channelMemory.get(key)` 并入既有那批并行查询（7 项 → 8 项），并 `catch` 降级：失败打 `console.warn('[chat] 读取频道记忆配置失败，按默认继续：' + describeError(error))` 后按默认走。
- 取值顺序：`settings?.historyMaxMessages ?? config.historyMaxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES(50)`；`settings?.summaryEveryMessages ?? config.summaryEveryMessages ?? DEFAULT_SUMMARY_EVERY_MESSAGES(50)`。
- 预算取值（`resolveTurnMemory`）：频道 `summaryMaxChars > 0` 用它，否则 `config.summaryMaxChars > 0` 用它，否则 `SUMMARY_MAX_CHARS = 4000`；`<= 0` 与 `NaN` 一律当「未设置」，一路退到默认（§26.4）。
- `summaryEveryMessages <= 0` → **自动总结关闭**：`maybeSummarize` 直接返回，不查 `loadAfter`、不调模型。**手动入口不受影响**（`/summary` 命令与后台「重新总结」照旧）。
- 阈值语义不变：未总结消息数 `>=` 阈值就触发；窗口语义变了：注入只由条数决定——`tailMessages(history, historyMaxMessages)` 之后那道字符安全阀已去掉（`trimToCharBudget` 不再参与回复路径，`memory-nolimit-1`，§31.8）。
- 日志：`[chat] turn …` 追加 ` hist=<n> sum=<n>`（本轮真正生效的两个数字，排障时一眼看出是配置还是代码默认）。
- **循环追平（本条为阈值可配后的必要补充）**：`summarize()` 的单批上限是 `summaryBatchLimit(summaryEveryMessages)` = `min(500, max(SUMMARY_MAX_INPUT_MESSAGES=50, 阈值))`——阈值 200 就一批吃 200 条、填到 2000 也只一批 500 条，游标推到这批的最后一条。2026-10-27 修过一次缺陷：此前单批写死 50 条，阈值 200 时第一批之后剩 150 条 `<` 阈值，循环立刻退出，摘要永远落后 150 条（线上日志表现为 `msgs=50`，`[chat] 自动摘要追平` 一次也打不出来）。因此 `maybeSummarize` 交给 `background` 的任务仍是**循环**（积压到「两倍阈值」才会跑第二轮——仅当阈值 ≤ 500、单批正好等于阈值时成立；阈值 > 500 时单批被 500 卡住，积压越深就要连着跑越多轮，直到剩余待总结 < 阈值；门牌 `memory-nolimit-1`）：每轮 `await summarize(key)`，用返回的 `SummaryOutcome.coveredUntilId` 推进 `covered`，再 `loadAfter(key, covered, summaryEveryMessages)` 重新计数，直到待总结条数 `<` 阈值、`summarize` 返回 `null`、或 `coveredUntilId` 不再前进（防死循环）为止。整段循环仍用一层 `try/catch` 包住：任一批失败只打 `[chat] 自动摘要失败：` + 一条 `warn/summary` 事件后停止，不重试、不影响回复。回复路径上只 `await` 那一次计数查询，与 §17 铁律一致。

### 26.4 后台路由（四条，挂在 `ALL /api/*` 鉴权之后）

| 方法 | 路径 | 入参 | 成功 |
| --- | --- | --- | --- |
| GET | `/api/memory-settings` | 无 | `{ items: ChannelMemoryConfig[] }`（只列已保存的行） |
| GET | `/api/memory-settings/channel` | `guildId`、`channelId` | `{ config: ChannelMemoryConfig }`；没有行时回 `updatedAt: ''`、`summaryMaxChars: 4000`（`SUMMARY_MAX_CHARS`），另两个数字是服务端默认值 |
| PUT | `/api/memory-settings` | body `{ guildId, channelId, historyMaxMessages, summaryEveryMessages, summaryMaxChars? }` | 200，保存后的整行 |
| DELETE | `/api/memory-settings` | `guildId`、`channelId`（query，不是 body） | `{ ok: true }`（恢复默认；本来没有也 200） |

校验：

- `guildId` / `channelId`：非空 `/^\d{1,32}$/`，否则 400 `BAD_CHANNEL_KEY`。
- `historyMaxMessages`：整数 **≥ 2**、不设上限（接受纯数字串），否则 400 `BAD_MEMORY_SETTINGS`（`memory-nolimit-1` 起没有上限常量）。
- `summaryEveryMessages`：整数且 `=== 0`（关闭）或 **≥ 2**、不设上限，否则 400 `BAD_MEMORY_SETTINGS`（0 是「关闭」，1 无意义所以要拒）。
- `summaryMaxChars`（可选）：整数且 `=== 0`（= 未设置）或 500..20000（含端点），否则 400 `BAD_MEMORY_SETTINGS`；1..499 与 20001 以上都拒（`readSummaryMaxChars`，`MIN_SUMMARY_MAX_CHARS = 500` / `MAX_SUMMARY_MAX_CHARS = 20000`，`src/workers/http/app.ts:64-65`）。缺键与 0 同义。
- `updatedAt` 由服务端取当前时刻，不接受客户端值；请求体不是 JSON 对象与缺参数同出口 400 `BAD_CHANNEL_KEY`。

`AdminAppDeps` 加 `channelMemory: ChannelMemoryStore`（必填）与 `memoryDefaults: { historyMaxMessages: number; summaryEveryMessages: number }`（必填，由装配层从 core 常量传入，HTTP 层不 import `chat/service.ts`，遵守 §16.5）。

### 26.5 入口与网关装配

- `src/workers/index.ts`：`createChatService({ ...data, … })` 里 `channelMemory` 随 `...data` 自动带入；`createAdminApp` 增 `channelMemory: data.channelMemory` 与 `memoryDefaults: { historyMaxMessages: DEFAULT_HISTORY_MAX_MESSAGES, summaryEveryMessages: DEFAULT_SUMMARY_EVERY_MESSAGES }`。
- `src/workers/gateway/durable-object.ts`：普通消息回复的 `createChatService({ ...repos, … })` 同样随 `...repos` 带入 `channelMemory`；`MESSAGE_CHAT_CONFIG` 仍是默认值的兜底，不删。
- 门牌见 §28.7（本节落地时是 `summary-span-1`；@ 路径要等 DO 换码，斜杠命令走入口、部署即生效）。

### 26.6 后台页面（新增「记忆」tab）

`web/src/pages/MemoryPage.tsx`：

1. 顶部：`guildId` + `channelId` 输入 +「读取」；右侧列表列出已保存的频道配置（`服务器 ID · 频道 ID · 窗口 · 阈值 · 预算`；预算为 0/未设置时显示默认 4000），点一行载入表单。
2. 表单：`historyMaxMessages` 数字输入（旁注「默认 50，≥ 2，不设上限」）、`summaryEveryMessages` 数字输入（旁注「默认 50；0 = 关闭自动总结，否则 ≥ 2，不设上限」）、`summaryMaxChars` 数字输入「记忆注入预算（字符）」（`min=500`、`max=20000`、`step=100`，可留空 = 默认 4000；帮助文案「默认 4000；越大记忆越全，但每轮 prompt 越贵；超出预算的老段仍留在库里」）。前两个占一行，第三个另起一行（`web/src/styles.css` 的 `.row` 不换行、`.field.memory-number` 固定 260px，三只并排会溢出 3fr 列）。
3. 按钮：「保存」「恢复默认」（后者对应 DELETE）。
4. 反馈：读到 `updatedAt === ''` 时提示「这个频道还没单独设置过，显示的是默认值」；保存成功显示服务端回的整行；错误码 `BAD_CHANNEL_KEY` / `BAD_MEMORY_SETTINGS` 中文化。

保存时预算留空或填 `0` 都按「未设置」提交（PUT body 里 `summaryMaxChars: 0`）；前端先按 500..20000 拦一遍，服务端再按 §26.4 拦一遍，`BAD_MEMORY_SETTINGS` 在页面上中文化成一句可读提示。

`web/src/api.ts` 新增 `ChannelMemoryConfig`、`fetchMemorySettings()`、`fetchChannelMemory(guildId, channelId)`、`saveChannelMemory(input)`、`deleteChannelMemory(guildId, channelId)`。

### 26.7 已知边界

1. 配置只在频道维度：同一服务器的不同频道要各配一次；没有「全局默认」这一层（默认值就是代码里的 50/50）。
2. 0 = 关闭自动总结，但 `/summary` 与后台「重新总结」仍可手动触发；阈值 0 时一次手动总结吃满 500 条（`SUMMARY_BATCH_SAFE_MAX`），积压几万条也只需几十次手动触发。
3. 改动在**下一轮回复**生效：入口（斜杠命令）部署即生效，@ 路径要等 DO 换码（门牌见 §28.7）。
4. 注入只有条数一个闸：字符安全阀已去掉（`memory-nolimit-1`，§31.8），条数填多大就注入多少条，代价是每轮 prompt 更长更贵。
5. 删除行 = 回到 50/50 与默认 4000 预算，不保留历史值。
6. 摘要素材的**单批上限**与这里的「注入条数」是两件事：前者限制一次总结吃多少条，取 `min(500, max(50, 本表阈值))`——阈值调到 200 就一批吃 200 条，超过 500 的部分靠循环多批追平（§26 追加语义）。
7. 本节的阈值只决定「什么时候总结」与「一批吃多少」；注入进上下文多少由累积记忆的字数预算 `summaryMaxChars` 决定（§31.3），两条线互不影响。

## 27. 摘要段头写「说话的时间」（覆盖时间段）

### 27.1 口径

所以段头写的是**这条摘要覆盖的那批消息的落库时刻**：一头是最早一条，一头是最晚一条。

`updatedAt` 保留但只给后台看（列表、编辑页、`/summary view`），**不再进提示词**。

### 27.2 存储（`migrations/0011_summary_span.sql`）

```sql
ALTER TABLE conversation_summaries ADD COLUMN covered_from TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_summaries ADD COLUMN covered_to TEXT NOT NULL DEFAULT '';
```

迁移随后按游标回填老行：
`covered_from` = 本频道 `id <= covered_until_id` 的消息里 `created_at` 最小的一条，`covered_to` = 最大的一条（都 `COALESCE(..., '')`）。
空串表示「不知道」，仓储读回来时**不建键**，上层一律按缺省处理。

### 27.3 渲染（`src/core/chat/summary.ts`）

`coveredMoment(coveredFrom, coveredTo)` 用 `formatDayMinute` + `roughTimeLabel`（§12.1 的北京时间半点制）拼段头：

| 输入 | 段头 |
| --- | --- |
| 两头都有且不同 | `【记忆段】（覆盖 10-25 22:40 ~ 10-26 14:30，最后一句约在 10-26 下午两点半）` |
| 只有 to（或两头相同） | `【记忆段】（覆盖到 10-26 14:30，最后一句约在 10-26 下午两点半）` |
| 两头都空 / 都解析不了 | 只写 `【记忆段】`，不带括号 |

`export function renderSummaryBlock(summary: string, coveredFrom?: string, coveredTo?: string): string`。
段头**一段一份**：累积正文里每段各带自己的括号，行级的 `coveredFrom` / `coveredTo` 只对没有段头的老正文兜底（§31.1）。

### 27.4 怎么算出来（`src/core/chat/service.ts`）

- 每次总结只吃最旧一批（单批上限 = `min(500, max(50, 频道阈值))`，默认 50 条），这一批的 `createdAt` 最小值/最大值就是**这一段**的跨度。
- 每段各写各的区间：追加新段时**不再**与上一段合并，老段的括号一个字不改（§31.2）。
- 消息没有 `createdAt`（老数据 / 测试）时该侧不参与，两侧都空就只写 `【记忆段】`。
- `PUT /api/summaries`（§25，后台手改正文）是**整段替换**：写回什么就是一个整段，段头要自己留下（§31.4）。

### 27.5 已知边界

- 时间段取的是**落库时刻**，等于消息在 Discord 的发送时刻（网关收到即写），但机器人离线期间的消息不会被计入（本来也没落库）。
- 手改正文不提供改时间段的入口；要换区间只能调游标或重新总结。
- 老摘要的时间段由 0011 一次性回填；回填值来自 `messages` 里仍存在的那部分，早期被 `prune` 删掉的消息查不回来，空就是空。
- 段头只是给人看的线索，日历进位（跨月/跨年）按 `MM-DD` 渲染，不带年份——与 §12.1 的记忆行一致。

## 28. 贴表情：一次多个 + 指定目标消息

### 28.1 需求口径

澄清结论（六项，已定）：

1. 上限 2 → **10**（`MAX_REACTIONS`）。
2. 主模型与表情模型都能一次给多个，合并去重（主模型在前）。
3. 允许贴到**任意消息**；目标两种写法，消息 ID 优先、作者名兜底。
4. 网关把最近 10 条频道消息的 ID 注入提示词，模型只能在这批 + 触发那条 + 被回复那条里挑。
5. 表情模型也用同一套写法。
6. 正文不主动堆表情（正文 `:名字:` 的渲染能力保留，不删）。

### 28.2 契约（`src/core/types.ts`）

```ts
export interface ReactionRequest {
  emoji: string;
  messageId?: string;   // 目标消息的 Discord ID；缺省=触发那条
  authorName?: string;  // 模型写的是「@作者名」时原样带下来，网关按清单解析
}
export interface ReactionTarget {
  messageId: string;    // Discord 消息 ID（不是 D1 行 id）
  author: string;       // 展示名，供「@作者名」匹配
  authorId: string;
  excerpt: string;      // 正文前 30 字
}
export interface TurnResult { /* … */ reactions: ReactionRequest[] }
export interface TurnContext { /* … */ reactionTargets?: ReactionTarget[] }
```

`messageId` 与 `authorName` 互斥，最多一个出现；都没有表示贴到触发那条。

### 28.3 指令语法与解析（`src/core/chat/react.ts`）

| 写法 | 含义 |
| --- | --- |
| `[[react:😄]]` | 贴到触发这一轮的那条消息 |
| `[[react:😄@123456789012345678]]` | 贴到该 ID 的消息 |
| `[[react:😄@卡利亞士兵]]` | 贴到该作者最近一条消息（网关解析） |
| `[[react:😄@all]]` | 给清单里最近发过言的人各贴一条（§33.5；同义词 `everyone` / `大家` / `所有人` / `全员` / `*`，大小写不敏感） |

解析规则 `parseReactionValue(raw)`：

- 取最后一个 `@` 切分；右侧去掉空白后**全是数字且长度 15..20** → `messageId`；
- 右侧非空但不是合法 ID → `authorName`（长度 1..32，否则丢弃整条）；
- 左侧 trim 后为空、或整条超过 64 字符 → 丢弃；
- 没有 `@` → 只有 `emoji`。

`splitReactDirectives(raw): { text: string; reactions: ReactionRequest[] }`（字段名从 `emojis` 改为 `reactions`），
去重键 = `emoji + '|' + (messageId ?? authorName ?? '')`，超过 `MAX_REACTIONS = 10` 的丢弃。`visibleText` 语义不变。

### 28.4 目标清单从哪来（网关）

`messages` 表没有 Discord 消息 ID（`id` 是 D1 自增行 id，只有 `reply_to_id` 是 Discord ID），所以清单只能来自 REST：
新增 `listChannelMessages(options, channelId, limit)` → `GET /channels/{channelId}/messages?limit=<n>`。
网关在要贴表情的那一轮组装 `reactionTargets`：

1. 最近 10 条频道消息（REST，新的在前），
2. 触发这一轮的那条（`messageId`、作者、正文前 30 字），
3. 被回复的那条（若有），

按 `messageId` 去重、截到 10 条；REST 失败只 warn `[gateway] 读最近消息失败：…` 并退化成「触发 + 被回复」两条。
提示词里渲染成一段：

```
【可贴表情的消息】
#123456789012345678 卡利亞士兵：「给我们贴大量的emoji」
```

**只允许贴清单里的消息**：目标 ID 不在清单、作者名匹配不到 → 跳过该条并 warn。

### 28.5 表情模型（`src/core/chat/reaction.ts`）

- 系统提示词是**可自定义文案**（§33.4）：主模型那段【表情】与这里共用同一份，解析后原样当 system。§28 时它是写死的一段（「可以挑多个，一行一个；最多 10 行；一次挑多个时每条都要写目标（`表情@消息ID` 或 `表情@作者名`），分开贴到各自对应的那条消息、不要全堆在对方这条；只挑一个才允许省略目标；没有合适的只输出 NONE」），§33 起这段文字搬进配置，内置默认文案见 §33.6。
- `buildReactionRequest(cfg, { userText, botReply, customEmojis?, images?, targets? })`：多一段【可贴表情的消息】（`targets` 为空则整段不出现）。
- `normalizeReaction(raw)` → `normalizeReactions(raw): ReactionRequest[]`：逐行、忽略空行与 NONE、每行走 `parseReactionValue`、按同键去重、上限 10。

### 28.6 ChatService（`src/core/chat/service.ts`）

- `mergeReactions(primary, extra)`：主模型在前，键同上，上限 `MAX_REACTIONS`。
- run：`splitReactDirectives` 直接产出 `ReactionRequest[]` 放进 `TurnResult.reactions`。
- 表情模型那一路用 `normalizeReactions`，与主模型结果合并。
- §28 给规则块补的三句（一次最多 10 个、一次两个以上时每条都要写清目标并分开贴到对应消息、不要在正文里堆一串表情）现在是内置默认文案的一部分（§33.6）：改成自己的文案时，这三句也就随自己写。
- system 装配顺序（`preset-head-1` 起，§52；`identity-head-1` 那版是 `before` 段 → 身份块 → 摘要块 → `after` 段 → 表情规则 → …）：`placement=before` 的 system 段（天头）→ 身份块（前导换行削掉）→ 提及规则 → 表情规则 → 语音提示 → 自定义表情清单 → 可贴表情的消息 → 世界书（自带前导 `\n\n`）→ `placement=after` 的 system 段（收尾）；长期记忆摘要不进 `system`，拼在本轮那条 user 消息的最前面；`role=user` 的段不进 system，按 `position` 排在历史之前（§32.3）。

### 28.7 网关（`src/workers/gateway/durable-object.ts`）

- `#react(message, reactions, catalog, targets)`：逐个解析表情、解析目标、`PUT` 贴上去；每条独立 try/catch，失败只 warn。
- 目标解析顺序：`messageId` 命中清单 → `authorName` 与清单里 `author` 大小写不敏感相等取**最新**那条 → 都没有 → 触发那条。
- 越界目标：warn `[gateway] 贴表情目标不在清单里，跳过：<描述>` 并跳过该条。
- §28 时贴之前无条件过一遍 `spreadReactions`（§28.9）：按「聊天记录里谁最近说过话」一条一人地分配，撞了同一条就往下顺延。**§33 起取消**：只有模型显式写 `[[react:😄@all]]`（同义词见 §33.5）才展开成「最近发言者各一条」，没点名就一个都不挪到别人身上。
- 每轮贴表情都写一行 info：`贴表情 计划 👍→<消息ID>,🎉→<消息ID>`（只有表情与消息 ID，没有正文）。模型没写目标的那条打 `→本回合:<消息ID>`——它在约定里就是贴在本轮要回的那条上，写成 `?` 会让人误以为目标丢了。
- 门牌：§28 这几版是 `'react-spread-1..3'`，§29 起是 `'stream-reply-1'`，`'stream-reply-2'` 是「首字到了才发」那版（§29.5），§30 起是 `'self-host-1'`，自托管第二版是 `'self-host-2'`（自托管 + 摘要单批跟阈值，见 §30.1），`'memory-append-1'`（累积记忆，§31）→ `'memory-budget-1'`（注入预算频道级可配，§31.3）→ `'memory-nocap-1'`（写侧不再设上限，§31.7）→ `'memory-nolimit-1'`（注入条数与自动总结阈值都不设上限，§31.8）→ `'prompt-segments-1'`（提示词改成多段，§32）→ `'prompt-bounds-1'`（提示词保存补上数值范围、停用段不再挡保存，§32.8）→ `'reaction-guide-1'`（贴表情文案三层可自定义、取消强制分散，§33.9）→ **`'reaction-template-1'`**（表情素材模板三层可自定义、表情模型能看最近 20 条历史，§34.7）→ **`'summary-backfill-1'`**（选择性补记：后台按时间范围挑段追加一段记忆、游标不动，§35）→ **`'summary-order-1'`**（读消息改按 `created_at` 排序、自动总结游标取批内最大 id，§35.7）→ **`'summary-order-2'`**（选区按 id、送模型按时间序，§35.7 的漏行归零）→ **`'backup-ui-1'`**（网页后台一键手动备份：请求/状态文件 + 每分钟 timer，§36）→ **`'reply-error-1'`**（流里的错误帧抛错、零字正文按候选失败处理，§37）→ **`'reply-error-2'`**（空回复时同一候选模型重试 3 次才换候选，§37）→ **`'fake-stream-1'`**（假流式：整段到手后切片挤出去，§29.6）→ **`'fake-stream-2'`**（假流式的片数做成三层可配、0 = 关闭，§38）→ **`'mention-1'`**（服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户，`@everyone` / `@here` / `@角色` 仍不解析，§39，前一版）→ **`'mention-2'`**（@ 前缀与「…(已截断)」都先从正文预算里扣掉，正文打满 1900 时不再吃掉尾部与截断提示，§39.2，前一版）→ **`'reply-continue-1'`**（被掐断的半句自动续上：协议层 + 文本层双信号判定、把已写正文当 assistant 前缀让模型接着说，最多续 2 次、合并累计上限 3000 字，续段接在同一条消息里，§40，前一版）→ **`'stream-edit-1'`**（边说边编辑：服务层不再节流、模型每来一块就立刻推给同一条消息，真正的节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推，§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7。

### 28.8 已知边界

- 清单窗口 10 条：更早的消息贴不到（要贴请先回复那条消息）。
- 「@作者名」同名时只能取最近一条；作者改名后清单里就是新名字。
- 每贴一个表情一次 REST 调用；10 个就是 10 次。
- 斜杠命令不设 `reactionTargets`、也忽略 `reactions`（§18.7 不变）。
- REST 读最近消息失败时清单退化，不阻塞回复。
- §28 的自动分散（§28.9）按「谁最近说过话」排，不看谁在说什么：它保证「不一堆表情全落在同一个人身上」，不保证每个表情都贴得恰如其分；§33 起只有在模型写 `@all` 时才这样排（§33.5）。
- 写 `@all` 而说的人不够表情多时，同一条消息会收到第二个：一圈发完从头再来。没写 `@all` 就不会有这件事——没点名的表情只贴触发那条。

### 28.9 按最近说话的人分散表情（§33 起只在 `@all` 时跑）

> **§33 已改口径**（`reaction-guide-1`）：这条强制分散不再无条件执行——默认只贴模型点名的目标，只有写 `[[react:😄@all]]` 时才按本节这套「最近发言者一人一条」分配（§33.5）。下面记的是 §28.9 落地时的病根与实现，读的时候当成历史。

两轮提示词都没解决「几个表情全堆在 @ 她的那条上」：表情模型常常一个 `@` 都不写，主模型又爱连着给同一个人写 `@名字`——线上 2026-10-27 那轮就是 `laugh@小明,OMG@小明,bengzhu@小明` 三条压在同一条消息上。这一版把分配放进代码（`spreadReactions`，`src/core/chat/react.ts`）：

- 只有一个表情：**不动**，贴触发那条（它属于这轮回复的那条）。
- 多个表情：先算一份「最近说过话的人」名单，然后一条表情一个人，从最近的那个开始排。
- 名单口径（`ReactionTarget` 清单本来就是新的在前）：同一作者只留**最新**那条、跳过机器人（含我们自己）发的（`ReactionTarget.bot`）；清单落空时用触发那条兜底。
- 模型点了名的目标**先占位**（`messageId` 直接命中，或 `authorName` 大小写不敏感取最新那条）；同一条消息被点第二次就顺延给下一位最近说话的人——这正是「三条全压在同一个人身上」的解药。
- 作者名在清单里找不到：原样留着，交给 §28.7 跳过并 warn（不悄悄贴到别人身上）。
- 圈数：3 个人、5 个表情时，第 4 个回到第一位——每圈一人一条，圈完才叠。
- 日志：`[gateway] 贴表情 计划 👍→1234…,🎉→1234…` 只写表情与消息 ID，不写正文（§19.1 同口径）。

## 29. @ 路径的流式回复（2026-10-27）

### 29.1 口径

- 以前：`#handleMessage` 等 `chat.run` 整段返回（线上实测 `ms=22238`，22 秒），再一次性 POST 出去——群里这段时间只有「正在输入」。
- 现在：**首个 token 到了才建消息**（发的就是正文开头），之后模型边吐边 PATCH 这条消息；**最后那次 PATCH 必然是全文**。
- 只改观感，不改语义：落库、回复链、贴表情、指令剥离仍按 §18 / §28 走。

### 29.2 时序（`src/workers/gateway/durable-object.ts` 的 `#openStream`）

1. `chat.run(context, { onProgress })`：core 侧每收到模型一个数据块就立刻推一次 `onProgress`（§29.7 起服务层不再节流，`burstEditIntervalMs` 这个配置项已删除），进度文本已剥掉 `[[react:…]]` 与假时刻。
2. **第一次** `push` 才算建消息：`createMessage(当前最新进度)` → `POST /channels/{id}/messages?wait=true`，图的是响应里的 `id`。建消息用的就是此刻最新的文本，所以不会再补一次同内容的 PATCH。
3. 之后每次进度 ⇒ `PATCH /channels/{id}/messages/{mid}`，内容取那次进度的**第一段**（`chunkMessage(text)[0]`），永远不超过 1900 字。
4. `finish(chunks[0])`：最后一次 PATCH 是最终正文第一段；`chunks.slice(1)` 按老规矩逐条 POST。没建过消息（一个进度都没有）就直接 POST 全文。
5. 回复发完才贴表情（§28.7 不变）。

### 29.3 节流与预算（`src/workers/discord/editor.ts`）

- 规则：间隔 ≥ `intervalMs`(1200ms)、总编辑数 ≤ `STREAM_MAX_EDITS`(20)、**最后一次单独留一个预算**（进度最多用 19 次）。节流只在这一层：服务层推多密，这里都按槽位合并（§29.7）。
- 最新覆盖旧的：`push` 不阻塞调用方，只记下最新文本，节流窗口里到点才发。
- 单次 PATCH 失败只 `console.error('[gateway] 流式编辑失败：…')`，不打断这一轮——后面的编辑会把最终全文兜回去。
- 这套规则与斜杠命令共用：`createProgressiveEditor` 从 `handler.ts` 提到 `editor.ts`，两条路各给一个 `send`。

### 29.4 边界

- 首条消息发不出去（403 / 429 / 断网）：退回整段发送——`push` 变空操作，`finish` 直接 `POST` 全文，与流式之前完全一致；日志 `[gateway] 首条消息发送失败，退回整段发送：…`。
- 一个字都没等到（秒回、模型没吐任何进度）：不建消息、不留占位，`finish` 直接 `POST` 一条——§29.6 起这条路上 `finish` 会先把整段切片挤出去，最后一次才是全文。
- 超长回复（> 1900 字）：只有第一条流式滚动，其余等生成完再补发（2026-10-27 定的口径）。
- 模型失败：已经建了消息就把那条 PATCH 成 `回复生成失败：…`；还没建就只发一条失败提示。频道里不会留下孤零零的 `…` 或半句。
- 速率限制：Discord 对同一频道的 PATCH 有桶限制，1200ms 间隔 + 20 次上限是留了余量的取值；要调只改常量。
- 斜杠命令那条路本来就是流式的（§16），这次只是把实现提到公共模块，行为不变。

### 29.5 门牌

- `GATEWAY_BUILD` 现在是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（104623§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `/chat/completions`，老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7；前一版 `'tts-admin-1'` 是 TTS 接口搬进后台：地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听，§46；前一版 `'prompt-scope-1'` 是内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，§45；再前一版 `'voice-2'`，按指令模式补上【语音】提示段（§44.1）；再前一版 `'voice-1'`，文字回复结束后可发一条语音附件、三档三层开关（§44）；再前一版 `'pg-errors-1'`，后台「故障」页看 PG 中继报错（§43）；再前一版 `'mention-once-2'` 同一个人一条回复只 @ 一次（§42），再前一版 `'vision-main-2'`，后台三层识图开关那版，§41；再前一版 `'vision-main-1'`，主对话也接图那版，§22.9；再再前一版 `'none-head-1'`；`src/workers/gateway/engine.ts:129`；§29 时先发 `…` 占位的那一版是 `stream-reply-1`，§29 部署前的最后一版是 `stream-reply-2`，§31 那版是 `memory-nolimit-1`，§32 是 `prompt-bounds-1`，§35.7 是 `summary-order-2`，§36 是 `backup-ui-1`，§37 起是 `reply-error-1`（流里的错误帧抛错、零字正文按候选失败），`reply-error-2` 是「空回复时同一候选模型重试 3 次」，`fake-stream-1` 是「整段到手后切片挤出去」那一版（§29.6，历史），`fake-stream-2` 把片数做成三层可配、0 = 关闭（§38，历史），`mention-1` 起服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户（§39，前一版），`mention-2` 把 @ 前缀与「…(已截断)」一起算进正文预算、正文打满 1900 也不再吃掉尾部与截断提示（§39.2，前一版），`reply-continue-1` 把被掐断的半句自动续上、仍然只有一条消息（双信号判定 + 最多续 2 次、合并累计上限 3000 字，§40，前一版）→ `'stream-edit-1'` 改成边说边编辑：服务层不再节流、模型每来一块就立刻推，节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推（§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，前一版）→ **`'tts-mimo-1'`**（接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；
没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47），`[gateway] alarm build=reply-tool-3` 出现才说明 DO 换到这一版（§13）。§30 起 Node 宿主打的是同一枚门牌：`[node] listening … build=reply-tool-3`。
- 斜杠命令路径（`src/workers/index.ts`）部署即生效，不经过 DO。

### 29.6 假流式：整段到手后切片挤出去（`fake-stream-1` 那一版起；片数自 §38 起可配）

- 为什么有它：§29.2 那套只管「边生成边 PATCH」。上游整段一次性返回时（`onProgress` 一次没推，或只推了一次），这条路上只有 `finish` 那一次写，群里看到的是「一下子蹦出全文」——前面那些秒只有「正在输入」。
- 做法：`finish(finalText)` 转给内部的 `reveal`——把已拿到的那段正文按节奏分几片挤出去，收尾那次 `deliver(finalText)` 才落地全文；真流式那条路的 `push` 一个字没改。
- 分片规则：差距 `remaining`（= 全文长度 − 已显示长度）不足 `REVEAL_MIN_GAIN_CHARS`(24) 字就不动画、直接发全文；要动画就切 `steps = Math.min(片数上限, progressBudget - edits - 1)` 片（片数上限就是本节的 `REVEAL_MAX_STEPS`，默认 `DEFAULT_REVEAL_STEPS` = 6，§38 起由「频道 > 服务器 > 全局」三层开关给出、0 = 关闭假流式），第 i 片长度是 `shown + round(remaining × i / (steps + 1))`——最后一片仍短于全文，全文由收尾那次写落地。
- 间隔与预算：每片之间仍受 `intervalMs`(1200ms，两条路同值) 约束，最多 `片数 + 1` 次发送，所以默认 6 片时最坏多花约 `(6 + 1) × 1200ms ≈ 8.4 秒`（片数由 §38 按频道定：调小就更短，0 = 关闭、一次都不挤）；最后一位预算永远留给最终全文（`progressBudget = maxEdits - 1`，§29.3），剩余预算不足就自动少切几片，一格都不剩（`budget <= 0` / `steps <= 0`）就直接发全文。
- 相同内容不重发：`deliver` 里 `content === lastContent` 直接返回，同一内容不会被 PATCH 两遍。
- 真流式追上全文就一次都不发：`push` 已经把全文推上去之后，`finish` 看到内容相同，一次都不再发——行为与 §29.2 完全一致。
- 只改观感，不改结果：任何一次 PATCH 失败都只记一行错误（@ 路径 `[gateway] 流式编辑失败：…`，斜杠路径 `discord 渐进编辑失败`，§29.3），不影响最终全文发出；落库、回复链、贴表情、摘要全按最终文本走（§18 / §28）。
- 触发场景：上游整段一次性返回（`push` 零次或一次）——这时用户能看到文字逐片长出来，而不是突然出现。
- §39 起：服务器频道的回复在正文前多一个 `<@提问者id> ` 前缀。它**在切片之外**，只在发送前拼（`withMention` 包住每一次写：首条 POST、每片 PATCH、收尾全文都带），切片规则与片数预算一个字没改；私聊与斜杠命令输出不带（§39.2、§39.4）。

| 位置 | 作用 |
| --- | --- |
| `src/workers/discord/editor.ts` 的 `createProgressiveEditor` | 两条路共用的渐进编辑器；假流式在闭包里的 `reveal(finalText)`，`finish(finalText)` 调它（`push` 那条路没动）；§38 起多接一个选项 `revealSteps?`（不传按 6、0 就直接发全文） |
| `src/workers/discord/editor.ts` 的 `REVEAL_MAX_STEPS` | 不传 `revealSteps` 时的片数上限，值是 `6`（= §38 的 `DEFAULT_REVEAL_STEPS`）；传 0 走 `steps <= 0` 分支直接一次发全文；收尾的全文那次另算，所以默认最多 7 次发送 |
| `src/workers/discord/editor.ts` 的 `REVEAL_MIN_GAIN_CHARS` | 还差多少字才值得动画，值是 `24`；`remaining` 不足这个数就直接发全文 |
| `src/workers/discord/handler.ts` | 斜杠命令那条路的调用点：传 `send` / `clock` / `intervalMs` / `maxEdits` / `maxChars` / `onError`（§38 起加 `revealSteps`，值由本文件开流前现读一次），**不含假流式逻辑** |
| `src/workers/gateway/engine.ts` 的 `createProgressiveEditor` 调用 | @ 路径的调用点：同上，只传参数（`revealSteps` 同样由本文件按当前频道现读，§38），**不含假流式逻辑** |

### 29.7 边说边编辑：节流只在编辑器（`stream-edit-1` 那一版起）

- 服务层不再节流：`src/core/chat/service.ts` 的回合循环每收到模型一个数据块就立刻 `onProgress` 推一次，中途不再等窗口，`burstEditIntervalMs` 这个配置项随之删除。上一版是 1200ms 一道闸，正文只能「一跳一跳」出现；截断后的续写那几段更彻底，整段收完才刷一次，用户看到的是「卡住 → 突然多一大段」。
- 真正的节流在编辑器一侧：`src/workers/discord/editor.ts` 的 `createProgressiveEditor` 用 `intervalMs`(1200ms) 与 `maxEdits`(20) 串行化 PATCH——`push` 只记下最新文本、内部队列按槽位发，窗口里来多少次都只发最新那一次（§29.3）。所以服务层推得再密也突破不了 Discord 的速率，多推的部分由编辑器自己合并。
- 续写同样边收边推：§40 的每一段续写请求都在同一个 `runChat` 回合循环里跑，模型每来一块就推一次、改的还是同一条 Discord 消息；用户看到的是那句话从被掐断处继续往下长，而不是「先停在那里、等整段续写收完再一下补上一大段」。
- 观感只由一个旋钮决定：编辑器节奏（1200ms 一改、最多 20 次）。要更细就缩 `intervalMs`，代价是限流风险（§29.4）；这与 §38 的片数是两件事。
- §29.6 的假流式**一行没改**：它只在「整段文字一次性到手、一次进度都没推过」时才起作用——真流式下 `push` 已经把全文顶上去了，`finish` 看到内容相同，一个字节都不会多发。

## 30. 自托管移植（Ubuntu + Node）

§30 起，同一个仓库有**两个宿主**：Cloudflare Workers（原路径，仍是生产与回退路径）和一台普通 Ubuntu + Node 进程（`dist/server.mjs`）。
两者共用 `src/core` 与 `src/workers` 的同一份实现，只在自己的入口文件里"装配平台给的东西"。
照着跑的运行手册在 `docs/hosting.md`；这一节只讲为什么这样切、切在哪。

### 30.1 为什么保留双轨

- `wrangler.toml` 一个字没改：`main`、`[assets]`、`[[d1_databases]]`、`GATEWAY_PRESENCE` 的 DO 绑定、`[triggers] crons` 全在，`npx wrangler deploy` 随时能回到云端，D1 也还在原处（回滚步骤见 `docs/hosting.md` §10.4）。
- 双轨的成本被压到装配层：迁移（`migrations/`）、业务（`src/core`）、平台中立的实现（`src/workers`）都是**一份**。两个入口传的是同一批参数，改一处就得同步改另一处 —— 这是这套结构唯一的纪律。
- 门牌链：`'react-model-1'` → `'emoji-alias-1'` → `'memory-config-1'` → `'summary-span-1'` → `'react-spread-3'` → `'stream-reply-1'` → `'self-host-1'`（自托管第一版，只跑在 EC2 上）→ `'self-host-2'`（摘要单批跟阈值）→ `'memory-append-1'`（累积记忆）→ `'memory-budget-1'`（注入预算频道级可配）→ `'memory-nocap-1'`（写侧不再设上限，§31.7）→ `'memory-nolimit-1'`（注入条数与自动总结阈值都不设上限，§31.8）→ `'prompt-segments-1'`（提示词改成多段，§32）→ **`'prompt-bounds-1'`**（提示词保存补数值范围与停用段检查，§32.8）→ **`'reaction-template-1'`**（贴表情文案三层可自定义、取消强制分散，§33.9）→ **`'summary-backfill-1'`**（选择性补记：后台按时间范围挑段追加一段记忆、游标不动，§35）→ **`'summary-order-1'`**（读消息改按 `created_at` 排序、自动总结游标取批内最大 id，§35.7）→ **`'summary-order-2'`**（选区按 id、送模型按时间序，§35.7 的漏行归零）→ **`'backup-ui-1'`**（网页后台一键手动备份：请求/状态文件 + 每分钟 timer，§36）→ **`'reply-error-1'`**（流里的错误帧抛错、零字正文按候选失败处理，§37）→ **`'reply-error-2'`**（空回复时同一候选模型重试 3 次才换候选，§37）→ **`'fake-stream-1'`**（假流式：整段到手后切片挤出去，§29.6）→ **`'fake-stream-2'`**（假流式的片数做成三层可配、0 = 关闭，§38）→ **`'mention-1'`**（服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户，`@everyone` / `@here` / `@角色` 仍不解析，§39，前一版）→ **`'mention-2'`**（@ 前缀与「…(已截断)」都先从正文预算里扣掉，正文打满 1900 时不再吃掉尾部与截断提示，§39.2，前一版）→ **`'reply-continue-1'`**（被掐断的半句自动续上：协议层 + 文本层双信号判定、把已写正文当 assistant 前缀让模型接着说，最多续 2 次、合并累计上限 3000 字，续段接在同一条消息里，§40，前一版）→ **`'stream-edit-1'`**（边说边编辑：服务层不再节流、模型每来一块就立刻推给同一条消息，真正的节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推，§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7。
当前值在 `src/workers/gateway/engine.ts:129`，`durable-object.ts:23` 只是把它转出去。看到 `[node] listening … build=reply-tool-3` 或 `[gateway] alarm build=reply-tool-3` 才算这一版在位。
- Node 宿主**不落盘任何网关状态**：没有 `resume_url` 缓存、没有 session 文件，重启就是一次全新的 IDENTIFY。`data/` 里只有 SQLite 一个文件，备份与搬迁因此只需要拷它。

### 30.2 分层图

```text
src/core/          零平台依赖：chat 服务、memory 窗口、providers、db 契约（db/sql.ts）、markdown…
      ↑            （不许 import 任何 workers/ 或 node/ 的东西）
src/workers/       平台中立实现：db/d1-repository、db/log-store、discord/handler、http/app、
      ↑            gateway/engine（状态机）、gateway/protocol（纯归约）
      │
      ├── src/workers/index.ts   ← Workers 宿主：env.DB(D1) / env.ASSETS / ctx.waitUntil
      └── src/node/main.ts       ← Node 宿主：createSqliteDatabase / createStaticHandler / TaskTracker
```

- 平台缝只有一个：`src/core/db/sql.ts` 的 `SqlDatabase`。Workers 侧拿到的是 D1 的 `prepare/bind/batch`，Node 侧是 `node:sqlite` 的薄包装（`src/node/db/sqlite.ts`）。
- 网关状态机抽到 `src/workers/gateway/engine.ts`：DO 宿主（`src/workers/gateway/durable-object.ts`）与 Node 宿主（`src/node/gateway.ts`）都只提供 `storage`（`get/put/getAlarm/setAlarm`）、`waitUntil`、`db` 三样东西 —— 引擎里没有一行代码知道自己跑在哪。
- 依赖方向保持单向：`core` 不 import `workers`，`workers` 不 import `node`，只有 `src/node/**` 允许同时 import 两者。Node 入口也因此不能 import `src/workers/index.ts`（会把 DO 类一起拖进 bundle），所以 `APP_VERSION`/`BOT_NAME`/`CHAT_CONFIG` 在 `src/node/main.ts:45-56` 各留了一份常量，注释里标了对齐的行号。

### 30.3 `SqlDatabase` 契约

`src/core/db/sql.ts` 一共六个成员：`prepare` / `bind` / `all` / `first` / `run` / `batch`。

- **为什么是这六个**：它们正好是 D1 与 `node:sqlite` 的公共子集，不多不少。D1 的 `stmt.bind(...).all()` 返回 `{ results }`、`.first()` 取一行、`.run()` 只关心副作用、`db.batch([...])` 批处理 —— `node:sqlite` 的 `prepare().run()/all()/get()` 能一一对上。少一个（比如只有 `all`）就得在两处各写一层转换；多一个（比如把 D1 的 `raw()` 也搬进来）Node 侧就没法实现。
- **`all()` 返回 `SqlResult<T>` 而不是裸数组**：D1 的返回值本来就带壳，抹平成数组会让 Workers 侧原有的消费代码全改一遍；保留壳，两边的调用点一模一样。
- **`bind()` 必须返回新实例**：D1 的 `bind` 本来就是纯函数式（返回新 statement）。而 Node 侧如果就地改参，`src/workers/db/log-store.ts:29-30` 这种**构造期 prepare、每次调用再 bind** 的复用就会互相串味 —— 同一份 `SqlStatement` 被两个并发 `append` 绑上不同的 retention，日志表会按错误的天花板剪枝。所以 `createSqliteDatabase` 的 `bind` 每次 `new` 一个包装对象（`src/node/db/sqlite.ts`）。
- **`batch()` 是单事务**：D1 的 batch 本身原子；Node 侧用 `BEGIN` / `COMMIT` / `ROLLBACK` 显式包起来。这条语义是有业务依赖的：`log-store` 的 `append` 把「插入一条」和「按 retention 剪枝」放进同一个 batch，要么都发生要么都不发生 —— 否则可能出现"剪枝生效、插入失败"，日志凭空少一截。
- **参数折算**：D1 只认 `null | number | string | ArrayBuffer`。Node 侧的 `toBinding` 把 `undefined` 折成 `NULL`、`boolean` 折成 `0|1`，让上层的可选字段不用为平台写分支。

### 30.4 网关：一个状态机，两个宿主，一条 timer

引擎的形态是「纯归约 + 一个执行器」：`reduceGatewayEvent(state, event)` 算出下一份状态与若干副作用，`#apply` 逐个执行（`openSocket` / `sendFrame` / `scheduleAlarm` / `close` / 落库）。宿主只需要回答两件事：**状态存哪**、**什么时候再叫我**。

三种节奏全部收敛到 `scheduleAlarm`：

| 节奏 | 取值 | 出处 |
| --- | --- | --- |
| 心跳 | `0.9 × heartbeat_interval`（`HEARTBEAT_INTERVAL_RATIO = 0.9`） | `src/workers/gateway/protocol.ts:161-169`；排期在 `src/workers/gateway/engine.ts:379` |
| 握手看门狗 | `HANDSHAKE_WATCHDOG_MS = 15000`，HELLO 后与 IDENTIFY 后各排一次 | `src/workers/gateway/engine.ts:132`、`:432`、`:490` |
| 重连退避 | 1s 起步、每次翻倍、封顶 60s、再叠 ±25% 抖动 | `src/workers/gateway/protocol.ts:171` |

- **为什么 Node 宿主也只允许一个 timer**：DO 的 `storage.setAlarm` 天生只有一个槽位，引擎因此只会问"下一次该醒的时刻是哪一刻"这一个数。Node 宿主照抄这个约束：`setAlarm` 折成 `#timer` 这**一个** `setTimeout`（`src/node/gateway.ts:79`、`:134-140`），谁最后排谁生效，绝不允许两个 timer 并存。并存的后果不是"多醒一次"这么轻：心跳和看门狗会互相抢先，一方的到点被另一方的排期覆盖，表现就是连接莫名其妙被踢或者心跳漏拍。
- 单 timer 的第二个好处在停机：`stop()` 只需要 `clearTimeout` 一次，不存在漏掉某个定时器的可能，之后走引擎内部路径 `/shutdown`（`GATEWAY_SHUTDOWN_PATH`，DO 宿主永不调用它）→ `socket.close(1000, 'shutdown')` → `drain()`。
- **没收到 READY 之前，`alarm()` 一律走重连而不是心跳**：这是 DO 时期的既有行为，Node 照搬。理由很硬：心跳帧要带 `session_id`，而 `session_id` 只在 READY 里下发；没 READY 就发心跳等于给一个不存在的会话续命。所以 `connected === false` 时到点做的是"再连一次"，退避计数也在这条路上累加。
- 两个宿主的差异只剩"状态存哪"：

| | Workers（`GatewayPresence` DO） | Node（`src/node/gateway.ts`） |
| --- | --- | --- |
| 状态 | `storage.get/put`（跨 alarm 存活） | 进程内存（重启即丢，本就该丢） |
| 排期 | `storage.setAlarm` | 单个 `setTimeout` |
| 长连接 | DO 里的 WebSocket | 进程内的 WebSocket |
| 重启后 | 可带 `resume_url` 做 RESUME | 全新 IDENTIFY（不落盘任何会话） |

### 30.5 HTTP 入口三分支与 `waitUntil`

Workers 入口的 `fetch` 是三段式（`src/workers/index.ts`）：交互路径精确匹配 → `/api` 与 `/api/*` → 剩下交给 `env.ASSETS`。Node 入口用 `createEntryHandler`（`src/node/http/router.ts`）复刻同一顺序，只把第三段换成 `createStaticHandler`（`src/node/http/static.ts`）：

- 交互路径：`INTERACTION_PATHS = ['/interactions', '/discord/interactions']`（`src/node/main.ts:53`，与 `src/workers/index.ts:54` 逐项一致）。**两个都要认**：只在 Discord 后台填了一个路径，另一个掉进 SPA 回退就会拿到一页 HTML，Discord 侧表现为签名校验失败。
- `/api` 分支：`/api` 与 `/api/` 前缀都算，返回 admin app 的 `fetch()`。
- 静态分支的 SPA 回退规则与 Workers 的 `not_found_handling = "single-page-application"` 等价：只有 `GET`/`HEAD`；`decodeURIComponent` 之后拒 `..` 与 NUL；`resolve` 后再校验一次仍在 root 内；**没有扩展名且文件不存在 → `index.html`，带扩展名 → 404**。
- 静态根靠 `new URL('./web/', import.meta.url)` 推导（`src/node/main.ts:74`）：bundle 之后 `import.meta.url` 指 `dist/server.mjs`，所以推导结果就是 `dist/web`。镜像只要保证这两样是邻居，代码里不写死任何绝对路径。
- `ctx.waitUntil`：Workers 里它是"这次调用的收尾还会跑"，Node 没有调用边界，用 `TaskTracker` 模拟（`src/node/wait-until.ts`）：`waitUntil` 收下 promise 记账、失败统一回调打日志、`drain()` 等所有在飞任务。传给 handler 的形状就是 `{ waitUntil }`（`src/node/main.ts:200-201`），与 Workers 的 `ctx` 同形，handler 一行都不用改。语义上 Node 反而更宽：后台任务不随请求结束被掐断，只在进程退出时被 drain 等一次。
- 装配时机不同：Workers 每次请求重建数据层（要按请求读 secret、隔离多租户）；Node 启动期装配一次（`src/node/main.ts:129-204`），因为 secret 来自进程环境、只有一份，进程就是租户边界。

### 30.6 测试池拆分

两个池各管一半，glob **必须互补**：

| | `vitest.config.ts` | `vitest.node.config.ts` |
| --- | --- | --- |
| 环境 | `@cloudflare/vitest-pool-workers`（workerd） | `environment: 'node'` |
| 数据库 | `readD1Migrations('./migrations')` 灌进 `d1Databases: ['DB']` | 真磁盘 + `node:sqlite`（`tmpdir()`） |
| 范围 | 除 `test/node.*.test.ts`、`test/*.node.test.ts` 之外的全部 | 恰好那两个 glob |

漏掉一个文件就是"两边都不跑"或"两边都跑"，所以这组 glob 是这一节里最脆的一处。

- **`node:os` 为什么只能动态 import**：workerd 池里根本没有 `node:` 内置模块的实现（`vitest.config.ts:45` 记了这条），静态 `import` 会让**整个文件**在加载期就失败，连"这台机器有没有真磁盘"这种判定都执行不到。所以 `test/node.static.test.ts:22-23` 用 `await import('node:os')` 把失败推迟到运行时，再降级成"跳过真实磁盘那部分断言"。
- Node 侧覆盖：`env`（缺项报错文案）、`migrate`（幂等、`markAllApplied`、账本）、`sqlite`（bind 不复用、batch 回滚、参数折算）、`static`（穿越、回退、404）、`waitUntil`（drain 语义）、以及两个 `*.node.test.ts`（网关宿主、路由）。
- 当前实测：workerd 池 44 文件 / 780 条，Node 池 7 文件 / 86 条，两边全绿。
- **入口本身不做单测**：`src/node/main.ts` 是装配，没有可断言的分支。它的验证方式是 build + 冒烟（`--mark-migrations-applied` 记账、`/api/health`、`/interactions` 对 GET 回 405），命令见 `docs/hosting.md` §6 与 §8.5。

### 30.7 已知缺口

- ~~运行镜像缺 `migrations/`~~ **已修复**：runner 阶段补了 `COPY --from=builder /app/migrations ./migrations`，运行镜像自带迁移账本所需的 SQL，不再需要 `docker-compose.override.yml` 挂载（`docs/hosting.md` §5）。仍要记住的残留约束：**迁移只在构建时进镜像**，改了/加了迁移文件必须重建镜像（`docker compose up -d --build`），`docker compose restart` 或只重启进程都不会带上新文件。


## 31. 累积记忆（长期记忆只增不减）

### 31.1 口径

- 长期记忆是**一段只增不减的正文**：每次总结只总结游标之后的新对话，产出一段新记忆**追加**到正文尾部（§35 起后台「选择性补记」也走这条追加路径 `appendSegment`，只是入口不同、游标不动）；
  老段原文永不改写、永不截断丢失。
- 段头格式：`【记忆段】（覆盖 A ~ B，最后一句约在 …）`，**一段一份**（§27）。
- 老数据或手改文本没有段头时，**整体当作一段**：不补段头、不拆段。
- 段内顺序永远是旧→新；整段正文的顺序也是旧→新。

### 31.2 追加规则

| 场景 | 行为 |
| --- | --- |
| 游标之后有新对话 | 取最旧一批（≤ 单批上限 `min(500, max(50, 频道阈值))`）→ 一次非流式调用 → 产出一段新记忆 → `正文 = 旧正文 + 换行 + 新段`，游标推到这一批的最后一条 |
| 游标之后没有新对话 | 不调模型、不落库：`summarize` 返回 `null`（后台「重新总结」回 409 `NO_SUMMARY_MATERIAL`，§25.4） |
| 老段 | 一个字不改：不重排、不合并、不重写、不截断 |
| 单段产出超长 | 照写不误：落库不截断（写侧无上限），长度只在注入时按频道预算约束（§31.3、§31.7） |
| 已经写进老段的内容 | 不重录：模型只看游标之后的新对话，不再被要求重写旧段（`buildSummaryRequest`） |

追加是**代码**做的：模型一次性产出的正文就是这一段，拼接不经过模型，所以老段不会被二次改写。

### 31.3 注入预算（频道级可配 `summaryMaxChars`）

- 预算来源：频道级配置 `summaryMaxChars`（整数，单位「字符」）——后台记忆页那个「记忆注入预算（字符）」输入写的就是它（§26.6）。
- 取值范围：**500..20000**（含端点）；`0` 或留空 = **未设置**，运行时用默认 `SUMMARY_MAX_CHARS = 4000`。
- 取值顺序：频道 `summaryMaxChars > 0` → 全局 `config.summaryMaxChars > 0` → `SUMMARY_MAX_CHARS = 4000`；非法值（1..499、20001 以上、非整数）后台直接 400 `BAD_MEMORY_SETTINGS`（§26.4）。算法本身没变，只是 `budget` 的来源换成了频道配置。
- 装法：把累积正文按 `【记忆段】` 切段，**从新到旧**一段一段往预算里塞，塞不下就停；装进来的段按旧→新原样拼接。
- 预算外的老段**只留在库里**：不删、不改，换个更大的预算就能重新进来。
- 写侧**没有上限**（§31.7）：提示词不再要求字数，落库也不截断；预算只决定这一轮装多少，库里一个字都不少。
- 最新的段优先：老段再多也挤不掉新段；只有最新的这一段自己就超预算时才截断它（唯一会丢字的地方）。

```text
budget = 频道 summaryMaxChars 非零 ? 它 : config.summaryMaxChars 非零 ? 它 : SUMMARY_MAX_CHARS   // 0/缺省 → 4000
segments = 正文按 `【记忆段】` 切段（没有段头 → 整段算 1 段）
kept = 空；used = 0                                  # 实现：src/core/chat/summary.ts 的 selectSegments(text, budgetChars)
for seg of segments 从新到旧：
  cost = kept 为空 ? len(seg) : len(seg) + 2      # 段间空行算 2 个字符
  if used + cost > budget：
    if kept 为空：kept = [截到 budget 的 seg]       # 最新段自己就超预算，只截它
    break
  kept = [seg] + kept；used += cost
注入 = kept 按旧→新拼接
```

### 31.4 /reset 与后台手改

- `/reset` 仍然**连摘要一起删**：清 `messages` + 删 `conversation_summaries` 那一行，累积记忆从 0 重来；
  频道里回的文案是「已清空本频道的对话记录与长期记忆摘要。」（`src/workers/discord/handler.ts` 的 `reset` 分支）。
- 后台 `PUT /api/summaries` 手改正文是**整段替换**：写回什么就是什么，段头要自己留着（§25.7 第 8 条）。
- `/summary view` 与后台「摘要」页看到的是**库里全量正文**，不是注入进上下文的那部分——等预算的老段都在。
- 后台「删除」同样把累积记忆整段清掉，游标回 0（§25.7 第 3 条）。

### 31.5 门牌

- §31 这版门牌是 `'memory-nolimit-1'`；现在门牌是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（135933§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记在 §46.7：接口类型（dialect）——`tts_settings` 多一列 `dialect`，老行默认 `openai`、行为与升级前一致，同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在 `choices[0].message.audio.data`，没有 `speed`），迁移 `0023`（迁移总数 23）；前一版 `'tts-admin-1'` 记在 §46：TTS 接口搬进后台——地址 / Key / 模型 / 默认音色只认后台「语音」页（`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改），`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听；再前一版 `'prompt-scope-1'` 记在 §45：内置默认（`fallback`）与身份块（`identity`）都能在后台改——`prompt_defaults` 两个 key × 三层，解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层；§44.1 记再前一版 `'voice-2'`：按指令模式补上【语音】段——提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同；前一版 `'voice-1'` 是语音回复那版：文字回复结束后可发一条语音附件、三档三层开关（§44）；再前一版 `'pg-errors-1'`，后台「故障」页看 PG 中继报错（§43）；再前一版 `'mention-once-2'` 同一个人一条回复只 @ 一次（§42），再前一版 `'vision-main-2'`，后台三层识图开关那版，§41；更早的 `'vision-main-1'`，主对话也接图那版，§22.9；再更早的 `'none-head-1'`，`src/workers/gateway/engine.ts:129`，§33.9、§22.9：`[gateway] alarm build=reply-tool-3` 或
  `[node] listening … build=reply-tool-3` 出现，才说明这一版在位（§13、§30.1）；`fake-stream-1` 是假流式第一版（片数写死 6，§29.6，历史），`fake-stream-2` 起片数按「频道 > 服务器 > 全局」三层可配（§38，历史），`mention-1` 起服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户（§39，前一版），`mention-2` 把 @ 前缀与「…(已截断)」一起算进正文预算（§39.2，前一版）→ **`'reply-continue-1'`**（被掐断的半句自动续上：协议层 + 文本层双信号判定、把已写正文当 assistant 前缀让模型接着说，最多续 2 次、合并累计上限 3000 字，续段接在同一条消息里，§40，前一版）→ **`'stream-edit-1'`**（边说边编辑：服务层不再节流、模型每来一块就立刻推给同一条消息，真正的节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推，§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7。
- 演进链（历史不抹）：`'self-host-1'`（§30 自托管第一版）→ `'self-host-2'`（摘要单批跟阈值）→ `'memory-append-1'`（累积记忆）→ `'memory-budget-1'`（注入预算频道级可配）→ `'memory-nocap-1'`（写侧不再设上限）→ `'memory-nolimit-1'`（注入条数与自动总结阈值都不设上限，§31.8）→ `'prompt-segments-1'`（提示词改成多段，§32）→ **`'prompt-bounds-1'`**（提示词保存补数值范围与停用段检查，§32.8）→ **`'reaction-guide-1'`**（贴表情文案三层可自定义、取消强制分散，§33.9）→ **`'reaction-template-1'`**（表情素材模板三层可自定义、表情模型能看最近 20 条历史，§34.7）→ **`'summary-backfill-1'`**（选择性补记：后台按时间范围挑段追加一段记忆、游标不动，§35）→ **`'summary-order-1'`**（读消息改按 `created_at` 排序、自动总结游标取批内最大 id，§35.7）→ **`'summary-order-2'`**（选区按 id、送模型按时间序，§35.7 的漏行归零）→ **`'backup-ui-1'`**（网页后台一键手动备份：请求/状态文件 + 每分钟 timer，§36）→ **`'reply-error-1'`**（流里的错误帧抛错、零字正文按候选失败处理，§37）→ **`'reply-error-2'`**（空回复时同一候选模型重试 3 次才换候选，§37）→ **`'fake-stream-1'`**（假流式：整段到手后切片挤出去，§29.6）→ **`'fake-stream-2'`**（假流式的片数做成三层可配、0 = 关闭，§38）→ **`'mention-1'`**（服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户，`@everyone` / `@here` / `@角色` 仍不解析，§39，前一版）→ **`'mention-2'`**（@ 前缀与「…(已截断)」都先从正文预算里扣掉，正文打满 1900 时不再吃掉尾部与截断提示，§39.2，前一版）→ **`'reply-continue-1'`**（被掐断的半句自动续上：协议层 + 文本层双信号判定、把已写正文当 assistant 前缀让模型接着说，最多续 2 次、合并累计上限 3000 字，续段接在同一条消息里，§40，前一版）→ **`'stream-edit-1'`**（边说边编辑：服务层不再节流、模型每来一块就立刻推给同一条消息，真正的节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推，§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7。

### 31.6 本版改动说明（`memory-budget-1`）

一句话：注入预算从「全局 config 可覆盖的常量」升级成**频道级可配**，切片算法一个字没改。

| 面 | 改动 |
| --- | --- |
| 配置 | 频道级新增 `summaryMaxChars`（500..20000；`0`/缺省 = 4000）。迁移 `migrations/0012_memory_budget.sql` 给 `channel_memory_settings` 加 `summary_max_chars INTEGER NOT NULL DEFAULT 0` |
| core | `src/core/types.ts` 的 `ChannelMemoryConfig` 加 `summaryMaxChars?: number`；`src/core/chat/service.ts` 新增 `resolveTurnMemory`，按「频道 > 全局 config > 默认 4000」定预算，`maybeSummarize` 与 `renderSummaryBlock` 都用它 |
| HTTP | `PUT /api/memory-settings` 收 `summaryMaxChars`；`GET /api/memory-settings/channel` 的 `config` 带它（没配过 → 4000）；非法值 400 `BAD_MEMORY_SETTINGS`（`src/workers/http/app.ts:64-65`、`:833`） |
| 后台页 | 记忆页新增「记忆注入预算（字符）」输入（`web/src/pages/MemoryPage.tsx`），`web/src/api.ts` 的类型与 PUT 载荷带上它 |
| 不变 | 从新到旧装满、最新的段优先、预算外的老段留库不进上下文、`/summary` 与后台看到的是库内全量（§31.4） |


### 31.7 本版改动说明（`memory-nocap-1`）

一句话：**写侧不再设上限**——提示词不再要求「控制在 800 字以内」，落库也不再按预算截断；预算只决定这一轮往 prompt 里装多少。

| 面 | 改动 |
| --- | --- |
| 提示词 | `SUMMARY_SYSTEM_PROMPT` 去掉「控制在 800 字以内」，改成「该写多少写多少，不要为了省字数把事实压掉」（`src/core/chat/summary.ts`） |
| core | `normalizeSummary(raw)` 不再接 `maxChars`、不再截断（只 trim 与剥围栏）；`summarizeCore` / `summarizeBatch` / `maybeSummarize` 不再传预算 |
| 不变 | 注入仍按 `summaryMaxChars`（默认 4000，500..20000）从新到旧装满；最新的段自己超预算时仍然只截它（§31.3）；`SUMMARY_MAX_CHARS` 现在只表示**默认注入预算** |
| 代价 | 「已有记忆」会整段进总结请求（`buildSummaryRequest`），记久了这一次调用本身会变长——这是不设上限的固有成本；回复路径的 prompt 仍受预算约束，不受影响 |

### 31.8 本版改动说明（`memory-nolimit-1`）

一句话：**两个数字都不设上限**——注入多少条只由条数决定（那道字符安全阀整个去掉），自动总结阈值填多大都认，单批靠 `min(500, max(50, 阈值))` 加既有循环多批追平。

| 面 | 本版口径 |
| --- | --- |
| 注入条数 | **≥ 2、不设上限**：`historyMaxMessages` 去掉 500 上限；同时删掉那道字符安全阀（`DEFAULT_HISTORY_MAX_CHARS` / `trimToCharBudget`），注入只由条数决定 |
| 自动总结阈值 | **0（关闭）或 ≥ 2、不设上限**：`summaryEveryMessages` 同样去掉 500 上限 |
| 单批 | **`min(500, max(50, 阈值))`**：一次总结调用最多吃 500 条，阈值更大时靠既有循环多批追平（循环本身没有批次数上限，追到积压清完或游标不再前进为止） |
| 代价 | 条数填大 → 每轮 prompt 变长变贵（没有第二个闸兜着）；积压极多时一轮回复之后要跑很多次总结调用才追平 |

## 32. 多段提示词（`prompt-bounds-1`）

### 32.1 为什么要多段

旧形态是**一层一段正文**：`prompts` 一行只有一个 `system_prompt`，外加可选的 `persona`，运行时拼成 `systemPrompt + "\n\n人格：" + persona`（§6 第 6 条）。三个后果：

- **只有一段**：想在身份块之前加一句「先看规则」、或在记忆块之后补一段输出格式，只能挤进同一段正文里；位置由代码写死，改不了。
- **人格是贴在正文后面的补丁**：`persona` 非空才追加，追加点永远在正文之后，想放前面做不到。
- **只有 system**：没法让某几句以 `user` 身份出现在历史之前——酒馆式「先铺几条设定对话，再接真实聊天」做不到。

`prompt-bounds-1` 把「一层一段正文」换成「一层一组段」：每段有自己的名字、角色（system / user）、正文、开关与位置，顺序由 `position` 决定，插在身份/记忆块之前还是之后由 `placement` 决定。

### 32.2 数据模型与迁移回填

类型（`src/core/types.ts`；旧字段 `persona` / `systemPrompt` **彻底删除**，没有兼容别名、没有双写）：

```ts
export type PromptRole = 'system' | 'user';
export type PromptPlacement = 'before' | 'after';

export interface PromptSegment {
  id: string;                   // 同一 (scope, scopeId) 内唯一
  name: string;                 // 显示名，trim 后不能为空
  role: PromptRole;             // system：进 system 提示词；user：进 messages
  content: string;
  enabled: boolean;
  placement: PromptPlacement;   // 只对 role='system' 有意义（§32.3）
  position: number;             // 组内顺序，升序
}

export interface PromptConfig {
  segments: PromptSegment[];
  temperature?: number;
  maxTokens?: number;
}
```

迁移 `migrations/0013_prompt_segments.sql` 建一张新表（列与主键按契约；`CHECK` 与默认值以迁移文件本身为准）：

```sql
CREATE TABLE IF NOT EXISTS prompt_segments (
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  placement TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, id)
);
CREATE INDEX IF NOT EXISTS idx_prompt_segments_scope ON prompt_segments (scope, scope_id, position);
```

主键是 `(scope, scope_id, id)`：同一层内段 id 唯一，不同层可以同名同 id。索引 `idx_prompt_segments_scope` 是 `(scope, scope_id, position)`——服务「取这一层的全部段，且已按 position 排好」。`role` / `placement` / `scope` 在表上还有 `CHECK` 约束兜底（枚举外写不进去），但仍以 HTTP 层校验为准（§32.4）。

**回填**：每个原有的 `prompts` 行各生成段，落在**原行的同一 `scope` / `scope_id`** 上：

| 来源列 | 新段 id | 名称 | position | role | placement | enabled |
| --- | --- | --- | --- | --- | --- | --- |
| `prompts.system_prompt` | `legacy-main` | 基本设定 | 0 | system | before | 1 |
| `prompts.persona`（非空才建） | `legacy-persona` | 人格 | 1 | system | before | 1 |

两条回填的生成条件不一样：**`legacy-main` 对每个 `prompts` 行无条件生成**——旧列 `system_prompt` 是 `NOT NULL`，每层必有一份正文；**`legacy-persona` 只在 `persona` 非 `NULL` 且 trim 后非空时生成**（`migrations/0013_prompt_segments.sql` 里的 `WHERE persona IS NOT NULL AND trim(persona) <> ''`），否则会多出一段空的「人格」段。

回填之后 `ALTER TABLE prompts DROP COLUMN persona` / `DROP COLUMN system_prompt`：`prompts` 行退化成「这一层配置存在」的容器，只剩 `temperature` / `max_tokens` / `updated_at`（§10 那段 SQL 因此只是 `0001` 的历史原样）。

### 32.3 组装顺序

命中层（§32.5）的段先按 `enabled` 过滤，再按 `position` 升序。system 提示词按这张表拼，**段与块之间空行分隔**：

| # | 块 | 来源 |
| --- | --- | --- |
| ① | 启用且 `role=system`、`placement=before` 的段 | 命中层 `segments`，`position` 升序，段间空行 |
| ② | 身份块 | 运行时生成（`{{bot_name}}` / `{{guild_name}}` / `{{channel_name}}` / `{{user_name}}` 那组身份句） |
| ③ | 长期记忆 / 摘要块 | 该频道的累积记忆（§31） |
| ④ | 启用且 `role=system`、`placement=after` 的段 | 命中层 `segments`，同样 `position` 升序 |
| ⑤ | 表情规则块 → 自定义表情清单 → 可贴表情目标清单 | 这三块的顺序不变（§18 / §20 / §21 / §28） |

`role=user` 的段**不进 system**：启用且 `role=user` 的段按 `position` 升序，变成 `messages` 里**排在历史之前**的一批 user 消息——历史原样跟在它们后面，本轮 `userText` 仍是最后一条 user。

- 每段都过 `renderTemplate`，5 个变量：`{{bot_name}}` / `{{user_name}}` / `{{guild_name}}` / `{{channel_name}}` / `{{date}}`（`date` = 当日 `YYYY-MM-DD` UTC，见 §6 第 6 条）。
- 判定看的是**渲染之后**：`renderTemplate` 出来的字符串 `trim()` 为空才整段跳过——`content` 里写着 `{{date}}` 这种「模板非空、渲染后空」的段也算空段。跳过的段既不进 system，也不变成一条空 user 消息。
- **顺序只有一个来源**：段在请求里是数组，数组顺序就是注入顺序；落库时 `position` = 数组下标 `0..n-1`。请求里不需要提交 `position`，提交了也不会被读（§32.4）。
- 段只影响发给模型的那份 `messages`：不写进历史、不进摘要、不改落库（§9）。

### 32.4 API 与校验

`PUT /api/prompts`：

```jsonc
{
  "scope": "channel",            // global | guild | channel
  "scopeId": "…",                // global 恒为 ''
  "temperature": 0.8,            // 可选
  "maxTokens": 1024,             // 可选
  "segments": [                  // 必填、非空
    { "id": "legacy-main", "name": "基本设定", "role": "system", "content": "…", "enabled": true, "placement": "before" }
  ]
}
```

- 请求里 `id` 可省（服务端生成，也可显式给，给了就得非空且同一次请求内不重复）；**`position` 不在请求契约里**——服务端不读这个字段，提交了按忽略处理：**数组顺序就是注入顺序**，落库按下标 `0..n-1`。
- 400 错误码（校验沿用 `readScopeKey` 的既有分工）：
  - `BAD_SCOPE`：`scope` 不在枚举内（`global` / `guild` / `channel` 之外）。
  - `BAD_REQUEST`：该 scope 需要的 `scopeId` 缺失、为空或不是字符串（`global` 的 `scopeId` 恒为 `''`）；`temperature` 不在 `0..2` 之间、`maxTokens` 不是 `1..100000` 的整数、请求体不是 JSON 对象也走这一码（范围见 §32.8，`/api/routes` 用的是同一把尺）。与 `GET` / `DELETE /api/prompts`、`/api/routes`、`/api/keys` 等端点一致。
  - `BAD_PROMPT_SEGMENTS`：`segments` 不是非空数组；`name` trim 后为空；`role` 或 `placement` 非法；`enabled` 不是布尔；`content` 不是字符串；`id` 重复。段本身的问题一律这一码。
  - `UNKNOWN_TEMPLATE_VAR`：**逐段**检查未知模板变量，命中就 400 并回 `vars`（出错的那几个变量名）。只看**已启用**的段——停用的段根本不进 prompt，写错变量不该挡保存（§32.8）。
- **后台文案只认三个码**：`web/src/api.ts` 只把 `BAD_SCOPE` / `BAD_PROMPT_SEGMENTS` / `UNKNOWN_TEMPLATE_VAR` 翻成中文，其余码按 `error.message` 原样显示——所以 `scopeId` 没填这类 `BAD_REQUEST` 在页面上是**通用错误提示**，不是「作用域不合法」那句专门文案。
- **空数组不等于「清空」**：`segments: []` 直接按 `BAD_PROMPT_SEGMENTS` 拒掉。想清空这一层请用 `DELETE /api/prompts`（`{scope, scopeId}`）——这样「手滑清空」不可能发生。
- `GET /api/prompts` 回的是段模型：`{items:[{scope,scopeId,temperature,maxTokens,segments:[…]}]}`，`segments` 按 `position` 升序并带 `id` / `position`。

### 32.5 作用域仍是整组覆盖

- 命中规则没变：channel > guild > global，**整组覆盖**——命中哪一层就只用那一层的**全部**段。
- **不跨层拼接**：channel 层只要配了段，guild / global 的段一个都不进来；哪怕 channel 层只放了一段。
- 三层都没有段 = 没有提示词配置，回落到内置默认提示词（§8），与旧版「三层全空」同一条路径。
- `temperature` / `maxTokens` 跟着同一层的 `prompts` 行走，不跨层取。

### 32.6 与旧版的差异与兼容

| 面 | 旧（`memory-nolimit-1` 及以前） | 新（`prompt-segments-1`） |
| --- | --- | --- |
| 存哪 | `prompts.system_prompt` + 可选 `persona` | 新表 `prompt_segments`，一层多段 |
| 顺序 | 正文在前、人格固定追加在正文之后 | 每段 `position` 决定；`placement` 决定在身份/记忆块之前还是之后 |
| 角色 | 只有 system | system 与 user 两种 |
| 开关 | 没有 | 每段 `enabled` |
| 清空 | 无（只有整行删除） | `DELETE /api/prompts`；`segments: []` 不放行 |
| API 字段 | `persona` / `systemPrompt` | `segments`（每项带 `role` / `placement` / `enabled`） |
| 命中 | channel > guild > global | 不变（整组覆盖，§32.5） |

**回填后行为等价**：`legacy-main`（`before`）排在 `legacy-persona` 之前，两条都在身份块之前——与旧版「正文 → 人格」的先后一致；旧库里 `persona` 为空的行只生成 `legacy-main`，等价于旧版不追加人格。内容一字未改，差异只在拼接细节：旧版是正文与身份块直接相连，新版段与块之间统一空行分隔，所以同一段文本在 prompt 里的字符串可能多出空行。段模型多出来的能力（多段、开关、`user` 角色、`after` 位置）回填后一个都不启用，行为与旧版等价。

### 32.7 门牌

- 现在门牌 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（163135§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记在 §46.7（`src/workers/gateway/engine.ts:129`；§33.9）：接口类型（dialect）——`tts_settings` 多一列 `dialect`，老行默认 `openai`、行为与升级前一致，同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在 `choices[0].message.audio.data`，没有 `speed`），迁移 `0023`（迁移总数 23）；前一版 `'tts-admin-1'` 记在 §46：TTS 接口搬进后台——地址 / Key / 模型 / 默认音色只认后台「语音」页（`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改），`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听；再前一版 `'prompt-scope-1'` 记在 §45：最底层的 `DEFAULT_PROMPT` 与身份块都能在后台改——`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块）、解析顺序三层提示词 → 三层内置默认 → 代码常量、三层都没配时输出与上一版逐字相同（§45.2、§45.3）；§44.1 记再前一版 `'voice-2'`：按指令模式补上【语音】段——只有 `mode = 1` 注入、教模型在正文里单独写一行 `[[voice]]`，位置在表情规则块之后、自定义表情清单之前，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同；§44 记前一版 `voice-1`：语音回复（文字回复结束后可发一条 mp3 附件、三档三层开关）；§43 记再前一版 `pg-errors-1`：后台「故障」页看 PG 中继报错（中继 `GET /admin/errors` + bot `/api/pg-errors` 代理 + 后台「故障」页）；§42 记前一版 `mention-once-2`：同一个人一条回复只 @ 一次——自动加在正文开头的 @ 前缀就算这一次，同一人再出现换成显示名、查不到名字就整段去掉标签；§41 记更前一版 `vision-main-2`：后台的三层识图开关——主对话模型这一侧可按 global / guild / channel 关掉，默认开、每条消息现读一次；§22.9 记更早的 `vision-main-1`：主对话模型也接图；§28.6 记更早的 `none-head-1` 的回复正文首行 `NONE` 由服务层剥掉；§29.7 记更早的 `empty-note-1` 的只 @ 不说话（`docs/operations.md` §14.2），`stream-edit-1` 是更早一版（边说边编辑），`reply-continue-1` 是续写那版（§40，更早一版）；`mention-1` 起服务器频道的回复自动在正文前 @ 提问者、`mention-2` 把 @ 前缀与「…(已截断)」一起算进正文预算，§39 / §39.2，前一版；`fake-stream-1` 是假流式写死 6 片那版，§29.6，`fake-stream-2` 把片数做成三层可配、0 = 关闭，§38，两版都是历史：`[gateway] alarm build=reply-tool-3` 或 `[node] listening … build=reply-tool-3` 出现，才说明这一版在位（§13、§30.1）。
- 演进链（历史不抹）：`'self-host-1'`（§30 自托管第一版）→ `'self-host-2'`（摘要单批跟阈值）→ `'memory-append-1'`（累积记忆）→ `'memory-budget-1'`（注入预算频道级可配）→ `'memory-nocap-1'`（写侧不再设上限）→ `'memory-nolimit-1'`（注入条数与自动总结阈值都不设上限，§31.8）→ `'prompt-segments-1'`（提示词改成多段，本节）→ **`'prompt-bounds-1'`**（提示词保存补数值范围与停用段检查，§32.8）→ **`'reaction-guide-1'`**（贴表情文案三层可自定义、取消强制分散，§33.9）→ **`'reaction-template-1'`**（表情素材模板三层可自定义、表情模型能看最近 20 条历史，§34.7）→ **`'summary-backfill-1'`**（选择性补记：后台按时间范围挑段追加一段记忆、游标不动，§35）→ **`'summary-order-1'`**（读消息改按 `created_at` 排序、自动总结游标取批内最大 id，§35.7）→ **`'summary-order-2'`**（选区按 id、送模型按时间序，§35.7 的漏行归零）→ **`'backup-ui-1'`**（网页后台一键手动备份：请求/状态文件 + 每分钟 timer，§36）→ **`'reply-error-1'`**（流里的错误帧抛错、零字正文按候选失败处理，§37）→ **`'reply-error-2'`**（空回复时同一候选模型重试 3 次才换候选，§37）→ **`'fake-stream-1'`**（假流式：整段到手后切片挤出去，§29.6）→ **`'fake-stream-2'`**（假流式的片数做成三层可配、0 = 关闭，§38）→ **`'mention-1'`**（服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户，`@everyone` / `@here` / `@角色` 仍不解析，§39，前一版）→ **`'mention-2'`**（@ 前缀与「…(已截断)」都先从正文预算里扣掉，正文打满 1900 时不再吃掉尾部与截断提示，§39.2，前一版）→ **`'reply-continue-1'`**（被掐断的半句自动续上：协议层 + 文本层双信号判定、把已写正文当 assistant 前缀让模型接着说，最多续 2 次、合并累计上限 3000 字，续段接在同一条消息里，§40，前一版）→ **`'stream-edit-1'`**（边说边编辑：服务层不再节流、模型每来一块就立刻推给同一条消息，真正的节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推，§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7。
- 提示词的写入路径（后台 `/api/prompts`、斜杠命令）部署即生效，不经过 DO；**只有网关（@ 路径）要等换码**——还看到 `memory-nolimit-1` 或更早的门牌，就是实例还没换（§13）。

### 32.8 本版改动说明（`prompt-bounds-1`）

一句话：段模型一个字没改，补的是**保存时那两道校验**——数值加范围，未知变量只查启用的段。

| 面 | 旧（`prompt-segments-1`） | 新（`prompt-bounds-1`） |
| --- | --- | --- |
| `temperature` / `maxTokens` | 只校验「是有限数字」，`-1` / `0` / `1.5` 都能存 | `temperature` 只收 `0..2`（可小数）；`maxTokens` 只收 `1..100000` 的**整数**；越界 400 `BAD_REQUEST` |
| 范围常量 | 无 | `src/workers/http/app.ts:71-72` 的 `TEMPERATURE_BOUNDS` / `MAX_TOKENS_BOUNDS`，`PUT /api/prompts` 与 `PUT /api/routes` 共用 |
| 未知模板变量 | 所有段都查，停用段写错 `{{var}}` 就整次 400 | 只查 `enabled: true` 的段（`src/workers/http/app.ts:529`） |
| 段的存读、排序、覆盖规则 | — | 一个字没改（§32.2–§32.5 仍然有效） |

**为什么要补范围**：`temperature` / `maxTokens` 是原样塞进模型请求的（`src/core/chat/service.ts:748-749`，`:769-770`），存进去一个 `-1` 或 `1.5` 会让那个作用域的**每一轮**调用都失败，而报错发生在运行时、页面上看不出来源。上界 `maxTokens: 100000` 是「比任何在售模型的输出上限都高」的宽松值，只用来挡手滑输入的位数错误。

**为什么停用段不再查**：停用的段既不进 system 也不进 messages，留着它只是备忘。原实现对着所有段查未知变量，等于「想把一段写坏的草稿先停掉」做不到。

**没动的**：`/api/prompts` 的错误码集合、段的必填项、`segments: []` 不算清空、作用域整组覆盖，全部照旧。`/api/routes` 的 `temperature` / `maxTokens` 与提示词共用 `readOptionalNumber`，这次一起收紧了。

---

## 33. 贴表情文案（`reaction-guide-1`，2026-10-28）

### 33.1 结论

一句话：**「教模型怎么贴表情」那段话从写死变成三层可配的一份文案，两条路径共用；同时取消「没点名也自动分给别人」**——想让大家各收一个，得让模型自己写 `@all`。

| 面 | 改前（`prompt-bounds-1` 及更早） | 改后（`reaction-guide-1`） |
| --- | --- | --- |
| 主模型的【表情】块 | `renderEmojiGuide(withCustomEmojis)`（原 `src/core/chat/service.ts:298`，本版已删除）写死两句话，还带一个 `withCustomEmojis` 开关 | `renderReactionGuide(guide)`（`src/core/chat/service.ts:304`）渲染解析后的文案：在文案前补 `'\n\n【表情】\n'`，再接在 system 尾部（§33.4） |
| 兜底表情模型的 system | `REACTION_SYSTEM_PROMPT`（原 `src/core/chat/reaction.ts:9`，本版已删除）写死八行 | 同一份解析后的文案：`buildReactionRequest` 的 `system` 取 `input.guide`（`src/core/chat/reaction.ts:131`），写死的常量不再被读（§33.4） |
| 文案从哪来 | 代码里的常量，改文案要发版 | `reaction_guides` 表：channel > guild > global > 内置默认 `DEFAULT_REACTION_GUIDE`（§33.2 / §33.3） |
| 后台入口 | 无 | 「表情」页多一节「贴表情提示词」，`GET/PUT/DELETE /api/reaction-guides`（§33.7） |
| 没点名的表情 | `spreadReactions` 无条件按「最近说过话的人」依次分配（§28.9） | 原样只贴触发那条；只有 `[[react:😄@all]]` 才展开（§33.5） |
| 日志 | 只有 `贴表情 计划 …` | 回复那一轮的 `[chat] turn … guide=<layer>`，看得见哪层文案生效（§33.4） |

### 33.2 存储与迁移

一层一行，新表 `reaction_guides`（`migrations/0014_reaction_guides.sql`，下面的 DDL 与该文件一致，若有出入以文件为准；风格与 `0013_prompt_segments.sql` 相同）：

```sql
-- §33：贴表情提示词三层配置（global / guild / channel），整组覆盖、命中哪层用哪层
CREATE TABLE IF NOT EXISTS reaction_guides (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
```

- 主键 `(scope, scope_id)`：`global` 只有一行且 `scope_id = ''`；`guild` / `channel` 按 Discord ID 各一行（ID 只做非空校验，不去 Discord 查它存不存在，§33.7）。
- **只有「有配置」的层才有一行**：`PUT` 写或覆盖，`DELETE` 删行——所以「表里没这一行」和「这一层没配置」是同一件事（§33.3）。
- `updated_at` 是 ISO 字符串，`PUT` 每次刷新；后台用它显示「上次保存」。
- 迁移跑法与既有版本一致（`docs/hosting.md`）：空库一次跑到 `0014`；生产库已经是 `0013` 的，这次只多出这一张表，`_migrations` 账本多一行（`0001`…`0014` 共 14 个），其它表结构与数据一个字不动。
- 仓储是 `ReactionGuideStore`（`get` / `list` / `put` / `remove`，接口在 `src/core/ports.ts:119`，与 `PromptStore`（`src/core/ports.ts:21`）同一套形状：同一个 `ScopedKey`，同样是「没有行 = 这一层没配置」），实现与 `ReactionModelStore` 并列（`src/workers/db/d1-repository.ts:797`）；后台三条路由分别接 `list()`（`src/workers/http/app.ts:721`）、`put()`（`:739`）、`remove(key)`（`:755`）。

### 33.3 三层命中与回落

解析在 core 做，一次函数决定这一轮用谁的文案：`resolveReactionGuide(channel: ReactionGuideConfig | null, guild: ReactionGuideConfig | null, global: ReactionGuideConfig | null): { prompt: string; scope: Scope }`（`src/core/chat/reaction-guide.ts:39`）。

| 顺序 | 用哪一层 | 条件 |
| --- | --- | --- |
| 1 | `channel` | 有这一行，且 `prompt.trim() !== ''` |
| 2 | `guild` | 同上 |
| 3 | `global` | 同上 |
| 4 | 内置默认 `DEFAULT_REACTION_GUIDE`（`src/core/chat/reaction-guide.ts:9`） | 三层都没有；返回的 `scope` 记 `'global'` |

- **整组覆盖，不拼**：命中哪层就整份用哪层，和提示词段（§32.2）同一套惯例——不存在「guild 写了几句 + channel 写了几句」拼起来这回事。
- **留空 = 这一层没有**：`trim()` 之后为空的行按「没配」处理；写入口也不收空正文（空着保存等于删这一层，§33.7 的 `BAD_REACTION_GUIDE`）。
- 三层都空时返回 `scope: 'global'`：对调用方就是「全局默认在生效」，日志也记 `guide=global`（§33.4）。
- 解析是纯函数（三份配置进、一份文案出）：调用方读到哪三份由它自己按 `TurnContext` 的频道 / 服务器取，core 不再回查数据库。

### 33.4 两条路径共用一份文案

产生贴表情指令的地方只有两处，现在两处读同一份：

| 路径 | 装配点 | 读什么 |
| --- | --- | --- |
| 主模型 | 拼 system 时把 `renderReactionGuide(guide.prompt)` 接在摘要块之后（`src/core/chat/service.ts:747`，§18.8） | 这一轮解析出的文案 + 命中的 `scope` |
| 兜底表情模型 | `buildReactionRequest`（`src/core/chat/reaction.ts:111`）的 `system` 取 `input.guide`（`:131`） | 同一份文案（写死的 `REACTION_SYSTEM_PROMPT` 不再被读） |

- **谁解析、谁渲染**：core。`resolveReactionGuide` 挑层（§33.3），`renderReactionGuide(guide)` 补 `'\n\n【表情】\n'` 标题——两条路径共用这两个函数，所以标题不会出现两次、也不会一处有一处没有。
- **调用方只管取数**：网关 DO、自托管 Node 宿主、斜杠命令路径各自把三层配置读出来递给 core，不自己挑层、也不自己拼标题。
- **日志**：三处都带 `guide=<scope>`——`[chat] turn prompt=… guide=<scope>`（`src/core/chat/service.ts:781`）、`回复成功 … guide=<scope>`（`:858`）、`表情选择 … guide=<scope>`（`:666`）。值只会是 `channel` / `guild` / `global`；**三层都没配时也记 `global`**（用的是内置默认文案）——看它就知道「我改的那一层到底有没有被用上」。
- **空白文案不出空标题**：`renderReactionGuide` 对 `trim()` 后为空的正文直接返回空串（`src/core/chat/service.ts:304-307`）；正常路径到不了这里（空正文在写入口就被 400 挡下，§33.7），但库里若留着旧的空行，也不会在提示词里冒出个空【表情】。
- **生效时机**：文案写侧部署即生效（读表，不经 DO）；只有 `@all` 的展开跑在网关里，要等 DO 换码（§13、§33.9）。

### 33.5 `@all` 展开规则

只有模型显式写「给大家贴」才展开，判据是 `[[react:<表情>@<目标>]]` 里那个 `<目标>`：

- **六个同义词**：`all` / `everyone` / `大家` / `所有人` / `全员` / `*`；**大小写不敏感、`trim()` 后比较**，所以 `[[react:😄@ALL]]`、`[[react:😄@ 大家 ]]` 都算。
- **展开顺序**：按当轮候选清单从新到旧，一人一条。清单就是注入提示词的那份（`src/workers/gateway/engine.ts:944` 的 `#reactionTargets`：最近 10 条频道消息 + 触发那条 + 被回复那条，去重后截 10），**不新增 Discord 拉取**。
- **跳过 bot**：`target.bot === true` 的消息不进池子（含我们自己发的），不给 bot 贴表情。
- **池空兜底**：一个人都没有时退回贴触发那条（`messageId`）：不报错，也不会一条都不贴。
- **上限**：`MAX_REACTIONS = 10`（`src/core/chat/react.ts:4`）是总共的额度，展开出来的每一条各占一个；模型自己还写了别的就按出现顺序接着算。
- **去重**：同一（表情 + 消息）只留一条（§28.3）；同一表情贴给不同的人算不同的条目。
- **在哪展开**：网关（`src/workers/gateway/engine.ts:987` 的 `#react`）——只有它持有候选清单。core 的 `splitReactDirectives`（`src/core/chat/react.ts`）只把这种写法解析成「广播标记」（`ReactionRequest.broadcast`，`src/core/types.ts:254`），不填具体目标。
- 清单之外的消息仍然贴不了：目标不在清单、表情不在该服清单，只 warn 并跳过，不影响回复（§28.8）。

### 33.6 内置默认文案全文

三层都没有配置时用 `DEFAULT_REACTION_GUIDE`（`src/core/chat/reaction-guide.ts:9`）。**渲染时会在这段文案前面加【表情】标题，所以文案本身不含标题**；下文与代码常量逐字一致，若实现与这里的文字有出入，以代码为准：

```text
【怎么判断】
值得贴的：开心的、可爱的、惊讶的、有梗的、在夸人或者在道谢的，都可以贴一个。
不值得贴的：正经提问、吵架、难过、严肃通知，一个都不要贴；一条都不贴完全允许，这时一行 [[react:…]] 都不写，也不要解释为什么。

【怎么指定贴哪条】
[[react:😄]] 不写目标 = 贴在这一轮要回的那条消息上。
[[react:😄@消息ID]] 贴到指定的那条消息（消息 ID 是 15~20 位纯数字）。
[[react:😄@作者名]] 贴到这个人最近说的一条消息。
想给最近说过话的每个人各贴一个，就写 @all：@all、@everyone、@大家、@所有人、@全员、@* 都算同一种写法，系统会把一个表情分给最近发过言的每个人，一人一条。
没点名就不换目标：系统只贴在它自己那条上，不会替你挪到别人身上。

【格式】
一行一个表情，最多 10 行；一行只写 [[react:…]]，不要解释、不要加标点、不要用代码围栏、不要写别的文字。
自定义表情写成 [[react:名字]]（名字就是清单里列出的那个，形如 :名字:）；unicode emoji 直接写在 [[react:]] 里，如 [[react:😄]]。
贴表情只走 [[react:…]]；正文照常说话，不要在正文里堆一串表情。
```

- 三段（怎么判断 / 怎么指定贴哪条 / 格式）少一段线上就退化：少「怎么判断」会逢消息必贴，少「不值得就不贴」会硬凑，少「格式」会写成解释或代码围栏。
- 文案里教 `@all` 与「没点名就不换目标」两件事——所以默认行为与 §33.5 一致，不写 `@all` 不会分散。
- 后台「贴表情提示词」一节的 placeholder 就是这段（`GET /api/reaction-guides` 的 `default`，§33.7），「恢复默认」= 删掉这一层。
- **`NONE` 只在表情请求那一侧（none-head-1 起的分工）**：上面这段共用文案里**不再出现 `NONE`**，不贴就写成「一行 `[[react:…]]` 都不写」。理由很具体：这份文案同时喂主模型的 system，教出「只输出一行 NONE」这种**正文**约定后，模型偶尔就真照着说出来，回复开头于是多一行 `NONE`（线上历史消息里已经出现过，例如 `2439` / `2468` / `2470`）。`NONE` 现在只由 `NO_REACTION_NOTE`（`src/core/chat/reaction.ts:28`，一行「没有值得贴的表情时，只回一行 NONE，不要解释为什么。」）补在**表情请求**的 system 末尾（`buildReactionRequest`，`src/core/chat/reaction.ts:152`：`input.guide.trim() === '' ? NO_REACTION_NOTE : input.guide + '\n\n' + NO_REACTION_NOTE`），主模型那一侧永远看不到这句话。


### 33.7 API 契约

三条路由都在 `src/workers/http/app.ts`，与其它 `/api/*` 同一套后台鉴权（§17）。

**`GET /api/reaction-guides`** → 200

```json
{
  "items": [
    { "scope": "channel", "scopeId": "1234567890", "prompt": "【怎么判断】…", "updatedAt": "2026-10-28T09:12:00.000Z" }
  ],
  "default": "【怎么判断】…"
}
```

- `items` 只列**有配置**的层（没配的层不出现，不是空字符串占位）；`default` 是内置文案（§33.6），后台拿它当 placeholder 与「恢复默认」的目标。
- 坏行（`scope` 不在三档、`prompt` 为空）不返回也不报错：读侧不当故障处理，页面照样能用。

**`PUT /api/reaction-guides`** — body `{ scope, scopeId?, prompt }`

```json
{ "scope": "channel", "scopeId": "1234567890", "prompt": "【怎么判断】…" }
```

- 200 回写后的对象 `{ scope, scopeId, prompt, updatedAt }`。
- **整段覆盖**：这一层的文案被这次 body 的 `prompt` 整个换掉，不是追加、也不是按行合并。
- `global` 可以不传 `scopeId`（传空串也收），落库的 `scope_id` 是 `''`。

**`DELETE /api/reaction-guides`** — body `{ scope, scopeId }` → 200 `{ "ok": true }`

- 删掉这一层 = 落回上一层（§33.3）。
- **幂等**：本来就没配也回 200，不报 404——「清空这一层」这个动作重复执行不该失败。
- 走 body 不走 query：`scope` / `scopeId` 与 `PUT` 用同一套解析。

| 错误码 | 状态 | 什么时候 |
| --- | --- | --- |
| `BAD_SCOPE` | 400 | `scope` 不在 `global` / `guild` / `channel` |
| `BAD_REQUEST` | 400 | `guild` / `channel` 的 `scopeId` 缺失或空串（`global` 例外） |
| `BAD_REACTION_GUIDE` | 400 | `prompt` 不是字符串 / `trim()` 后为空 / 长度超过 8000 |

- 错误体与其它接口同一个形状：`{ "error": "BAD_SCOPE" }`。
- `guild` / `channel` 的 `scopeId` 只校验非空，**不去 Discord 查这个服务器 / 频道存不存在**：写一个不存在的 ID 不会 400，只是永远命中不到。
- 8000 字是「比任何正常文案都长」的宽松上界，只挡手滑贴进去一整份日志。

### 33.8 本版改动说明（`reaction-guide-1`）

一句话：表情的判断逻辑一个字没动（`[[react:…]]` 语法、消息 ID 15–20 位、作者名 ≤32 字、同键去重、上限 10 全部照旧），动的是「教它怎么用」这段话从哪来，以及「没点名也自动分给别人」这条默认。

| 面 | 内容 |
| --- | --- |
| 新增文件 | `src/core/chat/reaction-guide.ts`（`DEFAULT_REACTION_GUIDE` + `resolveReactionGuide` + `renderReactionGuide`）、`migrations/0014_reaction_guides.sql` |
| 新增表 | `reaction_guides`（§33.2），仓储 `ReactionGuideStore` |
| 改的读侧 | 主模型 system 的【表情】块（`src/core/chat/service.ts`，旧 `renderEmojiGuide`）、兜底表情模型的 system（`src/core/chat/reaction.ts`，旧 `REACTION_SYSTEM_PROMPT`） |
| 改的执行侧 | `src/workers/gateway/engine.ts:987` 的 `#react`：去掉无条件 `spreadReactions`，只展开模型点名的广播（§33.5） |
| 新增接口 | `GET/PUT/DELETE /api/reaction-guides`（§33.7），后台「表情」页多一节「贴表情提示词」 |
| 新增日志 | 回复那一轮的 `[chat] turn … guide=<layer>`，值只会是 `channel` / `guild` / `global`（§33.4） |
| 没动 | 表情模型三态（`enabled` / `provider` / `model`）、表情描述与别名、`:名字:` 正文渲染、`[[react:…]]` 的解析边界、候选清单的取数方式（仍不新增 Discord 拉取）、提示词段（§32） |

### 33.9 门牌

- 现在门牌 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（186026§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记在 §46.7（`src/workers/gateway/engine.ts:129`）：接口类型（dialect）——`tts_settings` 多一列 `dialect`，老行默认 `openai`、行为与升级前一致，同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在 `choices[0].message.audio.data`，没有 `speed`），迁移 `0023`（迁移总数 23）；前一版 `'tts-admin-1'` 记在 §46：TTS 接口搬进后台——地址 / Key / 模型 / 默认音色只认后台「语音」页（`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改），`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听；再前一版 `'prompt-scope-1'` 记在 §45：最底层的 `DEFAULT_PROMPT` 与身份块都能在后台改——`prompt_defaults` 两个 key × 三层、解析顺序三层提示词 → 三层内置默认 → 代码常量、身份块模板逐行丢弃，「恢复默认」只删所在那一层（§45.2、§45.3）；§44.1 记再前一版 `'voice-2'`：按指令模式补上【语音】段——只有 `mode = 1` 注入、教模型在正文里单独写一行 `[[voice]]`，位置在表情规则块之后、自定义表情清单之前，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同；§44 记前一版 `voice-1`：语音回复（文字回复结束后可发一条 mp3 附件、三档三层开关）；§43 记再前一版 `pg-errors-1`：后台「故障」页看 PG 中继报错（中继 `GET /admin/errors` + bot `/api/pg-errors` 代理 + 后台「故障」页）；§42 记前一版 `mention-once-2`：同一个人一条回复只 @ 一次——自动加在正文开头的 @ 前缀就算这一次，同一人再出现换成显示名、查不到名字就整段去掉标签；§41 记更前一版 `vision-main-2`：后台的三层识图开关——主对话模型这一侧可按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看；§22.9 记更早的 `vision-main-1`：主对话模型也接图（网关 `imageRefs` 一轮只下载一份、只进首段与表情请求、续写不带图）；§28.6 记更早的 `none-head-1` 的回复正文首行 `NONE` 由服务层剥掉；§29.7 记更早的 `empty-note-1` 的只 @ 不说话（`docs/operations.md` §14.2），`stream-edit-1` 是更早一版（边说边编辑），`reply-continue-1` 是续写那版（§40，更早一版）；更早的 `none-head-1` 改的是回复正文开头单独一行的 NONE：NONE 只留给表情请求那一侧，服务层在剥指令与剥时间戳之后再过一道 `stripNoReactionHead`（`src/core/chat/reaction.ts`）把它剥掉（`none` / `无` / `不贴` 同义），整条只有 NONE 时原样保留（`docs/operations.md` §28.6）；`mention-1` 起服务器频道的回复自动在正文前 @ 提问者、`mention-2` 把 @ 前缀与「…(已截断)」一起算进正文预算，§39 / §39.2，前一版；`fake-stream-1` 是假流式写死 6 片那版，§29.6，`fake-stream-2` 把片数做成三层可配、0 = 关闭，§38，两版都是历史：`[gateway] alarm build=reply-tool-3` 或 `[node] listening … build=reply-tool-3` 出现，才说明这一版在位（§13、§30.1）。
- 演进链（历史不抹）：`'self-host-1'`（§30 自托管第一版）→ `'self-host-2'`（摘要单批跟阈值）→ `'memory-append-1'` → `'memory-budget-1'` → `'memory-nocap-1'` → `'memory-nolimit-1'`（§31.8）→ `'prompt-segments-1'`（提示词改多段，§32）→ **`'prompt-bounds-1'`**（提示词保存补数值范围，§32.8）→ **`'reaction-guide-1'`**（贴表情文案三层可自定义、取消强制分散，§33.9）→ **`'reaction-template-1'`**（表情素材模板三层可自定义、表情模型能看最近 20 条历史，§34.7）→ **`'summary-backfill-1'`**（选择性补记：后台按时间范围挑段追加一段记忆、游标不动，§35）→ **`'summary-order-1'`**（读消息改按 `created_at` 排序、自动总结游标取批内最大 id，§35.7）→ **`'summary-order-2'`**（选区按 id、送模型按时间序，§35.7 的漏行归零）→ **`'backup-ui-1'`**（网页后台一键手动备份：请求/状态文件 + 每分钟 timer，§36）→ **`'reply-error-1'`**（流里的错误帧抛错、零字正文按候选失败处理，§37）→ **`'reply-error-2'`**（空回复时同一候选模型重试 3 次才换候选，§37）→ **`'fake-stream-1'`**（假流式：整段到手后切片挤出去，§29.6）→ **`'fake-stream-2'`**（假流式的片数做成三层可配、0 = 关闭，§38）→ **`'mention-1'`**（服务器频道的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户，`@everyone` / `@here` / `@角色` 仍不解析，§39，前一版）→ **`'mention-2'`**（@ 前缀与「…(已截断)」都先从正文预算里扣掉，正文打满 1900 时不再吃掉尾部与截断提示，§39.2，前一版）→ **`'reply-continue-1'`**（被掐断的半句自动续上：协议层 + 文本层双信号判定、把已写正文当 assistant 前缀让模型接着说，最多续 2 次、合并累计上限 3000 字，续段接在同一条消息里，§40，前一版）→ **`'stream-edit-1'`**（边说边编辑：服务层不再节流、模型每来一块就立刻推给同一条消息，真正的节流只在编辑器的 `intervalMs`(1200ms) / `maxEdits`(20)，续写的每一段同样边收边推，§29.7，前一版）→ **`'empty-note-1'`**（只 @ 不说话时不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断，operations §14.2，前一版）→ **`'none-head-1'`**（回复正文开头单独一行的 NONE 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，NONE 只留给表情请求那一侧，operations §28.6，前一版）→ **`'vision-main-1'`**（主对话模型也接图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写请求不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，§22.9，前一版）→ **`'vision-main-2'`**（后台的三层识图开关：主对话模型这一侧可以按 global / guild / channel 关掉，默认开、每条消息现读一次，关掉后主对话请求不带图而表情模型照旧能看，§41，前一版）→ **`'mention-once-2'`**（同一个人一条回复只 @ 一次：自动加在正文开头的 `<@提问者id> ` 前缀就算这一次，同一人再出现时正文里换成聊天记录里的显示名、不带 `<@id>`，查不到名字就整段去掉标签，§42，前一版）→ **`'pg-errors-1'`**（后台「故障」页看 PG 中继报错：中继 `GET /admin/errors` 读内存环形缓冲 200 条，bot 侧 `/api/pg-errors` 代理，后台「故障」页，§43，前一版）→ **`'voice-1'`**（文字回复结束后可发一条语音附件，三档三层开关，§44，前一版）→ **`'voice-2'`**（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7。
- 提示词文案与接口部署即生效；`@all` 的展开、素材模板的取用（本版才在读侧改成读表）与 20 条历史都要等 DO 换码——还看到 `reaction-guide-1` / `prompt-bounds-1` 或更早的门牌，就是网关还没换（§13）。

## 34. 表情素材模板（`reaction-template-1`，2026-10-28）

一句话：表情模型每次被问「贴不贴」时，喂给它的那一整段素材从代码里拼死的四段变成**后台可编辑的模板**（global / guild / channel 三层，命中哪层整份用哪层）；同时素材里多了一节「最近的对话」——它现在能看到**最近 20 条**频道记录。

### 34.1 为什么要让表情模型看历史

- 改前（§33 那版）：素材只有两样真内容——触发它的那句（对方的消息）和主模型刚写的那句回复，外加自定义表情清单与可贴消息清单。「最近聊了些什么」它完全看不到：话题是接了两轮还是刚起头、谁在说、气氛是正经还是打岔，它一概不知道，只能凭单独一句话猜该贴什么。
- 改后：素材里多了 `{{最近对话}}`，填的是**最近 20 条**（`REACTION_HISTORY_MESSAGES = 20`，`src/core/chat/reaction.ts:12`），取的是注入历史的尾巴（`tail.kept.slice(-REACTION_HISTORY_MESSAGES)`，`src/core/chat/service.ts:795-797`）——`kept` 就是这一轮真正注入给主模型的那批消息，所以两边看到的是同一批、用同一套 `[MM-DD HH:mm] 显示名(用户ID)：正文` 渲染（`formatTranscript`），只是这里封顶 20 条。触发这一句不在里面，它已经单独占 `{{对方的消息}}`。
- **为什么与「注入条数」解耦**：注入条数（`historyMaxMessages`，频道级，默认 50，§23）管的是主对话；表情模型是每轮回复之后的**第二次调用**，如果它的素材条数跟着频道设置一起涨，第二次调用的输入就会与第一次同量级，等于每条消息多跑一次等量的调用。固定 20 条是可预期的上界：够看清这几轮在聊什么，又不会把成本跟着注入条数一起放大。
- 代价：多出来的历史只进素材（给表情模型那一次调用），不写进 messages、不进摘要；20 条以外的更早对话它看不到，要它知道更早的事，只能靠主模型把上下文写进正文。

### 34.2 数据

`migrations/0015_reaction_templates.sql`（**只建表、不动已有表**，能直接跑在已有生产库上）：

```sql
-- 表情模型素材模板的三层配置：global / guild / channel 各至多一行，命中哪层整份用哪层。
-- 只建表、不动任何已有表：这一段必须能直接跑在已有生产库上（0015 只做加法）。
-- scope_id：global 恒为空串，guild 存 guildId，channel 存 channelId；空串给 DEFAULT 是为了 global 那一行不用特判。
CREATE TABLE IF NOT EXISTS reaction_templates (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
```

- 一层至多一行：`PRIMARY KEY (scope, scope_id)` 让「同一层再写一次」变成 upsert，`global` 恒用 `''` 当 `scope_id`。
- 与 `reaction_guides`（§33.2）同形：同一套 `scope` / `scope_id` / `updated_at` 口径，只是一个存 `prompt`（提示词，进 system），一个存 `template`（素材，进 user 消息），两张表互不引用。
- 契约：`ReactionTemplateConfig`（`src/core/types.ts:306`）、`ReactionTemplateStore`（`src/core/ports.ts:134`，`get` / `list` / `put` / `remove`）。

### 34.3 模板与占位符

白名单 `REACTION_TEMPLATE_VARS`（`src/core/chat/reaction-template.ts:7`）就是这 6 个，一个字都不能错：

| 占位符 | 展开成什么 | 删掉它会怎样 |
| --- | --- | --- |
| `{{最近对话}}` | 最近 20 条频道记录的转录，一行一条 | 看不到上下文，退回「只看这一句 + 我的回复」的旧口径 |
| `{{对方的消息}}` | 触发这一轮的用户原文 | 它不知道在回应什么 |
| `{{我的回复}}` | 主模型刚写的那句正文 | 它不知道要给哪句话配表情 |
| `{{自定义表情}}` | 该服自定义表情清单，自带 `【可用自定义表情】` 标题（`src/core/chat/reaction.ts:8`、`:100`），最多 40 个（`REACTION_MAX_CATALOG`，`src/core/chat/reaction.ts:6`） | 清单整段消失（标题一起没有）；这一轮没有清单时展开成空串 |
| `{{可贴表情的消息}}` | 当轮可贴的目标清单，自带 `【可贴表情的消息】` 标题（`src/core/chat/reaction.ts:11`、`:82`） | 不能指名贴，只剩触发那条 |
| `{{表情规则}}` | 贴表情提示词的正文（`reaction_guides` 那一份，§33） | 素材里不再重复一份规则（默认模板就没写它） |

内置默认模板全文（`DEFAULT_REACTION_TEMPLATE`，`src/core/chat/reaction-template.ts:14-27`，逐字）：

```text
【最近的对话】
{{最近对话}}

【对方的消息】
{{对方的消息}}

【我的回复】
{{我的回复}}

{{自定义表情}}

{{可贴表情的消息}}
```

- 与源码注释一致的两处理由：`{{自定义表情}}` / `{{可贴表情的消息}}` 展开时各自带标题，所以模板里不再手写这两个标题；`{{表情规则}}` 已经有一份在 system 里，默认模板不重复放进素材。
- 段落随便删：模板里没写某个占位符，那一段就整段不出现；写了但这一轮没有内容（没历史 / 没清单 / 没有可贴目标），展开成空串。

渲染规则（`renderReactionMaterial`，`src/core/chat/reaction-template.ts:50-58`）：

1. 占位符按 `{{名字}}` 逐个换掉，`values[名字]` 没有就换空串；名字长度限 1–40 字（`VAR_PATTERN`，`src/core/chat/reaction-template.ts:30`），超过的当未知变量。
2. 每行 `trimEnd()`：去掉行尾空白，不碰行首缩进。
3. 连续 **3 个以上**换行压成 2 个（`/\n{3,}/g` → `\n\n`）：空段展开成空串之后留下的只是相邻空行，压完不留空壳。
4. 整段 `trim()`。
5. 结果作为**唯一一条 user 消息**进请求（`src/core/chat/reaction.ts:143-147`）。

### 34.4 三层解析与命中

`resolveReactionTemplate(channel, guild, global)`（`src/core/chat/reaction-template.ts:72-84`）按顺位取第一个「有行且正文非空」的：

| 顺位 | 看什么 | 命中条件 |
| --- | --- | --- |
| 1 | `channel` 行 | 这行存在、且 `template.trim() !== ''` |
| 2 | `guild` 行 | 同上 |
| 3 | `global` 行 | 同上 |
| 兜底 | 三层都没有 | 返回 `DEFAULT_REACTION_TEMPLATE`，`scope` 记 `'global'` |

- **整份覆盖，不做逐段合并**：命中 channel 就用 channel 那一整份，global 的段落一句都不补；只想换掉一段，就把另几段原样抄进这一层。
- 某层存了正文但 `trim()` 为空 = 等于没配（读侧直接跳过）；写侧本来就不收空串（§34.5），正常路径上不会有这种行。
- 读侧每次贴表情现读三行（`src/core/chat/service.ts:760-772`），配完下一轮就生效，不用重启。
- 命中层跟着日志出去：`[chat] 表情选择 … guide=<层> template=<层>`（`src/core/chat/service.ts:686-695`）。`template=` 是素材模板命中的层，与提示词的 `guide=` 各算各的。

### 34.5 API

| 方法 | 路径 | 进 | 出 |
| --- | --- | --- | --- |
| `GET` | `/api/reaction-templates` | — | `{ items, default, vars }`：已配置的层、内置默认模板、6 个占位符名字（前端不再抄一遍） |
| `PUT` | `/api/reaction-templates` | `{ scope, scopeId?, template }` | 存好的那一行（`ReactionTemplateConfig`） |
| `DELETE` | `/api/reaction-templates` | `{ scope, scopeId }` | `{ ok: true }`，幂等（删不存在的行也 200） |

- 路由：`src/workers/http/app.ts:770`（GET）、`:776`（PUT）、`:805`（DELETE）。
- `scope = global` 时 `scopeId` 可省（恒存 `''`）；`guild` / `channel` 必须给非空 ID。
- **留空 = 删除这一层，只走 DELETE**：PUT 收到空正文不当「清空这一层」，直接 400（一个动作只有一种叫法）。

错误码：

| 错误码 | 状态 | 什么时候 |
| --- | --- | --- |
| `BAD_SCOPE` | 400 | `scope` 不在 `global` / `guild` / `channel` |
| `BAD_REQUEST` | 400 | 请求体不是 JSON 对象，或 `guild` / `channel` 的 `scopeId` 缺失 / 空串 |
| `BAD_REACTION_TEMPLATE` | 400 | `template` 不是字符串 / `trim()` 后为空 / 超过 8000 字 / **一个合法占位符都没有** |
| `UNKNOWN_TEMPLATE_VAR` | 400 | 写了 6 个之外的名字；响应体带 `vars` 列出具体哪几个 |

- 错误体与其它接口同一形状：`{ "error": "UNKNOWN_TEMPLATE_VAR", "vars": ["最近对话"] }`。
- 8000 字上界在 `src/workers/http/app.ts:86`（`MAX_REACTION_TEMPLATE_CHARS`），与提示词那份同值不同常量。
- 「至少要有一个合法占位符」：模板里全是死文字时表情模型没有任何可判断的素材，贴不出来；与其让它瞎贴，不如保存时就拒掉（`src/workers/http/app.ts:795`）。
- 未知变量一律拒：拼错的占位符会渲染成空串，模型以为那一段本来就没有内容（源码注释 `src/core/chat/reaction-template.ts:4-6`），比 400 更难查。

### 34.6 与 §33 提示词的关系

- 分工：**提示词进 system，素材模板进 user 消息**——`src/core/chat/reaction.ts:143-147` 里 `system: input.guide`、`messages: [{ role: 'user', content }]`，`content` 是渲染后的素材。
- 两份配置各自三层、各存一张表（`reaction_guides` / `reaction_templates`），互不引用：改提示词不动素材，改素材不动提示词。
- `{{表情规则}}` 是提示词正文的**一份拷贝**：填的值就是当轮命中的提示词（`guide.prompt`，`src/core/chat/service.ts:663`）。默认模板不写它，避免同一份规则在 system 与 user 里各出现一遍；想让它在素材里再念一遍才加。
- 主模型 system 里的那段【表情】块（§33.4）一个字没动：素材模板只影响表情模型那一次调用，主模型自己写的 `[[react:…]]` 不经过素材。

### 34.7 本版改动说明（`reaction-template-1`）

| 面 | 内容 |
| --- | --- |
| 新增文件与表 | `src/core/chat/reaction-template.ts`（`REACTION_TEMPLATE_VARS` + `DEFAULT_REACTION_TEMPLATE` + `collectReactionTemplateVars` + `renderReactionMaterial` + `resolveReactionTemplate`）、`migrations/0015_reaction_templates.sql`、表 `reaction_templates` 与仓储 `ReactionTemplateStore` |
| 改的读侧与日志 | `buildReactionRequest` 不再拼死四段，改按模板渲染（`src/core/chat/reaction.ts:118`、`:135-142`）；`src/core/chat/service.ts:760-772` 每次现读三层并解析；表情选择那行多一个 `template=<层>`（`src/core/chat/service.ts:694`） |
| 新增接口与后台 | `GET/PUT/DELETE /api/reaction-templates`（§34.5）；后台「表情」页多一节「表情素材模板」（层级选择 + 编辑器 + 已配置的层） |
| 门牌与没动 | 门牌 `reaction-guide-1` → **`reaction-template-1`**（`src/workers/gateway/engine.ts:129`）；提示词与它那张表（§33）、`[[react:…]]` 语法与解析边界、目标清单取数、三态开关与看图、主模型 system 的【表情】块、表情描述与别名，都没动 |

### 34.8 已知边界

- 20 条是硬上限（常量，不可配）：要它看更早的对话，只能让主模型把上下文写进正文。
- 三层整份覆盖：没有「只继承 global 的某几段」这种写法，改一段要抄整份。
- 模板里写了 `{{表情规则}}` 而提示词很长时，同一份规则会占两份 token（system 一份、user 一份）。
- 占位符名字必须逐字一致（全角中文也算）：写错保存就被 400 挡下；改名同理，旧模板里的写法不会自动跟着改。
- 素材里的历史是原文转录（与主对话注入同源），`{{最近对话}}` 会把这些内容一起发给表情模型。
- 模板只影响表情模型那一次调用；运维侧看素材对不对，只能靠 `template=<层>` 这行日志加上行为观察（§29.5）。

## 35. 选择性补记（`summary-backfill-1`；读序口径是 §35.7 那版的 `summary-order-2`）

一句话：后台「摘要」页多一对时间框——挑一段历史消息、点「补记」，让摘要模型把这**一段**压成一段新记忆**追加**到该频道累积记忆的尾部；**游标一动不动**，所以自动总结的进度、下一次触发的时机一条都不受影响。

### 35.1 为什么需要（失忆 / 漏记时人工挑段补，且不能搅乱自动进度）

- 累积记忆只吃**游标之后**的新对话（§31.2），而游标是单调前进的水位线：一旦某段原文落在游标后面却没被压进任何一段（当时阈值填得很大一批跨过去了、那段时间自动总结被关过、游标被手改大主动放弃过一段、或模型当时报错那批就此跳过），它就**永远**进不了记忆——取素材走的是 `loadAfter(key, cursor)`，条件只有 `id > cursor`。
- 过去唯一的补法是「调游标 + 重新总结」（§25.7 第 2 条）：改小把一段原文重新纳入待总结，改大主动放弃一段。代价是**动到了自动总结的记账**，而且入口是按 `messages.id` 走的，说不清「补 10-25 晚上那三个小时」。
- 后台手改正文（§25）是**整段替换**，只能改字、不能凭空补内容：模型没压过的原文，人得自己读一遍自己写。
- 补记要解的正是这一种：**按时间范围补一段，且不搅乱自动进度**。它按时间取素材（`loadBetween`）、按范围写段头（`appendSegment`），全程不碰 `coveredUntilId`（35.2）——在自动总结眼里，补过一记等于没发生过。

### 35.2 数据与游标语义

| 面 | 补记怎么走 | 为什么不这样不行 |
| --- | --- | --- |
| 取素材 | `ConversationStore.loadBetween`（契约在 `src/core/ports.ts`，D1 与 SQLite 实现在 `src/workers/db/d1-repository.ts`）：`created_at` 落在 `[from, to]` 里的消息，按 `created_at` 升序（同值 `id` 破平，§35.7） | 既有 `loadAfter` 只表达「`id > 游标`」；补记的输入是时间，不是水位线 |
| 压成一段 | 与自动总结同一条生成路径（同一套 `buildSummaryRequest` 素材拼装、同一条 channel > guild > global 路由与 fallbacks、非流式），一次调用产出**一段**正文 | 另起一套拼装 / 路由会让补出来的段与老段口径不一致，注入进上下文之后没法对账 |
| 落库 | `appendSegment(previous, segment, from, to)`（`src/core/chat/summary.ts`，§27.3、§31.2）：老段一个字不改，新段接在尾部、前面空一行 | 累积记忆只增不减（§31.1）；补记是「加一段」，不是「改一段」 |
| 段头 | 【记忆段】（覆盖 **这个范围自己的**首末时刻）——范围里最早 / 最晚一条消息的 `created_at`，不是「最新一条」，也不是总结发生的时刻 | 段头写的是「这段话是什么时候说的」（§27.1 口径：取用户发言的时间）。补记压的是另一段时间，写成「覆盖到最新」既骗人，也会让同一份记忆里几段的时间互相重叠 |
| `coveredUntilId` | **不动**：写库时把读到的原值原样写回 | 游标是自动总结的水位线，不是「一共总结过多少」的计数器。补记推进它 = 替自动总结记账：那批原文从此再没机会被自动总结，而且用户点一次补记就悄悄改了自动进度——补记的卖点本来就是不搅乱它 |
| `coveredFrom` / `coveredTo` | **不动** | 这两个字段说的是「自动总结现在覆盖到哪一段」（§27.2）：后台摘要页、行级段头兜底都读它。补记压的是别的时间段，写进去会让「覆盖范围」变成一句假话 |

- 于是库里会同时存在两种事实：某段时间的原文**既在游标之前（自动总结不会再吃）又在尾部多了一段补记**。这是设计意图，不是缺陷——补记本来就是给「游标已经走过去、但那段没被记住」补的。
- 注入侧不区分段是怎么来的：补记的段与自动总结的段长得一模一样（同样以 `【记忆段】` 开头），按字数预算从新到旧装（§31.3）。

### 35.3 两条路由与错误码表

| 方法 | 路径 | 入参 | 出 |
| --- | --- | --- | --- |
| `GET` | `/api/summaries/range` | query `guildId`、`channelId`、`from`、`to`（ISO 时刻） | `{ count, tooLarge, firstAt?, lastAt?, samples: string[] }` |
| `POST` | `/api/summaries/backfill` | body `{ guildId, channelId, from, to }` | `{ outcome: { summarizedMessages, from, to, summaryLength, model } }` |

- `GET` 是**预览**：只查库，不调模型、不写库。它回答页面四个问题——命中多少条（`count`）、超没超上限（`tooLarge`）、命中的首末时刻（`firstAt` / `lastAt`，一条都没有时这两个键不出现）、首尾几条长什么样（`samples`，给「这是不是我要补的那一段」做人工确认）。
- 预览**永远回 200**，范围太宽用 `tooLarge: true` 表示，不报 400：读端点不跟参数较劲（与 §25.4 同一口径）。`count` 最多报到 501——取素材时只多要一条（`BACKFILL_PROBE_LIMIT = SUMMARY_BATCH_SAFE_MAX + 1`），够判断超没超 500，不必把整段历史读进内存。`samples` 是首尾各最多 3 条、每行 `[YYYY-MM-DD HH:mm] 名字：正文前 40 字`（北京时间），只给人认段用，绝不进提示词。
- `POST` 是**真补**：调一次模型、追加一段。成功回的 `outcome.summarizedMessages` 是真正压进这一段的消息条数，`from` / `to` 回显**你填的**范围（原串，不归一化），`summaryLength` 是追加之后**整份记忆**的总字数（不是新段自己的长度），`model` 是真正出结果的模型——与 `SummaryOutcome` 同一个口径（§17.2）。段头写的是命中消息自己 `created_at` 的首末（35.2），所以与回显的 `from` / `to` 差几秒到几分钟是正常的。
- 两条都挂在 `ALL /api/*` 鉴权之后，与 §25.3 那五条同一条中间件；实现在 `src/workers/http/app.ts`，业务在 `src/core/chat/service.ts` 的 `ChatService.previewBackfill` / `ChatService.backfill`。
- 编号口径：`web/src/api.ts` 里按草案把它写作「§25.8」，本节落地在 **§35**（§25 本版没有新增小节），两处指同一件事。
- 成功的痕迹不在回包里就没了：Worker 打 `[chat] 补记完成 from=… to=… msgs=… len=…`，`runtime_logs` 里另有一行 `[chat] 补记完成 msgs=… len=… model=…`；`len` 是追加之后的总字数，与回包的 `summaryLength` 同值。

错误码（后端只回码、页面翻成中文，与 §25.4 同一套骨架）：

| 状态 | 码 | 什么时候 | 人怎么办 |
| --- | --- | --- | --- |
| 400 | `BAD_CHANNEL_KEY` | `guildId` / `channelId` 为空或不匹配 `/^\d{1,32}$/`（§25.4 同一口径）；`POST` 的 body 读不出来（空 body、坏 JSON）同出口 | 检查是不是粘进了空格、`#`、`<#…>`；频道 ID 是纯数字雪花号 |
| 400 | `BAD_TIME_RANGE` | `from` / `to` 缺失、不是合法时刻，或 `from > to` | 两个框都要填，起点不能晚于终点 |
| 400 | `RANGE_TOO_LARGE` | 命中条数超过一次上限，响应体带 `{ limit: 500 }` | 缩范围再点（35.4）：补记**不自动拆批** |
| 409 | `NO_SUMMARY_MATERIAL` | 这个范围里一条消息都没有（`count = 0`）；或这个部署没接摘要存储（`summaries` 未接线时 `backfill` 同样回 `null`） | 先点「查看命中」确认 `count`：0 条就换范围（时间口径见 35.6）；`count` 有值却还是 409，就是部署没接线，别反复重试 |
| 501 | `SUMMARY_UNAVAILABLE` | 部署里没注入 `previewBackfill` / `backfillSummary`（`GET` 与 `POST` 各自一条依赖，与 §25.5 同一条装配） | 确认跑的是最新部署，别在页面上反复重试 |
| 502 | `SUMMARY_FAILED` | 模型那一次调用失败，或模型回了一段空正文（核心层抛 `SUMMARY_EMPTY`），都带 `{ detail }` | `detail` 就是核心层抛出的异常消息原文（取法与截断口径同「重新总结」，见 operations §22.5 那张表），按它对号；`detail` 是 `SUMMARY_EMPTY` 时换时间段重试 |

- 失败一律**不落库**：抛错不写、空摘要也不写，重试就等于重来一次。
- 预览回答不了「模型好不好使」：`count` 有值但三层路由都没配时，要到 `POST` 才会在 502 的 `detail` 里看到 `NO_ROUTE_CONFIGURED`。

代码地图（都不是新文件，全是既有层的追加）：

| 位置 | 是什么 |
| --- | --- |
| `src/core/chat/service.ts` 的 `ChatService.previewBackfill` / `ChatService.backfill` | 两条业务入口：前者只读、后者真写 |
| `src/core/chat/service.ts` 的 `RangeTooLargeError` | 命中超上限时抛的错，HTTP 层翻成 400 `RANGE_TOO_LARGE` 并带 `limit` |
| `src/core/chat/service.ts` 的 `SUMMARY_BATCH_SAFE_MAX` | 500，一次上限（35.4） |
| `src/core/types.ts` 的 `TimeRange` / `BackfillPreview` / `BackfillOutcome` | 入参与回包的契约 |
| `src/core/ports.ts` 的 `ConversationStore.loadBetween` | 按时间取素材的仓储契约 |
| `src/workers/db/d1-repository.ts` | `loadBetween` 的 D1 / SQLite 实现 |
| `src/workers/http/app.ts` | `GET /api/summaries/range` 与 `POST /api/summaries/backfill` 两条路由 |

### 35.4 一次 500 条的上限与为什么复用 `SUMMARY_BATCH_SAFE_MAX`

- 上限是 **500 条**，常量就是自动总结那个单批硬上限 `SUMMARY_BATCH_SAFE_MAX`（`src/core/chat/service.ts`，源码注释原文：「单批素材硬上限：一次总结调用最多吃这么多条，避免阈值填大后一次请求把模型撑爆」）。
- **为什么复用而不是新开一个数字**：补记与自动总结是同一类调用——同一份素材拼装、同一条路由、同一个模型。500 是「一次非流式请求别把模型撑爆」这一个约束的数值，与入口是谁无关。分成两个数，早晚出现「自动总结一次吃 500、补记只能吃 300」这种没有理由的差异，而且调一个忘一个。
- **阈值不参与补记**：补记的上限只由 `SUMMARY_BATCH_SAFE_MAX` 决定——把频道阈值设成 20，补记也不会只能吃 20 条；阈值设成 2000，补记也不会跟着涨到 2000。500 与「阈值 0 时手动一次吃满 500」（§26.7 第 2 条）是同一个数。
- 超了**不自动拆批**：补记是人工挑段。3000 条拆 6 次会在尾部留 6 个段头、时间还挨着，之后没人能对账「哪几段是同一次补的」。正确做法是缩范围、分几次点，每次自己知道在补哪一段（重复补同一段的风险见 35.6）。

### 35.5 与自动总结 / 手动 `/summary` 的关系对照

| | 自动总结（`maybeSummarize`） | 手动 `/summary` 与后台「重新总结」 | 选择性补记 |
| --- | --- | --- | --- |
| 吃什么素材 | 游标之后最旧一批，≤ `min(500, max(50, 频道阈值))`（§26、§31.8） | 同一批（同一条 `summarizeCore`，§25.3 里那条 regenerate 路由） | 指定时间范围里命中的**全部**消息；> 500 直接拒，不截断也不分批 |
| 谁触发 | 未总结条数 ≥ 阈值时自己跑；阈值 0 = 关（§26.7 第 2 条） | 人点一次 | 人点一次 |
| `coveredUntilId` | **推进**到这批已落库消息的**最大 id**（不是时间末行的 id，§35.7） | **推进**（同一条代码路径） | **不动** |
| `coveredFrom` / `coveredTo` | 写成本批的首末时刻 | 同上 | **不动** |
| 段头时刻 | 这批消息 `created_at` 的首末 | 同上 | **这个范围自己的**首末 |
| 怎么落库 | `appendSegment` 追加到尾部，老段一个字不改 | 同上 | 同上 |
| 会不会重复 | 不会：游标推过去了 | 不会；但把游标改小之后重新总结会 | **会**：同一段补两次 = 尾部两段近似内容（35.6） |
| 影响自动进度 | 它就是自动进度本身 | 是（它也推游标） | **不影响**：补完仍按原游标跑 |

一句话记法：**自动总结与手动 `/summary` 是「往后记」，补记是「另外记」**——前者推进水位线，后者只在尾部加一段，水位线一动不动。

### 35.6 已知边界

- **时间序以 `created_at` 为准，`id` 只用于游标与破平**：`id` 是写入顺序，不是时间顺序——回灌历史消息会拿到比在线行更大的 id（§35.7）。任何「按时间读」的地方都必须显式写 `ORDER BY created_at`，别指望 id 序等于时间序。
- **时间按 `created_at` 文本比较**：`messages.created_at` 是 `toISOString()` 写进去的 UTC 文本（`2026-10-28T12:34:56.789Z`），区间判断是**字符串比较**。校验只要求 `Date.parse` 认得出来（`readTimeRange`），**原串照原样进 SQL 比较、不做归一化**，所以 `from` / `to` 必须同一口径（UTC、`Z` 结尾、位数一致）；写成带本地时区偏移（`2026-10-28T20:34:56+08:00`）或省掉 `Z`，比较会按字面错位，出现「明明有消息却 0 条」。
- **范围只在一个频道里生效**：`loadBetween` 查的是一个 `(guild_id, channel_id)`；要给几个频道补，得一个一个点。
- **同一段补两次会重复追加**：补记不记「这段补过没有」，第二次照样往尾部压一段，段头时间相同或几乎相同、内容近似。看到重复就顺手把正文改顺（保存是整段替换，§25.7 第 8 条），或者一开始只补一次。
- **补记不重算 `coveredFrom` / `coveredTo`**：后台摘要页显示的覆盖时间仍是自动总结的进度，不会因为补记扩张到补记的那一段。要按「记忆里到底有哪些时间段」对账，只能数段头（operations §22.7）。
- **补记不进自动总结的计数**：未总结条数仍按游标算，「补完这一段，离阈值就近了几条」不成立——这正是「不影响自动进度」的定义。
- **补记不检查原文是否已经在老段里**：模型也不知道那段是不是已经被记过，漏记与重记都要人来看。
- **预览与真补之间有时间差**：范围是时间不是 id 快照。`to` 填现在或将来时，两次点击之间新落库的消息会进第二次的素材，条数可能比预览时多，跨过 500 就变成 `RANGE_TOO_LARGE`。

### 35.7 时间序以 `created_at` 为准（门牌 `summary-order-2`）

- **事故形状**：`scripts/import-discord.mjs` 回灌历史消息时拿到的是**新的**自增 `id`（生产上 1935..2282），而它们的 `created_at` 比在线的 1934 更早。于是「id 正序 = 时间正序」这个从未写下来、却被五个读法默默依赖的前提当场失效：同一条消息按 id 排和按时间排会得到相反的顺序，`GET /api/summaries/range` 回的 `lastAt` 比库里真实最新时刻早了七个小时，生产读出来整段是倒序。
- **口径**：时间序一律由 `created_at` 决定，`id` 只用来破平（同一毫秒）与当游标（`loadAfter` 的 `id > ?`）。`created_at` 是定长 UTC 文本，字典序即时间序（35.6 第 2 条）。
- **五个读法的排序**（`src/workers/db/d1-repository.ts`）：`loadRecent` / `loadLatest` 是 `ORDER BY created_at DESC, id DESC LIMIT ?`，返回前 `reverse()`，调用方拿到的仍是升序；`loadAll` / `loadAfter` / `loadBetween` 是 `ORDER BY created_at ASC, id ASC`。**过滤条件一个字没改**——`loadAfter` 还是 `id > ?`，游标语义保留。
- **选取按 id、读序按时间**：`summarizeCore` 把两件事拆开了。**选区**落在游标域里——`pending`（`loadAfter`，已按 `created_at` 升序）再按 `id` 升序排一遍，取最老的 `limit` 条；**送给模型的顺序**才按 `created_at` 重排（`orderSummaryMaterial`），段头时刻取重排后的首末行。理由：游标是 `id` 水位线，只有按 id 连续地吃，推进之后才不会留下「id 比游标小、可这一轮又没被总结」的死角；而 id 序读出来是倒的，模型必须按说话的先后看这段对话。
- **游标取最大 id**：`coveredUntilId` 取这批**已落库**消息的最大 id（`chosen` 按 id 升序，即末条；空批回落成游标不动），不再是「时间末行的 id」。时间序下末行 id 完全可能小于同批其它行（回灌行 id 更大、时间更早），沿用末行就会让游标**往回走**：下一轮 `id > 游标` 把刚吃过的行又取一遍，同一批原文被重复总结、记忆里出现近似重复的段。`extra`（本轮这条还没落库的用户消息）不算进游标——推过去它就永远进不了下一次总结。
- **上一版留下的漏行已归零**：`summary-order-1` 的选区是「时间序前 `limit` 条」，可游标取这批的最大 id，于是 `id` 与时间不共序时最大 id 会越过同批里时间靠后、id 更小的那些行，它们从此再也进不了下一轮（生产主频道 `<ID-6>`：`covered_until_id=1675`、pending 605、阈值 500、时间序前 500 条最大 id = 2234，实测被永久跳过 **57** 行）。改成「选取按 id」之后这三轮演练里跳过 0 行，重复 0 条——不跳、不重。读端点的口径见 operations §22.4 的接口表。
- **门牌**：`'summary-order-2'`（`src/workers/gateway/engine.ts:129`）。看到 `build=summary-order-2` 才说明这一版在位；`build=summary-order-1` 是「时间序对了、但会跳过漏行」的那一版，`build=summary-backfill-1` 及更早的部署仍是旧读序。本节之后门牌又前进过（`'backup-ui-1'`，§36 → `'reply-error-1'` → `'reply-error-2'`，§37 → `'fake-stream-1'`，§29.6 → `'fake-stream-2'`，§38 → `'mention-1'`，§39 → `'mention-2'`，§39.2 → `'reply-continue-1'`，§40 → `'stream-edit-1'`，§29.7 → `'empty-note-1'`（`docs/operations.md` §14.2）→ `'none-head-1'`（`docs/operations.md` §28.6）→ `'vision-main-1'`（主对话模型也接图，§22.9）→ `'vision-main-2'`（后台的三层识图开关，§41）→ `'mention-once-2'`（同一个人一条回复只 @ 一次，§42）→ `'pg-errors-1'`（后台「故障」页看 PG 中继报错，§43）→ `'voice-1'`（语音回复：文字回复结束后可发一条 mp3 附件、三档三层开关，§44，前一版）→ `'voice-2'`（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7，门牌以 §33.9 为准。

## 36. 网页后台一键手动备份（`backup-ui-1`，2026-10-28）

后台「备份」页上点一下按钮，宿主上的 `backup-to-drive.sh` 就跑一轮备份。**备份逻辑仍然只有一份**：脚本本身、锁、保留策略、rclone 远端都没变，本节加的是「怎么把一次点击递到宿主的脚本手里，再把结果递回页面」。容器里没有 systemd 也没有 rclone，所以真正驱动的是宿主上的 `dc-ai-bot-backup-request.timer`，两个进程之间只靠 `/data` 下的一对 JSON 文件通信。

### 36.1 契约与文件

两个文件都落在宿主 `/opt/dc-ai-bot/data`（容器内 `/data`，即 `docker-compose.yml` 里 bot 的 `./data:/data` 挂载）。后台只写请求文件，脚本只写状态文件，没有共享内存、没有回调、没有队列。

| 文件 | 谁写 | 谁读 | 语义 |
| --- | --- | --- | --- |
| `backup-request.json` | 后台（`POST /api/backup/run`） | `backup-to-drive.sh --if-requested` | 「请跑一轮」的凭据，脚本取走即删 |
| `backup-status.json` | `backup-to-drive.sh` | 后台（`GET /api/backup`） | 最近一轮的阶段与结果 |

请求文件：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 32 位 hex，一次点击一个，脚本原样回写进状态文件 |
| `requestedAt` | string | 点击时刻，ISO 8601 带 `Z` |

状态文件分三种阶段，共用一套键：

```json
{"phase":"running","id":"<id 或空串>","source":"manual|daily","startedAt":"<ISO Z>"}
{"phase":"done","id":"...","source":"manual|daily","startedAt":"...","finishedAt":"<ISO Z>","file":"dc-ai-bot-20261028T130737Z.tar.gz","bytes":247873,"keptRemote":3,"remote":"gdrive:dc-ai-bot-backup"}
{"phase":"failed", ...同上..., "error":"<单行人类可读原因>"}
```

- **不写 `null`**：用不上的键整键省略（`running` 没有 `finishedAt`，`done` 没有 `error`）。
- **原子写**：同目录临时文件 + `mv -f`，读侧任何时刻看到的都是一份完整 JSON。
- **状态写失败不影响备份成败**：`data/` 不可写时脚本只多打一行提示，退出码仍由备份本身决定——不会把一轮成功的备份记成 `failed`，也不会因为状态文件写不了就中断上传。
- `source` 由「抢到锁时请求文件在不在」决定：在就是 `manual`、不在就是 `daily`；每日定时那条路自己不写请求文件，所以恒为 `daily` 且 `id` 是空串。
- `id` 读不出来（请求文件被写成非 JSON）时按空串处理，这一轮照样跑——请求文件已经被消费掉，不能把它变成「永远重试」。
- **前置检查失败也消费请求**：root/rclone/sqlite3/DB/`rclone.conf` 缺件时脚本 `exit 2`，但同样会 `rm -f` 请求文件并写 `failed`（带请求的 `id` 与 `source=manual`，`error` 是「环境缺件：…」）。否则 timer 每分钟重试一次、后台永远拿 `409`，页面看到的却一直是上一轮的 `failed`。

### 36.2 两条 HTTP 接口与错误码

两条都挂在 admin 会话校验之下（与其它 `/api/*` 管理接口同一条前置校验），也都要求宿主注入了 `BackupStore`（`src/workers/http/app.ts:119` 的 `deps.backup`）。

| 接口 | 成功 | 错误 |
| --- | --- | --- |
| `GET /api/backup`（`src/workers/http/app.ts:1050`） | `200 {"request":{…}\|null,"status":{…}\|null}`：两个字段各自可以是 `null` | 无业务错误码；文件缺失或内容是坏形状时该字段回 `null`，**绝不 500** |
| `POST /api/backup/run`（`src/workers/http/app.ts:1059`） | `200 {"ok":true,"request":{"id":"…","requestedAt":"…"}}` | `409 {"error":"BACKUP_BUSY"}`（已有一份未处理的请求）/ `501 {"error":"BACKUP_UNAVAILABLE"}`（宿主没接线） |

- `501 BACKUP_UNAVAILABLE` 是**依赖未接线**的形状：`deps.backup` 为空。Cloudflare Workers 没有文件系统，那边不挂 `BackupStore`，所以同一个构建部署到 Workers 上，这条路是明确关掉的，而不是报 500 或静默成功。
- `409 BACKUP_BUSY` 只挡「还没被宿主消费」的窗口：脚本抢到锁后会立刻 `rm -f` 请求文件，之后（这一轮正在跑）再点就又是一份新请求，页面应该看 `status.phase` 而不是靠 409 判断进度。
- `200` 里的 `request` 是刚写进去的那一份（`id` 由后台生成），页面拿它跟之后的 `status.id` 对照，就知道看到的结果是不是自己点的那一次。

### 36.3 触发链路与延迟

```text
[页面按钮] --POST /api/backup/run--> /opt/dc-ai-bot/data/backup-request.json
                                          |
              dc-ai-bot-backup-request.timer（OnUnitActiveSec=60s）
                                          v
      dc-ai-bot-backup-request.service → backup-to-drive.sh --if-requested
                                          |
                    /opt/dc-ai-bot/data/backup-status.json（running → done/failed）
                                          v
[页面] --GET /api/backup--> {"request":…,"status":…}
```

- **没有请求文件时这一分钟什么也不做**：`--if-requested` 在任何前置检查之前先看 `REQUEST_FILE`，不存在就 `exit 0` 且不打印任何东西——每分钟一次、一天 1440 次，journal 里不会因此多出 1440 行。
- **最坏延迟 ≈ 60s + 一轮备份耗时**：timer 是 `OnUnitActiveSec=60s`（开机 `OnBootSec=2min` 起第一次），点下去最迟一分钟被捡到；随后就是 §17.3 那一轮的时长（打包 + 上传 + 校验）。
- **与每日常规备份互斥**：两者跑的是同一个脚本、同一把 `/var/lock/dc-ai-bot-backup.lock`。正赶上每日那轮在跑，请求那轮打一行「上一轮备份还在跑本轮跳过」就退出，请求文件**不删**，下一分钟再来。
- **超时**：单元是 `TimeoutStartSec=30min`，超了 systemd 会把它记为失败。此时状态文件可能停在 `running`——页面上一轮 `running` 超过半小时没变化，就去 `journalctl -u dc-ai-bot-backup-request.service` 看（排错顺序见 `docs/hosting.md` §17.5 最后一行）。

### 36.4 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/core/types.ts:348` / `:354` / `:357` / `:371` | `BackupRequest` / `BackupPhase`（`'running'\|'done'\|'failed'`）/ `BackupStatus`（可选字段用 `?`）/ `BackupSnapshot`（`request` 与 `status` 各自可为 `null`） |
| `src/core/ports.ts:159` | `interface BackupStore`：`read()` 取快照、`request()` 落一份请求 |
| `src/node/backup-files.ts:122` | `createFileBackupStore({ dir })`：Node 宿主的实现，两个 JSON 就在这个目录里 |
| `src/node/main.ts:203` | 接线：`backup: createFileBackupStore({ dir: backupDir(env.dbPath) })`（`backupDir` 把 `…/data/dc-ai-bot.sqlite3` 归到 `…/data`） |
| `src/workers/http/app.ts:119` / `:1050` / `:1059` | `deps.backup` 注入点；`GET /api/backup`；`POST /api/backup/run` |
| `web/src/api.ts:1314` / `:1321` | 前端两条调用；页面在 `web/src/pages/BackupPage.tsx` |
| `scripts/backup-to-drive.sh` | 唯一的备份逻辑：`STATE_DIR` / `REQUEST_FILE` / `STATUS_FILE` 三个可覆盖变量、`--if-requested` 参数、`status_write` / `status_running` / `status_done` / `status_failed` 与 `trap on_exit EXIT` |
| `scripts/dc-ai-bot-backup-request.service` / `.timer` | 宿主每分钟看一眼请求文件的单元（与每日那对单元分开，因为日常那对要跑无参数的一轮） |
| `docs/hosting.md` §17.6 / §17.7 | 装单元、跑一遍、排错与两份文件的契约表（运维视角） |

## 37. 流里的错误帧与空回复（`reply-error-2`，2026-10-28）

一句话：供应商在 SSE 流里报错时，三个适配器会把那一帧当成「没有正文」跳过，回合循环再把这轮零字回复记成成功——线上于是出现一条「（模型没有返回内容）」，日志却是 `回复成功 … len=0`。本节把两件事写进契约：**载荷里的 `error` 一律变成异常**，**零字正文一律不算成功**；`reply-error-2` 再补一条：零字不等于立刻换候选模型，同一个候选模型要先就地试满 3 次（37.2）。

### 37.1 问题与现象

- **现象**：Discord 频道里 bot 回了一条空回复（客户端显示占位串「（模型没有返回内容）」），同一时刻 `runtime_logs` 里是 `[chat] 回复成功 model=<供应商>/<模型> … len=0`。
- **真实的失败形状**：中继（`pg-relay`）先把 `200` 与 `text/event-stream` 头发出去，错误发生在**流里**——它发一行 `data: {"error":{"code":"executor_timeout","message":"执行器超时","detail":…}}`，紧接着一行 `data: [DONE]`。HTTP 状态码全程是 `200`。
- **错误帧为什么被吞**：三个适配器的 SSE 解析只问「这一帧有没有正文」（`choices[0].delta.content` / `content_block_delta` / `candidates[0].content.parts[].text`），不问有没有 `error`。错误帧里当然没有正文 → 被当成一次空 delta 跳过；`[DONE]` 一到，流正常结束、`chatStream` 正常返回。对上层来说，这跟「模型想了半天什么也没说」一模一样。
- **零字为什么被记成成功**：`run()` 拿到空正文后照旧走「剥指令 → 落库 → 打成功日志 → 返回」那条路。整条链上没有任何一处认为零字是失败，所以既没换同供应商下一把 Key，也没走路由的 `fallbacks`，用户拿到的就是一条空回复。
- **代价**：这类失败在监控上完全隐形——错误日志一条没有，只有一条 `len=0` 的成功记录；真故障要等人肉眼发现。

### 37.2 契约（两条，缺一条这个 bug 就还在）

| 层 | 规则 |
| --- | --- |
| 适配器：`openai-compat` / `gemini` / `anthropic` | 流式**与**非流式路径上，只要响应载荷带 `error` 字段就**抛异常**，不许当空帧跳过；anthropic 另有一种形状 `{"type":"error","error":{…}}`，同样抛 |
| 回合循环：`ChatService.run` | 流结束但累加出来的正文是空白（`raw.trim() === ''`）→ 抛 `EMPTY_RESPONSE`，**先在同一个候选模型上再试**：最多 `EMPTY_REPLY_ATTEMPTS`（3）次尝试（首次 + 2 次重试，重试之间不等待），任一次拿到正文即成功；三次全空才按「该候选模型失败」处理、换路由里的下一个候选模型；所有候选都空才抛 `ALL_PROVIDERS_FAILED` |

- **异常消息的固定形状**：`<适配器名>: <code>: <message>`，例如 `openai-compat: executor_timeout: 执行器超时`（`gemini: 429: …`、`anthropic: overloaded_error: …` 同理，anthropic 的 code 取 `error.type`）。中继自己的错误码与说明原样留在异常消息里（`message` 截到 200 字，免得异常串被整段错误体拖长）——`attempts`、`ALL_PROVIDERS_FAILED` 的 JSON 与后台上看到的错误文本都带这段原文，一眼能看出是谁报的错。
- **非流式也必须抛**：`summarize`、手动 `/summary`、后台「重新总结」、补记、表情模型走的都是非流式那一次调用，吃的是同一份错误体。只在流式路径上抛，等于把同一类故障搬到另一个入口复现，而且那条路上报出来的会是「模型回了空摘要」这种更误导的说法。
- **`EMPTY_RESPONSE` 的语义**：「这个候选模型、这一把 Key 这一次没有产出可用正文」，与网络错误、429、超时同级——**不是**「模型选择不说话」这种合法结果。
- **重试次数与节奏**：同一个候选模型最多试 `EMPTY_REPLY_ATTEMPTS`（3）次——首次 + 2 次重试，**重试之间不等待**（不 sleep、不退避）；三次都空才把这个候选模型记为失败、换路由里的下一个候选模型；中间任一次拿到正文就是成功。其它失败（网络 / HTTP / 超时 / 错误帧）**不进入**这套空回重试、也**不消耗**空回次数——它们照 §20.5 换同一供应商的下一把 Key。每次空回重试留一条 `emit('warn','chat',…)`，形如 `空回复重试 2/3 model=openai-compat/gemini-4-argon key=<label>`。
- **`attempts` 里仍只记一条 `EMPTY_RESPONSE`**：三次都空之后，这个候选模型在 `attempts`（以及 `ALL_PROVIDERS_FAILED` 的 JSON）里仍然只是**一条**记录——重试过程只落在上面那几条 `空回复重试 n/3 …` 的 warn 日志上，失败清单的形状没变。
- **只有 raw 全空才算失败**：判据是 `raw.trim() === ''`，`raw` 是流里累加出来的原始正文（含 `[[react:…]]` 与开头那个假时刻）。
- **只有 `[[react:…]]` 被剥空仍是成功**：模型只写了一句 `[[react:👍]]` 时，剥掉指令后可见文本是空、但 `raw` 非空，这一轮照旧算成功——贴表情本来就是它这轮唯一的产出。这条边界是**故意留的**，别顺手把「只贴表情」判成失败。
- 已经产出可见文本之后再出事，仍按 §20.5 的流式铁律走（37.3），不会因为本节新增的检查去改写已经发出去的那条消息。

### 37.3 与 §20.5「流式铁律」的关系

- §20.5 定的是**换 Key 的时机**：只有在首个 chunk 之前失败才换下一把 Key；一旦已经产出可见文本就停止换 Key、把该候选模型计为失败——否则同一条消息会被从头重写一遍（用户会看到文字跳变）。
- 本节不新开规则，只是把两类以前没人认领的失败**塞进 §20.5 已有的判定**：
  - 错误帧现在会让 `chatStream` 抛出。抛出发生在 `for await` 内，落在「首个 chunk 之前还是之后」由「已经吐出多少字」自然决定，不需要另加条件。
  - `EMPTY_RESPONSE` 在流**正常结束**之后才判，那时 `raw` 必然全空，等于一个字都没出去，正好落在「可以换下一把 Key」那一侧。
- **已产出可见文本后又收到错误帧**的实际行为：`onProgress` 已经推过文字 → 抛错 → `catch` 里 `stripStamp(visibleText(raw)).trim() !== ''` 成立 → `break`，**停止换 Key** → 该候选模型记失败（`attempts` 里是那条 `openai-compat: …` 的原文）→ 继续下一个候选模型（路由的 `fallbacks` 照旧会试）。已经 PATCH 出去的文字不会再改：用户最多看到一句没写完的话，而不是被从头重写。
- **错误帧出现在第一个字之前**（中继超时最常见的形状）：行为与「连接直接失败」完全一样——换同供应商下一把 Key，再换 fallback 候选；全部失败才是 `ALL_PROVIDERS_FAILED`。
- 一句话记法：**§20.5 管「什么时候换」，§37 管「什么算失败」**。前者一个字没改，后者把「静默的零字」和「藏在 200 里的错误帧」补进了失败的清单。

### 37.4 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/core/providers/sse.ts` 的 `upstreamErrorOf` / `parseSse` | 三个适配器共用的一份 SSE 解析与错误帧提取：`upstreamErrorOf(node)` 认出载荷里的 `error` 并拼成 `code: message`（Gemini 的 code 是数字、Anthropic 只有 `error.type`、message 截到 200 字），没有 `error` 才回 `null`；`parseSse` 按 `data:` 行吐帧、`[DONE]` 结束流 |
| `src/core/providers/openai-compat.ts` 的 `createOpenAiCompatProvider`（`chatStream` 与 `chat`） | 每帧先过 `upstreamErrorOf`，非空就抛 `<适配器>: <code>: <message>` |
| `src/core/providers/gemini.ts` 的 `createGeminiProvider` | 同上；Gemini 的错误体也是 `{"error":{…}}`（`error.code` 是 HTTP 码数字 / `error.message`） |
| `src/core/providers/anthropic.ts` 的 `createAnthropicProvider` | 同上，另加 `{"type":"error","error":{…}}` 这一种形状（只有 `error.type` 可用，code 就取它） |
| `src/core/chat/service.ts` 的 `run()` | 候选模型 × 同供应商 Key 的双层循环（§20.5）；流结束处 `if (raw.trim() === '') throw new Error('EMPTY_RESPONSE');`；失败归集与 `ALL_PROVIDERS_FAILED: <json>` 的形状不变 |
| `src/core/chat/service.ts` 的 `EMPTY_REPLY_ATTEMPTS` 常量 | 空回复时同一个候选模型的尝试上限，值是 `3`（首次 + 2 次重试）；`run()` 的重试循环与 `空回复重试 n/3 …` 那条日志都读这个常量，改重试次数只改这里 |
| `src/core/chat/service.ts` 的 `run()` 里那段空回重试循环 | 捕获 `EMPTY_RESPONSE` → 还没到 `EMPTY_REPLY_ATTEMPTS` 就**立刻**再跑一次同一个候选模型（重试之间不等待），每次重试发一条 `emit('warn','chat',…)`；到上限才把这个候选模型记失败、继续下一个候选模型。其它异常不走这段循环，仍按 §20.5 换同供应商下一把 Key，也不消耗空回次数 |
| `src/core/chat/service.ts` 的 `run()` 里那个 `break`（注释标着「流式铁律（§20.5）」） | 已产出可见文本就不再换 Key，本节依赖它（37.3） |
| `src/core/chat/service.ts` 里那条 `回复成功 … len=` | `len` 是**落库正文字数**（`text.length`，已剥掉 `[[react:…]]` 与假时刻）；这条日志只此一处，网关不重复记（`src/workers/gateway/engine.ts` 那条注释写着「回复成功/失败由 ChatService 记」） |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD`：§37 这一版是 `'reply-error-2'`，门牌见 §33.9 与 §47（`'voice-log-1'` 那一版：语音发出后补一条 `[voice] 已发送 …` 成功日志，只记标签 / 字节数 / 字数 / mode（`director-4` 起 `rejected=` 之后还会带 judge 那一行的完整一行、不截断），正文绝不整段进日志，gateway 路径落 `runtime_logs`（level=info、scope=gateway），§44.3、§47.7；前一版 `'tts-nolimit-1'` 是朗读不再按字数截断那版：朗读正文与后台试听都不再截、judge 输出上限提到 4000（§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是 assistant 正文开头的标签 + 正文逐字校验；再更早的 `'tts-style-1'` 是朗读语气三层（channel / guild / global）+ 可选情绪判断模型、模型不再可写、按接口类型取内置默认（`tts-1` / `mimo-v2.5-tts`），迁移 `0024`（迁移总数 24）；`'tts-mimo-1'` 记在 §46.7，接口类型（dialect）——迁移 `0023`（迁移总数 23）；前一版 `'tts-admin-1'`，§46 的 TTS 接口搬进后台——后台「语音」页配地址 / Key / 模型 / 默认音色、加密入库只回掩码、`VOICE_TTS_*` 那一版起不生效、每条消息现读一次；再前一版 `'prompt-scope-1'`，§45 的内置默认与身份块可编辑；`voice-2` 是 §44.1 那一版（再前一版，按指令模式提示段）；`voice-1` 是 §44 那一版（更早，文字回复结束后可发一条语音附件、三档三层开关）；`pg-errors-1` 是 §43 那一版（再前一版）；`mention-once-2` 是 §42 那一版（前一版）；`vision-main-2` 是后台的三层识图开关那一版（§41，前一版）；`vision-main-1` 是主对话模型也接图那一版（§22.9，前一版）；`none-head-1` 是回复正文首行 `NONE` 剥掉那一版（`docs/operations.md` §28.6，前一版）；`empty-note-1` 是只 @ 不说话那一版（`docs/operations.md` §14.2，前一版），`stream-edit-1` 是边说边编辑那一版（§29.7），`reply-continue-1` 是续写那一版（§40），`mention-2` 是 @ 前缀预算那一版，`mention-1` 是 §39 那一版、`fake-stream-2` 是 §38 那一版，都是历史）：`[gateway] alarm build=reply-tool-3` 或 `[node] listening … build=reply-tool-3` 出现，才说明这一版在位（§13、§30.1） |
| `docs/operations.md` §31 | 同一件事的运维视角：怎么用 `/pg/healthz` 的 `requestsFailed`、`len=0` 与 `ALL_PROVIDERS_FAILED … EMPTY_RESPONSE` 三处证据定位 |

## 38. 假流式的三层开关（`fake-stream-2`，2026-10-29）

一句话：§29.6 的假流式以前把「挤几片」写死在代码里（`REVEAL_MAX_STEPS` = 6），现在这一个数字搬进库里，按 **频道 > 服务器 > 全局** 三层解析、**0 = 关闭**、**默认 6**，后台新增一页「回复」改它，改完下一条消息就用新值（不改代码、不重启）。

### 38.1 为什么要可配

- 同一段「挤包」在不同频道里的价值完全不同：安静的小群里文字慢慢长出来像在真打字；几百人的大群里，为第二片再等 8 秒的成本比「一下子蹦出全文」高得多。
- 上一版把片数 6、间隔 1200ms、「还差不到 24 字不动画」三档都写死在 `src/workers/discord/editor.ts` 的常量里（§29.6），要改只能改代码再发一次版——可这件事每个频道的主人自己就能判断，不该由一次发版来定。
- 所以只把**片数**这一个数字开放出来（`0..10`，0 = 关闭）：片数是观感的唯一旋钮，间隔与「差不到 24 字不动画」仍留在代码里（§29.6 一个字没改）。

### 38.2 契约

表 `reply_settings`（`migrations/0017_reply_settings.sql`）：

| 列 | 类型与约束 | 说明 |
| --- | --- | --- |
| `scope` | TEXT NOT NULL，`CHECK (scope IN ('global', 'guild', 'channel'))` | 这一行配在哪一层 |
| `scope_id` | TEXT NOT NULL DEFAULT `''` | 服务器 / 频道 ID；global 层恒为 `''` |
| `reveal_steps` | INTEGER NOT NULL | 片数，合法值 0..10 |
| `updated_at` | TEXT NOT NULL | 写入时刻 |

主键 `(scope, scope_id)`：一层只有一行，写就是覆盖。形状与 §26 的 `channel_memory_settings`、§33 的 `reaction_guides` 同源（三层 + 空串代表 global）。

- `reveal_steps` 故意**不加** `CHECK`：越界值由读侧当「这一层没配置」处理，将来放宽 0..10 这个上限不必再写一条迁移。
- 0017 只做加法：只 `CREATE TABLE IF NOT EXISTS reply_settings`，不碰任何已有表，能直接跑在线上库上（`docs/hosting.md` §8）。

取值规则：

| 项 | 规则 |
| --- | --- |
| 优先级 | `channel` → `guild` → `global`，**第一个合法的赢**；三层都没有（或都不合法）用默认 |
| 默认 | `DEFAULT_REVEAL_STEPS` = 6，与 §29.6 那一版写死的值相同，所以升级后观感不变 |
| 合法范围 | `REVEAL_STEPS_MIN` = 0、`REVEAL_STEPS_MAX` = 10，且必须是整数 |
| 0 的含义 | **合法值**，等于关掉假流式：`finish` 直接一次发全文（`steps <= 0` 分支），不挤、不多花时间 |
| 越界当没配 | 行里的 `reveal_steps` 不是 0..10 的整数（手工改库、旧数据）就算这层没配，继续往下一层找——不报错、不夹逼成边界值 |
| 每条消息读一次 | 每轮回复开流前解析一次（`engine.ts` / `handler.ts` 各一处），**不带缓存**：改完下一条消息就生效，不用重启、不用等缓存过期 |
| 读失败回默认 | 逐层 `get` 抛错就当「这层没配」继续；三层全抛就是默认 6——**读配置失败绝不挡住回复** |

- 私聊或拿不到服务器 ID 时只查 `channel` 与 `global`（跳过 `guild` 层）。
- 这个开关只管假流式的片数：落库、回复链、贴表情、摘要、错误处理全部按最终文本走（§18 / §28 / §37），一个字没动。§39 起的 `<@提问者id> ` 前缀是发送层的事，与片数无关——片数只决定挤几次，0 片（关掉假流式）时前缀照样在。

### 38.3 三条路由与错误码

列数与 §11 表头一致（方法 / 路径 / 请求 / 响应）：

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/reply-settings` | — | 200 `{items:[{scope,scopeId,revealSteps,updatedAt}],default,min,max}`（`default`=6、`min`=0、`max`=10，前端不抄常量） |
| PUT | `/api/reply-settings` | `{scope,scopeId?,revealSteps}` | 200 回写后的那一行；400 `{error:'BAD_SCOPE'}` / 400 `{error:'BAD_REQUEST'}`（guild / channel 层的 `scopeId` 缺失或为空）/ 400 `{error:'BAD_REVEAL_STEPS'}` |
| DELETE | `/api/reply-settings` | `{scope,scopeId?}` | 200 `{ok:true}`（删掉这一层，回落到上一层） |

| 错误码 | 什么时候 | 说明 |
| --- | --- | --- |
| `BAD_SCOPE` | `scope` 不是 `global` / `guild` / `channel` | 与 §26.4、§33.7 同一个口径 |
| `BAD_REVEAL_STEPS` | `revealSteps` 不是 0..10 的整数 | `0` 是合法值；缺字段、字符串 `"6"`、`11`、`-1`、小数都拒（判据只有 `isRevealSteps`，不能用真假值判，否则「关掉」会被当成没填） |
| `BAD_REQUEST` | `guild` / `channel` 层的 `scopeId` 缺失或为空 | 与 §11 其它带 scope 的路由同一口径；global 层不传 `scopeId`（恒为 `""`） |

- 三条路由都挂在 `ALL /api/*` 的会话鉴权之后：没 Cookie 先 401，与 §11 其它路由一致。
- GET 只列**原始行、不合并**：页面上要一眼看出「这层到底存了什么」，命中哪一层由服务端按 §38.2 算；越界的行（`reveal_steps` 不在 0..10）连列表里都不出现——读侧当它没配。
- DELETE 只删这一层那一行、不级联：频道层删掉就回落到服务器层 / 全局层。

### 38.4 与 §29.6 的关系

- §29.6 讲**机制**：整段到手后怎么切片、每片多长、间隔多少、预算怎么扣、真流式那条路为什么一个字没改。那些规则一个字没改。
- §38 只讲**取值从哪来**：写死的 6 变成 `resolveRevealSteps` 的一次解析结果；`intervalMs`(1200ms)、`REVEAL_MIN_GAIN_CHARS`(24)、`STREAM_MAX_EDITS`(20) 仍留在代码里（§29.3、§29.6）。
- 两者的接口是 `createProgressiveEditor` 的新选项 `revealSteps?`：不传按 6（= 旧行为），传 0 就直接一次发全文，传 n 就把 §29.6 的 `REVEAL_MAX_STEPS` 换 n 用。
- 所以「关掉假流式」不是一个新分支去盖掉老逻辑，而是把片数设成 0 后走 §29.6 本来就有的 `steps <= 0` 分支——没有第二条「一次发全文」的路。

### 38.5 代码地图

| 位置 | 作用 |
| --- | --- |
| `migrations/0017_reply_settings.sql` | 建 `reply_settings`（§38.2 的四列 + 主键） |
| `src/core/chat/reply-view.ts` 的 `DEFAULT_REVEAL_STEPS` / `REVEAL_STEPS_MIN` / `REVEAL_STEPS_MAX` | `6` / `0` / `10`：默认值与合法区间的唯一出处 |
| `src/core/chat/reply-view.ts` 的 `isRevealSteps()` | 判一个值是不是 0..10 的整数；仓储读数与解析都读它 |
| `src/core/chat/reply-view.ts` 的 `resolveRevealSteps(rows, key)` | 纯函数：`channel` → `guild` → `global` 第一个合法的赢，都没有回默认；空的层（私聊没有 `guildId`、`channelId` 为空）由内部的 `scopeChain` / `layerExists` 直接跳过，不拿空串去匹配 |
| `src/core/chat/reply-view.ts` 的 `readRevealSteps(store, key)` | 逐层 `get`、命中即停；任何一层抛错都当「这层没配」继续（`catch { continue }`），三层全抛回默认 |
| `src/core/ports.ts` 的 `ReplySettingsStore` | `get` / `list` / `put` / `remove` 四个方法（`remove` 就是 DELETE 那条路由） |
| `src/workers/db/d1-repository.ts` 的 `replySettings` | D1 实现：`get` / `list` 都过一遍 `toRevealStepsConfig`——行里的 `scope` 不认识或 `reveal_steps` 不是 0..10 的整数就返回 `null`（列表里直接丢掉），等于这层没配；`put` 是 `ON CONFLICT (scope, scope_id) DO UPDATE` 的整份覆盖，`remove` 命中 0 行也算成功 |
| `src/workers/http/app.ts` | §38.3 那三条路由（`GET` / `PUT` / `DELETE`），校验与错误码都在这里 |
| `src/workers/discord/editor.ts` 的 `createProgressiveEditor` | 新增选项 `revealSteps?`：不传按 `REVEAL_MAX_STEPS`(6)，传 0 走 `steps <= 0` 分支直接发全文（§29.6 的机制不变） |
| `src/workers/gateway/engine.ts` | @ 路径：每条消息开流前 `readRevealSteps` 解析一次，把结果作为 `revealSteps` 传给编辑器 |
| `src/workers/discord/handler.ts` | 斜杠路径：同样解析一次再传；私聊或拿不到服务器时只查 `channel` + `global` |
| `web/src/pages/ReplyPage.tsx` | 后台「回复」页（标签排在「备份」之后）：选层级、填 `scopeId`、填 0..10、保存 / 删除 |

此后门牌又前进过若干次（`'mention-1'`，§39 → `'mention-2'`，§39.2 → `'reply-continue-1'`，§40 → `'stream-edit-1'`，§29.7 → `'empty-note-1'`（`docs/operations.md` §14.2）→ `'none-head-1'`（`docs/operations.md` §28.6）→ `'vision-main-1'`（主对话模型也接图，§22.9）→ `'vision-main-2'`（后台的三层识图开关，§41）→ `'mention-once-2'`（同一个人一条回复只 @ 一次，§42）→ `'pg-errors-1'`（后台「故障」页看 PG 中继报错，§43）→ `'voice-1'`（语音回复：文字回复结束后可发一条 mp3 附件、三档三层开关，§44，前一版）→ `'voice-2'`（按指令模式补上语音提示段：提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1，再前一版）→ **`'prompt-scope-1'`**（内置默认与身份块改成三层可配：`prompt_defaults` 两个 key × 三层（`fallback` 内置默认 / `identity` 身份块），解析顺序三层提示词 → 三层内置默认 → 代码常量，三层都没配时输出与上一版逐字相同，「恢复默认」只删所在那一层，§45，前一版）→ **`'tts-admin-1'`**（TTS 接口搬进后台：语音合成接口的地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、Key 用 AES-256-GCM 加密入库、接口只回掩码、编辑留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次配置、改完下一条就生效；后台新开独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听，迁移 `0022`（迁移总数 22），§46，更早的几版）→ **`preset-head-1`**（当时：预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）→ **`identity-head-1`**（前一版：身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）→ **`preset-4`**（再前一版，阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）→ **`preset-3`**（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）→ **`preset-2`**（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）→ **`preset-1`**（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）→ **`'director-6'`**（更早一版，只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ **`'director-5'`**（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）→ **`'director-4'`**（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）
→ **`'director-3'`**（导演模式的判断超时改成按字数给预算：15 秒起步（`JUDGE_TIMEOUT_FLOOR_MS = 15_000`）+ 每字 40 毫秒（`JUDGE_TIMEOUT_PER_CHAR_MS = 40`）、封顶 45 秒（`JUDGE_TIMEOUT_CAP_MS = 45_000`），即 `judgeTimeoutMs(chars)`；前一版是固定 8 秒——实测 148 字那条真实回复 judge 要 8.1 秒才回、被 8 秒整条掐断，`director=1` 于是在真机上和 `0` 档长得一模一样（都退回原文 + 提示词当标签）而 rejected 还是 `null`；退回原因多一种 `judge`（判断模型没给出可用的一行：没配 judge、超时、非 2xx、JSON 坏、抛异常），导演模式 1 / 2 档返回 `{ ...fallback, directorRejected: 'judge' }`、`0` 档兜底一字未变且不带这个字段，试听响应 `directorRejected` 因此是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一，成功日志退回时多出 `rejected=judge`；没有新迁移（仍是 `0025_director_mode.sql`、总数 25）、没有新接口与新开关，试听契约不变（可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`），§44.3、§47.8、§25.16，；**前一版** `'director-2'` 是导演模式可观测性补丁（judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在响应 `choices[0].message.audio.data`，没有 `speed` 参数）；老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7，门牌以 §33.9 为准。

## 39. 回复里的 @ 人（`mention-2`）

### 39.1 为什么

- 之前两条 Discord 发送路的 `allowed_mentions` 口径是反的。@ 路径在 `src/workers/gateway/channel-rest.ts` 的 `messageBody` 里一律塞 `parse: []`——正文里就算写了 `<@id>`，Discord 也只当纯文本，不亮、不通知；而斜杠命令那条路（`src/workers/discord/rest.ts` 的 `createInitialResponse` / `editOriginalMessage`）压根不带 `allowed_mentions`，等于交给 Discord 的默认值去全解析，`@everyone` / `@here` / `<@&角色id>` 都会真的响。于是同一个机器人：正常回复里 @ 谁都没反应，斜杠那条路反而有误炸风险。
- 这一版把两条路收成同一个口径（`{ parse: ['users'] }`），并且让服务器频道里的回复自动在正文前 @ 提问者：她被叫到时先点明叫的是谁，观感也从「一段无名发言」变成「在回答你」。
- 门牌 `GATEWAY_BUILD` 在这一节前进到 `'mention-1'`（上一版 `'fake-stream-2'`，§38），本版再前进到 `'mention-2'`（`mention-1` 是前一版；门牌的唯一出处仍是 §33.9，§39.2 记 `mention-2` 这一版的预算修法；§40 起门牌再前进到 `'reply-continue-1'`，§29.7 起再前进到 `'stream-edit-1'`，`docs/operations.md` §14.2 起再前进到 `'empty-note-1'`，§28.6 起再前进到 `'none-head-1'`，§22.9 起再前进到 `'vision-main-1'`，§41 起再前进到 `'vision-main-2'`，§42 起再前进到 `'mention-once-2'`，§43 起再前进到 `'pg-errors-1'`，§44 起再前进到 `'voice-1'`，§44.1 起再前进到 `'voice-2'`，§45 起再前进到 `'prompt-scope-1'`，§46 起是 `'tts-admin-1'`，§46.7 起再前进到 `'tts-mimo-1'`）。
- 这一版没有新表、没有新迁移：迁移仍是 17 个（`0001`…`0017`，`0017` 是上一版 §38 的 `reply_settings`）。

### 39.2 契约

- `allowed_mentions` 统一成 `{ parse: ['users'] }`：两处 Discord 发送的 body 都这么写。放开解析**用户**提及（`<@id>` 与 `<@!id>` 两种写法都算），也只放开用户：
  - `@everyone` / `@here` 仍不解析；
  - 角色提及 `<@&角色id>` 仍不解析。

  这是一条安全边界：她发出去的正文可能来自用户输入，也可能是模型自己发挥，角色提及能把一整群安静的人叫起来、`@everyone` 更是一键全员，而用户提及最多叫醒一个具体的人。要放开得改这两处代码，现在没有开关。
- 自动前缀：**服务器频道里**的回复，正文前加 `<@提问者id> `（末尾一个空格）；`提问者id` 就是触发这条回复的那条消息的 `author.id`。

| 场景 | 加不加 `<@提问者id> ` |
| --- | --- |
| 服务器频道里的聊天回复（首条 / 每次流式编辑 / 收尾全文） | 加 |
| 私聊 | 不加 |
| 斜杠 / 上下文菜单触发的聊天回复（`/chat`） | 加（服务器频道才加，私聊不加） |
| 命令输出：`/model` `/persona` `/reset` `/summary` `/help`、未知命令提示，含 /总结、/记忆这类补跑结果与命令自己的错误提示 | 不加 |

- 正文超长、被 `chunkMessage` 拆出来的续段**不带**前缀——一条回复只点一次名。
- **正文里同一个人重复出现**（模型自己写的第二处、第三处 `<@id>`）怎么处理见 §42：计数把本节这个自动前缀也算作那一次，所以同一个人一条回复里只会 ping 一次。
- 前缀贯穿这条回复的**每一次写**：首条、每一次流式编辑、收尾时补的全文都带前缀，不会出现「头一条有、后面掉」的观感。做法是每一次发送 / 编辑前都过一遍 `withMention`，而不是只在开头拼一次。
- 长度预算：**@ 前缀和截断提示都先从正文预算里扣**，再拼前缀。以前只扣前缀，回复正文一旦打满上限，`<@提问者> ` 这一串就把正文尾巴连同截断提示一起挤掉——读者看到「正文少了一截、也没有 `…(已截断)`」，比明说截断更坏。前缀有多长取决于提问者的 id：真实 snowflake 是 19 位数字，`mentionPrefix` 产出 `<@`（2）+ 19 + `>`（1）+ 空格（1）= 23 个字符。
  - 斜杠路径：先算 `reserve = mention.length + TRUNCATION_SUFFIX.length`（`TRUNCATION_SUFFIX = '…(已截断)'`，6 个字符，`src/workers/discord/editor.ts:20`；私聊没前缀时 `reserve` 是 0），交给编辑器的 `maxChars` 是 `Math.max(0, runtime.limits.maxChars - reserve)`，于是 **1900 = P（前缀）+ (1900 - P - 6)（正文）+ 6（后缀）**，`P` 就是前缀长度——真实 snowflake 下 P = 23，即 **1900 = 23 + 1871 + 6**。这里的 1900 是 `DEFAULT_MAX_CHARS = 1900`（`src/workers/discord/handler.ts:52`），离 `DISCORD_MESSAGE_LIMIT = 2000` 仍留余量，截断提示这回一定看得见。
  - @ 路径：切段上限按 `MESSAGE_CHUNK_LIMIT - P` 算（1900 在网关这边就是 `MESSAGE_CHUNK_LIMIT`，`src/workers/gateway/message.ts:73`），**1900 = P + (1900 - P)**，真实值 **1900 = 23 + 1877**（这条路没有截断提示）；首段因此不再被编辑器二次切片——那正是丢字的根源；续段接着首段往下接，彼此不重不漏，续段本身不带前缀，所以能用满 1900。
  - 顺序仍然不能反：先算预算、再拼前缀。先拼后截会把 `<@123…>` 从中间切掉，剩下的半截 id 既不亮、还可能被当文字发出去。

### 39.3 两条路径分别怎么落地

- 纯函数单独一层：新增 `src/workers/discord/mention.ts`，只有两个函数，不碰任何 IO。
  - `mentionPrefix(userId)`：拿去拼前缀，产出 `<@提问者id> `。
  - `withMention(content, prefix, maxChars)`：预算算法就落在这一处——先按 `maxChars - prefix.length` 截正文，再把前缀接在前面——它只保证「前缀不把正文顶超上限」，截断提示那一份预算由调用点先扣（见 §39.2）。
- @ 路径（`src/workers/gateway/engine.ts` 的 `#handleMessage`）：私聊（`message.guildId ?? ''` 为空）时前缀留空，服务器频道里取 `mentionPrefix(message.author.id)`；随后首条 `channel.createMessage`、编辑器每次 `channel.editMessage`、收尾 `channel.sendMessage` 都用 `withMention` 包一遍。`allowed_mentions` 在 `channel-rest.ts` 的 `messageBody` 里改成 `{ parse: ['users'] }`——`sendMessage` / `createMessage` / `editMessage` 都过这个工厂，一处改就够。
- 斜杠路径（`src/workers/discord/handler.ts:336` 的 `runChat`，斜杠 / 上下文菜单触发的聊天回复）：**同样拼前缀**——`mention = (interaction.guild_id ?? '') === '' ? '' : mentionPrefix(asker?.id ?? '')`（`asker` 取 `interaction.member?.user ?? interaction.user`），编辑器构造时的 `maxChars` 是 `Math.max(0, runtime.limits.maxChars - reserve)`（`reserve = mention.length + TRUNCATION_SUFFIX.length`，私聊为 0）——前缀与截断提示都先从正文预算里扣掉（算式与真实数值见 §39.2），`send` 仍把正文交给 `withMention(content, mention, runtime.limits.maxChars)`，收尾 `editor.finish` 同一条路，两段合起来正好一条 1900，所以「私聊不加、服务器频道加」与 @ 路径同一口径。唯一例外在 catch 里：故障提示先把 `mention` 清成空串再 `editor.finish(describeChatError(error))`——那不是聊天回复，不点名。命令输出不加前缀：`/model` `/persona` `/reset` `/help` 与 `/总结` `/记忆` 的结果走 `clampForDiscord` + `rest.editOriginalMessage`（`handler.ts:442`），全程不碰 `withMention`。`rest.ts` 里 `createInitialResponse` / `editOriginalMessage` 的 body 另补上 `allowed_mentions: { parse: ['users'] }`，与 @ 路径对齐。

### 39.4 与 §29.6、§38 的关系

- 前缀**不参与切片**：§29.6 / §38 的切片规则、片数、间隔、`REVEAL_MIN_GAIN_CHARS` 一个字没改。前缀在切片之外——切片按正文算，前缀只在「这一次要发出去的字符串」落到发送口之前拼上去；唯一动的是**可用预算**：@ 路径的切段上限按 `MESSAGE_CHUNK_LIMIT - 前缀长度`（1900 - P，真实 snowflake 下 1900 - 23 = 1877）算，首段因此不再被二次切片、续段接着往下接（§39.2）。
- 因此流式的每一次编辑都带前缀：第 1 片、第 2 片……收尾全文全都带，观感不会中途掉。片数设成 0（关掉假流式，§38）时一次发全文，前缀照样在。
- 与 §37 的重试 / 零字兜底也不冲突：那些解决的是「最终文本是什么」，前缀解决的是「最终文本发出去时怎么拼」。斜杠路径里的聊天回复同样拼前缀（见 §39.3），只有命令输出不拼，那些输出的截断规则仍按 §29.6 的 `clampForDiscord`。

### 39.5 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/workers/discord/mention.ts` | 新增：`mentionPrefix(userId)` / `withMention(content, prefix, maxChars)`——前缀拼接与预算的唯一出处 |
| `src/workers/gateway/channel-rest.ts` 的 `messageBody` | `allowed_mentions` 从 `{ parse: [] }` 改成 `{ parse: ['users'] }`；`sendMessage` / `createMessage` / `editMessage` 共用这一处 |
| `src/workers/discord/rest.ts` 的 `createInitialResponse` / `editOriginalMessage` | 显式补上 `allowed_mentions: { parse: ['users'] }`，与 @ 路径对齐（以前不带，等于让 Discord 全解析） |
| `src/workers/gateway/engine.ts` 的 `#handleMessage` | 服务器频道里取 `mentionPrefix(message.author.id)`、私聊留空；首条 / 每次编辑 / 收尾都过 `withMention`；`chunkMessage` 拆出的续段是裸的 `channel.sendMessage(message.channelId, chunk)`，**不过** `withMention`（一条回复只点一次名）；切段上限按 `MESSAGE_CHUNK_LIMIT - 前缀长度` 算，首段不再被编辑器二次切片（§39.2） |
| `src/workers/discord/editor.ts` 的 `clampForDiscord` | 截断函数本身不变，仍在编辑器里按 `maxChars` 截（`deliver` / `reveal`）；`withMention` **不调**它，自己用 `content.slice(0, maxChars - prefix.length)` 按剩余预算截正文。本版改动只在调用点：斜杠路径给的 `maxChars` 是 `Math.max(0, runtime.limits.maxChars - (mention.length + TRUNCATION_SUFFIX.length))`，截断后连后缀一起算正好一条 1900，`…(已截断)` 因此一定看得见（§39.2） |
| `src/workers/discord/handler.ts` | `runChat`（斜杠 / 上下文菜单的聊天回复）：服务器频道取 `mentionPrefix(asker?.id ?? '')`、私聊留空，`send` 与 `editor.finish` 都过 `withMention`，只有 catch 的故障提示把 `mention` 清成空串；`/总结`、`/记忆` 与其它命令输出仍走 `clampForDiscord` + `rest.editOriginalMessage`，不拼前缀 |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD` 前进到 `'mention-2'`（上一版 `'mention-1'`；§40 起再前进到 `'reply-continue-1'`，见 §40.5；§29.7 起再前进到 `'stream-edit-1'`；§28.6 起再前进到 `'empty-note-1'` → `'none-head-1'`，§22.9 起再前进到 `'vision-main-1'`，§41 起再前进到 `'vision-main-2'`，§42 起再前进到 `'mention-once-2'`，§43 起再前进到 `'pg-errors-1'`）：`[gateway] alarm build=mention-2` / `[node] listening … build=mention-2` 是那一版的示例，现值见 §29.5 与 §33.9 的 `build=reply-tool-3` |

- 本版没有新表、没有新迁移：迁移仍是 17 个，`0017` 是 §38 的 `reply_settings`。
- 本版没有新路由、没有新配置项：管理 API 与后台页面一个字没动（§11 不受影响）。

## 40. 被掐断的半句自动续上（`reply-continue-1`）

### 40.1 症状与判据

- 线上那条证据：`runtime_logs` 第 256 行是 `回复成功 model=openai-compat/gemini-4-argon history=1000 of=2000 dropped=1000 ms=5913 len=21 guide=global key=pg` ——同一行既写着「回复成功」，`len=21` 又只是个零头；对应 `messages` 表 `id=2455` 的正文停在「哼，笨蛋 小明！你自己刚才明明就已经手动」，句尾没有标点、也没有任何截断提示，就那样落库、那样发进了频道。同批正常回复都是写满一整段的，唯独这一条停在一个词中间：模型那边的流被掐断了，回合循环却把它当成了「模型说完了」。
- 所以判据必须**双信号**，先看协议层、再用文本层兜底：
  - **协议层**：这次流到底是怎么结束的。中继正常收尾是收到 `finish_reason` 为 "stop"、再加一条 `data: [DONE]`；异常时可能什么都不发就断（连结束原因帧都没收到），也可能收到 `length` / `MAX_TOKENS` 这类非正常收尾。前一种是「上游连承认没写完的机会都没有」，后一种是「上游自己承认了没写完」——两种都算截断。
  - **文本层兜底**：协议层什么都没说清、但正文的最后一个码点停在一个不该停的地方。去掉空白后长度 ≥ 12，并且末个码点落在字母 / 数字 / 汉字 / 假名 / 谚文上，就是「停在词中间」：一个说完了的句子不会正好断在这里。
- 为什么不能只看标点：标点是文风的函数，不是完整性的函数。一条完整的回复可以以颜文字、表情、代码块、URL 甚至空行收尾，句尾一个标点都没有；而被掐断的地方又常常正好落在一个 `，` 上——那是模型自己就会写出来的字符，不是「话没说完」的证据。只看标点两头都会错：把完整回复判成截断，白多一次请求；把截断判成完整，那条 `len=21` 的回复就是这么留下去的。双信号之后再叠一层 `[END]` 自撤（§40.2），误判就只剩代价、没有后果。

### 40.2 续写

- 消息形状：把这一轮**已经写出来的正文**原样当作 assistant 前缀接在原来的请求后面喂回去，让模型接着往下说；这一轮请求的末尾多一条固定的 user 指令，要求它「不要重复已写内容、不要开场白、直接从半个字接着写；如果上面那段其实已经写完整了，就只回 `[END]`」。
- 每块都推：续写请求与第一段走的是同一条流式路径——模型每吐出一块就立刻推一次、改的还是同一条 Discord 消息（§29.7）。续写不再「整段收完才刷一次」：用户不会先看到那句话停住、过几秒再突然补上一大段，而是从被掐断的那个字继续往下长。
- `[END]` 自撤：收到 `[END]`（或空回复）就当判据误判，**保留原样**，一个字都不改。这是整个机制的安全阀——判据再保守也会有误判，但误判的结果只是多问了一次模型，绝不会把一条本来完整的回复改坏。
- 上限：最多续 2 次；合并后的累计长度上限 3000 字，到顶就不再续。
- 续写请求自己失败只记一条 `warn`（`chat` 来源），这条回复仍按「成功」记、已经写出来的正文不变。续写是补救不是主路：补不上就照原样结束，不能因为一次补救失败，把一条本来已经给出了半句的回复变成「生成失败」。
- 落库与日志：合并后的完整正文**只存一条消息**（`messages` 表一行，不是每段一行）；成功日志在真的发生过续写时多一个字段 `cont=<次数>`（值是这一轮实际续写的次数），没续写时这个字段根本不出现——老日志的读法与告警正则一个字都不用改。

### 40.3 呈现

- 续上来的新内容接在**同一条 Discord 消息**里：既有的渐进编辑继续改这条消息（§29.2 / §29.3），而且**每一块都推**（§29.7）——用户看到的是那句话从被掐断处接着往下长，不会多出一条「续」，也不会先留一段空档再突然补上一大段。
- 超过单条上限时，仍由既有切段逻辑溢出到后续消息（`MESSAGE_CHUNK_LIMIT`，§39.2），续段照旧是纯正文。
- 续段**不带** `@` 前缀：一条回复只点一次名（§39.2）——前缀是「我在回你」的标记，不是分段标记。
- 两条路径都生效：服务器频道里的 `@` 路径（`src/workers/gateway/engine.ts`）与斜杠 `/chat`（`src/workers/discord/handler.ts`）最终都走 `src/core/chat/service.ts` 的 `runChat` 模型调用循环，判据与续写都在这一层，所以两条路一次改到位；差别只在发送侧——`@` 路径走网关的渐进编辑器 + `chunkMessage`，斜杠路径走 `createProgressiveEditor` 的 `send`（§29.3 / §29.6）。

### 40.4 与 §29.6 / §38 / §39 的关系

- 切片与假流式规则**一个字没改**：续写发生在「最终正文」被交出去之前，合并完的整段才是编辑器与切片看到的那份文本。§29.6 的分片算法、§38 的三层开关（频道 > 服务器 > 全局）与间隔、预算全部照旧——续写只改变「要发的那段文本有多长」，不改变文本怎么被发出去。
- `@` 前缀预算不变（§39.2）：前缀仍按提问者 id 现算、仍只拼一次，续段不拼；正文预算仍然是「上限减前缀、再减截断提示」那套算法。
- 与 §37 的分工：§37 管「这段正文算不算成功」（错误帧、零字正文、重试），本节管「这段正文是不是说完了」。顺序固定：先按 §37 判定这条候选模型成功，成功了才看 §40.1 的判据、才可能续写。

### 40.5 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/core/chat/truncation.ts` | 新增：截断判据与续写用料的纯函数（文本层兜底判据、`[END]` 的识别、那段固定指令的文案、片段合并），不碰任何 IO |
| `src/core/providers/openai-compat.ts` | 流式与非流式都要把「这次是怎么结束的」透出来（`finish_reason`；`data: [DONE]` 有没有收到）——协议层信号的第一手来源 |
| `src/core/providers/gemini.ts` | 同上；Gemini 的结束原因是它自己那一族（`MAX_TOKENS` 这类非正常收尾就是从这里进来的） |
| `src/core/providers/anthropic.ts` | 同上（`stop_reason` 一族）；三家形状在适配器里就地翻译成同一套，回合循环只认一套 |
| `src/core/types.ts` | 类型契约：结束原因与续写次数从这里出形状，适配器与回合循环只认这一份 |
| `src/core/chat/service.ts` 的 `runChat` | 判据 → 续写 → 合并 → 打 `cont=` 全在这条回合循环里；续写请求失败只 `warn`，不影响这条回复成功 |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD` 在 §40 这版前进到 `'reply-continue-1'`（上一版 `'mention-2'`；§29.7 起再前进到 `'stream-edit-1'`，`docs/operations.md` §14.2 起再前进到 `'empty-note-1'`，§28.6 起再前进到 `'none-head-1'`，§22.9 起再前进到 `'vision-main-1'`，§41 起再前进到 `'vision-main-2'`，§42 起再前进到 `'mention-once-2'`，§43 起再前进到 `'pg-errors-1'`）：`[gateway] alarm build=reply-continue-1` / `[node] listening … build=reply-continue-1` 出现才说明这版在位 |

- 本版没有新表、没有新迁移：迁移仍是 17 个，`0017` 是 §38 的 `reply_settings`。
- 本版没有新路由、没有新配置项：管理 API 与后台页面一个字没动（§11 不受影响）——续写次数与合并上限是常量，不是开关。


## 41. 主模型识图的后台三层开关（`vision-main-2`）

门牌前进到 `vision-main-2`，加的是「主对话模型看不看图」的后台开关（新迁移 `0018`）。§22 讲谁能看图与取图链路，§38 讲假流式的片数，本节只讲这个开关，三者不混写。

### 41.1 开关语义与三层解析顺序

开关按三层存，解析顺序固定：**channel > guild > global，第一个合法值赢**。私聊没有频道层，只有服务器层与全局层。

| 层 | `scope_id` | 说明 |
| --- | --- | --- |
| `global` | 空串 | 全局兜底层 |
| `guild` | 服务器 ID | 单个服务器 |
| `channel` | 频道 ID | 单个频道，最优先；私聊没有这一层 |

「没配置」有两种形态，读侧一视同仁：这一层根本没有行，或这一层有行但 `enabled` 不是合法布尔。遇到就跳过、继续看下一层：

| 情况 | 结果 |
| --- | --- |
| 三层都没有这一行 | 开（默认值，`DEFAULT_VISION_ENABLED = true`） |
| 某层 `enabled` 不是合法布尔 | 当这一层没配置，继续下一层 |
| 读这一层失败（存储读不出来） | 当这一层没配置，继续下一层 |
| 三层全都读失败 | 开（默认值） |

默认开意味着升级本身不改变行为：什么都没配时与 `vision-main-1` 逐字相同。每条消息读一次配置、不缓存，后台改完下一条消息就生效，不用重启。

### 41.2 关掉之后到底发生了什么

关掉的是「主对话模型这一侧要不要图」，不是「这一轮有没有图」：

- **主对话请求不带图**：首段请求里没有图的 part，请求形状与「这一轮本来就没图」逐字相同（不是带个空数组、留个空字段）。
- **表情模型照旧能看这一轮的图**：开关只管主对话模型（`TurnContext.mainImages`），表情请求那一侧不受影响。这条也是现场分辨两种故障的抓手 —— 表情那一侧同样看不到图时，问题在收集/中继链路（§22），不在这个开关。
- **关掉不增加图片下载次数**：一轮里图片仍然只下一份（§22.9 的 turn 级 memo，真有人要才下载）。关掉后主对话这一侧不去要，表情模型也没启用时这一轮一次都不下载。
- **照常回文字**：关掉只是不给图，回复照常生成、照常发。
- **读开关失败不让回复失败**：任何一层读失败都当「这一层没配置」继续，三层全失败用默认值（开）——取图链路上的配置读取失败绝不向上冒泡成回复失败。

### 41.3 存储与接口

新迁移 `migrations/0018_vision_settings.sql`，迁移总数因此从 17 变 18。表只有四列，主键 `(scope, scope_id)`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `TEXT NOT NULL` | 只允许 `global` / `guild` / `channel`，带 CHECK |
| `scope_id` | `TEXT NOT NULL DEFAULT ''` | 全局层是空串 |
| `enabled` | `INTEGER NOT NULL` | 真 / 假的整数表示；**故意不加 CHECK**，越界值由读侧当「这一层没配置」 |
| `updated_at` | `TEXT NOT NULL` | 写入时间 |

三条后台路由（§11 有同一份表）：

| 方法 | 路径 | 请求 body | 成功响应 |
| --- | --- | --- | --- |
| GET | `/api/vision-settings` | — | `{items:[{scope,scopeId,enabled,updatedAt}],default:true}`；只列原始行、不合并三层，`default` 恒为 `true` |
| PUT | `/api/vision-settings` | `{scope,scopeId?,enabled}` | 回写后的那一行 |
| DELETE | `/api/vision-settings` | `{scope,scopeId?}` | 只删这一层那一行、不级联；删掉就回落到下一层 |

`items` 只列库里真实存在的行：`enabled` 不是合法布尔值的脏值在仓储转换时就被丢掉，不会出现在 `items` 里；页面按「这一层没配置」处理，继续往下层兜（口径同 §41.1）。

三个错误码，全部是 `400`：

| `error` | 触发条件 |
| --- | --- |
| `BAD_SCOPE` | `scope` 不是 `global` / `guild` / `channel` |
| `BAD_REQUEST` | `guild` / `channel` 层没给 `scopeId`（缺失或空串） |
| `BAD_ENABLED` | `enabled` 不是布尔（字符串 `"true"` 这种不算） |

### 41.4 与 §22 / §38 的关系

- **§22** 讲的是「谁能看图 + 取图链路」：`vision-main-1` 让主对话模型也接这一轮的图，落地的是取图与装配（turn 级 memo、首段与表情请求、续写不带图）。本节不改变那条链路任何一步，只在主对话那一侧加一道「要不要」。
- **§38** 讲假流式的片数（`reveal_steps`），与本节是同一个后台「回复」页上的两张卡片：第一张是片数，第二张就是这个识图开关。两套开关的三层结构、三条路由、错误码风格一致，但表不同（`reply_settings` 与 `vision_settings`），互不影响。
- 一句话对照：§22 决定「图从哪里来、谁能看到」，§38 决定「回复分几片」，§41 决定「主对话模型这一侧要不要图」。

### 41.5 代码地图

| 位置 | 作用 |
| --- | --- |
| `migrations/0018_vision_settings.sql` | 建 `vision_settings` 表 |
| `src/core/chat/vision-view.ts` | `DEFAULT_VISION_ENABLED` / `isVisionEnabled` / `resolveVisionEnabled`（三层解析，第一个合法值赢）/ `readVisionEnabled`（逐层读，任何一层读失败都当这层没配置，全失败回默认值） |
| `src/workers/db/d1-repository.ts` | `visionSettings` 存储（读 / 写 / 删一行） |
| `src/workers/http/app.ts` | 三条 `/api/vision-settings` 路由与三个错误码 |
| `src/workers/gateway/engine.ts` | 每条消息读一次开关，按结果决定主对话请求带不带图 |
| `src/core/types.ts` | `TurnContext.mainImages`（主对话模型这一侧的图片入口） |
| `src/core/chat/service.ts` | 取图判断（关掉就不给主对话那一侧装配图） |
| `web/src/pages/ReplyPage.tsx` | 后台的「回复」页第二张卡片（第一张是 §38 的片数） |

- 本版没有新配置项、没有新环境变量：开关只活在后台与其存储里。
- 门牌本体仍在 `src/workers/gateway/engine.ts` 的 `GATEWAY_BUILD`，`test/gateway.node.test.ts` 里有断言；§33.9 记这枚门牌的演进链。

## 42. 同一个人一条回复只 @ 一次（`mention-once-2`）

门牌前进到 `mention-once-2`，改的是「一条回复里同一个人被 @ 了好几次」`mention-once-1` 立了这套规矩，`mention-once-2` 把名字来源从注入窗口扩到整个频道历史：自动加在正文开头的 `<@提问者id> ` 前缀算那一次，正文里再写 `<@同一个id>` 就不再 ping，换成显示名。§39 讲前缀与 `allowed_mentions` 的口径，§18.3 讲记忆行的形状，§29.7 讲边说边编辑，本节只讲重复提及这一件事，几者不混写。

### 42.1 语义

- **一个人、一条回复、只 ping 一次。** 计数按「每条回复」算一次：同一个 id 在这一轮里出现多处，只有第一处是 `<@id>`，之后一律是名字。
- **自动前缀也算那一次。** 服务器频道里正文前自动加的 `<@提问者id> ` 就是这一次（§39.2）；回答里再写 `<@提问者id>` 时，那一处会被换成显示名——同一个人不会因为「前缀一次 + 正文一次」被 ping 好几回。
- **跨多条 Discord 消息也一样。** 正文超长被拆成续段、流式每块进度改写同一条消息，都不重置计数：第一条消息点过名，后面那些段里同一人就只是名字（§39.2 的续段本来也不带前缀）。
- **之后写昵称或绰号。** 被 @ 过的人在正文里再出现时，写聊天记录里的**显示名**；模型也可以写昵称、绰号、简称——这是提示词在教的那条规则（§42.2），代码不做词表替换。
- **私聊不加这条规则块，也不去重。** 私聊本来就没有自动前缀（§39.2），没有「只 @ 一次」这件事：正文原样发出。

### 42.2 实现

- **纯函数一层**：`src/core/chat/mention-dedupe.ts`，不碰 IO、不碰 Discord、不碰数据库；对外三个函数，加一条共用的标签正则：
  - `MENTION_TAG_RE`（`mention-dedupe.ts:8`）：`/<@!?(\d{15,20})>/g`——`<@id>` 与昵称形态 `<@!id>` 指向同一个人，算同一次；id 只认 15~20 位数字，正文里凑巧长得像标签的短数字不算提及，一个字不动。
  - `buildMentionNames(messages)`（`mention-dedupe.ts:23`）：把这一轮读出来的行收成一张 `id → 显示名` 的表，只收 `role='user'` 且名字与 id 都非空的行（assistant 行是我们自己，@ 它没有对象），同一个人出现多次时取最近那个名字（他会改昵称）。名字就是 §18.3 记忆行里那个显示名，落库来自 `messages` 表的 `author_name`（`docs/operations.md` §12）。
  - `dedupeMentions(text, { alreadyPinged, names })`（`mention-dedupe.ts:106`）：按出现顺序扫正文，同一个 id 只保留**第一处**，后面那些换成 `names` 里的显示名；`names` 里没有这个 id 时**整段去掉标签**，并把标签两侧的空格一起收掉（中文与标点两侧不留空格，纯 ASCII 两侧留一个）——不留下裸的 `@`、也不留下半截 id。
  - `renderMentionRule()`（`mention-dedupe.ts:121`）：system 里那条规则块的正文本体，教她 @ 过之后同一个人再出现时直接写昵称或绰号；代码那一步只是兜底。
- **「开头前缀算那一次」怎么实现**：`alreadyPinged` 是种子——服务器频道里它就是提问者的 id（`const mentionSeed = ctx.guildId !== '' && ctx.userId !== '' ? [ctx.userId] : []`，`service.ts:988`），所以正文里写 `<@提问者id>` 时这个人已经在种子里，那一处就被换成显示名；私聊种子为空。
- **服务层一处封装、三处调用**（`src/core/chat/service.ts`）：`mentionSafe(text)`（`service.ts:1026-1027`）＝私聊原样返回、服务器频道过一遍 `dedupeMentions`。三处调用是**首段每块进度**（`service.ts:1102`）、**续写每块进度**（`service.ts:1138`）、**最终正文**（`service.ts:1163`；剥完指令、剥完时间戳、剥完正文首行 `NONE` 之后）。进度侧每块都拿**全量累积文本**再算一次，所以跨块、跨续段都不重置计数；用户看到的与落库的一字不差。
- **名字表从哪来**：`buildMentionNames([...history, turnUser])`（`service.ts:1024-1025`）——`history` 是这个频道的**全部历史**（`conversations.loadAll`，`service.ts:1000`），不只注入窗口那 50 条，所以很久没说话、早被挤出窗口的人同样换得出名字；同一个人出现多次取**最近**那个名字（他会改昵称），最后一次覆盖前面。`mention-once-2` 就是这一刀：`mention-once-1` 那版只拿 `tail.kept`，窗口外的人查不到名字、标签被整段删掉。查不到名字的 id 仍不硬编一个名字，「没名字就整段去掉」那条分支接手。
- **规则块在 system 里的位置**：`promptParts.after` 之后、表情规则块 `renderReactionGuide(...)` 之前（`service.ts:994-996`），且只有服务器频道加（`mentionSeed.length === 0 ? '' : renderMentionRule()`，`service.ts:989`）。
- **异常不外抛**：`dedupeMentions` 整个包在 try/catch 里，出错就原样返回——这一层只负责少 @ 一次，绝不能因此毁掉一整轮回复。

### 42.3 与既有口径的关系

- **只动正文，不动前缀**：去重与名字替换只作用于回复正文（含拆出来的每一条 Discord 消息的正文），开头那个自动 @ 前缀的位置与条数一个字没改，`allowed_mentions` 仍是 `{ parse: ['users'] }`（§39.2）——本节没有放宽也没有收紧。
- **§39 的前缀照旧**：仍然只加在第一条消息上、续段不带（§39.2「一条回复只点一次名」）；本节管的是**正文自己写的**那些 `<@id>`，两者合起来才是「同一个人只 ping 一次」。
- **`@everyone` / `@here` / `@角色` 照旧不解析**（§39.2 的安全边界）：本节只处理用户提及，角色提及仍由那一条边界挡住。
- **查不到名字就整段去掉标签**：宁可少一个名字，也不留下裸的 `@` 或半截 `<@…`——半截 id 既不亮、又会被当文字发出去（§39.2 的同一顾虑）。
- **与 §29.7 / §38 不冲突**：切片、片数、间隔一个字没改；去重发生在「正文是什么」那一层（与 §37 的重试、§40 的续写同层），切片发生在「怎么发出去」那一层（§39.4）。

### 42.4 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/core/chat/mention-dedupe.ts` | 新增（`:8` / `:23` / `:106` / `:121`）：`MENTION_TAG_RE`、`buildMentionNames(messages)`、`dedupeMentions(text, { alreadyPinged, names })`、`renderMentionRule()`——重复提及的唯一去处，纯函数、不做 IO |
| `src/core/chat/service.ts` | `mentionSeed` 与规则块（`:988-989`）、名字表（`:1024`）、`mentionSafe` 封装（`:1026`）、三处调用（`:1102` 首段进度、`:1138` 续写进度、`:1163` 最终正文）；私聊 `guildId === ''` 直接返回；规则块排在 `promptParts.after` 之后、`renderReactionGuide(...)` 之前（`:994-996`） |
| `src/core/chat/line.ts` | `withAuthorPrefix`（`:16-23`）拼出的 `[MM-DD HH:mm] 显示名(用户ID)：正文`（§18.3）是名字来源的前提，本版不改 |
| `src/workers/discord/mention.ts` | §39 的前缀（`mentionPrefix` / `withMention`）一个字没改，本节不动它 |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD` 在 §42 落地时指向 `'mention-once-2'`、§43 起 `'pg-errors-1'`、§44 起 `'voice-1'`、§44.1 起 `'voice-2'`（按指令模式补上【语音】段）、§45 起 `'prompt-scope-1'`（内置默认与身份块可编辑）、§46 起 `'tts-admin-1'`（TTS 接口搬进后台、后台「语音」页配 + 试听）、现指向 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（261291§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string \| null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版 `'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是§46.7，接口类型可选 OpenAI 兼容或 MiMo；日志 `[node] listening … build=reply-tool-3` 与 `[gateway] alarm build=reply-tool-3` 才说明这一版在位 |

- 本版没有新表、没有新迁移：迁移仍是 18 个，`0018` 是 §41 的 `vision_settings`（`docs/operations.md` §19.8）。
- 本版没有新路由、没有新配置项：去重不需要开关，行为就是「一人一次」。
- 代码地图里的行号按落地时的代码写；实现如果又挪了位置，以文件里的函数名为准。

## 43. 后台「故障」页：PG 中继报错（`pg-errors-1`）

门牌前进到 `pg-errors-1`，加的是**一条能看见中继为什么失败的路**：中继把每次失败的量纲记进进程里的环形缓冲（200 条），开一条只读端点 `GET /admin/errors`；bot 侧用 `/api/pg-errors` 代理它，后台多一张「故障」页（`web/src/pages/ErrorsPage.tsx`，标签在 `web/src/App.tsx:36`）。§37 讲失败怎么换候选模型、§31 讲 bot 这侧的三处证据，本节只讲「中继报了什么、运维在哪看」，几者不混写。

### 43.1 为什么要有

- 现状只有两个计数器：中继每个执行器各维护一份 `requestsServed` / `requestsFailed`（`server/server.js:488-489`，在 `:560` / `:563` 累加），它们回答「失败了几次」，不回答「哪一步、为什么」。
- 502 与 `executor_timeout` 之间差着一整条排查路：`docs/operations.md` §31 只能看到 bot 这侧的 `ALL_PROVIDERS_FAILED` 与错误串，看不到中继那端是执行器超时、还是上游回了非 200。
- 所以把失败条目**留在中继内存里**，用一条只读端点取出来：不落库、不新增表、不新增迁移（仍是 18 个，`0018` 是 §41 的 `vision_settings`）。
- **绝不记录**：prompt 正文、图片 base64、完整 Key、`Authorization` 头——`server/server.js:176` 那行注释就是这条边界。条目里只有量纲与错误串，与 §13「明文密钥永不进日志」同一条口径。

### 43.2 数据从哪来

- **中继一侧**：`GET /admin/errors?limit=N`，经 Caddy 时对外是 `/pg/admin/errors`（`docs/hosting.md` §15）。分发在 `server/server.js:1438`，处理函数 `handleAdminErrors`（`:1467`）。
  - 鉴权沿用中继现有的 Key 名单：`Authorization: Bearer <key>`，key 必须通过 `keyAllowed(key)`（`server/server.js:169`）。缺 key → 401 `{ "error": { "code": "api_key_required", "message": "缺少 API Key" } }`；key 不在名单里 → 401 `{ "error": { "code": "api_key_rejected", "message": "API Key 无效" } }`。鉴权失败**不记账**（`:1465` 的注释：读缓冲的动作不能把自己写进缓冲）。
  - `limit` 解析失败按 200，越界夹到 1..200，不报错（`clampErrorLimit`，`server/server.js:238`）。
- **缓冲**：`recentErrors`（`server/server.js:183`），容量 `RECENT_ERROR_LIMIT = 200`（`:179`）；写满从最旧的挤掉，被挤掉的累计在 `recentErrorsDropped`（`:184`）里，就是响应里的 `dropped`。**进程重启即清空**——它不是审计日志。
- **记账点只有一个**：`recordError({ status, code, message, model, key, durationMs, requestId, retries })`（`server/server.js:194`），顶层 catch 与两条流式 catch 都经 `recordFailure`（`:214`）进来，避免漏记或双记。
- **取快照**：`recentErrorFeed(limit)`（`server/server.js:245`），新 → 旧，最多 `limit` 条。

### 43.3 字段与语义

响应体：`{ "limit": 200, "dropped": 0, "items": [ … ] }`，`items` 新 → 旧，条数 ≤ `limit`。

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `at` | string | 失败发生时刻，ISO 时间串（`server/server.js:196`） |
| `status` | number | HTTP 状态码；拿不到就记 500（`:197`） |
| `code` | string | 错误码，形如 `executor_timeout`、`api_key_rejected`；缺省 `internal_error` |
| `message` | string | 一句中文原因，**截断到 500 字符**（`formatErrorMessage`，`:187`；重试过会带「（已重试 N 次）」后缀，后缀也算在这 500 里） |
| `model` | string? | 这次请求的模型名；取不到就不出现这个键 |
| `key` | string? | **掩码后**的 Key（`maskKey`，`server/server.js:81`），只留头尾几位；原值永不出现 |
| `durationMs` | number? | 从请求进来到失败交给调用方的毫秒数，非负整数 |
| `requestId` | string? | 中继给这次请求的 id，与中继日志里的那个一致，用来对齐 |

- **`dropped` 是累计值**：自进程启动以来被挤出缓冲的条数，不是这一次丢的。后台写「共 N 条（已丢弃 M 条）」就是它；`dropped` 变大只说明「比 200 条更早的那些看不到了」，不是故障。
- **上限是硬的**：`limit` 缺省 200、上限 200、下限 1；`limit=0` 当 1、`limit=abc` 当 200。响应里的 `limit` 是**夹紧后**的值，不是请求里那个。
- **bot 会再净化一遍**：`readEntry`（`src/core/pg-errors.ts:60`）要求 `at` / `status` / `code` / `message` 齐全，缺一个或类型不对就丢掉这一条；`message` 在这一层再截一次 500（`:68`）；`readFeed`（`:81`）把 `limit` 夹到 1..200、`dropped` 取非负整数。
- 后台表格把 `status` 与 `code` 放在同一列（读作「502 executor_timeout」），`requestId` 跟在原因下面（`web/src/pages/ErrorsPage.tsx:247-278`）。

### 43.4 bot 侧代理与三种结果

`GET /api/pg-errors?limit=N`（`src/workers/http/app.ts:757-769`）沿用 §11 那套会话 Cookie 鉴权（`/api/*` 中间件，`app.ts:532-541`），与 `/api/logs` 同一套：没有新口令、没有新登录方式。

| 结果 | 何时 | 响应 |
| --- | --- | --- |
| 200 | 中继可达且形状对 | 中继那份**原样**返回 `{ limit, dropped, items }`，条目的形状与 §43.3 一致 |
| 501 | `PG_ERRORS_URL` / `PG_ERRORS_TOKEN` 任一缺失（中继没配） | `{ "error": "PG_ERRORS_UNAVAILABLE" }` |
| 502 | 中继不可达 / 非 200 / 形状坏 | `{ "error": "PG_ERRORS_UPSTREAM", "detail": "<一句中文原因>" }` |

- 环境变量：`PG_ERRORS_URL`（例 `http://pg-relay:8787`）、`PG_ERRORS_TOKEN`（中继 `API_KEYS` 里的那一把）。两者任一缺失 = **没配中继**：`src/node/main.ts:140-144` 给的是未配置占位，只有这一条路由回 501，其它 API 与健康检查照常。
- `limit` 解析失败或越界一律夹到 1..200，不报错（`clampPgErrorsLimit`，`src/core/pg-errors.ts:14`）；缺省 200（`:4`）。
- 请求中继的超时、连不上、非 200、不是 JSON、形状不符，全部落成 502 带一句中文原因（`createRelayErrorSource`，`src/core/pg-errors.ts:113-150`）；超时时长是 `DEFAULT_TIMEOUT_MS`（`:11`）。
- 这一版**不动**回复路径：中继记账不改变它回给 bot 的成功 / 失败，`/api/pg-errors` 是纯读，绝不写库。

### 43.5 代码地图

| 位置 | 作用 |
| --- | --- |
| `server/server.js:174-211` | 环形缓冲本体：`RECENT_ERROR_LIMIT` / `RECENT_ERROR_MESSAGE_MAX`（`:179-180`）、`formatErrorMessage`（`:187`，500 字截断）、`recordError`（`:194`，唯一记账入口，`key` 过 `maskKey`）、挤掉计数（`:206-209`） |
| `server/server.js:214` | `recordFailure(error, context, fallback)`：顶层 catch 与两条流式 catch 共用 |
| `server/server.js:238` / `:245` | `clampErrorLimit`（1..200 夹紧）/ `recentErrorFeed`（新 → 旧 + `dropped`） |
| `server/server.js:1438` / `:1467` | 路由分发 / `handleAdminErrors`（Bearer + `keyAllowed`，401 两种错误码） |
| `src/core/pg-errors.ts` | 纯逻辑层：`clampPgErrorsLimit`（`:14`）、`PgErrorsSource`（`:20`）、`PgErrorsUnavailableError`（`:26`）、`readEntry` / `readFeed`（`:60` / `:81`）、`createRelayErrorSource`（`:113`）、`createUnconfiguredErrorSource`（`:153`） |
| `src/core/types.ts:422` | `PgErrorFeed`：`limit` / `dropped` / `items` 的类型面（条目就是 §43.3 那几项） |
| `src/workers/http/app.ts:149-150` / `:757-769` | 依赖注入位（`deps.pgErrors`，未注入即 501）/ 路由本体（501 与 502 两个分支） |
| `src/node/main.ts:140-144` | 读 `PG_ERRORS_URL` / `PG_ERRORS_TOKEN`，缺任一就装未配置占位 |
| `web/src/api.ts:1539-1616` / `:1620` | 后台的取数与净化（`PgErrorEntry` / `toPgErrorEntry` / `fetchPgErrors`）/ `describePgErrorsError`（501、502、认不出的码各一句中文） |
| `web/src/pages/ErrorsPage.tsx:104` | 「故障」页：时间 / 错误码 / 模型 / key / 耗时 / 原因，自动刷新可暂停，单条与全量复制 |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD` 这一版是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（271151§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string \| null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版 `'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记的是§46.7：接口类型可选 OpenAI 兼容 `/audio/speech` 或小米 MiMo `chat/completions`，老行默认 `openai`、行为不变；日志里 `build=reply-tool-3` 才说明在位（`tts-admin-1` 是 §46 那一版、前一版：TTS 接口搬进后台、后台「语音」页配 + 试听；`prompt-scope-1` 是 §45 那一版、再前一版：内置默认与身份块可编辑；`voice-2` 是 §44.1 那一版、更早：按指令模式补上【语音】提示段；`voice-1` 是 §44 那一版、更早：文字回复结束后可发一条语音附件、三档三层开关；`pg-errors-1` 是 §43 那一版，再前一版） |

- 本版没有新表、没有新迁移：迁移仍是 18 个，`0018` 是 §41 的 `vision_settings`。
- 本版只有一条新路由（`GET /api/pg-errors`）与两个新环境变量（`PG_ERRORS_URL` / `PG_ERRORS_TOKEN`），落盘步骤在 `docs/hosting.md` §15.8。
- 代码地图里的行号按落地时的代码写；实现如果又挪了位置，以文件里的函数名为准。

## 44. 语音回复（`voice-2`，§45 起是前一版；`voice-1` 是它前一版；TTS 配置 §46 起在后台「语音」页，§47 起带朗读语气——`tts-style-1` 是「自然语言语气行 + `role:user` 消息」，`tts-tags-1` 起改成「assistant 正文开头的标签 + 正文逐字校验」，`tts-nolimit-1` 起不再限制字数，`voice-log-1` 起语音发出后补一条成功日志）

门牌在 §44 前进到 `voice-1`，加的是**一条能听见的回复**：这一轮的文字回复发完之后，按后台的三层设置决定要不要把这段正文合成语音，并发成**单独一条 mp3 附件消息**到同一频道。正文、表情、摘要、落库一个字没改；Discord 的语音气泡留到下一步，本轮不做。

§44.1 末尾那一段【语音】提示段是 `voice-2` 补的：只动 `mode = 1` 的提示词（加一段【语音】教她写 `[[voice]]`），正文、表情、摘要、落库一个字没改，也没有新迁移（那一版是 19 个，`0019_voice_settings.sql` 不变；§45 加了 `0020_prompt_defaults.sql` 与 `0021_prompt_default_scope.sql`，§46 又加了 `0022_tts_settings.sql`，§46.7 再加 `0023_tts_dialect.sql`、§47 再加 `0024_tts_style.sql`，现为 24 个）。

### 44.1 能力与开关（三档 × 三层，默认关）

- 触发点在文字回复之后：这条回复已经发出去（也落了库）才轮到语音，朗读的就是用户看到的那段正文（§40 续写出来的部分也算在内）。
- 发法：新发一条消息，附件是 `voice.mp3`、走同一个频道；不改写、不编辑、不回复那条文字消息——语音是**单独一条**，不是把文字消息换成音频。Discord 的语音气泡（voice message）本轮不做。

| `mode` | 含义 | 什么时候发 |
| --- | --- | --- |
| `0` | 关闭（**默认值**） | 永远不发；升级后行为与上一版逐字相同 |
| `1` | 她说了才发 | 回复正文里出现 `[[voice]]` 指令才发；指令本身由核心层剥掉，用户看不到 |
| `2` | 每条都发 | 每条文字回复都配一条语音，与正文里写没写 `[[voice]]` 无关 |

三层与 §38 / §41 同一个口径：**channel > guild > global**，第一个合法的赢；`mode` 不是 0 / 1 / 2 的行当「这一层没配置」，继续往下一层；三层都没配就是 `0`。私聊没有频道层，只有服务器层与全局层。

- `[[voice]]` 只在 `mode = 1` 有意义：`mode = 0` 时它和别的未知指令一样被剥掉、不发；`mode = 2` 时发不发与它无关。
- 音色与语速也存在同一张表：`voice` 为空时这一项不写（用 TTS 接口自己配的默认音色；服务器环境变量 `VOICE_TTS_VOICE` 那一版起不生效、可以删，§46）；`speed` 存 50–200 的百分比，越界按默认 `100` 处理。合成用的地址 / Key / 默认音色在后台「语音」页（模型自 `tts-style-1` 起不再可写、按接口类型取内置默认，§47），见 §46。
- 表 `voice_settings`（`migrations/0019_voice_settings.sql`）：`scope` / `scope_id` / `mode` / `voice` / `speed` / `updated_at`，主键 `(scope, scope_id)`——一层只有一行，写就是覆盖，形状与 §26 的 `channel_memory_settings`、§38 的 `reply_settings`、§41 的 `vision_settings` 同源（三层 + 空串代表 global）。
- `mode` 与 `speed` 故意**不加** `CHECK`：越界值由读侧处理（`mode` 非法当没配、`speed` 越界回默认 100），将来放宽范围不必再写一条迁移。

**按指令模式（`mode = 1`）怎么让模型知道这条指令**（`voice-2` 补的就是这一处缺口）：`0` 与 `2` 都不需要指令，偏偏 `1` 是「她写了才发」——而提示词里从来没教过 `[[voice]]` 这种写法，于是这一档按指令模式等于永远不触发（对照贴表情：`[[react:…]]` 那条有「表情规则块」在教，`[[voice]]` 缺的正是同一件事）。所以只在 `mode = 1` 时往 system 里挂一小段固定文案，逐字是：

```text
【语音】
想让这条回复被念出来，就在正文里单独写一行 [[voice]]；不念就不要写。这一行不会显示给对方。
```

- **位置**：表情规则块之后、自定义表情清单之前——先立规则、再列素材，与 §42 的提及规则块同一个插槽思路，改提示词时不要把它挪到表情块前面。
- **只有 `mode = 1` 注入**：`0` 注入只会让她白写一行废指令（写了也不发），`2` 每条都发、根本不需要指令。`0` 与 `2` 的普通消息提示词与前一版 `voice-1` **逐字相同**——没开这一档的人，请求形状一个字都没变。
- **怎么挂上去**：`TurnContext` 上多一个 `voiceHint` 字段（空串 = 不注入）；文案由 `src/core/chat/service.ts` 的 `renderVoiceHint` 出；网关与 handler 各自在 `mode = 1` 时把它填进去，别处不拼这段字。

### 44.2 TTS 接口与配置来源

合成走的是 **HTTP 接口**；`tts-admin-1` 起这些值**只认后台「语音」页**（§46），`tts-mimo-1` 起同一份配置还能选两种上游方言（§46.7）；`tts-style-1` 起**模型不再是可写字段**——库里 `model` 列只留历史值、合成侧一律不读，按接口类型取内置默认（`openai` → `tts-1`，`mimo` → `mimo-v2.5-tts`，§47.1）：默认的 OpenAI 兼容 `/audio/speech` 与小米 MiMo 的 `chat/completions`。`VOICE_TTS_URL` / `VOICE_TTS_KEY` / `VOICE_TTS_MODEL` / `VOICE_TTS_VOICE` 四个环境变量仍完全不生效（部署脚本里留着空占位无害，后台会提示可以删），代码里的 `createEnvTts` 已删除。

| 项 | `openai` 方言（默认） | `mimo` 方言 |
| --- | --- | --- |
| 端点 | `POST {url}/audio/speech`，`url` 来自后台「语音」页（校验过 http/https、≤500） | `POST {url 去尾斜杠}/chat/completions` |
| 鉴权 | `Authorization: Bearer {key}`，`key` 是库里密文解密后的明文，只在进程内存里用到这一刻 | 同左 |
| body | `{ model, input, voice, response_format: 'mp3', speed }`（`voice` 为空就整个字段不出现） | `{ model: 'mimo-v2.5-tts', messages: [{ role: 'assistant', content: '(怅然)要念的文字' }], audio: { format: 'mp3', voice? } }`——只有一条 `assistant`，`content` 是「标签 + 正文」，没有标签时就是正文（§47.7） |
| 模型 | `tts-style-1` 起不可配：读侧忽略库里 `model`，恒用内置默认 `tts-1` | 同左，恒用内置默认 `mimo-v2.5-tts`（库列只留历史值、不覆写） |
| 音色 | 后台配，空白表示不带这个字段、用服务端默认音色；候选 `alloy` / `echo` / `fable` / `onyx` / `nova` / `shimmer` | 候选 `mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean；空白同样不带这个字段 |
| speed | 语音回复设置里的 50–200 百分比 ÷ 100，越界按默认 `100` 处理 | **没有这个参数**，选 MiMo 时语速不生效（后台会提示） |
| 音频 | 响应体本身就是 mp3 字节 | 响应 JSON 的 `choices[0].message.audio.data`（base64） |
| input | §44.3 的朗读文本（剥 @、剥 markdown、压空白，**不设字数上限**） | 同左 |

`mimo` 的 messages 只有一条 `assistant`：`content = tag + text`，无标签时 `content` 就是正文；标签贴着正文最前面（`(怅然)…`），正文任意位置可插 `[音频标签]`，**不发 `role:user` 消息**（`src/core/voice/tts.ts:243-244`，§47.7）。`openai` 方言忽略 `tag`，`/audio/speech` 请求体不变。

「未配置」＝库里没有行、`url` 空、`key` 空三者任一成立。这时语音整体不出声，回复、表情、摘要、落库一字不受影响。

**为什么不是 Edge TTS**：2026-11-05 在部署机上实测，微软那套走不通——`speech.platform.bing.com` 直接回 **HTTP/2 404**；`api.msedgeservices.com` 带 `Ocp-Apim-Subscription-Key` 回 **403**，把 key 换成 query 参数传又是 **404**；Node 侧自己发起 WebSocket 同样拿不到 101（`non-101`）。这三种都不是调参能救的（端点侧不放行），所以后端改成可配置的 HTTP 接口：谁能提供这个形状就填谁，换厂商只在后台「语音」页改地址与 Key、不改代码（§46 起那四个 `VOICE_TTS_*` 环境变量不生效）；`tts-mimo-1` 起再补一种小米 MiMo 的 `chat/completions` 形状（§46.7）。

### 44.3 朗读文本与失败策略

朗读的不是原文，而是清理过的正文：先清掉 **@ 提及**、**markdown 记号**、结尾的 **「…(已截断)」**，再把连续空白压掉。**这一版起不设字数上限**：`toSpeechText`（`src/core/voice/speech-text.ts:9`）只做清理，念多长由上游接口自己的规则决定；上游嫌长就按现有的失败路径报（合成失败只在日志留一条 `[voice] 语音发送失败 …`，回复照常），本服务不再自己截。清理只作用在送去合成的那份文本上：频道里的正文与落库的内容一个字不改。

- **成功补一条 info（`voice-log-1` 起）**：语音真的发出去之后补一条成功日志，格式逐字为 `[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，`tag` 优先取 judge 给的风格组、都空写 `tag=无`（例：`[voice] 已发送 tag=(温柔 低语) bytes=251592 字数=182 mode=2 director=1`）。这条只记标签、字节数、字数与 mode / director，**正文绝不整段进日志**（§19.1 的约束：日志里不出现用户 / 模型正文的整段；`director-4` 起唯一例外是末尾那个可选的 `judge=` 段——judge 那一行的完整一行、不截断，用于排查）。出口是 `VoiceReplyInput` 的新字段 `logInfo`（`src/workers/discord/voice-reply.ts`，默认 `console.log`）：gateway 路径把它接到 `#logGateway(info, …)`，所以这一行走 `runtime_logs`、`level=info`、`scope=gateway`，后台运行日志页按这两个条件就能查到；Discord 交互路径没有级别、只进控制台。它与失败那条互斥：成功才写、失败不写；写这条日志本身抛错也不影响语音已经发出去（返回值仍是 `sent: true`）。
- **失败只记一条 warn**：合成（HTTP 非 2xx、超时、返回不是音频都算）与上传（Discord 拒绝、权限不足）任何一步失败，都只在日志里写一条 `[voice] 语音发送失败 …`，回复本身照常——它早就发出去了，没有回滚这回事，也不会因此重发文字。
- **不重试**：这条失败就过去了，下一条回复再试；语音是附加物，不进回复的成功 / 失败判定（§37 那套不受影响）。
- **单独一条附件消息**：正文为空、附件是 mp3，落在同一个频道；Discord 侧要求 bot 在该频道有 **Attach Files** 权限（排错见 `docs/operations.md` §25.12）。
- **语音气泡留待下一步**：本轮只有 mp3 附件，没有波形、没有原生语音消息。

### 44.4 代码地图

| 位置 | 作用 |
| --- | --- |
| `migrations/0019_voice_settings.sql` | 建 `voice_settings`（§44.1 那六列 + 主键；迁移总数 18 → 19）；TTS 的地址 / Key / 模型 / 默认音色从 §46 起另存 `0022_tts_settings.sql`，方言列从 §46.7 起在 `0023_tts_dialect.sql` |
| `src/core/voice/settings.ts` | 三层解析：`channel > guild > global` 第一个合法的赢；`mode` 非法当没配，`speed` 越界回 `100` |
| `src/core/voice/tts.ts` | `ttsConfigFrom`（:38）拼配置、`createStoredTts`（:56）每条消息现读一次后台配置、`createTts`（:283）按 `dialect` 分派到 `createOpenAiTts`（:154，`POST {url}/audio/speech`）或 `createMimoTts`（:207，`POST {url 去尾斜杠}/chat/completions`）；读不到或未配置用「合成即抛」的占位实现，成功拿到 mp3 字节（§46.4） |
| `src/core/voice/speech-text.ts` | `toSpeechText`（`:9`）：剥 @ 提及、剥 markdown、去结尾「…(已截断)」、压空白——**没有任何字数上限**（本服务不截断） |
| `src/core/voice/directive.ts` | `[[voice]]` 的识别与剥离（只有 `mode = 1` 才看它） |
| `src/core/chat/service.ts` | `renderVoiceHint`：`mode = 1` 时那一段【语音】的固定文案（§44.1 逐字），挂在表情规则块之后、自定义表情清单之前；`0` / `2` 返回空串、不占位 |
| `src/workers/discord/voice-reply.ts` | 文字回复发完之后那一步：解析设置 → 合成 → 以单独一条附件消息发到同一频道；失败只 warn |
| `src/workers/http/app.ts` | `GET` / `PUT` / `DELETE /api/voice-settings` 三条路由（错误码见 §11）；TTS 配置那四条 `/api/tts-settings` 在 §46.3 |
| `src/workers/db/d1-repository.ts` | `voiceSettings` 存储（读 / 写 / 删一行）；`ttsSettings` 在 :503（§46.6） |
| `web/src/pages/VoicePage.tsx` | 「语音」页两张卡片：上面是「语音合成接口」（地址 / Key / 模型 / 默认音色 + 保存 / 清除 / 试听），下面是 `tts-admin-1` 从「回复」页搬过来的「语音回复」（三档单选 + 音色 + 语速 + 保存 / 清除，行为不变）；「接口类型」下拉切换只换地址 / 模型 placeholder 与音色 datalist，音色候选 `alloy` / `echo` / `fable` / `onyx` / `nova` / `shimmer`（OpenAI）或 `mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean（MiMo）只是输入建议，留空就是用服务端默认音色（§46.5、§46.7） |

- 本版只有这一张新表：迁移总数 18 → 19，`0019` 就是它；`0018` 仍是 §41 的 `vision_settings`。
- `voice-2` 没有新表、没有新迁移：那一版是 19 个，`0019_voice_settings.sql` 一字不动；§45 起 21 个（`0020_prompt_defaults.sql` 与 `0021_prompt_default_scope.sql`），§46 起 22 个（`0022_tts_settings.sql`），§46.7 起 23 个（`0023_tts_dialect.sql`）。
- 本版新增四个环境变量（§44.2），都不是必填；缺 URL 或 KEY 只关掉语音这一条支线。`tts-admin-1` 起这四个**完全不生效、可以删**——地址 / Key / 模型 / 默认音色只在后台「语音」页配（§46）。
- 门牌本体仍在 `src/workers/gateway/engine.ts` 的 `GATEWAY_BUILD`；§33.9 记这枚门牌的演进链。

## 45. 内置默认（兜底）与身份块按三层可配（`prompt-scope-1`）

§44 再怎么配，主模型最底下还留着两处写死在代码里的文案：三层提示词段落全空时那段「基本设定」，以及每一轮硬追加的【当前对话】身份块。前一版（`prompt-defaults-1`）让这两处能改，但只有一份全局的；`prompt-scope-1` 把它们做成**分层**：每一块都能按 channel > guild > global 各存一份、各删一份，层内配坏了（未知占位符 / 全空白）只等于这一层没配。**三层都没配时，装配出的 system 与身份块与上一版逐字相同。**

### 45.1 缺口与语义

写死的是「她是谁」这件事的最后两层：

| 写死在哪 | 是什么 | 什么时候生效 | 本版变成 |
| --- | --- | --- | --- |
| `src/core/prompt/resolver.ts:5` 的 `DEFAULT_PROMPT` | 一个 system / before 段（段 id `default-main`、name「基本设定」、position 0），正文用 5 个变量 | 只有三层提示词**与**三层内置默认**都为空**时才轮到它 | `prompt_defaults` 里 key = `fallback` 的三层行；三层都没配才回代码常量 |
| `src/core/chat/service.ts:319` 的 `buildIdentityBlock` | 每轮硬追加的【当前对话】块（system 天头）：谁在说话（名字 + ID）/ 这里（服务器 · 频道）/ 今天 | 每一轮都追加，与提示词配在哪一层无关 | `prompt_defaults` 里 key = `identity` 的三层行；三层都没配时仍由 `formatIdentityBlock` 拼那句原话 |

为什么要可编辑、还要分层：后台「提示词」页原先只能改 channel / guild / global 三层提示词段落，三层都空的时候那句「基本设定」改不动——想换一种自我认知的写法，只能改代码、重新部署；身份块的措辞（「和你说话的是 …（ID …）」「今天 …」）也全在代码里。这两处恰好是最像「她的底子」的文案：最想改，原先最改不动。而只给一份全局又不够用：一个服务器想换口吻，不该顺带把整个 bot 的兜底都换掉。

本版守住的三条不变式（都有测试断言）：

- **没配 = 上一版**：两块的三层都没配时，装配出的 system 与身份块与上一版逐字相同——升级不需要改任何设置，也不需要清空任何东西。
- **未接线 = 上一版**：没装配 `PromptDefaultsStore`（单测、早期宿主）时三层一次都不读，走的就是原路径。
- **读不到不挡路**：`prompt_defaults` 读失败（表还没迁、SQL 错、连接断）一律按「三层都没配」继续，回代码常量与原身份块，绝不让回复失败。

### 45.2 存储与迁移

`migrations/0021_prompt_default_scope.sql` 把 `0020` 那版单行表升级成复合主键表（迁移总数 20 → 21，`0021` 是 21 个迁移之末）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `key` | `TEXT NOT NULL` | 只允许 `fallback` 与 `identity`；库里若出现别的 key，读侧直接忽略、写侧拒绝 |
| `scope` | `TEXT NOT NULL` | 只允许 `channel` / `guild` / `global` |
| `scope_id` | `TEXT NOT NULL` | 频道 ID 或服务器 ID；`global` 层固定空串 |
| `content` | `TEXT NOT NULL` | 模板正文；trim 后不能为空，上限 20000 字（§45.5） |
| `updated_at` | `TEXT NOT NULL` | 最后一次保存的时间，`GET` 原样回给后台 |

主键是 `(key, scope, scope_id)`。升级时旧行一律搬成 `('global', '')`——升级前配过的那一份于是就是「全局层这一份」，行为不变。全库最多 6 行（2 个 key × 3 层），`GET` 也只可能回 6 行。

写是覆盖（同一 key + 同一层只有一行），删就是「恢复默认」——没有状态位，也没有历史版本，更没有一段「默认文本」要写回：删掉这一行，这一层就回落到下一层或代码内置（§45.5）。

### 45.3 完整解析顺序

```text
三层提示词段落：channel > guild > global     ← 命中即赢
        ↓ 三层都空
三层内置默认：  channel > guild > global     ← fallback 用它的正文，identity 用它的模板
        ↓ 三层都空
代码内置：      DEFAULT_PROMPT / formatIdentityBlock 拼的那句「【当前对话】…」
```

- 前三级不改：命中的第一层赢（就是 `resolvePrompt` 的前三个参数）。
- 第四到第六级是新加的一档**内部也分层**：`pickScopedTemplate(channel, guild, global)` 按同一优先级从三层里挑出「这一轮该用的那份模板」。`fallback` 挑中后装成一段 system / before 段（段 id `fallback`、name「内置默认」、position 0），正文沿用同一套 5 个变量（`bot_name` / `user_name` / `guild_name` / `channel_name` / `date`）——与三层提示词段落走**同一套段模型、同一个装配路径**，不是额外拼一段字。
- 第七级是代码内置：前六级全空才轮到它（`src/core/prompt/resolver.ts` 里 `return { cfg: DEFAULT_PROMPT, scope: 'global' }` 一字没动，`scope` 口径也没变）；身份块则由 `formatIdentityBlock` 拼出那句原话。
- **含未知占位符、或 trim 后全空白的层，等同于这一层没配**：读侧跳过它、继续往下层找，而不是把整块默认吞掉、也不是让每条回复都失败。错一个 `{{}}` 的代价是「这一层不生效」，不是「这一版全坏了」。
- 身份块走同一条链条：三层 `identity` → 代码拼装（§45.4）。两块的链条互不影响，可以只配 `fallback` 的三层、`identity` 全留空。

### 45.4 身份块模板与代码等价写法

`identity` 是可选的：三层都没配（或三层都等同于没配）时，身份块仍由 core 的 `formatIdentityBlock` 拼出与上一版逐字相同的那一句；配了才走通用渲染（`renderIdentityTemplate`，与后台预览 `previewPromptDefault` 共用同一实现——真实装配与后台预览不会各拼一套）。变量 6 个：

| 变量 | 含义 | 为空时 |
| --- | --- | --- |
| `bot_name` | bot 的显示名 | 引用它的行整行丢弃 |
| `user_name` | 提问者的显示名 | 引用它的行整行丢弃（旧路径的判据是「名字都没有就整块不出现」） |
| `user_id` | 提问者的用户 ID（Discord 数字 ID，提示词里只写「ID」） | 引用它的行整行丢弃 |
| `guild_name` | 服务器名（私聊为空；与频道名一起进「这里：」那一句） | 引用它的行整行丢弃 |
| `channel_name` | 频道名 | 引用它的行整行丢弃 |
| `date` | 今天的日期（与段模板同一份） | 引用它的行整行丢弃 |

逐行渲染与丢弃（合起来保证私聊里不会冒出「这里：」这种半截空壳）：

- 一行一行渲染：某行引用的变量为空，就整行丢弃。
- 渲染后 trim 成空的行也丢。
- 全丢光则整块不出现（连两个换行都不留）。

代码等价写法（三层都没配时的输出，也是后台只读区 `codeDefaults.identity.rendered` 里那一份）：

```text
【当前对话】和你说话的是 {提问者显示名}（ID {user_id}）；这里：{guild_name} · {channel_name}；今天 {date}。
```

这一句现在由 `formatIdentityBlock`（`src/core/prompt/defaults.ts:116-127`）统一拼装：真实装配与后台预览共用同一实现，后台看到的与线上跑的是同一句话。返回值仍以两个换行开头——那是它当年「接在预设段后面」的旧约定；`preset-head-1` 起它排在预设 `before` 段之后（`identity-head-1` 那版它是 `system` 的天头），装配处用 `identityBlock.replace(/^\n+/, '')`（`src/core/chat/service.ts:1150`）把这两个换行削掉，见 §52.2。

未知占位符不阻断编辑：保存时 `PUT` 拒（400 `UNKNOWN_TEMPLATE_VAR` + `vars`），预览时只回报不拦（响应里的 `unknownVars`），后台用警示色点名那一处、照常让你继续改（§45.5）。

### 45.5 后台形态与四条路由

后台「提示词」页**最上面那张卡片**改成分层：

- 三层 tab（channel / guild / global），每个 tab 带自己的「已配置 / 未配置」状态。
- 频道层与服务器层各有一个 ID 输入框（仓库里没有频道列表接口，与既有三层提示词表单口径一致）。
- 两块编辑区（`fallback` / `identity`），保存与「恢复默认」**只作用于当前 tab 那一层**。
- 每块下方 500ms 防抖的实时预览（走 `POST /api/prompt-defaults/preview`）；未知占位符用警示色点名，但不阻断编辑。
- 新增只读区「代码内置（只读）」：代码内两段默认原文（变量保持 `{{}}` 原样）+ 渲染预览（预览用固定示例数据：示例机器人 / 示例用户 / 123456789012345678 / 示例服务器 / 示例频道 / 2026-11-05），并注明「这里改不生效」。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/prompt-defaults` | — | 200 `{items,vars,maxChars,scopes,sampleVars,codeDefaults}`：`items` 最多 6 行（每行 `key` / `scope` / `scopeId` / `content` / `updatedAt`，没配的层没有对应行）；`vars` 是两块各自的变量表；`maxChars` = 20000；`scopes` 是三个 scope 的枚举与顺序；`sampleVars` 是预览用的示例数据；`codeDefaults` = `{fallback:{text,rendered},identity:{text,rendered}}`（代码内置的原文与渲染结果） |
| PUT | `/api/prompt-defaults` | `{key,scope,scopeId,content}` | 200 回写后的那一行；400 `BAD_PROMPT_KEY` / `BAD_SCOPE` / `BAD_REQUEST` / `BAD_PROMPT_CONTENT` / `UNKNOWN_TEMPLATE_VAR{vars}` |
| DELETE | `/api/prompt-defaults?key=&scope=&scopeId=` | — | 200 `{ok:true}`；只删这一层这一行；400 `BAD_PROMPT_KEY` / `BAD_SCOPE` |
| POST | `/api/prompt-defaults/preview` | `{key,content}` | 200 `{key,rendered,unknownVars}`；空白正文回空串；**不落库** |

`PUT` 的校验顺序固定为四步（先后不能换，否则报错会互相盖住）：`BAD_PROMPT_KEY` → `BAD_SCOPE` / `BAD_REQUEST` → `BAD_PROMPT_CONTENT`（非字符串 / trim 空 / > 20000）→ `UNKNOWN_TEMPLATE_VAR{vars}`。四类 400：

- `BAD_PROMPT_KEY`：`key` 不是 `fallback` / `identity`（`DELETE` 的 query 缺失也算）。入口只有这两个 key × 三层，没有第三个。
- `BAD_SCOPE` / `BAD_REQUEST`：`scope` 不是 `channel` / `guild` / `global`；频道层与服务器层没带 `scopeId`（`global` 层的 `scopeId` 固定空串）。
- `BAD_PROMPT_CONTENT`：`content` 不是字符串、trim 后为空、或超过 20000 字。
- `UNKNOWN_TEMPLATE_VAR`：模板里出现该 key 变量表之外的占位符；响应带 `vars`（出错的名字），后台照 §32.4 那套翻成人话。

「恢复默认」的语义：**只删掉当前层这一行**，于是这一层回落到下一层或代码内置——不是写回某段「默认文本」。全局层删掉之后是代码常量 / `formatIdentityBlock` 那句；频道层删掉之后是服务器层或全局层那一份。

`GET` 一次把变量表、上限、示例数据与代码内置一起下发，前端不抄常量；鉴权沿用管理后台（会话 Cookie，与 `/api/prompts` 同一条链），没有新权限概念。装配侧只认库里的行：读到就用，读不到按没配（§45.3）。

### 45.6 代码地图

| 位置 | 作用 |
| --- | --- |
| `migrations/0021_prompt_default_scope.sql` | 21 个迁移之末：把 `prompt_defaults` 换成 `(key, scope, scope_id)` 复合主键，旧行搬成 `('global','')`（§45.2） |
| `src/core/prompt/defaults.ts:23` `CODE_IDENTITY_TEMPLATE` | 代码内置那份身份块原文，只服务后台只读区（变量保持 `{{}}` 原样） |
| `src/core/prompt/defaults.ts:33` `SAMPLE_PROMPT_VARS` | 预览用固定示例数据：示例机器人 / 示例用户 / 123456789012345678 / 示例服务器 / 示例频道 / 2026-11-05 |
| `src/core/prompt/defaults.ts:116` `formatIdentityBlock` | 代码那句身份块的统一拼装——真实装配与后台 `codeDefaults.identity.rendered` 共用它 |
| `src/core/prompt/defaults.ts:136` `resolveFallbackPrompt` | 按 channel > guild > global 挑 `fallback` 的内置默认；挑不到回 `DEFAULT_PROMPT` |
| `src/core/prompt/defaults.ts:149` `pickScopedTemplate` | 三层挑一份：命中第一层赢；层内含未知占位符或全空白当作没配、继续往下 |
| `src/core/prompt/defaults.ts:167` `previewPromptDefault` | `POST` 预览的渲染：空白正文回空串、`unknownVars` 只回报不拦 |
| `src/core/types.ts:162` `PromptDefaultEntry` | 一行：`key` / `scope` / `scopeId` / `content` / `updatedAt` |
| `src/core/types.ts:173` `PromptDefaultsScope` | 一层里的两块（`fallback` / `identity`，可为 `null`） |
| `src/core/types.ts:179` `PromptDefaults` | 三层的整体形状（`channel` / `guild` / `global`） |
| `src/core/ports.ts:42` `PromptDefaultsStore` | 存储端口：`get` / `list` / `put` / `remove` |
| `src/workers/db/d1-repository.ts:1217` 起 | `get` / `list` / `put` / `remove` 的 D1 实现（复合主键，最多 6 行） |
| `src/workers/http/app.ts:347` `PROMPT_DEFAULT_SCOPES` | 三个 scope 的枚举与顺序 |
| `src/workers/http/app.ts:350` `sortPromptDefaults` | `GET` 的排序（先 key 后 scope，最多 6 行） |
| `src/workers/http/app.ts:669` / `:695` / `:721` / `:735` | `GET` / `PUT` / `DELETE` / `POST preview` 四条路由与四类 400（§11、§45.5） |
| `src/core/chat/service.ts:319` `buildIdentityBlock` | 不再自己拼那句话，委托 `formatIdentityBlock`（§45.4） |
| `src/core/chat/service.ts:922` `readPromptDefaults` | 每轮读三层（读失败按三层全空继续） |
| `src/core/chat/service.ts:1080` | 装配前的调用点：三层在 `Promise.all` 里一次性读进来 |
| `src/core/chat/service.ts:1094` `resolveFallbackPrompt` | `fallback` 的三层解析（§45.3） |
| `src/core/chat/service.ts:1125` `pickScopedTemplate` | `identity` 的三层解析（§45.4） |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'preset-import-1'`（当时：酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层深度注入，原始 JSON 按层各存一行，§56；上一版 `context-tool-5` 撤掉强制 `tool_choice`、`context-tool-4` 已回退、`context-tool-3` 是上下文工具模式，见 §55；`reply-tool-3` 起把模型写在正文里的 `story_reply` 工具调用壳与成对的 `<game>` / `<game_content>` 包裹标签剥掉再发——壳与包裹标签都不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ 上一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string \| null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版 `'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`，方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，只记标签 / 字节数 / 字数 / mode / director，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（§47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（§47）；`'tts-mimo-1'` 那一版记在 §46.7；§33.9 记演进链 |
| `web/src/api.ts:1811` | 四条接口的类型与调用（`items` 最多 6 行、`unknownVars` 里不带花括号） |
| `web/src/pages/PromptsPage.tsx:633-701` | 「提示词」页顶部那张分层卡片：三层 tab、两块编辑区、500ms 防抖预览、只读「代码内置」 |
| `web/src/styles.css:1160` 起 | 那张卡片的样式（tab 与已配置状态点、预览区、警示色） |

- 本版只动这一张表：`0021` 就地升级 `prompt_defaults`，迁移总数 20 → 21；其余表（`0019` 及更早）都不动。
- 没有新环境变量、没有新 secret：两块模板都跟着数据库走。
- 门牌：§45 落地时是 `prompt-scope-1`（日志里看到 `build=prompt-scope-1` 才说明它在位）；§46 起是 `tts-admin-1`，§46.7 起是 `tts-mimo-1`，§47 起先是 `tts-style-1`（自然语言语气行 + `role:user` 消息），`tts-tags-1` 改成 assistant 正文开头的标签 + 正文逐字校验，这一版是 `voice-log-1`（语音发出后补一条成功日志：只记标签 / 字节数 / 字数 / mode（`director-4` 起 `rejected=` 之后还会带 judge 那一行的完整一行、不截断），正文绝不整段进日志，gateway 路径落 `runtime_logs` 的 level=info、scope=gateway），前一版 `tts-nolimit-1` 是朗读正文与试听都不再截字数、judge 输出上限 4000 那版，日志里看到 `build=reply-tool-3` 才说明这一版在位，§33.9 记演进链。
- 排错：提示词改了没生效，按 `docs/operations.md` §25.13 的顺序对号（哪一层命中、三层内置默认、身份块、读库失败）。

## 46. TTS 接口搬进后台（`tts-admin-1`；§46.7 加接口类型，`tts-mimo-1`；§47 加朗读语气，`tts-style-1`，`tts-tags-1` 改成标签 + 逐字校验，`tts-nolimit-1` 去掉字数上限，`voice-log-1` 补一条成功日志）

门牌在 §46 前进到 `tts-admin-1`（现已是更早的一版：更早依次是 `tts-mimo-1`、`tts-style-1`、`tts-tags-1`、`tts-nolimit-1`、`voice-log-1`，现在是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（297541§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，§49、§50；`preset-1` 是酒馆预设导入阶段一，§48），只动 TTS 这一条支线：语音合成接口的地址 / Key / 模型 / 默认音色从「只认服务器环境变量」改成「后台唯一来源」，后台新开一个独立「语音」页（原「回复」页的语音回复卡片搬过去）并带试听。指令模式那套提示词、语音回复的三档三层、朗读文本与失败策略一个字没改（§44）；正文、表情、摘要、落库也一个字没改。§46.7 是 `tts-mimo-1` 在这条支线上再补的一节：同一份配置多一个「接口类型」（dialect），可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`，迁移 `0023_tts_dialect.sql`（迁移总数 22 → 23）。

### 46.1 为什么改，定了哪三件事

env 时代（`voice-1` / `voice-2`）的三条痛点：

- **改一次要重启**（`tts-admin-1` 之前）：`VOICE_TTS_URL` 这类值只在进程启动时读一次，换端点要改 `.env`、重启 Node 宿主；托管在 Cloudflare 上还要 `wrangler secret put` 再等实例驱逐。
- **Key 明文躺在 `.env`**：谁有部署机权限谁就能看到 key，没有审计、没有掩码。
- **地址错了只能看日志**：后台没有任何地方显示「现在连的是谁」，配错只能等一条 `[voice] 语音发送失败 …`。

三条决定：

1. **后台是唯一来源**：四个环境变量那一版起完全不生效（部署脚本里留着空占位也无害，后台会提示可以删），代码里的 `createEnvTts` 已删除。
2. **加密入库、只回掩码**：Key 用 AES-256-GCM 加密后进库（沿用 `provider_keys` 的 secretbox，主密钥仍是 `KEY_ENCRYPTION_SECRET`），接口只回 `keyHint`（规则 `'…' + 末 4 位`，与 `provider_keys` 同一个 `maskKeyHint`）。
3. **留空不改**：编辑时 Key 留空 = 保留原密文与掩码；首次必须给 Key。

### 46.2 存储与迁移

`migrations/0022_tts_settings.sql` 建单行表（迁移总数 21 → 22），`migrations/0023_tts_dialect.sql` 再加一列 `dialect`（22 → 23；这个迁移只有三行，逐字见 §46.7）：

| 列 | 含义 |
| --- | --- |
| `id` | `INTEGER PRIMARY KEY CHECK (id = 1)`——只有一行 |
| `dialect` | `TEXT NOT NULL DEFAULT 'openai' CHECK (dialect IN ('openai', 'mimo'))`（`0023` 加）——老行自动是 `openai`，行为与升级前一致 |
| `url` | 端点基址：`openai` 方言请求 `POST {url}/audio/speech`，`mimo` 方言请求 `POST {url 去尾斜杠}/chat/completions`（§46.7） |
| `key_sealed` | AES-256-GCM 密文 |
| `key_hint` | 掩码，只读给人看 |
| `model` | **历史列**（`tts-style-1` 起不再是可写字段）：老值原样留着、不覆写，读侧一律忽略，按接口类型取内置默认——`openai` 是 `tts-1`，`mimo` 是 `mimo-v2.5-tts`（§47.1） |
| `voice` | 空白 = 请求里不带这个字段，用服务端默认音色 |
| `updated_at` | 最后修改时间 |

- **未配置**的判定：没有行 / `url` 空 / `key` 空——任一成立即未配置。
- Key 用 AES-256-GCM 加密入库（沿用 `provider_keys` 的 secretbox，主密钥还是 `KEY_ENCRYPTION_SECRET`），接口只回 `keyHint`：规则与 `provider_keys` 同一个 `maskKeyHint`（`…` + 末 4 位，:482），明文只在进程内存里用到发出的那一刻。
- `model` 列自 `tts-style-1` 起只留历史值：`GET` 不再返回、`PUT` 与试听收到 `model` 静默忽略、合成侧不读（§47.1）；`voice` 空白表示不带该字段，用服务端默认音色。
- `dialect` 的读侧兜底：`get` 的 `SELECT` 带上这一列（`src/workers/db/d1-repository.ts:1301`），列值不是 `mimo` 就当 `openai`（`:1307`）——库里就算有脏值，也不会把请求发成另一种形状。
- `put` 省略 `dialect` 时沿用旧行的方言，旧值为空按 `openai`（`:1322-1326`）；`INSERT … ON CONFLICT` 一并写 `dialect`（`:1330-1344`）。

### 46.3 四条路由与错误码

鉴权与其它 `/api` 相同（没 cookie 就 401）。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/tts-settings` | — | `{configured, dialect, url, keyHint, voice, updatedAt, defaults, envPresent, judgeUrl, judgeKeyHint, judgeModel, judgeConfigured}`（`defaults` 形状见下；自 `tts-style-1` 起**不再有 `model`**，多出 judge 四项，`:1296`） |
| PUT | `/api/tts-settings` | `{url?, dialect?, key?, voice?, judgeUrl?, judgeKey?, judgeModel?}` | 200 回写后的视图；400 `BAD_TTS_URL` / `BAD_TTS_DIALECT` / `BAD_TTS_KEY` / `BAD_TTS_JUDGE` / `BAD_REQUEST`（收到 `model` 静默忽略，`:1334`） |
| DELETE | `/api/tts-settings` | — | `{ok:true}`（删整行 = 未配置） |
| POST | `/api/tts-settings/test` | `{url?, dialect?, key?, voice?, text?, style?}` | 200（多一个 `styleUsed`）/ 400 / 502，见下 |

- `defaults` 的形状（`src/workers/http/app.ts:1261-1268`）：`{urlPlaceholder, voices, dialects:[{id, label, urlPlaceholder, voices}, …], defaultDialect:'openai'}`——`dialects` 就是两种方言的候选，`openai` 的标签是「OpenAI 兼容（/audio/speech）」、`mimo` 的标签是「小米 MiMo（chat/completions）」，每项带自己的地址占位与音色表；模型不出现在候选里（内置在 core，§46.7）。顶层 `urlPlaceholder` / `voices` 是老字段（等于 `openai` 那份），老前端不炸；当前方言在响应顶层的 `dialect`。
- 视图里的 `dialect` 是 `stored?.dialect ?? 'openai'`（`app.ts:1262`）——从没配过就是 `openai`。
- `envPresent` 只表示「服务器还留着非空的 `VOICE_TTS_URL` 或 `VOICE_TTS_KEY`」，**只用于提示**，不参与取值。
- `PUT` 的校验顺序是 url → dialect → key → model/voice（`app.ts:1288-1297`）：`url` 必须非空、http/https、≤500，否则 400 `BAD_TTS_URL`；`dialect` 给了就必须是 `openai` / `mimo` 之一，否则 400 `{error:'BAD_TTS_DIALECT'}`，**省略 = 不改**（沿用库里已存的方言）；`key` 给了就必须非空且 ≤500，没给且库里也没有 → 400 `BAD_TTS_KEY`（给了就重新加密并重算掩码；没给但库里有 = 保留原密文与掩码）；`model` 静默忽略（`:1334`）、`voice` ≤100 超长 400 `BAD_REQUEST`；judge 三字段类型错 400 `BAD_TTS_JUDGE`（`:1339-1342`），`judgeUrl` ≤500 且必须 http(s)、`judgeKey` ≤500、`judgeModel` ≤100（`:1347-1364`）；空白 trim 后按空串存。judge 三字段的省略 / 清空规则见 §47.4。
- `DELETE` 删的是整行，删完就是「未配置」。
- `POST /api/tts-settings/test` 不落库：缺省用库里已存的值，`dialect` 可选——非法回 400 `BAD_TTS_DIALECT`，缺省用库里已存的方言（`app.ts:1378-1500`）；`key` 缺省用解密值；`text` 缺省固定「你好，我是示例机器人，这是一段语音测试。」，**试听也不设字数上限**（只 `trim`，不再按字数截断）。
  - 200 `{ok:true, bytes, durationMs, contentType:'audio/mpeg', audioBase64}`
  - 没有可用 url 或 key → 400 `{ok:false, code:'TTS_NOT_CONFIGURED', message}`
  - 上游报错或超时（30 秒）→ 502 `{ok:false, code:'TTS_UPSTREAM', message, durationMs}`
  - 试听与运行时走同一条路：先 `ttsConfigFrom` 再 `createTts`（§46.4），所以试听能通、运行时也走同一套方言分派。

### 46.4 运行时

- 每条消息在**读语音回复设置那一带**现读一次 TTS 配置（`src/workers/gateway/engine.ts:690-705`），再用 `ttsConfigFrom` 拼配置、`createTts` 按方言分派：`openai` 方言发 `POST {url}/audio/speech`（`src/core/voice/tts.ts:163`），`mimo` 方言发 `POST {url 去尾斜杠}/chat/completions`（`tts.ts:223`）。
- `ttsConfigFrom`（`tts.ts:42`）的规则：`url` 或 `key` 空白 → 返回 `null`（等于未配置）；`dialect` 不是 `mimo` 一律当 `openai`；库里 `model` 列**一律忽略**，恒用内置默认（`DEFAULT_MODEL`，`tts.ts:35`）；`voice` 非空才挂。
- `openai` 方言的 body 与以前逐字一致：`{model, input, response_format:'mp3', speed: speed/100}`；`mimo` 方言是 `{model:'mimo-v2.5-tts', messages:[{role:'assistant', content:'要念的文字'}], audio:{format:'mp3', voice?}}`——**没有 `speed`**，选 MiMo 时语速设置不生效（§46.7）。
- `mimo` 的音频在响应 JSON 的 `choices[0].message.audio.data`（base64，`readMimoAudioData`，`tts.ts:146`），用 `tts.ts:131` 手写的 `decodeBase64` 解——不用 `Buffer`，因为 `src/core` 要跑在 workerd。
- 超时一律 `TTS_TIMEOUT_MS = 30_000`（`tts.ts:98`）；错误文案三类：`TTS_HTTP <status>: <正文前 200 字>`、`TTS_BAD_RESPONSE: …`、`TTS_REQUEST_FAILED: …`。
- 读不到或未配置就用「合成即抛」的占位实现；读库失败只 `warn` 并按未配置继续——语音是附加项，**绝不让这一轮回复失败**（日志形如 `读取语音合成配置失败，本轮不发语音：…`）。
- 后台改完**下一条消息就生效**，进程里不缓存明文：`createStoredTts`（`tts.ts:60`）每次合成现读库。
- 斜杠命令 `/voice` 走同一个「现读配置」的实现（`src/workers/index.ts:215`）。
- 试听与运行时同一个超时口径：**30 秒**。

### 46.5 后台与试听

- 「语音」页是独立页签，排在「回复」之前（`web/src/App.tsx:13` / `:24` / `:37` / `:96`）。
- 一页三张卡，分工固定：最上面「语音合成接口」（接口类型 / 地址 / Key / 默认音色 + 保存、清除、试听；模型输入框自 `tts-style-1` 起删除、换成「情绪判断模型（可选）」的地址 / Key / 模型三字段，`web/src/pages/VoicePage.tsx:525-656`，judge 段在 `:595-643`）、中间「语音回复」（三档 `mode` + 三层 scope + 音色 + 语速，`:658-760`，自 `tts-admin-1` 起未动）、最下面「朗读语气」（层级切换 + textarea + 字数 + 保存 / 恢复默认 / 已配置层逐条删除，`:762-826`，`tts-style-1` 新增，§47.5）。
- 「接口类型」是个下拉，选项来自 GET 的 `defaults.dialects` 的 label；切类型只换地址 placeholder 与音色 datalist，**不覆盖用户已填的内容**。模型输入框在 `tts-style-1` 已删除（模型由接口类型唯一决定），换方言不需要跟着改模型。
- 选 MiMo 时提示「MiMo 不支持语速，此项不生效」并压暗语速输入框——这不是前端臆测，MiMo 的请求形状里确实没有这个参数（§46.7）。
- 中间是原来「回复」页搬过来的「语音回复」卡片：三档 `mode`、三层 scope、音色、语速，行为不变（`VoicePage.tsx:658-760`）。
- 最下面「朗读语气」卡片按 channel / guild / global 切换，一层一行提示词（≤2000 字）、保存即覆盖、`trim` 空即删这一层；试听结果里有 `styleUsed` 时在「{bytes} 字节 / {durationMs} ms」后面追加「· 语气：…」。**试听只取 global 层 + 库里的 judge**，频道层与服务器层不参与（§47.5）。
- 状态条显示「已配置（掩码）」或「未配置：语音回复不会发出声音」；`envPresent` 为真时多一行提示「服务器还留着 `VOICE_TTS_*` 环境变量，这一版只认后台配置，可以删掉」。
- 试听把表单已填的字段发过去（Key 留空就用已存的；接口类型会带上当前选中的方言，空字段仍省略），成功后把返回的 base64 转 Blob 直接播放，并显示「{bytes} 字节 / {durationMs} ms」；失败按 `TTS_NOT_CONFIGURED` / `TTS_UPSTREAM` / `BAD_TTS_URL` / `BAD_TTS_DIALECT` / `BAD_TTS_KEY` / `BAD_REQUEST` 给中文原因。

### 46.6 代码地图

| 位置 | 作用 |
| --- | --- |
| `migrations/0022_tts_settings.sql` | 单行表 `tts_settings`（§46.2）；21 → 22 |
| `migrations/0023_tts_dialect.sql` | 加 `dialect` 列（三行迁移，第 3 行是 `ALTER TABLE tts_settings ADD COLUMN dialect TEXT NOT NULL DEFAULT 'openai' CHECK (dialect IN ('openai', 'mimo'));`）；22 → 23，23 个迁移之末（§46.7） |
| `src/core/types.ts:405` | `TtsDialect = 'openai' | 'mimo'` |
| `src/core/types.ts:408` / `:425` / `:438` | `TtsSettingsSecret.dialect`（含密文）、`TtsSettingsView.dialect`（只含掩码）、`TtsSettingsInput.dialect?`（省略 = 不改） |
| `src/core/ports.ts:206-216` | `TtsSettingsStore`：`get` / `put` / `remove` |
| `src/core/voice/tts.ts:35` | `DEFAULT_MODEL = { openai: 'tts-1', mimo: 'mimo-v2.5-tts' }` |
| `src/core/voice/tts.ts:42` | `ttsConfigFrom`：视图 → 客户端配置（`url` / `key` 空白返回 `null`，`dialect` 非 `mimo` 一律 `openai`，库里 `model` 列一律忽略、恒用内置默认，`voice` 非空才挂） |
| `src/core/voice/tts.ts:60` | `createStoredTts`：每次合成现读库；`createEnvTts` 已删除 |
| `src/core/voice/tts.ts:85` | `TtsConfig`：`{dialect?, url, key, model, voice?, fetchImpl?}` |
| `src/core/voice/tts.ts:98` | `TTS_TIMEOUT_MS = 30_000` |
| `src/core/voice/tts.ts:106` / `:102` | `speechUrl`（`/audio/speech`）/ `chatCompletionsUrl`（去尾斜杠 + `/chat/completions`） |
| `src/core/voice/tts.ts:131` | `decodeBase64`：手写 atob，不用 `Buffer`（core 要跑在 workerd） |
| `src/core/voice/tts.ts:146` | `readMimoAudioData`：取 `choices[0].message.audio.data` |
| `src/core/voice/tts.ts:163` / `:207` / `:283` | `createOpenAiTts` / `createMimoTts` / `createTts` 按方言分派 |
| `src/workers/db/d1-repository.ts:503` | `maskKeyHint`（与 `provider_keys` 同一个函数） |
| `src/workers/db/d1-repository.ts:524-525` | `repositories` 里的 `ttsSettings` / `ttsStyles` |
| `src/workers/db/d1-repository.ts:1318-1412` | store 实现：`get` 的 `SELECT` 带 `dialect`（`:1322`）、脏值兜底成 `openai`（`:1331`）；`put` 省略 key 保留旧密文、省略 `dialect` 沿用旧行（`:1344` 起）、`INSERT … ON CONFLICT` 带 `dialect`（`:1388`）；`remove` 删 `id = 1`（`:1410`） |
| `src/workers/http/app.ts:147` / `:148` / `:150` / `:152` / `:173` / `:176` | `TTS_URL_PLACEHOLDER`（`https://api.openai.com/v1`）/ `TTS_VOICES`（六项）/ `TTS_MIMO_URL_PLACEHOLDER`（`https://api.xiaomimimo.com/v1`）/ `TTS_MIMO_VOICES`（九项，含中文音色）/ `TTS_DEFAULT_DIALECT = 'openai'` / `TTS_DIALECTS`（两种方言各带 id、label、urlPlaceholder、voices——模型内置在 core，这里没有 model 常量） |
| `src/workers/http/app.ts` | `deps.ttsSettings` 与 `ttsEnvPresent`（只看环境变量在不在，用于提示） |
| `src/workers/http/app.ts:620` / `:631` / `:636` | `isHttpUrl`、`normalizeTtsField`、`encodeBase64`——`clipTtsText` 与 `TTS_MAX_TEST_TEXT_CHARS` 已删（试听不再按字数截断） |
| `src/workers/http/app.ts:1250-1251` | `ttsDefaults` 增 `dialects` 与 `defaultDialect`（顶层 `model` / `urlPlaceholder` / `voices` 仍等于 `openai` 那份） |
| `src/workers/http/app.ts:1262` | `ttsView.dialect = stored?.dialect ?? 'openai'` |
| `src/workers/http/app.ts:1288-1297` | PUT 校验 url → dialect（400 `BAD_TTS_DIALECT`）→ key → model/voice |
| `src/workers/http/app.ts:1331-1390` | `POST /api/tts-settings/test`：可选 `dialect`，缺省用库里已存方言，走 `ttsConfigFrom` + `createTts` |
| `src/workers/http/app.ts:1199` / `:1217` / `:1219` / `:1257` | `ttsView`、`GET`、`PUT`、`DELETE` |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'preset-head-1'` |
| `src/workers/gateway/engine.ts:690-705` | 每轮 `repos.ttsSettings.get()` → `ttsConfigFrom` → `createTts`；读库失败只 warn「读取语音合成配置失败，本轮不发语音：…」 |
| `src/workers/gateway/engine.ts:740` | `maybeSendVoice`：文字回复之后那一步 |
| `src/workers/index.ts:84-89` / `:140-145` / `:215` / `:250-251` | `Env`、`legacyTtsEnvPresent`、斜杠命令 `/voice`、admin deps |
| `src/node/main.ts:147-152` / `:197` / `:221-222` | 自托管宿主的同一套接线 |
| `web/src/pages/VoicePage.tsx:348` / `:349-431` / `:432-533` | 页面根、TTS 卡片（含「接口类型」下拉与 MiMo 语速提示）、语音回复卡片 |
| `web/src/api.ts` 的 TTS 段 | `TtsDialect` / `TtsDialectOption` / `defaults.dialects` / `defaultDialect` / `snapshot.dialect` / `input.dialect` 与 `BAD_TTS_DIALECT` 文案 |
| `web/src/styles.css:1361` 起 | 这一页的样式 |

- 迁移总数 21 → 22 → 23 → 24：`0022` 只有一张新表、`0023` 只加一列 `dialect`、`0024` 给 `tts_settings` 加四列 judge 并新建 `tts_style_prompts`，其它表都不动（§47.2）。
- 门牌 `voice-log-1`：日志里看到 `build=voice-log-1` 才说明这一版在位（§33.9 记演进链）；`tts-nolimit-1` 是前一版（朗读不再设字数上限），`tts-tags-1` 是再前一版（assistant 正文开头的标签 + 正文逐字校验），`tts-style-1` 是更早的（自然语言语气行 + `role:user`），`tts-mimo-1` 是更早的接口类型那版、`tts-admin-1` 再早，§46 开头的三件事与四条路由都是 `tts-admin-1` 那一版立下的。
- 排错：语音没声音按 `docs/operations.md` §25.14 的顺序对号（状态条 → 试听 → 400 / 502 → 接口类型选错 → mode → 日志）。

### 46.7 接口类型（dialect）与第二种上游

门牌 `tts-mimo-1`（现已是更早的一版；再往前依次是 `tts-style-1`、`tts-tags-1`、`tts-nolimit-1`、`voice-log-1`，现在是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（309860§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，§49、§50；`preset-1` 是酒馆预设导入阶段一，§48）。§46 那一版把「连谁」搬进了后台，但配置里只有一种形状：OpenAI 兼容的 `POST {url}/audio/speech`，mp3 直接在响应体里。小米 MiMo 的语音合成走另一条路——`POST {url}/chat/completions`，要念的文字当成一条 `assistant` 消息，音频以 base64 藏在响应 JSON 里。两种形状不通用：把 MiMo 的地址填进旧配置，请求会按 `/audio/speech` 发出去，只会拿到 404 / 400；把 OpenAI 的 key 发给 MiMo 的路径，同样过不了鉴权。所以配置里必须多一个「接口类型」——它只回答一件事：这份地址 / key 是哪家形状，而不是让代码去猜。

- 迁移 `migrations/0023_tts_dialect.sql` 只有三行，第 3 行是：

  ```sql
  ALTER TABLE tts_settings ADD COLUMN dialect TEXT NOT NULL DEFAULT 'openai' CHECK (dialect IN ('openai', 'mimo'));
  ```

  老行自动拿到 `openai`，行为与升级前逐字一致；迁移总数 22 → 23（`test/node.migrate.test.ts` 的期望值也改成 23）。

- 两种请求形状逐字对照：

| 项 | `openai` 方言（默认） | `mimo` 方言 |
| --- | --- | --- |
| 路径 | `POST {url}/audio/speech`（`tts.ts:106`） | `POST {url 去尾斜杠}/chat/completions`（`tts.ts:111`） |
| 鉴权 | `Authorization: Bearer <key>` | 同左 |
| body | `{ model, input, voice?, response_format: 'mp3', speed: speed / 100 }`（`tts.ts:163`） | `{ model: 'mimo-v2.5-tts', messages: [{ role: 'assistant', content: '要念的文字' }], audio: { format: 'mp3', voice? } }`（`tts.ts:223`） |
| 音频在哪 | 响应体就是 mp3 字节 | 响应 JSON 的 `choices[0].message.audio.data`（base64；`tts.ts:146` 取、`tts.ts:131` 解） |
| speed | 有：语音回复设置的 50–200 百分比 ÷ 100 | **没有这个参数**——选 MiMo 时语速设置不生效，后台会提示 |
| 默认模型 | `tts-1` | `mimo-v2.5-tts` |
| 内置音色 | `alloy` / `echo` / `fable` / `onyx` / `nova` / `shimmer` | `mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean |

- 常量与类型：`app.ts:148` `TTS_URL_PLACEHOLDER = 'https://api.openai.com/v1'`、`:149` `TTS_VOICES`（六项）、`:151` `TTS_MIMO_URL_PLACEHOLDER = 'https://api.xiaomimimo.com/v1'`、`:153` `TTS_MIMO_VOICES`（九项，含中文音色）、`:174` `TTS_DEFAULT_DIALECT = 'openai'`、`:177` `TTS_DIALECTS`、`:196` `TTS_TEST_TEXT`（试听缺省文案）（`openai` 的标签是「OpenAI 兼容（/audio/speech）」、`mimo` 是「小米 MiMo（chat/completions）」，每项只有 `id` / `label` / `urlPlaceholder` / `voices`——模型内置在 core，没有 model 常量）；类型在 `src/core/types.ts:405` `TtsDialect`、`:408` / `:425` / `:438`；`tts.ts:35` `DEFAULT_MODEL = { openai: 'tts-1', mimo: 'mimo-v2.5-tts' }`、`:42` `ttsConfigFrom`（url 或 key 空白返回 `null`、`dialect` 非 `mimo` 一律 `openai`）、`:60` `createStoredTts`（每次合成现读库）、`:85` `TtsConfig`、`:98` `TTS_TIMEOUT_MS = 30_000`；运行时 `engine.ts:129` `GATEWAY_BUILD = 'preset-head-1'`、`:690-705` 每轮现读配置再拼客户端。错误文案三类：`TTS_HTTP <status>: <正文前 200 字>`、`TTS_BAD_RESPONSE: …`、`TTS_REQUEST_FAILED: …`。
- GET 的 `defaults` 多出 `dialects`（两种方言的候选，每项 `{value, label, model, urlPlaceholder, voices}`）与 `defaultDialect`（`'openai'`），顶层老字段保留（§46.3）；`snapshot.dialect` 就是这一行现在的方言。
- PUT 的 `dialect` **省略 = 不改**（沿用库里已存方言，旧值为空按 `openai`）；试听的 `dialect` 省略 = 用库里已存方言。两处给了不认识的方言都是 400 `BAD_TTS_DIALECT`（`app.ts:1288-1297` / `:1331-1390`）。
- 写侧挡一次、读侧再挡一次：`put` 落库前校验 `dialect ∈ {openai, mimo}`；`get` 读出来不是 `mimo` 就当 `openai`（`d1-repository.ts:1307`），所以就算库里被外部写进脏值，也只会退回默认方言，不会把请求发成另一种形状。
- 运行时没有第二套代码路径：`ttsConfigFrom` 拼出 `TtsConfig`（含 `dialect`），`createTts`（`tts.ts:310`）分派到 `createOpenAiTts` 或 `createMimoTts`；读库失败、未配置的降级行为与 §46.4 完全一样。
- 后台：TTS 卡片的「接口类型」下拉切换只换地址 / 模型 placeholder 与音色 datalist，不覆盖已经填好的内容；模型输入框在 `tts-style-1` 起已删除（按接口类型取内置默认）；选 MiMo 时语速输入框压暗并提示「MiMo 不支持语速，此项不生效」（§46.5）。
- 排错：接口类型选错的最典型现象是 **502**——上游按另一种形状解析不开；报 `BAD_TTS_DIALECT` 则是后台传了不认识的方言值（`docs/operations.md` §25.14）。

## 47. 朗读语气与情绪判断（`voice-log-1` 起；`director-1` 加导演模式；`director-2` 补导演模式的可观测性；`director-3` 补判断超时预算与 `judge` 退回原因；`director-4` 把 judge 那一行带进日志与试听；`director-5` 把导演档的提示词改成正文逐句语气标签、唱歌只在整体风格组标一次 `(唱歌)`；前一版 `director-6` 只把诊断用的 judge 行从截断改成完整一行（日志 `judge=` 段与试听 `judgeLine` 都不再截断，念法与迁移都没动））

门牌在 §47 里从 `director-2` 一路到前一版 `director-6`，现在是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（314141§54）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，§49、§50；`src/workers/gateway/engine.ts:129`，`test/gateway.node.test.ts:229` 同步；`preset-1` 是酒馆预设导入阶段一，§48），**`director-1` 那一版补了一枚新迁移**：`migrations/0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0;`），迁移总数 25（首启 `applied=25 skipped=0`，从 24 升上来 `applied=1 skipped=24`，见 §47.2、§47.8）。这一版加的是**导演模式**：judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director`（`0` 关闭（逐字朗读）/ `1` 只插标签 / `2` 允许顺句改写）按频道 / 服务器 / 全局三层各存一行，后台「语音」页多一个「导演模式」下拉（§47.8）。语音那条成功日志也顺势多一个 `director=<0|1|2>` 字段，tag 优先取风格组、字数按真正送进合成的文本算（§44.3、§47.7）。前一版 `voice-log-1` 才补的成功日志：语音真的发出去之后写一行 `[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2>`，标签为空写 `tag=无`，只记标签、字节数、字数与 mode，正文绝不整段进日志（§19.1；`director-4` 起 `rejected=` 之后多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查），出口是 `logInfo`、gateway 路径落 `runtime_logs`（level=info、scope=gateway）、Discord 交互路径只进控制台（§44.3、§47.7）。再前一版 `tts-nolimit-1` 只去掉字数上限：朗读正文（`toSpeechText`）与后台试听都不再按字数截断，`JUDGE_MAX_TOKENS` 从 1200 提到 4000（§44.3、§46.3、§47.7）。

`tts-tags-1` 把朗读语气从「**一行自然语言指令作为 `role:user` 消息**」换成「**assistant 正文开头的标签 + 正文逐字校验**」：标签长在要念的正文最前面（形如 `(怅然)今天的风有点凉。`），judge 抄回来的正文与原文逐字比对，对不上就只保留标签、正文用原文；MiMo 只再收一条 `assistant` 消息，不再发 `user`。这一版不改形状，只把字数上限拿掉：正文念多长由上游决定，试听也不再按字数截断。再前一版是 `tts-style-1`（自然语言语气行 + `user` 消息），更早是 `tts-mimo-1`（§46.7）。

正文、表情、摘要、落库、语音回复的三档三层一个字没改（§44），地址 / Key / 方言那套还是 §46 的，「模型不再可写、按接口类型取内置默认」与三层 `tts_style_prompts` 也照旧（§47.1、§47.2）。

### 47.1 三个决定（沿用）与这一版的修正

`tts-mimo-1`（§46.7）把「接口类型」暴露给后台之后，留下两个具体问题：

- **模型是个多余的自由度**：`openai` 方言只认 `tts-1`、`mimo` 方言只认 `mimo-v2.5-tts`，而这个字段能填的值其实由接口类型唯一决定——留着输入框，只是让人有机会把一种方言的模型名填到另一种方言里，然后拿到 400 / 502。
- **声音永远一个腔调**：TTS 只念字，念不出「这句该轻快还是该沉」；客服频道与整活频道用的是同一种语气。

三个决定：

1. **模型不再暴露**：`ttsConfigFrom`（`src/core/voice/tts.ts`）忽略库里 `model` 列，按接口类型取内置默认（`openai` → `tts-1`，`mimo` → `mimo-v2.5-tts`）；`GET /api/tts-settings` 不再返回 `model`，`PUT` 与 `POST /api/tts-settings/test` 收到 `model` **静默忽略**；库里 `model` 列保留旧值、不覆写，合成侧不读它。
2. **朗读语气按三层存**（新表 `tts_style_prompts`，`channel` > `guild` > `global`）：与 §38 / §41 / §45 同一个口径，第一个 `trim` 非空的层赢；一层只有一行，写就是覆盖。
3. **情绪判断模型是可选件，而且是另一把 Key**：配了才调（`judge_url` / `judge_key_sealed` / `judge_key_hint` / `judge_model` 四列），没配就把提示词原文当风格标签；它的密钥与合成用的 Key 分开存、不共用环境变量。

`tts-tags-1` 改的是第 3 条的**产出形状**：judge 不再写「一行中文语气指令」，而是把标签写在正文最前面抄回来（`(怅然)原文`），由 `applyJudgeLine`（`style.ts:249`）做逐字校验后决定标签留不留（§47.7）；这一版不改形状，只把 judge 的输出上限提到 4000，好让长正文整段抄回来。

### 47.2 迁移：0024 是语气那版的最后一枚，导演模式补了 0025

`migrations/0024_tts_style.sql` 只有 15 行，是这一串的最后一个（迁移总数 24），做两件事：

- 给 `tts_settings` 加四列 `judge_url` / `judge_key_sealed` / `judge_key_hint` / `judge_model`，都是 `TEXT NOT NULL DEFAULT ''`——老行自动是空串，等于「没配情绪判断模型」，行为与升级前逐字一致。
- 新建 `tts_style_prompts`：`scope TEXT NOT NULL CHECK (scope IN ('channel', 'guild', 'global'))`、`scope_id TEXT NOT NULL DEFAULT ''`、`content TEXT NOT NULL`、`updated_at TEXT NOT NULL`、`PRIMARY KEY (scope, scope_id)`——写入用 `ON CONFLICT(scope, scope_id) DO UPDATE`，与 §45 的 `prompt_defaults` 一样「一层一行」，`scope_id` 空串代表 `global`。

`voice-log-1` **也没有新增迁移**：成功日志全在应用层（`src/workers/discord/voice-reply.ts` 的 `logInfo` 出口与 `src/workers/gateway/engine.ts` 的 `#logGateway` 接线），库结构一个字没动，`0024` 是那一版的最后一个（导演模式补了 `0025`，见下）。

`tts-nolimit-1` **没有新增迁移**：去字数上限全在应用层（`src/core/voice/speech-text.ts` 的 `toSpeechText` 不再截断，`app.ts` 的试听只 `trim`，`style.ts` 的 `JUDGE_MAX_TOKENS` 提到 4000），库结构一个字没动，`0024` 是那一版的最后一个（导演模式补了 `0025`，见下）。

`director-1` **补了一枚新迁移**：`migrations/0025_director_mode.sql` 只有一行 `ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0;`（迁移总数 25）——老行自动是 `0` = 关闭，行为与上一版逐字相同，所以不加 `CHECK`；读侧 `isVoiceDirector` 把脏值落回 `0`（`src/core/voice/settings.ts:15`）。首启 `applied=25 skipped=0`，从 24 个迁移升上来 `applied=1 skipped=24`；`director-2` / `director-3` / `director-4` / `director-5` / `director-6` 都没有新增迁移；`preset-1` 才加 `0026_prompt_presets.sql`（那一版迁移总数 26）；`preset-2` 又加 `0027_route_sampling.sql` 与 `0028_prompt_injections.sql`，迁移总数 28（§49、§50）；`preset-3` 再加 `0029_world_books.sql`，迁移总数 29（§51、§48.7）；`preset-4`（前一版）没有新迁移，仍是 29（§48.8）；`identity-head-1` 没有新迁移，仍是 29（§52）；`preset-head-1` 也没有新迁移，仍是 29（§52）。

### 47.3 解析与合成链

- **取提示词**：`resolveStylePrompt`（`src/core/voice/style.ts:149`）按 channel → guild → global 取第一个 `trim` 非空的层；三层都空就是「这一轮没有语气」。上限 `TTS_STYLE_MAX_CHARS = 2000`（`style.ts:5`），写侧挡、读侧不再截。
- **判断情绪**：`composeVoiceSpeech`（`style.ts:385`）——`isJudgeConfigured`（`:133`）为假时直接回「标签 = `normalizeStyleTag(提示词)`（`:199`）、正文 = 原文」；配了就把 `JUDGE_SYSTEM`（`:53`，要求只输出一行 `(标签)原文`、正文逐字相同、只能插 `[音频标签]`）与「\n【风格要求】」拼成 system，`POST trimTrailingSlash(url)+'/chat/completions'`，`max_tokens` 4000（`JUDGE_MAX_TOKENS`，`:46`）、`temperature` 0.4（`JUDGE_TEMPERATURE`，`:47`）、超时按字数给预算（`judgeTimeoutMs`，`:38-40`：15 秒起步 + 每字 40 毫秒、封顶 45 秒，前一版是固定 `JUDGE_TIMEOUT_MS = 8000`，§47.8）；只取第一行（`readJudgeContent`，`:348`）并成对剥引号；`applyJudgeLine`（`:249`）给出四种结局（§47.7）；最后还有一道 `stripVoiceTags` 一致性保险（`:227`）；非 2xx、内容为空、超时、任何异常都 `catch` 回兜底——**永不抛**。
- **合成**：`TtsPort.synthesize` 的入参是 `tag`（`src/core/voice/tts.ts:11`）。`mimo` 方言只发一条 messages：`[{ role: 'assistant', content: tag === '' ? text : tag + text }]`（`:243-244`）——没有标签时 content 就是正文；`openai` 方言**主动忽略** `tag`，`/audio/speech` 请求体不变（没有这个入口，塞进去只会被上游当未知字段）。
- **时机**：`src/workers/discord/voice-reply.ts` 是「确认要发语音之后」才取提示词（`:21`）再判断（`:23`）：`:36-44` 的发送条件一个字没变；提示词读失败只 `console.warn`（`:50-55`）；判断失败、合成失败同样只 `warn`，兜底都是「无标签 + 原文」（`:58-73`）。**任何一环失败都只是「没有语气」，语音照发**。

### 47.4 四条路由与错误码

鉴权与其它 `/api` 相同（没 cookie 就 401）。四条路由：`GET` / `PUT` / `POST test` 三条挂在 `/api/tts-settings` 上，语气自己一对 `GET` / `PUT` / `DELETE /api/tts-style`。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/tts-settings` | — | `{configured, url, keyHint, voice, dialect, updatedAt, defaults, envPresent, judgeUrl, judgeKeyHint, judgeModel, judgeConfigured}`（`app.ts:1297`；**不再有 `model`**） |
| PUT | `/api/tts-settings` | `{url?, dialect?, key?, voice?, judgeUrl?, judgeKey?, judgeModel?}` | 200 回写后的视图；400 `BAD_TTS_URL` / `BAD_TTS_DIALECT` / `BAD_TTS_KEY` / `BAD_TTS_JUDGE` / `BAD_REQUEST`（`app.ts:1299`，judge 校验 `:1342-1363`） |
| POST | `/api/tts-settings/test` | `{url?, dialect?, key?, voice?, text?, style?}` | 200 `{ok, bytes, durationMs, contentType, audioBase64, styleUsed, speechUsed}` / 400 / 502（`app.ts:1385`、`:1455-1492`） |
| GET / PUT / DELETE | `/api/tts-style` | `GET` 无参；`PUT {scope, scopeId?, content}`；`DELETE ?scope=&scopeId=` | `GET` 回 `{items, maxChars: 2000}`；`PUT` 回 `{ok:true}` 或 `{ok:true, removed:true}`（`app.ts:1509` / `:1514` / `:1534`） |

- **PUT 的顺序**：仍是 url → dialect → key → voice / judge（`app.ts:1299`）。`model` 静默忽略（不报错、不落库）；judge 三字段类型错（不是字符串这类的）→ 400 `BAD_TTS_JUDGE`（`:1342-1352`）；`judgeUrl` ≤500 且必须 http(s)、`judgeKey` ≤500、`judgeModel` ≤100（`:1358-1363`）。
- **judge 三字段的省略 / 清空**：省略 `judgeUrl` / `judgeModel` = 保留旧值；显式空串 = 清掉这一项；`judgeKey` 空白 = 保留旧密钥（掩码不变），想换就填新的。
- **试听的 `style` 是标签，不是自然语言指令**（`app.ts:1455-1492`）：body 里的 `style` 按 `normalizeStyleTag`（`style.ts:199`）归一化成标签，**正文一个字不动**（`speechUsed` = 传进来的 `text`）；超 2000 字 → 400 `BAD_TTS_STYLE`（`:1407`）。不带 `style` 时按 **global 层**提示词 + 库里 judge 走一次 `composeVoiceSpeech`，`speechUsed` = 最终念的正文、`styleUsed` = 带括号的标签或 `null`——**没有标签也照发**。试听**不落库**；judge 密钥只来自库里，试听接口不接受临时 judge 密钥。
- **`/api/tts-style` 三条**：`GET` 回 `items`（每层一行：`scope` / `scopeId` / `content` / `updatedAt`）与 `maxChars = 2000`；`PUT` 的 `content` 非字符串或超 2000 → 400 `BAD_TTS_STYLE`（`:1523`），`trim` 后为空 = **删这一层**、回 `{ok:true, removed:true}`；`DELETE` 按 `?scope=&scopeId=` 删一层。`scope` 不是 `channel` / `guild` / `global` → 400 `BAD_SCOPE`（`:1518` / `:1536`），频道层 / 服务器层没给 `scopeId` → 400 `BAD_REQUEST`，与 §45.5 同一口径。

### 47.5 后台形态

「语音」页还是独立页签、排在「回复」之前，一页三张卡：

- 「语音合成接口」（`web/src/pages/VoicePage.tsx:525-656`）：没有模型输入框，有「情绪判断模型（可选）」三字段——地址 / Key / 模型，Key 只回掩码、留空不改。
- 「语音回复」（`:658-760`）：三档 `mode` + 三层 scope + 音色 + 语速，**一行没动**。
- 「朗读语气」（`:762-826`）：层级切换（`channel` / `guild` / `global`）+ 单栏 textarea + 字数 `x/maxChars` + 保存 / 恢复默认 / 已配置层列表逐条删除。说明文字改成**标签写法**（`:775-784`：标签放正文最前面、正文逐字不改、`[音频标签]` 只影响念法），下面四个示例 chips（`:791-804`）直接给出可点的 `(怅然)…` 例子。

- 试听结果里有 `styleUsed`（带括号的标签或 `null`）时追加「· 语气：…」，并显示「实际发送：标签 + 正文」（`VoicePage.tsx:362-365`）——`speechUsed` 就是这一次真正发出去的正文，这是「标签有没有生效」最直接的可视证据。
- **一个重要限制**：试听只取 **global 层**的「朗读语气」+ 库里的 judge，**频道层与服务器层不参与试听**；真正在 Discord 里发语音时才按 channel → guild → global 解析（§47.3）。所以「在频道层存了语气、试听却没变化」是设计内，只能在频道里发一条真的语音验证。

### 47.6 代码地图

| 位置 | 作用 |
| --- | --- |
| `migrations/0024_tts_style.sql` | 15 行：`tts_settings` 加四列 judge + 新建 `tts_style_prompts`（§47.2）；语气那版的最后一枚，迁移总数 24 |
| `migrations/0025_director_mode.sql` | 1 行：`voice_settings` 加 `director INTEGER NOT NULL DEFAULT 0`（`DEFAULT 0` 让老行 = 关闭，脏值由读侧落回 `0`，不加 `CHECK`；§47.8）；**仍是最后一个，迁移总数 25** |
| `src/core/voice/style.ts:5` | `TTS_STYLE_MAX_CHARS = 2000`（提示词上限） |
| `src/core/voice/style.ts:8` | `STYLE_TAG_MAX_CHARS = 40`（标签上限） |
| `src/core/voice/style.ts:11` | `SHORT_TAG_MAX_CHARS = 20`（整行裸标签的长度上限） |
| `src/core/voice/style.ts:14` | `TAG_PAIRS`：半角 `()` / 全角 `（）` / 方括号 `[]` / 黑框 `【】` 四对 |
| `src/core/voice/style.ts:33-35` | 判断超时的三个常量：`JUDGE_TIMEOUT_FLOOR_MS = 15_000` / `JUDGE_TIMEOUT_PER_CHAR_MS = 40` / `JUDGE_TIMEOUT_CAP_MS = 45_000`，算法在 `:38-40` 的 `judgeTimeoutMs(chars)`（§47.8）；前一版是固定 `JUDGE_TIMEOUT_MS = 8000`（本版已删除该常量）|
| `src/core/voice/style.ts:46` | `JUDGE_MAX_TOKENS = 4_000`（前一版 1200 抄不全长正文，§47.7） |
| `src/core/voice/style.ts:53` | `JUDGE_SYSTEM`：只输出一行 `(标签)原文`、正文逐字相同、只能插 `[音频标签]` |
| `src/core/voice/style.ts:120` | `VoiceSpeech = { tag, text }`：标签与正文是两件事 |
| `src/core/voice/style.ts:133` | `isJudgeConfigured`：三件齐（url / key / model）才算配了 |
| `src/core/voice/style.ts:149` | `resolveStylePrompt`：channel → guild → global 取第一个 `trim` 非空的层 |
| `src/core/voice/style.ts:199` | `normalizeStyleTag`：压空白、剥引号与括号、截 40 字；空串 = 无标签，否则半角括号包一层 |
| `src/core/voice/style.ts:210` | `dropPaired`：剥掉行首所有成对括号段 |
| `src/core/voice/style.ts:227` | `stripVoiceTags`：比对前统一剥掉成对括号段 |
| `src/core/voice/style.ts:234` | `looksLikeBareTag`：整行 ≤20 字且不含 `。！？；` 才算裸标签 |
| `src/core/voice/style.ts:249` | `applyJudgeLine`：四种结局——标签 + judge 正文 / 整行当标签 + 原文 / 标签保留 + 原文（正文对不上）/ 无标签 + 原文（§47.7） |
| `src/core/voice/style.ts:345` | `readJudgeContent`：只取第一行并成对剥引号 |
| `src/core/voice/style.ts:385` | `composeVoiceSpeech`：兜底标签 = 提示词本身、逐字校验、`stripVoiceTags` 保险、永不抛 |
| `src/core/voice/tts.ts:11` | `TtsPort.synthesize` 入参 `{ text, voice?, speed?, tag? }`（`tag` 不再是 `style`） |
| `src/core/voice/tts.ts:243-244` | mimo 方言单条 messages：`[{role:'assistant', content: tag + text}]`；无标签时 content 就是正文；openai 方言忽略 `tag` |
| `src/core/voice/speech-text.ts:9` | `toSpeechText`：只做清理、不截断，**不设字数上限**（§44.3） |
| `src/workers/discord/voice-reply.ts:50-55` / `:58-73` | 读提示词失败只 warn / 兜底「无标签 + 原文」，判断与合成失败同样只 warn、语音照发 |
| `src/workers/http/app.ts:1378-1500` | 试听：`style` 按标签归一化、正文只 `trim`（不截字数）；不带 `style` 走 global 层 + judge；响应 `styleUsed` / `speechUsed` |
| `src/workers/http/app.ts:1290` / `:1292` / `:1378` / `:1503`、`:1508`、`:1528` | 四条路由：settings 的 GET / PUT、test、`/api/tts-style` 的 GET / PUT / DELETE |
| `src/workers/db/d1-repository.ts:1322` / `:1328` / `:1348` / `:1414` | judge 四列读取、两把密钥各自解密、写回时省略即保留、`ttsStyles` 的 get / list / put / remove |
| `web/src/pages/VoicePage.tsx:775-784` / `:791-804` / `:362-365` | 标签写法说明 / 四个示例 chips / 试听「实际发送：标签 + 正文」 |
| `web/src/api.ts:2117-2128` | `TtsTestResult.styleUsed: string \| null` 与 `speechUsed?: string` |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'preset-head-1'`（`test/gateway.node.test.ts:229` 同步） |

### 47.7 标签形状与逐字校验

`tts-tags-1` 把「朗读语气」从一行自然语言指令改成**贴在正文最前面的标签**，judge 抄回来的正文还要过一道**逐字校验**；`tts-nolimit-1` 沿用这套形状、另外把字数上限拿掉；`voice-log-1` 再补一条成功日志；`director-2` 在它前面加了一层**导演模式**——先让 judge 按 mimo 导演模式改写要念的文本（§47.8），`0` 档与 `voice-log-1` 逐字相同。

- **形状**：`(怅然)正文`——标签在最前，紧跟正文；`applyJudgeLine`（`src/core/voice/style.ts:249`）只认行首的括号，写在别处不生效。
- **四种括号**：半角 `()`、全角 `（）`、方括号 `[]`、黑框 `【】`。多种风格写在同一个括号里，分隔符不限。
- **音频标签**：正文任意位置可以插 `[音频标签]`（`[轻笑]`、`[叹气]`、`[语速加快]`、`[沉默片刻]` 这类），只影响念法，不算风格标签。
- **不再发 `user` 消息**：MiMo 方言只发一条 `messages: [{ role: 'assistant', content: tag + text }]`（`src/core/voice/tts.ts:243-244`），没有标签时 content 就是正文；OpenAI 方言忽略 `tag`，`/audio/speech` 请求体不变。
- **字数不再设上限**：`toSpeechText`（`src/core/voice/speech-text.ts:9`）只做清理，正文念多长由上游接口自己的规则决定——上游嫌长就按现有错误路径报（合成失败只留一条 `[voice] 语音发送失败 …`，回复照常），本服务不再自己截；后台试听同理，只 `trim`、不再按字数截断。

judge 的产出要过逐字校验，共有四种结局：

| judge 给出的行 | 结局 |
| --- | --- |
| 行首是括号、括号配对，且剥掉所有成对括号段后与原文**逐字相同** | 用括号里的标签 + judge 抄回的正文 |
| 行首不是括号，但整行不超过 20 字（`SHORT_TAG_MAX_CHARS`）且不含 `。！？；` | 整行当标签，正文用原文 |
| 行首是括号、括号配对，但剥掉括号段后与原文**不再逐字相同**（改了一个字） | 标签保留、正文用原文 |
| 括号没有配对的收尾、括号后没有正文、整行过长 | 标签为空、正文用原文 |

判定失败、超时（`judgeTimeoutMs` 的预算用尽：15 秒 + 每字 40 毫秒、封顶 45 秒；前一版是固定 `JUDGE_TIMEOUT_MS = 8000`）、没配 judge（`isJudgeConfigured` 三件不齐）或上游非 2xx 时，标签退回三层提示词本身（`normalizeStyleTag`），**正文永远是原文**。`composeVoiceSpeech`（`src/core/voice/style.ts:385`）永不抛，最后还有一道 `stripVoiceTags` 一致性保险：剥掉成对括号段后仍是同一条正文，对不上就只把正文退回原文、标签保留。

`JUDGE_MAX_TOKENS = 4_000`（`src/core/voice/style.ts:46`）不是随手写的：judge 要把正文抄回来，不设字数上限后，前一版用的 1200 token 上限会在长正文上抄不全，抄回的与原文不再逐字相同，按上表第三行只保留标签、正文退回原文——judge 抄回来的正文连同它加的 `[音频标签]` 被弃用，表现出来就是语气还在、正文里的念法标注没了。4000 是给长回复留的余量，仍不是硬上限；真抄不全时宁可弃用抄回的正文，也不改原文。


- 迁移总数 25：`director-1` 补了 `0025_director_mode.sql`（`director-2` / `director-3` / `director-4` / `director-5` 都没有新迁移）（`voice_settings.director`，`NOT NULL DEFAULT 0`），`0024` 是它前一版；首启 `applied=25 skipped=0`，从 24 升上来 `applied=1 skipped=24`（§47.2）。
- 门牌 `reply-tool-3`：日志里看到 `build=reply-tool-3` 才说明这一版在位（这一版是把模型写在正文里的 `story_reply` 工具调用壳与成对的 `<game>` / `<game_content>` 包裹标签剥掉再发——壳与包裹标签都不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54；前一版 `reply-tool-1` 是只剥工具调用壳、game 包裹标签还留在正文里那版（无新迁移、迁移总数仍 29，§54.2）；再前一版 `identity-off-1` 是有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块，无新迁移、迁移总数仍 29，§53；再再前一版 `preset-head-1` 是预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52；再再再前一版 `identity-head-1` 是身份块去掉 Discord 平台措辞、平台元信息回到天头（§52）；再往前 `preset-4` 是阶段四：酒馆预设导入的段顺序按提示词链还原，§48.8；再往前 `preset-3` 是阶段三：世界书 + 酒馆预设导入器修正，§51、§48.7；`preset-2` 是阶段二：路由采样参数 + 深度注入，§49、§50；`preset-1` 只做酒馆预设导入，§48；再更早的 `director-6` 只把诊断用的 judge 行从截断改成完整一行——成功日志 `judge=` 段与试听 `judgeLine` 都是判断模型回的完整一行、不截断，念法、提示词、接口与迁移（仍 25 个）都没动；副作用是日志行可能变长，排错时按行读即可）；前一版 `director-5` 是「把导演档的提示词改成正文逐句语气标签、唱歌只在整体风格组标一次 `(唱歌)`」那版（`0` 档与接口、日志、UI 都没动，没有新迁移），再前一版 `director-4` 是「把 judge 那一行带进日志与试听」那版（成功日志多一个可选的 `judge=` 段、试听结果里多一行「判断模型写的是：…」，没有新迁移），再前一版 `director-3` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（无新迁移），再前一版 `director-2` 是「导演模式可观测性补丁」那版（无新迁移），再往前的 `director-1` 是导演模式第一版（补了迁移 `0025`），更早的 `voice-log-1` 是补成功日志那版（迁移 `0024`），再往前的 `tts-nolimit-1` 是「朗读不再有任何字数上限」那版（迁移 `0024`），更早以前的 `tts-tags-1` 是「assistant 正文开头的标签 + 正文逐字校验」那版，再往前的 `tts-style-1` 是「一行自然语言语气指令 + `role:user` 消息」那版，更早的 `tts-mimo-1`（§46.7，接口类型）、`tts-admin-1`（§46，TTS 搬进后台）、`prompt-scope-1`（§45）。
- 排错：语音没声音按 `docs/operations.md` §25.14 对号；**有声音但完全没语气**按 §25.15 对号（先看标签写法与 judge 配没配，再看试听只认 global 的限制）；**念出来把 `[轻笑]` 也念了，或正文像被改过**，看响应里的 `speechUsed`；抄不全与 judge 输出上限（`JUDGE_MAX_TOKENS = 4000`）见 §47.7；**导演模式**（三档 `director`、四条护栏、tag 置空）见 §47.8 与 `docs/operations.md` §25.16；`'director-2'` 起后台试听可以带档位、响应多 `director` 与 `directorRejected`、成功日志多一个可选的 `rejected=` 段。

### 47.8 导演模式（`director-1` 起；`director-2` 补试听档位、拒绝原因与日志段；`director-3` 把判断超时改成按字数给预算、多一种 `judge` 退回原因；`director-4` 把 judge 那一行带进日志与试听；`director-5` 把导演档的提示词改成正文逐句语气标签、唱歌只在整体风格组标一次 `(唱歌)`；前一版 `director-6` 只把诊断用的 judge 行从截断改成完整一行（日志 `judge=` 段与试听 `judgeLine` 都不再截断，念法与迁移都没动））

**是什么**：Discord 上显示的文字仍是原文，只把**要念的那段文本**先交给 judge 按 mimo 导演模式改写一遍。三档由每行 `voice_settings.director` 决定，后台「语音」页「语音回复」卡片的下拉（`web/src/pages/VoicePage.tsx:762-774`，选项文案是「关闭（逐字朗读）」/「只插标签」/「允许顺句改写」）跟着整行 `PUT` 走。

本节主体是 `'director-1'` 那一版定下的语义；`'director-2'` 只在其上补可观测性——试听可以带档位、响应多 `director` 与 `directorRejected`、成功日志多一个可选的 `rejected=` 段；`'director-3'` 只改判断超时的给法（从前一版的固定 8 秒改成按字数给预算）并多一种退回原因 `judge`；`'director-4'` 只把 judge 那一行带进日志与试听——成功日志多一个可选的 `judge=` 段、试听响应多 `judgeLine`、页面多一行「判断模型写的是：…」；`'director-5'` 只改导演档（`1` / `2` 档）的提示词规则——正文每一句前面都要加一个写语气或说话方式的括号标签，唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在那一处标一次、不再给每句歌词加标签，`0` 档 `JUDGE_SYSTEM`、两条护栏、接口、日志与 UI 一个字没动；前一版 `'director-6'` 只把诊断用的 judge 行从截断改成完整一行——成功日志 `judge=` 段与试听响应 `judgeLine` 都是判断模型回的完整一行、不截断（原先会截掉超长部分），念法、提示词、接口与迁移一个字没动。六版的念法与 `'director-1'` 逐字相同。
下面引用的行号按当前树校正过。

**再前一版（`director-4`）把 judge 那一行带进日志与试听**：真实语音那条成功日志在 `rejected=` 之后多一个可选的 `judge=` 段——`[voice] 已发送 tag=… bytes=… 字数=… mode=… director=… rejected=… judge=<judge 那一行的完整一行>`；judge 那一行走 `onJudgeLine` 回调（`src/core/voice/style.ts:376`，`VoiceSpeechInput` 的可选字段），`composeVoiceSpeech` 在 `:432` 直接 `input.onJudgeLine?.(line)` 把整行交出去（`:429` 先判空行），整段包在 try/catch 里——回调抛错不影响念法；`src/workers/discord/voice-reply.ts:66` 的 `let judgeLine = ''`、`:75` 接回调、`:116` 拼进日志（空串就整段不出现）。后台试听那边同源：`src/workers/http/app.ts:1468` 的 `let judgeLine: string | null = null`、`:1493` 收回调、`:1516` 随响应返回；前端 `web/src/api.ts:2183` 的 `TtsTestResult` 多 `judgeLine?: string | null`、`:2368-2369` 解析，页面 `web/src/pages/VoicePage.tsx:403-404` 在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：<judgeLine>」，只在 `directorRejected` 不为 `null` 时显示。**为什么加**：`1` 档退回时只看到 `rejected=verbatim`，判断不了模型到底怎么写的；现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」——没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`。**日志口径**：正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断（§19.1）。没有新迁移（仍是 `0025_director_mode.sql`、总数 25）。

**上一版（`director-5`）只改导演档的提示词规则**：`JUDGE_DIRECTOR_COMMON`（`src/core/voice/style.ts:62-67`）现在要求开头 `(风格1 风格2)` 仍是整体风格，紧跟其后的正文**每一句前面都要加一个括号标签**写语气或说话方式（如（轻声）、（语速加快）、（笑着）），正文任意位置还可以插 `[音频标签]` 做细粒度控制，括号可以用半角 `()`、全角 `（）` 或 `[]`；唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），**整段歌词只在这一个地方标一次、不要给每句歌词加标签**，歌词用中文；风格按这一条内容自己挑，后台给的【风格要求】只当偏好，与内容冲突时以内容为准。官方 MiMo 文档对唱歌的要求也是「必须在目标文本最开头添加 `(唱歌)` 标签，格式为 `(唱歌)歌词`；歌词建议中文」，我们只是把 `(唱歌)` 原样交给上游，上游认不认 `sing` / `singing` 不由代码决定。**护栏照旧**：`1` 档仍是「把候选与原文里的成对括号段与方括号段都删掉之后必须逐字相同」，每句标签都属成对括号组，剥掉后照样放行（`test/tts.style.test.ts` 断言提示词里含「每一句前面都要加一个括号标签」「唱歌时整体风格组里要有一个 `(唱歌)`」「不要给每句歌词加标签」）；`2` 档字数护栏、`0` 档 `JUDGE_SYSTEM`（`:53`）逐字未变，接口、后台 UI、日志字段（`rejected=`、`judge=`、`judgeLine`）一个都没动，也没有新迁移（仍是 `0025_director_mode.sql`、总数 25）。与上一版的差别只有三处：正文每一句前面都要加一个写语气或说话方式的括号标签；唱歌时整体风格组里要有一个 `(唱歌)`（上一版只要求唱歌用 `(唱歌)` 开头）；明确整段歌词只在风格组里标这一次、不要给每句歌词加标签。歌词仍用中文，风格仍按内容自选、【风格要求】只当偏好。

**前一版（`director-6`）只把诊断用的 judge 行从截断改成完整一行**：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都是判断模型回的完整一行、不截断（原先会截掉超长部分），字段名、出现时机与 `string | null` 类型都没变；`0` / `1` / `2` 三档念法、提示词、接口与迁移（仍是 `0025_director_mode.sql`、总数 25）一个字没动。**为什么**：截断会把长回复里「模型写的与原文差在哪里」藏在被截掉的部分里，整行才能直接比对；副作用是日志行可能变长，排错时按行读即可（一条成功日志仍是一行）。`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出（`:429` 先判空行、`:430` 起包在 try/catch 里），回调抛错不影响念法。

**判断超时的预算**（`director-3`）：`judgeTimeoutMs(chars)`（`src/core/voice/style.ts:38-40`）= `JUDGE_TIMEOUT_FLOOR_MS`（`:33`，15 秒）+ 字数 × `JUDGE_TIMEOUT_PER_CHAR_MS`（`:34`，40 毫秒），超过 `JUDGE_TIMEOUT_CAP_MS`（`:35`，45 秒）就取 45 秒；调用点是 `composeVoiceSpeech` 里的 `AbortSignal.timeout(judgeTimeoutMs(charCount(original)))`（`:423`），字数按送进 judge 的原文按码点算（`charCount`，`:279`）。**为什么不再是固定 8 秒**：前一版是固定 `JUDGE_TIMEOUT_MS = 8000`（本版已删掉这个常量），一次实测里 148 字的真实回复 judge 要 8.1 秒才回，被 8 秒整条掐断——导演模式于是退回原文，`director=1` 在真机上看着和 `0` 档一模一样（都是原文 + 提示词当标签），而 `directorRejected` 仍是 `null`，日志里也看不出来。按新预算，15 秒覆盖短正文、约 750 字才摸到 45 秒封顶，既压住慢回复、又不会无限等。

**数据与接口**（行号以当前树为准）：

- 迁移 `migrations/0025_director_mode.sql`：`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0;`（迁移总数 25；`DEFAULT 0` 让老行 = 关闭，脏值由读侧落回 `0`，所以不加 `CHECK`）。
- `src/core/types.ts:404`：`VoiceSettingsConfig` 加必填 `director: number`。
- `src/core/voice/settings.ts:10-12`：`VOICE_DIRECTOR_OFF = 0` / `VOICE_DIRECTOR_TAGS = 1` / `VOICE_DIRECTOR_FREE = 2`；`:15` `isVoiceDirector(value: unknown): value is 0 | 1 | 2`；`:70` 读侧 `isVoiceDirector(row.director) ? row.director : VOICE_DIRECTOR_OFF`（`src/workers/db/d1-repository.ts`：`:263` 行类型里就有 `director`，`:272-284` 的 `toVoiceSettingsConfig` 是同一条 normalize（`:282` 是那一行））。
- `src/workers/db/d1-repository.ts`：`:1162`、`:1171` 两条 `SELECT` 带 `director`，`:1186` `INSERT` 列表多一列，`:1191` `director = excluded.director`，`:1194` bind 带 `cfg.director`，`:1203` 回填对象带 `director`。
- `src/workers/http/app.ts`：`:1208` 默认值带 `director: VOICE_DIRECTOR_OFF`，`:1210` `directorModes: [VOICE_DIRECTOR_OFF, VOICE_DIRECTOR_TAGS, VOICE_DIRECTOR_FREE]`，`:1238-1240` `PUT` 读 `body['director']`（缺省 `0`，非法回 `400 { error: 'BAD_DIRECTOR_MODE' }`），`:1248` 落库。
- 三层（channel > guild > global）各存一行；**没有 `PATCH`**，保存就是整行 `PUT`，所以下拉一改会把 `mode` / `voice` / `speed` 一起写回。

**三档语义**（口径逐字如此）：

- `0` 关闭（逐字朗读）：行为与上一版完全一致，judge 只给一行标签，正文一个字都不许改。
- `1` 只插标签：judge 要写开头整体风格组、正文每一句前面都要加一个语气标签（唱歌时只有整体风格组里那一个 `(唱歌)`，整段歌词不再逐句加标签），但把候选与原文里的成对括号段都删掉之后必须逐字相同，否则退回原文（风格组留给日志，不当标签重复念）。
- `2` 允许顺句改写：judge 可以口语化改写，护栏是去掉标签后字数在原文 0.3–3 倍之间（原文不足 20 字时上限改成原文 +200 字）、不许残留 `[[voice]]` 之类双方括号指令，越界退回原文。
- 开头风格由模型按这一条内容自己挑；后台那段朗读语气提示词只当【风格要求】偏好，与内容冲突以内容为准。
- 导演模式放行时语音文本就是 judge 那一整行，`tag` 置空（风格组已经长在正文开头，再当标签拼前缀会念两遍）；judge 未配置、超时、非 2xx、坏 JSON、抛异常一律退回原文，绝不让导演模式把一条回复弄失败——`director-3` 起这一整类在 `1` / `2` 档统一返回 `directorRejected: 'judge'`（`0` 档兜底不带这个字段）。
- 后台「试听」（`POST /api/tts-settings/test`）默认按 `0` 档，body 里带可选 `director` 才走导演提示词：`src/workers/http/app.ts:1461-1463` 读 `body['director']`、缺省 `0`、非法回 `400 { error: 'BAD_DIRECTOR_MODE' }`（这道校验排在「TTS 未配置」检查之后），`:1485` 把 `director` 传给 `composeVoiceSpeech`。响应在 `speechUsed`、`styleUsed` 之后多两个字段（`:1504-1505`）：`director` 回显这次用的档位，`directorRejected` 是 `null` 或五种退回原因之一——`empty` 判断模型只回了一个风格组、没有正文；`verbatim` `1` 档候选去掉标签后与原文不逐字相同；`residue` `2` 档候选还留着 `[[...]]` 这类指令残留；`ratio` `2` 档候选去掉标签后的字数不在原文 `0.3` 到 `3` 倍之间（原文不足 20 字时上限放宽为原文 + 200 字）；`judge` 判断模型没给出可用的一行（没配 judge、超时、非 2xx、JSON 坏、抛异常）。放行或被退回到原文时，`speechUsed` 就是真正送进合成的那一份。后台那张试听卡片另有一个「导演模式（仅这次试听）」下拉（缺省 `0`，选项取快照的 `directorModes`），选 `1` / `2` 时结果区多一行「导演模式：…」——放行写「（这次放行了改写）」，退回写「（退回原文：<中文原因>）」，五种原因的中文文案在 `web/src/api.ts` 的 `describeVoiceDirectorRejection`；它只影响这一次试听，不改任何一层存的档位。

**提示词与护栏**（`src/core/voice/style.ts`）：

- `:53` `JUDGE_SYSTEM`（`0` 档，与旧版逐字相同）；`:62` `JUDGE_DIRECTOR_COMMON`（开头风格组、**正文每一句前面加一个写语气或说话方式的括号标签**、唱歌时整体风格组里要有一个 `(唱歌)` 且**整段歌词只在那一处标一次、不给每句歌词加标签**、正文任意位置可插音频标签、风格按内容自选、【风格要求】只当偏好）；`:70` `JUDGE_DIRECTOR_TAGS_RULE`；`:74` `JUDGE_DIRECTOR_FREE_RULE`；`:84` `judgeSystemFor(director, prompt)` 按档拼装，`0` 档 `return withPrompt(JUDGE_SYSTEM)`，与旧代码「有 prompt 才追加【风格要求】」逐字等价。
- `:227` `stripVoiceTags`（删掉成对括号段，`1` 档逐字比较与日志 tag 都用它）；`:271` `leadingStyleGroup`（取开头整组风格，放行后进日志）；`:279` `charCount`（按码点算，不按 UTF-16）；`:284` `INSTRUCTION_RESIDUE`（`[[voice]]` 之类残留指令）；`:287-290` `DIRECTOR_MIN_RATIO = 0.3` / `DIRECTOR_MAX_RATIO = 3` / `DIRECTOR_SHORT_CHARS = 20` / `DIRECTOR_SHORT_SLACK = 200`。
- `:305` `applyDirectedLine(original, line, director: 1 | 2, fallbackTag)`：候选 `trim` → `leadingStyleGroup` 取风格组 → `stripVoiceTags` 后为空则作废 → `1` 档判 `stripVoiceTags(candidate) === stripVoiceTags(original)` → `2` 档先查 `INSTRUCTION_RESIDUE`、再按码点算比例 → 放行就是 `{ tag: '', text: candidate, styleLabel }`。
- 退回有两个出口：护栏那一侧是 `:313-318` 的 `reject(reason: VoiceDirectorRejection)`，一律返回 `{ tag: fallbackTag, text: original, styleLabel, directorRejected: reason }`，调用点 `:319`（`trim` 后为空）、`:322`（删完标签没正文）、`:325`（`1` 档不逐字相同）、`:327`（`2` 档有指令残留）、`:337`（`2` 档字数越界，边界在 `:330-334` 的 `ceiling` / `floor`）；judge 那一侧是 `:396-397` 的 `judgeFailed()`。五种原因一一对应：`empty` = 判断模型只回了一个风格组、没有正文；`verbatim` = `1` 档候选去掉标签后与原文不逐字相同；`residue` = `2` 档候选里还留着 `[[...]]` 这类指令残留；`ratio` = `2` 档候选去掉标签后的字数不在原文 `0.3` 到 `3` 倍之间（原文不足 20 字时上限放宽为原文 + 200 字）；`judge` = 判断模型根本没给出可用的一行——没配 judge（`:401` 的 `isJudgeConfigured` 三件不齐）、超时的预算用尽、上游非 2xx、JSON 坏、抛异常，全走 `judgeFailed()`，`0` 档这时返回的是不带这个字段的 plain fallback。退回时 `text` 是原文、`directorRejected` 带原因，念的就是原文；日志里看到 `rejected=judge` 就读成「判断模型没答上来」，不是护栏拦的。
- 类型：`:117` `export type VoiceDirectorRejection = 'empty' | 'verbatim' | 'residue' | 'ratio' | 'judge';`；`:129` `VoiceSpeech.directorRejected?: VoiceDirectorRejection`（只有导演模式退回原文时才有值——试听原样回给后台，正常回复写进成功日志）。试听响应 `directorRejected` 因此是 `null` 或这五种之一。
- 接线：`VoiceSpeechInput.director?: number`（`:365` 起的 interface，缺省 `0`）；`composeVoiceSpeech`（`:388`）在 `:392` 把脏值落 `0`、`:423` 用 `judgeTimeoutMs(charCount(original))` 当超时、`:440` `director !== VOICE_DIRECTOR_OFF` 走 `applyDirectedLine` 否则走旧 `applyJudgeLine`（`:249`）、`:451` 的 `catch` 全部退回 fallback，永不抛。

**日志与 UI**：

- `src/workers/discord/voice-reply.ts:66-72` 把 `settings.director` 传进 `composeVoiceSpeech`；`:96` `tag` 优先取 `speech.styleLabel`、都空写 `无`；`:98-111` 成功日志 `[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`，字数按真正送进合成的文本算（`Array.from(speech.text).length`）。
- `rejected` 的来源：`:110` 在 `director=` 之后拼 `(speech.directorRejected === undefined ? '' : ' rejected=' + speech.directorRejected)`，所以完整形状是 `[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio|judge>]`；方括号那段是**可选**的，只有导演模式判定不合格、退回原文时才出现，放行、没配导演模式、`0` 档时逐字与 `'director-1'` 相同。
- `director-4` 那一行：`src/workers/discord/voice-reply.ts:116` 在 `rejected=` 之后拼 `(judgeLine === '' ? '' : ' judge=' + judgeLine)`；`judgeLine` 是 judge 那一行的完整一行、不截断（`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 直接交出），judge 没配 / 超时 / 非 2xx / 坏 JSON / 抛异常时是空串、整段不出现。试听侧同源：`src/workers/http/app.ts:1468` / `:1493` / `:1516`，响应字段 `judgeLine`（`string | null`），前端 `web/src/api.ts:2183` 与 `:2368-2369`，页面 `web/src/pages/VoicePage.tsx:403-404` 只在 `directorRejected` 不为 `null` 时显示「判断模型写的是：…」——带正文片段，口径见 §19.1 那条例外。
- 后台：`web/src/pages/VoicePage.tsx:199` 草稿、`:255` 接收 `snapshot.directorModes`、`:407` / `:419` / `:425` / `:446` 的 `PUT` body 带 `director`、`:762-774` 下拉、`:112` 列表摘要、`:814` 行渲染。
- 门牌同步：`src/workers/gateway/engine.ts:129`、`web/src/api.ts:2103` / `:2376`、`web/src/styles.css:1361` 的注释。

**三条限制（照实说）**：

- `2` 档念出来的话与屏幕上写的会不一致——judge 会口语化改写，这是设计，不是串台。
- 标签（`(怅然)` 之类）是否被 mimo 真正演绎，无法从服务端证实：接口只回音频字节，日志只能证明标签进了合成请求。
- `mimo` 合成自己还有一条 30 秒超时（§46 那节的口径没变）：实测 700 字以上的文本经常直接回 `502 {code:'TTS_UPSTREAM'}`——那条超时与本版的判断超时不是一回事，本版也没动它，长文照样失败。

排错见 `docs/operations.md` §25.16，日志形状见 §44.3，迁移见 §47.2。

## 48. 酒馆（SillyTavern）预设导入（阶段一）

后台「提示词」页顶部多了一块导入面板：选一份 SillyTavern 导出的预设 JSON（或直接粘贴），填一个角色名，二次确认后走 `POST /api/prompts/import`。这一版做的事只有一件——把预设里的**文本段、它们的顺序、以及宏**搬进本项目的 global 提示词层，**整层覆盖**（`preset-import-1` 起这一层由导入时选的 `scope` 决定，可以不是 global，见 §56）。世界书、深度注入、采样参数、正则脚本、Quick Replies 都还没有生效（逐条见 §48.5）。

### 48.1 数据与存档

- `preset-1` 到 `preset-4` 的导入只动 `prompt_segments` 里 `scope = 'global'`、`scope_id = ''` 这一层（`src/workers/http/app.ts:816`；`preset-import-1` 起改成请求里的目标层，见 §56.2）：先读旧层，把旧层配置里的 `temperature` / `maxTokens` 原样带过去（`src/workers/http/app.ts:830-831`），再把段整层换成新的一套（`src/workers/http/app.ts:819-829`，每段 `id = 'seg-' + uuid`、`position` 取数组下标），最后一次 `put` 落盘（`src/workers/http/app.ts:833`）。**旧段不备份、不保留**。
- 原始 JSON 另存一份：`prompt_presets` 表（`migrations/0026_prompt_presets.sql:3`），列 `id` / `name` / `char_name` / `source_json` / `imported_at`。`preset-1` 到 `preset-4` 的语义是**单行**：`id` 固定 `latest`（`preset-import-1` 起按层各存一行——global 仍是 `latest`、其它层 `latest:<scope>:<scopeId>`，见 §56.5），写入语句 `src/workers/db/d1-repository.ts:668` 加 `ON CONFLICT (id) DO UPDATE`（`src/workers/db/d1-repository.ts:669`），只留**最近一次**导入的原文；导入成功才写（`src/workers/http/app.ts:835`），解析或校验失败不覆盖上一条。
- 有读的口子吗：这一版**只写不读**。`latestPreset()`（`src/workers/db/d1-repository.ts:681`）只有接口与实现，没有任何路由调用它，后台也没有「查看 / 恢复上一次导入」的按钮——原文留在库里是给后续阶段与人工排错用的，不是本版的一键回滚。
- 迁移：`0026_prompt_presets.sql` 是第 26 个，老库升级是 `applied=1 skipped=25`，新库首次启动是 `applied=26 skipped=0`（这是 `preset-1` 那一版的数字；`preset-2` 到 28，见 §49、§50；`preset-3` 到 29，见 §51、§48.7；`preset-4`（前一版）没有新迁移，仍是 29，见 §48.8；`preset-head-1` / `identity-off-1` / `reply-tool-1` / `reply-error-2` 都没有新迁移、仍是 29，见 §52、§53；`context-tool-1` 起把 `0030_context_tool_mode.sql` 算进来、总数 30，`context-tool-2` 到 `context-tool-5` 都没有新迁移，见 §55；现行 `preset-import-1` 同样没有新迁移、仍是 30，见 §56.8）。

### 48.2 解析与宏映射

解析器是纯函数：`importSillyTavernPreset(raw: unknown, charName: string): PresetImportResult`（`src/core/prompt/sillytavern.ts:185`）。

- 形状：`raw` 必须是对象（`src/core/prompt/sillytavern.ts:144`），`prompts` 必须是数组（`src/core/prompt/sillytavern.ts:146`）；数组里的非对象条目跳过并记一条 warning（`src/core/prompt/sillytavern.ts:168-171`）。
- 顺序：`readPromptOrder`（`src/core/prompt/sillytavern.ts:129`）取第一个非空的顺序表——先看 `character_id === 100000`（`MAIN_CHARACTER_ID`，`src/core/prompt/sillytavern.ts:44`）那一组是否非空，不是就按文件顺序找第一个非空的组（`src/core/prompt/sillytavern.ts:132-138`）；全都空、或组结构不认识就返回 `null`，调用方回落到 `prompts` 原顺序；`prompt_order` 引用了不存在的段记 warning（`src/core/prompt/sillytavern.ts:225`）；没被点名的段按原顺序接在后面、启用与否只看段自己（`src/core/prompt/sillytavern.ts:231-234`）。
- 段名：`name` → `identifier` → `段 N` 兜底（`src/core/prompt/sillytavern.ts:196-197`）。
- 丢弃：`marker === true` 的段进 `ignored`（`reason: 'marker'`，`src/core/prompt/sillytavern.ts:200`）；内容 `trim()` 后为空进 `ignored`（`reason: 'empty'`，`src/core/prompt/sillytavern.ts:205`）。
- 角色：只认 `'user'` 与 `'system'`；其余非空角色值（含 `assistant`）一律降级成 `system` 并记 warning（`src/core/prompt/sillytavern.ts:210-217`）。
- `placement` 恒为 `'before'`（`src/core/prompt/sillytavern.ts:226`）——这一版不从预设里读注入位置。
- 一个可用段都没解析出来 → `NO_SEGMENTS`（`src/core/prompt/sillytavern.ts:229`）。
- 宏映射在 `mapMacros`（`src/core/prompt/sillytavern.ts:114`）：
  - `{{char}}` / `{{charIfNotGroup}}` → 导入时填的角色名（`src/core/prompt/sillytavern.ts:124-129`）；角色名留空则保留原宏并记 warning。
  - `{{user}}` → `{{user_name}}`（`src/core/prompt/sillytavern.ts:131`）。
  - `{{time}}` / `{{date}}` / `{{datetime}}` → `{{date}}`（`src/core/prompt/sillytavern.ts:132`）。
  - 一批「本阶段没有来源」的宏（`description` / `persona` / `personality` / `scenario` / `original` / `mesExamples` 等，完整清单见 `CLEARED_MACROS`，`src/core/prompt/sillytavern.ts:42-74`）清空并进 warnings，去重后最多 10 条（`MAX_CLEARED_WARNINGS`，`src/core/prompt/sillytavern.ts:31`，处理点 `src/core/prompt/sillytavern.ts:133-136`）。
  - 白名单宏（`TEMPLATE_VARS`，`src/core/prompt/sillytavern.ts:34`）原样保留（`src/core/prompt/sillytavern.ts:137`）。
  - 其余 `{{...}}` 原样保留并记一条 `unknown variable`（`src/core/prompt/sillytavern.ts:138-139`）。
- warnings 只提示、不拦导入；真正拦导入的只有 §48.3 那三类 400。

### 48.3 接口与错误码

`POST /api/prompts/import`（`src/workers/http/app.ts:798`），body：

```json
{ "preset": <预设 JSON 对象>, "charName": "<可选，角色名>" }
```

成功 200：

```json
{ "segments": [ { "id": "seg-…", "name": "…", "role": "system", "content": "…",
                    "enabled": true, "placement": "before", "position": 0 } ],
  "ignored": [], "warnings": [], "charName": "阿岚", "scope": "global", "replaced": 3 }
```

- `segments` 是写进去的段数组（长度就是段数，后台「已写入 N 段」的 N 就是它），`replaced` 是**被整层覆盖掉的旧段数**（`src/workers/http/app.ts:842-849`，旧层不存在时为 0）。
- `ignored` 是被跳过的段（`reason: 'marker'` / `'empty'`），`warnings` 是宏与角色的提示。
- `scope` 恒为 `'global'`：写的一直是 global 那一层，内部键是 `{ scope: 'global', scopeId: '' }`（`src/workers/http/app.ts:816`），响应里不带 `scopeId`。

三类 400：

| 错误 | 触发条件 | 位置 |
| --- | --- | --- |
| `BAD_PRESET` | body 不是 JSON 对象；`preset` 缺失或不是对象；解析器判 `BAD_PRESET`（不是对象 / 缺 `prompts` 数组） | `src/workers/http/app.ts:800`、`src/workers/http/app.ts:802`、`src/workers/http/app.ts:807` |
| `NO_SEGMENTS` | 一个可用段都没解析出来 | `src/workers/http/app.ts:807`（判定在 `src/core/prompt/sillytavern.ts:229`） |
| `UNKNOWN_TEMPLATE_VAR` | **启用**段里出现白名单外的宏（停用段不查），回 `{ error, vars }` | `src/workers/http/app.ts:811-814` |

白名单就是 `src/core/prompt/template.ts:1` 那五个（`bot_name` / `user_name` / `guild_name` / `channel_name` / `date`）。渲染时未知变量会抛 `UNKNOWN_TEMPLATE_VAR: <name>`（`src/core/prompt/template.ts:34`），所以导入前先用 `collectUnknownVars`（`src/workers/http/app.ts:459`）拦一道——把「导进去之后每条回复都失败」变成「导入当场 400」加一张变量清单。

### 48.4 段装配影响

导入的段最终由 `collectSegments`（`src/core/chat/service.ts:349`）挑出来：先按 `enabled` 与角色过滤（`src/core/chat/service.ts:355-357`），再按 `position` 升序（`src/core/chat/service.ts:359`），逐段 `renderTemplate`、渲染后整段为空的丢掉（`src/core/chat/service.ts:362-363`）。`buildPromptParts`（`src/core/chat/service.ts:373`）把 `before` / `after` 各自的段用空行拼起来（`src/core/chat/service.ts:383`、`src/core/chat/service.ts:384`），`user` 段则按 `position` 升序变成历史消息之前的 user 消息（`src/core/chat/service.ts:385`）。

三点必须知道：

- 整层覆盖意味着**导入那一刻目标层原来的段全没了**（`preset-1` 到 `preset-4` 这一层固定是 global，`preset-import-1` 起是导入时选的那一层，见 §56.2），包括后台手写的自定义段；想拿回来只能重新写。
- `temperature` / `maxTokens` 不跟着预设走（预设里的 `temperature` / `top_p` 之类这一版一个都不读），导入后仍是导入前的值（`src/workers/http/app.ts:830-831`）。
- 停用段（`enabled: false`）会写进库但不参与装配；它里面的未知宏也不拦导入，因为检查只看启用段（`src/workers/http/app.ts:811-814`）。

### 48.5 阶段边界（这一版明确不做的）

只到「文本段 + 顺序 + 宏」为止。下面这些**都没有生效**，排错时别按它们期待行为：

- 世界书（关键词触发、扫描深度、`character_book`）：不解析、不入库。
- 深度注入与注入位置（injection depth / position）：`placement` 恒为 `'before'`，不读预设里的位置。
- 采样参数（`top_p` / `top_k` / `presence_penalty` / `frequency_penalty` 等）：代码里只有 `temperature` / `maxTokens`，预设里的采样参数一律不读。
- 正则脚本（regex scripts）、Quick Replies、角色卡字段（`description` / `personality` / `scenario` 等）：只做存档或被清空，不参与提示词。
- 一键回滚与版本历史：`prompt_presets` 只留最近一份原文，没有读取接口、没有按钮。

### 48.6 代码地图

| 位置 | 内容 |
| --- | --- |
| `src/workers/http/app.ts:798` | `POST /api/prompts/import` 路由与 200 响应 |
| `src/workers/http/app.ts:800` / `:802` / `:807` | 三类 400 的判定点（含解析器失败） |
| `src/workers/http/app.ts:811-814` | 启用段的未知宏检查（`UNKNOWN_TEMPLATE_VAR`） |
| `src/workers/http/app.ts:816` | 目标层 `{ scope: 'global', scopeId: '' }` |
| `src/workers/http/app.ts:819-829` | 整层重建段（`id` / `position`） |
| `src/workers/http/app.ts:830-831` | 保留旧层的 `temperature` / `maxTokens` |
| `src/workers/http/app.ts:835` | 写 `prompt_presets` |
| `src/core/prompt/sillytavern.ts:185` | `importSillyTavernPreset` |
| `src/core/prompt/sillytavern.ts:129` / `:156` | `readPromptOrder` / `mapMacros` |
| `src/core/prompt/sillytavern.ts:42-74` | `CLEARED_MACROS` 清单（清空并进 warnings） |
| `src/core/prompt/sillytavern.ts:200` / `:205` / `:210-217` / `:226` | marker / 空段 / 角色降级 / `placement` |
| `src/core/chat/service.ts:349` / `:373` | 段装配入口（`collectSegments` / `buildPromptParts`） |
| `migrations/0026_prompt_presets.sql:3` | `prompt_presets` 建表 |
| `src/workers/db/d1-repository.ts:668` / `:681` | 写（单行 UPSERT）/ 读（无调用者） |
| `web/src/pages/PromptsPage.tsx:265` / `:302` | 二次确认 / 结果区「已写入 N 段（覆盖 M 段）」 |
| `web/src/api.ts:297` | `importPromptPreset` |

排错步骤与回滚写在 `docs/operations.md` §32。

### 48.7 preset-3 改了什么：enabled、深度注入与 46→28

§48 记的是阶段一（`preset-1`）解析器的行为。`preset-3` 在 `src/core/prompt/sillytavern.ts` 上修了三个令「破限」失效的根因，导入接口与响应各加了一点；宏映射、marker 判定、角色降级、整层覆盖这些都没动。

1. **尊重段自己的 `enabled`。** `isEntryEnabled`（`:106`）读条目的 `enabled`；`readPromptOrder` 里走 `prompt_order` 的分支判 `item.enabled && isEntryEnabled(...)`（`:221`），不走 `prompt_order` 的分支只看条目自己（`:225`）。`enabled:false` 的段当时进 `ignored` 且 `reason='disabled'`（`:238`，判定顺序 disabled → marker → empty）——**这条在 `preset-import-2` 之前是这样**，那一版起停用段照样导入、保持停用（§58）。旧版不看这个开关，预设里关着的段（真实预设里有 17 段）照样拼进提示词。
2. **历史后指令搬去深度注入。** `isPostHistoryEntry`（`:114`）认 `identifier === 'jailbreak'`（`POST_HISTORY_IDENTIFIER`，`:47`）或 `injection_position === 1` 的启用段。这些段不再留在文本段里，而是按出现顺序用两个换行拼成 `postHistory`（`:268-272`、`:277`），再按码点截断到 `POST_HISTORY_MAX_CHARS = 20000`（`:37`、`:280-282`），同时回 `moved: MovedEntry[]`（`{identifier, name}`，`:27`）。导入接口 `src/workers/http/app.ts:973-990` 拿到非空 `postHistory` 就写一条 global 深度注入 `{ depth: 0, role: 'system' }`（紧跟本轮用户消息之前），写前先 `get` 判 `replaced`（旧值真有正文才算覆盖）；响应 `:992-1001` 多 `moved` 与 `injection: {saved, chars, replaced}`。`postHistory` 为空时一个字都不碰——不含 jailbreak 的预设不会抹掉手写的 global 注入。
3. **`order` 缺失不再全开。** `prompt_order` 里主项的 `order` 是空数组（或缺失）时，旧逻辑退化成「全部条目都算启用」，把整本预设（含 NSFW 槽与几万字的长段）灌进提示词。

实测（真实预设 `E:\game\sb\Meowssiah_1.9.12.json`，316,453 字节、54 段、17 段 `enabled:false`、`prompt_order` 里主项 `order` 是空数组）：旧导入 46 段、约 9 万字符 → 新导入 **28 段、正文合计 4,465 字**，`ignored = {disabled: 17, marker: 8}`（`preset-import-2` 之前的口径；现在没有 disabled 这一类，这 17 段作为停用段导入，§58），`moved = [继续游戏]`（43 字）；`SPreset配置`（81,489 字）与 `⛔️关闭NSFW` 现在落 `disabled`。`test/prompt.sillytavern.test.ts` 26 例全过。

后台与接口的配套：`web/src/api.ts` 的 ignored 多一类 `disabled`（标签「预设里关着的段（disabled）」）——**`preset-import-2` 起这一类已删除**（`PromptImportIgnoreReason` 只剩 marker / empty / badRole），§58；`web/src/pages/PromptsPage.tsx` 结果区新增「搬去深度注入：继续游戏（43 字，已写入 global 深度注入）」这类行，`saved=false` 时提示去「深度注入」卡片手动保存一次，`replaced=true` 追加「（覆盖了原有的 global 深度注入）」，二次确认里也补了一句会一并覆盖 global 深度注入。

诚实限制：①Gemini 的服务端安全过滤在提示词之外，本仓库 `src/core/providers/gemini.ts` 里没有任何 `safetySettings` 代码，破了的内容仍可能被上游拦；②`{{lastUserMessage}}` 这类宏仍被清空（`CLEARED_MACROS`，`:42-74`），预设里依赖它的段会缺内容；③除 jailbreak 以外，ST 的 nsfw 槽等其它位置语义仍按 before 处理；④导入仍无撤销。

排错与回滚写在 `docs/operations.md` §34。

### 48.8 preset-4（现已是前一版）改了什么：段顺序按预设的提示词链还原

§48.7 之后还剩一个顺序问题：段数对了、内容也对了，但排出来的先后与酒馆里那条 prompt chain 对不上。

- 根因：`readPromptOrder`（`src/core/prompt/sillytavern.ts:129`）旧版把顺序表盯在 `character_id === 100000`（`MAIN_CHARACTER_ID`，`src/core/prompt/sillytavern.ts:44`）那一组上，这一组取不到才退到文件里的第一组。真实预设 `Meowssiah_1.9.12.json` 里 100000 那一组的 `order` 是空数组，真正的 52 项链写在 `100001` 那一组——旧版拿到的是空表，整份回落到 `prompts` 数组原顺序，导入结果自然与酒馆里看到的链对不上。
- 新逻辑（`src/core/prompt/sillytavern.ts:129-150`）：取**第一个非空的顺序表**。`isFilled`（`:132-135`）判 `order` 是不是数组且非空；`chosen`（`:136-138`）先在 `100000` 那一组里找非空的，找不到再按文件顺序找第一个非空的组；`chosen === undefined` 才返回 `null`（`:139`），调用方照旧回落到 `prompts` 原顺序。组结构不认识仍然返回 `null`、不抛错，错误口径没变。
- 语义没变的部分：顺序表之外的段仍按原顺序接在末尾、启用与否只看段自己的 `enabled`（`:231-234`）；marker 段仍进 `ignored(marker)`（`:249-252`）；`jailbreak` / `injection_position = 1` 的启用段仍搬进 `postHistory`、写 global 深度注入 `depth = 0`（`:276-280`）。
- 回归测试：`test/prompt.sillytavern.test.ts:136-159`「主对话项的顺序表是空数组时，改用下一项非空顺序表（真实预设就是这样）」，断言只留启用段、顺序按下一组非空表走；该文件 27 例通过。
- 实测（同一份真实预设，临时测试已删）：`segments=28`、`moved=[{identifier:'jailbreak',name:'继续游戏'}]`，顺序是 0 （不要关）token重定义+初始化 / 1 （必看）免责声明 / 2 用户角色 / 3 （不要关）召唤术 / 4 别关 / 5 char / 6 /char / 7 （不要关）上下文构造-衔接 / 8 ----角色控制---- / 9 😸情绪别太激烈 / 10 😸活人感加强 …（marker 段不进段表，Persona Description、World Info 这些不在其中）。
- 迁移：这一版没有新迁移，仍是 29 个、末尾 `0029_world_books.sql`；新库首启 `applied=29 skipped=0`，已有 29 个迁移的库就地升级是 `applied=0 skipped=29`。
- 判据：导入后顺序不对，按 `docs/operations.md` §34.1 第 8 条回读 `GET /api/prompts`，把目标层（`preset-1` 到 `preset-4` 是 global 层）的段按 `position` 排出来与酒馆的链逐项对。

## 49. 路由采样参数

模型路由的三层配置多了五个可选的采样参数：`topP` / `topK` / `seed` / `frequencyPenalty` / `presencePenalty`。它们跟 `temperature` / `maxTokens` 存在同一张 `routes` 表、同一份三层配置里，命中哪一层就整层生效；**留空 = 这一层不设，交给上游自己的默认**，而 `0` 是有效值——`topP: 0` 与「没填」在库里、接口上、线缆上都是两件事。提示词层没有这五项：采样只从路由取。

### 49.1 数据与接口

- 迁移：`migrations/0027_route_sampling.sql` 给 `routes` 加五列，**全可空**——`top_p REAL` / `top_k INTEGER` / `seed INTEGER` / `frequency_penalty REAL` / `presence_penalty REAL`（`migrations/0027_route_sampling.sql:3-7`）。文件头注释定的口径：`NULL = 这一层不设（上游用自己默认），0 是有效值，必须和 NULL 分开`（`:1`）。
- 类型：`RouteConfig` 的这五项都是 `?: number`（`src/core/types.ts:185-196`，注释在 `:190`）。
- 读：`GET /api/routes`（`src/workers/http/app.ts:992`）回 `{ items }`，五项原样带回。仓储的 SELECT 已带这五列（`src/workers/db/d1-repository.ts:730` 单行 / `:738` 全表），行 → 配置逐个判 `!== null` 才写键（`:424-428`）。
- 写：`PUT /api/routes`（`src/workers/http/app.ts:994`）读五个可选数字（`:1003-1007`），范围表在 `:154-157`：
  - `topP` 0–1（实数）、`topK` 1–1000（整数）、`seed` 0–2147483647（整数）、`frequencyPenalty` / `presencePenalty` -2–2（实数）。
  - 越界、整数字段填小数、非数字，全都汇合到同一个判定（`:1008-1018`）回既有的 `400 BAD_REQUEST`（`badRequest`，`src/workers/http/app.ts:640`）——**没有新错误码**。
  - 只有值不是 `undefined` 才写进 `cfg`（`:1042-1048`），成功回 `routeDto`（`:1051`）。
- 存：UPSERT 的列、冲突更新列表与绑定值都在 `src/workers/db/d1-repository.ts:746-774`（`top_p` 起五列依次在 `:753-757` 与 `:768-772`）。
- 后台：「模型路由」卡片（`web/src/pages/RoutesPage.tsx:151`）在 temperature / maxTokens 之后多两排输入框——`topP` / `topK` / `seed` 一排（`:222` / `:226` / `:230`），`frequencyPenalty` / `presencePenalty` 一排（`:236` / `:240`）；留空 = 不设（保存 `:84-88` 的 `parseOptionalNumber`，读回 `:120-124`）。

### 49.2 行为与护栏（行号实测）

- 取值只在一处：`src/core/chat/service.ts:1157-1166`。`temperature` / `maxTokens` 仍是 `route.X ?? promptHit.cfg.X`（`:1157-1158`，路由优先、回落提示词层）；**采样五项只从 `route` 取**——`sampling` 先建空对象（`:1161`），五项各自 `if (route.X !== undefined)` 才赋值（`:1162-1166`）。判 `undefined` 而不是判真假，`0` 才不会被吞掉（注释 `:1159-1160`）。
- 首段请求：`src/core/chat/service.ts:1204-1212`，`...sampling` 在 `:1209`，temperature / maxTokens 在 `:1211-1212` 之后单独补。
- 续写请求：同样带这五项（`src/core/chat/service.ts:1244-1251`，`...sampling` 在 `:1248`）。续写对象是新造的，`:1242-1243` 的注释写明只继承取词参数、绝不 `...request`（避免把图片挂到「继续写」那条指令上）。
- 表情（`src/core/chat/reaction.ts:121` 的注释写明不设 temperature / maxTokens，请求在 `:153-156` 只有 model / system / messages）与识图（`src/core/chat/emoji-describe.ts:56-59`）**故意不设采样**：这两条路径不读路由的五项。
- 线缆形状（未设置一律不带键，适配器侧每个字段都是 `...(req.X === undefined ? {} : { ... })`）：
  - `openai-compat`：发 `top_p` / `frequency_penalty` / `presence_penalty` / `seed`（`src/core/providers/openai-compat.ts:69-72`）；**没有 `top_k`**——注释在 `:68`，填了也不发，免得上游直接 400。
  - `gemini`：`generationConfig` 里发 `topP` / `topK` / `seed` / `frequencyPenalty` / `presencePenalty`（`src/core/providers/gemini.ts:55-59`）。
  - `anthropic`：**只发 `top_p`**（`src/core/providers/anthropic.ts:82-83`）；`top_k` / `seed` / 两个 penalty 即使填了也不发。

### 49.3 与既有装配的关系

- 采样参数不进 `system`、也不进 `messages`：它只挂在 `LlmRequest` 上。`system` 的拼接在 `src/core/chat/service.ts:1147-1157`、`messages` 的装配在 `:1177-1180`；`preset-head-1`（§52）动的是 `system` 里各块的前后与本轮那条 user 消息的前缀，与采样参数一个字节都不相干。
- 三层选择沿用既有的 `resolveRoute`（`src/core/chat/service.ts:1075`）：`channel > guild > global`，命中哪一层就用那一层**整份**配置，不是逐项合并。所以「频道层只填了 `topP`」等于这一层的 `topK` / `seed` / 两个 penalty 也是空的，不会回落到服务器层。
- 五项都没设时请求形状与接线前逐字相同：`sampling` 里一个键都没有，`...sampling` 展开成空对象。
- 与提示词层的 `temperature` / `maxTokens` 不是同一条来源规则：那两项路由优先、回落提示词层；采样五项没有提示词层这一路。

### 49.4 代码地图

| 位置 | 内容 |
| --- | --- |
| `migrations/0027_route_sampling.sql:3-7` | `routes` 加五列（全可空，NULL = 不设） |
| `src/core/types.ts:185-196` | `RouteConfig` 的五项（`?: number`） |
| `src/workers/http/app.ts:992` | `GET /api/routes`（原样带回五项） |
| `src/workers/http/app.ts:994` | `PUT /api/routes` |
| `src/workers/http/app.ts:1003-1007` | 五个 `readOptionalNumber` |
| `src/workers/http/app.ts:154-157` | 五组范围（0–1 / 1–1000 / 0–2147483647 / -2–2） |
| `src/workers/http/app.ts:1008-1018` | 越界 → 既有 `400 BAD_REQUEST`（无新错误码） |
| `src/workers/http/app.ts:1042-1048` | 只有非 `undefined` 才写进配置 |
| `src/workers/db/d1-repository.ts:730` / `:738` | SELECT 五列（单行 / 全表） |
| `src/workers/db/d1-repository.ts:746-774` | UPSERT 列、冲突更新与绑定值 |
| `src/core/chat/service.ts:1159-1166` | 采样对象构造（只从路由取，判 `undefined`） |
| `src/core/chat/service.ts:1204-1212` | 首段请求带 `...sampling` |
| `src/core/chat/service.ts:1244-1251` | 续写请求带 `...sampling` |
| `src/core/providers/openai-compat.ts:68-72` | 兼容协议映射（无 `top_k`） |
| `src/core/providers/gemini.ts:55-59` | `generationConfig` 五项 |
| `src/core/providers/anthropic.ts:82-83` | 只发 `top_p` |
| `web/src/pages/RoutesPage.tsx:222-241` | 后台两排输入框（留空 = 不设） |

## 50. 深度注入

后台「提示词」页多了一张「深度注入」卡片：按 `channel` / `guild` / `global` 三层各存一条 `{ content, depth, role }`，每条回复在 `messages` 的倒数第 `depth` 条之前插入一条**合成消息**。语义照 SillyTavern 的 depth prompt：它是对话侧的一条「临场提醒」，不是提示词层的一段——`system` 一个字都不加，段装配的顺序也没变。

### 50.1 数据与接口

- 迁移：`migrations/0028_prompt_injections.sql:3-11` 建 `prompt_injections`——`scope`（`global` / `guild` / `channel`，CHECK）、`scope_id`、`content`、`depth`、`role`（`system` / `user` / `assistant`，CHECK）、`updated_at`，主键 `(scope, scope_id)`：一层一行。文件头注释：`depth 是「倒数第几条之前」：0 = 紧接本轮用户消息之前；content 空串表示这一层关着`（`:2`）。
- 类型：`PromptInjectionConfig`（`src/core/types.ts:478-485`）。
- 常量：`INJECTION_DEPTH_MAX = 50`（`src/core/prompt/injection.ts:4`）、`INJECTION_CONTENT_MAX_CHARS = 20000`（`:6`）、`INJECTION_ROLES`（`:20`）。
- 读：`GET /api/prompt-injections`（`src/workers/http/app.ts:809-813`）→ `{ items: [...] }`；仓储没接线时回 `501 INJECTION_UNAVAILABLE`（`:811`）。仓储 `list()` 按 `scope ASC, scope_id ASC` 排序（`src/workers/db/d1-repository.ts:1346`）。
- 写：`PUT /api/prompt-injections`（`src/workers/http/app.ts:815-836`），body `{ scope, scopeId, content, depth, role }`，四个 400 码：
  - `BAD_SCOPE`：scope / scopeId 不合法（`:821`，沿用既有 `readScopeKey`，`src/workers/http/app.ts:429`）。
  - `BAD_INJECTION_CONTENT`：`content` 不是 string，或长度 > 20000（`:826-827`）；**空串合法**——它就是「这一层关掉」的写法。
  - `BAD_INJECTION_DEPTH`：不是 0–50 的整数（`:830`，判定在 `src/core/prompt/injection.ts:23-25`）。
  - `BAD_INJECTION_ROLE`：不是三个角色之一（`:832`，判定在 `:27-29`）。
  - 成功回**整行**（`:834-835`），含 `updatedAt`。
- 删：`DELETE /api/prompt-injections`（`:838-848`）返回 `{ ok: true }`；命中 0 行也回 `ok`——仓储 `remove` 不看 `changes`（`src/workers/db/d1-repository.ts:1384-1387`）。
- 存：`get`（`src/workers/db/d1-repository.ts:1337`）/ `list`（`:1346`）/ `put`（`:1361`，UPSERT 一层一行，空正文照存）/ `remove`（`:1384`）；端口声明在 `src/workers/db/d1-repository.ts:615`，装配进 deps 在 `:1660`。
- 后台：「深度注入（按深度插一条消息）」卡片（`web/src/pages/PromptsPage.tsx:1076`）：三层 tab（各带「已配置 / 未配置」）+ `role` 下拉（`:1136`）+ `depth` 数字（`:1146`）+ 正文 textarea（`:1158`）+ 字数与「上次保存 <updatedAt>」（`:1161-1162`）+ 保存 / 删除这一层（`:1166-1178`）。正文留空保存 = 关掉这一层，页面上写明了（`:1077-1080`）。

### 50.2 行为与护栏（行号实测）

- 三层解析：`resolveInjection`（`src/core/prompt/injection.ts:40-49`）按 `channel → guild → global` 找第一层 `isConfigured` 的；`isConfigured` 是 `cfg !== null && cfg.content.trim() !== ''`（`:32-34`）——**空白正文等于没配，继续往下找**；三层都空 / 都没有回 `null`（`:48`），= 这一轮什么都不插。
- 插入：`withInjection`（`src/core/prompt/injection.ts:56-68`）：
  - 没配置时**原样返回同一个数组**（`:60`）——无注入的 `messages` 与加这个功能之前逐字相同，续写路径拿到的也是这同一个数组。
  - 空历史直接返回（`:62`）：没有对话时插进去的合成消息没有任何可依附的位置。
  - 位置：`depth` 先取整（非有限数落 0，`:63`），再 clamp 到 `[0, messages.length - 1]`（`:64`），落点 `at = messages.length - 1 - clamped`（`:65`），在 `at` 之前插入（`:67`）。
  - 合成消息只有 `{ role, content }`（`:66`）：没有 `author`，因此**不会**被 `withAuthorPrefix` 加上名字前缀。
- 装配点：`src/core/chat/service.ts:1177-1180`——`withInjection([...promptParts.userMessages, ...kept, withAuthorPrefix(turnUser)], injection)`；三层分别在 `:1081-1083` 读（每层读失败只当这一层没配，`readInjection` `:800-808`），`:1105` 合成三层结果。数组末尾是本轮用户消息，所以 `depth = 0` 就是「紧接本轮用户消息之前」。
- `system` 只在 `src/core/chat/service.ts:1147-1157` 拼一次（`preset-head-1` 起的块序见 §52）：深度注入只动 `messages`。
- 表情（`src/core/chat/reaction.ts:153-156`）与识图（`src/core/chat/emoji-describe.ts:56-59`）各自造请求、不经过这条装配，所以**不注入**。
- 跨提供方：
  - `anthropic`：`messages[].role` 只接受 `user` / `assistant`，`wireMessage` 把 `role === 'system'` 按 `user` 发（`src/core/providers/anthropic.ts:34-36`）。
  - `gemini`：非 `assistant` 一律映射成 `user`（`src/core/providers/gemini.ts:44`），所以 `system` / `user` 两种注入都占 `user` 的角色位。
  - `openai-compat`：`messages` 前面本来就内联一条 `{ role: 'system', content: req.system }`（`src/core/providers/openai-compat.ts:65`），注入的 `role: 'system'` 原样作为对话侧的一条 system 发出去。

### 50.3 与既有装配的关系

- `messages` 只有这一处装配：`[...promptParts.userMessages, ...kept, withAuthorPrefix(turnUser)]`（`src/core/chat/service.ts:1177-1178`）。注入在数组**拼好之后**做，所以提示词里的 `role: 'user'` 段、历史、本轮三段之间的相对顺序都没变。
- 没有注入时是同一个数组（`src/core/prompt/injection.ts:60`），续写用的 `continuationMessages(messages, raw)`（`src/core/chat/service.ts:1247`）拿到的输入与旧版一致；首段与续写共用同一份 `messages`，所以注入不会在续写里丢、也不会插两次。
- 名字前缀只作用于历史与本轮（`src/core/chat/service.ts:1136` 的 `kept.map(withAuthorPrefix)`、`:1178` 的 `withAuthorPrefix(turnUser)`）；合成消息没有 `author` 字段，不加前缀。
- 注入只加一条消息，不改 `system`、不改段装配（`collectSegments` / `buildPromptParts` 那一层，§48.4）。

### 50.4 代码地图

| 位置 | 内容 |
| --- | --- |
| `migrations/0028_prompt_injections.sql:3-11` | 建表（主键 `(scope, scope_id)`，`role` CHECK） |
| `src/core/types.ts:478-485` | `PromptInjectionConfig` |
| `src/core/prompt/injection.ts:4` / `:6` | 深度上限 50 / 正文上限 20000 |
| `src/core/prompt/injection.ts:23-29` | `isInjectionDepth` / `isInjectionRole` |
| `src/core/prompt/injection.ts:32-34` | `isConfigured`（空白正文 = 这一层关着） |
| `src/core/prompt/injection.ts:40-49` | `resolveInjection`（三层，跳过空层） |
| `src/core/prompt/injection.ts:56-68` | `withInjection`（clamp / 落点 / 合成消息） |
| `src/core/chat/service.ts:1053-1055` | 三层各读一次（读失败按上层继续） |
| `src/core/chat/service.ts:1074` | `resolveInjection` 的结果 |
| `src/core/chat/service.ts:1131-1134` | `messages` 装配点（注入在这里发生） |
| `src/workers/http/app.ts:809-813` | `GET /api/prompt-injections` |
| `src/workers/http/app.ts:815-836` | `PUT`（四个 400 码） |
| `src/workers/http/app.ts:838-848` | `DELETE`（恒 `{ ok: true }`） |
| `src/workers/db/d1-repository.ts:1333-1387` | `promptInjections` 仓储四个方法 |
| `src/workers/db/d1-repository.ts:1660` | 装配进 deps |
| `src/core/providers/anthropic.ts:34-36` | `system` 注入按 `user` 发 |
| `src/core/providers/gemini.ts:44` | 非 assistant → `user` |
| `web/src/pages/PromptsPage.tsx:1076-1178` | 后台卡片（三层 / role / depth / 正文 / 保存删除） |

排错步骤与回滚写在 `docs/operations.md` §33。

## 51. 世界书（阶段三）

`preset-3` 起提示词里多了一层「世界书」：把 SillyTavern 的 lorebook（关键词触发的设定条目）按 channel / guild / global 三层各存一本，每轮挑出命中的条目、把正文拼成一段 `【世界书】` 塞进 system 提示词。解析与拼装都在新文件 `src/core/prompt/worldbook.ts`（387 行）里，装配在 `src/core/chat/service.ts`。没配置任何一本世界书时 `worldPart` 为空串，system 与旧版逐字相同。

### 51.1 数据与存档

- 迁移：`migrations/0029_world_books.sql`（11 行）建 `world_books(scope, scope_id, name, book_json, entry_count, imported_at)`，主键 `(scope, scope_id)`，`scope` 带 `CHECK` 三档（`global` / `guild` / `channel`）。一本书一格：`book_json` 存的是**解析后的规范化书本**（`WorldBook` 形状），不是酒馆原文。
- 类型（`src/core/prompt/worldbook.ts`）：`WorldEntry` `:4`、`WorldIgnored` `:20`、`WorldBook` `:27`、`WorldBookParseResult` `:34`、`WorldBookRecord` `:39`、`WorldBookStore` `:46`。
- 常量：`WORLD_SCAN_DEPTH_DEFAULT = 4`（`:53`）、`WORLD_SCAN_DEPTH_MAX = 20`（`:54`）、`WORLD_BLOCK_MAX_CHARS = 4000`（`:55`）。
- 仓储：`src/workers/db/d1-repository.ts` 的 `worldBooks` `:1448-1504`（`get` / `list` / `put` 单行 upsert / `remove`）；接线 `src/node/main.ts:232` 与 `src/workers/index.ts:261` 都是 `worldBooks: data.worldBooks`。
- 迁移口径：`0029` 是第 29 个；老库（28 个迁移）升级是 `applied=1 skipped=28`，新库首次启动是 `applied=29 skipped=0`（见 `docs/hosting.md`）。

### 51.2 解析与条目取舍

- `parseWorldBook`（`:207`）接受三种输入：酒馆单独导出的世界书 JSON、角色卡 V2 的 `character_book`（顶层或 `data.character_book` 都认）、以及带 `entries` 的对象。解析失败回 `BAD_WORLDBOOK` / `NO_WORLD_ENTRIES`（HTTP 400）。
- 条目字段收敛成：`id` / `name` / `keys` / `secondaryKeys` / `content` / `enabled` / `constant` / `selective` / `selectiveLogic`（`andAny` | `andAll` | `notAny` | `notAll`）/ `order` / `caseSensitive` / `wholeWords`。
- 导入时被跳过的条目进 `ignored`，`reason` 三档：`empty`（正文空）/ `noKeys`（非常驻却没有关键词）/ `disabled`。
- 是否启用：`readFlag(item['enabled'], true) && !readFlag(item['disable'], false)`（`:229-230`）——`enabled` 缺省为真，`disable` 为真则关。

### 51.3 触发与装配

- 取书：`resolveWorldBook`（`:279`）按 `channel > guild > global` 取第一本非空。
- 扫描窗口：`selectWorldEntries`（`:354`）拿最近 N 条消息做扫描窗口，默认 4 条（`WORLD_SCAN_DEPTH_DEFAULT`，`:357`），N 上限 20（`clampScanDepth` `:313`）；窗口里的用户文本用**未署名原文**。
- 命中：`constant` 条目每轮必插；其余大小写不敏感（条目 `caseSensitive` 为真时区分）、`wholeWords` 按词边界、`selective` 配合 `secondaryKeys` 与 `selectiveLogic` 一起判。命中后按 `insertion_order`（即 `order`）排序。
- 出块：`buildWorldBlock`（`:379`）输出 `【世界书】` + 换行 + 命中正文用两个换行拼接；总量上限 4000 字符，只按正文 `trim` 后累加、外加条目之间 2 字符（标题行不计，所以理论最大约 4006），放不下的条目直接不进块（`:371` `if (used + cost > WORLD_BLOCK_MAX_CHARS) continue;`）。
- 装配（`src/core/chat/service.ts`）：deps 可选 `worldBooks?: WorldBookStore`（`:118`、`:503`）；`readWorldBook` `:786-794`（读失败只 `warn`，当这层没有）；三层并行读 `:1084-1086`；`hit` 判定 `:1107`（`resolveWorldBook(channelWorldBook, guildWorldBook, globalWorldBook)`）；扫描窗口 `worldWindow` `:1138`；`worldBlock` `:1140`；`worldPart` `:1142`（自带两个前导换行）；`preset-head-1` 起它拼在表情块之后、预设 `after` 段之前（`system` 的 `:1156`，§52）。
- 没有世界书时 `worldPart` 是空串，system 与旧版逐字相同——这是回归时的判据。

### 51.4 接口与错误码

都在 `src/workers/http/app.ts`：

- `GET /api/world-book`（`:856`）：`items` 带 `scope` / `scopeId` / `name` / `entryCount` / `importedAt`，以及条目摘要 `id` / `name` / `keys` / `secondaryKeys` / `constant` / `enabled` / `order` / `chars`（`chars` 按码点算）。
- `POST /api/world-book/import`（`:882`）：body `{scope, scopeId, book}`，**整本覆盖该层**，回 `entryCount` / `ignored` / `warnings` / `replaced`（`replaced` = 该层原条目数）。
- `DELETE /api/world-book`（`:914`）：`scope` 与 `scopeId` 走 **JSON body**，不是 query 参数。
- 错误码：store 没接线一律 `501 WORLDBOOK_UNAVAILABLE`（`:858` / `:884` / `:916`）；`scope` 非法 `400 BAD_SCOPE`；解析失败 `400 BAD_WORLDBOOK` / `400 NO_WORLD_ENTRIES`。
- 后台：`web/src/pages/PromptsPage.tsx` 的「世界书」卡片 `:1461-1586`，位置在「深度注入」卡片之后；三层 tab、选文件或粘贴、整层覆盖二次确认、条目摘要表、删除该层；处理函数 `:791` / `:800` / `:841` / `:852` / `:887` / `:906` / `:945`。接口封装 `web/src/api.ts`：`fetchWorldBook` `:2820`、`importWorldBook` `:2835`、`deleteWorldBook` `:2872`、`describeWorldBookError` `:2880`；样式在 `web/src/styles.css` 的 `.page.prompts .worldbook-*`（`:1424-1492`）。

### 51.5 限制

①只有关键词触发，没有向量检索、没有权重/概率、没有递归触发；②扫描深度固定 4 条（常量默认，接口未暴露，1–20 只能在代码里调）；③命中块总量上限 4000 字符，超出的条目静默不进块；④一本书整体存成一格 JSON，导入即整本覆盖、没有逐条编辑；⑤角色卡里的 `character_book` 与单独的世界书 JSON 都能导，但仍是「手动导入」——不会随预设导入自动带上。

### 51.6 代码地图

| 位置 | 内容 |
| --- | --- |
| `src/core/prompt/worldbook.ts:4` / `:20` / `:27` / `:34` / `:39` / `:46` | 类型：条目 / 被跳过的条目 / 规范化书本 / 解析结果 / 存档记录 / 仓储端口 |
| `src/core/prompt/worldbook.ts:53-55` | 三个常量：扫描默认 4 / 上限 20 / 块上限 4000 |
| `src/core/prompt/worldbook.ts:207` | `parseWorldBook`，接受世界书 JSON、`character_book`、带 `entries` 的对象 |
| `src/core/prompt/worldbook.ts:229-230` | 启用判定：`enabled` 且非 `disable` |
| `src/core/prompt/worldbook.ts:279` | `resolveWorldBook`，`channel > guild > global` 取第一本非空 |
| `src/core/prompt/worldbook.ts:313` / `:322` | `clampScanDepth` / 扫描窗口 |
| `src/core/prompt/worldbook.ts:354` | `selectWorldEntries`：constant / 大小写 / wholeWords / selective / 按 order 排序 |
| `src/core/prompt/worldbook.ts:371` / `:379` | 4000 字上限丢条 / `buildWorldBlock` |
| `migrations/0029_world_books.sql:3` | `world_books` 建表，主键 `(scope, scope_id)` |
| `src/workers/db/d1-repository.ts:1448-1504` | `worldBooks` 仓储（get / list / put / remove） |
| `src/node/main.ts:232` / `src/workers/index.ts:261` | 装配 `worldBooks: data.worldBooks` |
| `src/core/chat/service.ts:118` / `:503` | deps 可选 `worldBooks` |
| `src/core/chat/service.ts:786-794` | `readWorldBook`，读失败只 warn |
| `src/core/chat/service.ts:1084-1086` | 三层并行读 |
| `src/core/chat/service.ts:1107` / `:1138` / `:1140` / `:1142` / `:1154` | hit 判定 / 扫描窗口 / `worldBlock` / `worldPart` / 在 `system` 里的位置 |
| `src/workers/http/app.ts:856` / `:882` / `:914` | GET / POST import / DELETE |
| `web/src/api.ts:2820` / `:2835` / `:2872` / `:2880` | `fetchWorldBook` / `importWorldBook` / `deleteWorldBook` / `describeWorldBookError` |
| `web/src/pages/PromptsPage.tsx:1461-1586` | 「世界书」卡片 |
| `web/src/styles.css:1424-1492` | `.page.prompts .worldbook-*` |

排错步骤与回滚写在 `docs/operations.md` §34。

## 52. preset-head-1：预设回到天头，长期记忆摘要跟着用户消息（2026-11-06）

这一版动两处：`system` 的第一块从身份块换成预设 `before` 段；长期记忆摘要整体搬出 `system`，改为拼在本轮那条 user 消息的最前面，跟着用户这一句一起发。没有新迁移（仍是 29 个）、没有新配置项、没有新接口字段。代码与测试注释里的「§52」指的就是本节。

### 52.1 记忆摘要成了用户消息的前缀

`renderSummaryBlock`（`src/core/chat/summary.ts:173-177`）一个字没改：摘要为空返回空串，否则返回 `'\n\n【长期记忆摘要】\n' + 正文`——前导两个换行是它当年接在 `system` 里时的分隔约定。现在由调用方把这几个换行削掉、接在本轮那条用户消息前面（取块在 `src/core/chat/service.ts:1158-1160`，拼行在 `:1178-1180`）：

```
const turnPrompt: ChatMessage = withAuthorPrefix(turnUser);
if (summaryBlock !== '') turnPrompt.content = summaryBlock.replace(/^\n+/, '') + '\n\n' + turnPrompt.content;
```

拼出来是**一条**消息，不是两条：

```
【长期记忆摘要】
<摘要正文>

<时刻> <作者名>：<本轮正文>
```

`system` 里不再出现【长期记忆摘要】。没有摘要时 `summaryBlock` 是空串，这条 user 消息与旧版逐字相同——回归时就比这一条。

### 52.2 system 装配顺序：预设 before 段在天头，after 段收尾

`src/core/chat/service.ts:1112-1117` 的注释与 `:1144-1157` 的一行拼接在 `preset-head-1` 时按这个次序（自上而下；`identity-off-1` 起第 2 项只在没有任何前置预设段时非空，见 §53.3）：

1. `presetHead`——预设 `before` 段，`src/core/chat/service.ts:1145` 给整段后面补 `\n\n`（`:1144` 注释：它自己不带前导空行，用两个换行和后面的平台元信息分开）——现在是 `system` 的第一块；
2. `identityBlock.replace(/^\n+/, '')`——身份块，`:1150` 就地削掉它的前导换行（`:1147` 注释写明那是「原先当天头时的分隔约定」）；`identity-off-1` 起它只在 `promptParts.before === ''` 时非空（`src/core/chat/service.ts:1122-1136`），有 `before` 段时这一项是空串、`system` 里没有身份块（§53）；
3. `mentionRule`（@ 提及规则，`:1151`）；
4. `renderReactionGuide(guide.prompt)`——表情规则；
5. `renderVoiceHint(ctx.voiceHint)`——语音提示；
6. `renderEmojiBlock(ctx.customEmojis)`——自定义表情清单；
7. `renderReactionTargets(ctx.reactionTargets)`——可贴表情目标；
8. `worldPart`——世界书，`:1156`（自带两个前导换行）；
9. `presetAfter`——预设 `after` 段，`:1157` 补前导 `\n\n`，它是 `system` 的最后一块。

旧顺序（`identity-head-1` 及以前）是：身份块 → 提及规则 → 表情规则 → 语音提示 → 自定义表情清单 → 可贴表情目标 → 世界书 → 预设 `before` 段 → 记忆/摘要块 → 预设 `after` 段；再往前（`preset-4` 及以前）：`before` 段 → 世界书 → 身份块 → 摘要块 → `after` 段 → 提及规则 → 表情规则 → 语音提示 → 自定义表情清单 → 可贴表情目标。块集合没变，改的是两块的位置：预设 `before` 段从「压在身份块之后」挪到天头，摘要块整块搬出 `system`。空块仍是空串（各 `render*` 没内容时返回 `''`），所以块序变化不会凭空多出空行。`identity-off-1` 起第 2 项退化为空串：有 `before` 段时身份块整块不出现，其余八项与上面一致（§53.3）。

### 52.3 只挪位置，其余不动

- 迁移：没有新的，`migrations/` 末尾仍是 `0029_world_books.sql`、共 29 个；升级这一版是 `applied=0 skipped=29`。
- 摘要的内容与渲染函数没变（仍是 `renderSummaryBlock` 与 `summaryMaxChars` 预算），变的是它落在哪条消息里：从 `system` 的一条块变成本轮 user 消息的前缀。
- 预设段的文字内容、三层/频道层选择、世界书命中与扫描窗口、@ 提及规则、emoji 规则、语音提示——内容与渲染函数都没变。
- 深度注入仍只动 `messages`：装配是 `withInjection([...promptParts.userMessages, ...kept, turnPrompt], injection)`（`src/core/chat/service.ts:1183-1186`），`turnPrompt` 就是带摘要前缀的那一条，注入点相对它算；表情与识图两条路径不经过这条装配。
- 可观测差异只有两处，`[chat] turn … summaryLen=… systemLen=…`（`src/core/chat/service.ts:1194-1208`）：`summaryLen` 是本轮摘要的总长，`systemLen` 从此不再包含摘要——摘要变长时 `summaryLen` 变、`systemLen` 不动，这是最省事的判据（排错见 `docs/operations.md` §34.4）；以及请求体里最后一条 user 消息的形状。

### 52.4 代码地图

| 位置 | 这一版的样子 |
| --- | --- |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'preset-head-1'` |
| `test/gateway.node.test.ts:229` | 期望 `[gateway] node host started build=preset-head-1` |
| `src/core/chat/service.ts:1112-1117` | 装配顺序注释（预设 → 平台元信息 → 世界书 → 收尾） |
| `src/core/chat/service.ts:1144-1157` | `presetHead` / `presetAfter` 与 `const system = …` 的块序（§52.2） |
| `src/core/chat/service.ts:1158-1160` | `summaryBlock` 取块 |
| `src/core/chat/service.ts:1178-1180` | 摘要削掉前导换行后拼在本轮 user 消息前面 |
| `src/core/chat/service.ts:1183-1186` | `withInjection([...promptParts.userMessages, ...kept, turnPrompt], injection)` |
| `src/core/chat/summary.ts:173-177` | `renderSummaryBlock`（形状不变，前导换行由调用方削） |
| `web/src/api.ts:323` / `:1787` / `:2263` / `:2555` | 段头注释里的门牌 |
| `web/src/styles.css:1501` | 样式段头注释里的门牌 |

## 53. identity-off-1：有预设段时不再追加身份块（2026-11-06）

这一版只改一处判断：`system` 里的身份块从「每轮都拼」改成「只有这一轮没有任何前置预设段时才拼」。**这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就完全没有身份块。** 没有新迁移（仍是 29 个）、没有新配置项、没有新接口字段，后台能编辑的东西一样没少；门牌 `identity-off-1` 接在 `preset-head-1` 之后（§52）；这一版之后：`preset-head-1`（§52）、`reply-tool-1` / `reply-tool-3`（§54）、`context-tool-1` 到 `context-tool-3`（§55）、`context-tool-4`（已回退）、`context-tool-5`（§55），现版门牌是 `preset-import-2`（§58），前一版是 `context-stream-1`（§57），再上一版是 `preset-import-1`（§56）。

### 53.1 改了什么

`src/core/chat/service.ts:1122-1136` 把身份块从「每轮无条件拼」改成「按预设段有无决定拼不拼」：

```ts
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
```

判断只看 `promptParts.before`：它是三层预设里所有启用的 `before` 段拼出来的串，只要不是空串，`identityBlock` 就是空串。`resolveIdentityBlock`（`src/core/chat/service.ts:334`）与那三层 `pickScopedTemplate` 一个字没改——模板还是同一份、分层还是 channel > guild > global，只是调用挪到了条件后面。

注释就写在这段上面（`src/core/chat/service.ts:1122-1125`）：

> 有预设段时不再追加身份块（§52）：预设里的角色卡已经交代了「我是谁、这是谁在说话」，再叠一层平台口吻的身份行，等于把对话拽回「你在某个聊天平台上当机器人」。预设为空时它照旧兜底——那时主模型除了这几行没有任何来历（身份块仍可分层、仍走同一份模板）。

（注释里标的 `§52` 是它写下时的那一节，正式记录是本节 §53。）

### 53.2 为什么


问题不在措辞对不对，而在它和角色卡重复、方向还相反：角色卡已经交代「我是谁、这是谁在说话」，再叠一层平台口吻的身份行，等于把模型拽回「你在某个聊天平台上当机器人」的口径——角色演得越像，这层口径越碍事。所以有预设段（尤其导入了角色卡）时整块让位；预设为空时才用它兜底，那时主模型除了这几行没有任何来历。

### 53.3 现在的 system 顺序

`src/core/chat/service.ts:1153-1162` 的拼接没变（仍是同一串加法），变的是第 2 项什么时候非空——`identity-off-1` 起它只在 `promptParts.before === ''` 时才是身份块（`src/core/chat/service.ts:1126-1136`）：

1. `presetHead`——预设 `before` 段，`src/core/chat/service.ts:1145` 给整段后面补 `\n\n`；
2. `identityBlock.replace(/^\n+/, '')`——**只在没有任何前置预设段时非空**，有 `before` 段时是空串；
3. `mentionRule`（@ 提及规则）；
4. `renderReactionGuide(guide.prompt)`——表情规则；
5. `renderVoiceHint(ctx.voiceHint)`——语音提示段（只有 `mode = 1`）；
6. `renderEmojiBlock(ctx.customEmojis)`——自定义表情清单；
7. `renderReactionTargets(ctx.reactionTargets)`——可贴表情消息；
8. `worldPart`——世界书（自带两个前导换行）；
9. `presetAfter`——预设 `after` 段，`system` 的最后一块。

所以正常情况（有预设段、`identityBlock` 是空串）实际看到的是：**预设段 → 【提及】规则 → 【表情】规则 → 语音提示段（仅模式 1）→ 自定义表情清单 → 可贴表情消息 → 世界书 → `after` 段**。身份块只在没有任何前置段时插在预设段之后——那时 `presetHead` 也是空串，它其实就是天头第一块；`src/core/chat/service.ts:1147` 的 `replace(/^\n+/, '')` 仍保留，因为身份行自带两个前导换行，只有它真当天头时才需要削掉。

### 53.4 行为边界

- 身份块**没有删**：仍可分层（channel > guild > global）、仍可在后台编辑（`prompt_defaults` 的 `identity` key）、仍走 `resolveIdentityBlock`（`src/core/chat/service.ts:334`）、仍是同一份模板。
- 它只在「这一轮没有任何前置预设段」时兜底出现，例如某层只配了 `after` 段、又没配 fallback 文案（此时 `promptParts.before === ''`）。
- 默认配置（三层都空 → 代码内置 `DEFAULT_PROMPT`，`src/core/prompt/resolver.ts:5`）有 `before` 段（`基本设定`），所以线上实际不会出现身份块；想看兜底，得把三层的 `before` 段全删掉。
- 后台文案同步改成同一条口径（`web/src/pages/PromptsPage.tsx:1057`、`:1071`）：「兜底用的身份块：只在这一轮没有任何前置预设段时才出现（有角色卡就不需要它）」；placeholder 是「留空 = 用代码内置：身份块用代码生成的那份（只在没有前置预设段时出现，保存后覆盖这一层）」。
- 迁移：没有新的，`migrations/` 末尾仍是 `0029_world_books.sql`、共 29 个，升级这一版是 `applied=0 skipped=29`。
- 其余全部沿 §52：摘要仍跟着本轮 user 消息、深度注入仍只动 `messages`；`systemLen` 仍不含摘要，这一版起也不含身份块（有预设段时整块不出现），判据见 `docs/operations.md` §34.4。
- 测试同步：`test/chat.identity.test.ts:130-132` 改成断言 `system` 不含【当前对话】；`test/chat.prompt-defaults.test.ts` 的套件改名「run 身份块（只在没有预设段时兜底）」，6 例（有预设段时三层身份块都不进 `system`；预设段为空时照旧分层；只配收尾段时身份块兜底并排在收尾段前；等）；`test/chat.service.test.ts:714-718` 的 `platformHead()` 不再拼 `buildIdentityBlock`；`test/chat.summary.test.ts:479-483` 同步。

### 53.5 代码地图

| 位置 | 这一版的样子 |
| --- | --- |
| `src/core/chat/service.ts:1122-1136` | 注释与 `const identityBlock = promptParts.before === '' ? … : ''`（§53.1） |
| `src/core/chat/service.ts:1153-1162` | `const system = presetHead + identityBlock.replace(…) + …` 的块序（§53.3） |
| `src/core/chat/service.ts:1147` | 身份块前导换行的 `replace(/^\n+/, '')`（只在它真当天头时用得上） |
| `src/core/chat/service.ts:334` | `resolveIdentityBlock`（没动，§53.4） |
| `src/core/prompt/resolver.ts:5` | `DEFAULT_PROMPT`：内置默认有 `before` 段，线上不会出现身份块 |
| `web/src/pages/PromptsPage.tsx:1057` / `:1071` | 后台身份块的口径文案与 placeholder |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'preset-import-1'`（§55 当时是 `context-tool-3`，§54 当时是 `reply-tool-3`；§53 当时是 `identity-off-1`，当时见 §56.7） |
| `test/gateway.node.test.ts:229` | 期望 `[gateway] node host started build=preset-import-1`（§55 当时是 `context-tool-3`，§54 当时是 `reply-tool-3`；§53 当时是 `identity-off-1`，当时见 §56.7） |
| `web/src/api.ts`（4 处） / `web/src/styles.css:1501` | 段头注释里的门牌 |

## 54. reply-tool-3：把工具调用壳和 game 包裹标签从正文里剥掉，并把 tools 定义发进请求（2026-11-06）

频道预设是从酒馆（SillyTavern）导进来的『示例角色』，它要求模型调用一个名为 `story_reply` 的工具、把要发出去的正文放在 `content` 里。模型经常不真调工具，而是把调用壳当正文写出来；正文还常被 `<game>` 这类包裹标签整段包住。以前这些标记原样发到 Discord，频道里就看到一串标签。这一版只改三处：**正文发出去之前先剥工具调用壳**（`reply-tool-1` 起）、**再剥成对的 game 包裹标签**（这一版新增）、**请求里同时带一份真的 tools 定义**（兼容性保留，见 §54.5）。没有新迁移（仍是 29 个）、没有新配置项、没有新接口字段。门牌 `reply-tool-3` 接在 `reply-tool-1` 之后，`reply-tool-1` 接在 `identity-off-1` 之后（§53）。

### 54.1 壳长什么样

真机上见过的四种开头（原样抄自 `content`）：

1. `<run_tool_name>story_reply</run_tool_name><run_tool_args>…`
2. `<|tool_call>call:story_reply{content:<<<|catgodml|str|…>>>}`
3. `<|FunctionCallBegin|>[{"name": …}]`
4. `<run_tool_replacement>`

结尾残渣见过：`</run_tool_args>`、`>>>`、`<|FunctionCallEnd|>`、`</story_reply>`、`<</story_reply>>`、`<<ptool_call>>`、`[END]`。

这些壳本身不是正文，但长度、行数与括号都像正文，模型会把它们和正文混在一段里写出来（壳在前、正文在后，偶尔中间夹一个 `<think_nya>` 思考块）。

### 54.2 剥壳规则

入口是 `src/core/chat/tool-shell.ts:97` 的 `unwrapToolReply(raw): { text: string; unwrapped: boolean }`：文本里没有 `story_reply` 就原样返回 `{ text: raw, unwrapped: false }`（:99），一个字符都不动。命中之后按三步走：

1. **切头**：按第一次出现的工具名切（`bodyStart`，:47-55），正文起点定在工具名之后**最靠后的一个已知外壳收尾**（`headCutEnd`，:58-69）。`HEAD_END_PATTERNS`（:12-17）认四种：`<run_tool_args>`、`<<<|catgodml|str|`、`"content"\s*:\s*["']`、`\{content\s*:\s*["']`——工具名与参数可以套两层，所以取最大的那个 end。
2. **认不出收尾时退化**：只吃掉紧跟其后的闭合标签、壳标点与五个已知开标签（`NAME_TAIL_PATTERN`，:23-24），**不吃未知开标签**——正文开头的 `<think_nya>` 因此保得住。
3. **剥尾**：循环 trim + 剥残渣（`stripTails`，:84-91 / `stripOneTail`，:72-81）。已知字面量在 `TAIL_MARKERS`（:27-35），就是 §54.1 那七个；兜底 `TAIL_PATTERNS`（:38-44）只吃「整块外壳」：未知闭合标签、未知单标签或 `<|xxx|>`、成片的 `>`、全大写方括号哨兵、JSON 收尾。

刻意不剥正文里可能合法的尾巴：**单个 `>`、单个 `]`、单个双引号、裸 `}` 都不动**——一句「我觉得 > 也行」不会被改。剥完为空就是空串，**不回退成原始壳**（宁可走空回复那条路，也不把标记发到频道，:95 注释、:100）。只按第一次出现的工具名切头；JSON 形态不反转义 `\n` / `\"`（用不上，不做）。

### 54.3 流式为什么先不推

流式版是 `unwrapToolReplyStream(raw): string`（:107-112），口径与非流式一致，只多一条时序约定：文本里没有工具名时就是 `raw.trim()`（与旧行为逐字相同）；**有工具名但头部外壳还没收尾时返回空串**（:111），先不推半截标记；等收尾那一块到了再剥尾并照常推。这样边收边编辑不会把 `<run_tool_name>` 闪到频道上，代价只是壳阶段那一小段的延迟（通常几十毫秒）。

### 54.4 game 包裹标签：只剥成对

`reply-tool-3` 在 `reply-tool-1` 之上只多一件事：把正文里**成对**的 `<game>` / `</game>`（以及 `<game_content>` / `</game_content>`）包裹标签剥掉，标签里面的正文**一个字不动**。实现在 `src/core/chat/wrapper-tags.ts`：`WRAPPER_TAGS = ['game', 'game_content']`（:4）、`stripWrapperTags(raw): string`（:7-17）。

- **成对才剥**：同一组标签的开、闭两串**都在原文里出现**才动手（:13）；一旦动手，就把这一组的开、闭标签**所有出现**都删掉（:14），中间正文原样留着。只出现一边时整段原样返回——判断不出正文到哪结束，宁可留一个开标签，也不冒把正文吃掉的险。`test/chat.wrapper-tags.test.ts` 里「只有开头 `<game>`」「只有结尾 `</game>`」两条就是钉这个的。
- **两组各算各的**：循环里逐组独立判断（:9-15），`<game>` 与 `<game_content>` 同时成对出现（`<game><game_content>…</game_content></game>`）时两层都剥。
- **正文细节全保留**：换行、缩进、`<think_nya>` 思考块一律不动（:6 注释；测试里 `<think_nya>` 那一条把思考块和正文一起比对）。
- **实测样本**：生产 `messages` 里 id 6907（731 字）的正文是 `<game>\n屋外的天色……\n</game>` 形态，剥完只剩正文，首尾换行都还在。
- **与工具壳的关系**：正文发出去之前先剥壳、再剥包裹标签（`src/core/chat/service.ts:1294` / `:1339` / `:1368`），两层各管一类标记，互不依赖；频道理看到的标记应当两类都没有。

### 54.5 tools 定义与「中继接受但空转」的实测

同时把真的 tools 定义发进请求，是因为预设本身就是按 OpenAI 工具协议写的，发过去**至少请求形状是对的**：

- 类型：`src/core/types.ts` 的 `ChatToolFunction`（:230-235）与 `ChatTool`（:237-240）；`LlmRequest` 加可选 `tools?: readonly ChatTool[]`（:259-260）与 `toolChoice?: 'auto' | 'none' | 'required'`（:261-262）。
- 线缆：`src/core/providers/openai-compat.ts` 的 `bodyOf` 在 `seed` 之后、`stream` 之前**仅当 `tools` 非空才发** `tools`（:73 注释、:74-79），`tool_choice` 只在给了且 tools 非空时才发（:78）；两个都不给时键序仍是旧五键、请求串与旧版逐字节相同。其余采样字段与键序一字未动。
- 什么时候带：`src/core/chat/reply-tool.ts:10-11` 的 `replyToolsFor(system)`——`system` 里出现 `story_reply`（区分大小写）才返回一条定义（`parameters` 是 `object`、必填 `content: string`，:18-24），否则空数组；`REPLY_TOOL_NAME = 'story_reply'` 在 :4。`src/core/chat/service.ts:1166-1170` 用它算出 `toolFields`（只有非空才是 `{ tools, toolChoice: 'auto' }`，空则连键都没有），首段请求（:1275）与续写请求（:1323）各展开一次，保证同一轮两段请求工具集一致。

**实测（2026-11-06，服务器上直接打中继）**：请求 `https://example.com/pg/v1/chat/completions`，模型 `gemini-4-argon`，`system` 用频道 2 的 24 段预设，带 `tools` 打三次，`tool_choice` 分别是 `auto` / 不带 / `required`——全部 HTTP 200、`finish=stop`、`tool_calls=0`，模型照旧把假壳写在 `content` 里；流式下 `tool_calls` 增量也是 0。

结论：**tools 字段对这条中继目前是空转的兼容性保留**——请求形状对，但模型不会真调工具；真正让正文变干净的是 §54.2 的剥壳与 §54.4 的包裹标签。所以运维上别把「请求里有 tools」当成「模型会调工具」，判据见 `docs/operations.md` §34.4。为什么还留着：换成会真调工具的上游（或中继将来支持）时这一层立刻有用，而发送条件已经收紧到「`system` 里出现工具名」，普通频道一个字节都不多发。

### 54.6 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/core/chat/tool-shell.ts:12-17` | `HEAD_END_PATTERNS`：四种开头外壳的收尾 |
| `src/core/chat/tool-shell.ts:23-24` | `NAME_TAIL_PATTERN`：退化时只吃闭合标签、壳标点与五个已知开标签，不吃未知开标签 |
| `src/core/chat/tool-shell.ts:27-35` | `TAIL_MARKERS`：七个已知结尾残渣 |
| `src/core/chat/tool-shell.ts:38-44` | `TAIL_PATTERNS`：兜底只吃整块外壳 |
| `src/core/chat/tool-shell.ts:47-55` | `bodyStart`：按第一次出现的工具名切头 |
| `src/core/chat/tool-shell.ts:58-69` | `headCutEnd`：取最靠后的已知收尾 |
| `src/core/chat/tool-shell.ts:72-91` | `stripOneTail` / `stripTails`：尾部循环剥 |
| `src/core/chat/tool-shell.ts:97` | `unwrapToolReply`：非流式入口 |
| `src/core/chat/tool-shell.ts:107` | `unwrapToolReplyStream`：流式入口 |
| `src/core/chat/wrapper-tags.ts:4` | `WRAPPER_TAGS = ['game', 'game_content']` |
| `src/core/chat/wrapper-tags.ts:7-17` | `stripWrapperTags`：同一组开闭标签都在才剥，只删标记本身 |
| `src/core/chat/reply-tool.ts:4` | `REPLY_TOOL_NAME = 'story_reply'` |
| `src/core/chat/reply-tool.ts:10-11` | `replyToolsFor(system)`：`system` 里出现工具名才给一条定义 |
| `src/core/types.ts:230-240` | `ChatToolFunction` / `ChatTool` |
| `src/core/types.ts:259-262` | `LlmRequest.tools` / `toolChoice` |
| `src/core/providers/openai-compat.ts:73-79` | `bodyOf` 里发 `tools` / `tool_choice`（只在 tools 非空时） |
| `src/core/chat/service.ts:88` / `:90` / `:91` | 三条 import：`replyToolsFor`、`unwrapToolReply` / `unwrapToolReplyStream`、`stripWrapperTags` |
| `src/core/chat/service.ts:1166-1170` | `tools` / `toolFields`：空时连键都没有 |
| `src/core/chat/service.ts:1275` / `:1323` | 首段与续写各展开一次 `...toolFields` |
| `src/core/chat/service.ts:1290-1296` / `:1333-1343` | 两处流式进度：先剥壳、再剥成对包裹标签，然后走原有清洗链 |
| `src/core/chat/service.ts:1366-1372` | 最终正文：`stripWrapperTags(unwrapToolReply(raw).text)` → `splitReactDirectives` → 清洗 |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'preset-import-1'`（§55 当时是 `context-tool-3`，§54 当时是 `reply-tool-3`，当时见 §56.7） |
| `test/gateway.node.test.ts:229` | 期望 `[gateway] node host started build=preset-import-1`（§55 当时是 `context-tool-3`，§54 当时是 `reply-tool-3`，当时见 §56.7） |
| `web/src/api.ts`（:323 / :1787 / :2263 / :2555） / `web/src/styles.css:1501` | 段头注释里的门牌 |

接入点的细节：两处流式进度都是先把 `unwrapToolReplyStream(raw)` / `unwrapToolReplyStream(raw + extra)` 交给 `stripWrapperTags`，再走原有链路 `stripVoiceDirective(...).text → visibleText → stripStamp → stripNoReactionHead → mentionSafe`（:1294 首段、:1339 续写段）；最终正文（:1366-1367 注释、:1368）是 `const unwrappedRaw = stripWrapperTags(unwrapToolReply(raw).text)`，随后 `splitReactDirectives(unwrappedRaw)`（:1369）→ `stripVoiceDirective`（:1371）→ `mentionSafe(stripNoReactionHead(stripStamp(...)))`（:1372），`len=` 仍取最终 `text.length`（:1405）。`<think_nya>` 思考块保留（按既定要求），其余清洗函数一行未动。

门槛：`reply-tool-3` 落地时实测 `npm run typecheck` / `typecheck:node` / `typecheck:web` 全部 exit 0、`npm test` 79 个文件 **1501** 例全过、`npm run test:node` 9 个文件 116 通过 + 1 跳过、`npm run build:web` 产出 `dist/web/assets/index-DRcbWA55.js` 385.69 kB（gzip 112.28 kB）；`reply-tool-1` 当时是 78 个文件 1493 例，这一版在它之上多 `test/chat.wrapper-tags.test.ts` 的 7 例（成对剥、单边不剥、两组同剥、`<think_nya>` 保留、无标签原样），`test/chat.tool-shell.test.ts` 9 例与 `test/chat.reply-tool.test.ts` 4 例沿用，`test/providers.openai.test.ts` 里「只给 tools 不给 tool_choice」「都不给时键序仍是旧五键」「`tools: []` 与旧请求整串字节相同」也照旧。没有新迁移：`migrations/` 末尾仍是 `0029_world_books.sql`、共 29 个，从 `identity-off-1` 就地升级是 `applied=0 skipped=29`。`reply-tool-2` 是验收用的中间版：它临时在 `[chat] 回复成功` 尾部加了 `rawLen=`（模型原始输出长度）与 `rawShell=`（原始输出里各标记出现的次数，`none` 表示这轮确实没写），用来证明「壳是模型写的、我们只是删掉」；`reply-tool-3` 把这两个字段撤掉，日志回到 `key=<label>` 收尾，其余行为与 `reply-tool-2` 逐字相同。实测证据（`reply-tool-2` 那一轮）：`runtime_logs` 里 `len=472 … rawLen=505 rawShell=<game>:1,</game>:1`，同一条消息落库正文里查不到 `<game>`。

运维判据在 `docs/operations.md` §34.4（正文里还看得见壳或 `<game>` = 实例还跑着旧镜像），宿主侧门牌与日志期望在 `docs/hosting.md` 开头那一节。

## 55. context-tool-3：把预设与历史塞进 context 工具，顶层只发一条固定句（2026-11-07）

门牌 `context-tool-3` 接在 `context-tool-2` / `context-tool-1` 之后，`context-tool-1` 之前是 `reply-tool-3`（§54）。这一版只改**开关打开的那个频道**：`channel_memory_settings.context_tool = 1` 时同一轮回复换一种请求形状；没打开的频道走原来的分支，请求体、日志、流式与续写**一个字节都不变**。判据只有一处：`src/core/chat/service.ts:1105` 的 `contextToolMode = memorySettings?.contextTool === true`（缺省与老行都是 false），下面每个分支都以它为条件。

### 55.1 三个版本各自解决什么

- `context-tool-1`（首版）：先证明形状本身能进角色——预设正文与最近历史塞进一个 `context` 工具的描述体，顶层只发**一条用户原话**。原话仍留在 `messages` 里，所以它还会踩 55.2 那个拒答。
- `context-tool-2`：把顶层那条消息从用户原话换成固定句 `CONTEXT_TOOL_TURN = '请继续 context 中的互动游戏。'`（`src/core/chat/context-tool.ts:28`），原话挪进描述体最后一段；同时加历史预算 `budgetedHistory`（`:48-63`）与 `CONTEXT_TOOL_HISTORY_CHARS = 8000`（`:42`），避免 `historyMaxMessages` 上千条时描述体涨成十万字。
- `context-tool-3`（§55 那一版；现版是 `context-tool-6`，见 §59）：在 2 之上补齐两件对齐酒馆实发请求的事——`reasoning_effort = 'low'`（`service.ts:1320`）与 `max_tokens` 兜底 `CONTEXT_TOOL_MAX_TOKENS = 65535`（`:1263-1265`）。这两项照抄酒馆那条请求（`context-tool.ts:30-36`），让采样预算不成为我们这边多出来的变量；路由或提示词层显式配了 `maxTokens` 就尊重配置，65535 只是兜底。
- 再往前：`reply-tool-3`（§54）→ `reply-tool-1` → `identity-off-1`（§53）→ `preset-head-1` / `identity-head-1`（§52）→ `preset-4`（§48.8）。

### 55.2 为什么把用户原话从 messages 里拿掉

实测定位：把用户原话当顶层 user 消息会触发安全拒答；同一份内容放进 `context` 工具的描述体、顶层只发一句「请继续 context 中的互动游戏。」就进角色。

证据（2026-11-07，生产探针）：

- 探针 A / B / D 三种形状都返回 HTTP 200，且都调用了 `story_reply`，正文 1740 / 2198 / 2334 字——形状本身稳定出正文。
- E 变体只把最后一条换成用户原话，被拒：回复 225 字，正文点名「示例角色设定及自定义工具调用」——拒的是「平台上的机器人在扮演」，不是设定本身。
- 酒馆（SillyTavern）本来就这么发：抓包它的 `messages` 里没有用户原话，原话只活在 `context` 工具的描述里。

所以这版的设计约束是：**顶层 `messages` 只有一条固定句，用户这一轮的原话永远在描述体最后一段**（55.5）。`CONTEXT_TOOL_SYSTEM` 与 `CONTEXT_TOOL_TURN` 都不提平台名与机器人身份（`context-tool.ts:13-27`），system 只有一句、只交代「设定在工具里、正文用 `story_reply` 交付」。

另有一条反向约束：**不要求模型先调用 `context`**。这一轮只发一条 user、没有把工具结果回喂的第二次请求，模型真照做就只回一个 `context` 调用、正文为空，直接变成一次 `EMPTY_RESPONSE`（`context-tool.ts:17-19`）。上下文本来就在 description 里，不调也读得到。**`context-tool-6` 起不再直接落 `EMPTY_RESPONSE`**：只调 `context` 交白卷时先补一次交付回合（§59.5）。

### 55.3 开关：一个列、一条迁移、一个复选框

- 迁移 `migrations/0030_context_tool_mode.sql`：`ALTER TABLE channel_memory_settings ADD COLUMN context_tool INTEGER NOT NULL DEFAULT 0;`。老库升级只补这一列，已有频道全部是 0（关）。
- 仓储 `src/workers/db/d1-repository.ts`：类型 `:170`（`context_tool: number`）、行映射 `:581`（`contextTool: row.context_tool !== 0`）、SELECT `:1064` / `:1075`、INSERT `:1090`、upsert `:1095`（`context_tool = excluded.context_tool`）、bind `:1105`（`cfg.contextTool === true ? 1 : 0`）、回写 `:1116`。
- 接口 `src/workers/http/app.ts`：`readContextTool` `:637`（`undefined` → `false`、非 boolean → `null` → `400 BAD_CONTEXT_TOOL` `:2068-2069`）；GET 无行时默认 `contextTool: false` `:2051`；落库 `:2092`。
- **PUT 不传 `contextTool` = 显式写 0**：读侧把 `undefined` 当 `false`，所以整份设置提交一次就会把开关关掉——后台每次都带上当前值（`web/src/pages/MemoryPage.tsx:228` 提交、`:233` 保存后回写、`:266` 恢复默认）。
- 后台复选框在「记忆」页：`MemoryPage.tsx:382` 的 `checked={contextTool}`，文案 `:385`「上下文工具模式（把预设与历史塞进 context 工具，只发一条用户消息）」；开关状态 `:117` / `:163`。

### 55.4 打开开关后这一轮的请求长什么样

`service.ts` 里这几处：

- `system`：换成 `CONTEXT_TOOL_SYSTEM`（`context-tool.ts:21-22`）：「所有设定、人物与最近的对话都在 context 工具里。给用户看的正文用 story_reply 交付。」——一句，平台中性。**`context-tool-6` 起这句前面多了「不要调用 context 工具——设定就在它的描述里，直接写正文」**（`src/core/chat/context-tool.ts:22` 起），见 §59.3。
- `messages`：只有一条 `{ role: 'user', content: CONTEXT_TOOL_TURN }`（`:1216-1218`）。原来拼进 user 消息的摘要块这时不再拼（`:1209-1210` 先判模式）。
- `tools`：两个（`:1223-1237`，定义在 `context-tool.ts:140-172`）——`context` 只有一个 `query` 参数，`story_reply` 有 `think_nya` / `game_content` / `extra`，`required: ['game_content']`；`tool_choice: 'auto'`。
- `maxTokens`：`route.maxTokens ?? promptHit.cfg.maxTokens ?? CONTEXT_TOOL_MAX_TOKENS`（`:1263-1265`）；老模式仍是 `route.maxTokens ?? promptHit.cfg.maxTokens`，没有 65535 这层兜底。
- `reasoningEffort: CONTEXT_TOOL_REASONING_EFFORT`（`:1318-1320`）。类型在 `src/core/types.ts:257`（`LlmRequest.reasoningEffort?: string`），provider 在 `src/core/providers/openai-compat.ts:71-73` **只在非空时**发 `reasoning_effort`；键序是 `top_p`（`:69`）→ `reasoning_effort`（`:71-73`）→ `frequency_penalty` / `presence_penalty`（`:74-75`）→ `seed`（`:76`）。老模式根本不带这个键。
- 调用方式（**历史**：`context-tool-1` … `context-tool-5` 都是非流式 `chat()`）：正文从 `tool_calls` 里取（`:1327-1335`，当时的注释写明流式拿不到 `tool_calls`）。`context-stream-1` 起改成流式 `chatStream()`，但仍然整段攒完才交付，见 §57。

### 55.5 描述体：五段，本轮原话永远最后

`composeContextBody`（`context-tool.ts:178-183`）把非空段用空行拼起来，顺序是（`:1223-1237`）：

1. `promptParts.before`——预设里位置在前的段；
2. `promptParts.after`——位置在后的段；
3. 长期记忆摘要块；
4. `budgetedHistory(kept)`——最近历史的署名行；
5. 本轮用户行——时刻 + 名字 + 原话，**永远最后一段**。

`budgetedHistory`（`context-tool.ts:48-63`）的规则：入参旧→新，从末尾往前累加；行间那个换行也按 1 个字符计入预算（`:57-59`）；超预算立即停（更早的内容交给长期记忆摘要兜底）；返回仍是旧→新（时间线不能倒）；空行跳过、不占预算也不进结果；单行就超预算时返回空串。

这一模式的描述体里**没有** `promptParts.userMessages`（历史上按轮拼进去的那些 user 消息），也没有深度注入——它们只在老分支里出现。

### 55.6 正文从 story_reply 的参数里取

`readToolReply(calls, fallbackText)`（`context-tool.ts:118-134`）：

- 找名为 `story_reply` 的调用；`game_content` 与 `extra` 用空行拼成正文，`think_nya` **不进正文**。
- 参数是 JSON 字符串，先按整段 `JSON.parse`；解析失败或两个键都空时才走兜底：`PARTIAL_PAIR` 正则（`:67`）从半截 JSON 里抠 `game_content` / `extra`，同名键取第一次出现（`:100-111`）。
- 找不到这个调用、或正文为空 → 回退 `fallbackText`（模型写在正文里的文本），再经 `stripWrapperTags`（`:1428`）。这一模式的正文来自工具参数、不再有调用壳，但仍过一遍 `stripWrapperTags`，防止模型把包裹标签写进参数。

模型只调 `context`、不调 `story_reply` 时正文取不到，这一轮算空回复：`service.ts:1551-1561` 打 `空回复重试 n/… model=… key=…`，重试用尽仍是空的就落 `EMPTY_RESPONSE`——这是这条模式最常见的失败形状（判据见 `docs/operations.md` §35）。**`context-tool-6` 起先补一次交付回合**（`src/core/chat/service.ts:1367-1387`），仍空才走这里的重试（§59.5）。

### 55.7 这一版明确丢掉了什么

只在开关打开的频道：

- 顶层 `messages` 不再有 `promptParts.userMessages`，也不再做深度注入。
- **没有流式进度**（**历史**：`context-tool-1` … `context-tool-5` 是非流式 `chat()`）：这一版要等整轮结束才出字（线上两条 28s / 105s，见 55.9）。`context-stream-1` 起上游是流式的，但分支内仍一次进度都不推，见 §57.5。
- **没有续写**：`service.ts:1365-1370` 的续写循环以 `!contextToolMode` 开头，这一模式整段跳过；长度靠 `max_tokens` 的 65535 兜底，不再靠续写补。
- 空回复重试照旧。**`context-tool-6` 起在这之前先补一次交付回合**（§59.5）。

### 55.8 代码地图

| 位置 | 这一版的样子 |
| --- | --- |
| `migrations/0030_context_tool_mode.sql` | 给 `channel_memory_settings` 加 `context_tool INTEGER NOT NULL DEFAULT 0` |
| `src/workers/db/d1-repository.ts:170` / `:581` | 类型与行映射（`row.context_tool !== 0`） |
| `src/workers/db/d1-repository.ts:1064` / `:1075` / `:1090` / `:1095` / `:1105` / `:1116` | SELECT / INSERT / upsert / bind / 回写 |
| `src/workers/http/app.ts:637` | `readContextTool`：`undefined` → false、非 boolean → null |
| `src/workers/http/app.ts:2051` / `:2068-2069` / `:2092` | GET 默认值 / 非法 400 `BAD_CONTEXT_TOOL` / 落库 |
| `web/src/pages/MemoryPage.tsx:382` / `:385` | 复选框与文案 |
| `src/core/chat/context-tool.ts:8` / `:11` | `CONTEXT_TOOL_NAME = 'context'` / `REPLY_TOOL_NAME = 'story_reply'` |
| `src/core/chat/context-tool.ts:21-22` / `:28` | 唯一 system / 顶层固定句 |
| `src/core/chat/context-tool.ts:35-36` / `:42` | `reasoning_effort` 与 `max_tokens` 兜底 / 历史预算 8000 |
| `src/core/chat/context-tool.ts:48-63` | `budgetedHistory` |
| `src/core/chat/context-tool.ts:118-134` / `:140-172` / `:178-183` | `readToolReply` / 两个工具定义 / `composeContextBody` |
| `src/core/chat/service.ts:1105` | `contextToolMode`（唯一判据） |
| `src/core/chat/service.ts:1180` / `:1216-1218` / `:1223-1237` | system / messages / tools 与描述体 |
| `src/core/chat/service.ts:1263-1265` / `:1318-1320` | maxTokens 三层兜底 / reasoningEffort |
| `src/core/chat/service.ts:1327-1335` / `:1428` / `:1473` | chat + 读工具回复 / stripWrapperTags / 日志尾 `mode=context`（非流式是**历史**：`context-stream-1` 起改流式 `chatStream()` + `accumulateToolCalls` 拼回，见 §57.5） |
| `src/core/types.ts:257` / `src/core/providers/openai-compat.ts:71-73` | `reasoningEffort` 字段 / `reasoning_effort` 透传 |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'context-stream-1'`（§55 当时是 `context-tool-3`，当时见 §57.9） |
| `test/gateway.node.test.ts:229` | 期望 `[gateway] node host started build=context-stream-1`（§55 当时是 `context-tool-3`，当时见 §57.9） |
| `test/chat.context-tool.test.ts` | `readToolReply` / `budgetedHistory` / 固定句不含 discord 与机器人 |
| `test/chat.service.test.ts:3113` / `:3133` / `:3136-3168` | 只有一条固定句 / 日志含 `mode=context` / 缺省与显式关闭时请求逐字相同、日志无 `mode=context` |

### 55.9 线上验收（2026-11-07，生产 203.0.113.10，build=context-tool-3）

频道 `<ID-9>` 在后台勾上开关（`updated_at 15:51:14`）之后：

- 15:52:17 `回复成功 … ms=28091 len=773 … mode=context`——进角色正文；
- 15:54:49 `回复成功 … ms=104809 len=844 … mode=context`——进角色正文。

同一频道 15:49:31 还没勾时那条 `len=180` 是拒答（该条日志**没有** `mode=context`）。也就是说「进角色 / 被拒」与尾标一一对得上，没勾开关的频道不受影响。

### 55.10 门槛、迁移与回滚

门槛（本地复核方式）：`npm run typecheck`（含 `typecheck:node` / `typecheck:web`）与 `npm test`；这一版的用例集中在 `test/chat.context-tool.test.ts` 与 `test/chat.service.test.ts:3113` / `:3133` / `:3136-3168`（缺省与显式关闭的请求体逐字相同、日志里没有 `mode=context`）。

迁移：`migrations/` 现在 30 个文件，末尾 `0030_context_tool_mode.sql`。29 个迁移的库启动是 `applied=1 skipped=29`；30 个迁移的库是 `applied=0 skipped=30`；新库首次启动是 `applied=30 skipped=0`。

回滚：不动数据——后台取消勾选即回 `reply-tool-3` 那一套请求形状，列留在库里（值 0）。镜像回退到 `reply-tool-3` 或更早时，旧代码不读这一列，行为与加列之前一致。

判据：成功日志尾部有 `mode=context` 才说明这一轮走的是这条模式；没有尾标的频道仍在老路径，一个字节没变。面向线上的那一份在 `docs/operations.md` §35。历史小节里的 `build=reply-tool-3` 是各自那一版的判据（§54 当时就是它），按当前线上门牌 `build=context-tool-6` 对号即可（§59.7）。

## 56. preset-import-1：酒馆预设可以导入频道层与服务器层（2026-11-07）

门牌 `GATEWAY_BUILD = 'preset-import-1'`（`src/workers/gateway/engine.ts:129`），上一版是 `context-tool-5`（§55），再往前的 `context-tool-4` 已回退。这一版只改酒馆预设导入这一条链路：导入从「目标层写死 global」变成「可以在 global / guild / channel 里选一层」，其余行为逐字不变。没有新迁移、没有新配置项、没有新表。

### 56.1 为什么以前只能 global（三处硬编码）

§48 那一版把目标层写死在代码里：`const key: ScopedKey = { scope: 'global', scopeId: '' };`。这一行决定了一切下游行为——段写进 global、注入写进 global、存档 id 固定、响应里的 `scope` 是字面量 `'global'` 且根本没有 `scopeId` 字段；存档 id 则固定成 `LATEST_PRESET_ID = 'latest'`（`src/workers/http/app.ts:539`）。所以「导到哪一层」从来不是能力问题，是三个字面量的硬编码：目标 key、存档 id、响应字段。preset-import-1 把这三处全部换成请求里的 `scope` / `scopeId`，并把层级校验提到写库之前（§56.3）。

### 56.2 四条语义

1. **整层覆盖目标层，其它层不动**。目标层原来的段全部被预设的段替换，其它层的段一条不碰；被替换掉的旧段数由响应 `replaced` 报出（`app.ts:1008` 只跟同层旧值比，`:1020-1022` 输出 `existing === null ? 0 : existing.segments.length`）。
2. **覆盖前按目标层读旧 PromptConfig，只换段**。`const existing = await deps.prompts.get(key)`（`app.ts:966-967`），`temperature` / `maxTokens` 从 `existing` 继承（`:979-980`）——不再固定读 global。测试锁定：频道层自己的 `temperature 0.4` 保留、`maxTokens` 仍为空，global 的 `0.85` / `777` 不上浮（`test/prompt.import.test.ts:448-450`）。
3. **预设里的历史后指令（jailbreak 等）写到同一层的深度注入**。`app.ts:999-1002` 用 `key.scope` / `key.scopeId` 读写 `prompt_injections`（`depth: 0`、`role: 'system'`），与段落在同一层；只有 `postHistory.trim() !== ''` 才碰注入（`:998`），预设里没有后指令时不会清掉该层已有的注入。`replaced` 同样只跟同层旧值比。
4. **原始预设 JSON 按层各存一行**。id 编码：global 仍是 `latest`，其它层 `latest:<scope>:<scopeId>`（`app.ts:985-988`）。`prompt_presets` 的主键本来就是 TEXT id（`migrations/0026_prompt_presets.sql`），所以加层只是加行、不需要迁移。

### 56.3 层级校验为什么放在写库之前

一次导入要写三处：段（`prompts.put(key, cfg)`，`app.ts:982`）、存档（`savePreset`，`:987`）、深度注入（`:999-1002`）。三次 `await` 不在一个事务里，先写再校验就会在非法 `scope` 时留下半套数据。所以入口先校验：`app.ts:948-950` 调 `readImportScopeKey(body)`，拿到 `'BAD_SCOPE'` 直接 `400 { error: 'BAD_SCOPE' }`，此时任何写库动作都还没发生。`test/prompt.import.test.ts:497` 用 7 种非法输入逐个断言 400 **且零写入**（三层段、三层注入、`prompt_presets` 一行都不落）：`scope: 'world'`、`'GLOBAL'`（大小写不符）、`5`（非字符串）、`channel` 缺 `scopeId`、`channel` + `scopeId: ''`、`guild` 缺 `scopeId`、`channel` + `scopeId: 5`。

`readImportScopeKey`（`app.ts:442-449`）的口径：`scope` 完全缺省（`undefined` / `null`）= 旧行为 = `{ scope: 'global', scopeId: '' }`（:448 之前的分支）；一旦传了 `scope` 就走通用 `readScopeKey`（`:432`）——未知层返回 `'BAD_SCOPE'`，非 global 但 `scopeId` 不是非空字符串（缺、空串、非字符串都算）返回 `null`，再由 `return readScopeKey(body) ?? 'BAD_SCOPE'`（`:448`）把 `null` 折成 `BAD_SCOPE`。**导入是唯一把 `null` 折成 `BAD_SCOPE` 的路由**：其它 22 处调用（`:790`、`:819`、`:838`、`:861`、`:902`、`:934`、`:1062`、`:1085`、`:1116`、`:1176`、`:1314`、`:1336`、`:1354`、`:1383`、`:1401`、`:1420`、`:1438`、`:1457`、`:1482`、`:1519`、`:1804`、`:1822`）拿 `null` 回 `BAD_REQUEST`。这样前端只需认一个错误码，不用区分「层非法」与「ID 缺失」。

### 56.4 接口契约

`POST /api/prompts/import`（`app.ts:945-1024`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `preset` | object | 原始 SillyTavern 预设 JSON，不变 |
| `charName` | string? | 不变 |
| `scope` | `'global' \| 'guild' \| 'channel'`? | **新增可选**；不传 = 旧行为 = `'global'` |
| `scopeId` | string? | **新增可选**；非 global 层必须是非空字符串，global 会被钉成 `''` |

200 响应：`{ ok: true, scope, scopeId, replaced, written, skipped, warnings }`。`scopeId` 是新增字段，`scope` 不再是写死的 `'global'`；`replaced` = 目标层导入前的旧段数。400 多出来的只有 `{ error: 'BAD_SCOPE' }`，原有的 `BAD_PRESET`（JSON 读不出/不是对象）与 `UNKNOWN_TEMPLATE_VAR`（只查启用段）语义不变。前端类型：`PromptImportResult.scope: Scope` + `scopeId: string`（`web/src/api.ts:117-118`），入参 `PromptImportInput.scope?` / `scopeId?`（`:122-131`）；`toPromptImportResult` 对老服务端兜底 `toScope(source.scope) ?? 'global'`（`:500-501`）与 `normalizeScopeId(scope, ...)`（`:513-514`）。

### 56.5 存档 id 编码与阶段四怎么读

id 编码只有三种：global → `latest`；guild → `latest:guild:<guildId>`；channel → `latest:channel:<channelId>`。每层只留**最近一次**（同层再导覆盖那一行，其它层那几行不动）。

后续阶段（世界书 / 正则）要按目标层取那一行，**不能再用 `latestPreset()`**：`src/workers/db/d1-repository.ts:780-784` 的实现是 `ORDER BY imported_at DESC, id ASC` 取全表最新一行，分层之后会取到别的层（哪层最后导入就取到哪层）。仓储需要补一个按 id 读的方法（如 `getPreset(id)`），阶段四调用时传同一个编码字符串。表结构不动：`prompt_presets` 主键是 TEXT id（`migrations/0026_prompt_presets.sql`），多一层就是多一个 id、多一行。

### 56.6 后台 UI

提示词页的「从酒馆预设导入」面板有**自己的**层选择（`web/src/pages/PromptsPage.tsx:1309-1314`，复用 `ScopeField`），状态是独立的 `importScope` / `importScopeId`（`:267-269`），与页面顶部编辑区的层互不影响——改上面的编辑区不会改变下面导入的目标层。非 global 没填 ID 时本地拦截、一个请求都不发（`:361-366`）。二次确认与结果区文案都跟目标层走：写入层、搬去深度注入、覆盖原有深度注入由 `describeImportTarget`（`:116-119`）生成，确认正文在 `:367-373`。

### 56.7 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/workers/http/app.ts:442-449` | `readImportScopeKey`：`scope` 缺省 = global，`null` 折成 `'BAD_SCOPE'` |
| `src/workers/http/app.ts:948-950` | 入口校验 → `400 { error: 'BAD_SCOPE' }`，在任何写库之前 |
| `src/workers/http/app.ts:966-967` / `:979-980` / `:982` | 按目标层读旧 `PromptConfig` / `temperature` 与 `maxTokens` 从该层继承 / `prompts.put(key, cfg)` |
| `src/workers/http/app.ts:985-988` | 存档 id：`latest` 或 `latest:<scope>:<scopeId>` |
| `src/workers/http/app.ts:999-1002` | 深度注入写 `key.scope` / `key.scopeId`（`depth: 0`、`role: 'system'`） |
| `src/workers/http/app.ts:1020-1022` | 响应 `scope` / `scopeId` / `replaced` |
| `test/prompt.import.test.ts:419` / `:466` | channel 整层覆盖；guild 与 global 互不覆盖（global 存档仍是 `latest`） |
| `test/prompt.import.test.ts:448-450` | 频道层 `temperature 0.4` 保留、global 的 `777` 不上浮 |
| `test/prompt.import.test.ts:497` | 7 种非法输入全 400 且零写入 |
| `test/prompt.import.test.ts:184` / `:190` | 响应含 `scopeId`；老请求仍是 `global` + `''` |
| `web/src/api.ts:117-118` / `:122-131` | 结果类型 `scope` + `scopeId` / 入参可选 `scope`、`scopeId` |
| `web/src/api.ts:500-501` / `:513-514` | 兜底 `?? 'global'` / `normalizeScopeId` |
| `web/src/pages/PromptsPage.tsx:116-119` / `:267-269` / `:361-366` / `:367-373` / `:1309-1314` | 文案 / 独立层状态 / 缺 ID 本地拦截 / 二次确认 / `ScopeField` |

门牌落点 7 处：`src/workers/gateway/engine.ts:129`、`test/gateway.node.test.ts:229`、`web/src/api.ts:330`（注释）/ `:1807` / `:2283` / `:2575`（注释）、`web/src/styles.css:1501`。

### 56.8 门槛、迁移与回滚

门槛（本机实跑，2026-11-07）：`TSC_W` / `TSC_N` / `TYPEWEB` / `BUILDWEB` 全 0；`npm test` 81 个文件 **1539 例**全过；`npm run test:node` 9 个文件 **116 通过 + 1 跳过**；`build:web` 产物 `dist/web/assets/index-c0sB_u8_.js` 386.74 kB（gzip 112.70）、`index-B0KPgCn-.css` 21.48 kB（gzip 3.87）。

迁移：仍是 30 个文件，末尾 `0030_context_tool_mode.sql`（由 `context-tool-1` 引入）。**本版没有新迁移**：升级只往 `prompt_presets` 加表行（一层一行），不改表结构。新库启动 `applied=30 skipped=0`；已经在跑 30 个迁移的库是 `applied=0 skipped=30`（不会出现 `context-tool-3` 那种 `applied=1 skipped=29`）。

回滚：旧代码不认 `scope` / `scopeId`，导入回到旧口径，目标层固定是 global；已经落进 guild / channel 的段、注入与存档行留在库里（存档只写不读，不会干扰旧代码）。要清掉某一层，用 `DELETE /api/prompts`（`app.ts:816`）带该层的 `scope` / `scopeId`。

### 56.9 线上判据

面向线上的排查清单在 `docs/operations.md` §36：门牌、`prompt_presets` 的多行、`prompt_segments` 的 `scope` + `scope_id`、`prompt_injections` 同层、`400 BAD_SCOPE` 的两种成因。一句话：**导入之后只看「目标层变了、其它层没变」**——其它层行数或 `imported_at` 有任何变动就是 bug。

## 57. context-stream-1：上下文工具模式的上游改成流式（2026-11-07）

门牌 `GATEWAY_BUILD = 'context-stream-1'`（`src/workers/gateway/engine.ts:129`）——**这一节是更早的一版**，现版门牌是 `context-tool-6`（§59），上一版是 `preset-import-2`（§58），再上一版是 `preset-import-1`（§56）。这一版只动一条链路：§55 那个上下文工具模式（`mode=context`）的上游请求从非流式 `chat()` 换成流式 `chatStream()`（`stream: true`）。**仍然整段攒完才交付**——流式只发生在 bot 到上游这一段，Discord 侧、日志形状与用户观感跟上一版逐字相同。

### 57.1 为什么以前只能非流式，这一版为什么要改

- 旧 `chatStream()` 只吐 delta 正文（`choices[0].delta.content`），**拿不到 `tool_calls`**，所以 §55 那几版只能走 `chat()`（**历史**）；代价是 bot 与上游之间也是整段一问一答，与酒馆（SillyTavern）抓包看到的流式请求不是一回事。
- 这一版让 `chatStream()` 也把 `delta.tool_calls` 交出来：context 模式于是既保持流式请求形状，又能拿到工具调用。「流式」在这里的真实收益是**请求形状与上游一致**，不是更早出字。

### 57.2 新类型：`ToolCallDelta`

`src/core/types.ts:276-282` 新增：

```ts
export interface ToolCallDelta {
  index: number;
  name?: string;
  arguments: string;
}
```

`LlmChunk`（`src/core/types.ts:295`）多一个可选键 `toolCallDelta?: ToolCallDelta;`——**只有流里真的出现工具调用分片时才带这个键**，没出现时老消费者看到的 `LlmChunk` 形状逐字不变。`ChatToolCall`（`name` + `arguments`，可带 `id`）与 `LlmResult.toolCalls` 都没动：分片是传输层的东西，拼完仍是原来那个形状。

### 57.3 适配器：把 `delta.tool_calls` 逐帧交出来

`src/core/providers/openai-compat.ts:117` 新增 `toolCallDeltasOf(node: unknown): ToolCallDelta[]`：

- 读 `choices[0].delta.tool_calls` 逐项解析；**没有 `index` 的项直接跳过**（分桶全靠它）。
- `function.name` **只在非空时**带上——后续片通常没有 name。
- `name` 与 `arguments` 都为空的项丢弃。

流循环（`:202-213`）：这一帧有工具调用分片就**逐项 yield 一个 `LlmChunk`**；同一帧若还带 `content`，挂在**第一项**上——一次 yield 两个字段，不拆成两条 chunk；`finishReason` 挂在**最后一项**上。没有工具调用的帧仍照旧原样 yield（`:216-217`）。`bodyOf` 一个字没动：`stream: true` 本来就在。

### 57.4 累加器：按 index 分桶拼回

`src/core/chat/context-tool.ts:141` 新增 `accumulateToolCalls(chunks: Iterable<ToolCallDelta>): ChatToolCall[]`：

- 按 `index` 分桶（`Map<number, …>`）；
- `name` **只认第一个非空值**，后面的重复值忽略；
- `arguments` 按到达顺序**字符串拼接**——中继不拆片时一帧就是完整 JSON，拆片时也照样拼得回来；
- 输出按 `index` **升序**，`name` 与 `arguments` 都空的桶丢弃（不产出只剩壳的假调用）。

拼出来的就是原来 `ChatToolCall[]` 那个形状，`readToolReply` 一个字节没改。

### 57.5 服务层：请求形状换了，交付方式没换

`src/core/chat/service.ts:1333-1344`：context 分支改成 `for await (const chunk of chatStream(...))`，把 `chunk.toolCallDelta` 收进 `toolDeltas`、正文照旧 `raw += chunk.delta`；循环结束 `raw = readToolReply(accumulateToolCalls(toolDeltas), raw)`（`:1344`）。

- **分支内一次 `emitProgress` 都不调**：推进度的是 `:1345` 那个 `else` 分支（`:1355-1361`），context 分支根本走不到。用户看不到中间态，日志也不会因为流式多出中间行——`mode=context` 那条仍然只在**成功之后**出现一次。
- **为什么仍不推进度**：这一模式的正文本来就不在 delta 里，而在 `story_reply` 的 `game_content` 里。delta 可能只有半截参数 JSON，拿它做进度等于把 `{"think_nya":…,"game_content":"半句话` 推到频道上；要推就得先拼回再解析，而拼回要等流结束——那时正文已经有了，推中间态没有意义。

### 57.6 空回与续写：判据为什么一个字不用改

- 空回（`:1366-1369`）：`if (raw.trim() === '')` 原样保留。顺序是**先拼回、再判空**，所以「只有 `tool_calls`、正文 delta 为空」的流不会被误判成 `EMPTY_RESPONSE`。
- 续写（`:1373-1380`）：`while (!contextToolMode && …)` 仍然 false 短路；注释改成真实原因——这一模式靠工具调用**一次性交付**，正文不是按文本长度截断的，续写没有意义。
- 请求形状的差异只有 `stream: true` 这一项：`tools` 定义、`tool_choice: 'auto'`、`reasoning_effort`、`max_tokens` 三层兜底与键序一个字节没动。

### 57.7 生产探针：中继确实会流式回工具调用

实测（`gg` key + `pg-gemini-3.1-pro-preview`，请求带 `tools` 与 `stream: true`）：`200`、`content-type: text/event-stream`、5.1 秒回来、一共 **3 帧**，其中 **1 帧带 `tool_calls`**，`function.arguments` 是**完整 JSON**。也就是说这个中继**不拆片**，一个 `delta.tool_calls` 就把整个调用给全；实现两种都认（`toolCallDeltasOf` 逐项 + `accumulateToolCalls` 分桶拼接），换一个会拆片的中继不用改代码。

### 57.8 代码地图

| 位置 | 这一版的样子 |
| --- | --- |
| `src/core/types.ts:276-282` | `ToolCallDelta`（`index` / `name?` / `arguments`） |
| `src/core/types.ts:295` | `LlmChunk.toolCallDelta?: ToolCallDelta`，只有真出现分片时才带这个键 |
| `src/core/providers/openai-compat.ts:117` | `toolCallDeltasOf`：跳过无 `index` 项、`name` 空则不写键、双空丢弃 |
| `src/core/providers/openai-compat.ts:202-213` | 逐项 yield；同帧 `content` 挂第一项、`finishReason` 挂最后一项 |
| `src/core/chat/context-tool.ts:141` | `accumulateToolCalls`：分桶、name 只认首个非空、arguments 顺序拼接、index 升序、空桶丢弃 |
| `src/core/chat/service.ts:1333-1344` | `for await` `chatStream` 收集 `toolDeltas` + `raw`，`readToolReply(accumulateToolCalls(...), raw)` |
| `src/core/chat/service.ts:1366-1369` | 空回判定不变：先拼回再 `raw.trim() === ''` |
| `src/core/chat/service.ts:1373-1380` | 续写仍 `!contextToolMode`，注释改成真实原因 |
| `test/providers.openai.test.ts` | 分片解析；同帧 `content` + `tool_calls` 各一条 |
| `test/chat.context-tool.test.ts` | 分桶拼接 / name 只认首个非空 / index 升序 / 空桶丢弃（4 条） |
| `test/chat.service.test.ts` | context 模式走 `chatStream`、`chat()` 调用 0 次、正文仍取自 `story_reply` 的 `game_content` |

门牌落点 7 处：`src/workers/gateway/engine.ts:129`、`test/gateway.node.test.ts:229`、`web/src/api.ts`（4 处）、`web/src/styles.css:1501`。

### 57.9 门槛、迁移与回滚

门槛（本机实跑，2026-11-07）：`TSC_W` / `TSC_N` / `TYPEWEB` / `BUILDWEB` 全 0；`npm test` 81 个文件 **1546 例**（比上一版 +7）；`npm run test:node` 9 个文件 **116 通过 + 1 跳过**；`build:web` 产物 `dist/web/assets/index-c0sB_u8_.js` 386.74 kB（gzip 112.70）；`@ts-expect-error` 仍是 3 个基线。

迁移：**没有新迁移**，仍是 30 个文件、末尾 `0030_context_tool_mode.sql`。新库首次启动 `applied=30 skipped=0`；已经在跑 30 个迁移的库是 `applied=0 skipped=30`（不会出现 `context-tool-3` 那种 `applied=1 skipped=29`）。

回滚：镜像回退到 `preset-import-1` 即回非流式 `chat()`；这一版不写库，没有任何数据要回滚。

判据：启动日志与心跳里的 `build=context-stream-1`；成功日志尾部的 `mode=context` 仍只在**成功之后**出现一次；报 `EMPTY_RESPONSE` 且重试满 3 次，说明这一轮流里既没有正文也没有可用的工具调用。面向线上的那一份在 `docs/operations.md` §35。（`context-tool-6` 起，只调 `context` 交白卷会先补一次交付回合再谈重试，见 §59.7 与 `docs/operations.md` §37。）

## 58. preset-import-2：导入预设时把停用段也带进来（2026-11-07）

门牌 `GATEWAY_BUILD = 'preset-import-2'`（`src/workers/gateway/engine.ts:129`），前一版是 `context-stream-1`（§57），再上一版是 `preset-import-1`（§56）。这一版只改酒馆预设导入的一处判定：预设里自己关着的段（条目写了 `enabled:false`，或 `prompt_order` 里那一项 `enabled:false`）以前在导入时被丢掉、只记进 `ignored`（`reason='disabled'`）；现在照样导入，但保留它自己的 `enabled=false`，发不发由后台逐段决定。没有新迁移、迁移总数仍是 30，不写库结构。

### 58.1 以前为什么丢掉

§48 阶段一把「段自己的开关」当成导入过滤器：`isEntryEnabled`（`src/core/prompt/sillytavern.ts:107`）只回答条目自己开没开，`prompt_order` 分支再把 `item.enabled && isEntryEnabled(...)` 合起来（`:229`），导入循环遇到 `enabled=false` 就跳过、把这一段记进 `ignored`。当时的理由是「关着的段本来就不该进提示词」，代价是后台**看不到**这些段——想启用其中一段，既没有行可勾，也没有正文可编辑，只能回酒馆改预设再整份导一次。真实预设（§48.7 的 Meowssiah_1.9.12）里 17 段 `enabled:false`，就是这么整批消失的。

### 58.2 新规则

- `IgnoredEntry.reason` 收窄成 `'marker' | 'empty' | 'badRole'`（`src/core/prompt/sillytavern.ts:20`）：`'disabled'` 这一类删除。
- marker 仍跳过（`:244`，`reason='marker'`）；空正文仍跳过（`:249`，`content.trim() === ''` → `reason='empty'`）；角色非法仍走 `badRole`（更早的 role 归一化处，判定没动）。
- 停用段不再跳过：`:270-271` 是注释，`:272` `if (!enabled) {`，`:273` `segments.push({ name: displayName, role, content: mapped, enabled: false, placement: 'before' })`，`:274` `continue`，`:275` 收尾——**正文照收、`enabled` 钉成 `false`、`placement` 仍是 `before`**。
- 启用段照旧走 `:284` 的 push，`enabled` 原样。
- 段顺序仍按 `prompt_order`：`:219-234` 的挑选口径一个字没动，停用段在它原本该在的位置上，只是不带启用状态。

### 58.3 停用段与深度注入的取舍

历史后指令只有在**启用**时才搬去深度注入：`:278` 的 `isPostHistoryEntry`（`:114`）分支把段拼进 `postHistory`、从段表里拿掉，停用段不满足条件，留在段表。为什么不一并搬？因为深度注入没有「停用」这一态——一旦写进 `prompt_injections` 就每轮都拼。停用段若因为 `identifier === 'jailbreak'` 就被搬走，「停用」会变成「换个地方生效」，正好是这一版要消灭的意外。导入写注入的路径没动（`src/workers/http/app.ts:973-990`，`{ depth: 0, role: 'system' }`，写前 `get` 判 `replaced`），`postHistory` 为空时仍然一个字都不碰。

### 58.4 宏映射与警告

停用段和启用段走同一条 `mapMacros`（`src/core/prompt/sillytavern.ts:156`）：`{{char}}` / `{{user}}` 照样替换，`CLEARED_MACROS`（:63）里的宏照样清空，未知变量原样留在正文里、并冒一条 `unknown variable {{x}}`（:210 的 `noteUnknown`）。所以「先导入、以后再打开」不会等到打开那一刻才发现宏写错；导入响应的 `warnings` 现在是整份预设的口径，比上一版多了停用段里的那些（导入结果本身没有 `unknownVars` 字段，那个字段属于 `POST /api/prompt-defaults/preview`）。

### 58.5 后台怎么点出来

`web/src/pages/PromptsPage.tsx:397` 用 `result.segments.filter((item) => !item.enabled)` 数出停用段数，`:403-408` 在结果区多一行「其中 N 段是预设里关着的，已按停用导入；要让它们生效，就在下面的列表里逐段打开。」；`:1288` 的导入面板说明补了一句「预设里关着的段也会导进来，但保持停用。」。段列表里这些行就是一行普通段，只是 `enabled=false`、默认不勾选，勾上保存即生效。

### 58.6 代码地图

| 位置 | 这一版的口径 |
| `src/core/prompt/sillytavern.ts:20` | `IgnoredEntry.reason` 只剩 `'marker' \| 'empty' \| 'badRole'` |
| `:244` | marker 判定，仍跳过（`reason='marker'`） |
| `:249` | 空正文判定，仍跳过（`reason='empty'`） |
| `:270-275` | 停用段分支：push `enabled: false` 后 `continue` |
| `:278` | `isPostHistoryEntry` 只在启用时搬深度注入 |
| `:284` | 正常段 push（`enabled` 原样） |
| `web/src/api.ts:84` | `PromptImportIgnoreReason` 三值 |
| `web/src/pages/PromptsPage.tsx:397` / `:403-408` / `:1288` | 停用段计数 / 结果区提示 / 面板说明 |
| 门牌 7 处 | `src/workers/gateway/engine.ts:129`、`test/gateway.node.test.ts:229`、`web/src/api.ts:330` / `:1807` / `:2283` / `:2575`、`web/src/styles.css:1501` |

### 58.7 门槛与回滚

门槛实测（2026-11-07）：`npm run typecheck` / `npm run typecheck:node` / `npm run typecheck:web` 全 0；`npm test` 81 文件 1546 例全过；`npm run test:node` 9 文件 116 通过 + 1 跳过；`npm run build:web` 产物 `dist/web/assets/index-Crkd0bo8.js` 386.95 kB（gzip 112.79）、`index-B0KPgCn-.css` 21.48 kB。

迁移：**没有新迁移**，仍是 30 个文件；新库首启 `applied=30 skipped=0`，已在 30 个迁移上的库是 `applied=0 skipped=30`。

判据：启动日志与心跳里的 `build=preset-import-2`；导入结果区出现「其中 N 段是预设里关着的」（老版本这里没有这一行，`ignored` 里反而有 `reason='disabled'` 一类）。

回滚：把 `src/core/prompt/sillytavern.ts:272-275` 的停用段分支改回「记 `ignored`（`reason='disabled'`）后 `continue`」，恢复 `IgnoredEntry.reason` 的 `'disabled'` 成员与后台那一栏，门牌退回 `context-stream-1`。导入只写 `prompt_presets` / `prompt_segments` / `prompt_injections`，回滚后新导入回到旧口径；已经按停用导入的行留在库里（`enabled=false`），回滚前先想清楚这些行要不要清。

## 59. context-tool-6：模型只调 context 交白卷时补一次交付回合（2026-11-07）

前文各节里写的「现版」「现在门牌是 `preset-import-2`」这类句子一律是各自写作时的口径，读作 §58 那一版；**现版以本节为准**。这一版只动一件事：开了 `contextTool` 的频道里，模型只调 `context` 工具就收尾、一个字正文都不交时，先补一次**交付回合**再谈重试。

### 59.1 线上症状与探针证据

4a 频道（以及所有开了 `contextTool` 的频道）里，线上模型 `gemini-4-argon`（经 `pg` 中继）只调用 `context` 工具就收尾：`finish=stop`、`name=context`、`completion_tokens` 21–26、5–11 秒，一个字正文都不交；`readToolReply` 只认 `story_reply`，于是 `raw` 为空，这一轮落一次 `EMPTY_RESPONSE`。探针同一形状连打三次全部如此；只有一次真的调了 `story_reply` 才出 1003 字正文，耗时 32–47 秒。

日志里看到的「空回复重试 2/3」「3/3」**不是第二次、第三次重试，而是第一次、第二次空回**（代码按 `empties+1` 口径写这两个数字）；第三次空回不再打这条 warn，静默换候选，最后落到 `deepseek-v4-pro`。所以「重试 3 次」的观感是错的：真正发生的是空回从没被救过一次，就直接开始数数。

### 59.2 根因

这一模式的正文只从 `story_reply` 的 `game_content` 里取（`readToolReply` 只认这一个工具名）。`context` 是描述体载体——它的「参数」就是预设与历史本身，交不出给用户看的正文。模型把「调一次工具」当成一次交付，于是 `raw.trim() === ''`，服务层按空回处理（`src/core/chat/service.ts:1551-1561` 那套 warn 与重试）。

### 59.3 两个杠杆

1. **在 system 里叫住 `context`**：`CONTEXT_TOOL_SYSTEM`（`src/core/chat/context-tool.ts:22` 起）明确写「不要调用 context 工具——设定就在它的描述里，直接写正文」。首回合的 `system` 仍然只有这一段。
2. **补一次交付回合**：首回合 `raw.trim() === ''` 且这一轮确实调过工具（`first.calls > 0`）时，按 59.4 的形状再发一次请求；仍然为空才走原来的空回原地重试。

### 59.4 补交付请求形状

首回合不变：`contextBody`（`src/core/chat/service.ts:1227`）＝预设 before + after + 摘要 + `budgetedHistory(8000 字)` + 本轮那一行。补交付那一发只换两样东西：

| 字段 | 补交付那一发 |
| --- | --- |
| `system` | `contextReplySystem`（`src/core/chat/service.ts:1245`）＝ `CONTEXT_REPLY_SYSTEM_PREFIX` + `contextBody` |
| `tools` | 只留 `replyOnlyTools()`（`src/core/chat/context-tool.ts:212`，定义来自私有的 `replyToolDefinition()`，`:189`） |
| `toolChoice` | `'auto'` |
| `reasoningEffort` | `CONTEXT_TOOL_REASONING_EFFORT`（`'low'`） |
| `temperature` / `maxTokens` / `images` | 与首回合完全相同 |
| `messages` | 与首回合完全相同 |

### 59.5 语义边界

- **每回合最多补一次**：补交付之后仍空，走的是原来的空回原地重试（`empties` 计数照旧），不会连环补。
- **补交付不换模型、不换路由**：同一个候选、同一把 key，换的只有 `system` 与 `tools`；`temperature` / `maxTokens` / `images` 照旧。
- **`contextToolMode` 为 false 的频道零变化**：不建 `contextBody`、不发 `tools`、日志里没有 `mode=context`。
- **不碰正文链路**：`story_reply` 的正文解析、剥壳与 `<game>` / `<game_content>` 包裹标签的处理一个字没动。

### 59.6 代码地图

| 位置 | 这一版的样子 |
| --- | --- |
| `src/core/chat/service.ts:1338` | `const streamContext = async (target: LlmRequest)`：攒 `tool_calls`、`readToolReply`、回报 `calls` 数 |
| `src/core/chat/service.ts:1360` | `if (contextToolMode)` 起先发首回合 |
| `src/core/chat/service.ts:1367-1387` | 首回合 `raw.trim() === ''` 且 `first.calls > 0`：`emit('warn','chat','空回补交付 model=… key=…')` 后再发一次 |
| `src/core/chat/service.ts:1227` | `const contextBody`（描述体，内容与上一版逐字相同） |
| `src/core/chat/service.ts:1245` | `contextReplySystem` |
| `src/core/chat/context-tool.ts:22` | `CONTEXT_TOOL_SYSTEM`（首回合唯一 `system`，多了「不要调用 context 工具」这一句） |
| `src/core/chat/context-tool.ts:189` | `replyToolDefinition()`（私有） |
| `src/core/chat/context-tool.ts:212` | `replyOnlyTools()` |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'context-tool-6'` |
| `test/gateway.node.test.ts:229` | 期望 `[gateway] node host started build=context-tool-6` |
| `web/src/api.ts:330` / `:1807` / `:2283` / `:2575` | 『门牌 `context-tool-6`』注释 |
| `web/src/styles.css:1501` | 同一批门牌注释 |

### 59.7 门槛、部署与线上判据

门槛全绿：`npm run typecheck` / `typecheck:node` / `typecheck:web` 全 0；`npm test` 81 个文件 1548 例全过（`test/chat.context-tool.test.ts` 20 例、`test/chat.service.test.ts` 125 例）；`npm run test:node` 9 个文件 116 通过 + 1 跳过；`npm run build:web` 产出 `dist/web/assets/index-Crkd0bo8.js` 386.95 kB（gzip 112.79）、`dist/web/assets/index-B0KPgCn-.css` 21.48 kB。

迁移：**没有新迁移**，仍是 30 个；已在 30 个迁移上的库升级是 `applied=0 skipped=30`。

部署：代码提交 `a81e1e8`；部署包 401,840 字节 / 191 条目；部署前服务器源码备份 `backup-src-20261106-213518.tar.gz`。线上 `build=context-tool-6`、gateway `READY as 示例机器人`、`health {"ok":true}`。

判据：`runtime_logs` 里出现 `空回补交付 model=… key=…` 这条 warn，说明这一轮走过补交付、首回合交的是白卷——**这是修复生效的证据，不是故障**；成功那行仍带 `mode=context`。一条 warn 都没有、回复也正常，说明首回合一次就交付了。判据顺序见 `docs/operations.md` §37。

## 60. self-name-1：被回复的名字先读服务器昵称，回复机器人自己时署名「你自己」（2026-11-08）

前文各节里的「现版」「现在门牌是 `key-unicode-1`」一律读作各自写作时的口径；**现版以本节为准**。这一版只动署名：谁说话用哪个名字、被回复的对象是谁，两条都不再靠猜。

### 60.1 线上症状

频道 `<ID-8>` 里，`小明` 先回了一条由机器人发出的消息，下一条里示例角色把机器人当成外人：

> 示例：她把机器人当外人，回了一句「还能是什么鲸鱼，就是这个叫 <机器人账号名> 的家伙喵」。

「示例机器人」确实是机器人自己的 Discord 账号名（`<ID-7>`，2023 年的老行里也这么写）；它在服务器里的昵称是「示例角色」。也就是说：她能认出「有人回复了我」，却读不出「回的是我」。

### 60.2 两个原因叠在一起

1. **被回复者的名字读的是错的字段**：`src/workers/gateway/message.ts:110`（旧实现）写 `authorName: readString(author, 'global_name') ?? readString(author, 'username') ?? ''`，注释写着「服务器昵称优先」，但 `referenced_message.member.nick` 根本没读。机器人账号没有 `global_name`，于是只剩下账号名「示例机器人」。
2. **她自己的历史行不带署名**：`src/core/chat/line.ts:18` `if (message.role !== 'user') return { role: message.role, content: head + message.content };`——assistant 行只有时间戳。两条合起来，提示词里就凭空多了一个「只有名字、没有任何台词」的外人。

系统其实早就知道「这是回我自己」：`src/workers/gateway/engine.ts:537` 的 `#botId()`（READY 的 `botUserId`，回落 `applicationId`）与 `src/workers/gateway/message.ts:194` 的 `repliedToMe`；只是这个事实从来没写进提示词。

### 60.3 修法一：名字统一走 `authorDisplayName`

`src/workers/gateway/message.ts:30` 新增 `export function authorDisplayName(author: IncomingAuthor): string`：服务器昵称 > 全局显示名 > 账号名，三者都先 `trim()` 判非空，全空才回落「未知用户」。`IncomingAuthor` 多了 `nickname: string | null`（`message.ts:22`），值来自整条载荷的 `member.nick`（`message.ts:165`）；`readReplyTo` 改成 `readString(readRecord(record, 'member'), 'nick') ?? global_name ?? username ?? ''`（`message.ts:127`）。

网关里三处作者名一律改用它：`engine.ts:258`（贴表情那一路的 `triggerTarget`）、`engine.ts:658`（`TurnContext.userName`）、`engine.ts:874`（落库的 `author`）。所以后台「消息」页与提示词里看到的名字，从此与群里显示的一致。

### 60.4 修法二：回复机器人自己时署名「你自己」

`src/workers/gateway/engine.ts:229` 新增 `const SELF_REPLY_AUTHOR = '你自己';`，`toReplyRef(message, botId)`（`:232`）在 `botId !== '' && replyTo.authorId === botId` 时把 `author` 换成这个常量（`:239`）；两处调用点带上 `this.#botId()`：`engine.ts:670`（拼 `TurnContext`）与 `engine.ts:878`（`#recordMessage` 落库）。

只修昵称不够：她自己的历史行不带署名，模型手里只剩一个「示例角色」的空名字，照样会把「她」当成第三个人；写成「你自己」，这一次回复才被认回自己身上。落库的 `reply_to_author` 同样是「你自己」，所以下一轮再从库里读历史时口径一致。

### 60.5 代码地图

| 位置 | 内容 |
| --- | --- |
| `src/workers/gateway/message.ts:22` | `IncomingAuthor.nickname` |
| `src/workers/gateway/message.ts:30` | `authorDisplayName`（昵称 > 全局显示名 > 账号名 > 未知用户） |
| `src/workers/gateway/message.ts:127` | `readReplyTo` 先读 `referenced_message.member.nick` |
| `src/workers/gateway/message.ts:165` | `author.nickname = payload.member.nick` |
| `src/workers/gateway/engine.ts:229` | `SELF_REPLY_AUTHOR = '你自己'` |
| `src/workers/gateway/engine.ts:232-243` | `toReplyRef(message, botId)` 与「回复自己」判定 |
| `src/workers/gateway/engine.ts:537` | `#botId()`（`botUserId`，回落 `applicationId`） |
| `src/workers/gateway/engine.ts:670` / `:878` | 两处调用点都带 `this.#botId()` |
| `src/workers/gateway/engine.ts:258` / `:658` / `:874` | 三处作者名改用 `authorDisplayName` |
| `src/workers/gateway/engine.ts:129` | `GATEWAY_BUILD = 'self-name-1'` |
| `test/gateway.node.test.ts:229` | 期望 `build=self-name-1` |
| `web/src/api.ts:330` / `:1807` / `:2283` / `:2575` | 门牌注释 |
| `web/src/styles.css:1501` | 同一批门牌注释 |

### 60.6 测试、门槛与部署

- 新用例：`test/gateway.message.test.ts:127`（`member.nick` 压过账号名 → `replyTo.authorName === '示例角色'`）、`:142`（`payload.member.nick` → `author.nickname`）、`:148`（`authorDisplayName` 四档，含 `'  '` 回落）；`test/gateway.react.test.ts:410`（被回复者昵称进 `replyTo`）、`:421`（回复的就是机器人自己 → `replyTo.author === '你自己'`）；`test/gateway.record.test.ts:185`（落库 `author_name` 用服务器昵称）。
- 门槛全绿：`npm run typecheck` / `npm run typecheck:web` 全 0；`npm test` 82 个文件 **1562 例**（此前 1556）；`npm run build:web` 产物仍是 `dist/web/assets/index-Crkd0bo8.js` 386.95 kB（gzip 112.79）、`index-B0KPgCn-.css` 21.48 kB——这次改动只在注释里带门牌字符串，压缩后不留痕。
- 部署：代码提交 `7f7a718`；部署包 1,127,875 字节；服务器源码备份 `backup-src-20261107-193845.tar.gz`；启动 `applied=0 skipped=30`（没有新迁移，仍是 30 个）、`build=self-name-1`、`gateway READY as 示例机器人`、`/api/health {"ok":true}`。

### 60.7 判据与边界

- 判据一：群里有人回复机器人的消息时，后台「消息」里那条新行的 `reply_to_author` 是 `你自己`，不再是账号名。
- 判据二：其它人的回复署名是**服务器昵称**（带 `member.nick` 的服务器里），落库的 `author_name` 同样用昵称。
- 边界：只动「显示名」与「被回复对象的署名」，`author_id` / `user_id` / `reply_to_author_id` 一字不改，历史正文不动；昵称改回原名后，旧行的署名不会回写——它记的是当时那一轮的展示名。没有新迁移。

## 61. recall-tags-1：长期记忆套 `<recall>`，短期历史套 `<recent>`（2026-11-08）

前文各节里的「现版」「现在门牌是 …」一律读作各自写作时的口径；**现版以本节为准**。这一版只加标签：记忆正文、字数预算、路由、迁移一个都没动。

### 61.1 要求与决定


### 61.2 拼出来的形状

上下文工具模式（4a 那条路径）里 `context` 工具描述体按「预设 before → 预设 after → 长期记忆 → 短期历史 → 本轮这一行」排列，其中两段记忆现在长这样：

```text
<recall>
【长期记忆摘要】
【记忆段】（覆盖 10-27 23:02 ~ 10-28 19:39，最后一句约在 10-28 晚上七点半）
…
</recall>

<recent>
[11-08 03:41] 示例角色保持着双手抱胸的姿势愣在了原地，头顶那对猫耳猛地竖了起来。
[11-08 03:41] 小明(<ID-1>)：<上一轮用户台词> ↳ 回复 你自己(<ID-7>)：「<@<ID-1>> 示例角色原本屈膝坐在…」
</recent>

[11-08 03:43] 小明(<ID-1>)：<本轮用户原话>
```

最后那一行是本轮用户原话，**不进标签**（它是这一轮的输入，不是回忆）；assistant 行照旧只有时刻 + 正文（`src/core/chat/line.ts:18`）。

### 61.3 两种模式的差异

- **长期记忆两模式同口径**：标签写在 `renderSummaryBlock` 的返回值里，所以普通模式（摘要在本轮 user 消息最前，`src/core/chat/service.ts:1215-1216`）与上下文工具模式（摘要在描述体第 3 段）都带 `<recall>`。
- **短期历史只有上下文工具模式能包**：这一模式下历史是拼出来的一整段文本（`service.ts:1237` 的 `taggedHistory(budgetedHistory(...))`）；普通模式的历史是 `messages` 数组里一条条消息，要包就只能改正文或插假消息，两者都会污染消息结构，所以不包——普通模式里你看不到 `<recent>`。
- **空块不出标签**：`taggedHistory('')` 返回空串。否则 `<recent>\n\n</recent>` 会让 `composeContextBody` 的「空段整段跳过」失效，描述体里凭空多两个空行。

### 61.4 代码地图

| 位置 | 内容 |
| --- | --- |
| `src/core/chat/summary.ts:173-174` | `SUMMARY_TAG_OPEN = '<recall>'`、`SUMMARY_TAG_CLOSE = '</recall>'` |
| `src/core/chat/summary.ts:180-184` | `renderSummaryBlock` 返回 `'\n\n' + OPEN + '\n【长期记忆摘要】\n' + 正文 + '\n' + CLOSE` |
| `src/core/chat/context-tool.ts:79-80` | `HISTORY_TAG_OPEN = '<recent>'`、`HISTORY_TAG_CLOSE = '</recent>'` |
| `src/core/chat/context-tool.ts:83-87` | `taggedHistory(text)`：`trim()` 后为空返回 `''`，否则前后各一行标签 |
| `src/core/chat/service.ts:101` | `import { … taggedHistory }` |
| `src/core/chat/service.ts:1237` | 描述体第 4 段 = `taggedHistory(budgetedHistory(kept.map(m => m.content)))` |
| `src/workers/gateway/engine.ts:130` | `GATEWAY_BUILD = 'recall-tags-1'` |
| `test/gateway.node.test.ts:229` | 期望 `build=recall-tags-1` |
| `web/src/api.ts:330` / `:1807` / `:2283` / `:2575` | 门牌注释 |
| `web/src/styles.css:1501` | 同一批门牌注释 |

### 61.5 测试、门槛与部署

- 新用例：`test/chat.context-tool.test.ts:218` 起「§61 记忆标签」三条——多行原样带出（`:219`）、空历史返回空串且描述体不留空标签（`:223`）、`<recall>` 与 `<recent>` 各自成块且顺序固定（`:229`）。
- 改断言：`test/summary.logic.test.ts:215` / `:225` / `:231` / `:237` 四条 `renderSummaryBlock` 期望值改成带 `<recall>` 的形状；`test/chat.summary.test.ts:484`（本轮 user 消息以 `<recall>` 开头）与 `:494`（整条消息全文）；`test/chat.service.test.ts:3143` / `:3145` / `:3147` 三条描述体断言（含「`</recall>` 早于 `<recent>`」）。
- 门槛全绿：`npm run typecheck` / `npm run typecheck:node` / `npm run typecheck:web` 全 0；`npm test` 82 个文件 **1565 例**（此前 1562）；`npm run test:node` 9 个文件 116 通过 + 1 跳过；`npm run build:web` 产物哈希不变（`dist/web/assets/index-Crkd0bo8.js` 386.95 kB、`index-B0KPgCn-.css` 21.48 kB）。
- 部署：代码提交 `9204296`；部署包 1,131,911 字节；服务器源码备份 `backup-src-20261108-040700.tar.gz`；启动 `applied=0 skipped=30`（没有新迁移，仍是 30 个）、`build=recall-tags-1`、`gateway READY as 示例机器人`、`/api/health {"ok":true}`。

### 61.6 边界

- 标签只加在**拼出来的提示词文本**上：`conversation_summaries` 的段正文、`messages` 的正文、摘要预算 4,000 字、历史预算 2,500 字（`src/core/chat/context-tool.ts:51`）全都不变；重开一次总结也不会把标签写进库。
- 标签占的字符**不进预算**：摘要先由 `selectSegments` 按预算选段、再由 `renderSummaryBlock` 包标签；历史先由 `budgetedHistory` 裁到 2,500 字、再由 `taggedHistory` 包标签。所以描述体比标称预算多 18 个字符（两组标签各 9 + 9），不是漏算。
- 模型若把标签抄进正文，现在没人剥：`stripWrapperTags`（`src/core/chat/wrapper-tags.ts`）只剥 `<game>` 这些已知包裹标签，`<recall>` / `<recent>` 不在名单里。线上还没出现过；真出现了再把它加进名单。
- **标签名已经被预设点名**：线上三个频道层各有一段「🧪历史回顾」（`prompt_segments`，`position=35`、`placement=before`，`2026-11-07T20:16:01Z` 起）写着「先从历史记录<recall>和<recent>还有世界设定里回忆…」。所以这两个名字是**对外契约**：改名就得连这三段一起改，否则预设指着一个不存在的块。
- 回退：镜像回退 `self-name-1` 即回到「没有任何标签」的提示词；数据不动、没有迁移。
## 62. history-del-2：后台「历史」页可以手动删单条短期记忆（2026-11-08）

前文各节里的「现版」「现在门牌是 …」一律读作各自写作时的口径；**现版以本节为准**。这一版只加「删一行」的能力：拼提示词、摘要、路由、迁移都没动。

### 62.1 要求与两个决定


### 62.2 一条删除走的路

```text
后台「历史」页（web/src/pages/HistoryPage.tsx）
  → DELETE /api/messages/:id
      → conversations.getById(id)        取这一行（带上 channel_id，Discord 定位要用）
      → pruneDiscordMessage(row)         先删 Discord 那条（失败不影响下一步）
      → conversations.removeById(id)     再删库里的行
  → { ok, deleted, discord, detail, message }
```

顺序是有意的：**先删 Discord、后删库**。反过来的话，Discord 删失败时库里那行已经没了，人就再也没机会从后台重试（列表里看不到它了）。现在库里这行留到最后一步，Discord 侧失败了用户还能再点一次。

### 62.3 Discord 那边怎么定位那一条

- **新行靠 `discord_id`**：网关发回复时把消息 id 记进来（`attachDiscordId`，见 62.4），所以 `DELETE /channels/{id}/messages/{messageId}` 一步到位，404 当「早就删过了」（`not_found`）。
- **老行靠「时间窗 + 正文比对」**：`discord_id` 是迁移 0016 才有的列，之前落库的行几乎都是 NULL。没有 id 时用 `created_at` 换雪花（`snowflakeOf`，`(ms - 1420070400000) << 22`）当 `around` 参数拉 50 条，然后按「作者对得上 + 正文归一后逐字相等」筛：assistant 行认 `author.bot === true`，用户行认 `author.id === authorId`；正文先剥 `<@id>` 提及、再把连续空白压成单空格（库里存的是剥掉提及的原文，Discord 那边是带提及的）。
- **筛出多条就不猜**：回 `ambiguous`，一个 DELETE 都不发。宁可让人手工删，也不能删错别人的消息。
- 结局只有五种：`deleted` / `not_found` / `ambiguous` / `no_token`（没配 `DISCORD_BOT_TOKEN`）/ `failed`（带状态码与正文前 160 字）。函数**从不抛错**：Discord 这一侧的成败由调用方决定要不要牵连库里的行。

### 62.4 `discord_id` 从哪来

| 时机 | 写入方式 |
| --- | --- |
| 用户消息（@ 路径） | `context.userDiscordId = message.messageId` → 服务层落库时写进 `ChatMessage.discordId` |
| 用户消息（不 @ 的旁听消息） | `#recordMessage` 的 row 直接带 `discordId: message.messageId` |
| 回复（流式首条） | `#openStream` 的 `finish` 返回消息 id；调用方拿它调 `attachDiscordId(key, 正文, id)` |
| 回复（整段发送） | 同一处：整段发送也从 `sendMessage` 改成 `createMessage`（`?wait=true`）就为了拿这个 id |

`attachDiscordId` 的 UPDATE 条件是「同频道 + `role = 'assistant'` + 正文逐字相等 + `ORDER BY id DESC LIMIT 1`」——回复刚发出来一定是最新那条同正文的行，所以不用再传时间。超长回复被切成多条时只有第一条有 id，`pruneDiscordMessage` 会按整篇正文去比对而找不到（`not_found`）：宁可删不掉，也不删半条。

### 62.5 两个只在线上才现形的坑

**空串 vs NULL**：`migrations/0016_message_discord_id.sql` 给 `discord_id` 建了**唯一索引**。第一版把「不知道」写成空串，结果第二条消息就撞 `UNIQUE constraint failed: messages.discord_id`；改成写 `NULL`（SQLite 的唯一索引允许多个 NULL）才过。同一批落库的其它四列（`reply_to_*`）仍是空串，它们的语义是「没有」而不是「唯一」，不受影响。

**`run()` 的返回形状**：D1 回 `{ meta: { changes } }`，node:sqlite 回 `{ changes }`。第一版只读 `meta.changes`，于是线上（node 宿主）每一行都删得掉、却每次回 `deleted: false`——`removeById` 现在两个形状都读（`result.meta?.changes ?? result.changes ?? 0`）。这类差异只有真连上 node 库才会露出来，`test/node.sqlite.test.ts` 那条用例就是钉它的。

**两个入口**：后台 app 有两条装配路径——`src/workers/index.ts`（Workers 入口）与 `src/node/main.ts`（线上真正跑的 node 宿主）。第一版只接了 Workers 那条，线上于是每行都回 `discord: "skipped"`；现在两边都接。`src/node/main.ts:9-10` 那句「改一处就得同步改另一处」就是给这类漏接写的。

### 62.6 代码地图

| 位置 | 内容 |
| --- | --- |
| `src/core/types.ts` | `ChatMessage.discordId?`、`TurnContext.userDiscordId?`、`StoredMessage = { id, channelId? }` |
| `src/core/ports.ts` | `ConversationStore.getById?` / `removeById?` / `attachDiscordId?`（**可选**，老仓储与测试假仓储不必实现） |
| `src/workers/db/d1-repository.ts:989-1011` | `discordColumn`（空 → NULL）与 12 列 INSERT |
| `src/workers/db/d1-repository.ts:1023` / `:1033` / `:1041` | `getById`（SELECT 多带 `channel_id`）/ `removeById`（`meta.changes ?? changes` 两种形状都读）/ `attachDiscordId` |
| `src/workers/discord/prune.ts:38` | `snowflakeOf(iso)` |
| `src/workers/discord/prune.ts:90` | `deleteOnce`（404 → `not_found`，其它 → `failed（状态码）`） |
| `src/workers/discord/prune.ts:107` | `pruneDiscordMessage`（有 id 直删，否则时间窗 + 归一比对） |
| `src/workers/http/app.ts:1263` | `DELETE /api/messages/:id`（400 `BAD_MESSAGE_ID` / 404 `MESSAGE_NOT_FOUND` / 501 `HISTORY_DELETE_UNAVAILABLE`） |
| `src/workers/index.ts:302` / `src/node/main.ts:272` | 装配（**两条入口都要接**）：把行摊成 `PruneTarget` 再调 prune；线上跑的是 node 那条 |
| `src/workers/gateway/engine.ts:670` / `:748` / `:751` / `:903` | 用户消息带 id、`finish` 返回消息 id、`attachDiscordId`、"不 @ 的旁听消息" 带 id |
| `web/src/api.ts:799` | `deleteHistoryMessage(id)` |
| `web/src/pages/HistoryPage.tsx:54` | 「历史」页（服务器/频道 + 最近 50 条 + 逐行删除 + Discord 结局） |
| `web/src/App.tsx:37` | Tab「历史」（在「摘要」与「记忆」之间） |
| `src/workers/gateway/engine.ts:130` | `GATEWAY_BUILD = 'history-del-2'` |

### 62.7 测试、门槛与部署

- 新用例：`test/discord.prune.test.ts` 13 例（雪花换算两条、直删、直删 404、时间窗命中、多条歧义、作者不符、bot 行 `author.bot`、提及/空白归一、没 token、时间解析不出、删除 5xx、读窗口 403）。
- 扩展：`test/admin.summaries.test.ts` 新增「§62 删单条短期记忆」五例（正常删除并核对交给 prune 的字段、Discord ambiguous 仍删库、prune 抛错按 failed 收、未接线记 `skipped`、400/404/501 三个出口）与仓储一例（`getById` 带频道、`attachDiscordId` 只改最新一条、`removeById` 第二次回 false）；`test/admin.crud.test.ts:1128` 的路由清单补一行。
- 改断言：`test/gateway.stream.test.ts` 的 `sends()`（只数补发）与新增 `created()`（`?wait=true`）、403 用例改成「只拒第一次建消息」；`test/gateway.react.test.ts` 的 `messageCalls()` 与 `stubFetch` 默认回 `{ id }`。
- 真库用例：`test/node.sqlite.test.ts` 新增一条（`getById` 带回频道、`removeById` 认 node:sqlite 的 `changes`、`attachDiscordId` 只改最新一条）；它跑在真实 SQLite 上，所以 62.5 里那两个坑它能拦住。
- 门槛全绿：`npm run typecheck` / `typecheck:node` / `typecheck:web` 全 0；`npm test` 83 个文件 **1578 例**（新用例落在 test:node）；`npm run test:node` 9 个文件 117 通过 + 1 跳过；`npm run build:web` 产物见 `dist/web/assets/`。

### 62.8 边界

- **只删「短期记忆」的那一行**：`conversation_summaries` 一段都不动。已经总结进长期记忆的内容仍在，删行不会把它从摘要里抠出来——要改摘要得走「摘要」页手改。
- **不删频道里的旁证**：`channel_memories`（频道长期记忆）与 `prompt_segments` 无关，一个字不动。
- **老行往往删不掉 Discord 那条**：迁移 0016 之前的行没有 `discord_id`，只能靠时间窗 + 正文比对；正文被编辑过（Discord 支持编辑）或时间窗里挤了 50 条以上就会 `not_found` / `ambiguous`，库里照样删掉，Discord 那条留给人工。
- **超长回复只有第一条有 id**：分段补发的那几条没记 id（`sendMessage` 不拿回执），删的时候按整篇正文比对会落 `not_found`。
- 回退：镜像回退 `recall-tags-1` 即回到「没有历史页、也不能删单行」；那条路由与页面一起消失，库里的数据不动、没有新迁移（仍 30 个）。

## 63. bot-name-1：后台手动连续总结长期记忆（2026-11-08）

前文各节里写的「现版」一律是各自写作时的口径；现版以本节为准。


后台「摘要」页原本只有「重新总结」，它走 `POST /api/summaries/regenerate`，一次只消化一批；一批的条数由该频道的自动总结阈值决定（`summaryBatchLimit`，`src/core/chat/service.ts:245`，只有阈值不设时才用满 500）。积压几千条时要点几十次、每次等 30–60 秒。这一节记的是「一次 500 条、没完自动接着来」怎么做的。

### 63.1 两个决定

| 问题 | 决定 | 为什么 |
| --- | --- | --- |
| 谁负责接力 | **前端自动接力**：一批一个请求，页面拿到 `remaining` 就立刻发下一批 | 服务端不建后台任务、不落任务表、不用清扫僵尸任务；关掉页面就是停，进度已经在库里（游标 `covered_until_id`），下次再点接着走 |
| 吃哪些消息 | **只吃游标之后还没进记忆的原文**，按段追加到已有记忆尾部 | 长期记忆的契约是「只增不减、老段永不改写」（§31）；清空重建会把压过的记忆重写一遍，还多烧一次模型 |

### 63.2 一批怎么算

- 硬上限 **500 条**，来自 `SUMMARY_BATCH_SAFE_MAX`（`src/core/chat/service.ts:236`），**不读频道阈值**——这就是「一次 500 条」的字面实现。频道把自动总结阈值调到 200，只影响自动总结，不影响这里。
- 游标是唯一权威：`summarizeBatch(key, 500)` 先读 `conversation_summaries.covered_until_id`，用 `conversations.loadAfter(key, cursor)` 取游标之后的消息、按 id 升序取最老 500 条，送模型前按 `created_at` 重排，落库时把游标推到这批最大 id。所以连续两次请求**互不重叠**，前端不需要传任何偏移量。
- 每批结束都重新数一次「游标之后还剩多少条」再回给前端：`summarizeSweep`（`src/core/chat/service.ts:688`）在 `summarizeBatch` 之后重新 `summaries.get(key)` + `conversations.loadAfter(...)`，`remaining` 就是**下一批能吃的量**、不含本批——剩 0 才是真的吃完。
- 一批的产出仍然是一段 `【记忆段】（覆盖 A ~ B，最后一句约在 …）`，由 `appendSegment` 追加到尾部，与 `/summary`、自动总结同一条落库路径。
- 每批落一条日志：`连续总结 covered=<id> msgs=<n> 剩余=<m>`（`severity=info`、`source=summary`），台上实时日志里能看到接力在进行。

### 63.3 接口形状

`POST /api/summaries/sweep`，body `{ guildId, channelId }`。

| 情况 | 状态 | 回执 |
| --- | --- | --- |
| 消化了一批 | 200 | `{ outcome: { summary, coveredUntilId, summarizedMessages, model }, remaining }` |
| 游标之后没有原文 | 409 | `{ error: 'NO_SUMMARY_MATERIAL', outcome: null, remaining }` |
| 宿主没接这个能力 | 501 | `{ error: 'SUMMARY_UNAVAILABLE' }` |
| 模型侧失败 | 502 | `{ error: 'SUMMARY_FAILED', detail }`（detail 截 300 字） |
| key 不合法 | 400 | `{ error: 'BAD_CHANNEL_KEY' }` |

409 不是错误，是「这一批没东西可吃」的正常回执；前端把它当收工信号，不再发下一批。

### 63.4 前端接力与三个停手条件

「摘要」页新增一张「连续总结（每批 500 条）」卡片（`web/src/pages/SummaryPage.tsx:522` 附近）。点按钮先 `window.confirm`，然后在 `sweep()`（`web/src/pages/SummaryPage.tsx:350`）里循环。停手条件三条：

1. `outcome === null`（409 被 `web/src/api.ts:979` 吃成正常回执）——没有未总结原文；
2. `remaining <= 0`——刚才那批把积压吃完了；
3. `remaining >= previous`——这一批没让剩余变少（模型没产出、或游标没推进），再发只会空转，直接停并提示。

进度行实时写「已总结 X 条 · 还剩 Y 条」：X 是本轮累计的 `summarizedMessages` 之和，Y 是最新一批回报的剩余条数。任何异常（网络、502、401）都会停下并显示原因；**再点一次就从库里那个游标继续**，不会重做已经总结过的部分。

### 63.5 代码地图

- 结果类型：`src/core/types.ts:104` `export interface SummarySweepOutcome { outcome: SummaryOutcome | null; remaining: number }`。
- 服务层：`ChatService.summarizeSweep`（`src/core/chat/service.ts:165` 声明、`:688` 实现），从 `createChatService` 的返回里导出（`src/core/chat/service.ts:1619`）。
- HTTP：deps 字段 `src/workers/http/app.ts:262-263`，路由 `src/workers/http/app.ts:2045`。
- 装配两条入口（上次 §62 的教训，少一条线上就会回 501）：`src/workers/index.ts:283-285` 与 `src/node/main.ts:253-255`。
- 日志：这四条后台摘要入口都要把 `log: sink` 一起传进 `createChatService`——不传的话服务层那条 info / summary 日志调用落进空实现，台上实时日志一行都看不到（收尾时线上实测才发现：探针跑完一批接口回 200，`runtime_logs` 里却没有 `连续总结` 那一行，补上 `log: sink` 才有）。
- 前端：`web/src/api.ts:970` `SummarySweepResult` + `:979` `summarizeSweep()`；`web/src/pages/SummaryPage.tsx:47` 的 `BusyKind` 多了 `'sweep'`、`:133-136` 是进度状态、`:350` 是循环、`:522` 是卡片。

### 63.6 测试、门槛与部署

- 新用例：`test/chat.summary.test.ts` 的「§63 连续总结：一批 500 条、回报剩余、没完接着来」两例——1200 条分三批吃（500 / 500 / 200，剩余 700 / 200 / 0，第四批 409 语义回 `{ outcome: null, remaining: 0 }`，第二批素材从第 501 条开始、不重叠），以及「频道阈值是 20 时一批仍吃满 500 条」。
- HTTP 用例：`test/admin.summaries.test.ts` 五例（未接线 501、200 带 remaining、409 带 remaining、502 detail 截 300、400 `BAD_CHANNEL_KEY`）；`test/admin.crud.test.ts:1108` 的路由清单补一行。
- 门槛全绿：`npm run typecheck` / `typecheck:node` / `typecheck:web` 全 0；`npm test` 83 个文件 **1585 例**；`npm run test:node` 9 个文件 117 通过 + 1 跳过；`npm run build:web` 产物 `dist/web/assets/index-Bxk8ENUs.js` 393.89 kB（gzip 114.62）、`index-DP2hj6Xq.css` 21.72 kB。
- 部署：`git archive` 出包 → scp 到服务器 → 先 `data/backup-src-<ts>.tar.gz` 备份 → 解包 → `sudo docker compose up -d --build`；预期 `build=summary-sweep-2`、`applied=0 skipped=30`、`gateway READY as 示例机器人`、`/api/health` ok。

### 63.7 边界

- **只追加、不改老段**：这一版没有「清空重建」入口，也没有「重写某段」的能力；要改记忆走「摘要」页手改。
- **不动自动总结**：自动总结仍按频道阈值跑，`/summary` 仍是一批；这一版只多了一个手动连续入口。
- **409 与 0 剩余不是一回事**：409 是「本批没东西可吃」，`remaining = 0` 才是「库里已经追平」。两者都让前端收工，但日志里能区分。
- **一批失败就整批失败**：500 条那一批里模型出错会 502，游标不动，再点重试同一批；不会自动切成 250 条。
- 没有新迁移（仍 30 条）。回退镜像 `history-del-2` 即回到旧后台（没有这张卡片、没有这个端点）。
## 64. bot-name-1：回复署名与 `{{bot_name}}` 改用服务器昵称（2026-11-08）

### 64.1 问题：记忆里写着「DC AI BOT」

- 现象：长期记忆摘要里是「DC AI BOT 说…」，而群里挂的名字是服务器昵称「示例角色」；模型读自己的记忆时读到的是个陌生人。
- 为什么进摘要：摘要素材由 `src/core/chat/summary.ts:40-57` 的 `formatTranscript` 拼，assistant 行的名字取 `message.author`（空则回落 `ANONYMOUS_ASSISTANT = 'Bot'`，`:33`）。
- 名字从哪来：助手落库时署名用的是 `ctx.botName`（`src/core/chat/service.ts:1539`），而网关给的是写死常量 `MESSAGE_BOT_NAME = 'DC AI BOT'`（`src/workers/gateway/engine.ts:160`），斜杠命令给的是 `DEFAULT_BOT_NAME`（`src/workers/discord/handler.ts:59`，装配层还有同名 `BOT_NAME` 常量）。
- 线上取证：`GET /users/@me` → bot id `<ID-7>`、username `示例机器人`、`global_name` 为 null；`GET /guilds/<ID-2>/members/<ID-7>` → 200，`nick=示例角色`（另一台服务器 `<ID-4>` 回 404，账号已不在那个服）。`messages` 里 assistant 署名分布：`DC AI BOT` 428 条、`類腦女孩` 41 条、`示例机器人` 32 条、NULL 8 条。
- `botName` 不只进署名：它还是提示词模板变量 `bot_name`（`src/core/chat/service.ts:356-366` 的 `resolveIdentityBlock`、`:408-416` 的 `buildPromptParts`）——同一个错名字也进了 system。

### 64.2 一条规则、三档回落

- 顺序固定：服务器昵称（`member.nick`）> 账号全局名（`user.global_name`）> 账号名（`user.username`）；三者都空就返回空串，调用侧退回 `MESSAGE_BOT_NAME` / `DEFAULT_BOT_NAME`。
- 私聊没有 guild、没配 Bot token、没有 botId 都直接空串，**不发请求**——这条规则只管「服务器里的名字」。
- 请求失败只吞成空串，不抛错：名字是锦上添花，绝不能让这条回复失败。

### 64.3 代码地图

- 新模块 `src/workers/discord/bot-name.ts`：`readMemberDisplayName(body)`（`:18`，纯函数，三档回落）、`BotNameOptions`（`:29`，在 `ChannelRestOptions` 上多一个必填 `botId`）、`resetBotNameCache()`（`:34`，测试用）、`resolveBotDisplayName(options, guildId)`（`:42`，`GET /guilds/{guildId}/members/{botId}`）。
- `src/workers/discord/rest.ts:102` 的 `channelRequest` 从模块私有改成 `export`（新模块复用它，鉴权头与错误文案与表情/频道那几条路完全一致）。
- 网关：`src/workers/gateway/engine.ts:69` import；`:655-660` 在组上下文前解析（`{ botToken: this.#token(), botId: this.#botId() }` + `message.guildId`），`:668` 把它写进 `botName`。
- 斜杠命令：`src/workers/discord/handler.ts:43` import；`:468-478` 先 `buildTurnContext`（拿 deps 的常量），解析到非空名才覆盖 `context.botName`；`botTokens` / `apiBase` / `fetch` 都从 deps 取，测试可注入。

### 64.4 缓存语义（改昵称不会立刻生效）

- 缓存键是 `guildId|botId`，进程内一张 `Map`（`bot-name.ts:11`）。
- 非空结果**永久缓存**；空结果缓存 `EMPTY_TTL_MS = 5 * 60 * 1000`（`:9`）——机器人不在的服不要每轮回复都为一个 404 再打一次 REST。
- 所以：改了服务器昵称要等进程重启（或那条空结果过 5 分钟）才会换名字；网关与斜杠命令共用同一张表。

### 64.5 存量数据回填

- 只改 assistant 行的 `author_name`：按 `guild_id` 分组，回填成该服解析出来的昵称；解析不到（bot 已不在那个服）保持原样。
- 回填前整表备份到服务器 `data/backup-assistant-names.json`；`messages` 的正文、id、`discord_id`、`reply_to_*` 一个字段都不动。
- 已写好的 `conversation_summaries` 正文**不改**：摘要文本是当时生成的，改名字只能等下一次重总结。

### 64.6 测试、门槛与部署

- 新用例 `test/discord.bot-name.test.ts` 6 例：三档回落、坏结构空串、按 guild 取一次且第二次命中缓存（断言 URL 与 `authorization: Bot …`）、两个 guild 分开缓存、缺 token/guild/botId 不发请求、404 不抛错且空结果在窗口内缓存。
- `test/discord.handler.test.ts:653` 起新增「服务器昵称（§64）」：`/chat` 的 `ctx.botName` 用成员接口回的昵称 `示例角色`。
- 门槛全绿：`npm run typecheck` / `typecheck:web` 全 0；`npm test` 84 个文件 **1592 例**；`npm run test:node` 9 个文件 117 通过 + 1 跳过；`npm run build:web` 产物 `dist/web/assets/index-Bxk8ENUs.js` 393.89 kB（gzip 114.62）、`index-DP2hj6Xq.css` 21.72 kB（与上一版一致）。
- 部署：`git archive` 出包 → scp 到服务器 → `data/backup-src-<ts>.tar.gz` 备份 → 解包 → `sudo docker compose up -d --build`；预期 `build=bot-name-1`、`applied=0 skipped=30`、`gateway READY as 示例机器人`、`/api/health` ok。

### 64.7 边界

- 只改署名与模板变量：历史正文、时间戳、id 一律不动。
- 只在「有 guild」时生效：私聊仍写常量（Discord 私聊里没有服务器昵称这个概念）。
- 一次解析只是多一次 REST：每个 guild 只在第一次发言时付这笔钱，之后走缓存。
- 没有新迁移（仍 30 条）。回退镜像 `summary-sweep-2` 即回到「署名恒为 DC AI BOT」的旧行为；回填过的 `author_name` 不会自动改回去（要回退就按备份文件恢复）。

## 65. worldbook-ctx-1：上下文工具模式把世界书也带上（2026-11-08）

### 65.1 漏在哪

- 上下文工具模式（§55）把整套提示词搬进 `context` 工具的描述体，拼装在 `src/core/chat/service.ts:1257-1269` 的 `composeContextBody([...])`：预设 before、预设 after、长期记忆摘要、`<recent>` 历史、本轮原话——**没有世界书**。
- 世界书那段只在普通模式的 `legacySystem` 里拼：`src/core/chat/service.ts:1201-1210`，位置是「身份块 + 提及规则 + 表情规则 + 语音提示 + 自定义表情 + 可贴消息」之后、`presetAfter` 之前。
- 于是开关打开的频道里，导入世界书完全不生效：命中判定照样跑（`resolveWorldBook` `:1154`、`selectWorldEntries` / `buildWorldBlock` `:1194`），拼出来的字符串却没人用。线上至今没被发现，是因为生产库 `world_books` 一直是 0 行（`migrations/0029_world_books.sql` 建的表），没有书可漏。

### 65.2 决定：放在预设段之后、记忆之前

描述体顺序定为：**预设 before → 预设 after → 【世界书】 → `<recall>` → `<recent>` → 本轮原话**。三条理由：

1. **预设必须在最前**：`before` 段是这套预设的 token 重置与工具约定（正文以 `{{trim}}` / `<|sep|>` 开头），排在它前面的东西会被切断，世界书不能插到它上面。
2. **设定先立、记忆后叙**：世界书是「世界是什么」，摘要与历史是「发生过什么」，事实在前、经历在后，模型读到的因果顺序才对得上。
3. **本轮原话永远最后**：它要贴近生成点，这条从 §55 起没变。

### 65.3 代码地图

- `src/core/chat/service.ts:1154` `resolveWorldBook(channelWorldBook, guildWorldBook, globalWorldBook)`：三层 channel > guild > global 整层覆盖。
- `src/core/chat/service.ts:1192` `worldWindow = [...tail.kept, { role: 'user', content: ctx.userText }]`：命中判定用**未署名**原文（带上「时刻+作者名」会让拿人名当关键词的条目每轮必中）。
- `src/core/chat/service.ts:1194` `worldBlock = worldBookHit === null ? '' : buildWorldBlock(selectWorldEntries(worldBookHit.book, worldWindow))`：段自带 `【世界书】` 标题，没书或没命中都是空串。
- `src/core/chat/service.ts:1261` 描述体第 3 段改成 `worldBlock`；空串由 `composeContextBody`（`src/core/chat/context-tool.ts:236-241`，逐段 trim 后滤空）整段跳过，所以没书时描述体与改动前逐字相同。
- 普通模式的 `worldPart`（`:1196`，带两个前导换行、拼进 `legacySystem`）一字未动。

### 65.4 测试与门槛

- `test/chat.service.test.ts` 的「§55 上下文工具模式」新增两例：世界书命中后描述体含 `【世界书】\n龙住在山里。`，且顺序是「收尾设定段 → 【世界书】 → `<recall>`」；三层都没书时描述体不含 `【世界书】`、预设段与 `<recall>` 仍紧挨着（不多出空段）。
- 门槛全绿：`npm run typecheck` / `typecheck:web` 全 0；`npm test` 84 个文件 **1594 例**；`npm run test:node` 9 个文件 117 通过 + 1 跳过；`npm run build:web` 产物 `dist/web/assets/index-Bxk8ENUs.js` 393.89 kB（gzip 114.62）、`index-DP2hj6Xq.css` 21.72 kB（哈希与上一版一致）。
- 部署：`git archive` 出包 → scp 到服务器 → `data/backup-src-<ts>.tar.gz` 备份 → 解包 → `sudo docker compose up -d --build`；预期 `build=worldbook-ctx-1`、`applied=0 skipped=30`、`gateway READY as 示例机器人`、`/api/health` ok。

### 65.5 边界

- 世界书仍**只按关键词命中**才成段：没书、没命中、条目停用都等于空串；`constant` 条目照旧常驻。
- 世界书只进 `context` 描述体，不进 `messages`：顶层仍只有那一条「请继续」的固定 user 消息。
- 普通模式的位置与拼接顺序不变；这次只补上下文工具模式那一条路径。
- 描述体的字数预算没动：摘要 4,000 字、历史 2,500 字各自独立，世界书按命中条目自带长度（先前的普通模式也是如此）。
- 没有新迁移（仍 30 条）。回退镜像 `bot-name-1` 即回到「context 模式不吃世界书」的旧行为。

## 66. emoji-body-2：正文里的自定义表情（2026-11-08）

### 66.1 断在哪一层

- 网关本来就认正文里的 `:名字:`：`resolveInlineEmojis`（`src/workers/discord/emoji.ts:34-52`）把它换成 `<:名字:id>`，命中服务器表情清单才换、查不到原样保留；入口在 `src/workers/gateway/engine.ts:754` 的 `chunkMessage(resolveInlineEmojis(text, customEmojis), chunkLimit)`。也就是说**解析侧一直是通的**，缺的是模型不知道有哪些名字。
- 上下文工具模式（§55）的 `system` 只剩一句 `CONTEXT_TOOL_SYSTEM`（`src/core/chat/context-tool.ts:21`），表情清单与贴表情规则只拼在普通模式的 `legacySystem`（`src/core/chat/service.ts:1201-1210`，`renderEmojiBlock` `:1207`、`renderReactionGuide` `:1205`）→ 这个模式下主模型从没拿到过清单。
- 即便拿到清单，内置贴表情规则最后一行（`src/core/chat/reaction-guide.ts:26`）写着「贴表情只走 `[[react:…]]`；正文照常说话，不要在正文里堆一串表情」，等于明文禁止。
- 贴表情是另一条链路（`buildReactionRequest` `src/core/chat/service.ts:1011` + `renderCatalog` `src/core/chat/reaction.ts:74`），与正文渲染无关——所以「表情能贴到消息上、正文里却一个都没有」并不矛盾。

### 66.2 决定：文案即开关，三层各一份，只列名字

- **不新增开关列、不新增表**：`body_emoji_guides` 与 `reaction_guides` 同形（`scope` / `scope_id` / `prompt` / `updated_at`，主键 `(scope, scope_id)`），文案本身就是开关——**三层都没有 = 关**，描述体一个字不加。
- **默认关（opt-in）**：`DEFAULT_BODY_EMOJI_GUIDE = ''`（`src/core/chat/body-emoji.ts:8`）。理由是这条提示词会被塞进剧情描述体，可能扰动预设的破甲效果；要不要开、怎么措辞，交给使用者决定。后台按钮「写入推荐文案」填的是 `BODY_EMOJI_SUGGESTION`（`:14`，逐字：「正文里可以自然带一两个 :名字:，只在真有情绪的那一句；不要每句都带、不要堆一串、不要解释表情本身。」），只有保存落库后才生效。
- **落点在预设与世界书之后、记忆之前**：预设 before → 预设 after → 【世界书】 → 【可用自定义表情】 → 【正文表情】 → `<recall>` → `<recent>` → 本轮原话。理由与 §65.2 同：预设的 token 重置与工具约定必须在最前，设定（世界）先立，用法（怎么带表情）紧随其后，记忆后叙，本轮原话永远贴生成点。
- **清单只列名字**：`renderEmojiNames`（`src/core/chat/service.ts:497`）只出 `:名字:`，不带 `(描述)` 与别名。认图描述是表情模型看图写给自己认表情用的元叙述（「黄色胖角色站立掐腰」），进剧情提示词会污染叙述口吻；正文侧只需要知道有哪些名字可用。去重与上限沿用 `MAX_EMOJI_IN_PROMPT`（`src/core/chat/service.ts:432`，40 个）。
- **普通模式不动**：那里的清单仍是 `renderEmojiBlock`（带描述与别名），是既有的挑表情行为（`test/chat.service.test.ts` §18.5 钉着）；这次只在它后面追加【正文表情】，且同样只在规则非空时追加。

### 66.3 代码地图

- `migrations/0031_body_emoji_guides.sql`：`body_emoji_guides(scope CHECK IN ('global','guild','channel'), scope_id DEFAULT '', prompt, updated_at, PRIMARY KEY(scope,scope_id))`，写法对齐 `0014_reaction_guides.sql`。
- `src/core/chat/body-emoji.ts:29` `resolveBodyEmojiGuide(channel, guild, global)`：channel → guild → global，null 或 trim 为空都当这一层没配，三层皆空回 `{ prompt: '', scope: 'global' }`。
- `src/core/chat/service.ts:135` `deps.bodyEmojiGuides?`（可选：没接线 = 整段不出现）；`:856` `readBodyEmojiGuide(scope, scopeId)`（读失败只当这层没有）；`:1208-1216` 三层解析 + `bodyEmojiPart` + `bodyEmojiSection` 门控——**规则为空时清单与规则一起消失**；`:1276` 普通模式在 `renderEmojiBlock` 之后追加 `bodyEmojiPart`；`:1332` 上下文工具模式用 `bodyEmojiSection`（世界书之后、摘要之前）。
- `src/workers/http/app.ts:1394` GET（回 `{ items, default: '', suggestion }`）、`:1405` PUT（`BAD_SCOPE` / `BAD_REQUEST` / `BAD_BODY_EMOJI_GUIDE`，上限 8,000 字，trim 落库）、`:1427` DELETE（幂等 `{ ok: true }`）。留空回上一层只由 DELETE 表达：PUT 收到空串一律 400。
- `src/workers/db/d1-repository.ts:1271` 仓储（同构 SQL、`ON CONFLICT` 覆盖写、`ORDER BY scope, scope_id`）；`src/core/ports.ts:173` `BodyEmojiGuideStore`；`src/core/types.ts:457` `BodyEmojiGuideConfig`。
- 门牌 `emoji-body-2`：`src/workers/gateway/engine.ts:131`、`test/gateway.node.test.ts:229`、`web/src/api.ts:330/:1957/:2433/:2725`、`web/src/styles.css:1501`。
- 后台：`web/src/pages/ReactionPage.tsx:762-836` 新卡「正文表情」，插在「贴表情提示词」与「表情素材模板」之间；三层 `ScopeField`、载入 / 保存 / 删除 / 行内删除、「写入推荐文案」（`:801` 用 `suggestion`），说明写着「三层都不配 = 关」。客户端契约在 `web/src/api.ts:1464-1516`。

### 66.4 测试与门槛

- 新增 `test/admin.body-emoji-guides.test.ts` 14 例：空库回 `items: []` / `default: ''` / `suggestion` 与常量逐字相等；未登录 401；三层往返；global 的 `scopeId` 被钉成空串；同层再 PUT 是覆盖写；`BAD_SCOPE`；guild/channel 缺 `scopeId` → `BAD_REQUEST`；非字符串 / trim 空 / 超 8,000 → `BAD_BODY_EMOJI_GUIDE`；正好 8,000 合法；库里存的是 trim 后的文案；删一层后回落；删不存在的行也成功。
- `test/chat.service.test.ts` 4 例：`:2135` 普通模式规则接在带描述的清单之后、未接线时整段不出现；`:2175` 三层整组覆盖（channel 有配置就只拼 channel）；`:3314` 描述体清单只列名字、顺序是【世界书】→【可用自定义表情】→【正文表情】→`<recall>`；`:3378` 规则为空时描述体与接线前逐字一致（`:3412` `expect(wired).toBe(unwired)`）。
- 同步清单：`test/admin.crud.test.ts:1071/:1112/:1127` 路由表、`test/node.migrate.test.ts:43` 迁移清单。
- 门槛全绿：`npm run typecheck` / `typecheck:web` 全 0；`npm test` 85 个文件 **1612 例**；`npm run test:node` 9 个文件 117 通过 + 1 跳过；`npm run build:web` 产物 `dist/web/assets/index-CrUFzuOL.js` 399.03 kB（gzip 115.38）、`index-DP2hj6Xq.css` 21.72 kB。
- 部署（2026-11-08 11:23Z）：`git archive` 出包 1,178,473 B → scp → `data/backup-src-20261108-112339.tar.gz` → 解包 → `sudo docker compose up -d --build`；回执 `迁移已执行：0031_body_emoji_guides.sql`、`applied=1 skipped=30`、`build=emoji-body-2`、`gateway READY as 示例机器人`、`/api/health {"ok":true,"version":"0.1.0"}`。

### 66.5 边界

- **默认关**：线上 `body_emoji_guides` 为空时，描述体与 `worldbook-ctx-1` 逐字相同（有测试逐字对比），所以这次部署对现网零影响。
- 只影响提示词与正文渲染：不改 `messages`（上下文工具模式顶层仍只有那一条固定 user 消息）、不改历史与摘要落库、不改贴表情链路。
- 清单来自服务器表情缓存（与现有 `customEmojis` 同源），斜杠命令路径仍没有表情清单，带不进去。
- 文案上限 8,000 字；清单上限 40 个名字（`MAX_EMOJI_IN_PROMPT`），超出的不再列。
- 回退镜像 `worldbook-ctx-1` 即回到「正文只有 `[[react:…]]` 这一条路」；迁移 0031 建的表留着不影响旧版（旧版不读它）。

## 67. prompt-copy-1：把一个作用域的提示词预设整层复制到另一个作用域（2026-11-08）

### 67.1 缺的是什么

- 提示词预设按作用域各存一份（channel > guild > global），后台此前只能逐层手填或逐层导入一份酒馆预设；想把「A 频道调好的那套」搬到 B 频道 / 服务器 / 全局，只能重导一次 JSON 或手抄。
- 新增 `POST /api/prompts/copy`（`src/workers/http/app.ts:849-908`）：一次调用 = 源层解析 + 目标层覆盖写。

### 67.2 决定

- **复制「此刻真正生效」的那份**：源层空就照线上同一顺序往上取（channel > guild > global > 后台可编辑的「内置默认」> `DEFAULT_PROMPT`），所以复制出来的是它正在借用的那份，而不是一份空配置。调用链与 `src/core/chat/service.ts:1199-1204` 同源：`resolveFallbackPrompt(...)` → `resolvePrompt(...)`。
- **只有 channel id 时拿不到 guild id**：用 `messages` 表反查（`guildOfChannel`，`src/workers/db/d1-repository.ts:1004`，`SELECT guild_id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1`）。查不到就跳过 guild 层继续往下，响应里的 `sourceScope` 如实说明落到哪层。端口方法是**可选**的（`src/core/ports.ts:110` 的 `guildOfChannel?`），既有假仓储不必改。
- **复制内容** = 段（深拷贝，`src/workers/http/app.ts:900`）+ `temperature` / `maxTokens`（存在才带）。
- **目标已有配置直接覆盖**：页面上先用确认框告知，接口本身不拦。
- 源与目标规范化后相同 → `400 {"error":"SAME_TARGET"}`（global 带任意 `scopeId` 也会撞上 global 的空串）。
- 三层全空也有内置默认可复制，所以这个接口没有 404。

### 67.3 代码地图

- 路由 `src/workers/http/app.ts:849`；参数解析复用 `readScopeKey`（`src/workers/http/app.ts:449`），错误码与 `/api/prompts` 同口径（`BAD_SCOPE` / `BAD_REQUEST`）。
- 响应 `{...promptDto(to, cfg), sourceScope, sourceScopeId}`；落到「内置默认」或 `DEFAULT_PROMPT` 时 `sourceScope='global'`、`sourceScopeId=''`。
- 前端：`web/src/api.ts:137-158` 类型、`:362-364` `copyPromptPreset`、`:551-575` `toPromptCopyResult`、`:1137-1148` 错误文案；页面 `web/src/pages/PromptsPage.tsx:1425-1464` 卡片「复制预设」、`:509-543` `runCopy`（`window.confirm` → 请求 → 结果行 → 复用 `loadItems()` 刷新），复制后编辑区仍停在用户原来那层。

### 67.4 测试与门槛

- `test/admin.prompts-copy.test.ts` 8 例：源频道自带配置；源频道空、`messages` 里 seed 过 `(G1, C1)` → 借 guild 那份且 `sourceScope='guild'`；频道从没出现过 → 落 global；三层全空 → 先取后台「内置默认」、清掉后取 `DEFAULT_PROMPT` 且逐字相等；目标旧配置与旧 `maxTokens` 被整体覆盖；同层复制两例 400；`BAD_SCOPE`、缺 `fromScopeId`、`toScopeId` 非字符串各 400；未登录 401。
- 路由清单登记 `test/admin.crud.test.ts:1105`。
- 门槛：`npm run typecheck` 0；`npm test` 86 文件 **1620 例**；`npm run test:node` 9 文件 117 通过 + 1 跳过；`npm run typecheck:web` 0；`npm run build:web` 产物 `dist/web/assets/index-DsAILq-y.js` 402.41 kB（gzip 116.27）、`index-DP2hj6Xq.css` 21.72 kB。
- 提交：代码 **d3626b2**「feat(prompts): copy one scope's prompt preset onto another」；文档 **024859f**「docs: describe prompt-copy-1 and how to check a copy」。
- 部署（2026-11-08 12:29Z）：`git archive` 出包 1,191,262 B → scp → 服务器源码备份 `data/backup-src-20261108-122922.tar.gz` → 解包 → `sudo docker compose up -d --build`；回执 `applied=0 skipped=31`、`build=prompt-copy-1`、`listening on :8787 build=prompt-copy-1`、`gateway READY as 示例机器人`；容器内 `/app/dist/web/assets/index-DsAILq-y.js` 含「复制预设」。
- 线上实测（容器内 node 探针）：频道 `<ID-3>`（3 段）→ 假频道 `999000000000000001` 回 `200`，`sourceScope=channel`、`sourceScopeId` 是源频道，`GET /api/prompts` 回读目标层 3 段（名字 `基本设定,基本设定,人格`）；源与目标同层 → `400 {"error":"SAME_TARGET"}`；`DELETE` 目标回 `200` 后目标层消失。源层为空的一支：不存在的频道 `999000000000000002` → `999000000000000003` 回 `200`、`sourceScope=global`、1 段——该层没配置，落到的是后台「内置默认」（按约定记成 global）。两次探针结束后 `/api/prompts` 只剩原来四个频道，线上数据未改。

### 67.5 边界

- 只复制提示词预设（段 + 采样参数）：世界书、深度注入、贴表情与正文表情文案、语音设置一个字不动。
- `guildOfChannel` 每次调用扫一遍 `messages`：`idx_messages_channel` 是 `(guild_id, channel_id, id)`，只按 `channel_id` 过滤用不上它，`EXPLAIN QUERY PLAN` 实测 `SCAN messages`。后台手动点一次的成本可接受；要优化得另开 `(channel_id)` 或 `(channel_id, id)` 的索引迁移。
- 复制写的是目标层的显式配置：此后它不随上层变化，这正是「搬过来」的语义。
- 没有新迁移，迁移总数仍是 31。

## 68. reaction-json-1：表情选择改用结构化输出（2026-11-09）

### 68.1 缺的是什么

- 表情选择一直是「问一次小模型，让它只回一行」：请求由 `buildReactionRequest()`（`src/core/chat/reaction.ts:155`）拼成 system 指路 + 一段素材，解析靠 `normalizeReactions()` 逐行读、剥引号与反引号、按 `表情|目标` 去重。模型偶尔多写一句解释或缩进成多行，全靠这套兜底吞下去。
- 中继这版起支持 `response_format`（`structuredFormatOf()`，`data/deploy-pg-relay/server.js:1318` 把它翻成 `wire[3]` 的下标 7 `response_mime_type` 与下标 8 `response_schema`），于是「只填一个字段」可以由协议约束，而不是靠提示词自觉。

### 68.2 决定

- **请求侧恒带 schema，不做开关**：`REACTION_RESPONSE_FORMAT`（`src/core/chat/reaction.ts:43`）固定 `{type:'json_schema', json_schema:{name:'reaction_choice', schema:{type:'object', properties:{reaction:{type:'string'}}, required:['reaction']}}}`，`buildReactionRequest()` 每次都给 `responseFormat`（`:188`）。这样线上只有一种请求形状，出问题只看一处。
- **解析侧 JSON 只当前缀尝试**：`jsonReactionValues()`（`src/core/chat/reaction.ts:265`）先整段 `JSON.parse`，认三种形状——`{"reaction":"…"}`、顶层字符串、对象里唯一的字符串值；认不出返回 `null`，`normalizeReactions()`（`:289`）退回原来的逐行解析。理由：Anthropic 通道不发这个键、旧提示词也只保证纯文本，兜底必须留在 JSON 之后才不丢任何旧语义。
- **JSON 也要能表达「不贴」**：`{"reaction":"NONE"}` 与文本 `NONE` 同义（`NO_REACTION` 集合照旧判），多出来的说明字段不该把答案顶成「形状不认识」。
- **类型是可选的**：`LlmResponseFormat` 与 `LlmRequest.responseFormat`（`src/core/types.ts:263`、`:305`）；`openai-compat` 适配器条件展开（`src/core/providers/openai-compat.ts:92`），缺省时请求体逐字节不变；`anthropic` 不列该字段，静默忽略、不报错。

### 68.3 代码地图

- 门牌：`GATEWAY_BUILD = 'reaction-effort-1'`（`src/workers/gateway/engine.ts:131`），`test/gateway.node.test.ts:229` 同步；上一版 `reaction-json-1` 只差 §68.6 那一处。
- 契约：`REACTION_RESPONSE_FORMAT`（`src/core/chat/reaction.ts:43`）、`jsonReactionValues()`（`:265`）、`normalizeReactions()`（`:289` 的 `for (const line of jsonReactionValues(raw) ?? raw.split('\n'))`）。
- 线缆：`src/core/providers/openai-compat.ts:92` `...(req.responseFormat === undefined ? {} : { response_format: req.responseFormat })`，位置在 `tools` / `tool_choice` 之后、`stream` 之前。
- 中继：`data/deploy-pg-relay/server.js:1297` `generationConfigOf()`（数组加长到下标 8）、`:1318` `structuredFormatOf()`、`:2467` 请求入口日志 `结构化输出 type=…`。

### 68.4 测试与门槛

- `test/chat.reaction-json.test.ts` 6 例：JSON 取出表情且 @目标照旧切分；顶层字符串与对象里唯一字符串值也认；缩进成多行的 JSON 整段解析、不按换行切碎；JSON 里的 NONE 与文本 NONE 同义；形态错乱回落到旧文本解析；`LlmRequest` 带 `json_schema`（name 固定、`reaction` 必填）。
- `test/providers.openai.test.ts:726` 起 3 例：`responseFormat` 原样进 body 且排在 `stream` 之前、旧字段顺序不动；`json_object` 同样透传；不给该字段时键不出现（含流式走同一个 `bodyOf`）。
- `test/providers.anthropic.test.ts:433`：不发 `response_format`、不报错。
- 门槛：`npm run typecheck` 0；`npm test` **87 文件 1631 例**（§68.6 那条 +1）。
- 中继侧实测（pg-relay 容器内 `data/_probe_json1.mjs` / `_probe_json2.mjs`）：`json_object` 200 / 6.2s / `{"emoji":":laugh:"}`；`json_schema` 200 / 4.4s / 同形状；**与函数工具同发** 200 且照旧回 `tool_calls`（两者不冲突，工具优先）。

### 68.5 边界

- 只在 `openai-compat` 通道发这个键。如果把表情模型换成不认识 `response_format` 的供应商，最坏是那一路 400 —— `askReactionModel()` 只 warn 从不抛错（`src/core/chat/service.ts:1044`），结果是这轮不贴表情，正文不受影响。
- `json_schema.strict` 在上游没有对应槽，传了也不生效；schema 这里只用「一个必填字符串」，没引入 `additionalProperties` 之类没验过的关键字。
- 结构化输出不改变「贴不贴」的决策语义，也不改贴表情链路与正文表情文案（那两条各归 `§28` 与 `§66`）。
- 没有新迁移，迁移总数仍是 31；中继那份改动只影响 `response_format` 这一条通道，不带该字段的请求逐字不变。

### 68.6 这条支线也钉最低思考档

- 改了什么：`buildReactionRequest` 的 `LlmRequest` 多一个 `reasoningEffort: REACTION_REASONING_EFFORT`（`src/core/chat/reaction.ts:43` 起的常量 = `'low'`，赋值在 `:190` 附近）。挑一个表情不需要推导，线上实测那一路 7.0s 里大半是默认档位的思考时间。
- 为什么钉在这里而不是后台可配：`reasoning_effort` 已经是这条链路的固定契约（主链在 `src/core/chat/service.ts:1429` 也写死 `low`），再多一个后台开关只会多一种「配错就慢」的分支。
- 生效路径：`src/core/providers/openai-compat.ts:78` 把 `reasoningEffort` 发成 `reasoning_effort` → 中继 `thinkingConfigOf()`（`data/deploy-pg-relay/server.js:1323`）翻成 `wire[3][16] = [null,null,null,1]`，日志 `思考档位 effort=low level=1 …`。Anthropic 通道不列这个键，静默忽略。
- 测试：`test/chat.reaction-json.test.ts:76` 起一例断言 `req.reasoningEffort` 就是那个常量且等于 `'low'`。
- 已知不变：它只影响「多快想完」，不影响贴不贴、贴几个、结构化输出；关掉（把常量删掉）就退回默认档位，别的都不动。

## 69. draw-image-2：模型自己画图，并把图作为附件发出去（2026-11-09）

### 69.1 缺的是什么

- 中继早就有生图端点（`POST /v1/images/generations`，见 `docs/hosting.md` §15.5），但 bot 侧没有入口：模型只能写字，要图就得人去别处画。
- 想要的形态不是斜杠命令，而是预设里一句「想画就调 `draw_image`」：模型自己判断该画，画出来那一轮只发图、不配台词，历史里留一个占位让下一轮知道自己画过。

### 69.2 决定

- **工具门控照抄 `story_reply`**：`drawToolsFor(preset)`（`src/core/chat/image-tool.ts:43`）只在 `preset.indexOf('draw_image') !== -1` 时返回工具；预设没写的频道，请求体里连这条工具都不存在，形状与加这层之前逐字相同。
- **只在上下文工具模式装配**：`src/core/chat/service.ts:1288` `const drawTools = contextToolMode ? drawToolsFor(promptParts.before + '\n' + promptParts.after) : [];`，同时进普通 `tools`（`:1289`）与 `contextToolFields`（`:1346-1347` 的 `tools: [...buildContextTools(contextBody), ...drawTools]`、`toolChoice: 'auto'`）。
- **命中就把正文换成台词**：`:1475` `drawPrompt = drawPromptOf(first.calls);`，非 `null` 时再取 `drawLineOf(first.calls)`（`say`，`src/core/chat/image-tool.ts:76`）；取了就用它当正文，没取到才保留模型自己写的正文（`draw-image-3` 之前是直接 `raw = ''`、只发图）。同时让 §59 的「空回补交付」不再问一次（`:1480` 的条件带 `drawPrompt === null`）——工具已经交付了这一轮，再问一次只会多花一次调用。
- **生图用当前这把 Key 的 baseUrl**：`requestImage()`（`src/core/chat/image-tool.ts:86`）→ `POST {baseUrl}/images/generations`，body 固定 `{model:'gemini-3.1-flash-image', prompt, n:1, response_format:'b64_json'}`，超时 `AbortSignal.timeout(IMAGE_TIMEOUT_MS=180_000)`（`:21`）。认 `data[0].b64_json`，也认 `data[0].url` 的 `data:` 形式；三种失败各有错误码：`IMAGE_HTTP`（`:107`，带状态与 200 字原文）、`IMAGE_BAD_JSON`（`:112`）、`IMAGE_MISSING`（`:121`，上游 2xx 但没图）。
- **发图与文字分两步**：`src/workers/gateway/engine.ts:744` 取 `result.image`；`:747` 只发图那轮正文留空串，不再补「（模型没有返回内容）」；`:759` `imageOnly = image !== undefined && text.trim() === ''`；`:761-769` 调 `channel.sendFile` 发附件，文件名按 mime 取 `image.png` / `image.webp` / `image.jpg`（Discord 靠后缀预览）；`:776` 只有「图没发出去且没正文」才补一句「（图片没发出去）」；`:778` `if (!imageOnly || !imageSent)` 才建那条文字消息。
- **空回判据放行图片**：`:1546` `if (raw.trim() === '' && imageResult === undefined)` 才算空回；生成失败不吞（`:1541` `图片生成失败 key=…`），宁可这轮按空回重试，也不放一张空白图出去。

### 69.3 代码地图

- 新文件 `src/core/chat/image-tool.ts`：`DRAW_TOOL_NAME='draw_image'`（`:9`）、`IMAGE_MODEL_NAME='gemini-3.1-flash-image'`（`:15`）、`IMAGE_PROMPT_MAX_CHARS=8000`（`:18`）、`drawTool()`（`:25`，必填 `prompt` 与 `say`）、`drawToolsFor()`（`:43`）、`drawPromptOf()`（`:48`，没调/参数坏/空串都返回 `null`，超长截断）、`drawLineOf()`（`:76`，同上，台词上限 `DRAW_LINE_MAX_CHARS=600`）、`requestImage()`（`:86`）。
- 服务层 `src/core/chat/service.ts`：`:1471-1476` 分流、`:1521-1542` 调 `requestImage` 并打 `图片回复 model=… key=… prompt=<字数> bytes=… ms=…` 或 `图片生成失败`、`:1546` 空回、`:1634` `result.image`、`:1650` 落库 `[图片]`、`:1670` 成功日志尾部的 `image=1`、`:1681` 没有正文就不问表情模型。
- 发送侧：`src/workers/gateway/engine.ts:734` `TurnResult.image`、`:757-777` 附件发送、`:772` `发送图片失败：`；`src/workers/gateway/channel-rest.ts:32` 的 `sendFile?(channelId, bytes, file?)` 与 `:80` 的实现；`src/workers/discord/rest.ts:120` `ChannelFileShape`、`:131` `sendChannelFile(…, shape?)`。
- 门牌：`GATEWAY_BUILD = 'draw-image-2'`（`src/workers/gateway/engine.ts:131`，`test/gateway.node.test.ts:229` 同步）。
- 线上预设：主频道 `123456789012345678` 的 48 段里位置 37 是「画图」段，正文逐字「用户让你画画、要一张图、说「画个…」时，调用 draw_image 把画面写清楚（主体、动作、场景、风格）；图会直接发出去，这一轮不用再写正文。」——没这段的频道请求体逐字不变。

### 69.4 测试与门槛

- `test/chat.image-tool.test.ts` 7 例：预设没写 `draw_image` 不返回工具；写了只返回一条且参数只有 `prompt`；`drawPromptOf` 取参数、坏 JSON/空串/没调返回 `null`、超长截断；`requestImage` 认 `b64_json`、认 `data:` URL、非 2xx 抛 `IMAGE_HTTP`、缺字段抛 `IMAGE_MISSING`。
- `test/chat.service.test.ts` 末尾「画图工具（draw_image）」2 例：上下文工具模式命中后正文为空、`result.image` 有字节、落库是 `[图片]`；普通模式不装配这条工具。
- 门槛：`npm run typecheck` 0；`npm test` **88 文件 1640 例全过**；`npm run test:node` **118 通过 +1 跳过**（9 文件）。
- 线上（2026-11-08T19:25Z）：`图片回复 model=gemini-3.1-flash-image key=pgl prompt=233 bytes=778925 ms=9949`，紧跟 `回复成功 … len=0 image=1 ms=22773 key=pgl mode=context`；Discord 附件 `image.jpg` 778,925 B、1408×768、`image/jpeg`，正文为空；`messages` 落 `[图片]`。

### 69.5 第一次真机暴露的事：并发 batch 把整轮拖成了失败

- 现象：19:12Z 那轮四张图都生成成功（四次 `图片回复`），整轮却是 `ALL_PROVIDERS_FAILED`；`messages` 一行没落；容器反复打 `[log] 写日志失败：cannot start a transaction within a transaction`。
- 真因：`src/node/db/sqlite.ts` 的 `batch()` 在同一条连接上直接 `db.exec('BEGIN')`；回复落库（`conversations.append` → `db.batch`）与 `runtime_logs` 写入（`createLogStore().append` → `db.batch`）是两个独立异步批，交错时后一个 BEGIN 撞上前一个未提交的事务，`append` 抛错 → 本轮判失败 → 换下一把 Key 重问 → 图作废再画一张。
- 改法：`batch()` 串成一条 promise 链——`const next = batchChain.then(run, run); batchChain = next.catch(() => undefined); return next;`。一次只开一个事务，前一批失败不阻塞后一批，错误仍回到各自调用方。
- 回归测试 `test/node.sqlite.test.ts`：两个 `db.batch` 并发（`Promise.all`）后两行都在；再让前一批故意失败（`NOT NULL`），`Promise.allSettled` 里前者 rejected、后者 fulfilled、表里三行齐全。
- 教训：日志里那句 `cannot start a transaction within a transaction` 是「两个写入批撞车」的指纹，不是日志系统自己的毛病；看到它先查谁绕开了 `batch()` 的排队顺序。

### 69.6 边界

- 只在上下文工具模式发这个工具；普通模式的工具调用不解析，预设里写 `draw_image` 也不会画。
- 生图模型名写死在 `IMAGE_MODEL_NAME`；换供应商要么改常量，要么在那一侧做模型别名（中继默认就是 `gemini-3.1-flash-image`）。
- 失败按空回重试：`MAX_ATTEMPTS` 之内每次都会真的再生成一张图（时间与额度都花掉）；它只保证「不发空白图」，不保证这轮一定有图。
- `n` 固定 1；Discord 附件上限 10 MB，线上实测 0.7–0.8 MB；prompt 超过 8000 字截断后续画，不判整轮失败。
- 图片不参与下一轮的多模态理解：历史里只有 `[图片]` 占位，模型记得自己画过，但看不到那张图。
- 没有新迁移，迁移总数仍是 31。
### 69.7 图先出、正文由主模型再写一次（draw-image-4，2026-11-09）

- 上一版把台词塞进 `draw_image` 的参数（`say`），等于从工具参数里抠一行当正文。线上要的是「4a 生成正文」——和普通回合走同一条生成路径，而不是让工具参数兼职正文。
- 做法：`draw_image` 参数回到只有 `prompt`。图生成成功、这一轮又没有正文时，再发一次请求（`src/core/chat/service.ts:1545` 起）：`system: contextReplySystem`（整份上下文搬进 system）、`messages` 末尾追加一句「（刚刚按这个画面画了一张图，已经发给用户了：<prompt>）请照设定写这一轮的正文，可以自然提到这张图，但不要描述画图过程，也不要说自己调用了工具。」、工具只留 `replyOnlyTools()`（`story_reply`）、`reasoningEffort: 'low'`——和 §59 的「补交付」是同一套形状。
- 同一次响应里模型已经交了 `story_reply`（或写了正文）时 `raw` 非空，直接用它，不再多问一次；只有「只调了 draw_image」才付这次额外调用。
- 代价与边界：画图那一轮多一次模型调用（实测 5–15 秒）；第二段仍可能交白卷，那就退化成只发图（`raw=''` 但 `imageResult` 有值，空回判据放行），历史存 `[图片]`。
- 发送顺序不变：先 `sendFile` 发图，再走 `chunkMessage` / `stream.finish` 发正文（`src/workers/gateway/engine.ts:761-778`）；正文照常吃 `resolveInlineEmojis`、@ 提及与 1900 字切段。
- 线上预设同步：主频道 `123456789012345678` 第 37 段正文改成「…调用 draw_image 把画面写清楚（主体、动作、场景、风格）；图会先发出去，然后你再照设定写这一轮的正文。」——只动这一段。
- 工具说明：`drawTool().function.description` 改成「画一张图并直接发到频道……图画好之后会再让你写这一轮的正文。」，与第二段请求对上。
- 测试：`test/chat.service.test.ts` 新增「图画好之后正文由主模型再写一次」一例（第一段只调 draw_image、第二段交 story_reply；断言两段请求、第二段只带 `story_reply`、末尾消息带「已经发给用户了」、历史存正文）；「反复只调 draw_image」那一例仍覆盖纯图兜底。`test/chat.image-tool.test.ts` 的 `required` 断言回到 `['prompt']`。
- 门牌：`GATEWAY_BUILD = 'draw-image-4'`（`src/workers/gateway/engine.ts:132`，`test/gateway.node.test.ts:229` 同步）。

## 70. 超时全部搬进后台，外加第三种 TTS 方言（timeout-config-1，2026-11-09）

### 70.1 缺的是什么

到 `draw-image-4` 为止，时间预算全写死在代码里：LLM 180 秒（`src/core/providers/rt.ts`）、生图 180 秒（`src/core/chat/image-tool.ts`）、TTS 30 秒（`src/core/voice/tts.ts`）、语气评审 15 秒起步 + 每字 40 毫秒、封顶 45 秒（`src/core/voice/style.ts`）、拉中继报错 5 秒（`src/core/pg-errors.ts`）、优雅退出 25 秒（`src/node/main.ts`）。接 Gemini TTS 时这条更明显：204 字中文要 10.9 秒才回、音频本身 43.8 秒，30 秒的旧上限会把正常请求掐死，而「到底给多少」取决于模型、频道与机器，写死在代码里只能每次改代码重发镜像。

### 70.2 决定

- **后台是主入口，`.env` 只是兜底**：每一项都可以在后台改；库里没存过这一项时，用环境变量，再用内置默认。
- **逐项 + 一个全局倍率**：九个毫秒值各自可改，另有一个 0.1–10 的倍率一次放大缩小（单项最终还会被夹在自己的上下限里）。
- **保存即生效**：调用点一律现取（`resolveTimeout(key)`），保存后下一条请求就用新值，不必重启。

### 70.3 数据与代码地图

- 迁移 `migrations/0033_timeout_settings.sql`：一张平表 `timeout_settings(name TEXT PRIMARY KEY, value REAL NOT NULL, updated_at TEXT NOT NULL)`。只建表、只做加法。
- `src/core/timeouts.ts`：`TIMEOUT_KEYS` 九项 `llm / image / tts / ttsGemini / judgeFloor / judgePerChar / judgeCap / pgErrors / shutdown`；`TIMEOUT_FIELDS` 带 env 名、中文说明、默认值与上下限；`MULTIPLIER_ENV = 'TIMEOUT_MULTIPLIER'`、`MULTIPLIER_MIN = 0.1`、`MULTIPLIER_MAX = 10`。导出 `timeoutDefaults()`（env + 内置默认）、`timeoutSettings()`（当前基线）、`applyTimeoutOverrides()`、`resetTimeouts()`、`resolveTimeout(key)`（基线 × 倍率，再夹进上下限）、`judgeTimeoutMs(chars)`（起步 + 每字 × 字数，封顶）。env 用 `globalThis.process?.env` 读，workerd 下不会炸。
- 接线（全部改成现取）：`src/core/providers/rt.ts` 的 `createRequestSignal()` → `resolveTimeout('llm')`；`src/core/chat/image-tool.ts` → `resolveTimeout('image')`；`src/core/voice/tts.ts` 三处 → `resolveTimeout('tts')` 与 `resolveTimeout('ttsGemini')`；`src/core/voice/style.ts` 的 `judgeTimeoutMs` 改成从 core 导入；`src/core/pg-errors.ts` → `resolveTimeout('pgErrors')`；`src/node/main.ts` 退出预算 → `resolveTimeout('shutdown')`。
- 装配：`src/node/main.ts` 启动时 `await handlers.loadTimeoutSettings()`（读库 → `applyTimeoutOverrides`，失败只 warn）；`src/workers/index.ts` 每个请求前 `loadTimeoutSettings(data)`，多 isolate 下最多晚一条请求。
- 仓储：`src/core/ports.ts` 新增 `TimeoutSettingsStore { get(); put(); clear(); }`；`src/workers/db/d1-repository.ts` 的 `timeoutSettings` 用 `db.batch` 先 DELETE 再逐条 INSERT，`clear()` 只 DELETE。
- HTTP：`GET /api/timeouts` 回 `{ fields: [{ key, env, label, detail, defaultMs, minMs, maxMs, valueMs, effectiveMs, overridden }], multiplier }`，并顺手把库里的值重新装进进程；`PUT` 要求九项 + multiplier 整份给（少一项、非数字、越界都是 `400 BAD_TIMEOUT_SETTINGS`），只落库「和基线不同」的项（改回默认就删行，`.env` 变了还能重新露出来）；`DELETE` 清表 + `resetTimeouts()`。
- 前端：`web/src/pages/TimeoutsPage.tsx`（输入框存字符串，避免输入中途被 `Number()` 吃掉光标）+ `web/src/App.tsx` 的「超时」tab；`web/src/api.ts` 新增 `fetchTimeouts / saveTimeouts / resetTimeouts / describeTimeoutRejection` 与三个视图类型。

### 70.4 第三种 TTS 方言（同一版一起上线）

- `TtsDialect` 变成 `'openai' | 'mimo' | 'gemini'`；`DEFAULT_MODEL` 里 gemini 是 `gemini-3.8-flash-tts`；`createGeminiTts` 打 `POST {url}/audio/speech`，body `{ model, input, response_format: 'wav', voice? }`。
- 产物是 24kHz 单声道 WAV，所以 `TtsPort` 多了一条可选 `file: { name, contentType }`（`voice.wav` / `audio/wav` vs `voice.mp3` / `audio/mpeg`），`src/workers/gateway/engine.ts:830` 发附件时把 `tts.file` 传给 `sendFile`，后台试听的 `contentType` 也跟着端口走。
- 迁移 `migrations/0032_tts_gemini_dialect.sql`：SQLite 改不了 CHECK，只能重建表（12 列原样搬过去，`CHECK (dialect IN ('openai','mimo','gemini'))`）。
- 中继侧见 `docs/hosting.md` §15.5「语音合成：POST /v1/audio/speech 出 24kHz WAV」：音色在 `generation_config[15]`，上游回 `audio/l16` 分片，中继拼 PCM 再套 WAV 头；中继的超时也全部改成 `.env` 读（`TTS_TIMEOUT_MS` / `URL_READ_TIMEOUT_MS` / `KEEPALIVE_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS`），临时诊断口 `POST /v1/_probe` 已删。

### 70.5 测试与门槛

- `test/timeouts.test.ts` 7 例：默认值、env 覆盖与夹紧、后台覆盖 + 倍率、倍率与单项夹紧、保存即生效与 reset、`judgeTimeoutMs` 公式、倍率作用于评审三档。
- `test/admin.timeouts.test.ts` 7 例：空库形状、未登录 401、只落库与基线不同的项（`llm=240000` + 倍率 2 → 生效 480000，`pgErrors` 5000 → 10000）、越界 400、少项/非数字/空体 400、改回基线删行、DELETE 清空并回默认。
- `test/tts.gemini.test.ts` 10 例：方言解析、默认模型、请求形状、无 voice 不发 voice、超时 120 秒、文件形状、非 2xx 与请求失败的归一。
- `test/node.migrate.test.ts`：迁移清单加到 33 个，并新增「0032 重建表后老行十二列原样保留」一例。
- 门槛：`typecheck` 0、`typecheck:web` 0、`npm test` 91 文件 1666 例全过、`test:node` 119 passed + 1 skipped。
- 门牌：`GATEWAY_BUILD = 'timeout-config-1'`（`src/workers/gateway/engine.ts:132`，`test/gateway.node.test.ts:229` 同步）。

### 70.6 边界

- 只覆盖「一次请求等多久」这一层；重试次数（LLM 两次尝试）、退避间隔、并发上限不在这一页。
- 中继是独立进程，它的超时只认 `.env`（改完要 `docker compose up -d --build`），后台改不到。
- `.env` 优先级低于后台：库里存过的项永远盖住 env，想回到 env 就在页面上「恢复默认」。
- workerd 多 isolate 下，后台保存只对当前 isolate 立即生效，其它 isolate 在下一次请求前重读（最多晚一条请求）。

## 71. 上下文工具模式下补上【语音】段（voice-hint-context-1，2026-11-09）

### 71.1 缺的是什么

「按指令」模式（`voice_settings.mode = 1`）靠模型在正文里写一行 `[[voice]]` 触发，提示段由 `renderVoiceHint()` 输出（`src/core/chat/service.ts:530`）。但它只拼进 `legacySystem`；而 §55 上下文工具模式把整个 system 换成了 `CONTEXT_TOOL_SYSTEM` 一句固定文案（`src/core/chat/service.ts:1285`），上面那一整串段落——表情规则、【语音】、正文表情、世界书、预设尾巴——一个都不在里面。

线上正跑在 `mode=context`。2026-11-09 12:07Z 把开关从 0 改成 1、音色改 Kore 之后，那一轮（`runtime_logs` 1440）正文 660 字、没有 `[[voice]]`、没有语音附件，中继也没有合成日志：模型根本没被告知有这种写法。

### 71.2 决定

- 把 `renderVoiceHint(ctx.voiceHint)` 先算成局部变量 `voiceHint`，两套 system 共用：
  `const system = contextToolMode ? CONTEXT_TOOL_SYSTEM + voiceHint : legacySystem;`
- 没有语音提示时 `voiceHint` 是空串，上下文 system 与改动前逐字相同（既有请求形状与日志不变）。
- `[[voice]]` 的解析本来就在正文那条路上：上下文模式下正文来自 `story_reply` 的 `game_content`，`stripVoiceDirective()` 照样在 `src/core/chat/service.ts:1651` 跑，所以只需要把提示送到模型，不需要另开分支。

### 71.3 测试与门槛

- `test/chat.voice-hint.test.ts` 新增两例：上下文模式 + `voiceHint: true` → `system === CONTEXT_TOOL_SYSTEM + VOICE_HINT`；上下文模式不带提示 → `system === CONTEXT_TOOL_SYSTEM`（逐字）。共 8 例。
- 门槛：`typecheck` 0、`npm test` 91 文件 1668 例全过、`test:node` 119 passed + 1 skipped。
- 门牌：`GATEWAY_BUILD = 'voice-hint-context-1'`（`src/workers/gateway/engine.ts:132`，`test/gateway.node.test.ts:229` 同步）。

### 71.4 边界

- 只影响「按指令」：`mode = 2`（每条都念）不依赖提示，`mode = 0` 仍然整条跳过。
- `[[voice]]` 必须单独成行写在正文里；写在 `think_nya` 或 `extra` 参数里不会被念，模型模仿历史行写假时刻的处理也不变。
- 上下文 system 只有这一句 + 语音段；其它段落（表情、世界书、预设）在上下文模式下依旧不出现，这是 §55 的设计，不是本版遗漏。
