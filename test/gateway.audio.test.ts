import { describe, expect, it } from 'vitest';
import { MAX_AUDIO_BYTES, collectAudioRefs, loadAudio, narrowAudioAttachments } from '../src/workers/gateway/audio';

function attachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://cdn.example/voice.mp3',
    content_type: 'audio/mpeg',
    size: 1024,
    filename: 'voice.mp3',
    ...overrides,
  };
}

describe('narrowAudioAttachments', () => {
  it('只收 audio/*；content_type 缺省时按扩展名猜；保留 filename', () => {
    const refs = narrowAudioAttachments([
      attachment(),
      attachment({ content_type: '', url: 'https://cdn.example/a.wav' }),
      attachment({ content_type: 'image/png' }),
      attachment({ content_type: 'video/mp4' }),
      attachment({ content_type: '', url: 'https://cdn.example/a.txt' }),
      attachment({ size: 0 }),
      attachment({ size: MAX_AUDIO_BYTES + 1 }),
      attachment({ url: '' }),
    ]);
    expect(refs).toEqual([
      { url: 'https://cdn.example/voice.mp3', mediaType: 'audio/mpeg', size: 1024, filename: 'voice.mp3' },
      { url: 'https://cdn.example/a.wav', mediaType: 'audio/wav', size: 1024, filename: 'voice.mp3' },
    ]);
  });

  it('非数组当空数组；坏字段不抛', () => {
    expect(narrowAudioAttachments(null)).toEqual([]);
    expect(narrowAudioAttachments([null, 'x', 3])).toEqual([]);
  });
});

describe('collectAudioRefs', () => {
  const ref = { url: 'https://cdn.example/a.mp3', mediaType: 'audio/mpeg', size: 10, filename: 'a.mp3' };

  it('当前消息在前、被回复消息在后，最多一条', () => {
    expect(
      collectAudioRefs({
        attachments: [ref],
        replyTo: { attachments: [{ ...ref, url: 'https://cdn.example/b.mp3' }] },
      }),
    ).toEqual([ref]);
    expect(collectAudioRefs({ attachments: [], replyTo: { attachments: [ref] } })).toEqual([ref]);
  });

  it('没有字段时返回空数组', () => {
    expect(collectAudioRefs({ attachments: [] })).toEqual([]);
    expect(collectAudioRefs({ attachments: [], replyTo: null })).toEqual([]);
  });
});

describe('loadAudio', () => {
  it('下载第一条，返回 LlmAudio；非 2xx/空体/抛错都丢掉', async () => {
    const ref = { url: 'https://cdn.example/a.mp3', mediaType: 'audio/mpeg', size: 10, filename: 'a.mp3' };
    const ok = await loadAudio([ref], async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    expect(ok).toEqual([{ data: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg', filename: 'a.mp3' }]);

    const bad = await loadAudio([ref], async () => new Response('nope', { status: 404 }));
    expect(bad).toEqual([]);

    const empty = await loadAudio([ref], async () => new Response(new Uint8Array(), { status: 200 }));
    expect(empty).toEqual([]);

    const thrown = await loadAudio([ref], async () => {
      throw new Error('network down');
    });
    expect(thrown).toEqual([]);
  });
});
