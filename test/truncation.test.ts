import { describe, expect, it } from 'vitest';
import {
  CONTINUE_INSTRUCTION,
  CONTINUE_SENTINEL,
  CONTINUE_TOTAL_CHARS,
  MAX_CONTINUATIONS,
  TRUNCATION_MIN_CHARS,
  continuationMessages,
  isTruncatedReply,
  looksUnfinished,
} from '../src/core/chat/truncation';
import type { ChatMessage } from '../src/core/types';

describe('截断续写的常量口径', () => {
  it('最多续 2 次（共 3 段）、累计 3000 字、最短 12 字、自撤口令 [END]', () => {
    expect(MAX_CONTINUATIONS).toBe(2);
    expect(CONTINUE_TOTAL_CHARS).toBe(3000);
    expect(TRUNCATION_MIN_CHARS).toBe(12);
    expect(CONTINUE_SENTINEL).toBe('[END]');
  });
});

describe('looksUnfinished：结尾停在词中间', () => {
  it('末尾是词内字符（汉字 / 字母 / 数字）→ true', () => {
    expect(looksUnfinished('哼，笨蛋，你自己刚才明明就已经手动')).toBe(true);
    expect(looksUnfinished('the answer is forty two')).toBe(true);
    expect(looksUnfinished('倒计时还剩四十二秒，数字是 3')).toBe(true);
  });

  it('句末标点 / 引号 / 代码围栏 / 表情 → false', () => {
    expect(looksUnfinished('这句话其实已经写完了，对吧。')).toBe(false);
    expect(looksUnfinished('他回头对你说了一句「走吧」')).toBe(false);
    expect(looksUnfinished('```\nconst a = 1\n```')).toBe(false);
    expect(looksUnfinished('哈哈哈哈哈哈哈哈好耶😄')).toBe(false);
    expect(looksUnfinished('这句话其实已经写完了，对吧？')).toBe(false);
  });

  it('短于 12 个字一律 false：太短看不出是否被掐断', () => {
    expect(looksUnfinished('好的')).toBe(false);
    expect(looksUnfinished('   好呀   ')).toBe(false);
    expect(looksUnfinished('')).toBe(false);
  });
});

describe('isTruncatedReply：协议层优先，文本层兜底', () => {
  const COMPLETE = '这句话其实已经写完了，对吧。';
  const HALF = '哼，笨蛋，你自己刚才明明就已经手动';

  it('没有结束原因 → true（流被上游掐断）', () => {
    expect(isTruncatedReply(COMPLETE, undefined)).toBe(true);
  });

  it('length / MAX_TOKENS 这类非正常收尾 → true，哪怕正文看起来完整', () => {
    expect(isTruncatedReply(COMPLETE, 'length')).toBe(true);
    expect(isTruncatedReply(COMPLETE, 'MAX_TOKENS')).toBe(true);
  });

  it('stop 且句子完整 → false', () => {
    expect(isTruncatedReply(COMPLETE, 'stop')).toBe(false);
    expect(isTruncatedReply(COMPLETE, 'STOP')).toBe(false);
    expect(isTruncatedReply(COMPLETE, 'end_turn')).toBe(false);
  });

  it('stop 但停在词中间 → true（文本层兜底）', () => {
    expect(isTruncatedReply(HALF, 'stop')).toBe(true);
  });
});

describe('continuationMessages：原上下文 + 已写正文 + 续写指令', () => {
  it('三条消息按序排好，且不改动入参数组', () => {
    const base: ChatMessage[] = [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在。' },
      { role: 'user', content: '那你说说看' },
    ];
    const soFar = '哼，笨蛋，你自己刚才明明就已经手动';

    const out = continuationMessages(base, soFar);

    expect(out).toHaveLength(5);
    expect(out.slice(0, 3)).toEqual(base);
    expect(out[3]).toEqual({ role: 'assistant', content: soFar });
    expect(out[4]).toEqual({ role: 'user', content: CONTINUE_INSTRUCTION });
    expect(base).toHaveLength(3);
    expect(out).not.toBe(base);
  });
});
