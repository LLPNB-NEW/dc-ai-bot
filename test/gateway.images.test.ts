/**
 * §22.4 网关图片：附件窄化、按扩展名兜底、5MB 与 4 张两个上限、分块 base64、下载失败降级。
 *
 * 这一层全是纯函数加注入式 fetch：不许出网，更不许因为一张图失败而抛错影响文字。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  collectImageRefs,
  loadImages,
  narrowAttachments,
  toBase64,
  type ImageRef,
  type ImageSource,
} from '../src/workers/gateway/images';

const CDN = 'https://cdn.test/';

function ref(url: string, size = 1024, mediaType = 'image/png'): ImageRef {
  return { url: CDN + url, mediaType, size };
}

/** 自己 + 被回复：两个数组都齐全的那种形状 */
function source(own: ImageRef[], replied: ImageRef[] = []): ImageSource {
  return { attachments: own, replyTo: { attachments: replied } };
}

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function imageFetch(calls: string[], responder?: (url: string) => Response | undefined): typeof fetch {
  return (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const custom = responder?.(url);
    if (custom !== undefined) return Promise.resolve(custom);
    return Promise.resolve(new Response(new Uint8Array([104, 105])));
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectImageRefs', () => {
  it('顺序：本条消息的附件在前，被回复消息的附件在后', () => {
    const refs = collectImageRefs(
      source([ref('own-1.png'), ref('own-2.jpg', 2048, 'image/jpeg')], [ref('reply-1.webp', 4096, 'image/webp')]),
    );
    expect(refs.map((entry) => entry.url)).toEqual([CDN + 'own-1.png', CDN + 'own-2.jpg', CDN + 'reply-1.webp']);
    expect(refs.map((entry) => entry.mediaType)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });

  it('非 image/* 类型丢弃：内容类型说了不是图，扩展名像图片也不留（§22.8）', () => {
    const refs = collectImageRefs({
      attachments: [
        ref('clip.png', 1024, 'video/mp4'),
        ref('note.txt', 1024, 'text/plain'),
        ref('voice.ogg', 1024, 'audio/ogg'),
        ref('ok.webp', 1024, 'image/webp'),
      ],
    });
    expect(refs.map((entry) => entry.url)).toEqual([CDN + 'ok.webp']);
  });

  it('mediaType 缺失（空串）时按扩展名兜底，猜不出就丢；查询串与大小写不干扰判定', () => {
    const refs = collectImageRefs({
      attachments: [
        ref('a.png', 10, ''),
        ref('b.JPEG', 10, ''),
        ref('c.webp?ex=1&is=2&hm=abc', 10, ''),
        ref('d.gif#frag', 10, ''),
        ref('e.bin', 10, ''),
        ref('f', 10, ''),
      ],
    });
    expect(refs.map((entry) => entry.url)).toEqual([
      CDN + 'a.png',
      CDN + 'b.JPEG',
      CDN + 'c.webp?ex=1&is=2&hm=abc',
      CDN + 'd.gif#frag',
    ]);
    expect(refs.map((entry) => entry.mediaType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ]);
  });

  it('超过 5MB 或非正数的丢弃，正好 5MB 保留（§22.1）', () => {
    const refs = collectImageRefs({
      attachments: [
        ref('big.png', MAX_IMAGE_BYTES + 1),
        ref('zero.png', 0),
        ref('negative.png', -1),
        ref('edge.png', MAX_IMAGE_BYTES),
      ],
    });
    expect(refs.map((entry) => entry.url)).toEqual([CDN + 'edge.png']);
  });

  it('超过 ' + String(MAX_IMAGES) + ' 张截断：自己的图先占名额', () => {
    const own = [1, 2, 3].map((index) => ref('own-' + String(index) + '.png'));
    const replied = [1, 2, 3].map((index) => ref('reply-' + String(index) + '.png'));
    const refs = collectImageRefs(source(own, replied));

    expect(refs).toHaveLength(MAX_IMAGES);
    expect(refs.map((entry) => entry.url)).toEqual([
      CDN + 'own-1.png',
      CDN + 'own-2.png',
      CDN + 'own-3.png',
      CDN + 'reply-1.png',
    ]);
  });

  it('自己就超员时，被回复消息的图一张都进不来', () => {
    const own = [1, 2, 3, 4, 5].map((index) => ref('own-' + String(index) + '.png'));
    const refs = collectImageRefs(source(own, [ref('reply-1.png')]));
    expect(refs.map((entry) => entry.url)).toEqual([
      CDN + 'own-1.png',
      CDN + 'own-2.png',
      CDN + 'own-3.png',
      CDN + 'own-4.png',
    ]);
  });

  it('缺失字段不抛错：没有 replyTo、replyTo 里没有 attachments、replyTo 为 null', () => {
    expect(collectImageRefs({ attachments: [] })).toEqual([]);
    expect(collectImageRefs({ attachments: [], replyTo: {} })).toEqual([]);
    expect(collectImageRefs({ attachments: [], replyTo: null })).toEqual([]);
    expect(collectImageRefs({ attachments: [ref('only.png')], replyTo: {} })).toEqual([ref('only.png')]);
  });

  it('url 为空的条目不下载也不算一张图', () => {
    expect(collectImageRefs({ attachments: [{ url: '', mediaType: 'image/png', size: 10 }] })).toEqual([]);
  });
});

describe('narrowAttachments（原始载荷 → ImageRef）', () => {
  it('url / content_type / size 齐全时收下，字段名换成 mediaType', () => {
    expect(narrowAttachments([{ url: CDN + 'a.png', content_type: 'image/png', size: 1024 }])).toEqual([
      { url: CDN + 'a.png', mediaType: 'image/png', size: 1024 },
    ]);
  });

  it('缺 content_type 时按扩展名猜；给了非 image/* 就丢', () => {
    expect(
      narrowAttachments([
        { url: CDN + 'guess.jpg', size: 10 },
        { url: CDN + 'guess.GIF', size: 10 },
        { url: CDN + 'weird.png', content_type: 'video/mp4', size: 10 },
        { url: CDN + 'nothing.bin', size: 10 },
      ]),
    ).toEqual([
      { url: CDN + 'guess.jpg', mediaType: 'image/jpeg', size: 10 },
      { url: CDN + 'guess.GIF', mediaType: 'image/gif', size: 10 },
    ]);
  });

  it('size 缺失、非数字、零、负数、超限一律丢；正好 5MB 保留', () => {
    expect(
      narrowAttachments([
        { url: CDN + 'no-size.png', content_type: 'image/png' },
        { url: CDN + 'string-size.png', content_type: 'image/png', size: '1024' },
        { url: CDN + 'zero.png', content_type: 'image/png', size: 0 },
        { url: CDN + 'negative.png', content_type: 'image/png', size: -5 },
        { url: CDN + 'big.png', content_type: 'image/png', size: MAX_IMAGE_BYTES + 1 },
        { url: CDN + 'edge.png', content_type: 'image/png', size: MAX_IMAGE_BYTES },
      ]),
    ).toEqual([{ url: CDN + 'edge.png', mediaType: 'image/png', size: MAX_IMAGE_BYTES }]);
  });

  it('非数组（undefined / null / 对象 / 字符串）都当空数组，不抛错', () => {
    expect(narrowAttachments(undefined)).toEqual([]);
    expect(narrowAttachments(null)).toEqual([]);
    expect(narrowAttachments({ url: CDN + 'a.png' })).toEqual([]);
    expect(narrowAttachments('nope')).toEqual([]);
  });

  it('坏条目跳过，其余照收', () => {
    expect(
      narrowAttachments([
        'nope',
        null,
        { url: 123, content_type: 'image/png', size: 10 },
        { url: '', content_type: 'image/png', size: 10 },
        { url: CDN + 'ok.png', content_type: 'image/png', size: 10 },
      ]),
    ).toEqual([{ url: CDN + 'ok.png', mediaType: 'image/png', size: 10 }]);
  });
});

describe('toBase64', () => {
  it('已知字节：hi → aGk=', () => {
    expect(toBase64(bytes([104, 105]))).toBe('aGk=');
  });

  it('空字节 → 空串', () => {
    expect(toBase64(bytes([]))).toBe('');
  });

  it('跨过 8KB 分块边界：长度符合 4*ceil(n/3)，且与一次性编码逐字相同', () => {
    const values = Array.from({ length: 20000 }, (_value, index) => index % 256);
    const encoded = toBase64(bytes(values));
    expect(encoded).toHaveLength(26668);
    expect(encoded).toBe(btoa(String.fromCharCode(...values)));
  });
});

describe('loadImages', () => {
  it('成功两张：按 refs 顺序返回 LlmImage，base64 不带 data: 前缀也不含换行', async () => {
    const calls: string[] = [];
    const images = await loadImages(
      [ref('a.png'), ref('b.jpg', 512, 'image/jpeg')],
      imageFetch(calls, (url) =>
        url === CDN + 'b.jpg' ? new Response(new Uint8Array([1, 2, 3])) : undefined,
      ),
    );

    expect(calls).toEqual([CDN + 'a.png', CDN + 'b.jpg']);
    expect(images).toEqual([
      { mediaType: 'image/png', base64: 'aGk=' },
      { mediaType: 'image/jpeg', base64: toBase64(bytes([1, 2, 3])) },
    ]);
    for (const image of images) {
      expect(image.base64.startsWith('data:')).toBe(false);
      expect(image.base64.includes('\n')).toBe(false);
    }
  });

  it('单张 500 跳过其余照收，warn 文案逐字带 [gateway] 图片下载失败：', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});
    const calls: string[] = [];
    const images = await loadImages(
      [ref('bad.png'), ref('good.png')],
      imageFetch(calls, (url) => (url === CDN + 'bad.png' ? new Response('boom', { status: 500 }) : undefined)),
    );

    expect(calls).toEqual([CDN + 'bad.png', CDN + 'good.png']);
    expect(images).toEqual([{ mediaType: 'image/png', base64: 'aGk=' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[gateway] 图片下载失败：' + CDN + 'bad.png');
  });

  it('抛错的那张跳过，后续照常下载', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});
    const calls: string[] = [];
    const images = await loadImages([ref('throws.png'), ref('ok.png')], (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === CDN + 'throws.png') return Promise.reject(new Error('network down'));
      return Promise.resolve(new Response(new Uint8Array([104, 105])));
    });

    expect(calls).toEqual([CDN + 'throws.png', CDN + 'ok.png']);
    expect(images).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('[gateway] 图片下载失败：' + CDN + 'throws.png');
  });

  it('空体跳过并 warn，不算一张图', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => {});
    const images = await loadImages(
      [ref('empty.png')],
      imageFetch([], () => new Response(null, { status: 200 })),
    );

    expect(images).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[gateway] 图片下载失败：' + CDN + 'empty.png');
  });

  it('全部失败时返回空数组（绝不抛错）', async () => {
    vi.spyOn(console, 'warn').mockImplementation((): void => {});
    const images = await loadImages(
      [ref('a.png'), ref('b.png')],
      imageFetch([], () => new Response('nope', { status: 403 })),
    );
    expect(images).toEqual([]);
  });

  it('refs 为空时一次 fetch 都不发（懒加载的下限）', async () => {
    const calls: string[] = [];
    await expect(loadImages([], imageFetch(calls))).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});
