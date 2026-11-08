import type { VoiceSettingsStore } from '../ports';
import type { ScopedKey, VoiceSettingsConfig } from '../types';

/** 三层开关的取值：0 = 不念，1 = 模型写了 [[voice]] 才念，2 = 每条回复都念 */
export const VOICE_MODE_OFF = 0;
export const VOICE_MODE_ON_REQUEST = 1;
export const VOICE_MODE_ALWAYS = 2;

/** 导演模式的取值：0 = 关（逐字朗读），1 = 只许插标签，2 = 允许顺句改写 */
export const VOICE_DIRECTOR_OFF = 0;
export const VOICE_DIRECTOR_TAGS = 1;
export const VOICE_DIRECTOR_FREE = 2;

/** 一个数是不是合法的导演模式：只认 0 / 1 / 2 三个整数，脏值当作「这一层没配置导演模式」 */
export function isVoiceDirector(value: unknown): value is 0 | 1 | 2 {
  return value === VOICE_DIRECTOR_OFF || value === VOICE_DIRECTOR_TAGS || value === VOICE_DIRECTOR_FREE;
}

/** 语速按百分比存取（100 = 原速）：区间与后台输入框的 min / max 一致 */
export const VOICE_SPEED_MIN = 50;
export const VOICE_SPEED_MAX = 200;
export const VOICE_SPEED_DEFAULT = 100;

/**
 * 一个数是不是合法的开关值：只认 0 / 1 / 2 三个整数。
 * 字符串 "1"、1.5、3 一律为假 —— 脏值当作「这一层没配置」比抛错安全，开关读坏了不该拖住回复。
 */
export function isVoiceMode(value: unknown): value is 0 | 1 | 2 {
  return value === VOICE_MODE_OFF || value === VOICE_MODE_ON_REQUEST || value === VOICE_MODE_ALWAYS;
}

/** 一个数是不是合法的语速：只认 50–200 的整数（百分比） */
export function isVoiceSpeed(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= VOICE_SPEED_MIN &&
    value <= VOICE_SPEED_MAX
  );
}

/**
 * 三层查找顺序：channel > guild > global。
 * 私聊没有服务器（guildId 为空），频道层也不该拿空串去匹配 —— 空 id 直接跳过这一层。
 */
export function scopeChain(key: { guildId: string; channelId: string }): ScopedKey[] {
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
 * 一条命中的行 -> 生效配置：mode 合法才算这一层有配置；speed 越界回落默认值、voice 空就是空串，
 * 都只影响各自那一项，不整条丢弃 —— 后台只改开关时不该把音色与语速一起清掉。
 */
function normalize(row: VoiceSettingsConfig): VoiceSettingsConfig {
  return {
    scope: row.scope,
    scopeId: row.scopeId,
    mode: row.mode,
    voice: row.voice,
    speed: isVoiceSpeed(row.speed) ? row.speed : VOICE_SPEED_DEFAULT,
    director: isVoiceDirector(row.director) ? row.director : VOICE_DIRECTOR_OFF,
    updatedAt: row.updatedAt,
  };
}

/**
 * 三层覆盖：命中第一层 mode 合法的行就用它，三层都没有才返回 null（= 没配置，等于不念）。
 * 0 是合法值且必须生效，所以判空只能靠 isVoiceMode，不能用 || 落默认。
 */
export function resolveVoiceSettings(
  rows: readonly VoiceSettingsConfig[],
  key: { guildId: string; channelId: string },
): VoiceSettingsConfig | null {
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    const hit = rows.find(
      (row) => row.scope === layer.scope && row.scopeId === layer.scopeId && isVoiceMode(row.mode),
    );
    if (hit !== undefined) return normalize(hit);
  }
  return null;
}

/**
 * 逐层读库：命中 mode 合法的行即返回，三层都没有返回 null。
 * 任何一层读失败都只当「这一层没配置」继续下一层 —— 开关读不出来绝不能把一条回复弄失败。
 */
export async function readVoiceSettings(
  store: VoiceSettingsStore,
  key: { guildId: string; channelId: string },
): Promise<VoiceSettingsConfig | null> {
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    let row: VoiceSettingsConfig | null;
    try {
      row = await store.get(layer);
    } catch {
      continue;
    }
    if (row !== null && isVoiceMode(row.mode)) return normalize(row);
  }
  return null;
}
