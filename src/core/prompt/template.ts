export const TEMPLATE_VARS = ['bot_name', 'user_name', 'guild_name', 'channel_name', 'date'] as const;
export type TemplateVars = Partial<Record<(typeof TEMPLATE_VARS)[number], string>>;

type TemplateVar = (typeof TEMPLATE_VARS)[number];

// 变量两侧允许任意空白：模板由运营手写，{{ user_name }} 与 {{user_name}} 必须等价
const VAR_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/**
 * 酒馆预设里的控制宏：不是取值变量，而是对这段文本本身下手。
 * {{trim}} = 去掉这段前后空白（酒馆对它的语义就是这个），保存时放行、渲染时消费掉。
 * 只列真正实现了的宏：没实现的名字仍按未知变量拒绝，免得打错字被静默吞掉。
 */
export const TEMPLATE_MACROS = ['trim'] as const;

const TRIM_MACRO = /\{\{\s*trim\s*\}\}/;
const TRIM_MACRO_ALL = /\{\{\s*trim\s*\}\}/g;

function isKnownVar(name: string): name is TemplateVar {
  return (TEMPLATE_VARS as readonly string[]).includes(name);
}

function isMacro(name: string): boolean {
  return (TEMPLATE_MACROS as readonly string[]).includes(name);
}

/** 返回模板里出现但不在 allowed 中的变量名（去重）；风格与 findUnknownVars 一致，供别的变量表复用 */
export function findUnknownVarsIn(template: string, allowed: readonly string[]): string[] {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const match of template.matchAll(new RegExp(VAR_PATTERN.source, 'g'))) {
    const name = match[1] ?? '';
    if (allowed.includes(name) || isMacro(name) || seen.has(name)) continue;
    seen.add(name);
    unknown.push(name);
  }
  return unknown;
}

/** 返回模板里出现但不在白名单中的变量名（去重）；用于保存时校验 */
export function findUnknownVars(template: string): string[] {
  return findUnknownVarsIn(template, TEMPLATE_VARS);
}

/**
 * 渲染 {{var}}；未提供的变量渲染为空串；未知变量抛 Error('UNKNOWN_TEMPLATE_VAR: <name>')。
 * 带 {{trim}} 的段渲染完再整体去首尾空白（宏本身不产生字符）。
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const wantsTrim = TRIM_MACRO.test(template);
  const body = wantsTrim ? template.replace(TRIM_MACRO_ALL, '') : template;
  const rendered = body.replace(new RegExp(VAR_PATTERN.source, 'g'), (_raw: string, name: string) => {
    if (!isKnownVar(name)) throw new Error('UNKNOWN_TEMPLATE_VAR: ' + name);
    return vars[name] ?? '';
  });
  return wantsTrim ? rendered.trim() : rendered;
}
