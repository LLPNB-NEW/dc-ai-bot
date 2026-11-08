import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BackupStore } from '../src/core/ports';
import type { BackupRequest, BackupSnapshot, BackupStatus } from '../src/core/types';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

// 手动备份的两条后台路由：鉴权 / 未接线 501 / 双 null / 完整状态 / 成功 / 忙 409

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

/** 32 位 hex：请求 id 的形状由 Node 侧的 randomBytes(16) 决定，这里按同一口径造 */
const REQUEST_ID = '0123456789abcdef0123456789abcdef';
const REQUEST: BackupRequest = { id: REQUEST_ID, requestedAt: '2026-10-28T13:07:37.000Z' };
/** 宿主脚本写回来的完整终态：GET 必须原样透出，不做任何重组 */
const STATUS: BackupStatus = {
  phase: 'done',
  id: REQUEST_ID,
  source: 'manual',
  startedAt: '2026-10-28T13:07:38.000Z',
  finishedAt: '2026-10-28T13:09:01.000Z',
  file: 'dc-ai-bot-20261028T130737Z.tar.gz',
  bytes: 247873,
  keptRemote: 3,
  remote: 'gdrive:dc-ai-bot-backup',
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 真实实现（src/node/backup-files.ts）依赖 node:fs，workerd 池里连 import 都解析不了，
 * 所以这里按端口语义造一份最小实现；「忙」按错误名传递，与路由的判据一致。
 */
function createStore(snapshot: BackupSnapshot): BackupStore {
  return {
    read: async () => snapshot,
    request: async () => {
      throw new Error('这个用例不该写请求文件');
    },
  };
}

/** 模拟「没有未处理请求」的部署：request() 写一份新的，read() 随后就能读到它 */
function acceptingStore(): BackupStore {
  let current: BackupRequest | null = null;
  return {
    read: async () => ({ request: current, status: null }),
    request: async () => {
      const created: BackupRequest = { id: REQUEST_ID, requestedAt: new Date().toISOString() };
      current = created;
      return created;
    },
  };
}

function busyStore(): BackupStore {
  return {
    read: async () => ({ request: REQUEST, status: null }),
    request: async () => {
      const error = new Error('已存在未处理的备份请求');
      error.name = 'BackupBusyError';
      throw error;
    },
  };
}

/** 非「忙」的异常走 onError：必须是 JSON 500，而不是 Hono 默认的纯文本 */
function brokenStore(): BackupStore {
  return {
    read: async () => ({ request: null, status: null }),
    request: async () => {
      throw new Error('EACCES: permission denied');
    },
  };
}

function makeApp(backup?: BackupStore) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
  };
  // 不传 backup 就是「没接线的部署」（Workers 没有文件系统），两条端点应回 501
  if (backup !== undefined) deps.backup = backup;
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;
type Json = Record<string, unknown>;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function login(app: App): Promise<string> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return 'admin_session=' + value;
}

describe('备份路由鉴权', () => {
  it('两条端点未登录一律 401，且不会写请求文件', async () => {
    const app = makeApp(acceptingStore());
    const calls: Array<[string, string]> = [
      ['GET', '/api/backup'],
      ['POST', '/api/backup/run'],
    ];
    for (const [method, path] of calls) {
      const res = await app.request(path, { method, headers: JSON_HEADERS });
      expect(res.status).toBe(401);
      expect(await jsonOf(res)).toEqual({ error: 'UNAUTHORIZED' });
    }
  });
});

describe('未接线部署（没有 backup 依赖）', () => {
  it('GET 与 POST 都回 501 BACKUP_UNAVAILABLE，不崩', async () => {
    const app = makeApp();
    const cookie = await login(app);

    const get = await app.request('/api/backup', { headers: { cookie } });
    expect(get.status).toBe(501);
    expect(await jsonOf(get)).toEqual({ error: 'BACKUP_UNAVAILABLE' });

    const post = await app.request('/api/backup/run', { method: 'POST', headers: { cookie } });
    expect(post.status).toBe(501);
    expect(await jsonOf(post)).toEqual({ error: 'BACKUP_UNAVAILABLE' });
  });
});

describe('GET /api/backup', () => {
  it('两个文件都读不到时 200 且两个字段都是 null', async () => {
    const app = makeApp(createStore({ request: null, status: null }));
    const cookie = await login(app);

    const res = await app.request('/api/backup', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ request: null, status: null });
  });

  it('请求与终态都在时原样透出整条 status', async () => {
    const app = makeApp(createStore({ request: REQUEST, status: STATUS }));
    const cookie = await login(app);

    const res = await app.request('/api/backup', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.request).toEqual(REQUEST);
    expect(body.status).toEqual(STATUS);
    // 终态字段一个都不能丢：这几个数正是后台「这次备份多大」的全部来源
    const status = body.status as Json;
    expect(status.bytes).toBe(247873);
    expect(status.keptRemote).toBe(3);
    expect(status.remote).toBe('gdrive:dc-ai-bot-backup');
  });

  it('只有状态文件（每日备份跑完、手动请求已消费）时 request 为 null', async () => {
    const daily: BackupStatus = { ...STATUS, source: 'daily' };
    const app = makeApp(createStore({ request: null, status: daily }));
    const cookie = await login(app);

    expect(await jsonOf(await app.request('/api/backup', { headers: { cookie } }))).toEqual({
      request: null,
      status: daily,
    });
  });
});

describe('POST /api/backup/run', () => {
  it('没有未处理请求时写一份新请求并回 { ok: true, request }', async () => {
    const app = makeApp(acceptingStore());
    const cookie = await login(app);

    const res = await app.request('/api/backup/run', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['ok', 'request']);

    const request = body.request as Json;
    expect(request.id).toBe(REQUEST_ID);
    expect(Number.isFinite(Date.parse(String(request.requestedAt)))).toBe(true);
    expect(String(request.requestedAt).endsWith('Z')).toBe(true);

    // 写完之后 GET 就能读到同一份（宿主 timer 也正是这么发现它的）
    expect(await jsonOf(await app.request('/api/backup', { headers: { cookie } }))).toEqual({
      request,
      status: null,
    });
  });

  it('已有未处理请求时 409 BACKUP_BUSY', async () => {
    const app = makeApp(busyStore());
    const cookie = await login(app);

    const res = await app.request('/api/backup/run', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: 'BACKUP_BUSY' });
  });

  it('非「忙」的写盘异常按 500 INTERNAL 收口，不把原始 message 漏给前端', async () => {
    const app = makeApp(brokenStore());
    const cookie = await login(app);

    const res = await app.request('/api/backup/run', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(500);
    expect(await jsonOf(res)).toEqual({ error: 'INTERNAL' });
  });
});
