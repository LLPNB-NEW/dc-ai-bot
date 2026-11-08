import { describe, expect, it } from 'vitest';
import { importSillyTavernPreset, POST_HISTORY_MAX_CHARS } from '../src/core/prompt/sillytavern';
import type { PresetImport } from '../src/core/prompt/sillytavern';

function importOk(raw: unknown, charName = '小樱'): PresetImport {
  const result = importSillyTavernPreset(raw, charName);
  if (!result.ok) throw new Error('expected ok, got ' + result.error + ': ' + result.detail);
  return result.value;
}

function single(content: string, charName = '小樱'): PresetImport {
  return importOk({ prompts: [{ identifier: 's1', name: '段一', role: 'system', content }] }, charName);
}

const NORMAL_PRESET = {
  prompts: [
    { identifier: 'main', name: '主提示词', role: 'system', content: '你是 {{char}}，请简洁。' },
    { identifier: 'chatHistory', name: '', role: 'system', marker: true, content: '' },
    { identifier: 'jailbreak', name: '越狱', role: 'system', content: '{{user}} 的指令优先。' },
    { identifier: 'blank', name: '空白段', role: 'user', content: '  \n ' },
    { identifier: 'style', name: '风格提示', role: 'assistant', content: '回答控制在三句内。' },
  ],
  prompt_order: [
    { character_id: 42, order: [{ identifier: 'main', enabled: true }] },
    {
      character_id: 100000,
      order: [
        { identifier: 'jailbreak', enabled: true },
        { identifier: 'main', enabled: false },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'blank', enabled: true },
        { identifier: 'style', enabled: true },
      ],
    },
  ],
};

