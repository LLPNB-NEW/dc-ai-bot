import { describe, expect, it } from 'vitest';
import {
  DESCRIBE_BATCH_SIZE,
  DESCRIBE_MAX_CHARS,
  DESCRIBE_SYSTEM_PROMPT,
  buildDescribeRequest,
  parseDescribeOutput,
} from '../src/core/chat/emoji-describe';
import type { DescribeTarget } from '../src/core/chat/emoji-describe';
import type { LlmImage, ReactionModelConfig } from '../src/core/types';

const CFG: ReactionModelConfig = { enabled: true, provider: 'openai-compat', model: 'gpt-4o-mini' };

const IMAGE_A: LlmImage = { mediaType: 'image/png', base64: 'iVBORw0KGgo=' };
const IMAGE_B: LlmImage = { mediaType: 'image/gif', base64: 'R0lGODlhAQAB' };
const IMAGE_C: LlmImage = { mediaType: 'image/png', base64: '/9j/4AAQ' };

const BATCH: DescribeTarget[] = [
  { id: '1', name: 'laugh', image: IMAGE_A },
  { id: '2', name: '猫猫', image: IMAGE_B },
  { id: '3', name: 'wow', image: IMAGE_C },
];

describe('DESCRIBE_MAX_CHARS / DESCRIBE_BATCH_SIZE（§23.3）', () => {
  it('描述上限 20 字、一批最多 6 张图', () => {
    expect(DESCRIBE_MAX_CHARS).toBe(20);
    expect(DESCRIBE_BATCH_SIZE).toBe(6);
  });
});

describe('DESCRIBE_SYSTEM_PROMPT（§23.3）', () => {
  it('四条口径写死：只看画面、一句中文 20 字、不要解释/围栏/结尾标点、只输出 id=描述', () => {
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('只描述画面上真正看到的东西');
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('角色外形');
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('不超过 20 字');
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('不要解释');
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('代码围栏');
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('id=描述');
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('宁可漏也不要编');
    // 试过加「认得出知名形象就写名字」：二创像素图认不出，还让 36 个表情里 12 个解析失败，已回退
  });
});

describe('buildDescribeRequest（§23.3）', () => {
  it('model 取配置、system 是认图指令、只有一条 user 消息、不设采样旋钮', () => {
    const request = buildDescribeRequest(CFG, BATCH);

    expect(request.model).toBe('gpt-4o-mini');
    expect(request.system).toBe(DESCRIBE_SYSTEM_PROMPT);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe('user');
    // 与 §21.3 同口径：多调一个旋钮只多一处可错的地方
    expect('temperature' in request).toBe(false);
    expect('maxTokens' in request).toBe(false);
  });

  it('user 文本逐行 N. 名字（id xxx），末行要求每行输出 id=描述', () => {
    const content = buildDescribeRequest(CFG, BATCH).messages[0]?.content ?? '';
    const lines = content.split('\n');

    expect(lines).toContain('1. laugh（id 1）');
    expect(lines).toContain('2. 猫猫（id 2）');
    expect(lines).toContain('3. wow（id 3）');
    // 编号顺序必须与行序一致：模型靠「第 N 张图 = 第 N 行」对号
    expect(lines.indexOf('1. laugh（id 1）')).toBeLessThan(lines.indexOf('2. 猫猫（id 2）'));
    expect(lines.indexOf('2. 猫猫（id 2）')).toBeLessThan(lines.indexOf('3. wow（id 3）'));
    expect(lines.at(-1)).toContain('id=描述');
  });

  it('images 按 batch 顺序，张数与 batch 一致', () => {
    const request = buildDescribeRequest(CFG, BATCH);

    expect(request.images).toEqual([IMAGE_A, IMAGE_B, IMAGE_C]);
    expect(request.images?.[0]).toBe(IMAGE_A);
    expect(request.images?.[1]?.mediaType).toBe('image/gif');
    expect(request.images).toHaveLength(BATCH.length);
  });

  it('空批次不写 images 键：没有图时请求形状里不出现这个字段（与 §22.6 同口径）', () => {
    expect('images' in buildDescribeRequest(CFG, [])).toBe(false);
    expect('images' in buildDescribeRequest(CFG, BATCH)).toBe(true);
  });
});

