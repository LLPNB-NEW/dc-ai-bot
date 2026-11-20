import type { DecryptedKey } from '../types';

/** 名单里允许出现的字符（§20.4）；`*` 只允许出现在末尾，单独处理。字母按 unicode 算，中文模型名（`假流式-…`）才能进名单 */
const ALLOWED = /^[\p{L}\p{N}._:-]$/u;
const WILDCARD = '*';

/**
 * trim → 丢掉末尾 `*` 之外的非法字符 → 丢空 → 去重（小写比较，保留首次出现的原始大小写）。
 * 保留原始大小写，匹配统一小写（§20.3 存的是用户输入的原样，§20.4 只在比较时归一）。
 */
export function normalizeModelPatterns(raw: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const pattern = sanitize(item);
    if (pattern === '') continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(pattern);
  }
  return kept;
}

/** 逐个字符筛：非法字符直接丢；`*` 只有落在最后一位才是通配，否则同样是非法字符 */
function sanitize(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const last = trimmed.length - 1;
  let pattern = '';
  for (let index = 0; index <= last; index += 1) {
    const char = trimmed[index]!;
    if (char === WILDCARD) {
      if (index === last) pattern += char;
      continue;
    }
    if (ALLOWED.test(char)) pattern += char;
  }
  return pattern;
}

/** 0 = 显式命中；1 = 通用；2 = 声明了别的模型 */
export type KeyRank = 0 | 1 | 2;

/**
 * 名单对某个模型的偏好档位（§20.4）：三档全部保留在候选里——名单是偏好不是硬约束，
 * 新模型没来得及声明时仍然能跑通（§20.8）。
 */
export function rankKey(patterns: readonly string[], model: string): KeyRank {
  const normalized = normalizeModelPatterns(patterns);
  const target = model.trim().toLowerCase();
  let wildcard = normalized.length === 0;
  for (const pattern of normalized) {
    const lower = pattern.toLowerCase();
    if (lower === WILDCARD) {
      // 单独的 `*` 表达「全部模型」，不算某一模型的显式命中
      wildcard = true;
      continue;
    }
    if (lower === target) return 0;
    if (lower.endsWith(WILDCARD) && target.startsWith(lower.slice(0, -1))) return 0;
  }
  return wildcard ? 1 : 2;
}

/** 按 (rank, 原序) 稳定排序；同 rank 保持仓储给的 created_at,id 顺序，不改动入参 */
export function orderKeysForModel(keys: readonly DecryptedKey[], model: string): DecryptedKey[] {
  return keys
    .map((key, index) => ({ key, index, rank: rankKey(key.models, model) }))
    .sort((left, right) => (left.rank - right.rank) || (left.index - right.index))
    .map((entry) => entry.key);
}