describe('importSillyTavernPreset · 段与顺序', () => {
  it('正常预设：jailbreak 搬去深度注入，order 里关掉的段导成停用段，marker 与空段各归各的', () => {
    const value = importOk(NORMAL_PRESET);

    expect(value.segments).toHaveLength(2);
    expect(value.segments.map((segment) => segment.name)).toEqual(['主提示词', '风格提示']);
    expect(value.segments.map((segment) => segment.enabled)).toEqual([false, true]);
    expect(value.segments.map((segment) => segment.role)).toEqual(['system', 'system']);
    expect(value.segments.map((segment) => segment.placement)).toEqual(['before', 'before']);
    expect(value.segments.map((segment) => segment.content)).toEqual(['你是 小樱，请简洁。', '回答控制在三句内。']);

    expect(value.postHistory).toBe('{{user_name}} 的指令优先。');
    expect(value.moved).toEqual([{ identifier: 'jailbreak', name: '越狱' }]);
    expect(value.ignored).toEqual([
      { identifier: 'chatHistory', name: 'chatHistory', reason: 'marker' },
      { identifier: 'blank', name: '空白段', reason: 'empty' },
    ]);
    expect(value.charName).toBe('小樱');
    expect(value.warnings).toHaveLength(1);
    expect(value.warnings[0]).toContain('assistant');
  });

  it('prompt_order 重排：未列出的段按原顺序接在末尾，order 里关掉的段导成停用段', () => {
    const value = importOk({
      prompts: [
        { identifier: 'a', name: 'A', role: 'system', content: 'A 内容', enabled: true },
        { identifier: 'b', name: 'B', role: 'system', content: 'B 内容' },
        { identifier: 'c', name: 'C', role: 'user', content: 'C 内容' },
        { identifier: 'd', name: 'D', role: 'user', content: 'D 内容' },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: [
            { identifier: 'c', enabled: true },
            { identifier: 'b', enabled: false },
            { identifier: 'ghost', enabled: true },
            { identifier: 'd' },
          ],
        },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['C', 'B', 'D', 'A']);
    expect(value.segments.map((segment) => segment.enabled)).toEqual([true, false, true, true]);
    expect(value.segments.map((segment) => segment.role)).toEqual(['user', 'system', 'user', 'system']);
    expect(value.ignored).toEqual([]);
    expect(value.warnings).toEqual(['prompt_order 引用了不存在的段 ghost']);
  });

  it('缺 prompt_order：保持 prompts 原顺序，全部启用', () => {
    const value = importOk({
      prompts: [
        { identifier: 'a', name: 'A', role: 'system', content: 'A 内容' },
        { identifier: 'b', name: 'B', role: 'system', content: 'B 内容' },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['A', 'B']);
    expect(value.segments.map((segment) => segment.enabled)).toEqual([true, true]);
    expect(value.postHistory).toBe('');
    expect(value.moved).toEqual([]);
    expect(value.warnings).toEqual([]);
  });

  it('prompt_order 结构坏掉：回落原顺序而不是报错', () => {
    const value = importOk({
      prompts: [{ identifier: 'a', name: 'A', role: 'system', content: 'A 内容' }],
      prompt_order: [{ character_id: 100000, order: 'nope' }],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['A']);
    expect(value.warnings).toEqual([]);
  });

  it('没有 character_id=100000 时取 prompt_order 第一项', () => {
    const value = importOk({
      prompts: [
        { identifier: 'a', name: 'A', role: 'system', content: 'A 内容' },
        { identifier: 'b', name: 'B', role: 'system', content: 'B 内容' },
      ],
      prompt_order: [
        {
          character_id: 42,
          order: [
            { identifier: 'b', enabled: true },
            { identifier: 'a', enabled: false },
          ],
        },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['B', 'A']);
    expect(value.segments.map((segment) => segment.enabled)).toEqual([true, false]);
    expect(value.ignored).toEqual([]);
  });

  it('主对话项的顺序表是空数组时，改用下一项非空顺序表（真实预设就是这样）', () => {
    const value = importOk({
      prompts: [
        { identifier: 'a', name: 'A', role: 'system', content: 'A 内容' },
        { identifier: 'b', name: 'B', role: 'system', content: 'B 内容' },
        { identifier: 'c', name: 'C', role: 'system', content: 'C 内容' },
      ],
      prompt_order: [
        { character_id: 100000, order: [] },
        {
          character_id: 100001,
          order: [
            { identifier: 'c', enabled: true },
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
          ],
        },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['C', 'A', 'B']);
    expect(value.segments.map((segment) => segment.enabled)).toEqual([true, true, false]);
    expect(value.ignored).toEqual([]);
    expect(value.warnings).toEqual([]);
  });

  it('marker 优先于空内容：两者都命中时记为 marker', () => {
    const value = importOk({
      prompts: [
        { identifier: 'm', name: '标记', role: 'system', marker: true, content: '   ' },
        { identifier: 'ok', name: '正常', role: 'system', content: '正常内容' },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['正常']);
    expect(value.ignored).toEqual([{ identifier: 'm', name: '标记', reason: 'marker' }]);
  });

  it('name 回退：取 identifier，再退回「段 N」', () => {
    const value = importOk({
      prompts: [
        { identifier: 'onlyId', role: 'system', content: 'A 内容' },
        { role: 'system', content: 'B 内容' },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['onlyId', '段 2']);
  });
});

describe('importSillyTavernPreset · 宏映射', () => {
  it('{{char}} / {{charIfNotGroup}} 换成 charName', () => {
    const value = single('{{char}} 与 {{charIfNotGroup}} 都在');

    expect(value.segments[0].content).toBe('小樱 与 小樱 都在');
    expect(value.warnings).toEqual([]);
  });

  it('{{user}} 归一成 {{user_name}}，时间三种写法归一成 {{date}}', () => {
    const value = single('{{user}}|{{time}}|{{date}}|{{datetime}}');

    expect(value.segments[0].content).toBe('{{user_name}}|{{date}}|{{date}}|{{date}}');
    expect(value.warnings).toEqual([]);
  });

  it('没有来源的宏清空并逐条点名', () => {
    const value = single('{{description}}{{persona}}{{scenario}}{{personality}}{{original}}{{mesExamples}}');

    expect(value.segments).toHaveLength(1);
    expect(value.segments[0].content).toBe('');
    expect(value.warnings).toEqual([
      '已清空宏 {{description}}',
      '已清空宏 {{persona}}',
      '已清空宏 {{scenario}}',
      '已清空宏 {{personality}}',
      '已清空宏 {{original}}',
      '已清空宏 {{mesExamples}}',
    ]);
  });

  it('清空类的 warning 去重，且最多 10 条', () => {
    const duplicated = single('{{description}}x{{description}}');
    expect(duplicated.segments[0].content).toBe('x');
    expect(duplicated.warnings).toEqual(['已清空宏 {{description}}']);

    const many = [
      'description',
      'persona',
      'personality',
      'scenario',
      'original',
      'mesExamples',
      'mesExamplesRaw',
      'charPrompt',
      'charInstruction',
      'charDescription',
      'charPersonality',
    ]
      .map((macro) => '{{' + macro + '}}')
      .join('');
    const capped = single(many);
    expect(capped.warnings).toHaveLength(10);
    expect(capped.warnings.join('')).not.toContain('charPersonality');
  });

  it('白名单变量原样保留且不告警', () => {
    const content = '{{bot_name}}/{{user_name}}/{{guild_name}}/{{channel_name}}/{{date}}';
    const value = single(content);

    expect(value.segments[0].content).toBe(content);
    expect(value.warnings).toEqual([]);
  });

  it('白名单之外的宏保留原文并提示 unknown variable（同名的只提示一次）', () => {
    const value = single('情绪：{{mood}} 与 {{mood}}');

    expect(value.segments[0].content).toBe('情绪：{{mood}} 与 {{mood}}');
    expect(value.warnings).toEqual(['unknown variable {{mood}}']);
  });

  it('替换结果不参与二次替换', () => {
    const value = single('{{char}}', '{{user}}');

    expect(value.segments[0].content).toBe('{{user}}');
    expect(value.warnings).toEqual([]);
  });

  it('charName 为空串：保留 {{char}} 宏并告警，{{user}} 照旧归一', () => {
    const value = importOk(
      { prompts: [{ name: '段一', role: 'system', content: '{{char}} 与 {{charIfNotGroup}}，还有 {{user}}' }] },
      '',
    );

    expect(value.charName).toBe('');
    expect(value.segments[0].content).toBe('{{char}} 与 {{charIfNotGroup}}，还有 {{user_name}}');
    expect(value.warnings).toEqual(['charName 为空，保留宏 {{char}}', 'charName 为空，保留宏 {{charIfNotGroup}}']);
  });
});

describe('importSillyTavernPreset · 开关与深度注入', () => {
  it('空的主对话 order：关着的段也导进来，只是保持停用', () => {
    const value = importOk({
      prompts: [
        { identifier: 'on', name: '开着的', role: 'system', content: '开着的内容' },
        { identifier: 'off', name: '关着的', role: 'system', content: '关着的内容', enabled: false },
        { identifier: 'plain', name: '没写开关', role: 'system', content: '默认算开' },
      ],
      prompt_order: [{ character_id: 100000, order: [] }],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['开着的', '关着的', '没写开关']);
    expect(value.segments.map((segment) => segment.enabled)).toEqual([true, false, true]);
    expect(value.ignored).toEqual([]);
  });

  it('order 里列出但段自己 enabled:false：导进来并保持停用', () => {
    const value = importOk({
      prompts: [
        { identifier: 'a', name: 'A', role: 'system', content: 'A 内容', enabled: false },
        { identifier: 'b', name: 'B', role: 'system', content: 'B 内容' },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
          ],
        },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['A', 'B']);
    expect(value.segments.map((segment) => segment.enabled)).toEqual([false, true]);
    expect(value.ignored).toEqual([]);
  });

  it('identifier 为 jailbreak 的启用段：进 postHistory 与 moved，不进 segments', () => {
    const value = importOk({
      prompts: [
        { identifier: 'main', name: '主提示词', role: 'system', content: '主内容' },
        { identifier: 'jailbreak', name: '越狱', role: 'system', content: '{{user}} 优先' },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['主提示词']);
    expect(value.segments).toHaveLength(1);
    expect(value.postHistory).toBe('{{user_name}} 优先');
    expect(value.moved).toEqual([{ identifier: 'jailbreak', name: '越狱' }]);
    expect(value.ignored).toEqual([]);
  });

  it('injection_position 为 1 的段同样搬走；marker 段不参与深度注入判定', () => {
    const value = importOk({
      prompts: [
        { identifier: 'depth', name: '深度段', role: 'system', content: '深度内容', injection_position: 1 },
        {
          identifier: 'markerJC',
          name: '标记深度段',
          role: 'system',
          marker: true,
          content: '',
          injection_position: 1,
        },
        { identifier: 'normal', name: '普通段', role: 'system', content: '普通内容' },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['普通段']);
    expect(value.postHistory).toBe('深度内容');
    expect(value.moved).toEqual([{ identifier: 'depth', name: '深度段' }]);
    expect(value.ignored).toEqual([{ identifier: 'markerJC', name: '标记深度段', reason: 'marker' }]);
  });

  it('多个深度注入段按出现顺序用空行拼接，且都走宏映射', () => {
    const value = importOk({
      prompts: [
        { identifier: 'jailbreak', name: '越狱', role: 'system', content: '第一条 {{char}}', injection_depth: 2 },
        { identifier: 'depth2', name: '第二段', role: 'user', content: '第二条 {{user}}', injection_position: 1 },
        { identifier: 'main', name: '主提示词', role: 'system', content: '主内容' },
      ],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['主提示词']);
    expect(value.postHistory).toBe('第一条 小樱\n\n第二条 {{user_name}}');
    expect(value.moved.map((entry) => entry.identifier)).toEqual(['jailbreak', 'depth2']);
  });

  it('超过 20000 字按码点截断并告警，正好 20000 不告警', () => {
    expect(POST_HISTORY_MAX_CHARS).toBe(20000);

    const over = importOk({
      prompts: [
        {
          identifier: 'jailbreak',
          name: '越狱',
          role: 'system',
          content: '🙂'.repeat(POST_HISTORY_MAX_CHARS + 1),
        },
        { identifier: 'keep', name: '普通段', role: 'system', content: '普通内容' },
      ],
    });
    expect(Array.from(over.postHistory)).toHaveLength(POST_HISTORY_MAX_CHARS);
    expect(over.postHistory).not.toContain('\uFFFD');
    expect(over.postHistory).toBe('🙂'.repeat(POST_HISTORY_MAX_CHARS));
    expect(over.warnings).toEqual(['深度注入正文超过 20000 字，已截断']);

    const exact = importOk({
      prompts: [
        { identifier: 'jailbreak', name: '越狱', role: 'system', content: 'x'.repeat(POST_HISTORY_MAX_CHARS) },
        { identifier: 'keep', name: '普通段', role: 'system', content: '普通内容' },
      ],
    });
    expect(exact.postHistory).toHaveLength(POST_HISTORY_MAX_CHARS);
    expect(exact.warnings).toEqual([]);
  });

  it('只有 post-history 段、没有普通段：仍然 NO_SEGMENTS', () => {
    const result = importSillyTavernPreset(
      { prompts: [{ identifier: 'jailbreak', name: '越狱', role: 'system', content: '只管深度注入' }] },
      '小樱',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('NO_SEGMENTS');
  });
});

describe('importSillyTavernPreset · 错误分支', () => {
  it('顶层不是对象 → BAD_PRESET', () => {
    for (const raw of [null, 'x', 42, [], true]) {
      const result = importSillyTavernPreset(raw, '小樱');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_PRESET');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('prompts 不是数组 → BAD_PRESET', () => {
    for (const raw of [{}, { prompts: null }, { prompts: 'x' }, { prompts: {} }]) {
      const result = importSillyTavernPreset(raw, '小樱');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('BAD_PRESET');
    }
  });

  it('没有任何可用段 → NO_SEGMENTS', () => {
    const cases = [
      { prompts: [] },
      { prompts: [{ identifier: 'm', marker: true, content: '' }] },
      { prompts: [{ identifier: 'e', role: 'system', content: '   ' }] },
      { prompts: ['x', null] },
    ];
    for (const raw of cases) {
      const result = importSillyTavernPreset(raw, '小樱');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('NO_SEGMENTS');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('非对象条目被跳过并留一条 warning，其余段照常导入', () => {
    const value = importOk({
      prompts: [{ identifier: 'a', name: 'A', role: 'system', content: 'A 内容' }, 'x', null],
    });

    expect(value.segments.map((segment) => segment.name)).toEqual(['A']);
    expect(value.warnings).toEqual(['已跳过 2 个非对象段条目']);
  });
});
