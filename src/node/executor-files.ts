/// <reference types="node" />
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ExecutorControlStore } from '../core/ports';
import type {
  ExecutorConfig,
  ExecutorConfigInput,
  ExecutorHealth,
  ExecutorRequest,
  ExecutorRun,
  ExecutorSnapshot,
  ExecutorStatus,
} from '../core/types';

/**
 * 后台「执行器」页的文件端口：容器里没有 systemd / docker socket，网页按钮只能写
 * executor-request.json；宿主每分钟的 pg-executor-refresh.py 看到它就跑 inject.py，跑完再把
 * executor-status.json 写回来。两边唯一的契约就是这三个文件的名字与形状，所以校验都在这里做。
 */

const CONTROL_FILE = 'executor-control.json';
const REQUEST_FILE = 'executor-request.json';
const STATUS_FILE = 'executor-status.json';
const REQUEST_ID_BYTES = 16;
const TEMP_SUFFIX = '.tmp';

/** 宿主脚本由运维账号写、容器内 uid 1000 读；反过来本进程写、宿主读；两个方向都要求 0644 */
const FILE_MODE = 0o644;

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

/** 「已经有一个没处理的刷新请求」：HTTP 层只能按这个名字认 409 */
export class ExecutorBusyError extends Error {
  constructor(message = '已存在未处理的执行器刷新请求') {
    super(message);
    this.name = 'ExecutorBusyError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 可选字段三态：缺省放过（undefined）、类型对就收下、类型错返回 null 表示整条判坏 */
function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : null;
}

function defaultConfig(): ExecutorConfig {
  return { enabled: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES, updatedAt: '' };
}

function toConfig(value: unknown): ExecutorConfig | null {
  if (!isRecord(value)) return null;
  const enabled = value['enabled'];
  const intervalMinutes = value['intervalMinutes'];
  if (typeof enabled !== 'boolean') return null;
  if (
    typeof intervalMinutes !== 'number' ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < MIN_INTERVAL_MINUTES ||
    intervalMinutes > MAX_INTERVAL_MINUTES
  ) {
    return null;
  }
  const updatedAt = optionalString(value['updatedAt']);
  if (updatedAt === null) return null;
  return { enabled, intervalMinutes, updatedAt: updatedAt ?? '' };
}

function toRequest(value: unknown): ExecutorRequest | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const requestedAt = value['requestedAt'];
  if (typeof id !== 'string' || typeof requestedAt !== 'string') return null;
  return { id, requestedAt };
}

function toHealth(value: unknown): ExecutorHealth | null {
  if (!isRecord(value)) return null;
  const ok = value['ok'];
  const connected = value['connected'];
  if (typeof ok !== 'boolean' || typeof connected !== 'boolean') return null;

  // 宿主探测失败时 pending 必须写成 null：未知和「没有排队」不是一回事，不能拿 0 冒充。
  const rawPending = value['pending'];
  if (rawPending !== undefined && rawPending !== null && typeof rawPending !== 'number') return null;
  if (typeof rawPending === 'number' && !Number.isFinite(rawPending)) return null;

  const connectedSeconds = optionalNumber(value['connectedSeconds']);
  const requestsServed = optionalNumber(value['requestsServed']);
  const requestsFailed = optionalNumber(value['requestsFailed']);
  const summary = optionalString(value['summary']);
  if (connectedSeconds === null || requestsServed === null || requestsFailed === null || summary === null) {
    return null;
  }

  return {
    ok,
    pending: rawPending === undefined ? null : rawPending,
    connected,
    ...(connectedSeconds === undefined ? {} : { connectedSeconds }),
    ...(requestsServed === undefined ? {} : { requestsServed }),
    ...(requestsFailed === undefined ? {} : { requestsFailed }),
    ...(summary === undefined ? {} : { summary }),
  };
}

function optionalHealth(value: unknown): ExecutorHealth | undefined | null {
  if (value === undefined) return undefined;
  return toHealth(value);
}

