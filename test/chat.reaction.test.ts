import { describe, expect, it } from 'vitest';
import {
  NO_REACTION_NOTE,
  REACTION_HISTORY_MESSAGES,
  REACTION_MAX_CATALOG,
  REACTION_TARGETS_HEADER,
  buildReactionRequest,
  isOnlyNoReactionMark,
  normalizeReactions,
  renderReactionTargets,
  stripNoReactionHead,
} from '../src/core/chat/reaction';
import { DEFAULT_REACTION_GUIDE } from '../src/core/chat/reaction-guide';
import { DEFAULT_REACTION_TEMPLATE } from '../src/core/chat/reaction-template';
import type { CustomEmoji, LlmImage, ReactionModelConfig, ReactionTarget } from '../src/core/types';

const CFG: ReactionModelConfig = { enabled: true, provider: 'openai-compat', model: 'gpt-4o-mini' };

/**
 * 表情模型的 system 与素材模板都是三层解析后的那一份（§28.10 / §34.4），本文件只关心素材段怎么拼，
 * 所以统一把 guide 与 template 钉在默认值上；要验「system 就是传进来的 guide」「模板被尊重」的自己直调 buildReactionRequest。
 */
function buildReq(
  cfg: ReactionModelConfig,
  input: Omit<Parameters<typeof buildReactionRequest>[1], 'guide' | 'template'>,
) {
  return buildReactionRequest(cfg, { ...input, guide: DEFAULT_REACTION_GUIDE, template: DEFAULT_REACTION_TEMPLATE });
}

/** 默认模板 + 空历史 + 空清单：只留下这两段（清单段/目标段整段消失，不留空行与空标题） */
const BASE = '【最近的对话】\n\n【对方的消息】\n你好\n\n【我的回复】\n好的';

function emoji(name: string): CustomEmoji {
  return { name, id: 'id-' + name };
}

describe('表情模型的 system 来自三层配置（§28.10）', () => {
  it('guide 非空时 system = guide + 空行 + NO_REACTION_NOTE：共用规则在前，不贴的约定收尾', () => {
    const request = buildReactionRequest(CFG, {
      userText: '你好',
      botReply: '好的',
      guide: '第一行规则\n第二行规则',
      template: DEFAULT_REACTION_TEMPLATE,
    });

    expect(request.system.startsWith('第一行规则\n第二行规则')).toBe(true);
    expect(request.system.endsWith(NO_REACTION_NOTE)).toBe(true);
    expect(request.system).toBe('第一行规则\n第二行规则\n\n' + NO_REACTION_NOTE);
    // 素材里的 {{表情规则}} 仍然只填 guide：同一句约定不能在 system 与素材里各来一遍
    expect(request.messages[0]?.content ?? '').not.toContain(NO_REACTION_NOTE);
  });

  it('guide trim 后为空时 system 只有 NO_REACTION_NOTE：不贴的约定与文案无关，必须留着', () => {
    for (const guide of ['', '   \n\t ']) {
      const request = buildReactionRequest(CFG, {
        userText: '你好',
        botReply: '好的',
        guide,
        template: DEFAULT_REACTION_TEMPLATE,
      });
      expect(request.system).toBe(NO_REACTION_NOTE);
    }
  });

  it('清单上限与 §18.5 同口径：40', () => {
    expect(REACTION_MAX_CATALOG).toBe(40);
  });
});


