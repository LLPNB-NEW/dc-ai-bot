import type { ChatMessage, Role, Scope, ScopedKey } from '../types';

/** 插入位置：与酒馆的五档一一对应，`atDepth` 是唯一进消息队列的一档 */
export type WorldPosition = 'beforeChar' | 'afterChar' | 'anTop' | 'anBottom' | 'atDepth';

export const WORLD_POSITIONS: readonly WorldPosition[] = ['beforeChar', 'afterChar', 'anTop', 'anBottom', 'atDepth'];

/** 一条世界书条目：把酒馆几套字段名收敛成一份，触发与拼接只认这里的形状 */
export interface WorldEntry {
  id: number;
  name: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  selectiveLogic: 'andAny' | 'andAll' | 'notAny' | 'notAll';
  order: number;
  caseSensitive: boolean;
  wholeWords: boolean;
  /** 插到哪一段：system 的四个锚点，或按 depth 插进历史消息 */
  position: WorldPosition;
  /** 只对 atDepth 有意义：从倒数第几条之前插入 */
  depth: number;
  /** 只对 atDepth 有意义：这条消息以谁的口吻出现 */
  role: Role;
  /** 触发概率 0–100；100 表示必中，不再掷骰 */
  probability: number;
  /** 酒馆的开关：关掉就忽略 probability，按必中处理 */
  useProbability: boolean;
  /** 包含组：同组最多活一条，空串表示不参与分组 */
  group: string;
  /** 组内权重，大者胜 */
  groupWeight: number;
  /** 命中后还能继续活几轮（按轮滑动续期） */
  sticky: number;
  /** 触发后冷却几轮 */
  cooldown: number;
  /** 频道消息数不足这个值时永不触发 */
  delay: number;
  /** 这条自己的扫描深度；null 表示用书级默认 */
  scanDepth: number | null;
}

/** 被跳过的条目：导入回执要说清「为什么这条没进来」，否则用户会以为书丢了 */
export interface WorldIgnored {
  identifier: string;
  name: string;
  reason: 'empty' | 'noKeys' | 'disabled';
}

/** 一本世界书：ignored 与 warnings 分开记，因为前者是条目的取舍、后者是格式的毛病 */
export interface WorldBook {
  name: string;
  entries: WorldEntry[];
  ignored: WorldIgnored[];
  warnings: string[];
  /** 下一次手动新建该给什么 id：只增不减，删掉最大号再新建也不复用（粘性/冷却按 entryId 记账） */
  nextEntryId?: number;
}

export type WorldBookParseResult =
  | { ok: true; value: WorldBook }
  | { ok: false; error: 'BAD_WORLDBOOK' | 'NO_WORLD_ENTRIES'; detail: string };

/** 落库后的一本世界书：entryCount 冗余存一份，列表页不必反序列化整本书 */
export interface WorldBookRecord extends ScopedKey {
  /** 一本一个稳定 id：条目 id 只在书内唯一，粘性/冷却记账靠它把两本书的同号条目分开 */
  bookId: string;
  name: string;
  book: WorldBook;
  entryCount: number;
  importedAt: string;
  /** 整本开关：停用只影响装配，书与条目都留在库里，后台随时能再开 */
  enabled: boolean;
}

export interface WorldBookStore {
  list(): Promise<WorldBookRecord[]>;
  /** 按 bookId 单取一本：单条编辑/删除只需要这一本，不必把整层甚至整个库反序列化 */
  get(bookId: string): Promise<WorldBookRecord | null>;
  create(input: { scope: Scope; scopeId: string; name: string; book: WorldBook }): Promise<WorldBookRecord>;
  /** 局部更新：没给的字段保持原值；bookId 不存在回 null，由调用方决定 404 */
  update(input: { bookId: string; name?: string; book?: WorldBook; enabled?: boolean }): Promise<WorldBookRecord | null>;
  remove(bookId: string): Promise<void>;
}

/** 一条条目的粘性/冷却记账：轮次口径 = 该频道已存消息条数，落库才能活过重启 */
export interface WorldEntryState {
  /** 这条账属于哪本书：两本书都有 id=1 的条目，光靠 entryId 会串 */
  bookId: string;
  entryId: number;
  /** 到这一轮（含）仍然有效；0 表示没有粘性 */
  stickyUntil: number;
  /** 到这一轮（含）不得再触发；0 表示不在冷却 */
  cooldownUntil: number;
}

