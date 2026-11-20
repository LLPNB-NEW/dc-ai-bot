import { describe, expect, it } from 'vitest';
import { DISCORD_API_BASE, createChannelClient } from '../src/workers/gateway/channel-rest';
import { MAX_IMAGE_BYTES } from '../src/workers/gateway/images';
import {
  DISCORD_MESSAGE_LIMIT,
  EMPTY_ADDRESSED_NOTE,
  MESSAGE_CHUNK_LIMIT,
  authorDisplayName,
  chunkMessage,
  isMentioned,
  messageStats,
  parseIncomingMessage,
  shouldRecord,
  shouldRespond,
  stripMentions,
  type IncomingMessage,
} from '../src/workers/gateway/message';

const BOT_ID = '150000000000000001';

function parseOrThrow(raw: unknown): IncomingMessage {
  const parsed = parseIncomingMessage(raw);
  if (parsed === null) throw new Error('这条载荷本应能解析');
  return parsed;
}

function dmPayload(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    channel_id: 'chan-1',
    content,
    author: { id: 'user-1', username: 'alice', global_name: 'Alice', bot: false },
    mentions: [],
    ...overrides,
  };
}

function guildPayload(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dmPayload(content, { guild_id: 'guild-1', ...overrides });
}

describe('parseIncomingMessage', () => {
  it('解析私聊：guildId 为 null，作者信息齐全', () => {
    const message = parseOrThrow(dmPayload('你好'));
    expect(message).toEqual({
      messageId: 'msg-1',
      channelId: 'chan-1',
      guildId: null,
      content: '你好',
      author: { id: 'user-1', bot: false, username: 'alice', globalName: 'Alice', nickname: null },
      mentionedIds: [],
      // §22.5：没有附图的老消息多一个空数组，其余字段一字不差
      attachments: [],
      referencedAuthorId: null,
      replyTo: null,
    });
  });

  it('解析服务器消息：guildId、mentions、referenced_message.author.id 都收下', () => {
    const message = parseOrThrow(
      guildPayload('<@' + BOT_ID + '> 帮个忙', {
        mentions: [{ id: BOT_ID, username: '示例机器人' }],
        referenced_message: { id: 'msg-0', author: { id: 'user-2' } },
      }),
    );
    expect(message.guildId).toBe('guild-1');
    expect(message.mentionedIds).toEqual([BOT_ID]);
    expect(message.referencedAuthorId).toBe('user-2');
  });

  it('数字 id 也接受（v10 给字符串，但不该因类型差异整条丢掉）', () => {
    const message = parseOrThrow(
      dmPayload('hi', { id: 12, channel_id: 34, author: { id: 56, username: 'bob' } }),
    );
    expect(message.messageId).toBe('12');
    expect(message.channelId).toBe('34');
    expect(message.author.id).toBe('56');
  });

  it('缺关键字段或不是对象时返回 null', () => {
    expect(parseIncomingMessage(null)).toBeNull();
    expect(parseIncomingMessage('nope')).toBeNull();
    expect(parseIncomingMessage({ id: 'm', channel_id: 'c' })).toBeNull();
    expect(parseIncomingMessage({ id: 'm', author: { id: 'u' } })).toBeNull();
  });

  it('内容缺失时按空串处理', () => {
    const message = parseOrThrow(dmPayload('x', { content: undefined }));
    expect(message.content).toBe('');
  });
});

