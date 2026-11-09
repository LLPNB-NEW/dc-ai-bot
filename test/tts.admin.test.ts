import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_MODE_ALWAYS, VOICE_SPEED_DEFAULT } from '../src/core/voice/settings';
import { JUDGE_SYSTEM, TTS_STYLE_MAX_CHARS } from '../src/core/voice/style';
import { createStoredTts } from '../src/core/voice/tts';
import { maybeSendVoice } from '../src/workers/discord/voice-reply';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';

const MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const APP_VERSION = '0.1.0-test';
const FIRST_KEY = 'sk-tts-secret-ab12';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 仓储留在外面：断言「省略 key 时密文没被覆盖」得直接解一次库 */
function makeApp(options: { ttsEnvPresent?: boolean } = {}) {
  const repos = createRepositories(env.DB, createSecretBox(MASTER_KEY));
  const deps: AdminAppDeps = {
    ...repos,
    logs: createLogStore(env.DB),
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: APP_VERSION,
    ...(options.ttsEnvPresent === undefined ? {} : { ttsEnvPresent: options.ttsEnvPresent }),
  };
  return { app: createAdminApp(deps), repos };
}

type App = ReturnType<typeof makeApp>['app'];

async function send(app: App, method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

async function login(app: App): Promise<string> {
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return 'admin_session=' + value;
}

type Json = Record<string, unknown>;

async function jsonOf(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function getSettings(app: App, cookie: string): Promise<Json> {
  const res = await send(app, 'GET', '/api/tts-settings', undefined, cookie);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

async function putSettings(app: App, cookie: string, body: unknown): Promise<Response> {
  return send(app, 'PUT', '/api/tts-settings', body, cookie);
}

/** 假 mp3：4 个字节足够验证 base64 往返 */
const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

function stubTtsFetch(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(() => Promise.resolve(new Response(FAKE_MP3, { status: 200 })));
  vi.stubGlobal('fetch', stub);
  return stub;
}

/** MiMo 的响应形状：音频是 JSON 里 base64 的 choices[0].message.audio.data */
function stubMimoFetch(data: string): ReturnType<typeof vi.fn> {
  const stub = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { audio: { data } } }] }), { status: 200 })),
  );
  vi.stubGlobal('fetch', stub);
  return stub;
}

/** 响应里的 audioBase64 解回字节，用来验证 bytes 与音频内容对得上 */
function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM tts_settings'), env.DB.prepare('DELETE FROM tts_style_prompts')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/tts-settings', () => {
  it('未登录 401', async () => {
    const { app } = makeApp();
    const res = await send(app, 'GET', '/api/tts-settings');
    expect(res.status).toBe(401);
  });

  it('未配置时也给出完整形状：configured:false + 默认方言 openai', async () => {
    const { app } = makeApp();
    const body = await getSettings(app, await login(app));
    expect(body.configured).toBe(false);
    expect(body.dialect).toBe('openai');
    expect(body.url).toBe('');
    expect(body.keyHint).toBe('');
    // model 不再暴露：顶层、defaults 顶层与 dialects 每项都不该再出现它
    expect('model' in body).toBe(false);
    expect(body.voice).toBe('');
    expect(body.judgeUrl).toBe('');
    expect(body.judgeKeyHint).toBe('');
    expect(body.judgeModel).toBe('');
    expect(body.judgeConfigured).toBe(false);
    expect(body.updatedAt).toBe('');
    expect(body.envPresent).toBe(false);
    // 顶层字段仍是 openai 那份（老前端只认它们），方言清单另给一份
    expect(body.defaults).toEqual({
      urlPlaceholder: 'https://api.openai.com/v1',
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      dialects: [
        {
          id: 'openai',
          label: 'OpenAI 兼容（/audio/speech）',
          urlPlaceholder: 'https://api.openai.com/v1',
          voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
        },
        {
          id: 'mimo',
          label: '小米 MiMo（chat/completions）',
          urlPlaceholder: 'https://api.xiaomimimo.com/v1',
          voices: ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
        },
        {
          id: 'gemini',
          label: 'Gemini（/audio/speech，WAV）',
          urlPlaceholder: 'https://example.com/pg/v1',
          voices: [
            'Kore',
            'Puck',
            'Charon',
            'Fenrir',
            'Aoede',
            'Leda',
            'Orus',
            'Zephyr',
            'Callirrhoe',
            'Autonoe',
            'Enceladus',
            'Iapetus',
            'Umbriel',
            'Algieba',
            'Despina',
            'Erinome',
            'Algenib',
            'Rasalgethi',
            'Laomedeia',
            'Achernar',
            'Alnilam',
            'Schedar',
            'Gacrux',
            'Pulcherrima',
            'Achird',
            'Zubenelgenubi',
            'Vindemiatrix',
            'Sadachbia',
            'Sadaltager',
            'Sulafat',
          ],
        },
      ],
      defaultDialect: 'openai',
    });
    expect(JSON.stringify(body.defaults).includes('"model"')).toBe(false);
  });

  it('envPresent 只反映服务器上是否还留着老环境变量', async () => {
    const { app } = makeApp({ ttsEnvPresent: true });
    const body = await getSettings(app, await login(app));
    expect(body.configured).toBe(false);
    expect(body.envPresent).toBe(true);
  });
});

