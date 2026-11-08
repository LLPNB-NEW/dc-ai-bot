import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelKey, ChatMessage, ReplyRef } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const KEY: ChannelKey = { guildId: 'g1', channelId: 'c1' };

const REPLY: ReplyRef = {
  messageId: 'm-1001',
  author: '小明',
  authorId: 'u-llp',
  content: '被回复的原文，含标点与空格 逐字比对',
};

const WITH_REPLY: ChatMessage = {
  role: 'user',
  content: '在吗',
  author: '阿天',
  authorId: 'u-tian',
  createdAt: '2026-10-25T03:00:00.000Z',
  replyTo: REPLY,
};

const PLAIN: ChatMessage = {
  role: 'assistant',
  content: '在',
  createdAt: '2026-10-25T03:00:01.000Z',
};

const REPLY_COLUMN_NAMES = ['reply_to_id', 'reply_to_author', 'reply_to_author_id', 'reply_to_content'] as const;

interface ReplyRow {
  reply_to_id: string | null;
  reply_to_author: string | null;
  reply_to_author_id: string | null;
  reply_to_content: string | null;
}

const EMPTY_REPLY_ROW: ReplyRow = { reply_to_id: '', reply_to_author: '', reply_to_author_id: '', reply_to_content: '' };

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

async function firstReplyRow(): Promise<ReplyRow> {
  const row = await env.DB.prepare(
    'SELECT reply_to_id, reply_to_author, reply_to_author_id, reply_to_content FROM messages ORDER BY id LIMIT 1',
  ).first<ReplyRow>();
  if (row === null) throw new Error('messages 里还没有行，先 append 再查');
  return row;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM messages').run();
});

describe('messages.reply_to_* 列（§18.2）', () => {
  it('带 replyTo 的行在 loadAll / loadRecent / loadAfter 三处逐字读回', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [WITH_REPLY, PLAIN]);

    expect(await conversations.loadAll(KEY)).toEqual([WITH_REPLY, PLAIN]);
    expect(await conversations.loadRecent(KEY, 10)).toEqual([WITH_REPLY, PLAIN]);

    const after = await conversations.loadAfter(KEY, 0);
    expect(after).toHaveLength(2);
    expect(after[0]?.replyTo).toEqual(REPLY);
    expect(after[0]).toMatchObject({
      role: 'user',
      content: '在吗',
      author: '阿天',
      authorId: 'u-tian',
      createdAt: '2026-10-25T03:00:00.000Z',
    });
    expect(after[1]?.replyTo).toBeUndefined();
  });

  it('不带 replyTo 的行读回根本没有 replyTo 键，四列落成空串而不是 NULL', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [PLAIN]);

    expect(await firstReplyRow()).toEqual(EMPTY_REPLY_ROW);

    const recent = await conversations.loadRecent(KEY, 10);
    const all = await conversations.loadAll(KEY);
    const after = await conversations.loadAfter(KEY, 0);
    expect(recent).toHaveLength(1);
    expect(all).toHaveLength(1);
    expect(after).toHaveLength(1);

    for (const message of [...recent, ...all, ...after]) {
      expect('replyTo' in message).toBe(false);
      expect(message.replyTo).toBeUndefined();
    }
  });

  it('迁移前的老行（INSERT 不提这四列）落成空串，读侧不崩且没有 replyTo 键', async () => {
    const { conversations } = makeRepos();
    // 模拟 0004 之前落库的行：语句里完全不出现 reply_to_*
    await env.DB.prepare(
      "INSERT INTO messages (guild_id, channel_id, user_id, role, content, author_name, created_at) VALUES (?, ?, '', 'user', ?, NULL, ?)",
    )
      .bind(KEY.guildId, KEY.channelId, '迁移前的老消息', '2026-10-25T02:00:00.000Z')
      .run();

    expect(await firstReplyRow()).toEqual(EMPTY_REPLY_ROW);

    const loaded = await conversations.loadAll(KEY);
    expect(loaded).toEqual([{ role: 'user', content: '迁移前的老消息', createdAt: '2026-10-25T02:00:00.000Z' }]);
    expect('replyTo' in loaded[0]!).toBe(false);
    expect(await conversations.loadRecent(KEY, 5)).toEqual(loaded);
  });

  it('四列在 schema 上是 TEXT NOT NULL DEFAULT 空串', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(messages)').all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const byName = new Map((results ?? []).map((column) => [column.name, column]));
    for (const name of REPLY_COLUMN_NAMES) {
      const column = byName.get(name);
      expect(column?.type).toBe('TEXT');
      expect(column?.notnull).toBe(1);
      expect((column?.dflt_value ?? '').replace(/'/g, '')).toBe('');
    }
  });

  it('reply_to_content 存原文全文：超过 40 字也不截断', async () => {
    const { conversations } = makeRepos();
    const longContent = '这是一段明显超过四十个字的被回复原文，用来确认存储层不做截断'.repeat(3);
    expect(longContent.length).toBeGreaterThan(40);
    const replyTo: ReplyRef = { messageId: 'm-long', author: '小明', authorId: 'u-llp', content: longContent };

    await conversations.append(KEY, [{ role: 'user', content: '接着聊', replyTo }]);

    expect((await firstReplyRow()).reply_to_content).toBe(longContent);
    const [all] = await conversations.loadAll(KEY);
    expect(all?.replyTo?.content).toBe(longContent);
    const [recent] = await conversations.loadRecent(KEY, 1);
    expect(recent?.replyTo?.content.length).toBe(longContent.length);
    const [after] = await conversations.loadAfter(KEY, 0);
    expect(after?.replyTo?.content).toBe(longContent);
  });

  it('只有一个字段有值时仍产生 replyTo 键，其余字段按空串原样读回', async () => {
    const { conversations } = makeRepos();
    const bare: ReplyRef = { messageId: 'm-bare', author: '', authorId: '', content: '' };
    await conversations.append(KEY, [{ role: 'user', content: '只留 id', replyTo: bare }]);

    const loaded = await conversations.loadAll(KEY);
    expect(loaded).toHaveLength(1);
    expect('replyTo' in loaded[0]!).toBe(true);
    expect(loaded[0]?.replyTo).toEqual(bare);
  });

  it('append 的 createdAt 落库行为不受新列影响：显式值原样存、缺省补当前时刻', async () => {
    const { conversations } = makeRepos();
    await conversations.append(KEY, [WITH_REPLY, { role: 'assistant', content: '没有时刻' }]);

    const { results } = await env.DB.prepare('SELECT content, created_at FROM messages ORDER BY id').all<{
      content: string;
      created_at: string;
    }>();
    expect(results?.[0]).toEqual({ content: '在吗', created_at: '2026-10-25T03:00:00.000Z' });
    expect(results?.[1]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const loaded = await conversations.loadAll(KEY);
    expect(loaded[0]?.createdAt).toBe('2026-10-25T03:00:00.000Z');
    expect(loaded[0]?.replyTo).toEqual(REPLY);
    expect(typeof loaded[1]?.createdAt).toBe('string');
  });
});
