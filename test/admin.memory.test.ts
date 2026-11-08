import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX_CHARS } from '../src/core/chat/summary';
import type { ChannelMemoryStore } from '../src/core/ports';
import type { ChannelKey, ChannelMemoryConfig } from '../src/core/types';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

// §26.4：后台四条频道记忆配置路由（成功 / 400 / 401 矩阵）

const MASTER_KEY = toBase64(new Uint8Array(32).fill(5));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

/** §26.4 只认雪花，所以这里的 key 全是纯数字（与 admin.summaries.test.ts 同一口径） */
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '333333333333333333';
const KEY: ChannelKey = { guildId: GUILD, channelId: CHANNEL };
const OTHER_KEY: ChannelKey = { guildId: GUILD, channelId: OTHER_CHANNEL };

/**
 * 装配层传进来的兜底值：故意不用 50/50，否则「回默认值」的用例分不清
 * 是读了 deps.memoryDefaults 还是 HTTP 层自己写死了常量。
 */
const MEMORY_DEFAULTS = { historyMaxMessages: 30, summaryEveryMessages: 40 };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * §26.2 的 D1 实现由并行的另一路交付，这组用例只验 HTTP 层，所以用同一份语义的最小内存实现：
 * 一个频道一行（覆盖写）、updatedAt 由 store 按写入时刻补、list 按 (guildId, channelId) 升序。
 */
function createMemoryStore(): ChannelMemoryStore {
  const rows = new Map<string, ChannelMemoryConfig>();
  const idOf = (key: ChannelKey): string => key.guildId + '/' + key.channelId;
  return {
    async get(key) {
      return rows.get(idOf(key)) ?? null;
    },
    async list() {
      return [...rows.values()].sort((a, b) =>
        a.guildId === b.guildId
          ? a.channelId.localeCompare(b.channelId)
          : a.guildId.localeCompare(b.guildId),
      );
    },
    async put(cfg) {
      // updatedAt 一律 store 侧取当前时刻：HTTP 层与客户端都不传（§26.4）
      const saved: ChannelMemoryConfig = { ...cfg, updatedAt: new Date().toISOString() };
      rows.set(idOf(cfg), saved);
      return { ...saved };
    },
    async remove(key) {
      rows.delete(idOf(key));
    },
  };
}

function makeApp(store: ChannelMemoryStore = createMemoryStore()) {
  const deps: AdminAppDeps = {
    ...createRepositories(env.DB, createSecretBox(MASTER_KEY)),
    logs: createLogStore(env.DB),
    channelMemory: store,
    memoryDefaults: MEMORY_DEFAULTS,
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
  };
  return createAdminApp(deps);
}

type App = ReturnType<typeof makeApp>;
type Json = Record<string, unknown>;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function send(app: App, method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie !== undefined) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

async function get(app: App, path: string, cookie: string): Promise<Response> {
  return app.request(path, { headers: { cookie } });
}

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function itemsOf(app: App, cookie: string): Promise<Json[]> {
  return (await jsonOf(await get(app, '/api/memory-settings', cookie))).items as Json[];
}

function channelPath(key: ChannelKey): string {
  return '/api/memory-settings/channel?guildId=' + key.guildId + '&channelId=' + key.channelId;
}

