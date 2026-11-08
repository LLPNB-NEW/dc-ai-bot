import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PromptConfig, PromptSegment, RouteConfig } from '../src/core/types';
import { findUnknownVars, renderTemplate } from '../src/core/prompt/template';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const MASTER_KEY = toBase64(new Uint8Array(32).fill(9));
const WRONG_MASTER_KEY = toBase64(new Uint8Array(16).fill(9));

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

const COUNT_SQL = {
  prompts: 'SELECT COUNT(*) AS n FROM prompts',
  prompt_segments: 'SELECT COUNT(*) AS n FROM prompt_segments',
  routes: 'SELECT COUNT(*) AS n FROM routes',
  provider_keys: 'SELECT COUNT(*) AS n FROM provider_keys',
  messages: 'SELECT COUNT(*) AS n FROM messages',
} as const;

async function countRows(table: keyof typeof COUNT_SQL): Promise<number> {
  const row = await env.DB.prepare(COUNT_SQL[table]).first<{ n: number }>();
  return row?.n ?? 0;
}

function seg(id: string, content: string, extra: Partial<PromptSegment> = {}): PromptSegment {
  return { id, name: id, role: 'system', content, enabled: true, placement: 'before', position: 0, ...extra };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prompts'),
    env.DB.prepare('DELETE FROM prompt_segments'),
    env.DB.prepare('DELETE FROM routes'),
    env.DB.prepare('DELETE FROM provider_keys'),
    env.DB.prepare('DELETE FROM messages'),
  ]);
});

describe('migrations', () => {
  it('四张表都存在且可插入', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const tables = (results ?? []).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(['prompts', 'routes', 'provider_keys', 'messages']));

    const { prompts, routes, keys, conversations } = makeRepos();
    await prompts.put({ scope: 'global', scopeId: '' }, { segments: [seg('main', 'p')] });
    await routes.put({ scope: 'global', scopeId: '' }, { primary: { provider: 'openai-compat', model: 'm' }, fallbacks: [] });
    await keys.create({ provider: 'openai-compat', label: 'k', apiKey: 'sk-abcdefgh' });
    await conversations.append({ guildId: 'g', channelId: 'c' }, [{ role: 'user', content: 'hi' }]);

    expect(await countRows('prompts')).toBe(1);
    expect(await countRows('prompt_segments')).toBe(1);
    expect(await countRows('routes')).toBe(1);
    expect(await countRows('provider_keys')).toBe(1);
    expect(await countRows('messages')).toBe(1);
  });
});

