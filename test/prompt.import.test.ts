import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PromptConfig, PromptSegment } from '../src/core/types';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';
import { createLogStore } from '../src/workers/db/log-store';
import type { AdminAppDeps } from '../src/workers/http/app';
import { createAdminApp } from '../src/workers/http/app';

const MASTER_KEY = toBase64(new Uint8Array(32).fill(9));
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface AppOptions {
  /** 模拟装配层漏接线：可选端口整条删掉，导入不该因此失败 */
  withoutInjections?: boolean;
}

function makeApp(options: AppOptions = {}) {
  const repos = createRepositories(env.DB, createSecretBox(MASTER_KEY));
  const deps: AdminAppDeps = {
    ...repos,
    logs: createLogStore(env.DB),
    memoryDefaults: { historyMaxMessages: 50, summaryEveryMessages: 50 },
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    appVersion: '0.1.0-test',
  };
  if (options.withoutInjections === true) delete deps.promptInjections;
  return { app: createAdminApp(deps), repos };
}

type App = ReturnType<typeof makeApp>['app'];
type Repos = ReturnType<typeof makeApp>['repos'];

const JSON_HEADERS = { 'content-type': 'application/json' };

async function send(app: App, method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie !== undefined) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  // body 原样传字符串：BAD_PRESET 也要覆盖「请求体不是 JSON 对象」这种
  if (typeof body === 'string') init.body = body;
  else if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

type Json = Record<string, unknown>;

async function setup(options: AppOptions = {}) {
  const { app, repos } = makeApp(options);
  const res = await send(app, 'POST', '/api/login', { password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  const value = /admin_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (value === '') throw new Error('登录未拿到 admin_session');
  return { app, repos, cookie: 'admin_session=' + value };
}

/** 酒馆预设里的一条 prompt（字段名与真实导出文件一致） */
function stPrompt(
  identifier: string,
  name: string,
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { identifier, name, role: 'system', content, system_prompt: false, marker: false, ...extra };
}

/** prompt_order 只认 character_id 100000 那一组；顺序与启用状态都以它为准 */
function stPreset(
  prompts: Array<Record<string, unknown>>,
  order?: Array<{ identifier: string; enabled: boolean }>,
): Record<string, unknown> {
  const preset: Record<string, unknown> = { name: '测试预设', prompts };
  if (order !== undefined) preset['prompt_order'] = [{ character_id: 100000, order }];
  return preset;
}

function seg(id: string, content: string, extra: Partial<PromptSegment> = {}): PromptSegment {
  return { id, name: id, role: 'system', content, enabled: true, placement: 'before', position: 0, ...extra };
}

interface PresetRow {
  id: string;
  name: string;
  char_name: string;
  source_json: string;
  imported_at: string;
}

async function presetRows(): Promise<PresetRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, char_name, source_json, imported_at FROM prompt_presets ORDER BY id ASC',
  ).all<PresetRow>();
  return results ?? [];
}

type LayerScope = 'channel' | 'guild' | 'global';

async function layerConfig(repos: Repos, scope: LayerScope, scopeId: string): Promise<PromptConfig | null> {
  return repos.prompts.get({ scope, scopeId });
}

async function globalLayer(repos: Repos): Promise<PromptConfig | null> {
  return layerConfig(repos, 'global', '');
}

interface InjectionRow {
  content: string;
  depth: number;
  role: string;
}

/** 直接读表而不是走仓储：这条断言要盯的是「落库的那几个值」，不是读侧的兜底逻辑 */
async function injectionRows(scope: string, scopeId: string): Promise<InjectionRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT content, depth, role FROM prompt_injections WHERE scope = ? AND scope_id = ?',
  )
    .bind(scope, scopeId)
    .all<InjectionRow>();
  return results ?? [];
}