describe('parseIncomingMessage 的 replyTo（§18.6 回复链）', () => {
  const referenced = {
    id: 'msg-0',
    author: { id: 'user-2', username: 'bob', global_name: 'Bob' },
    content: '第一行\n第二行',
  };

  it('带 referenced_message：四个字段都按 Discord 实际载荷解析', () => {
    const message = parseOrThrow(guildPayload('<@' + BOT_ID + '> 接着说', { referenced_message: referenced }));
    expect(message.replyTo).toEqual({
      messageId: 'msg-0',
      authorId: 'user-2',
      authorName: 'Bob',
      content: '第一行\n第二行',
      // §22.5：被回复消息没有附件时同样是空数组
      attachments: [],
    });
    // 既有字段保持原样：shouldRespond 仍靠它判断「回复的是不是 bot」
    expect(message.referencedAuthorId).toBe('user-2');
  });

  it('没有 global_name 时回落 username；原文缺失时按空串', () => {
    const message = parseOrThrow(
      guildPayload('嗯', { referenced_message: { id: 'msg-0', author: { id: 'user-3', username: 'carol' } } }),
    );
    expect(message.replyTo).toEqual({
      messageId: 'msg-0',
      authorId: 'user-3',
      authorName: 'carol',
      content: '',
      attachments: [],
    });
  });

  it('被回复者的服务器昵称优先：member.nick 压过账号名（§60）', () => {
    const message = parseOrThrow(
      guildPayload('嗯', {
        referenced_message: {
          id: 'msg-bot',
          author: { id: BOT_ID, username: '示例机器人' },
          member: { nick: '示例角色' },
          content: '上一条',
        },
      }),
    );
    // 机器人账号没有 global_name，旧实现只能拿到账号名「示例机器人」，服务器昵称读不到
    expect(message.replyTo?.authorName).toBe('示例角色');
  });

  it('本条消息的作者也带上服务器昵称：member.nick → author.nickname（§60）', () => {
    const message = parseOrThrow(guildPayload('在吗', { member: { nick: '小苏' } }));
    expect(message.author.nickname).toBe('小苏');
    expect(authorDisplayName(message.author)).toBe('小苏');
  });

  it('authorDisplayName：昵称 > 全局显示名 > 账号名，全空回落「未知用户」', () => {
    expect(authorDisplayName({ id: 'u', bot: false, username: 'whale', globalName: 'Whale', nickname: '示例角色' })).toBe('示例角色');
    expect(authorDisplayName({ id: 'u', bot: false, username: 'whale', globalName: 'Whale', nickname: '  ' })).toBe('Whale');
    expect(authorDisplayName({ id: 'u', bot: false, username: 'whale', globalName: null, nickname: null })).toBe('whale');
    expect(authorDisplayName({ id: 'u', bot: false, username: null, globalName: null, nickname: null })).toBe('未知用户');
  });

  it('作者字段全缺时仍是「一条回复」，只是名字与 id 为空串（由 §18.3 的退化规则兜底）', () => {
    const message = parseOrThrow(guildPayload('嗯', { referenced_message: { id: 'msg-0' } }));
    expect(message.replyTo).toEqual({ messageId: 'msg-0', authorId: '', authorName: '', content: '', attachments: [] });
  });

  it('没有 referenced_message：replyTo 为 null（不是回复）', () => {
    expect(parseOrThrow(dmPayload('你好')).replyTo).toBeNull();
    expect(parseOrThrow(guildPayload('随便聊聊')).replyTo).toBeNull();
  });

  it('referenced_message 为 null（原消息已删除）：replyTo 为 null，退化成普通消息', () => {
    const message = parseOrThrow(guildPayload('继续聊', { referenced_message: null }));
    expect(message.replyTo).toBeNull();
    expect(message.referencedAuthorId).toBeNull();
  });

  it('回复 bot 的消息：referencedAuthorId 与 replyTo.authorId 都能认出是 bot', () => {
    const message = parseOrThrow(
      guildPayload('继续', { referenced_message: { id: 'msg-bot', author: { id: BOT_ID }, content: '上一条' } }),
    );
    expect(message.referencedAuthorId).toBe(BOT_ID);
    expect(message.replyTo?.authorId).toBe(BOT_ID);
    expect(shouldRespond(message, BOT_ID).reason).toBe('reply');
  });
});

