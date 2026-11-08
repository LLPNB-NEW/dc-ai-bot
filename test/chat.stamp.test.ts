import { describe, expect, it } from 'vitest';
import {
  STAMP_OFFSET_MINUTES,
  formatDayMinute,
  formatStamp,
  roughTimeLabel,
  stampPrefix,
  stripStamp,
} from '../src/core/chat/stamp';

describe('记忆行的时间戳前缀', () => {
  it('UTC 时刻转成北京时间 [MM-DD HH:mm]', () => {
    expect(STAMP_OFFSET_MINUTES).toBe(480);
    expect(formatStamp('2026-10-25T03:00:00.000Z')).toBe('[10-25 11:00]');
  });

  it('按北京时间进位到次日、次月', () => {
    expect(formatStamp('2026-10-24T16:00:00.000Z')).toBe('[10-25 00:00]');
    expect(formatStamp('2026-10-31T17:30:00.000Z')).toBe('[11-01 01:30]');
  });

  it('空值或不可解析的串返回空串，绝不拼出 NaN 戳', () => {
    expect(formatStamp(undefined)).toBe('');
    expect(formatStamp('')).toBe('');
    expect(formatStamp('not-a-date')).toBe('');
  });

  it('stampPrefix 有戳时带一个尾随空格，无戳时是空串', () => {
    expect(stampPrefix('2026-10-25T03:00:00.000Z')).toBe('[10-25 11:00] ');
    expect(stampPrefix(undefined)).toBe('');
  });
});

describe('摘要段头用的日期与大概时间', () => {
  it('formatDayMinute 给出不带方括号的北京时间', () => {
    expect(formatDayMinute('2026-10-26T06:30:00.000Z')).toBe('10-26 14:30');
    expect(formatDayMinute(undefined)).toBe('');
    expect(formatDayMinute('not-a-date')).toBe('');
  });

  it('大概时间按口语读钟点，半小时一档', () => {
    expect(roughTimeLabel('2026-10-26T06:30:00.000Z')).toBe('下午两点半');
    expect(roughTimeLabel('2026-10-26T06:05:00.000Z')).toBe('下午两点');
    expect(roughTimeLabel('2026-10-26T06:59:00.000Z')).toBe('下午两点半');
  });

  it('各个时段的口语说法与 12 小时制读法', () => {
    expect(roughTimeLabel('2026-10-25T03:00:00.000Z')).toBe('上午十一点');
    expect(roughTimeLabel('2026-10-25T20:00:00.000Z')).toBe('凌晨四点');
    expect(roughTimeLabel('2026-10-25T23:00:00.000Z')).toBe('早上七点');
    expect(roughTimeLabel('2026-10-26T04:00:00.000Z')).toBe('中午十二点');
    expect(roughTimeLabel('2026-10-26T15:30:00.000Z')).toBe('晚上十一点半');
  });

  it('解析不了的时刻不给大概时间', () => {
    expect(roughTimeLabel(undefined)).toBe('');
    expect(roughTimeLabel('not-a-date')).toBe('');
  });
});

describe('剥离模型自己写在开头的时间戳', () => {
  it('剥掉开头戳并清掉其后空白', () => {
    expect(stripStamp('[10-26 05:29] 哈啊？！')).toBe('哈啊？！');
    expect(stripStamp('  [10-26 05:29]   好')).toBe('好');
  });

  it('只剥开头一处，正文中间的方括号原样保留', () => {
    expect(stripStamp('报价 [10-26 05:29] 见附件')).toBe('报价 [10-26 05:29] 见附件');
    expect(stripStamp('没有前缀')).toBe('没有前缀');
  });

  it('形状不符的方括号不被当成戳', () => {
    expect(stripStamp('[10-26] 好')).toBe('[10-26] 好');
    expect(stripStamp('[abc] 好')).toBe('[abc] 好');
  });

  it('只有戳、没有正文时返回空串', () => {
    expect(stripStamp('[10-26 05:29] ')).toBe('');
  });
});