describe('PUT /api/tts-settings', () => {
  it('首次不带 key → 400 BAD_TTS_KEY', async () => {
    const { app } = makeApp();
    const res = await putSettings(app, await login(app), { url: 'https://tts.example/v1' });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_KEY' });
  });

  it('不传 dialect 就存成 openai（老前端行为不变）', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    const res = await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).dialect).toBe('openai');
    expect((await repos.ttsSettings.get())?.dialect).toBe('openai');
  });

  it('切到 mimo：方言、地址一起存下，GET 原样回显且不带 model', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    const res = await putSettings(app, cookie, {
      dialect: 'mimo',
      url: 'https://api.xiaomimimo.com/v1',
      key: 'sk-mimo-0001',
      model: '',
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).dialect).toBe('mimo');

    const read = await getSettings(app, cookie);
    expect(read.dialect).toBe('mimo');
    expect(read.url).toBe('https://api.xiaomimimo.com/v1');
    expect('model' in read).toBe(false);
    // PUT 不再接受 model：库里的历史列保持空串，运行时按方言补内置默认
    expect((await repos.ttsSettings.get())?.model).toBe('');
  });

  it('dialect 非法 → 400 BAD_TTS_DIALECT，且什么都不落库', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    const res = await putSettings(app, cookie, { dialect: 'nope', url: 'https://tts.example/v1', key: FIRST_KEY });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_DIALECT' });
    expect(await repos.ttsSettings.get()).toBeNull();
  });

  it('url 先于 dialect 报错：两者都坏时回 BAD_TTS_URL', async () => {
    const { app } = makeApp();
    const res = await putSettings(app, await login(app), { dialect: 'nope', url: 'ftp://x' });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_URL' });
  });

  it('带 key 保存后 GET 只有掩码，明文一个字节都不回', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    const res = await putSettings(app, cookie, {
      url: 'https://tts.example/v1',
      key: FIRST_KEY,
      model: 'tts-1-hd',
      voice: 'nova',
    });
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    expect(saved.configured).toBe(true);
    expect(saved.keyHint).toBe('…ab12');
    expect(JSON.stringify(saved).includes(FIRST_KEY)).toBe(false);

    const read = await getSettings(app, cookie);
    expect(read.configured).toBe(true);
    expect(read.url).toBe('https://tts.example/v1');
    expect('model' in read).toBe(false);
    expect(read.voice).toBe('nova');
    expect(JSON.stringify(read).includes(FIRST_KEY)).toBe(false);
  });

  it('第二次省略 key 只改 url：密文与掩码都保持第一把', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    expect((await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY })).status).toBe(200);

    const res = await putSettings(app, cookie, { url: 'https://tts2.example/v1', model: 'tts-1', voice: '' });
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    expect(saved.keyHint).toBe('…ab12');
    expect(saved.url).toBe('https://tts2.example/v1');

    const stored = await repos.ttsSettings.get();
    expect(stored?.key).toBe(FIRST_KEY);
    expect(stored?.url).toBe('https://tts2.example/v1');
    // 单行表：第二次保存也是改那一行
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM tts_settings').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('url 不是 http/https → 400 BAD_TTS_URL（空串与超长同罪）', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    for (const url of ['ftp://x', '', '   ', 'not-a-url', 'https://' + 'a'.repeat(500)]) {
      const res = await putSettings(app, cookie, { url, key: FIRST_KEY });
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_URL' });
    }
  });

  it('model 传了就忽略（不报错、也不写库）；voice 超过 100 字仍是 400 BAD_REQUEST', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    const res = await putSettings(app, cookie, {
      url: 'https://tts.example/v1',
      key: FIRST_KEY,
      model: 'm'.repeat(101),
    });
    expect(res.status).toBe(200);
    expect('model' in (await jsonOf(res))).toBe(false);
    expect((await repos.ttsSettings.get())?.model).toBe('');

    // PUT 的 url 仍是每次必填（既有契约），所以这里也带上合法 url
    const tooLongVoice = await putSettings(app, cookie, { url: 'https://tts.example/v1', voice: 'v'.repeat(101) });
    expect(tooLongVoice.status).toBe(400);
    expect(await jsonOf(tooLongVoice)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('空白 voice 按空串存；put 不带 judge 字段时保留旧值', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      url: 'https://tts.example/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-1',
      judgeModel: 'judge-1',
    });
    await putSettings(app, cookie, { voice: '  ' });
    const stored = await repos.ttsSettings.get();
    expect(stored?.voice).toBe('');
    // 契约之外的保守处理：省略 judge 字段 = 保留旧值，老前端保存不会顺手清掉判断模型
    expect(stored?.judgeUrl).toBe('https://judge.example/v1');
    expect(stored?.judgeModel).toBe('judge-1');
    expect(stored?.judgeKey).toBe('sk-judge-1');
  });

  it('judgeUrl 不是 http/https 或超过 500 字 → 400 BAD_TTS_JUDGE', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    for (const judgeUrl of ['ftp://x', 'not-a-url', 'https://' + 'a'.repeat(500)]) {
      const res = await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY, judgeUrl });
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_JUDGE' });
    }
    expect(await repos.ttsSettings.get()).toBeNull();
  });

  it('judgeKey / judgeModel 超长或类型不对 → 400 BAD_TTS_JUDGE', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });
    for (const body of [
      { judgeKey: 'k'.repeat(501) },
      { judgeModel: 'm'.repeat(101) },
      { judgeUrl: 123 },
      // null 在老接口里与「没给」等价（readOptionalString 的既有语义），不算类型错误
      { judgeKey: 123 },
      { judgeModel: ['judge-1'] },
    ]) {
      const res = await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY, ...body });
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_JUDGE' });
    }
  });

  it('保存 judge 三字段后 GET 只回掩码与 judgeConfigured:true，明文一个字节都不回', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      url: 'https://tts.example/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-secret-9999',
      judgeModel: 'judge-1',
    });

    const read = await getSettings(app, cookie);
    expect(read.judgeUrl).toBe('https://judge.example/v1');
    expect(read.judgeKeyHint).toBe('…9999');
    expect(read.judgeModel).toBe('judge-1');
    expect(read.judgeConfigured).toBe(true);
    expect(JSON.stringify(read).includes('sk-judge-secret-9999')).toBe(false);
    expect((await repos.ttsSettings.get())?.judgeKey).toBe('sk-judge-secret-9999');
  });

  it('第二次省略 judgeKey 只改地址：密文与掩码都保持第一把', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      url: 'https://tts.example/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-secret-9999',
      judgeModel: 'judge-1',
    });
    const res = await putSettings(app, cookie, { url: 'https://tts2.example/v1', judgeUrl: 'https://judge2.example/v1' });
    expect(res.status).toBe(200);
    const saved = await jsonOf(res);
    expect(saved.judgeKeyHint).toBe('…9999');
    expect(saved.judgeUrl).toBe('https://judge2.example/v1');

    const stored = await repos.ttsSettings.get();
    expect(stored?.judgeKey).toBe('sk-judge-secret-9999');
    expect(stored?.judgeUrl).toBe('https://judge2.example/v1');
    expect(stored?.judgeModel).toBe('judge-1');
  });

  it('judgeUrl / judgeModel 传空串、judgeKey 空白：judgeConfigured 变 false', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      url: 'https://tts.example/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-secret-9999',
      judgeModel: 'judge-1',
    });
    const res = await putSettings(app, cookie, {
      url: 'https://tts.example/v1',
      judgeUrl: '',
      judgeModel: '',
      judgeKey: '   ',
    });
    expect(res.status).toBe(200);
    const read = await getSettings(app, cookie);
    expect(read.judgeUrl).toBe('');
    expect(read.judgeModel).toBe('');
    expect(read.judgeConfigured).toBe(false);
  });
});

