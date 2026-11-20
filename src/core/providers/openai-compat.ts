import type {
  ChatMessage,
  ChatToolCall,
  LlmProvider,
  LlmRequest,
  ProviderRuntime,
  ToolCallDelta,
} from '../types';
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

const PROVIDER = 'openai-compat' as const;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function headers(apiKey: string): Record<string, string> {
  return { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' };
}

function wireMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role, content: message.content };
}

/** §22.3：图片只挂在最后一条 role==='user' 的消息上；没有 user 消息返回 -1 */
function lastUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface WireMessage {
  role: string;
  content: string | ContentPart[];
}

/** 无图时返回旧版 {role, content: string}（形状逐字不变）；有图时只有目标那条变成 parts 数组 */
function messagesOf(req: LlmRequest): WireMessage[] {
  const wire: WireMessage[] = req.messages.map(wireMessage);
  const images = req.images ?? [];
  const index = lastUserIndex(req.messages);
  if (images.length === 0 || index < 0) return wire;
  wire[index] = {
    role: wire[index].role,
    content: [
      { type: 'text', text: req.messages[index].content },
      ...images.map((image): ContentPart => ({
        type: 'image_url',
        image_url: { url: 'data:' + image.mediaType + ';base64,' + image.base64 },
      })),
    ],
  };
  return wire;
}

function bodyOf(req: LlmRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    messages: [{ role: 'system', content: req.system }, ...messagesOf(req)],
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
    // 兼容协议没有 top_k：用户填了也不发，免得上游直接 400
    ...(req.topP === undefined ? {} : { top_p: req.topP }),
    // 推理强度照抄原样；缺省 / 空串时连键都不出现，旧请求体逐字不变
    ...(req.reasoningEffort === undefined || req.reasoningEffort === ''
      ? {}
      : { reasoning_effort: req.reasoningEffort }),
    ...(req.frequencyPenalty === undefined ? {} : { frequency_penalty: req.frequencyPenalty }),
    ...(req.presencePenalty === undefined ? {} : { presence_penalty: req.presencePenalty }),
    ...(req.seed === undefined ? {} : { seed: req.seed }),
    // 工具是兼容性保留：tools 为空时整组键都不出现，旧请求体逐字节不变
    ...(req.tools === undefined || req.tools.length === 0
      ? {}
      : {
          tools: req.tools,
          ...(req.toolChoice === undefined ? {} : { tool_choice: req.toolChoice }),
        }),
    // 结构化输出：缺省时连键都不出现，旧请求体逐字节不变；给了就原样透传，由中继翻成上游 schema
    ...(req.responseFormat === undefined ? {} : { response_format: req.responseFormat }),
    stream,
  };
}

function endpoint(rt: ProviderRuntime, path: string): string {
  return resolveBaseUrl(rt.baseUrl, DEFAULT_BASE_URL) + path;
}

function textOf(node: unknown): string | undefined {
  return readString(readRecord(readArray(node, 'choices')[0], 'message'), 'content');
}

function deltaOf(node: unknown): string | undefined {
  return readString(readRecord(readArray(node, 'choices')[0], 'delta'), 'content');
}

/** 结束原因（finish_reason）只在最后那一帧出现，且那一帧的 delta 通常是空的 */
function finishOf(node: unknown): string | undefined {
  return readString(readArray(node, 'choices')[0], 'finish_reason');
}

/**
 * §55 流式工具调用增量：`delta.tool_calls[i]` 的 index / function.name / function.arguments。
 * name 通常只在第一帧给，arguments 是半截 JSON；没有 index 或 name 与 arguments 都空的项
 * 一个字节的信息都没有，直接丢掉。没有分片时返回空数组（不进请求，也不影响正文那条路径）。
 */
function toolCallDeltasOf(node: unknown): ToolCallDelta[] {
  const delta = readRecord(readArray(node, 'choices')[0], 'delta');
  const items: ToolCallDelta[] = [];
  for (const item of readArray(delta, 'tool_calls')) {
    const index = readNumber(item, 'index');
    if (index === undefined) continue;
    const fn = readRecord(item, 'function');
    const name = readString(fn, 'name');
    const args = readString(fn, 'arguments') ?? '';
    if ((name === undefined || name === '') && args === '') continue;
    // name 只在拿到非空字符串时才带：空串会让累加器误以为这一帧要给调用改名
    items.push({ index, ...(name === undefined || name === '' ? {} : { name }), arguments: args });
  }
  return items;
}

