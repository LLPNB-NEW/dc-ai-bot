#!/usr/bin/env node
/**
 * 把 Discord 里的一段历史消息回灌进 bot 的 SQLite（migrations/0016 的 messages.discord_id 是幂等的地基）。
 *
 * 为什么需要它：服务器被误删重建后，库里最后一条是 2026-10-27T08:48:10.789Z，之后约 24 小时的消息
 * 只在 Discord 里。运行时（gateway → conversations.append）只记新消息，不会自己补历史，
 * 这段只能靠运维一次性搬回来 —— 所以是纯运维脚本，不改运行时源码。
 *
 * 只用 Node 内置模块（镜像里没有 devDependencies，也不跑构建工具）：
 *   docker exec -i <容器> node --input-type=module < scripts/import-discord.mjs
 * 从标准输入执行时 process.argv[1] 是 undefined，入口守卫因此把「没有 argv[1]」也算入口；
 * 被测试 import 时 argv[1] 是 vitest 的入口，守卫为假，main 不会执行、也不会发任何网络请求。
 *
 * 与运行时写入语义对齐（src/workers/db/d1-repository.ts:648 的 conversations.append）：
 *   role = author.bot ? 'assistant' : 'user'；author_name 空白写 NULL；
 *   reply_to_* 四列是 TEXT NOT NULL DEFAULT ''，没有回复时一律写空串（写 NULL 会撞约束）。
 */
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://discord.com/api/v10';
const PAGE_LIMIT = 100;
const PAGE_GAP_MS = 300;
const MAX_RATE_LIMIT_RETRIES = 6;
const NETWORK_BACKOFF_MS = [1000, 3000, 7000];
const DEFAULT_DB_PATH = '/data/dc-ai-bot.sqlite3';
const DEFAULT_MAX_PAGES = 400;
const PROGRESS_EVERY_PAGES = 20;
/** Discord snowflake 的元年（2015-01-01T00:00:00Z），after 参数要的是 (ms - epoch) << 22 */
const DISCORD_EPOCH_MS = 1420070400000n;

/** 列顺序与运行时 append 一致，discord_id 追加在 created_at 之后 */
const INSERT_SQL =
  'INSERT INTO messages (guild_id, channel_id, user_id, role, content, author_name, created_at, discord_id, reply_to_id, reply_to_author, reply_to_author_id, reply_to_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(discord_id) DO NOTHING';

// 三个可替换的副作用：测试要既不连 Discord、也不真的等 300ms，所以做成模块级变量
let fetchImpl = (url, init) => globalThis.fetch(url, init);
let sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let logImpl = (line) => console.log(line);

/** 测试用：替换 fetch / sleep / log；不传的保持原样 */
export function setImportHooks(hooks = {}) {
  if (typeof hooks.fetch === 'function') fetchImpl = hooks.fetch;
  if (typeof hooks.sleep === 'function') sleepImpl = hooks.sleep;
  if (typeof hooks.log === 'function') logImpl = hooks.log;
}

/** 测试用：把三个钩子恢复成真实实现，免得用例之间互相污染 */
export function resetImportHooks() {
  fetchImpl = (url, init) => globalThis.fetch(url, init);
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  logImpl = (line) => console.log(line);
}

/** ISO 时刻 → snowflake（after 参数）。非法时刻直接抛，调用方按配置错误处理 */
export function toSnowflake(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error('AFTER_ISO 不是合法时间：' + String(iso));
  return ((BigInt(ms) - DISCORD_EPOCH_MS) << 22n).toString();
}

function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? '（' + error.cause.message + '）' : '';
  return error.message + cause;
}

/** Discord 的显示名规则：global_name 优先，退回 username；空白当作「没有名字」（读侧据此不拼前缀） */
function displayName(author) {
  if (author === null || author === undefined) return '';
  const raw = author.global_name || author.username || '';
  return String(raw).trim() === '' ? '' : String(raw).trim();
}

/**
 * 一条 Discord 消息 → 一行 messages。键名就是列名，test 里可以整对象比对。
 * 时间戳必须归一化：Discord 给的是 2026-10-27T08:58:47.475000+00:00，
 * 库里已有的历史全是 2026-10-27T08:48:10.789Z 这种形态，两种混在一起会让按字符串比时间的读侧错乱。
 */
export function mapMessage(message, guildId, channelId) {
  const author = message.author ?? {};
  const name = displayName(author);
  const referenced = message.referenced_message ?? null;
  return {
    guild_id: guildId,
    channel_id: channelId,
    user_id: author.id ?? '',
    role: author.bot === true ? 'assistant' : 'user',
    content: message.content ?? '',
    author_name: name === '' ? null : name,
    created_at: new Date(message.timestamp).toISOString(),
    discord_id: String(message.id),
    // 四列 NOT NULL DEFAULT ''：原消息被删（referenced_message 为 null）时只留 id，其余留空串
    reply_to_id: message.reference?.message_id ?? '',
    reply_to_author: displayName(referenced?.author),
    reply_to_author_id: referenced?.author?.id ?? '',
    reply_to_content: referenced?.content ?? '',
  };
}