describe('DELETE /api/tts-settings', () => {
  it('删整行 = 回到未配置', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });

    const res = await send(app, 'DELETE', '/api/tts-settings', undefined, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect((await getSettings(app, cookie)).configured).toBe(false);
    expect(await repos.ttsSettings.get()).toBeNull();
  });
});

describe('POST /api/tts-settings/test', () => {
  it('未配置 → 400 TTS_NOT_CONFIGURED', async () => {
    const { app } = makeApp();
    const res = await send(app, 'POST', '/api/tts-settings/test', {}, await login(app));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('TTS_NOT_CONFIGURED');
  });

  it('成功：假 mp3 原样回 base64，openai 方言的 contentType 是 audio/mpeg', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });
    const stub = stubTtsFetch();

    const res = await send(app, 'POST', '/api/tts-settings/test', {}, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(FAKE_MP3.length);
    expect(body.contentType).toBe('audio/mpeg');
    expect(typeof body.durationMs).toBe('number');
    const decoded = Uint8Array.from(atob(String(body.audioBase64)), (ch) => ch.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(FAKE_MP3));

    // 缺省文案就是那句固定中文短句，请求也真的发出去了
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('body 里给的字段优先于库里的（可只测未保存的配置）；model 传了也忽略', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });
    const stub = stubTtsFetch();

    const res = await send(
      app,
      'POST',
      '/api/tts-settings/test',
      { url: 'https://other.example/v1', key: 'sk-other-9999', model: 'tts-1-hd', text: '嗯' },
      cookie,
    );
    expect(res.status).toBe(200);
    const call = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://other.example/v1/audio/speech');
    const sent = JSON.parse(String(call[1].body)) as Json;
    expect(sent['input']).toBe('嗯');
    // model 不再是入参：body 里给 tts-1-hd 也不生效，始终是方言内置默认
    expect(sent['model']).toBe('tts-1');
    // openai 方言回归：音频形状没被 MiMo 改动带偏
    expect(sent['response_format']).toBe('mp3');
    expect(sent['speed']).toBe(1);
  });

  it('text 原样进合成，不按字数截断', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });
    const stub = stubTtsFetch();

    await send(app, 'POST', '/api/tts-settings/test', { text: '啊'.repeat(250) }, cookie);
    const call = stub.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(call[1].body)) as Json;
    expect(Array.from(String(sent['input'])).length).toBe(250);
  });

  it('上游 500 → 502 TTS_UPSTREAM，带耗时与原因', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))));

    const res = await send(app, 'POST', '/api/tts-settings/test', {}, cookie);
    expect(res.status).toBe(502);
    const body = await jsonOf(res);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('TTS_UPSTREAM');
    expect(typeof body.durationMs).toBe('number');
    expect(String(body.message)).toContain('TTS_HTTP 500');
  });

  it('mimo 方言：打到 /chat/completions，body 按 MiMo 形状、默认模型且没有 speed', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      dialect: 'mimo',
      url: 'https://api.xiaomimimo.com/v1',
      key: FIRST_KEY,
      model: '',
      voice: '',
    });
    const audio = new TextEncoder().encode('ID3xyz');
    const stub = stubMimoFetch(toBase64(audio));

    // body 不带 dialect 时用库里存的那份（mimo），不是回落 openai
    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安' }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(audio.length);
    expect(body.contentType).toBe('audio/mpeg');
    expect(Array.from(decodeBase64(String(body.audioBase64)))).toEqual(Array.from(audio));

    const call = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    const sent = JSON.parse(String(call[1].body)) as Json;
    expect(sent['model']).toBe('mimo-v2.5-tts');
    expect(sent['messages']).toEqual([{ role: 'assistant', content: '晚安' }]);
    expect(sent['audio']).toEqual({ format: 'mp3' });
    expect('speed' in sent).toBe(false);
    // 没给 style、也没配 judge：本次没有语气指令
    expect(body.styleUsed).toBeNull();
  });

  it('gemini 方言：打到 /audio/speech，body 是 wav 契约，试听 contentType 跟着端口变 audio/wav', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      dialect: 'gemini',
      url: 'https://relay.example/pg/v1',
      key: FIRST_KEY,
      model: '',
      voice: 'Kore',
    });
    // 一段 RIFF/WAVE 头（fmt 块到一半）：足够验证「原样 base64 往返」与 contentType
    const audio = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
      0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x5d, 0x00, 0x00, 0x80, 0xbb, 0x00, 0x00,
      0x02, 0x00, 0x10, 0x00,
    ]);
    const stub = vi.fn(() => Promise.resolve(new Response(audio, { status: 200 })));
    vi.stubGlobal('fetch', stub);

    // body 不带 dialect 时用库里存的那份（gemini），不是回落 openai
    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安' }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(audio.length);
    expect(body.contentType).toBe('audio/wav');
    expect(Array.from(decodeBase64(String(body.audioBase64)))).toEqual(Array.from(audio));

    const call = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://relay.example/pg/v1/audio/speech');
    const sent = JSON.parse(String(call[1].body)) as Json;
    expect(sent['model']).toBe('gemini-3.8-flash-tts');
    expect(sent['input']).toBe('晚安');
    expect(sent['response_format']).toBe('wav');
    expect(sent['voice']).toBe('Kore');
    expect('speed' in sent).toBe(false);
  });

  it('body 给了 style 就归一化成标签：mimo 只有一条 assistant，content 是 (温柔一点)+正文', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { dialect: 'mimo', url: 'https://api.xiaomimimo.com/v1', key: FIRST_KEY });
    const audio = new TextEncoder().encode('ID3xyz');
    const stub = stubMimoFetch(toBase64(audio));

    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安', style: '  温柔一点  ' }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // 给了 style：它只当标签用，正文一个字都不动
    expect(body.styleUsed).toBe('(温柔一点)');
    expect(body.speechUsed).toBe('晚安');

    const call = stub.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(call[1].body)) as Json;
    expect(sent['messages']).toEqual([{ role: 'assistant', content: '(温柔一点)晚安' }]);
  });

  it('body 的 style 已经是括号形状时不会套两层', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { dialect: 'mimo', url: 'https://api.xiaomimimo.com/v1', key: FIRST_KEY });
    const stub = stubMimoFetch(toBase64(new TextEncoder().encode('ID3xyz')));

    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安', style: '（怅然）' }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.styleUsed).toBe('(怅然)');
    const call = stub.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(call[1].body)) as Json;
    expect(sent['messages']).toEqual([{ role: 'assistant', content: '(怅然)晚安' }]);
  });

  it('没给 style 就按 global 提示词 + 库里 judge 现算一次，styleUsed 回标签、speechUsed 回正文', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      dialect: 'mimo',
      url: 'https://api.xiaomimimo.com/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-secret',
      judgeModel: 'judge-1',
    });
    await repos.ttsStyles.put({ scope: 'global', scopeId: '', content: '温柔一点' });
    const audio = new TextEncoder().encode('ID3xyz');
    const stub = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://judge.example')) {
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '「轻快地说」' } }] }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: toBase64(audio) } } }] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', stub);

    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安' }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.styleUsed).toBe('(轻快地说)');
    expect(body.speechUsed).toBe('晚安');
    // judge 那一行原样带回：导演档退回时靠它看出模型到底写了什么
    expect(body.judgeLine).toBe('轻快地说');

    // 第一次请求是 judge：global 提示词拼在内置系统指令后面
    const judgeCall = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(judgeCall[0]).toBe('https://judge.example/v1/chat/completions');
    const judgeBody = JSON.parse(String(judgeCall[1].body)) as Json;
    expect((judgeBody['messages'] as Json[])[0]).toEqual({
      role: 'system',
      content: JUDGE_SYSTEM + '\n【风格要求】温柔一点',
    });

    // 第二次才是合成：标签与正文同在一条 assistant 里
    const ttsCall = stub.mock.calls[1] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(ttsCall[1].body)) as Json;
    expect(sent['messages']).toEqual([{ role: 'assistant', content: '(轻快地说)晚安' }]);
  });

  it('director=2 时试听走导演提示词：speechUsed 是改写后的整行，styleUsed 为空', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      dialect: 'mimo',
      url: 'https://api.xiaomimimo.com/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-secret',
      judgeModel: 'judge-1',
    });
    await repos.ttsStyles.put({ scope: 'global', scopeId: '', content: '温柔一点' });
    const stub = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://judge.example')) {
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '(温柔 低语) 晚安安，早点睡呀。' } }] }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: toBase64(FAKE_MP3) } } }] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', stub);

    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安', director: 2 }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['director']).toBe(2);
    expect(body['directorRejected']).toBe(null);
    expect(body['speechUsed']).toBe('(温柔 低语) 晚安安，早点睡呀。');
    expect(body['styleUsed']).toBe(null);
    expect(body['judgeLine']).toBe('(温柔 低语) 晚安安，早点睡呀。');

    const judgeBody = JSON.parse(String((stub.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Json;
    const system = String(((judgeBody['messages'] as Json[])[0] as Json)['content']);
    expect(system).toContain('口语化改写');
  });

  it('导演档退回时把 judge 原话一起带回：看得出是没写、写歪还是没答上来', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      dialect: 'mimo',
      url: 'https://api.xiaomimimo.com/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-secret',
      judgeModel: 'judge-1',
    });
    await repos.ttsStyles.put({ scope: 'global', scopeId: '', content: '温柔一点' });
    const stub = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://judge.example')) {
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '(温柔) 晚安呀' } }] }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: toBase64(FAKE_MP3) } } }] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', stub);

    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安', director: 1 }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['director']).toBe(1);
    expect(body['directorRejected']).toBe('verbatim');
    expect(body['speechUsed']).toBe('晚安');
    expect(body['judgeLine']).toBe('(温柔) 晚安呀');
  });

  it('director 不是 0/1/2 时试听回 400 BAD_DIRECTOR_MODE', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      dialect: 'mimo',
      url: 'https://api.xiaomimimo.com/v1',
      key: FIRST_KEY,
    });
    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安', director: 5 }, cookie);
    expect(res.status).toBe(400);
    expect((await jsonOf(res))['error']).toBe('BAD_DIRECTOR_MODE');
  });

  it('judge 插了 [音频标签]：speechUsed 带插入段，styleUsed 是括号标签', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, {
      dialect: 'mimo',
      url: 'https://api.xiaomimimo.com/v1',
      key: FIRST_KEY,
      judgeUrl: 'https://judge.example/v1',
      judgeKey: 'sk-judge-secret',
      judgeModel: 'judge-1',
    });
    await repos.ttsStyles.put({ scope: 'global', scopeId: '', content: '怅然' });
    const stub = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://judge.example')) {
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '(怅然)晚安[轻笑]' } }] }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: toBase64(FAKE_MP3) } } }] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', stub);

    const res = await send(app, 'POST', '/api/tts-settings/test', { text: '晚安' }, cookie);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.styleUsed).toBe('(怅然)');
    // [轻笑] 是 judge 插进去的音频标签，正文其余部分没变
    expect(body.speechUsed).toBe('晚安[轻笑]');

    const ttsCall = stub.mock.calls[1] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(ttsCall[1].body)) as Json;
    expect(sent['messages']).toEqual([{ role: 'assistant', content: '(怅然)晚安[轻笑]' }]);
  });

  it('style 超过 2000 字 → 400 BAD_TTS_STYLE', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    const res = await send(app, 'POST', '/api/tts-settings/test', { style: '啊'.repeat(TTS_STYLE_MAX_CHARS + 1) }, cookie);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_STYLE' });
  });

  it('mimo 上游 500 → 502 TTS_UPSTREAM', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('mimo down', { status: 500 }))));

    const res = await send(
      app,
      'POST',
      '/api/tts-settings/test',
      { dialect: 'mimo', url: 'https://api.xiaomimimo.com/v1', key: 'sk-mimo-0001' },
      cookie,
    );
    expect(res.status).toBe(502);
    const body = await jsonOf(res);
    expect(body.code).toBe('TTS_UPSTREAM');
    expect(String(body.message)).toContain('TTS_HTTP 500');
  });

  it('mimo 响应没有 audio.data → 502 且 message 含 TTS_BAD_RESPONSE', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }))),
    );

    const res = await send(
      app,
      'POST',
      '/api/tts-settings/test',
      { dialect: 'mimo', url: 'https://api.xiaomimimo.com/v1', key: 'sk-mimo-0001' },
      cookie,
    );
    expect(res.status).toBe(502);
    const body = await jsonOf(res);
    expect(body.code).toBe('TTS_UPSTREAM');
    expect(String(body.message)).toContain('TTS_BAD_RESPONSE');
  });

  it('test 端点 dialect 非法 → 400 BAD_TTS_DIALECT', async () => {
    const { app } = makeApp();
    const res = await send(
      app,
      'POST',
      '/api/tts-settings/test',
      { dialect: 'nope', url: 'https://tts.example/v1', key: FIRST_KEY },
      await login(app),
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_DIALECT' });
  });
});

