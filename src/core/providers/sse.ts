import { readRecord, readString } from './rt';

const DONE = '[DONE]';

function trimCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** null 表示该行不产出载荷（空行 / `:` 注释 / event:/id:/retry: 字段） */
function payloadOf(line: string): string | null {
  if (line === '' || line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  const raw = line.slice('data:'.length);
  const value = raw.startsWith(' ') ? raw.slice(1) : raw;
  return value === '' ? null : value;
}

/** Gemini 的 code 是 HTTP 状态码数字，OpenAI 风格是字符串，Anthropic 只有 error.type */
function errorCodeOf(error: Record<string, unknown>): string {
  const code = error.code;
  if (typeof code === 'number') return String(code);
  if (typeof code === 'string' && code !== '') return code;
  const type = readString(error, 'type');
  return type === undefined || type === '' ? 'unknown' : type;
}

/**
 * 上游/中继在流里报错时发的是一条普通 JSON 事件（`{"error":{"code":"…","message":"…"}}`），
 * 既没有 delta 也没有 HTTP 非 2xx，不认出来它就会被当成「一帧脏数据」丢掉，整条流看起来是干净地结束。
 * 返回 `code: message`（没有 error 字段返回 null），message 截到 200 字免得异常串拖太长。
 */
export function upstreamErrorOf(node: unknown): string | null {
  const error = readRecord(node, 'error');
  if (error === null) return null;
  return errorCodeOf(error) + ': ' + (readString(error, 'message') ?? '').slice(0, 200);
}

/**
 * 通用 SSE 行解析：容忍 \r\n、空行与注释行，`data: [DONE]` 结束流。
 * 本项目三个供应商都是一行一个 JSON 事件，故不实现多行 data 拼接。
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = trimCr(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const payload = payloadOf(line);
        if (payload === DONE) return;
        if (payload !== null) yield payload;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const tail = payloadOf(trimCr(buffer));
    if (tail !== null && tail !== DONE) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已关闭时 cancel 无意义，忽略
    }
    reader.releaseLock();
  }
}
