import { describe, expect, it } from 'vitest';
import type { Scope, TtsStyleLayer } from '../src/core/types';
import {
  JUDGE_DIRECTOR_COMMON,
  JUDGE_DIRECTOR_FREE_RULE,
  JUDGE_DIRECTOR_TAGS_RULE,
  JUDGE_SYSTEM,
  STYLE_TAG_MAX_CHARS,
  TTS_STYLE_MAX_CHARS,
  applyJudgeLine,
  composeVoiceSpeech,
  isJudgeConfigured,
  judgeSystemFor,
  normalizeStyleTag,
  resolveStylePrompt,
  stripVoiceTags,
  type VoiceSpeech,
} from '../src/core/voice/style';
import { createMimoTts, createOpenAiTts } from '../src/core/voice/tts';

type FetchArgs = Parameters<typeof fetch>;

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal | null;
}

/** 记下每次请求，按 handler 返回假响应；不改全局 fetch */
function recorder(handler: (url: string) => Response): { calls: Recorded[]; fetchImpl: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchImpl = (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      signal: init?.signal ?? null,
    });
    return Promise.resolve(handler(url));
  };
  return { calls, fetchImpl };
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(call.body) as Record<string, unknown>;
}

function layerOf(scope: Scope, scopeId: string, content: string): TtsStyleLayer {
  return { scope, scopeId, content, updatedAt: '2026-01-01T00:00:00.000Z' };
}

const EMPTY_LAYERS = { channel: null, guild: null, global: null };

const JUDGE = { url: 'https://judge.example/v1/', key: 'sk-judge', model: 'judge-1' };

/** judge 的响应形状：内容在 choices[0].message.content */
function judgeResponse(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

/** MiMo 的响应形状：音频是 JSON 里 base64 的 choices[0].message.audio.data */
function mimoResponse(data: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { audio: { data } } }] }), { status: 200 });
}

const MIMO_TEXT_BASE64 = btoa('ID3xyz');

const ORIGINAL = '这么多年过去了，我还记得。';

/** 27 字：过了 20 字门槛，走 0.3–3 倍那条长度护栏 */
const LONG = '这么多年过去了，我还记得那年夏天我们一起淋过的那场雨。';

/** 0 档（导演模式关）的语音：没有风格组，styleLabel 恒为空串 */
function flat(tag: string, text: string): VoiceSpeech {
  return { tag, text, styleLabel: '' };
}

describe('resolveStylePrompt', () => {
  it('三层按 channel -> guild -> global 取第一个非空，并去掉首尾空白', () => {
    expect(
      resolveStylePrompt({
        channel: layerOf('channel', 'c1', '  频道语气  '),
        guild: layerOf('guild', 'g1', '服务器语气'),
        global: layerOf('global', '', '全局语气'),
      }),
    ).toBe('频道语气');
  });

  it('channel 空白或没有行时退到 guild，guild 也空再退到 global', () => {
    expect(
      resolveStylePrompt({
        channel: layerOf('channel', 'c1', '   '),
        guild: layerOf('guild', 'g1', '服务器语气'),
        global: layerOf('global', '', '全局语气'),
      }),
    ).toBe('服务器语气');
    expect(
      resolveStylePrompt({
        channel: null,
        guild: null,
        global: layerOf('global', '', '全局语气'),
      }),
    ).toBe('全局语气');
  });

  it('三层都没有行或全是空白：返回空串', () => {
    expect(resolveStylePrompt(EMPTY_LAYERS)).toBe('');
    expect(
      resolveStylePrompt({
        channel: layerOf('channel', 'c1', ''),
        guild: layerOf('guild', 'g1', '  '),
        global: layerOf('global', '', '\n'),
      }),
    ).toBe('');
  });

  it('上限常量：提示词 2000、标签 40，HTTP 层与后台共用同一个数', () => {
    expect(TTS_STYLE_MAX_CHARS).toBe(2000);
    expect(STYLE_TAG_MAX_CHARS).toBe(40);
  });
});

