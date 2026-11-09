/** 与编辑器同一个截断后缀：模型正文里可能留着它，念出来就是噪音 */
const TRUNCATION_SUFFIX = '…(已截断)';

/**
 * 成对的中文引号：正文里出现任意一对，就认为这一轮真的有「说出来的话」。
 * 直角引号与双直角引号在中文里都是台词，一起认；英文直引号不认（聊天里常用来包术语和代码）。
 */
const QUOTE_PATTERN = /“([^”]*)”|「([^」]*)」|『([^』]*)』/gu;

/**
 * 把聊天正文变成「适合念」的一句话：
 * 提及、markdown 记号、换行都不该被读出来，结尾的截断后缀也要摘掉。
 * 正文里有台词引号时只念引号里的句子（按出现顺序拼起来），引号外的叙述与动作都跳过；
 * 一对引号都没有就整段照念——她忘写引号时不该变成哑巴。
 * 这里不按字数截断：念多长由上游接口自己的上限决定，清理之外一个字都不动。
 */
export function toSpeechText(raw: string): string {
  let text = raw
    .replace(/<@!?\d+>/gu, '')
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.endsWith(TRUNCATION_SUFFIX)) text = text.slice(0, -TRUNCATION_SUFFIX.length).trim();

  const quoted: string[] = [];
  for (const match of text.matchAll(QUOTE_PATTERN)) {
    const inner = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (inner !== '') quoted.push(inner);
  }
  return quoted.length === 0 ? text : quoted.join(' ');
}
