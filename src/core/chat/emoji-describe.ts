import type { LlmImage, LlmRequest, ReactionModelConfig } from '../types';

/**
 * 一句描述的上限（UTF-16 code unit，超出截断，§23.3）。
 * 只约束认图产出：注入提示词时不再二次截断（§23.5）。
 */
export const DESCRIBE_MAX_CHARS = 20;

/** 一次请求塞几张图（§23.3）：多了模型会把这些图对错号，宁可多跑几次 */
export const DESCRIBE_BATCH_SIZE = 6;

/** 待认的一个表情：id 只用来对号，name 进提示词，image 走线缆（§23.3） */
export interface DescribeTarget {
  id: string;
  name: string;
  image: LlmImage;
}

/**
 * 认图的四条口径必须写死（§23.3）：只描述画面上看到的、一句中文不超过 20 字、
 * 不要解释/代码围栏/标点结尾、只输出 id=描述 的行且宁可漏也不要编。
 * 少了最后一条，模型会替「没认出来的表情」编一个看着很合理的描述，比留空更糟。
 * 试过再加一条「认得出知名形象就写名字」：奶龙这类二创像素图认不出来，还让模型多写解释、
 * 36 个表情里 12 个解析失败（实测 2026-10-26），所以退回四条。
 */
export const DESCRIBE_SYSTEM_PROMPT: string = [
  '你负责看自定义表情的图片，只描述画面上真正看到的东西：角色外形、表情、动作，和图上出现的文字。',
  '每个表情写一句中文，不超过 20 字。',
  '不要解释，不要代码围栏，不要在结尾加标点。',
  '只输出 id=描述 形式的行，一行一个；认不出的就整行不写，宁可漏也不要编。',
].join('\n');

/** 清单段标题：与主提示词同一个写法，模型不必重新学一种排版 */
const TARGETS_HEADER = '【要认的表情】';

/** 编号与图片的对应关系要说出来，否则模型会把第 3 张图描述成第 1 行 */
const PAIRING_LINE = '图片与上面的编号一一对应：第 1 张图就是第 1 行。';

/** 读取端的唯一形状（§23.3）：这一行必须留在最后 */
const OUTPUT_LINE = '每个表情输出一行，形如 id=描述。';

/**
 * 一次认图请求：指令放 system、要认的清单与图放对话侧（§23.3）。
 * 不设 temperature / maxTokens：与 §21.3 同口径，走供应商默认。
 * images 非空才写进请求：空批次时 LlmRequest 的形状与纯文本请求逐字相同。
 */
export function buildDescribeRequest(
  cfg: ReactionModelConfig,
  batch: readonly DescribeTarget[],
): LlmRequest {
  const lines: string[] = [TARGETS_HEADER];
  batch.forEach((target, index) => {
    lines.push(`${String(index + 1)}. ${target.name.trim()}（id ${target.id}）`);
  });
  lines.push(PAIRING_LINE, OUTPUT_LINE);
  const request: LlmRequest = {
    model: cfg.model,
    system: DESCRIBE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: lines.join('\n') }],
  };
  // 空数组与缺省一样：键都不出现，否则「有没有图」在下游会多出一种形状（与 §22.6 同口径）
  if (batch.length > 0) request.images = batch.map((target) => target.image);
  return request;
}

/** 全角等号也认：模型在中文输入法下敲 `＝` 是常事（§23.3） */
const SEPARATORS: readonly string[] = ['=', '＝'];

/** 模型爱用这些成对符号包住整行或描述本身；不剥掉的话描述里会带噪声（与 §21.3 同一份表） */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
];

/** 行首的排版噪声：`- ` / `* ` / `> ` 这类列表符，以及模型自己重复的 `1. ` / `2、` 编号 */
const LEADING_MARKER = /^(?:[-*•·>]+\s*|\d+\s*[.、)．]\s*)/;

/** 反复剥掉成对包裹的符号：剥掉一层再看下一层，``描述`` 也能还原成 描述 */
function unwrapWrappers(value: string): string {
  let text = value.trim();
  for (;;) {
    let matched: readonly [string, string] | null = null;
    for (const pair of WRAPPERS) {
      if (text.length < 2) break;
      if (text.startsWith(pair[0]) && text.endsWith(pair[1])) {
        matched = pair;
        break;
      }
    }
    if (matched === null) return text;
    text = text.slice(matched[0].length, text.length - matched[1].length).trim();
  }
}

/** id 与描述的分界：取最早出现的那个等号，描述里再出现等号不算分界 */
function firstSeparator(line: string): number {
  let at = -1;
  for (const separator of SEPARATORS) {
    const index = line.indexOf(separator);
    if (index < 0) continue;
    if (at < 0 || index < at) at = index;
  }
  return at;
}

/** 字面量边界的判据：id 两侧不能紧贴字母数字，否则 `1` 会命中 `12` 里那一位 */
const WORD_CHAR = /[0-9A-Za-z_]/;

/** 整段里有没有出现过这个 id，且两侧都没贴着字母数字 */
function hasStandalone(text: string, id: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(id, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = at + id.length >= text.length ? '' : text.charAt(at + id.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = at + 1;
  }
}

/**
 * 等号左边那一段里认一个 batch 里真有的 id（§23.3）。
 * 先认整段相等，再认「夹在噪声里」的写法（`id e1`、`:e1:`、`- e1` 都是模型写过的东西）；
 * 多个命中时取最长的那个，免得批次里同时有 `1` 与 `12` 时对错号。
 */
function resolveId(head: string, batch: readonly DescribeTarget[]): string | null {
  const exact = batch.find((target) => target.id === head);
  if (exact !== undefined) return exact.id;
  let best: string | null = null;
  for (const target of batch) {
    if (target.id === '') continue;
    if (!hasStandalone(head, target.id)) continue;
    if (best === null || target.id.length > best.length) best = target.id;
  }
  return best;
}

/**
 * 把模型那段输出压成可以直接落库的描述表（§23.3）。
 * 规则一条不少：按行切、全角等号也认、等号前后空白忽略、id 不在本批的丢弃、
 * 描述剥掉成对反引号/引号后截 20 字、空描述丢弃、同一 id 取第一次。
 * 返回顺序按 batch 而不是模型的行序：调用方要按「批里第 i 个」对上号。
 */
export function parseDescribeOutput(
  raw: string,
  batch: readonly DescribeTarget[],
): Array<{ emojiId: string; description: string }> {
  const found = new Map<string, string>();
  for (const rawLine of raw.split('\n')) {
    const line = unwrapWrappers(rawLine).replace(LEADING_MARKER, '').trim();
    if (line === '') continue;
    const separator = firstSeparator(line);
    // 没有等号的行一定是解释或空壳：整行走不到对号这一步
    if (separator < 0) continue;
    const emojiId = resolveId(line.slice(0, separator).trim(), batch);
    if (emojiId === null) continue;
    const description = unwrapWrappers(line.slice(separator + 1));
    if (description === '') continue;
    // 同一 id 取第一次出现：模型重复输出同一行时，后面的多半是自我修正，不可信
    if (found.has(emojiId)) continue;
    found.set(emojiId, description.slice(0, DESCRIBE_MAX_CHARS));
  }
  const result: Array<{ emojiId: string; description: string }> = [];
  for (const target of batch) {
    const description = found.get(target.id);
    if (description === undefined) continue;
    result.push({ emojiId: target.id, description });
  }
  return result;
}
