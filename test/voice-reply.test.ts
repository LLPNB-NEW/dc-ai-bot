import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceSettingsConfig } from '../src/core/types';
import {
  VOICE_DIRECTOR_FREE,
  VOICE_DIRECTOR_OFF,
  VOICE_DIRECTOR_TAGS,
  VOICE_MODE_ALWAYS,
  VOICE_MODE_OFF,
  VOICE_MODE_ON_REQUEST,
  VOICE_SPEED_DEFAULT,
} from '../src/core/voice/settings';
import { TtsUnavailableError, type TtsPort } from '../src/core/voice/tts';
import { maybeSendVoice } from '../src/workers/discord/voice-reply';

const AUDIO = new Uint8Array([9, 8, 7]);

function settingsOf(patch: Partial<VoiceSettingsConfig> = {}): VoiceSettingsConfig {
  return {
    scope: 'channel',
    scopeId: 'c1',
    mode: VOICE_MODE_ALWAYS,
    voice: '',
    speed: VOICE_SPEED_DEFAULT,
    // 导演模式默认关：绝大多数用例走的就是逐字朗读的老路径
    director: VOICE_DIRECTOR_OFF,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

interface SynthCall {
  text: string;
  voice?: string;
  speed?: number;
  tag?: string;
}

function fakeTts(fail = false): { tts: TtsPort; calls: SynthCall[] } {
  const calls: SynthCall[] = [];
  return {
    calls,
    tts: {
      async synthesize(input: SynthCall): Promise<Uint8Array> {
        // 只记真正给出的字段：便于用 toEqual 断言「没给 tag 就彻底不出现」
        const call: SynthCall = { text: input.text };
        if (input.voice !== undefined) call.voice = input.voice;
        if (input.speed !== undefined) call.speed = input.speed;
        if (input.tag !== undefined) call.tag = input.tag;
        calls.push(call);
        if (fail) throw new TtsUnavailableError('TTS_HTTP 500: boom');
        return AUDIO;
      },
    },
  };
}

describe('maybeSendVoice 的三层开关', () => {
  it('settings 为 null：不发（三层都没配）', async () => {
    const { tts, calls } = fakeTts();
    const sent: Uint8Array[] = [];
    const result = await maybeSendVoice({ settings: null, tts, text: '你好', wanted: true, send: async (audio) => { sent.push(audio); } });
    expect(result).toEqual({ sent: false });
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('mode 0：就算模型写了 [[voice]] 也不发', async () => {
    const { tts, calls } = fakeTts();
    const result = await maybeSendVoice({
      settings: settingsOf({ mode: VOICE_MODE_OFF }),
      tts,
      text: '你好',
      wanted: true,
      send: async () => undefined,
    });
    expect(result).toEqual({ sent: false });
    expect(calls).toEqual([]);
  });

  it('mode 1 且没有指令：不发', async () => {
    const { tts, calls } = fakeTts();
    const result = await maybeSendVoice({
      settings: settingsOf({ mode: VOICE_MODE_ON_REQUEST }),
      tts,
      text: '你好',
      wanted: false,
      send: async () => undefined,
    });
    expect(result).toEqual({ sent: false });
    expect(calls).toEqual([]);
  });

  it('mode 1 且有指令：合成并发出，voice/speed 取自配置', async () => {
    const { tts, calls } = fakeTts();
    const sent: Uint8Array[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf({ mode: VOICE_MODE_ON_REQUEST, voice: 'nova', speed: 120 }),
      tts,
      text: '晚上好',
      wanted: true,
      send: async (audio) => {
        sent.push(audio);
      },
    });
    expect(result).toEqual({ sent: true });
    expect(calls).toEqual([{ text: '晚上好', voice: 'nova', speed: 120 }]);
    expect(sent).toEqual([AUDIO]);
  });

  it('mode 2：没有指令也发', async () => {
    const { tts } = fakeTts();
    const result = await maybeSendVoice({
      settings: settingsOf({ mode: VOICE_MODE_ALWAYS }),
      tts,
      text: '早',
      wanted: false,
      send: async () => undefined,
    });
    expect(result).toEqual({ sent: true });
  });

  it('配置音色为空串时不带 voice 字段（合成侧退回服务端默认音色）', async () => {
    const { tts, calls } = fakeTts();
    await maybeSendVoice({ settings: settingsOf(), tts, text: '早', wanted: false, send: async () => undefined });
    expect(calls[0]?.voice).toBeUndefined();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('maybeSendVoice 的语气提示词', () => {
  it('确认要发语音后才取提示词，并作为标签传给合成', async () => {
    const { tts, calls } = fakeTts();
    let asked = 0;
    const result = await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: async (): Promise<string> => {
        asked += 1;
        return '  温柔一点  ';
      },
      judge: null,
      send: async () => undefined,
    });
    expect(result).toEqual({ sent: true });
    expect(asked).toBe(1);
    expect(calls).toEqual([{ text: '晚上好', speed: VOICE_SPEED_DEFAULT, tag: '(温柔一点)' }]);
  });

  it('配好 judge 时先判断情绪：把模型给的那一行去掉引号后当作标签', async () => {
    const { tts, calls } = fakeTts();
    const stub = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '「轻快地说」' } }] }), { status: 200 }),
      ),
    );
    vi.stubGlobal('fetch', stub);
    await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: async (): Promise<string> => '固定提示词',
      judge: { url: 'https://judge.example/v1', key: 'sk-judge', model: 'judge-1' },
      send: async () => undefined,
    });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(calls[0]?.tag).toBe('(轻快地说)');
  });

  it('stylePrompt 抛错只 warn，按空提示词继续，语音照发', async () => {
    const { tts, calls } = fakeTts();
    const logs: string[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: () => Promise.reject(new Error('d1 down')),
      send: async () => undefined,
      log: (line) => logs.push(line),
    });
    expect(result).toEqual({ sent: true });
    expect(calls[0]?.tag).toBeUndefined();
    expect(logs.join('')).toContain('[voice] 读取语气提示词失败');
  });

  it('判断模型失败（非 2xx）时退回固定提示词，不拖住语音', async () => {
    const { tts, calls } = fakeTts();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('judge down', { status: 500 }))));
    await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: async (): Promise<string> => '平静',
      judge: { url: 'https://judge.example/v1', key: 'sk-judge', model: 'judge-1' },
      send: async () => undefined,
    });
    expect(calls[0]?.tag).toBe('(平静)');
  });

  it('judge 往正文里插 [轻笑]：念的是插过标签的正文，标签也照带', async () => {
    const { tts, calls } = fakeTts();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '(怅然)晚上好[轻笑]' } }] }), {
            status: 200,
          }),
        ),
      ),
    );
    await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: async (): Promise<string> => '',
      judge: { url: 'https://judge.example/v1', key: 'sk-judge', model: 'judge-1' },
      send: async () => undefined,
    });
    expect(calls).toEqual([{ text: '晚上好[轻笑]', speed: VOICE_SPEED_DEFAULT, tag: '(怅然)' }]);
  });

  it('judge 改了一个字：正文退回原文，judge 给的标签留下，语音照发', async () => {
    const { tts, calls } = fakeTts();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '(怅然)晚上好啊' } }] }), { status: 200 }),
        ),
      ),
    );
    await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: async (): Promise<string> => '',
      judge: { url: 'https://judge.example/v1', key: 'sk-judge', model: 'judge-1' },
      send: async () => undefined,
    });
    // 标签留下：多抄一个字不该让整条语气消失；改过的正文一个字都不念
    expect(calls).toEqual([{ text: '晚上好', speed: VOICE_SPEED_DEFAULT, tag: '(怅然)' }]);
  });

  it('不满足发送条件时根本不取提示词（省一次读库）', async () => {
    const { tts, calls } = fakeTts();
    let asked = 0;
    const result = await maybeSendVoice({
      settings: settingsOf({ mode: VOICE_MODE_ON_REQUEST }),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: async (): Promise<string> => {
        asked += 1;
        return '温柔';
      },
      send: async () => undefined,
    });
    expect(result).toEqual({ sent: false });
    expect(asked).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('maybeSendVoice 的失败兜底', () => {
  it('TTS 抛错：不抛出去，返回 sent:false，并记一条 warn', async () => {
    const { tts } = fakeTts(true);
    const logs: string[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '你好',
      wanted: false,
      send: async () => undefined,
      log: (line) => logs.push(line),
    });
    expect(result).toEqual({ sent: false });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[voice] 语音发送失败');
  });

  it('上传失败同样只 warn：回复已经发出去，不能再失败一次', async () => {
    const { tts } = fakeTts();
    const logs: string[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '你好',
      wanted: false,
      send: async () => {
        throw new Error('discord HTTP 403: missing access');
      },
      log: (line) => logs.push(line),
    });
    expect(result).toEqual({ sent: false });
    expect(logs[0]).toContain('discord HTTP 403');
  });
});