describe('prompts repository', () => {
  it('global/guild/channel 三种 scope 的 put→get→list→remove 往返（行 + 段两张表）', async () => {
    const { prompts } = makeRepos();
    const globalCfg: PromptConfig = {
      segments: [
        seg('main', '你是 {{bot_name}}', { name: '基本设定' }),
        seg('persona', '冷静克制', { name: '人格', position: 1 }),
        seg('note', '只回一句话', { role: 'user', position: 2 }),
      ],
      temperature: 0.3,
      maxTokens: 512,
    };
    const guildCfg: PromptConfig = { segments: [seg('guild-main', '公会提示词')] };
    const channelCfg: PromptConfig = {
      segments: [seg('ch-main', '频道提示词', { enabled: false, placement: 'after' })],
      maxTokens: 256,
    };

    await prompts.put({ scope: 'global', scopeId: '' }, globalCfg);
    await prompts.put({ scope: 'guild', scopeId: 'g1' }, guildCfg);
    await prompts.put({ scope: 'channel', scopeId: 'c1' }, channelCfg);

    expect(await prompts.get({ scope: 'global', scopeId: '' })).toEqual(globalCfg);
    expect(await prompts.get({ scope: 'guild', scopeId: 'g1' })).toEqual(guildCfg);
    expect(await prompts.get({ scope: 'channel', scopeId: 'c1' })).toEqual(channelCfg);
    expect(await prompts.get({ scope: 'channel', scopeId: 'missing' })).toBeNull();
    expect(await countRows('prompt_segments')).toBe(5);

    const listed = await prompts.list();
    expect(listed).toHaveLength(3);
    const byKey = new Map(listed.map((item) => [`${item.scope}:${item.scopeId}`, item]));
    expect(byKey.get('global:')).toEqual({ ...globalCfg, scope: 'global', scopeId: '' });
    expect(byKey.get('guild:g1')).toEqual({ ...guildCfg, scope: 'guild', scopeId: 'g1' });
    expect(byKey.get('channel:c1')).toEqual({ ...channelCfg, scope: 'channel', scopeId: 'c1' });

    await prompts.put({ scope: 'guild', scopeId: 'g1' }, { segments: [seg('guild-main', '改写后')] });
    expect(await prompts.get({ scope: 'guild', scopeId: 'g1' })).toEqual({ segments: [seg('guild-main', '改写后')] });
    expect(await countRows('prompt_segments')).toBe(5);

    await prompts.remove({ scope: 'guild', scopeId: 'g1' });
    expect(await prompts.get({ scope: 'guild', scopeId: 'g1' })).toBeNull();
    expect(await prompts.list()).toHaveLength(2);
    expect(await countRows('prompt_segments')).toBe(4);
  });

  it('只有段没有 prompts 行时仍算这一层存在；行与段都没有才返回 null', async () => {
    const { prompts } = makeRepos();
    await env.DB.prepare(
      "INSERT INTO prompt_segments (id, scope, scope_id, position, name, role, content, enabled, placement, updated_at) VALUES ('orphan', 'guild', 'g9', 0, '孤儿段', 'system', 'x', 1, 'before', '2024-01-01')",
    ).run();

    expect(await prompts.get({ scope: 'guild', scopeId: 'g9' })).toEqual({
      segments: [seg('orphan', 'x', { name: '孤儿段' })],
    });
    expect(await prompts.get({ scope: 'guild', scopeId: 'none' })).toBeNull();
  });

  it('put 按数组顺序写 position，并整体替换旧段', async () => {
    const { prompts } = makeRepos();
    await prompts.put({ scope: 'global', scopeId: '' }, {
      segments: [seg('b', 'B', { position: 9 }), seg('a', 'A', { position: 0 })],
    });
    expect(await prompts.get({ scope: 'global', scopeId: '' })).toEqual({
      segments: [seg('b', 'B', { position: 0 }), seg('a', 'A', { position: 1 })],
    });

    await prompts.put({ scope: 'global', scopeId: '' }, { segments: [seg('c', 'C')] });
    expect(await countRows('prompt_segments')).toBe(1);
  });
});

describe('routes repository', () => {
  it('fallbacks 序列化往返，坏 JSON 降级为空数组', async () => {
    const { routes } = makeRepos();
    const cfg: RouteConfig = {
      primary: { provider: 'openai-compat', model: 'gpt-4o-mini' },
      fallbacks: [
        { provider: 'anthropic', model: 'claude-3-5-haiku' },
        { provider: 'gemini', model: 'gemini-2.0-flash' },
      ],
      temperature: 0.7,
      maxTokens: 900,
    };
    await routes.put({ scope: 'channel', scopeId: 'c1' }, cfg);
    expect(await routes.get({ scope: 'channel', scopeId: 'c1' })).toEqual(cfg);

    await routes.put({ scope: 'global', scopeId: '' }, { primary: { provider: 'anthropic', model: 'x' }, fallbacks: [] });
    const listed = await routes.list();
    expect(listed).toHaveLength(2);
    expect(listed.find((item) => item.scope === 'channel')?.fallbacks).toEqual(cfg.fallbacks);

    await env.DB.prepare("UPDATE routes SET fallbacks_json = 'not-json{{' WHERE scope = 'channel'").run();
    expect(await routes.get({ scope: 'channel', scopeId: 'c1' })).toEqual({ ...cfg, fallbacks: [] });

    await routes.remove({ scope: 'channel', scopeId: 'c1' });
    expect(await routes.get({ scope: 'channel', scopeId: 'c1' })).toBeNull();
  });
});

