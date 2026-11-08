import type { ChatTool, ChatToolCall } from '../types';
import { resolveBaseUrl } from '../providers/rt';

/**
 * 生图工具：只有预设里真写了 `draw_image` 才下发（与 story_reply 同一套门控）。
 * 频道预设说「想画的时候调这个工具」，模型才会把画面描述放进 prompt；
 * 没写的频道请求体里连这条工具都没有，形状与加这一层之前逐字相同。
 */
export const DRAW_TOOL_NAME = 'draw_image';

/**
 * 生图模型名：与聊天模型无关，只发给 /images/generations。
 * 我们的中继默认就是它；换成别家 OpenAI 兼容服务时改这里（或在那一侧做模型别名）。
 */
export const IMAGE_MODEL_NAME = 'gemini-3.1-flash-image';

/** prompt 上限与中继侧一致；超了截断，不因此判整轮失败 */
export const IMAGE_PROMPT_MAX_CHARS = 8000;

/** 台词上限：一两句话够用；超了截断，不因此判整轮失败 */
export const DRAW_LINE_MAX_CHARS = 600;

/** 生图比聊天慢（实测 10–30 秒），给足预算；超时按这一把 Key 失败处理 */
const IMAGE_TIMEOUT_MS = 180_000;

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export function drawTool(): ChatTool {
  return {
    type: 'function',
    function: {
      name: DRAW_TOOL_NAME,
      description:
        '画一张图并发到频道，同时说一两句话。用户让你画、要一张图、说「画个…」时调用；prompt 写清楚画面内容、风格与构图，say 写画完之后要对用户说的话（一两句，符合人设，不要描述画图过程），图会先发出去、say 接着作为这一轮的正文。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要画什么：主体、动作、场景、风格；越具体越好' },
          say: {
            type: 'string',
            description: '画完之后要对用户说的一两句话，符合人设；这句会作为这一轮的正文发出去',
          },
        },
        required: ['prompt', 'say'],
      },
    },
  };
}

export function drawToolsFor(preset: string): ChatTool[] {
  return preset.indexOf(DRAW_TOOL_NAME) === -1 ? [] : [drawTool()];
}

/** 从拼回的调用里取某个字符串参数；没调、参数坏、该字段为空都返回 null */
function stringArgOf(calls: readonly ChatToolCall[], key: string, maxChars: number): string | null {
  const call = calls.find((item) => item.name === DRAW_TOOL_NAME);
  if (call === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[key];
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text.slice(0, maxChars);
}

/** draw_image 的 prompt；没调、参数坏、prompt 为空都返回 null */
export function drawPromptOf(calls: readonly ChatToolCall[]): string | null {
  return stringArgOf(calls, 'prompt', IMAGE_PROMPT_MAX_CHARS);
}

/** draw_image 的 say：画完要说的那一两句；缺省时这一轮就只有图、没有正文 */
export function drawLineOf(calls: readonly ChatToolCall[]): string | null {
  return stringArgOf(calls, 'say', DRAW_LINE_MAX_CHARS);
}

export interface GeneratedImage {
  data: Uint8Array;
  mime: string;
  prompt: string;
}

/** base64 -> 字节：atob 而不是 Buffer —— core 也要能跑在 workerd 上 */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function dataUrlOf(value: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  return match === null ? null : { mime: match[1], base64: match[2] };
}

/**
 * 调 OpenAI 形状的图片端点：POST {baseUrl}/images/generations。
 * 中继回 { data: [{ b64_json }] }；有的服务回 data: URL，两种都认。
 */
export async function requestImage(options: {
  baseUrl: string | undefined;
  apiKey: string;
  prompt: string;
  fetch: typeof fetch;
  model?: string;
}): Promise<GeneratedImage> {
  const url = resolveBaseUrl(options.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, '') + '/images/generations';
  const response = await options.fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + options.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: options.model ?? IMAGE_MODEL_NAME,
      prompt: options.prompt,
      n: 1,
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  // 先读 text 再 parse：失败时才有原文可报（response.json() 的报错不带正文）
  const text = await response.text();
  if (!response.ok) throw new Error('IMAGE_HTTP ' + String(response.status) + ': ' + text.slice(0, 200));
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('IMAGE_BAD_JSON: ' + text.slice(0, 200));
  }
  const data = (payload as { data?: unknown }).data;
  const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  const b64 = first !== null && typeof first === 'object' && typeof first.b64_json === 'string' ? first.b64_json : '';
  if (b64 !== '') return { data: decodeBase64(b64), mime: 'image/jpeg', prompt: options.prompt };
  const urlValue = first !== null && typeof first === 'object' && typeof first.url === 'string' ? first.url : '';
  const inline = dataUrlOf(urlValue);
  if (inline !== null) return { data: decodeBase64(inline.base64), mime: inline.mime, prompt: options.prompt };
  throw new Error('IMAGE_MISSING: ' + text.slice(0, 200));
}