describe('isJudgeConfigured', () => {
  it('三字段都 trim 非空才算配好', () => {
    expect(isJudgeConfigured(JUDGE)).toBe(true);
    expect(isJudgeConfigured({ ...JUDGE, url: '  ' })).toBe(false);
    expect(isJudgeConfigured({ ...JUDGE, key: '' })).toBe(false);
    expect(isJudgeConfigured({ ...JUDGE, model: '   ' })).toBe(false);
    expect(isJudgeConfigured(null)).toBe(false);
  });
});

describe('normalizeStyleTag', () => {
  it('普通词包一层半角括号', () => {
    expect(normalizeStyleTag('怅然')).toBe('(怅然)');
  });

  it('去首尾空白、空白压成单空格、去引号', () => {
    expect(normalizeStyleTag('  轻柔   低语  ')).toBe('(轻柔 低语)');
    expect(normalizeStyleTag('"怅然"')).toBe('(怅然)');
    expect(normalizeStyleTag('「怅然」')).toBe('(怅然)');
  });

  it('已有的成对括号去掉再包一层：全角 / 方括号 / 套两层都一样', () => {
    expect(normalizeStyleTag('(怅然)')).toBe('(怅然)');
    expect(normalizeStyleTag('（怅然）')).toBe('(怅然)');
    expect(normalizeStyleTag('【怅然】')).toBe('(怅然)');
    expect(normalizeStyleTag('((怅然))')).toBe('(怅然)');
  });

  it('截断到 40 字（括号不算在内）', () => {
    expect(normalizeStyleTag('啊'.repeat(60))).toBe('(' + '啊'.repeat(STYLE_TAG_MAX_CHARS) + ')');
  });

  it('空白（含只剩括号与引号）：返回空串 = 没有语气', () => {
    expect(normalizeStyleTag('')).toBe('');
    expect(normalizeStyleTag('   ')).toBe('');
    expect(normalizeStyleTag('()')).toBe('');
    expect(normalizeStyleTag('""')).toBe('');
  });
});

describe('stripVoiceTags', () => {
  it('去掉四种成对段，再把空白压成一个', () => {
    expect(stripVoiceTags('这么多年过去了，我还记得。[轻笑]')).toBe('这么多年过去了，我还记得。');
    expect(stripVoiceTags('（轻声）你好')).toBe('你好');
    expect(stripVoiceTags('【x】abc')).toBe('abc');
    expect(stripVoiceTags('a[b]c')).toBe('ac');
    expect(stripVoiceTags('a  (b)  c')).toBe('a c');
  });

  it('没有配对的括号原样留着（不猜模型想说什么）', () => {
    expect(stripVoiceTags('a (b')).toBe('a (b');
    expect(stripVoiceTags('(怅然)')).toBe('');
  });
});

