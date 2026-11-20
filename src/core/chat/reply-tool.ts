import type { ChatTool } from '../types';

/** 预设点名要的工具：system 里出现它才发 tools，别的频道请求形状一点不变 */
export const REPLY_TOOL_NAME = 'story_reply';

/**
 * 频道预设（酒馆导入的「示例角色」）要求模型调用 story_reply 并把正文放进 content。
 * 只有预设里真点了这个工具名才返回定义：别的频道拿空数组，请求体与加这一层之前逐字节相同。
 */
export function replyToolsFor(system: string): ChatTool[] {
  if (system.indexOf(REPLY_TOOL_NAME) === -1) return [];
  return [
    {
      type: 'function',
      function: {
        name: REPLY_TOOL_NAME,
        description: '把要发给用户的正文放在 content 里交付出去',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '给用户看的正文（可以带 <think_nya> 思考块）' },
          },
          required: ['content'],
        },
      },
    },
  ];
}
