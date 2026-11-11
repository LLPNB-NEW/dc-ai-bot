/**
 * M6 装配层：把 M1-M5 的模块拼成一个可运行的 Worker。
 *
 * 三条分支（见 docs/architecture.md §5/§11/§12）：
 *   - /interactions 与 /discord/interactions -> M3 交互处理器（自行验签、type=5 + waitUntil）
 *   - /api/**                                 -> M4 管理台（Cookie 鉴权、健康检查免鉴权）
 *   - 其余                                    -> ASSETS（web 管理台静态资源，SPA 回退）
 *
 * 缺 secret 时不在模块顶层抛错：各分支先自检所需 secret，缺哪个就回 500
 * {error:'MISSING_SECRET', name}，这样 /api/health 之类的诊断端点仍可达。
 */
import { DEFAULT_SUMMARY_EVERY_MESSAGES, createChatService } from '../core/chat/service';
import { DEFAULT_HISTORY_MAX_MESSAGES } from '../core/memory/window';
import { applyTimeoutOverrides } from '../core/timeouts';
import { createProviders } from '../core/providers/index';
import { createStoredTts } from '../core/voice/tts';
import type { SqlDatabase } from '../core/db/sql';
import { createRelayErrorSource, createUnconfiguredErrorSource, type PgErrorsSource } from '../core/pg-errors';
import type { LlmProvider, LogEntry, ProviderId } from '../core/types';
import { createSecretBox } from './crypto/secretbox';
import { createRepositories } from './db/d1-repository';
import { createLogStore } from './db/log-store';
import { createInteractionHandler } from './discord/handler';
import { listGuildEmojis } from './discord/rest';
import { pruneDiscordMessage, type PruneTarget } from './discord/prune';
import { describeGuildEmojis } from './emoji/describe';
import { createAdminApp } from './http/app';
import type { KeyProber } from './http/ports';
import {
  GATEWAY_DO_NAME,
  GATEWAY_ENSURE_PATH,
  GATEWAY_INTERNAL_ORIGIN,
  GatewayPresence,
} from './gateway/durable-object';

/**
 * Durable Object 的 class_name 必须在入口模块的 export map 里找到同名绑定，
 * 而 workerd 只接受函数/类作为具名导出，所以这里只导出 class 本身。
 * gateway/durable-object.ts 里的常量（GATEWAY_DO_NAME 等）一律不 export，
 * 否则 wrangler deploy 会报 "Incorrect type for map entry"。
 */
export { GatewayPresence };

/**
 * 与 package.json 的 version 保持一致；tsconfig 未开 resolveJsonModule，故为常量。
 * 不 export：workerd 要求入口模块的每个具名导出都是函数或 ExportedHandler，多一个字符串常量会直接起不来。
 */
const APP_VERSION = '0.1.0';

const BOT_NAME = 'DC AI BOT';

/** 缺 secret 的判定名单：只有真正用到的分支才会被要求 */
const API_SECRETS = ['KEY_ENCRYPTION_SECRET', 'ADMIN_PASSWORD', 'SESSION_SECRET'] as const;
const DISCORD_SECRETS = ['KEY_ENCRYPTION_SECRET', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID'] as const;

type SecretName = (typeof API_SECRETS)[number] | (typeof DISCORD_SECRETS)[number];

const INTERACTION_PATHS: readonly string[] = ['/interactions', '/discord/interactions'];

/**
 * 契约 §9/§6：进度文本每块必推（间隔由编辑器一侧串行化）；只注入最近 50 条原文；每 50 条未总结消息后台大总结一次。
 * 注入侧只按条数裁剪，没有字符安全阀（更早的内容由累积记忆兜底）。
 * §26：50/50 从此只是「该频道没有单独配置」时的兜底，频道配了就以 D1 那一行为准。
 */
const CHAT_CONFIG = { historyMaxMessages: 50, summaryEveryMessages: 50 };

export interface Env {
  /** §30：Workers 侧直接绑 D1（结构上就是 SqlDatabase），自托管 Node 侧换 createSqliteDatabase 的同形状实现 */
  DB: SqlDatabase;
  ASSETS: Fetcher;
  /**
   * 常驻 Gateway 连接（只负责让 bot 显示在线）。可选：没有这条绑定时 cron 分支直接空转，
   * 其余 HTTP 分支行为完全不变。
   */
  GATEWAY_PRESENCE?: DurableObjectNamespace;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  KEY_ENCRYPTION_SECRET?: string;
  /** §46：PG 中继根地址（例 http://pg-relay:8787）；与 TOKEN 任一缺失 = 没配中继 */
  PG_ERRORS_URL?: string;
  /** §46：中继的 Bearer key，只在服务端进请求头，浏览器永远拿不到 */
  PG_ERRORS_TOKEN?: string;
  /**
   * 老的语音合成环境变量：后台配置才是唯一来源，这两个变量已经不再参与取值。
   * 仍然留着只是为了在后台提示「服务器上还挂着可以删」，删掉它们不影响任何行为。
   */
  VOICE_TTS_URL?: string;
  VOICE_TTS_KEY?: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function missingSecretResponse(name: SecretName): Response {
  return jsonResponse({ error: 'MISSING_SECRET', name }, 500);
}

/** 返回第一个缺失的 secret 名；全都在则返回 null */
function firstMissingSecret(env: Env, names: readonly SecretName[]): SecretName | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') return name;
  }
  return null;
}

