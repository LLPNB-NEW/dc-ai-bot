/// <reference types="node" />
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BackupStore } from '../core/ports';
import type { BackupPhase, BackupRequest, BackupSnapshot, BackupStatus } from '../core/types';

/**
 * 后台「手动备份」的文件端口：容器里没有 systemd / docker socket / rclone，网页按钮只能写
 * backup-request.json；宿主每分钟的 timer 看到它就跑 scripts/backup-to-drive.sh，跑完再把
 * backup-status.json 写回来。两边唯一的契约就是这两个文件的名字与形状，所以校验都在这里做。
 */

const REQUEST_FILE = 'backup-request.json';
const STATUS_FILE = 'backup-status.json';
const REQUEST_ID_BYTES = 16;
const TEMP_SUFFIX = '.tmp';

/** 宿主脚本以 root 写、容器内 uid 1000 读，反过来本进程写、root 读；两个方向都要求 0644 */
const FILE_MODE = 0o644;

const PHASES: readonly BackupPhase[] = ['running', 'done', 'failed'];
const SOURCES: readonly BackupStatus['source'][] = ['manual', 'daily'];

/**
 * 「已经有一个没处理的请求」。POST /api/backup/run 要回 409 才靠这个名字：
 * 端口在 core、实现在 Node，HTTP 层 import 本模块会把 node:fs 拖进 Workers bundle。
 */
export class BackupBusyError extends Error {
  constructor(message = '已存在未处理的备份请求') {
    super(message);
    this.name = 'BackupBusyError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPhase(value: string): value is BackupPhase {
  return PHASES.some((phase) => phase === value);
}

function isSource(value: string): value is BackupStatus['source'] {
  return SOURCES.some((source) => source === value);
}

/** 可选字段三态：缺省放过（undefined）、类型对就收下、类型错返回 null 表示整条判坏 */
function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : null;
}

function toRequest(value: unknown): BackupRequest | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const requestedAt = value['requestedAt'];
  if (typeof id !== 'string' || typeof requestedAt !== 'string') return null;
  return { id, requestedAt };
}

/** 半条状态比没有状态更容易把人带偏：任何一个已知字段类型不对，整块按「没有」处理 */
function toStatus(value: unknown): BackupStatus | null {
  if (!isRecord(value)) return null;

  const phase = value['phase'];
  const source = value['source'];
  const id = value['id'];
  const startedAt = value['startedAt'];
  if (typeof phase !== 'string' || !isPhase(phase)) return null;
  if (typeof source !== 'string' || !isSource(source)) return null;
  if (typeof id !== 'string' || typeof startedAt !== 'string') return null;

  const finishedAt = optionalString(value['finishedAt']);
  const file = optionalString(value['file']);
  const remote = optionalString(value['remote']);
  const error = optionalString(value['error']);
  const bytes = optionalNumber(value['bytes']);
  const keptRemote = optionalNumber(value['keptRemote']);
  if (finishedAt === null || file === null || remote === null || error === null) return null;
  if (bytes === null || keptRemote === null) return null;

  return {
    phase,
    id,
    source,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(file === undefined ? {} : { file }),
    ...(remote === undefined ? {} : { remote }),
    ...(error === undefined ? {} : { error }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(keptRemote === undefined ? {} : { keptRemote }),
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

export function createFileBackupStore(options: { dir: string }): BackupStore {
  const dir = options.dir;
  const requestPath = join(dir, REQUEST_FILE);
  const statusPath = join(dir, STATUS_FILE);

  return {
    async read(): Promise<BackupSnapshot> {
      const [request, status] = await Promise.all([readJsonFile(requestPath), readJsonFile(statusPath)]);
      return { request: toRequest(request), status: toStatus(status) };
    },

    async request(): Promise<BackupRequest> {
      if (await isPresent(requestPath)) throw new BackupBusyError();

      const created: BackupRequest = {
        id: randomBytes(REQUEST_ID_BYTES).toString('hex'),
        requestedAt: new Date().toISOString(),
      };
      // 目录按需创建：BACKUP_DIR 指到还没建的路径时，点一次按钮就建好，比启动期直接失败省事
      await mkdir(dir, { recursive: true });

      const tempPath = join(dir, REQUEST_FILE + '.' + randomBytes(REQUEST_ID_BYTES).toString('hex') + TEMP_SUFFIX);
      try {
        // 先写同目录临时文件再 rename：宿主 timer 随时可能在读，不能让任何一方看见半截 JSON
        await writeFile(tempPath, JSON.stringify(created) + '\n', { encoding: 'utf8', mode: FILE_MODE });
        // rename 保留临时文件的权限；这里再 chmod 一次是为了不受进程 umask 影响
        await chmod(tempPath, FILE_MODE);
        await rename(tempPath, requestPath);
      } catch (error) {
        // 失败别把临时文件留在数据目录：宿主 timer 只认 backup-request.json，没人会来清它
        try {
          await rm(tempPath, { force: true });
        } catch {
          // 清不掉也不改变「这次请求没写成功」这个结论
        }
        throw error;
      }
      return created;
    },
  };
}
