import { describe, expect, it } from 'vitest';
import type { ScopedKey } from '../src/core/types';
import {
  buildWorldBlock,
  parseWorldBook,
  resolveWorldBook,
  selectWorldEntries,
  WORLD_BLOCK_MAX_CHARS,
  WORLD_SCAN_DEPTH_DEFAULT,
  WORLD_SCAN_DEPTH_MAX,
} from '../src/core/prompt/worldbook';
import type { WorldBook, WorldBookRecord, WorldEntry } from '../src/core/prompt/worldbook';

function parseOk(raw: unknown): WorldBook {
  const result = parseWorldBook(raw);
  if (!result.ok) throw new Error('期望解析成功，实际失败：' + result.error + ' / ' + result.detail);
  return result.value;
}

function parseError(raw: unknown): string {
  const result = parseWorldBook(raw);
  if (result.ok) throw new Error('期望解析失败，实际成功：' + String(result.value.entries.length) + ' 条');
  return result.error;
}

/** 选择器用例只关心触发口径，正文与字段全给默认值，断言才能一眼看出差异来自哪一项 */
function entry(overrides: Partial<WorldEntry> = {}): WorldEntry {
  return {
    id: 0,
    name: '条目',
    keys: [],
    secondaryKeys: [],
    content: '正文',
    enabled: true,
    constant: false,
    selective: false,
    selectiveLogic: 'andAny',
    order: 100,
    caseSensitive: false,
    wholeWords: false,
    ...overrides,
  };
}

function book(entries: WorldEntry[]): WorldBook {
  return { name: '测试书', entries, ignored: [], warnings: [] };
}

function message(content: string, role = 'user'): { role: string; content: string } {
  return { role, content };
}

function record(scope: ScopedKey['scope'], scopeId: string, name: string): WorldBookRecord {
  return {
    scope,
    scopeId,
    name,
    book: book([entry({ keys: ['龙'] })]),
    entryCount: 1,
    importedAt: '2026-10-25T03:00:00.000Z',
  };
}

