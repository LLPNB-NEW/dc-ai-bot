import type { ChatMessage, LlmRequest, ModelRef } from '../types';
import { withAuthorPrefix } from './line';
import { formatDayMinute, roughTimeLabel } from './stamp';

/** 摘要只读这几列：本轮这条还没落库，没有 id 也能进素材 */
export type SummaryLine = Pick<ChatMessage, 'role' | 'content' | 'author' | 'authorId' | 'createdAt' | 'replyTo'>;

/**
 * 记忆是累积的：模型每次只写「这一批新增的」，老段原样留在库里。
 * 再说「合并」会让模型重写已有记忆（改写就是丢信息），落库侧也不再接受重写；
 * 禁止项照旧，否则模型爱写「好的，以下是摘要：」，那句话会被当成记忆长期带进上下文。
 */
export const SUMMARY_SYSTEM_PROMPT = [
  '你是对话记忆记录员。',
  '输入包含【已有记忆】（可能为空）与【新增对话】。',
  '只记录【新增对话】里值得留到以后的事实：人物身份与称呼、偏好与禁忌、做过的约定、进行中的事、关键结论。',
  '不要复述或改写【已有记忆】——那份记忆会原样保留，你只写这一段新增的。',
  '直接输出正文：不要解释性开场白，不要写「好的」「以下是摘要」之类的话，不要标题，不要代码围栏。',
  '用第三人称陈述，把时间说清楚；该写多少写多少，不要为了省字数把事实压掉。',
].join('\n');

/** 默认注入预算：只有「注入 system」这一步按它裁剪，落库正文不设上限（频道级 summaryMaxChars 可改，§31.3） */
export const SUMMARY_MAX_CHARS = 4000;

/**
 * 单次送去总结的原文上限 = 自动总结的触发阈值 50 条：一次总结正好吃掉一批，谁也不跳过。
 * 游标之后攒得更多时（比如历史积压）只取最旧的一批，游标也只推进到这批的最后一条，下一轮接着总结。
 */
export const SUMMARY_MAX_INPUT_MESSAGES = 50;

// user 行可能来自迁移前的老数据（author 为 NULL）：给个稳定占位，空名字会让模型误以为没人说话
const ANONYMOUS_USER = '用户';
const ANONYMOUS_ASSISTANT = 'Bot';

/**
 * 每行 `[MM-DD HH:mm] <名字(ID)或名字>：<正文> ↳ 回复 …`；assistant 行名字取 author 或 'Bot'。
 * 行格式化直接用 ./line 的 withAuthorPrefix——提示词与摘要素材共用同一份实现，格式不可能分叉，
 * 所以回复链（replyTo）在这里也自然跟着进素材。
 */
export function formatTranscript(messages: SummaryLine[]): string {
  return messages
    .map((message) => {
      const author = (message.author ?? '').trim();
      const fallback = message.role === 'assistant' ? ANONYMOUS_ASSISTANT : ANONYMOUS_USER;
      // assistant 行本来不署名，把它当成带显示名的 user 行送进同一套逻辑，输出与旧版逐字一致
      return withAuthorPrefix({
        role: 'user',
        content: message.content,
        author: author === '' ? fallback : author,
        authorId: message.authorId,
        createdAt: message.createdAt,
        // assistant 行永远不带 replyTo（§18.3），老数据即便有键也不往素材里写
        replyTo: message.role === 'user' ? message.replyTo : undefined,
      }).content;
    })
    .join('\n');
}

/** 已有记忆与新增对话拼成一条 user 消息：system 放指令，素材放对话侧，模型才不会把指令当资料复述 */
export function buildSummaryRequest(route: ModelRef, previous: string, transcript: string): LlmRequest {
  const sections: string[] = [];
  const prev = previous.trim();
  if (prev !== '') sections.push('【已有记忆】\n' + prev);
  sections.push('【新增对话】\n' + transcript);
  return {
    model: route.model,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: sections.join('\n\n') }],
  };
}

// 模型常无视「不要围栏」：不剥掉的话围栏会作为摘要正文长期待在 system prompt 里
const FENCE_PATTERN = /^```[^\n]*\n([\s\S]*?)\n?```$/;

/** trim、剥 ``` 围栏；写侧不按长度截断（写多长就存多长）。结果可能为空串，由调用方判定 SUMMARY_EMPTY */
export function normalizeSummary(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(FENCE_PATTERN);
  if (fenced) text = (fenced[1] ?? '').trim();
  return text;
}

