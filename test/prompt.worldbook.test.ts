import { describe, expect, it } from 'vitest';
import type { ChatMessage, ScopedKey } from '../src/core/types';
import {
  buildWorldBlock,
  mergeWorldSelections,
  normalizeWorldBook,
  parseWorldBook,
  readWorldPosition,
  readWorldRole,
  resolveWorldBooks,
  selectWorldEntries,
  uniqueWorldBookName,
  withWorldDepth,
  WORLD_BOOK_FALLBACK_NAME,
  WORLD_DEPTH_MAX,
  WORLD_GROUP_WEIGHT_DEFAULT,
  WORLD_POSITIONS,
  WORLD_PROBABILITY_DEFAULT,
  WORLD_SCAN_DEPTH_DEFAULT,
  WORLD_SCAN_DEPTH_MAX,
} from '../src/core/prompt/worldbook';
import type {
  WorldBook,
  WorldBookPart,
  WorldBookRecord,
  WorldEntry,
  WorldEntryState,
  WorldSelection,
} from '../src/core/prompt/worldbook';

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
    position: 'anTop',
    depth: 4,
    role: 'system',
    probability: 100,
    useProbability: true,
    group: '',
    groupWeight: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    scanDepth: null,
    ...overrides,
  };
}

/** 单书用例的默认书 id：记账行不带它会被当成别的书，跨书用例自己传 bookId */
const BOOK_ID = 'book-a';

/** 粘性/冷却记账行：默认落在 BOOK_ID 这本书，跨书用例传第四个数 */
function stateRow(entryId: number, stickyUntil: number, cooldownUntil: number, bookId = BOOK_ID): WorldEntryState {
  return { bookId, entryId, stickyUntil, cooldownUntil };
}

/** 选择结果只关心条目本身：这里把 WorldSelection 拆成数组，断言与旧版一一对应 */
function pick(
  value: WorldBook,
  messages: readonly { role: string; content: string }[],
  scanDepth?: number,
  options: { bookId?: string; state?: readonly WorldEntryState[]; turn?: number; random?: () => number } = {},
): WorldEntry[] {
  return selectWorldEntries(value, messages, {
    bookId: BOOK_ID,
    ...options,
    ...(scanDepth === undefined ? {} : { scanDepth }),
  }).entries;
}

/** 要看 skipped / state / byPosition 的用例走这里：pick 只把 entries 摊平 */
function select(
  value: WorldBook,
  messages: readonly { role: string; content: string }[],
  options: { bookId?: string; scanDepth?: number; state?: readonly WorldEntryState[]; turn?: number; random?: () => number } = {},
): WorldSelection {
  return selectWorldEntries(value, messages, { bookId: BOOK_ID, ...options });
}

function book(entries: WorldEntry[]): WorldBook {
  return { name: '测试书', entries, ignored: [], warnings: [] };
}

function message(content: string, role = 'user'): { role: string; content: string } {
  return { role, content };
}