async function setup() {
  const app = makeApp();
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

function putBody(overrides: Json = {}): Json {
  return { guildId: GUILD, channelId: CHANNEL, historyMaxMessages: 80, summaryEveryMessages: 20, ...overrides };
}

describe('记忆配置路由鉴权', () => {
  it('四条端点未登录一律 401', async () => {
    const app = makeApp();
    const calls: Array<[string, string]> = [
      ['GET', '/api/memory-settings'],
      ['GET', channelPath(KEY)],
      ['PUT', '/api/memory-settings'],
      ['DELETE', '/api/memory-settings?guildId=' + GUILD + '&channelId=' + CHANNEL],
    ];
    for (const [method, path] of calls) {
      const res = await send(app, method, path, method === 'GET' || method === 'DELETE' ? undefined : putBody());
      expect(res.status).toBe(401);
      expect(await jsonOf(res)).toEqual({ error: 'UNAUTHORIZED' });
    }
    // 匿名 PUT 不该落库：登录后列表仍是空的
    const cookieRes = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
    const cookie = 'admin_session=' + (/admin_session=([^;]*)/.exec(cookieRes.headers.get('set-cookie') ?? '')?.[1] ?? '');
    expect(await itemsOf(app, cookie)).toEqual([]);
  });
});

describe('GET /api/memory-settings', () => {
  it('空表回 { items: [] }', async () => {
    const { app, cookie } = await setup();
    expect(await jsonOf(await get(app, '/api/memory-settings', cookie))).toEqual({ items: [] });
  });

  it('PUT 后列表有 1 条，且与 PUT 回的整行一致（updatedAt 由服务端补）', async () => {
    const { app, cookie } = await setup();

    const put = await send(app, 'PUT', '/api/memory-settings', putBody({ updatedAt: '1999-01-01T00:00:00.000Z' }), cookie);
    expect(put.status).toBe(200);
    const saved = await jsonOf(put);
    expect(saved.guildId).toBe(GUILD);
    expect(saved.channelId).toBe(CHANNEL);
    expect(saved.historyMaxMessages).toBe(80);
    expect(saved.summaryEveryMessages).toBe(20);
    // §26.4：客户端传的 updatedAt 一概不认，服务端取当前时刻
    expect(saved.updatedAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(typeof saved.updatedAt).toBe('string');
    expect(Number.isFinite(Date.parse(String(saved.updatedAt)))).toBe(true);

    expect(await itemsOf(app, cookie)).toEqual([saved]);
  });

  it('同 key 覆盖写只更新不新增', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/memory-settings', putBody(), cookie);
    const again = await send(app, 'PUT', '/api/memory-settings', putBody({ historyMaxMessages: 500, summaryEveryMessages: 0 }), cookie);
    expect(again.status).toBe(200);

    const items = await itemsOf(app, cookie);
    expect(items).toHaveLength(1);
    expect(items[0]?.historyMaxMessages).toBe(500);
    expect(items[0]?.summaryEveryMessages).toBe(0);
  });
});

describe('GET /api/memory-settings/channel', () => {
  it('没有行时回默认值：条数与阈值来自 deps.memoryDefaults，预算来自 SUMMARY_MAX_CHARS，updatedAt 为空串', async () => {
    const { app, cookie } = await setup();
    const res = await get(app, channelPath(KEY), cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      config: {
        guildId: GUILD,
        channelId: CHANNEL,
        historyMaxMessages: MEMORY_DEFAULTS.historyMaxMessages,
        summaryEveryMessages: MEMORY_DEFAULTS.summaryEveryMessages,
        summaryMaxChars: SUMMARY_MAX_CHARS,
        contextTool: false,
        updatedAt: '',
      },
    });
  });

  it('保存后回保存值（updatedAt 非空）', async () => {
    const { app, cookie } = await setup();
    const saved = await jsonOf(await send(app, 'PUT', '/api/memory-settings', putBody(), cookie));

    const res = await get(app, channelPath(KEY), cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.config).toEqual(saved);

    // 别的频道不受影响，仍是默认值
    const other = await jsonOf(await get(app, channelPath(OTHER_KEY), cookie));
    expect((other.config as Json).updatedAt).toBe('');
    expect((other.config as Json).historyMaxMessages).toBe(MEMORY_DEFAULTS.historyMaxMessages);
  });

  it('缺 / 空 / 非雪花 guildId、channelId 一律 400 BAD_CHANNEL_KEY', async () => {
    const { app, cookie } = await setup();
    const paths = [
      '/api/memory-settings/channel',
      '/api/memory-settings/channel?guildId=' + GUILD,
      '/api/memory-settings/channel?guildId=&channelId=' + CHANNEL,
      '/api/memory-settings/channel?guildId=%20&channelId=' + CHANNEL,
      '/api/memory-settings/channel?guildId=abc&channelId=' + CHANNEL,
      '/api/memory-settings/channel?guildId=' + GUILD + '&channelId=' + '1'.repeat(33),
    ];
    for (const path of paths) {
      const res = await get(app, path, cookie);
      expect(res.status, path).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });
});

describe('PUT /api/memory-settings', () => {
  it('边界值 2 与 500 都通过', async () => {
    const { app, cookie } = await setup();
    for (const n of [2, 500]) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody({ historyMaxMessages: n, summaryEveryMessages: n }), cookie);
      expect(res.status, String(n)).toBe(200);
      const saved = await jsonOf(res);
      expect(saved.historyMaxMessages).toBe(n);
      expect(saved.summaryEveryMessages).toBe(n);
    }
  });

  it('纯数字串照收，回的是数字', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'PUT', '/api/memory-settings', putBody({ historyMaxMessages: '2', summaryEveryMessages: '500' }), cookie);
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    expect(saved.historyMaxMessages).toBe(2);
    expect(saved.summaryEveryMessages).toBe(500);
  });

  it('summaryEveryMessages = 0 是「关闭自动总结」：200 并存下来', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'PUT', '/api/memory-settings', putBody({ historyMaxMessages: 50, summaryEveryMessages: 0 }), cookie);
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).summaryEveryMessages).toBe(0);

    const body = await jsonOf(await get(app, channelPath(KEY), cookie));
    expect((body.config as Json).summaryEveryMessages).toBe(0);
    expect((body.config as Json).updatedAt).not.toBe('');
  });

  it('historyMaxMessages 只卡下界（1 / 0）→ 400 BAD_MEMORY_SETTINGS', async () => {
    const { app, cookie } = await setup();
    for (const n of [1, 0]) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody({ historyMaxMessages: n }), cookie);
      expect(res.status, String(n)).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_MEMORY_SETTINGS' });
    }
  });

  it('historyMaxMessages 没有上限：501 / 5000 / 100000 都保存成功并按原值读回', async () => {
    const { app, cookie } = await setup();
    for (const n of [501, 5000, 100000]) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody({ historyMaxMessages: n }), cookie);
      expect(res.status, String(n)).toBe(200);
      expect((await jsonOf(res)).historyMaxMessages).toBe(n);
      const body = await jsonOf(await get(app, channelPath(KEY), cookie));
      expect((body.config as Json).historyMaxMessages, String(n)).toBe(n);
    }
  });

  it('summaryEveryMessages 只卡下界（1）→ 400 BAD_MEMORY_SETTINGS', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'PUT', '/api/memory-settings', putBody({ summaryEveryMessages: 1 }), cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_MEMORY_SETTINGS' });
  });

  it('summaryEveryMessages 没有上限：501 / 100000 都保存成功并原值读回', async () => {
    const { app, cookie } = await setup();
    for (const n of [501, 100000]) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody({ summaryEveryMessages: n }), cookie);
      expect(res.status, String(n)).toBe(200);
      expect((await jsonOf(res)).summaryEveryMessages).toBe(n);
      const body = await jsonOf(await get(app, channelPath(KEY), cookie));
      expect((body.config as Json).summaryEveryMessages, String(n)).toBe(n);
    }
  });

  it('小数 / 布尔 / 缺字段 → 400 BAD_MEMORY_SETTINGS，且一行都没写进去', async () => {
    const { app, cookie } = await setup();
    const bads: Json[] = [
      { historyMaxMessages: 2.5 },
      { summaryEveryMessages: 2.5 },
      { historyMaxMessages: true },
      { summaryEveryMessages: null },
      { historyMaxMessages: '3.0' },
      { historyMaxMessages: '-2' },
      { summaryEveryMessages: '  ' },
    ];
    for (const bad of bads) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody(bad), cookie);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_MEMORY_SETTINGS' });
    }
    expect(await itemsOf(app, cookie)).toEqual([]);
  });

  it('summaryMaxChars 边界 500 与 20000 都通过，GET channel 读回同一个数', async () => {
    const { app, cookie } = await setup();
    for (const n of [500, 20000]) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody({ summaryMaxChars: n }), cookie);
      expect(res.status, String(n)).toBe(200);
      expect((await jsonOf(res)).summaryMaxChars).toBe(n);
      const body = await jsonOf(await get(app, channelPath(KEY), cookie));
      expect((body.config as Json).summaryMaxChars, String(n)).toBe(n);
    }
  });

  it('summaryMaxChars 越界（499 / 20001 / -1 / "abc" / 2.5 / true）→ 400 BAD_MEMORY_SETTINGS，一行都不写', async () => {
    const { app, cookie } = await setup();
    const bads: unknown[] = [499, 20001, -1, 'abc', 2.5, true];
    for (const bad of bads) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody({ summaryMaxChars: bad }), cookie);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_MEMORY_SETTINGS' });
    }
    expect(await itemsOf(app, cookie)).toEqual([]);
  });

  it('不传与传 0 都算「未设置」：照样保存成功，回读不带 summaryMaxChars', async () => {
    const { app, cookie } = await setup();

    const absent = await send(app, 'PUT', '/api/memory-settings', putBody(), cookie);
    expect(absent.status).toBe(200);
    expect('summaryMaxChars' in (await jsonOf(absent))).toBe(false);

    const zero = await send(app, 'PUT', '/api/memory-settings', putBody({ summaryMaxChars: 0 }), cookie);
    expect(zero.status).toBe(200);
    expect('summaryMaxChars' in (await jsonOf(zero))).toBe(false);

    // 这行确实落库了（条数与阈值都在），只是预算按「未设置」处理
    const items = await itemsOf(app, cookie);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('summaryMaxChars');
    const body = await jsonOf(await get(app, channelPath(KEY), cookie));
    expect((body.config as Json).historyMaxMessages).toBe(80);
    expect((body.config as Json).updatedAt).not.toBe('');
  });

  it('body 不是 JSON 对象或缺 channel key → 400 BAD_CHANNEL_KEY（与缺参数同出口）', async () => {
    const { app, cookie } = await setup();
    const brokenJson = await app.request('/api/memory-settings', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, cookie },
      body: '{not json',
    });
    expect(brokenJson.status).toBe(400);
    expect(await jsonOf(brokenJson)).toEqual({ error: 'BAD_CHANNEL_KEY' });

    const arrayBody = await send(app, 'PUT', '/api/memory-settings', [putBody()], cookie);
    expect(arrayBody.status).toBe(400);
    expect(await jsonOf(arrayBody)).toEqual({ error: 'BAD_CHANNEL_KEY' });

    const bads: Json[] = [
      {},
      { guildId: GUILD },
      { channelId: CHANNEL },
      { guildId: 'abc', channelId: CHANNEL },
      { guildId: GUILD, channelId: '12 34' },
      { guildId: '1'.repeat(33), channelId: CHANNEL },
    ];
    for (const bad of bads) {
      const res = await send(app, 'PUT', '/api/memory-settings', bad, cookie);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
    expect(await itemsOf(app, cookie)).toEqual([]);
  });
});

