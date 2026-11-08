import { describe, expect, it } from 'vitest';
import {
  CONTEXT_REPLY_SYSTEM_PREFIX,
  CONTEXT_TOOL_NAME,
  CONTEXT_TOOL_SYSTEM,
  CONTEXT_TOOL_TURN,
  REPLY_TOOL_NAME,
  accumulateToolCalls,
  buildContextTools,
  budgetedHistory,
  composeContextBody,
  taggedHistory,
  readToolReply,
  replyOnlyTools,
} from '../src/core/chat/context-tool';
import type { ChatTool, ChatToolCall, ToolCallDelta } from '../src/core/types';

function call(name: string, args: string): ChatToolCall {
  return { name, arguments: args };
}

function parametersOf(tool: ChatTool): { properties: Record<string, unknown>; required?: string[] } {
  return tool.function.parameters as { properties: Record<string, unknown>; required?: string[] };
}

describe('§55 上下文工具定义', () => {
  it('两个工具：context 的描述就是整份上下文，回复工具只强制 game_content', () => {
    const body = '角色卡正文\n\n【长期记忆摘要】\n上次聊到电影';
    const tools = buildContextTools(body);

    expect(tools.map((tool) => tool.function.name)).toEqual([CONTEXT_TOOL_NAME, REPLY_TOOL_NAME]);
    expect([CONTEXT_TOOL_NAME, REPLY_TOOL_NAME]).toEqual(['context', 'story_reply']);
    expect(tools[0]?.function.description).toBe(body);

    const contextParams = parametersOf(tools[0] as ChatTool);
    expect(Object.keys(contextParams.properties)).toEqual(['query']);
    expect((contextParams.properties.query as { type: string }).type).toBe('string');

    const replyParams = parametersOf(tools[1] as ChatTool);
    expect(Object.keys(replyParams.properties).sort()).toEqual(['extra', 'game_content', 'think_nya']);
    for (const value of Object.values(replyParams.properties)) {
      expect((value as { type: string }).type).toBe('string');
    }
    expect(replyParams.required).toEqual(['game_content']);
  });

  it('CONTEXT_TOOL_SYSTEM 平台中性：说清设定在哪、正文用哪个工具交付，并明确叫住 context', () => {
    expect(CONTEXT_TOOL_SYSTEM).toContain(CONTEXT_TOOL_NAME);
    expect(CONTEXT_TOOL_SYSTEM).toContain(REPLY_TOOL_NAME);
    // 没有第二次请求把工具结果回喂，要求「先调用 context」只会换来一次空正文；反过来要明确禁止
    expect(CONTEXT_TOOL_SYSTEM).not.toMatch(/先调用|先读/);
    expect(CONTEXT_TOOL_SYSTEM).toContain('不要调用 context');
    expect(CONTEXT_TOOL_SYSTEM).not.toMatch(/discord/i);
    expect(CONTEXT_TOOL_SYSTEM).not.toMatch(/机器人|bot/i);
  });

  it('§59 补交付回合：工具只留回复工具，system 前缀以空行收尾、后面接整份上下文', () => {
    const tools = replyOnlyTools();
    expect(tools.map((tool) => tool.function.name)).toEqual([REPLY_TOOL_NAME]);
    // 回复工具的定义与两条工具列表里的那一份逐字相同
    expect(tools[0]).toEqual(buildContextTools('上下文')[1]);
    expect(CONTEXT_REPLY_SYSTEM_PREFIX.endsWith('\n\n')).toBe(true);
    expect(CONTEXT_REPLY_SYSTEM_PREFIX).toContain(REPLY_TOOL_NAME);
    expect(CONTEXT_REPLY_SYSTEM_PREFIX).not.toContain(CONTEXT_TOOL_NAME);
  });

  it('composeContextBody：空白段整段跳过，其余用空行连接', () => {
    expect(composeContextBody(['预设 before', '预设 after', '', '   ', '【长期记忆摘要】\n旧事'])).toBe(
      '预设 before\n\n预设 after\n\n【长期记忆摘要】\n旧事',
    );
    expect(composeContextBody([])).toBe('');
    expect(composeContextBody(['', '  '])).toBe('');
  });
});

