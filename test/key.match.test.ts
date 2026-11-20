import { describe, expect, it } from 'vitest';
import { normalizeModelPatterns, orderKeysForModel, rankKey } from '../src/core/providers/key-match';
import type { DecryptedKey } from '../src/core/types';

function key(id: string, models: string[]): DecryptedKey {
  return { id, provider: 'openai-compat', label: id, apiKey: 'sk-' + id, models };
}

describe('normalizeModelPatterns（§20.4 归一化）', () => {
  it('trim + 丢空项，其余原样保留', () => {
    expect(normalizeModelPatterns([' deepseek-* ', '', '   ', 'gpt-4o-mini'])).toEqual([
      'deepseek-*',
      'gpt-4o-mini',
    ]);
  });

  it('去重按小写比较，保留首次出现的大小写', () => {
    expect(normalizeModelPatterns(['GPT-4o', 'gpt-4o', 'Gpt-4O'])).toEqual(['GPT-4o']);
  });

  it('只允许字母数字 ._: - 与结尾 *：非法字符逐个丢弃，中文算字母', () => {
    // 'a*b' 的 * 不在末尾 → 非法；'x**' 只留最后一个 *；中文是 \\p{L}，原样保留
    expect(normalizeModelPatterns(['ab$c', 'a*b', 'x**', '中文'])).toEqual(['abc', 'ab', 'x*', '中文']);
    expect(normalizeModelPatterns(['假流式-pg-gemini-4-argon'])).toEqual(['假流式-pg-gemini-4-argon']);
  });

  it('合法字符集原样保留（冒号、点、下划线、连字符）', () => {
    expect(normalizeModelPatterns(['openai:gpt-4_o.1'])).toEqual(['openai:gpt-4_o.1']);
  });

  it('全是空白或全是非法字符时归一成空数组', () => {
    expect(normalizeModelPatterns(['  ', '@@', '$$'])).toEqual([]);
    expect(normalizeModelPatterns([])).toEqual([]);
  });
});

describe('rankKey（§20.4 三档）', () => {
  it('0 = 显式命中：名单里有一项等于模型名（大小写无关）', () => {
    expect(rankKey(['gpt-4o-mini'], 'gpt-4o-mini')).toBe(0);
    expect(rankKey(['GPT-4o-Mini'], 'gpt-4o-mini')).toBe(0);
    expect(rankKey(['gpt-4o-mini'], 'GPT-4O-MINI')).toBe(0);
  });

  it('0 = 显式命中：* 结尾的通配按前缀匹配', () => {
    expect(rankKey(['deepseek-*'], 'deepseek-chat')).toBe(0);
    expect(rankKey(['deepseek-*'], 'deepseek-reasoner')).toBe(0);
    expect(rankKey(['DeepSeek-*'], 'deepseek-chat')).toBe(0);
  });

  it('1 = 通用：名单为空', () => {
    expect(rankKey([], 'gpt-4o-mini')).toBe(1);
    // 全是非法字符 → 归一后为空 → 通用
    expect(rankKey(['@@'], 'gpt-4o-mini')).toBe(1);
  });

  it('1 = 通用：名单只剩 *', () => {
    expect(rankKey(['*'], 'gpt-4o-mini')).toBe(1);
    expect(rankKey([' * '], 'deepseek-chat')).toBe(1);
  });

  it('2 = 声明了别的模型', () => {
    expect(rankKey(['gg-model'], 'gpt-4o-mini')).toBe(2);
    expect(rankKey(['deepseek-*'], 'gpt-4o-mini')).toBe(2);
  });

  it('同时写了显式模型与 *：该模型算显式命中，别的模型算通用', () => {
    expect(rankKey(['*', 'gpt-4o'], 'gpt-4o')).toBe(0);
    expect(rankKey(['*', 'gpt-4o'], 'deepseek-chat')).toBe(1);
  });

  it('中文模型名（假流式-…）能点名：等值算 0，通配前缀也算 0', () => {
    expect(rankKey(['假流式-pg-gemini-4-argon'], '假流式-pg-gemini-4-argon')).toBe(0);
    expect(rankKey(['假流式-pg-*'], '假流式-pg-gemini-4-argon')).toBe(0);
    expect(rankKey(['假流式-pg-*'], 'pg-gemini-4-argon')).toBe(2);
  });
});

describe('orderKeysForModel（§20.4 稳定排序）', () => {
  it('按 (rank, 原序) 排：显式命中 → 通用 → 声明了别的模型', () => {
    const keys = [
      key('a', ['other-model']),
      key('b', []),
      key('c', ['target-*']),
      key('d', []),
      key('e', ['target-ish']),
    ];

    expect(orderKeysForModel(keys, 'target-1').map((item) => item.id)).toEqual(['c', 'b', 'd', 'a', 'e']);
  });

  it('同 rank 保持仓储给的 created_at,id 顺序', () => {
    const keys = [key('k1', ['x-model']), key('k2', ['y-model']), key('k3', ['z-model'])];

    expect(orderKeysForModel(keys, 'gpt-4o-mini').map((item) => item.id)).toEqual(['k1', 'k2', 'k3']);
  });

  it('三档全部留在候选里：名单是偏好不是硬约束（§20.8）', () => {
    const keys = [key('hit', ['gpt-4o-mini']), key('generic', []), key('other', ['gg-model'])];

    expect(orderKeysForModel(keys, 'gpt-4o-mini').map((item) => item.id)).toEqual(['hit', 'generic', 'other']);
  });

  it('不修改入参，返回新数组', () => {
    const keys = [key('a', ['other-model']), key('b', ['gpt-4o-mini'])];
    const ordered = orderKeysForModel(keys, 'gpt-4o-mini');

    expect(ordered).not.toBe(keys);
    expect(keys.map((item) => item.id)).toEqual(['a', 'b']);
    expect(ordered.map((item) => item.id)).toEqual(['b', 'a']);
  });
});