describe('parseWorldBook 三种输入形态', () => {
  it('ST 世界书 entries 对象：键当 id，字段完整映射', () => {
    const value = parseOk({
      name: '江湖设定',
      entries: {
        '0': {
          key: ['剑', '刀'],
          keysecondary: ['武林', '江湖'],
          content: '行走江湖要用兵器。',
          comment: '兵器',
          insertion_order: 30,
          selective: true,
          selectiveLogic: 2,
          case_sensitive: true,
          match_whole_words: true,
        },
        '7': {
          constant: true,
          text: '这个世界有灵气。',
          title: '灵气',
        },
      },
    });

    expect(value.name).toBe('江湖设定');
    expect(value.warnings).toEqual([]);
    expect(value.ignored).toEqual([]);
    expect(value.entries).toEqual([
      {
        id: 0,
        name: '兵器',
        keys: ['剑', '刀'],
        secondaryKeys: ['武林', '江湖'],
        content: '行走江湖要用兵器。',
        enabled: true,
        constant: false,
        selective: true,
        selectiveLogic: 'notAny',
        order: 30,
        caseSensitive: true,
        wholeWords: true,
      },
      {
        id: 7,
        name: '灵气',
        keys: [],
        secondaryKeys: [],
        content: '这个世界有灵气。',
        enabled: true,
        constant: true,
        selective: false,
        selectiveLogic: 'andAny',
        order: 100,
        caseSensitive: false,
        wholeWords: false,
      },
    ]);
  });

  it('ST 世界书 entries 数组：id 按下标，名字回落首关键词再用「条目 N」', () => {
    const value = parseOk({
      entries: [
        { keys: ['龙'], content: '龙住在山里。' },
        { keywords: ['凤'], text: '凤住在天上。', name: '凤凰' },
        { constant: true, content: '天上有两个月亮。' },
      ],
    });

    expect(value.name).toBe('');
    expect(value.entries.map((item) => item.name)).toEqual(['龙', '凤凰', '条目 2']);
    expect(value.entries.map((item) => item.id)).toEqual([0, 1, 2]);
    expect(value.entries[1]?.content).toBe('凤住在天上。');
    expect(value.entries[2]?.constant).toBe(true);
  });

  it('角色卡 V2：取 data.character_book，书名按 顶层 name > data.name > character_book.name', () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      name: '卡名',
      data: {
        name: '数据名',
        character_book: {
          name: '角色书',
          entries: [{ keys: ['龙'], content: '龙族住在北境。' }],
        },
      },
    };
    expect(parseOk(card).name).toBe('卡名');

    const withoutTopName = {
      spec: 'chara_card_v2',
      data: { name: '数据名', character_book: { name: '角色书', entries: [{ keys: ['龙'], content: '龙族住在北境。' }] } },
    };
    expect(parseOk(withoutTopName).name).toBe('数据名');

    const bareBook = {
      spec: 'chara_card_v2',
      data: { character_book: { name: '角色书', entries: [{ keys: ['龙'], content: '龙族住在北境。' }] } },
    };
    expect(parseOk(bareBook).name).toBe('角色书');
  });

  it('顶层数组：无书名，按下标给 id', () => {
    const value = parseOk([{ keys: ['龙'], content: '龙住在山里。' }, { keys: ['凤'], content: '凤住在天上。' }]);
    expect(value.name).toBe('');
    expect(value.entries.map((item) => item.id)).toEqual([0, 1]);
    expect(value.entries.map((item) => item.content)).toEqual(['龙住在山里。', '凤住在天上。']);
  });

  it('不是对象/数组、或取不到 entries：BAD_WORLDBOOK', () => {
    expect(parseError(null)).toBe('BAD_WORLDBOOK');
    expect(parseError(undefined)).toBe('BAD_WORLDBOOK');
    expect(parseError(42)).toBe('BAD_WORLDBOOK');
    expect(parseError('entries: []')).toBe('BAD_WORLDBOOK');
    expect(parseError({ name: '空壳' })).toBe('BAD_WORLDBOOK');
    expect(parseError({ entries: '不是数组' })).toBe('BAD_WORLDBOOK');
  });

  it('一条可用的都没有：NO_WORLD_ENTRIES', () => {
    expect(parseError({ entries: [] })).toBe('NO_WORLD_ENTRIES');
    expect(parseError({ entries: { '0': { keys: ['龙'], content: '   ' } } })).toBe('NO_WORLD_ENTRIES');
    expect(parseError([1, 2, 3])).toBe('NO_WORLD_ENTRIES');
  });
});

describe('parseWorldBook 跳过与提醒', () => {
  it('三种 ignored 原因各归各的，都不进 entries', () => {
    const value = parseOk({
      entries: {
        '0': { keys: ['龙'], content: '' },
        '1': { keys: ['龙'], content: '被关掉的条目。', enabled: false },
        '2': { content: '没有关键词也不是 constant。' },
        '3': { keys: ['龙'], content: '这条正常。' },
      },
    });

    expect(value.entries.map((item) => item.id)).toEqual([3]);
    expect(value.ignored).toEqual([
      { identifier: '0', name: '龙', reason: 'empty' },
      { identifier: '1', name: '龙', reason: 'disabled' },
      { identifier: '2', name: '条目 2', reason: 'noKeys' },
    ]);
  });

  it('非对象条目记 warning 后跳过，不影响其余条目', () => {
    const value = parseOk({ entries: ['坏条目', { keys: ['龙'], content: '龙住在山里。' }] });
    expect(value.warnings).toEqual(['已跳过 1 个非对象条目']);
    expect(value.entries).toHaveLength(1);
  });

  it('constant 条目没有关键词也收下', () => {
    const value = parseOk({ entries: [{ constant: true, content: '这个世界有灵气。' }] });
    expect(value.ignored).toEqual([]);
    expect(value.entries[0]?.constant).toBe(true);
    expect(value.entries[0]?.keys).toEqual([]);
  });

  it('disable=true 与 enabled=false 同口径停用：连 constant 也不得命中', () => {
    const value = parseOk({
      entries: [
        { disable: true, constant: true, content: '被停用的常驻条目。' },
        { keys: ['龙'], content: '龙住在山里。' },
      ],
    });

    expect(value.entries.map((item) => item.content)).toEqual(['龙住在山里。']);
    expect(value.ignored).toEqual([{ identifier: '0', name: '条目 0', reason: 'disabled' }]);
    // 空窗口也要为空：constant 停用后不能再靠「每轮必插」混进来
    expect(selectWorldEntries(value, [])).toEqual([]);
    expect(selectWorldEntries(value, [message('龙')]).map((item) => item.content)).toEqual(['龙住在山里。']);
  });
});

