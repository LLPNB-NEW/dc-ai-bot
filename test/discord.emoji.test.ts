import { describe, expect, it } from 'vitest';
import { resolveInlineEmojis, resolveReactionEmoji } from '../src/workers/discord/emoji';

const CATALOG = [
  { name: 'blob', id: '123' },
  { name: 'dance', id: '456', animated: true },
];

describe('正文自定义表情渲染（§18.8）', () => {
  it('命中清单的 :名字: 换成 <:名字:id>，animated 用 <a:名字:id>', () => {
    expect(resolveInlineEmojis('好的 :blob: 和 :dance:', CATALOG)).toBe('好的 <:blob:123> 和 <a:dance:456>');
  });

  it('同一个表情出现多次全部替换', () => {
    expect(resolveInlineEmojis(':blob::blob:', CATALOG)).toBe('<:blob:123><:blob:123>');
  });

  it('清单里没有的名字原样保留', () => {
    expect(resolveInlineEmojis('看 :missing: 呀', CATALOG)).toBe('看 :missing: 呀');
  });

  it('已经成型的标记不会被二次替换', () => {
    expect(resolveInlineEmojis('原来 <:blob:999> 与 <a:dance:888>', CATALOG)).toBe('原来 <:blob:999> 与 <a:dance:888>');
  });

  it('空文本、空清单、名字全空白都原样返回', () => {
    expect(resolveInlineEmojis('', CATALOG)).toBe('');
    expect(resolveInlineEmojis(':blob:', [])).toBe(':blob:');
    expect(resolveInlineEmojis(':blob:', [{ name: '   ', id: '1' }])).toBe(':blob:');
  });

  it('同名多个只取第一个；名字两端空格被裁掉', () => {
    expect(
      resolveInlineEmojis(':blob:', [
        { name: 'blob', id: '1' },
        { name: 'blob', id: '2' },
      ]),
    ).toBe('<:blob:1>');
    expect(resolveInlineEmojis(':blob:', [{ name: '  blob  ', id: '9' }])).toBe('<:blob:9>');
  });

  it('普通文字与时间戳前缀原样不动', () => {
    expect(resolveInlineEmojis('[10-25 11:00] cat(1)：看 :blob:', CATALOG)).toBe(
      '[10-25 11:00] cat(1)：看 <:blob:123>',
    );
  });
});


describe('贴表情值的解析（§18.6）', () => {
  it('模型写清单里的名字（不带冒号）也认：换成 name:id，大小写不敏感', () => {
    expect(resolveReactionEmoji('OMG', [{ name: 'OMG', id: '999' }])).toBe('OMG:999');
    expect(resolveReactionEmoji('omg', [{ name: 'OMG', id: '999' }])).toBe('OMG:999');
    expect(resolveReactionEmoji('  blob  ', CATALOG)).toBe('blob:123');
  });

  it(':名字: 带冒号同样认；清单里没有就跳过（返回 null）', () => {
    expect(resolveReactionEmoji(':blob:', CATALOG)).toBe('blob:123');
    expect(resolveReactionEmoji(':missing:', CATALOG)).toBeNull();
    expect(resolveReactionEmoji('Missing', CATALOG)).toBeNull();
  });

  it('unicode 表情原样返回，冒号包着也认', () => {
    expect(resolveReactionEmoji('👍', CATALOG)).toBe('👍');
    expect(resolveReactionEmoji('❤️', CATALOG)).toBe('❤️');
    expect(resolveReactionEmoji(':🎉:', CATALOG)).toBe('🎉');
  });

  it('name:id 与 <:名字:id> 规范化成 name:id', () => {
    expect(resolveReactionEmoji('blob:123', CATALOG)).toBe('blob:123');
    expect(resolveReactionEmoji('<:blob:123>', CATALOG)).toBe('blob:123');
    expect(resolveReactionEmoji('<a:dance:456>', CATALOG)).toBe('dance:456');
  });

  it('空串、只有冒号、非 ASCII 且不在清单里的一律返回 null（不发给 Discord）', () => {
    expect(resolveReactionEmoji('', CATALOG)).toBeNull();
    expect(resolveReactionEmoji('::', CATALOG)).toBeNull();
    expect(resolveReactionEmoji(':中文名:', CATALOG)).toBeNull();
  });
});

describe('表情别名（§24.5）：真名优先，输出永远是真的表情名', () => {
  const LAUGH = { name: 'laugh', id: '150000000000000003', aliases: ['奶龙'] };

  it('中文别名写得出来：:奶龙: 渲染成真实表情 <:laugh:id>', () => {
    expect(resolveInlineEmojis('好的 :奶龙: 呀', [LAUGH])).toBe('好的 <:laugh:150000000000000003> 呀');
  });

  it('别名大小写不敏感，输出仍是真名', () => {
    const emoji = { name: 'laugh', id: '111', aliases: ['NaiLong'] };
    expect(resolveInlineEmojis(':nailong:', [emoji])).toBe('<:laugh:111>');
    expect(resolveInlineEmojis(':NAILONG:', [emoji])).toBe('<:laugh:111>');
    expect(resolveReactionEmoji('nailong', [emoji])).toBe('laugh:111');
    expect(resolveReactionEmoji(':NaiLong:', [emoji])).toBe('laugh:111');
  });

  it('真名优先于别名：别名撞到别的表情真名时，真名说了算', () => {
    const catalog = [
      { name: 'laugh', id: '1' },
      { name: 'wow', id: '2', aliases: ['laugh'] },
    ];
    expect(resolveInlineEmojis(':laugh:', catalog)).toBe('<:laugh:1>');
    expect(resolveReactionEmoji('laugh', catalog)).toBe('laugh:1');
    // 连大小写都算撞名：真名 Laugh 的存在让别名 laugh 不进表
    const cased = [
      { name: 'Laugh', id: '3' },
      { name: 'wow', id: '4', aliases: ['laugh'] },
    ];
    expect(resolveReactionEmoji('laugh', cased)).toBe('Laugh:3');
    // 正文同理：真名 Laugh 占住小写 laugh，别名抢不走（:laugh: 原样留着）
    expect(resolveInlineEmojis(':laugh:', cased)).toBe(':laugh:');
  });

  it('别名指的表情不在清单里：静默保持原样 / 返回 null', () => {
    expect(resolveInlineEmojis('看 :奶龙: 呀', CATALOG)).toBe('看 :奶龙: 呀');
    expect(resolveReactionEmoji('奶龙', CATALOG)).toBeNull();
    expect(resolveReactionEmoji(':奶龙:', CATALOG)).toBeNull();
  });

  it('animated 的别名同样用 <a:真名:id>；别名两端的空白与空别名被忽略', () => {
    const catalog = [{ name: 'dance', id: '456', animated: true, aliases: [' 小黄龙 ', ''] }];
    expect(resolveInlineEmojis(':小黄龙:', catalog)).toBe('<a:dance:456>');
    expect(resolveReactionEmoji(' 小黄龙 ', catalog)).toBe('dance:456');
  });

  it('别名数组缺省等于没有别名（§18.8 老行为逐字不变）', () => {
    expect(resolveInlineEmojis(':blob:', CATALOG)).toBe('<:blob:123>');
    expect(resolveInlineEmojis(':奶龙:', [{ name: 'laugh', id: '1', aliases: [] }])).toBe(':奶龙:');
  });
});
