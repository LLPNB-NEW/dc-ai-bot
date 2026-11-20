import type { ReplySettingsStore } from '../ports';
import type { RevealStepsConfig, ScopedKey } from '../types';

/**
 * §38 假流式的默认切片次数：与 src/workers/discord/editor.ts 的 REVEAL_MAX_STEPS 同值。
 * 那一份是「编辑器没拿到配置」时的兜底，这一份是「三层都没配」的线上口径 —— 改一处必须同时改另一处。
 */
export const DEFAULT_REVEAL_STEPS = 6;

/** 合法区间：0 = 关闭假流式（整段一次发完），上限与后台输入框的 max 一致 */
export const REVEAL_STEPS_MIN = 0;
export const REVEAL_STEPS_MAX = 10;

/**
 * 一个数是不是合法的切片次数：只认 0–10 的整数。
 * 字符串 "6"、1.5、11 一律为假 —— 脏值当作「这一层没配置」比抛错安全，开关读坏了不该拖住回复。
 */
export function isRevealSteps(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= REVEAL_STEPS_MIN &&
    value <= REVEAL_STEPS_MAX
  );
}

/**
 * §38 的三层查找顺序：channel > guild > global。
 * 私聊没有服务器（guildId 为空），频道层也不该拿空串去匹配 —— 空 id 直接跳过这一层。
 */
function scopeChain(key: { guildId: string; channelId: string }): ScopedKey[] {
  return [
    { scope: 'channel', scopeId: key.channelId },
    { scope: 'guild', scopeId: key.guildId },
    { scope: 'global', scopeId: '' },
  ];
}

/** 空 id 的层等于不存在：不能把它当成「有一行 scopeId 为空串的配置」 */
function layerExists(layer: ScopedKey): boolean {
  return layer.scope === 'global' || layer.scopeId !== '';
}

/**
 * 三层覆盖（§38）：命中第一层的合法值就用它，三层都没有才用默认值。
 * 0 是合法值且必须生效，所以判空只能靠 isRevealSteps，不能用 || 落默认。
 */
export function resolveRevealSteps(
  rows: readonly RevealStepsConfig[],
  key: { guildId: string; channelId: string },
): number {
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    const hit = rows.find(
      (row) => row.scope === layer.scope && row.scopeId === layer.scopeId && isRevealSteps(row.revealSteps),
    );
    if (hit !== undefined) return hit.revealSteps;
  }
  return DEFAULT_REVEAL_STEPS;
}

/**
 * 逐层读库（§38）：命中合法值即返回，三层都没有用默认值。
 * 任何一层读失败都只当「这一层没配置」继续下一层 —— 开关读不出来绝不能把一条回复弄失败。
 */
export async function readRevealSteps(
  store: ReplySettingsStore,
  key: { guildId: string; channelId: string },
): Promise<number> {
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    let row: RevealStepsConfig | null;
    try {
      row = await store.get(layer);
    } catch {
      continue;
    }
    if (row !== null && isRevealSteps(row.revealSteps)) return row.revealSteps;
  }
  return DEFAULT_REVEAL_STEPS;
}
