/**
 * 回复开头的 @ 提问者：只在服务器频道里点名（私聊点自己没有意义），
 * 而且前缀必须算进 Discord 的内容长度上限 —— 先按剩余预算截正文再拼前缀，
 * 拼完再砍有可能把 <@id> 砍成半个标签。
 */

/** 话题前缀：`<@id> `；空 id 返回空串（没拿到提问者就不发一个空标签） */
export function mentionPrefix(userId: string): string {
  return userId === '' ? '' : '<@' + userId + '> ';
}

/**
 * 把前缀拼在正文前：没有前缀时正文原样返回；
 * 有前缀时正文按 maxChars - prefix.length 截断，整条 content 因此仍然 <= maxChars。
 */
export function withMention(content: string, prefix: string, maxChars: number): string {
  if (prefix === '') return content;
  const budget = maxChars - prefix.length;
  return prefix + (budget > 0 ? content.slice(0, budget) : '');
}
