/** 与编辑器同一个截断后缀：模型正文里可能留着它，念出来就是噪音 */
const TRUNCATION_SUFFIX = '…(已截断)';

/**
 * 把聊天正文变成「适合念」的一句话：
 * 提及、markdown 记号、换行都不该被读出来，结尾的截断后缀也要摘掉。
 * 这里不按字数截断：念多长由上游接口自己的上限决定，清理之外一个字都不动。
 */
export function toSpeechText(raw: string): string {
  let text = raw
    .replace(/<@!?\d+>/gu, '')
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.endsWith(TRUNCATION_SUFFIX)) text = text.slice(0, -TRUNCATION_SUFFIX.length).trim();
  return text;
}