describe('parseIncomingMessage 的图片附件（§22.5）', () => {
  it('attachments：收下 url，content_type 换成 mediaType，size 原样', () => {
    const message = parseOrThrow(
      dmPayload('看这张', {
        attachments: [{ url: 'https://cdn.test/a.png', content_type: 'image/png', size: 2048 }],
      }),
    );
    expect(message.attachments).toEqual([{ url: 'https://cdn.test/a.png', mediaType: 'image/png', size: 2048 }]);
  });

  it('非 image/* 的附件丢弃：扩展名像图片也不留（§22.8）', () => {
    const message = parseOrThrow(
      dmPayload('文件', {
        attachments: [
          { url: 'https://cdn.test/clip.png', content_type: 'video/mp4', size: 1024 },
          { url: 'https://cdn.test/doc.pdf', content_type: 'application/pdf', size: 1024 },
        ],
      }),
    );
    expect(message.attachments).toEqual([]);
  });

  it('缺 content_type 时按扩展名兜底猜 MIME，猜不出就丢', () => {
    const message = parseOrThrow(
      dmPayload('图', {
        attachments: [
          { url: 'https://cdn.test/no-type.jpeg', size: 10 },
          { url: 'https://cdn.test/no-type.webp', size: 10 },
          { url: 'https://cdn.test/no-type', size: 10 },
        ],
      }),
    );
    expect(message.attachments.map((entry) => entry.mediaType)).toEqual(['image/jpeg', 'image/webp']);
  });

  it('单张超过 5MB 的丢弃，正好 5MB 保留', () => {
    const message = parseOrThrow(
      dmPayload('大图', {
        attachments: [
          { url: 'https://cdn.test/big.png', content_type: 'image/png', size: MAX_IMAGE_BYTES + 1 },
          { url: 'https://cdn.test/edge.png', content_type: 'image/png', size: MAX_IMAGE_BYTES },
        ],
      }),
    );
    expect(message.attachments.map((entry) => entry.url)).toEqual(['https://cdn.test/edge.png']);
  });

  it('referenced_message.attachments 同样解析：回复链里的图跟着 replyTo 走', () => {
    const message = parseOrThrow(
      guildPayload('<@' + BOT_ID + '> 这张呢', {
        referenced_message: {
          id: 'msg-0',
          author: { id: 'user-2', username: 'bob' },
          content: '上一条',
          attachments: [{ url: 'https://cdn.test/reply.png', content_type: 'image/png', size: 4096 }],
        },
      }),
    );
    expect(message.replyTo?.attachments).toEqual([
      { url: 'https://cdn.test/reply.png', mediaType: 'image/png', size: 4096 },
    ]);
  });

  it('没有附件时 attachments 为 []，被回复那条也是 []（老消息形状不变）', () => {
    expect(parseOrThrow(dmPayload('纯文字')).attachments).toEqual([]);
    const replied = parseOrThrow(
      guildPayload('继续', { referenced_message: { id: 'msg-0', author: { id: 'user-2' } } }),
    );
    expect(replied.replyTo?.attachments).toEqual([]);
  });

  it('附件字段被写坏时按空数组处理，不抛错', () => {
    expect(parseOrThrow(dmPayload('x', { attachments: 'nope' })).attachments).toEqual([]);
    expect(parseOrThrow(dmPayload('x', { attachments: [null] })).attachments).toEqual([]);
  });
});

