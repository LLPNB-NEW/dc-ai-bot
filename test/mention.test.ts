/**
 * 回复开头的 @ 提问者：纯函数契约。
 *
 * mention.ts 只做两件事 —— 把用户 id 变成 `<@id> `，把前缀拼在正文前同时守住 Discord 的字符上限。
 * 这段是否真的进了请求体由网关用例覆盖（test/gateway.stream.test.ts），这里只钉算术与边界。
 */
import { describe, expect, it } from 'vitest';
import { mentionPrefix, withMention } from '../src/workers/discord/mention';

/** `<@123> ` 正好 7 个字符：前缀本身也占配额，下面的边界断言都按它算 */
const PREFIX = mentionPrefix('123');
const PREFIX_LENGTH = 7;

describe('mentionPrefix：用户 id → 回复开头的前缀', () => {
  it('拿不到 id 时返回空串，不发一个空标签', () => {
    expect(mentionPrefix('')).toBe('');
  });

  it('正常 id 包成 <@id> 并跟一个空格', () => {
    expect(mentionPrefix('123')).toBe('<@123> ');
    expect(PREFIX).toBe('<@123> ');
    expect(PREFIX).toHaveLength(PREFIX_LENGTH);
  });
});

describe('withMention：前缀 + 正文，整条不越界', () => {
  it('没有前缀时正文原样返回（哪怕正文自己就超了 maxChars）', () => {
    const long = '甲'.repeat(50);
    expect(withMention(long, '', 10)).toBe(long);
    expect(withMention('正文', '', 1900)).toBe('正文');
  });

  it('有前缀时前缀完整，正文让出前缀那么长的预算', () => {
    const result = withMention('一二三四五六七八九十', PREFIX, PREFIX_LENGTH + 4);
    expect(result).toBe(PREFIX + '一二三四');
    expect(result).toHaveLength(PREFIX_LENGTH + 4);
    expect(result.startsWith(PREFIX)).toBe(true);
  });

  it('超长正文：整条仍然正好 maxChars，前缀一个字符都没被切掉', () => {
    const result = withMention('甲'.repeat(3000), PREFIX, 1900);
    expect(result).toHaveLength(1900);
    expect(result).toBe(PREFIX + '甲'.repeat(1900 - PREFIX_LENGTH));
    expect(result.startsWith(PREFIX)).toBe(true);
  });

  it('maxChars 比前缀还短：返回前缀本身，不抛错也不做负长度切片', () => {
    expect(withMention('正文', PREFIX, PREFIX_LENGTH - 1)).toBe(PREFIX);
    expect(withMention('正文', PREFIX, 0)).toBe(PREFIX);
    expect(() => withMention('正文', PREFIX, 0)).not.toThrow();
  });
});