/** 粘性/冷却的持久化端口：按频道存一份，与 WorldBookStore 同处，装配时一起接线 */
export interface WorldBookStateStore {
  load(guildId: string, channelId: string): Promise<WorldEntryState[]>;
  save(guildId: string, channelId: string, rows: readonly WorldEntryState[]): Promise<void>;
}

export const WORLD_SCAN_DEPTH_DEFAULT = 4;
export const WORLD_SCAN_DEPTH_MAX = 20;
/** 与 injection.ts 的 INJECTION_DEPTH_MAX 同口径：插得比这更深已经没有意义 */
export const WORLD_DEPTH_MAX = 50;
export const WORLD_PROBABILITY_DEFAULT = 100;
export const WORLD_GROUP_WEIGHT_DEFAULT = 100;
/** 老库里有书没存名字：后台总得有个可点的标签，重名同样按这个基准加后缀 */
export const WORLD_BOOK_FALLBACK_NAME = '未命名世界书';

/** 本仓库其余解析器的同款判据：数组也是 object，必须先排掉 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 取第一个「有值」的同义字段：显式的空数组也算有值，
 * 因为「keys: []」在酒馆里就是「这条没有关键词」，不能退回用 key 字段。
 */
function pickField(entry: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = entry[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * 关键词列表：数组照抄；单个字符串按逗号拆，
 * 因为有些导出把多关键词塞进一个逗号串，不拆就等于整串当一个关键词。
 */
function readKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    const keys: string[] = [];
    for (const item of value) {
      const text = readText(item).trim();
      if (text !== '') keys.push(text);
    }
    return keys;
  }
  const text = readText(value);
  if (text.trim() === '') return [];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 数字容忍字符串，因为部分导出把 insertion_order 写成 "100" */
function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 布尔除了 true/false 还要认 0/1：酒馆导出里两种写法都出现过 */
function readFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  return fallback;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

/**
 * ST 口径数字码：0=↑Char、1=↓Char、2=↑AN、3=↓AN、4=@D。
 * 缺省给 anTop：本仓库老库里的书没有这个字段，落到现有【世界书】位置才不会改变旧行为。
 */
export function readWorldPosition(value: unknown): WorldPosition {
  if (typeof value === 'number' && Number.isFinite(value)) {
    switch (Math.floor(value)) {
      case 0:
        return 'beforeChar';
      case 1:
        return 'afterChar';
      case 3:
        return 'anBottom';
      case 4:
        return 'atDepth';
      default:
        return 'anTop';
    }
  }
  const text = readText(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
  switch (text) {
    case '0':
    case 'beforechar':
      return 'beforeChar';
    case '1':
    case 'afterchar':
      return 'afterChar';
    case '3':
    case 'anbottom':
      return 'anBottom';
    case '4':
    case 'atdepth':
      return 'atDepth';
    case '2':
    case 'antop':
      return 'anTop';
    default:
      return 'anTop';
  }
}

/** ST 的角色码：0=system、1=user、2=assistant；写错的导出按 system 处理 */
export function readWorldRole(value: unknown): Role {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Math.floor(value) === 1) return 'user';
    if (Math.floor(value) === 2) return 'assistant';
    return 'system';
  }
  const text = readText(value).trim().toLowerCase();
  if (text === 'user') return 'user';
  if (text === 'assistant') return 'assistant';
  return 'system';
}

/**
 * ST 口径数字码：0=AND ANY、1=NOT ALL、2=NOT ANY、3=AND ALL。
 * 用 switch 而不是映射表查表，是为了让未知值落到 andAny 时一眼能看出来。
 */
