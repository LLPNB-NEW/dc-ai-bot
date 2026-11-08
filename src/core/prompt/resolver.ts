import type { PromptConfig, Scope } from '../types';

// 提示词缺失不是错误（§8）：三层全空时回落到这份内置提示词，而非像路由那样报错。
// 内置提示词也走分段结构，才能和库里存的层共用同一条装配路径（§11）。
export const DEFAULT_PROMPT: PromptConfig = {
  segments: [
    {
      id: 'default-main',
      name: '基本设定',
      role: 'system',
      content:
        '你是 {{bot_name}}，一个礼貌、简洁的中文助手，正在 {{guild_name}} 的 #{{channel_name}} 里与 {{user_name}} 对话。' +
        '请用简体中文回答：先给结论，再按需给理由，不寒暄、不复述问题、不编造不确定的信息。今天是 {{date}}。',
      enabled: true,
      placement: 'before',
      position: 0,
    },
  ],
};

/**
 * channel > guild > global > 后台可编辑的「内置默认」> 代码里的 DEFAULT_PROMPT。
 * 前三层与兜底层都空时返回内置默认（scope 记为 global），实现上永不返回 null。
 * fallback 缺省为 null：老调用方只传三层，行为与加这一层之前逐字相同。
 */
export function resolvePrompt(
  channel: PromptConfig | null,
  guild: PromptConfig | null,
  global: PromptConfig | null,
  fallback: PromptConfig | null = null,
): { cfg: PromptConfig; scope: Scope } | null {
  if (channel) return { cfg: channel, scope: 'channel' };
  if (guild) return { cfg: guild, scope: 'guild' };
  if (global) return { cfg: global, scope: 'global' };
  if (fallback) return { cfg: fallback, scope: 'global' };
  return { cfg: DEFAULT_PROMPT, scope: 'global' };
}