function record(
  scope: ScopedKey['scope'],
  scopeId: string,
  name: string,
  overrides: Partial<WorldBookRecord> = {},
): WorldBookRecord {
  return {
    scope,
    scopeId,
    bookId: scope + ':' + scopeId,
    name,
    book: book([entry({ keys: ['龙'] })]),
    entryCount: 1,
    importedAt: '2026-10-25T03:00:00.000Z',
    enabled: true,
    ...overrides,
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
        // 新契约：老导出没这些字段，全部落到「不改旧行为」的缺省值
        position: 'anTop',
        depth: WORLD_SCAN_DEPTH_DEFAULT,
        role: 'system',
        probability: WORLD_PROBABILITY_DEFAULT,
        useProbability: false,
        group: '',
        groupWeight: WORLD_GROUP_WEIGHT_DEFAULT,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        scanDepth: null,
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
        position: 'anTop',
        depth: WORLD_SCAN_DEPTH_DEFAULT,
        role: 'system',
        probability: WORLD_PROBABILITY_DEFAULT,
        useProbability: false,
        group: '',
        groupWeight: WORLD_GROUP_WEIGHT_DEFAULT,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        scanDepth: null,
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
    expect(pick(value, [])).toEqual([]);
    expect(pick(value, [message('龙')]).map((item) => item.content)).toEqual(['龙住在山里。']);
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

describe('parseWorldBook 触发字段', () => {
  it('position 数字 0..4 一一对应，缺省与越界值落 anTop', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1', position: 0 },
        { keys: ['乙'], content: '2', position: 1 },
        { keys: ['丙'], content: '3', position: 2 },
        { keys: ['丁'], content: '4', position: 3 },
        { keys: ['戊'], content: '5', position: 4 },
        { keys: ['己'], content: '6' },
        { keys: ['庚'], content: '7', position: 9 },
      ],
    });

    expect(value.entries.map((item) => item.position)).toEqual([
      'beforeChar',
      'afterChar',
      'anTop',
      'anBottom',
      'atDepth',
      'anTop',
      'anTop',
    ]);
    expect(WORLD_POSITIONS).toEqual(['beforeChar', 'afterChar', 'anTop', 'anBottom', 'atDepth']);
  });

  it('readWorldPosition 认字符串写法：大小写、空格、下划线都不计较', () => {
    expect(readWorldPosition('beforeChar')).toBe('beforeChar');
    expect(readWorldPosition('After Char')).toBe('afterChar');
    expect(readWorldPosition('AN_TOP')).toBe('anTop');
    expect(readWorldPosition('an-bottom')).toBe('anBottom');
    expect(readWorldPosition('at_depth')).toBe('atDepth');
    expect(readWorldPosition('0')).toBe('beforeChar');
    expect(readWorldPosition(undefined)).toBe('anTop');
    expect(readWorldPosition('乱写')).toBe('anTop');
  });

  it('depth / role / probability 缺省与显式值，越界按上下限夹住', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1' },
        { keys: ['乙'], content: '2', depth: 0, role: 0, probability: 0 },
        { keys: ['丙'], content: '3', depth: 60, role: 2, probability: 40 },
        { keys: ['丁'], content: '4', role: 1, probability: 150 },
        { keys: ['戊'], content: '5', depth: -1, probability: -1 },
      ],
    });

    expect(value.entries.map((item) => item.depth)).toEqual([4, 0, WORLD_DEPTH_MAX, 4, 0]);
    expect(value.entries.map((item) => item.role)).toEqual(['system', 'system', 'assistant', 'user', 'system']);
    expect(value.entries.map((item) => item.probability)).toEqual([WORLD_PROBABILITY_DEFAULT, 0, 40, 100, 0]);
  });

  it('readWorldRole 数字码 0/1/2 与字符串都认，写错按 system', () => {
    expect(readWorldRole(0)).toBe('system');
    expect(readWorldRole(1)).toBe('user');
    expect(readWorldRole(2)).toBe('assistant');
    expect(readWorldRole('USER')).toBe('user');
    expect(readWorldRole('assistant')).toBe('assistant');
    expect(readWorldRole(7)).toBe('system');
    expect(readWorldRole(undefined)).toBe('system');
  });

  it('useProbability 缺省按 probability<100 推导，显式值照抄', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1' },
        { keys: ['乙'], content: '2', probability: 40 },
        { keys: ['丙'], content: '3', probability: 40, useProbability: false },
        { keys: ['丁'], content: '4', useProbability: true },
        { keys: ['戊'], content: '5', use_probability: 0 },
      ],
    });

    expect(value.entries.map((item) => item.useProbability)).toEqual([false, true, false, true, false]);
  });

  it('group 去首尾空格、缺省空串；groupWeight 缺省 100 并夹在 0..100000', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1' },
        { keys: ['乙'], content: '2', group: '  龙组  ', groupWeight: 300 },
        { keys: ['丙'], content: '3', group_weight: 50 },
        { keys: ['丁'], content: '4', group: '   ', groupWeight: -1 },
      ],
    });

    expect(value.entries.map((item) => item.group)).toEqual(['', '龙组', '', '']);
    expect(value.entries.map((item) => item.groupWeight)).toEqual([WORLD_GROUP_WEIGHT_DEFAULT, 300, 50, 0]);
  });

  it('sticky / cooldown / delay 缺省 0；scanDepth 缺省 null，显式值夹到 1..20', () => {
    const value = parseOk({
      entries: [
        { keys: ['甲'], content: '1' },
        { keys: ['乙'], content: '2', sticky: 3, cooldown: 2, delay: 5, scanDepth: 7 },
        { keys: ['丙'], content: '3', sticky: -1, cooldown: -2, delay: -3, scanDepth: 0 },
        { keys: ['丁'], content: '4', scan_depth: 30 },
        { keys: ['戊'], content: '5', scanDepth: null },
      ],
    });

    expect(value.entries.map((item) => item.sticky)).toEqual([0, 3, 0, 0, 0]);
    expect(value.entries.map((item) => item.cooldown)).toEqual([0, 2, 0, 0, 0]);
    expect(value.entries.map((item) => item.delay)).toEqual([0, 5, 0, 0, 0]);
    expect(value.entries.map((item) => item.scanDepth)).toEqual([null, 7, 1, WORLD_SCAN_DEPTH_MAX, null]);
  });
});