function readSelectiveLogic(value: unknown): WorldEntry['selectiveLogic'] {
  switch (value) {
    case 0:
      return 'andAny';
    case 1:
      return 'notAll';
    case 2:
      return 'notAny';
    case 3:
      return 'andAll';
    default:
      break;
  }
  const text = readText(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (text === 'notall') return 'notAll';
  if (text === 'notany') return 'notAny';
  if (text === 'andall') return 'andAll';
  return 'andAny';
}

interface EntrySlot {
  entry: unknown;
  /** 对象形式下用原键，回落数字下标：ignored.ignored 的 identifier 要能和原书对上号 */
  identifier: string;
  id: number;
}

interface EntrySource {
  slots: EntrySlot[];
  name: string;
}

/** 角色卡 V2 把书塞在 data.character_book；也兼容非 V2 直接放顶层的 character_book */
function pickCharacterBook(raw: Record<string, unknown>): Record<string, unknown> | null {
  const data = raw['data'];
  if (isRecord(data) && isRecord(data['character_book'])) return data['character_book'];
  if (isRecord(raw['character_book'])) return raw['character_book'];
  return null;
}

function readEntrySlots(container: unknown): EntrySlot[] | null {
  if (Array.isArray(container)) {
    return container.map((entry, index) => ({ entry, identifier: String(index), id: index }));
  }
  if (isRecord(container)) {
    return Object.keys(container).map((key, index) => {
      const numeric = Number(key);
      const id = Number.isInteger(numeric) && numeric >= 0 ? numeric : index;
      return { entry: container[key], identifier: key, id };
    });
  }
  return null;
}

/** 书名的优先级：顶层 name > data.name > character_book.name > '' */
function readBookName(raw: Record<string, unknown>, characterBook: Record<string, unknown> | null): string {
  const data = raw['data'];
  const candidates = [
    raw['name'],
    isRecord(data) ? data['name'] : undefined,
    characterBook === null ? undefined : characterBook['name'],
  ];
  for (const candidate of candidates) {
    const text = readText(candidate).trim();
    if (text !== '') return text;
  }
  return '';
}

function collectSource(raw: unknown): EntrySource | null {
  if (Array.isArray(raw)) {
    const slots = readEntrySlots(raw);
    return slots === null ? null : { slots, name: '' };
  }
  if (!isRecord(raw)) return null;
  const characterBook = pickCharacterBook(raw);
  const container = characterBook === null ? raw['entries'] : characterBook['entries'];
  const slots = readEntrySlots(container);
  if (slots === null) return null;
  return { slots, name: readBookName(raw, characterBook) };
}

/**
 * 解析世界书。三种输入（ST 导出的 entries 对象/数组、角色卡 V2、顶层数组）在这里合流，
 * 之后的触发与拼接只面对 WorldEntry 一种形状。
 */
export function parseWorldBook(raw: unknown): WorldBookParseResult {
  const source = collectSource(raw);
  if (source === null) {
    return { ok: false, error: 'BAD_WORLDBOOK', detail: '找不到世界书条目（既没有 entries，也不是可识别的角色卡）' };
  }

  const entries: WorldEntry[] = [];
  const ignored: WorldIgnored[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (const slot of source.slots) {
    if (!isRecord(slot.entry)) {
      skipped += 1;
      continue;
    }
    const item = slot.entry;
    const keys = readKeys(pickField(item, ['keys', 'key', 'keywords']));
    const secondaryKeys = readKeys(pickField(item, ['secondaryKeys', 'keysecondary', 'secondary_keys']));
    const content = readText(pickField(item, ['content', 'text']));
    const comment = readText(pickField(item, ['comment', 'name', 'title'])).trim();
    const name = comment !== '' ? comment : keys.length > 0 ? keys[0] : '条目 ' + String(slot.id);
    // 酒馆有两个相反口径的开关：enabled=false 与 disable=true 都表示停用，任一成立就不得参与触发
    const enabled = readFlag(item['enabled'], true) && !readFlag(item['disable'], false);
    const constant = readFlag(item['constant'], false);

    // 空正文的条目留着只会让 system 多出一串空行，先判它：这是三条里最没救的一条
    if (content.trim() === '') {
      ignored.push({ identifier: slot.identifier, name, reason: 'empty' });
      continue;
    }
    if (!enabled) {
      ignored.push({ identifier: slot.identifier, name, reason: 'disabled' });
      continue;
    }
    // constant 条目本来就不靠关键词触发，没 keys 也照样每轮插
    if (keys.length === 0 && !constant) {
      ignored.push({ identifier: slot.identifier, name, reason: 'noKeys' });
      continue;
    }

    const probability = clampInt(readNumber(pickField(item, ['probability']), WORLD_PROBABILITY_DEFAULT), 0, 100, WORLD_PROBABILITY_DEFAULT);
    const rawScanDepth = pickField(item, ['scanDepth', 'scan_depth']);
    entries.push({
      id: slot.id,
      name,
      keys,
      secondaryKeys,
      content,
      enabled,
      constant,
      selective: readFlag(item['selective'], false),
      selectiveLogic: readSelectiveLogic(item['selectiveLogic']),
      order: readNumber(pickField(item, ['insertion_order', 'order', 'priority']), 100),
      caseSensitive: readFlag(pickField(item, ['caseSensitive', 'case_sensitive']), false),
      wholeWords: readFlag(pickField(item, ['matchWholeWords', 'match_whole_words']), false),
      position: readWorldPosition(pickField(item, ['position'])),
      depth: clampInt(readNumber(pickField(item, ['depth']), WORLD_SCAN_DEPTH_DEFAULT), 0, WORLD_DEPTH_MAX, WORLD_SCAN_DEPTH_DEFAULT),
      role: readWorldRole(pickField(item, ['role'])),
      probability,
      // 老导出只有 probability 没有开关：概率小于 100 就是「要用概率」，否则关掉
      useProbability: readFlag(pickField(item, ['useProbability', 'use_probability']), probability < WORLD_PROBABILITY_DEFAULT),
      group: readText(pickField(item, ['group'])).trim(),
      groupWeight: clampInt(readNumber(pickField(item, ['groupWeight', 'group_weight']), WORLD_GROUP_WEIGHT_DEFAULT), 0, 100000, WORLD_GROUP_WEIGHT_DEFAULT),
      sticky: clampInt(readNumber(pickField(item, ['sticky']), 0), 0, 10000, 0),
      cooldown: clampInt(readNumber(pickField(item, ['cooldown']), 0), 0, 10000, 0),
      delay: clampInt(readNumber(pickField(item, ['delay']), 0), 0, 100000, 0),
      scanDepth: rawScanDepth === undefined ? null : clampScanDepth(readNumber(rawScanDepth, WORLD_SCAN_DEPTH_DEFAULT)),
    });
  }

  if (skipped > 0) warnings.push('已跳过 ' + String(skipped) + ' 个非对象条目');
  if (entries.length === 0) {
    return {
      ok: false,
      error: 'NO_WORLD_ENTRIES',
      detail: '世界书里没有可用条目（跳过 ' + String(ignored.length) + ' 条）',
    };
  }
  return { ok: true, value: { name: source.name, entries, ignored, warnings } };
}

/**
 * 老库里的 book_json 是上一版规范化的产物，没有位置/概率/粘性这些字段。
 * 读侧统一过一遍这里，选择管线就永远面对完整形状——缺省值刻意选 anTop，保持旧书的位置与行为。
 */
export function normalizeWorldEntry(entry: WorldEntry): WorldEntry {
  const raw = entry as Partial<WorldEntry>;
  const probability = clampInt(typeof raw.probability === 'number' ? raw.probability : WORLD_PROBABILITY_DEFAULT, 0, 100, WORLD_PROBABILITY_DEFAULT);
  const scanDepth = raw.scanDepth;
  return {
    ...entry,
    position: raw.position === undefined ? 'anTop' : readWorldPosition(raw.position),
    depth: clampInt(typeof raw.depth === 'number' ? raw.depth : WORLD_SCAN_DEPTH_DEFAULT, 0, WORLD_DEPTH_MAX, WORLD_SCAN_DEPTH_DEFAULT),
    role: raw.role === undefined ? 'system' : readWorldRole(raw.role),
    probability,
    useProbability: raw.useProbability === undefined ? probability < WORLD_PROBABILITY_DEFAULT : readFlag(raw.useProbability, true),
    group: typeof raw.group === 'string' ? raw.group.trim() : '',
    groupWeight: clampInt(typeof raw.groupWeight === 'number' ? raw.groupWeight : WORLD_GROUP_WEIGHT_DEFAULT, 0, 100000, WORLD_GROUP_WEIGHT_DEFAULT),
    sticky: clampInt(typeof raw.sticky === 'number' ? raw.sticky : 0, 0, 10000, 0),
    cooldown: clampInt(typeof raw.cooldown === 'number' ? raw.cooldown : 0, 0, 10000, 0),
    delay: clampInt(typeof raw.delay === 'number' ? raw.delay : 0, 0, 100000, 0),
    scanDepth: typeof scanDepth === 'number' && Number.isFinite(scanDepth) ? clampScanDepth(scanDepth) : null,
  };
}

export function normalizeWorldBook(book: WorldBook): WorldBook {
  const raw = book as Partial<WorldBook>;
  const nextEntryId = typeof raw.nextEntryId === 'number' && Number.isFinite(raw.nextEntryId) && raw.nextEntryId > 0 ? Math.trunc(raw.nextEntryId) : null;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : WORLD_BOOK_FALLBACK_NAME,
    entries: Array.isArray(raw.entries) ? raw.entries.map(normalizeWorldEntry) : [],
    ignored: Array.isArray(raw.ignored) ? raw.ignored : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    ...(nextEntryId === null ? {} : { nextEntryId }),
  };
}

/**
 * 层间仍是整层互斥（channel > guild > global），层内则是「所有启用的书一起上」：
 * 传进来的三组已经按层筛过（同一层 + enabled），哪层非空就用哪一层，全空等于没配世界书。
 */
export function resolveWorldBooks(
  channel: readonly WorldBookRecord[],
  guild: readonly WorldBookRecord[],
  global: readonly WorldBookRecord[],
): WorldBookRecord[] {
  if (channel.length > 0) return [...channel];
  if (guild.length > 0) return [...guild];
  return [...global];
}

/**
 * 同一层导入同名书时自动让路：不做「同名覆盖」（导入永远新增一本），
 * 名字后缀只为了后台能分辨，不参与任何匹配。
 */
export function uniqueWorldBookName(existing: readonly string[], wanted: string): string {
  const base = wanted.trim() === '' ? WORLD_BOOK_FALLBACK_NAME : wanted.trim();
  if (!existing.includes(base)) return base;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = base + '（' + String(index) + '）';
    if (!existing.includes(candidate)) return candidate;
  }
  return base + '（' + String(Date.now()) + '）';
}