describe('parseWorldBook 字段兼容', () => {
  it('keys / key / keywords 通用，逗号串按多个关键词拆', () => {
    const keys = parseOk({ entries: [{ keys: ['甲'], content: '一' }, { key: ['乙'], content: '二' }, { keywords: ['丙'], content: '三' }] });
    expect(keys.entries.map((item) => item.keys)).toEqual([['甲'], ['乙'], ['丙']]);

    const comma = parseOk({ entries: [{ key: '甲, 乙', content: '一' }] });
    expect(comma.entries[0]?.keys).toEqual(['甲', '乙']);
  });

  it('secondaryKeys / keysecondary / secondary_keys 通用', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], secondaryKeys: ['一'], content: '1' },
        { key: ['乙'], keysecondary: ['二'], content: '2' },
        { key: ['丙'], secondary_keys: ['三'], content: '3' },
      ],
    });
    expect(value.entries.map((item) => item.secondaryKeys)).toEqual([['一'], ['二'], ['三']]);
  });

  it('content / text 通用，缺省时算空正文', () => {
    const value = parseOk({ entries: [{ keys: ['甲'], content: '正文' }, { keys: ['乙'], text: '正文二' }] });
    expect(value.entries.map((item) => item.content)).toEqual(['正文', '正文二']);
  });

  it('comment / name / title 通用，都空才回落关键词', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1', comment: '注释名' },
        { keys: ['乙'], content: '2', name: '名字' },
        { keys: ['丙'], content: '3', title: '标题' },
        { keys: ['丁'], content: '4' },
      ],
    });
    expect(value.entries.map((item) => item.name)).toEqual(['注释名', '名字', '标题', '丁']);
  });

  it('insertion_order / order / priority 通用，缺省 100', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1', insertion_order: 5 },
        { keys: ['乙'], content: '2', order: 6 },
        { keys: ['丙'], content: '3', priority: 7 },
        { keys: ['丁'], content: '4' },
      ],
    });
    expect(value.entries.map((item) => item.order)).toEqual([5, 6, 7, 100]);
  });

  it('caseSensitive / matchWholeWords 两套写法都认，缺省 false', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1', caseSensitive: true, matchWholeWords: true },
        { keys: ['乙'], content: '2', case_sensitive: true, match_whole_words: true },
        { keys: ['丙'], content: '3' },
      ],
    });
    expect(value.entries.map((item) => item.caseSensitive)).toEqual([true, true, false]);
    expect(value.entries.map((item) => item.wholeWords)).toEqual([true, true, false]);
  });

  it('enabled 缺省 true、constant / selective 缺省 false', () => {
    const value = parseOk({ entries: [{ keys: ['甲'], content: '1' }] });
    expect(value.entries[0]?.enabled).toBe(true);
    expect(value.entries[0]?.constant).toBe(false);
    expect(value.entries[0]?.selective).toBe(false);
    expect(value.entries[0]?.selectiveLogic).toBe('andAny');
  });

  it('selectiveLogic 数字按 ST 口径 0/1/2/3，字符串大小写与空格都容忍', () => {
    const numeric = parseOk({
      entries: [
        { keys: ['甲'], content: '1', selectiveLogic: 0 },
        { keys: ['乙'], content: '2', selectiveLogic: 1 },
        { keys: ['丙'], content: '3', selectiveLogic: 2 },
        { keys: ['丁'], content: '4', selectiveLogic: 3 },
      ],
    });
    expect(numeric.entries.map((item) => item.selectiveLogic)).toEqual(['andAny', 'notAll', 'notAny', 'andAll']);

    const named = parseOk({
      entries: [
        { keys: ['甲'], content: '1', selectiveLogic: 'AND ALL' },
        { keys: ['乙'], content: '2', selectiveLogic: 'not_any' },
        { keys: ['丙'], content: '3', selectiveLogic: 'Not All' },
        { keys: ['丁'], content: '4', selectiveLogic: 'andany' },
      ],
    });
    expect(named.entries.map((item) => item.selectiveLogic)).toEqual(['andAll', 'notAny', 'notAll', 'andAny']);
  });
});