describe('selectWorldEntries 触发', () => {
  it('constant 条目每轮必插，不看关键词', () => {
    const target = book([entry({ constant: true, content: '这个世界有灵气。' })]);
    expect(pick(target, [message('完全无关')])).toHaveLength(1);
  });

  it('keys 任一命中即算命中', () => {
    const target = book([entry({ keys: ['龙', '凤'] })]);
    expect(pick(target, [message('天上飞的凤')])).toHaveLength(1);
    expect(pick(target, [message('地上跑的狗')])).toHaveLength(0);
  });

  it('大小写不敏感；条目开了 caseSensitive 才区分', () => {
    const loose = book([entry({ keys: ['Dragon'] })]);
    expect(pick(loose, [message('a dragon here')])).toHaveLength(1);

    const strict = book([entry({ keys: ['Dragon'], caseSensitive: true })]);
    expect(pick(strict, [message('a dragon here')])).toHaveLength(0);
    expect(pick(strict, [message('a Dragon here')])).toHaveLength(1);
  });

  it('wholeWords 只认词边界', () => {
    const target = book([entry({ keys: ['cat'], wholeWords: true })]);
    expect(pick(target, [message('concatenate')])).toHaveLength(0);
    expect(pick(target, [message('a cat, here')])).toHaveLength(1);
    expect(pick(target, [message('cat')])).toHaveLength(1);
  });

  it('扫描窗口只看末尾 scanDepth 条，缺省 4 条', () => {
    const target = book([entry({ keys: ['龙'] })]);
    const far = [message('龙'), message('无关'), message('无关'), message('无关'), message('无关')];
    expect(far).toHaveLength(5);
    expect(WORLD_SCAN_DEPTH_DEFAULT).toBe(4);
    expect(pick(target, far)).toHaveLength(0);
    // 同一句话挪进窗口就命中：判的是位置，不是内容
    expect(pick(target, [...far.slice(1), message('龙')])).toHaveLength(1);
    expect(pick(target, far, 5)).toHaveLength(1);
  });

  it('scanDepth 被夹到 1..20', () => {
    const target = book([entry({ keys: ['龙'] })]);
    const pair = [message('龙'), message('无关')];
    expect(pick(target, pair, 0)).toHaveLength(0);
    expect(pick(target, pair, -3)).toHaveLength(0);
    expect(pick(target, pair, 2)).toHaveLength(1);

    const long = [message('无关'), message('无关'), message('无关'), message('无关'), message('龙')];
    for (let index = 5; index < 25; index += 1) long.push(message('无关'));
    expect(long).toHaveLength(25);
    expect(WORLD_SCAN_DEPTH_MAX).toBe(20);
    // 第 5 条要 21 条窗口才够得着；上限 20 把它挡在窗口外
    expect(pick(target, long, 21)).toHaveLength(0);
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
      expect(pick(target, [message('龙 甲 乙')])).toHaveLength(item.all ? 1 : 0);
      expect(pick(target, [message('龙 甲')])).toHaveLength(item.some ? 1 : 0);
      expect(pick(target, [message('龙')])).toHaveLength(item.none ? 1 : 0);
    }
  });

  it('selective 但没 secondaryKeys 时只看主关键词', () => {
    const target = book([entry({ keys: ['龙'], selective: true, selectiveLogic: 'andAll' })]);
    expect(pick(target, [message('龙')])).toHaveLength(1);
  });
});

