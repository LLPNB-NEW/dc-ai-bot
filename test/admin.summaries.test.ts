import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BackfillOutcome,
  BackfillPreview,
  ChannelKey,
  ChatMessage,
  ConversationSummary,
  StoredMessage,
  SummaryOutcome,
  SummarySweepOutcome,
  TimeRange,
} from '../src/core/types';
import { RangeTooLargeError } from '../src/core/chat/service';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

// §25.3–§25.5：后台手改摘要的五条路由（成功/失败矩阵）

const MASTER_KEY = toBase64(new Uint8Array(32).fill(3));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

/** §25.4 只认雪花，所以这里的 key 全是纯数字（其余后台用例用的 g1/c1 在摘要路由上会被拒） */
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '333333333333333333';
const KEY: ChannelKey = { guildId: GUILD, channelId: CHANNEL };
const OTHER_KEY: ChannelKey = { guildId: GUILD, channelId: OTHER_CHANNEL };
// §35：补记的时间范围（ISO 文本，字典序即时间序）
const FROM = '2026-10-25T14:00:00.000Z';
const TO = '2026-10-25T15:00:00.000Z';
const RANGE: TimeRange = { from: FROM, to: TO };
const RANGE_PATH =
  '/api/summaries/range?guildId=' + GUILD + '&channelId=' + CHANNEL + '&from=' + encodeURIComponent(FROM) + '&to=' + encodeURIComponent(TO);

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface AppOptions {
  /** §25.5：装配层注入的重新总结；不传就是「未接线」，regenerate 端点应回 501 */
  summarizeChannel?: (key: ChannelKey) => Promise<SummaryOutcome | null>;
  /** §63：装配层注入的连续总结一批；不传就是「未接线」，sweep 端点应回 501 */
  summarizeSweep?: (key: ChannelKey) => Promise<SummarySweepOutcome>;
  /** 只替换 loadLatest：用来喂「仓储老数据没记 createdAt」这类真实 D1 造不出来的行 */
  loadLatest?: (key: ChannelKey, limit: number) => Promise<StoredMessage[]>;
  /** §35：装配层注入的范围预览；不传就是「未接线」，range 端点应回 501 */
  previewBackfill?: (key: ChannelKey, range: TimeRange) => Promise<BackfillPreview>;
  /** §35：装配层注入的补记；不传就是「未接线」，backfill 端点应回 501 */
  backfillSummary?: (key: ChannelKey, range: TimeRange) => Promise<BackfillOutcome | null>;
  /** §62：装配层注入的 Discord 侧删除；不传就是「未接线」，只在库里删 */
  pruneDiscordMessage?: (target: StoredMessage) => Promise<{ outcome: string; detail: string }>;
  /** §62：拿掉仓储的单行读/删，模拟老仓储，历史删除应回 501 */
  dropHistoryMethods?: boolean;
}

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

function makeApp(options: AppOptions = {}) {
  const deps: AdminAppDeps = {
    ...makeRepos(),
    logs: createLogStore(env.DB),
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
  };
  if (options.summarizeChannel !== undefined) deps.summarizeChannel = options.summarizeChannel;
  if (options.summarizeSweep !== undefined) deps.summarizeSweep = options.summarizeSweep;
  if (options.loadLatest !== undefined) deps.conversations = { ...deps.conversations, loadLatest: options.loadLatest };
  if (options.previewBackfill !== undefined) deps.previewBackfill = options.previewBackfill;
  if (options.backfillSummary !== undefined) deps.backfillSummary = options.backfillSummary;
  if (options.pruneDiscordMessage !== undefined) deps.pruneDiscordMessage = options.pruneDiscordMessage;
  if (options.dropHistoryMethods === true) {
    const store = { ...deps.conversations };
    delete store.getById;
    delete store.removeById;
    deps.conversations = store;
  }
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

async function setup(options: AppOptions = {}) {
  const app = makeApp(options);
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

/** 摘要游标上界就是 messages.id：用例必须先造出真实楼层，不能凭空编 id */
async function seedMessages(contents: string[]): Promise<number[]> {
  const { conversations } = makeRepos();
  const messages: ChatMessage[] = contents.map((content) => ({ role: 'user', content, author: '小明' }));
  await conversations.append(KEY, messages);
  return (await conversations.loadAfter(KEY, 0)).map((message) => message.id);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM conversation_summaries'),
  ]);
});

