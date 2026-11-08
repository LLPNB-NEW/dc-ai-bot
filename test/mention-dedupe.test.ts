import { describe, expect, it } from 'vitest';
import { MENTION_TAG_RE, buildMentionNames, dedupeMentions, renderMentionRule } from '../src/core/chat/mention-dedupe';
import type { ChatMessage } from '../src/core/types';

/** 真实的 Discord snowflake 是 15~20 位数字，正则只认这个区间，用例里的 id 也必须是数字 */
const A = '111111111111111111';
const B = '222222222222222222';

/** 聊天记录里出现过的名字：@ 过之后再提到这个人，正文里就该只剩这几个字 */
const NAMES = new Map<string, string>([
  [A, '小明'],
  [B, '小乙'],
]);

const NO_NAMES = new Map<string, string>();

/** 一条真实的提及标签 */
const tag = (id: string): string => '<@' + id + '>';
/** 昵称形态的提及标签：Discord 两种写法都指向同一个人 */
const nickTag = (id: string): string => '<@!' + id + '>';

function dedupe(
  text: string,
  alreadyPinged: readonly string[] = [],
  names: ReadonlyMap<string, string> = NO_NAMES,
): string {
  return dedupeMentions(text, { alreadyPinged, names });
}

describe('MENTION_TAG_RE', () => {
  it('两种提及写法都认；不足 15 位或超过 20 位的数字不算提及', () => {
    expect((tag(A) + ' ' + nickTag(A)).match(new RegExp(MENTION_TAG_RE.source, 'g'))).toEqual([tag(A), nickTag(A)]);
    expect('<@12345678901234> 和 <@123456789012345678901>'.match(new RegExp(MENTION_TAG_RE.source, 'g'))).toBeNull();
  });
});

describe('dedupeMentions', () => {
  it('第一次保留原标签，第二次换成聊天记录里的名字（不带 @、不加括号）', () => {
    expect(dedupe('甲 ' + tag(A) + ' 乙 ' + tag(A) + ' 丙', [], NAMES)).toBe('甲 ' + tag(A) + ' 乙 小明 丙');
  });

  it('已经 ping 过的 id（开头前缀算一次）连正文第一处也换成名字', () => {
    expect(dedupe(tag(A) + ' 你好 ' + tag(A), [A], NAMES)).toBe('小明 你好 小明');
  });

  it('名字查不到就整段删标签：不留双空格，也不在标点前留空格', () => {
    // 删掉标签后左右都是中文：不补空格，否则「甲 乙 丙」中间凭空多出停顿
    expect(dedupe('甲 ' + tag(A) + ' 乙 ' + tag(A) + ' 丙', [A], NO_NAMES)).toBe('甲乙丙');
    expect(dedupe('甲 ' + tag(A) + ' 乙 ' + tag(A) + ' 丙', [A], NO_NAMES)).not.toContain('  ');
    expect(dedupe('甲 ' + tag(A) + ' ，', [A], NO_NAMES)).toBe('甲，');
    expect(dedupe(tag(A) + ' 你', [A], NO_NAMES)).toBe('你');
    expect(dedupe('甲 ' + tag(A), [A], NO_NAMES)).toBe('甲');
    // 英文两侧仍然留一个空格，否则两个词会粘成一个
    expect(dedupe('Hello ' + tag(A) + ' world', [A], NO_NAMES)).toBe('Hello world');
  });

  it('标签两种写法是同一个人：混着写也照样只留第一次', () => {
    expect(dedupe('甲 ' + nickTag(A) + ' 乙 ' + tag(A), [], NAMES)).toBe('甲 ' + nickTag(A) + ' 乙 小明');
    expect(dedupe('甲 ' + tag(A) + ' 乙 ' + nickTag(A), [], NAMES)).toBe('甲 ' + tag(A) + ' 乙 小明');
  });

  it('两个不同的人各自保留第一次，重复的那次才换名字', () => {
    expect(dedupe(tag(A) + ' ' + tag(B) + ' ' + tag(A) + ' ' + tag(B), [], NAMES)).toBe(
      tag(A) + ' ' + tag(B) + ' 小明 小乙',
    );
  });

  it('没有重复就原样返回同一段文本', () => {
    const text = '甲 ' + tag(A) + ' 乙 ' + tag(B);
    expect(dedupe(text, [], NAMES)).toBe(text);
    expect(dedupe('你好，这一段没有任何提及', [], NAMES)).toBe('你好，这一段没有任何提及');
  });

  it('纯函数：反复算、按累积前缀一段段算，结果只由传进来的文本决定', () => {
    const full = '甲 ' + tag(A) + ' 乙 ' + tag(A) + ' 丙';
    const once = dedupe(full, [], NAMES);
    expect(dedupe(once, [], NAMES)).toBe(once);
    // 进度侧每块都拿全量累积文本重算：只攒到一个标签时它还算第一次
    expect(dedupe('甲 ' + tag(A) + ' ', [], NAMES)).toBe('甲 ' + tag(A) + ' ');
    expect(dedupe('甲 ' + tag(A) + ' 乙 ' + tag(A), [], NO_NAMES)).toBe('甲 ' + tag(A) + ' 乙');
    expect(once).toBe('甲 ' + tag(A) + ' 乙 小明 丙');
  });

  it('空文本、只剩标签的文本都不炸', () => {
    expect(dedupe('', [], NAMES)).toBe('');
    expect(dedupe(tag(A), [A], NAMES)).toBe('小明');
    expect(dedupe(tag(A), [A], NO_NAMES)).toBe('');
    expect(dedupe(tag(A), [], NO_NAMES)).toBe(tag(A));
  });
});

describe('buildMentionNames', () => {
  it('后出现的覆盖先出现的；只收 role=user 且名字与 id 都非空的行', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a', author: '旧名', authorId: A },
      { role: 'assistant', content: 'b', author: '机器人', authorId: A },
      { role: 'user', content: 'c', author: ' 新名 ', authorId: ' ' + A + ' ' },
      { role: 'user', content: 'd', author: '   ', authorId: B },
      { role: 'user', content: 'e', author: '没有 id 的名字' },
      { role: 'user', content: 'f', author: '只有 id 没有名字', authorId: '' },
    ];

    expect([...buildMentionNames(messages).entries()]).toEqual([[A, '新名']]);
  });
});

describe('renderMentionRule', () => {
  it('规则正文逐字固定：教她之后写昵称或绰号，并封死 @everyone 与 @角色', () => {
    expect(renderMentionRule().trim()).toBe(
      '【提及】一轮回复里同一个人最多 @ 一次：第一次直接写 <@用户ID>；之后提到这个人，' +
        '一律直接写昵称或绰号，不要再写 <@ID>。系统已经在开头 @ 过提问的人，正文里再提到他/她就不要重复 @。' +
        '@everyone 与 @角色 一律不许写。',
    );
    expect(renderMentionRule().startsWith('\n\n【提及】')).toBe(true);
  });
});
