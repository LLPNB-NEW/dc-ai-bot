import { describe, expect, it } from 'vitest';
import {
  INJECTION_CONTENT_MAX_CHARS,
  INJECTION_DEPTH_MAX,
  isInjectionDepth,
  isInjectionRole,
  resolveInjection,
  withInjection,
} from '../src/core/prompt/injection';
import type { ChatMessage, PromptInjectionConfig } from '../src/core/types';

/** 一层注入：默认全局层 + depth 0，用例只覆盖自己要验的字段。 */
function injection(overrides: Partial<PromptInjectionConfig> = {}): PromptInjectionConfig {
  return {
    scope: 'global',
    scopeId: '',
    content: '记住：这段设定在每条回复前都有效',
    depth: 0,
    role: 'system',
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}

/** 5 条历史，最后一条就是本轮用户消息（装配时 withAuthorPrefix(turnUser) 永远在末尾）。 */
const HISTORY: ChatMessage[] = [
  { role: 'user', content: '第一句', author: '阿天', authorId: 'u1', createdAt: '2026-11-05T10:00:00.000Z' },
  { role: 'assistant', content: '第一回', author: '小助手', createdAt: '2026-11-05T10:00:05.000Z' },
  { role: 'user', content: '第二句', author: '阿天', authorId: 'u1', createdAt: '2026-11-05T10:01:00.000Z' },
  { role: 'assistant', content: '第二回', author: '小助手', createdAt: '2026-11-05T10:01:05.000Z' },
  { role: 'user', content: '你好', author: '阿天', authorId: 'u1', createdAt: '2026-11-05T10:02:00.000Z' },
];

const SYNTHETIC = '记住：这段设定在每条回复前都有效';

describe('resolveInjection 三层解析', () => {
  it('三层都没有 → null', () => {
    expect(resolveInjection(null, null, null)).toBeNull();
  });

  it('channel 压过 guild 与 global', () => {
    const channel = injection({ scope: 'channel', scopeId: 'c1', content: '频道层' });
    const guild = injection({ scope: 'guild', scopeId: 'g1', content: '服务器层' });
    const global = injection({ content: '全局层' });
    expect(resolveInjection(channel, guild, global)).toBe(channel);
  });

  it('channel 是空正文 → 视为没配置，落到 guild', () => {
    const channel = injection({ scope: 'channel', scopeId: 'c1', content: '   ' });
    const guild = injection({ scope: 'guild', scopeId: 'g1', content: '服务器层' });
    expect(resolveInjection(channel, guild, injection({ content: '全局层' }))).toBe(guild);
  });

  it('channel / guild 都是空正文 → 落到 global', () => {
    const global = injection({ content: '全局层' });
    const out = resolveInjection(injection({ scope: 'channel', scopeId: 'c1', content: '' }), injection({ scope: 'guild', scopeId: 'g1', content: ' ' }), global);
    expect(out).toBe(global);
  });

  it('三层都是空正文 → null（不是返回某层空壳）', () => {
    const empty = [injection({ scope: 'channel', scopeId: 'c1', content: '' }), injection({ scope: 'guild', scopeId: 'g1', content: '  ' }), injection({ content: '\n' })];
    expect(resolveInjection(empty[0], empty[1], empty[2])).toBeNull();
  });

  it('只有 guild 有正文 → 用 guild（global 有配置也不越级）', () => {
    const guild = injection({ scope: 'guild', scopeId: 'g1', content: '服务器层' });
    expect(resolveInjection(null, guild, injection({ content: '全局层' }))).toBe(guild);
  });
});

describe('withInjection 插入位置', () => {
  it('无注入 → 原样返回同一个数组引用', () => {
    expect(withInjection(HISTORY, null)).toBe(HISTORY);
  });

  it('注入正文是空白 → 也算没注入，同一个数组引用', () => {
    expect(withInjection(HISTORY, injection({ content: '   ' }))).toBe(HISTORY);
  });

  it('空 messages 不造孤立消息，原样返回空数组', () => {
    const empty: ChatMessage[] = [];
    expect(withInjection(empty, injection({ depth: 0 }))).toBe(empty);
    expect(withInjection(empty, injection({ depth: 7 }))).toHaveLength(0);
  });

  it('depth 0 → 紧接本轮用户消息之前（倒数第 1 条之前）', () => {
    const out = withInjection(HISTORY, injection({ depth: 0 }));
    expect(out.map((message) => message.content)).toEqual(['第一句', '第一回', '第二句', '第二回', SYNTHETIC, '你好']);
  });

  it('depth 1 → 倒数第 2 条之前', () => {
    const out = withInjection(HISTORY, injection({ depth: 1 }));
    expect(out.map((message) => message.content)).toEqual(['第一句', '第一回', '第二句', SYNTHETIC, '第二回', '你好']);
  });

  it('depth 3 → 倒数第 4 条之前', () => {
    const out = withInjection(HISTORY, injection({ depth: 3 }));
    expect(out.map((message) => message.content)).toEqual(['第一句', SYNTHETIC, '第一回', '第二句', '第二回', '你好']);
  });

  it('depth 超过历史长度 → clamp 到最前面一条之前', () => {
    const out = withInjection(HISTORY, injection({ depth: 50 }));
    expect(out.map((message) => message.content)).toEqual([SYNTHETIC, '第一句', '第一回', '第二句', '第二回', '你好']);
  });

  it('depth 负数按 0 处理（不越界到末尾之后）', () => {
    expect(withInjection(HISTORY, injection({ depth: -3 })).map((message) => message.content)).toEqual(
      withInjection(HISTORY, injection({ depth: 0 })).map((message) => message.content),
    );
  });

  it('合成消息只有 role + content：不带 author / authorId / createdAt / replyTo，也不加名字前缀', () => {
    const injected = withInjection(HISTORY, injection({ role: 'system' }))[4];
    expect(Object.keys(injected).sort()).toEqual(['content', 'role']);
    expect(injected.role).toBe('system');
    expect(injected.content).toBe(SYNTHETIC);
    expect(injected.content.startsWith('[')).toBe(false);
  });

  it('role 原样透传：user / assistant 都不改写', () => {
    expect(withInjection(HISTORY, injection({ role: 'user' }))[4].role).toBe('user');
    expect(withInjection(HISTORY, injection({ role: 'assistant' }))[4].role).toBe('assistant');
  });

  it('不改原数组：长度与内容都没被动过', () => {
    withInjection(HISTORY, injection({ depth: 0 }));
    expect(HISTORY).toHaveLength(5);
    expect(HISTORY[4].content).toBe('你好');
  });
});

describe('注入的取值边界', () => {
  it('常量与契约一致（depth ≤ 50、正文 ≤ 20000）', () => {
    expect(INJECTION_DEPTH_MAX).toBe(50);
    expect(INJECTION_CONTENT_MAX_CHARS).toBe(20000);
  });

  it('isInjectionDepth 只认 0–50 的整数', () => {
    for (const good of [0, 1, 50]) expect(isInjectionDepth(good)).toBe(true);
    for (const bad of [-1, 51, 1.5, '3', null, undefined, Number.NaN]) expect(isInjectionDepth(bad)).toBe(false);
  });

  it('isInjectionRole 只认三个角色', () => {
    for (const good of ['system', 'user', 'assistant']) expect(isInjectionRole(good)).toBe(true);
    for (const bad of ['tool', 'System', '', null]) expect(isInjectionRole(bad)).toBe(false);
  });
});
