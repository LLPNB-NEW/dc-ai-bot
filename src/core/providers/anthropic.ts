import type { ChatMessage, LlmProvider, LlmRequest, ProviderRuntime } from '../types';
import {
  isEventStream,
  parseJson,
  readArray,
  readNumber,
  readRecord,
  readString,
  resolveBaseUrl,
  sendRequest,
  toUsage,
} from './rt';
import { parseSse, upstreamErrorOf } from './sse';

const PROVIDER = 'anthropic' as const;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** §7.2：/v1/models 失败时兜底，后台「测试连通性」不至于完全不可用 */
export const ANTHROPIC_FALLBACK_MODELS: readonly string[] = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
];

function headers(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

/** 历史里本来没有 system 角色（system 是顶层字段），只有深度注入会造出这种消息；Anthropic 不接受 messages[].role='system'，所以按 user 发 */
function wireMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role === 'system' ? 'user' : message.role, content: message.content };
}

/** §22.3：图片只挂在最后一条 role==='user' 的消息上；没有 user 消息返回 -1 */
function lastUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface WireMessage {
  role: string;
  content: string | ContentBlock[];
}

/** 无图时返回旧版 {role, content: string}（形状逐字不变）；有图时只有目标那条变成 blocks 数组 */
function messagesOf(req: LlmRequest): WireMessage[] {
  const wire: WireMessage[] = req.messages.map(wireMessage);
  const images = req.images ?? [];
  const index = lastUserIndex(req.messages);
  if (images.length === 0 || index < 0) return wire;
  wire[index] = {
    role: wire[index].role,
    content: [
      { type: 'text', text: req.messages[index].content },
      ...images.map((image): ContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      })),
    ],
  };
  return wire;
}

function bodyOf(req: LlmRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    system: req.system,
    messages: messagesOf(req),
    max_tokens: req.maxTokens ?? 1024,
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    // Anthropic 只有 top_p：top_k / seed / 两个 penalty 即使填了也不发
    ...(req.topP === undefined ? {} : { top_p: req.topP }),
    stream,
  };
}

function endpoint(rt: ProviderRuntime, path: string): string {
  return resolveBaseUrl(rt.baseUrl, DEFAULT_BASE_URL) + path;
}

function textOf(node: unknown): string | undefined {
  return readString(readArray(node, 'content')[0], 'text');
}

/** Anthropic 的结束原因在 stream 事件里：message_delta.delta.stop_reason（end_turn / max_tokens …） */
function stopReasonOf(node: unknown): string | undefined {
  return readString(readRecord(node, 'delta'), 'stop_reason');
}

export function createAnthropicProvider(): LlmProvider {
  return {
    id: PROVIDER,

    async chat(req, rt) {
      const res = await sendRequest(PROVIDER, rt, endpoint(rt, '/v1/messages'), {
        method: 'POST',
        headers: headers(rt.apiKey),
        body: JSON.stringify(bodyOf(req, false)),
      });
      const node = parseJson(await res.text());
      // 200 里也是错误：不认出来 textOf 拿不到就返回空串，上层会把空回复当成成功
      const upstream = upstreamErrorOf(node);
      if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
      const usage = readRecord(node, 'usage');
      return {
        text: textOf(node) ?? '',
        usage: toUsage(readNumber(usage, 'input_tokens'), readNumber(usage, 'output_tokens')),
      };
    },

    async *chatStream(req, rt) {
      const res = await sendRequest(PROVIDER, rt, endpoint(rt, '/v1/messages'), {
        method: 'POST',
        headers: headers(rt.apiKey),
        body: JSON.stringify(bodyOf(req, true)),
      });

      // 兼容网关可能忽略 stream:true 直接回整段 JSON，退化成一次性 yield
      if (!isEventStream(res)) {
        const raw = await res.text();
        const node = parseJson(raw);
        // 退化路径拿不到正文时会把整段 raw 当成正文 yield 出去，错误体的 JSON 会原样发给用户
        const upstream = upstreamErrorOf(node);
        if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
        const delta = textOf(node) ?? raw;
        // 整段 JSON 一次性回完 = 上游自己收尾了：不报 end_turn，上层只能按「没收到结束原因」当截断续写
        yield { delta, finishReason: 'stop' };
        return;
      }
      if (!res.body) throw new Error(PROVIDER + ': empty response body');

      // 结束原因是否已经报过：message_delta 给过 stop_reason 之后，message_stop 不再重复报
      let finished = false;
      for await (const payload of parseSse(res.body)) {
        const node = parseJson(payload);
        // 单条脏数据不该炸掉整条流
        if (node === null) continue;
        // Anthropic 的错误帧是 {"type":"error","error":{"type":"overloaded_error"}}：
        // 它不匹配下面的 content_block_delta，不先拦就会被直接 continue 掉
        const upstream = upstreamErrorOf(node);
        if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
        const type = readString(node, 'type');
        // message_stop 就是「这条流正常结束」：上游没给 stop_reason 时也要报一次收尾，
        // 否则每一轮都会被上层当成「没收到结束原因」而白续写两次
        if (type === 'message_stop') {
          if (!finished) yield { delta: '', finishReason: 'end_turn' };
          return;
        }
        if (type === 'message_delta') {
          const stopReason = stopReasonOf(node);
          if (stopReason !== undefined) {
            finished = true;
            yield { delta: '', finishReason: stopReason };
          }
          continue;
        }
        if (type !== 'content_block_delta') continue;
        const delta = readString(readRecord(node, 'delta'), 'text');
        if (delta) yield { delta };
      }
    },

    async listModels(rt) {
      try {
        const res = await sendRequest(PROVIDER, rt, endpoint(rt, '/v1/models'), {
          method: 'GET',
          headers: headers(rt.apiKey),
        });
        const node = parseJson(await res.text());
        return readArray(node, 'data')
          .map((item) => readString(item, 'id'))
          .filter((id): id is string => typeof id === 'string');
      } catch {
        return [...ANTHROPIC_FALLBACK_MODELS];
      }
    },
  };
}
