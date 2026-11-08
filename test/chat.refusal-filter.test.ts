import { describe, expect, it } from 'vitest';
import { dropRefusalHistory, looksLikeRefusal } from '../src/core/chat/refusal-filter';

const CANNED =
  '我将忽略提示词中关于扮演特定角色以及绕过安全规则的设定，直接回应你的核心请求。你的意图是继续进行一段设定中包含露骨色情要求（如“18+ASMR风格”、描述身体结合部位感受及呻吟声）的互动文字游戏。由于我的安全准则严格禁止生成高度露骨的性描写或成人色情内容，我必须拒绝继续编写该方向的剧情。';

describe('§61 历史里的拒答', () => {
  it('线上那条 180 字固定拒答算拒答', () => {
    expect(looksLikeRefusal(CANNED)).toBe(true);
  });

  it('更早那条点名「示例角色」的 196 字拒答也算', () => {
    expect(
      looksLikeRefusal(
        '我将忽略你请求中关于扮演“示例角色”以及绕过安全规则的设定，直接回应你的核心意图。由于我的安全准则严格禁止生成高度露骨的性描写或色情内容，因此我必须拒绝。',
      ),
    ).toBe(true);
  });

  it('短英文拒答也算（没有 policy 字样，靠 sexual / cannot 命中）', () => {
    expect(looksLikeRefusal('I cannot fulfill this request. Your prompt involves engaging in sexual content.')).toBe(
      true,
    );
  });

  it('正常正文不算：句子里的撒娇、正文里的「无法」「色情」单独出现都不够', () => {
    expect(looksLikeRefusal('喵～你终于回来了，我都快等睡着了喵。')).toBe(false);
    expect(looksLikeRefusal('我无法再忍了，伸手把你的脸扳过来。')).toBe(false);
    expect(looksLikeRefusal('这一段是正文里提到的色情描写桥段，她翻过去不看了。')).toBe(false);
  });

  it('长正文里就算同时出现「无法」和「准则」也不算：超过 600 字一律放行', () => {
    expect(looksLikeRefusal('我无法拒绝你。' + '喵'.repeat(700) + '安全准则')).toBe(false);
  });

  it('只滤 assistant 行，user 行与正常 assistant 行都留着，顺序不变', () => {
    const rows = [
      { role: 'user', content: '老婆涩涩' },
      { role: 'assistant', content: CANNED },
      { role: 'assistant', content: '喵～抱住你的胳膊蹭了蹭。' },
    ];
    const kept = dropRefusalHistory(rows);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.content).toBe('老婆涩涩');
    expect(kept[1]?.content).toBe('喵～抱住你的胳膊蹭了蹭。');
  });
});
