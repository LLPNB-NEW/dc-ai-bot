import { describe, expect, it } from 'vitest';
import {
  QQ_C2C_EVENT,
  QQ_EMPTY_TEXT,
  QQ_GROUP_EVENT,
  QQ_GROUP_FULL_EVENT,
  QQ_REPLY_CHUNK_MAX,
  buildQqReplyBody,
  normalizeQqText,
  parseQqEvent,
  parseQqFrame,
  qqLinkDisplayName,
  qqReplyPath,
  splitQqReply,
  stripLeadingMention,
  type QqIncomingMessage,
} from '../src/node/qq/protocol';

describe('QQ 事件解析', () => {
  it('把群 @ 消息解析成平台无关消息', () => {
    const message = parseQqEvent(QQ_GROUP_EVENT, {
      id: 'EVENT-1',
      content: '<@!123456> 你好呀',
      group_openid: 'GROUP-OPENID',
      author: { member_openid: 'MEMBER-OPENID', username: '小明' },
    });
    expect(message).toEqual({
      kind: 'qq_group',
      externalId: 'GROUP-OPENID',
      userId: 'MEMBER-OPENID',
      userName: '小明',
      text: '你好呀',
      eventId: 'EVENT-1',
      mentioned: true,
    });
  });

  it('群里缺 member_openid 时退回 author.id，缺 username 时叫 QQ用户', () => {
    const message = parseQqEvent(QQ_GROUP_EVENT, {
      id: 'EVENT-2',
      content: '  hi  ',
      group_openid: 'G',
      author: { id: 'LEGACY-ID' },
    });
    expect(message?.userId).toBe('LEGACY-ID');
    expect(message?.userName).toBe('QQ用户');
    expect(message?.text).toBe('hi');
  });

  it('把单聊消息解析成 qq_c2c，用户与外部 id 是同一个人', () => {
    const message = parseQqEvent(QQ_C2C_EVENT, {
      id: 'EVENT-3',
      content: '在吗',
      author: { user_openid: 'USER-OPENID', username: '阿花' },
    });
    expect(message).toEqual({
      kind: 'qq_c2c',
      externalId: 'USER-OPENID',
      userId: 'USER-OPENID',
      userName: '阿花',
      text: '在吗',
      eventId: 'EVENT-3',
      mentioned: true,
    });
  });

  it('单聊缺 user_openid 时退回 author.id', () => {
    const message = parseQqEvent(QQ_C2C_EVENT, { id: 'E', content: 'x', author: { id: 'AUTHOR-ID' } });
    expect(message?.externalId).toBe('AUTHOR-ID');
  });

  it('解析 msg_idx / ref_msg_idx，并从嵌套 msg_elements 取被引用正文', () => {
    const message = parseQqEvent(QQ_GROUP_EVENT, {
      id: 'EVENT-QUOTE',
      content: '<@!1> 你刚才说什么',
      group_openid: 'G',
      author: { member_openid: 'USER-2', username: '阿花' },
      message_scene: { ext: ['msg_idx=MSG-2', 'ref_msg_idx=MSG-1', 'auth_token=secret'] },
      msg_elements: [
        {
          msg_idx: 'MSG-2',
          message_type: 103,
          content: '你刚才说什么',
          msg_elements: [{ msg_idx: 'MSG-1', message_type: 0, content: '原来的话' }],
        },
      ],
    });
    expect(message).toMatchObject({
      msgIdx: 'MSG-2',
      refMsgIdx: 'MSG-1',
      quoteText: '原来的话',
    });
  });

  it('引用一条本身也是引用的消息时，把内层正文放进 quoteChain', () => {
    const message = parseQqEvent(QQ_GROUP_EVENT, {
      id: 'EVENT-QUOTE-NESTED',
      content: '<@!1> 什么？',
      group_openid: 'G',
      author: { member_openid: 'USER-3', username: '小红' },
      message_scene: { ext: ['msg_idx=MSG-3', 'ref_msg_idx=MSG-2'] },
      msg_elements: [
        {
          msg_idx: 'MSG-3',
          message_type: 103,
          content: '什么？',
          msg_elements: [
            {
              msg_idx: 'MSG-2',
              message_type: 103,
              content: '我引用他',
              msg_elements: [{ msg_idx: 'MSG-1', message_type: 0, content: '原来的话' }],
            },
          ],
        },
      ],
    });
    expect(message).toMatchObject({
      msgIdx: 'MSG-3',
      refMsgIdx: 'MSG-2',
      quoteText: '我引用他',
      quoteChain: ['原来的话'],
    });
  });

  it('ref 缺失且外层 type=103 带子节点时，取子节点而不是当前正文', () => {
    const message = parseQqEvent(QQ_GROUP_EVENT, {
      id: 'EVENT-QUOTE-NESTED-2',
      content: '<@!1> 什么？',
      group_openid: 'G',
      author: { member_openid: 'USER-3', username: '小红' },
      message_scene: { ext: ['msg_idx=MSG-3', 'ref_msg_idx=MSG-MISSING'] },
      msg_elements: [
        {
          msg_idx: 'MSG-3',
          message_type: 103,
          content: '什么？',
          msg_elements: [
            {
              msg_idx: 'MSG-2',
              message_type: 103,
              content: '我引用他',
              msg_elements: [{ msg_idx: 'MSG-1', message_type: 0, content: '原来的话' }],
            },
          ],
        },
      ],
    });
    expect(message).toMatchObject({ quoteText: '我引用他', quoteChain: ['原来的话'] });
  });

  it('只有 type=103 的引用元素时也能取到正文', () => {
    const message = parseQqEvent(QQ_C2C_EVENT, {
      id: 'EVENT-QUOTE-2',
      content: '你说呢',
      author: { user_openid: 'USER-2', username: '阿花' },
      message_scene: { ext: ['ref_msg_idx=MSG-9'] },
      msg_elements: [{ msg_idx: 'MSG-OTHER', message_type: 103, content: '引用正文' }],
    });
    expect(message?.refMsgIdx).toBe('MSG-9');
    expect(message?.quoteText).toBe('引用正文');
  });

  it('空正文落成占位文案，而不是一条空回复', () => {
    const message = parseQqEvent(QQ_GROUP_EVENT, {
      id: 'EVENT-4',
      content: '   ',
      group_openid: 'G',
      author: { member_openid: 'M' },
    });
    expect(message?.text).toBe(QQ_EMPTY_TEXT);
  });

  it('群开了全量模式后，解析所有人类消息，@ 只决定回不回', () => {
    const message = parseQqEvent(QQ_GROUP_FULL_EVENT, {
      id: 'EVENT-FULL-1',
      content: '<@!BOT> 在吗',
      group_openid: 'GROUP-OPENID',
      author: { member_openid: 'MEMBER-OPENID', username: '小明' },
      mentions: [{ is_you: true, scope: 'single' }],
    });
    expect(message).toEqual({
      kind: 'qq_group',
      externalId: 'GROUP-OPENID',
      userId: 'MEMBER-OPENID',
      userName: '小明',
      text: '在吗',
      eventId: 'EVENT-FULL-1',
      mentioned: true,
    });

    const base = {
      id: 'EVENT-FULL-2',
      content: '没 @ 机器人',
      group_openid: 'GROUP-OPENID',
      author: { member_openid: 'MEMBER-OPENID', username: '小明' },
    };
    expect(parseQqEvent(QQ_GROUP_FULL_EVENT, base)).toMatchObject({
      text: '没 @ 机器人',
      mentioned: false,
    });
    expect(parseQqEvent(QQ_GROUP_FULL_EVENT, { ...base, mentions: [{ is_you: false, scope: 'all' }] })).toMatchObject({
      text: '没 @ 机器人',
      mentioned: false,
    });
  });

  it('全量模式里机器人自己的回复不解析，避免自问自答', () => {
    const message = parseQqEvent(QQ_GROUP_FULL_EVENT, {
      id: 'EVENT-FULL-3',
      content: '刚到',
      group_openid: 'GROUP-OPENID',
      author: { member_openid: 'BOT-OPENID', bot: true },
      mentions: [{ is_you: true, scope: 'single' }],
    });
    expect(message).toBeNull();
  });

  it('不认识的事件类型与缺字段一律返回 null', () => {
    expect(parseQqEvent('AT_MESSAGE_CREATE', { id: 'x', content: 'y' })).toBeNull();
    expect(parseQqEvent(QQ_GROUP_EVENT, { content: 'x', group_openid: 'G' })).toBeNull();
    expect(parseQqEvent(QQ_GROUP_EVENT, { id: 'x', content: 'y' })).toBeNull();
    expect(parseQqEvent(QQ_C2C_EVENT, { id: 'x', content: 'y', author: {} })).toBeNull();
    expect(parseQqEvent(QQ_GROUP_EVENT, null)).toBeNull();
  });
});