describe('stripMentions / isMentioned', () => {
  it('剥掉两种 @ 写法并压掉多余空白', () => {
    expect(stripMentions('<@' + BOT_ID + '>   在吗', BOT_ID)).toBe('在吗');
    expect(stripMentions('<@!' + BOT_ID + '> 在吗', BOT_ID)).toBe('在吗');
    expect(stripMentions('帮我 <@' + BOT_ID + '> 看看', BOT_ID)).toBe('帮我 看看');
    expect(stripMentions('无关内容', BOT_ID)).toBe('无关内容');
  });

  it('mentions 数组与原文两种来源都能认出被 @', () => {
    expect(isMentioned(parseOrThrow(guildPayload('hi', { mentions: [{ id: BOT_ID }] })), BOT_ID)).toBe(true);
    expect(isMentioned(parseOrThrow(guildPayload('<@' + BOT_ID + '> hi')), BOT_ID)).toBe(true);
    expect(isMentioned(parseOrThrow(guildPayload('hi')), BOT_ID)).toBe(false);
    // 空 userId 一律不算被 @
    expect(isMentioned(parseOrThrow(guildPayload('<@' + BOT_ID + '> hi')), '')).toBe(false);
  });
});

describe('shouldRespond', () => {
  it('私聊一律回，文本去掉 @ 前缀', () => {
    const decision = shouldRespond(parseOrThrow(dmPayload('今天天气怎么样')), BOT_ID);
    expect(decision).toEqual({ respond: true, reason: 'dm', text: '今天天气怎么样' });
  });

  it('服务器里 @我 才回', () => {
    const decision = shouldRespond(parseOrThrow(guildPayload('<@' + BOT_ID + '> 讲个笑话')), BOT_ID);
    expect(decision.respond).toBe(true);
    expect(decision.reason).toBe('mention');
    expect(decision.text).toBe('讲个笑话');
  });

  it('服务器里回复我的消息也回', () => {
    const decision = shouldRespond(
      parseOrThrow(guildPayload('继续', { referenced_message: { author: { id: BOT_ID } } })),
      BOT_ID,
    );
    expect(decision.reason).toBe('reply');
    expect(decision.text).toBe('继续');
  });

  it('服务器里没 @我 也没回复我就保持安静', () => {
    const decision = shouldRespond(parseOrThrow(guildPayload('随便聊聊')), BOT_ID);
    expect(decision).toEqual({ respond: false, reason: 'not-addressed', text: '' });
  });

  it('别的机器人和自己的消息都跳过（避免自激循环）', () => {
    const otherBot = parseOrThrow(dmPayload('bot says hi', { author: { id: 'bot-2', bot: true } }));
    expect(shouldRespond(otherBot, BOT_ID).reason).toBe('bot');
    const self = parseOrThrow(guildPayload('<@' + BOT_ID + '> hi', { author: { id: BOT_ID } }));
    expect(shouldRespond(self, BOT_ID).reason).toBe('self');
  });

  it('服务器里只 @ 了我、没写字：只交一句事实标记，不再替用户编话', () => {
    const decision = shouldRespond(parseOrThrow(guildPayload('<@' + BOT_ID + '>')), BOT_ID);
    expect(decision.respond).toBe(true);
    expect(decision.reason).toBe('empty-addressed');
    expect(decision.text).toBe(EMPTY_ADDRESSED_NOTE);
  });

  it('正文被抹成空串但 mentions 里有我（缺 MESSAGE_CONTENT）：同样只交事实标记', () => {
    const decision = shouldRespond(parseOrThrow(guildPayload('', { mentions: [{ id: BOT_ID }] })), BOT_ID);
    expect(decision.reason).toBe('empty-addressed');
    expect(decision.text).toBe(EMPTY_ADDRESSED_NOTE);
  });

  it('频道里没人叫我的空正文消息：not-addressed（保持安静）', () => {
    const decision = shouldRespond(parseOrThrow(guildPayload('')), BOT_ID);
    expect(decision).toEqual({ respond: false, reason: 'not-addressed', text: '' });
  });

  it('私聊里发空消息：也交事实标记', () => {
    const decision = shouldRespond(parseOrThrow(dmPayload('   ')), BOT_ID);
    expect(decision.reason).toBe('empty-addressed');
    expect(decision.text).toBe(EMPTY_ADDRESSED_NOTE);
  });

  it('回复我的消息但没写正文：交事实标记', () => {
    const decision = shouldRespond(
      parseOrThrow(guildPayload('', { referenced_message: { author: { id: BOT_ID } } })),
      BOT_ID,
    );
    expect(decision.reason).toBe('empty-addressed');
    expect(decision.text).toBe(EMPTY_ADDRESSED_NOTE);
  });

  it('空 @ 的决策不再另设落库原文（text 本身就是事实标记），有正文的也不设', () => {
    const empty = shouldRespond(parseOrThrow(guildPayload('<@' + BOT_ID + '>')), BOT_ID);
    expect(empty.storedText).toBeUndefined();
    expect(empty.text).toBe(EMPTY_ADDRESSED_NOTE);
    const normal = shouldRespond(parseOrThrow(guildPayload('<@' + BOT_ID + '> 讲个笑话')), BOT_ID);
    expect(normal.storedText).toBeUndefined();
  });

  it('事实标记本身也受 1900 字上限约束（会走同一条 chunkMessage 路径）', () => {
    expect(EMPTY_ADDRESSED_NOTE.length).toBeGreaterThan(0);
    expect(EMPTY_ADDRESSED_NOTE.length).toBeLessThanOrEqual(MESSAGE_CHUNK_LIMIT);
    expect(chunkMessage(EMPTY_ADDRESSED_NOTE)).toEqual([EMPTY_ADDRESSED_NOTE]);
  });
});

