import type { PromptConfig, PromptDefaultKey } from '../types';
import { TEMPLATE_VARS, findUnknownVarsIn, renderTemplate } from './template';

/** 兜底文案只有这两份；别的 key 一律当不存在（读侧忽略，写侧拒绝） */
export const PROMPT_DEFAULT_KEYS = ['fallback', 'identity'] as const;

/** 兜底提示词与三层提示词共用同一套 5 个变量 */
export const FALLBACK_PROMPT_VARS: readonly string[] = TEMPLATE_VARS;

/** 身份块多一个 user_id：称呼后面那个括号里的 ID 就是它 */
export const IDENTITY_PROMPT_VARS = ['bot_name', 'user_name', 'user_id', 'guild_name', 'channel_name', 'date'] as const;

export type IdentityPromptVar = (typeof IDENTITY_PROMPT_VARS)[number];
export type IdentityTemplateVars = Partial<Record<IdentityPromptVar, string>>;

/** 单份兜底文案的字数上限：与提示词段同量级，再长就该去写三层提示词了 */
export const MAX_PROMPT_DEFAULT_CHARS = 20000;

/**
 * 后台只读展示用：把今天代码里那句写死的身份块摊成等价模板文本。
 * 仅后台只读展示与预览，不参与真实装配——真实装配是 formatIdentityBlock 拼出来的。
 */
export const CODE_IDENTITY_TEMPLATE = [
  '【当前对话】',
  '和你说话的是 {{user_name}}（ID {{user_id}}）',
  '这里：{{guild_name}} · {{channel_name}}',
  '今天 {{date}}',
].join('\n');

/** 后台预览用的固定变量表；date 固定成一个日期，预览才有稳定可断言的输出 */
export const SAMPLE_PROMPT_VARS = {
  bot_name: '示例机器人',
  user_name: '示例用户',
  user_id: '123456789012345678',
  guild_name: '示例服务器',
  channel_name: '示例频道',
  date: '2026-11-05',
} satisfies IdentityTemplateVars;

export function isPromptDefaultKey(value: string): value is PromptDefaultKey {
  return (PROMPT_DEFAULT_KEYS as readonly string[]).includes(value);
}

/** 某个 key 允许出现哪些模板变量；PUT 校验与前端提示共用这一份 */
export function promptDefaultVars(key: PromptDefaultKey): readonly string[] {
  return key === 'fallback' ? FALLBACK_PROMPT_VARS : IDENTITY_PROMPT_VARS;
}

/** 模板里出现但不在该 key 变量表里的占位符（去重），保存时用它拒绝拼错的 {{}} */
export function findUnknownPromptDefaultVars(key: PromptDefaultKey, template: string): string[] {
  return findUnknownVarsIn(template, promptDefaultVars(key));
}

const VAR_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

function isIdentityVar(name: string): name is IdentityPromptVar {
  return (IDENTITY_PROMPT_VARS as readonly string[]).includes(name);
}

/**
 * 自定义身份块：逐行渲染，某一行引用的变量为空（含未知变量）就整行丢掉，
 * 渲染后只剩空白的行也丢掉；全丢光返回空串，system 里就整块不出现。
 * 有内容时以两个换行开头——与今天写死的身份块同一个位置约定，前置提示词不用改。
 */
export function renderIdentityTemplate(template: string, vars: IdentityTemplateVars): string {
  const lines: string[] = [];
  for (const raw of template.split(/\r?\n/)) {
    let drop = false;
    const rendered = raw.replace(new RegExp(VAR_PATTERN.source, 'g'), (_match: string, name: string) => {
      const value = isIdentityVar(name) ? (vars[name] ?? '').trim() : '';
      if (value === '') drop = true;
      return value;
    });
    if (drop) continue;
    if (rendered.trim() === '') continue;
    lines.push(rendered);
  }
  return lines.length === 0 ? '' : '\n\n' + lines.join('\n');
}