describe('selectWorldEntries 排序与不设字数上限', () => {
  it('按 order 升序，同 order 按 id 升序，且不改动原书顺序', () => {
    const target = book([
      entry({ id: 3, order: 50, constant: true, content: 'c' }),
      entry({ id: 9, order: 10, constant: true, content: 'b' }),
      entry({ id: 2, order: 10, constant: true, content: 'a' }),
    ]);
    const picked = pick(target, [message('无关')]);
    expect(picked.map((item) => item.id)).toEqual([2, 9, 3]);
    expect(target.entries.map((item) => item.id)).toEqual([3, 9, 2]);
  });

  it('总量超过 4000 字不再裁条目：两条 3000 字常驻整条都收', () => {
    const big = 'x'.repeat(3000);
    const target = book([
      entry({ id: 0, constant: true, content: big }),
      entry({ id: 1, constant: true, content: big }),
    ]);
    const result = select(target, [message('无关')]);
    expect(result.entries.map((item) => item.id)).toEqual([0, 1]);
    expect(result.entries.map((item) => item.content)).toEqual([big, big]);
    expect(result.skipped).toEqual([]);
    // 两条 3000 字正文 + 中间两个换行，一个字都不省
    expect(result.usedChars).toBe(6002);
  });

  it('单条正文远超 4000 也照收，正文不截断', () => {
    const target = book([entry({ constant: true, content: 'x'.repeat(12000) })]);
    const result = select(target, [message('无关')]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toHaveLength(12000);
    expect(result.usedChars).toBe(12000);
  });
});

describe('selectWorldEntries 概率', () => {
  it('probability=100 不掷骰：random 一次都不调用', () => {
    let rolls = 0;
    const target = book([entry({ keys: ['龙'] })]);
    const random = (): number => {
      rolls += 1;
      return 0;
    };
    expect(pick(target, [message('龙')], undefined, { random })).toHaveLength(1);
    expect(rolls).toBe(0);
  });

  it('useProbability=false 时 40% 也必中，同样不掷骰', () => {
    let rolls = 0;
    const target = book([entry({ keys: ['龙'], probability: 40, useProbability: false })]);
    const random = (): number => {
      rolls += 1;
      return 0.99;
    };
    expect(pick(target, [message('龙')], undefined, { random })).toHaveLength(1);
    expect(rolls).toBe(0);
  });

  it('random()*100 与 probability 比较：39 中、40 不中', () => {
    const target = book([entry({ keys: ['龙'], probability: 40 })]);
    expect(pick(target, [message('龙')], undefined, { random: () => 0.39 })).toHaveLength(1);
    expect(pick(target, [message('龙')], undefined, { random: () => 0.4 })).toHaveLength(0);
  });

  it('probability=0 必不中，且 skipped 记 probability', () => {
    const target = book([entry({ keys: ['龙'], probability: 0 })]);
    const result = select(target, [message('龙')]);
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([{ id: 0, name: '条目', reason: 'probability' }]);
  });
});

describe('selectWorldEntries 包含组', () => {
  it('同组三条只活 groupWeight 最大的，其余记 group', () => {
    const target = book([
      entry({ id: 0, name: '一百', group: '龙组', groupWeight: 100, constant: true }),
      entry({ id: 1, name: '三百', group: '龙组', groupWeight: 300, constant: true }),
      entry({ id: 2, name: '二百', group: '龙组', groupWeight: 200, constant: true }),
    ]);

    const result = select(target, [message('无关')]);
    expect(result.entries.map((item) => item.id)).toEqual([1]);
    // 权重降序排完，输家按 200、100 的顺序落进 skipped
    expect(result.skipped.map((item) => item.id)).toEqual([2, 0]);
    expect(result.skipped.every((item) => item.reason === 'group')).toBe(true);
  });

  it('权重并列取 order 小的，order 也并列取 id 小的', () => {
    const byOrder = book([
      entry({ id: 2, group: '龙组', groupWeight: 100, order: 50, constant: true }),
      entry({ id: 9, group: '龙组', groupWeight: 100, order: 10, constant: true }),
    ]);
    expect(select(byOrder, [message('无关')]).entries.map((item) => item.id)).toEqual([9]);

    const byId = book([
      entry({ id: 5, group: '龙组', groupWeight: 100, order: 10, constant: true }),
      entry({ id: 3, group: '龙组', groupWeight: 100, order: 10, constant: true }),
    ]);
    expect(select(byId, [message('无关')]).entries.map((item) => item.id)).toEqual([3]);
  });

  it('不同组各活一条；空 group 的条目互不相干', () => {
    const target = book([
      entry({ id: 0, group: '甲组', groupWeight: 100, order: 10, constant: true }),
      entry({ id: 1, group: '甲组', groupWeight: 200, order: 20, constant: true }),
      entry({ id: 2, group: '乙组', groupWeight: 100, order: 30, constant: true }),
      entry({ id: 3, group: '乙组', groupWeight: 300, order: 40, constant: true }),
      entry({ id: 4, order: 50, constant: true }),
      entry({ id: 5, order: 60, constant: true }),
    ]);

    const result = select(target, [message('无关')]);
    expect(result.entries.map((item) => item.id)).toEqual([1, 3, 4, 5]);
    expect(result.skipped.map((item) => item.id)).toEqual([0, 2]);
  });
});

describe('selectWorldEntries 粘性', () => {
  const stickyBook = (overrides: Partial<WorldEntry> = {}): WorldBook =>
    book([entry({ keys: ['龙'], sticky: 2, ...overrides })]);

  it('首次命中后 stickyUntil = turn + sticky', () => {
    const result = select(stickyBook(), [message('龙')], { turn: 10 });
    expect(result.entries.map((item) => item.id)).toEqual([0]);
    expect(result.state).toEqual([stateRow(0, 12, 0)]);
  });

  it('粘性期内不带关键词也入选，过期那轮不再入选', () => {
    const state = [stateRow(0, 12, 0)];
    expect(pick(stickyBook(), [message('无关')], undefined, { turn: 11, state })).toHaveLength(1);
    expect(pick(stickyBook(), [message('无关')], undefined, { turn: 12, state })).toHaveLength(1);
    expect(pick(stickyBook(), [message('无关')], undefined, { turn: 13, state })).toHaveLength(0);
  });

  it('每命中一轮都顺延：turn=11 命中后 stickyUntil=13', () => {
    const state = [stateRow(0, 12, 0)];
    const result = select(stickyBook(), [message('无关')], { turn: 11, state });
    expect(result.state).toEqual([stateRow(0, 13, 0)]);
  });

  it('粘性期内不掷骰：probability=0 也照样入选', () => {
    let rolls = 0;
    const state = [stateRow(0, 12, 0)];
    const random = (): number => {
      rolls += 1;
      return 0.99;
    };
    expect(pick(stickyBook({ probability: 0 }), [message('无关')], undefined, { turn: 11, state, random })).toHaveLength(1);
    expect(rolls).toBe(0);
  });
});

describe('selectWorldEntries 冷却', () => {
  const cooledBook = (): WorldBook => book([entry({ keys: ['龙'], cooldown: 3 })]);

  it('cooldown=3：turn=10 触发后 11/12/13 被挡且记 cooldown，turn=14 恢复', () => {
    const first = select(cooledBook(), [message('龙')], { turn: 10 });
    expect(first.entries.map((item) => item.id)).toEqual([0]);
    expect(first.state).toEqual([stateRow(0, 0, 13)]);

    for (const turn of [11, 12, 13]) {
      const result = select(cooledBook(), [message('无关')], { turn, state: first.state });
      expect(result.entries).toEqual([]);
      expect(result.skipped).toEqual([{ id: 0, name: '条目', reason: 'cooldown' }]);
    }

    expect(pick(cooledBook(), [message('龙')], undefined, { turn: 14, state: first.state })).toHaveLength(1);
  });
});

describe('selectWorldEntries 延迟', () => {
  it('delay=5：turn=4 被挡且记 delay，turn=5 可触发', () => {
    const target = book([entry({ keys: ['龙'], delay: 5 })]);

    const early = select(target, [message('龙')], { turn: 4 });
    expect(early.entries).toEqual([]);
    expect(early.skipped).toEqual([{ id: 0, name: '条目', reason: 'delay' }]);

    expect(pick(target, [message('龙')], undefined, { turn: 5 })).toHaveLength(1);
  });
});

describe('selectWorldEntries 状态回写', () => {
  it('没入选但仍在冷却的行保留，过期行剔除', () => {
    const target = book([entry({ keys: ['龙'], cooldown: 3 })]);
    const state = [stateRow(0, 0, 13), stateRow(9, 0, 5), stateRow(8, 20, 0)];

    const result = select(target, [message('无关')], { turn: 10, state });
    expect(result.entries).toEqual([]);
    expect(result.state).toEqual([stateRow(0, 0, 13), stateRow(8, 20, 0)]);
  });

  it('入选但既无粘性也无冷却的条目不进 state', () => {
    const target = book([entry({ constant: true })]);
    const result = select(target, [message('无关')], { turn: 10 });
    expect(result.entries).toHaveLength(1);
    expect(result.state).toEqual([]);
  });

  it('过期旧行被这一轮的新行替换', () => {
    const target = book([entry({ keys: ['龙'], sticky: 2 })]);
    const state = [stateRow(0, 12, 0)];

    const result = select(target, [message('龙')], { turn: 20, state });
    expect(result.state).toEqual([stateRow(0, 22, 0)]);
  });
});

describe('selectWorldEntries 位置分组', () => {
  it('五档各一条常驻条目：byPosition 各一条，entries 仍按 order/id 升序', () => {
    const target = book([
      entry({ id: 0, position: 'beforeChar', constant: true, content: '天头' }),
      entry({ id: 1, position: 'afterChar', constant: true, content: '预设后' }),
      entry({ id: 2, position: 'anTop', constant: true, content: 'AN上' }),
      entry({ id: 3, position: 'anBottom', constant: true, content: 'AN下' }),
      entry({ id: 4, position: 'atDepth', constant: true, content: '深度' }),
    ]);

    const result = select(target, [message('无关')]);
    for (const position of WORLD_POSITIONS) {
      expect(result.byPosition[position]).toHaveLength(1);
    }
    expect(result.byPosition.beforeChar[0]?.id).toBe(0);
    expect(result.byPosition.afterChar[0]?.id).toBe(1);
    expect(result.byPosition.anTop[0]?.id).toBe(2);
    expect(result.byPosition.anBottom[0]?.id).toBe(3);
    expect(result.byPosition.atDepth[0]?.id).toBe(4);
    expect(result.entries.map((item) => item.id)).toEqual([0, 1, 2, 3, 4]);
    // 2+3+3+3+2 字正文，四条连接符各 2 字
    expect(result.usedChars).toBe(21);
  });
});

describe('withWorldDepth 按 depth 插进消息队列', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '二' },
    { role: 'user', content: '三' },
    { role: 'assistant', content: '四' },
  ];

  it('depth 大的先插：4 落在队首、2 落在倒数第三条之前、0 落在末条之前', () => {
    const out = withWorldDepth(history, [
      entry({ id: 0, depth: 4, role: 'system', content: '设定四' }),
      entry({ id: 1, depth: 2, role: 'user', content: '设定二' }),
      entry({ id: 2, depth: 0, role: 'assistant', content: '设定零' }),
    ]);

    expect(out.map((item) => item.content)).toEqual(['设定四', '一', '设定二', '二', '三', '设定零', '四']);
    expect(out.map((item) => item.role)).toEqual(['system', 'user', 'user', 'assistant', 'user', 'assistant', 'assistant']);
    // 原数组不被改动
    expect(history.map((item) => item.content)).toEqual(['一', '二', '三', '四']);
  });

  it('depth 超过消息条数时压到队首', () => {
    const out = withWorldDepth([{ role: 'user', content: '唯一' }], [entry({ depth: 9, content: '设定' })]);
    expect(out.map((item) => item.content)).toEqual(['设定', '唯一']);
  });

  it('空条目数组原样返回一份拷贝', () => {
    const out = withWorldDepth(history, []);
    expect(out).toEqual(history);
    expect(out).not.toBe(history);
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

  it('整块超过 4000 字也不截断', () => {
    const tail = 'y'.repeat(2500);
    const block = buildWorldBlock([entry({ content: 'x'.repeat(2500) }), entry({ content: '  ' + tail + '  ' })]);
    expect(block).toBe('【世界书】\n' + 'x'.repeat(2500) + '\n\n' + tail);
  });
});

