/// <reference types="node" />
/**
 * §30 自托管入口：唯一入口文件，由 `node scripts/build-node.mjs` 打成单文件 `dist/server.mjs`。
 *
 * 装配顺序照 `src/workers/index.ts` 的 fetch/handleApi/handleInteraction 三分支抄，
 * 差别只在"平台给什么"：
 *   - Workers 的 env.DB（D1）/ env.ASSETS / ctx.waitUntil
 *   - Node 的 createSqliteDatabase(dbPath) / createStaticHandler(root) / TaskTracker
 * 中间那层（createRepositories / createLogStore / createAdminApp / createInteractionHandler）
 * 两边传的是**同一份参数**，改一处就得同步改另一处。
 *
 * 与 Workers 唯一的架构性差异：Node 是单租户、进程常驻，所以装配可以只做一次（存进 #deps 的闭包），
 * 而 Workers 每次请求重建 —— 那边是为了按请求读 secret 并隔离多租户。
 */
import { serve, type ServerType } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SUMMARY_EVERY_MESSAGES, createChatService } from '../core/chat/service';
import type { SqlDatabase } from '../core/db/sql';
import { DEFAULT_HISTORY_MAX_MESSAGES } from '../core/memory/window';
import { createProviders } from '../core/providers/index';
import { createRelayErrorSource, createUnconfiguredErrorSource, type PgErrorsSource } from '../core/pg-errors';
import { createStoredTts } from '../core/voice/tts';
import type { LlmProvider, LogEntry, ProviderId } from '../core/types';
import { createSecretBox } from '../workers/crypto/secretbox';
import { createRepositories } from '../workers/db/d1-repository';
import { createLogStore } from '../workers/db/log-store';
import { createInteractionHandler } from '../workers/discord/handler';
import { listGuildEmojis } from '../workers/discord/rest';
import { pruneDiscordMessage, type PruneTarget } from '../workers/discord/prune';
import { describeGuildEmojis } from '../workers/emoji/describe';
import { GATEWAY_BUILD } from '../workers/gateway/engine';
import { createAdminApp } from '../workers/http/app';
import type { KeyProber } from '../workers/http/ports';
import { createFileBackupStore } from './backup-files';
import { markAllApplied, runMigrations } from './db/migrate';
import { createSqliteDatabase } from './db/sqlite';
import { readNodeEnv, type NodeEnv } from './env';
import { createNodeGateway, type NodeGateway } from './gateway';
import { createEntryHandler } from './http/router';
import { createStaticHandler } from './http/static';
import { createTaskTracker, type TaskTracker } from './wait-until';

/**
 * 与 package.json 的 version 保持一致；tsconfig 未开 resolveJsonModule，故为常量。
 * 不能 import src/workers/index.ts 里的同名常量：那会把 DO 类一起拖进 bundle。
 */
const APP_VERSION = '0.1.0';

const BOT_NAME = 'DC AI BOT';

/**
 * 与 src/workers/index.ts:54 逐项一致：Discord 后台填哪个路径都能通，
 * 只认 /interactions 会让 /discord/interactions 掉进 SPA 回退、拿到一页 HTML。
 */
const INTERACTION_PATHS: readonly string[] = ['/interactions', '/discord/interactions'];

/** 与 src/workers/index.ts:61 的 CHAT_CONFIG 同值（契约 §9/§6） */
const CHAT_CONFIG = { historyMaxMessages: 50, summaryEveryMessages: 50 };

/**
 * 「D1 全量导出后再导入」用的一次性开关：库里的表已经建好，迁移却一条都没记账，
 * 直接跑 runMigrations 会在第一个 CREATE TABLE 上撞「table already exists」。
 */
const MARK_MIGRATIONS_FLAG = '--mark-migrations-applied';

/** 迁移目录按工作目录解析：镜像里 WORKDIR=/app，仓库根跑就是仓库根 */
const MIGRATIONS_DIR = 'migrations';

/** 与 src/node/env.ts 的 DEFAULT_DB_PATH 同值；那边的常量没有 export，这里只为 mark 分支服务 */
const DEFAULT_DB_PATH = '/data/dc-ai-bot.sqlite3';

/**
 * 静态产物根：bundle 之后 import.meta.url 是 dist/server.mjs，因此 ./web/ 正好是 dist/web
 * （Dockerfile 把 builder 的 dist/web 拷到 runner 的同名位置）。
 */
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url).toString());

