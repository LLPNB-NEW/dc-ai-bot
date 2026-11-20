import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REACTION_TEMPLATE,
  REACTION_TEMPLATE_VARS,
  collectReactionTemplateVars,
  renderReactionMaterial,
  resolveReactionTemplate,
} from '../src/core/chat/reaction-template';
import type { ReactionTemplateConfig } from '../src/core/types';

function cfg(scope: 'global' | 'guild' | 'channel', template: string): ReactionTemplateConfig {
  return { scope, scopeId: scope === 'global' ? '' : 'x', template, updatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('表情素材模板的占位符（§34.3）', () => {
  it('六个占位符、顺序固定', () => {
    expect(REACTION_TEMPLATE_VARS).toEqual(['最近对话', '对方的消息', '我的回复', '自定义表情', '可贴表情的消息', '表情规则']);
  });

  it('默认模板只覆盖五个：{{表情规则}} 在 system 里已有一份，素材里不重复', () => {
    const used = collectReactionTemplateVars(DEFAULT_REACTION_TEMPLATE);

    expect(used).toHaveLength(5);
    expect(used).toEqual(REACTION_TEMPLATE_VARS.filter((name) => name !== '表情规则'));
    expect(DEFAULT_REACTION_TEMPLATE).not.toContain('{{表情规则}}');
  });

  it('默认模板不自带清单/目标的标题：这两段展开时已经带着标题', () => {
    expect(DEFAULT_REACTION_TEMPLATE).not.toContain('【可用自定义表情】');
    expect(DEFAULT_REACTION_TEMPLATE).not.toContain('【可贴表情的消息】');
  });

  it('collect 去重保序：按第一次出现的先后留一个', () => {
    expect(collectReactionTemplateVars('{{最近对话}} 与 {{我的回复}} 与 {{最近对话}}')).toEqual(['最近对话', '我的回复']);
    expect(collectReactionTemplateVars('{{我的回复}}{{对方的消息}}')).toEqual(['我的回复', '对方的消息']);
    expect(collectReactionTemplateVars('')).toEqual([]);
    expect(collectReactionTemplateVars('没有占位符的纯文本')).toEqual([]);
  });

  it('collect 只认 1..40 个字符的花括号占位符：空的与超长的都不算', () => {
    expect(collectReactionTemplateVars('{{}}')).toEqual([]);
    expect(collectReactionTemplateVars('{{' + 'a'.repeat(40) + '}}')).toHaveLength(1);
    expect(collectReactionTemplateVars('{{' + 'a'.repeat(41) + '}}')).toEqual([]);
  });
});

describe('renderReactionMaterial（§34.3）', () => {
  it('逐个替换，没提供的名字按空串', () => {
    expect(renderReactionMaterial('【对方的消息】\n{{对方的消息}}\n\n【我的回复】\n{{我的回复}}', {
      对方的消息: '你好',
      我的回复: '好的',
    })).toBe('【对方的消息】\n你好\n\n【我的回复】\n好的');

    expect(renderReactionMaterial('a{{没提供的变量}}b', {})).toBe('ab');
  });

  it('空段折叠：清单段与目标段都是空串时，不留空行也不留空壳标题', () => {
    expect(renderReactionMaterial('{{自定义表情}}\n\n{{可贴表情的消息}}', { 自定义表情: '', 可贴表情的消息: '' })).toBe(
      '',
    );
    // 段之间空一行是刻意的，连续三个换行才是空段残留
    expect(renderReactionMaterial('甲\n\n{{自定义表情}}\n\n乙', { 自定义表情: '' })).toBe('甲\n\n乙');
  });

  it('行尾空格与制表符去掉、整体 trim；行首缩进是后台自己写的版式，留着', () => {
    expect(renderReactionMaterial('\n\n甲  \n\n\n  乙\t\n\n', {})).toBe('甲\n\n  乙');
  });

  it('默认模板 + 空历史 + 空清单：只剩两段正文', () => {
    expect(
      renderReactionMaterial(DEFAULT_REACTION_TEMPLATE, {
        最近对话: '',
        对方的消息: '你好',
        我的回复: '好的',
        自定义表情: '',
        可贴表情的消息: '',
        表情规则: '',
      }),
    ).toBe('【最近的对话】\n\n【对方的消息】\n你好\n\n【我的回复】\n好的');
  });
});

describe('resolveReactionTemplate（§34.4）', () => {
  it('频道 > 服务器 > 全局：最近的一层整份生效', () => {
    const channel = cfg('channel', '频道模板');
    const guild = cfg('guild', '服务器模板');
    const global = cfg('global', '全局模板');

    expect(resolveReactionTemplate(channel, guild, global)).toEqual({ template: '频道模板', scope: 'channel' });
    expect(resolveReactionTemplate(null, guild, global)).toEqual({ template: '服务器模板', scope: 'guild' });
    expect(resolveReactionTemplate(null, null, global)).toEqual({ template: '全局模板', scope: 'global' });
  });

  it('trim 后为空等于没配：继续往下找', () => {
    expect(resolveReactionTemplate(cfg('channel', '   '), cfg('guild', '服务器模板'), null)).toEqual({
      template: '服务器模板',
      scope: 'guild',
    });
    expect(resolveReactionTemplate(cfg('channel', '\n\t'), null, cfg('global', '全局模板'))).toEqual({
      template: '全局模板',
      scope: 'global',
    });
  });

  it('三层都没有就回默认模板（归到全局这一层）', () => {
    expect(resolveReactionTemplate(null, null, null)).toEqual({
      template: DEFAULT_REACTION_TEMPLATE,
      scope: 'global',
    });
    expect(resolveReactionTemplate(cfg('channel', '  '), cfg('guild', ''), cfg('global', ' \n '))).toEqual({
      template: DEFAULT_REACTION_TEMPLATE,
      scope: 'global',
    });
  });

  it('找到就整份用：不与上层拼段', () => {
    const resolved = resolveReactionTemplate(cfg('channel', '{{我的回复}}'), null, cfg('global', '全局模板'));

    expect(resolved.template).toBe('{{我的回复}}');
  });
});