/**
 * 段头时间段：`（覆盖 10-25 22:40 ~ 10-26 14:30，最后一句约在 10-26 下午两点半）`。
 * 用户要的是「这些话是什么时候说的」，所以取被总结消息的落库时刻，跟摘要生成的时刻无关；两头都不知道就整段不出现。
 */
function coveredMoment(coveredFrom: string | undefined, coveredTo: string | undefined): string {
  const from = formatDayMinute(coveredFrom);
  const to = formatDayMinute(coveredTo);
  if (from === '' && to === '') return '';
  const rough = to === '' ? '' : roughTimeLabel(coveredTo);
  const tail = rough === '' ? '' : '，最后一句约在 ' + to.slice(0, 5) + ' ' + rough;
  if (from === '' || to === '' || from === to) return '（覆盖到 ' + (to !== '' ? to : from) + tail + '）';
  return '（覆盖 ' + from + ' ~ ' + to + tail + '）';
}

/** 段标记：每段以它开头，切段、按时间挑段都只认这一行 */
const MEMORY_SEGMENT_HEADING = '【记忆段】';

/** 段头 = 段标记 + 覆盖时间段（这一批的落库时刻，可能为空） */
export function segmentHeading(coveredFrom?: string, coveredTo?: string): string {
  return MEMORY_SEGMENT_HEADING + coveredMoment(coveredFrom, coveredTo);
}

/**
 * 只增不减：新段接在已有记忆尾部，老段一个字符都不动。
 * 改写老段就是丢信息，而且改过的文本没法再跟记录对账，所以这里只做拼接。
 */
export function appendSegment(previous: string, segment: string, coveredFrom?: string, coveredTo?: string): string {
  const head = segmentHeading(coveredFrom, coveredTo);
  const kept = previous.trimEnd();
  if (kept === '') return head + '\n' + segment;
  return kept + '\n\n' + head + '\n' + segment;
}

/**
 * 按段头切段，段头行归属它自己那一段。
 * 没有段头的文本（老摘要、手改正文）整块算一段：下次追加时它原样待在最前，不会被切开或改写。
 */
export function splitSegments(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const segments: string[] = [];
  let current: string[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.startsWith(MEMORY_SEGMENT_HEADING)) {
      if (current.length > 0) segments.push(current.join('\n').trim());
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) segments.push(current.join('\n').trim());
  return segments;
}

/** 单段超预算：段头整行必须留着（没有段头就不知道这段话是什么时候说的），正文截断并以省略号收尾 */
function clipSegment(segment: string, budgetChars: number): string {
  const breakAt = segment.indexOf('\n');
  const head = breakAt < 0 ? segment : segment.slice(0, breakAt);
  const body = breakAt < 0 ? '' : segment.slice(breakAt + 1).trim();
  // 段头行 + 换行 已占 length + 1，再留一个字给省略号
  const room = budgetChars - head.length - 2;
  return head + '\n' + (room > 0 ? body.slice(0, room).trimEnd() + '…' : '…');
}

/**
 * 按字数预算从新到旧装满：越近的记忆越可能被用到，装到装不下为止，更老的段整段不进上下文。
 * 最新一段自己就超预算时只截它——老段都放下了，再把它整段丢掉等于这一轮完全没有记忆。
 */
export function selectSegments(text: string, budgetChars: number): string {
  const segments = splitSegments(text);
  const picked: string[] = [];
  let used = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? '';
    // 段与段之间用空行隔开，这个开销算在后拼上来的那一段头上
    const cost = picked.length === 0 ? segment.length : segment.length + 2;
    if (used + cost > budgetChars) {
      if (picked.length === 0) picked.unshift(clipSegment(segment, budgetChars));
      break;
    }
    picked.unshift(segment);
    used += cost;
  }
  return picked.join('\n\n');
}

/**
 * 长期记忆的标签：模型靠它认出这一段是回忆，不把它当成这一轮的指令。
 * 标签只加在拼出来的文本上，库里的摘要正文一个字不动。
 */
export const SUMMARY_TAG_OPEN = '<recall>';
export const SUMMARY_TAG_CLOSE = '</recall>';

/**
 * 摘要在 system prompt 里独占一段；时间段由每段自己的段头写，外层不再拼——累了很多段时外层只剩一个时间是假的。
 * 空摘要返回空串，调用方可以直接拼在末尾。
 */
export function renderSummaryBlock(summary: string, budgetChars: number = SUMMARY_MAX_CHARS): string {
  const text = selectSegments(summary, budgetChars);
  if (text === '') return '';
  return '\n\n' + SUMMARY_TAG_OPEN + '\n【长期记忆摘要】\n' + text + '\n' + SUMMARY_TAG_CLOSE;
}