describe('resolveWorldBooks 层间互斥、层内多本', () => {
  it('channel > guild > global：哪层有启用的书就整层用哪层', () => {
    const channel = record('channel', 'c1', '频道书');
    const guild = record('guild', 'g1', '公会书');
    const global = record('global', '', '全局书');

    expect(resolveWorldBooks([channel], [guild], [global]).map((item) => item.name)).toEqual(['频道书']);
    expect(resolveWorldBooks([], [guild], [global]).map((item) => item.name)).toEqual(['公会书']);
    expect(resolveWorldBooks([], [], [global]).map((item) => item.name)).toEqual(['全局书']);
    expect(resolveWorldBooks([], [], [])).toEqual([]);
  });

  it('同一层的两本都返回，顺序就是传进来的顺序，后面的层一概不看', () => {
    const dragon = record('guild', 'g1', '龙书', { bookId: 'book-dragon' });
    const whale = record('guild', 'g1', '鲸书', { bookId: 'book-whale' });
    const global = record('global', '', '全局书');

    expect(resolveWorldBooks([], [dragon, whale], [global])).toEqual([dragon, whale]);
    // 上层只要有一本启用就轮不到下层：全局书在结果里连影子都没有
    expect(resolveWorldBooks([], [dragon, whale], [global]).map((item) => item.name)).toEqual(['龙书', '鲸书']);
    expect(resolveWorldBooks([], [], [global]).map((item) => item.bookId)).toEqual(['global:']);
  });

  it('返回的是一份新数组：调用方改动不会动到入参', () => {
    const guild = [record('guild', 'g1', '公会书')];
    const picked = resolveWorldBooks([], guild, []);
    picked.pop();
    expect(guild).toHaveLength(1);
  });
});

