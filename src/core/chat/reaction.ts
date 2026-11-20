import type {
  CustomEmoji,
  LlmImage,
  LlmRequest,
  LlmResponseFormat,
  ReactionModelConfig,
  ReactionRequest,
  ReactionTarget,
} from '../types';
import { MAX_REACTIONS, parseReactionValue, reactionKey, splitReactDirectives } from './react';
import { renderReactionMaterial } from './reaction-template';

/** 清单最多列 40 个，与 §18.5 的 renderEmojiBlock 同口径：全服几百个表情会把这轮 prompt 撑爆 */
export const REACTION_MAX_CATALOG = 40;

/**
 * 表情模型只看最近这么多条历史（§34.1），与频道「注入条数」设置解耦：
 * 它每回一条消息都要多跑一次调用，历史越多越贵，而贴表情只需要眼前这几句上下文。
 */
export const REACTION_HISTORY_MESSAGES = 20;

/** 清单段标题取主提示词里的同名段：两处教的是同一批名字，模型不必重新学一种写法 */
const CATALOG_HEADER = '【可用自定义表情】';

/** 可贴表情的消息段标题（§28.4）：主模型与表情模型吃的是同一段，措辞不能分叉 */
export const REACTION_TARGETS_HEADER = '【可贴表情的消息】';

/** 表示「不贴」的几种写法：§21.3 只认这四个 */
const NO_REACTION = new Set(['NONE', 'none', '无', '不贴']);

/**
 * 「这轮不贴」怎么写：只补在表情模型的 system 里，不进 reaction-guide.ts 那份共用规则。
 * 共用规则同时喂主模型的 system，教出「只输出一行 NONE」这种正文约定，模型偶尔就真照着说出来，
 * 回复开头于是多一行 NONE；放这里，主模型那一侧永远看不到这句话。
 */
export const NO_REACTION_NOTE = '没有值得贴的表情时，只回一行 NONE，不要解释为什么。';

/**
 * 挑一个表情不需要深想（§21）：给这条支线钉最低档，省下几秒思考时间；
 * 认这个键的通道才发，Anthropic 等不发该键的通道忽略它。
 */
export const REACTION_REASONING_EFFORT = 'low';

/**
 * 表情选择的结构化输出契约：中继把它翻成上游的 response_mime_type / response_schema，
 * 模型只需填一个字符串字段，省掉「表情 + 一行解释」这种要再猜第一 token 的纯文本；
 * 但 Anthropic 等不发该键的通道仍回纯文本，所以解析侧必须保留老路径（JSON 只当前缀尝试）。
 */
export const REACTION_RESPONSE_FORMAT: LlmResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'reaction_choice',
    schema: {
      type: 'object',
      properties: {
        reaction: {
          type: 'string',
          description: '要贴的表情：unicode emoji 或 :名字:，可带 @消息ID / @作者名；这轮不贴就写 NONE',
        },
      },
      required: ['reaction'],
    },
  },
};

/** 一行输出里只取第一个 token：`👍 因为很开心` 的答案是前面那个（§21.3 规则 5） */
const WHITESPACE = /\s+/;

/** unicode emoji 认得出来：有 pictographic 码位就是，`不是表情的几个字` 一个都没有 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** Discord 表情真名只能是 ASCII 字母数字下划线波浪号；模型写裸名时靠它认 */
const BARE_NAME = /^[A-Za-z0-9_~]{2,32}$/;

/** 已经成型的两种写法：`名字:id` 与 `<:名字:id>`，与 §18.6 resolveReactionEmoji 认的同形 */
const NAME_ID = /^[A-Za-z0-9_~]{2,32}:\d+$/;
const ANGLE_NAME_ID = /^<a?:[A-Za-z0-9_~]{2,32}:\d+>$/;

/** 模型爱用这些成对符号包住答案；不剥掉的话下游 §18.6 一个都认不出 */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
];

