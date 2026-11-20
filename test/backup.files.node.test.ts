/// <reference types="node" />
/**
 * 手动备份的文件端口契约：后台写 backup-request.json，宿主脚本写 backup-status.json，
 * 两边只靠 <dir> 下这两个 JSON 交流，所以「坏形状当没有」「忙」「走完不留临时文件」都要钉住。
 *
 * 文件名是 *.node.test.ts 才进 Node 池（vitest.node.config.ts 的 include 与 vitest.config.ts 的 exclude 一一对应）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BackupBusyError, createFileBackupStore } from '../src/node/backup-files';

const ROOT = mkdtempSync(join(tmpdir(), 'dc-ai-bot-backup-'));
let seq = 0;

/** 契约里的文件名：宿主脚本按死名字找文件，改这里等于改协议 */
const REQUEST_FILE = 'backup-request.json';
const STATUS_FILE = 'backup-status.json';

/** 每个用例一个全新目录：request() 会落文件，共用目录会让用例互相看见对方的请求 */
function newDir(): string {
  seq += 1;
  const dir = join(ROOT, 'case-' + String(seq));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStatus(dir: string, value: unknown): void {
  writeFileSync(join(dir, STATUS_FILE), JSON.stringify(value), 'utf8');
}

afterAll(() => {
  // 同 node.migrate.test.ts：Windows 上删不掉就留给系统临时目录，不影响断言结果
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // EBUSY
  }
});

describe('createFileBackupStore.request()', () => {
  it('写出的 id 是 16 字节 hex、requestedAt 是 ISO（带 Z），并落在 backup-request.json', async () => {
    const dir = newDir();
    const store = createFileBackupStore({ dir });

    const created = await store.request();
    expect(created.id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(created.requestedAt).toISOString()).toBe(created.requestedAt);
    expect(created.requestedAt.endsWith('Z')).toBe(true);

    const onDisk = JSON.parse(readFileSync(join(dir, REQUEST_FILE), 'utf8')) as unknown;
    expect(onDisk).toEqual(created);
  });

  it('连续两次：第二次抛 BackupBusyError，且不覆盖第一次的请求', async () => {
    const dir = newDir();
    const store = createFileBackupStore({ dir });

    const first = await store.request();
    const error = await store.request().then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(BackupBusyError);
    // 路由按这个名字认「忙」并回 409，改名等于改 HTTP 契约
    expect((error as Error).name).toBe('BackupBusyError');
    expect(JSON.parse(readFileSync(join(dir, REQUEST_FILE), 'utf8'))).toEqual(first);
  });

  it('写完不留临时文件', async () => {
    const dir = newDir();
    await createFileBackupStore({ dir }).request();

    expect(readdirSync(dir)).toEqual([REQUEST_FILE]);
  });

  it('目录不存在时按需创建（既定行为）：第一次点按钮就把目录建好', async () => {
    const dir = join(ROOT, 'missing', 'nested');
    expect(existsSync(dir)).toBe(false);

    const created = await createFileBackupStore({ dir }).request();
    expect(existsSync(join(dir, REQUEST_FILE))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, REQUEST_FILE), 'utf8'))).toEqual(created);
  });

  it.skipIf(process.platform === 'win32')('落盘权限是 0644（宿主脚本以 root 读写同一份）', async () => {
    const dir = newDir();
    await createFileBackupStore({ dir }).request();

    expect(statSync(join(dir, REQUEST_FILE)).mode & 0o777).toBe(0o644);
  });
});

describe('createFileBackupStore.read()', () => {
  it('写读往返：request() 之后读回同一条，status 为 null', async () => {
    const dir = newDir();
    const store = createFileBackupStore({ dir });

    const created = await store.request();
    expect(await store.read()).toEqual({ request: created, status: null });
  });

  it('两个文件都不存在时回 { request: null, status: null }，目录也不存在同样不抛', async () => {
    expect(await createFileBackupStore({ dir: newDir() }).read()).toEqual({ request: null, status: null });
    expect(await createFileBackupStore({ dir: join(ROOT, 'never-created') }).read()).toEqual({
      request: null,
      status: null,
    });
  });

  it('完整终态整条读回（含 file / bytes / keptRemote / remote）', async () => {
    const dir = newDir();
    const status = {
      phase: 'done',
      id: 'a'.repeat(32),
      source: 'manual',
      startedAt: '2026-10-28T13:07:38.000Z',
      finishedAt: '2026-10-28T13:09:01.000Z',
      file: 'dc-ai-bot-20261028T130737Z.tar.gz',
      bytes: 247873,
      keptRemote: 3,
      remote: 'gdrive:dc-ai-bot-backup',
    };
    writeStatus(dir, status);

    const snapshot = await createFileBackupStore({ dir }).read();
    expect(snapshot.status).toEqual(status);
    expect(snapshot.request).toBeNull();
  });

  it('running 阶段没有的字段整键不出现（不是 null）', async () => {
    const dir = newDir();
    writeStatus(dir, { phase: 'running', id: '', source: 'daily', startedAt: '2026-10-28T13:07:38.000Z' });

    const status = (await createFileBackupStore({ dir }).read()).status;
    expect(status).toEqual({ phase: 'running', id: '', source: 'daily', startedAt: '2026-10-28T13:07:38.000Z' });
    expect(status !== null && 'file' in status).toBe(false);
    expect(status !== null && 'bytes' in status).toBe(false);
  });

  it('failed 阶段带单行 error', async () => {
    const dir = newDir();
    writeStatus(dir, {
      phase: 'failed',
      id: 'b'.repeat(32),
      source: 'manual',
      startedAt: '2026-10-28T13:07:38.000Z',
      finishedAt: '2026-10-28T13:07:41.000Z',
      error: 'rclone: gdrive token expired',
    });

    const status = (await createFileBackupStore({ dir }).read()).status;
    expect(status?.phase).toBe('failed');
    expect(status?.error).toBe('rclone: gdrive token expired');
  });

  it('坏 JSON 两边都按「没有」处理', async () => {
    const dir = newDir();
    writeFileSync(join(dir, REQUEST_FILE), '{"id":', 'utf8');
    writeFileSync(join(dir, STATUS_FILE), 'not json at all', 'utf8');

    expect(await createFileBackupStore({ dir }).read()).toEqual({ request: null, status: null });
  });

  it('坏形状整块判坏：phase 不在枚举 / source 不认识 / bytes 是字符串', async () => {
    const dir = newDir();
    writeStatus(dir, { phase: 'pending', id: 'c'.repeat(32), source: 'manual', startedAt: '2026-10-28T13:07:38.000Z' });
    expect((await createFileBackupStore({ dir }).read()).status).toBeNull();

    writeStatus(dir, { phase: 'done', id: 'c'.repeat(32), source: 'cron', startedAt: '2026-10-28T13:07:38.000Z' });
    expect((await createFileBackupStore({ dir }).read()).status).toBeNull();

    writeStatus(dir, {
      phase: 'done',
      id: 'c'.repeat(32),
      source: 'manual',
      startedAt: '2026-10-28T13:07:38.000Z',
      bytes: '247873',
    });
    expect((await createFileBackupStore({ dir }).read()).status).toBeNull();

    // 请求文件只认两个字符串字段：id 变成数字同样整块作废
    writeFileSync(join(dir, REQUEST_FILE), JSON.stringify({ id: 7, requestedAt: '2026-10-28T13:07:37.000Z' }), 'utf8');
    expect((await createFileBackupStore({ dir }).read()).request).toBeNull();
  });
});