describe('uniqueWorldBookName 重名加后缀', () => {
  it('没重名原样返回，首尾空白先 trim', () => {
    expect(uniqueWorldBookName([], '江湖设定')).toBe('江湖设定');
    expect(uniqueWorldBookName(['别的书'], '  江湖设定  ')).toBe('江湖设定');
  });

  it('重名加全角括号序号，已占用的序号跳过去', () => {
    expect(uniqueWorldBookName(['江湖设定'], '江湖设定')).toBe('江湖设定（2）');
    expect(uniqueWorldBookName(['江湖设定', '江湖设定（2）'], '江湖设定')).toBe('江湖设定（3）');
    // 「（2）」是别的书自己的名字，不挡没有重名的本名
    expect(uniqueWorldBookName(['江湖设定（2）'], '江湖设定')).toBe('江湖设定');
  });

  it('空名字落成未命名世界书，重名同样加后缀', () => {
    expect(uniqueWorldBookName([], '   ')).toBe('未命名世界书');
    expect(uniqueWorldBookName(['未命名世界书'], '')).toBe('未命名世界书（2）');
  });

  it('老库没存名字：读回归一化时给「未命名世界书」，有名字一个字符都不动', () => {
    expect(normalizeWorldBook({ name: '', entries: [], ignored: [], warnings: [] }).name).toBe(WORLD_BOOK_FALLBACK_NAME);
    expect(normalizeWorldBook({ name: '   ', entries: [], ignored: [], warnings: [] }).name).toBe(WORLD_BOOK_FALLBACK_NAME);
    expect(normalizeWorldBook({ name: ' 江湖设定 ', entries: [], ignored: [], warnings: [] }).name).toBe(' 江湖设定 ');
  });
});

