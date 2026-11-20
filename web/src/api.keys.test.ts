import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

// §81：web 侧启停只发 { enabled }，回执按列表同一形状解析（models 缺省补 []）。

const KEY_ID = 'key-1';

interface CapturedCall {
  path: string;
  init: RequestInit;
}

function stubFetch(payload: unknown, status = 200): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

function bodyOf(call: CapturedCall | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error('没有捕获到请求');
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function keyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: KEY_ID,
    provider: 'openai-compat',
    label: '主力',
    keyHint: '…abcd',
    enabled: false,
    createdAt: '2026-11-11T00:00:00.000Z',
    models: ['deepseek-*'],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web 侧 Key 启停（PATCH /api/keys/:id）', () => {
  it('PATCH 路径 / 方法 / content-type / body 只有 { enabled }，回执带 models', async () => {
    const calls = stubFetch(keyPayload());

    const updated = await api.setKeyEnabled(KEY_ID, false);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/keys/key-1');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
    expect(bodyOf(calls[0])).toEqual({ enabled: false });
    expect(updated.enabled).toBe(false);
    expect(updated.id).toBe(KEY_ID);
    expect(updated.models).toEqual(['deepseek-*']);
  });

  it('回执漏了 models 按 §20.3 兜底成 []，界面不读 undefined', async () => {
    stubFetch({ id: KEY_ID, provider: 'anthropic', label: '通用', keyHint: '…1234', enabled: true, createdAt: '' });

    const updated = await api.setKeyEnabled(KEY_ID, true);

    expect(updated.enabled).toBe(true);
    expect(updated.models).toEqual([]);
  });

  it('非 2xx 抛 ApiError：status 与 error 码原样带出', async () => {
    stubFetch({ error: 'NOT_FOUND' }, 404);

    const failure = await api.setKeyEnabled(KEY_ID, false).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect((failure as ApiError).code).toBe('NOT_FOUND');
    expect((failure as ApiError).message).toBe('NOT_FOUND');
  });
});
