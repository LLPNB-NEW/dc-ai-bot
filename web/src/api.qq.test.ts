import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type PromptConfig } from './api';

// QQ 桥接的 web 侧只做解析与回传：request() 只认 globalThis.fetch，替换它就能验形状与路径。

const ISO = '2026-11-16T00:00:00.000Z';

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

const RECORD = {
  id: 'conv-1',
  name: '主群',
  presetId: 'preset-1',
  memoryGuildId: 'qq:group',
  memoryChannelId: 'OPENID-A',
  links: [
    {
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'OPENID-A',
      displayName: '测试群',
      lastSeenAt: ISO,
    },
  ],
  createdAt: ISO,
  updatedAt: ISO,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web 侧会话目录 API（migration 0038）', () => {
  it('GET /api/conversations：丢掉没有记忆键的会话，坏链接单独丢弃', async () => {
    const calls = stubFetch({
      items: [
        RECORD,
        { id: 'broken', name: '缺记忆键' },
        {
          ...RECORD,
          id: 'conv-2',
          presetId: '',
          links: [{ platform: 'qq' }, { platform: 'qq', kind: 'qq_c2c', externalId: 'OPENID-B' }],
        },
      ],
    });

    const items = await api.listConversations();
    expect(calls[0]?.path).toBe('/api/conversations');
    expect(calls[0]?.init.method).toBe('GET');
    expect(items.map((item) => item.id)).toEqual(['conv-1', 'conv-2']);
    expect(items[0]?.links[0]?.displayName).toBe('测试群');
    // presetId 空串 = 没选预设
    expect(items[1]?.presetId).toBeNull();
    // 平台认不出的链接丢掉，认得出的留下
    expect(items[1]?.links.map((link) => link.kind)).toEqual(['qq_c2c']);
  });

  it('POST /api/conversations：按冻结契约发 platform/kind/externalId/guildId/name 并解析整条会话', async () => {
    const calls = stubFetch(RECORD);
    const record = await api.createConversation({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: '9876543210987654321',
      guildId: '1234567890123456789',
      name: '新建频道',
    });
    expect(calls[0]?.path).toBe('/api/conversations');
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: '9876543210987654321',
      guildId: '1234567890123456789',
      name: '新建频道',
    });
    expect(record.id).toBe('conv-1');
    expect(record.memoryGuildId).toBe('qq:group');
  });

  it('PATCH /api/conversations/:id：路径转义 id，presetId 传 null 清空选择', async () => {
    const calls = stubFetch({ ...RECORD, presetId: null, name: '改名后' });
    const record = await api.updateConversation('conv/1', { name: '改名后', presetId: null });
    expect(calls[0]?.path).toBe('/api/conversations/conv%2F1');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(bodyOf(calls[0])).toEqual({ name: '改名后', presetId: null });
    expect(record.presetId).toBeNull();
  });
});

describe('web 侧会话链接 API', () => {
  it('POST /api/conversations/:id/links：带 merge 与 Discord 的 guildId', async () => {
    const calls = stubFetch({
      ...RECORD,
      links: [
        ...RECORD.links,
        { platform: 'discord', kind: 'discord_channel', externalId: '222', displayName: '', lastSeenAt: ISO },
      ],
    });
    const record = await api.bindConversation('conv-1', {
      platform: 'discord',
      kind: 'discord_channel',
      externalId: '222',
      guildId: '111',
      merge: true,
    });
    expect(calls[0]?.path).toBe('/api/conversations/conv-1/links');
    expect(bodyOf(calls[0])).toEqual({
      platform: 'discord',
      kind: 'discord_channel',
      externalId: '222',
      guildId: '111',
      merge: true,
    });
    expect(record.links).toHaveLength(2);
  });

  it('POST /api/conversations/:id/unlink：只发定位链接的三个键', async () => {
    const calls = stubFetch({ ok: true });
    const result = await api.unlinkConversation('conv-1', {
      platform: 'qq',
      kind: 'qq_group',
      externalId: 'OPENID-A',
    });
    expect(calls[0]?.path).toBe('/api/conversations/conv-1/unlink');
    expect(bodyOf(calls[0])).toEqual({ platform: 'qq', kind: 'qq_group', externalId: 'OPENID-A' });
    expect(result.ok).toBe(true);
  });

  it('DELETE /api/conversations/:id：删掉目录记录', async () => {
    const calls = stubFetch({ ok: true });
    await api.deleteConversation('conv-1');
    expect(calls[0]?.path).toBe('/api/conversations/conv-1');
    expect(calls[0]?.init.method).toBe('DELETE');
  });
});