describe('buildReactionRequest（§21.3）', () => {
  it('model 取配置、system 是指令、素材只放一条 user 消息', () => {
    const request = buildReq(CFG, { userText: '你好', botReply: '好的' });

    expect(request.model).toBe('gpt-4o-mini');
    expect(request.system).toBe(DEFAULT_REACTION_GUIDE + '\n\n' + NO_REACTION_NOTE);
    expect(request.messages).toEqual([{ role: 'user', content: BASE }]);
    // 表情是单 token 输出，多调一个采样旋钮只多一处可错的地方
    expect('temperature' in request).toBe(false);
    expect('maxTokens' in request).toBe(false);
  });

  it('没有自定义表情时清单段整段不出现', () => {
    expect(buildReq(CFG, { userText: '你好', botReply: '好的' }).messages[0]?.content).not.toContain('【可用自定义表情】');
    expect(buildReq(CFG, { userText: '你好', botReply: '好的', customEmojis: [] }).messages[0]?.content).toBe(BASE);
    // 名字全是空白等于没有名字：不能留一个空壳清单段
    expect(buildReq(CFG, { userText: '你好', botReply: '好的', customEmojis: [emoji(' ')] }).messages[0]?.content).toBe(BASE);
  });

  it('有自定义表情时清单段接在回复之后，名字写成 :name: 并用空格分隔', () => {
    const request = buildReq(CFG, {
      userText: '你好',
      botReply: '好的',
      customEmojis: [emoji('开心'), emoji(' 猫猫 ')],
    });

    expect(request.messages[0]?.content).toBe(BASE + '\n\n【可用自定义表情】\n:开心: :猫猫:');
  });

  it('清单去重并截到 40 个：几百个表情不能把这轮 prompt 撑爆', () => {
    const many: CustomEmoji[] = [emoji('dup'), emoji('dup')];
    for (let index = 0; index < REACTION_MAX_CATALOG + 5; index += 1) many.push(emoji('e' + String(index)));

    const content = buildReq(CFG, { userText: '你好', botReply: '好的', customEmojis: many }).messages[0]?.content ?? '';
    const catalog = content.split('【可用自定义表情】\n')[1] ?? '';

    expect(catalog.split(' ')).toHaveLength(REACTION_MAX_CATALOG);
    expect(catalog.startsWith(':dup: :e0: ')).toBe(true);
    expect(catalog).not.toContain(':dup: :dup:');
    expect(catalog).not.toContain(':e40:');
  });
});

describe('清单里的认图描述（§23.5）', () => {
  it('有描述时写成 :名字:(描述)：表情模型看的是与主模型同一份清单', () => {
    const request = buildReq(CFG, {
      userText: '你好',
      botReply: '好的',
      customEmojis: [
        { name: 'laugh', id: '1', description: '黄胖小子咧嘴大笑' },
        emoji('猫猫'),
      ],
    });

    expect(request.messages[0]?.content).toBe(BASE + '\n\n【可用自定义表情】\n:laugh:(黄胖小子咧嘴大笑) :猫猫:');
  });

  it('没有描述（缺省或 trim 后为空）时与旧文本逐字相同', () => {
    const request = buildReq(CFG, {
      userText: '你好',
      botReply: '好的',
      customEmojis: [{ name: '开心', id: 'id-开心' }, { name: '猫猫', id: 'id-猫猫', description: '   ' }],
    });

    expect(request.messages[0]?.content).toBe(BASE + '\n\n【可用自定义表情】\n:开心: :猫猫:');
  });

  it('描述不参与去重与 40 上限：同名只列第一次那条，条数仍是 40', () => {
    const many: CustomEmoji[] = [
      { name: 'dup', id: 'a', description: '第一个' },
      { name: 'dup', id: 'b', description: '第二个' },
    ];
    for (let index = 0; index < REACTION_MAX_CATALOG + 5; index += 1) many.push(emoji('e' + String(index)));

    const content = buildReq(CFG, { userText: '你好', botReply: '好的', customEmojis: many }).messages[0]?.content ?? '';
    const catalog = content.split('【可用自定义表情】\n')[1] ?? '';

    expect(catalog.split(' ')).toHaveLength(REACTION_MAX_CATALOG);
    expect(catalog.startsWith(':dup:(第一个) :e0: ')).toBe(true);
    expect(catalog).not.toContain('第二个');
  });
});