function toRun(value: unknown): ExecutorRun | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const source = value['source'];
  const startedAt = value['startedAt'];
  if (typeof id !== 'string' || typeof startedAt !== 'string') return null;
  if (source !== 'manual' && source !== 'scheduled') return null;

  const finishedAt = optionalString(value['finishedAt']);
  const ok = optionalBoolean(value['ok']);
  const message = optionalString(value['message']);
  const durationMs = optionalNumber(value['durationMs']);
  const before = optionalHealth(value['before']);
  const after = optionalHealth(value['after']);
  if (
    finishedAt === null ||
    ok === null ||
    message === null ||
    durationMs === null ||
    before === null ||
    after === null
  ) {
    return null;
  }

  return {
    id,
    source,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(ok === undefined ? {} : { ok }),
    ...(message === undefined ? {} : { message }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

function toStatus(value: unknown): ExecutorStatus | null {
  if (!isRecord(value)) return null;
  const phase = value['phase'];
  const checkedAt = value['checkedAt'];
  if (phase !== 'idle' && phase !== 'running') return null;
  if (typeof checkedAt !== 'string') return null;

  const nextDueAt = optionalString(value['nextDueAt']);
  if (nextDueAt === null) return null;

  let current: ExecutorRun | undefined;
  if (value['current'] !== undefined) {
    const parsed = toRun(value['current']);
    if (parsed === null) return null;
    current = parsed;
  }
  let last: ExecutorRun | undefined;
  if (value['last'] !== undefined) {
    const parsed = toRun(value['last']);
    if (parsed === null) return null;
    last = parsed;
  }

  return {
    phase,
    checkedAt,
    ...(nextDueAt === undefined ? {} : { nextDueAt }),
    ...(current === undefined ? {} : { current }),
    ...(last === undefined ? {} : { last }),
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    // 文件不存在、没权限读、JSON 半截，都等于「这一半没有」：读端点绝不因此回 500
    return null;
  }
}

/** 只区分「在」与「不在」；读不了（EACCES 之类）一律当在，宁可回忙也别覆盖一份没处理的请求 */
async function isPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return isRecord(error) ? error['code'] !== 'ENOENT' : true;
  }
}

async function writeJsonAtomic(path: string, dir: string, value: unknown): Promise<void> {
  // 目录按需创建：数据目录还没建好时，点一次按钮就建好，比启动期直接失败省事
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, basename(path) + '.' + randomBytes(REQUEST_ID_BYTES).toString('hex') + TEMP_SUFFIX);
  try {
    // 先写同目录临时文件再 rename：宿主脚本随时可能在读，不能让任何一方看见半截 JSON
    await writeFile(tempPath, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: FILE_MODE });
    // rename 保留临时文件的权限；这里再 chmod 一次是为了不受进程 umask 影响
    await chmod(tempPath, FILE_MODE);
    await rename(tempPath, path);
  } catch (error) {
    // 失败别把临时文件留在数据目录：宿主只认固定文件名，没人会来清它
    try {
      await rm(tempPath, { force: true });
    } catch {
      // 清不掉也不改变「这次写入没成功」这个结论
    }
    throw error;
  }
}

export function createFileExecutorControlStore(options: { dir: string }): ExecutorControlStore {
  const dir = options.dir;
  const controlPath = join(dir, CONTROL_FILE);
  const requestPath = join(dir, REQUEST_FILE);
  const statusPath = join(dir, STATUS_FILE);

  return {
    async read(): Promise<ExecutorSnapshot> {
      const [control, request, status] = await Promise.all([
        readJsonFile(controlPath),
        readJsonFile(requestPath),
        readJsonFile(statusPath),
      ]);
      return {
        config: toConfig(control) ?? defaultConfig(),
        request: toRequest(request),
        status: toStatus(status),
      };
    },

    async saveConfig(input: ExecutorConfigInput): Promise<ExecutorConfig> {
      if (
        typeof input.enabled !== 'boolean' ||
        !Number.isInteger(input.intervalMinutes) ||
        input.intervalMinutes < MIN_INTERVAL_MINUTES ||
        input.intervalMinutes > MAX_INTERVAL_MINUTES
      ) {
        throw new Error('BAD_EXECUTOR_CONFIG');
      }
      const saved: ExecutorConfig = {
        enabled: input.enabled,
        intervalMinutes: input.intervalMinutes,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(controlPath, dir, saved);
      return saved;
    },

    async request(): Promise<ExecutorRequest> {
      if (await isPresent(requestPath)) throw new ExecutorBusyError();

      const created: ExecutorRequest = {
        id: randomBytes(REQUEST_ID_BYTES).toString('hex'),
        requestedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(requestPath, dir, created);
      return created;
    },
  };
}
