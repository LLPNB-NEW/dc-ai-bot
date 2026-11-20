import { describe, expect, it } from 'vitest';
import { createOpenAiCompatProvider } from '../src/core/providers/openai-compat';
import {
  HttpStatusError,
  MAX_ATTEMPTS,
  RETRYABLE_STATUS,
  RETRY_DELAY_MS,
  sendRequest,
} from '../src/core/providers/rt';
import type { LlmRequest, ProviderRuntime } from '../src/core/types';

interface FakeCall {
  url: string;
  init: RequestInit;
}

/** 逐次应答：第 n 次调用拿 responses[n]，用完一直重复最后一个；Error 表示这一抛 */
function scriptedFetch(responses: Array<Response | Error>): {
  fetch: ProviderRuntime['fetch'];
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: FakeCall = { url: typeof input === 'string' ? input : String(input), init: init ?? {} };
    calls.push(call);
    const scripted = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (scripted === undefined) throw new Error('scriptedFetch: 没有脚本');
    if (scripted instanceof Error) throw scripted;
    return scripted;
  };
  return { fetch: fn as unknown as ProviderRuntime['fetch'], calls };
}

const URL = 'https://api.example.test/v1/chat/completions';
const INIT: RequestInit = { method: 'POST', body: '{"model":"gpt-4o-mini"}' };

function runtime(fetchImpl: ProviderRuntime['fetch']): ProviderRuntime {
  return { apiKey: 'sk-test', fetch: fetchImpl };
}

function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error as Error,
  );
}

function status(code: number, body: string): Response {
  return new Response(body, { status: code });
}

/** OpenAI 兼容的成功响应：只用到 choices[0].message.content 一处 */
function completion(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('§19.7 常量', () => {
  it('MAX_ATTEMPTS=2、RETRY_DELAY_MS=800、RETRYABLE_STATUS 只有 429 与 5xx', () => {
    expect(MAX_ATTEMPTS).toBe(2);
    expect(RETRY_DELAY_MS).toBe(800);
    expect(RETRYABLE_STATUS).toEqual([429, 500, 502, 503, 504]);
  });
});

describe('§19.7 sendRequest 自动重试一次', () => {
  it('429 → 200：只重试一次，返回第二次的响应', async () => {
    const fake = scriptedFetch([status(429, 'rate limited'), completion('重试成功')]);

    const res = await sendRequest('openai-compat', runtime(fake.fetch), URL, INIT);

    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(2);
    // 每次尝试各自 createRequestSignal：两个 signal 必须是不同实例
    expect(fake.calls[0].init.signal).toBeDefined();
    expect(fake.calls[0].init.signal).not.toBe(fake.calls[1].init.signal);
    // 重试重放的是同一个请求
    expect(fake.calls[1].url).toBe(URL);
    expect(fake.calls[1].init.body).toBe(INIT.body);
  });

  it('500 两次仍失败：最多两次尝试，错误串格式不变，且抛的是第二次的原始错误', async () => {
    const fake = scriptedFetch([status(500, '第一次'), status(500, '第二次')]);

    const error = await failure(sendRequest('anthropic', runtime(fake.fetch), URL, INIT));

    expect(fake.calls).toHaveLength(2);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(500);
    // 逐字保持 <provider> HTTP <status>: <body 前 300 字>，body 取第二次的
    expect(error.message).toBe('anthropic HTTP 500: 第二次');
  });

  it('400 不重试：fetch 只被调用 1 次，错误原样上抛', async () => {
    const fake = scriptedFetch([status(400, 'bad request')]);

    const error = await failure(sendRequest('gemini', runtime(fake.fetch), URL, INIT));

    expect(fake.calls).toHaveLength(1);
    expect((error as HttpStatusError).status).toBe(400);
    expect(error.message).toBe('gemini HTTP 400: bad request');
  });

  it('fetch 抛传输错误后重试成功', async () => {
    const fake = scriptedFetch([new TypeError('network down'), completion('恢复了')]);

    const res = await sendRequest('openai-compat', runtime(fake.fetch), URL, INIT);

    expect(res.ok).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].init.signal).not.toBe(fake.calls[1].init.signal);
  });

  it('AbortError 不重试：我们自己 30 秒建连超时，重试只会把等待翻倍', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fake = scriptedFetch([abortError]);

    const error = await failure(sendRequest('openai-compat', runtime(fake.fetch), URL, INIT));

    expect(fake.calls).toHaveLength(1);
    // 原对象上抛：不包装、不改名
    expect(error).toBe(abortError);
    expect(error.name).toBe('AbortError');
  });

  it('走真实 provider：429 被吞掉并重试后正常返回整段文本', async () => {
    const fake = scriptedFetch([status(429, 'slow down'), completion('重试后的回复')]);
    const request: LlmRequest = {
      model: 'gpt-4o-mini',
      system: 'SYS',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const result = await createOpenAiCompatProvider().chat(request, runtime(fake.fetch));

    expect(fake.calls).toHaveLength(2);
    expect(result.text).toBe('重试后的回复');
  });
});