describe('web 侧会话记忆 API', () => {
  it('GET /api/conversations/:id/memory：认 { config } 包装并按默认值兜底', async () => {
    const calls = stubFetch({
      config: {
        guildId: 'qq:group',
        channelId: 'OPENID-A',
        historyMaxMessages: 80,
        summaryEveryMessages: 0,
        contextTool: true,
        updatedAt: ISO,
      },
    });
    const config = await api.fetchConversationMemory('conv-1');
    expect(calls[0]?.path).toBe('/api/conversations/conv-1/memory');
    expect(config.historyMaxMessages).toBe(80);
    expect(config.summaryEveryMessages).toBe(0);
    expect(config.contextTool).toBe(true);
  });

  it('PUT /api/conversations/:id/memory：只提交窗口、阈值与 contextTool', async () => {
    const calls = stubFetch({
      config: {
        guildId: 'qq:group',
        channelId: 'OPENID-A',
        historyMaxMessages: 60,
        summaryEveryMessages: 20,
        contextTool: true,
        updatedAt: ISO,
      },
    });
    const saved = await api.saveConversationMemory('conv-1', {
      historyMaxMessages: 60,
      summaryEveryMessages: 20,
      contextTool: true,
    });
    expect(calls[0]?.path).toBe('/api/conversations/conv-1/memory');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(bodyOf(calls[0])).toEqual({
      historyMaxMessages: 60,
      summaryEveryMessages: 20,
      contextTool: true,
    });
    expect(saved.historyMaxMessages).toBe(60);
  });

  it('DELETE /api/conversations/:id/memory：恢复默认', async () => {
    const calls = stubFetch({ ok: true });
    await api.deleteConversationMemory('conv-1');
    expect(calls[0]?.path).toBe('/api/conversations/conv-1/memory');
    expect(calls[0]?.init.method).toBe('DELETE');
  });
});

describe('web 侧 QQ 预设 API', () => {
  const PRESET_CONFIG: PromptConfig = {
    segments: [
      {
        id: 'seg-1',
        name: '主体',
        role: 'system',
        content: '你是群友。',
        enabled: true,
        placement: 'before',
        position: 0,
      },
    ],
    temperature: 0.8,
  };
  const PRESET = {
    id: 'preset-1',
    name: '群聊人格',
    config: PRESET_CONFIG,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it('GET /api/qq/presets：缺 id 的预设丢掉，坏 config 兜底成空段', async () => {
    const calls = stubFetch({
      items: [PRESET, { name: '没有 id' }, { id: 'preset-2', name: '坏配置', config: {}, createdAt: '', updatedAt: '' }],
    });
    const items = await api.listQqPresets();
    expect(calls[0]?.path).toBe('/api/qq/presets');
    expect(items.map((item) => item.id)).toEqual(['preset-1', 'preset-2']);
    expect(items[0]?.config.segments[0]?.content).toBe('你是群友。');
    expect(items[0]?.config.temperature).toBe(0.8);
    expect(items[1]?.config.segments).toEqual([]);
  });

  it('POST /api/qq/presets：name + PromptConfig 原样提交', async () => {
    const calls = stubFetch(PRESET);
    const saved = await api.createQqPreset({ name: '群聊人格', config: PRESET.config });
    expect(calls[0]?.path).toBe('/api/qq/presets');
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({ name: '群聊人格', config: PRESET.config });
    expect(saved.id).toBe('preset-1');
  });

  it('PUT /api/qq/presets/:id 与 DELETE /api/qq/presets/:id 走同一条路径', async () => {
    const putCalls = stubFetch(PRESET);
    const saved = await api.updateQqPreset('preset/1', { name: '改名', config: PRESET.config });
    expect(putCalls[0]?.path).toBe('/api/qq/presets/preset%2F1');
    expect(putCalls[0]?.init.method).toBe('PUT');
    expect(bodyOf(putCalls[0])).toEqual({ name: '改名', config: PRESET.config });
    expect(saved.name).toBe('群聊人格');

    vi.unstubAllGlobals();
    const deleteCalls = stubFetch({ ok: true });
    await api.deleteQqPreset('preset-1');
    expect(deleteCalls[0]?.path).toBe('/api/qq/presets/preset-1');
    expect(deleteCalls[0]?.init.method).toBe('DELETE');
  });

  it('POST /api/qq/presets/import：发送 { name, preset }，并从 { preset, warnings } 里取预设', async () => {
    const calls = stubFetch({ preset: PRESET, warnings: ['worldbook 已忽略'] });
    const preset = { name: '酒馆预设', prompts: [] };
    const saved = await api.importQqPreset({ name: '导入名', preset });
    expect(calls[0]?.path).toBe('/api/qq/presets/import');
    expect(bodyOf(calls[0])).toEqual({ name: '导入名', preset });
    expect(saved.id).toBe('preset-1');
  });
});
