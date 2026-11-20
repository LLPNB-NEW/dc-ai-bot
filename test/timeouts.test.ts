import { afterEach, describe, expect, it } from 'vitest';
import {
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
  TIMEOUT_FIELDS,
  applyTimeoutOverrides,
  judgeTimeoutMs,
  resetTimeouts,
  resolveTimeout,
  timeoutDefaults,
  timeoutSettings,
} from '../src/core/timeouts';

const ENV_NAMES = TIMEOUT_FIELDS.map((field) => field.env);
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  resetTimeouts();
});

describe('超时配置：默认值来自环境变量，后台覆盖叠在上面', () => {
  it('没有任何环境变量时用内置默认', () => {
    for (const name of ENV_NAMES) delete process.env[name];
    delete process.env.TIMEOUT_MULTIPLIER;
    resetTimeouts();
    const settings = timeoutSettings();
    expect(settings.llm).toBe(180_000);
    expect(settings.image).toBe(180_000);
    expect(settings.tts).toBe(30_000);
    expect(settings.ttsGemini).toBe(120_000);
    expect(settings.judgeFloor).toBe(15_000);
    expect(settings.judgePerChar).toBe(40);
    expect(settings.judgeCap).toBe(45_000);
    expect(settings.pgErrors).toBe(5_000);
    expect(settings.shutdown).toBe(25_000);
    expect(settings.multiplier).toBe(1);
  });

  it('环境变量能改基线，越界会被夹到该字段的上下限', () => {
    setEnv('LLM_TIMEOUT_MS', '240000');
    setEnv('TTS_TIMEOUT_MS', '1');
    resetTimeouts();
    expect(timeoutSettings().llm).toBe(240_000);
    expect(timeoutSettings().tts).toBe(5_000);
    expect(timeoutDefaults().llm).toBe(240_000);
  });

  it('后台覆盖整份替换，倍率乘在基线之上', () => {
    applyTimeoutOverrides({ llm: 60_000, tts: 20_000, multiplier: 2 });
    expect(resolveTimeout('llm')).toBe(120_000);
    expect(resolveTimeout('tts')).toBe(40_000);
    expect(resolveTimeout('image')).toBe(360_000);
  });

  it('倍率与单项都会被夹在上下限里', () => {
    applyTimeoutOverrides({ multiplier: 999 });
    expect(timeoutSettings().multiplier).toBe(MULTIPLIER_MAX);
    expect(resolveTimeout('llm')).toBe(600_000);
    applyTimeoutOverrides({ multiplier: -1 });
    expect(timeoutSettings().multiplier).toBe(MULTIPLIER_MIN);
    applyTimeoutOverrides({ judgePerChar: 10_000 });
    expect(timeoutSettings().judgePerChar).toBe(500);
  });

  it('保存即生效：apply 之后 resolve 立刻是新值，reset 回默认', () => {
    expect(resolveTimeout('pgErrors')).toBe(5_000);
    applyTimeoutOverrides({ pgErrors: 9_000 });
    expect(resolveTimeout('pgErrors')).toBe(9_000);
    resetTimeouts();
    expect(resolveTimeout('pgErrors')).toBe(5_000);
  });

  it('语气评审按字数加预算，封顶由上限管', () => {
    applyTimeoutOverrides({ judgeFloor: 15_000, judgePerChar: 40, judgeCap: 45_000 });
    expect(judgeTimeoutMs(0)).toBe(15_000);
    expect(judgeTimeoutMs(100)).toBe(19_000);
    expect(judgeTimeoutMs(10_000)).toBe(45_000);
  });

  it('倍率同样作用于语气评审的三档', () => {
    applyTimeoutOverrides({ multiplier: 2 });
    expect(judgeTimeoutMs(100)).toBe(38_000);
  });
});
