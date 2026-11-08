import type { ReactionRequest, ReactionTarget, ReplyRef } from '../types';

/** 一条消息最多贴几个表情（§28.1）：上限从 2 提到 10，多贴不会更好看，只会刷屏 */
export const MAX_REACTIONS = 10;

/**
 * 模型点名「给大家贴」的几种写法（§28.9）：比较前 trim + 转小写，所以这里只放小写成员。
 * 中文与 `*` 都得认——模型写 `😄@大家` 与我们教它写的 `😄@all` 是同一件事。
 */
export const BROADCAST_TARGETS: ReadonlySet<string> = new Set(['all', 'everyone', '*', '大家', '所有人', '全员']);

/** 引用原文进提示词时保留的长度（UTF-16 code unit，与项目其它截断口径一致） */
export const REPLY_EXCERPT_CHARS = 40;

/** 表情指令前缀：模型在正文里写 `[[react:👍]]`，core 剥掉后交给执行侧去贴 */
export const REACT_DIRECTIVE_PREFIX = '[[react:';

/** `[[react:` + 1..64 个非 `]`、非换行字符 + `]]`；可同行、可独占一行、可多次出现 */
const DIRECTIVE_PATTERN = /\[\[react:([^\]\n]{1,64})\]\]/g;

/** 回复后缀的固定文案：箭头两侧都要空格，否则会和正文粘成一句 */
const REPLY_MARK = ' ↳ 回复 ';

/** 名字与 id 都缺时的写法：§18.3 退化表是「回复一条更早的消息」，这里不留那个分隔空格 */
const REPLY_MARK_UNKNOWN = ' ↳ 回复';

/** 引用原文两侧的引号：全角，与中文正文的标点风格一致 */
const QUOTE_OPEN = '：「';
const QUOTE_CLOSE = '」';

/** 回复目标的名字与 id 都缺失时的退化文案 */
const UNKNOWN_REPLY_TARGET = '一条更早的消息';

/** 非可选字段也走它：网关偶尔会给出 undefined，宁可当成空串也不能把整轮回复炸掉 */
const trimmed = (value: string | undefined): string => (value ?? '').trim();

/** 指令里一条值的长度上限（§28.3）：超过它的一定不是模型挑的表情，而是在解释 */
const MAX_REACTION_VALUE_CHARS = 64;

/** Discord 消息 ID 的位数区间（§28.3）：右侧全是数字且落在这个区间才算 ID */
const MESSAGE_ID_MIN_CHARS = 15;
const MESSAGE_ID_MAX_CHARS = 20;

/** 作者名的长度上限（§28.3）：1..32，超长整条丢弃 */
const AUTHOR_NAME_MAX_CHARS = 32;

const DIGITS_ONLY = /^[0-9]+$/;

/** 右侧是不是一个 Discord 消息 ID（§28.3）：全是数字，长度 15..20 */
function isMessageId(value: string): boolean {
  return (
    value.length >= MESSAGE_ID_MIN_CHARS && value.length <= MESSAGE_ID_MAX_CHARS && DIGITS_ONLY.test(value)
  );
}

/** 左侧 trim 后为空就没有表情可贴；否则这就是一条只带表情的请求 */
function emojiOnly(raw: string): ReactionRequest | null {
  const emoji = raw.trim();
  return emoji === '' ? null : { emoji };
}

/**
 * 一条 `[[react:…]]` 里的值 → 一条贴表情请求（§28.3 解析规则，逐条照做）：
 * `😄` 只有表情（贴触发这一轮的那条）、`😄@<消息ID>` 指定消息、`😄@<作者名>` 指定该作者最近一条。
 * 取**最后**一个 `@` 切分（口径逐字来自 §28.3）；判不出来返回 null——丢一条不能影响已经生成好的正文。
 */