describe('shouldRecord（不回，但仍要进频道记忆）', () => {
  /** 判定由 shouldRespond 给：这里测的是「拿到判定后再怎么记」，不重复覆盖回复策略 */
  function recordOf(raw: unknown): boolean {
    const message = parseOrThrow(raw);
    return shouldRecord(message, shouldRespond(message, BOT_ID));
  }

  it('频道里既没 @我 也没回复我的人类发言：记', () => {
    expect(recordOf(guildPayload('今天晚上有人打排位吗'))).toBe(true);
  });

  it('@我 / 回复我 的回合不在这里记（已由 chat service 落库，避免重复）', () => {
    expect(recordOf(guildPayload('<@' + BOT_ID + '> 在吗', { mentions: [{ id: BOT_ID }] }))).toBe(false);
    expect(recordOf(guildPayload('继续说', { referenced_message: { author: { id: BOT_ID } } }))).toBe(false);
  });

  it('私聊与自己的消息都不记', () => {
    expect(recordOf(dmPayload('你好'))).toBe(false);
    expect(recordOf(guildPayload('<@' + BOT_ID + '> hi', { author: { id: BOT_ID } }))).toBe(false);
  });

  it('频道里没有正文的 not-addressed 消息不记（空串与纯空白都算）', () => {
    expect(recordOf(guildPayload(''))).toBe(false);
    expect(recordOf(guildPayload('   \n\t '))).toBe(false);
  });

  it('别的机器人在频道里的发言不记（哪怕判定就是 not-addressed）', () => {
    const botMessage = parseOrThrow(guildPayload('bot 播报', { author: { id: 'bot-2', bot: true } }));
    expect(shouldRecord(botMessage, { respond: false, reason: 'not-addressed', text: '' })).toBe(false);
  });

  it('只认 not-addressed：reason 是 bot / self / dm 时一律不记', () => {
    const message = parseOrThrow(guildPayload('随便说说'));
    for (const reason of ['bot', 'self', 'dm'] as const) {
      expect(shouldRecord(message, { respond: false, reason, text: '' })).toBe(false);
    }
  });
});