function botHeaders(token) {
  return { Authorization: 'Bot ' + token, 'User-Agent': 'dc-ai-bot-import (self-hosted, 1.0)' };
}

/** 429 的 retry_after 是秒（可能是小数）；没有就退回响应头，再没有按 1 秒兜底 */
function retryAfterMs(body, headers) {
  let seconds = Number.NaN;
  try {
    const parsed = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') seconds = Number(parsed.retry_after);
  } catch {
    // 不是 JSON（Cloudflare 那类拦截页）：走响应头
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    const header = Number(headers?.get?.('retry-after'));
    seconds = Number.isFinite(header) && header >= 0 ? header : 1;
  }
  return Math.ceil(seconds * 1000);
}

/**
 * 一次 GET，把两类抖动都吃掉：
 *   429 → 按 retry_after 睡完重试同一页，最多 6 次；
 *   网络错误（fetch failed / UND_ERR_SOCKET …）→ 1s、3s、7s 退避重试 3 次，仍失败交给调用方 exit 1。
 * label 只用来打日志，URL 里没有 token，不会泄露。
 */
async function requestJson(url, token, label) {
  let rateLimited = 0;
  let networkErrors = 0;
  for (;;) {
    let response;
    let body;
    try {
      response = await fetchImpl(url, { headers: botHeaders(token) });
      body = await response.text();
    } catch (error) {
      if (networkErrors >= NETWORK_BACKOFF_MS.length) {
        throw new Error(label + ' 网络错误，退避重试 ' + NETWORK_BACKOFF_MS.length + ' 次仍失败：' + describeError(error));
      }
      const waitMs = NETWORK_BACKOFF_MS[networkErrors];
      networkErrors += 1;
      logImpl(label + ' 网络错误，' + waitMs + 'ms 后重试（第 ' + networkErrors + ' 次）：' + describeError(error));
      await sleepImpl(waitMs);
      continue;
    }
    if (response.status === 429) {
      const waitMs = retryAfterMs(body, response.headers);
      if (rateLimited >= MAX_RATE_LIMIT_RETRIES) {
        throw new Error(label + ' 被 Discord 限速（429），重试 ' + MAX_RATE_LIMIT_RETRIES + ' 次仍然 429');
      }
      rateLimited += 1;
      logImpl(label + ' 429 限速，' + waitMs + 'ms 后重试（第 ' + rateLimited + ' 次）');
      await sleepImpl(waitMs);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Discord 拒绝了这个 bot token（HTTP ' + response.status + '）：' + body.slice(0, 200));
    }
    if (!response.ok) {
      throw new Error(label + ' 返回 HTTP ' + response.status + '：' + body.slice(0, 200));
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(label + ' 返回的不是 JSON：' + body.slice(0, 200));
    }
  }
}

/** 频道详情只为拿 guild_id；拿不到（没权限、网络、没这字段）就退回环境变量 GUILD_ID */
async function resolveGuildId({ token, channelId, guildId }) {
  try {
    const channel = await requestJson(API_BASE + '/channels/' + channelId, token, 'channel');
    const id = channel !== null && typeof channel === 'object' && channel.guild_id ? String(channel.guild_id) : '';
    if (id !== '') return id;
    logImpl('频道详情里没有 guild_id，改用 GUILD_ID');
  } catch (error) {
    logImpl('读频道详情失败（' + describeError(error) + '），改用 GUILD_ID');
  }
  const fallback = (guildId ?? '').trim();
  if (fallback === '') throw new Error('拿不到 guild_id，也没有设置环境变量 GUILD_ID');
  return fallback;
}

/** 本页里最新的那个 id：Discord 按「新 → 旧」返回，取最大值才不依赖数组顺序 */
function newestId(page) {
  let newest = null;
  for (const message of page) {
    const id = String(message?.id ?? '');
    if (!/^[0-9]+$/.test(id)) continue;
    if (newest === null || BigInt(id) > BigInt(newest)) newest = id;
  }
  return newest;
}

/** 一页一个事务：整页要么全进要么全不进，重试那一页时不会留下半页 */
function writeRows(db, statement, rows) {
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const result = statement.run(
        row.guild_id,
        row.channel_id,
        row.user_id,
        row.role,
        row.content,
        row.author_name,
        row.created_at,
        row.discord_id,
        row.reply_to_id,
        row.reply_to_author,
        row.reply_to_author_id,
        row.reply_to_content,
      );
      if (Number(result.changes) > 0) inserted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败说明事务已不在，要报出去的是前面那条真正的错
    }
    throw error;
  }
  return { inserted, skipped: rows.length - inserted };
}

/** 没有 0016 就会在写入时炸出「no such column: discord_id」，提前一句中文比那个好读 */
function assertSchema(db) {
  const columns = db
    .prepare('PRAGMA table_info(messages)')
    .all()
    .map((column) => column.name);
  if (!columns.includes('discord_id')) {
    throw new Error(
      '库里没有 messages.discord_id：先让 bot 启动跑完 migrations（0016_message_discord_id.sql），再重跑本脚本',
    );
  }
}

