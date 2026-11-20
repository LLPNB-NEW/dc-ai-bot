import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVoiceSettings, saveVoiceSetting } from './api';

// 契约（src/workers/http/app.ts:2407-2461）：GET 的 items 与 default 都带 quoteOnly，PUT 显式带 quoteOnly、
// 省略时按 true。web 侧只做解析与回传，request() 只认 globalThis.fetch，替换它就能验形状，用不上 jsdom。

const ISO = '2026-11-06T00:00:00.000Z';
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '333333333333333333';

interface CapturedCall {
  path: string;
  init: RequestInit;
}

function stubFetch(payload: unknown): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

function bodyOf(call: CapturedCall | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error('没有捕获到请求');
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web 侧语音配置的 quoteOnly 解析', () => {
  it('GET /api/voice-settings：items 里 true / false 原样读出，缺列与坏形状回落 true', async () => {
    stubFetch({
      items: [
        { scope: 'global', scopeId: '', mode: 2, director: 0, voice: 'nova', speed: 100, quoteOnly: false, updatedAt: ISO },
        { scope: 'guild', scopeId: GUILD, mode: 1, director: 1, voice: '', speed: 120, quoteOnly: true, updatedAt: ISO },
        // 老库：整条没有这一列，按旧行为「只念引号」兜底
        { scope: 'channel', scopeId: CHANNEL, mode: 1, director: 0, voice: '', speed: 100, updatedAt: '' },
        // 坏形状：只认真正的 boolean，1 不能当成 true
        { scope: 'channel', scopeId: OTHER_CHANNEL, mode: 1, director: 0, voice: '', speed: 100, quoteOnly: 1, updatedAt: '' },
      ],
      default: { mode: 0, voice: '', speed: 100, director: 0, quoteOnly: false },
    });

    const snapshot = await fetchVoiceSettings();
    expect(snapshot.items.map((item) => item.quoteOnly)).toEqual([false, true, true, true]);
    expect(snapshot.default.quoteOnly).toBe(false);
  });

  it('GET /api/voice-settings：default 缺列 / 坏形状都回落 true', async () => {
    stubFetch({ items: [], default: { mode: 1, voice: '', speed: 100, director: 0 } });
    expect((await fetchVoiceSettings()).default.quoteOnly).toBe(true);

    vi.unstubAllGlobals();
    stubFetch({ items: [], default: { mode: 1, voice: '', speed: 100, director: 0, quoteOnly: 'false' } });
    expect((await fetchVoiceSettings()).default.quoteOnly).toBe(true);
  });

  it('PUT /api/voice-settings：显式 quoteOnly=false 进请求体，回读按后端回的那一行解析', async () => {
    const calls = stubFetch({
      scope: 'global',
      scopeId: '',
      mode: 2,
      director: 0,
      voice: 'nova',
      speed: 100,
      quoteOnly: false,
      updatedAt: ISO,
    });

    const saved = await saveVoiceSetting({ scope: 'global', mode: 2, voice: 'nova', speed: 100, quoteOnly: false });

    expect(calls[0]?.path).toBe('/api/voice-settings');
    expect(bodyOf(calls[0]).quoteOnly).toBe(false);
    expect(bodyOf(calls[0]).mode).toBe(2);
    expect(saved.quoteOnly).toBe(false);
  });

  it('PUT /api/voice-settings：省略 quoteOnly 时请求体写 true，兜底对象也带 true', async () => {
    // 后端回了个形状坏掉的本体：走 saveVoiceSetting 的兜底对象那条路
    const calls = stubFetch({});

    const saved = await saveVoiceSetting({ scope: 'global', mode: 1 });

    expect(bodyOf(calls[0]).quoteOnly).toBe(true);
    expect(saved.quoteOnly).toBe(true);
  });
});