describe('开头 @ 与正文清洗', () => {
  it('剥掉 <@!id>、<@id> 与全角 @ 三种写法', () => {
    expect(stripLeadingMention('<@!123> 你好')).toBe('你好');
    expect(stripLeadingMention('<@123>你好')).toBe('你好');
    expect(stripLeadingMention('＠小神鲸 你好')).toBe('你好');
  });

  it('没有 @ 时只动首尾空白', () => {
    expect(stripLeadingMention('  你好  ')).toBe('你好');
    expect(normalizeQqText('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('非字符串正文按空消息处理', () => {
    expect(normalizeQqText(undefined)).toBe(QQ_EMPTY_TEXT);
    expect(normalizeQqText(42)).toBe(QQ_EMPTY_TEXT);
  });
});

describe('websocket 帧与回复请求', () => {
  it('解析 Hello / Dispatch 帧，s 允许是字符串', () => {
    const hello = parseQqFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
    expect(hello?.op).toBe(10);
    expect(hello?.t).toBe('');
    const dispatch = parseQqFrame('{"op":0,"s":42,"t":"READY","d":{}}');
    expect(dispatch).toEqual({ op: 0, s: 42, t: 'READY', d: {} });
    expect(parseQqFrame('not json')).toBeNull();
    expect(parseQqFrame('{"no_op":true}')).toBeNull();
  });

  it('回复路由按群/单聊分开，openid 做转义', () => {
    expect(qqReplyPath('qq_group', 'G1')).toBe('/v2/groups/G1/messages');
    expect(qqReplyPath('qq_c2c', 'U1')).toBe('/v2/users/U1/messages');
    expect(qqReplyPath('qq_group', 'a/b c')).toBe('/v2/groups/a%2Fb%20c/messages');
  });

  it('请求体带 msg_id 与递增的 msg_seq，空正文直接拒发', () => {
    expect(buildQqReplyBody('回复', 'EVENT-1', 1)).toEqual({ content: '回复', msg_id: 'EVENT-1', msg_seq: 1 });
    expect(buildQqReplyBody('回复', 'EVENT-1', 2).msg_seq).toBe(2);
    expect(() => buildQqReplyBody('   ', 'EVENT-1', 1)).toThrow('QQ_REPLY_EMPTY');
  });
});

describe('回复分片', () => {
  it('短文本原样一片，空白文本不发', () => {
    expect(splitQqReply('就一句')).toEqual(['就一句']);
    expect(splitQqReply('')).toEqual([]);
    expect(splitQqReply('   ')).toEqual([]);
    expect(splitQqReply('y'.repeat(QQ_REPLY_CHUNK_MAX))).toEqual(['y'.repeat(QQ_REPLY_CHUNK_MAX)]);
  });

  it('优先断在换行上', () => {
    const text = 'a'.repeat(1000) + '\n' + 'b'.repeat(1000);
    expect(splitQqReply(text)).toEqual(['a'.repeat(1000), 'b'.repeat(1000)]);
  });

  it('每片不超过 1800 字、最多 5 片，超出的以省略号收尾', () => {
    const chunks = splitQqReply('x'.repeat(12_000));
    expect(chunks).toHaveLength(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(QQ_REPLY_CHUNK_MAX);
    expect(chunks[chunks.length - 1]?.endsWith('…')).toBe(true);
  });
});

describe('QQ 链接展示名', () => {
  const incoming = (overrides: Partial<QqIncomingMessage>): QqIncomingMessage => ({
    kind: 'qq_group',
    externalId: 'GROUP-OPENID-abc123',
    userId: 'USER-1',
    userName: '小明',
    text: '你好',
    eventId: 'EVENT-1',
    mentioned: true,
    ...overrides,
  });

  it('群名不可得：用 openid 末 6 位拼成「QQ群·abc123」', () => {
    expect(qqLinkDisplayName(incoming({}))).toBe('QQ群·abc123');
  });

  it('openid 不足 6 位时整段拿来用，不补空', () => {
    expect(qqLinkDisplayName(incoming({ externalId: 'AB1' }))).toBe('QQ群·AB1');
  });

  it('单聊不改写，仍用发送者昵称', () => {
    expect(qqLinkDisplayName(incoming({ kind: 'qq_c2c', externalId: 'USER-9', userName: '阿花' }))).toBe('阿花');
  });
});