describe('/api/tts-style 三层语气提示词', () => {
  it('未登录 401', async () => {
    const { app } = makeApp();
    expect((await send(app, 'GET', '/api/tts-style')).status).toBe(401);
  });

  it('GET 空表：items 为空数组，maxChars 固定 2000', async () => {
    const { app } = makeApp();
    const res = await send(app, 'GET', '/api/tts-style', undefined, await login(app));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ items: [], maxChars: TTS_STYLE_MAX_CHARS });
  });

  it('PUT：scope 非法 → 400 BAD_SCOPE；非 global 缺 scopeId → 400 BAD_REQUEST', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    const badScope = await send(app, 'PUT', '/api/tts-style', { scope: 'nope', scopeId: 'c1', content: '温柔' }, cookie);
    expect(badScope.status).toBe(400);
    expect(await jsonOf(badScope)).toEqual({ error: 'BAD_SCOPE' });

    const noId = await send(app, 'PUT', '/api/tts-style', { scope: 'channel', scopeId: '', content: '温柔' }, cookie);
    expect(noId.status).toBe(400);
    expect(await jsonOf(noId)).toEqual({ error: 'BAD_REQUEST' });
  });

  it('PUT：content 不是字符串或超过 2000 字 → 400 BAD_TTS_STYLE', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    for (const content of [123, null, ['x'], '啊'.repeat(TTS_STYLE_MAX_CHARS + 1)]) {
      const res = await send(app, 'PUT', '/api/tts-style', { scope: 'global', scopeId: '', content }, cookie);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: 'BAD_TTS_STYLE' });
    }
  });

  it('PUT 落库后 GET 按 channel → guild → global、再按 scopeId 排序', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    for (const body of [
      { scope: 'guild', scopeId: 'g2', content: '服务器' },
      { scope: 'channel', scopeId: 'c1', content: ' 频道一 ' },
      { scope: 'global', scopeId: '', content: '全局' },
      { scope: 'channel', scopeId: 'c0', content: '频道零' },
    ]) {
      expect((await send(app, 'PUT', '/api/tts-style', body, cookie)).status).toBe(200);
    }

    const res = await send(app, 'GET', '/api/tts-style', undefined, cookie);
    const body = await jsonOf(res);
    const items = body.items as Array<Record<string, string>>;
    expect(items.map((item) => item['scope'] + ':' + item['scopeId'])).toEqual([
      'channel:c0',
      'channel:c1',
      'guild:g2',
      'global:',
    ]);
    // 返回的是 trim 后的正文，与运行时读到的一致
    expect(items[1]?.['content']).toBe('频道一');
    expect(body.maxChars).toBe(TTS_STYLE_MAX_CHARS);
  });

  it('PUT trim 空 = 删这一层，回 removed:true', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await send(app, 'PUT', '/api/tts-style', { scope: 'global', scopeId: '', content: '全局' }, cookie);
    const res = await send(app, 'PUT', '/api/tts-style', { scope: 'global', scopeId: '', content: '   ' }, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, removed: true });
    expect((await jsonOf(await send(app, 'GET', '/api/tts-style', undefined, cookie))).items).toEqual([]);
  });

  it('DELETE：删掉该层回 ok:true；scope 非法 → 400 BAD_SCOPE', async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await send(app, 'PUT', '/api/tts-style', { scope: 'channel', scopeId: 'c1', content: '温柔' }, cookie);

    const res = await send(app, 'DELETE', '/api/tts-style?scope=channel&scopeId=c1', undefined, cookie);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect((await jsonOf(await send(app, 'GET', '/api/tts-style', undefined, cookie))).items).toEqual([]);

    const bad = await send(app, 'DELETE', '/api/tts-style?scope=nope', undefined, cookie);
    expect(bad.status).toBe(400);
    expect(await jsonOf(bad)).toEqual({ error: 'BAD_SCOPE' });
  });
});