describe('selectWorldEntries 按 bookId 隔离记账', () => {
  it('state 里别的书的同 id 行不算数：A 书没关键词就不入选', () => {
    const target = book([entry({ id: 1, keys: ['龙'], sticky: 2 })]);
    const foreign = [stateRow(1, 90, 0, 'book-b')];
    expect(pick(target, [message('无关')], undefined, { state: foreign, turn: 10 })).toHaveLength(0);

    const own = [stateRow(1, 90, 0, BOOK_ID)];
    expect(pick(target, [message('无关')], undefined, { state: own, turn: 10 })).toHaveLength(1);
  });

  it('两本书各有一条 id=1：粘性只续自己那本的命，冷却也只挡自己那本', () => {
    const shared = [stateRow(1, 20, 0, 'book-dragon'), stateRow(1, 0, 99, 'book-whale')];

    const dragon = book([entry({ id: 1, keys: ['龙'], sticky: 2 })]);
    const dragonResult = select(dragon, [message('无关')], { bookId: 'book-dragon', state: shared, turn: 10 });
    expect(dragonResult.entries.map((item) => item.id)).toEqual([1]);
    expect(dragonResult.state).toEqual([stateRow(1, 12, 0, 'book-dragon')]);

    // 龙书的粘性行对鲸书无效：鲸书只按自己那条冷却走
    const whale = book([entry({ id: 1, keys: ['鲸'], cooldown: 3 })]);
    const whaleResult = select(whale, [message('鲸')], { bookId: 'book-whale', state: shared, turn: 10 });
    expect(whaleResult.entries).toEqual([]);
    expect(whaleResult.skipped).toEqual([{ id: 1, name: '条目', reason: 'cooldown' }]);
    expect(whaleResult.state).toEqual([stateRow(1, 0, 99, 'book-whale')]);
  });
});