describe('maybeSendVoice 念的文本', () => {
  it('正文多长都念完，不按字数截断', async () => {
    const { tts, calls } = fakeTts();
    await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '好'.repeat(900),
      wanted: false,
      send: async () => undefined,
    });
    expect(Array.from(calls[0]?.text ?? '').length).toBe(900);
  });

  it('剥掉提及与 markdown 记号再念', async () => {
    const { tts, calls } = fakeTts();
    await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '  <@123> **你好** __世界__ ',
      wanted: false,
      send: async () => undefined,
    });
    expect(calls[0]?.text).toBe('你好 世界');
  });

  it('念不出内容（纯提及）时连合成都不调', async () => {
    const { tts, calls } = fakeTts();
    const result = await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '<@123>',
      wanted: false,
      send: async () => undefined,
    });
    expect(result).toEqual({ sent: false });
    expect(calls).toEqual([]);
  });
});

describe('maybeSendVoice 的成功日志', () => {
  it('成功时留一条 info：只有标签、字节数、字数、模式、导演档位，不含正文', async () => {
    const { tts } = fakeTts();
    const info: string[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf({ mode: VOICE_MODE_ALWAYS }),
      tts,
      text: '你好',
      wanted: false,
      send: async () => undefined,
      logInfo: (line) => {
        info.push(line);
      },
    });
    expect(result).toEqual({ sent: true });
    expect(info).toEqual([
      '[voice] 已发送 tag=无 bytes=3 字数=2 mode=' + String(VOICE_MODE_ALWAYS) + ' director=0',
    ]);
    expect(info[0]).not.toContain('你好');
  });

  it('合成失败只留 warn，不写成功行', async () => {
    const { tts } = fakeTts(true);
    const info: string[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '你好',
      wanted: false,
      send: async () => undefined,
      log: () => undefined,
      logInfo: (line) => {
        info.push(line);
      },
    });
    expect(result).toEqual({ sent: false });
    expect(info).toEqual([]);
  });

  it('日志出口自己抛错也不把这条语音变成失败', async () => {
    const { tts } = fakeTts();
    const result = await maybeSendVoice({
      settings: settingsOf(),
      tts,
      text: '你好',
      wanted: false,
      send: async () => undefined,
      logInfo: () => {
        throw new Error('log sink down');
      },
    });
    expect(result).toEqual({ sent: true });
  });
});