describe('applyJudgeLine', () => {
  it('行首括号是标签：正文与原文一致时用括号内容，正文取 judge 那句', () => {
    expect(applyJudgeLine(ORIGINAL, '(怅然)' + ORIGINAL)).toEqual(flat('(怅然)', ORIGINAL));
    expect(applyJudgeLine(ORIGINAL, '【怅然】' + ORIGINAL)).toEqual(flat('(怅然)', ORIGINAL));
  });

  it('正文里多插了 [音频标签] 也算「没改字」：插进去的那段保留在正文里', () => {
    expect(applyJudgeLine(ORIGINAL, '(怅然)这么多年过去了，我还记得。[轻笑]')).toEqual(
      flat('(怅然)', '这么多年过去了，我还记得。[轻笑]'),
    );
  });

  it('正文被改了一个字：正文退回原文，括号里的标签留下', () => {
    expect(applyJudgeLine(ORIGINAL, '(怅然)这么多年过去了，我还记得啊。')).toEqual(
      flat('(怅然)', ORIGINAL),
    );
  });

  it('带标签却擅自追加一句解释：标签留下、正文退回原文', () => {
    expect(applyJudgeLine(ORIGINAL, '(怅然)这么多年过去了，我还记得。这句要念得慢一点。')).toEqual(
      flat('(怅然)', ORIGINAL),
    );
  });

  it('括号后没有正文（只剩标签）：退回原文，不念一个空串', () => {
    expect(applyJudgeLine(ORIGINAL, '(怅然)   ')).toEqual(flat('', ORIGINAL));
  });

  it('行首有括号却没有配对收尾：不认这一行', () => {
    expect(applyJudgeLine(ORIGINAL, '(怅然' + ORIGINAL)).toEqual(flat('', ORIGINAL));
  });

  it('没有括号但整行短得像标签（≤20 字、没有句读）：整行当标签，正文仍是原文', () => {
    expect(applyJudgeLine(ORIGINAL, '怅然')).toEqual(flat('(怅然)', ORIGINAL));
    expect(applyJudgeLine(ORIGINAL, '  轻柔 低语  ')).toEqual(flat('(轻柔 低语)', ORIGINAL));
  });

  it('没有括号又长得像正文（超过 20 字或带句读）：没有标签，正文仍是原文', () => {
    expect(applyJudgeLine(ORIGINAL, '怅然')).toEqual(flat('(怅然)', ORIGINAL));
    expect(applyJudgeLine(ORIGINAL, '怅然。')).toEqual(flat('', ORIGINAL));
    expect(applyJudgeLine(ORIGINAL, '啊'.repeat(21))).toEqual(flat('', ORIGINAL));
    expect(applyJudgeLine(ORIGINAL, '')).toEqual(flat('', ORIGINAL));
  });
});