/** 优雅退出总预算：超过就强制结束，别让 systemd/docker 的 SIGKILL 来收尾 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/** 缺 secret / 端口非法都在启动期结束进程：带着半份配置跑起来只会让每个请求各自回 500 */
function loadEnv(): NodeEnv {
  try {
    return readNodeEnv(process.env);
  } catch (error) {
    console.error('[node] 配置不完整：' + describeError(error));
    process.exit(1);
  }
}

/**
 * 每次调用才读 globalThis.fetch：与 Workers 入口同形，出网拦截（测试/排障）替换全局 fetch 才能生效。
 */
function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/** providers 无密钥、无请求态，进程内一份就够（secretBox 之类带密钥的不进这里） */
let providersCache: Record<ProviderId, LlmProvider> | null = null;

function providers(): Record<ProviderId, LlmProvider> {
  const cached = providersCache;
  if (cached !== null) return cached;
  const created = createProviders();
  providersCache = created;
  return created;
}

/** §16.4：连通性测试走注入窄接口，HTTP 层不 import src/core/providers/** */
const keyProber: KeyProber = async (input) => {
  const provider = providers()[input.provider];
  if (!provider) throw new Error('UNKNOWN_PROVIDER: ' + String(input.provider));
  return provider.listModels({ apiKey: input.apiKey, baseUrl: input.baseUrl, fetch: runtimeFetch });
};

interface RequestHandlers {
  handleInteraction(request: Request): Promise<Response>;
  handleApi(request: Request): Promise<Response>;
}

/**
 * 备份请求/状态文件与 DB 同目录（compose 只挂 ./data:/data，宿主脚本读同一份）。
 * BACKUP_DIR 只给「库里和备份目录想分开放」的部署用，缺省跟着 DB_PATH 走。
 */
function backupDir(dbPath: string): string {
  const raw = process.env.BACKUP_DIR;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed === '' ? dirname(dbPath) : trimmed;
}

/**
 * §46：PG 中继报错列表是可选端口 —— 与 Workers 侧同口径，两个环境变量缺一个就装配「永远抛」占位，
 * 只影响 /api/pg-errors（回 501），健康检查与其它 API 完全不受影响。
 */
/**
 * 服务器上是否还留着老的语音合成环境变量：只用于后台提示「可以删」，不参与任何取值。
 * 语音合成只从 tts_settings 那张单行表读，不进任何必填 secret 清单。
 */
function legacyTtsEnvPresent(): boolean {
  const url = (process.env.VOICE_TTS_URL ?? '').trim();
  const key = (process.env.VOICE_TTS_KEY ?? '').trim();
  return url !== '' || key !== '';
}

function createPgErrorsSource(): PgErrorsSource {
  const url = (process.env.PG_ERRORS_URL ?? '').trim();
  const token = (process.env.PG_ERRORS_TOKEN ?? '').trim();
  if (url === '' || token === '') return createUnconfiguredErrorSource();
  return createRelayErrorSource({ url, token, fetch: runtimeFetch });
}

/**
 * 装配一次，三个分支共用。参数逐项对着 src/workers/index.ts 的 handleInteraction/handleApi 抄：
 * 那边每次请求重建是因为要按请求读 secret；这边 secret 来自进程环境，只有一份。
 */
