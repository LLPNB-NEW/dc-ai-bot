import type { VisionSettingsStore } from '../ports';
import type { VisionSettingsConfig, ScopedKey } from '../types';

/**
 * §41 主模型识图的默认口径：三层都没配时是「开」，与加这个开关之前的行为逐字相同。
 * 关掉只影响主对话那一路请求，表情模型照旧能看同一轮的图（见 TurnContext.mainImages）。
 */
export const DEFAULT_VISION_ENABLED = true;

/**
 * 一个值是不是合法的识图开关：只认真正的布尔。
 * 字符串 "true"、数字 1 / 0 一律为假 —— 脏值当作「这一层没配置」比抛错安全，开关读坏了不该拖住回复。
 */
export function isVisionEnabled(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * §41 的三层查找顺序：channel > guild > global。
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
 * 三层覆盖（§41）：命中第一层的合法值就用它，三层都没有才回默认值。
 * false 是合法值且必须真的生效，所以判空只能靠 isVisionEnabled，不能写成 enabled || 默认值。
 */
export function resolveVisionEnabled(
  rows: readonly VisionSettingsConfig[],
  key: { guildId: string; channelId: string },
): boolean {
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    const hit = rows.find(
      (row) => row.scope === layer.scope && row.scopeId === layer.scopeId && isVisionEnabled(row.enabled),
    );
    if (hit !== undefined) return hit.enabled;
  }
  return DEFAULT_VISION_ENABLED;
}

/**
 * 逐层读库（§41）：命中合法值即返回，三层都没有回默认值。
 * 任何一层读失败都只当「这一层没配置」继续下一层 —— 开关读不出来绝不能把一条回复弄失败。
 */
export async function readVisionEnabled(
  store: VisionSettingsStore,
  key: { guildId: string; channelId: string },
): Promise<boolean> {
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    let row: VisionSettingsConfig | null;
    try {
      row = await store.get(layer);
    } catch {
      continue;
    }
    if (row !== null && isVisionEnabled(row.enabled)) return row.enabled;
  }
  return DEFAULT_VISION_ENABLED;
}
