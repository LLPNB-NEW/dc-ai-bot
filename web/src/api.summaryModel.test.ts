import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSummaryModel,
  describeSummaryModelError,
  fetchSummaryModel,
  saveSummaryModel,
} from './api';

const ISO = '2026-11-16T00:00:00.000Z';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web 侧摘要模型 API', () => {
  it('GET /api/summary-settings：认出已知供应商，丢弃坏配置，限额缺省 200', async () => {
    const calls = stubFetch({
      config: { provider: 'gemini', model: ' gemini-4-argon ', updatedAt: ISO },
      providers: ['gemini', 'nope', 'anthropic', 'gemini'],
      limits: { model: 120 },
    });

    const snapshot = await fetchSummaryModel();

    expect(calls[0]?.path).toBe('/api/summary-settings');
    expect(calls[0]?.init.method).toBe('GET');
    expect(snapshot.config).toEqual({ provider: 'gemini', model: 'gemini-4-argon', updatedAt: ISO });
    expect(snapshot.providers).toEqual(['gemini', 'anthropic']);
    expect(snapshot.limits.model).toBe(120);
  });

  it('GET 坏形状兜底：config=null，providers 空时用内建枚举', async () => {
    stubFetch({ config: { provider: 'nope', model: 'm' }, providers: [], limits: {} });
    const snapshot = await fetchSummaryModel();
    expect(snapshot.config).toBeNull();
    expect(snapshot.providers).toEqual(['openai-compat', 'anthropic', 'gemini']);
    expect(snapshot.limits.model).toBe(200);
  });

  it('PUT 去掉模型名两侧空白；DELETE 就是清空', async () => {
    const calls = stubFetch({ provider: 'gemini', model: 'gemini-4-argon', updatedAt: ISO });
    const saved = await saveSummaryModel({ provider: 'gemini', model: '  gemini-4-argon  ' });
    expect(calls[0]?.path).toBe('/api/summary-settings');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(bodyOf(calls[0])).toEqual({ provider: 'gemini', model: 'gemini-4-argon' });
    expect(saved.model).toBe('gemini-4-argon');

    const deleted = await clearSummaryModel();
    expect(deleted).toBeUndefined();
    expect(calls[1]?.path).toBe('/api/summary-settings');
    expect(calls[1]?.init.method).toBe('DELETE');
  });

  it('错误码翻中文：501 说未启用，400 说校验口径', async () => {
    stubFetch({ error: 'SUMMARY_SETTINGS_UNAVAILABLE' }, 501);
    let unavailable = '';
    try {
      await fetchSummaryModel();
    } catch (error) {
      unavailable = describeSummaryModelError(error);
    }
    expect(unavailable).toContain('未启用');

    stubFetch({ error: 'BAD_SUMMARY_MODEL' }, 400);
    let rejected = '';
    try {
      await saveSummaryModel({ provider: 'gemini', model: 'm' });
    } catch (error) {
      rejected = describeSummaryModelError(error);
    }
    expect(rejected).toContain('1–200 字');
  });
});