describe('运行时：语音端口按配置现读', () => {
  it('配好了就合成并交给发送器', async () => {
    const { app, repos } = makeApp();
    const cookie = await login(app);
    await putSettings(app, cookie, { url: 'https://tts.example/v1', key: FIRST_KEY });
    stubTtsFetch();

    const sent: Uint8Array[] = [];
    const result = await maybeSendVoice({
      settings: { scope: 'global', scopeId: '', mode: VOICE_MODE_ALWAYS, voice: '', speed: VOICE_SPEED_DEFAULT, director: 0, updatedAt: '' },
      tts: createStoredTts(repos.ttsSettings),
      text: '你好',
      wanted: false,
      send: async (audio: Uint8Array): Promise<void> => {
        sent.push(audio);
      },
      log: (): void => undefined,
    });
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(Array.from(sent[0] as Uint8Array)).toEqual(Array.from(FAKE_MP3));
  });

  it('没配置就不发语音，调用方也不需要处理异常', async () => {
    const { repos } = makeApp();
    const logs: string[] = [];
    const sent: Uint8Array[] = [];
    const result = await maybeSendVoice({
      settings: { scope: 'global', scopeId: '', mode: VOICE_MODE_ALWAYS, voice: '', speed: VOICE_SPEED_DEFAULT, director: 0, updatedAt: '' },
      tts: createStoredTts(repos.ttsSettings),
      text: '你好',
      wanted: false,
      send: async (audio: Uint8Array): Promise<void> => {
        sent.push(audio);
      },
      log: (line: string): void => {
        logs.push(line);
      },
    });
    expect(result.sent).toBe(false);
    expect(sent).toHaveLength(0);
    expect(logs.join('')).toContain('TTS_NOT_CONFIGURED');
  });
});
