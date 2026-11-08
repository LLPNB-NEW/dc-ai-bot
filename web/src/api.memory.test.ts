import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchChannelMemory, fetchMemorySettings, saveChannelMemory } from './api';

// §55：web 侧只做解析与回传，不碰真实网络：request() 只认 globalThis.fetch，替换它就能验形状。

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '333333333333333333';

const ISO = '2026-11-06T00:00:00.000Z';

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

describe('web 侧记忆配置的 contextTool 解析（§55）', () => {
  it('GET /api/memory-settings：true 原样读出，false / 缺字段 / 非 boolean 一律解析成 false', async () => {
    stubFetch({
      items: [
        {
          guildId: GUILD,
          channelId: CHANNEL,
          historyMaxMessages: 50,
          summaryEveryMessages: 50,
          summaryMaxChars: 4000,
          contextTool: true,
          updatedAt: ISO,
        },
        {
          guildId: GUILD,
          channelId: OTHER_CHANNEL,
          historyMaxMessages: 10,
          summaryEveryMessages: 0,
          contextTool: false,
          updatedAt: ISO,
        },
        // 老后端：整条没有这个字段
        { guildId: GUILD, channelId: '444444444444444444', historyMaxMessages: 2, summaryEveryMessages: 2, updatedAt: '' },
        // 形状不对（后端只该回 boolean）：不能渲染成 undefined
        { guildId: GUILD, channelId: '555555555555555555', contextTool: 1, updatedAt: '' },
      ],
    });

    const items = await fetchMemorySettings();
    expect(items.map((item) => item.contextTool)).toEqual([true, false, false, false]);
  });

  it('GET /api/memory-settings/channel：有行读回 true，行缺失 / 形状坏掉都回落到 false', async () => {
    stubFetch({
      config: {
        guildId: GUILD,
        channelId: CHANNEL,
        historyMaxMessages: 50,
        summaryEveryMessages: 50,
        summaryMaxChars: 4000,
        contextTool: true,
        updatedAt: ISO,
      },
    });
    expect((await fetchChannelMemory(GUILD, CHANNEL)).contextTool).toBe(true);

    vi.unstubAllGlobals();
    stubFetch({ config: { guildId: GUILD, channelId: OTHER_CHANNEL, updatedAt: '' } });
    expect((await fetchChannelMemory(GUILD, OTHER_CHANNEL)).contextTool).toBe(false);

    vi.unstubAllGlobals();
    stubFetch({});
    // 后端形状坏掉时前端按入参 + 默认值拼一条，开关跟着默认关
    expect((await fetchChannelMemory(GUILD, CHANNEL)).contextTool).toBe(false);
  });

  it('PUT /api/memory-settings：请求体带上 contextTool，缺省提交 false', async () => {
    const on = stubFetch({
      guildId: GUILD,
      channelId: CHANNEL,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
      summaryMaxChars: 0,
      updatedAt: ISO,
    });
    const saved = await saveChannelMemory({
      guildId: GUILD,
      channelId: CHANNEL,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
      contextTool: true,
    });
    expect(bodyOf(on[0]).contextTool).toBe(true);
    expect(on[0]?.path).toBe('/api/memory-settings');
    // 后端回的整行没有这个字段：按「未设置」解析成关；真实后端会回填，见下一段
    expect(saved.contextTool).toBe(false);

    vi.unstubAllGlobals();
    const echoed = stubFetch({
      guildId: GUILD,
      channelId: CHANNEL,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
      summaryMaxChars: 0,
      contextTool: true,
      updatedAt: ISO,
    });
    const roundTrip = await saveChannelMemory({
      guildId: GUILD,
      channelId: CHANNEL,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
      contextTool: true,
    });
    expect(bodyOf(echoed[0]).contextTool).toBe(true);
    expect(roundTrip.contextTool).toBe(true);

    vi.unstubAllGlobals();
    const off = stubFetch({
      guildId: GUILD,
      channelId: CHANNEL,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
      summaryMaxChars: 0,
      contextTool: false,
      updatedAt: ISO,
    });
    const plain = await saveChannelMemory({
      guildId: GUILD,
      channelId: CHANNEL,
      historyMaxMessages: 50,
      summaryEveryMessages: 50,
    });
    expect(bodyOf(off[0]).contextTool).toBe(false);
    expect(plain.contextTool).toBe(false);
  });
});
