/**
 * 记忆行的时刻前缀：`[MM-DD HH:mm]`。固定按北京时间（UTC+8）渲染——workerd 跑在 UTC，
 * 直接用本地时区会让模型看到的时刻比说话人慢 8 小时；先把毫秒整体平移，再取 getUTC*，
 * 结果与运行环境时区无关（以后迁到 AWS 机器上也不会变）。
 */
export const STAMP_OFFSET_MINUTES = 480;

const pad = (value: number): string => String(value).padStart(2, '0');

interface BeijingClock {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

/** 解析不了的时间一律当「没有时间」：宁可少一个前缀，也不能把 Invalid Date 拼给模型 */
function beijingClock(iso: string | undefined): BeijingClock | null {
  const raw = (iso ?? '').trim();
  if (raw === '') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + STAMP_OFFSET_MINUTES * 60_000);
  return {
    year: String(shifted.getUTCFullYear()),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
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

/** 年月日时分，全部两位补零；段头按它拼「2026年11月10日17时20分」 */
export interface MomentParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

/** 解析不出来返回 null（宁可少一个时间段，也不能把 Invalid Date 拼给模型） */
export function momentParts(iso: string | undefined): MomentParts | null {
  const clock = beijingClock(iso);
  if (clock === null) return null;
  return { year: clock.year, month: clock.month, day: clock.day, hour: clock.hour, minute: clock.minute };
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