/**
 * 主流程：拿 guild_id → 按 after 翻页 → 每页映射 + 入库 → 打进度。
 * 显式收 options（而不是自己读 process.env），测试才好喂假 fetch 与临时库。
 */
export async function runImport(options) {
  const token = options.token;
  const channelId = String(options.channelId);
  const afterIso = options.afterIso;
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const dryRun = options.dryRun === true;

  const guildId = await resolveGuildId({ token, channelId, guildId: options.guildId });
  let after = toSnowflake(afterIso);

  const db = dryRun ? null : new DatabaseSync(dbPath);
  try {
    if (db !== null) {
      // bot 还在跑的时候写库会撞上它的写锁：等 5 秒，比直接抛 SQLITE_BUSY 好排查
      db.exec('PRAGMA busy_timeout = 5000');
      assertSchema(db);
    }
    const statement = db === null ? null : db.prepare(INSERT_SQL);

    let pages = 0;
    let inserted = 0;
    let skipped = 0;
    let fetched = 0;
    let first = null;
    let last = null;

    for (;;) {
      if (pages >= maxPages) {
        logImpl('到达 MAX_PAGES=' + maxPages + '，停止翻页');
        break;
      }
      const url =
        API_BASE + '/channels/' + channelId + '/messages?limit=' + PAGE_LIMIT + '&after=' + after;
      const page = await requestJson(url, token, 'page ' + (pages + 1));
      pages += 1;
      if (!Array.isArray(page) || page.length === 0) break;

      const rows = page.map((message) => mapMessage(message, guildId, channelId));
      fetched += rows.length;
      for (const row of rows) {
        if (first === null || row.created_at < first) first = row.created_at;
        if (last === null || row.created_at > last) last = row.created_at;
      }
      if (statement !== null) {
        const counts = writeRows(db, statement, rows);
        inserted += counts.inserted;
        skipped += counts.skipped;
      }

      // 下一页锚点取本页最新 id（不是数组最后一条：after 语义是「更新的那些」）
      const newest = newestId(page);
      if (newest === null || BigInt(newest) <= BigInt(after)) {
        logImpl('本页没有更靠后的消息 id，停止翻页以免死循环');
        break;
      }
      after = newest;

      if (pages % PROGRESS_EVERY_PAGES === 0) {
        logImpl('progress pages=' + pages + ' inserted=' + inserted + ' last=' + String(last ?? ''));
      }
      if (page.length < PAGE_LIMIT) break;
      await sleepImpl(PAGE_GAP_MS);
    }

    const summary = { channelId, guildId, pages, inserted, skipped, fetched, first, last, dryRun };
    logImpl('done ' + JSON.stringify(summary));
    return summary;
  } finally {
    if (db !== null) db.close();
  }
}

/** 环境变量 → 配置。缺什么一次性列全，别让运维一次试一个 */
export function readConfig(env = process.env) {
  const missing = [];
  const token = (env.DISCORD_BOT_TOKEN ?? '').trim();
  const channelId = (env.CHANNEL_ID ?? '').trim();
  const afterIso = (env.AFTER_ISO ?? '').trim();
  if (token === '') missing.push('DISCORD_BOT_TOKEN');
  if (channelId === '') missing.push('CHANNEL_ID');
  if (afterIso === '') missing.push('AFTER_ISO');

  const dbPath = (env.DB_PATH ?? '').trim() || DEFAULT_DB_PATH;
  const rawMaxPages = (env.MAX_PAGES ?? '').trim();
  const maxPages = /^[0-9]+$/.test(rawMaxPages) && Number(rawMaxPages) > 0 ? Number(rawMaxPages) : DEFAULT_MAX_PAGES;
  return {
    missing,
    token,
    channelId,
    afterIso,
    dbPath,
    maxPages,
    dryRun: (env.DRY_RUN ?? '').trim() === '1',
    guildId: (env.GUILD_ID ?? '').trim(),
  };
}

async function main() {
  const config = readConfig();
  if (config.missing.length > 0) {
    console.error('缺少必填环境变量：' + config.missing.join('、'));
    console.error(
      '用法：DISCORD_BOT_TOKEN=… CHANNEL_ID=… AFTER_ISO=2026-10-27T08:48:10.789Z node --input-type=module < scripts/import-discord.mjs',
    );
    console.error(
      '可选：DB_PATH（默认 ' + DEFAULT_DB_PATH + '）、MAX_PAGES（默认 ' + DEFAULT_MAX_PAGES + '）、DRY_RUN=1、GUILD_ID',
    );
    process.exitCode = 2;
    return;
  }
  if (Number.isNaN(Date.parse(config.afterIso))) {
    console.error('AFTER_ISO 不是合法时间：' + config.afterIso);
    process.exitCode = 2;
    return;
  }
  try {
    await runImport(config);
  } catch (error) {
    console.error('回灌失败：' + describeError(error));
    process.exitCode = 1;
  }
}

/** 从标准输入执行时 argv[1] 是 undefined —— 那种情况也算入口 */
function isEntryPoint() {
  if (process.argv[1] === undefined) return true;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await main();
}