/** 取值；调用点已用 firstMissingSecret 校验过存在性 */
function readSecret(env: Env, name: SecretName): string {
  const value = env[name];
  return typeof value === 'string' ? value : '';
}

/**
 * 每次调用才读 globalThis.fetch：e2e 用替换全局 fetch 的方式拦截出网，
 * 若在模块顶层捕获函数引用就拦不到。
 */
function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/**
 * §46：PG 中继报错列表是可选端口 —— 两个环境变量缺一个就当没配，
 * 只让 /api/pg-errors 回 501；绝不要把它们加进 API_SECRETS（那会整站 500）。
 */
/**
 * 服务器上是否还留着老的语音合成环境变量：只用于后台提示，不参与任何取值。
 * 语音合成只从 tts_settings 那张单行表读，绝不出现在 firstMissingSecret 的名单里。
 */
function legacyTtsEnvPresent(env: Env): boolean {
  const url = typeof env.VOICE_TTS_URL === 'string' ? env.VOICE_TTS_URL.trim() : '';
  const key = typeof env.VOICE_TTS_KEY === 'string' ? env.VOICE_TTS_KEY.trim() : '';
  return url !== '' || key !== '';
}

function createPgErrorsSource(env: Env): PgErrorsSource {
  const url = typeof env.PG_ERRORS_URL === 'string' ? env.PG_ERRORS_URL.trim() : '';
  const token = typeof env.PG_ERRORS_TOKEN === 'string' ? env.PG_ERRORS_TOKEN.trim() : '';
  if (url === '' || token === '') return createUnconfiguredErrorSource();
  return createRelayErrorSource({ url, token, fetch: runtimeFetch });
}

/**
 * providers 无密钥、无请求态，可以跨请求复用（isolate 内一份）；
 * 带密钥的 secretBox / repositories / chat 一律按请求构造，避免多租户串号。
 */
let providersCache: Record<ProviderId, LlmProvider> | null = null;

function providers(): Record<ProviderId, LlmProvider> {
  const cached = providersCache;
  if (cached !== null) return cached;
  const created = createProviders();
  providersCache = created;
  return created;
}

/** §16.4：连通性测试走注入窄接口，M4 不 import src/core/providers/** */
const keyProber: KeyProber = async (input) => {
  const provider = providers()[input.provider];
  if (!provider) throw new Error('UNKNOWN_PROVIDER: ' + String(input.provider));
  return provider.listModels({ apiKey: input.apiKey, baseUrl: input.baseUrl, fetch: runtimeFetch });
};

/** secretBox -> repositories（一次请求内共享同一份） */
function createDataLayer(env: Env) {
  const secretBox = createSecretBox(readSecret(env, 'KEY_ENCRYPTION_SECRET'));
  return createRepositories(env.DB, secretBox);
}

/**
 * 超时覆盖值存在 D1 里，而 resolveTimeout 读的是进程内状态：
 * 每个 isolate 在处理请求前顺手把它读回来，后台保存之后最多晚一条请求生效，不会用到永久过期的值。
 * 读失败只 warn：超时配置读不到不该让消息回不出去。
 */
async function loadTimeoutSettings(data: ReturnType<typeof createDataLayer>): Promise<void> {
  try {
    applyTimeoutOverrides(await data.timeoutSettings.get());
  } catch (error) {
    console.warn('[timeouts] 读超时配置失败，先用默认值：' + describeError(error));
  }
}