function isWordChar(char: string): boolean {
  return /[0-9A-Za-z_]/.test(char);
}

/**
 * 整词匹配自己找边界，而不是拼 \b 正则：
 * 关键词里带空格、标点或中文时 \b 的语义就失效了，这里只认「两侧不是字母数字下划线」。
 */
function containsKeyword(haystack: string, keyword: string, wholeWords: boolean): boolean {
  if (keyword === '') return false;
  if (!wholeWords) return haystack.includes(keyword);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(keyword, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack.charAt(at - 1);
    const after = haystack.charAt(at + keyword.length);
    const leftOk = before === '' || !isWordChar(before);
    const rightOk = after === '' || !isWordChar(after);
    if (leftOk && rightOk) return true;
    from = at + 1;
  }
}

function clampScanDepth(scanDepth: number | undefined): number {
  if (scanDepth === undefined || !Number.isFinite(scanDepth)) return WORLD_SCAN_DEPTH_DEFAULT;
  const floored = Math.floor(scanDepth);
  if (floored < 1) return 1;
  if (floored > WORLD_SCAN_DEPTH_MAX) return WORLD_SCAN_DEPTH_MAX;
  return floored;
}

/** 扫窗口只看每层正文：把多段拼一起判「任一命中」，与 ST 的扫描缓冲同义 */
function buildScanWindow(messages: readonly { role: string; content: string }[], depth: number): string {
  const start = Math.max(0, messages.length - depth);
  return messages
    .slice(start)
    .map((message) => message.content)
    .join('\n');
}