describe('keys repository', () => {
  it('list 只见 hint，listEnabled 解回明文，库里是 v1. 密文', async () => {
    const { keys } = makeRepos();
    const apiKey = 'sk-live-SECRET-9876';
    const created = await keys.create({ provider: 'openai-compat', label: '主力', apiKey });

    expect(created.keyHint).toBe('…9876');
    expect(created.enabled).toBe(true);
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const listed = await keys.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.keyHint).toBe('…9876');
    expect(JSON.stringify(listed)).not.toContain(apiKey);

    const decrypted = await keys.listEnabled('openai-compat');
    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]?.apiKey).toBe(apiKey);
    expect(decrypted[0]?.id).toBe(created.id);
    expect(await keys.listEnabled('gemini')).toEqual([]);

    expect((await keys.getDecrypted(created.id))?.apiKey).toBe(apiKey);
    expect(await keys.getDecrypted('nope')).toBeNull();

    const row = await env.DB.prepare('SELECT ciphertext, key_hint FROM provider_keys WHERE id = ?')
      .bind(created.id)
      .first<{ ciphertext: string; key_hint: string }>();
    expect(row?.ciphertext.startsWith('v1.')).toBe(true);
    expect(row?.ciphertext).not.toBe(apiKey);
    expect(row?.ciphertext).not.toContain(apiKey);
    expect(row?.key_hint).toBe('…9876');

    await keys.remove(created.id);
    expect(await keys.list()).toHaveLength(0);
  });

  it('baseUrl 可空可填', async () => {
    const { keys } = makeRepos();
    const withUrl = await keys.create({ provider: 'openai-compat', label: '兼容', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1111' });
    expect(withUrl.baseUrl).toBe('https://api.deepseek.com/v1');
    expect((await keys.listEnabled('openai-compat'))[0]?.baseUrl).toBe('https://api.deepseek.com/v1');
    const withoutUrl = await keys.create({ provider: 'anthropic', label: '原生', apiKey: 'sk-ant-2222' });
    expect(withoutUrl.baseUrl).toBeUndefined();
    expect((await keys.listEnabled('anthropic'))[0]?.baseUrl).toBeUndefined();
  });
});

describe('conversations repository', () => {
  it('append→loadRecent 返回时间正序；loadAll 取全部按 id 正序；clear 生效', async () => {
    const { conversations } = makeRepos();
    const key = { guildId: 'g1', channelId: 'c1' };
    // 显式给时刻：库里的 created_at 就是上层给的值，read 回来逐字比对
    await conversations.append(key, [
      { role: 'user', content: 'q1', createdAt: '2026-10-25T03:00:00.000Z' },
      { role: 'assistant', content: 'a1', createdAt: '2026-10-25T03:00:01.000Z' },
    ]);
    await conversations.append(key, [
      { role: 'user', content: 'q2', createdAt: '2026-10-25T03:00:02.000Z' },
      { role: 'assistant', content: 'a2', createdAt: '2026-10-25T03:00:03.000Z' },
    ]);

    expect(await conversations.loadRecent(key, 10)).toEqual([
      { role: 'user', content: 'q1', createdAt: '2026-10-25T03:00:00.000Z' },
      { role: 'assistant', content: 'a1', createdAt: '2026-10-25T03:00:01.000Z' },
      { role: 'user', content: 'q2', createdAt: '2026-10-25T03:00:02.000Z' },
      { role: 'assistant', content: 'a2', createdAt: '2026-10-25T03:00:03.000Z' },
    ]);
    // 取最近 2 条：必须还是时间正序
    expect(await conversations.loadRecent(key, 2)).toEqual([
      { role: 'user', content: 'q2', createdAt: '2026-10-25T03:00:02.000Z' },
      { role: 'assistant', content: 'a2', createdAt: '2026-10-25T03:00:03.000Z' },
    ]);

    // 全部历史：不带 LIMIT，也不串到别的频道
    await conversations.append({ guildId: 'g2', channelId: 'c1' }, [{ role: 'user', content: 'other guild' }]);
    expect(await countRows('messages')).toBe(5);
    expect(await conversations.loadAll(key)).toEqual([
      { role: 'user', content: 'q1', createdAt: '2026-10-25T03:00:00.000Z' },
      { role: 'assistant', content: 'a1', createdAt: '2026-10-25T03:00:01.000Z' },
      { role: 'user', content: 'q2', createdAt: '2026-10-25T03:00:02.000Z' },
      { role: 'assistant', content: 'a2', createdAt: '2026-10-25T03:00:03.000Z' },
    ]);
    const otherRow = await conversations.loadAll({ guildId: 'g2', channelId: 'c1' });
    expect(otherRow).toHaveLength(1);
    expect(otherRow[0]).toMatchObject({ role: 'user', content: 'other guild' });
    // 没给时刻就由库侧补当前时刻
    expect(typeof otherRow[0]?.createdAt).toBe('string');

    await conversations.clear(key);
    expect(await conversations.loadRecent(key, 10)).toEqual([]);
    expect(await conversations.loadAll(key)).toEqual([]);
    expect(await countRows('messages')).toBe(1);
  });
});