/**
 * 一个清单项的最终写法（§23.5 / §24.4）：`:名字:` + 描述 `(…)` + 别名 ` 别名「a、b」`。
 * 描述与别名 trim 后为空就各自不出现——没认过、没配别名的表情与 §18.5 逐字相同；
 * 这里不二次截断（截断只发生在认图产出侧，§23.3 的 DESCRIBE_MAX_CHARS）。
 * 两处必须逐字一致：表情模型与主模型看的是同一份清单，写法一分叉就会互相教坏。
 */
function withEmojiDescription(emoji: CustomEmoji): string {
  const token = ':' + emoji.name.trim() + ':';
  const descText = (emoji.description ?? '').trim();
  const aliasText = (emoji.aliases ?? [])
    .map((alias) => alias.trim())
    .filter((alias) => alias !== '')
    .join('、');
  const head = descText === '' ? token : token + '(' + descText + ')';
  return aliasText === '' ? head : head + ' 别名「' + aliasText + '」';
}

/**
 * 清单段：没有可用名字时返回空串，调用方整段不拼——留一个空壳分段只会让模型以为
 * 「必须从空清单里挑一个」，然后写出谁也渲染不了的字面文字。
 */
function renderCatalog(customEmojis: CustomEmoji[] | undefined): string {
  if (customEmojis === undefined) return '';
  const names: string[] = [];
  // 去重仍按 `:名字:` 判：描述只是后缀，同名表情不能因为描述不同就列两遍（§23.5 规则不变）
  const seen = new Set<string>();
  for (const emoji of customEmojis) {
    const name = emoji.name.trim();
    if (name === '') continue;
    const token = ':' + name + ':';
    if (seen.has(token)) continue;
    seen.add(token);
    names.push(withEmojiDescription(emoji));
    if (names.length >= REACTION_MAX_CATALOG) break;
  }
  return names.length === 0 ? '' : CATALOG_HEADER + '\n' + names.join(' ');
}

/**
 * 可贴表情的消息段（§28.4）：一行一条 `#<消息ID> <作者>：「<正文前 30 字>」`。
 * 没有清单返回空串，调用方整段不拼——留个空壳分段只会让模型以为「清单里有东西」。
 * 摘要为空就省掉引文段，与 §18.3 退化表同样的取舍。
 */
function targetsSection(targets: readonly ReactionTarget[] | undefined): string {
  if (targets === undefined) return '';
  const lines: string[] = [];
  for (const target of targets) {
    const messageId = target.messageId.trim();
    // 没有消息 ID 的目标贴不上去，写进提示词只会骗模型也骗我们
    if (messageId === '') continue;
    const excerpt = target.excerpt.trim();
    const quote = excerpt === '' ? '' : '：「' + excerpt + '」';
    lines.push('#' + messageId + ' ' + target.author.trim() + quote);
  }
  return lines.length === 0 ? '' : REACTION_TARGETS_HEADER + '\n' + lines.join('\n');
}

/**
 * 提示词里的整段（段前空两行，与其它段同风格）：主模型 system 与表情模型素材共用这一段，
 * 免得两处各写一份、悄悄分叉。
 */
export function renderReactionTargets(targets: readonly ReactionTarget[] | undefined): string {
  const block = targetsSection(targets);
  return block === '' ? '' : '\n\n' + block;
}

/**
 * 一次单轮请求：指令放 system、素材放对话侧，模型才不会把指令当成资料复述回来。
 * 不设 temperature / maxTokens：走供应商默认，表情是单 token 输出，多调一个旋钮只多一处可错的地方。
 * images 非空才写进请求（§22.6）：无图时 LlmRequest 的形状与 §21.3 逐字相同，适配器走老线缆。
 * 素材段由模板决定（§34.3）：顺序、要不要某一段都归后台那份文案管，这里只负责把 6 个变量填满。
 */
