import { describe, expect, it } from 'vitest';
import { REACTION_RESPONSE_FORMAT, buildReactionRequest, normalizeReactions } from '../src/core/chat/reaction';
import { DEFAULT_REACTION_GUIDE } from '../src/core/chat/reaction-guide';
import { DEFAULT_REACTION_TEMPLATE } from '../src/core/chat/reaction-template';
import type { ReactionModelConfig } from '../src/core/types';

const CFG: ReactionModelConfig = { enabled: true, provider: 'openai-compat', model: 'gpt-4o-mini' };

function request() {
  return buildReactionRequest(CFG, {
    userText: '你好',
    botReply: '好的',
    guide: DEFAULT_REACTION_GUIDE,
    template: DEFAULT_REACTION_TEMPLATE,
  });
}

describe('normalizeReactions 先试 JSON（结构化输出）', () => {
  it('{"reaction":":名字:"} 取出表情，@目标照旧切分', () => {
    expect(normalizeReactions('{"reaction":":laugh:"}')).toEqual([{ emoji: ':laugh:' }]);
    expect(normalizeReactions('{"reaction":"😄@123456789012345678"}')).toEqual([
      { emoji: '😄', messageId: '123456789012345678' },
    ]);
  });

  it('顶层字符串与对象里唯一的字符串值也认', () => {
    expect(normalizeReactions('"👍"')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('{"emoji":"🔥"}')).toEqual([{ emoji: '🔥' }]);
  });

  it('缩进成多行的 JSON 整段解析：不按换行切碎', () => {
    expect(normalizeReactions('{\n  "reaction": ":猫猫:"\n}')).toEqual([{ emoji: ':猫猫:' }]);
  });

  it('JSON 里的 NONE 与文本 NONE 同义：不贴，多余的说明字段不影响', () => {
    expect(normalizeReactions('{"reaction":"NONE"}')).toEqual([]);
    expect(normalizeReactions('{"reaction":"none"}')).toEqual([]);
    expect(normalizeReactions('{"reaction":"不贴"}')).toEqual([]);
    expect(normalizeReactions('{"reaction":"NONE","explanation":"没有合适的表情"}')).toEqual([]);
  });

  it('JSON 形态错乱时回落到旧文本解析：指令、多行、解释文字全按老语义走', () => {
    // 不是 JSON：[[react:…]] 指令照旧生效
    expect(normalizeReactions('[[react:👍]]')).toEqual([{ emoji: '👍' }]);
    // 不是 JSON：两行表情照旧一条一行
    expect(normalizeReactions('👍\n:laugh:')).toEqual([{ emoji: '👍' }, { emoji: ':laugh:' }]);
    // JSON 合法但没有字符串值：回落文本后同样一个都认不出
    expect(normalizeReactions('{"reaction":42}')).toEqual([]);
    // 不是 JSON 的一行解释文字：老规则照样丢掉
    expect(normalizeReactions('因为很开心所以贴一个')).toEqual([]);
  });
});

describe('buildReactionRequest 的结构化输出契约', () => {
  it('LlmRequest 带上 json_schema：name 固定，reaction 是必填字符串', () => {
    const req = request();

    expect(req.responseFormat).toEqual(REACTION_RESPONSE_FORMAT);
    expect(req.responseFormat).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'reaction_choice',
        schema: {
          type: 'object',
          properties: {
            reaction: {
              type: 'string',
              description: '要贴的表情：unicode emoji 或 :名字:，可带 @消息ID / @作者名；这轮不贴就写 NONE',
            },
          },
          required: ['reaction'],
        },
      },
    });
  });
});