describe('secretbox', () => {
  it('随机 IV 使同一明文两次密文不同，且能解回原文', async () => {
    const box = createSecretBox(MASTER_KEY);
    const plaintext = 'sk-secret-value-1234';
    const first = await box.encrypt(plaintext);
    const second = await box.encrypt(plaintext);

    expect(first.startsWith('v1.')).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain(plaintext);
    expect(first.split('.')).toHaveLength(3);
    expect(await box.decrypt(first)).toBe(plaintext);
    expect(await box.decrypt(second)).toBe(plaintext);

    const other = createSecretBox(MASTER_KEY);
    expect(await other.decrypt(first)).toBe(plaintext);
  });

  it('masterKey 非 32 字节时构造即抛错', () => {
    expect(() => createSecretBox(WRONG_MASTER_KEY)).toThrow();
    expect(() => createSecretBox('')).toThrow();
  });

  it('密文被篡改时解密失败', async () => {
    const box = createSecretBox(MASTER_KEY);
    const blob = await box.encrypt('tamper-me');
    const parts = blob.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -4)}AAAA`;
    await expect(box.decrypt(tampered)).rejects.toThrow();
  });
});

describe('template', () => {
  const vars = {
    bot_name: '小助手',
    user_name: '阿天',
    guild_name: '测试公会',
    channel_name: '测试频道',
    date: '2026-01-01',
  };

  it('渲染已知变量，缺失变量渲染为空串', () => {
    expect(renderTemplate('{{bot_name}} 在 {{ channel_name }} 服务 {{user_name}}', vars)).toBe('小助手 在 测试频道 服务 阿天');
    expect(renderTemplate('你好 {{user_name}}，今天是 {{date}}', vars)).toBe('你好 阿天，今天是 2026-01-01');
    expect(renderTemplate('[{{guild_name}}]', {})).toBe('[]');
  });

  it('变量两侧空格与无空格等价', () => {
    expect(renderTemplate('{{ user_name }}', vars)).toBe(renderTemplate('{{user_name}}', vars));
    expect(findUnknownVars('{{ nope }}')).toEqual(['nope']);
    expect(findUnknownVars('{{nope}}')).toEqual(['nope']);
  });

  it('未知变量渲染抛 UNKNOWN_TEMPLATE_VAR', () => {
    expect(() => renderTemplate('{{unknown_var}}', vars)).toThrow('UNKNOWN_TEMPLATE_VAR: unknown_var');
    expect(() => renderTemplate('ok {{ user_name }} {{ bad }}', vars)).toThrow('UNKNOWN_TEMPLATE_VAR: bad');
  });

  it('findUnknownVars 去重且保持出现顺序', () => {
    expect(findUnknownVars('{{zeta}} {{alpha}} {{zeta}} {{user_name}} {{alpha}}')).toEqual(['zeta', 'alpha']);
    expect(findUnknownVars('{{bot_name}} {{user_name}} {{guild_name}} {{channel_name}} {{date}}')).toEqual([]);
    expect(findUnknownVars('没有变量')).toEqual([]);
  });
});