describe('selectWorldEntries 触发', () => {
  it('constant 条目每轮必插，不看关键词', () => {
    const target = book([entry({ constant: true, content: '这个世界有灵气。' })]);
    expect(selectWorldEntries(target, [message('完全无关')])).toHaveLength(1);
  });

  it('keys 任一命中即算命中', () => {
    const target = book([entry({ keys: ['龙', '凤'] })]);
    expect(selectWorldEntries(target, [message('天上飞的凤')])).toHaveLength(1);
    expect(selectWorldEntries(target, [message('地上跑的狗')])).toHaveLength(0);
  });

  it('大小写不敏感；条目开了 caseSensitive 才区分', () => {
    const loose = book([entry({ keys: ['Dragon'] })]);
    expect(selectWorldEntries(loose, [message('a dragon here')])).toHaveLength(1);

    const strict = book([entry({ keys: ['Dragon'], caseSensitive: true })]);
    expect(selectWorldEntries(strict, [message('a dragon here')])).toHaveLength(0);
    expect(selectWorldEntries(strict, [message('a Dragon here')])).toHaveLength(1);
  });

  it('wholeWords 只认词边界', () => {
    const target = book([entry({ keys: ['cat'], wholeWords: true })]);
    expect(selectWorldEntries(target, [message('concatenate')])).toHaveLength(0);
    expect(selectWorldEntries(target, [message('a cat, here')])).toHaveLength(1);
    expect(selectWorldEntries(target, [message('cat')])).toHaveLength(1);
  });

  it('扫描窗口只看末尾 scanDepth 条，缺省 4 条', () => {
    const target = book([entry({ keys: ['龙'] })]);
    const far = [message('龙'), message('无关'), message('无关'), message('无关'), message('无关')];
    expect(far).toHaveLength(5);
    expect(WORLD_SCAN_DEPTH_DEFAULT).toBe(4);
    expect(selectWorldEntries(target, far)).toHaveLength(0);
    // 同一句话挪进窗口就命中：判的是位置，不是内容
    expect(selectWorldEntries(target, [...far.slice(1), message('龙')])).toHaveLength(1);
    expect(selectWorldEntries(target, far, 5)).toHaveLength(1);
  });

  it('scanDepth 被夹到 1..20', () => {
    const target = book([entry({ keys: ['龙'] })]);
    const pair = [message('龙'), message('无关')];
    expect(selectWorldEntries(target, pair, 0)).toHaveLength(0);
    expect(selectWorldEntries(target, pair, -3)).toHaveLength(0);
    expect(selectWorldEntries(target, pair, 2)).toHaveLength(1);

    const long = [message('无关'), message('无关'), message('无关'), message('无关'), message('龙')];
    for (let index = 5; index < 25; index += 1) long.push(message('无关'));
    expect(long).toHaveLength(25);
    expect(WORLD_SCAN_DEPTH_MAX).toBe(20);
    // 第 5 条要 21 条窗口才够得着；上限 20 把它挡在窗口外
    expect(selectWorldEntries(target, long, 21)).toHaveLength(0);
  });

  it('四种 selectiveLogic 按窗口里的 secondary 判定', () => {
    const cases = [
      { logic: 'andAny' as const, all: true, some: true, none: false },
      { logic: 'andAll' as const, all: true, some: false, none: false },
      { logic: 'notAny' as const, all: false, some: false, none: true },
      { logic: 'notAll' as const, all: false, some: true, none: true },
    ];
    for (const item of cases) {
      const target = book([
        entry({ keys: ['龙'], selective: true, secondaryKeys: ['甲', '乙'], selectiveLogic: item.logic }),
      ]);
      expect(selectWorldEntries(target, [message('龙 甲 乙')])).toHaveLength(item.all ? 1 : 0);
      expect(selectWorldEntries(target, [message('龙 甲')])).toHaveLength(item.some ? 1 : 0);
      expect(selectWorldEntries(target, [message('龙')])).toHaveLength(item.none ? 1 : 0);
    }
  });

  it('selective 但没 secondaryKeys 时只看主关键词', () => {
    const target = book([entry({ keys: ['龙'], selective: true, selectiveLogic: 'andAll' })]);
    expect(selectWorldEntries(target, [message('龙')])).toHaveLength(1);
  });
});

