/**
 * 正文里的自定义表情渲染（§18.8）：模型在回复里写 :名字:，Discord 只把它当纯文字显示。
 * 发消息前把命中该服清单的名字换成 <:名字:id>（animated 用 <a:名字:id>），正文里才是真表情。
 *
 * 不放进 core：尖括号标记是 Discord 的线缆格式，core 只管内容不管平台语法。
 */
import type { CustomEmoji } from '../../core/types';

/**
 * 一次扫两种形态：已经成型的 <:名字:id> / <a:名字:id> 整个匹配到（第 1 组 undefined，原样返回），
 * 剩下的 :名字: 才交给清单查表。否则会把 <:blob:123> 里的 :blob: 再替换一次，拼出坏标记。
 *
 * :名字: 分支用 [^\s:<>] 而不是 [A-Za-z0-9_~]：管理员配的别名是中文（奶龙）就匹配不到了（§24.5）。
 * 尖括号分支保持窄字符集：那是 Discord 的线缆格式，只可能是真实表情名。
 */
const EMOJI_TOKEN = /<a?:[A-Za-z0-9_~]{2,32}:\d+>|:([^\s:<>]{2,32}):/g;

/** 别名表：小写别名 → 表情；真名（含大小写不敏感的同名）一律不进来，保证「真名优先」 */
function aliasIndex(catalog: readonly CustomEmoji[], byName: Map<string, CustomEmoji>): Map<string, CustomEmoji> {
  const names = new Set<string>();
  for (const name of byName.keys()) names.add(name.toLowerCase());
  const byAlias = new Map<string, CustomEmoji>();
  for (const emoji of catalog) {
    for (const raw of emoji.aliases ?? []) {
      const alias = raw.trim().toLowerCase();
      if (alias === '' || names.has(alias) || byAlias.has(alias)) continue;
      byAlias.set(alias, emoji);
    }
  }
  return byAlias;
}

/** 命中清单才替换；查不到的名字原样保留（模型偶尔凭印象造名字，不许凭空发明表情） */
export function resolveInlineEmojis(text: string, catalog: readonly CustomEmoji[]): string {
  if (text === '' || catalog.length === 0) return text;
  const byName = new Map<string, CustomEmoji>();
  for (const emoji of catalog) {
    const name = emoji.name.trim();
    if (name === '' || byName.has(name)) continue;
    byName.set(name, emoji);
  }
  if (byName.size === 0) return text;
  const byAlias = aliasIndex(catalog, byName);
  return text.replace(EMOJI_TOKEN, (match: string, name?: string): string => {
    if (name === undefined) return match;
    // 真名优先 → 别名：两者都按原样查询，别名表本身是小写的（§24.5）
    const hit = byName.get(name) ?? byAlias.get(name.toLowerCase());
    if (hit === undefined) return match;
    // 永远用真实表情名拼标记：Discord 只认真名，别名只是我们自己叫它的方式
    return (hit.animated === true ? '<a:' : '<:') + hit.name.trim() + ':' + hit.id + '>';
  });
}

/**
 * 模型给的表情值 → Reaction API 认的形态（§18.6）：unicode 原样用；清单里的名字（不带冒号、
 * 带冒号、不分大小写都认）换成 name:id；已经写成 name:id / <:名字:id> 的规范化成 name:id；
 * 其余（不在清单里的英文名）返回 null——贴上去 Discord 只会回 400 Unknown Emoji。
 *
 * §24.5：真名一个都命中不了才轮到别名，返回的同样是真实表情名（Discord 不认别名叫法）。
 */
export function resolveReactionEmoji(raw: string, catalog: readonly CustomEmoji[]): string | null {
  const value = raw.trim();
  if (value === '') return null;

  // 已经成型的尖括号标记：Reaction API 要 name:id，不能带尖括号
  const angle = /^<a?:([A-Za-z0-9_~]{2,32}):(\d+)>$/.exec(value);
  if (angle !== null) return angle[1] + ':' + angle[2];
  // 已经是 name:id 形态，直接可用
  if (/^[A-Za-z0-9_~]{2,32}:\d+$/.test(value)) return value;

  const name = value.startsWith(':') && value.endsWith(':') && value.length > 2 ? value.slice(1, -1) : value;
  if (name === '') return null;

  const lower = name.toLowerCase();
  // 整张表先按真名扫完，别名才可能命中：真名说了算，否则同名表情会被别名抢走（§24.5）
  for (const emoji of catalog) {
    // 模型常把大小写写错（清单里是 OMG，它写 omg），Discord 的表情名本身不区分大小写
    if (emoji.name.toLowerCase() === lower) return emoji.name + ':' + emoji.id;
  }
  for (const emoji of catalog) {
    for (const alias of emoji.aliases ?? []) {
      if (alias.trim().toLowerCase() === lower) return emoji.name + ':' + emoji.id;
    }
  }
  // 非清单的 unicode 表情（👍、🎉、❤️）原样贴；普通英文词贴上去必 400，宁可跳过
  if (/\p{Extended_Pictographic}/u.test(name)) return name;
  return null;
}