function createRequestHandlers(db: SqlDatabase, env: NodeEnv, tracker: TaskTracker): RequestHandlers {
  const secretBox = createSecretBox(env.KEY_ENCRYPTION_SECRET);
  const data = createRepositories(db, secretBox);
  // §19.9：入口与网关共用同一份环形表；写日志搭后台任务的便车，失败只 warn
  const logStore = createLogStore(db);
  const sink = (entry: LogEntry): void => {
    tracker.waitUntil(
      logStore.append([entry]).catch((error: unknown) => {
        console.warn('[log] 写日志失败：' + describeError(error));
      }),
    );
  };
  // summaries 随 createRepositories 的返回值一起被 ...data 带进来（§17.2）
  const chat = createChatService({
    ...data,
    providers: providers(),
    config: CHAT_CONFIG,
    background: (task: Promise<unknown>) => tracker.waitUntil(task),
    log: sink,
  });

  const interaction = createInteractionHandler({
    publicKeyHex: env.DISCORD_PUBLIC_KEY,
    applicationId: env.DISCORD_APPLICATION_ID,
    botToken: env.DISCORD_BOT_TOKEN,
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

  const app = createAdminApp({
    prompts: data.prompts,
    // §ST：酒馆预设导入的原始 JSON 存档（单行），与 Node 端 HTTP 层是同一份存储
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
    // §voice：语音回复的三层配置表（0 关 / 1 按指令 / 2 总是）
    voiceSettings: data.voiceSettings,
    // 语音合成接口：唯一来源是后台那一行；envPresent 只用于提示老环境变量可以删
    ttsSettings: data.ttsSettings,
    // §voice：三层语气提示词（channel > guild > global），后台可编辑
    ttsStyles: data.ttsStyles,
    // 深度注入：三层各一行，聊天装配按 channel > guild > global 取第一个非空
    promptInjections: data.promptInjections,
    // 世界书：三层各一本整本覆盖，聊天装配按 channel > guild > global 取第一本
    worldBooks: data.worldBooks,
    ttsEnvPresent: legacyTtsEnvPresent(),
    // §23.1/§23.6：认图读写的落库表，以及那棵「后台认图」按钮背后的执行器
    emojiDescriptions: data.emojiDescriptions,
    // §24.6/§24.7：管理员手工配的别名，以及后台下拉框要拉的该服真实表情清单
    emojiAliases: data.emojiAliases,
    listEmojis: (guildId: string) => listGuildEmojis({ botToken: env.DISCORD_BOT_TOKEN }, guildId),
    describeEmojis: (guildId, options) =>
      describeGuildEmojis(
        { reactionModels: data.reactionModels, emojiDescriptions: data.emojiDescriptions, keys: data.keys, providers: providers() },
        guildId,
        env.DISCORD_BOT_TOKEN,
        options,
      ),
    // §19.8：GET /api/logs 直接读同一份 store（轮询游标就是表里的 id）
    logs: logStore,
    // §25.5：重新总结与 /summary 命令共用 summarize，chat 每次调用新建
    summaries: data.summaries,
    summarizeChannel: (key) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).summarize(key),
    // §63：连续总结每批新建一个 chat（与上面同口径），批与批之间只靠库里的游标接力
    summarizeSweep: (key) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).summarizeSweep(key),
    // 手动备份：后台只写请求文件，打包上传由宿主 timer 干（容器里没有 systemd/rclone，也不该有）
    backup: createFileBackupStore({ dir: backupDir(env.dbPath) }),
    // §35：后台「选择性补记」同样每次新建 chat，预览只数条数、补记只追加一段新记忆
    previewBackfill: (key, range) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).previewBackfill(key, range),
    backfillSummary: (key, range) =>
      createChatService({ ...data, providers: providers(), config: CHAT_CONFIG, log: sink }).backfill(key, range),
    // §26.4：频道记忆配置随 ...data 一起从 createRepositories 带进来
    channelMemory: data.channelMemory,
    memoryDefaults: {
      historyMaxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
      summaryEveryMessages: DEFAULT_SUMMARY_EVERY_MESSAGES,
    },
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    appVersion: APP_VERSION,
    probeKey: keyProber,
    // §46：中继没配时装配的是「永远抛」占位，路由据此回 501
    pgErrors: createPgErrorsSource(),
    // §62：后台删单条短期记忆时，先把 Discord 里那条删掉；没配 token 时它自己回一句原因
    pruneDiscordMessage: (row) => {
      const target: PruneTarget = { channelId: row.channelId ?? '', role: row.role, content: row.content };
      if (row.authorId !== undefined) target.authorId = row.authorId;
      if (row.createdAt !== undefined) target.createdAt = row.createdAt;
      if (row.discordId !== undefined) target.discordId = row.discordId;
      return pruneDiscordMessage({ botToken: env.DISCORD_BOT_TOKEN }, target);
    },
  });

  return {
    // ctx.waitUntil 的等价物：Workers 侧那个参数形状是 { waitUntil }，这里给同形对象
    handleInteraction: (request: Request) =>
      interaction(request, { waitUntil: (task: Promise<unknown>) => tracker.waitUntil(task) }),
    handleApi: (request: Request) => Promise.resolve(app.fetch(request)),
  };
}

/** 迁移失败几乎总是「工作目录里没有 migrations/」或「库是 D1 导入的、没先认账」 */
async function migrate(env: NodeEnv): Promise<void> {
  try {
    const result = await runMigrations(env.dbPath, MIGRATIONS_DIR);
    if (result.applied.length > 0) console.log('[node] 迁移已执行：' + result.applied.join(', '));
    console.log('[node] 迁移检查完成 applied=' + String(result.applied.length) + ' skipped=' + String(result.skipped.length));
  } catch (error) {
    console.error('[node] 迁移失败（目录 ' + MIGRATIONS_DIR + ' 必须在工作目录下）：' + describeError(error));
    console.error('[node] 若是 D1 全量导入的库，先跑 node dist/server.mjs ' + MARK_MIGRATIONS_FLAG);
    process.exit(1);
  }
}

