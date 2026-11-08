import { describe, expect, it } from 'vitest';
import {
  BROADCAST_TARGETS,
  MAX_REACTIONS,
  REACT_DIRECTIVE_PREFIX,
  REPLY_EXCERPT_CHARS,
  expandBroadcast,
  parseReactionValue,
  reactionKey,
  replySuffix,
  spreadReactions,
  splitReactDirectives,
  visibleText,
} from '../src/core/chat/react';
import type { ReactionTarget } from '../src/core/types';

describe('splitReactDirectives 契约常量（§28.1）', () => {
  it('上限从 2 提到 10，其余常量不动', () => {
    expect(MAX_REACTIONS).toBe(10);
    expect(REPLY_EXCERPT_CHARS).toBe(40);
    expect(REACT_DIRECTIVE_PREFIX).toBe('[[react:');
  });
});

describe('parseReactionValue 三种写法（§28.3）', () => {
  it('没有 @ → 只有 emoji，目标是触发这一轮的那条', () => {
    expect(parseReactionValue('😄')).toEqual({ emoji: '😄' });
    expect(parseReactionValue('  😄  ')).toEqual({ emoji: '😄' });
  });

  it('@ 后面是 15..20 位数字 → messageId', () => {
    expect(parseReactionValue('😄@123456789012345678')).toEqual({ emoji: '😄', messageId: '123456789012345678' });
    // 边界：15 位与 20 位都算 ID
    expect(parseReactionValue('😄@123456789012345')).toEqual({ emoji: '😄', messageId: '123456789012345' });
    expect(parseReactionValue('😄@12345678901234567890')).toEqual({ emoji: '😄', messageId: '12345678901234567890' });
  });

  it('@ 后面是名字 → authorName，两侧空白都 trim', () => {
    expect(parseReactionValue('😄@卡利亞士兵')).toEqual({ emoji: '😄', authorName: '卡利亞士兵' });
    expect(parseReactionValue('  卡利亞士兵  ')).toEqual({ emoji: '卡利亞士兵' });
    expect(parseReactionValue('  😄 @ 卡利亞士兵  ')).toEqual({ emoji: '😄', authorName: '卡利亞士兵' });
  });

  it('14 位 / 21 位 / 带字母的都不是合法 ID，退化成作者名', () => {
    expect(parseReactionValue('😄@12345678901234')).toEqual({ emoji: '😄', authorName: '12345678901234' });
    expect(parseReactionValue('😄@123456789012345678901')).toEqual({ emoji: '😄', authorName: '123456789012345678901' });
    expect(parseReactionValue('😄@abc123')).toEqual({ emoji: '😄', authorName: 'abc123' });
    expect(parseReactionValue('😄@12345678901234567a')).toEqual({ emoji: '😄', authorName: '12345678901234567a' });
  });

  it('作者名 1..32 个字符：正好 32 收下，33 丢弃整条', () => {
    const name32 = '字'.repeat(32);
    expect(parseReactionValue('😄@' + name32)).toEqual({ emoji: '😄', authorName: name32 });
    expect(parseReactionValue('😄@' + '字'.repeat(33))).toBeNull();
  });

  it('左侧为空 → null；整条空值 → null', () => {
    expect(parseReactionValue('@123456789012345678')).toBeNull();
    expect(parseReactionValue('@')).toBeNull();
    expect(parseReactionValue('')).toBeNull();
    expect(parseReactionValue('   ')).toBeNull();
  });

  it('整条超过 64 个字符 → null；正好 64 收下（§28.3 的旧上限仍然管用）', () => {
    const exact = 'a'.repeat(64);
    expect(parseReactionValue(exact)).toEqual({ emoji: 'a'.repeat(64) });
    expect(parseReactionValue('a'.repeat(65))).toBeNull();
  });

  it('@ 右侧空着：等于没写目标，别因为多一个 @ 白丢表情', () => {
    expect(parseReactionValue('😄@')).toEqual({ emoji: '😄' });
    expect(parseReactionValue('😄@  ')).toEqual({ emoji: '😄' });
  });

  it('取最后一个 @ 切分：作者名里带 @ 时右侧才是目标', () => {
    expect(parseReactionValue('😄@a@卡利亞士兵')).toEqual({ emoji: '😄@a', authorName: '卡利亞士兵' });
  });
});