async function globalInjectionRows(): Promise<InjectionRow[]> {
  return injectionRows('global', '');
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prompts'),
    env.DB.prepare('DELETE FROM prompt_segments'),
    env.DB.prepare('DELETE FROM prompt_presets'),
    // 深度注入是导入的副作用：不清会把上一条用例写进去的正文带进下一条
    env.DB.prepare('DELETE FROM prompt_injections'),
  ]);
});

describe('POST /api/prompts/import', () => {
  it('200：整层覆盖 global 段、保留 temperature/maxTokens、返回摘要并落一行原始 JSON', async () => {
    const { app, repos, cookie } = await setup();
    // 覆盖前已有的 global 层：采样参数必须活下来，旧段必须被整体换掉
    const before: PromptConfig = {
      segments: [seg('old-main', '旧提示'), seg('old-extra', '旧补充', { position: 1 })],
      temperature: 0.85,
      maxTokens: 777,
    };
    await repos.prompts.put({ scope: 'global', scopeId: '' }, before);

    const preset = stPreset(
      [
        stPrompt('main', '主提示', '你是 {{char}}，用户是 {{user}}。'),
        stPrompt('charDescription', '角色卡描述', ''),
        stPrompt('chatHistory', '对话历史', '', { marker: true }),
        // 停用的段里写错宏不拦：它根本不进 prompt（与 PUT /api/prompts 同一口径）
        stPrompt('jailbreak', '越狱', '说点 {{bogus_macro}}'),
        stPrompt('nsfw', 'NSFW', '保持风格', { role: 'user' }),
      ],
      [
        { identifier: 'main', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: false },
        { identifier: 'nsfw', enabled: true },
      ],
    );

    const res = await send(app, 'POST', '/api/prompts/import', { preset, charName: '灵梦' }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(Object.keys(body).sort()).toEqual([
      'charName',
      'ignored',
      'injection',
      'moved',
      'replaced',
      'scope',
      'scopeId',
      'segments',
      'warnings',
    ]);
    expect(body['scope']).toBe('global');
    // 老请求仍写 global，响应把实际写入的层一并回出来（global 的 scopeId 恒为空串）
    expect(body['scopeId']).toBe('');
    expect(body['charName']).toBe('灵梦');
    // 旧层两段全被换掉
    expect(body['replaced']).toBe(2);
    // 标记段与空段仍要在 ignored 里点名（顺序跟 prompt_order 一致）；关着的段不再忽略
    expect(body['ignored']).toEqual([
      { identifier: 'charDescription', name: '角色卡描述', reason: 'empty' },
      { identifier: 'chatHistory', name: '对话历史', reason: 'marker' },
    ]);
    // 关着的段现在也导进来，所以它的宏照样映射：写错的宏在这里冒泡成警告，而不是等用户打开才炸
    expect(body['warnings']).toEqual(['unknown variable {{bogus_macro}}']);
    // 这份预设里没有启用着的历史后指令：两个新字段照常出现，但一个都没写
    expect(body['moved']).toEqual([]);
    expect(body['injection']).toEqual({ saved: false, chars: 0, replaced: false });
    expect(await globalInjectionRows()).toHaveLength(0);

    const segments = body['segments'] as PromptSegment[];
    expect(segments.map((item) => item.name)).toEqual(['主提示', '越狱', 'NSFW']);
    expect(segments.map((item) => item.position)).toEqual([0, 1, 2]);
    // 关着的越狱段照样落库，但保持停用
    expect(segments.map((item) => item.enabled)).toEqual([true, false, true]);
    expect(segments.map((item) => item.role)).toEqual(['system', 'system', 'user']);
    expect(segments.map((item) => item.placement)).toEqual(['before', 'before', 'before']);
    // 宏映射：{{char}} 换成 charName，{{user}} 换成库里认得的 {{user_name}}
    expect(segments[0]?.content).toBe('你是 灵梦，用户是 {{user_name}}。');
    expect(segments[1]?.content).toBe('说点 {{bogus_macro}}');
    expect(new Set(segments.map((item) => item.id)).size).toBe(3);

    const saved = await globalLayer(repos);
    expect(saved?.segments.map((item) => item.name)).toEqual(['主提示', '越狱', 'NSFW']);
    expect(saved?.segments.map((item) => item.enabled)).toEqual([true, false, true]);
    // 采样参数原样保留：导入不该把调好的 temperature/maxTokens 清空
    expect(saved?.temperature).toBe(0.85);
    expect(saved?.maxTokens).toBe(777);

    const rows = await presetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('latest');
    expect(rows[0]?.name).toBe('测试预设');
    expect(rows[0]?.char_name).toBe('灵梦');
    // 原文落库：后续阶段要按原结构读世界书与正则，不能被裁剪过
    expect(rows[0]?.source_json).toBe(JSON.stringify(preset));
    expect(rows[0]?.imported_at).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/);
  });

  it('再导一次：整层覆盖第二次，prompt_presets 仍只有一行且换成最新原文', async () => {
    const { app, repos, cookie } = await setup();
    const first = stPreset([stPrompt('main', '主提示', '第一次'), stPrompt('extra', '补充', '第二段')]);
    expect((await send(app, 'POST', '/api/prompts/import', { preset: first, charName: '灵梦' }, cookie)).status).toBe(200);

    const second = stPreset([stPrompt('main', '主提示', '第二次')]);
    const res = await send(app, 'POST', '/api/prompts/import', { preset: second, charName: '灵梦' }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    // 覆盖掉的是上一次导入的两段
    expect(body['replaced']).toBe(2);
    expect((body['segments'] as PromptSegment[]).map((item) => item.content)).toEqual(['第二次']);

    const rows = await presetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_json).toBe(JSON.stringify(second));
  });

  it('preset 缺失 / 不是对象 / 没有 prompts 数组 → 400 BAD_PRESET', async () => {
    const { app, cookie } = await setup();
    const cases: unknown[] = ['not json', {}, { preset: 'x' }, { preset: [] }, { preset: [1, 2] }, { preset: { prompts: 'nope' } }];

    for (const body of cases) {
      const res = await send(app, 'POST', '/api/prompts/import', body, cookie);
      expect(res.status).toBe(400);
      const json = (await res.json()) as Json;
      expect(json['error']).toBe('BAD_PRESET');
      expect(typeof json['detail']).toBe('string');
    }
    expect(await presetRows()).toHaveLength(0);
  });

  it('没有可用段 → 400 NO_SEGMENTS，且不动已有 global 层、不写存档', async () => {
    const { app, repos, cookie } = await setup();
    const before: PromptConfig = { segments: [seg('keep', '必须留着的旧提示')], temperature: 0.5 };
    await repos.prompts.put({ scope: 'global', scopeId: '' }, before);

    const preset = stPreset([stPrompt('empty', '空段', '   '), stPrompt('marker', '标记', '', { marker: true })]);
    const res = await send(app, 'POST', '/api/prompts/import', { preset, charName: '灵梦' }, cookie);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Json;
    expect(body['error']).toBe('NO_SEGMENTS');
    expect(typeof body['detail']).toBe('string');
    expect(await globalLayer(repos)).toEqual(before);
    expect(await presetRows()).toHaveLength(0);
  });

  it('启用段里出现白名单外的宏 → 400 UNKNOWN_TEMPLATE_VAR，与 PUT /api/prompts 同码', async () => {
    const { app, repos, cookie } = await setup();
    const preset = stPreset([stPrompt('main', '主提示', '你是 {{bot_name}}，也是 {{bogus}}')]);

    const res = await send(app, 'POST', '/api/prompts/import', { preset, charName: '灵梦' }, cookie);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Json;
    expect(body['error']).toBe('UNKNOWN_TEMPLATE_VAR');
    expect(body['vars']).toEqual(['bogus']);
    // 半截模板不许进库：段与存档都不写
    expect(await globalLayer(repos)).toBeNull();
    expect(await presetRows()).toHaveLength(0);
  });

  it('charName 缺省：接口不替用户编名字，响应里的 charName 就是空串', async () => {
    const { app, cookie } = await setup();
    const preset = stPreset([stPrompt('main', '主提示', '你是 {{bot_name}}')]);

    const res = await send(app, 'POST', '/api/prompts/import', { preset }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body['charName']).toBe('');
    expect((body['segments'] as PromptSegment[]).map((item) => item.content)).toEqual(['你是 {{bot_name}}']);
  });

  it('charName 缺省且段里写了 {{char}}：保留的宏过不了未知变量校验，整次拒绝', async () => {
    const { app, cookie } = await setup();
    const preset = stPreset([stPrompt('main', '主提示', '你是 {{char}}')]);

    const res = await send(app, 'POST', '/api/prompts/import', { preset }, cookie);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Json;
    expect(body['error']).toBe('UNKNOWN_TEMPLATE_VAR');
    expect(body['vars']).toEqual(['char']);
  });
});