async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const missing = firstMissingSecret(env, DISCORD_SECRETS);
  if (missing !== null) return missingSecretResponse(missing);

  const data = createDataLayer(env);
  await loadTimeoutSettings(data);
  // §19.9：入口与网关共用同一份 D1 环形表；写日志搭 waitUntil 的便车，失败只 warn（§19.1）
  const logStore = createLogStore(env.DB);
  const sink = (entry: LogEntry): void => {
    ctx.waitUntil(
      logStore.append([entry]).catch((error: unknown) => {
        console.warn('[log] 写日志失败：' + describeError(error));
      }),
    );
  };
  // summaries 随 createRepositories 的返回值一起被 ...data 带进来（§17.2）
  const chat = createChatService({
    ...data,
    // 世界书的粘性/冷却记账与书同库：显式写出来，读代码时不用再追 createRepositories 的返回类型
    worldBookState: data.worldBookState,
    providers: providers(),
    config: CHAT_CONFIG,
    // 自动摘要走 waitUntil：回帖已经 PATCH 完了，摘要不占回复时延
    background: (task: Promise<unknown>) => ctx.waitUntil(task),
    log: sink,
  });
  const handler = createInteractionHandler({
    publicKeyHex: readSecret(env, 'DISCORD_PUBLIC_KEY'),
    applicationId: readSecret(env, 'DISCORD_APPLICATION_ID'),
    botToken: env.DISCORD_BOT_TOKEN ?? '',
    botName: BOT_NAME,
    chat,
    routes: data.routes,
    prompts: data.prompts,
    // §38：渐进取片次数（global / guild / channel 三层），斜杠命令路径也按频道解析
    replySettings: data.replySettings,
    // §voice：语音开关同样三层；TTS 配置每次合成现读后台那一行
    voiceSettings: data.voiceSettings,
    tts: createStoredTts(data.ttsSettings, runtimeFetch),
    // §voice：斜杠命令发语音前要现读 judge 三字段，以及三层语气提示词
    ttsSettings: data.ttsSettings,
    ttsStyles: data.ttsStyles,
    fetch: runtimeFetch,
  });
  return handler(request, { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) });
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, pathname: string): Promise<Response> {
  const missing = firstMissingSecret(env, API_SECRETS);
  if (missing !== null) {
    // 缺 secret 时正是最需要健康检查的时候，这一条走本地兜底
    if (pathname === '/api/health') return jsonResponse({ ok: true, version: APP_VERSION }, 200);
    return missingSecretResponse(missing);
  }

  const data = createDataLayer(env);
  await loadTimeoutSettings(data);
  // §63：后台摘要入口也要写日志（与网关共用同一份环形表），写失败只 warn（§19.1）
  const logStore = createLogStore(env.DB);
  const sink = (entry: LogEntry): void => {
    ctx.waitUntil(
      logStore.append([entry]).catch((error: unknown) => {
        console.warn('[log] 写日志失败：' + describeError(error));
      }),
    );
  };
  const app = createAdminApp({
    prompts: data.prompts,
    // §ST：酒馆预设导入的原始 JSON 存档（单行），后续阶段读世界书与正则用
    presetImports: data.presetImports,
    routes: data.routes,
    keys: data.keys,
    conversations: data.conversations,
    // §21.5：表情模型同样来自 createRepositories（单行配置）
    reactionModels: data.reactionModels,
    // §28.10：贴表情提示词的三层配置表（global / guild / channel）
    reactionGuides: data.reactionGuides,
    // 正文表情提示词的三层配置表（global / guild / channel）
    bodyEmojiGuides: data.bodyEmojiGuides,
    // §34.5：表情模型素材模板的三层配置表（global / guild / channel）
    reactionTemplates: data.reactionTemplates,
    // §43：两份可编辑兜底文案（内置默认提示词 / 当前对话身份块），没有行就用代码默认
    promptDefaults: data.promptDefaults,
    // §38：假流式切片次数的三层配置表（0 = 关闭，0–10）
    replySettings: data.replySettings,
    // §41：主模型识图的三层开关表（global / guild / channel，缺省开）
    visionSettings: data.visionSettings,
    // 生图自定义：三层各一行，空字段逐项继承；Key 只存密文与掩码
    imageSettings: data.imageSettings,
    // §voice：语音回复的三层配置表（0 关 / 1 按指令 / 2 总是）
    voiceSettings: data.voiceSettings,
    // 超时配置的后台覆盖值：每次请求前重读一次，后台保存后本 isolate 立刻跟上
    timeoutSettings: data.timeoutSettings,
    // 语音合成接口：唯一来源是后台那一行；envPresent 只用于提示老环境变量可以删
    ttsSettings: data.ttsSettings,
    // §voice：三层语气提示词（channel > guild > global），后台可编辑
    ttsStyles: data.ttsStyles,
    // 深度注入：三层各一行，聊天装配按 channel > guild > global 取第一个非空
    promptInjections: data.promptInjections,
    // 世界书：每层可存多本，聊天装配按 channel > guild > global 取第一个有启用条目的层
    worldBooks: data.worldBooks,
    ttsEnvPresent: legacyTtsEnvPresent(env),
    // §23.1/§23.6：认图读写的落库表，以及那棵「后台认图」按钮背后的执行器
    emojiDescriptions: data.emojiDescriptions,
    // §24.6/§24.7：管理员手工配的别名，以及后台下拉框要拉的该服真实表情清单
    emojiAliases: data.emojiAliases,
    listEmojis: (guildId: string) => listGuildEmojis({ botToken: env.DISCORD_BOT_TOKEN ?? '' }, guildId),
    describeEmojis: (guildId, options) =>
      describeGuildEmojis(
        { reactionModels: data.reactionModels, emojiDescriptions: data.emojiDescriptions, keys: data.keys, providers: providers() },
        guildId,
        env.DISCORD_BOT_TOKEN ?? '',
        options,
      ),
    // §19.8：GET /api/logs 直接读同一份 store（轮询游标就是表里的 id）
    logs: logStore,
    // §25.5：摘要读写直接落在同一份仓储上；重新总结与 /summary 命令共用 summarize，
    // chat 每次调用新建（不带跨请求状态，也不把密钥/路由缓存进 isolate）
    summaries: data.summaries,
    summarizeChannel: (key) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).summarize(key),
    // §63：连续总结每批新建一个 chat（与上面两条同口径），批与批之间只靠库里的游标接力
    summarizeSweep: (key) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).summarizeSweep(key),
    // §35：后台「选择性补记」同样每次新建 chat，预览只数条数、补记只追加一段新记忆
    previewBackfill: (key, range) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).previewBackfill(key, range),
    backfillSummary: (key, range) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).backfill(key, range),
    // §26.4：频道记忆配置随 ...data 一起从 createRepositories 带进来；
    // 默认值从 core 常量取，HTTP 层不 import chat/service.ts（§16.5）
    channelMemory: data.channelMemory,
    memoryDefaults: {
      historyMaxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
      summaryEveryMessages: DEFAULT_SUMMARY_EVERY_MESSAGES,
    },
    adminPassword: readSecret(env, 'ADMIN_PASSWORD'),
    sessionSecret: readSecret(env, 'SESSION_SECRET'),
    appVersion: APP_VERSION,
    probeKey: keyProber,
    // §46：中继没配时这里装配的是「永远抛」占位，路由据此回 501，其它路由照旧
    pgErrors: createPgErrorsSource(env),
    // §62：后台删单条短期记忆时，先把 Discord 里那条删掉；没配 token 时它自己回一句原因
    pruneDiscordMessage: (row) => {
      const target: PruneTarget = { channelId: row.channelId ?? '', role: row.role, content: row.content };
      if (row.authorId !== undefined) target.authorId = row.authorId;
      if (row.createdAt !== undefined) target.createdAt = row.createdAt;
      if (row.discordId !== undefined) target.discordId = row.discordId;
      return pruneDiscordMessage({ botToken: env.DISCORD_BOT_TOKEN ?? '' }, target);
    },
  });
  return app.fetch(request);
}