/** mark 分支只要 DB_PATH：此时不必有六个 secret，运维在空环境里也能先认账 */
function readDatabasePath(): string {
  const raw = process.env.DB_PATH;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed === '' ? DEFAULT_DB_PATH : trimmed;
}

async function markMigrationsApplied(): Promise<void> {
  const dbPath = readDatabasePath();
  const marked = await markAllApplied(dbPath, MIGRATIONS_DIR);
  console.log('[node] mark-migrations-applied db=' + dbPath + ' marked=' + String(marked.length));
  if (marked.length > 0) console.log('[node] 新认账：' + marked.join(', '));
  console.log('[node] 未执行的迁移已全部记为已执行，不会重放任何 SQL');
}

/**
 * 关 HTTP：keep-alive 的空闲连接不会自己关，close() 会一直等它们，
 * 所以先掐掉空闲连接再关，剩下的在飞请求由上面的 25s 预算兜底。
 */
function closeServer(server: ServerType): Promise<void> {
  const idler = server as ServerType & { closeIdleConnections?: () => void };
  idler.closeIdleConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** 停的顺序固定：先断 Discord（不然那条 socket 会一直有事件进来）→ 等后台任务 → 关 HTTP */
function installShutdownHandlers(deps: { server: ServerType; gateway: NodeGateway; tracker: TaskTracker }): void {
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log('[node] 收到 ' + signal + '，开始优雅退出');
    const forced = setTimeout(() => {
      console.error('[node] 优雅退出超过 ' + String(SHUTDOWN_TIMEOUT_MS) + 'ms，强制结束');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    void (async (): Promise<void> => {
      try {
        await deps.gateway.stop();
        await deps.tracker.drain();
        await closeServer(deps.server);
        clearTimeout(forced);
        console.log('[node] 已停止');
        process.exit(0);
      } catch (error) {
        console.error('[node] 优雅退出失败：' + describeError(error));
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function start(): Promise<void> {
  const env = loadEnv();

  // 迁移必须早于任何读写：库是空的/半旧的都靠这一步补齐
  await migrate(env);

  const db = createSqliteDatabase(env.dbPath);
  const tracker = createTaskTracker((error: unknown) => {
    console.error('[node] 后台任务失败：' + describeError(error));
  });
  const { handleInteraction, handleApi } = createRequestHandlers(db, env, tracker);

  if (!existsSync(WEB_ROOT)) {
    console.warn('[node] 静态目录不存在，管理台页面会全部 404：' + WEB_ROOT);
  }
  const serveAssets = createStaticHandler({ root: WEB_ROOT });
  const handler = createEntryHandler({ interactionPaths: INTERACTION_PATHS, handleInteraction, handleApi, serveAssets });

  const server = serve({ fetch: handler, port: env.port }, (info) => {
    console.log(
      '[node] listening on :' + String(info.port) + ' db=' + env.dbPath + ' build=' + GATEWAY_BUILD + ' web=' + WEB_ROOT,
    );
  });
  // EADDRINUSE 之类只在事件里报：没有这个监听就是一条裸栈，看不出是端口被占
  server.on('error', (error: Error) => {
    console.error('[node] HTTP 服务异常：' + describeError(error));
    process.exit(1);
  });

  // 网关只负责「显示在线 + 普通消息聊天」，斜杠命令仍走 /interactions（与 DO 宿主同一套引擎）
  const gateway = createNodeGateway({
    db,
    botToken: env.DISCORD_BOT_TOKEN,
    applicationId: env.DISCORD_APPLICATION_ID,
    keyEncryptionSecret: env.KEY_ENCRYPTION_SECRET,
  });
  gateway.start();

  installShutdownHandlers({ server, gateway, tracker });
}

async function main(): Promise<void> {
  // 一次性运维开关：只记账，不起服务、不要求 secret
  if (process.argv.includes(MARK_MIGRATIONS_FLAG)) {
    await markMigrationsApplied();
    return;
  }
  await start();
}

void main().catch((error: unknown) => {
  console.error('[node] 启动失败：' + describeError(error));
  process.exit(1);
});