describe('POST /api/prompts/import · 历史后指令写进 global 深度注入', () => {
  // 带一个 emoji：字数按码点算，按 UTF-16 长度会多报一位
  const POST_HISTORY = '继续游戏，别停 ✨';

  function presetWithPostHistory(content: string = POST_HISTORY): Record<string, unknown> {
    return stPreset(
      [stPrompt('main', '主提示', '你是 {{char}}。'), stPrompt('jailbreak', '继续游戏', content)],
      [
        { identifier: 'main', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ],
    );
  }

  it('有历史后指令：写 global 深度注入（depth 0 / system），响应报 moved 与码点字数', async () => {
    const { app, cookie } = await setup();

    const res = await send(app, 'POST', '/api/prompts/import', { preset: presetWithPostHistory(), charName: '灵梦' }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body['moved']).toEqual([{ identifier: 'jailbreak', name: '继续游戏' }]);
    expect(body['injection']).toEqual({ saved: true, chars: Array.from(POST_HISTORY).length, replaced: false });
    // 段表里只剩主提示：历史后指令换通道走，不再当成普通段发出去
    expect((body['segments'] as PromptSegment[]).map((item) => item.name)).toEqual(['主提示']);
    expect(await globalInjectionRows()).toEqual([{ content: POST_HISTORY, depth: 0, role: 'system' }]);
  });

  it('没有历史后指令：injection 全 false，原有 global 深度注入一字不动', async () => {
    const { app, repos, cookie } = await setup();
    await repos.promptInjections.put({ scope: 'global', scopeId: '', content: '用户手写的注入', depth: 3, role: 'user' });

    const preset = stPreset([stPrompt('main', '主提示', '你是 {{char}}。')]);
    const res = await send(app, 'POST', '/api/prompts/import', { preset, charName: '灵梦' }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body['moved']).toEqual([]);
    expect(body['injection']).toEqual({ saved: false, chars: 0, replaced: false });
    // 「这份预设没有 jailbreak」不等于「用户想关掉注入」：正文、深度、角色都得原样留着
    expect(await globalInjectionRows()).toEqual([{ content: '用户手写的注入', depth: 3, role: 'user' }]);
  });

  it('旧注入非空：replaced 报 true，正文与深度换成预设的这份', async () => {
    const { app, repos, cookie } = await setup();
    await repos.promptInjections.put({ scope: 'global', scopeId: '', content: '旧的深度注入', depth: 2, role: 'assistant' });

    const res = await send(app, 'POST', '/api/prompts/import', { preset: presetWithPostHistory(), charName: '灵梦' }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body['injection']).toEqual({ saved: true, chars: Array.from(POST_HISTORY).length, replaced: true });
    expect(await globalInjectionRows()).toEqual([{ content: POST_HISTORY, depth: 0, role: 'system' }]);
  });

  it('旧注入是空串：照常写入，但 replaced 报 false（空正文算没配置，不算覆盖）', async () => {
    const { app, repos, cookie } = await setup();
    await repos.promptInjections.put({ scope: 'global', scopeId: '', content: '', depth: 0, role: 'system' });

    const res = await send(app, 'POST', '/api/prompts/import', { preset: presetWithPostHistory(), charName: '灵梦' }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body['injection']).toEqual({ saved: true, chars: Array.from(POST_HISTORY).length, replaced: false });
  });

  it('deps.promptInjections 未接线：导入照常 200，injection.saved 为 false 且不写注入', async () => {
    const { app, cookie } = await setup({ withoutInjections: true });

    const res = await send(app, 'POST', '/api/prompts/import', { preset: presetWithPostHistory(), charName: '灵梦' }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    // moved 仍要报出来：页面靠它提示「去深度注入卡片手动保存」
    expect(body['moved']).toEqual([{ identifier: 'jailbreak', name: '继续游戏' }]);
    expect(body['injection']).toEqual({ saved: false, chars: 0, replaced: false });
    expect((body['segments'] as PromptSegment[]).map((item) => item.name)).toEqual(['主提示']);
    expect(await globalInjectionRows()).toHaveLength(0);
  });
});

describe('POST /api/prompts/import · 写入频道层与服务器层', () => {
  const CHANNEL_ID = '1200000000000000001';
  const GUILD_ID = '1300000000000000002';
  const POST_HISTORY = '继续游戏，别停 ✨';

  function presetWithPostHistory(content: string): Record<string, unknown> {
    return stPreset(
      [stPrompt('main', '主提示', '你是 {{char}}。'), stPrompt('jailbreak', '继续游戏', content)],
      [
        { identifier: 'main', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ],
    );
  }

  it('scope=channel + scopeId：段/注入/存档都落频道层，global 层与它的存档一行不动', async () => {
    const { app, repos, cookie } = await setup();
    const globalBefore: PromptConfig = { segments: [seg('g-old', '全局旧段')], temperature: 0.85, maxTokens: 777 };
    await repos.prompts.put({ scope: 'global', scopeId: '' }, globalBefore);
    const globalSource = JSON.stringify(stPreset([stPrompt('main', '全局主提示', '全局原文')]));
    await repos.presetImports.savePreset({ id: 'latest', name: '全局预设', charName: '灵梦', sourceJson: globalSource });
    // 频道层自己的采样参数：覆盖前按目标层读，不能拿 global 的顶上来
    await repos.prompts.put({ scope: 'channel', scopeId: CHANNEL_ID }, { segments: [seg('c-old', '频道旧段')], temperature: 0.4 });
    await repos.promptInjections.put({ scope: 'channel', scopeId: CHANNEL_ID, content: '频道旧注入', depth: 2, role: 'assistant' });

    const preset = presetWithPostHistory(POST_HISTORY);
    const res = await send(
      app,
      'POST',
      '/api/prompts/import',
      { preset, charName: '灵梦', scope: 'channel', scopeId: CHANNEL_ID },
      cookie,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body['scope']).toBe('channel');
    expect(body['scopeId']).toBe(CHANNEL_ID);
    // 覆盖掉的是频道层自己那一段，不是 global 的两段
    expect(body['replaced']).toBe(1);
    expect(body['injection']).toEqual({ saved: true, chars: Array.from(POST_HISTORY).length, replaced: true });

    const channel = await layerConfig(repos, 'channel', CHANNEL_ID);
    expect(channel?.segments.map((item) => item.name)).toEqual(['主提示']);
    // 采样参数按目标层继承：频道层的 0.4 留下，global 的 0.85 / 777 不上浮
    expect(channel?.temperature).toBe(0.4);
    expect(channel?.maxTokens).toBeUndefined();
    expect(await injectionRows('channel', CHANNEL_ID)).toEqual([{ content: POST_HISTORY, depth: 0, role: 'system' }]);

    // global 层与 global 的深度注入一个字节都没动
    expect(await globalLayer(repos)).toEqual(globalBefore);
    expect(await globalInjectionRows()).toHaveLength(0);

    // 存档按层分开：global 那行还是原来那份，频道层新开一行
    const rows = await presetRows();
    expect(rows.map((row) => row.id)).toEqual(['latest', 'latest:channel:' + CHANNEL_ID]);
    expect(rows[0]?.source_json).toBe(globalSource);
    expect(rows[1]?.source_json).toBe(JSON.stringify(preset));
    expect(rows[1]?.name).toBe('测试预设');
    expect(rows[1]?.char_name).toBe('灵梦');
  });

  it('scope=guild + scopeId：段落服务器层、存档 id 为 latest:guild:<id>，之后再导 global 两边互不覆盖', async () => {
    const { app, repos, cookie } = await setup();

    const preset = stPreset([stPrompt('main', '主提示', '服务器层提示')]);
    const res = await send(app, 'POST', '/api/prompts/import', { preset, charName: '灵梦', scope: 'guild', scopeId: GUILD_ID }, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body['scope']).toBe('guild');
    expect(body['scopeId']).toBe(GUILD_ID);
    expect(body['replaced']).toBe(0);
    expect(body['injection']).toEqual({ saved: false, chars: 0, replaced: false });

    const guild = await layerConfig(repos, 'guild', GUILD_ID);
    expect(guild?.segments.map((item) => item.content)).toEqual(['服务器层提示']);
    // 只写目标层：global 与别的 scopeId 都没被顺手写
    expect(await globalLayer(repos)).toBeNull();
    expect(await layerConfig(repos, 'channel', GUILD_ID)).toBeNull();
    expect((await presetRows()).map((row) => row.id)).toEqual(['latest:guild:' + GUILD_ID]);

    // 再导一次 global：服务器层的段与存档都留着，global 仍是老行为（存档 id 还是 'latest'）
    const globalPreset = stPreset([stPrompt('main', '全局主提示', '全局原文')]);
    const globalRes = await send(app, 'POST', '/api/prompts/import', { preset: globalPreset, charName: '灵梦' }, cookie);
    expect(globalRes.status).toBe(200);
    const globalBody = (await globalRes.json()) as Json;
    expect(globalBody['scope']).toBe('global');
    expect(globalBody['scopeId']).toBe('');
    expect((await layerConfig(repos, 'guild', GUILD_ID))?.segments.map((item) => item.content)).toEqual(['服务器层提示']);
    expect((await presetRows()).map((row) => row.id)).toEqual(['latest', 'latest:guild:' + GUILD_ID]);
  });

  it('scope 非法 / 非 global 缺 scopeId → 400 BAD_SCOPE，段、注入、存档一行都不写', async () => {
    const { app, repos, cookie } = await setup();
    const preset = presetWithPostHistory('继续游戏');
    const cases: Array<Record<string, unknown>> = [
      { scope: 'world' },
      { scope: 'GLOBAL' },
      { scope: 5 },
      { scope: 'channel' },
      { scope: 'channel', scopeId: '' },
      { scope: 'guild' },
      // 非字符串 scopeId 与既有 /api/world-book 同一口径：缺必填字段
      { scope: 'channel', scopeId: 5 },
    ];

    for (const extra of cases) {
      const res = await send(app, 'POST', '/api/prompts/import', { preset, charName: '灵梦', ...extra }, cookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Json)['error']).toBe('BAD_SCOPE');
    }
    // 先校验再写库：一层都没落、注入没写、存档没落
    expect(await globalLayer(repos)).toBeNull();
    expect(await layerConfig(repos, 'channel', CHANNEL_ID)).toBeNull();
    expect(await layerConfig(repos, 'guild', GUILD_ID)).toBeNull();
    expect(await globalInjectionRows()).toHaveLength(0);
    expect(await presetRows()).toHaveLength(0);
  });
});
