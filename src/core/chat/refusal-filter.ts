/**
 * 历史里的「拒答」会把下一轮继续拽向拒答：模型看到自己上次是怎么拒的，
 * 就照着同一套说法再拒一遍（§61）。装配历史时把它们滤掉，正文照旧全量入库。
 */

const REFUSAL_MAX_CHARS = 600;

const ACTION = /(无法|不能|不会|拒绝|忽略|cannot|can't|unable|refuse)/i;

const POLICY = /(安全|准则|政策|规范|露骨|色情|NSFW|性描写|绕过|越狱|policy|guideline|safety|explicit|sexual)/i;

export function looksLikeRefusal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > REFUSAL_MAX_CHARS) return false;
  return ACTION.test(trimmed) && POLICY.test(trimmed);
}

export function dropRefusalHistory<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
  return messages.filter((message) => message.role !== 'assistant' || !looksLikeRefusal(message.content));
}
