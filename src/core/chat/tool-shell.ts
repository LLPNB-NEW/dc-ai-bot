/**
 * 频道预设（酒馆导入的「示例角色」）要求模型调用 `story_reply` 并把正文放进 content，
 * 模型却常把调用壳本身当正文写出来：`<run_tool_name>story_reply</run_tool_name><run_tool_args>…`、
 * `call:story_reply{content:<<<|catgodml|str|…>>>}`、`<|FunctionCallBegin|>[{"name": …}]`。
 * 壳只是提示词约定，发到 Discord 就成了一堆标记——这里只做「切头 + 剥尾」，正文一个字都不改。
 */

/** 触发剥壳的工具名：文本里没有它就整段原样返回 */
const TOOL_NAME = 'story_reply';

/** 头部外壳的收尾：命中处之后就是正文；多处命中取最靠后的（工具名与参数可以套两层） */
const HEAD_END_PATTERNS: readonly RegExp[] = [
  /<run_tool_args>/,
  /<<<\|catgodml\|str\|/,
  /"content"\s*:\s*["']/,
  /\{content\s*:\s*["']/,
];

/**
 * 认不出的开头（例如只有 `<run_tool_replacement>`、没有参数壳）：切到工具名之后，再吃掉紧跟的
 * 闭合标签与壳标点。只吃闭合标签和标点、不吃开标签，正文开头常带 `<think_nya>` 才不会被误伤。
 */
const NAME_TAIL_PATTERN =
  /^(?:(?:<run_tool_args>|<run_tool_replacement>|<<ptool_call>>|<\|tool_call>|<\|FunctionCallBegin\|>|<\/[A-Za-z_][^<>\n]{0,40}>)|[\s:|,}{[\]()'"])*/;

/** 已知的结尾残渣（生产探针里见过的全部写法）；长串在前 */
const TAIL_MARKERS: readonly string[] = [
  '</run_tool_args>',
  '<</story_reply>>',
  '</story_reply>',
  '<|FunctionCallEnd|>',
  '<<ptool_call>>',
  '>>>',
  '[END]',
];

/** 兜底残渣：列表之外的写法。只吃「整块外壳」——未知标签、成片的 >、方括号哨兵、JSON 收尾 */
const TAIL_PATTERNS: readonly RegExp[] = [
  /<?<\/[^<>\n]{0,60}>$/,
  /<[^<>\n]{0,60}>$/,
  /(?:>{2,}|>[}\]"']+)$/,
  /\[[A-Z_]{2,16}\]$/,
  /"\s*[}\]]+$/,
];

/** 头部切到哪：返回正文起点下标；文本里没有工具名返回 -1 */
function bodyStart(raw: string): number {
  const at = raw.indexOf(TOOL_NAME);
  if (at === -1) return -1;
  const afterName = at + TOOL_NAME.length;
  const end = headCutEnd(raw, afterName);
  if (end !== -1) return end;
  const tail = NAME_TAIL_PATTERN.exec(raw.slice(afterName));
  return afterName + (tail === null ? 0 : tail[0].length);
}

/** 工具名之后最近的一个外壳收尾位置；一个都认不出来返回 -1 */
function headCutEnd(raw: string, from: number): number {
  let end = -1;
  for (const source of HEAD_END_PATTERNS) {
    // 每次新建实例：带 g 的正则带 lastIndex 状态，模块级共用会串到下一次调用
    const pattern = new RegExp(source.source, 'g');
    pattern.lastIndex = from;
    for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
      end = Math.max(end, match.index + match[0].length);
    }
  }
  return end;
}

/** 剥掉尾巴上的一处残渣；没有可剥的原样返回 */
function stripOneTail(text: string): string {
  for (const marker of TAIL_MARKERS) {
    if (text.endsWith(marker)) return text.slice(0, text.length - marker.length);
  }
  for (const pattern of TAIL_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return text.slice(0, match.index);
  }
  return text;
}

/** 反复剥尾巴、每轮 trim，剥到不再变化为止（残渣会叠：`</run_tool_args>` 后面还挂过 `[END]`） */
function stripTails(body: string): string {
  let text = body.trim();
  for (;;) {
    const next = stripOneTail(text).trim();
    if (next === text) return text;
    text = next;
  }
}

/**
 * 剥掉模型自写的 `story_reply` 调用壳：只切头部外壳、剥尾部残渣，中间正文一个字都不动
 * （`<think_nya>` 属于正文，保留）。剥完为空就是空——不回退成原始壳文本。
 */
export function unwrapToolReply(raw: string): { text: string; unwrapped: boolean } {
  const start = bodyStart(raw);
  if (start === -1) return { text: raw, unwrapped: false };
  return { text: stripTails(raw.slice(start)), unwrapped: true };
}

/**
 * 流式用：半截文本里壳还没收尾，头切不开时先一个字都不推，等 `<run_tool_args>` 之类的收尾到了
 * 再露正文——宁可晚一点，也不让壳先刷进 Discord。没有工具名时与旧行为一致（trim 后原样）。
 */
export function unwrapToolReplyStream(raw: string): string {
  const at = raw.indexOf(TOOL_NAME);
  if (at === -1) return raw.trim();
  const end = headCutEnd(raw, at + TOOL_NAME.length);
  return end === -1 ? '' : stripTails(raw.slice(end));
}