describe('PUT /api/memory-settings 的上下文工具模式（§55）', () => {
  it('不传 = 关：PUT 回 false，GET channel 与列表也带 false', async () => {
    const { app, cookie } = await setup();
    const saved = await send(app, 'PUT', '/api/memory-settings', putBody(), cookie);
    expect(saved.status).toBe(200);
    expect((await jsonOf(saved)).contextTool).toBe(false);

    const config = (await jsonOf(await get(app, channelPath(KEY), cookie))).config as Json;
    expect(config.contextTool).toBe(false);
    expect((await itemsOf(app, cookie))[0]?.contextTool).toBe(false);
  });

  it('传 true 存下来：PUT 回 true，GET channel 与列表读回同一个值', async () => {
    const { app, cookie } = await setup();
    const saved = await send(app, 'PUT', '/api/memory-settings', putBody({ contextTool: true }), cookie);
    expect(saved.status).toBe(200);
    expect((await jsonOf(saved)).contextTool).toBe(true);

    const config = (await jsonOf(await get(app, channelPath(KEY), cookie))).config as Json;
    expect(config.contextTool).toBe(true);
    expect((await itemsOf(app, cookie))[0]?.contextTool).toBe(true);

    // 再显式传 false：覆盖写要把开关关回去
    const off = await send(app, 'PUT', '/api/memory-settings', putBody({ contextTool: false }), cookie);
    expect(off.status).toBe(200);
    expect((await jsonOf(off)).contextTool).toBe(false);
    expect(((await jsonOf(await get(app, channelPath(KEY), cookie))).config as Json).contextTool).toBe(false);
  });

  it('非 boolean（1 / 0 / "true" / null）→ 400 BAD_CONTEXT_TOOL，且一行都不写', async () => {
    const { app, cookie } = await setup();
    const bads: unknown[] = [1, 0, 'true', 'false', null, {}];
    for (const bad of bads) {
      const res = await send(app, 'PUT', '/api/memory-settings', putBody({ contextTool: bad }), cookie);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      // §55：类型不对单独一个错误码，不混进 BAD_MEMORY_SETTINGS
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CONTEXT_TOOL' });
    }
    expect(await itemsOf(app, cookie)).toEqual([]);
  });
});

