import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT, resolvePrompt } from '../src/core/prompt/resolver';
import { resolveRoute } from '../src/core/routing/resolve';
import type { PromptConfig, PromptSegment, RouteConfig } from '../src/core/types';

function seg(id: string, content: string, extra: Partial<PromptSegment> = {}): PromptSegment {
  return { id, name: id, role: 'system', content, enabled: true, placement: 'before', position: 0, ...extra };
}

const globalPrompt: PromptConfig = { segments: [seg('g-main', 'global 提示词')] };
const guildPrompt: PromptConfig = {
  segments: [seg('gu-main', 'guild 提示词'), seg('gu-persona', '公会人格', { name: '人格', position: 1 })],
};
const channelPrompt: PromptConfig = { segments: [seg('ch-main', 'channel 提示词')], temperature: 0.2 };

const globalRoute: RouteConfig = { primary: { provider: 'gemini', model: 'gemini-2.0-flash' }, fallbacks: [] };
const guildRoute: RouteConfig = {
  primary: { provider: 'anthropic', model: 'claude-3-5-haiku' },
  fallbacks: [{ provider: 'gemini', model: 'gemini-2.0-flash' }],
};
const channelRoute: RouteConfig = {
  primary: { provider: 'openai-compat', model: 'gpt-4o-mini' },
  fallbacks: [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }],
  temperature: 0.5,
};

describe('resolvePrompt 三层优先级', () => {
  it('三层都有 → 命中 channel', () => {
    const hit = resolvePrompt(channelPrompt, guildPrompt, globalPrompt);
    expect(hit).toEqual({ cfg: channelPrompt, scope: 'channel' });
  });

  it('channel 为空 → 命中 guild', () => {
    expect(resolvePrompt(null, guildPrompt, globalPrompt)).toEqual({ cfg: guildPrompt, scope: 'guild' });
  });

  it('channel/guild 都为空 → 命中 global', () => {
    expect(resolvePrompt(null, null, globalPrompt)).toEqual({ cfg: globalPrompt, scope: 'global' });
  });

  it('三层全空 → 回落到 DEFAULT_PROMPT 且 scope 为 global（提示词缺失不是错误）', () => {
    const hit = resolvePrompt(null, null, null);
    expect(hit).not.toBeNull();
    expect(hit?.cfg).toBe(DEFAULT_PROMPT);
    expect(hit?.scope).toBe('global');
    expect(DEFAULT_PROMPT.segments.length).toBeGreaterThan(0);
    expect(DEFAULT_PROMPT.segments[0]?.content.length).toBeGreaterThan(0);
  });

  it('DEFAULT_PROMPT 只用白名单变量，可被 renderTemplate 渲染', async () => {
    const { findUnknownVars } = await import('../src/core/prompt/template');
    expect(findUnknownVars(DEFAULT_PROMPT.segments.map((item) => item.content).join('\n'))).toEqual([]);
  });

  it('命中层返回的是该层对象本身，不被合并或改写', () => {
    const hit = resolvePrompt(null, guildPrompt, globalPrompt);
    expect(hit?.cfg).toBe(guildPrompt);
    expect(hit?.cfg.segments[1]?.content).toBe('公会人格');
  });
});

describe('resolveRoute 三层优先级', () => {
  it('三层都有 → 命中 channel', () => {
    expect(resolveRoute(channelRoute, guildRoute, globalRoute)).toEqual({ cfg: channelRoute, scope: 'channel' });
  });

  it('channel 为空 → 命中 guild（fallbacks 原样保留）', () => {
    const hit = resolveRoute(null, guildRoute, globalRoute);
    expect(hit?.scope).toBe('guild');
    expect(hit?.cfg.fallbacks).toEqual(guildRoute.fallbacks);
  });

  it('channel/guild 都为空 → 命中 global', () => {
    expect(resolveRoute(null, null, globalRoute)).toEqual({ cfg: globalRoute, scope: 'global' });
  });

  it('三层全空 → null（路由缺失才是错误）', () => {
    expect(resolveRoute(null, null, null)).toBeNull();
  });
});