describe('maybeSendVoice 的导演模式', () => {
  const JUDGE = { url: 'https://judge.example/v1', key: 'sk-judge', model: 'judge-1' };

  /** 判断模型回的那一行由用例写死；这里只验 director 如何影响合成与日志 */
  function stubJudge(line: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: line } }] }), { status: 200 }),
        ),
      ),
    );
  }

  it('director 1：整行含标签送去合成，tag 不再当前缀，日志的 tag 取 styleLabel', async () => {
    const { tts, calls } = fakeTts();
    const rewritten = '（紧张，深呼吸）晚上好[轻笑]';
    stubJudge(rewritten);
    const info: string[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf({ director: VOICE_DIRECTOR_TAGS }),
      tts,
      text: '晚上好',
      wanted: false,
      judge: JUDGE,
      send: async () => undefined,
      logInfo: (line) => {
        info.push(line);
      },
    });
    expect(result).toEqual({ sent: true });
    // 风格组只在正文开头出现一次：tag 必须为空，否则 mimo 会把它念两遍
    expect(calls).toEqual([{ text: rewritten, speed: VOICE_SPEED_DEFAULT }]);
    expect(info).toEqual([
      '[voice] 已发送 tag=（紧张，深呼吸） bytes=3 字数=' +
        String(Array.from(rewritten).length) +
        ' mode=' +
        String(VOICE_MODE_ALWAYS) +
        ' director=' +
        String(VOICE_DIRECTOR_TAGS) +
        ' judge=' +
        rewritten,
    ]);
  });

  it('director 2：接受改写，字数按改写后的文本算而不是原文', async () => {
    const { tts, calls } = fakeTts();
    const rewritten = '（怅然）晚上好呀，今天也辛苦了。';
    stubJudge(rewritten);
    const info: string[] = [];
    await maybeSendVoice({
      settings: settingsOf({ director: VOICE_DIRECTOR_FREE }),
      tts,
      text: '晚上好',
      wanted: false,
      judge: JUDGE,
      send: async () => undefined,
      logInfo: (line) => {
        info.push(line);
      },
    });
    expect(calls).toEqual([{ text: rewritten, speed: VOICE_SPEED_DEFAULT }]);
    expect(info[0]).toContain(' 字数=' + String(Array.from(rewritten).length) + ' ');
    // 原文只有 3 字：字数若按原文算就说明记错了那份文本
    expect(info[0]).not.toContain(' 字数=3 ');
    expect(info[0]).toContain(' director=' + String(VOICE_DIRECTOR_FREE));
    // 导演档具体怎么写的是排查的关键：日志把 judge 那一行原样带上
    expect(info[0]).toContain(' judge=' + rewritten);
  });

  it('director 1 改了一个字：念原文，风格组留在日志的 tag 里', async () => {
    const { tts, calls } = fakeTts();
    stubJudge('（紧张）晚上好啊');
    const info: string[] = [];
    await maybeSendVoice({
      settings: settingsOf({ director: VOICE_DIRECTOR_TAGS }),
      tts,
      text: '晚上好',
      wanted: false,
      judge: JUDGE,
      send: async () => undefined,
      logInfo: (line) => {
        info.push(line);
      },
    });
    // 一个字的差错就退回原文；没有提示词时 tag 仍是老语义的空串
    expect(calls).toEqual([{ text: '晚上好', speed: VOICE_SPEED_DEFAULT }]);
    expect(info).toEqual([
      '[voice] 已发送 tag=（紧张） bytes=3 字数=3 mode=' +
        String(VOICE_MODE_ALWAYS) +
        ' director=1 rejected=verbatim judge=（紧张）晚上好啊',
    ]);
  });

  it('director 2 判断失败：退回原文照发，不把这条回复弄失败', async () => {
    const { tts, calls } = fakeTts();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('judge down', { status: 500 }))));
    const info: string[] = [];
    const result = await maybeSendVoice({
      settings: settingsOf({ director: VOICE_DIRECTOR_FREE }),
      tts,
      text: '晚上好',
      wanted: false,
      stylePrompt: async (): Promise<string> => '平静',
      judge: JUDGE,
      send: async () => undefined,
      logInfo: (line) => {
        info.push(line);
      },
    });
    expect(result).toEqual({ sent: true });
    expect(calls).toEqual([{ text: '晚上好', speed: VOICE_SPEED_DEFAULT, tag: '(平静)' }]);
    expect(info).toEqual([
      '[voice] 已发送 tag=(平静) bytes=3 字数=3 mode=' +
        String(VOICE_MODE_ALWAYS) +
        ' director=2 rejected=judge',
    ]);
  });
});