describe('composeVoiceSpeech', () => {
  it('judge 未配置（缺任何一段）：不发请求，提示词转标签、正文用原文', async () => {
    const { calls, fetchImpl } = recorder(() => judgeResponse('不该被调用'));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '  怅然  ',
      judge: { ...JUDGE, key: '' },
      fetchImpl,
    });
    expect(speech).toEqual(flat('(怅然)', ORIGINAL));
    expect(calls).toEqual([]);
  });

  it('judge 与提示词都没料：标签空串，正文仍是原文', async () => {
    await expect(composeVoiceSpeech({ text: ORIGINAL, prompt: '   ', judge: null })).resolves.toEqual(
      flat('', ORIGINAL),
    );
  });

  it('judge 成功：按 OpenAI 形状打 /chat/completions，系统指令带上提示词，正文原样作 user', async () => {
    const { calls, fetchImpl } = recorder(() => judgeResponse('"' + '(怅然)' + ORIGINAL + '"'));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '  怅然  ',
      judge: JUDGE,
      fetchImpl,
    });

    expect(speech).toEqual(flat('(怅然)', ORIGINAL));
    const call = calls[0] as Recorded;
    expect(call.url).toBe('https://judge.example/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer sk-judge');
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(call)).toEqual({
      model: 'judge-1',
      messages: [
        { role: 'system', content: JUDGE_SYSTEM + '\n【风格要求】怅然' },
        { role: 'user', content: ORIGINAL },
      ],
      max_tokens: 4000,
      temperature: 0.4,
    });
  });

  it('judge 带标签又插了 [轻笑]：正文照用 judge 那句，一个字都不改', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('(怅然)这么多年过去了，[轻笑]我还记得。'));
    const speech = await composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl });
    expect(speech).toEqual(flat('(怅然)', '这么多年过去了，[轻笑]我还记得。'));
    // 契约：去掉标签后与原文一致
    expect(stripVoiceTags(speech.text)).toBe(stripVoiceTags(ORIGINAL));
  });

  it('judge 改了一个字：正文退回原文，括号里的标签照样用（没有提示词也不丢）', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('(怅然)这么多年过去了，我还记得啊。'));
    await expect(composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl })).resolves.toEqual(
      flat('(怅然)', ORIGINAL),
    );
  });

  it('judge 带标签但擅自加了句解释：标签留下、正文退回原文', async () => {
    const { fetchImpl } = recorder(() =>
      judgeResponse('(怅然)这么多年过去了，我还记得。这句要念得慢一点。'),
    );
    await expect(composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl })).resolves.toEqual(
      flat('(怅然)', ORIGINAL),
    );
  });

  it('judge 只回一行「怅然」：整行当标签，正文用原文', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('怅然'));
    await expect(composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl })).resolves.toEqual(
      flat('(怅然)', ORIGINAL),
    );
  });

  it('judge 回空：用提示词转标签', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('   '));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));
  });

  it('judge 回多行：只认首行，第二行起不看', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('(怅然)' + ORIGINAL + '\n以上是标签'));
    await expect(composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl })).resolves.toEqual(
      flat('(怅然)', ORIGINAL),
    );
  });

  it('非 2xx / 超时 / 坏 JSON / 结构不符：都退回提示词标签 + 原文', async () => {
    const down = recorder(() => new Response('judge down', { status: 500 }));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl: down.fetchImpl }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));

    const timeout = (): Promise<Response> => Promise.reject(new DOMException('timeout', 'TimeoutError'));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl: timeout }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));

    const badJson = recorder(() => new Response('not json at all', { status: 200 }));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl: badJson.fetchImpl }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));

    const missing = recorder(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl: missing.fetchImpl }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));
  });

  it('请求本身抛错也不抛出去：仍是提示词标签 + 原文', async () => {
    const failing = (): Promise<Response> => Promise.reject(new Error('socket hang up'));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl: failing }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));
  });

  it('任何结局都保证：stripVoiceTags(正文) 与原文一致', async () => {
    const cases: Array<[string, () => Response]> = [
      ['(怅然)' + ORIGINAL, () => judgeResponse('(怅然)' + ORIGINAL)],
      ['insert', () => judgeResponse('(怅然)这么多年过去了，[轻笑]我还记得。')],
      ['rewrite', () => judgeResponse('(怅然)这么多年过去了，我还记得啊。')],
      ['bare', () => judgeResponse('怅然')],
      ['empty', () => judgeResponse('')],
      ['down', () => new Response('boom', { status: 500 })],
    ];
    for (const [, handler] of cases) {
      const { fetchImpl } = recorder(handler);
      const speech = await composeVoiceSpeech({ text: ORIGINAL, prompt: '怅然', judge: JUDGE, fetchImpl });
      expect(stripVoiceTags(speech.text)).toBe(stripVoiceTags(ORIGINAL));
      // 标签要么是空串，要么已经是包好的半角括号形状
      if (speech.tag !== '') expect(speech.tag.startsWith('(') && speech.tag.endsWith(')')).toBe(true);
    }
  });
});

describe('judgeSystemFor', () => {
  it('director 0：与改动前的 JUDGE_SYSTEM 逐字相同，提示词照旧追加在末尾', () => {
    expect(judgeSystemFor(0, '')).toBe(JUDGE_SYSTEM);
    expect(judgeSystemFor(0, '怅然')).toBe(JUDGE_SYSTEM + '\n【风格要求】怅然');
  });

  it('director 1：带上公共规则与「不许改一个字」，不出现改写那条', () => {
    const system = judgeSystemFor(1, '平静');
    expect(system).toContain(JUDGE_DIRECTOR_COMMON);
    expect(system).toContain(JUDGE_DIRECTOR_TAGS_RULE);
    expect(system).not.toContain(JUDGE_DIRECTOR_FREE_RULE);
    // 唱歌与括号形状写进公共规则里：两档都得有
    expect(system).toContain('唱歌');
    // 每一句前面都要加语气标签；唱歌时每句的标签带唱歌字样
    expect(system).toContain('每一句前面都要加一个括号标签');
    expect(system).toContain('唱歌时整体风格组里要有一个 (唱歌)');
    expect(system).toContain('不要给每句歌词加标签');
    expect(system).toContain('【风格要求】平静');
  });

  it('director 2：带上公共规则与改写那条，不出现「不许改一个字」那条', () => {
    const system = judgeSystemFor(2, '');
    expect(system).toContain(JUDGE_DIRECTOR_COMMON);
    expect(system).toContain(JUDGE_DIRECTOR_FREE_RULE);
    expect(system).not.toContain(JUDGE_DIRECTOR_TAGS_RULE);
    // 公共规则里自带「后台给的【风格要求】只当偏好」；没有提示词时行尾不该再追加一段
    expect(system).not.toContain('\n【风格要求】');
  });
});

