import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { QqQuoteEntry } from '../src/core/ports';
import type { ChatMessage, ChannelKey, PromptSegment } from '../src/core/types';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';

// §48 QQ 桥接：会话目录仓储 + 后台 HTTP 契约。
// 记忆仍然住在 messages / conversation_summaries / channel_memory_settings，按 (guild_id, channel_id) 分；
// 这里验的就是「QQ 用合成键、绑定时把数据搬进 Discord 的真实键」这条不变量。

const MASTER_KEY = toBase64(new Uint8Array(32).fill(3));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const OTHER_GUILD = '999999999999999999';
const DISCORD_KEY: ChannelKey = { guildId: GUILD, channelId: CHANNEL };

const MEMORY_DEFAULTS = { historyMaxMessages: 50, summaryEveryMessages: 50 };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

function makeApp() {
  const deps: AdminAppDeps = {
    ...makeRepos(),
    logs: createLogStore(env.DB),
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

/** 故意发一段坏 JSON：验 readJsonBody 的 400，而不是 500 */
async function sendRaw(app: App, method: string, path: string, raw: string, cookie: string): Promise<Response> {
  return app.request(path, { method, headers: { ...JSON_HEADERS, cookie }, body: raw });
}

async function get(app: App, path: string, cookie: string): Promise<Response> {
  return app.request(path, { headers: { cookie } });
}

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function setup() {
  const app = makeApp();
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, cookie: 'admin_session=' + value };
}

/** updated_at 只到毫秒：连着写两次要让它真的往前挪 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function segment(id = 'seg-1', content = '你是群里的机器人'): PromptSegment {
  return { id, name: '开场', role: 'system', content, enabled: true, placement: 'before', position: 0 };
}

async function seedMessages(key: ChannelKey, count: number): Promise<void> {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: '消息 ' + String(index + 1) });
  }
  await makeRepos().conversations.append(key, messages);
}

async function countMessages(key: ChannelKey): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE guild_id = ? AND channel_id = ?')
    .bind(key.guildId, key.channelId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM conversation_summaries'),
    env.DB.prepare('DELETE FROM channel_memory_settings'),
    env.DB.prepare('DELETE FROM conversation_links'),
    env.DB.prepare('DELETE FROM conversations'),
    env.DB.prepare('DELETE FROM qq_presets'),
    env.DB.prepare('DELETE FROM qq_quote_index'),
  ]);
});

describe('会话目录仓储：QQ 自动登记', () => {
  it('QQ 群首次登记建会话 + qq:group 合成键，重复登记只刷新 lastSeenAt', async () => {
    const { conversationDirectory } = makeRepos();
    const first = await conversationDirectory.ensureLink({
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'GROUP-OPENID-1',
      displayName: '跑团群',
    });

    expect(first.memoryGuildId).toBe('qq:group');
    expect(first.memoryChannelId).toBe('GROUP-OPENID-1');
    expect(first.name).toBe('跑团群');
    expect(first.presetId).toBeNull();
    expect(first.links).toHaveLength(1);
    expect(first.links[0].platform).toBe('qq');
    expect(first.links[0].kind).toBe('qq_group');
    expect(first.links[0].externalId).toBe('GROUP-OPENID-1');
    expect(first.links[0].lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await tick();
    const again = await conversationDirectory.ensureLink({
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'GROUP-OPENID-1',
      displayName: '跑团群（改名）',
    });
    // 幂等：会话还是那一条；已有显示名保留，只刷新 lastSeenAt
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('跑团群');
    expect(again.links).toHaveLength(1);
    expect(again.links[0].displayName).toBe('跑团群');
    expect(again.links[0].lastSeenAt > first.links[0].lastSeenAt).toBe(true);
    expect(await conversationDirectory.list()).toHaveLength(1);
    expect(await countMessages({ guildId: 'qq:group', channelId: 'GROUP-OPENID-1' })).toBe(0);
  });

  it('ensureLink 保留自定义显示名，只给空显示名补位', async () => {
    const { conversationDirectory } = makeRepos();
    const first = await conversationDirectory.ensureLink({
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'GROUP-KEEP',
      displayName: '自定义群名',
    });
    await tick();
    // QQ 适配器每条消息都带自动名：已有非空显示名不能被它改回去
    const again = await conversationDirectory.ensureLink({
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'GROUP-KEEP',
      displayName: 'QQ群·abc123',
    });
    expect(again.id).toBe(first.id);
    expect(again.links[0].displayName).toBe('自定义群名');
    expect(again.links[0].lastSeenAt > first.links[0].lastSeenAt).toBe(true);

    // 之前是空串时才由本次的名字补上
    const blank = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_c2c', externalId: 'USER-KEEP' });
    expect(blank.links[0].displayName).toBe('');
    const filled = await conversationDirectory.ensureLink({
      platform: 'qq',
      kind: 'qq_c2c',
      externalId: 'USER-KEEP',
      displayName: '小明',
    });
    expect(filled.links[0].displayName).toBe('小明');
  });

  it('QQ 单聊用 qq:c2c 合成键，默认名字可读', async () => {
    const { conversationDirectory } = makeRepos();
    const record = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_c2c', externalId: 'USER-OPENID-1' });
    expect(record.memoryGuildId).toBe('qq:c2c');
    expect(record.memoryChannelId).toBe('USER-OPENID-1');
    expect(record.name).toBe('QQ 单聊 USER-OPENID-1');
  });

  it('Discord 频道登记的记忆键就是真实 (guildId, channelId)', async () => {
    const { conversationDirectory } = makeRepos();
    const record = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });
    expect(record.memoryGuildId).toBe(GUILD);
    expect(record.memoryChannelId).toBe(CHANNEL);
    expect(record.name).toBe('Discord 频道 ' + CHANNEL);
    expect(record.links[0].kind).toBe('discord_channel');
  });

  it('同一记忆键已有会话时复用（0038 迁回来的 Discord 会话不能被新插一条撞 UNIQUE）', async () => {
    const { conversationDirectory } = makeRepos();
    await env.DB.prepare(
      'INSERT INTO conversations (id, name, preset_id, memory_guild_id, memory_channel_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    )
      .bind('conv-legacy', '老频道', GUILD, CHANNEL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      .run();

    const record = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });
    expect(record.id).toBe('conv-legacy');
    expect(record.name).toBe('老频道');
    expect(record.links).toHaveLength(1);
    expect(await conversationDirectory.list()).toHaveLength(1);
  });

  it('list 按 updated_at 倒序，links 按 platform / kind / external_id 升序', async () => {
    const { conversationDirectory } = makeRepos();
    const qq = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-A' });
    await tick();
    const discord = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });
    expect((await conversationDirectory.list()).map((item) => item.id)).toEqual([discord.id, qq.id]);

    // 再挂一条 QQ 单聊链接，并且刷新 QQ 会话的 updated_at → 它应回到最前
    await tick();
    const bound = await conversationDirectory.bind(qq.id, { platform: 'qq', kind: 'qq_c2c', externalId: 'USER-A' });
    expect(bound.links.map((link) => link.kind)).toEqual(['qq_c2c', 'qq_group']);
    expect((await conversationDirectory.list()).map((item) => item.id)).toEqual([qq.id, discord.id]);
  });
});

describe('会话目录仓储：绑定 / 合并 / 删除', () => {
  it('QQ 绑到 Discord 会话并 merge：原文与摘要搬进 Discord 键，来源会话消失，链接改指向', async () => {
    const repos = makeRepos();
    const { conversationDirectory } = repos;
    const qq = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-M' });
    await seedMessages({ guildId: 'qq:group', channelId: 'GROUP-M' }, 2);
    await repos.summaries.put({
      guildId: 'qq:group',
      channelId: 'GROUP-M',
      summary: 'QQ 群里的旧摘要',
      coveredUntilId: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const discord = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });

    const merged = await conversationDirectory.bind(discord.id, {
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'GROUP-M',
      merge: true,
    });

    expect(merged.id).toBe(discord.id);
    expect(merged.links.map((link) => link.kind).sort()).toEqual(['discord_channel', 'qq_group']);
    expect(await conversationDirectory.get(qq.id)).toBeNull();
    expect(await countMessages({ guildId: 'qq:group', channelId: 'GROUP-M' })).toBe(0);
    expect(await countMessages(DISCORD_KEY)).toBe(2);
    expect((await repos.summaries.get(DISCORD_KEY))?.summary).toBe('QQ 群里的旧摘要');
    expect((await conversationDirectory.getByLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-M' }))?.id).toBe(
      discord.id,
    );
  });

  it('merge=false 只在来源没有历史时挪链接：有原文或摘要就拒，空了才删来源会话', async () => {
    const repos = makeRepos();
    const { conversationDirectory } = repos;
    const qq = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-B' });
    const qqKey = { guildId: 'qq:group', channelId: 'GROUP-B' };
    await seedMessages(qqKey, 1);
    const discord = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });

    // 有原文：拒绝，链接一条不动，历史仍读得到
    await expect(
      conversationDirectory.bind(discord.id, { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-B' }),
    ).rejects.toThrow('CONVERSATION_HAS_HISTORY');
    expect((await conversationDirectory.getByLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-B' }))?.id).toBe(
      qq.id,
    );
    expect(await countMessages(qqKey)).toBe(1);

    // 只剩摘要也算历史
    await env.DB.prepare('DELETE FROM messages WHERE guild_id = ? AND channel_id = ?')
      .bind(qqKey.guildId, qqKey.channelId)
      .run();
    await repos.summaries.put({
      ...qqKey,
      summary: '只剩摘要',
      coveredUntilId: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(
      conversationDirectory.bind(discord.id, { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-B' }),
    ).rejects.toThrow('CONVERSATION_HAS_HISTORY');

    // 数据清空后才只挪链接；没有别的入口的空来源会话被顺手删掉
    await env.DB.prepare('DELETE FROM conversation_summaries WHERE guild_id = ? AND channel_id = ?')
      .bind(qqKey.guildId, qqKey.channelId)
      .run();
    const moved = await conversationDirectory.bind(discord.id, {
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'GROUP-B',
    });
    expect(moved.links.map((link) => link.kind)).toEqual(['discord_channel', 'qq_group']);
    expect(await conversationDirectory.get(qq.id)).toBeNull();
    expect(await countMessages(DISCORD_KEY)).toBe(0);
  });

  it('两边都有摘要时拒绝合并（SUMMARY_CONFLICT），且一条数据都不动', async () => {
    const repos = makeRepos();
    const { conversationDirectory } = repos;
    const qq = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-C' });
    await seedMessages({ guildId: 'qq:group', channelId: 'GROUP-C' }, 1);
    await repos.summaries.put({
      guildId: 'qq:group',
      channelId: 'GROUP-C',
      summary: '来源摘要',
      coveredUntilId: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const discord = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });
    await repos.summaries.put({ ...DISCORD_KEY, summary: '目标摘要', coveredUntilId: 0, updatedAt: '2026-01-01T00:00:00.000Z' });

    await expect(
      conversationDirectory.bind(discord.id, {
        platform: 'qq',
        kind: 'qq_group',
        externalId: 'GROUP-C',
        merge: true,
      }),
    ).rejects.toThrow('SUMMARY_CONFLICT');

    expect(await countMessages({ guildId: 'qq:group', channelId: 'GROUP-C' })).toBe(1);
    expect((await conversationDirectory.get(qq.id))?.links).toHaveLength(1);
    expect((await conversationDirectory.getByLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-C' }))?.id).toBe(
      qq.id,
    );
  });

  it('Discord 链接只能绑在自己的真实记忆键上，否则 DISCORD_CONVERSATION_MISMATCH', async () => {
    const { conversationDirectory } = makeRepos();
    const target = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });
    await expect(
      conversationDirectory.bind(target.id, {
        platform: 'discord',
        kind: 'discord_channel',
        externalId: CHANNEL,
        guildId: OTHER_GUILD,
      }),
    ).rejects.toThrow('DISCORD_CONVERSATION_MISMATCH');
    // 记忆键没被改写
    expect((await conversationDirectory.get(target.id))?.memoryGuildId).toBe(GUILD);
  });

  it('merge 拒绝把带 Discord 链接的会话搬到另一个记忆键，数据一行不动', async () => {
    const repos = makeRepos();
    const { conversationDirectory } = repos;
    const source = await conversationDirectory.ensureLink({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: CHANNEL,
      guildId: GUILD,
    });
    await seedMessages(DISCORD_KEY, 1);
    const target = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-G' });
    const targetKey = { guildId: 'qq:group', channelId: 'GROUP-G' };

    await expect(conversationDirectory.merge(source.id, target.id)).rejects.toThrow('DISCORD_CONVERSATION_MISMATCH');

    expect((await conversationDirectory.get(source.id))?.links.map((link) => link.kind)).toEqual(['discord_channel']);
    expect((await conversationDirectory.get(target.id))?.links.map((link) => link.kind)).toEqual(['qq_group']);
    expect(await countMessages(DISCORD_KEY)).toBe(1);
    expect(await countMessages(targetKey)).toBe(0);
    // 同一条会话（同键）仍是恒等操作，不触发护栏
    expect((await conversationDirectory.merge(source.id, source.id)).id).toBe(source.id);
  });

  it('unbind 删链接但保留会话；重复解绑返回 false', async () => {
    const { conversationDirectory } = makeRepos();
    const record = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-D' });
    expect(await conversationDirectory.unbind({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-D' })).toBe(true);
    expect(await conversationDirectory.get(record.id)).not.toBeNull();
    expect((await conversationDirectory.get(record.id))?.links).toHaveLength(0);
    expect(await conversationDirectory.unbind({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-D' })).toBe(false);
  });

  it('remove：空会话可删，有原文的会话回 CONVERSATION_NOT_EMPTY', async () => {
    const { conversationDirectory } = makeRepos();
    const empty = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-E' });
    expect(await conversationDirectory.remove(empty.id)).toBe(true);
    expect(await conversationDirectory.get(empty.id)).toBeNull();

    const busy = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-F' });
    await seedMessages({ guildId: 'qq:group', channelId: 'GROUP-F' }, 1);
    await expect(conversationDirectory.remove(busy.id)).rejects.toThrow('CONVERSATION_NOT_EMPTY');
    expect(await conversationDirectory.get(busy.id)).not.toBeNull();
  });

  it('remove 连同该记忆键下的摘要与记忆设置一起清掉，不留孤儿行', async () => {
    const repos = makeRepos();
    const { conversationDirectory } = repos;
    const record = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-O' });
    const key = { guildId: 'qq:group', channelId: 'GROUP-O' };
    await repos.summaries.put({ ...key, summary: '只剩摘要没有原文', coveredUntilId: 0, updatedAt: '2026-01-01T00:00:00.000Z' });
    await repos.channelMemory.put({ ...key, historyMaxMessages: 10, summaryEveryMessages: 5 });

    expect(await conversationDirectory.remove(record.id)).toBe(true);
    expect(await repos.summaries.get(key)).toBeNull();
    expect(await repos.channelMemory.get(key)).toBeNull();
  });

  it('update 改名与选/清预设', async () => {
    const { conversationDirectory } = makeRepos();
    const record = await conversationDirectory.ensureLink({ platform: 'qq', kind: 'qq_group', externalId: 'GROUP-U' });
    const renamed = await conversationDirectory.update(record.id, { name: '新名字' });
    expect(renamed?.name).toBe('新名字');
    const preset = await conversationDirectory.update(record.id, { presetId: 'preset-1' });
    expect(preset?.presetId).toBe('preset-1');
    expect(preset?.name).toBe('新名字');
    const cleared = await conversationDirectory.update(record.id, { presetId: null });
    expect(cleared?.presetId).toBeNull();
    expect(await conversationDirectory.update('missing-id', { name: 'x' })).toBeNull();
  });
});

describe('QQ 命名预设仓储', () => {
  it('无 id 新建；有 id 覆盖写且保留 createdAt', async () => {
    const { qqPresets } = makeRepos();
    const created = await qqPresets.put({ name: '毒舌群友', config: { segments: [segment()] } });
    expect(created.id).not.toBe('');
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await tick();
    const updated = await qqPresets.put({
      id: created.id,
      name: '更毒舌',
      config: { segments: [segment('seg-2', '你是更毒舌的群友')], temperature: 0.4 },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('更毒舌');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(updated.config.temperature).toBe(0.4);
    expect(updated.config.segments[0].content).toBe('你是更毒舌的群友');

    const read = await qqPresets.get(created.id);
    expect(read?.config.segments).toHaveLength(1);
    expect(await qqPresets.list()).toHaveLength(1);
  });

  it('list 按创建时间正序，坏 JSON 行被跳过而不是炸掉整个列表', async () => {
    const { qqPresets } = makeRepos();
    await qqPresets.put({ name: '第一条', config: { segments: [segment()] } });
    await tick();
    await qqPresets.put({ name: '第二条', config: { segments: [segment('seg-2', '第二段')] } });
    await env.DB.prepare('INSERT INTO qq_presets (id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('broken', '坏行', 'not json', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      .run();

    const listed = await qqPresets.list();
    expect(listed.map((preset) => preset.name)).toEqual(['第一条', '第二条']);
    expect(await qqPresets.get('broken')).toBeNull();
  });

  it('remove 幂等', async () => {
    const { qqPresets } = makeRepos();
    const created = await qqPresets.put({ name: '待删', config: { segments: [segment()] } });
    await qqPresets.remove(created.id);
    expect(await qqPresets.get(created.id)).toBeNull();
    await expect(qqPresets.remove(created.id)).resolves.toBeUndefined();
  });
});

describe('QQ 引用索引仓储', () => {
  it('按四列主键覆盖写，过期后查不到，下一次写入清掉旧行', async () => {
    const { qqQuoteIndex } = makeRepos();
    const key = { accountId: 'app-id', kind: 'qq_group' as const, chatId: 'GROUP-1', msgIdx: 'MSG-1' };
    const first: QqQuoteEntry = {
      ...key,
      platformMessageId: 'EVENT-1',
      userId: 'USER-1',
      userName: '小明',
      content: '原来的话',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T00:00:00.000Z',
    };
    await qqQuoteIndex.record(first);
    expect(await qqQuoteIndex.find(key, '2026-01-02T00:00:00.000Z')).toEqual(first);
    expect(await qqQuoteIndex.find({ ...key, chatId: 'GROUP-2' }, '2026-01-02T00:00:00.000Z')).toBeNull();

    const second: QqQuoteEntry = {
      ...first,
      userName: '阿花',
      content: '改过的话',
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: '2026-01-09T00:00:00.000Z',
    };
    await qqQuoteIndex.record(second);
    expect(await qqQuoteIndex.find(key, '2026-01-03T00:00:00.000Z')).toEqual(second);
    expect(await qqQuoteIndex.find(key, '2026-01-10T00:00:00.000Z')).toBeNull();

    await qqQuoteIndex.record({
      ...first,
      msgIdx: 'MSG-2',
      platformMessageId: 'EVENT-2',
      createdAt: '2026-01-10T00:00:00.000Z',
      expiresAt: '2026-01-17T00:00:00.000Z',
    });
    const rows = await env.DB.prepare('SELECT msg_idx FROM qq_quote_index ORDER BY msg_idx ASC').all<{ msg_idx: string }>();
    expect(rows.results).toEqual([{ msg_idx: 'MSG-2' }]);
  });

  it('正文兜底只认前缀，且唯一命中才返回', async () => {
    const { qqQuoteIndex } = makeRepos();
    const scope = { accountId: 'app-id', kind: 'qq_group' as const, chatId: 'GROUP-TEXT' };
    const now = '2026-01-03T00:00:00.000Z';
    const entry: QqQuoteEntry = {
      ...scope,
      msgIdx: 'MSG-TEXT-1',
      platformMessageId: 'EVENT-TEXT-1',
      userId: 'USER-1',
      userName: '小明',
      content: '原来的话 ↳ 回复 阿花(USER-2)：「早」',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T00:00:00.000Z',
    };
    await qqQuoteIndex.record(entry);
    expect(await qqQuoteIndex.findByText(scope, '原来的话', now)).toEqual(entry);
    expect(await qqQuoteIndex.findByText(scope, '来的话', now)).toBeNull();
    expect(await qqQuoteIndex.findByText(scope, '', now)).toBeNull();

    await qqQuoteIndex.record({
      ...entry,
      msgIdx: 'MSG-TEXT-2',
      platformMessageId: 'EVENT-TEXT-2',
      userName: '小红',
      content: '原来的话，另一条',
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: '2026-01-09T00:00:00.000Z',
    });
    expect(await qqQuoteIndex.findByText(scope, '原来的话', now)).toBeNull();
    expect(await qqQuoteIndex.findByText(scope, '原来的话', '2026-01-10T00:00:00.000Z')).toBeNull();
  });
});

describe('HTTP：会话目录', () => {
  it('未登录一律 401', async () => {
    const app = makeApp();
    expect((await app.request('/api/conversations')).status).toBe(401);
    expect((await app.request('/api/qq/presets')).status).toBe(401);
    const created = await send(app, 'POST', '/api/conversations', {
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'GROUP-H',
    });
    expect(created.status).toBe(401);
    expect(await jsonOf(created)).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('POST 自动登记 QQ 群 → 201，字段与契约一致', async () => {
    const { app, cookie } = await setup();
    const res = await send(
      app,
      'POST',
      '/api/conversations',
      { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-H', displayName: '跑团群' },
      cookie,
    );
    expect(res.status).toBe(201);
    const dto = await jsonOf(res);
    expect(Object.keys(dto).sort()).toEqual([
      'createdAt',
      'id',
      'links',
      'memoryChannelId',
      'memoryGuildId',
      'name',
      'presetId',
      'updatedAt',
    ]);
    expect(dto['memoryGuildId']).toBe('qq:group');
    expect(dto['memoryChannelId']).toBe('GROUP-H');
    expect(dto['name']).toBe('跑团群');
    expect(dto['presetId']).toBeNull();
    const links = dto['links'] as Json[];
    expect(links).toHaveLength(1);
    expect(Object.keys(links[0]).sort()).toEqual(['displayName', 'externalId', 'kind', 'lastSeenAt', 'platform']);

    // 再发一次同样的登记：仍 201，但不会多出一条会话
    const again = await send(
      app,
      'POST',
      '/api/conversations',
      { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-H' },
      cookie,
    );
    expect(again.status).toBe(201);
    expect((await jsonOf(again))['id']).toBe(dto['id']);
    const listed = await jsonOf(await get(app, '/api/conversations', cookie));
    expect((listed['items'] as Json[]).length).toBe(1);
  });

  it('GET 目录列表不带参数走新语义，带参数仍是老语义（缺 channelId → 400）', async () => {
    const { app, cookie } = await setup();
    await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_c2c', externalId: 'USER-H' }, cookie);

    const listed = await get(app, '/api/conversations', cookie);
    expect(listed.status).toBe(200);
    expect((await jsonOf(listed))['items']).toHaveLength(1);

    const legacy = await get(app, '/api/conversations?guildId=g1', cookie);
    expect(legacy.status).toBe(400);
    expect(await jsonOf(legacy)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('PATCH 改名 / 选预设 / 清预设；未知 id 404，空 body 400', async () => {
    const { app, cookie } = await setup();
    const created = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-P' }, cookie),
    );
    const id = String(created['id']);

    const renamed = await send(app, 'PATCH', '/api/conversations/' + id, { name: ' 新名字 ', presetId: 'preset-9' }, cookie);
    expect(renamed.status).toBe(200);
    const renamedDto = await jsonOf(renamed);
    expect(renamedDto['name']).toBe('新名字');
    expect(renamedDto['presetId']).toBe('preset-9');

    const cleared = await send(app, 'PATCH', '/api/conversations/' + id, { presetId: null }, cookie);
    expect((await jsonOf(cleared))['presetId']).toBeNull();

    expect((await send(app, 'PATCH', '/api/conversations/' + id, {}, cookie)).status).toBe(400);
    const missing = await send(app, 'PATCH', '/api/conversations/nope', { name: 'x' }, cookie);
    expect(missing.status).toBe(404);
    expect(await jsonOf(missing)).toEqual({ error: 'CONVERSATION_NOT_FOUND' });
  });

  it('POST /:id/links merge=true 把 QQ 群并进 Discord 会话；Discord 记忆键不符 → 400', async () => {
    const { app, cookie } = await setup();
    const discord = await jsonOf(
      await send(
        app,
        'POST',
        '/api/conversations',
        { platform: 'discord', kind: 'discord_channel', externalId: CHANNEL, guildId: GUILD },
        cookie,
      ),
    );
    const targetId = String(discord['id']);
    const qq = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-L' }, cookie),
    );
    await seedMessages({ guildId: 'qq:group', channelId: 'GROUP-L' }, 2);

    const bound = await send(
      app,
      'POST',
      '/api/conversations/' + targetId + '/links',
      { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-L', merge: true },
      cookie,
    );
    expect(bound.status).toBe(200);
    expect(((await jsonOf(bound))['links'] as Json[]).length).toBe(2);
    expect(await countMessages(DISCORD_KEY)).toBe(2);
    expect(await countMessages({ guildId: 'qq:group', channelId: 'GROUP-L' })).toBe(0);
    expect((await jsonOf(await get(app, '/api/conversations', cookie)))['items']).toHaveLength(1);
    expect(qq['id']).toBeTruthy();

    const mismatch = await send(
      app,
      'POST',
      '/api/conversations/' + targetId + '/links',
      { platform: 'discord', kind: 'discord_channel', externalId: CHANNEL, guildId: OTHER_GUILD },
      cookie,
    );
    expect(mismatch.status).toBe(400);
    expect(await jsonOf(mismatch)).toEqual({ error: 'DISCORD_CONVERSATION_MISMATCH' });

    const qqHistory = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-L2' }, cookie),
    );
    await seedMessages({ guildId: 'qq:group', channelId: 'GROUP-L2' }, 1);
    const hasHistory = await send(
      app,
      'POST',
      '/api/conversations/' + targetId + '/links',
      { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-L2' },
      cookie,
    );
    expect(hasHistory.status).toBe(409);
    expect(await jsonOf(hasHistory)).toEqual({ error: 'CONVERSATION_HAS_HISTORY' });
    expect(qqHistory['id']).toBeTruthy();

    const unknown = await send(
      app,
      'POST',
      '/api/conversations/nope/links',
      { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-L' },
      cookie,
    );
    expect(unknown.status).toBe(404);
  });

  it('unlink 成功回 ok，重复解绑 404 LINK_NOT_FOUND，未知会话 404', async () => {
    const { app, cookie } = await setup();
    const created = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-U2' }, cookie),
    );
    const id = String(created['id']);
    const key = { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-U2' };

    const unlinked = await send(app, 'POST', '/api/conversations/' + id + '/unlink', key, cookie);
    expect(unlinked.status).toBe(200);
    expect(await jsonOf(unlinked)).toEqual({ ok: true });

    const again = await send(app, 'POST', '/api/conversations/' + id + '/unlink', key, cookie);
    expect(again.status).toBe(404);
    expect(await jsonOf(again)).toEqual({ error: 'LINK_NOT_FOUND' });

    const unknown = await send(app, 'POST', '/api/conversations/nope/unlink', key, cookie);
    expect(unknown.status).toBe(404);
    expect(await jsonOf(unknown)).toEqual({ error: 'CONVERSATION_NOT_FOUND' });
  });

  it('DELETE：空会话 ok，带原文 409 CONVERSATION_NOT_EMPTY，未知 404', async () => {
    const { app, cookie } = await setup();
    const empty = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-D1' }, cookie),
    );
    const ok = await send(app, 'DELETE', '/api/conversations/' + String(empty['id']), undefined, cookie);
    expect(ok.status).toBe(200);
    expect(await jsonOf(ok)).toEqual({ ok: true });

    const busy = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-D2' }, cookie),
    );
    await seedMessages({ guildId: 'qq:group', channelId: 'GROUP-D2' }, 1);
    const refused = await send(app, 'DELETE', '/api/conversations/' + String(busy['id']), undefined, cookie);
    expect(refused.status).toBe(409);
    expect(await jsonOf(refused)).toEqual({ error: 'CONVERSATION_NOT_EMPTY' });

    expect((await send(app, 'DELETE', '/api/conversations/nope', undefined, cookie)).status).toBe(404);
  });

  it('校验矩阵：坏 JSON / 缺字段 / 平台类型不配对 / Discord 缺 guildId', async () => {
    const { app, cookie } = await setup();
    expect((await sendRaw(app, 'POST', '/api/conversations', '{', cookie)).status).toBe(400);

    const missing = await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group' }, cookie);
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toEqual({ error: 'BAD_REQUEST' });

    const badKind = await send(
      app,
      'POST',
      '/api/conversations',
      { platform: 'qq', kind: 'discord_channel', externalId: 'X' },
      cookie,
    );
    expect(badKind.status).toBe(400);
    expect(await jsonOf(badKind)).toEqual({ error: 'BAD_LINK' });

    const noGuild = await send(
      app,
      'POST',
      '/api/conversations',
      { platform: 'discord', kind: 'discord_channel', externalId: CHANNEL },
      cookie,
    );
    expect(noGuild.status).toBe(400);
    expect(await jsonOf(noGuild)).toEqual({ error: 'BAD_GUILD_ID' });

    const unknownPlatform = await send(
      app,
      'POST',
      '/api/conversations',
      { platform: 'telegram', kind: 'qq_group', externalId: 'X' },
      cookie,
    );
    expect(unknownPlatform.status).toBe(400);
    expect(await jsonOf(unknownPlatform)).toEqual({ error: 'BAD_LINK' });
  });
});

describe('HTTP：会话记忆', () => {
  it('GET 回默认 → PUT 落库 → GET 回存值 → DELETE 回默认；QQ 键不进 /api/memory-settings', async () => {
    const { app, cookie } = await setup();
    const created = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-MEM' }, cookie),
    );
    const base = '/api/conversations/' + String(created['id']) + '/memory';

    const fresh = await jsonOf(await get(app, base, cookie));
    const freshConfig = fresh['config'] as Json;
    expect(freshConfig['guildId']).toBe('qq:group');
    expect(freshConfig['channelId']).toBe('GROUP-MEM');
    expect(freshConfig['historyMaxMessages']).toBe(MEMORY_DEFAULTS.historyMaxMessages);
    expect(freshConfig['summaryEveryMessages']).toBe(MEMORY_DEFAULTS.summaryEveryMessages);
    expect(freshConfig['contextTool']).toBe(false);
    expect(freshConfig['updatedAt']).toBe('');

    const put = await send(
      app,
      'PUT',
      base,
      { historyMaxMessages: 80, summaryEveryMessages: 20, contextTool: true },
      cookie,
    );
    expect(put.status).toBe(200);
    const saved = await jsonOf(put);
    expect(saved['guildId']).toBe('qq:group');
    expect(saved['historyMaxMessages']).toBe(80);
    expect(saved['contextTool']).toBe(true);
    expect(typeof saved['updatedAt']).toBe('string');
    expect(saved['updatedAt']).not.toBe('');

    const readBack = await jsonOf(await get(app, base, cookie));
    expect(readBack['config']).toEqual(saved);

    // QQ 的合成键不能出现在 Discord 频道列表里；真正的 Discord 行照旧出现
    const discordRow = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'discord', kind: 'discord_channel', externalId: CHANNEL, guildId: GUILD }, cookie),
    );
    await send(
      app,
      'PUT',
      '/api/conversations/' + String(discordRow['id']) + '/memory',
      { historyMaxMessages: 60, summaryEveryMessages: 0, contextTool: false },
      cookie,
    );
    const listed = (await jsonOf(await get(app, '/api/memory-settings', cookie)))['items'] as Json[];
    expect(listed).toHaveLength(1);
    expect(listed[0]['guildId']).toBe(GUILD);
    expect(listed[0]['channelId']).toBe(CHANNEL);

    const removed = await send(app, 'DELETE', base, undefined, cookie);
    expect(removed.status).toBe(200);
    expect(await jsonOf(removed)).toEqual({ ok: true });
    const afterDelete = await jsonOf(await get(app, base, cookie));
    expect((afterDelete['config'] as Json)['updatedAt']).toBe('');
  });

  it('PUT 缺字段 400 BAD_MEMORY_SETTINGS，contextTool 类型不对 400 BAD_CONTEXT_TOOL，未知会话 404', async () => {
    const { app, cookie } = await setup();
    const created = await jsonOf(
      await send(app, 'POST', '/api/conversations', { platform: 'qq', kind: 'qq_group', externalId: 'GROUP-MEM2' }, cookie),
    );
    const base = '/api/conversations/' + String(created['id']) + '/memory';

    const missing = await send(app, 'PUT', base, { historyMaxMessages: 80 }, cookie);
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toEqual({ error: 'BAD_MEMORY_SETTINGS' });

    const badTool = await send(
      app,
      'PUT',
      base,
      { historyMaxMessages: 80, summaryEveryMessages: 20, contextTool: 'yes' },
      cookie,
    );
    expect(badTool.status).toBe(400);
    expect(await jsonOf(badTool)).toEqual({ error: 'BAD_CONTEXT_TOOL' });

    expect((await send(app, 'PUT', '/api/conversations/nope/memory', {}, cookie)).status).toBe(404);
    expect((await send(app, 'DELETE', '/api/conversations/nope/memory', undefined, cookie)).status).toBe(404);
  });
});

describe('HTTP：QQ 命名预设', () => {
  it('CRUD：新建 / 列表 / 改名 / 删除，未知 id 404', async () => {
    const { app, cookie } = await setup();
    const created = await send(app, 'POST', '/api/qq/presets', { name: '毒舌群友', config: { segments: [segment()] } }, cookie);
    expect(created.status).toBe(200);
    const dto = await jsonOf(created);
    expect(Object.keys(dto).sort()).toEqual(['config', 'createdAt', 'id', 'name', 'updatedAt']);
    expect(dto['name']).toBe('毒舌群友');
    const id = String(dto['id']);

    const listed = (await jsonOf(await get(app, '/api/qq/presets', cookie)))['items'] as Json[];
    expect(listed).toHaveLength(1);
    expect(listed[0]['id']).toBe(id);

    const renamed = await send(app, 'PUT', '/api/qq/presets/' + id, { name: '更毒舌' }, cookie);
    expect(renamed.status).toBe(200);
    const renamedDto = await jsonOf(renamed);
    expect(renamedDto['name']).toBe('更毒舌');
    // 只改名字时 config 原样保留
    expect((renamedDto['config'] as Json)['segments']).toHaveLength(1);

    const missing = await send(app, 'PUT', '/api/qq/presets/nope', { name: 'x' }, cookie);
    expect(missing.status).toBe(404);
    expect(await jsonOf(missing)).toEqual({ error: 'QQ_PRESET_NOT_FOUND' });

    const removed = await send(app, 'DELETE', '/api/qq/presets/' + id, undefined, cookie);
    expect(removed.status).toBe(200);
    expect(await jsonOf(removed)).toEqual({ ok: true });
    expect(((await jsonOf(await get(app, '/api/qq/presets', cookie)))['items'] as Json[])).toHaveLength(0);
  });

  it('POST 校验：缺 name → BAD_PRESET_NAME，config 坏 → BAD_PRESET_CONFIG，空段数组也拒', async () => {
    const { app, cookie } = await setup();
    const noName = await send(app, 'POST', '/api/qq/presets', { config: { segments: [segment()] } }, cookie);
    expect(noName.status).toBe(400);
    expect(await jsonOf(noName)).toEqual({ error: 'BAD_PRESET_NAME' });

    const badConfig = await send(app, 'POST', '/api/qq/presets', { name: 'x', config: { segments: [] } }, cookie);
    expect(badConfig.status).toBe(400);
    expect(await jsonOf(badConfig)).toEqual({ error: 'BAD_PRESET_CONFIG' });

    const notObject = await send(app, 'POST', '/api/qq/presets', { name: 'x', config: 'nope' }, cookie);
    expect(notObject.status).toBe(400);
    expect(await jsonOf(notObject)).toEqual({ error: 'BAD_PRESET_CONFIG' });
  });

  it('POST /import 复用酒馆解析器：段按数组下标定位并落成新预设', async () => {
    const { app, cookie } = await setup();
    const preset = {
      name: '测试预设',
      prompts: [
        { identifier: 'main', name: '主提示', role: 'system', content: '你是猫娘', system_prompt: false, marker: false },
        { identifier: 'user1', name: '用户补充', role: 'user', content: '用户说话要简短', system_prompt: false, marker: false },
      ],
      prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
    };
    const res = await send(app, 'POST', '/api/qq/presets/import', { name: '导入预设', preset }, cookie);
    expect(res.status).toBe(200);
    const dto = await jsonOf(res);
    expect(dto['name']).toBe('导入预设');
    const config = dto['config'] as Json;
    const segments = config['segments'] as Json[];
    expect(segments).toHaveLength(2);
    expect(segments[0]['content']).toBe('你是猫娘');
    expect(segments[0]['position']).toBe(0);
    expect(segments[0]['role']).toBe('system');
    expect(segments[1]['position']).toBe(1);
    expect(String(segments[0]['id']).startsWith('seg-')).toBe(true);

    const bad = await send(app, 'POST', '/api/qq/presets/import', { name: 'x', preset: 'nope' }, cookie);
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad))['error']).toBe('BAD_PRESET');
  });
});
