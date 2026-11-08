import type { ReactionGuideConfig, Scope } from '../types';

/**
 * 贴表情提示词的内置默认（§28.10）：主模型的 system 段与表情模型的 system 用的是同一份。
 * 一段文字必须同时回答三件事，缺一件线上就退化——
 * 少「怎么判断」模型会逢消息必贴，少「不值得就不贴」它会硬凑一个，少「格式」它写成解释或代码围栏。
 * 分段之间留空行：这是给人也在后台编辑的文案，挤成一坨没法改。
 * 「一条都不贴」在这里只写成「一行 [[react:…]] 都不写」：回一行 NONE 是表情请求那一侧的约定，
 * 由 reaction.ts 的 NO_REACTION_NOTE 补，绝不写进这份共用规则——主模型会把它当正文抄出来。
 */
export const DEFAULT_REACTION_GUIDE: string = [
  '【怎么判断】',
  '值得贴的：开心的、可爱的、惊讶的、有梗的、在夸人或者在道谢的，都可以贴一个。',
  '不值得贴的：正经提问、吵架、难过、严肃通知，一个都不要贴；一条都不贴完全允许，这时一行 [[react:…]] 都不写，也不要解释为什么。',
  '',
  '【怎么指定贴哪条】',
  '[[react:😄]] 不写目标 = 贴在这一轮要回的那条消息上。',
  '[[react:😄@消息ID]] 贴到指定的那条消息（消息 ID 是 15~20 位纯数字）。',
  '[[react:😄@作者名]] 贴到这个人最近说的一条消息。',
  '想给最近说过话的每个人各贴一个，就写 @all：@all、@everyone、@大家、@所有人、@全员、@* 都算同一种写法，系统会把一个表情分给最近发过言的每个人，一人一条。',
  '没点名就不换目标：系统只贴在它自己那条上，不会替你挪到别人身上。',
  '',
  '【格式】',
  '一行一个表情，最多 10 行；一行只写 [[react:…]]，不要解释、不要加标点、不要用代码围栏、不要写别的文字。',
  '自定义表情写成 [[react:名字]]（名字就是清单里列出的那个，形如 :名字:）；unicode emoji 直接写在 [[react:]] 里，如 [[react:😄]]。',
  '贴表情只走 [[react:…]]；正文照常说话，不要在正文里堆一串表情。',
].join('\n');

/**
 * 三层覆盖（§28.10）：channel > guild > global，整组覆盖——命中哪层就整份用哪层。
 * 某层没有行、或者正文 trim 之后为空，都等于「这一层没配置」，落回上一层；
 * 三层都没有才用内置默认，scope 记 'global'（对调用方来说就是「全局默认在生效」）。
 */
export interface ResolvedReactionGuide {
  /** 整份生效文案（已 trim），直接进 system */
  prompt: string;
  /** 命中的层；三层都没有时是 'global'（内置默认在生效） */
  scope: Scope;
}

export function resolveReactionGuide(
  channel: ReactionGuideConfig | null,
  guild: ReactionGuideConfig | null,
  global: ReactionGuideConfig | null,
): ResolvedReactionGuide {
  for (const hit of [channel, guild, global]) {
    if (hit === null) continue;
    const prompt = hit.prompt.trim();
    if (prompt === '') continue;
    return { prompt, scope: hit.scope };
  }
  return { prompt: DEFAULT_REACTION_GUIDE, scope: 'global' };
}
