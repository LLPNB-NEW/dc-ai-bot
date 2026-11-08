import { describe, expect, it } from 'vitest';
import {
  CODE_IDENTITY_TEMPLATE,
  MAX_PROMPT_DEFAULT_CHARS,
  PROMPT_DEFAULT_KEYS,
  SAMPLE_PROMPT_VARS,
  findUnknownPromptDefaultVars,
  formatIdentityBlock,
  isPromptDefaultKey,
  pickScopedTemplate,
  previewPromptDefault,
  promptDefaultVars,
  renderIdentityTemplate,
  resolveFallbackPrompt,
} from '../src/core/prompt/defaults';

const VARS = {
  bot_name: '示例机器人',
  user_name: '阿天',
  user_id: '150000000000000001',
  guild_name: '测试公会',
  channel_name: '闲聊2',
  date: '2026-10-25',
};

describe('renderIdentityTemplate', () => {
  it('某一行引用的变量为空值：整行丢弃，其余行照旧', () => {
    const block = renderIdentityTemplate(
      '【当前对话】\n和你说话的是 {{user_name}}\n服务器：{{guild_name}}\n频道：#{{channel_name}}',
      { user_name: '', guild_name: '测试公会', channel_name: '闲聊2' },
    );
    expect(block).toBe('\n\n【当前对话】\n服务器：测试公会\n频道：#闲聊2');
    expect(block).not.toContain('和你说话的是');
  });

  it('渲染后只剩空白的行丢弃（空行与纯空格行都不留）', () => {
    const block = renderIdentityTemplate('【当前对话】\n\n   \n今天 {{date}}', VARS);
    expect(block).toBe('\n\n【当前对话】\n今天 2026-10-25');
  });

  it('全部行都被丢掉时返回空串（system 里整块不出现）', () => {
    expect(renderIdentityTemplate('{{user_name}}\n服务器：{{guild_name}}', {})).toBe('');
    expect(renderIdentityTemplate('', VARS)).toBe('');
    expect(renderIdentityTemplate('   \n\n', VARS)).toBe('');
  });

  it('未知占位符按「解析为空」处理：那一行丢掉，保存时另外点名', () => {
    expect(renderIdentityTemplate('昵称：{{nickname}}\n今天 {{date}}', VARS)).toBe('\n\n今天 2026-10-25');
    expect(findUnknownPromptDefaultVars('identity', '昵称：{{nickname}} 与 {{nickname}}')).toEqual(['nickname']);
    expect(findUnknownPromptDefaultVars('fallback', '你是 {{bot_name}}，{{user_name}} 的助手')).toEqual([]);
    // user_id 只属于身份块：兜底提示词沿用的是提示词段那 5 个变量
    expect(findUnknownPromptDefaultVars('fallback', 'ID：{{user_id}}')).toEqual(['user_id']);
  });
});

describe('isPromptDefaultKey', () => {
  it('只认 fallback 与 identity', () => {
    expect(PROMPT_DEFAULT_KEYS).toEqual(['fallback', 'identity']);
    expect(isPromptDefaultKey('fallback')).toBe(true);
    expect(isPromptDefaultKey('identity')).toBe(true);
    expect(isPromptDefaultKey('global')).toBe(false);
    expect(isPromptDefaultKey('Fallback')).toBe(false);
    expect(isPromptDefaultKey('')).toBe(false);
  });

  it('变量表与上限是给后台/文档用的同一份常量', () => {
    expect(promptDefaultVars('fallback')).toEqual(['bot_name', 'user_name', 'guild_name', 'channel_name', 'date']);
    expect(promptDefaultVars('identity')).toContain('user_id');
    expect(promptDefaultVars('identity')).toHaveLength(6);
    expect(MAX_PROMPT_DEFAULT_CHARS).toBe(20000);
  });
});

describe('CODE_IDENTITY_TEMPLATE', () => {
  it('配齐变量时逐行都在，且是今天那段身份块的可读写法', () => {
    const block = renderIdentityTemplate(CODE_IDENTITY_TEMPLATE, VARS);
    const lines = block.split('\n');
    // 两个换行开头 → 首元素是空串，后面 5 行依次是标题与 4 项
    expect(lines).toEqual([
      '',
      '',
      '【当前对话】',
      '和你说话的是 阿天（ID 150000000000000001）',
      '这里：测试公会 · 闲聊2',
      '今天 2026-10-25',
    ]);
  });

  it('示例里不出现未知变量（拿去 PUT 必须 200）', () => {
    expect(findUnknownPromptDefaultVars('identity', CODE_IDENTITY_TEMPLATE)).toEqual([]);
  });
});

