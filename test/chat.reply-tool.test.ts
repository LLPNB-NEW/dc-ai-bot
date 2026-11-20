import { describe, expect, it } from 'vitest';
import { REPLY_TOOL_NAME, replyToolsFor } from '../src/core/chat/reply-tool';

describe('replyToolsFor', () => {
  it('system 里出现 story_reply：一条函数工具定义，名字与 required 正确', () => {
    const tools = replyToolsFor('你是示例角色。每次回复都调用 story_reply，把正文放进 content。');

    expect(REPLY_TOOL_NAME).toBe('story_reply');
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('story_reply');
    expect(tools[0].function.description).toBe('把要发给用户的正文放在 content 里交付出去');
    expect(tools[0].function.parameters).toEqual({
      type: 'object',
      properties: {
        content: { type: 'string', description: '给用户看的正文（可以带 <think_nya> 思考块）' },
      },
      required: ['content'],
    });
  });

  it('系统提示只有工具名也认：判定是 indexOf 包含，不是整段相等', () => {
    expect(replyToolsFor('story_reply')).toHaveLength(1);
  });

  it('大小写不同不算：NAME_TAIL 与 PRESET 的写法都不该命中', () => {
    expect(replyToolsFor('示例角色_Reply')).toEqual([]);
    expect(replyToolsFor('SOLIUMBRA_REPLY')).toEqual([]);
  });

  it('system 不含工具名：空数组（别的频道不受影响）', () => {
    expect(replyToolsFor('')).toEqual([]);
    expect(replyToolsFor('你是小助手，回答简短一点。')).toEqual([]);
  });
});
