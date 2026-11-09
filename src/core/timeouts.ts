/**
 * 超时配置：内置默认 → 环境变量 → 后台保存的覆盖值，逐层覆盖，最后乘上全局倍率。
 * 调用点一律现取（resolveTimeout），所以后台保存后下一条请求就用新值，不必重启。
 */

export const TIMEOUT_KEYS = [
  'llm',
  'image',
  'tts',
  'ttsGemini',
  'judgeFloor',
  'judgePerChar',
  'judgeCap',
  'pgErrors',
  'shutdown',
] as const;

export type TimeoutKey = (typeof TIMEOUT_KEYS)[number];

export const MULTIPLIER_KEY = 'multiplier';

/** 后台一栏一行，顺序即界面顺序 */
export interface TimeoutField {
  key: TimeoutKey;
  env: string;
  label: string;
  detail: string;
  defaultMs: number;
  minMs: number;
  maxMs: number;
}

export const TIMEOUT_FIELDS: readonly TimeoutField[] = [
  {
    key: 'llm',
    env: 'LLM_TIMEOUT_MS',
    label: '对话请求',
    detail: '一次模型请求从建连到首字节的上限；历史很长时不要低于 180 秒',
    defaultMs: 180_000,
    minMs: 5_000,
    maxMs: 600_000,
  },
  {
    key: 'image',
    env: 'IMAGE_TIMEOUT_MS',
    label: '图片生成',
    detail: 'draw_image 与生图端点的整轮上限',
    defaultMs: 180_000,
    minMs: 10_000,
    maxMs: 600_000,
  },
  {
    key: 'tts',
    env: 'TTS_TIMEOUT_MS',
    label: '语音合成',
    detail: 'openai / mimo 两种方言的整段合成上限',
    defaultMs: 30_000,
    minMs: 5_000,
    maxMs: 600_000,
  },
  {
    key: 'ttsGemini',
    env: 'TTS_GEMINI_TIMEOUT_MS',
    label: '语音合成（Gemini）',
    detail: 'Gemini 一次交整段音频，耗时随字数线性增长（204 字约 11 秒）',
    defaultMs: 120_000,
    minMs: 10_000,
    maxMs: 600_000,
  },
  {
    key: 'judgeFloor',
    env: 'JUDGE_FLOOR_MS',
    label: '语气评审起步',
    detail: '判断情绪时先给这么多，再按字数追加',
    defaultMs: 15_000,
    minMs: 1_000,
    maxMs: 120_000,
  },
  {
    key: 'judgePerChar',
    env: 'JUDGE_PER_CHAR_MS',
    label: '语气评审每字',
    detail: '正文字数每多一个字追加的毫秒数',
    defaultMs: 40,
    minMs: 1,
    maxMs: 500,
  },
  {
    key: 'judgeCap',
    env: 'JUDGE_CAP_MS',
    label: '语气评审上限',
    detail: '起步 + 每字 × 字数，封顶在这里',
    defaultMs: 45_000,
    minMs: 5_000,
    maxMs: 600_000,
  },
  {
    key: 'pgErrors',
    env: 'PG_ERRORS_TIMEOUT_MS',
    label: '中继报错查询',
    detail: '后台拉 /admin/errors 的上限',
    defaultMs: 5_000,
    minMs: 1_000,
    maxMs: 60_000,
  },
  {
    key: 'shutdown',
    env: 'SHUTDOWN_TIMEOUT_MS',
    label: '进程退出等待',
    detail: '收到停止信号后最多等这么久，超时强制结束；下一次退出才生效',
    defaultMs: 25_000,
    minMs: 5_000,
    maxMs: 300_000,
  },
];

/** 全局倍率：一次把所有超时放大或缩小，0.1–10 倍 */
export const MULTIPLIER_MIN = 0.1;
export const MULTIPLIER_MAX = 10;
export const MULTIPLIER_ENV = 'TIMEOUT_MULTIPLIER';

export interface TimeoutSettings {
  llm: number;
  image: number;
  tts: number;
  ttsGemini: number;
  judgeFloor: number;
  judgePerChar: number;
  judgeCap: number;
  pgErrors: number;
  shutdown: number;
  multiplier: number;
}

export type TimeoutOverrides = Partial<Record<keyof TimeoutSettings, number>>;

function envNumber(name: string): number | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env === undefined) return null;
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** 环境变量与内置默认拼出的基线，后台没有覆盖时就用它 */
export function timeoutDefaults(): TimeoutSettings {
  const settings = {} as TimeoutSettings;
  for (const field of TIMEOUT_FIELDS) {
    const fromEnv = envNumber(field.env);
    settings[field.key] = clamp(fromEnv === null ? field.defaultMs : fromEnv, field.minMs, field.maxMs);
  }
  const multiplier = envNumber(MULTIPLIER_ENV);
  settings.multiplier = clamp(multiplier === null ? 1 : multiplier, MULTIPLIER_MIN, MULTIPLIER_MAX);
  return settings;
}

function normalize(overrides: TimeoutOverrides): TimeoutSettings {
  const settings = timeoutDefaults();
  for (const field of TIMEOUT_FIELDS) {
    const value = overrides[field.key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      settings[field.key] = clamp(value, field.minMs, field.maxMs);
    }
  }
  const multiplier = overrides.multiplier;
  if (typeof multiplier === 'number' && Number.isFinite(multiplier)) {
    settings.multiplier = clamp(multiplier, MULTIPLIER_MIN, MULTIPLIER_MAX);
  }
  return settings;
}

let current: TimeoutSettings = normalize({});

/** 当前生效的配置（未乘倍率），后台回读用 */
export function timeoutSettings(): TimeoutSettings {
  return { ...current };
}

/** 后台保存后调用：整份替换，随后所有 resolveTimeout 立刻用新值 */
export function applyTimeoutOverrides(overrides: TimeoutOverrides): void {
  current = normalize(overrides);
}

/** 恢复成环境变量与内置默认（后台「恢复默认」与测试重置都用它） */
export function resetTimeouts(): void {
  current = normalize({});
}

/** 某个超时的实际毫秒数：基线 × 全局倍率，夹在该字段的上下限里 */
export function resolveTimeout(key: TimeoutKey): number {
  const field = TIMEOUT_FIELDS.find((item) => item.key === key);
  if (field === undefined) return 0;
  const scaled = Math.round(current[key] * current.multiplier);
  return clamp(scaled, field.minMs, field.maxMs);
}

/** 语气评审这次该等多久：起步 + 每字 × 字数，封顶由「语气评审上限」管 */
export function judgeTimeoutMs(chars: number): number {
  const scaled = resolveTimeout('judgeFloor') + Math.max(0, chars) * resolveTimeout('judgePerChar');
  const cap = resolveTimeout('judgeCap');
  return scaled < cap ? scaled : cap;
}
