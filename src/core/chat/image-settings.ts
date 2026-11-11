import type { ImageSettingsStore } from '../ports';
import type { ImageSettingsSecret, ScopedKey } from '../types';
import { IMAGE_MODEL_NAME } from './image-tool';

/** 生图模型名的后台输入上限：够长到容纳供应商前缀，又不至于把错误当配置存下来 */
export const IMAGE_MODEL_MAX_CHARS = 200;

/** 生图地址的后台输入上限；空 = 用当前聊天 Key 的 baseUrl */
export const IMAGE_BASE_URL_MAX_CHARS = 500;

/** 三层合并后的生图配置：未配的项落在默认模型 / 当前聊天 Key 上 */
export interface ResolvedImageSettings {
  model: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
}

/** 三层查找顺序：channel > guild > global。私聊没有 guildId，空 id 的层直接跳过 */
function scopeChain(key: { guildId: string; channelId: string }): ScopedKey[] {
  return [
    { scope: 'channel', scopeId: key.channelId },
    { scope: 'guild', scopeId: key.guildId },
    { scope: 'global', scopeId: '' },
  ];
}

function layerExists(layer: ScopedKey): boolean {
  return layer.scope === 'global' || layer.scopeId !== '';
}

/**
 * 按字段继承：model / baseUrl / apiKey 各自取 channel → guild → global 的第一个非空值。
 * 这样频道只改模型时，仍能继承全局自定义地址与 Key；三项都空才回默认模型与聊天 Key。
 */
export function resolveImageSettings(
  rows: readonly ImageSettingsSecret[],
  key: { guildId: string; channelId: string },
): ResolvedImageSettings {
  const ordered: ImageSettingsSecret[] = [];
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    const hit = rows.find((row) => row.scope === layer.scope && row.scopeId === layer.scopeId);
    if (hit !== undefined) ordered.push(hit);
  }

  const firstText = (read: (row: ImageSettingsSecret) => string): string | undefined => {
    for (const row of ordered) {
      const value = read(row).trim();
      if (value !== '') return value;
    }
    return undefined;
  };

  return {
    model: firstText((row) => row.model) ?? IMAGE_MODEL_NAME,
    baseUrl: firstText((row) => row.baseUrl),
    apiKey: firstText((row) => row.apiKey),
  };
}

/**
 * 逐层读库再按字段合并。任何一层读失败都只当「这一层没配置」继续下一层：
 * 生图配置读不出来只能落回默认值，绝不能因此把一条能画的回复弄失败。
 */
export async function readImageSettings(
  store: ImageSettingsStore,
  key: { guildId: string; channelId: string },
): Promise<ResolvedImageSettings> {
  const rows: ImageSettingsSecret[] = [];
  for (const layer of scopeChain(key)) {
    if (!layerExists(layer)) continue;
    try {
      const row = await store.get(layer);
      if (row !== null) rows.push(row);
    } catch {
      // 这一层坏掉就当没配；下一层或默认值继续兜底
    }
  }
  return resolveImageSettings(rows, key);
}