describe('清单里的表情别名（§24.4）', () => {
  function contentOf(customEmojis: CustomEmoji[]): string {
    return buildReq(CFG, { userText: '你好', botReply: '好的', customEmojis }).messages[0]?.content ?? '';
  }

  it('有别名没描述时只挂别名', () => {
    expect(contentOf([{ name: 'laugh', id: '1', aliases: ['奶龙'] }])).toBe(
      BASE + '\n\n【可用自定义表情】\n:laugh: 别名「奶龙」',
    );
  });

  it('有描述也有别名时描述在前、别名在后', () => {
    expect(contentOf([{ name: 'laugh', id: '1', description: '黄色胖角色站立掐腰', aliases: ['奶龙'] }])).toBe(
      BASE + '\n\n【可用自定义表情】\n:laugh:(黄色胖角色站立掐腰) 别名「奶龙」',
    );
  });

  it('多个别名用「、」连接，各自 trim 后排掉空串', () => {
    expect(contentOf([{ name: 'laugh', id: '1', aliases: [' 奶龙 ', '', '   ', ' 小黄龙'] }])).toBe(
      BASE + '\n\n【可用自定义表情】\n:laugh: 别名「奶龙、小黄龙」',
    );
  });

  it('别名全是空白等于没配别名', () => {
    expect(contentOf([{ name: 'cat', id: '2', aliases: ['  ', '', '\t'] }])).toBe(BASE + '\n\n【可用自定义表情】\n:cat:');
    expect(contentOf([{ name: 'cat', id: '2', aliases: [] }])).toBe(BASE + '\n\n【可用自定义表情】\n:cat:');
  });

  it('没有 aliases 键时输出与 §23.5 逐字相同', () => {
    expect(contentOf([{ name: 'cat', id: '2' }])).toBe(BASE + '\n\n【可用自定义表情】\n:cat:');
    expect(contentOf([{ name: 'cat', id: '2', description: '一只猫' }])).toBe(BASE + '\n\n【可用自定义表情】\n:cat:(一只猫)');
  });
});

