import { TEMPLATE_VARS } from './template';

export interface ImportedSegment {
  name: string;
  role: 'system' | 'user';
  content: string;
  enabled: boolean;
  placement: 'before' | 'after';
}

/** 被搬去「深度注入」的段：后台要按名字告诉用户它去哪了 */
export interface MovedEntry {
  identifier: string;
  name: string;
}

export interface IgnoredEntry {
  identifier: string;
  name: string;
  reason: 'marker' | 'empty' | 'badRole';
}

export interface PresetImport {
  segments: ImportedSegment[];
  /** 拼好的深度注入正文；没有就是空串，不是 undefined */
  postHistory: string;
  moved: MovedEntry[];
  ignored: IgnoredEntry[];
  charName: string;
  warnings: string[];
}

/**
 * 与注入写入侧的 INJECTION_CONTENT_MAX_CHARS 同值：导入时先截一次，
 * 免得用户在预设里看到的字数上限和后台卡片里的上限对不上。
 */
export const POST_HISTORY_MAX_CHARS = 20000;

export type PresetImportResult =
  | { ok: true; value: PresetImport }
  | { ok: false; error: 'BAD_PRESET' | 'NO_SEGMENTS'; detail: string };

/** 酒馆约定：主对话（非角色卡、非群聊）的 prompt_order 固定用这个 character_id */
const MAIN_CHARACTER_ID = 100000;

/** 酒馆约定的历史后注入段 identifier */
const POST_HISTORY_IDENTIFIER = 'jailbreak';

/** 酒馆的「按深度注入」：injection_position 为 1 */
const INJECTION_POSITION_DEPTH = 1;

const MAX_CLEARED_WARNINGS = 10;

/** 与 HTTP 层共用同一张变量表：这里留下的变量，保存时不会判成未知变量 */
const KEPT_MACROS: readonly string[] = TEMPLATE_VARS;

const MACRO_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/**
 * 有名字但本阶段没有来源的宏：清空并在 warnings 里点名。
 * 表外的 {{...}} 不属于这个名单，保留原文交给调用方判断（HTTP 层会做未知变量校验）。
 */
