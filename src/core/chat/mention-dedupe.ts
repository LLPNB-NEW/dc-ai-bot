import type { ChatMessage } from '../types';

/**
 * 一轮回复里同一个人只能被 @ 一次：重复的 <@id> 换成聊天记录里的显示名。
 * Discord 的提及标签有两种写法（<@id> 与昵称形态 <@!id>），指向同一个人，必须算同一次；
 * id 只认 15~20 位数字的 snowflake —— 正文里凑巧长得像标签的短数字不是提及，不许动。
 */
export const MENTION_TAG_RE = /<@!?(\d{15,20})>/g;

/** 删掉标签后这两侧不留空格：中文标点前面带空格难看，「甲 ，」这种排版事故一眼就能看见 */
const NO_SPACE_BEFORE = new Set([...'，。、；：！？）》」』】…—,.!?;:%)]}']);
/** 开括号同理：「（ 他」比「（他」难看得多 */
const NO_SPACE_AFTER = new Set([...'（《「『【([{']);
/** 全角与中日韩字符：中文正文里本来不写空格，删掉标签时两边直接贴上 */
const WIDE_CHAR = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;
/** 只吃空格、制表符与全角空格：换行是消息的排版结构，吃掉会把两行粘成一行 */
const BLANK = /[ \t\u3000]/;

/**
 * 聊天记录里出现过的「id → 显示名」：后出现的覆盖先出现的（同一个人会改昵称，最近那个才是现在的）。
 * 只收 role=user 且名字与 id 都非空的行：assistant 行的 author 是我们自己，@ 它没有对象。
 */
export function buildMentionNames(messages: readonly ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const id = (message.authorId ?? '').trim();
    const name = (message.author ?? '').trim();
    if (id === '' || name === '') continue;
    names.set(id, name);
  }
  return names;
}

/** 末尾连续空格的数量：删标签时这些空格跟着标签一起去掉 */
function trailingBlanks(text: string): number {
  let count = 0;
  while (count < text.length && BLANK.test(text.charAt(text.length - 1 - count))) count += 1;
  return count;
}

/** 从 from 开始连续的空白数量 */
function leadingBlanks(text: string, from: number): number {
  let count = 0;
  while (from + count < text.length && BLANK.test(text.charAt(from + count))) count += 1;
  return count;
}

/** 标签删掉之后两截之间留几个空格：中文与标点两侧不留，纯 ASCII 两侧留一个免得粘成一个词 */
function joinSpace(leftChar: string, rightChar: string): string {
  if (leftChar === '' || rightChar === '') return '';
  if (NO_SPACE_BEFORE.has(rightChar) || NO_SPACE_AFTER.has(leftChar)) return '';
  if (WIDE_CHAR.test(leftChar) || WIDE_CHAR.test(rightChar)) return '';
  return ' ';
}

/** 逐条扫描、按出现顺序判定；单独拎出来只是为了把 try 收在外面 */
function dedupeCore(text: string, alreadyPinged: readonly string[], names: ReadonlyMap<string, string>): string {
  const pinged = new Set<string>();
  for (const id of alreadyPinged) {
    const trimmed = id.trim();
    if (trimmed !== '') pinged.add(trimmed);
  }
  // 每次都用一份新的正则：模块级那个带 g，lastIndex 会跨调用残留，第二次就少算一段
  const pattern = new RegExp(MENTION_TAG_RE.source, 'g');
  let out = '';
  let cursor = 0;
  let changed = false;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const id = match[1] ?? '';
    if (!pinged.has(id)) {
      pinged.add(id);
      out += text.slice(cursor, end);
      cursor = end;
    } else {
      changed = true;
      out += text.slice(cursor, start);
      const name = (names.get(id) ?? '').trim();
      if (name !== '') {
        out += name;
        cursor = end;
      } else {
        // 没名字就整段去掉：连它两侧的空格一起收掉，否则会留下「甲  乙」这种双空格
        const dropLeft = trailingBlanks(out);
        const dropRight = leadingBlanks(text, end);
        const leftChar = dropLeft === out.length ? '' : out.charAt(out.length - dropLeft - 1);
        const next = end + dropRight;
        const rightChar = next < text.length ? text.charAt(next) : '';
        out = out.slice(0, out.length - dropLeft) + joinSpace(leftChar, rightChar);
        cursor = next;
      }
    }
    match = pattern.exec(text);
  }
  return changed ? out + text.slice(cursor) : text;
}

/**
 * 同一段文本里同一个人只留第一次 @：第二次起换成显示名，查不到名字就把标签整段删掉。
 * 纯函数，结果只由文本与 options 决定 —— 进度侧每条 chunk 都拿全量累积文本再算一次。
 * 任何异常都不许冒出去：这一层只负责少 @ 一次，绝不能因此毁掉一整轮回复。
 */
export function dedupeMentions(
  text: string,
  options: { alreadyPinged: readonly string[]; names: ReadonlyMap<string, string> },
): string {
  try {
    return dedupeCore(text, options.alreadyPinged, options.names);
  } catch {
    return text;
  }
}

/**
 * system 里的提及规则块：代码那一层只兜底重复的 <@id>，怎么写要靠这条规则教。
 * 模型不知道之后要改口写昵称，就会一路把 @ 当称呼用。
 */
export function renderMentionRule(): string {
  return (
    '\n\n【提及】一轮回复里同一个人最多 @ 一次：第一次直接写 <@用户ID>；之后提到这个人，' +
    '一律直接写昵称或绰号，不要再写 <@ID>。系统已经在开头 @ 过提问的人，正文里再提到他/她就不要重复 @。' +
    '@everyone 与 @角色 一律不许写。'
  );
}