describe('§55 readToolReply', () => {
  it('完整 JSON：game_content 就是正文，extra 另起一段', () => {
    const args = JSON.stringify({ think_nya: '心里那句', game_content: '第一段', extra: '补一句' });

    expect(readToolReply([call(REPLY_TOOL_NAME, args)], '兜底')).toBe('第一段\n\n补一句');
  });

  it('think_nya 不进正文，只有 game_content 时正文就是它自己', () => {
    const args = JSON.stringify({ think_nya: '这一句只留在模型侧', game_content: '给用户看的' });

    const text = readToolReply([call(REPLY_TOOL_NAME, args)], '兜底');

    expect(text).toBe('给用户看的');
    expect(text).not.toContain('这一句只留在模型侧');
  });

  it('arguments 是截断 JSON：正则逐键兜底，转义换行还原，半截的 extra 丢掉', () => {
    const truncated = '{"think_nya":"想一想","game_content":"第一行\\n第二行","extra":"补';

    const text = readToolReply([call(REPLY_TOOL_NAME, truncated)], '兜底');

    expect(text).toBe('第一行\n第二行');
    expect(text).not.toContain('想一想');
  });

  it('正则兜底同样把 extra 排在 game_content 之后', () => {
    const truncated = '{"game_content":"正文","think_nya":"想","extra":"补充"}'.slice(0, -1);

    expect(readToolReply([call(REPLY_TOOL_NAME, truncated)], '兜底')).toBe('正文\n\n补充');
  });

  it('没有回复工具调用时回退 content 文本', () => {
    expect(readToolReply([call(CONTEXT_TOOL_NAME, '{}')], 'content 里的正文')).toBe('content 里的正文');
    expect(readToolReply([], '')).toBe('');
  });

  it('只调用了 context、没调回复工具且 content 为空：返回空串，绝不把 context 的参数当正文', () => {
    const contextArgs = JSON.stringify({ query: '读整份设定' });

    expect(readToolReply([call(CONTEXT_TOOL_NAME, contextArgs)], '')).toBe('');
    expect(readToolReply([call(CONTEXT_TOOL_NAME, contextArgs)], '')).not.toContain('读整份设定');
  });

  it('调用了回复工具但正文全空时也回退', () => {
    const args = JSON.stringify({ think_nya: '只有想法', game_content: '   ', extra: '' });

    expect(readToolReply([call(REPLY_TOOL_NAME, args)], '兜底')).toBe('兜底');
  });

  it('多个回复调用时取第一个，后面的不参与拼接', () => {
    const first = JSON.stringify({ game_content: '第一次' });
    const second = JSON.stringify({ game_content: '第二次' });

    expect(readToolReply([call(REPLY_TOOL_NAME, first), call(REPLY_TOOL_NAME, second)], '兜底')).toBe('第一次');
  });
});

