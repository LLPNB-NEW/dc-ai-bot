/**
 * 记忆行的时刻前缀：`[MM-DD HH:mm]`。固定按北京时间（UTC+8）渲染——workerd 跑在 UTC，
 * 直接用本地时区会让模型看到的时刻比说话人慢 8 小时；先把毫秒整体平移，再取 getUTC*，
 * 结果与运行环境时区无关（以后迁到 AWS 机器上也不会变）。
 */
export const STAMP_OFFSET_MINUTES = 480;

const pad = (value: number): string => String(value).padStart(2, '0');

interface BeijingClock {
  month: string;
  day: string;
  hour: string;
  minute: string;
  hour24: number;
  minuteValue: number;
}

/** 解析不了的时间一律当「没有时间」：宁可少一个前缀，也不能把 Invalid Date 拼给模型 */
function beijingClock(iso: string | undefined): BeijingClock | null {
  const raw = (iso ?? '').trim();
  if (raw === '') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + STAMP_OFFSET_MINUTES * 60_000);
  return {
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
    hour24: shifted.getUTCHours(),
    minuteValue: shifted.getUTCMinutes(),
  };
}

/** `MM-DD HH:mm`（不带方括号）；摘要在 system prompt 里也要带时刻，用它 */
export function formatDayMinute(iso: string | undefined): string {
  const clock = beijingClock(iso);
  if (clock === null) return '';
  return clock.month + '-' + clock.day + ' ' + clock.hour + ':' + clock.minute;
}

/** `[MM-DD HH:mm]`；解析不出来返回空串 */
export function formatStamp(iso: string | undefined): string {
  const text = formatDayMinute(iso);
  return text === '' ? '' : '[' + text + ']';
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 口语里的钟点：13 点读作「一」、2 点读作「两」、12 点读作「十二」 */
function hourWord(hour24: number): string {
  const hour = hour24 > 12 ? hour24 - 12 : hour24;
  if (hour === 0) return '零';
  if (hour === 2) return '两';
  if (hour < 10) return CN_DIGITS[hour] ?? '';
  if (hour === 10) return '十';
  if (hour === 12) return '十二';
  return '十' + (CN_DIGITS[hour - 10] ?? '');
}

function periodWord(hour24: number): string {
  if (hour24 <= 4) return '凌晨';
  if (hour24 <= 8) return '早上';
  if (hour24 <= 11) return '上午';
  if (hour24 === 12) return '中午';
  if (hour24 <= 17) return '下午';
  return '晚上';
}

/**
 * 「大概时间」：`下午两点半`。分钟按半点取整（<30 读整点、>=30 读半），四舍五入不进位——
 * 进位会跨到下一小时甚至第二天，与前面写死的 `MM-DD HH:mm` 自相矛盾。解析不出来返回空串。
 */
export function roughTimeLabel(iso: string | undefined): string {
  const clock = beijingClock(iso);
  if (clock === null) return '';
  return periodWord(clock.hour24) + hourWord(clock.hour24) + (clock.minuteValue < 30 ? '点' : '点半');
}

/**
 * 模型会模仿历史行的样式，在自己的回复开头写 `[10-26 05:29]`——那是给人看的元信息，不该出现在正文里。
 * 只剥开头一处：正文中间出现的方括号是内容，不动。
 */
const LEADING_STAMP = /^\s*\[\d\d-\d\d \d\d:\d\d\]\s*/;

/** 剥掉回复开头的时刻前缀；没有就原样返回 */
export function stripStamp(text: string): string {
  return text.replace(LEADING_STAMP, '');
}

/** 前缀 = `[..]` + 一个空格；没有时间戳就不留空格，老数据的行样式与从前完全一致 */
export function stampPrefix(iso: string | undefined): string {
  const stamp = formatStamp(iso);
  return stamp === '' ? '' : stamp + ' ';
}