/**
 * §55 非流式响应里的工具调用：`message.tool_calls[i].function` 的 name + 原始 arguments 字符串。
 * 没有（或者一个都不带名字）返回 undefined——返回对象里连这个键都不出现，旧形状逐字不变。
 */
function toolCallsOf(node: unknown): ChatToolCall[] | undefined {
  const calls: ChatToolCall[] = [];
  const message = readRecord(readArray(node, 'choices')[0], 'message');
  for (const item of readArray(message, 'tool_calls')) {
    const fn = readRecord(item, 'function');
    const name = readString(fn, 'name');
    if (name === undefined || name === '') continue;
    // arguments 缺失时留空串：名字有了就是一次调用，空参由上层（readToolReply）自己判定
    calls.push({ name, arguments: readString(fn, 'arguments') ?? '' });
  }
  return calls.length === 0 ? undefined : calls;
}

export function createOpenAiCompatProvider(): LlmProvider {
  return {
    id: PROVIDER,

    async chat(req, rt) {
      const res = await sendRequest(PROVIDER, rt, endpoint(rt, '/chat/completions'), {
        method: 'POST',
        headers: headers(rt.apiKey),
        body: JSON.stringify(bodyOf(req, false)),
      });
      const node = parseJson(await res.text());
      // 200 里也是错误：不认出来 textOf 拿不到就返回空串，上层会把空回复当成成功
      const upstream = upstreamErrorOf(node);
      if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
      const usage = readRecord(node, 'usage');
      const toolCalls = toolCallsOf(node);
      return {
        // 调了工具时 content 常常是 null：正文为空串，正文在 arguments 里
        text: textOf(node) ?? '',
        usage: toUsage(readNumber(usage, 'prompt_tokens'), readNumber(usage, 'completion_tokens')),
        ...(toolCalls === undefined ? {} : { toolCalls }),
      };
    },

    async *chatStream(req, rt) {
      const res = await sendRequest(PROVIDER, rt, endpoint(rt, '/chat/completions'), {
        method: 'POST',
        headers: headers(rt.apiKey),
        body: JSON.stringify(bodyOf(req, true)),
      });

      // 兼容端点可能忽略 stream:true 直接回整段 JSON，退化成一次性 yield
      if (!isEventStream(res)) {
        const raw = await res.text();
        const node = parseJson(raw);
        // 退化路径拿不到正文时会把整段 raw 当成正文 yield 出去，错误体的 JSON 会原样发给用户
        const upstream = upstreamErrorOf(node);
        if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
        const delta = textOf(node) ?? raw;
        // 整段 JSON 一次性回完 = 上游自己收尾了：不报 stop，上层只能按「没收到结束原因」当截断续写
        yield { delta, finishReason: 'stop' };
        return;
      }
      if (!res.body) throw new Error(PROVIDER + ': empty response body');

      for await (const payload of parseSse(res.body)) {
        const node = parseJson(payload);
        // 中继把上游错误塞成流里一帧（不带 delta），必须抛：否则上层当成「干净地结束但一字未出」
        const upstream = upstreamErrorOf(node);
        if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
        const delta = deltaOf(node);
        const finishReason = finishOf(node);
        const toolDeltas = toolCallDeltasOf(node);
        // 一帧里有工具调用：逐项 yield；同一帧的 content 挂在第一项上，不拆成两条
        if (toolDeltas.length > 0) {
          const entries = toolDeltas.entries();
          for (const [position, toolCallDelta] of entries) {
            yield {
              delta: position === 0 ? delta ?? '' : '',
              ...(finishReason === undefined || position !== toolDeltas.length - 1 ? {} : { finishReason }),
              toolCallDelta,
            };
          }
          continue;
        }
        // 单条脏数据不该炸掉整条流；纯空 delta 且没有结束原因的帧继续丢弃
        if (delta !== undefined && delta !== '') yield { delta, ...(finishReason === undefined ? {} : { finishReason }) };
        else if (finishReason !== undefined) yield { delta: '', finishReason };
      }
    },

    async listModels(rt) {
      const res = await sendRequest(PROVIDER, rt, endpoint(rt, '/models'), {
        method: 'GET',
        headers: headers(rt.apiKey),
      });
      const node = parseJson(await res.text());
      return readArray(node, 'data')
        .map((item) => readString(item, 'id'))
        .filter((id): id is string => typeof id === 'string');
    },
  };
}
