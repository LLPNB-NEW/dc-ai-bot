import type { ChatMessage, PromptInjectionConfig, Role, ScopedKey } from '../types';

/** 深度上限：再深就等于塞进开场白，超过历史长度的按最深处（最靠前）处理 */
export const INJECTION_DEPTH_MAX = 50;
/** 单条注入正文上限：PUT 校验、后台卡片计数、仓储读侧共用这一份，不各写一个数 */
export const INJECTION_CONTENT_MAX_CHARS = 20000;

/**
 * 三层注入的存储端口。放在这里而不是 ports.ts：读写两端拿到的就是同一个形状（一层一行），
 * 这个模块既不认识 D1 也不认识 HTTP，端口跟它的语义放在一起才不会两边各猜一次。
 */
export interface PromptInjectionStore {
  get(key: ScopedKey): Promise<PromptInjectionConfig | null>;
  list(): Promise<PromptInjectionConfig[]>;
  put(cfg: Omit<PromptInjectionConfig, 'updatedAt'>): Promise<PromptInjectionConfig>;
  remove(key: ScopedKey): Promise<void>;
}

/** 合成消息允许的三个角色：别的值既进不了库，也不会被拿去拼 messages */
export const INJECTION_ROLES: readonly Role[] = ['system', 'user', 'assistant'];

/** depth 只认 0–50 的整数：越界、小数、非数字一律算坏值 */
export function isInjectionDepth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= INJECTION_DEPTH_MAX;
}

export function isInjectionRole(value: unknown): value is Role {
  return value === 'system' || value === 'user' || value === 'assistant';
}

/** 空正文 = 这一层关着：后台删不掉的配置用空串表达，解析与插入两处都必须认这个口径 */
function isConfigured(cfg: PromptInjectionConfig | null): cfg is PromptInjectionConfig {
  return cfg !== null && cfg.content.trim() !== '';
}

/**
 * 三层解析 channel > guild > global：空正文的那一层视为没配置，继续往下找；
 * 三层都空 / 都没有返回 null（= 这一轮不插任何东西）。
 */
export function resolveInjection(
  channel: PromptInjectionConfig | null,
  guild: PromptInjectionConfig | null,
  global: PromptInjectionConfig | null,
): PromptInjectionConfig | null {
  for (const layer of [channel, guild, global]) {
    if (isConfigured(layer)) return layer;
  }
  return null;
}

/**
 * 往 messages 里插一条合成消息：位置 = 倒数第 depth 条之前（depth = 0 就是紧接本轮用户消息之前）。
 * 合成消息只带 role + content——没有 author，就绝不会被 withAuthorPrefix 加上名字。
 * 没配置时原样返回同一个数组：调用方拿到的 messages 与接线前逐字一致，也包括续写那条路径。
 */
export function withInjection(
  messages: ChatMessage[],
  injection: PromptInjectionConfig | null,
): ChatMessage[] {
  if (!isConfigured(injection)) return messages;
  // 空历史不造一条孤立消息：没有对话时插进去的合成消息没有任何可依附的位置
  if (messages.length === 0) return messages;
  const depth = Number.isFinite(injection.depth) ? Math.trunc(injection.depth) : 0;
  const clamped = Math.min(Math.max(depth, 0), messages.length - 1);
  const at = messages.length - 1 - clamped;
  const synthetic: ChatMessage = { role: injection.role, content: injection.content };
  return [...messages.slice(0, at), synthetic, ...messages.slice(at)];
}