describe('parseDescribeOutput（§23.3）', () => {
  it('标准多行：一行一个 id=描述', () => {
    const result = parseDescribeOutput('1=黄胖小子咧嘴大笑\n2=一只白猫\n3=张大的嘴', BATCH);

    expect(result).toEqual([
      { emojiId: '1', description: '黄胖小子咧嘴大笑' },
      { emojiId: '2', description: '一只白猫' },
      { emojiId: '3', description: '张大的嘴' },
    ]);
  });

  it('全角等号也认，等号前后空白忽略', () => {
    expect(parseDescribeOutput('1＝黄胖小子咧嘴大笑', BATCH)).toEqual([
      { emojiId: '1', description: '黄胖小子咧嘴大笑' },
    ]);
    expect(parseDescribeOutput('  2  =  一只白猫  ', BATCH)).toEqual([
      { emojiId: '2', description: '一只白猫' },
    ]);
  });

  it('行首的脏字符被剥掉：列表符、引用符、模型自己重复的编号', () => {
    const raw = ['- 1=横线列表项', '2. 2=重复编号项', '> 3=引用块项'].join('\n');

    expect(parseDescribeOutput(raw, BATCH)).toEqual([
      { emojiId: '1', description: '横线列表项' },
      { emojiId: '2', description: '重复编号项' },
      { emojiId: '3', description: '引用块项' },
    ]);
  });

  it('行首尾的包裹符被剥掉：整行反引号/引号包住，代码围栏行本身不算描述', () => {
    const raw = ['```', '`1=反引号包住的描述`', '"2=引号包住的描述"'].join('\n');

    expect(parseDescribeOutput(raw, BATCH)).toEqual([
      { emojiId: '1', description: '反引号包住的描述' },
      { emojiId: '2', description: '引号包住的描述' },
    ]);
  });

  it('id 不在本批里的行丢弃：别人的 id 不能落库', () => {
    expect(parseDescribeOutput('99=野表情\n1=黄胖小子咧嘴大笑', BATCH)).toEqual([
      { emojiId: '1', description: '黄胖小子咧嘴大笑' },
    ]);
    // 子串也不算：13 里那一位 1 / 3 不能对号
    expect(parseDescribeOutput('13=野表情\n12=另一个野表情', BATCH)).toEqual([]);
  });

  it('空描述丢弃：只写等号或只写包裹符都不算描述', () => {
    expect(parseDescribeOutput('1=\n2=   \n3=``', BATCH)).toEqual([]);
  });

  it('同一 id 取第一次出现', () => {
    expect(parseDescribeOutput('1=第一次\n1=第二次', BATCH)).toEqual([
      { emojiId: '1', description: '第一次' },
    ]);
  });

  it('描述超过 20 字被截断', () => {
    const long = '黄胖小子咧嘴大笑'.repeat(4);
    const result = parseDescribeOutput('1=' + long, BATCH);

    expect(result[0]?.description).toHaveLength(DESCRIBE_MAX_CHARS);
    expect(result[0]?.description).toBe(long.slice(0, DESCRIBE_MAX_CHARS));
  });

  it('整段没有一个 id=描述 的行时返回空数组（不猜）', () => {
    expect(parseDescribeOutput('', BATCH)).toEqual([]);
    expect(parseDescribeOutput('抱歉，这几张图我没看清。\n\n无法描述。', BATCH)).toEqual([]);
    expect(parseDescribeOutput('图片1：一只猫', BATCH)).toEqual([]);
  });

  it('返回顺序按 batch，不按模型输出的行序', () => {
    const result = parseDescribeOutput('3=张大的嘴\n1=黄胖小子咧嘴大笑', BATCH);

    expect(result).toEqual([
      { emojiId: '1', description: '黄胖小子咧嘴大笑' },
      { emojiId: '3', description: '张大的嘴' },
    ]);
  });
});