/**
 * 配了兜底提示词就包成一份单段 PromptConfig 交给 resolvePrompt：
 * id / 名字 / 位置固定，管理员只管正文；正文原样保留（换行由模板自己决定）。
 * 变量表里没有的占位符直接当「没配」——手改库写错一个 {{}} 不能把每条回复都弄失败。
 */
export function fallbackPromptConfig(content: string | null): PromptConfig | null {
  if (content === null || content.trim() === '') return null;
  if (findUnknownPromptDefaultVars('fallback', content).length > 0) return null;
  const segments = [
    {
      id: 'fallback',
      name: '内置默认',
      role: 'system' as const,
      content,
      enabled: true,
      placement: 'before' as const,
      position: 0,
    },
  ];
  return { segments };
}

/** 身份块拼装要的字段；与 TurnContext 解耦，后台预览才能拿示例值直接拼 */
export interface IdentityBlockVars {
  userName: string;
  userId: string;
  guildName: string;
  channelName: string;
  date: string;
}

/**
 * 身份块的唯一拼装实现：真实装配（service.buildIdentityBlock）与后台 GET 预览共用它，
 * GET 里 codeDefaults.identity.rendered 才可能和线上逐字一致，而不是另写一份冒充。
 */
export function formatIdentityBlock(vars: IdentityBlockVars): string {
  const userName = vars.userName.trim();
  if (userName === '') return '';

  const userId = vars.userId.trim();
  const sentences: string[] = ['和你说话的是 ' + userName + (userId === '' ? '' : '（ID ' + userId + '）')];
  // 平台措辞（Discord ID / 服务器 / 频道）会让模型把注意力放回「我是个 bot」，这里只留中性的地点说法
  const place = [vars.guildName.trim(), vars.channelName.trim()].filter((part) => part !== '');
  if (place.length > 0) sentences.push('这里：' + place.join(' · '));
  if (vars.date !== '') sentences.push('今天 ' + vars.date);
  return '\n\n【当前对话】' + sentences.join('；') + '。';
}

/**
 * 兜底提示词分层：channel > guild > global，第一个能用的层胜出。
 * 含未知变量、正文全空白的层等价于没配，直接跳过——手改库写错一个 {{}} 不能把回复弄失败。
 */
export function resolveFallbackPrompt(
  channel: string | null,
  guild: string | null,
  global: string | null,
): PromptConfig | null {
  for (const candidate of [channel, guild, global]) {
    const config = fallbackPromptConfig(candidate);
    if (config !== null) return config;
  }
  return null;
}

/** 身份块分层：channel > guild > global，第一个 trim 非空的原始文本；三层都空给 null（= 代码默认） */
export function pickScopedTemplate(channel: string | null, guild: string | null, global: string | null): string | null {
  for (const candidate of [channel, guild, global]) {
    if (candidate !== null && candidate.trim() !== '') return candidate;
  }
  return null;
}

/** 后台预览结果：rendered 是渲染后的正文，unknownVars 是点名的未知变量 */
export interface PromptDefaultPreview {
  rendered: string;
  unknownVars: string[];
}

/**
 * 后台预览（只读，不落库、不参与真实装配）：
 * fallback 走 renderTemplate，identity 走 renderIdentityTemplate（未知变量所在行整行丢弃）。
 * renderTemplate 遇未知变量会抛，所以 fallback 先把未知占位符剔掉再渲染，未知变量仍照常点名返回。
 */
export function previewPromptDefault(
  key: PromptDefaultKey,
  content: string,
  samples: IdentityTemplateVars,
): PromptDefaultPreview {
  const unknownVars = findUnknownPromptDefaultVars(key, content);
  if (key === 'identity') return { rendered: renderIdentityTemplate(content, samples), unknownVars };
  if (unknownVars.length === 0) return { rendered: renderTemplate(content, samples), unknownVars };

  const allowed = promptDefaultVars(key);
  const knownOnly = content.replace(new RegExp(VAR_PATTERN.source, 'g'), (raw: string, name: string) =>
    allowed.includes(name) ? raw : '',
  );
  return { rendered: renderTemplate(knownOnly, samples), unknownVars };
}