describe('摘要路由鉴权', () => {
  it('摘要与历史端点未登录一律 401', async () => {
    const app = makeApp();
    const calls: Array<[string, string]> = [
      ['GET', '/api/summaries'],
      ['GET', '/api/summaries/messages?guildId=' + GUILD + '&channelId=' + CHANNEL],
      ['PUT', '/api/summaries'],
      ['DELETE', '/api/summaries?guildId=' + GUILD + '&channelId=' + CHANNEL],
      ['POST', '/api/summaries/regenerate'],
      ['GET', '/api/summaries/range?guildId=' + GUILD + '&channelId=' + CHANNEL + '&from=' + FROM + '&to=' + TO],
      ['POST', '/api/summaries/backfill'],
      ['POST', '/api/summaries/sweep'],
      ['DELETE', '/api/messages/1'],
    ];
    for (const [method, path] of calls) {
      const res = await send(app, method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.status).toBe(401);
      expect(await jsonOf(res)).toEqual({ error: 'UNAUTHORIZED' });
    }
  });
});

describe('GET /api/summaries', () => {
  it('空表回空数组，保存后按 (guild, channel) 升序列出', async () => {
    const { app, cookie } = await setup();
    expect(await jsonOf(await get(app, '/api/summaries', cookie))).toEqual({ items: [] });

    const { summaries } = makeRepos();
    const first: ConversationSummary = {
      guildId: GUILD,
      channelId: OTHER_CHANNEL,
      summary: '别的频道',
      coveredUntilId: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const second: ConversationSummary = {
      guildId: GUILD,
      channelId: CHANNEL,
      summary: '本频道',
      coveredUntilId: 7,
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    await summaries.put(first);
    await summaries.put(second);

    // list() 的排序交给 SQL：频道号小的在前（§25.2），HTTP 层不再排一次
    const body = await jsonOf(await get(app, '/api/summaries', cookie));
    expect(body.items).toEqual([second, first]);
  });
});

describe('GET /api/summaries/messages', () => {
  it('按 id 升序回最近 limit 条，缺 author/createdAt 时不出键', async () => {
    const { app, cookie } = await setup();
    const { conversations } = makeRepos();
    await conversations.append(KEY, [
      { role: 'user', content: '第一句', author: '小明', createdAt: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: '第二句' },
      { role: 'user', content: '第三句', author: '小明' },
    ]);

    const res = await get(app, '/api/summaries/messages?guildId=' + GUILD + '&channelId=' + CHANNEL + '&limit=2', cookie);
    expect(res.status).toBe(200);
    const items = (await jsonOf(res)).items as Json[];
    expect(items.map((item) => item.content)).toEqual(['第二句', '第三句']);
    expect(typeof items[0]?.['id']).toBe('number');
    // 第二句没记 author/createdAt：键不出现，前端据此区分「没记」与「空串」
    expect(items[0]).not.toHaveProperty('author');
    expect(items[1]?.['author']).toBe('小明');
  });

  it('author / createdAt 缺失时不出键，有值时原样透出', async () => {
    const { app, cookie } = await setup({
      loadLatest: async () => [
        { id: 7, role: 'assistant', content: '没有元数据' },
        { id: 8, role: 'user', content: '有元数据', author: '小明', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    const res = await get(app, '/api/summaries/messages?guildId=' + GUILD + '&channelId=' + CHANNEL, cookie);
    expect(res.status).toBe(200);
    const items = (await jsonOf(res)).items as Json[];
    expect(items).toEqual([
      { id: 7, role: 'assistant', content: '没有元数据' },
      { id: 8, role: 'user', author: '小明', content: '有元数据', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('limit 非法或 ≤0 用缺省 50，超 200 按 200', async () => {
    const { app, cookie } = await setup();
    const contents = Array.from({ length: 205 }, (_unused, index) => '第' + (index + 1) + '条');
    await seedMessages(contents);

    const base = '/api/summaries/messages?guildId=' + GUILD + '&channelId=' + CHANNEL;
    const byDefault = (await jsonOf(await get(app, base, cookie))).items as Json[];
    expect(byDefault).toHaveLength(50);
    expect(byDefault[0]?.['content']).toBe('第156条');

    const bad = (await jsonOf(await get(app, base + '&limit=abc', cookie))).items as Json[];
    expect(bad).toHaveLength(50);

    const zero = (await jsonOf(await get(app, base + '&limit=0', cookie))).items as Json[];
    expect(zero).toHaveLength(50);

    const capped = (await jsonOf(await get(app, base + '&limit=999', cookie))).items as Json[];
    expect(capped).toHaveLength(200);
    expect(capped[0]?.['content']).toBe('第6条');
  });

  it('BAD_CHANNEL_KEY：缺参数或非雪花', async () => {
    const { app, cookie } = await setup();
    const paths = [
      '/api/summaries/messages',
      '/api/summaries/messages?guildId=' + GUILD,
      '/api/summaries/messages?guildId=g1&channelId=c1',
      '/api/summaries/messages?guildId=' + GUILD + '&channelId=' + 'x'.repeat(33),
    ];
    for (const path of paths) {
      const res = await get(app, path, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });
});

describe('PUT /api/summaries', () => {
  it('保存后回服务端 updatedAt，客户端传的时间被忽略', async () => {
    const { app, cookie } = await setup();
    const ids = await seedMessages(['一', '二']);

    const res = await send(
      app,
      'PUT',
      '/api/summaries',
      {
        guildId: GUILD,
        channelId: CHANNEL,
        summary: '  手改后的摘要  ',
        coveredUntilId: ids[1],
        // §25.4：客户端时间不认，服务端自己取 now
        updatedAt: '1999-01-01T00:00:00.000Z',
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    expect(saved['summary']).toBe('手改后的摘要');
    expect(saved['coveredUntilId']).toBe(ids[1]);
    expect(saved['updatedAt']).not.toBe('1999-01-01T00:00:00.000Z');
    expect(String(saved['updatedAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const listed = (await jsonOf(await get(app, '/api/summaries', cookie))).items as Json[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(saved);
  });

  it('覆盖写：同一频道只留一条', async () => {
    const { app, cookie } = await setup();
    const body = { guildId: GUILD, channelId: CHANNEL, summary: '第一版', coveredUntilId: 0 };
    expect((await send(app, 'PUT', '/api/summaries', body, cookie)).status).toBe(200);
    expect((await send(app, 'PUT', '/api/summaries', { ...body, summary: '第二版' }, cookie)).status).toBe(200);

    const listed = (await jsonOf(await get(app, '/api/summaries', cookie))).items as Json[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.['summary']).toBe('第二版');
  });

  it('coveredUntilId 允许纯数字串，0 = 从头重算', async () => {
    const { app, cookie } = await setup();
    const { conversations } = makeRepos();
    await conversations.append(KEY, [{ role: 'user', content: '一' }]);
    const ids = (await conversations.loadAfter(KEY, 0)).map((message) => message.id);

    const zero = await send(app, 'PUT', '/api/summaries', { guildId: GUILD, channelId: CHANNEL, summary: '从头', coveredUntilId: 0 }, cookie);
    expect(zero.status).toBe(200);
    const asString = await send(app, 'PUT', '/api/summaries', { guildId: GUILD, channelId: CHANNEL, summary: '字符串', coveredUntilId: String(ids[0]) }, cookie);
    expect(asString.status).toBe(200);
    expect((await jsonOf(asString))['coveredUntilId']).toBe(ids[0]);
  });

  it('BAD_SUMMARY：空串、全空白与超 8000 字；8000 字本身放行', async () => {
    const { app, cookie } = await setup();
    const rejected = ['', '   ', 'x'.repeat(8001)];
    for (const summary of rejected) {
      const res = await send(app, 'PUT', '/api/summaries', { guildId: GUILD, channelId: CHANNEL, summary, coveredUntilId: 0 }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_SUMMARY' });
    }

    const boundary = await send(app, 'PUT', '/api/summaries', { guildId: GUILD, channelId: CHANNEL, summary: 'x'.repeat(8000), coveredUntilId: 0 }, cookie);
    expect(boundary.status).toBe(200);
    expect(String((await jsonOf(boundary))['summary'])).toHaveLength(8000);
  });

  it('BAD_COVERED_UNTIL：负数、非整数、超过该频道最大 id', async () => {
    const { app, cookie } = await setup();
    const ids = await seedMessages(['一', '二']);
    const body = { guildId: GUILD, channelId: CHANNEL, summary: '摘要' };
    const rejected = [-1, 1.5, ids[1] + 1, 1e18];
    for (const coveredUntilId of rejected) {
      const res = await send(app, 'PUT', '/api/summaries', { ...body, coveredUntilId }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_COVERED_UNTIL' });
    }

    // 空频道上界是 0：0 能写，1 不能
    const emptyApp = await setup();
    const atZero = await send(emptyApp.app, 'PUT', '/api/summaries', { ...body, guildId: GUILD, channelId: OTHER_CHANNEL, coveredUntilId: 0 }, emptyApp.cookie);
    expect(atZero.status).toBe(200);
    const beyondEmpty = await send(emptyApp.app, 'PUT', '/api/summaries', { ...body, guildId: GUILD, channelId: OTHER_CHANNEL, coveredUntilId: 1 }, emptyApp.cookie);
    expect(beyondEmpty.status).toBe(400);
    expect(await jsonOf(beyondEmpty)).toEqual({ error: 'BAD_COVERED_UNTIL' });
  });

  it('BAD_CHANNEL_KEY：请求体坏掉、缺字段、非雪花都回同一个出口', async () => {
    const { app, cookie } = await setup();
    const broken = await app.request('/api/summaries', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: '{不是 JSON',
    });
    expect(broken.status).toBe(400);
    expect(await jsonOf(broken)).toEqual({ error: 'BAD_CHANNEL_KEY' });

    const bodies = [{ summary: 'x', coveredUntilId: 0 }, { guildId: GUILD, summary: 'x', coveredUntilId: 0 }, { guildId: 'g1', channelId: 'c1', summary: 'x', coveredUntilId: 0 }];
    for (const body of bodies) {
      const res = await send(app, 'PUT', '/api/summaries', body, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });
});

describe('DELETE /api/summaries', () => {
  it('删掉已有摘要；本来就没有也回 200', async () => {
    const { app, cookie } = await setup();
    const { summaries } = makeRepos();
    await summaries.put({ guildId: GUILD, channelId: CHANNEL, summary: '待删', coveredUntilId: 2, updatedAt: '2026-01-01T00:00:00.000Z' });

    const path = '/api/summaries?guildId=' + GUILD + '&channelId=' + CHANNEL;
    const res = await send(app, 'DELETE', path, undefined, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect(await summaries.get(KEY)).toBeNull();

    // 连点两下：第二次删 0 行也算成功
    const again = await send(app, 'DELETE', path, undefined, cookie);
    expect(again.status).toBe(200);
    expect(await jsonOf(again)).toEqual({ ok: true });
  });

  it('BAD_CHANNEL_KEY', async () => {
    const { app, cookie } = await setup();
    for (const path of ['/api/summaries', '/api/summaries?guildId=' + GUILD, '/api/summaries?guildId=g1&channelId=c1']) {
      const res = await send(app, 'DELETE', path, undefined, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });
});

describe('POST /api/summaries/regenerate', () => {
  it('未注入 summarizeChannel 回 501 SUMMARY_UNAVAILABLE', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'POST', '/api/summaries/regenerate', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(501);
    expect(await jsonOf(res)).toEqual({ error: 'SUMMARY_UNAVAILABLE' });
  });

  it('成功：回 SummaryOutcome，并把解析后的 key 交给 summarize', async () => {
    const seen: ChannelKey[] = [];
    const outcome: SummaryOutcome = { summary: '机器总结', coveredUntilId: 12, summarizedMessages: 3, model: 'gpt-test' };
    const { app, cookie } = await setup({
      summarizeChannel: async (key) => {
        seen.push(key);
        return outcome;
      },
    });

    const res = await send(app, 'POST', '/api/summaries/regenerate', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ outcome });
    expect(seen).toEqual([KEY]);
  });

  it('返回 null → 409 NO_SUMMARY_MATERIAL 且 outcome 为 null', async () => {
    const { app, cookie } = await setup({ summarizeChannel: async () => null });
    const res = await send(app, 'POST', '/api/summaries/regenerate', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: 'NO_SUMMARY_MATERIAL', outcome: null });
  });

  it('抛错 → 502 SUMMARY_FAILED，detail 截前 300 字', async () => {
    const message = '模型超时'.repeat(200);
    const { app, cookie } = await setup({
      summarizeChannel: async () => {
        throw new Error(message);
      },
    });
    const res = await send(app, 'POST', '/api/summaries/regenerate', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(502);
    const body = await jsonOf(res);
    expect(body['error']).toBe('SUMMARY_FAILED');
    const detail = String(body['detail']);
    expect(detail).toHaveLength(300);
    expect(message.startsWith(detail)).toBe(true);
  });

  it('BAD_CHANNEL_KEY', async () => {
    const { app, cookie } = await setup();
    for (const body of [{}, { guildId: GUILD }, { guildId: 'g1', channelId: 'c1' }]) {
      const res = await send(app, 'POST', '/api/summaries/regenerate', body, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });
});

describe('POST /api/summaries/sweep', () => {
  it('未注入 summarizeSweep 回 501 SUMMARY_UNAVAILABLE', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'POST', '/api/summaries/sweep', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(501);
    expect(await jsonOf(res)).toEqual({ error: 'SUMMARY_UNAVAILABLE' });
  });

  it('成功：回本批 outcome 与剩余条数，并把解析后的 key 交给 sweep', async () => {
    const seen: ChannelKey[] = [];
    const outcome: SummaryOutcome = { summary: '一批记忆', coveredUntilId: 500, summarizedMessages: 500, model: 'gpt-test' };
    const { app, cookie } = await setup({
      summarizeSweep: async (key) => {
        seen.push(key);
        return { outcome, remaining: 700 };
      },
    });

    const res = await send(app, 'POST', '/api/summaries/sweep', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ outcome, remaining: 700 });
    expect(seen).toEqual([KEY]);
  });

  it('本批没有素材 → 409 NO_SUMMARY_MATERIAL，但把 remaining 带上', async () => {
    const { app, cookie } = await setup({ summarizeSweep: async () => ({ outcome: null, remaining: 0 }) });
    const res = await send(app, 'POST', '/api/summaries/sweep', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: 'NO_SUMMARY_MATERIAL', outcome: null, remaining: 0 });
  });

  it('抛错 → 502 SUMMARY_FAILED，detail 截前 300 字', async () => {
    const message = '模型超时'.repeat(200);
    const { app, cookie } = await setup({
      summarizeSweep: async () => {
        throw new Error(message);
      },
    });
    const res = await send(app, 'POST', '/api/summaries/sweep', { guildId: GUILD, channelId: CHANNEL }, cookie);
    expect(res.status).toBe(502);
    const body = await jsonOf(res);
    expect(body['error']).toBe('SUMMARY_FAILED');
    const detail = String(body['detail']);
    expect(detail).toHaveLength(300);
    expect(message.startsWith(detail)).toBe(true);
  });

  it('BAD_CHANNEL_KEY', async () => {
    const { app, cookie } = await setup();
    for (const body of [{}, { guildId: GUILD }, { guildId: 'g1', channelId: 'c1' }]) {
      const res = await send(app, 'POST', '/api/summaries/sweep', body, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });
});

describe('GET /api/summaries/range', () => {
  it('未注入 previewBackfill 回 501 SUMMARY_UNAVAILABLE', async () => {
    const { app, cookie } = await setup();
    const res = await get(app, RANGE_PATH, cookie);
    expect(res.status).toBe(501);
    expect(await jsonOf(res)).toEqual({ error: 'SUMMARY_UNAVAILABLE' });
  });

  it('成功：回 BackfillPreview，并把解析后的 key 与范围交给 previewBackfill', async () => {
    const seen: Array<{ key: ChannelKey; range: TimeRange }> = [];
    const preview: BackfillPreview = {
      count: 3,
      tooLarge: false,
      firstAt: FROM,
      lastAt: TO,
      samples: ['[2026-10-25 22:00] 小明：第一句'],
    };
    const { app, cookie } = await setup({
      previewBackfill: async (key, range) => {
        seen.push({ key, range });
        return preview;
      },
    });

    const res = await get(app, RANGE_PATH, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual(preview);
    expect(seen).toEqual([{ key: KEY, range: RANGE }]);
  });

  it('BAD_CHANNEL_KEY', async () => {
    const { app, cookie } = await setup();
    const paths = [
      '/api/summaries/range',
      '/api/summaries/range?guildId=' + GUILD,
      '/api/summaries/range?guildId=g1&channelId=c1&from=' + encodeURIComponent(FROM) + '&to=' + encodeURIComponent(TO),
    ];
    for (const path of paths) {
      const res = await get(app, path, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });

  it('BAD_TIME_RANGE：缺端点、解析不了、from 晚于 to 都是 400（且比 501 先判）', async () => {
    const { app, cookie } = await setup();
    const base = '/api/summaries/range?guildId=' + GUILD + '&channelId=' + CHANNEL;
    const suffixes = [
      '',
      '&from=' + encodeURIComponent(FROM),
      '&from=abc&to=' + encodeURIComponent(TO),
      '&from=' + encodeURIComponent(TO) + '&to=' + encodeURIComponent(FROM),
    ];
    for (const suffix of suffixes) {
      const res = await get(app, base + suffix, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_TIME_RANGE' });
    }
  });
});

describe('POST /api/summaries/backfill', () => {
  const body = { guildId: GUILD, channelId: CHANNEL, from: FROM, to: TO };

  it('未注入 backfillSummary 回 501 SUMMARY_UNAVAILABLE', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'POST', '/api/summaries/backfill', body, cookie);
    expect(res.status).toBe(501);
    expect(await jsonOf(res)).toEqual({ error: 'SUMMARY_UNAVAILABLE' });
  });

  it('成功：回 { outcome }，并把 key 与范围交给 backfillSummary', async () => {
    const seen: Array<{ key: ChannelKey; range: TimeRange }> = [];
    const outcome: BackfillOutcome = {
      summarizedMessages: 3,
      from: FROM,
      to: TO,
      summaryLength: 42,
      model: 'gpt-test',
    };
    const { app, cookie } = await setup({
      backfillSummary: async (key, range) => {
        seen.push({ key, range });
        return outcome;
      },
    });

    const res = await send(app, 'POST', '/api/summaries/backfill', body, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ outcome });
    expect(seen).toEqual([{ key: KEY, range: RANGE }]);
  });

  it('返回 null → 409 NO_SUMMARY_MATERIAL 且 outcome 为 null', async () => {
    const { app, cookie } = await setup({ backfillSummary: async () => null });
    const res = await send(app, 'POST', '/api/summaries/backfill', body, cookie);
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: 'NO_SUMMARY_MATERIAL', outcome: null });
  });

  it('挑得太宽 → 400 RANGE_TOO_LARGE + 这一次的上限', async () => {
    const { app, cookie } = await setup({
      backfillSummary: async () => {
        throw new RangeTooLargeError(500);
      },
    });
    const res = await send(app, 'POST', '/api/summaries/backfill', body, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'RANGE_TOO_LARGE', limit: 500 });
  });

  it('抛错 → 502 SUMMARY_FAILED，detail 截前 300 字', async () => {
    const message = '模型超时'.repeat(200);
    const { app, cookie } = await setup({
      backfillSummary: async () => {
        throw new Error(message);
      },
    });
    const res = await send(app, 'POST', '/api/summaries/backfill', body, cookie);
    expect(res.status).toBe(502);
    const parsed = await jsonOf(res);
    expect(parsed['error']).toBe('SUMMARY_FAILED');
    const detail = String(parsed['detail']);
    expect(detail).toHaveLength(300);
    expect(message.startsWith(detail)).toBe(true);
  });

  it('BAD_CHANNEL_KEY：body 坏掉也走这个出口', async () => {
    const { app, cookie } = await setup();
    const bodies: unknown[] = [{}, { guildId: GUILD }, { guildId: 'g1', channelId: 'c1' }];
    for (const item of bodies) {
      const res = await send(app, 'POST', '/api/summaries/backfill', item, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_CHANNEL_KEY' });
    }
  });

  it('BAD_TIME_RANGE：缺端点、解析不了、from 晚于 to 都是 400', async () => {
    const { app, cookie } = await setup();
    const bodies: unknown[] = [
      { guildId: GUILD, channelId: CHANNEL },
      { guildId: GUILD, channelId: CHANNEL, from: FROM },
      { guildId: GUILD, channelId: CHANNEL, from: 'abc', to: TO },
      { guildId: GUILD, channelId: CHANNEL, from: TO, to: FROM },
      { guildId: GUILD, channelId: CHANNEL, from: 1, to: 2 },
    ];
    for (const item of bodies) {
      const res = await send(app, 'POST', '/api/summaries/backfill', item, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_TIME_RANGE' });
    }
  });
});