describe('mergeWorldSelections 同层多本合并', () => {
  function part(bookId: string, entries: WorldEntry[], messages: readonly { role: string; content: string }[] = [message('无关')]): WorldBookPart {
    return { bookId, selection: selectWorldEntries(book(entries), messages, { bookId }) };
  }

  it('两本书的条目合进同一档：先按 order，再按书序，最后按 id', () => {
    const dragon = part('book-dragon', [
      entry({ id: 5, order: 30, constant: true, content: '龙-30' }),
      entry({ id: 1, order: 10, constant: true, content: '龙-10' }),
    ]);
    const whale = part('book-whale', [
      entry({ id: 1, order: 20, constant: true, content: '鲸-20' }),
      entry({ id: 9, order: 10, constant: true, content: '鲸-10' }),
    ]);

    const merged = mergeWorldSelections([dragon, whale]);
    // order=10 的两条按书序（龙书先传）排，同书内才看 id
    expect(merged.byPosition.anTop.map((item) => item.content)).toEqual(['龙-10', '鲸-10', '鲸-20', '龙-30']);
    expect(merged.usedChars).toBe(dragon.selection.usedChars + whale.selection.usedChars);
    expect(merged.skipped).toEqual([]);
  });

  it('两本书按各自的 position 各进各档，互不挤占', () => {
    const dragon = part('book-dragon', [entry({ id: 0, constant: true, position: 'beforeChar', content: '天头' })]);
    const whale = part('book-whale', [entry({ id: 0, constant: true, position: 'atDepth', content: '深度' })]);

    const merged = mergeWorldSelections([dragon, whale]);
    expect(merged.byPosition.beforeChar.map((item) => item.content)).toEqual(['天头']);
    expect(merged.byPosition.atDepth.map((item) => item.content)).toEqual(['深度']);
    expect(merged.byPosition.anTop).toEqual([]);
  });

  it('skipped 带书 id：两本书各挡一条也能分清是哪本', () => {
    const dragon = part('book-dragon', [entry({ id: 1, keys: ['龙'], probability: 0 })], [message('龙')]);
    const whale: WorldBookPart = {
      bookId: 'book-whale',
      selection: selectWorldEntries(book([entry({ id: 1, keys: ['鲸'], cooldown: 3 })]), [message('无关')], {
        bookId: 'book-whale',
        turn: 1,
        state: [stateRow(1, 0, 9, 'book-whale')],
      }),
    };

    const merged = mergeWorldSelections([dragon, whale]);
    expect(merged.skipped).toEqual([
      { id: 1, name: '条目', reason: 'probability', bookId: 'book-dragon' },
      { id: 1, name: '条目', reason: 'cooldown', bookId: 'book-whale' },
    ]);
    expect(merged.byPosition.anTop).toEqual([]);
  });

  it('空 parts 等于没有世界书：三档全空、字数 0', () => {
    const merged = mergeWorldSelections([]);
    for (const position of WORLD_POSITIONS) expect(merged.byPosition[position]).toEqual([]);
    expect(merged.usedChars).toBe(0);
    expect(merged.skipped).toEqual([]);
  });
});