export function parseReactionValue(raw: string): ReactionRequest | null {
  const value = raw.trim();
  if (value === '' || value.length > MAX_REACTION_VALUE_CHARS) return null;

  const at = value.lastIndexOf('@');
  // 没有 @ → 只有表情，目标是触发这一轮的那条
  if (at === -1) return emojiOnly(value);

  const request = emojiOnly(value.slice(0, at));
  // 左侧空：没有表情可贴，整条丢弃
  if (request === null) return null;

  const target = value.slice(at + 1).trim();
  // `😄@` 右侧空着：等于没写目标（§28.3 不把它列为丢弃），别因为多一个 @ 白丢一个表情
  if (target === '') return request;
  // 「给大家贴」（§28.9）先于消息 ID 判断：@all 既不是 ID 也不是人名，落到下面只会变成作者名
  if (BROADCAST_TARGETS.has(target.toLowerCase())) return { emoji: request.emoji, broadcast: true };
  if (isMessageId(target)) return { emoji: request.emoji, messageId: target };
  // 非空又不是合法 ID → 作者名；超过 32 个字不可能是个名字，整条丢弃
  if (target.length > AUTHOR_NAME_MAX_CHARS) return null;
  return { emoji: request.emoji, authorName: target };
}

/**
 * 去重键（§28.3）：同一个表情贴到不同目标是两件事，所以目标也进键。
 * 网关合并、表情模型解析、指令解析三处必须是同一个键，否则同一个表情会被贴两遍。
 */
export function reactionKey(request: ReactionRequest): string {
  // 「给大家贴」与「贴某一条」是两件事：广播项独占一个键，别和「没写目标」撞在一起
  if (request.broadcast === true) return request.emoji + '|all';
  return request.emoji + '|' + (request.messageId ?? request.authorName ?? '');
}

/**
 * 收下一条贴表情请求：解不出来的只剥不产出，同键的按先来后到丢弃，
 * 超过 MAX_REACTIONS 的按出现顺序丢弃（不报错——表情贴不上不能影响已经生成好的回复）。
 */
function collectReaction(target: ReactionRequest[], keys: Set<string>, raw: string): void {
  const request = parseReactionValue(raw);
  if (request === null) return;
  if (target.length >= MAX_REACTIONS) return;
  const key = reactionKey(request);
  if (keys.has(key)) return;
  keys.add(key);
  target.push(request);
}

/**
 * 剥掉所有 `[[react: X]]` 指令：返回干净正文与去重保序的贴表情请求，最多 MAX_REACTIONS 个。
 * 独占一行的指令整行删掉（正文里不留空行），行尾空白剥掉，连续空行压成一个换行，整体 trim。
 */
export function splitReactDirectives(raw: string): { text: string; reactions: ReactionRequest[] } {
  const reactions: ReactionRequest[] = [];
  const keys = new Set<string>();
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    let stripped = false;
    const text = line
      .replace(DIRECTIVE_PATTERN, (_match: string, inner: string): string => {
        collectReaction(reactions, keys, inner);
        stripped = true;
        return '';
      })
      .replace(/[ \t\r]+$/, '');
    // 整行只有指令：剥完就空，把这一行彻底删掉，正文里不该留下一行空行
    if (stripped && text === '') continue;
    // 连续空行压成一个换行
    if (text === '' && lines.length > 0 && lines[lines.length - 1] === '') continue;
    lines.push(text);
  }
  return { text: lines.join('\n').trim(), reactions };
}

/** 第一个没有配对 `]]` 的 `[[` 的下标；没有未闭合的指令返回 -1 */
function unclosedDirectiveIndex(raw: string): number {
  let index = raw.indexOf('[[', 0);
  while (index !== -1) {
    if (raw.indexOf(']]', index + 2) === -1) return index;
    index = raw.indexOf('[[', index + 2);
  }
  return -1;
}

/**
 * 流式用：截到第一个未闭合的 '[[' 之前，避免半截指令刷进 Discord；已闭合的指令同样剥掉，
 * 进度文本里永远看不到 `[[react:` 语法。返回前 trim。
 */
