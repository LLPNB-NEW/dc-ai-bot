import type { BodyEmojiGuideConfig, Scope } from '../types';

/**
 * 正文表情提示词的内置默认：默认关——空串就是「没有文案」，正文表情整段（清单 + 规则）都不出现。
 * 文案只来自三层配置里真的配了的那一层；GET /api/body-emoji-guides 的 default 直接回这份占位。
 * 保留常量而不是删掉，是为了让「内置默认」在类型与接口上始终有一个明确的值。
 */
export const DEFAULT_BODY_EMOJI_GUIDE: string = '';

/**
 * 推荐文案：后台「一键填入」按钮用的那一份，不会自动生效——用户点保存、真的落库之后才算配置。
 * 默认关是刻意的（见上），所以这里只提供建议，不把它当默认注入。
 */
export const BODY_EMOJI_SUGGESTION: string =
  '正文里可以自然带一两个 :名字:，只在真有情绪的那一句；不要每句都带、不要堆一串、不要解释表情本身。';

/**
 * 三层覆盖：channel > guild > global，整组覆盖——命中哪层就整份用哪层。
 * 某层没有行、或者正文 trim 之后为空，都等于「这一层没配置」，落回上一层；
 * 三层都没有才用内置默认，scope 记 'global'（对调用方来说就是「全局默认在生效」）。
 */
export interface ResolvedBodyEmojiGuide {
  /** 整份生效文案（已 trim），直接进 system */
  prompt: string;
  /** 命中的层；三层都没有时是 'global'（内置默认在生效） */
  scope: Scope;
}

export function resolveBodyEmojiGuide(
  channel: BodyEmojiGuideConfig | null,
  guild: BodyEmojiGuideConfig | null,
  global: BodyEmojiGuideConfig | null,
): ResolvedBodyEmojiGuide {
  for (const hit of [channel, guild, global]) {
    if (hit === null) continue;
    const prompt = hit.prompt.trim();
    if (prompt === '') continue;
    return { prompt, scope: hit.scope };
  }
  return { prompt: DEFAULT_BODY_EMOJI_GUIDE, scope: 'global' };
}
