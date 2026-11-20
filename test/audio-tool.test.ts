import { describe, expect, it } from 'vitest';
import type { LlmAudio, TurnAudio } from '../src/core/types';
import {
  MUSIC_TOOL_NAME,
  SFX_TOOL_NAME,
  VOICE_CHANGE_TOOL_NAME,
  audioCallOf,
  audioToolsFor,
  executeAudioCall,
  presetMentionsAudioTool,
} from '../src/core/chat/audio-tool';
import type { AudioToolPort } from '../src/core/voice/audio';

const AUDIO: TurnAudio = {
  data: new Uint8Array([1, 2, 3]),
  mime: 'audio/mpeg',
  name: 'music.mp3',
  kind: 'music',
  prompt: 'test',
};

function fake(overrides: Partial<AudioToolPort> = {}): AudioToolPort {
  return {
    available: async () => true,
    music: async () => AUDIO,
    soundEffect: async () => ({ ...AUDIO, kind: 'sound_effect', name: 'sound.mp3' }),
    changeVoice: async () => ({ ...AUDIO, kind: 'voice_change', name: 'voice-change.mp3' }),
    ...overrides,
  };
}

describe('音频工具定义与门控', () => {
  it('只有预设点名才下发对应工具', () => {
    expect(audioToolsFor('普通预设')).toEqual([]);
    expect(audioToolsFor('想唱歌时调用 compose_music。').map((tool) => tool.function.name)).toEqual([
      MUSIC_TOOL_NAME,
    ]);
    expect(
      audioToolsFor('唱：compose_music；音效：sound_effect；变声：change_voice。').map(
        (tool) => tool.function.name,
      ),
    ).toEqual([MUSIC_TOOL_NAME, SFX_TOOL_NAME, VOICE_CHANGE_TOOL_NAME]);
    expect(presetMentionsAudioTool('sound_effect')).toBe(true);
    expect(presetMentionsAudioTool('普通预设')).toBe(false);
  });
});

describe('audioCallOf', () => {
  it('解析 music 的 prompt/lyrics/duration，并截断超长输入', () => {
    const call = audioCallOf([
      {
        name: MUSIC_TOOL_NAME,
        arguments: JSON.stringify({
          prompt: '  一首歌  ',
          lyrics: '  歌词  ',
          duration_seconds: 45,
        }),
      },
    ]);
    expect(call).toEqual({ kind: 'music', prompt: '一首歌', lyrics: '歌词', durationSeconds: 45 });

    const long = audioCallOf([
      { name: MUSIC_TOOL_NAME, arguments: JSON.stringify({ prompt: 'p'.repeat(5_000), lyrics: 'l'.repeat(5_000) }) },
    ]);
    expect(long?.kind).toBe('music');
    if (long?.kind === 'music') {
      expect(long.prompt).toHaveLength(4_100);
      expect(long.lyrics).toHaveLength(4_000);
    }
  });

  it('音效解析、voice_change 不需要参数、坏 JSON/空 prompt 返回 null', () => {
    expect(
      audioCallOf([{ name: SFX_TOOL_NAME, arguments: JSON.stringify({ prompt: '  雨声  ', duration_seconds: 6 }) }]),
    ).toEqual({ kind: 'sound_effect', prompt: '雨声', durationSeconds: 6 });
    expect(audioCallOf([{ name: VOICE_CHANGE_TOOL_NAME, arguments: '{}' }])).toEqual({ kind: 'voice_change' });
    expect(audioCallOf([{ name: MUSIC_TOOL_NAME, arguments: 'not json' }])).toBeNull();
    expect(audioCallOf([{ name: MUSIC_TOOL_NAME, arguments: '{"prompt":"  "}' }])).toBeNull();
    expect(audioCallOf([{ name: 'unknown', arguments: '{}' }])).toBeNull();
  });
});

describe('executeAudioCall', () => {
  it('music 透传参数；sound_effect 透传时长', async () => {
    const seen: unknown[] = [];
    const port = fake({
      music: async (input) => {
        seen.push(input);
        return AUDIO;
      },
      soundEffect: async (input) => {
        seen.push(input);
        return { ...AUDIO, kind: 'sound_effect' };
      },
    });
    await executeAudioCall(port, { kind: 'music', prompt: 'p', lyrics: 'l', durationSeconds: 10 });
    await executeAudioCall(port, { kind: 'sound_effect', prompt: 's', durationSeconds: 2 });
    expect(seen).toEqual([
      { prompt: 'p', lyrics: 'l', durationSeconds: 10 },
      { prompt: 's', durationSeconds: 2 },
    ]);
  });

  it('voice_change 从 loadAudio 取第一条；没有源音频就抛 AUDIO_SOURCE_MISSING', async () => {
    const sources: LlmAudio[] = [{ data: new Uint8Array([9]), mediaType: 'audio/mpeg', filename: 'a.mp3' }];
    const port = fake({
      changeVoice: async ({ source }) => ({ ...AUDIO, kind: 'voice_change', name: source.filename }),
    });
    const result = await executeAudioCall(port, { kind: 'voice_change' }, async () => sources);
    expect(result.name).toBe('a.mp3');

    await expect(executeAudioCall(port, { kind: 'voice_change' }, async () => [])).rejects.toThrow(
      'AUDIO_SOURCE_MISSING',
    );
    await expect(executeAudioCall(port, { kind: 'voice_change' })).rejects.toThrow('AUDIO_SOURCE_MISSING');
  });
});
