import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  INJECTION_CONTENT_MAX_CHARS,
  INJECTION_DEPTH_MAX,
  INJECTION_ROLE_LABELS,
  INJECTION_ROLES,
  PROMPT_DEFAULT_KEYS,
  PROMPT_DEFAULT_MAX_CHARS,
  PROMPT_DEFAULT_SCOPES,
  PROMPT_DEFAULTS_VARS,
  PROMPT_PLACEMENT_IDS,
  PROMPT_PLACEMENT_LABELS,
  PROMPT_ROLE_IDS,
  PROMPT_ROLE_LABELS,
  TEMPLATE_VARS,
  WORLD_BOOK_IGNORE_REASONS,
  WORLD_BOOK_NAME_MAX,
  WORLD_BOOK_NAME_RULE,
  WORLD_COOLDOWN_MAX,
  WORLD_DELAY_MAX,
  WORLD_DEPTH_MAX,
  WORLD_ENTRY_ROLE_LABELS,
  WORLD_ENTRY_ROLES,
  WORLD_GROUP_WEIGHT_DEFAULT,
  WORLD_GROUP_WEIGHT_MAX,
  WORLD_POSITION_LABELS,
  WORLD_POSITIONS,
  WORLD_PROBABILITY_DEFAULT,
  WORLD_SCAN_DEPTH_DEFAULT,
  WORLD_SCAN_DEPTH_MAX,
  WORLD_SELECTIVE_LOGIC_LABELS,
  WORLD_SELECTIVE_LOGICS,
  WORLD_STICKY_MAX,
  api,
  clearPromptDefault,
  clearPromptInjection,
  createWorldBookEntry,
  deleteWorldBook,
  deleteWorldBookEntry,
  describeError,
  describePromptCopyRejection,
  describePromptDefaultsError,
  describePromptImportError,
  describePromptInjectionError,
  describeScopeTarget,
  describeWorldBookEntryError,
  describeWorldBookError,
  fetchPromptDefaults,
  fetchWorldBookEntry,
  fetchPromptInjections,
  fetchWorldBook,
  formatNumber,
  importWorldBook,
  normalizeScopeId,
  parseOptionalNumber,
  previewPromptDefault,
  renameWorldBook,
  savePromptDefault,
  savePromptInjection,
  saveWorldBookEntry,
  updateWorldBookEnabled,
  type InjectionRole,
  type PromptCopyResult,
  type PromptDefaultEntry,
  type PromptDefaultKey,
  type PromptDefaultPreview,
  type PromptDefaultsSnapshot,
  type PromptImportIgnoreReason,
  type PromptImportResult,
  type PromptInjectionLayer,
  type PromptItem,
  type PromptPlacement,
  type PromptRole,
  type PromptSegmentInput,
  type Scope,
  type WorldBookEntry,
  type WorldBookEntrySummary,
  type WorldBookIgnoreReason,
  type WorldBookImportResult,
  type WorldBook,
  type WorldEntryRole,
  type WorldPosition,
  type WorldSelectiveLogic,
} from '../api';
import ScopeField from '../components/ScopeField';

/** 编辑中的一段：position 不存在草稿里，列表顺序就是保存后的段顺序。 */
interface SegmentDraft {
  /** 列表 key：服务端返回的段用它自己的 id，新加的段在本地生成。 */
  key: string;
  name: string;
  role: PromptRole;
  content: string;
  enabled: boolean;
  placement: PromptPlacement;
}

let draftSeed = 0;

function newDraftKey(): string {
  draftSeed += 1;
  return 'new-' + String(draftSeed);
}

function emptyDraft(): SegmentDraft {
  return { key: newDraftKey(), name: '', role: 'system', content: '', enabled: true, placement: 'before' };
}

// 服务端按 position 升序拼段，编辑器也照这个顺序渲染；position 撞车时用 id 兜一个稳定次序。
function toDrafts(segments: PromptItem['segments']): SegmentDraft[] {
  return segments
    .slice()
    .sort((left, right) => (left.position === right.position ? left.id.localeCompare(right.id) : left.position - right.position))
    .map((segment) => ({
      key: segment.id,
      name: segment.name,
      role: segment.role,
      content: segment.content,
      enabled: segment.enabled,
      placement: segment.placement,
    }));
}

// 「填入示例」给的是 identity 模板的默认形状：某行变量为空时整行不出现，所以一行只放一个变量。
const IDENTITY_EXAMPLE = [
  '【当前对话】',
  '和你说话的是 {{user_name}}（ID {{user_id}}）',
  '这里：{{guild_name}} · {{channel_name}}',
  '今天 {{date}}',
].join('\n');

const PROMPT_DEFAULT_HEADINGS: Record<PromptDefaultKey, string> = {
  fallback: '内置默认提示词（fallback）',
  identity: '身份块（identity）',
};

const PROMPT_DEFAULT_TITLES: Record<PromptDefaultKey, string> = {
  fallback: '内置默认提示词',
  identity: '身份块',
};

// 三层 tab 上的短标题：SCOPE_LABELS 带「（global）」括号后缀，一行三个 tab 放不下。
const PROMPT_SCOPE_TITLES: Record<Scope, string> = { channel: '频道', guild: '服务器', global: '全局' };

// 导入目标层的写法：global 就说 global，其它层点名「频道 123」；二次确认与结果区共用这一种写法。
function describeImportTarget(scope: Scope, scopeId: string): string {
  return scope === 'global' ? 'global' : PROMPT_SCOPE_TITLES[scope] + ' ' + normalizeScopeId(scope, scopeId);
}

// 复制卡片的作用域写法：global 就写「全局」，其它层点名「频道（scopeId 123）」；确认文案与结果行共用这一种写法。
function describeCopyTarget(scope: Scope, scopeId: string): string {
  if (scope === 'global') return '全局';
  return PROMPT_SCOPE_TITLES[scope] + '（scopeId ' + normalizeScopeId(scope, scopeId) + '）';
}

const NO_NOTE: Record<PromptDefaultKey, string> = { fallback: '', identity: '' };

/** 预览防抖：输入停 500ms 才打 POST /preview，打字过程中不发请求。 */
const PREVIEW_DEBOUNCE_MS = 500;

// 契约 sillytavern-import 的四个忽略原因：分组顺序与文案写死在这里，结果区按这个顺序列。
const IMPORT_REASON_IDS: PromptImportIgnoreReason[] = ['marker', 'empty', 'badRole'];
const IMPORT_REASON_LABELS: Record<PromptImportIgnoreReason, string> = {
  marker: '占位标记（marker）',
  empty: '空段（empty）',
  badRole: '角色不支持（badRole）',
};
const IMPORT_NAME_LIMIT = 5;
const IMPORT_WARNING_LIMIT = 10;