export function buildReactionRequest(
  cfg: ReactionModelConfig,
  input: {
    userText: string;
    botReply: string;
    /** 贴表情提示词（§28.10）：三层解析后的那一份，与主模型 system 里的段落同源 */
    guide: string;
    /** 素材模板（§34.3）：三层解析后的那一份，已 trim */
    template: string;
    /** 最近的历史行（已排成「作者：内容」，末尾是最新的）；缺省 = 素材里没有历史这一段 */
    history?: readonly string[];
    customEmojis?: CustomEmoji[];
    images?: LlmImage[];
    targets?: readonly ReactionTarget[];
  },
): LlmRequest {
  // 清单段与目标清单段各自自带标题，为空时展开成空串，交给 renderReactionMaterial 把空行收干净
  const content = renderReactionMaterial(input.template, {
    '最近对话': (input.history ?? []).join('\n'),
    '对方的消息': input.userText,
    '我的回复': input.botReply,
    '自定义表情': renderCatalog(input.customEmojis),
    '可贴表情的消息': targetsSection(input.targets),
    '表情规则': input.guide,
  });
  // 「不贴就回一行 NONE」只补在 system 这一侧：素材里的 {{表情规则}} 仍然只填 input.guide，
  // 否则同一句约定会在 system 与素材里各出现一遍
  const system = input.guide.trim() === '' ? NO_REACTION_NOTE : input.guide + '\n\n' + NO_REACTION_NOTE;
  const request: LlmRequest = {
    model: cfg.model,
    system,
    messages: [{ role: 'user', content }],
    // 每次都带：少一种「结构化/纯文本」的请求形状，兜底解析放在 normalizeReactions 里统一收
    responseFormat: REACTION_RESPONSE_FORMAT,
    reasoningEffort: REACTION_REASONING_EFFORT,
  };
  // 空数组与缺省一样：键都不出现，否则「有没有图」这件事会在下游多出一种形状
  if (input.images !== undefined && input.images.length > 0) request.images = input.images;
  return request;
}

