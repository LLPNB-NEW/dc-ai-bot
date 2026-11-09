/**
 * toSpeechText：正文 → 要念的那句话。
 * 本轮改动：有台词引号时只念引号里的句子，没有就整段照念（用户选的兜底）。
 */
import { describe, expect, it } from 'vitest';
import { toSpeechText } from '../src/core/voice/speech-text';

describe('引号内才是台词', () => {
  it('弯引号：只取引号里的句子，叙述整段丢掉', () => {
    expect(toSpeechText('她抬眼看了看你，慢慢说：“今天不想动，陪我躺一会儿。”说完又把脸埋回枕头里。')).toBe(
      '今天不想动，陪我躺一会儿。',
    );
  });

  it('直角引号与双直角引号都算台词', () => {
    expect(toSpeechText('（歪头）「你终于回来了。」')).toBe('你终于回来了。');
    expect(toSpeechText('她小声嘀咕：「『别走』这句话我说不出口。」')).toBe('『别走』这句话我说不出口。');
  });

  it('多段引号按出现顺序拼起来，中间留一个空格当停顿', () => {
    expect(toSpeechText('她笑了一下：“走吧。”走到门口又补一句：“别回头。”')).toBe('走吧。 别回头。');
  });

  it('一对引号都没有 → 整段照念，一个字都不剪', () => {
    expect(toSpeechText('嗯……就这样吧，今天懒得说话。')).toBe('嗯……就这样吧，今天懒得说话。');
  });

  it('空引号不算台词：回退成整段', () => {
    expect(toSpeechText('她张了张嘴：“”，然后什么都没说。')).toBe('她张了张嘴：“”，然后什么都没说。');
  });

  it('英文直引号不算台词（聊天里常用来包术语）', () => {
    expect(toSpeechText('这个 "context" 参数是必填的。')).toBe('这个 "context" 参数是必填的。');
  });
});

describe('清理与之前逐字相同', () => {
  it('提及、markdown、换行先清掉，再从清理后的正文里取引号', () => {
    expect(toSpeechText('<@123> **她** 说：\n“你好呀。”')).toBe('你好呀。');
    expect(toSpeechText('*叹气*\n\n“算了。”')).toBe('算了。');
  });

  it('结尾截断后缀摘掉', () => {
    expect(toSpeechText('“讲完了。”…(已截断)')).toBe('讲完了。');
    expect(toSpeechText('讲了一半…(已截断)')).toBe('讲了一半');
  });

  it('只剩空白 → 空串（调用方据此跳过合成）', () => {
    expect(toSpeechText('   ')).toBe('');
    expect(toSpeechText('<@1> *~* ')).toBe('');
  });
});
