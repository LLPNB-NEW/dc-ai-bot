import { describe, expect, it } from 'vitest';
import type { ReplySettingsStore } from '../src/core/ports';
import {
  DEFAULT_REVEAL_STEPS,
  REVEAL_STEPS_MAX,
  REVEAL_STEPS_MIN,
  isRevealSteps,
  readRevealSteps,
  resolveRevealSteps,
} from '../src/core/chat/reply-view';
import type { RevealStepsConfig, ScopedKey } from '../src/core/types';

function row(scope: 'global' | 'guild' | 'channel', scopeId: string, revealSteps: number): RevealStepsConfig {
  return { scope, scopeId, revealSteps, updatedAt: '2026-01-01T00:00:00.000Z' };
}

interface FakeStore extends ReplySettingsStore {
  /** 每次 get 打到的层，按调用顺序：用来验证「命中即停」 */
  gets: ScopedKey[];
}

/** fail 返回 true 的层模拟读库抛错（D1 抖动、表还没建都不该拖住回复） */
function fakeStore(rows: RevealStepsConfig[], fail?: (key: ScopedKey) => boolean): FakeStore {
  const gets: ScopedKey[] = [];
  return {
    gets,
    async get(key: ScopedKey): Promise<RevealStepsConfig | null> {
      gets.push(key);
      if (fail?.(key) === true) throw new Error('D1 读失败');
      return rows.find((item) => item.scope === key.scope && item.scopeId === key.scopeId) ?? null;
    },
    async list(): Promise<RevealStepsConfig[]> {
      return [...rows];
    },
    async put(cfg: Omit<RevealStepsConfig, 'updatedAt'>): Promise<RevealStepsConfig> {
      const saved: RevealStepsConfig = { ...cfg, updatedAt: '2026-01-01T00:00:00.000Z' };
      rows.push(saved);
      return saved;
    },
    async remove(key: ScopedKey): Promise<void> {
      const index = rows.findIndex((item) => item.scope === key.scope && item.scopeId === key.scopeId);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}

describe('isRevealSteps：只认 0–10 的整数（§38）', () => {
  it('区间两端与中间的整数都合法', () => {
    expect(isRevealSteps(REVEAL_STEPS_MIN)).toBe(true);
    expect(isRevealSteps(REVEAL_STEPS_MAX)).toBe(true);
    expect(isRevealSteps(6)).toBe(true);
  });

  it('越界、小数、字符串、缺值都不合法', () => {
    for (const value of [REVEAL_STEPS_MAX + 1, REVEAL_STEPS_MIN - 1, 1.5, '6', null, undefined, Number.NaN]) {
      expect(isRevealSteps(value)).toBe(false);
    }
  });
});

describe('resolveRevealSteps：三层优先级（§38）', () => {
  const key = { guildId: 'g1', channelId: 'c1' };

  it('channel 命中就用 channel，压过 guild 与 global', () => {
    const rows = [row('channel', 'c1', 2), row('guild', 'g1', 4), row('global', '', 8)];
    expect(resolveRevealSteps(rows, key)).toBe(2);
  });

  it('没有 channel 行就落 guild', () => {
    const rows = [row('guild', 'g1', 4), row('global', '', 8)];
    expect(resolveRevealSteps(rows, key)).toBe(4);
  });

  it('只有 global 就用 global', () => {
    expect(resolveRevealSteps([row('global', '', 3)], key)).toBe(3);
  });

  it('三层都没有才用默认值', () => {
    expect(resolveRevealSteps([], key)).toBe(DEFAULT_REVEAL_STEPS);
  });

  it('0 是合法值且必须生效，不能落回默认 6', () => {
    expect(resolveRevealSteps([row('channel', 'c1', 0), row('global', '', 5)], key)).toBe(0);
  });

  it('越界值等于这一层没配置：落到下一层', () => {
    const rows = [row('channel', 'c1', 11), row('guild', 'g1', 4)];
    expect(resolveRevealSteps(rows, key)).toBe(4);
  });

  it('小数同样当作没配置', () => {
    const rows = [row('guild', 'g1', 2.5), row('global', '', 7)];
    expect(resolveRevealSteps(rows, key)).toBe(7);
  });

  it('channelId 为空时跳过 channel 层（空串行不算这一层）', () => {
    const rows = [row('channel', '', 1), row('guild', 'g1', 4)];
    expect(resolveRevealSteps(rows, { guildId: 'g1', channelId: '' })).toBe(4);
  });

  it('guildId 为空时跳过 guild 层，global 仍然生效', () => {
    const rows = [row('guild', '', 1), row('global', '', 9)];
    expect(resolveRevealSteps(rows, { guildId: '', channelId: 'c1' })).toBe(9);
  });
});

describe('readRevealSteps：逐层读库（§38）', () => {
  const key = { guildId: 'g1', channelId: 'c1' };

  it('channel 命中就停：只查一次库', async () => {
    const store = fakeStore([row('channel', 'c1', 2), row('guild', 'g1', 4)]);
    expect(await readRevealSteps(store, key)).toBe(2);
    expect(store.gets).toEqual([{ scope: 'channel', scopeId: 'c1' }]);
  });

  it('channel 没有行才去查 guild 与 global', async () => {
    const store = fakeStore([row('global', '', 3)]);
    expect(await readRevealSteps(store, key)).toBe(3);
    expect(store.gets).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'guild', scopeId: 'g1' },
      { scope: 'global', scopeId: '' },
    ]);
  });

  it('某一层读库抛错按「没配置」继续下一层', async () => {
    const store = fakeStore([row('guild', 'g1', 4)], (layer) => layer.scope === 'channel');
    expect(await readRevealSteps(store, key)).toBe(4);
  });

  it('三层全抛错返回默认值，绝不把异常抛给调用方', async () => {
    const store = fakeStore([], () => true);
    await expect(readRevealSteps(store, key)).resolves.toBe(DEFAULT_REVEAL_STEPS);
  });

  it('读到 0 就返回 0', async () => {
    const store = fakeStore([row('channel', 'c1', 0)]);
    expect(await readRevealSteps(store, key)).toBe(0);
  });

  it('私聊（guildId 为空）只查 channel 与 global', async () => {
    const store = fakeStore([row('global', '', 8)]);
    expect(await readRevealSteps(store, { guildId: '', channelId: 'c1' })).toBe(8);
    expect(store.gets).toEqual([
      { scope: 'channel', scopeId: 'c1' },
      { scope: 'global', scopeId: '' },
    ]);
  });
});
