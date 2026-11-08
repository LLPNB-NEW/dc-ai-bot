import { describe, expect, it } from 'vitest';
import { DEFAULT_REACTION_GUIDE, resolveReactionGuide } from '../src/core/chat/reaction-guide';
import type { ReactionGuideConfig } from '../src/core/types';

const CHANNEL: ReactionGuideConfig = { scope: 'channel', scopeId: 'c1', prompt: '频道这一份', updatedAt: '2026-01-01T00:00:00.000Z' };
const GUILD: ReactionGuideConfig = { scope: 'guild', scopeId: 'g1', prompt: '公会这一份', updatedAt: '2026-01-01T00:00:00.000Z' };
const GLOBAL: ReactionGuideConfig = { scope: 'global', scopeId: '', prompt: '全局这一份', updatedAt: '2026-01-01T00:00:00.000Z' };

describe('resolveReactionGuide 三层覆盖（§28.10）', () => {
  it('channel > guild > global：三层都有就整份用 channel', () => {
    expect(resolveReactionGuide(CHANNEL, GUILD, GLOBAL)).toEqual({ prompt: '频道这一份', scope: 'channel' });
  });

  it('channel 没有行 → guild 生效', () => {
    expect(resolveReactionGuide(null, GUILD, GLOBAL)).toEqual({ prompt: '公会这一份', scope: 'guild' });
  });

  it('channel 与 guild 都没有 → global 生效', () => {
    expect(resolveReactionGuide(null, null, GLOBAL)).toEqual({ prompt: '全局这一份', scope: 'global' });
  });

  it('行存在但正文只有空白 = 这一层没有配置，落回上一层', () => {
    const blank: ReactionGuideConfig = { ...CHANNEL, prompt: '   \n\t ' };
    expect(resolveReactionGuide(blank, GUILD, GLOBAL)).toEqual({ prompt: '公会这一份', scope: 'guild' });
  });

  it('三层全空 → 内置默认，scope 记 global', () => {
    expect(resolveReactionGuide(null, null, null)).toEqual({ prompt: DEFAULT_REACTION_GUIDE, scope: 'global' });
    expect(resolveReactionGuide({ ...CHANNEL, prompt: '  ' }, null, null)).toEqual({
      prompt: DEFAULT_REACTION_GUIDE,
      scope: 'global',
    });
  });

  it('返回的正文是 trim 过的：库里存着前后空行也不会带进 system', () => {
    expect(resolveReactionGuide({ ...CHANNEL, prompt: '\n\n  频道这一份  \n\n' }, null, null).prompt).toBe('频道这一份');
  });
});

describe('DEFAULT_REACTION_GUIDE 内置默认文案（§28.10）', () => {
  it('分三小节，段落之间空行：怎么判断 / 怎么指定贴哪条 / 格式', () => {
    const sections = DEFAULT_REACTION_GUIDE.split('\n\n');
    expect(sections).toHaveLength(3);
    expect(sections[0]?.startsWith('【怎么判断】')).toBe(true);
    expect(sections[1]?.startsWith('【怎么指定贴哪条】')).toBe(true);
    expect(sections[2]?.startsWith('【格式】')).toBe(true);
  });

  it('什么样的消息值得贴、什么样的不值得：允许一条都不贴，这时一行 [[react:…]] 都不写', () => {
    expect(DEFAULT_REACTION_GUIDE).toContain('值得贴的');
    expect(DEFAULT_REACTION_GUIDE).toContain('不值得贴的');
    expect(DEFAULT_REACTION_GUIDE).toContain('一条都不贴完全允许');
    expect(DEFAULT_REACTION_GUIDE).toContain('一行 [[react:…]] 都不写');
    // 回一行 NONE 是表情请求那一侧的约定（reaction.ts 的 NO_REACTION_NOTE），这份共用规则里一个字都不能有
    expect(DEFAULT_REACTION_GUIDE).not.toContain('NONE');
  });

  it('输出格式契约：一行一个、三种写法、@all 同义词、最多 10 行', () => {
    expect(DEFAULT_REACTION_GUIDE).toContain('一行一个表情，最多 10 行');
    expect(DEFAULT_REACTION_GUIDE).toContain('[[react:😄]]');
    expect(DEFAULT_REACTION_GUIDE).toContain('[[react:😄@消息ID]]');
    expect(DEFAULT_REACTION_GUIDE).toContain('[[react:😄@作者名]]');
    expect(DEFAULT_REACTION_GUIDE).toContain('15~20 位纯数字');
    for (const word of ['@all', '@everyone', '@大家', '@所有人', '@全员', '@*']) {
      expect(DEFAULT_REACTION_GUIDE).toContain(word);
    }
  });

  it('自定义表情写成 [[react:名字]]，正文里不堆表情，不要解释与代码围栏', () => {
    expect(DEFAULT_REACTION_GUIDE).toContain('[[react:名字]]');
    expect(DEFAULT_REACTION_GUIDE).toContain(':名字:');
    expect(DEFAULT_REACTION_GUIDE).toContain('不要在正文里堆一串表情');
    expect(DEFAULT_REACTION_GUIDE).toContain('不要解释');
    expect(DEFAULT_REACTION_GUIDE).toContain('代码围栏');
  });

  it('不再出现强制分散与「只挑一个」的老口径', () => {
    expect(DEFAULT_REACTION_GUIDE).toContain('没点名就不换目标');
    expect(DEFAULT_REACTION_GUIDE).not.toContain('只挑一个');
    expect(DEFAULT_REACTION_GUIDE).not.toContain('不要输出多个');
    expect(DEFAULT_REACTION_GUIDE).not.toContain('要把表情分开贴到各自真正对应的那条消息上');
    expect(DEFAULT_REACTION_GUIDE).not.toContain('最多 2 个');
  });
});