function matchesEntry(entry: WorldEntry, window: string): boolean {
  // constant 每轮必插，连窗口都不必看
  if (entry.constant) return true;
  const haystack = entry.caseSensitive ? window : window.toLowerCase();
  const hit = (key: string): boolean => containsKeyword(haystack, entry.caseSensitive ? key : key.toLowerCase(), entry.wholeWords);
  if (!entry.keys.some(hit)) return false;
  if (!entry.selective || entry.secondaryKeys.length === 0) return true;
  const secondary = entry.secondaryKeys.map(hit);
  switch (entry.selectiveLogic) {
    case 'andAll':
      return secondary.every((value) => value);
    case 'notAny':
      return secondary.every((value) => !value);
    case 'notAll':
      return secondary.some((value) => !value);
    default:
      return secondary.some((value) => value);
  }
}

/** 被跳过的条目与原因：排障时「为什么这条没出现」全靠它 */
export interface WorldSkip {
  id: number;
  name: string;
  reason: 'delay' | 'cooldown' | 'probability' | 'group';
}

/** 一本书的取舍结果；多本同时启用时由 mergeWorldSelections 拼成一份 */
export interface WorldSelection {
  /** 最终入选的条目，已按 order/id 升序（不设字数上限，见 §79） */
  entries: WorldEntry[];
  /** 同 entries，按插入位置分好，供装配处各自成段 */
  byPosition: Record<WorldPosition, WorldEntry[]>;
  skipped: WorldSkip[];
  /** 下一轮要落库的粘性/冷却：过期的行不会出现在这里 */
  state: WorldEntryState[];
  usedChars: number;
}