describe('§55 accumulateToolCalls：流式增量拼回一次调用', () => {
  it('按 index 分桶、arguments 按到达顺序拼接：半截分片拼成完整 JSON', () => {
    const chunks: ToolCallDelta[] = [
      { index: 0, name: REPLY_TOOL_NAME, arguments: '{"game_con' },
      { index: 0, arguments: 'tent":"正文"}' },
    ];

    const calls = accumulateToolCalls(chunks);

    expect(calls).toEqual([{ name: REPLY_TOOL_NAME, arguments: '{"game_content":"正文"}' }]);
    expect(JSON.parse(calls[0].arguments)).toEqual({ game_content: '正文' });
  });

  it('name 只认第一次出现的非空值：后续帧的空名与重复名一律忽略', () => {
    const chunks: ToolCallDelta[] = [
      { index: 0, name: REPLY_TOOL_NAME, arguments: '{"game_content":' },
      { index: 0, name: '', arguments: '"正文"' },
      { index: 0, name: '别的名字', arguments: '}' },
    ];

    expect(accumulateToolCalls(chunks)).toEqual([
      { name: REPLY_TOOL_NAME, arguments: '{"game_content":"正文"}' },
    ]);
  });

  it('多个调用按 index 升序返回（与到达顺序无关）', () => {
    const chunks: ToolCallDelta[] = [
      { index: 1, name: CONTEXT_TOOL_NAME, arguments: '{"query":' },
      { index: 0, name: REPLY_TOOL_NAME, arguments: '{"game_content":"正' },
      { index: 1, arguments: '"设定"}' },
      { index: 0, arguments: '文"}' },
    ];

    expect(accumulateToolCalls(chunks)).toEqual([
      { name: REPLY_TOOL_NAME, arguments: '{"game_content":"正文"}' },
      { name: CONTEXT_TOOL_NAME, arguments: '{"query":"设定"}' },
    ]);
  });

  it('name 与 arguments 都空的桶丢掉；只有参数没名字的桶保留（空参由上层自己判定）', () => {
    const chunks: ToolCallDelta[] = [
      { index: 2, arguments: '' },
      { index: 3, arguments: '{}' },
      { index: 4, name: '', arguments: '' },
    ];

    expect(accumulateToolCalls(chunks)).toEqual([{ name: '', arguments: '{}' }]);
    expect(accumulateToolCalls([])).toEqual([]);
  });
});

describe('§55 顶层 user 与历史预算', () => {
  it('顶层 user 是固定那一句：真实那句只进描述体，绝不把用户原话发成 user 消息', () => {
    expect(CONTEXT_TOOL_TURN).toBe('请继续 context 中的互动游戏。');
    expect(CONTEXT_TOOL_TURN).toContain(CONTEXT_TOOL_NAME);
    // 平台中性：不提平台、不提机器人身份
    expect(CONTEXT_TOOL_TURN).not.toMatch(/discord/i);
    expect(CONTEXT_TOOL_TURN).not.toMatch(/机器人|bot/i);
  });

  it('预算够时全部保留，仍是旧→新顺序', () => {
    expect(budgetedHistory(['第一条', '第二条', '第三条'], 8000)).toBe('第一条\n第二条\n第三条');
  });

  it('超出预算时从最近一条往前取，只留得下的几条，顺序仍是旧→新', () => {
    const line = (index: number): string => '第' + String(index) + '条' + '甲'.repeat(2990);
    const lines = [1, 2, 3, 4, 5].map(line);

    const text = budgetedHistory(lines, 8000);

    // 3000 字左右一行：8000 只装得下最近两条
    expect(text).toContain('第4条');
    expect(text).toContain('第5条');
    expect(text).not.toContain('第3条');
    expect(text.indexOf('第4条')).toBeLessThan(text.indexOf('第5条'));
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it('单行就超预算时返回空串；空行不占预算也不进结果', () => {
    expect(budgetedHistory(['甲'.repeat(9000)])).toBe('');
    expect(budgetedHistory(['先', '', '   ', '后'], 8000)).toBe('先\n后');
    expect(budgetedHistory([])).toBe('');
  });
});

describe('§61 记忆标签', () => {
  it('历史段套 <recent>：多行原样带出，前后各一行标签', () => {
    expect(taggedHistory('第一条\n第二条')).toBe('<recent>\n第一条\n第二条\n</recent>');
  });

  it('空历史返回空串，描述体里不会留下只包着空白的标签', () => {
    expect(taggedHistory('')).toBe('');
    expect(taggedHistory('   \n ')).toBe('');
    expect(composeContextBody(['预设', taggedHistory(''), '本轮'])).toBe('预设\n\n本轮');
  });

  it('与长期记忆的 <recall> 分开：两段在描述体里各自成块', () => {
    const body = composeContextBody(['预设', '<recall>\n旧事\n</recall>', taggedHistory('最近一句'), '本轮']);
    expect(body).toBe('预设\n\n<recall>\n旧事\n</recall>\n\n<recent>\n最近一句\n</recent>\n\n本轮');
  });
});