describe('DELETE /api/memory-settings', () => {
  it('删掉后 GET channel 回到默认值（updatedAt 空串）', async () => {
    const { app, cookie } = await setup();
    await send(app, 'PUT', '/api/memory-settings', putBody(), cookie);
    expect(await itemsOf(app, cookie)).toHaveLength(1);

    const del = await send(app, 'DELETE', '/api/memory-settings?guildId=' + GUILD + '&channelId=' + CHANNEL, undefined, cookie);
    expect(del.status).toBe(200);
    expect(await jsonOf(del)).toEqual({ ok: true });

    expect(await itemsOf(app, cookie)).toEqual([]);
    expect(await jsonOf(await get(app, channelPath(KEY), cookie))).toEqual({
      config: {
        guildId: GUILD,
        channelId: CHANNEL,
        historyMaxMessages: MEMORY_DEFAULTS.historyMaxMessages,
        summaryEveryMessages: MEMORY_DEFAULTS.summaryEveryMessages,
        summaryMaxChars: SUMMARY_MAX_CHARS,
        contextTool: false,
        updatedAt: '',
      },
    });
  });

  it('删不存在的也 200', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'DELETE', '/api/memory-settings?guildId=' + GUILD + '&channelId=' + CHANNEL, undefined, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
  });

  it('缺 / 坏参数 → 400 BAD_CHANNEL_KEY', async () => {
    const { app, cookie } = await setup();
    const paths = [
      '/api/memory-settings',
      '/api/memory-settings?guildId=' + GUILD,
      '/api/memory-settings?guildId=&channelId=' + CHANNEL,
      '/api/memory-settings?guildId=abc&channelId=' + CHANNEL,
    ];
    for (const path of paths) {
      const res = await send(app, 'DELETE', path, undefined, cookie);
      expect(res.status, path).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });
});