describe('composeVoiceSpeech 的导演模式', () => {
  it('director 0：与改动前一致 —— 标签来自 judge、正文逐字校验、系统指令是旧那条', async () => {
    const { calls, fetchImpl } = recorder(() => judgeResponse('(怅然)这么多年过去了，我还记得啊。'));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '怅然',
      judge: JUDGE,
      fetchImpl,
      director: 0,
    });
    expect(speech).toEqual(flat('(怅然)', ORIGINAL));
    expect(bodyOf(calls[0] as Recorded)['messages']).toEqual([
      { role: 'system', content: JUDGE_SYSTEM + '\n【风格要求】怅然' },
      { role: 'user', content: ORIGINAL },
    ]);
  });

  it('director 1：放行含中途（语速加快）与 [轻笑] 的候选，text 是整行、tag 为空', async () => {
    const line = '（怅然）这么多年过去了，（语速加快）我还记得。[轻笑]';
    const { fetchImpl } = recorder(() => judgeResponse(line));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '平静',
      judge: JUDGE,
      fetchImpl,
      director: 1,
    });
    expect(speech).toEqual({ tag: '', text: line, styleLabel: '（怅然）' });
    // 删掉标签后与原文逐字相同：一个字都没改，只是插了标签
    expect(stripVoiceTags(speech.text)).toBe(stripVoiceTags(ORIGINAL));
    // tag 必须为空：风格组已经长在正文开头，再当前缀就会被念两遍
    expect(speech.tag).toBe('');
  });

  it('director 1：每句前面都带标签也放行（删掉标签后与原文逐字相同）', async () => {
    const line = '（怅然）（轻声）这么多年过去了，（笑着）我还记得。[轻笑]';
    const { fetchImpl } = recorder(() => judgeResponse(line));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '',
      judge: JUDGE,
      fetchImpl,
      director: 1,
    });
    expect(speech).toEqual({ tag: '', text: line, styleLabel: '（怅然）' });
  });

  it('director 1：开头没有风格组时 styleLabel 是空串，中途的标签照样保留', async () => {
    const line = '这么多年过去了，[轻笑]我还记得。';
    const { fetchImpl } = recorder(() => judgeResponse(line));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '',
      judge: JUDGE,
      fetchImpl,
      director: 1,
    });
    expect(speech).toEqual({ tag: '', text: line, styleLabel: '' });
  });

  it('director 1 改了一个字：正文退回原文，styleLabel 把这组风格留下来', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('（怅然）这么多年过去了，我还记得啊。'));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl, director: 1 }),
    ).resolves.toEqual({ tag: '(平静)', text: ORIGINAL, styleLabel: '（怅然）', directorRejected: 'verbatim' });
  });

  it('director 1 多加一句解释：同样算改字，退回原文', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('(怅然)' + ORIGINAL + '这句要念得慢一点。'));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl, director: 1 }),
    ).resolves.toEqual({ tag: '', text: ORIGINAL, styleLabel: '(怅然)', directorRejected: 'verbatim' });
  });

  it('director 1 只回了标签没有正文：退回原文，不念一个空串', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('（怅然）  '));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl, director: 1 }),
    ).resolves.toEqual({ tag: '(平静)', text: ORIGINAL, styleLabel: '（怅然）', directorRejected: 'empty' });
  });

  it('director 2：接受口语化改写，整段（含风格组）拿去合成', async () => {
    const line = '（怅然）这么多年过去了呀，我还记得那会儿的事。';
    const { fetchImpl } = recorder(() => judgeResponse(line));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '',
      judge: JUDGE,
      fetchImpl,
      director: 2,
    });
    expect(speech).toEqual({ tag: '', text: line, styleLabel: '（怅然）' });
  });

  it('director 2：开头不是括号组时 styleLabel 是空串', async () => {
    const line = '这么多年过去了呀，我还记得。';
    const { fetchImpl } = recorder(() => judgeResponse(line));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl, director: 2 }),
    ).resolves.toEqual({ tag: '', text: line, styleLabel: '' });
  });

  it('director 2 长度跑飞（超过 3 倍）：退回原文，styleLabel 留下', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('（怅然）' + '啊'.repeat(100)));
    await expect(
      composeVoiceSpeech({ text: LONG, prompt: '', judge: JUDGE, fetchImpl, director: 2 }),
    ).resolves.toEqual({ tag: '', text: LONG, styleLabel: '（怅然）', directorRejected: 'ratio' });
  });

  it('director 2 缩得太狠（低于 0.3 倍）：退回原文', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('（怅然）嗯。'));
    await expect(
      composeVoiceSpeech({ text: LONG, prompt: '', judge: JUDGE, fetchImpl, director: 2 }),
    ).resolves.toEqual({ tag: '', text: LONG, styleLabel: '（怅然）', directorRejected: 'ratio' });
  });

  it('director 2 原文不足 20 字：上限放宽到原文 + 200 字', async () => {
    const okLine = '（轻快）晚安呀，' + '啊'.repeat(150);
    const ok = recorder(() => judgeResponse(okLine));
    await expect(
      composeVoiceSpeech({ text: '晚安', prompt: '', judge: JUDGE, fetchImpl: ok.fetchImpl, director: 2 }),
    ).resolves.toEqual({ tag: '', text: okLine, styleLabel: '（轻快）' });

    const overLine = '（轻快）' + '啊'.repeat(250);
    const over = recorder(() => judgeResponse(overLine));
    await expect(
      composeVoiceSpeech({ text: '晚安', prompt: '', judge: JUDGE, fetchImpl: over.fetchImpl, director: 2 }),
    ).resolves.toEqual({ tag: '', text: '晚安', styleLabel: '（轻快）', directorRejected: 'ratio' });
  });

  it('director 2 出现 [[voice]] 这类指令残留：退回原文', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('（怅然）' + ORIGINAL + '[[voice]]'));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl, director: 2 }),
    ).resolves.toEqual({ tag: '', text: ORIGINAL, styleLabel: '（怅然）', directorRejected: 'residue' });
  });

  it('导演模式下 judge 失败 / 没配 judge：退回原文，tag 保持老的兜底语义，不抛', async () => {
    const down = recorder(() => new Response('judge down', { status: 500 }));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl: down.fetchImpl, director: 1 }),
    ).resolves.toEqual({ ...flat('(平静)', ORIGINAL), directorRejected: 'judge' });

    const failing = (): Promise<Response> => Promise.reject(new Error('socket hang up'));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: JUDGE, fetchImpl: failing, director: 2 }),
    ).resolves.toEqual({ ...flat('(平静)', ORIGINAL), directorRejected: 'judge' });

    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: null, director: 2 }),
    ).resolves.toEqual({ ...flat('(平静)', ORIGINAL), directorRejected: 'judge' });
  });

  it('director 0 的兜底不记退回原因：老行为一个字都不该变', async () => {
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '平静', judge: null, director: 0 }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));
  });

  it('director 是脏值（既不是 0 / 1 / 2）：按 0 档走', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('(怅然)' + ORIGINAL));
    await expect(
      composeVoiceSpeech({ text: ORIGINAL, prompt: '', judge: JUDGE, fetchImpl, director: 9 }),
    ).resolves.toEqual(flat('(怅然)', ORIGINAL));
  });
});