describe('splitReactDirectives 剥离指令（§28.3 字段名 reactions）', () => {
  it('末尾独占一行的一条指令被整行删掉，不留下空行', () => {
    const out = splitReactDirectives('今天好累\n[[react:👍]]');
    expect(out.text).toBe('今天好累');
    expect(out.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('指令在行尾时连同前面的空格一起裁掉', () => {
    const out = splitReactDirectives('今天好累 [[react:👍]]');
    expect(out.text).toBe('今天好累');
    expect(out.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('指令夹在正文中间：正文两段都留下，语法一点不露', () => {
    const out = splitReactDirectives('前半[[react:😀]]后半');
    expect(out.text).not.toContain(REACT_DIRECTIVE_PREFIX);
    expect(out.text).toContain('前半');
    expect(out.text).toContain('后半');
    expect(out.reactions).toEqual([{ emoji: '😀' }]);
  });

  it('独占一行的指令删掉后，前后两行直接相邻', () => {
    const out = splitReactDirectives('第一行\n[[react:👍]]\n第二行');
    expect(out.text).toBe('第一行\n第二行');
    expect(out.reactions).toEqual([{ emoji: '👍' }]);
  });

  it('多次出现：去重且保持出现顺序', () => {
    const out = splitReactDirectives('好的[[react:👍]]收到[[react:👍]]了[[react:🔥]]');
    expect(out.text).toBe('好的收到了');
    expect(out.reactions).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
  });

  it('指令里可以带目标，messageId 与 authorName 原样带下来', () => {
    const out = splitReactDirectives('好的[[react:👍@123456789012345678]]吧[[react:🔥@卡利亞士兵]]');
    expect(out.text).toBe('好的吧');
    expect(out.reactions).toEqual([
      { emoji: '👍', messageId: '123456789012345678' },
      { emoji: '🔥', authorName: '卡利亞士兵' },
    ]);
  });

  it('去重键是 表情|目标：同一句贴到不同目标是两条，同键只收一次', () => {
    expect(splitReactDirectives('[[react:👍]][[react:👍@123456789012345678]]').reactions).toHaveLength(2);
    expect(splitReactDirectives('[[react:👍@卡利亞士兵]][[react:👍@小助手]]').reactions).toHaveLength(2);
    expect(splitReactDirectives('[[react:👍@123456789012345678]][[react:👍@123456789012345678]]').reactions).toEqual([
      { emoji: '👍', messageId: '123456789012345678' },
    ]);
  });

  it('超过 MAX_REACTIONS 的按出现顺序丢弃', () => {
    const many: string[] = [];
    for (let index = 0; index <= MAX_REACTIONS; index += 1) many.push('[[react:e' + String(index) + ']]');
    const out = splitReactDirectives(many.join(''));
    expect(out.text).toBe('');
    expect(out.reactions).toHaveLength(MAX_REACTIONS);
    expect(out.reactions.at(-1)).toEqual({ emoji: 'e' + String(MAX_REACTIONS - 1) });
  });

  it('解不出来的指令只剥不产出：空白、左侧空、作者名超长的都被丢', () => {
    const out = splitReactDirectives('好的[[react:   ]][[react:@123456789012345678]][[react:😄@' + '字'.repeat(33) + ']]');
    expect(out.text).toBe('好的');
    expect(out.reactions).toEqual([]);
    expect(splitReactDirectives('[[react:  ]]').text).toBe('');
  });

  it('连续空行压成一个换行，整体 trim', () => {
    expect(splitReactDirectives('\n\n甲\n\n\n乙\n\n').text).toBe('甲\n\n乙');
    expect(splitReactDirectives('   ').text).toBe('');
    expect(splitReactDirectives('').text).toBe('');
  });

  it('没有指令时正文逐字返回（只有行尾空白与空行被规范化）', () => {
    const out = splitReactDirectives('就一句话');
    expect(out).toEqual({ text: '就一句话', reactions: [] });
  });

  it('语法不合法的不当指令：缺 ]] 或缺内容的原样留着', () => {
    expect(splitReactDirectives('[[react:👍').text).toBe('[[react:👍');
    expect(splitReactDirectives('[[react:]]').text).toBe('[[react:]]');
  });
});

describe('visibleText 流式进度', () => {
  it('未闭合的指令被截掉：进度里看不到半截语法', () => {
    expect(visibleText('前半[[react:👍')).toBe('前半');
    expect(visibleText('前半[[re')).toBe('前半');
    expect(visibleText('[[react:👍')).toBe('');
  });

  it('已闭合的指令同样剥掉，只留正文', () => {
    expect(visibleText('前半[[react:👍]]后半')).not.toContain(REACT_DIRECTIVE_PREFIX);
    expect(visibleText('前半[[react:👍]]后半')).toContain('前半');
    expect(visibleText('前半[[react:👍]]后半')).toContain('后半');
  });

  it('单个 [ 不是指令起点，原样返回；返回前 trim', () => {
    expect(visibleText('abc[not-directive')).toBe('abc[not-directive');
    expect(visibleText('  你好  ')).toBe('你好');
    expect(visibleText('')).toBe('');
  });
});

const REPLY = { messageId: 'm-1', author: '小明', authorId: 'u1', content: '我也想看电影' };

describe('replySuffix 回复后缀（§18.3 退化表）', () => {
  it('没有 replyTo 时是空串，历史行与旧版逐字一致', () => {
    expect(replySuffix(undefined)).toBe('');
  });

  it('名字与 id 都有：<名字>(<id>)', () => {
    expect(replySuffix(REPLY)).toBe(' ↳ 回复 小明(u1)：「我也想看电影」');
  });

  it('只有名字：不带空括号', () => {
    expect(replySuffix({ ...REPLY, authorId: '' })).toBe(' ↳ 回复 小明：「我也想看电影」');
    expect(replySuffix({ ...REPLY, authorId: '   ' })).toBe(' ↳ 回复 小明：「我也想看电影」');
  });

  it('只有 id：直接写 id', () => {
    expect(replySuffix({ ...REPLY, author: '' })).toBe(' ↳ 回复 u1：「我也想看电影」');
  });

  it('名字与 id 都缺：退化成「一条更早的消息」', () => {
    expect(replySuffix({ ...REPLY, author: '', authorId: '' })).toBe(' ↳ 回复一条更早的消息：「我也想看电影」');
  });

  it('原文为空或全空白：省略整段引文', () => {
    expect(replySuffix({ ...REPLY, content: '' })).toBe(' ↳ 回复 小明(u1)');
    expect(replySuffix({ ...REPLY, content: ' \n\t ' })).toBe(' ↳ 回复 小明(u1)');
  });

  it('原文先把连续空白压成单个空格', () => {
    expect(replySuffix({ ...REPLY, content: '我也想\n\n 看电影' })).toBe(' ↳ 回复 小明(u1)：「我也想 看电影」');
  });

  it('原文超过 REPLY_EXCERPT_CHARS 个 code unit 截断并补 …，正好不超时不补', () => {
    const exact = '字'.repeat(REPLY_EXCERPT_CHARS);
    expect(replySuffix({ ...REPLY, content: exact })).toBe(' ↳ 回复 小明(u1)：「' + exact + '」');
    const long = '字'.repeat(REPLY_EXCERPT_CHARS + 5);
    expect(replySuffix({ ...REPLY, content: long })).toBe(' ↳ 回复 小明(u1)：「' + '字'.repeat(REPLY_EXCERPT_CHARS) + '…」');
  });
});
describe('spreadReactions 按最近说过话的人分散（§28.9）', () => {
  const target = (messageId: string, author: string, authorId: string, bot = false): ReactionTarget => ({
    messageId,
    author,
    authorId,
    excerpt: author + '的正文',
    bot,
  });
  const TRIGGER = 'msg-1';
  /** 清单新的在前：msg-1 是触发那条（也是最近说的），msg-9 是机器人自己发的，msg-5 是 Bob 更早的一条 */
  const TARGETS: ReactionTarget[] = [
    target('msg-1', 'Alice', 'u1'),
    target('msg-2', 'Bob', 'u2'),
    target('msg-3', 'Carol', 'u3'),
    target('msg-9', '示例角色', 'bot-1', true),
    target('msg-5', 'Bob', 'u2'),
  ];

  it('只有一个表情：不动，仍然贴触发那条', () => {
    expect(spreadReactions([{ emoji: '👍' }], TARGETS, TRIGGER)).toEqual([{ emoji: '👍' }]);
  });

  it('多个都没写目标：按聊天记录里最近说过话的次序，一人一条', () => {
    expect(spreadReactions([{ emoji: '👍' }, { emoji: '🎉' }, { emoji: '❤️' }], TARGETS, TRIGGER)).toEqual([
      { emoji: '👍', messageId: 'msg-1' },
      { emoji: '🎉', messageId: 'msg-2' },
      { emoji: '❤️', messageId: 'msg-3' },
    ]);
  });

  it('同一作者只留最新那条，机器人消息不进池子，人不够才轮第二圈', () => {
    const out = spreadReactions(
      [{ emoji: '👍' }, { emoji: '🎉' }, { emoji: '❤️' }, { emoji: '🔥' }],
      TARGETS,
      TRIGGER,
    );
    expect(out.map((one) => one.messageId)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-1']);
  });

  it('模型写了目标的那条不动，分散时避开它占用的消息', () => {
    expect(spreadReactions([{ emoji: '👍', messageId: 'msg-2' }, { emoji: '🎉' }], TARGETS, TRIGGER)).toEqual([
      { emoji: '👍', messageId: 'msg-2' },
      { emoji: '🎉', messageId: 'msg-1' },
    ]);
  });

  it('作者名目标同样占位：别的表情不再落到该作者最新那条', () => {
    expect(spreadReactions([{ emoji: '👍', authorName: 'bob' }, { emoji: '🎉' }], TARGETS, TRIGGER)).toEqual([
      { emoji: '👍', messageId: 'msg-2' },
      { emoji: '🎉', messageId: 'msg-1' },
    ]);
  });

  it('线上那种情况：模型连着给同一个人点两次，第二条改贴下一位最近说话的人', () => {
    expect(
      spreadReactions([{ emoji: '👍', authorName: 'Alice' }, { emoji: '🎉', authorName: 'Alice' }], TARGETS, TRIGGER),
    ).toEqual([
      { emoji: '👍', messageId: 'msg-1' },
      { emoji: '🎉', messageId: 'msg-2' },
    ]);
  });

  it('没有别人的消息：全部退回触发那条（与旧行为一致）', () => {
    expect(spreadReactions([{ emoji: '👍' }, { emoji: '🎉' }], [target('msg-1', 'Alice', 'u1')], TRIGGER)).toEqual([
      { emoji: '👍', messageId: 'msg-1' },
      { emoji: '🎉', messageId: 'msg-1' },
    ]);
    expect(spreadReactions([{ emoji: '👍' }, { emoji: '🎉' }], [], TRIGGER)).toEqual([
      { emoji: '👍', messageId: 'msg-1' },
      { emoji: '🎉', messageId: 'msg-1' },
    ]);
  });
});

describe('@all 广播目标（§28.10）', () => {
  const target = (messageId: string, author: string, authorId: string, bot = false): ReactionTarget => ({
    messageId,
    author,
    authorId,
    excerpt: author + '的正文',
    bot,
  });
  const TRIGGER = 'msg-1';
  /** 清单新的在前：msg-1 触发那条，msg-9 是机器人自己的，msg-5 是 Bob 更早的一条 */
  const TARGETS: ReactionTarget[] = [
    target('msg-1', 'Alice', 'u1'),
    target('msg-2', 'Bob', 'u2'),
    target('msg-3', 'Carol', 'u3'),
    target('msg-9', '示例角色', 'bot-1', true),
    target('msg-5', 'Bob', 'u2'),
  ];

  it('六种同义写法都解析成 broadcast：all / everyone / * / 大家 / 所有人 / 全员', () => {
    for (const word of ['all', 'everyone', '*', '大家', '所有人', '全员']) {
      expect(parseReactionValue('😄@' + word)).toEqual({ emoji: '😄', broadcast: true });
    }
  });

  it('大小写与首尾空白都不影响：ALL / Everyone / 大家 前后带空格', () => {
    expect(parseReactionValue('😄@ALL')).toEqual({ emoji: '😄', broadcast: true });
    expect(parseReactionValue('😄@Everyone')).toEqual({ emoji: '😄', broadcast: true });
    expect(parseReactionValue('😄@ 大家 ')).toEqual({ emoji: '😄', broadcast: true });
  });

  it('broadcast 命中时不带 messageId / authorName：它指的是「所有人」而不是某一条', () => {
    const parsed = parseReactionValue('😄@all');
    expect(parsed).toEqual({ emoji: '😄', broadcast: true });
    expect(parsed !== null && 'messageId' in parsed).toBe(false);
    expect(parsed !== null && 'authorName' in parsed).toBe(false);
  });

  it('别的目标照旧：消息 ID 走 messageId，作者名走 authorName，都不算 broadcast', () => {
    expect(parseReactionValue('😄@123456789012345678')).toEqual({ emoji: '😄', messageId: '123456789012345678' });
    expect(parseReactionValue('😄@卡利亞士兵')).toEqual({ emoji: '😄', authorName: '卡利亞士兵' });
  });

  it('同义词清单本身只放小写，比较在解析时做', () => {
    expect([...BROADCAST_TARGETS].sort()).toEqual(['*', 'all', 'everyone', '全员', '大家', '所有人'].sort());
  });

  it('broadcast 的键固定成 emoji|all：同一表情点的多处广播只留一条', () => {
    expect(reactionKey({ emoji: '😄', broadcast: true })).toBe('😄|all');
    expect(reactionKey({ emoji: '😄', messageId: 'm-1' })).toBe('😄|m-1');
    expect(reactionKey({ emoji: '😄', authorName: 'Bob' })).toBe('😄|Bob');
    expect(reactionKey({ emoji: '😄' })).toBe('😄|');
    expect(reactionKey({ emoji: '😄', broadcast: true })).not.toBe(reactionKey({ emoji: '😄' }));
  });

  it('没点名 @all 的一条都不分配：不再按最近发言者硬摊', () => {
    expect(expandBroadcast([{ emoji: '👍' }, { emoji: '🎉' }, { emoji: '❤️' }], TARGETS, TRIGGER)).toEqual([
      { emoji: '👍' },
      { emoji: '🎉' },
      { emoji: '❤️' },
    ]);
  });

  it('显式目标原样保留', () => {
    expect(
      expandBroadcast([{ emoji: '👍', messageId: 'msg-2' }, { emoji: '🎉', authorName: 'Carol' }], TARGETS, TRIGGER),
    ).toEqual([
      { emoji: '👍', messageId: 'msg-2' },
      { emoji: '🎉', authorName: 'Carol' },
    ]);
  });

  it('点名 @all：最近说过话的人各一条，跳过机器人、按作者去重', () => {
    expect(expandBroadcast([{ emoji: '😄', broadcast: true }], TARGETS, TRIGGER)).toEqual([
      { emoji: '😄', messageId: 'msg-1' },
      { emoji: '😄', messageId: 'msg-2' },
      { emoji: '😄', messageId: 'msg-3' },
    ]);
  });

  it('展开结果不带 broadcast 字段：执行侧只认具体消息', () => {
    const out = expandBroadcast([{ emoji: '😄', broadcast: true }], TARGETS, TRIGGER);
    expect(out.every((one) => !('broadcast' in one))).toBe(true);
  });

  it('广播与普通条目混着来：普通的原样，广播的展开，顺序不动', () => {
    // 显式目标只占自己的键（emoji|目标），不占池子名额：广播照样从最近那个人开始发
    expect(
      expandBroadcast([{ emoji: '👍', messageId: 'msg-3' }, { emoji: '😄', broadcast: true }], TARGETS, TRIGGER),
    ).toEqual([
      { emoji: '👍', messageId: 'msg-3' },
      { emoji: '😄', messageId: 'msg-1' },
      { emoji: '😄', messageId: 'msg-2' },
      { emoji: '😄', messageId: 'msg-3' },
    ]);
  });

  it('池子只有触发那条：广播就贴它一条', () => {
    expect(expandBroadcast([{ emoji: '😄', broadcast: true }], [target('msg-1', 'Alice', 'u1')], TRIGGER)).toEqual([
      { emoji: '😄', messageId: 'msg-1' },
    ]);
  });

  it('清单为空：兜底贴触发那条，不是什么都不贴', () => {
    expect(expandBroadcast([{ emoji: '😄', broadcast: true }], [], TRIGGER)).toEqual([{ emoji: '😄', messageId: 'msg-1' }]);
  });

  it('人比上限多：最多 MAX_REACTIONS 条', () => {
    const many: ReactionTarget[] = [];
    for (let index = 0; index < 20; index += 1) {
      many.push(target('m-' + String(index), 'user' + String(index), 'u-' + String(index)));
    }
    const out = expandBroadcast([{ emoji: '😄', broadcast: true }], many, 'm-0');
    expect(out).toHaveLength(MAX_REACTIONS);
    expect(new Set(out.map((one) => one.messageId)).size).toBe(MAX_REACTIONS);
  });

  it('同一个表情广播两次只展开一次（键去重）', () => {
    const out = expandBroadcast(
      [
        { emoji: '😄', broadcast: true },
        { emoji: '😄', broadcast: true },
      ],
      TARGETS,
      TRIGGER,
    );
    expect(out).toEqual([
      { emoji: '😄', messageId: 'msg-1' },
      { emoji: '😄', messageId: 'msg-2' },
      { emoji: '😄', messageId: 'msg-3' },
    ]);
  });

  it('广播吃满上限后，后面的普通条目不再挤进来', () => {
    const many: ReactionTarget[] = [];
    for (let index = 0; index < MAX_REACTIONS; index += 1) {
      many.push(target('m-' + String(index), 'user' + String(index), 'u-' + String(index)));
    }
    const out = expandBroadcast([{ emoji: '😄', broadcast: true }, { emoji: '🔥', messageId: 'm-0' }], many, 'm-0');
    expect(out).toHaveLength(MAX_REACTIONS);
    expect(out.some((one) => one.emoji === '🔥')).toBe(false);
  });
});

