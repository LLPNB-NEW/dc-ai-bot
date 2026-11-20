import { describe, expect, it } from 'vitest';
import type { PromptItem } from './api';
import {
  defaultPresetNameFromLayer,
  parseMemoryNumber,
  parsePresetConfig,
  qqPresetInputFromPromptLayer,
} from './pages/QqPage';

// 这个仓库的 web 测试跑在 @cloudflare/vitest-pool-workers（workerd）里，没有 jsdom，
// react-dom/server 在该环境会解析出第二份 React（useState dispatcher 为 null），
// 因此不渲染整页，只验页面里承担校验逻辑的纯函数。

describe('QQ 管理页的输入校验', () => {
  it('消息条数：空串与非纯数字视为未填，非负整数原样返回', () => {
    expect(parseMemoryNumber('')).toBeNull();
    expect(parseMemoryNumber('0')).toBe(0);
    expect(parseMemoryNumber('80')).toBe(80);
    expect(parseMemoryNumber('-1')).toBeNull();
    expect(parseMemoryNumber('1.5')).toBeNull();
    expect(parseMemoryNumber('80条')).toBeNull();
  });

  it('预设 JSON：合法 PromptConfig 通过并补 position；缺字段时报出是第几段', () => {
    const config = parsePresetConfig(
      JSON.stringify({
        segments: [
          { id: 'seg-1', name: '主体', role: 'system', content: '你是群友。', enabled: true, placement: 'before' },
        ],
        temperature: 0.7,
      }),
    );
    expect(config.segments).toHaveLength(1);
    expect(config.segments[0]?.position).toBe(0);
    expect(config.temperature).toBe(0.7);

    expect(() => parsePresetConfig('{')).toThrow('JSON');
    expect(() => parsePresetConfig('{"segments":{}}')).toThrow('segments 数组');
    expect(() => parsePresetConfig(JSON.stringify({ segments: [] }))).toThrow('至少要有一段');
    expect(() => parsePresetConfig(JSON.stringify({ segments: [{ role: 'system' }] }))).toThrow(
      '第 1 段缺少非空的 id',
    );
    expect(() =>
      parsePresetConfig(
        JSON.stringify({
          segments: [{ id: 'a', role: 'tool', content: '', enabled: true, placement: 'before' }],
        }),
      ),
    ).toThrow('缺少非空的 name');
    expect(() =>
      parsePresetConfig(
        JSON.stringify({
          segments: [{ id: 'a', name: '主体', role: 'tool', content: '', enabled: true, placement: 'before' }],
        }),
      ),
    ).toThrow('role 只能是 system 或 user');
  });

  it('从 Discord 提示词层复制：保留段与采样参数，名称留空按层命名', () => {
    const layer: PromptItem = {
      scope: 'guild',
      scopeId: '123456789012345678',
      segments: [
        {
          id: 'seg-1',
          name: '主体',
          role: 'system',
          content: '你是群友。',
          enabled: true,
          placement: 'before',
          position: 0,
        },
      ],
      temperature: 0.7,
      maxTokens: 8000,
    };
    const input = qqPresetInputFromPromptLayer(layer, '   ');
    expect(input.name).toBe('DC 复制 · 服务器 123456789012345678');
    expect(input.config.temperature).toBe(0.7);
    expect(input.config.maxTokens).toBe(8000);
    expect(input.config.segments).toHaveLength(1);
    expect(input.config.segments[0]?.content).toBe('你是群友。');
    expect(input.config.segments).not.toBe(layer.segments);
    expect(qqPresetInputFromPromptLayer(layer, ' 群里的人格 ').name).toBe('群里的人格');
    expect(defaultPresetNameFromLayer({ ...layer, scope: 'global', scopeId: '' })).toBe('DC 复制 · 全局');
  });
});
