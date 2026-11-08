import { describe, expect, it } from 'vitest';
import { unwrapToolReply, unwrapToolReplyStream } from '../src/core/chat/tool-shell';

/** 正文里的思考块是给用户看的正文的一部分，剥壳时一个字都不能动 */
const BODY = '<think_nya>唔……今天也想见你</think_nya>好呀，我等你。';

const NAME = 'story_reply';

describe('工具调用壳剥离', () => {
  it('没有工具名时原样返回，unwrapped=false', () => {
    const raw = '  ' + BODY + '\n';
    expect(unwrapToolReply(raw)).toEqual({ text: raw, unwrapped: false });
  });

  it('开头是 <run_tool_name> + <run_tool_args>：切到参数壳之后', () => {
    const raw = '<run_tool_name>' + NAME + '</run_tool_name><run_tool_args>' + BODY + '</run_tool_args>';
    expect(unwrapToolReply(raw)).toEqual({ text: BODY, unwrapped: true });
  });

  it('开头是 <run_tool_replacement>：认不出参数壳时切到工具名与闭合标签之后', () => {
    const raw = '<run_tool_replacement>' + NAME + '</run_tool_replacement>' + BODY;
    expect(unwrapToolReply(raw)).toEqual({ text: BODY, unwrapped: true });
  });

  it('call: + catgodml 串包裹：切到 | 之后，>>>} 一并剥掉', () => {
    const raw = '<|tool_call>call:' + NAME + '{content:<<<|catgodml|str|' + BODY + '>>>}';
    expect(unwrapToolReply(raw)).toEqual({ text: BODY, unwrapped: true });
  });

  it('FunctionCallBegin JSON 形态：切到 "content": " 之后，JSON 收尾与结尾 token 都剥掉', () => {
    const raw =
      '<|FunctionCallBegin|>[{"name": "' + NAME + '", "arguments": {"content": "' + BODY + '"}}]<|FunctionCallEnd|>';
    expect(unwrapToolReply(raw)).toEqual({ text: BODY, unwrapped: true });
  });

  it('结尾残渣叠了几层也照样剥干净', () => {
    const raw = '<run_tool_name>' + NAME + '</run_tool_name><run_tool_args>' + BODY + '</run_tool_args>[END]<|FunctionCallEnd|>';
    expect(unwrapToolReply(raw)).toEqual({ text: BODY, unwrapped: true });
  });

  it('没有结尾残渣时正文完整保留', () => {
    const raw = '<run_tool_name>' + NAME + '</run_tool_name><run_tool_args>' + BODY;
    expect(unwrapToolReply(raw)).toEqual({ text: BODY, unwrapped: true });
  });

  it('剥完是空串就返回空串，不回退成原始壳文本', () => {
    const shell = '<run_tool_name>' + NAME + '</run_tool_name><run_tool_args></run_tool_args>';
    expect(unwrapToolReply(shell)).toEqual({ text: '', unwrapped: true });
    expect(unwrapToolReply(NAME)).toEqual({ text: '', unwrapped: true });
  });

  it('流式：半截头部先不推，头部收尾到了才露正文', () => {
    expect(unwrapToolReplyStream('<run_tool_name>' + NAME + '</run_tool_nam')).toBe('');
    expect(unwrapToolReplyStream('<run_tool_name>' + NAME + '</run_tool_name><run_tool_args>')).toBe('');
    expect(unwrapToolReplyStream('<run_tool_name>' + NAME + '</run_tool_name><run_tool_args>' + BODY)).toBe(BODY);
    expect(unwrapToolReplyStream('普通回复')).toBe('普通回复');
  });
});
