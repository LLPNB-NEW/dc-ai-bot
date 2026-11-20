/** 模型在正文里写这一行表示「这条回复请念出来」；它不是给人看的内容，落库与流式推送前都要剥掉 */
export const VOICE_DIRECTIVE = '[[voice]]';

/**
 * 摘掉所有 [[voice]]，wanted 记下它到底出现过没有。
 * 独占一行的指令被摘掉后会留下一个空行：那一段连同它带来的多余空行一起去掉，
 * 否则语音文本与聊天正文都会多出无意义的空白行（行内出现时只摘标记、不动前后文）。
 */
export function stripVoiceDirective(raw: string): { text: string; wanted: boolean } {
  if (!raw.includes(VOICE_DIRECTIVE)) return { text: raw, wanted: false };

  const kept = raw.split('\n').filter((line) => line.trim() !== VOICE_DIRECTIVE);
  const text = kept
    .join('\n')
    .split(VOICE_DIRECTIVE)
    .join('')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+/u, '')
    .replace(/\n+$/u, '');
  return { text, wanted: true };
}
