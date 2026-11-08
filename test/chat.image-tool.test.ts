import { describe, expect, it, vi } from 'vitest';
import {
  DRAW_TOOL_NAME,
  IMAGE_PROMPT_MAX_CHARS,
  drawPromptOf,
  drawToolsFor,
  requestImage,
} from '../src/core/chat/image-tool';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('draw_image 工具定义', () => {
  it('预设里写了 draw_image 才下发，参数只要求 prompt', () => {
    const tools = drawToolsFor('想画的时候调用 draw_image。');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.function.name).toBe(DRAW_TOOL_NAME);
    expect(tools[0]?.function.parameters?.required).toEqual(['prompt']);
  });

  it('预设没写就不下发：没有这条工具时请求体里连它都没有', () => {
    expect(drawToolsFor('只调 story_reply。')).toEqual([]);
  });

  it('从拼回的调用里取 prompt：去空白、坏 JSON 与空串都当没调', () => {
    expect(drawPromptOf([{ name: 'draw_image', arguments: JSON.stringify({ prompt: ' 一只橘猫 ' }) }])).toBe('一只橘猫');
    expect(drawPromptOf([{ name: 'draw_image', arguments: 'not json' }])).toBeNull();
    expect(drawPromptOf([{ name: 'draw_image', arguments: '{"prompt":"   "}' }])).toBeNull();
    expect(drawPromptOf([{ name: 'story_reply', arguments: '{"game_content":"正文"}' }])).toBeNull();
  });

  it('prompt 超长截断到上限', () => {
    const prompt = drawPromptOf([{ name: 'draw_image', arguments: JSON.stringify({ prompt: 'x'.repeat(9000) }) }]);
    expect(prompt).toHaveLength(IMAGE_PROMPT_MAX_CHARS);
  });
});

describe('requestImage', () => {
  it('默认模型与 b64_json，baseUrl 尾斜杠不会拼出双斜杠', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ data: [{ b64_json: Buffer.from('hello').toString('base64') }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const image = await requestImage({
        baseUrl: 'https://relay.test/pg/v1/',
        apiKey: 'sk-test',
        prompt: '一只橘猫',
        fetch: fetchMock as unknown as typeof fetch,
      });
      expect(calls[0]?.url).toBe('https://relay.test/pg/v1/images/generations');
      const body = JSON.parse(String(calls[0]?.init?.body));
      expect(body).toMatchObject({ model: 'gemini-3.1-flash-image', prompt: '一只橘猫', n: 1, response_format: 'b64_json' });
      expect(image.mime).toBe('image/jpeg');
      expect(Buffer.from(image.data).toString()).toBe('hello');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('服务回 data: URL 也认，并按它自己的 mime 标注', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ url: 'data:image/png;base64,' + Buffer.from('png').toString('base64') }] }),
    );
    const image = await requestImage({
      baseUrl: undefined,
      apiKey: 'sk-test',
      prompt: '一只橘猫',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(image.mime).toBe('image/png');
    expect(Buffer.from(image.data).toString()).toBe('png');
  });

  it('HTTP 失败、非 JSON、没有图：三种都有可读错误码', async () => {
    const http = vi.fn(async () => new Response('upstream exploded', { status: 500 }));
    await expect(
      requestImage({ baseUrl: 'https://relay.test', apiKey: 'k', prompt: 'p', fetch: http as unknown as typeof fetch }),
    ).rejects.toThrow('IMAGE_HTTP 500');

    const bad = vi.fn(async () => new Response('<html>not json</html>', { status: 200 }));
    await expect(
      requestImage({ baseUrl: 'https://relay.test', apiKey: 'k', prompt: 'p', fetch: bad as unknown as typeof fetch }),
    ).rejects.toThrow('IMAGE_BAD_JSON');

    const empty = vi.fn(async () => jsonResponse({ data: [] }));
    await expect(
      requestImage({ baseUrl: 'https://relay.test', apiKey: 'k', prompt: 'p', fetch: empty as unknown as typeof fetch }),
    ).rejects.toThrow('IMAGE_MISSING');
  });
});