export interface WorldSelectOptions {
  /** 这本书的 id：产出的粘性/冷却记账要带上它，两本书的同号条目才不会串 */
  bookId?: string;
  /** 书级默认扫描深度；条目自己的 scanDepth 优先 */
  scanDepth?: number;
  /** 上一轮落库的粘性/冷却（调用方按 bookId 先筛好，这里再筛一次也不贵） */
  state?: readonly WorldEntryState[];
  /** 当前轮次 = 该频道已存消息条数；缺省 0（第一轮） */
  turn?: number;
  /** 测试注入的随机源，返回 [0,1) */
  random?: () => number;
}

function emptyByPosition(): Record<WorldPosition, WorldEntry[]> {
  return { beforeChar: [], afterChar: [], anTop: [], anBottom: [], atDepth: [] };
}

/** 概率掷骰：100% 不消耗随机数，「这次掷了几次骰」才可数 */
function rollProbability(entry: WorldEntry, random: () => number): boolean {
  if (!entry.useProbability) return true;
  if (entry.probability >= WORLD_PROBABILITY_DEFAULT) return true;
  if (entry.probability <= 0) return false;
  return random() * 100 < entry.probability;
}

/**
 * 选一本书里的条目，顺序与酒馆一致：
 * 关键词/常驻 → 延迟 → 粘性（直接续命）→ 冷却 → 概率 → 包含组取权重最高 → order/id 升序。
 * 不设字数上限（§79）：入选的条目全部注入，挤占上下文由预设与历史条数共同决定。
 */
export function selectWorldEntries(
  book: WorldBook,
  messages: readonly { role: string; content: string }[],
  options: WorldSelectOptions = {},
): WorldSelection {
  const defaultDepth = clampScanDepth(options.scanDepth);
  const turn = Math.max(0, Math.floor(options.turn ?? 0));
  const random = options.random ?? Math.random;
  const bookId = options.bookId ?? '';
  const previous = new Map<number, WorldEntryState>();
  for (const row of options.state ?? []) {
    if (row.bookId !== bookId) continue;
    previous.set(row.entryId, row);
  }

  const windows = new Map<number, string>();
  const windowFor = (depth: number): string => {
    const cached = windows.get(depth);
    if (cached !== undefined) return cached;
    const built = buildScanWindow(messages, depth);
    windows.set(depth, built);
    return built;
  };

  const candidates: WorldEntry[] = [];
  const skipped: WorldSkip[] = [];
  for (const entry of book.entries) {
    const state = previous.get(entry.id);
    // 粘性期内既不看了关键词也不掷骰：酒馆的粘性就是「上一轮在，这一轮还在」，每轮顺延
    if (entry.sticky > 0 && state !== undefined && state.stickyUntil >= turn) {
      candidates.push(entry);
      continue;
    }
    if (entry.cooldown > 0 && state !== undefined && state.cooldownUntil >= turn) {
      skipped.push({ id: entry.id, name: entry.name, reason: 'cooldown' });
      continue;
    }
    if (entry.delay > 0 && turn < entry.delay) {
      skipped.push({ id: entry.id, name: entry.name, reason: 'delay' });
      continue;
    }
    if (!matchesEntry(entry, windowFor(entry.scanDepth ?? defaultDepth))) continue;
    if (!rollProbability(entry, random)) {
      skipped.push({ id: entry.id, name: entry.name, reason: 'probability' });
      continue;
    }
    candidates.push(entry);
  }

  // 包含组：先各自过完关键词与概率，再在组内取权重最高；并列时 order 小的优先
  const grouped = new Map<string, WorldEntry[]>();
  const winners: WorldEntry[] = [];
  for (const entry of candidates) {
    if (entry.group === '') {
      winners.push(entry);
      continue;
    }
    const members = grouped.get(entry.group);
    if (members === undefined) grouped.set(entry.group, [entry]);
    else members.push(entry);
  }
  for (const members of grouped.values()) {
    members.sort((left, right) => right.groupWeight - left.groupWeight || left.order - right.order || left.id - right.id);
    winners.push(members[0]!);
    for (const loser of members.slice(1)) skipped.push({ id: loser.id, name: loser.name, reason: 'group' });
  }
  winners.sort((left, right) => left.order - right.order || left.id - right.id);

  // 正文为空等于没写：整条丢，但不记 skip（它不是被规则挡下的）
  const entries = winners.filter((entry) => entry.content.trim() !== '');
  let used = 0;
  for (const entry of entries) used += entry.content.trim().length + (used === 0 ? 0 : 2);

  // 记账：没入选的条目只要粘性/冷却还没过期就保留原行，否则下一轮就漏挡了
  const next = new Map<number, WorldEntryState>();
  for (const row of previous.values()) {
    if (row.stickyUntil > turn || row.cooldownUntil > turn) next.set(row.entryId, row);
  }
  for (const entry of entries) {
    const stickyUntil = entry.sticky > 0 ? turn + entry.sticky : 0;
    const cooldownUntil = entry.cooldown > 0 ? turn + entry.cooldown : 0;
    if (stickyUntil > turn || cooldownUntil > turn) {
      next.set(entry.id, { bookId, entryId: entry.id, stickyUntil, cooldownUntil });
    } else {
      next.delete(entry.id);
    }
  }

  const byPosition = emptyByPosition();
  for (const entry of entries) byPosition[entry.position].push(entry);

  return { entries, byPosition, skipped, state: [...next.values()], usedChars: used };
}

