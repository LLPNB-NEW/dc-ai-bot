import { describe, expect, it } from 'vitest';
import type { VisionSettingsStore } from '../src/core/ports';
import {
  DEFAULT_VISION_ENABLED,
  isVisionEnabled,
  readVisionEnabled,
  resolveVisionEnabled,
} from '../src/core/chat/vision-view';
import type { ScopedKey, VisionSettingsConfig } from '../src/core/types';

function row(scope: VisionSettingsConfig['scope'], scopeId: string, enabled: boolean): VisionSettingsConfig {
  return { scope, scopeId, enabled, updatedAt: '2026-01-01T00:00:00.000Z' };
}

/** 手改库才会有的脏值：类型上是布尔，库里是 0/1 */
function dirtyRow(scope: VisionSettingsConfig['scope'], scopeId: string, enabled: unknown): VisionSettingsConfig {
  return { scope, scopeId, enabled, updatedAt: '2026-01-01T00:00:00.000Z' } as unknown as VisionSettingsConfig;
}

interface FakeStore extends VisionSettingsStore {
  gets: ScopedKey[];
}

function fakeStore(
  rows: readonly VisionSettingsConfig[],
  fail: (key: ScopedKey) => boolean = () => false,
): FakeStore {
  const gets: ScopedKey[] = [];
  return {
    gets,
    async get(key) {
      gets.push({ scope: key.scope, scopeId: key.scopeId });
      if (fail(key)) throw new Error('读库挂了');
      return rows.find((item) => item.scope === key.scope && item.scopeId === key.scopeId) ?? null;
    },
    async list() {
      return [...rows];
    },
    async put(cfg) {
      return { ...cfg, updatedAt: '2026-01-01T00:00:00.000Z' };
    },
    async remove() {},
  };
}

describe('isVisionEnabled：只认布尔（§41）', () => {
  it('true / false 才算合法值', () => {
    expect(isVisionEnabled(true)).toBe(true);
    expect(isVisionEnabled(false)).toBe(true);
  });

  it('字符串一律为假（"true" 不是布尔）', () => {
    expect(isVisionEnabled('true')).toBe(false);
    expect(isVisionEnabled('false')).toBe(false);
    expect(isVisionEnabled('')).toBe(false);
  });

  it('数字 1 / 0 一律为假（库里是 INTEGER，但读侧只认布尔）', () => {
    expect(isVisionEnabled(1)).toBe(false);
    expect(isVisionEnabled(0)).toBe(false);
  });

  it('null / undefined / 对象一律为假', () => {
    expect(isVisionEnabled(null)).toBe(false);
    expect(isVisionEnabled(undefined)).toBe(false);
    expect(isVisionEnabled({})).toBe(false);
  });
});

describe('resolveVisionEnabled：三层优先级（§41）', () => {
  const key = { guildId: 'g1', channelId: 'c1' };

  it('三层都配了用频道层', () => {
    const rows = [row('global', '', true), row('guild', 'g1', true), row('channel', 'c1', false)];
    expect(resolveVisionEnabled(rows, key)).toBe(false);
  });

  it('频道层没配落回服务器层', () => {
    const rows = [row('global', '', true), row('guild', 'g1', false)];
    expect(resolveVisionEnabled(rows, key)).toBe(false);
  });

  it('只有全局层时用全局层', () => {
    expect(resolveVisionEnabled([row('global', '', false)], key)).toBe(false);
  });

  it('三层都没有回默认值（开）', () => {
    expect(DEFAULT_VISION_ENABLED).toBe(true);
    expect(resolveVisionEnabled([], key)).toBe(true);
  });

  it('enabled=false 必须真的生效（禁用 || 兜底的写法会把「关掉」变成「没配」）', () => {
    expect(resolveVisionEnabled([row('channel', 'c1', false)], key)).toBe(false);
    expect(resolveVisionEnabled([row('global', '', false)], key)).toBe(false);
  });

  it('空频道 id 跳过频道层', () => {
    const rows = [row('channel', '', false), row('global', '', true)];
    expect(resolveVisionEnabled(rows, { guildId: 'g1', channelId: '' })).toBe(true);
  });

  it('空服务器 id 跳过服务器层（私聊）', () => {
    const rows = [row('guild', '', false), row('global', '', true)];
    expect(resolveVisionEnabled(rows, { guildId: '', channelId: 'c1' })).toBe(true);
  });

  it('脏值当这一层没配置，继续往下落', () => {
    const rows = [dirtyRow('channel', 'c1', 1), row('guild', 'g1', false)];
    expect(resolveVisionEnabled(rows, key)).toBe(false);
  });
});

describe('readVisionEnabled：逐层读库（§41）', () => {
  const key = { guildId: 'g1', channelId: 'c1' };

  it('命中即停：频道层有值就不再查后两层', async () => {
    const store = fakeStore([row('channel', 'c1', true), row('guild', 'g1', false)]);
    expect(await readVisionEnabled(store, key)).toBe(true);
    expect(store.gets).toEqual([{ scope: 'channel', scopeId: 'c1' }]);
  });

  it('channel 没有行就按 guild、global 的顺序继续读', async () => {
    const store = fakeStore([row('global', '', false)]);
    expect(await readVisionEnabled(store, key)).toBe(false);
    expect(store.gets).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
  });

  it('某一层读库抛错只当这一层没配置，继续往下', async () => {
    const store = fakeStore([row('guild', 'g1', false)], (layer) => layer.scope === 'channel');
    expect(await readVisionEnabled(store, key)).toBe(false);
    expect(store.gets).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
    ]);
  });

  it('三层全抛错回默认值（开），不抛出去', async () => {
    const store = fakeStore([], () => true);
    expect(await readVisionEnabled(store, key)).toBe(true);
    expect(store.gets).toHaveLength(3);
  });

  it('读到的 false 就是 false，不能落回默认值', async () => {
    const store = fakeStore([row('channel', 'c1', false), row('global', '', true)]);
    expect(await readVisionEnabled(store, key)).toBe(false);
    expect(store.gets).toHaveLength(1);
  });

  it('私聊只读频道层与全局层', async () => {
    const store = fakeStore([]);
    expect(await readVisionEnabled(store, { guildId: '', channelId: 'c1' })).toBe(true);
    expect(store.gets).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'global', scopeId: '' },
    ]);
  });
});