// 角色名用于替换 {{char}}：酒馆把它放在三个位置，按 char_name → name → data.name 取第一个非空字符串。
function guessCharName(preset: unknown): string {
  const record: Record<string, unknown> = preset !== null && typeof preset === 'object' ? (preset as Record<string, unknown>) : {};
  const data: Record<string, unknown> =
    record.data !== null && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {};
  for (const candidate of [record.char_name, record.name, data.name]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return '';
}

// 只在前端判定「是不是合法 JSON」：解析失败就不发请求，结果里给后端留的只有解析成功的对象。
// 预设与世界书共用：两边都是「粘一个 JSON → 后端判结构」。
function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// 被忽略的条目常常没名字（酒馆的空段就是无名条目），退回它的 identifier 才认得出来是哪一条。
// 只取两个字段，预设与世界书的 ignored 都能传进来。
function ignoredEntryLabel(entry: { identifier: string; name: string }): string {
  const name = entry.name.trim();
  return name === '' ? entry.identifier : name;
}

// 只到秒：毫秒对「什么时候存的」没意义，还会把状态行撑宽。
function formatSavedAt(at: string): string {
  if (at === '') return '未知时间';
  const value = new Date(at);
  if (Number.isNaN(value.getTime())) return at;
  return value.toLocaleString('zh-CN', { hour12: false });
}

// 契约 world-book 的三种忽略原因：分组顺序与文案写死在这里，结果区按这个顺序列。
const WORLD_BOOK_REASON_LABELS: Record<WorldBookIgnoreReason, string> = {
  empty: '正文空白（empty）',
  noKeys: '没有关键词（noKeys）',
  disabled: '条目停用（disabled）',
};
const WORLD_BOOK_NAME_LIMIT = 5;
const WORLD_BOOK_WARNING_LIMIT = 10;
/** 关键词念前 3 个就够，多出来的折成 +N：一条塞十几个关键词会把整行撑爆。 */
const WORLD_BOOK_KEYS_LIMIT = 3;
/** 摘要表最多渲染 50 行：整本几百条时先保住页面响应，剩下的只报计数。 */
const WORLD_BOOK_ROWS_LIMIT = 50;

// 关键词列：超过 3 个折成 +N；常驻条目不靠关键词触发，照实说清，别让人以为关键词写错了。
function describeWorldBookKeys(entry: WorldBookEntrySummary): string {
  const secondary = entry.secondaryKeys.length === 0 ? '' : '（辅 ' + String(entry.secondaryKeys.length) + '）';
  if (entry.constant) return '（常驻，不看关键词）' + secondary;
  const head = entry.keys.slice(0, WORLD_BOOK_KEYS_LIMIT).join('、');
  if (head === '') return '（无关键词）' + secondary;
  const extra = entry.keys.length - WORLD_BOOK_KEYS_LIMIT;
  return (extra > 0 ? head + ' +' + String(extra) : head) + secondary;
}

// 结论行：导入永远新增一本，所以只说新书名、写入条数与这一层现在几本。
function describeWorldBookOutcome(result: WorldBookImportResult): string {
  const name = result.name === '' ? '（未命名）' : result.name;
  return '已新增「' + name + '」：写入 ' + String(result.entryCount) + ' 条，这一层现在共 ' + String(result.layerCount) + ' 本';
}

// 逐条编辑：数字字段先存字符串，留空与越界统一在保存前判，输入过程中不拦人。
interface WorldEntryDraft {
  id: number;
  name: string;
  content: string;
  enabled: boolean;
  constant: boolean;
  /** 关键词输入框的原文：逗号或换行分隔，保存时才拆成数组。 */
  keys: string;
  secondaryKeys: string;
  caseSensitive: boolean;
  wholeWords: boolean;
  selective: boolean;
  selectiveLogic: WorldSelectiveLogic;
  position: WorldPosition;
  depth: string;
  role: WorldEntryRole;
  probability: string;
  useProbability: boolean;
  group: string;
  groupWeight: string;
  sticky: string;
  cooldown: string;
  delay: string;
  scanDepth: string;
  order: string;
}

/** 需要行内提示的字段：其余字段是勾选 / 下拉，前端没有可校验的输入。 */
type WorldEntryFieldKey =
  | 'name'
  | 'content'
  | 'depth'
  | 'probability'
  | 'groupWeight'
  | 'sticky'
  | 'cooldown'
  | 'delay'
  | 'scanDepth'
  | 'order';

type WorldEntryFieldErrors = Partial<Record<WorldEntryFieldKey, string>>;

/** 关键词输入框：中英文逗号与换行都算分隔符，空白项丢掉（与后端 readKeys 同口径）。 */
function splitWorldKeys(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function joinWorldKeys(keys: readonly string[]): string {
  return keys.join(', ');
}

function toWorldEntryDraft(entry: WorldBookEntry): WorldEntryDraft {
  return {
    id: entry.id,
    name: entry.name,
    content: entry.content,
    enabled: entry.enabled,
    constant: entry.constant,
    keys: joinWorldKeys(entry.keys),
    secondaryKeys: joinWorldKeys(entry.secondaryKeys),
    caseSensitive: entry.caseSensitive,
    wholeWords: entry.wholeWords,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    position: entry.position,
    depth: String(entry.depth),
    role: entry.role,
    probability: String(entry.probability),
    useProbability: entry.useProbability,
    group: entry.group,
    groupWeight: String(entry.groupWeight),
    sticky: String(entry.sticky),
    cooldown: String(entry.cooldown),
    delay: String(entry.delay),
    scanDepth: entry.scanDepth === null ? '' : String(entry.scanDepth),
    order: String(entry.order),
  };
}

/** 新建模式的草稿：id 固定 0（后端按本层 max id + 1 分配），其余取后端缺省口径。 */
function newWorldEntryDraft(): WorldEntryDraft {
  return {
    id: 0,
    name: '',
    content: '',
    enabled: true,
    constant: false,
    keys: '',
    secondaryKeys: '',
    caseSensitive: false,
    wholeWords: false,
    selective: false,
    selectiveLogic: 'andAny',
    position: 'anTop',
    depth: String(WORLD_SCAN_DEPTH_DEFAULT),
    role: 'system',
    probability: String(WORLD_PROBABILITY_DEFAULT),
    useProbability: false,
    group: '',
    groupWeight: String(WORLD_GROUP_WEIGHT_DEFAULT),
    sticky: '0',
    cooldown: '0',
    delay: '0',
    scanDepth: '',
    order: '0',
  };
}

/**
 * 整数输入：范围与后端 clamp 同界，超出就不发请求，免得后端静默截断。
 * 输入框不挂 min/max：浏览器会把键入值和回填值夹到边界（100001 显示成 100000），
 * 行内提示就永远看不到，state 与 DOM 也会对不上。
 */
function readWorldInteger(
  raw: string,
  min: number | null,
  max: number | null,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '') return { ok: false, error: label + '必填' };
  const value = Number(text);
  // isSafeInteger 一并挡掉 NaN/Infinity/小数：接口校验只收安全整数。
  if (!Number.isSafeInteger(value)) return { ok: false, error: label + '要填整数' };
  if (min !== null && value < min) return { ok: false, error: label + '不能小于 ' + String(min) };
  if (max !== null && value > max) return { ok: false, error: label + '不能大于 ' + String(max) };
  return { ok: true, value };
}

/** 保存前一次收齐所有问题：返回 entry 才能发请求，返回 errors 就逐个字段标红。 */
function buildWorldEntry(
  draft: WorldEntryDraft,
): { ok: true; entry: WorldBookEntry } | { ok: false; errors: WorldEntryFieldErrors } {
  const errors: WorldEntryFieldErrors = {};
  const name = draft.name.trim();
  if (name === '') errors.name = '名字必填';
  if (draft.content.trim() === '') errors.content = '正文必填';

  const depth = readWorldInteger(draft.depth, 0, WORLD_DEPTH_MAX, '深度');
  if (!depth.ok) errors.depth = depth.error;
  const probability = readWorldInteger(draft.probability, 0, 100, '概率');
  if (!probability.ok) errors.probability = probability.error;
  const groupWeight = readWorldInteger(draft.groupWeight, 0, WORLD_GROUP_WEIGHT_MAX, '组权重');
  if (!groupWeight.ok) errors.groupWeight = groupWeight.error;
  const sticky = readWorldInteger(draft.sticky, 0, WORLD_STICKY_MAX, '粘性');
  if (!sticky.ok) errors.sticky = sticky.error;
  const cooldown = readWorldInteger(draft.cooldown, 0, WORLD_COOLDOWN_MAX, '冷却');
  if (!cooldown.ok) errors.cooldown = cooldown.error;
  const delay = readWorldInteger(draft.delay, 0, WORLD_DELAY_MAX, '延迟');
  if (!delay.ok) errors.delay = delay.error;
  const order = readWorldInteger(draft.order, null, null, '排序');
  if (!order.ok) errors.order = order.error;

  // 留空 = 用书级默认（null）；填了就必须是 1–20 的整数。
  const scanText = draft.scanDepth.trim();
  let scanDepth: number | null = null;
  if (scanText !== '') {
    const scan = readWorldInteger(scanText, 1, WORLD_SCAN_DEPTH_MAX, '扫描深度');
    if (scan.ok) scanDepth = scan.value;
    else errors.scanDepth = scan.error;
  }

  if (
    !depth.ok ||
    !probability.ok ||
    !groupWeight.ok ||
    !sticky.ok ||
    !cooldown.ok ||
    !delay.ok ||
    !order.ok ||
    Object.keys(errors).length > 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    entry: {
      id: draft.id,
      name,
      keys: splitWorldKeys(draft.keys),
      secondaryKeys: splitWorldKeys(draft.secondaryKeys),
      content: draft.content,
      enabled: draft.enabled,
      constant: draft.constant,
      selective: draft.selective,
      selectiveLogic: draft.selectiveLogic,
      order: order.value,
      caseSensitive: draft.caseSensitive,
      wholeWords: draft.wholeWords,
      position: draft.position,
      depth: depth.value,
      role: draft.role,
      probability: probability.value,
      useProbability: draft.useProbability,
      group: draft.group.trim(),
      groupWeight: groupWeight.value,
      sticky: sticky.value,
      cooldown: cooldown.value,
      delay: delay.value,
      scanDepth,
    },
  };
}

/** 保存回执 → 列表行：正文不留在行里，字数按码点数（与后端 chars 同口径）。 */
function toWorldEntrySummary(entry: WorldBookEntry): WorldBookEntrySummary {
  return {
    id: entry.id,
    name: entry.name,
    keys: entry.keys,
    secondaryKeys: entry.secondaryKeys,
    enabled: entry.enabled,
    constant: entry.constant,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    order: entry.order,
    caseSensitive: entry.caseSensitive,
    wholeWords: entry.wholeWords,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
    probability: entry.probability,
    useProbability: entry.useProbability,
    group: entry.group,
    groupWeight: entry.groupWeight,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    scanDepth: entry.scanDepth,
    chars: Array.from(entry.content).length,
  };
}

// 一层的 key 就是 scope + scopeId（global 的 scopeId 固定空串），与后端同一套定位方式。
function entryAt(
  snapshot: PromptDefaultsSnapshot | null,
  key: PromptDefaultKey,
  scope: Scope,
  scopeId: string,
): PromptDefaultEntry | undefined {
  if (snapshot === null) return undefined;
  const target = normalizeScopeId(scope, scopeId);
  return snapshot.items.find((item) => item.key === key && item.scope === scope && item.scopeId === target);
}

// 预览里的占位符统一按 {{名字}} 显示：后端回的名字不带花括号。
function describeVarToken(name: string): string {
  return '{{' + name + '}}';
}

export default function PromptsPage() {
  const [scope, setScope] = useState<Scope>('global');
  const [scopeId, setScopeId] = useState('');
  const [segments, setSegments] = useState<SegmentDraft[]>([]);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [items, setItems] = useState<PromptItem[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [defaults, setDefaults] = useState<PromptDefaultsSnapshot | null>(null);
  const [defaultLoadError, setDefaultLoadError] = useState('');
  // 三层各自的「具体目标 ID」分开记：频道 ID 填进服务器层只会存错地方。
  const [defaultScope, setDefaultScope] = useState<Scope>('global');
  const [defaultTargetIds, setDefaultTargetIds] = useState<Record<Scope, string>>({ channel: '', guild: '', global: '' });
  const [fallbackDraft, setFallbackDraft] = useState('');
  const [identityDraft, setIdentityDraft] = useState('');
  const [defaultBusy, setDefaultBusy] = useState<PromptDefaultKey | null>(null);
  const [defaultErrors, setDefaultErrors] = useState<Record<PromptDefaultKey, string>>(NO_NOTE);
  const [defaultMessages, setDefaultMessages] = useState<Record<PromptDefaultKey, string>>(NO_NOTE);
  const [previews, setPreviews] = useState<Record<PromptDefaultKey, PromptDefaultPreview | null>>({
    fallback: null,
    identity: null,
  });
  const [previewErrors, setPreviewErrors] = useState<Record<PromptDefaultKey, string>>(NO_NOTE);
  const [previewBusy, setPreviewBusy] = useState<Record<PromptDefaultKey, boolean>>({ fallback: false, identity: false });
  // 深度注入：整张表一次读回（就三层），编辑区只对应「当前选中的层」。
  const [injections, setInjections] = useState<PromptInjectionLayer[] | null>(null);
  const [injectionScope, setInjectionScope] = useState<Scope>('global');
  const [injectionTargetIds, setInjectionTargetIds] = useState<Record<Scope, string>>({ channel: '', guild: '', global: '' });
  const [injectionContent, setInjectionContent] = useState('');
  const [injectionDepthText, setInjectionDepthText] = useState('0');
  const [injectionRole, setInjectionRole] = useState<InjectionRole>('system');
  const [injectionBusy, setInjectionBusy] = useState(false);
  const [injectionError, setInjectionError] = useState('');
  const [injectionMessage, setInjectionMessage] = useState('');
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const identityRef = useRef<HTMLTextAreaElement | null>(null);
  // 竞态令牌：每次输入变化就 +1，旧响应回来对不上就直接丢掉，不许覆盖新正文的预览。
  const previewEpoch = useRef(0);
  // 酒馆预设导入：内联面板的展开状态 + 已解析好的文件 + 角色名 + 结果 / 错误，都是本页局部状态。
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<{ name: string; preset: unknown } | null>(null);
  const [importCharName, setImportCharName] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<PromptImportResult | null>(null);
  // 导入写哪一层与页面顶部编辑区的 scope / scopeId 互不影响：导入换层不该改掉正在编辑的层。
  const [importScope, setImportScope] = useState<Scope>('global');
  const [importScopeId, setImportScopeId] = useState('');
  // 复制预设：源 / 目标各一份选择，与上面编辑区的 scope 无关——复制完也不把编辑对象切到目标层。
  const [copyFromScope, setCopyFromScope] = useState<Scope>('global');
  const [copyFromScopeId, setCopyFromScopeId] = useState('');
  const [copyToScope, setCopyToScope] = useState<Scope>('channel');
  const [copyToScopeId, setCopyToScopeId] = useState('');
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copyResult, setCopyResult] = useState<PromptCopyResult | null>(null);
  // 世界书：所有层的所有书一次读回；scope + scopeId 筛出当前层的书。
  const [worldBooks, setWorldBooks] = useState<WorldBook[] | null>(null);
  const [worldBookScope, setWorldBookScope] = useState<Scope>('global');
  const [worldBookTargetIds, setWorldBookTargetIds] = useState<Record<Scope, string>>({ channel: '', guild: '', global: '' });
  const [worldBookFile, setWorldBookFile] = useState<{ name: string; book: unknown } | null>(null);
  const [worldBookPaste, setWorldBookPaste] = useState('');
  const [worldBookBusy, setWorldBookBusy] = useState(false);
  const [worldBookError, setWorldBookError] = useState('');
  const [worldBookMessage, setWorldBookMessage] = useState('');
  const [worldBookResult, setWorldBookResult] = useState<WorldBookImportResult | null>(null);
  // 哪一本展开着条目表；一次只展开一本，换层 / 换对象就收起。
  const [worldBookExpandedId, setWorldBookExpandedId] = useState<string | null>(null);
  // 正在 PATCH 整本开关的那一本：只锁这一行的开关，别的书还能操作。
  const [worldBookTogglingId, setWorldBookTogglingId] = useState<string | null>(null);
  // 重命名：一次只开一行；打开时把当前书名填进输入框，保存成功只换这一行的 name。
  const [worldBookRenameId, setWorldBookRenameId] = useState<string | null>(null);
  const [worldBookRenameName, setWorldBookRenameName] = useState('');
  const [worldBookRenameError, setWorldBookRenameError] = useState('');
  const [worldBookRenameBusy, setWorldBookRenameBusy] = useState(false);
  // 逐条编辑：列表只有摘要，正文要打开时现读一条；表单期间不重拉整表，免得冲掉没保存的改动。
  // bookId 与条目 id 一起记：条目 id 只在书内唯一，缺了书就不知道该写哪一本。
  const [worldBookEditBookId, setWorldBookEditBookId] = useState<string | null>(null);
  const [worldBookEditId, setWorldBookEditId] = useState<number | null>(null);
  const [worldBookDraft, setWorldBookDraft] = useState<WorldEntryDraft | null>(null);
  const [worldBookEditLoading, setWorldBookEditLoading] = useState(false);
  const [worldBookEditBusy, setWorldBookEditBusy] = useState(false);
  const [worldBookEditError, setWorldBookEditError] = useState('');
  const [worldBookEditFields, setWorldBookEditFields] = useState<WorldEntryFieldErrors>({});
  // 新建模式与逐条编辑共用同一块表单与同一份草稿。
  // createBookId 为 null = 这一层还没有书，保存时先按书名新建一本；否则直接写进这本书。
  const [worldBookCreating, setWorldBookCreating] = useState(false);
  const [worldBookCreateBookId, setWorldBookCreateBookId] = useState<string | null>(null);
  const [worldBookBookName, setWorldBookBookName] = useState('');
  const [worldBookBookNameError, setWorldBookBookNameError] = useState('');
  // 换层 / 收起 / 再点另一行之后，先前发出的详情响应回来也不许再填回表单。
  const worldBookEditEpoch = useRef(0);

  useEffect(() => {
    void loadItems();
    void loadDefaults();
    void loadInjections();
    void loadWorldBooks();
  }, []);

  // 输入停下 500ms 才发预览：两块一起发，任何一块变正文都让旧响应作废。
  useEffect(() => {
    previewEpoch.current += 1;
    const epoch = previewEpoch.current;
    const timer = window.setTimeout(() => {
      void requestPreview('fallback', fallbackDraft, epoch);
      void requestPreview('identity', identityDraft, epoch);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [fallbackDraft, identityDraft]);

  async function loadItems(): Promise<void> {
    try {
      setItems(await api.listPrompts());
    } catch (err) {
      setError(describeError(err));
    }
  }

  // 选文件：FileReader 读成文本再 JSON.parse；解析失败本地就说清「不是合法 JSON」，一个请求都不发。
  function readImportFile(file: File | null): void {
    setImportError('');
    setImportResult(null);
    if (file === null) {
      setImportFile(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = parseJsonText(text);
      if (!parsed.ok) {
        setImportFile(null);
        setImportError(file.name + ' 不是合法 JSON：换一个酒馆导出的提示词预设文件');
        return;
      }
      setImportFile({ name: file.name, preset: parsed.value });
      const guess = guessCharName(parsed.value);
      // 默认值只在输入框空着时补：已经手填的角色名不覆盖。
      if (guess !== '') setImportCharName((current) => (current.trim() === '' ? guess : current));
    };
    reader.onerror = () => {
      setImportFile(null);
      setImportError('读取文件失败：' + file.name);
    };
    reader.readAsText(file);
  }

  function closeImportPanel(): void {
    setImportOpen(false);
    setImportFile(null);
    setImportCharName('');
    setImportScope('global');
    setImportScopeId('');
    setImportBusy(false);
    setImportError('');
    setImportResult(null);
  }

  // 导入前二次确认：文案写明「整层覆盖哪一层」；用户点取消就一个请求都不发。
  async function runImport(): Promise<void> {
    if (importBusy) return;
    const chosen = importFile;
    if (chosen === null) {
      setImportError('先选一个 .json 预设文件');
      return;
    }
    const charName = importCharName.trim();
    if (charName === '') {
      setImportError('角色名用于替换 {{char}}，必填');
      return;
    }
    // global 的 scopeId 恒为空串；其它层没填 ID 连落到哪都不知道，本地拦住，一个请求都不发。
    const targetId = normalizeScopeId(importScope, importScopeId);
    if (importScope !== 'global' && targetId === '') {
      setImportError('先填 频道/服务器 ID，才知道导入到哪一层');
      return;
    }
    const targetLabel = describeImportTarget(importScope, targetId);
    const confirmed = window.confirm(
      '这会整层覆盖 ' +
        targetLabel +
        ' 的提示词：该层原有的段会被全部删除，再写入这份预设的段（其它层不动）。' +
        '若预设里有历史后指令（jailbreak 等），还会一并覆盖该层的深度注入。确定导入？',
    );
    if (!confirmed) return;
    setImportBusy(true);
    setImportError('');
    setImportResult(null);
    try {
      const result = await api.importPromptPreset({
        preset: chosen.preset,
        charName,
        scope: importScope,
        scopeId: targetId,
      });
      setImportResult(result);
      // 列表刷新复用本页的加载函数；编辑区不动，免得冲掉没保存的编辑。
      await loadItems();
    } catch (err) {
      setImportError(describePromptImportError(err));
    } finally {
      setImportBusy(false);
    }
  }

  // 结果区：写入段数 + 覆盖段数、搬去深度注入的段与写入结果、忽略条目按 reason 分组（各列前 5 个名字）、warnings 最多 10 条。
  function renderImportResult(result: PromptImportResult): ReactElement {
    const shownWarnings = result.warnings.slice(0, IMPORT_WARNING_LIMIT);
    // 预设里关着的段现在照样导入：不点出来，用户会以为它们生效了
    const disabledCount = result.segments.filter((item) => !item.enabled).length;
    // 写入层以响应为准（后端可能按自己的定位回填），别拿导入前选的层去猜。
    const writtenTarget = describeImportTarget(result.scope, result.scopeId);
    return (
      <div className="prompt-import-result">
        <p className="ok">{'已写入 ' + String(result.segments.length) + ' 段（覆盖 ' + String(result.replaced) + ' 段）'}</p>
        {disabledCount === 0 ? null : (
          <p className="hint">
            {'其中 ' +
              String(disabledCount) +
              ' 段是预设里关着的，已按停用导入；要让它们生效，就在下面的列表里逐段打开。'}
          </p>
        )}
        {result.moved.length === 0 ? null : (
          // 历史后指令没进段表：不点名说清楚，用户会以为那几段被吞了
          <p className="prompt-import-moved">
            {'搬去深度注入：' +
              result.moved.map(ignoredEntryLabel).join('、') +
              '（' +
              String(result.injection.chars) +
              ' 字，' +
              (result.injection.saved ? '已写入 ' + writtenTarget + ' 深度注入' : '未能写入，请到「深度注入」卡片手动保存') +
              '）' +
              (result.injection.replaced ? '（覆盖了原有的 ' + writtenTarget + ' 深度注入）' : '')}
          </p>
        )}
        <p className="hint">
          {'写入层：' + writtenTarget}
          {result.charName === '' ? '' : '（角色名：' + result.charName + '）'}
          {'；页面上的提示词列表已刷新，上面编辑区还是导入前的内容，点列表里的条目可重新载入。'}
        </p>
        {result.ignored.length === 0 ? null : (
          <ul className="prompt-import-ignored">
            {IMPORT_REASON_IDS.map((reason) => {
              const group = result.ignored.filter((entry) => entry.reason === reason);
              if (group.length === 0) return null;
              const names = group.slice(0, IMPORT_NAME_LIMIT).map(ignoredEntryLabel).join('、');
              return (
                <li key={reason}>
                  {'被忽略 · ' +
                    IMPORT_REASON_LABELS[reason] +
                    '：' +
                    String(group.length) +
                    ' 条 —— ' +
                    names +
                    (group.length > IMPORT_NAME_LIMIT ? ' 等' : '')}
                </li>
              );
            })}
          </ul>
        )}
        {shownWarnings.length === 0 ? null : (
          <ul className="prompt-import-warnings">
            {shownWarnings.map((warning, index) => (
              <li key={String(index)}>{'警告：' + warning}</li>
            ))}
            {result.warnings.length > IMPORT_WARNING_LIMIT ? (
              <li>{'还有 ' + String(result.warnings.length - IMPORT_WARNING_LIMIT) + ' 条'}</li>
            ) : null}
          </ul>
        )}
      </div>
    );
  }

  const copyFromId = normalizeScopeId(copyFromScope, copyFromScopeId);
  const copyToId = normalizeScopeId(copyToScope, copyToScopeId);
  // global 的 scopeId 恒为空串；非全局层没填 ID 连从哪一层复制都不知道，按钮先锁住。
  const copyReady = (copyFromScope === 'global' || copyFromId !== '') && (copyToScope === 'global' || copyToId !== '');

  // 换源 / 换目标就清掉上一次的结果：那句「已复制」写的是另一个作用域。
  function selectCopyFromScope(next: Scope): void {
    setCopyFromScope(next);
    setCopyError('');
    setCopyResult(null);
  }

  function selectCopyFromId(next: string): void {
    setCopyFromScopeId(next);
    setCopyError('');
    setCopyResult(null);
  }

  function selectCopyToScope(next: Scope): void {
    setCopyToScope(next);
    setCopyError('');
    setCopyResult(null);
  }

  function selectCopyToId(next: string): void {
    setCopyToScopeId(next);
    setCopyError('');
    setCopyResult(null);
  }

  // 复制前二次确认：文案写明会覆盖目标层，并点名两侧的 scopeId（global 写「全局」）；用户取消就一个请求都不发。
  async function runCopy(): Promise<void> {
    if (copyBusy) return;
    setCopyError('');
    setCopyResult(null);
    if (!copyReady) {
      setCopyError('先填源 / 目标作用域的 ID（global 层不用填），才知道从哪一层复制到哪一层');
      return;
    }
    const fromLabel = describeCopyTarget(copyFromScope, copyFromId);
    const toLabel = describeCopyTarget(copyToScope, copyToId);
    const confirmed = window.confirm(
      '确定把「' +
        fromLabel +
        '」的提示词预设复制到「' +
        toLabel +
        '」？这会覆盖目标作用域现有的预设：该层原有的段与 temperature / maxTokens 会被整层替换，其它作用域不动。',
    );
    if (!confirmed) return;
    setCopyBusy(true);
    try {
      const result = await api.copyPromptPreset({
        fromScope: copyFromScope,
        fromScopeId: copyFromId,
        toScope: copyToScope,
        toScopeId: copyToId,
      });
      setCopyResult(result);
      // 列表刷新复用本页的加载函数；编辑区保持用户当前选的那一层，不自动跳到目标层。
      await loadItems();
    } catch (err) {
      setCopyError(describePromptCopyRejection(err));
    } finally {
      setCopyBusy(false);
    }
  }

  const defaultTargetId = defaultScope === 'global' ? '' : defaultTargetIds[defaultScope].trim();
  // 频道 / 服务器层没填 ID 时后端一定 400，先禁用保存与恢复。
  const defaultTargetReady = defaultScope === 'global' || defaultTargetId !== '';

  function defaultDraft(key: PromptDefaultKey): string {
    return key === 'fallback' ? fallbackDraft : identityDraft;
  }

  function setDefaultDraft(key: PromptDefaultKey, next: string): void {
    if (key === 'fallback') setFallbackDraft(next);
    else setIdentityDraft(next);
  }

  function setDefaultError(key: PromptDefaultKey, text: string): void {
    setDefaultErrors((current) => ({ ...current, [key]: text }));
  }

  function setDefaultMessage(key: PromptDefaultKey, text: string): void {
    setDefaultMessages((current) => ({ ...current, [key]: text }));
  }

  function setPreview(key: PromptDefaultKey, next: PromptDefaultPreview | null): void {
    setPreviews((current) => ({ ...current, [key]: next }));
  }

  function setPreviewError(key: PromptDefaultKey, text: string): void {
    setPreviewErrors((current) => ({ ...current, [key]: text }));
  }

  function setPreviewLoading(key: PromptDefaultKey, next: boolean): void {
    setPreviewBusy((current) => ({ ...current, [key]: next }));
  }

  // GET 回来的白名单为空按契约常量兜底：页面不能没有 chip。
  function defaultVars(key: PromptDefaultKey): string[] {
    if (defaults === null) return PROMPT_DEFAULTS_VARS[key];
    const vars = defaults.vars[key];
    return vars.length === 0 ? PROMPT_DEFAULTS_VARS[key] : vars;
  }

  // 切层 / 换目标时两块编辑区一起换成该层的内容：没配就是空，placeholder 说明用代码内置。
  function fillDefaultDrafts(snapshot: PromptDefaultsSnapshot | null, scope: Scope, scopeId: string): void {
    for (const key of PROMPT_DEFAULT_KEYS) {
      const entry = entryAt(snapshot, key, scope, scopeId);
      setDefaultDraft(key, entry === undefined ? '' : entry.content);
    }
  }

  function selectDefaultLayer(next: Scope): void {
    if (next === defaultScope) return;
    setDefaultScope(next);
    setDefaultErrors(NO_NOTE);
    setDefaultMessages(NO_NOTE);
    fillDefaultDrafts(defaults, next, next === 'global' ? '' : defaultTargetIds[next]);
  }

  // 换频道 / 服务器 ID 同样要换正文，否则上一条 ID 的内容会被存到这一条上。
  function selectDefaultTarget(nextId: string): void {
    setDefaultTargetIds((current) => ({ ...current, [defaultScope]: nextId }));
    setDefaultErrors(NO_NOTE);
    setDefaultMessages(NO_NOTE);
    fillDefaultDrafts(defaults, defaultScope, nextId);
  }

  // 写入后只刷新快照（拿新的 updatedAt / 哪些层已配置），不动编辑区：另一块可能还有没保存的编辑。
  async function refreshSnapshot(): Promise<void> {
    const snapshot = await fetchPromptDefaults();
    setDefaults(snapshot);
    setDefaultLoadError('');
  }

  async function loadDefaults(): Promise<void> {
    try {
      const snapshot = await fetchPromptDefaults();
      setDefaults(snapshot);
      setDefaultLoadError('');
      fillDefaultDrafts(snapshot, defaultScope, defaultTargetId);
    } catch (err) {
      setDefaultLoadError(describePromptDefaultsError(err));
    }
  }

  // 正文已经落库（或已清掉），刷新只是为了拿到新的 updatedAt / 层状态：读失败也别谎报写入失败。
  async function refreshAfterWrite(key: PromptDefaultKey, done: string): Promise<void> {
    try {
      await refreshSnapshot();
      setDefaultMessage(key, done);
    } catch (err) {
      setDefaultMessage(key, done + '，但刷新状态失败：' + describePromptDefaultsError(err));
    }
  }

  // 变量 chip：插到光标处（有选中内容就替换掉），插完把光标放到占位符后面接着写。
  function insertDefaultVar(key: PromptDefaultKey, name: string): void {
    const token = describeVarToken(name);
    const node = (key === 'fallback' ? fallbackRef : identityRef).current;
    if (node === null) {
      setDefaultDraft(key, defaultDraft(key) + token);
      return;
    }
    const start = node.selectionStart;
    const end = node.selectionEnd;
    setDefaultDraft(key, node.value.slice(0, start) + token + node.value.slice(end));
    // 受控 textarea 要等 React 回写 value 再动光标，同步 setSelectionRange 会被下一次渲染冲掉。
    window.requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function fillIdentityExample(): void {
    if (identityDraft.trim() !== '' && identityDraft !== IDENTITY_EXAMPLE) {
      if (!window.confirm('编辑区已有内容，确定用示例覆盖？')) return;
    }
    setIdentityDraft(IDENTITY_EXAMPLE);
    setDefaultError('identity', '');
    setDefaultMessage('identity', '');
  }

  // 保存只写「当前层 + 当前 key」：另一块没保存的编辑不跟着提交。
  async function saveDefault(key: PromptDefaultKey): Promise<void> {
    if (defaultBusy !== null) return;
    setDefaultError(key, '');
    setDefaultMessage(key, '');
    if (!defaultTargetReady) {
      setDefaultError(key, '先填 ' + PROMPT_SCOPE_TITLES[defaultScope] + ' ID，才知道要存到哪一层');
      return;
    }
    const content = defaultDraft(key);
    // 空正文后端必拒（BAD_PROMPT_CONTENT）；「清空」是「恢复默认」的语义，这里直接拦下并说清走哪条路。
    if (content.trim() === '') {
      setDefaultError(key, '正文不能为空：想回到代码内置默认，请点「恢复默认」');
      return;
    }
    setDefaultBusy(key);
    try {
      await savePromptDefault({ key, scope: defaultScope, scopeId: defaultTargetId, content });
      await refreshAfterWrite(key, '已保存到 ' + describeScopeTarget(defaultScope, defaultTargetId));
    } catch (err) {
      setDefaultError(key, describePromptDefaultsError(err));
    } finally {
      setDefaultBusy(null);
    }
  }

  // 恢复默认 = 只删当前层这一张模板，删完这一层回落到上一层 / 代码内置。
  async function clearDefault(key: PromptDefaultKey): Promise<void> {
    if (defaultBusy !== null) return;
    if (!defaultTargetReady) return;
    const entry = entryAt(defaults, key, defaultScope, defaultTargetId);
    if (entry === undefined) return;
    const targetLabel = describeScopeTarget(defaultScope, defaultTargetId);
    if (!window.confirm('确定清掉「' + PROMPT_DEFAULT_TITLES[key] + '」在 ' + targetLabel + ' 这一层的配置？清掉后回落到上一层或代码内置。')) {
      return;
    }
    setDefaultError(key, '');
    setDefaultMessage(key, '');
    setDefaultBusy(key);
    try {
      await clearPromptDefault({ key, scope: defaultScope, scopeId: defaultTargetId });
      setDefaultDraft(key, '');
      await refreshAfterWrite(key, '已恢复代码内置（' + targetLabel + ' 这一层不再有配置）');
    } catch (err) {
      setDefaultError(key, describePromptDefaultsError(err));
    } finally {
      setDefaultBusy(null);
    }
  }

  // 预览：空白正文不打请求（后端也只会回空串），失败只落在预览区，不拦编辑。
  async function requestPreview(key: PromptDefaultKey, content: string, epoch: number): Promise<void> {
    if (content.trim() === '') {
      if (epoch !== previewEpoch.current) return;
      setPreview(key, null);
      setPreviewError(key, '');
      setPreviewLoading(key, false);
      return;
    }
    if (epoch !== previewEpoch.current) return;
    setPreviewLoading(key, true);
    try {
      const result = await previewPromptDefault({ key, content });
      if (epoch !== previewEpoch.current) return;
      setPreview(key, result);
      setPreviewError(key, '');
    } catch (err) {
      if (epoch !== previewEpoch.current) return;
      setPreviewError(key, describePromptDefaultsError(err));
    } finally {
      if (epoch === previewEpoch.current) setPreviewLoading(key, false);
    }
  }

  function configuredTargetIds(scope: Scope): string[] {
    if (defaults === null) return [];
    const ids: string[] = [];
    for (const item of defaults.items) {
      if (item.scope !== scope || item.scopeId === '') continue;
      if (!ids.includes(item.scopeId)) ids.push(item.scopeId);
    }
    return ids;
  }

  // 全局层是「有没有配」，频道 / 服务器层是「配了几个目标」。
  function configuredSummary(scope: Scope): string {
    if (scope === 'global') {
      const count = defaults === null ? 0 : defaults.items.filter((item) => item.scope === 'global').length;
      return count > 0 ? '已配置' : '未配置';
    }
    const count = configuredTargetIds(scope).length;
    return count > 0 ? '已配置 ' + String(count) + ' 个' : '未配置';
  }

  // 全局层的 scopeId 恒为空；非全局层填了 ID 才定位得到一条记录。
  const injectionTargetId = normalizeScopeId(injectionScope, injectionTargetIds[injectionScope]);

  function injectionAt(layers: PromptInjectionLayer[] | null, scope: Scope, scopeId: string): PromptInjectionLayer | null {
    if (layers === null) return null;
    const target = normalizeScopeId(scope, scopeId);
    return layers.find((item) => item.scope === scope && item.scopeId === target) ?? null;
  }

  // 空正文 = 这一层关着，所以它既不算「已配置」，也不出现在目标 chip 里。
  function injectionTargets(scope: Scope): string[] {
    if (injections === null) return [];
    const ids: string[] = [];
    for (const item of injections) {
      if (item.scope !== scope || item.scopeId === '' || item.content.trim() === '') continue;
      if (!ids.includes(item.scopeId)) ids.push(item.scopeId);
    }
    return ids;
  }

  function injectionSummary(scope: Scope): string {
    if (injections === null) return '未配置';
    if (scope === 'global') {
      const entry = injectionAt(injections, 'global', '');
      return entry !== null && entry.content.trim() !== '' ? '已配置' : '未配置';
    }
    const count = injectionTargets(scope).length;
    return count > 0 ? '已配置 ' + String(count) + ' 个' : '未配置';
  }

  const injectionEntry = injectionAt(injections, injectionScope, injectionTargetId);

  function fillInjectionDraft(scope: Scope, scopeId: string, layers: PromptInjectionLayer[] | null): void {
    const entry = injectionAt(layers, scope, scopeId);
    setInjectionContent(entry === null ? '' : entry.content);
    setInjectionDepthText(entry === null ? '0' : String(entry.depth));
    setInjectionRole(entry === null ? 'system' : entry.role);
    setInjectionError('');
    setInjectionMessage('');
  }

  function selectInjectionLayer(scope: Scope): void {
    setInjectionScope(scope);
    fillInjectionDraft(scope, injectionTargetIds[scope], injections);
  }

  // 换目标 = 换编辑对象，别把上一个对象的正文带过去。
  function selectInjectionTarget(value: string): void {
    setInjectionTargetIds({ ...injectionTargetIds, [injectionScope]: value });
    fillInjectionDraft(injectionScope, value, injections);
  }

  async function loadInjections(): Promise<void> {
    try {
      const layers = await fetchPromptInjections();
      setInjections(layers);
      fillInjectionDraft(injectionScope, injectionTargetIds[injectionScope], layers);
    } catch (err) {
      setInjectionError(describePromptInjectionError(err));
    }
  }

  async function refreshInjections(): Promise<PromptInjectionLayer[]> {
    const layers = await fetchPromptInjections();
    setInjections(layers);
    return layers;
  }

  // 空正文照存（后端允许）：那是「这一层关掉」的写法，不用先删再空着。
  async function saveInjection(): Promise<void> {
    if (injectionBusy) return;
    setInjectionError('');
    setInjectionMessage('');
    if (injectionScope !== 'global' && injectionTargetId.trim() === '') {
      setInjectionError('先填 ' + PROMPT_SCOPE_TITLES[injectionScope] + ' ID，才知道要存到哪一层');
      return;
    }
    const depthText = injectionDepthText.trim();
    const depth = depthText === '' ? Number.NaN : Number(depthText);
    if (!Number.isInteger(depth) || depth < 0 || depth > INJECTION_DEPTH_MAX) {
      setInjectionError('深度要填 0–' + String(INJECTION_DEPTH_MAX) + ' 的整数');
      return;
    }
    if (injectionContent.length > INJECTION_CONTENT_MAX_CHARS) {
      setInjectionError('正文超长：最多 ' + String(INJECTION_CONTENT_MAX_CHARS) + ' 字');
      return;
    }
    const targetLabel = describeScopeTarget(injectionScope, injectionTargetId);
    setInjectionBusy(true);
    try {
      const saved = await savePromptInjection({
        scope: injectionScope,
        scopeId: injectionTargetId,
        content: injectionContent,
        depth,
        role: injectionRole,
      });
      await refreshInjections();
      setInjectionMessage(
        saved.content.trim() === ''
          ? '已保存空正文：' + targetLabel + ' 这一层关掉了，会话回落到下一层'
          : '已保存到 ' + targetLabel,
      );
    } catch (err) {
      setInjectionError(describePromptInjectionError(err));
    } finally {
      setInjectionBusy(false);
    }
  }

  async function removeInjection(): Promise<void> {
    if (injectionBusy || injectionEntry === null) return;
    const targetLabel = describeScopeTarget(injectionScope, injectionTargetId);
    if (!window.confirm('确定删掉 ' + targetLabel + ' 这一层的深度注入？删完会话回落到下一层。')) return;
    setInjectionError('');
    setInjectionMessage('');
    setInjectionBusy(true);
    try {
      await clearPromptInjection(injectionScope, injectionTargetId);
      const layers = await refreshInjections();
      fillInjectionDraft(injectionScope, injectionTargetId, layers);
      setInjectionMessage('已删除 ' + targetLabel + ' 这一层');
    } catch (err) {
      setInjectionError(describePromptInjectionError(err));
    } finally {
      setInjectionBusy(false);
    }
  }


  // 世界书：global 的 scopeId 恒为空；非全局层填了 ID 才能筛出这一层的书。
  const worldBookTargetId = normalizeScopeId(worldBookScope, worldBookTargetIds[worldBookScope]);

  function worldBooksAt(scope: Scope, scopeId: string): WorldBook[] {
    if (worldBooks === null) return [];
    const target = normalizeScopeId(scope, scopeId);
    return worldBooks.filter((item) => item.scope === scope && item.scopeId === target);
  }

  const worldBookList = worldBooksAt(worldBookScope, worldBookTargetId);

  function findWorldBook(bookId: string | null): WorldBook | null {
    if (bookId === null || worldBooks === null) return null;
    return worldBooks.find((item) => item.bookId === bookId) ?? null;
  }

  function worldBookTargets(scope: Scope): string[] {
    if (worldBooks === null) return [];
    const ids: string[] = [];
    for (const item of worldBooks) {
      if (item.scope !== scope || item.scopeId === '') continue;
      if (!ids.includes(item.scopeId)) ids.push(item.scopeId);
    }
    return ids;
  }

  // tab 上只放短状态：这一层一共几本；书名 / 条数 / 导入时间留给书自己的行。
  function worldBookSummary(scope: Scope): string {
    if (worldBooks === null) return '未导入';
    const count = worldBooks.filter((item) => item.scope === scope).length;
    return count === 0 ? '未导入' : String(count) + ' 本';
  }

  async function loadWorldBooks(): Promise<void> {
    try {
      setWorldBooks(await fetchWorldBook());
    } catch (err) {
      setWorldBookError(describeWorldBookError(err));
    }
  }

  // 选文件：本地读成文本再解析；解析失败只说「不是合法 JSON」，一个请求都不发。
  function readWorldBookFile(file: File | null): void {
    setWorldBookError('');
    setWorldBookResult(null);
    if (file === null) {
      setWorldBookFile(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = parseJsonText(text);
      if (!parsed.ok) {
        setWorldBookFile(null);
        setWorldBookError('这个文件不是合法 JSON：解析失败，没有发请求');
        return;
      }
      // 原样上送：后端认 entries 本体、角色卡 V2 与顶层数组三种外壳，前端拆壳只会丢掉卡片自己的书名。
      setWorldBookFile({ name: file.name, book: parsed.value });
    };
    reader.onerror = () => {
      setWorldBookFile(null);
      setWorldBookError('读文件失败：换一个文件，或者直接把 JSON 粘贴到下面');
    };
    reader.readAsText(file);
  }

  function selectWorldBookLayer(scope: Scope): void {
    resetWorldBookEdit();
    resetWorldBookRename();
    setWorldBookScope(scope);
    setWorldBookExpandedId(null);
    setWorldBookError('');
    setWorldBookMessage('');
    setWorldBookResult(null);
  }

  function selectWorldBookTarget(value: string): void {
    resetWorldBookEdit();
    resetWorldBookRename();
    setWorldBookTargetIds({ ...worldBookTargetIds, [worldBookScope]: value });
    setWorldBookExpandedId(null);
    setWorldBookError('');
    setWorldBookMessage('');
    setWorldBookResult(null);
  }

  // 导入源：粘贴优先（粘了一半再去选文件时，想导的显然是粘的那份）；本地解析失败就停在这里。
  function readWorldBookSource(): { ok: true; book: unknown } | { ok: false; error: string } {
    const pasted = worldBookPaste.trim();
    if (pasted !== '') {
      const parsed = parseJsonText(pasted);
      if (!parsed.ok) return { ok: false, error: '粘贴的内容不是合法 JSON：解析失败，没有发请求' };
      return { ok: true, book: parsed.value };
    }
    if (worldBookFile !== null) return { ok: true, book: worldBookFile.book };
    return { ok: false, error: '先选一个世界书 JSON 文件（或角色卡 V2），或者把内容粘贴进来' };
  }

  async function runWorldBookImport(): Promise<void> {
    if (worldBookBusy) return;
    setWorldBookError('');
    setWorldBookMessage('');
    setWorldBookResult(null);
    if (worldBookScope !== 'global' && worldBookTargetId.trim() === '') {
      setWorldBookError('先填 ' + PROMPT_SCOPE_TITLES[worldBookScope] + ' ID，才知道要写到哪一层');
      return;
    }
    const source = readWorldBookSource();
    if (!source.ok) {
      setWorldBookError(source.error);
      return;
    }
    const targetLabel = describeScopeTarget(worldBookScope, worldBookTargetId);
    if (
      !window.confirm(
        '导入会为 ' + targetLabel + ' 新增一本世界书，不会覆盖这一层已有的书：' +
          '导进来的是独立的一本，同层的书全部保留。重名会自动加「（2）」后缀。确定继续？',
      )
    ) {
      return;
    }
    setWorldBookBusy(true);
    try {
      const result = await importWorldBook({ scope: worldBookScope, scopeId: worldBookTargetId, book: source.book });
      setWorldBookResult(result);
      // 换书后旧条目 id 已作废，编辑区要收起；展开刚导进来的那本，让人马上看到条目。
      resetWorldBookEdit();
      resetWorldBookRename();
      setWorldBookExpandedId(result.bookId === '' ? null : result.bookId);
      await loadWorldBooks();
      setWorldBookMessage('已新增世界书「' + (result.name === '' ? '未命名' : result.name) + '」');
    } catch (err) {
      setWorldBookError(describeWorldBookError(err));
    } finally {
      setWorldBookBusy(false);
    }
  }

  async function toggleWorldBook(book: WorldBook): Promise<void> {
    if (worldBookBusy || worldBookTogglingId !== null) return;
    setWorldBookError('');
    setWorldBookMessage('');
    setWorldBookTogglingId(book.bookId);
    try {
      const updated = await updateWorldBookEnabled(book.bookId, !book.enabled);
      // 只换这一行：别的书、别的层都不动，展开状态也保持不变。
      setWorldBooks((current) =>
        current === null
          ? current
          : current.map((item) => (item.bookId === book.bookId ? { ...item, enabled: updated.enabled } : item)),
      );
      setWorldBookMessage(
        '已' + (updated.enabled ? '启用' : '停用') + '「' + (book.name === '' ? '这本没有名字' : book.name) + '」',
      );
    } catch (err) {
      setWorldBookError(describeWorldBookEntryError(err));
    } finally {
      setWorldBookTogglingId(null);
    }
  }

  // 重命名：收起就丢草稿；换层 / 换对象、导入与删书成功、新建成功后都由调用方收起。
  function resetWorldBookRename(): void {
    setWorldBookRenameId(null);
    setWorldBookRenameName('');
    setWorldBookRenameError('');
    setWorldBookRenameBusy(false);
  }

  function openWorldBookRename(book: WorldBook): void {
    if (worldBookRenameBusy) return;
    // 再点同一本就是收起；换一本就把草稿换成那本当前的书名。
    if (worldBookRenameId === book.bookId) {
      resetWorldBookRename();
      return;
    }
    setWorldBookRenameId(book.bookId);
    setWorldBookRenameName(book.name);
    setWorldBookRenameError('');
    setWorldBookError('');
  }

  async function saveWorldBookRename(book: WorldBook): Promise<void> {
    if (worldBookRenameBusy) return;
    const trimmed = worldBookRenameName.trim();
    // 与后端 BAD_BOOK_NAME 同口径：trim 后 1..80 字，先在本地说清，不发请求。
    if (trimmed === '' || trimmed.length > WORLD_BOOK_NAME_MAX) {
      setWorldBookRenameError(WORLD_BOOK_NAME_RULE);
      return;
    }
    setWorldBookRenameBusy(true);
    setWorldBookRenameError('');
    try {
      const renamed = await renameWorldBook(book.bookId, trimmed);
      // 只换这一行的书名：别的书、别的层、展开状态都不动，也不重拉整表。
      setWorldBooks((current) =>
        current === null
          ? current
          : current.map((item) => (item.bookId === book.bookId ? { ...item, name: renamed.name } : item)),
      );
      resetWorldBookRename();
      setWorldBookMessage('已重命名为「' + renamed.name + '」');
    } catch (err) {
      // 失败只写表单：列表保持原样，改了还能再存。
      setWorldBookRenameError(describeWorldBookEntryError(err));
    } finally {
      setWorldBookRenameBusy(false);
    }
  }

  async function removeWorldBook(book: WorldBook): Promise<void> {
    if (worldBookBusy || worldBookTogglingId !== null) return;
    const targetLabel = describeScopeTarget(worldBookScope, worldBookTargetId);
    const name = book.name === '' ? '这本没有名字' : book.name;
    if (
      !window.confirm(
        '确定删掉 ' + targetLabel + ' 的「' + name + '」？只删这一本，同层其它书不动；删完会话回落到下一层。',
      )
    ) {
      return;
    }
    setWorldBookError('');
    setWorldBookMessage('');
    setWorldBookResult(null);
    setWorldBookBusy(true);
    try {
      await deleteWorldBook(book.bookId);
      if (worldBookEditBookId === book.bookId || worldBookCreateBookId === book.bookId) resetWorldBookEdit();
      resetWorldBookRename();
      if (worldBookExpandedId === book.bookId) setWorldBookExpandedId(null);
      await loadWorldBooks();
      setWorldBookMessage('已删除「' + name + '」：只删了这一本，同层其它书还在');
    } catch (err) {
      setWorldBookError(describeWorldBookError(err));
    } finally {
      setWorldBookBusy(false);
    }
  }

  // 删一条：二次确认写清只动这本书；删掉最后一条时服务端连书移除，界面收起这本书。
  async function removeWorldBookEntry(book: WorldBook, item: WorldBookEntrySummary): Promise<void> {
    if (worldBookBusy || worldBookEditBusy) return;
    const bookName = book.name === '' ? '这本没有名字' : book.name;
    const name = item.name.trim() === '' ? '无名条目' : item.name.trim();
    const last = book.entryCount <= 1;
    const tail = last
      ? '这是这本书最后一条：删完这本书整本移除，同层其它书不动。'
      : '其它条目和同层其它书都不动。';
    if (!window.confirm('确定删掉「' + bookName + '」里的「' + name + '」？' + tail)) return;
    setWorldBookError('');
    setWorldBookMessage('');
    setWorldBookResult(null);
    setWorldBookBusy(true);
    try {
      const result = await deleteWorldBookEntry({ bookId: book.bookId, id: item.id });
      // 删的正是表单里那一条（或正在往这本书新建）：id 已经作废，表单要收起。
      if (worldBookEditBookId === book.bookId && (worldBookEditId === item.id || worldBookCreating)) {
        resetWorldBookEdit();
      }
      if (result.removedBook) {
        if (worldBookExpandedId === book.bookId) setWorldBookExpandedId(null);
        // 整本被移除：为它打开的重命名表单已经没有行可落，直接收起。
        if (worldBookRenameId === book.bookId) resetWorldBookRename();
      }
      await loadWorldBooks();
      setWorldBookMessage(
        result.removedBook
          ? '已删除「' + name + '」：这本书没有条目了，整本移除，同层其它书还在'
          : '已删除「' + name + '」',
      );
    } catch (err) {
      setWorldBookError(describeWorldBookEntryError(err));
    } finally {
      setWorldBookBusy(false);
    }
  }

  function resetWorldBookEdit(): void {
    worldBookEditEpoch.current += 1;
    setWorldBookEditBookId(null);
    setWorldBookEditId(null);
    setWorldBookDraft(null);
    setWorldBookEditLoading(false);
    setWorldBookEditBusy(false);
    setWorldBookEditError('');
    setWorldBookEditFields({});
    setWorldBookCreating(false);
    setWorldBookCreateBookId(null);
    setWorldBookBookName('');
    setWorldBookBookNameError('');
  }

  function closeWorldBookEdit(): void {
    if (worldBookEditBusy) return;
    resetWorldBookEdit();
  }

  // 新建：book 非空时直接写进这本书；book 为 null 时这一层还没有书，表单里多一个必填书名。
  function openWorldBookCreate(book: WorldBook | null): void {
    if (worldBookEditBusy) return;
    const bookId = book === null ? null : book.bookId;
    if (worldBookCreating && worldBookCreateBookId === bookId) {
      resetWorldBookEdit();
      return;
    }
    worldBookEditEpoch.current += 1;
    setWorldBookEditBookId(null);
    setWorldBookEditId(null);
    setWorldBookDraft(newWorldEntryDraft());
    setWorldBookEditLoading(false);
    setWorldBookEditBusy(false);
    setWorldBookEditError('');
    setWorldBookEditFields({});
    setWorldBookCreating(true);
    setWorldBookCreateBookId(bookId);
    if (bookId !== null) setWorldBookExpandedId(bookId);
    setWorldBookBookName('');
    setWorldBookBookNameError('');
    setWorldBookError('');
  }

  // 点一行：读这一条的正文再铺成表单；点正在编辑的那行就收起。
  async function openWorldBookEdit(book: WorldBook, item: WorldBookEntrySummary): Promise<void> {
    if (worldBookEditBusy) return;
    if (worldBookEditBookId === book.bookId && worldBookEditId === item.id && !worldBookEditLoading) {
      resetWorldBookEdit();
      return;
    }
    // 从新建切到编辑：新建那份草稿连书名一起丢掉。
    setWorldBookCreating(false);
    setWorldBookCreateBookId(null);
    setWorldBookBookName('');
    setWorldBookBookNameError('');
    const epoch = worldBookEditEpoch.current + 1;
    worldBookEditEpoch.current = epoch;
    setWorldBookEditBookId(book.bookId);
    setWorldBookExpandedId(book.bookId);
    setWorldBookEditId(item.id);
    setWorldBookDraft(null);
    setWorldBookEditError('');
    setWorldBookEditFields({});
    setWorldBookEditLoading(true);
    try {
      const entry = await fetchWorldBookEntry(book.bookId, item.id);
      if (worldBookEditEpoch.current !== epoch) return;
      setWorldBookDraft(toWorldEntryDraft(entry));
    } catch (err) {
      if (worldBookEditEpoch.current !== epoch) return;
      setWorldBookEditError(describeWorldBookEntryError(err));
    } finally {
      if (worldBookEditEpoch.current === epoch) setWorldBookEditLoading(false);
    }
  }

  // 改一个字段就顺手消掉它的行内提示：别让已经改对的输入框一直红着。
  function updateWorldBookDraft<K extends keyof WorldEntryDraft>(key: K, value: WorldEntryDraft[K]): void {
    setWorldBookDraft((current) => (current === null ? current : { ...current, [key]: value }));
    const field = key as WorldEntryFieldKey;
    setWorldBookEditFields((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function saveWorldBookForm(): Promise<void> {
    if (worldBookDraft === null || worldBookEditBusy) return;
    const creating = worldBookCreating;
    const built = buildWorldEntry(worldBookDraft);
    if (!built.ok) {
      setWorldBookEditFields(built.errors);
      setWorldBookEditError('');
      return;
    }
    // 这一层还没有书：书名必填（trim 后 1..80 字），提示语与后端 BAD_BOOK_NAME 共用一句。
    const needsBookName = creating && worldBookCreateBookId === null;
    let bookName: string | null = null;
    if (needsBookName) {
      const trimmed = worldBookBookName.trim();
      if (trimmed === '' || trimmed.length > WORLD_BOOK_NAME_MAX) {
        setWorldBookBookNameError(WORLD_BOOK_NAME_RULE);
        setWorldBookEditError('');
        return;
      }
      bookName = trimmed;
    }
    const scope = worldBookScope;
    const scopeId = worldBookTargetId;
    const createBookId = worldBookCreateBookId;
    const editBookId = worldBookEditBookId;
    const rowId = worldBookDraft.id;
    setWorldBookEditBusy(true);
    setWorldBookEditError('');
    setWorldBookEditFields({});
    setWorldBookBookNameError('');
    try {
      if (creating) {
        const created = await createWorldBookEntry({
          scope,
          scopeId,
          bookId: createBookId,
          bookName,
          entry: built.entry,
        });
        // 新建可能顺带建了一本书：书名、条目数、整表状态都变了，重读后展开刚写进去的那本。
        const targetBookId = created.bookId === '' ? createBookId : created.bookId;
        resetWorldBookEdit();
        resetWorldBookRename();
        await loadWorldBooks();
        if (targetBookId !== null) setWorldBookExpandedId(targetBookId);
        const label = created.entry.name.trim() === '' ? '无名条目' : created.entry.name.trim();
        setWorldBookMessage(
          created.createdBook
            ? '已新建世界书「' + (created.name === '' ? label : created.name) + '」，并写入第一条「' + label + '」'
            : '已写入「' + label + '」到「' + (created.name === '' ? '这本书' : created.name) + '」',
        );
        return;
      }
      if (editBookId === null) {
        setWorldBookEditError('不知道该写进哪一本：收起表单，重新点这本书里的「编辑」');
        return;
      }
      const saved = await saveWorldBookEntry(editBookId, built.entry);
      const summary = toWorldEntrySummary(saved);
      // 只换这一本的这一行：不重拉整表，别的书、别的层都不动。
      setWorldBooks((current) =>
        current === null
          ? current
          : current.map((book) =>
              book.bookId === editBookId
                ? { ...book, entries: book.entries.map((item) => (item.id === rowId ? summary : item)) }
                : book,
            ),
      );
      resetWorldBookEdit();
      setWorldBookMessage('已保存「' + (summary.name === '' ? '无名条目' : summary.name) + '」');
    } catch (err) {
      // 失败只写表单：列表保持原样，用户还能改了重试。
      setWorldBookEditError(describeWorldBookEntryError(err));
    } finally {
      setWorldBookEditBusy(false);
    }
  }

  function renderWorldBookResult(result: WorldBookImportResult): ReactElement {
    const groups = WORLD_BOOK_IGNORE_REASONS.map((reason) => ({
      reason,
      items: result.ignored.filter((item) => item.reason === reason),
    })).filter((group) => group.items.length > 0);
    return (
      <div className="prompt-import-result">
        <p className="ok">{describeWorldBookOutcome(result)}</p>
        {result.warnings.length === 0 ? null : (
          <div className="prompt-import-warnings">
            <span className="hint">后端提醒（{String(result.warnings.length)} 条）：</span>
            <ul>
              {result.warnings.slice(0, WORLD_BOOK_WARNING_LIMIT).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        {groups.length === 0 ? (
          <p className="hint">没有被跳过的条目。</p>
        ) : (
          groups.map((group) => (
            <p className="prompt-import-ignored" key={group.reason}>
              <span className="badge">{WORLD_BOOK_REASON_LABELS[group.reason]}</span>
              <span className="hint">
                {group.items.length > WORLD_BOOK_NAME_LIMIT ? '共 ' + String(group.items.length) + ' 条：' : ''}
                {group.items
                  .slice(0, WORLD_BOOK_NAME_LIMIT)
                  .map(ignoredEntryLabel)
                  .join('、')}
                {group.items.length > WORLD_BOOK_NAME_LIMIT ? ' …' : ''}
              </span>
            </p>
          ))
        )}
      </div>
    );
  }

  // 行内重命名：一条窄表单贴着这一本展开；错误留在表单里，不往卡片顶部堆。
  function renderWorldBookRename(book: WorldBook): ReactElement {
    return (
      <form
        className="worldbook-rename"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void saveWorldBookRename(book);
        }}
      >
        <div className="worldbook-rename-row">
          <label className="field">
            <span>新的书名（{String(WORLD_BOOK_NAME_MAX)} 字以内，只改这一本，条目不动）</span>
            <input
              type="text"
              value={worldBookRenameName}
              maxLength={WORLD_BOOK_NAME_MAX}
              disabled={worldBookRenameBusy}
              onChange={(event) => {
                setWorldBookRenameName(event.target.value);
                setWorldBookRenameError('');
              }}
            />
          </label>
          <div className="actions">
            <button type="submit" className="primary small" disabled={worldBookRenameBusy}>
              {worldBookRenameBusy ? '保存中…' : '保存'}
            </button>
            <button type="button" className="ghost small" disabled={worldBookRenameBusy} onClick={resetWorldBookRename}>
              取消
            </button>
          </div>
        </div>
        {worldBookRenameError === '' ? null : <p className="error">{worldBookRenameError}</p>}
      </form>
    );
  }

  function renderWorldBookEntries(book: WorldBook): ReactElement | null {
    if (book.entries.length === 0) return <p className="hint">这本书没有条目摘要可显示。</p>;
    const rows = book.entries.slice(0, WORLD_BOOK_ROWS_LIMIT);
    const hidden = book.entryCount - rows.length;
    const disabledCount = book.entries.filter((item) => !item.enabled).length;
    return (
      <div className="worldbook-entries">
        <p className="hint">
          条目摘要：共 {formatNumber(book.entryCount)} 条
          {disabledCount === 0 ? '' : '，其中 ' + formatNumber(disabledCount) + ' 条停用（不参与装配）'}
          {hidden > 0 ? '；表里只列前 ' + String(rows.length) + ' 条' : ''}
        </p>
        <div className="worldbook-table-wrap">
          <table className="worldbook-table">
            <thead>
              <tr>
                <th>名字</th>
                <th>关键词</th>
                <th>类型</th>
                <th>字数</th>
                <th className="worldbook-op">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr
                  key={item.id}
                  className={
                    (item.enabled ? 'worldbook-row' : 'worldbook-row off') +
                    (worldBookEditBookId === book.bookId && worldBookEditId === item.id ? ' editing' : '')
                  }
                >
                  <td className="worldbook-name">{item.name === '' ? '（无名条目）' : item.name}</td>
                  <td className="worldbook-keys">{describeWorldBookKeys(item)}</td>
                  <td>{item.enabled ? (item.constant ? '常驻' : '普通') : '停用'}</td>
                  <td className="worldbook-chars">{formatNumber(item.chars)}</td>
                  <td className="worldbook-op">
                    <span className="worldbook-op-actions">
                      <button
                        type="button"
                        className="link small"
                        disabled={worldBookEditBusy || worldBookBusy}
                        onClick={() => void openWorldBookEdit(book, item)}
                      >
                        {worldBookEditBookId === book.bookId && worldBookEditId === item.id ? '收起' : '编辑'}
                      </button>
                      <button
                        type="button"
                        className="link small danger"
                        disabled={worldBookEditBusy || worldBookBusy}
                        onClick={() => void removeWorldBookEntry(book, item)}
                      >
                        删除
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // 逐条编辑 / 新建区：同页展开，不弹窗。字段顺序按契约分组：基本 / 关键词 / 触发 / 排序。
  function renderWorldBookEditor(book: WorldBook | null): ReactElement | null {
    if (worldBookEditId === null && !worldBookCreating) return null;
    const draft = worldBookDraft;
    const title =
      draft === null
        ? '条目 #' + String(worldBookEditId)
        : draft.name.trim() === ''
          ? '（无名条目）'
          : draft.name;
    // book 为 null = 这一层还没有书，新建时书名必填；否则直接写进这本书，书名不变。
    const needsBookName = worldBookCreating && book === null;
    const submitLabel = worldBookCreating ? '新建并保存' : '保存';
    const bookLabel = book === null ? '' : book.name === '' ? '这本没有名字' : book.name;
    const head = (
      <div className="worldbook-editor-head">
        <h3>
          {worldBookCreating
            ? book === null
              ? '新建条目（同时新建这本书）'
              : '新建条目 · ' + bookLabel
            : '编辑条目 · ' + title}
        </h3>
        <button type="button" className="ghost small" disabled={worldBookEditBusy} onClick={closeWorldBookEdit}>
          收起
        </button>
      </div>
    );
    if (worldBookEditLoading) {
      return (
        <div className="worldbook-editor">
          {head}
          <p className="hint">正在读取条目正文…</p>
        </div>
      );
    }
    if (draft === null) {
      return (
        <div className="worldbook-editor">
          {head}
          {worldBookEditError === '' ? null : <p className="error">{worldBookEditError}</p>}
          <p className="hint">没读到这条的正文，收起后重新点「编辑」；列表里的摘要没动。</p>
        </div>
      );
    }
    const fieldError = (key: WorldEntryFieldKey): ReactElement | null =>
      worldBookEditFields[key] === undefined ? null : <span className="field-error">{worldBookEditFields[key]}</span>;
    // 深度只在 @D 时参与装配，其它位置锁住免得用户以为它生效了。
    const depthLocked = draft.position !== 'atDepth';
    return (
      <form
        className="worldbook-editor"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void saveWorldBookForm();
        }}
      >
        {head}
        {needsBookName ? (
          <label className="field">
            <span>世界书名字（这一层还没有世界书，保存时按它新建一本，{String(WORLD_BOOK_NAME_MAX)} 字以内）</span>
            <input
              type="text"
              value={worldBookBookName}
              maxLength={WORLD_BOOK_NAME_MAX}
              disabled={worldBookEditBusy}
              onChange={(event) => {
                setWorldBookBookName(event.target.value);
                setWorldBookBookNameError('');
              }}
            />
            {worldBookBookNameError === '' ? null : <span className="field-error">{worldBookBookNameError}</span>}
          </label>
        ) : null}
        {worldBookCreating ? (
          <p className="hint">
            {needsBookName
              ? '保存后这一层就有世界书了：条目 id 由服务端分配，写进去的是第一条。'
              : '保存后写进「' + bookLabel + '」这本书，书名不变；同层其它书不动。'}
          </p>
        ) : null}
        <div className="worldbook-editor-group">
          <h4>基本</h4>
          <label className="field">
            <span>名字</span>
            <input
              type="text"
              value={draft.name}
              disabled={worldBookEditBusy}
              onChange={(event) => updateWorldBookDraft('name', event.target.value)}
            />
            {fieldError('name')}
          </label>
          <label className="field">
            <span>正文</span>
            <textarea
              rows={6}
              value={draft.content}
              disabled={worldBookEditBusy}
              onChange={(event) => updateWorldBookDraft('content', event.target.value)}
            />
            {fieldError('content')}
          </label>
          <label className="row checkbox">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={worldBookEditBusy}
              onChange={(event) => updateWorldBookDraft('enabled', event.target.checked)}
            />
            <span>启用这条（关掉后内容留在库里，但不参与装配）</span>
          </label>
          <label className="row checkbox">
            <input
              type="checkbox"
              checked={draft.constant}
              disabled={worldBookEditBusy}
              onChange={(event) => updateWorldBookDraft('constant', event.target.checked)}
            />
            <span>常驻（constant，不靠关键词命中）</span>
          </label>
        </div>
        <div className="worldbook-editor-group">
          <h4>关键词</h4>
          <div className="row">
            <label className="field">
              <span>主关键词（逗号或换行分隔）</span>
              <input
                type="text"
                value={draft.keys}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('keys', event.target.value)}
              />
            </label>
            <label className="field">
              <span>次关键词（逗号或换行分隔）</span>
              <input
                type="text"
                value={draft.secondaryKeys}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('secondaryKeys', event.target.value)}
              />
            </label>
          </div>
          <div className="row worldbook-editor-flags">
            <label className="row checkbox">
              <input
                type="checkbox"
                checked={draft.caseSensitive}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('caseSensitive', event.target.checked)}
              />
              <span>区分大小写</span>
            </label>
            <label className="row checkbox">
              <input
                type="checkbox"
                checked={draft.wholeWords}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('wholeWords', event.target.checked)}
              />
              <span>只匹配整词</span>
            </label>
            <label className="row checkbox">
              <input
                type="checkbox"
                checked={draft.selective}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('selective', event.target.checked)}
              />
              <span>启用次关键词</span>
            </label>
          </div>
          <label className="field">
            <span>次关键词逻辑</span>
            <select
              value={draft.selectiveLogic}
              disabled={worldBookEditBusy}
              onChange={(event) => updateWorldBookDraft('selectiveLogic', event.target.value as WorldSelectiveLogic)}
            >
              {WORLD_SELECTIVE_LOGICS.map((logic) => (
                <option key={logic} value={logic}>
                  {WORLD_SELECTIVE_LOGIC_LABELS[logic]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="worldbook-editor-group">
          <h4>触发</h4>
          <div className="row">
            <label className="field">
              <span>插入位置</span>
              <select
                value={draft.position}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('position', event.target.value as WorldPosition)}
              >
                {WORLD_POSITIONS.map((position) => (
                  <option key={position} value={position}>
                    {WORLD_POSITION_LABELS[position]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>深度（仅 @D 生效，0–{String(WORLD_DEPTH_MAX)}）</span>
              <input
                type="number"
                step={1}
                value={draft.depth}
                disabled={worldBookEditBusy || depthLocked}
                onChange={(event) => updateWorldBookDraft('depth', event.target.value)}
              />
              {fieldError('depth')}
            </label>
            <label className="field">
              <span>角色（role）</span>
              <select
                value={draft.role}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('role', event.target.value as WorldEntryRole)}
              >
                {WORLD_ENTRY_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {WORLD_ENTRY_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>概率（0–100）</span>
              <input
                type="number"
                step={1}
                value={draft.probability}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('probability', event.target.value)}
              />
              {fieldError('probability')}
            </label>
            <label className="row checkbox">
              <input
                type="checkbox"
                checked={draft.useProbability}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('useProbability', event.target.checked)}
              />
              <span>按概率触发（useProbability）</span>
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>分组（group）</span>
              <input
                type="text"
                value={draft.group}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('group', event.target.value)}
              />
            </label>
            <label className="field">
              <span>组权重（0–{String(WORLD_GROUP_WEIGHT_MAX)}）</span>
              <input
                type="number"
                step={1}
                value={draft.groupWeight}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('groupWeight', event.target.value)}
              />
              {fieldError('groupWeight')}
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>粘性 sticky（0–{String(WORLD_STICKY_MAX)}）</span>
              <input
                type="number"
                step={1}
                value={draft.sticky}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('sticky', event.target.value)}
              />
              {fieldError('sticky')}
            </label>
            <label className="field">
              <span>冷却 cooldown（0–{String(WORLD_COOLDOWN_MAX)}）</span>
              <input
                type="number"
                step={1}
                value={draft.cooldown}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('cooldown', event.target.value)}
              />
              {fieldError('cooldown')}
            </label>
            <label className="field">
              <span>延迟 delay（0–{String(WORLD_DELAY_MAX)}）</span>
              <input
                type="number"
                step={1}
                value={draft.delay}
                disabled={worldBookEditBusy}
                onChange={(event) => updateWorldBookDraft('delay', event.target.value)}
              />
              {fieldError('delay')}
            </label>
          </div>
          <label className="field">
            <span>
              扫描深度（1–{String(WORLD_SCAN_DEPTH_MAX)}，留空 = 用书级默认 {String(WORLD_SCAN_DEPTH_DEFAULT)}）
            </span>
            <input
              type="number"
              step={1}
              value={draft.scanDepth}
              placeholder={'书级默认 ' + String(WORLD_SCAN_DEPTH_DEFAULT)}
              disabled={worldBookEditBusy}
              onChange={(event) => updateWorldBookDraft('scanDepth', event.target.value)}
            />
            {fieldError('scanDepth')}
          </label>
        </div>
        <div className="worldbook-editor-group">
          <h4>排序</h4>
          <label className="field">
            <span>order（同位置内按它排，越小越靠前）</span>
            <input
              type="number"
              step={1}
              value={draft.order}
              disabled={worldBookEditBusy}
              onChange={(event) => updateWorldBookDraft('order', event.target.value)}
            />
            {fieldError('order')}
          </label>
        </div>
        {worldBookEditError === '' ? null : <p className="error">{worldBookEditError}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={worldBookEditBusy}>
            {worldBookEditBusy ? '保存中…' : submitLabel}
          </button>
          <button type="button" className="ghost" disabled={worldBookEditBusy} onClick={closeWorldBookEdit}>
            取消
          </button>
        </div>
      </form>
    );
  }

  function renderCodeDefaults(): ReactElement {
    const samples = defaults === null ? [] : Object.entries(defaults.sampleVars);
    const sampleText =
      samples.length === 0
        ? '（接口没给示例值）'
        : samples.map(([name, value]) => describeVarToken(name) + ' = ' + value).join(' · ');
    return (
      <div className="prompt-code-defaults">
        <h3>代码内置（只读）：这里改不生效，要改就填上面的内置默认</h3>
        <p className="hint">
          上面两块留空时走的就是这一份。下面「原文」是代码里的原文，占位符保持 {'{{名字}}'} 原样；「渲染预览」是用示例数据替换后的样子。
        </p>
        <div className="prompt-code-grid">
          {PROMPT_DEFAULT_KEYS.map((key) => {
            const code = defaults === null ? { text: '', rendered: '' } : defaults.codeDefaults[key];
            return (
              <div className="prompt-code-default" key={key}>
                <div className="prompt-code-head">
                  <h4>{PROMPT_DEFAULT_HEADINGS[key]}</h4>
                  <span className="badge">代码内置原文</span>
                </div>
                <pre className="prompt-code-text">{code.text === '' ? '（接口没返回这段原文）' : code.text}</pre>
                <div className="prompt-code-head">
                  <span className="badge">渲染预览</span>
                  <span className="prompt-sample-vars">示例数据：{sampleText}</span>
                </div>
                <pre className="prompt-code-text">{code.rendered === '' ? '（渲染结果为空）' : code.rendered}</pre>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderDefaultBlock(key: PromptDefaultKey): ReactElement {
    const entry = entryAt(defaults, key, defaultScope, defaultTargetId);
    const draft = defaultDraft(key);
    const vars = defaultVars(key);
    const maxChars = defaults === null ? PROMPT_DEFAULT_MAX_CHARS : defaults.maxChars;
    const busy = defaultBusy === key;
    const locked = defaultBusy !== null;
    // 超长后端必拒（BAD_PROMPT_CONTENT）：计数变红并锁住保存，省一次注定失败的往返。
    const over = draft.length > maxChars;
    const preview = previews[key];
    const previewError = previewErrors[key];
    return (
      <div className="prompt-default">
        <div className="prompt-default-head">
          <h3>{PROMPT_DEFAULT_HEADINGS[key]}</h3>
          <span className="prompt-default-target-badge">{describeScopeTarget(defaultScope, defaultTargetId)}</span>
          <span className={entry === undefined ? 'prompt-default-state' : 'prompt-default-state on'}>
            {entry === undefined ? '这一层未配置' : '已配置 · 保存于 ' + formatSavedAt(entry.updatedAt)}
          </span>
        </div>
        <p className="hint">
          {key === 'fallback'
            ? '频道 / 服务器 / 全局三层都没配提示词时，用这段拼系统提示词。'
            : '兜底用的身份块：只在这一轮没有任何前置预设段时才出现（有角色卡就不需要它）。某行变量为空时整行不出现；不配置就沿用现在的代码生成。'}
        </p>
        <label className="field">
          <span>
            正文（占位符写成 {'{{名字}}'}，最多 {maxChars} 字；留空 = 用代码内置）
          </span>
          <textarea
            ref={key === 'fallback' ? fallbackRef : identityRef}
            rows={key === 'fallback' ? 10 : 8}
            maxLength={maxChars}
            value={draft}
            placeholder={
              key === 'fallback'
                ? '留空 = 用代码内置：三层都没配时用代码里那段（保存后覆盖这一层）'
                : '留空 = 用代码内置：身份块用代码生成的那份（只在没有前置预设段时出现，保存后覆盖这一层）'
            }
            onChange={(event) => setDefaultDraft(key, event.target.value)}
            disabled={locked}
          />
        </label>
        <p className="prompt-vars">
          <span className="hint">变量：</span>
          {vars.map((name) => (
            <button
              key={name}
              type="button"
              className="prompt-var"
              disabled={locked}
              onClick={() => insertDefaultVar(key, name)}
            >
              {describeVarToken(name)}
            </button>
          ))}
          <span className={over ? 'prompt-count over' : 'prompt-count'}>
            {draft.length} / {maxChars}
          </span>
        </p>
        <div className="prompt-preview">
          <div className="prompt-preview-head">
            <span>渲染预览</span>
            <span className="prompt-preview-state">
              {previewBusy[key] ? '预览中…' : preview === null ? '留空时没有可预览的正文' : '已按当前正文渲染'}
            </span>
          </div>
          {preview !== null && preview.unknownVars.length > 0 ? (
            <p className="prompt-preview-warn">
              这些占位符不会生效：{preview.unknownVars.map(describeVarToken).join('、')}（保存会被拒绝，先改掉再保存）
            </p>
          ) : null}
          {previewError === '' ? null : <p className="error">{previewError}</p>}
          <pre className="prompt-preview-body">
            {preview === null ? '（留空 = 用代码内置，没有可预览的正文）' : preview.rendered}
          </pre>
        </div>
        {defaultMessages[key] === '' ? null : <p className="ok">{defaultMessages[key]}</p>}
        {defaultErrors[key] === '' ? null : <p className="error">{defaultErrors[key]}</p>}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={locked || draft.trim() === '' || over || !defaultTargetReady}
            onClick={() => void saveDefault(key)}
          >
            {busy ? '保存中…' : '保存这一层'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={locked || entry === undefined || !defaultTargetReady}
            onClick={() => void clearDefault(key)}
          >
            恢复默认（删掉这一层）
          </button>
          {key === 'identity' ? (
            <button type="button" className="ghost" disabled={locked} onClick={fillIdentityExample}>
              填入示例
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  function currentTarget(): { scope: Scope; scopeId: string } {
    return { scope, scopeId: normalizeScopeId(scope, scopeId) };
  }

  function patchDraft(key: string, patch: Partial<SegmentDraft>): void {
    setSegments((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }

  // 新段固定加在末尾：它就是最后拼进去的那一段。
  function addSegment(): void {
    setSegments((current) => [...current, emptyDraft()]);
    setMessage('');
    setError('');
  }

  function removeSegment(key: string): void {
    setSegments((current) => current.filter((draft) => draft.key !== key));
  }

  // 上移 / 下移只换数组位置：数组顺序就是提交时的段顺序，服务端据此写 position。
  function moveSegment(index: number, delta: number): void {
    setSegments((current) => {
      const target = index + delta;
      if (index < 0 || index >= current.length || target < 0 || target >= current.length) return current;
      const next = current.slice();
      const moved = next.splice(index, 1);
      next.splice(target, 0, moved[0]);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (busy) return;
    setMessage('');
    setError('');
    // 本地先拦一遍（对齐服务端 BAD_PROMPT_SEGMENTS），提示能具体到第几段。
    if (segments.length === 0) {
      setError('至少要有一段提示词：先点「+ 新增一段」再保存');
      return;
    }
    const blank = segments.findIndex((draft) => draft.name.trim() === '');
    if (blank >= 0) {
      setError('第 ' + String(blank + 1) + ' 段的名称不能为空');
      return;
    }
    const target = currentTarget();
    // id 一律不传：服务端生成 id，并按数组顺序重写 position。
    const payload: PromptSegmentInput[] = segments.map((draft) => ({
      name: draft.name.trim(),
      role: draft.role,
      content: draft.content,
      enabled: draft.enabled,
      placement: draft.placement,
    }));
    setBusy(true);
    try {
      await api.savePrompt({
        scope: target.scope,
        scopeId: target.scopeId,
        temperature: parseOptionalNumber(temperature),
        maxTokens: parseOptionalNumber(maxTokens),
        segments: payload,
      });
      setMessage(
        '已保存 ' + describeScopeTarget(target.scope, target.scopeId) + '（' + String(payload.length) + ' 段）',
      );
      await loadItems();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: { scope: Scope; scopeId: string }): Promise<void> {
    if (!window.confirm('确定删除 ' + describeScopeTarget(target.scope, target.scopeId) + ' 的提示词？')) return;
    setMessage('');
    setError('');
    try {
      await api.deletePrompt(target);
      setMessage('已删除 ' + describeScopeTarget(target.scope, target.scopeId));
      await loadItems();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function loadItem(item: PromptItem): void {
    setScope(item.scope);
    setScopeId(item.scope === 'global' ? '' : item.scopeId);
    setSegments(toDrafts(item.segments));
    setTemperature(formatNumber(item.temperature));
    setMaxTokens(formatNumber(item.maxTokens));
    setError('');
    setMessage(
      '已载入 ' + describeScopeTarget(item.scope, item.scopeId) + '（' + String(item.segments.length) + ' 段）',
    );
  }

  return (
    <div className="page prompts">
      <div className="prompt-import">
        <div className="prompt-import-bar">
          <span className="hint">提示词也可以从酒馆（SillyTavern）预设导入：写 global / 服务器 / 频道任意一层，其它层不动。</span>
          <button type="button" className="primary" disabled={importBusy} onClick={() => setImportOpen((open) => !open)}>
            {importOpen ? '收起导入面板' : '从酒馆预设导入'}
          </button>
        </div>
        {importOpen ? (
          <div className="prompt-import-panel">
            <div className="prompt-import-head">
              <h3>从酒馆预设导入</h3>
              <span className="prompt-import-file">{importFile === null ? '未选文件' : importFile.name}</span>
            </div>
            <p className="hint">
              {'选一个酒馆导出的提示词预设（.json），再填上 {{char}} 指向的角色名；导入只写选中的那一层，会整层覆盖该层现有的段。预设里关着的段也会导进来，但保持停用。'}
            </p>
            <div className="row">
              <label className="field">
                <span>预设文件（.json）</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={importBusy}
                  onChange={(event) => {
                    const picked = event.target.files === null ? null : event.target.files.item(0);
                    // 清空 value：同一个文件解析失败后再选一次，change 才会再触发。
                    event.target.value = '';
                    readImportFile(picked);
                  }}
                />
              </label>
              <label className="field">
                <span>{'角色名（{{char}} 指向谁）'}</span>
                <input
                  type="text"
                  value={importCharName}
                  placeholder="例如 爱丽丝"
                  disabled={importBusy}
                  onChange={(event) => setImportCharName(event.target.value)}
                />
              </label>
            </div>
            <ScopeField
              scope={importScope}
              scopeId={importScopeId}
              onScopeChange={setImportScope}
              onScopeIdChange={setImportScopeId}
            />
            {importCharName.trim() === '' ? <p className="hint">角色名用于替换 {'{{char}}'}，必填</p> : null}
            {importError === '' ? null : <p className="error">{importError}</p>}
            {importResult === null ? null : renderImportResult(importResult)}
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={importBusy || importFile === null || importCharName.trim() === ''}
                onClick={() => void runImport()}
              >
                {importBusy ? '导入中…' : '开始导入'}
              </button>
              <button type="button" className="ghost" disabled={importBusy} onClick={closeImportPanel}>
                取消
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="card prompt-defaults">
        <h2>复制预设（整层复制到另一个作用域）</h2>
        <p className="hint">
          把一个作用域的提示词预设整层复制到另一个作用域：段、temperature、maxTokens 一起复制，目标层原有的预设会被覆盖，其它作用域不动。
          复制完页面停在当前编辑的那一层，不会自动切到目标层。
        </p>
        <h3>源作用域（从这里复制）</h3>
        <ScopeField
          scope={copyFromScope}
          scopeId={copyFromScopeId}
          onScopeChange={selectCopyFromScope}
          onScopeIdChange={selectCopyFromId}
        />
        <h3>目标作用域（会被覆盖）</h3>
        <ScopeField
          scope={copyToScope}
          scopeId={copyToScopeId}
          onScopeChange={selectCopyToScope}
          onScopeIdChange={selectCopyToId}
        />
        {copyReady ? null : (
          <p className="hint">源 / 目标是非全局层时都要填 scopeId：不知道从哪一层复制到哪一层，按钮先锁住。</p>
        )}
        {copyError === '' ? null : <p className="error">{copyError}</p>}
        {copyResult === null ? null : (
          <p className="ok">
            {'已复制到 ' +
              describeCopyTarget(copyResult.scope, copyResult.scopeId) +
              '（' +
              String(copyResult.segments.length) +
              ' 段）· 内容来源：' +
              describeCopyTarget(copyResult.sourceScope, copyResult.sourceScopeId)}
          </p>
        )}
        <div className="actions">
          <button type="button" className="primary" disabled={copyBusy || !copyReady} onClick={() => void runCopy()}>
            {copyBusy ? '复制中…' : '复制到目标作用域'}
          </button>
        </div>
      </div>

      <div className="card prompt-defaults">
        <h2>内置默认与身份块（分层编辑）</h2>
        <p className="hint">
          这两段原本写死在代码里：优先级 频道 &gt; 服务器 &gt; 全局，三层都没配才用代码内置那一份。
          保存只写当前选中层；恢复默认只删当前层的这一块，删完回落到上一层 / 代码内置。
        </p>
        <div className="prompt-default-layers" role="tablist">
          {(defaults === null ? PROMPT_DEFAULT_SCOPES : defaults.scopes).map((scopeOption) => {
            const active = defaultScope === scopeOption;
            const configured = configuredSummary(scopeOption) !== '未配置';
            return (
              <button
                key={scopeOption}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'prompt-default-layer on' : 'prompt-default-layer'}
                onClick={() => selectDefaultLayer(scopeOption)}
              >
                <span>{PROMPT_SCOPE_TITLES[scopeOption]}</span>
                <span className={configured ? 'prompt-default-dot on' : 'prompt-default-dot'} aria-hidden="true" />
                <span className="prompt-default-layer-state">{configuredSummary(scopeOption)}</span>
              </button>
            );
          })}
        </div>
        {defaultScope === 'global' ? (
          <p className="hint">全局层对所有没单独配置的频道 / 服务器生效，不用选具体对象。</p>
        ) : (
          <div className="prompt-default-target">
            <label className="field">
              <span>
                {PROMPT_SCOPE_TITLES[defaultScope]} ID（点下面已配置的直接切，或填一个新的 ID 再保存）
              </span>
              <input
                type="text"
                value={defaultTargetIds[defaultScope]}
                placeholder={'例如 123456789012345678（' + PROMPT_SCOPE_TITLES[defaultScope] + '的 Discord ID）'}
                onChange={(event) => selectDefaultTarget(event.target.value)}
              />
            </label>
            {configuredTargetIds(defaultScope).length === 0 ? (
              <p className="hint">这一层还没有配置过：上面填 {PROMPT_SCOPE_TITLES[defaultScope]} ID 就能开始存。</p>
            ) : (
              <p className="prompt-target-chips">
                <span className="hint">已配置的{PROMPT_SCOPE_TITLES[defaultScope]}：</span>
                {configuredTargetIds(defaultScope).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={defaultTargetId === id ? 'prompt-target-chip on' : 'prompt-target-chip'}
                    onClick={() => selectDefaultTarget(id)}
                  >
                    {id}
                  </button>
                ))}
              </p>
            )}
          </div>
        )}
        {defaultLoadError === '' ? null : <p className="error">{defaultLoadError}</p>}
        {defaults === null && defaultLoadError === '' ? <p className="hint">正在读取内置默认…</p> : null}
        {renderDefaultBlock('fallback')}
        {renderDefaultBlock('identity')}
        {renderCodeDefaults()}
      </div>

      <div className="card prompt-defaults">
        <h2>深度注入（按深度插一条消息）</h2>
        <p className="hint">
          优先级 频道 &gt; 服务器 &gt; 全局，只取第一条非空正文；每条回复前按 depth 插进历史：0 = 紧接本轮用户消息之前，越大越靠前。
          正文留空保存 = 这一层关掉，会话回落到下一层。
        </p>
        <div className="prompt-default-layers" role="tablist">
          {PROMPT_DEFAULT_SCOPES.map((scopeOption) => {
            const active = injectionScope === scopeOption;
            const configured = injectionSummary(scopeOption) !== '未配置';
            return (
              <button
                key={scopeOption}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'prompt-default-layer on' : 'prompt-default-layer'}
                onClick={() => selectInjectionLayer(scopeOption)}
              >
                <span>{PROMPT_SCOPE_TITLES[scopeOption]}</span>
                <span className={configured ? 'prompt-default-dot on' : 'prompt-default-dot'} aria-hidden="true" />
                <span className="prompt-default-layer-state">{injectionSummary(scopeOption)}</span>
              </button>
            );
          })}
        </div>
        {injectionScope === 'global' ? (
          <p className="hint">全局层对所有没单独配置的频道 / 服务器生效，不用选具体对象。</p>
        ) : (
          <div className="prompt-default-target">
            <label className="field">
              <span>{PROMPT_SCOPE_TITLES[injectionScope]} ID（填哪个就编辑哪一层）</span>
              <input
                type="text"
                value={injectionTargetIds[injectionScope]}
                placeholder={'例如 123456789012345678（' + PROMPT_SCOPE_TITLES[injectionScope] + '的 Discord ID）'}
                onChange={(event) => selectInjectionTarget(event.target.value)}
              />
            </label>
            {injectionTargets(injectionScope).length === 0 ? (
              <p className="hint">这一层还没有配置过：上面填 {PROMPT_SCOPE_TITLES[injectionScope]} ID 就能开始存。</p>
            ) : (
              <p className="prompt-target-chips">
                <span className="hint">已配置的{PROMPT_SCOPE_TITLES[injectionScope]}：</span>
                {injectionTargets(injectionScope).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={injectionTargetId === id ? 'prompt-target-chip on' : 'prompt-target-chip'}
                    onClick={() => selectInjectionTarget(id)}
                  >
                    {id}
                  </button>
                ))}
              </p>
            )}
          </div>
        )}
        <div className="row">
          <label className="field">
            <span>角色</span>
            <select value={injectionRole} onChange={(event) => setInjectionRole(event.target.value as InjectionRole)}>
              {INJECTION_ROLES.map((role) => (
                <option key={role} value={role}>
                  {INJECTION_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>深度 depth（0–{INJECTION_DEPTH_MAX} 的整数）</span>
            <input
              type="number"
              min="0"
              max={INJECTION_DEPTH_MAX}
              step="1"
              value={injectionDepthText}
              onChange={(event) => setInjectionDepthText(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>注入正文（留空保存 = 关掉这一层）</span>
          <textarea rows={5} value={injectionContent} onChange={(event) => setInjectionContent(event.target.value)} />
        </label>
        <p className="hint">
          {formatNumber(injectionContent.length)} / {formatNumber(INJECTION_CONTENT_MAX_CHARS)} 字
          {injectionEntry === null ? '' : ' · 上次保存 ' + injectionEntry.updatedAt}
        </p>
        {injectionError === '' ? null : <p className="error">{injectionError}</p>}
        {injectionMessage === '' ? null : <p className="hint">{injectionMessage}</p>}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={injectionBusy || (injectionScope !== 'global' && injectionTargetId.trim() === '')}
            onClick={() => void saveInjection()}
          >
            {injectionBusy ? '保存中…' : '保存这一层'}
          </button>
          <button type="button" className="danger" disabled={injectionBusy || injectionEntry === null} onClick={() => void removeInjection()}>
            删除这一层
          </button>
        </div>
      </div>

      <div className="card prompt-defaults worldbook">
        <h2>世界书（酒馆 lorebook，一层多本）</h2>
        <p className="hint">
          一个频道 / 服务器 / 全局可以放多本：启用中的书同时参与装配；优先级
          频道 &gt; 服务器 &gt; 全局，这一层整层都停用才落到下一层。
          导入永远是新增一本，不会覆盖同层已有的书。
        </p>
        <div className="prompt-default-layers" role="tablist">
          {PROMPT_DEFAULT_SCOPES.map((scopeOption) => {
            const active = worldBookScope === scopeOption;
            const imported = worldBookSummary(scopeOption) !== '未导入';
            return (
              <button
                key={scopeOption}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'prompt-default-layer on' : 'prompt-default-layer'}
                onClick={() => selectWorldBookLayer(scopeOption)}
              >
                <span>{PROMPT_SCOPE_TITLES[scopeOption]}</span>
                <span className={imported ? 'prompt-default-dot on' : 'prompt-default-dot'} aria-hidden="true" />
                <span className="prompt-default-layer-state">{worldBookSummary(scopeOption)}</span>
              </button>
            );
          })}
        </div>
        {worldBookScope === 'global' ? (
          <p className="hint">全局层对所有没单独导入的频道 / 服务器生效，不用选具体对象。</p>
        ) : (
          <div className="prompt-default-target">
            <label className="field">
              <span>{PROMPT_SCOPE_TITLES[worldBookScope]} ID（填哪个就看 / 导入哪一层世界书）</span>
              <input
                type="text"
                value={worldBookTargetIds[worldBookScope]}
                placeholder={'例如 123456789012345678（' + PROMPT_SCOPE_TITLES[worldBookScope] + '的 Discord ID）'}
                onChange={(event) => selectWorldBookTarget(event.target.value)}
              />
            </label>
            {worldBookTargets(worldBookScope).length === 0 ? (
              <p className="hint">
                这一层还没有导入过世界书：上面填 {PROMPT_SCOPE_TITLES[worldBookScope]} ID 就能开始导，填好也能直接新建条目。
              </p>
            ) : (
              <p className="prompt-target-chips">
                <span className="hint">已导入的{PROMPT_SCOPE_TITLES[worldBookScope]}：</span>
                {worldBookTargets(worldBookScope).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={worldBookTargetId === id ? 'prompt-target-chip on' : 'prompt-target-chip'}
                    onClick={() => selectWorldBookTarget(id)}
                  >
                    {id}
                  </button>
                ))}
              </p>
            )}
          </div>
        )}
        {worldBookError === '' ? null : <p className="error">{worldBookError}</p>}
        {worldBooks === null && worldBookError === '' ? <p className="hint">正在读取世界书…</p> : null}
        {worldBooks !== null && (worldBookScope === 'global' || worldBookTargetId.trim() !== '') ? (
          worldBookList.length === 0 ? (
            <div className="worldbook-empty">
              <p className="hint">这一层还没有世界书：可以新增一本，也可以导入</p>
              <div className="worldbook-entry-actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={worldBookBusy || worldBookEditBusy}
                  onClick={() => openWorldBookCreate(null)}
                >
                  {worldBookCreating && worldBookCreateBookId === null ? '收起新建' : '+ 新建条目'}
                </button>
                <span className="hint">还没有书：先填书名，保存后这本书就有第一条了。</span>
              </div>
              {worldBookCreating && worldBookCreateBookId === null ? renderWorldBookEditor(null) : null}
            </div>
          ) : (
            <div className="worldbook-list">
              {worldBookList.map((book) => {
                const expanded = worldBookExpandedId === book.bookId;
                const editingHere = worldBookEditBookId === book.bookId && worldBookEditId !== null;
                const creatingHere = worldBookCreating && worldBookCreateBookId === book.bookId;
                const renamingHere = worldBookRenameId === book.bookId;
                return (
                  <div className={book.enabled ? 'worldbook-book' : 'worldbook-book off'} key={book.bookId}>
                    <div className="worldbook-book-head">
                      <button
                        type="button"
                        className="worldbook-book-toggle"
                        aria-expanded={expanded}
                        onClick={() => setWorldBookExpandedId(expanded ? null : book.bookId)}
                      >
                        <span className="worldbook-book-caret" aria-hidden="true">
                          {expanded ? '▾' : '▸'}
                        </span>
                        <span className="worldbook-book-name">
                          {book.name === '' ? '（这本没有名字）' : book.name}
                        </span>
                      </button>
                      <span className="badge">{formatNumber(book.entryCount)} 条</span>
                      <span className="badge">导入于 {formatSavedAt(book.importedAt)}</span>
                      <label className="row checkbox worldbook-book-switch">
                        <input
                          type="checkbox"
                          checked={book.enabled}
                          disabled={
                            worldBookBusy || (worldBookTogglingId !== null && worldBookTogglingId !== book.bookId)
                          }
                          onChange={() => void toggleWorldBook(book)}
                        />
                        <span>{book.enabled ? '启用' : '停用'}</span>
                      </label>
                      <span className="worldbook-book-actions">
                        <button
                          type="button"
                          className="link small"
                          disabled={worldBookBusy || worldBookEditBusy}
                          onClick={() => openWorldBookCreate(book)}
                        >
                          {creatingHere ? '收起新建' : '+ 新建条目'}
                        </button>
                        <button
                          type="button"
                          className="link small"
                          disabled={worldBookBusy || worldBookEditBusy}
                          onClick={() => openWorldBookRename(book)}
                        >
                          {renamingHere ? '收起重命名' : '重命名'}
                        </button>
                        <button
                          type="button"
                          className="link small danger"
                          disabled={worldBookBusy}
                          onClick={() => void removeWorldBook(book)}
                        >
                          删除本书
                        </button>
                      </span>
                    </div>
                    {renamingHere ? renderWorldBookRename(book) : null}
                    {expanded ? (
                      <>
                        {renderWorldBookEntries(book)}
                        {editingHere || creatingHere ? renderWorldBookEditor(book) : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )
        ) : null}
        <div className="row">
          <label className="field">
            <span>世界书文件（.json 或角色卡 V2）</span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={worldBookBusy}
              onChange={(event) => {
                const picked = event.target.files === null ? null : event.target.files.item(0);
                // 清空 value：同一个文件解析失败后再选一次，change 才会再触发。
                event.target.value = '';
                readWorldBookFile(picked);
              }}
            />
          </label>
          <label className="field">
            <span>或直接粘贴 JSON（粘贴优先于文件）</span>
            <textarea
              rows={4}
              value={worldBookPaste}
              placeholder='{"entries": {…}} 或角色卡 {"data": {"character_book": {…}}}'
              disabled={worldBookBusy}
              onChange={(event) => setWorldBookPaste(event.target.value)}
            />
          </label>
        </div>
        {worldBookFile === null ? null : <p className="hint">已读入文件：{worldBookFile.name}</p>}
        <p className="hint">
          <span>{'新增前先确认：这会为 '}</span>
          <strong>
            {worldBookScope !== 'global' && worldBookTargetId === ''
              ? '（还没填 ' + PROMPT_SCOPE_TITLES[worldBookScope] + ' ID）'
              : describeScopeTarget(worldBookScope, worldBookTargetId)}
          </strong>
          <span>{' 新增一本世界书，同层已有的书全部保留；重名会自动加「（2）」后缀。'}</span>
        </p>
        {worldBookMessage === '' ? null : <p className="ok">{worldBookMessage}</p>}
        {worldBookResult === null ? null : renderWorldBookResult(worldBookResult)}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={worldBookBusy || (worldBookScope !== 'global' && worldBookTargetId.trim() === '')}
            onClick={() => void runWorldBookImport()}
          >
            {worldBookBusy ? '导入中…' : '新增一本'}
          </button>
        </div>
      </div>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>提示词配置</h2>
        <p className="hint">优先级 channel &gt; guild &gt; global；三层都缺失时用内置默认提示词。</p>
        <ScopeField
          scope={scope}
          scopeId={scopeId}
          onScopeChange={setScope}
          onScopeIdChange={setScopeId}
        />
        <div className="row">
          <label className="field">
            <span>temperature（可选）</span>
            <input type="number" step="0.1" min="0" max="2" value={temperature} onChange={(event) => setTemperature(event.target.value)} />
          </label>
          <label className="field">
            <span>maxTokens（可选）</span>
            <input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} />
          </label>
        </div>

        <h2>提示词分段</h2>
        <p className="hint">
          按列表顺序拼接：system 段拼进系统提示词，user 段插在历史消息之前。「位置」只对 system 段生效。
        </p>
        {segments.length === 0 ? <p className="hint">还没有段：点下面的「+ 新增一段」开始。</p> : null}
        <div className="segment-list">
          {segments.map((draft, index) => (
            <div className="segment" key={draft.key}>
              <div className="segment-head">
                <span className="segment-title">第 {index + 1} 段</span>
                <span className="badge">{PROMPT_ROLE_LABELS[draft.role]}</span>
                <div className="segment-actions">
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busy || index === 0}
                    onClick={() => moveSegment(index, -1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busy || index === segments.length - 1}
                    onClick={() => moveSegment(index, 1)}
                  >
                    下移
                  </button>
                  <button type="button" className="danger small" disabled={busy} onClick={() => removeSegment(draft.key)}>
                    删除
                  </button>
                </div>
              </div>
              <div className="row">
                <label className="field">
                  <span>名称</span>
                  <input
                    type="text"
                    value={draft.name}
                    placeholder="例如 主体设定"
                    onChange={(event) => patchDraft(draft.key, { name: event.target.value })}
                  />
                </label>
                <label className="field segment-role">
                  <span>角色</span>
                  <select
                    value={draft.role}
                    onChange={(event) => patchDraft(draft.key, { role: event.target.value as PromptRole })}
                  >
                    {PROMPT_ROLE_IDS.map((role) => (
                      <option key={role} value={role}>
                        {PROMPT_ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {draft.role === 'system' ? (
                <div className="row">
                  <label className="field segment-placement">
                    <span>位置（相对累积摘要块）</span>
                    <select
                      value={draft.placement}
                      onChange={(event) => patchDraft(draft.key, { placement: event.target.value as PromptPlacement })}
                    >
                      {PROMPT_PLACEMENT_IDS.map((placement) => (
                        <option key={placement} value={placement}>
                          {PROMPT_PLACEMENT_LABELS[placement]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
              <label className="field">
                <span>内容</span>
                <textarea
                  rows={6}
                  value={draft.content}
                  placeholder="支持 {{bot_name}} 等占位符，换行会原样保留"
                  onChange={(event) => patchDraft(draft.key, { content: event.target.value })}
                />
              </label>
              <label className="row checkbox">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => patchDraft(draft.key, { enabled: event.target.checked })}
                />
                <span>启用这一段（关掉后内容留在库里，但不参与拼接）</span>
              </label>
            </div>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="ghost" disabled={busy} onClick={addSegment}>
            + 新增一段
          </button>
        </div>

        {message === '' ? null : <p className="ok">{message}</p>}
        {error === '' ? null : <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" className="ghost" onClick={() => void remove(currentTarget())}>
            删除当前作用域
          </button>
        </div>
      </form>

      <aside className="card">
        <h2>模板变量</h2>
        <p className="hint">
          保存时只允许下列占位符，其它形如 {'{{var}}'} 的写法会被服务端 400 拒绝。
        </p>
        <ul className="chips">
          {TEMPLATE_VARS.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <h2>拼接规则</h2>
        <p className="hint">
          system 段按顺序拼进系统提示词，位置 = 累积摘要块之前还是之后；user 段按顺序插在历史消息之前。
        </p>
        <p className="hint">没启用的段照样保存，只是不参与拼接。</p>
        <h2>已有条目</h2>
        {items.length === 0 ? <p className="hint">还没有配置。</p> : null}
        <ul className="items">
          {items.map((item) => {
            const target = describeScopeTarget(item.scope, item.scopeId);
            const enabled = item.segments.filter((segment) => segment.enabled).length;
            return (
              <li key={target}>
                <button type="button" className="link" disabled={busy} onClick={() => loadItem(item)}>
                  {target}
                </button>
                <span className="hint">
                  共 {item.segments.length} 段 · 启用 {enabled}
                </span>
                <button
                  type="button"
                  className="danger small"
                  onClick={() => void remove({ scope: item.scope, scopeId: item.scopeId })}
                >
                  删除
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
