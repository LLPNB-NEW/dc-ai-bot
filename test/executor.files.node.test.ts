/// <reference types="node" />
/**
 * 执行器文件端口契约：后台写 executor-control.json / executor-request.json，
 * 宿主脚本写 executor-status.json。三个文件都是死名字，坏形状必须当成「没有」，
 * 否则网页会把半截 JSON 当成真实配置显示出来。
 *
 * 文件名是 *.node.test.ts 才进 Node 池（vitest.node.config.ts 的 include 与 vitest.config.ts 的 exclude 一一对应）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExecutorBusyError, createFileExecutorControlStore } from '../src/node/executor-files';

const ROOT = mkdtempSync(join(tmpdir(), 'dc-ai-bot-executor-'));
let seq = 0;

const CONTROL_FILE = 'executor-control.json';
const REQUEST_FILE = 'executor-request.json';
const STATUS_FILE = 'executor-status.json';

function newDir(): string {
  seq += 1;
  const dir = join(ROOT, 'case-' + String(seq));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value), 'utf8');
}

afterAll(() => {
  // Windows 上删不掉就留给系统临时目录，不影响断言结果
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // EBUSY
  }
});

describe('createFileExecutorControlStore.read()', () => {
  it('目录不存在时回默认配置，请求和状态都是 null', async () => {
    const snapshot = await createFileExecutorControlStore({ dir: join(ROOT, 'never-created') }).read();
    expect(snapshot).toEqual({
      config: { enabled: true, intervalMinutes: 30, updatedAt: '' },
      request: null,
      status: null,
    });
  });

  it('三个文件都是坏 JSON 时整组按没有处理：配置回落默认，其余 null', async () => {
    const dir = newDir();
    writeFileSync(join(dir, CONTROL_FILE), '{"enabled":', 'utf8');
    writeFileSync(join(dir, REQUEST_FILE), 'not json at all', 'utf8');
    writeFileSync(join(dir, STATUS_FILE), '{"phase":', 'utf8');

    expect(await createFileExecutorControlStore({ dir }).read()).toEqual({
      config: { enabled: true, intervalMinutes: 30, updatedAt: '' },
      request: null,
      status: null,
    });
  });

  it('配置形状错就回落默认；请求/状态各自独立判坏', async () => {
    const dir = newDir();
    writeJson(dir, CONTROL_FILE, { enabled: 'yes', intervalMinutes: 30, updatedAt: '' });
    writeJson(dir, REQUEST_FILE, { id: 7, requestedAt: '2026-11-20T03:00:00.000Z' });
    writeJson(dir, STATUS_FILE, { phase: 'pending', checkedAt: '2026-11-20T03:00:00.000Z' });

    expect(await createFileExecutorControlStore({ dir }).read()).toEqual({
      config: { enabled: true, intervalMinutes: 30, updatedAt: '' },
      request: null,
      status: null,
    });
  });

  it('间隔 0 / 1441 / 1.5 都算坏配置，回默认 30', async () => {
    for (const intervalMinutes of [0, 1441, 1.5]) {
      const dir = newDir();
      writeJson(dir, CONTROL_FILE, { enabled: false, intervalMinutes, updatedAt: '' });
      expect((await createFileExecutorControlStore({ dir }).read()).config).toEqual({
        enabled: true,
        intervalMinutes: 30,
        updatedAt: '',
      });
    }
  });

  it('完整状态整条读回，可选字段缺省时整键不出现', async () => {
    const dir = newDir();
    writeJson(dir, STATUS_FILE, {
      phase: 'idle',
      checkedAt: '2026-11-20T03:00:01.000Z',
      nextDueAt: '2026-11-20T03:30:00.000Z',
      last: {
        id: 'a'.repeat(32),
        source: 'manual',
        startedAt: '2026-11-20T02:59:00.000Z',
        finishedAt: '2026-11-20T02:59:12.000Z',
        ok: true,
        durationMs: 12000,
        before: { ok: true, pending: 0, connected: true },
        after: { ok: true, pending: 0, connected: true, summary: 'ok requestsServed=3' },
      },
    });

    const status = (await createFileExecutorControlStore({ dir }).read()).status;
    expect(status?.last?.after).toEqual({
      ok: true,
      pending: 0,
      connected: true,
      summary: 'ok requestsServed=3',
    });
    expect(status?.last !== undefined && 'message' in status.last).toBe(false);
    expect(status?.current).toBeUndefined();
  });

  it('status 的 current/last 坏一个就整条判坏', async () => {
    const dir = newDir();
    writeJson(dir, STATUS_FILE, {
      phase: 'idle',
      checkedAt: '2026-11-20T03:00:01.000Z',
      last: { id: 'a'.repeat(32), source: 'cron', startedAt: '2026-11-20T02:59:00.000Z' },
    });
    expect((await createFileExecutorControlStore({ dir }).read()).status).toBeNull();

    writeJson(dir, STATUS_FILE, {
      phase: 'running',
      checkedAt: '2026-11-20T03:00:01.000Z',
      current: { id: 'a'.repeat(32), source: 'manual', startedAt: 7 },
    });
    expect((await createFileExecutorControlStore({ dir }).read()).status).toBeNull();
  });
});

describe('createFileExecutorControlStore.saveConfig()', () => {
  it('保存后读回同一条，updatedAt 是 ISO 且落 control 文件', async () => {
    const dir = newDir();
    const store = createFileExecutorControlStore({ dir });

    const saved = await store.saveConfig({ enabled: false, intervalMinutes: 5 });
    expect(saved.enabled).toBe(false);
    expect(saved.intervalMinutes).toBe(5);
    expect(saved.updatedAt.endsWith('Z')).toBe(true);

    expect(await store.read()).toEqual({ config: saved, request: null, status: null });
    expect(JSON.parse(readFileSync(join(dir, CONTROL_FILE), 'utf8'))).toEqual(saved);
  });

  it('目录不存在时按需创建', async () => {
    const dir = join(ROOT, 'missing', 'nested');
    expect(existsSync(dir)).toBe(false);

    await createFileExecutorControlStore({ dir }).saveConfig({ enabled: true, intervalMinutes: 60 });
    expect(existsSync(join(dir, CONTROL_FILE))).toBe(true);
  });

  it('写完不留临时文件', async () => {
    const dir = newDir();
    const store = createFileExecutorControlStore({ dir });
    await store.saveConfig({ enabled: true, intervalMinutes: 30 });
    await store.request();

    expect(readdirSync(dir).sort()).toEqual([CONTROL_FILE, REQUEST_FILE]);
  });

  it.skipIf(process.platform === 'win32')('落盘权限是 0644（宿主脚本与容器共读）', async () => {
    const dir = newDir();
    const store = createFileExecutorControlStore({ dir });
    await store.saveConfig({ enabled: true, intervalMinutes: 30 });
    await store.request();

    expect(statSync(join(dir, CONTROL_FILE)).mode & 0o777).toBe(0o644);
    expect(statSync(join(dir, REQUEST_FILE)).mode & 0o777).toBe(0o644);
  });
});

describe('createFileExecutorControlStore.request()', () => {
  it('写出 16 字节 hex 的 id 与 ISO requestedAt，并落在 request 文件', async () => {
    const dir = newDir();
    const store = createFileExecutorControlStore({ dir });

    const created = await store.request();
    expect(created.id).toMatch(/^[0-9a-f]{32}$/);
    expect(created.requestedAt.endsWith('Z')).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, REQUEST_FILE), 'utf8'))).toEqual(created);
    expect(await store.read()).toEqual({
      config: { enabled: true, intervalMinutes: 30, updatedAt: '' },
      request: created,
      status: null,
    });
  });

  it('连续两次：第二次抛 ExecutorBusyError，且不覆盖第一次的请求', async () => {
    const dir = newDir();
    const store = createFileExecutorControlStore({ dir });

    const first = await store.request();
    const error = await store.request().then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ExecutorBusyError);
    expect((error as Error).name).toBe('ExecutorBusyError');
    expect(JSON.parse(readFileSync(join(dir, REQUEST_FILE), 'utf8'))).toEqual(first);
  });
});