describe('messageStats（日志量纲，不含正文）', () => {
  it('只发了一个 @ 提及：rawLen>0 而 textLen=0', () => {
    const message = parseOrThrow(guildPayload('<' + '@' + BOT_ID + '>', { mentions: [{ id: BOT_ID }] }));
    expect(messageStats(message, BOT_ID)).toEqual({ mentions: 1, textLen: 0, rawLen: BOT_ID.length + 3 });
  });

  it('正文被抹成空串：rawLen=0（说明 Discord 没给 content）', () => {
    const message = parseOrThrow(guildPayload('', { mentions: [{ id: BOT_ID }] }));
    expect(messageStats(message, BOT_ID)).toEqual({ mentions: 1, textLen: 0, rawLen: 0 });
  });

  it('正常正文：mentions 计数与剥离后的长度都对得上', () => {
    const message = parseOrThrow(guildPayload('<' + '@' + BOT_ID + '> 讲个笑话', { mentions: [{ id: BOT_ID }] }));
    const stats = messageStats(message, BOT_ID);
    expect(stats.mentions).toBe(1);
    expect(stats.textLen).toBe('讲个笑话'.length);
    expect(stats.rawLen).toBeGreaterThan(stats.textLen);
  });

  it('没给 mentions 数组时按 0 计', () => {
    expect(messageStats(parseOrThrow(dmPayload('hi', { mentions: undefined })), BOT_ID)).toEqual({
      mentions: 0,
      textLen: 2,
      rawLen: 2,
    });
  });
});

describe('chunkMessage', () => {
  it('空文本不产生任何消息', () => {
    expect(chunkMessage('   ')).toEqual([]);
    expect(chunkMessage('')).toEqual([]);
  });

  it('短文本原样一条', () => {
    expect(chunkMessage('短回复')).toEqual(['短回复']);
  });

  it('超长文本切成多段，每段都在上限内且拼回原文', () => {
    const long = Array.from({ length: 400 }, (_value, index) => '第' + String(index) + '行内容').join('\n');
    const chunks = chunkMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MESSAGE_CHUNK_LIMIT);
      expect(chunk.length).toBeGreaterThan(0);
    }
    expect(chunks.join('\n')).toBe(long);
  });

  it('没有换行时也硬切而不超限', () => {
    const chunks = chunkMessage('a'.repeat(5000), 1000);
    expect(chunks).toHaveLength(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
  });

  it('上限常量与 Discord 的 2000 字符约束一致', () => {
    expect(MESSAGE_CHUNK_LIMIT).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(DISCORD_MESSAGE_LIMIT).toBe(2000);
  });
});

describe('createChannelClient', () => {
  interface Captured {
    url: string;
    init: RequestInit | undefined;
  }

  function fakeFetch(captured: Captured[], status = 200, body = '{}'): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured.push({ url: String(input), init });
      return Promise.resolve(new Response(body, { status }));
    };
  }

  it('sendMessage 用 Bot token POST 到频道消息端点', async () => {
    const captured: Captured[] = [];
    const client = createChannelClient({ botToken: 'tok', fetch: fakeFetch(captured) });
    await client.sendMessage('chan-1', '你好');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(DISCORD_API_BASE + '/channels/chan-1/messages');
    expect(captured[0].init?.method).toBe('POST');
    const headers = captured[0].init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bot tok');
    expect(headers['content-type']).toBe('application/json');
    // 只解析用户提及：正文里的 <@id> 要真的 ping 到人，@everyone / @角色 一律不响
    expect(JSON.parse(String(captured[0].init?.body))).toEqual({ content: '你好', allowed_mentions: { parse: ['users'] } });
  });

  it('sendTyping 打到 typing 端点', async () => {
    const captured: Captured[] = [];
    const client = createChannelClient({ botToken: 'tok', apiBase: 'https://example.test/v10', fetch: fakeFetch(captured) });
    await client.sendTyping('chan-9');
    expect(captured[0].url).toBe('https://example.test/v10/channels/chan-9/typing');
  });

  it('非 2xx 时抛出带状态码与响应片段的错误', async () => {
    const captured: Captured[] = [];
    const client = createChannelClient({ botToken: 'tok', fetch: fakeFetch(captured, 403, 'Missing Access') });
    await expect(client.sendMessage('chan-1', 'hi')).rejects.toThrow('discord HTTP 403: Missing Access');
  });
});
