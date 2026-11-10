import { describe, expect, it } from 'vitest';
import {
  SUMMARY_MAX_CHARS,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_MAX_INPUT_MESSAGES,
  appendSegment,
  buildSummaryRequest,
  formatTranscript,
  normalizeSummary,
  renderSummaryBlock,
  segmentHeading,
  selectSegments,
  splitSegments,
} from '../src/core/chat/summary';
import type { ModelRef, StoredMessage } from '../src/core/types';

function stored(id: number, role: 'user' | 'assistant', content: string, author?: string, authorId?: string): StoredMessage {
  const message: StoredMessage = { id, role, content };
  if (author !== undefined) message.author = author;
  if (authorId !== undefined) message.authorId = authorId;
  return message;
}

describe('摘要常量', () => {
  it('与契约一致', () => {
    expect(SUMMARY_MAX_CHARS).toBe(4000);
    expect(SUMMARY_MAX_INPUT_MESSAGES).toBe(50);
  });

  it('指令要求只写新增、禁止改写已有记忆，并禁止解释性开场白', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('不要复述或改写【已有记忆】');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('新增对话');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('开场白');
    // 记忆是累积的：再说「合并成一段」模型就会重写老段
    expect(SUMMARY_SYSTEM_PROMPT).not.toContain('合并成一段');
    expect(SUMMARY_SYSTEM_PROMPT).not.toContain('上一版摘要');
  });
});

describe('formatTranscript', () => {
  it('每行「名字(ID)：正文」，用全角冒号', () => {
    const transcript = formatTranscript([
      stored(1, 'user', '我也想看电影', '小明', '150000000000000001'),
      stored(2, 'assistant', '一起看', '示例机器人'),
    ]);
    expect(transcript.split('\n')).toEqual([
      '小明(150000000000000001)：我也想看电影',
      '示例机器人：一起看',
    ]);
  });

  it('assistant 行缺名字时退化成 Bot，user 行缺名字时退化成用户', () => {
    const transcript = formatTranscript([stored(1, 'user', '你好'), stored(2, 'assistant', '在')]);
    expect(transcript.split('\n')).toEqual(['用户：你好', 'Bot：在']);
  });

  it('空数组得到空串，单条不补换行', () => {
    expect(formatTranscript([])).toBe('');
    expect(formatTranscript([stored(1, 'user', '只有一条', '小明')])).toBe('小明：只有一条');
  });
});

describe('buildSummaryRequest', () => {
  const route: ModelRef = { provider: 'openai-compat', model: 'gpt-4o-mini' };

  it('模型取路由候选，指令进 system，素材进 user', () => {
    const request = buildSummaryRequest(route, '', '小明：你好');
    expect(request.model).toBe('gpt-4o-mini');
    expect(request.system).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe('user');
    expect(request.messages[0]?.content).toContain('【新增对话】\n小明：你好');
  });

  it('已有记忆为空时不出现空的【已有记忆】段', () => {
    expect(buildSummaryRequest(route, '   ', 'transcript').messages[0]?.content).not.toContain('【已有记忆】');
  });

  it('有已有记忆时放在新增对话之前', () => {
    const content = buildSummaryRequest(route, '他喜欢猫', '小明：你好').messages[0]?.content ?? '';
    expect(content).toContain('【已有记忆】\n他喜欢猫');
    expect(content.indexOf('【已有记忆】')).toBeLessThan(content.indexOf('【新增对话】'));
  });
});

describe('normalizeSummary', () => {
  it('去掉首尾空白', () => {
    expect(normalizeSummary('  \n 他喜欢猫 \n ')).toBe('他喜欢猫');
  });

  it('剥掉整段代码围栏', () => {
    expect(normalizeSummary('```\n他喜欢猫\n```')).toBe('他喜欢猫');
    expect(normalizeSummary('```markdown\n他喜欢猫\n```')).toBe('他喜欢猫');
  });

  it('围栏只包了一部分时按正文处理，不误删内容', () => {
    expect(normalizeSummary('他喜欢猫\n```js\nconst a = 1\n```')).toBe('他喜欢猫\n```js\nconst a = 1\n```');
  });

  it('不按长度截断：模型写多长就存多长', () => {
    const long = 'x'.repeat(SUMMARY_MAX_CHARS + 10);
    expect(normalizeSummary(long)).toBe(long);
  });

  it('空输入得到空串，交给调用方判定 SUMMARY_EMPTY', () => {
    expect(normalizeSummary('')).toBe('');
    expect(normalizeSummary('```\n```')).toBe('');
  });
});

describe('segmentHeading', () => {
  it('段标记 + 这一批的覆盖时间段', () => {
    expect(segmentHeading('2026-10-25T14:40:00.000Z', '2026-10-26T06:30:00.000Z')).toBe(
      '【记忆段】（2026年10月25日22时40分-10月26日14时30分）',
    );
  });

  it('只有覆盖到（老摘要或单条消息）时，段头只写截止时刻', () => {
    expect(segmentHeading(undefined, '2026-10-26T06:30:00.000Z')).toBe(
      '【记忆段】（2026年10月26日14时30分）',
    );
  });

  it('同一天的两头只写一次年月日，结尾是几点几分', () => {
    expect(segmentHeading('2026-11-10T09:20:00.000Z', '2026-11-10T12:54:00.000Z')).toBe(
      '【记忆段】（2026年11月10日17时20分-20时54分）',
    );
    expect(segmentHeading('2026-11-10T09:20:00.000Z', '2026-11-10T09:20:00.000Z')).toBe(
      '【记忆段】（2026年11月10日17时20分）',
    );
  });

  it('时间段解析不了或两头都空，就退回裸的段标记，不拼 Invalid Date', () => {
    expect(segmentHeading('not-a-date', '2026-10-26T06:30:00.000Z')).toBe(
      '【记忆段】（2026年10月26日14时30分）',
    );
    expect(segmentHeading('not-a-date', 'also-bad')).toBe('【记忆段】');
    expect(segmentHeading('', '')).toBe('【记忆段】');
    expect(segmentHeading()).toBe('【记忆段】');
  });
});