/**
 * cron（见 wrangler.toml 的 [triggers]）把 DO 唤醒：确认那条 Gateway 长连接还活着。
 * 斜杠命令依旧走 /interactions 的 HTTP 路径，这里只做保活，不碰任何交互逻辑。
 */
async function ensureGatewayPresence(env: Env): Promise<void> {
  const namespace = env.GATEWAY_PRESENCE;
  if (namespace === undefined) return;
  const stub = namespace.get(namespace.idFromName(GATEWAY_DO_NAME));
  const response = await stub.fetch(GATEWAY_INTERNAL_ORIGIN + GATEWAY_ENSURE_PATH, { method: 'POST' });
  if (!response.ok) {
    console.error('[gateway] 保活调用失败，status=' + String(response.status));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (INTERACTION_PATHS.includes(pathname)) return handleInteraction(request, env, ctx);
    if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(request, env, ctx, pathname);
    return env.ASSETS.fetch(request);
  },
  /** 只用于保活 DO；失败也不影响任何 HTTP 分支（DO 自己的 alarm 也会兜底重连） */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await ensureGatewayPresence(env);
    } catch (error) {
      const detail = describeError(error);
      console.error('[gateway] cron 保活异常：' + detail);
      // cron 没有 ctx.waitUntil：这一条直接 await 并自带 try/catch（§19.9）
      try {
        await createLogStore(env.DB).append([
          { level: 'error', scope: 'gateway', message: 'cron 保活异常 ' + detail, createdAt: new Date().toISOString() },
        ]);
      } catch (appendError) {
        console.warn('[log] 写日志失败：' + describeError(appendError));
      }
    }
  },
};