describe('composeVoiceSpeech 的诊断回调 onJudgeLine', () => {
  it('judge 答上来时回调一次，拿到它写的那一行（首行、去引号）', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('"(怅然)' + ORIGINAL + '"\n第二行不看'));
    const seen: string[] = [];
    await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '',
      judge: JUDGE,
      fetchImpl,
      onJudgeLine: (line: string): void => {
        seen.push(line);
      },
    });

    expect(seen).toEqual(['(怅然)' + ORIGINAL]);
  });

  it('整行都给：不截断，多长都原样交出去', async () => {
    const long = '啊'.repeat(300);
    const { fetchImpl } = recorder(() => judgeResponse(long));
    const seen: string[] = [];
    await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '',
      judge: JUDGE,
      fetchImpl,
      onJudgeLine: (line: string): void => {
        seen.push(line);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(long);
  });

  it('judge 没回（失败 / 超时 / 没配）：一次都不调，念法照旧', async () => {
    const seen: string[] = [];
    const down = recorder(() => new Response('judge down', { status: 500 }));
    await expect(
      composeVoiceSpeech({
        text: ORIGINAL,
        prompt: '平静',
        judge: JUDGE,
        fetchImpl: down.fetchImpl,
        onJudgeLine: (line: string): void => {
          seen.push(line);
        },
      }),
    ).resolves.toEqual(flat('(平静)', ORIGINAL));
    await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '平静',
      judge: null,
      onJudgeLine: (line: string): void => {
        seen.push(line);
      },
    });

    expect(seen).toEqual([]);
  });

  it('回调自己抛错也不影响这一条：念法与不传它时逐字相同', async () => {
    const { fetchImpl } = recorder(() => judgeResponse('(怅然)' + ORIGINAL));
    const speech = await composeVoiceSpeech({
      text: ORIGINAL,
      prompt: '',
      judge: JUDGE,
      fetchImpl,
      onJudgeLine: (): void => {
        throw new Error('log sink exploded');
      },
    });

    expect(speech).toEqual(flat('(怅然)', ORIGINAL));
  });
});