const CLEARED_MACROS = new Set<string>([
  'description',
  'persona',
  'personality',
  'scenario',
  'original',
  'mesexamples',
  'mesexamplesraw',
  'charprompt',
  'charinstruction',
  'charscenario',
  'chardescription',
  'charpersonality',
  'userpersona',
  'personadescription',
  'system',
  'input',
  'lastmessage',
  'lastusermessage',
  'lastcharmessage',
  'firstmessage',
  'group',
  'groupnotmuted',
  'notchar',
  'model',
  'maxprompt',
  'maxresponse',
  'lastgenerationtype',
  'ismobile',
  'idleduration',
  'noop',
  'trim',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 段自己的开关：只有明确写了 false 才算关，缺字段按酒馆默认（开）处理 */
function isEntryEnabled(entry: Record<string, unknown>): boolean {
  return entry['enabled'] !== false;
}

/**
 * 历史后注入段：jailbreak，或注射位置为「按深度注入」。
 * 它们进 messages 的位置由深度决定，跟系统提示词的先后无关，所以整段搬走。
 */
function isPostHistoryEntry(entry: Record<string, unknown>, identifier: string): boolean {
  return identifier === POST_HISTORY_IDENTIFIER || entry['injection_position'] === INJECTION_POSITION_DEPTH;
}

interface OrderItem {
  identifier: string;
  enabled: boolean;
}

/**
 * 展开 prompt_order：酒馆把「这条链」挂在某个 character_id 下，预设里 100000（主对话）那一项
 * 常常是空数组，真正的顺序在 100001 那一项里。所以取**第一个非空**的顺序表：先看 100000，
 * 再按文件顺序往后找；全都空才当「没有顺序表」，让调用方回落到 prompts 原顺序。
 * 结构不认识时也返回 null —— 顺序表坏掉不该让整份预设报废。
 */
function readPromptOrder(raw: unknown): OrderItem[] | null {
  if (!Array.isArray(raw)) return null;
  const groups = raw.filter(isRecord);
  const isFilled = (group: Record<string, unknown>): boolean => {
    const order = group['order'];
    return Array.isArray(order) && order.length > 0;
  };
  const chosen =
    groups.find((group) => group['character_id'] === MAIN_CHARACTER_ID && isFilled(group)) ??
    groups.find(isFilled);
  if (chosen === undefined) return null;
  const order = chosen['order'] as unknown[];

  const items: OrderItem[] = [];
  for (const entry of order) {
    if (!isRecord(entry)) continue;
    const identifier = readText(entry['identifier']).trim();
    if (identifier === '') continue;
    items.push({ identifier, enabled: entry['enabled'] !== false });
  }
  return items;
}

/**
 * 一遍扫完所有宏：String.replace 不会回头扫描替换结果，所以 {{user}} -> {{user_name}}
 * 这类改写不会被二次展开，charName 里就算带宏也原样落下。
 */
function mapMacros(
  content: string,
  charName: string,
  noteCharMissing: (macro: string) => void,
  noteCleared: (macro: string) => void,
  noteUnknown: (macro: string) => void,
): string {
  const charMissing = charName.trim() === '';
  return content.replace(new RegExp(MACRO_PATTERN.source, 'g'), (raw: string, name: string) => {
    const key = name.toLowerCase();
    if (key === 'char' || key === 'charifnotgroup') {
      if (charMissing) {
        noteCharMissing(name);
        return raw;
      }
      return charName;
    }
    if (key === 'user') return '{{user_name}}';
    if (key === 'time' || key === 'date' || key === 'datetime') return '{{date}}';
    if (CLEARED_MACROS.has(key)) {
      noteCleared(name);
      return '';
    }
    if (KEPT_MACROS.includes(name)) return raw;
    noteUnknown(name);
    return raw;
  });
}

export function importSillyTavernPreset(raw: unknown, charName: string): PresetImportResult {
  if (!isRecord(raw)) return { ok: false, error: 'BAD_PRESET', detail: '预设不是 JSON 对象' };
  const prompts = raw['prompts'];
  if (!Array.isArray(prompts)) return { ok: false, error: 'BAD_PRESET', detail: '预设缺少 prompts 数组' };

  const char = typeof charName === 'string' ? charName : '';
  const segments: ImportedSegment[] = [];
  const moved: MovedEntry[] = [];
  const postHistoryParts: string[] = [];
  const ignored: IgnoredEntry[] = [];
  const warnings: string[] = [];
  const seenWarnings = new Set<string>();
  const clearedWarnings = new Set<string>();

  const note = (message: string): void => {
    if (seenWarnings.has(message)) return;
    seenWarnings.add(message);
    warnings.push(message);
  };
  const noteCleared = (macro: string): void => {
    const message = '已清空宏 {{' + macro + '}}';
    if (clearedWarnings.has(message) || clearedWarnings.size >= MAX_CLEARED_WARNINGS) return;
    clearedWarnings.add(message);
    warnings.push(message);
  };
  const noteUnknown = (macro: string): void => note('unknown variable {{' + macro + '}}');

  const entries = prompts.filter(isRecord);
  if (entries.length !== prompts.length) {
    note('已跳过 ' + (prompts.length - entries.length) + ' 个非对象段条目');
  }

  const order = readPromptOrder(raw['prompt_order']);
  const used = new Set<number>();
  const plan: Array<{ index: number; enabled: boolean }> = [];
  for (const item of order ?? []) {
    const index = entries.findIndex(
      (entry, i) => !used.has(i) && readText(entry['identifier']).trim() === item.identifier,
    );
    if (index === -1) {
      note('prompt_order 引用了不存在的段 ' + item.identifier);
      continue;
    }
    used.add(index);
    plan.push({ index, enabled: item.enabled && isEntryEnabled(entries[index]) });
  }
  // 顺序表之外（或整份缺失）的段按原顺序接在后面：启用与否只看段自己的 enabled
  for (let index = 0; index < entries.length; index += 1) {
    if (!used.has(index)) plan.push({ index, enabled: isEntryEnabled(entries[index]) });
  }

  for (const { index, enabled } of plan) {
    const entry = entries[index];
    const identifier = readText(entry['identifier']).trim();
    const rawName = readText(entry['name']).trim();
    const displayName =
      rawName !== '' ? rawName : identifier !== '' ? identifier : '段 ' + (segments.length + 1);
    const ignoredName = rawName !== '' ? rawName : identifier !== '' ? identifier : '段 ' + (index + 1);

    if (entry['marker'] === true) {
      ignored.push({ identifier, name: ignoredName, reason: 'marker' });
      continue;
    }
    const content = readText(entry['content']);
    if (content.trim() === '') {
      ignored.push({ identifier, name: ignoredName, reason: 'empty' });
      continue;
    }

    const rawRole = entry['role'];
    let role: 'system' | 'user' = 'system';
    if (rawRole === 'user') {
      role = 'user';
    } else if (rawRole !== undefined && rawRole !== null && rawRole !== '' && rawRole !== 'system') {
      const label = typeof rawRole === 'string' ? rawRole : '非字符串';
      note('段「' + displayName + '」的 role 为 ' + label + '，已按 system 处理');
    }

    const mapped = mapMacros(
      content,
      char,
      (macro) => note('charName 为空，保留宏 {{' + macro + '}}'),
      noteCleared,
      noteUnknown,
    );
    // 预设里关着的段照样导进来，保它自己的 enabled=false：正文不丢，发不发由后台决定。
    // 深度注入没有「单条停用」这回事，所以关着的后置段也留成停用段，不搬去注入。
    if (!enabled) {
      segments.push({ name: displayName, role, content: mapped, enabled: false, placement: 'before' });
      continue;
    }

    // 历史后注入段：改成由 injection 通道按深度插入，这里只把正文按出现顺序攒起来
    if (isPostHistoryEntry(entry, identifier)) {
      moved.push({ identifier, name: displayName });
      postHistoryParts.push(mapped);
      continue;
    }

    segments.push({ name: displayName, role, content: mapped, enabled, placement: 'before' });
  }

  const joined = postHistoryParts.join('\n\n');
  // 按码点截断，别把 emoji / 生僻字劈成半个代理对
  const postHistoryPoints = Array.from(joined);
  const truncated = postHistoryPoints.length > POST_HISTORY_MAX_CHARS;
  if (truncated) note('深度注入正文超过 ' + POST_HISTORY_MAX_CHARS + ' 字，已截断');
  const postHistory = truncated ? postHistoryPoints.slice(0, POST_HISTORY_MAX_CHARS).join('') : joined;

  if (segments.length === 0) {
    return { ok: false, error: 'NO_SEGMENTS', detail: '预设里没有可用的提示词段' };
  }

  return { ok: true, value: { segments, postHistory, moved, ignored, charName: char, warnings } };
}