export function visibleText(raw: string): string {
  const cut = unclosedDirectiveIndex(raw);
  return splitReactDirectives(cut === -1 ? raw : raw.slice(0, cut)).text;
}

/** 引用原文：连续空白（含换行）压成单个空格、trim，超过 REPLY_EXCERPT_CHARS 个 code unit 补 … */
function excerptOf(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  return text.length > REPLY_EXCERPT_CHARS ? text.slice(0, REPLY_EXCERPT_CHARS) + '…' : text;
}

/**
 * 记忆行里「这条消息回复了谁」的后缀（§18.3 的唯一实现，提示词与摘要素材共用）：
 * ` ↳ 回复 <名字>(<id>)：「<原文前 40 字>」`。名字与 id 按退化表取其一，
 * 两者都没有时写「一条更早的消息」；原文空白则整段省略引文。
 */
export function replySuffix(replyTo: ReplyRef | undefined): string {
  if (replyTo === undefined) return '';
  const author = trimmed(replyTo.author);
  const id = trimmed(replyTo.authorId);
  const excerpt = excerptOf(trimmed(replyTo.content));
  const quote = excerpt === '' ? '' : QUOTE_OPEN + excerpt + QUOTE_CLOSE;
  if (author === '' && id === '') return REPLY_MARK_UNKNOWN + UNKNOWN_REPLY_TARGET + quote;
  const label = id === '' ? author : author === '' ? id : author + '(' + id + ')';
  return REPLY_MARK + label + quote;
}
/**
 * 「最近说过话的人」分配器（§28.9）：spreadReactions 与 expandBroadcast 共用这一份，
 * 不许各写一套——分散规则一改，两条路径必须同时改。
 */
interface RecentAllocator {
  /** 池子里的名额数：一人一条，机器人跳过，触发那条兜底补在最后 */
  readonly size: number;
  /** 这条是否已被占用（模型点名的目标也占位） */
  isUsed(messageId: string): boolean;
  markUsed(messageId: string): void;
  /** 取下一个还没被占用的、最近说过话的人的某条消息；一圈都占满了才有人多收一个 */
  take(): string;
}

function createRecentAllocator(targets: readonly ReactionTarget[], triggerId: string): RecentAllocator {
  // 最近说过话的人：清单新的在前，一人只留最新那条，跳过机器人自己发的
  const recent: string[] = [];
  const authors = new Set<string>();
  for (const target of targets) {
    const messageId = target.messageId.trim();
    if (messageId === '' || target.bot === true) continue;
    const authorKey = target.authorId.trim() === '' ? 'name:' + target.author.trim().toLowerCase() : target.authorId.trim();
    if (authors.has(authorKey)) continue;
    authors.add(authorKey);
    recent.push(messageId);
  }
  // 清单里没有触发那条时兜底补上：它至少总是可以贴
  if (!recent.includes(triggerId)) recent.push(triggerId);

  const used = new Set<string>();
  let cursor = 0;
  return {
    size: recent.length,
    isUsed: (messageId: string): boolean => used.has(messageId),
    markUsed: (messageId: string): void => {
      used.add(messageId);
    },
    take: (): string => {
      for (let step = 0; step < recent.length; step += 1) {
        const index = (cursor + step) % recent.length;
        const candidate = recent[index];
        if (!used.has(candidate)) {
          used.add(candidate);
          cursor = (index + 1) % recent.length;
          return candidate;
        }
      }
      const fallback = recent[cursor % recent.length];
      cursor = (cursor + 1) % recent.length;
      return fallback;
    },
  };
}

