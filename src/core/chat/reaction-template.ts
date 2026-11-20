import type { ReactionTemplateConfig, Scope } from '../types';

/**
 * 表情模型素材能用的 6 个占位符（§34.3）：后台保存时按这份白名单校验，
 * 写了别的名字直接 400——拼错的占位符展开成空串，模型会以为那一段本来就没有内容。
 */
export const REACTION_TEMPLATE_VARS = ['最近对话', '对方的消息', '我的回复', '自定义表情', '可贴表情的消息', '表情规则'] as const;

/**
 * 内置默认模板：段落之间空一行，后台拿到的就是这份可编辑文案。
 * {{自定义表情}} 与 {{可贴表情的消息}} 展开时各自带标题，所以这里不再手写那两个标题；
 * {{表情规则}} 已经有一份在 system 里，默认不重复放进素材。
 */
export const DEFAULT_REACTION_TEMPLATE: string = [
  '【最近的对话】',
  '{{最近对话}}',
  '',
  '【对方的消息】',
  '{{对方的消息}}',
  '',
  '【我的回复】',
  '{{我的回复}}',
  '',
  '{{自定义表情}}',
  '',
  '{{可贴表情的消息}}',
].join('\n');

/** 变量名限 40 字：超过这个长度的多半是整段文字被错写成占位符，按未知变量拦下更好排错 */
const VAR_PATTERN = /\{\{([^{}]{1,40})\}\}/g;

/** 模板里出现的全部变量名，去重保序：保存前按它和白名单比，错一个都整次拒绝 */
export function collectReactionTemplateVars(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(VAR_PATTERN.source, 'g'))) {
    const name = match[1] ?? '';
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * 渲染素材：占位符逐个换掉，没给值的按空串——模板允许删段，也允许提到一个这轮没有的段。
 * 换完再收拾空壳：行尾空格去掉、连续 3 个以上换行压成 2 个、整体 trim。
 * 空目录 / 空清单展开成空串之后，留下的只是相邻两个空行，压完就干净了。
 */
export function renderReactionMaterial(template: string, values: Record<string, string>): string {
  const filled = template.replace(new RegExp(VAR_PATTERN.source, 'g'), (_raw: string, name: string) => values[name] ?? '');
  return filled
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 三层覆盖（§34.4）：channel > guild > global，整份覆盖——命中哪层就整份用哪层。
 * 某层没有行、或者正文 trim 之后为空，都等于「这一层没配置」，落回上一层；
 * 三层都没有才用内置默认，scope 记 'global'（对调用方来说就是「全局默认在生效」）。
 */
export interface ResolvedReactionTemplate {
  /** 整份生效模板（已 trim），直接进 renderReactionMaterial */
  template: string;
  /** 命中的层；三层都没有时是 'global'（内置默认在生效） */
  scope: Scope;
}

export function resolveReactionTemplate(
  channel: ReactionTemplateConfig | null,
  guild: ReactionTemplateConfig | null,
  global: ReactionTemplateConfig | null,
): ResolvedReactionTemplate {
  for (const hit of [channel, guild, global]) {
    if (hit === null) continue;
    const template = hit.template.trim();
    if (template === '') continue;
    return { template, scope: hit.scope };
  }
  return { template: DEFAULT_REACTION_TEMPLATE, scope: 'global' };
}