describe('appendSegment', () => {
  it('第一段：段头 + 换行 + 正文，没有前导空行', () => {
    expect(appendSegment('', '他喜欢猫', '2026-10-25T14:40:00.000Z', '2026-10-26T06:30:00.000Z')).toBe(
      '【记忆段】（2026年10月25日22时40分-10月26日14时30分）' + '\n' + '他喜欢猫',
    );
  });

  it('后续段接在尾部，段间一个空行，原文本逐字不动', () => {
    expect(appendSegment('【记忆段】\n他喜欢猫', '他养了两只猫')).toBe(
      '【记忆段】\n他喜欢猫\n\n【记忆段】\n他养了两只猫',
    );
  });

  it('已有记忆只有空白时当成没有，不留前导空行', () => {
    expect(appendSegment('  \n ', '他喜欢猫')).toBe('【记忆段】\n他喜欢猫');
  });

  it('尾部多余空白先 trimEnd 再拼，段与段之间只有一个空行', () => {
    expect(appendSegment('【记忆段】\n他喜欢猫\n\n\n', '下一段')).toBe(
      '【记忆段】\n他喜欢猫\n\n【记忆段】\n下一段',
    );
  });
});

describe('splitSegments', () => {
  it('没有段头的老数据整块算一段', () => {
    expect(splitSegments('  老摘要：他喜欢猫  ')).toEqual(['老摘要：他喜欢猫']);
  });

  it('空文本得到空数组', () => {
    expect(splitSegments('')).toEqual([]);
    expect(splitSegments('   \n ')).toEqual([]);
  });

  it('按段头切段，段头行归属自己那段，段间空行不算进正文', () => {
    expect(splitSegments('【记忆段】\n第一段\n\n【记忆段】\n第二段')).toEqual([
      '【记忆段】\n第一段',
      '【记忆段】\n第二段',
    ]);
  });

  it('老数据后面追加的新段：老数据自己是一段，新段带段头', () => {
    expect(splitSegments('老摘要正文\n\n【记忆段】\n新的一段')).toEqual(['老摘要正文', '【记忆段】\n新的一段']);
  });
});

describe('selectSegments', () => {
  const stored = '【记忆段】\n老记忆：他喜欢猫\n\n【记忆段】\n新记忆：他养了两只猫';

  it('预算充足时全部带上，顺序仍是旧→新', () => {
    const picked = selectSegments(stored, 1000);
    expect(picked).toBe(stored);
    expect(picked.indexOf('老记忆')).toBeLessThan(picked.indexOf('新记忆'));
  });

  it('预算不够时只带最新一段，更老的关键词一个都不出现', () => {
    const picked = selectSegments(stored, '【记忆段】\n新记忆：他养了两只猫'.length);
    expect(picked).toBe('【记忆段】\n新记忆：他养了两只猫');
    expect(picked).not.toContain('他喜欢猫');
  });

  it('段间空行算 2 个字符：正好 18 个字符能带两段，17 个就只剩最新一段', () => {
    const two = '【记忆段】\n老段\n\n【记忆段】\n新段';
    expect(selectSegments(two, 18)).toBe(two);
    expect(selectSegments(two, 17)).toBe('【记忆段】\n新段');
  });

  it('单段超预算时保留段头，正文截到预算以内并以省略号结尾', () => {
    const long = '【记忆段】\n' + 'x'.repeat(200);
    const picked = selectSegments(long, 40);
    expect(picked.startsWith('【记忆段】\n')).toBe(true);
    expect(picked.endsWith('…')).toBe(true);
    expect(picked.length).toBeLessThanOrEqual(40);
  });

  it('空文本得到空串', () => {
    expect(selectSegments('', 100)).toBe('');
  });
});

describe('renderSummaryBlock', () => {
  it('非空摘要包成【长期记忆摘要】段，外面套 <recall>，带前导空行，外层不再拼时间段', () => {
    expect(renderSummaryBlock('他喜欢猫')).toBe('\n\n<recall>\n【长期记忆摘要】\n他喜欢猫\n</recall>');
  });

  it('空摘要返回空串，可以直接拼在 system prompt 末尾', () => {
    expect(renderSummaryBlock('')).toBe('');
    expect(renderSummaryBlock('   \n ')).toBe('');
  });

  it('去掉正文首尾空白', () => {
    expect(renderSummaryBlock('  他喜欢猫  ')).toBe('\n\n<recall>\n【长期记忆摘要】\n他喜欢猫\n</recall>');
  });

  it('多段原样带出：时间段由每段自己的段头写', () => {
    const stored = '【记忆段】\n第一段\n\n【记忆段】\n第二段';
    expect(renderSummaryBlock(stored)).toBe(
      '\n\n<recall>\n【长期记忆摘要】\n【记忆段】\n第一段\n\n【记忆段】\n第二段\n</recall>',
    );
  });

  it('预算由调用方给：只装得下最新段时更老的内容不出现', () => {
    const stored = '【记忆段】\n老段\n\n【记忆段】\n新段';
    expect(renderSummaryBlock(stored, 8)).toBe('\n\n<recall>\n【长期记忆摘要】\n【记忆段】\n新段\n</recall>');
  });
});