describe('buildReactionRequest 的图片（§22.6）', () => {
  const IMAGES: LlmImage[] = [
    { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
    { mediaType: 'image/jpeg', base64: '/9j/4AAQ' },
  ];

  it('有图 → request.images 深等于传入数组，顺序不变', () => {
    const request = buildReq(CFG, { userText: '你好', botReply: '好的', images: IMAGES });

    expect(request.images).toEqual(IMAGES);
    expect(request.images?.[0]?.mediaType).toBe('image/png');
    expect(request.images?.[1]?.base64).toBe('/9j/4AAQ');
    // 图片不走 prompt 文本：素材段与无图时逐字相同，模型靠线缆里的 image 块看图
    expect(request.messages[0]?.content).toBe(BASE);
  });

  it('缺省与空数组都不写 images 键：无图时 LlmRequest 形状与 §21.3 一致', () => {
    expect('images' in buildReq(CFG, { userText: '你好', botReply: '好的' })).toBe(false);
    expect('images' in buildReq(CFG, { userText: '你好', botReply: '好的', images: [] })).toBe(false);
  });
});

const TARGETS: ReactionTarget[] = [
  { messageId: '123456789012345678', author: '卡利亞士兵', authorId: 'u-1', excerpt: '给我们贴大量的emoji' },
  { messageId: '223456789012345678', author: '小助手', authorId: 'u-2', excerpt: '' },
];

describe('可贴表情的消息段（§28.4）', () => {
  it('一行一条 #<id> <作者>：「<摘要>」，接在素材最后；摘要为空就不写引文', () => {
    const content = buildReq(CFG, { userText: '你好', botReply: '好的', targets: TARGETS }).messages[0]?.content;

    expect(content).toBe(
      BASE +
        '\n\n' +
        REACTION_TARGETS_HEADER +
        '\n#123456789012345678 卡利亞士兵：「给我们贴大量的emoji」\n#223456789012345678 小助手',
    );
  });

  it('顺序：自定义表情清单在前，可贴表情的消息在后（§28.6）', () => {
    const content =
      buildReq(CFG, { userText: '你好', botReply: '好的', customEmojis: [emoji('开心')], targets: TARGETS })
        .messages[0]?.content ?? '';

    expect(content.indexOf('【可用自定义表情】')).toBeLessThan(content.indexOf(REACTION_TARGETS_HEADER));
  });

  it('targets 缺省或空数组时整段不出现：素材与旧版逐字相同', () => {
    expect(buildReq(CFG, { userText: '你好', botReply: '好的' }).messages[0]?.content).toBe(BASE);
    expect(buildReq(CFG, { userText: '你好', botReply: '好的', targets: [] }).messages[0]?.content).toBe(BASE);
    expect(renderReactionTargets(undefined)).toBe('');
    expect(renderReactionTargets([])).toBe('');
  });

  it('没有消息 ID 的目标不写进提示词：贴不上去的目标只会骗模型', () => {
    expect(renderReactionTargets([{ messageId: '   ', author: '甲', authorId: 'u', excerpt: 'x' }])).toBe('');
  });

  it('renderReactionTargets 是段前空两行的整段：主模型 system 直接拼', () => {
    expect(renderReactionTargets(TARGETS).startsWith('\n\n' + REACTION_TARGETS_HEADER + '\n#123456789012345678 ')).toBe(true);
  });
});

describe('最近的对话（§34.1）', () => {
  const ROWS = ['[01-01 10:00] 阿天(ID1)：早', '[01-01 10:01] Bot：早呀'];

  it('history 行原样落进【最近的对话】，末尾是最近的一条', () => {
    const content = buildReq(CFG, { userText: '你好', botReply: '好的', history: ROWS }).messages[0]?.content ?? '';

    expect(content).toContain('【最近的对话】');
    expect(content.startsWith('【最近的对话】\n' + ROWS[0] + '\n' + ROWS[1] + '\n\n【对方的消息】')).toBe(true);
  });

  it('缺省与空数组：该段只剩标题，底下不留一串空行', () => {
    expect(buildReq(CFG, { userText: '你好', botReply: '好的' }).messages[0]?.content).toBe(BASE);
    expect(buildReq(CFG, { userText: '你好', botReply: '好的', history: [] }).messages[0]?.content).toBe(BASE);
    expect(BASE).not.toMatch(/\n{3,}/);
  });

  it('上限 20 条：25 条按 slice(-REACTION_HISTORY_MESSAGES) 只剩最后 20 条，最老的 5 条不进素材', () => {
    expect(REACTION_HISTORY_MESSAGES).toBe(20);

    const many = Array.from({ length: 25 }, (_, index) => '[01-01 10:00] 用户' + String(index) + '(u-' + String(index) + ')：第' + String(index) + '条');
    const kept = many.slice(-REACTION_HISTORY_MESSAGES);
    const content = buildReq(CFG, { userText: '你好', botReply: '好的', history: kept }).messages[0]?.content ?? '';
    const block = content.split('【最近的对话】\n')[1] ?? '';
    const lines = (block.split('\n\n【对方的消息】')[0] ?? '').split('\n');

    expect(lines).toHaveLength(REACTION_HISTORY_MESSAGES);
    expect(lines[0]).toBe(many[5]);
    expect(lines.at(-1)).toBe(many[24]);
    expect(content).not.toContain('第2条');
  });
});

describe('素材模板决定段与段序（§34.3）', () => {
  function material(template: string, extra: { history?: readonly string[]; customEmojis?: CustomEmoji[] } = {}) {
    return (
      buildReactionRequest(CFG, {
        userText: '你好',
        botReply: '好的',
        guide: DEFAULT_REACTION_GUIDE,
        template,
        ...extra,
      }).messages[0]?.content ?? ''
    );
  }

  it('自写模板：段序与段落都按模板来，旧版写死的顺序不再生效', () => {
    expect(material('【我的回复】\n{{我的回复}}\n\n【对方的消息】\n{{对方的消息}}')).toBe(
      '【我的回复】\n好的\n\n【对方的消息】\n你好',
    );
  });

  it('删掉哪段就没有哪段：模板里不写 {{可贴表情的消息}} 时目标清单不出现', () => {
    const content = material('{{我的回复}}');
    expect(content).toBe('好的');

    const withTargets =
      buildReactionRequest(CFG, {
        userText: '你好',
        botReply: '好的',
        guide: DEFAULT_REACTION_GUIDE,
        template: '{{我的回复}}',
        targets: TARGETS,
      }).messages[0]?.content ?? '';
    expect(withTargets).toBe('好的');
  });

  it('{{表情规则}} 也能用：模板想自己放规则就放，system 里那份不受影响', () => {
    const request = buildReactionRequest(CFG, {
      userText: '你好',
      botReply: '好的',
      guide: '规则X',
      template: '{{表情规则}}\n\n{{对方的消息}}',
    });

    expect(request.system).toBe('规则X\n\n' + NO_REACTION_NOTE);
    expect(request.messages[0]?.content).toBe('规则X\n\n你好');
  });
});

describe('normalizeReactions 多行输出（§28.5）', () => {
  it('一行一个：多行 → 多条，顺序保持', () => {
    expect(normalizeReactions('😄\n🔥\n👍')).toEqual([{ emoji: '😄' }, { emoji: '🔥' }, { emoji: '👍' }]);
  });

  it('空行忽略，行内的 @目标 原样带下来', () => {
    expect(normalizeReactions('\n😄@123456789012345678\n\n🔥@卡利亞士兵\n')).toEqual([
      { emoji: '😄', messageId: '123456789012345678' },
      { emoji: '🔥', authorName: '卡利亞士兵' },
    ]);
  });

  it('上限 10 条：第 11 条丢掉', () => {
    const rows = ['😄', '🔥', '👍', '🎉', '😀', '🚀', '🐱', '😁', '😆', '🥲', '🤣'];
    const out = normalizeReactions(rows.join('\n'));

    expect(out).toHaveLength(10);
    expect(out.at(-1)).toEqual({ emoji: '🥲' });
  });

  it('去重按 表情|目标：同键只收一次，同表情不同目标是两条', () => {
    expect(normalizeReactions('🔥\n🔥\n🔥')).toEqual([{ emoji: '🔥' }]);
    expect(normalizeReactions('🔥@123456789012345678\n🔥@卡利亞士兵\n🔥')).toEqual([
      { emoji: '🔥', messageId: '123456789012345678' },
      { emoji: '🔥', authorName: '卡利亞士兵' },
      { emoji: '🔥' },
    ]);
  });

  it('NONE 整段不贴：单独一行 / 多行混着 / 后面跟解释都不产出', () => {
    expect(normalizeReactions('NONE')).toEqual([]);
    expect(normalizeReactions('none\n无\n不贴')).toEqual([]);
    expect(normalizeReactions('NONE 因为没有合适的表情')).toEqual([]);
    expect(normalizeReactions('😄\nNONE')).toEqual([{ emoji: '😄' }]);
    expect(normalizeReactions('')).toEqual([]);
    expect(normalizeReactions('   \n\n')).toEqual([]);
  });

  it('只有解释文字 → 不贴：一行解释换不来一条贴不上的表情', () => {
    expect(normalizeReactions('我觉得这条消息适合贴 😄 因为很开心')).toEqual([]);
    expect(normalizeReactions('不是表情的几个字')).toEqual([]);
    expect(normalizeReactions('Sorry, no suitable emoji here.')).toEqual([]);
  });

  it('模型照抄 [[react:…]]：取指令里的表情，同行的说明文字不算', () => {
    expect(normalizeReactions('[[react:👍]]')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('[[react:👍]] 因为开心')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('就 [[react::猫猫:]] 吧')).toEqual([{ emoji: ':猫猫:' }]);
    expect(normalizeReactions('[[react:👍@123456789012345678]]')).toEqual([{ emoji: '👍', messageId: '123456789012345678' }]);
    expect(normalizeReactions('[[react:👍]][[react:🔥]]')).toEqual([{ emoji: '👍' }, { emoji: '🔥' }]);
  });

  it('引号/反引号包裹的答案仍然认得出，且能剥多层', () => {
    expect(normalizeReactions('\u0060👍\u0060')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('\u0060\u0060👍\u0060\u0060')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('"👍"')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('「👍」')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('\u201c👍\u201d')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('\u0060👍\u0060 因为开心')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('"😄@123456789012345678"')).toEqual([{ emoji: '😄', messageId: '123456789012345678' }]);
  });

  it('含空白时取第一个 token（§21.3 规则 5 不变）', () => {
    expect(normalizeReactions('👍 因为很开心')).toEqual([{ emoji: '👍' }]);
    expect(normalizeReactions('  👍\t🔥 ')).toEqual([{ emoji: '👍' }]);
  });

  it('认得的写法：:名字: / 裸 ASCII 名 / 名字:id / <:名字:id>', () => {
    expect(normalizeReactions(':开心:')).toEqual([{ emoji: ':开心:' }]);
    expect(normalizeReactions('blob')).toEqual([{ emoji: 'blob' }]);
    expect(normalizeReactions('blob:12345')).toEqual([{ emoji: 'blob:12345' }]);
    expect(normalizeReactions('<:blob:12345>')).toEqual([{ emoji: '<:blob:12345>' }]);
    expect(normalizeReactions('不是表情的几个字')).toEqual([]);
  });

  it('整行超过 64 个字符丢掉：§28.3 的上限在解析这一步就管住', () => {
    const exact = ':' + 'a'.repeat(62) + ':';
    expect(normalizeReactions(exact)).toEqual([{ emoji: exact }]);
    expect(normalizeReactions(':' + 'a'.repeat(63) + ':')).toEqual([]);
  });
});

describe('stripNoReactionHead 剥掉正文开头的 NONE', () => {
  it('第一行 NONE + 换行 + 正文 → 只剩正文', () => {
    expect(stripNoReactionHead('NONE\n哼，笨蛋')).toBe('哼，笨蛋');
  });

  it('小写 none / 无 / 不贴 三种同义写法一样剥', () => {
    expect(stripNoReactionHead('none\n哼，笨蛋')).toBe('哼，笨蛋');
    expect(stripNoReactionHead('无\n哼，笨蛋')).toBe('哼，笨蛋');
    expect(stripNoReactionHead('不贴\n哼，笨蛋')).toBe('哼，笨蛋');
  });

  it('NONE 行带行尾空格也认', () => {
    expect(stripNoReactionHead('NONE   \n哼，笨蛋')).toBe('哼，笨蛋');
  });

  it('开头先有空行、NONE 之后还有空行：一起丢掉，剩下的从正文第一行开始', () => {
    expect(stripNoReactionHead('\n\nNONE\n\n哼，笨蛋')).toBe('哼，笨蛋');
  });

  it('整段只有 NONE（后面全是空行也一样）→ 原样返回，绝不把回复变成空串', () => {
    expect(stripNoReactionHead('NONE')).toBe('NONE');
    expect(stripNoReactionHead('NONE\n\n  \n')).toBe('NONE\n\n  \n');
    expect(stripNoReactionHead('   \n\t')).toBe('   \n\t');
  });

  it('正文中间或结尾出现 NONE 不动：只处理头部一行，不做多次剥离', () => {
    expect(stripNoReactionHead('我说 NONE\n再说一句')).toBe('我说 NONE\n再说一句');
    expect(stripNoReactionHead('哼，笨蛋\nNONE')).toBe('哼，笨蛋\nNONE');
  });

  it('不以 NONE 开头 → 原样返回，正文一个字符都不 trim', () => {
    expect(stripNoReactionHead('  哼，笨蛋  ')).toBe('  哼，笨蛋  ');
    expect(stripNoReactionHead('')).toBe('');
  });
});

describe('isOnlyNoReactionMark 认「整段只剩不贴」', () => {
  it('四种写法与带空白的写法都算：NONE / none / 无 / 不贴 / 「  NONE  」', () => {
    for (const text of ['NONE', 'none', '无', '不贴', '  NONE  ']) {
      expect(isOnlyNoReactionMark(text)).toBe(true);
    }
  });

  it('空串、只有空白、带解释的 NONE、正常正文都不算', () => {
    for (const text of ['', '   \n\t ', 'NONE 因为没有', '哼']) {
      expect(isOnlyNoReactionMark(text)).toBe(false);
    }
  });
});
