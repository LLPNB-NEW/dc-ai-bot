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

const PROVIDER = 'gemini' as const;
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** §22.3：图片只挂在最后一条 role==='user' 的消息上；没有 user 消息返回 -1 */
function lastUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

interface WireContent {
  role: string;
  parts: Part[];
}

/** 无图时 parts 仍是 [{text}]（形状逐字不变）；有图时只有目标那条追加 inlineData，role 映射不变 */
function contentsOf(req: LlmRequest): WireContent[] {
  const images = req.images ?? [];
  const target = images.length === 0 ? -1 : lastUserIndex(req.messages);
  return req.messages.map((message: ChatMessage, index: number): WireContent => {
    const parts: Part[] = [{ text: message.content }];
    if (index === target) {
      for (const image of images) {
        parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
      }
    }
    return { role: message.role === 'assistant' ? 'model' : 'user', parts };
  });
}

function bodyOf(req: LlmRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: contentsOf(req),
    generationConfig: {
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.maxTokens === undefined ? {} : { maxOutputTokens: req.maxTokens }),
      ...(req.topP === undefined ? {} : { topP: req.topP }),
      ...(req.topK === undefined ? {} : { topK: req.topK }),
      ...(req.seed === undefined ? {} : { seed: req.seed }),
      ...(req.frequencyPenalty === undefined ? {} : { frequencyPenalty: req.frequencyPenalty }),
      ...(req.presencePenalty === undefined ? {} : { presencePenalty: req.presencePenalty }),
    },
  };
}

function endpoint(rt: ProviderRuntime, model: string, method: string): string {
  const base = resolveBaseUrl(rt.baseUrl, DEFAULT_BASE_URL);
  const key = 'key=' + encodeURIComponent(rt.apiKey);
  const query = method === 'streamGenerateContent' ? 'alt=sse&' + key : key;
  return base + '/models/' + encodeURIComponent(model) + ':' + method + '?' + query;
}

/** §7.3：每块只取 candidates[0].content.parts[0].text，缺失即跳过 */
function textOf(node: unknown): string | undefined {
  const part = readArray(readRecord(readArray(node, 'candidates')[0], 'content'), 'parts')[0];
  return readString(part, 'text');
}

/** 结束原因（finishReason = STOP / MAX_TOKENS …）挂在 candidates[0] 上 */
function finishOf(node: unknown): string | undefined {
  return readString(readArray(node, 'candidates')[0], 'finishReason');
}

export function createGeminiProvider(): LlmProvider {
  return {
    id: PROVIDER,

    async chat(req, rt) {
      const res = await sendRequest(PROVIDER, rt, endpoint(rt, req.model, 'generateContent'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyOf(req)),
      });
      const node = parseJson(await res.text());
      // 200 里也是错误：不认出来 textOf 拿不到就返回空串，上层会把空回复当成成功
      const upstream = upstreamErrorOf(node);
      if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
      const usage = readRecord(node, 'usageMetadata');
      return {
        text: textOf(node) ?? '',
        usage: toUsage(
          readNumber(usage, 'promptTokenCount'),
          readNumber(usage, 'candidatesTokenCount'),
        ),
      };
    },

    async *chatStream(req, rt) {
      const res = await sendRequest(
        PROVIDER,
        rt,
        endpoint(rt, req.model, 'streamGenerateContent'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bodyOf(req)),
        },
      );

      // 兼容网关可能忽略 alt=sse 直接回整段 JSON，退化成一次性 yield
      if (!isEventStream(res)) {
        const raw = await res.text();
        const node = parseJson(raw);
        // 退化路径拿不到正文时会把整段 raw 当成正文 yield 出去，错误体的 JSON 会原样发给用户
        const upstream = upstreamErrorOf(node);
        if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
        const delta = textOf(node) ?? raw;
        // 整段 JSON 一次性回完 = 上游自己收尾了：不报 STOP，上层只能按「没收到结束原因」当截断续写
        yield { delta, finishReason: 'stop' };
        return;
      }
      if (!res.body) throw new Error(PROVIDER + ': empty response body');

      for await (const payload of parseSse(res.body)) {
        const node = parseJson(payload);
        // 中继把上游错误塞成流里一帧（不带 candidates），必须抛：否则上层当成「干净地结束但一字未出」
        const upstream = upstreamErrorOf(node);
        if (upstream !== null) throw new Error(PROVIDER + ': ' + upstream);
        const delta = textOf(node);
        const finishReason = finishOf(node);
        // 单条脏数据不该炸掉整条流；纯空 delta 且没有结束原因的帧继续丢弃
        if (delta !== undefined && delta !== '') yield { delta, ...(finishReason === undefined ? {} : { finishReason }) };
        else if (finishReason !== undefined) yield { delta: '', finishReason };
      }
    },

    async listModels(rt) {
      const base = resolveBaseUrl(rt.baseUrl, DEFAULT_BASE_URL);
      const res = await sendRequest(
        PROVIDER,
        rt,
        base + '/models?key=' + encodeURIComponent(rt.apiKey),
        { method: 'GET' },
      );
      const node = parseJson(await res.text());
      return readArray(node, 'models')
        .map((item) => readString(item, 'name'))
        .filter((name): name is string => typeof name === 'string')
        .map((name) => (name.startsWith('models/') ? name.slice('models/'.length) : name));
    },
  };
}