/** 反复剥掉成对包裹的反引号与引号：剥掉一层再看下一层，``👍`` 也能还原成 👍 */
function unwrapQuotes(value: string): string {
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

/** 表情名本身也可能被包裹、后面还跟着解释（§21.3 规则 3–5）：取第一个 token，再剥一层壳 */
function headToken(raw: string): string {
  return unwrapQuotes(raw.split(WHITESPACE)[0] ?? '');
}

/**
 * 一个 token 像不像表情（§28.5 的「只有解释文字就不贴」靠它）：
 * unicode emoji、`:名字:`、`名字:id`、`<:名字:id>`，以及 Discord 真名那种纯 ASCII 裸名。
 * 纯 ASCII 之外的长句子一律丢掉：现在输出是多行的，一行解释会变成一条贴不上的表情，
 * 白让网关多打一次 REST 再加一条 warn。裸写的中文名也在这里丢掉（Discord 真名只能是 ASCII），
 * 想让那种名字生效，模型得按提示词写成 `:名字:`。
 */
function looksLikeReactionToken(token: string): boolean {
  if (token === '') return false;
  if (PICTOGRAPHIC.test(token)) return true;
  if (token.length > 2 && token.startsWith(':') && token.endsWith(':')) return true;
  if (ANGLE_NAME_ID.test(token)) return true;
  if (NAME_ID.test(token)) return true;
  return BARE_NAME.test(token);
}

/** 换掉请求里的表情名（token 规整之后），目标原样保留 */
function withEmoji(request: ReactionRequest, emoji: string): ReactionRequest {
  const out: ReactionRequest = { emoji };
  if (request.messageId !== undefined) out.messageId = request.messageId;
  else if (request.authorName !== undefined) out.authorName = request.authorName;
  // 「给大家贴」（§28.9）是目标而不是表情，换名字时不能把它丢掉：丢了就退化成「贴对方这一条」
  else if (request.broadcast === true) out.broadcast = true;
  return out;
}

/**
 * 一行模型输出 → 0..n 条贴表情请求（§28.5）：先按 `[[react:…]]` 提取（模型会照抄主提示词的写法，
 * 同行前后的说明文字一律不算），没有指令才把整行当成一个值。
 */
function lineReactions(line: string): ReactionRequest[] {
  const directive = splitReactDirectives(line);
  if (directive.reactions.length > 0) return directive.reactions.map((one) => withEmoji(one, headToken(one.emoji)));

  // 整行先剥壳再解析：只有先剥掉引号，`"😄@<ID>"` 的目标才切得对
  const parsed = parseReactionValue(unwrapQuotes(line));
  if (parsed === null) return [];
  const emoji = headToken(parsed.emoji);
  // 判不出是表情就丢掉：一行解释文字换不来一次贴表情（§28.5）
  if (!looksLikeReactionToken(emoji)) return [];
  return [withEmoji(parsed, emoji)];
}

/**
 * 结构化输出里可认的三种形状：`{"reaction":"…"}`、顶层字符串、对象里唯一的字符串值。
 * 显式 reaction 键优先，多出来的说明字段不该把整条答案顶成「形状不认识」；
 * 认不出就返回 null，让调用方走旧的逐行文本解析——那才是所有通道都保证得了的那条路。
 */
function jsonReactionValues(raw: string): string[] | null {
  let node: unknown;
  try {
    node = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof node === 'string') return [node];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  if (typeof record['reaction'] === 'string') return [record['reaction']];
  const values = Object.values(record).filter((value): value is string => typeof value === 'string');
  return values.length === 1 ? values : null;
}

/**
 * 模型整段输出 → 贴表情请求列表（§28.5）：逐行解析、忽略空行与 NONE、按 `表情|目标` 去重、上限 10。
 * 一条都认不出来就返回空数组（这轮不贴），绝不把解释文字当成表情交给下游。
 * 先整段试 JSON：结构化输出就是一行 JSON，按行切会把缩进切碎；
 * 失败再走文本——旧通道与旧提示词只保证纯文本，兜底放在 JSON 之后才不丢它们任何一个语义。
 */
export function normalizeReactions(raw: string): ReactionRequest[] {
  const picked: ReactionRequest[] = [];
  const keys = new Set<string>();
  for (const line of jsonReactionValues(raw) ?? raw.split('\n')) {
    for (const request of lineReactions(line)) {
      if (picked.length >= MAX_REACTIONS) return picked;
      // 先判 NONE 再收：模型常写「NONE 因为没有合适的表情」，那个 NONE 不能当成表情贴出去
      if (request.emoji === '' || NO_REACTION.has(request.emoji)) continue;
      const key = reactionKey(request);
      if (keys.has(key)) continue;
      keys.add(key);
      picked.push(request);
    }
  }
  return picked;
}

/**
 * 剥掉回复正文开头单独一行的 NONE：模型偶尔把上面那条「不贴表情」的约定当成正文写出来，
 * 用户就看到一条先 NONE、再说话的回复。
 * 只剥头部这一行：中间与结尾的 NONE 是正文内容，一个字都不动；剥完什么都不剩就原样返回，
 * 绝不把一条有内容的回复变成空串。
 */
export function stripNoReactionHead(text: string): string {
  const lines = text.split('\n');
  // 头部空行不算正文：先跳过，再看第一个非空行是不是那个约定
  let head = 0;
  while (head < lines.length && lines[head].trim() === '') head += 1;
  if (head === lines.length) return text;
  if (!NO_REACTION.has(lines[head].trim().toLowerCase())) return text;
  // 丢掉这一行以及它后面紧跟的空行，剩下的原样连回去（不 trim 正文、不合并中间的多个换行）
  let rest = head + 1;
  while (rest < lines.length && lines[rest].trim() === '') rest += 1;
  if (rest === lines.length) return text;
  return lines.slice(rest).join('\n');
}

/** 整段只剩「不贴」这一个记号：进度侧用它挡掉只含约定的中间帧，免得先建出一条写着 NONE 的消息 */
export function isOnlyNoReactionMark(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== '' && NO_REACTION.has(trimmed.toLowerCase());
}