describe('TTS 请求里的 tag', () => {
  it('mimo 有 tag：只有一条 assistant，content 是 (怅然)+正文', async () => {
    const { calls, fetchImpl } = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    const tts = createMimoTts({
      url: 'https://api.xiaomimimo.com/v1',
      key: 'secret',
      model: 'mimo-v2.5-tts',
      fetchImpl,
    });
    await tts.synthesize({ text: '晚安', tag: '(怅然)' });

    const sent = bodyOf(calls[0] as Recorded);
    expect(sent['messages']).toEqual([{ role: 'assistant', content: '(怅然)晚安' }]);
    expect((sent['messages'] as unknown[]).length).toBe(1);
    // 不再有 role:user 那条：标签与正文同一条消息
    expect(JSON.stringify(sent)).not.toContain('"user"');
  });

  it('mimo 没有 tag（含空串与纯空白）：仍是一条 assistant，content 就是正文', async () => {
    const a = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    await createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl: a.fetchImpl })
      .synthesize({ text: '晚安' });
    expect(bodyOf(a.calls[0] as Recorded)['messages']).toEqual([{ role: 'assistant', content: '晚安' }]);

    const b = recorder(() => mimoResponse(MIMO_TEXT_BASE64));
    await createMimoTts({ url: 'https://api.xiaomimimo.com/v1', key: 'k', model: 'mimo-v2.5-tts', fetchImpl: b.fetchImpl })
      .synthesize({ text: '晚安', tag: '   ' });
    expect(bodyOf(b.calls[0] as Recorded)['messages']).toEqual([{ role: 'assistant', content: '晚安' }]);
  });

  it('openai 方言忽略 tag：/audio/speech 没有对应参数，body 里绝不出现 tag', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([1]), { status: 200 }));
    const tts = createOpenAiTts({ url: 'https://tts.example/v1', key: 'k', model: 'tts-1', fetchImpl });
    await tts.synthesize({ text: '晚安', tag: '(怅然)' });

    const sent = bodyOf(calls[0] as Recorded);
    expect('tag' in sent).toBe(false);
    expect('style' in sent).toBe(false);
    expect(sent).toEqual({ model: 'tts-1', input: '晚安', response_format: 'mp3', speed: 1 });
  });
});
