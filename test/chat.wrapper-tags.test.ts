import { describe, expect, it } from 'vitest';
import { stripWrapperTags } from '../src/core/chat/wrapper-tags';

/** 生产样本（消息 6907）的形态：首尾换行也是正文的一部分，一个字都不能动 */
const BODY = '\n屋外的天色沉下去了，我靠着窗，等你回来。\n';

describe('预设包裹标签剥离', () => {
  it('成对的 <game> 去掉，正文逐字不变', () => {
    expect(stripWrapperTags('<game>' + BODY + '</game>')).toBe(BODY);
  });

  it('成对的 <game_content> 去掉，正文逐字不变', () => {
    expect(stripWrapperTags('<game_content>' + BODY + '</game_content>')).toBe(BODY);
  });

  it('只有开头 <game>、没有结尾：整段原样返回', () => {
    const raw = '<game>' + BODY;
    expect(stripWrapperTags(raw)).toBe(raw);
  });

  it('只有结尾 </game>、没有开头：整段原样返回', () => {
    const raw = BODY + '</game>';
    expect(stripWrapperTags(raw)).toBe(raw);
  });

  it('两个标签都成对出现时都剥掉', () => {
    expect(stripWrapperTags('<game><game_content>' + BODY + '</game_content></game>')).toBe(BODY);
  });

  it('不含标签时原样返回', () => {
    expect(stripWrapperTags(BODY)).toBe(BODY);
    expect(stripWrapperTags('')).toBe('');
  });

  it('<think_nya> 是正文的一部分，不受影响', () => {
    const think = '<think_nya>唔……今天也想见你</think_nya>';
    expect(stripWrapperTags('<game>' + think + BODY + '</game>')).toBe(think + BODY);
  });
});