/**
 * 按「最近说过话的人」分散表情（§28.9）。
 *
 * 表情模型常常只给一串表情、一个 @ 都不写，于是它们全落到触发那条上——「给大家都贴一个」
 * 就变成了「只贴给 @ 她的那个人」。现在不管模型写没写目标，最终都按**聊天记录里谁最近说过话**
 * 来分配：一个人先占一条，占满了才轮到第二圈，所以几个人就是几条表情分别落在几个人身上。
 *
 * 次序：清单本来就是「新的在前」，按作者去重后就是最近发言者的次序；机器人（含我们自己）
 * 发的消息不进池子。模型点了名的目标先占位，同一条消息被点第二次就往下顺延。
 * 一个候选都没有时行为与旧版一致（贴触发那条）。
 */
export function spreadReactions(
  reactions: readonly ReactionRequest[],
  targets: readonly ReactionTarget[],
  triggerId: string,
): ReactionRequest[] {
  const out: ReactionRequest[] = reactions.map((one) => ({ ...one }));
  // 只有一个表情：它属于这轮回复的那条，分散反而莫名其妙（§28.5 只挑一个才允许不写 @）
  if (out.length <= 1) return out;

  /** 按作者名找清单里最新那条：与 §28.7 的兜底规则同一条 */
  const latestOf = (name: string): string | undefined => {
    const wanted = name.trim().toLowerCase();
    if (wanted === '') return undefined;
    return targets.find((target) => target.author.trim().toLowerCase() === wanted)?.messageId;
  };

  const recent = createRecentAllocator(targets, triggerId);

  for (const one of out) {
    const explicit = one.messageId?.trim()
      ? one.messageId.trim()
      : one.authorName === undefined
        ? undefined
        : latestOf(one.authorName);
    if (explicit === undefined) {
      // 作者名在清单里找不到：原样留着，交给 §28.7 跳过并 warn（别悄悄贴到别人身上）
      if (one.authorName !== undefined) continue;
      one.messageId = recent.take();
      continue;
    }
    if (recent.isUsed(explicit)) {
      // 与前面那几条撞了同一条消息：改贴下一位最近说过话的人
      one.messageId = recent.take();
      delete one.authorName;
      continue;
    }
    one.messageId = explicit;
    delete one.authorName;
    recent.markUsed(explicit);
  }
  return out;
}

/** 收一条：同键丢弃、超过上限丢弃（一条广播能展开成十几条，必须在这里封顶） */
function pushReaction(out: ReactionRequest[], keys: Set<string>, request: ReactionRequest): void {
  if (out.length >= MAX_REACTIONS) return;
  const key = reactionKey(request);
  if (keys.has(key)) return;
  keys.add(key);
  out.push(request);
}

/**
 * 把模型点名的「给大家贴」展开成每个人一条（§28.9）。
 *
 * 只有 broadcast 项才分散：没写 `@all` 的表情一条都不分配，留在它自己的目标上——旧的
 * 「不管模型写没写目标都按最近发言者排」已经撤掉，模型没点名就不该有人替它贴到别人身上。
 * 每个广播项按「最近说过话的人」一圈一圈发：一人一条，一圈占满才轮到第二圈；
 * 池子为空时兜底触发那条。展开后按 reactionKey 去重、总数不超过 MAX_REACTIONS。
 */
export function expandBroadcast(
  reactions: readonly ReactionRequest[],
  targets: readonly ReactionTarget[],
  triggerId: string,
): ReactionRequest[] {
  const out: ReactionRequest[] = [];
  const keys = new Set<string>();
  const recent = createRecentAllocator(targets, triggerId);
  for (const one of reactions) {
    if (one.broadcast !== true) {
      // 非广播项原样留着：这一版的核心变更就是「没点名就不分配」
      pushReaction(out, keys, { ...one });
      continue;
    }
    for (let index = 0; index < recent.size; index += 1) {
      if (out.length >= MAX_REACTIONS) break;
      const messageId = recent.take();
      // 池子里只有空串（既没候选也没触发 ID）：贴不上去，宁可少贴一条
      if (messageId.trim() === '') continue;
      pushReaction(out, keys, { emoji: one.emoji, messageId });
    }
  }
  return out;
}