/** 一本书的取舍结果，带上它的 id（排障日志与粘性/冷却记账都要能指回书） */
export interface WorldBookPart {
  bookId: string;
  selection: WorldSelection;
}

export interface WorldSkipBook extends WorldSkip {
  bookId: string;
}

/** 多本书拼起来之后的同一份选择：层内所有启用的书一起生效（§79） */
export interface MergedWorldSelection {
  byPosition: Record<WorldPosition, WorldEntry[]>;
  skipped: WorldSkipBook[];
  usedChars: number;
}

/**
 * 合并同层多本书的取舍结果。组与概率都是按书各自算的（酒馆的包含组也是一本书内的概念），
 * 这里只做拼接：每档位置内按 (order, 书序, id) 排，书序 = 传进来的顺序，保证同一份库每次渲染一致。
 */
export function mergeWorldSelections(parts: readonly WorldBookPart[]): MergedWorldSelection {
  const byPosition = emptyByPosition();
  const skipped: WorldSkipBook[] = [];
  let usedChars = 0;
  const ordered: { part: number; entry: WorldEntry }[] = [];
  parts.forEach((part, index) => {
    usedChars += part.selection.usedChars;
    for (const skip of part.selection.skipped) skipped.push({ ...skip, bookId: part.bookId });
    for (const entry of part.selection.entries) ordered.push({ part: index, entry });
  });
  ordered.sort(
    (left, right) =>
      left.entry.order - right.entry.order ||
      left.part - right.part ||
      left.entry.id - right.entry.id,
  );
  for (const item of ordered) byPosition[item.entry.position].push(item.entry);
  return { byPosition, skipped, usedChars };
}

/**
 * 把 @D 条目插进消息队列：depth 大的先插（离末尾更远），同深度的按 order 升序，
 * 这样浅层条目最终落在深层之后，读起来仍是 order 的顺序。
 */
export function withWorldDepth(messages: readonly ChatMessage[], entries: readonly WorldEntry[]): ChatMessage[] {
  if (entries.length === 0) return [...messages];
  const ordered = [...entries].sort((left, right) => right.depth - left.depth || left.order - right.order || left.id - right.id);
  const out = [...messages];
  for (const entry of ordered) {
    const body = entry.content.trim();
    if (body === '') continue;
    const limit = Math.max(0, out.length - 1);
    const depth = clampInt(entry.depth, 0, limit, 0);
    const at = out.length === 0 ? 0 : limit - depth;
    out.splice(at, 0, { role: entry.role, content: body });
  }
  return out;
}

/** 合成一段 system 文本；标题行让模型知道这一段的出处，也让排障时一眼能认出 */
export function buildWorldBlock(entries: readonly WorldEntry[]): string {
  const bodies: string[] = [];
  for (const entry of entries) {
    const body = entry.content.trim();
    if (body !== '') bodies.push(body);
  }
  if (bodies.length === 0) return '';
  return '【世界书】\n' + bodies.join('\n\n');
}
