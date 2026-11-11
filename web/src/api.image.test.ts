import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  clearImageSetting,
  describeImageSettingsError,
  fetchImageSettings,
  saveImageSetting,
} from './api';

// 门牌 image-settings-1：生图三层配置的契约（GET / PUT / DELETE）与错误文案。

const UPDATED_AT = '2026-11-11T00:00:00.000Z';

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

function imageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'channel',
    scopeId: 'chan-1',
    model: 'gemini-3.1-flash-image',
    baseUrl: 'https://img.example/v1',
    keyHint: '…AbC1',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchImageSettings（GET /api/image-settings）', () => {
  it('解析 items / defaultModel / limits，global 的 scopeId 归一成空串', async () => {
    const calls = stubFetch({
      items: [
        imageRow(),
        imageRow({ scope: 'global', scopeId: '  ', model: '', baseUrl: '', keyHint: '' }),
        { scope: 'nope', scopeId: 'x' },
      ],
      defaultModel: 'gemini-nano-banana-2.1',
      limits: { model: 200, baseUrl: 500 },
    });

    const snapshot = await fetchImageSettings();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/image-settings');
    expect(calls[0]?.init.method).toBe('GET');
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]).toEqual({
      scope: 'channel',
      scopeId: 'chan-1',
      model: 'gemini-3.1-flash-image',
      baseUrl: 'https://img.example/v1',
      keyHint: '…AbC1',
      updatedAt: UPDATED_AT,
    });
    expect(snapshot.items[1]).toEqual({
      scope: 'global',
      scopeId: '',
      model: '',
      baseUrl: '',
      keyHint: '',
      updatedAt: UPDATED_AT,
    });
    expect(snapshot.defaultModel).toBe('gemini-nano-banana-2.1');
    expect(snapshot.limits).toEqual({ model: 200, baseUrl: 500 });
  });

  it('形状坏掉时按空列表 / 空默认模型 / 0 上限兜底，页面不读 undefined', async () => {
    stubFetch({ items: 'nope', limits: { model: 'x' } });

    const snapshot = await fetchImageSettings();

    expect(snapshot).toEqual({ items: [], defaultModel: '', limits: { model: 0, baseUrl: 0 } });
  });
});

describe('saveImageSetting（PUT /api/image-settings）', () => {
  it('只写选中这一层；apiKey 省略时整个字段不送（保留原密文）', async () => {
    const calls = stubFetch(imageRow());

    const saved = await saveImageSetting({
      scope: 'channel',
      scopeId: 'chan-1',
      model: 'gemini-3.1-flash-image',
      baseUrl: 'https://img.example/v1',
    });

    expect(calls[0]?.path).toBe('/api/image-settings');
    expect(calls[0]?.init.method).toBe('PUT');
    const body = bodyOf(calls[0]);
    expect(body).toEqual({
      scope: 'channel',
      scopeId: 'chan-1',
      model: 'gemini-3.1-flash-image',
      baseUrl: 'https://img.example/v1',
    });
    expect('apiKey' in body).toBe(false);
    expect(saved.keyHint).toBe('…AbC1');
  });

  it('global 只送 scope，不带 scopeId', async () => {
    const calls = stubFetch(imageRow({ scope: 'global', scopeId: '' }));

    await saveImageSetting({ scope: 'global', model: '', baseUrl: '' });

    expect(bodyOf(calls[0])).toEqual({ scope: 'global', model: '', baseUrl: '' });
  });

  it('apiKey 显式空串照送，用来清除本层 Key', async () => {
    const calls = stubFetch(imageRow({ scope: 'guild', scopeId: 'g-1', keyHint: '' }));

    const saved = await saveImageSetting({ scope: 'guild', scopeId: 'g-1', model: '', baseUrl: '', apiKey: '' });

    expect(bodyOf(calls[0])).toEqual({ scope: 'guild', scopeId: 'g-1', model: '', baseUrl: '', apiKey: '' });
    expect(saved.keyHint).toBe('');
  });
});

describe('clearImageSetting（DELETE /api/image-settings）', () => {
  it('发 scope / scopeId，{ ok: true } 视作成功', async () => {
    const calls = stubFetch({ ok: true });

    await expect(clearImageSetting({ scope: 'guild', scopeId: 'g-1' })).resolves.toBeUndefined();

    expect(calls[0]?.path).toBe('/api/image-settings');
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(bodyOf(calls[0])).toEqual({ scope: 'guild', scopeId: 'g-1' });
  });
});

describe('describeImageSettingsError', () => {
  it('BAD_IMAGE_SETTINGS 直接显示后端 detail', async () => {
    stubFetch({ error: 'BAD_IMAGE_SETTINGS', detail: 'baseUrl 不能超过 500 字' }, 400);

    const failure = await saveImageSetting({ scope: 'global', model: '', baseUrl: 'x' }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(describeImageSettingsError(failure)).toBe('baseUrl 不能超过 500 字');
  });

  it('detail 缺失时给中文兜底，不把错误码甩给用户', async () => {
    stubFetch({ error: 'BAD_IMAGE_SETTINGS' }, 400);

    const failure = await saveImageSetting({ scope: 'global', model: '', baseUrl: '' }).catch(
      (error: unknown) => error,
    );

    expect(describeImageSettingsError(failure)).toBe('生图配置不合法：请检查模型名与地址');
  });

  it('501 IMAGE_SETTINGS_UNAVAILABLE 翻成中文', async () => {
    stubFetch({ error: 'IMAGE_SETTINGS_UNAVAILABLE' }, 501);

    const failure = await fetchImageSettings().catch((error: unknown) => error);

    expect(describeImageSettingsError(failure)).toBe('生图配置存储未启用（缺 D1 绑定），这一页暂时存不了');
  });
});
