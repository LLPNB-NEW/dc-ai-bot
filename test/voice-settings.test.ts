import { describe, expect, it } from 'vitest';
import type { VoiceSettingsStore } from '../src/core/ports';
import type { Scope, ScopedKey, VoiceSettingsConfig } from '../src/core/types';
import {
  VOICE_DIRECTOR_FREE,
  VOICE_DIRECTOR_OFF,
  VOICE_DIRECTOR_TAGS,
  VOICE_MODE_ALWAYS,
  VOICE_MODE_OFF,
  VOICE_MODE_ON_REQUEST,
  VOICE_SPEED_DEFAULT,
  isVoiceDirector,
  isVoiceMode,
  isVoiceSpeed,
  readVoiceSettings,
  resolveVoiceSettings,
  scopeChain,
} from '../src/core/voice/settings';

const KEY = { guildId: 'g1', channelId: 'c1' };

function row(
  scope: Scope,
  scopeId: string,
  mode: number,
  extra: Partial<VoiceSettingsConfig> = {},
): VoiceSettingsConfig {
  return {
    scope,
    scopeId,
    mode,
    voice: '',
    speed: VOICE_SPEED_DEFAULT,
    director: VOICE_DIRECTOR_OFF,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** 只实现 get：其余三个方法这些用例碰不到 */
function storeOf(
  rows: VoiceSettingsConfig[],
  failScopes: Scope[] = [],
): VoiceSettingsStore {
  return {
    async get(key: ScopedKey): Promise<VoiceSettingsConfig | null> {
      if (failScopes.includes(key.scope)) throw new Error('D1 down');
      return rows.find((item) => item.scope === key.scope && item.scopeId === key.scopeId) ?? null;
    },
    async list(): Promise<VoiceSettingsConfig[]> {
      return rows;
    },
    async put(): Promise<VoiceSettingsConfig> {
      throw new Error('not used');
    },
    async remove(): Promise<void> {
      throw new Error('not used');
    },
  };
}

describe('isVoiceMode / isVoiceSpeed', () => {
  it('只认 0/1/2 三个整数，字符串与小数都不算', () => {
    expect(isVoiceMode(VOICE_MODE_OFF)).toBe(true);
    expect(isVoiceMode(VOICE_MODE_ON_REQUEST)).toBe(true);
    expect(isVoiceMode(VOICE_MODE_ALWAYS)).toBe(true);
    for (const value of [3, -1, 1.5, '1', null, undefined, true]) {
      expect(isVoiceMode(value)).toBe(false);
    }
  });

  it('语速只认 50–200 的整数（边界含）', () => {
    expect(isVoiceSpeed(50)).toBe(true);
    expect(isVoiceSpeed(200)).toBe(true);
    for (const value of [49, 201, 100.5, '100', null]) {
      expect(isVoiceSpeed(value)).toBe(false);
    }
  });
});

describe('isVoiceDirector', () => {
  it('只认 0/1/2 三个整数，字符串与小数都不算', () => {
    expect(isVoiceDirector(VOICE_DIRECTOR_OFF)).toBe(true);
    expect(isVoiceDirector(VOICE_DIRECTOR_TAGS)).toBe(true);
    expect(isVoiceDirector(VOICE_DIRECTOR_FREE)).toBe(true);
    for (const value of [3, -1, 1.5, '1', null, undefined, true]) {
      expect(isVoiceDirector(value)).toBe(false);
    }
  });
});

describe('scopeChain', () => {
  it('顺序是 channel -> guild -> global', () => {
    expect(scopeChain(KEY)).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
  });
});

describe('resolveVoiceSettings', () => {
  it('channel 赢 guild、guild 赢 global', () => {
    const rows = [
      row('global', '', VOICE_MODE_OFF),
      row('guild', 'g1', VOICE_MODE_ON_REQUEST),
      row('channel', 'c1', VOICE_MODE_ALWAYS),
    ];
    expect(resolveVoiceSettings(rows, KEY)?.mode).toBe(VOICE_MODE_ALWAYS);
    expect(resolveVoiceSettings(rows.slice(0, 2), KEY)?.mode).toBe(VOICE_MODE_ON_REQUEST);
    expect(resolveVoiceSettings(rows.slice(0, 1), KEY)?.mode).toBe(VOICE_MODE_OFF);
  });

  it('0 是合法值：不能被 || 当成没配置', () => {
    const rows = [row('channel', 'c1', VOICE_MODE_OFF), row('global', '', VOICE_MODE_ALWAYS)];
    const resolved = resolveVoiceSettings(rows, KEY);
    expect(resolved).not.toBeNull();
    expect(resolved?.mode).toBe(VOICE_MODE_OFF);
    expect(resolved?.scope).toBe('channel');
  });

  it('mode 非法的那一行等于这层没配，继续往下找', () => {
    const rows = [row('channel', 'c1', 3), row('guild', 'g1', 1.5), row('global', '', VOICE_MODE_ALWAYS)];
    expect(resolveVoiceSettings(rows, KEY)?.scope).toBe('global');
    expect(resolveVoiceSettings([row('channel', 'c1', Number.NaN)], KEY)).toBeNull();
  });

  it('speed 越界只用默认语速，voice 空串原样返回，不整条丢弃', () => {
    const resolved = resolveVoiceSettings([row('channel', 'c1', VOICE_MODE_ALWAYS, { speed: 900 })], KEY);
    expect(resolved?.speed).toBe(VOICE_SPEED_DEFAULT);
    expect(resolved?.mode).toBe(VOICE_MODE_ALWAYS);
    expect(resolved?.voice).toBe('');
  });

  it('director 0/1/2 都原样带回（0 也是合法值）', () => {
    for (const director of [VOICE_DIRECTOR_OFF, VOICE_DIRECTOR_TAGS, VOICE_DIRECTOR_FREE]) {
      expect(resolveVoiceSettings([row('channel', 'c1', VOICE_MODE_ALWAYS, { director })], KEY)?.director).toBe(director);
    }
  });

  it('director 脏值只落回 0，不整条丢弃', () => {
    for (const director of [9, -1, 1.5, Number.NaN]) {
      const resolved = resolveVoiceSettings([row('channel', 'c1', VOICE_MODE_ALWAYS, { director })], KEY);
      expect(resolved?.director).toBe(VOICE_DIRECTOR_OFF);
      expect(resolved?.mode).toBe(VOICE_MODE_ALWAYS);
    }
  });

  it('私聊（guildId 空）跳过 guild 层，只查 channel + global', () => {
    const rows = [row('guild', '', VOICE_MODE_ALWAYS)];
    expect(resolveVoiceSettings(rows, { guildId: '', channelId: 'c1' })).toBeNull();
  });

  it('三层都没有返回 null', () => {
    expect(resolveVoiceSettings([], KEY)).toBeNull();
    expect(resolveVoiceSettings([row('guild', 'g9', VOICE_MODE_ALWAYS)], KEY)).toBeNull();
  });
});

describe('readVoiceSettings', () => {
  it('命中最外层即停，不再读内层', async () => {
    const reads: Scope[] = [];
    const store = storeOf([row('channel', 'c1', VOICE_MODE_ON_REQUEST)]);
    const spy: VoiceSettingsStore = {
      ...store,
      async get(key: ScopedKey): Promise<VoiceSettingsConfig | null> {
        reads.push(key.scope);
        return store.get(key);
      },
    };
    expect((await readVoiceSettings(spy, KEY))?.mode).toBe(VOICE_MODE_ON_REQUEST);
    expect(reads).toEqual(['channel']);
  });

  it('本层读库抛错当作没配，继续下一层', async () => {
    const store = storeOf([row('global', '', VOICE_MODE_ALWAYS)], ['channel', 'guild']);
    expect((await readVoiceSettings(store, KEY))?.scope).toBe('global');
  });

  it('全抛或全空都返回 null（读开关失败不许抛给调用方）', async () => {
    expect(await readVoiceSettings(storeOf([], ['channel', 'guild', 'global']), KEY)).toBeNull();
    expect(await readVoiceSettings(storeOf([]), KEY)).toBeNull();
  });

  it('读到非法 mode 的行当作没配，继续往下', async () => {
    const store = storeOf([row('channel', 'c1', 9), row('guild', 'g1', VOICE_MODE_ON_REQUEST)]);
    expect((await readVoiceSettings(store, KEY))?.scope).toBe('guild');
  });
});