describe('SAMPLE_PROMPT_VARS', () => {
  it('六行示例变量齐全，date 是固定字符串（预览才可断言）', () => {
    expect(Object.keys(SAMPLE_PROMPT_VARS).sort()).toEqual([
      'bot_name',
      'channel_name',
      'date',
      'guild_name',
      'user_id',
      'user_name',
    ]);
    expect(SAMPLE_PROMPT_VARS.date).toBe('2026-11-05');
    expect(findUnknownPromptDefaultVars('identity', CODE_IDENTITY_TEMPLATE)).toEqual([]);
  });
});

describe('formatIdentityBlock', () => {
  it('与线上身份块同一套拼装：字段齐全时是一句「；」串起来的块', () => {
    expect(
      formatIdentityBlock({
        userName: '阿天',
        userId: '150000000000000001',
        guildName: '测试公会',
        channelName: '闲聊2',
        date: '2026-10-25',
      }),
    ).toBe('\n\n【当前对话】和你说话的是 阿天（ID 150000000000000001）；这里：测试公会 · 闲聊2；今天 2026-10-25。');
  });

  it('空字段整段省略；user_name 为空整块不出现', () => {
    expect(formatIdentityBlock({ userName: '阿天', userId: '', guildName: '', channelName: '', date: '' })).toBe(
      '\n\n【当前对话】和你说话的是 阿天。',
    );
    expect(formatIdentityBlock({ userName: '  ', userId: '1', guildName: 'g', channelName: 'c', date: 'd' })).toBe('');
  });
});

describe('resolveFallbackPrompt', () => {
  it('channel > guild > global：第一个能用的层胜出', () => {
    const channel = resolveFallbackPrompt('频道正文', '服务器正文', '全局正文');
    expect(channel?.segments[0]?.content).toBe('频道正文');
    const guild = resolveFallbackPrompt(null, '服务器正文', '全局正文');
    expect(guild?.segments[0]?.content).toBe('服务器正文');
    const global = resolveFallbackPrompt(null, null, '全局正文');
    expect(global?.segments[0]?.content).toBe('全局正文');
  });

  it('三层都没配（null / 全空白）返回 null = 继续用代码默认', () => {
    expect(resolveFallbackPrompt(null, null, null)).toBeNull();
    expect(resolveFallbackPrompt('   ', '\n', null)).toBeNull();
  });

  it('含未知变量的层等价于没配：跳过它落到下一层', () => {
    const hit = resolveFallbackPrompt('你是 {{nickname}}', '服务器正文', null);
    expect(hit?.segments[0]?.content).toBe('服务器正文');
    expect(resolveFallbackPrompt('你是 {{nickname}}', null, null)).toBeNull();
  });
});

describe('pickScopedTemplate', () => {
  it('第一个 trim 非空的原始文本（原样保留换行，不 trim 结果）', () => {
    expect(pickScopedTemplate('  频道正文\n', '服务器正文', '全局正文')).toBe('  频道正文\n');
    expect(pickScopedTemplate('   ', '服务器正文', '全局正文')).toBe('服务器正文');
    expect(pickScopedTemplate(null, null, '全局正文')).toBe('全局正文');
  });

  it('三层都空给 null（= 代码里的身份块）', () => {
    expect(pickScopedTemplate(null, null, null)).toBeNull();
    expect(pickScopedTemplate('  ', '\n', null)).toBeNull();
  });
});

describe('previewPromptDefault', () => {
  it('fallback 已知变量照常渲染，未知变量为空', () => {
    expect(previewPromptDefault('fallback', '你是 {{bot_name}}，今天 {{date}}。', SAMPLE_PROMPT_VARS)).toEqual({
      rendered: '你是 示例机器人，今天 2026-11-05。',
      unknownVars: [],
    });
  });

  it('fallback 有未知变量时渲染照进行、变量点名返回（不抛错）', () => {
    expect(previewPromptDefault('fallback', '你是 {{bot_name}}，{{nickname}} 的助手', SAMPLE_PROMPT_VARS)).toEqual({
      rendered: '你是 示例机器人， 的助手',
      unknownVars: ['nickname'],
    });
  });

  it('identity 有未知变量时那一行丢掉，变量点名返回', () => {
    expect(
      previewPromptDefault(
        'identity',
        '【当前对话】\n昵称：{{nickname}}\n和你说话的是 {{user_name}}',
        SAMPLE_PROMPT_VARS,
      ),
    ).toEqual({ rendered: '\n\n【当前对话】\n和你说话的是 示例用户', unknownVars: ['nickname'] });
  });

  it('空白正文渲染为空串且不点名', () => {
    expect(previewPromptDefault('identity', '   \n ', SAMPLE_PROMPT_VARS)).toEqual({ rendered: '', unknownVars: [] });
    expect(previewPromptDefault('fallback', '', SAMPLE_PROMPT_VARS)).toEqual({ rendered: '', unknownVars: [] });
  });
});