describe('selectWorldEntries 排序与预算', () => {
  it('按 order 升序，同 order 按 id 升序，且不改动原书顺序', () => {
    const target = book([
      entry({ id: 3, order: 50, constant: true, content: 'c' }),
      entry({ id: 9, order: 10, constant: true, content: 'b' }),
      entry({ id: 2, order: 10, constant: true, content: 'a' }),
    ]);
    const picked = selectWorldEntries(target, [message('无关')]);
    expect(picked.map((item) => item.id)).toEqual([2, 9, 3]);
    expect(target.entries.map((item) => item.id)).toEqual([3, 9, 2]);
  });

  it('累计后超过 4000 字就整条跳过，不截断正文', () => {
    const big = 'x'.repeat(3000);
    const target = book([
      entry({ id: 0, constant: true, content: big }),
      entry({ id: 1, constant: true, content: big }),
    ]);
    const picked = selectWorldEntries(target, [message('无关')]);
    expect(picked.map((item) => item.id)).toEqual([0]);
    expect(picked[0]?.content).toHaveLength(3000);
    expect(WORLD_BLOCK_MAX_CHARS).toBe(4000);
  });

  it('预算按 trim 后的正文加两条之间的两个换行算，刚好 4000 收下', () => {
    const first = 'x'.repeat(2000);
    const second = 'y'.repeat(1998);
    const target = book([
      entry({ id: 0, constant: true, content: '  ' + first + '  ' }),
      entry({ id: 1, constant: true, content: second }),
      entry({ id: 2, constant: true, content: 'z' }),
    ]);
    const picked = selectWorldEntries(target, [message('无关')]);
    expect(picked.map((item) => item.id)).toEqual([0, 1]);
  });

  it('单条正文超过 4000 也不收', () => {
    const target = book([entry({ constant: true, content: 'x'.repeat(4001) })]);
    expect(selectWorldEntries(target, [message('无关')])).toHaveLength(0);
  });
});

describe('buildWorldBlock', () => {
  it('空数组返回空串', () => {
    expect(buildWorldBlock([])).toBe('');
  });

  it('只有空白正文时同样返回空串', () => {
    expect(buildWorldBlock([entry({ content: '   ' })])).toBe('');
  });

  it('标题行加逐条 trim 后用两个换行连接', () => {
    const block = buildWorldBlock([
      entry({ content: '  龙住在山里。  ' }),
      entry({ content: '凤住在天上。' }),
    ]);
    expect(block).toBe('【世界书】\n龙住在山里。\n\n凤住在天上。');
  });
});

describe('resolveWorldBook 三层整本覆盖', () => {
  it('channel > guild > global，哪层有书整本用哪层', () => {
    const channel = record('channel', 'c1', '频道书');
    const guild = record('guild', 'g1', '公会书');
    const global = record('global', '', '全局书');

    expect(resolveWorldBook(channel, guild, global)?.name).toBe('频道书');
    expect(resolveWorldBook(null, guild, global)?.name).toBe('公会书');
    expect(resolveWorldBook(null, null, global)?.name).toBe('全局书');
    expect(resolveWorldBook(null, null, null)).toBeNull();
  });
});
