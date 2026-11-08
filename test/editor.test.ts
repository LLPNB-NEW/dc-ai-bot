import { describe, expect, it } from 'vitest';
import {
  REVEAL_MAX_STEPS,
  REVEAL_MIN_GAIN_CHARS,
  createProgressiveEditor,
  type Clock,
  type ProgressiveEditor,
} from '../src/workers/discord/editor';

/**
 * §29 渐进编辑的假流式：整段正文一次性到手时也要按节奏分片挤出去。
 * 时钟是注入的，这里给一个只记时长、不真睡的假实现 —— 真 sleep 会让这套用例跑满十几秒。
 */
interface FakeClock extends Clock {
  /** 每次 sleep 的时长，按调用顺序 */
  sleeps: number[];
  /** 累计睡了多少毫秒 */
  totalSlept: number;
}

function createFakeClock(): FakeClock {
  let now = 0;
  const clock: FakeClock = {
    sleeps: [],
    totalSlept: 0,
    now: () => now,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.totalSlept += ms;
      now += ms;
    },
  };
  return clock;
}

interface Sent {
  content: string;
  at: number;
}

interface Harness {
  clock: FakeClock;
  sends: Sent[];
  errors: unknown[];
  editor: ProgressiveEditor;
}

interface HarnessConfig {
  intervalMs?: number;
  maxEdits?: number;
  maxChars?: number;
  /** 假流式切片次数（§38 的后台配置）：不传就按 REVEAL_MAX_STEPS */
  revealSteps?: number;
  /** 第一次 send 抛错，用来验证一次 PATCH 失败不会吞掉最终全文 */
  failFirstSend?: boolean;
}

function createHarness(config: HarnessConfig = {}): Harness {
  const clock = createFakeClock();
  const sends: Sent[] = [];
  const errors: unknown[] = [];
  let failed = false;
  const editor = createProgressiveEditor({
    send: async (content: string) => {
      if (config.failFirstSend === true && !failed) {
        failed = true;
        throw new Error('PATCH 失败');
      }
      sends.push({ content, at: clock.now() });
    },
    clock,
    intervalMs: config.intervalMs ?? 1200,
    maxEdits: config.maxEdits ?? 12,
    maxChars: config.maxChars ?? 1900,
    revealSteps: config.revealSteps,
    onError: (error: unknown) => errors.push(error),
  });
  return { clock, sends, errors, editor };
}

/** push 的发送排在内部队列里（不阻塞调用方）：这里把微任务队列跑空，等那次发送落地 */
async function drainQueue(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('渐进编辑：节流与收尾（§29）', () => {
  it('push 一段再 finish：相邻两次 send 至少隔 intervalMs，次数不超过 maxEdits，最后一条是全文', async () => {
    const { editor, sends } = createHarness();
    editor.push('甲'.repeat(200));
    await drainQueue();
    expect(sends).toHaveLength(1);
    await editor.finish('甲'.repeat(400));

    expect(sends.length).toBeGreaterThan(2);
    expect(sends.length).toBeLessThanOrEqual(12);
    expect(sends[sends.length - 1]!.content).toBe('甲'.repeat(400));
    for (let index = 1; index < sends.length; index += 1) {
      expect(sends[index]!.at - sends[index - 1]!.at).toBeGreaterThanOrEqual(1200);
    }
  });
});

describe('假流式：整段到手后切片挤出去', () => {
  it('零次 push 直接 finish 长文本：分多次发送、每条都是前缀且更长、最后一条是全文', async () => {
    const { editor, sends } = createHarness();
    const text = '乙'.repeat(400);
    await editor.finish(text);

    expect(sends.length).toBeGreaterThan(2);
    expect(sends.length).toBeLessThanOrEqual(REVEAL_MAX_STEPS + 1);
    expect(sends[sends.length - 1]!.content).toBe(text);
    for (const [index, sent] of sends.entries()) {
      expect(text.startsWith(sent.content)).toBe(true);
      if (index > 0) expect(sent.content.length).toBeGreaterThan(sends[index - 1]!.content.length);
    }
  });

  it('短文本不动画：不到阈值就一次给全文', async () => {
    const { editor, sends, clock } = createHarness();
    const text = '丙'.repeat(REVEAL_MIN_GAIN_CHARS - 4);
    await editor.finish(text);

    expect(sends).toHaveLength(1);
    expect(sends[0]!.content).toBe(text);
    expect(clock.sleeps).toHaveLength(0);
  });

  it('预算不够也保证全文：maxEdits=2 时只收尾一次，内容仍是全文', async () => {
    const { editor, sends } = createHarness({ maxEdits: 2 });
    const text = '丁'.repeat(400);
    await editor.finish(text);

    expect(sends).toHaveLength(1);
    expect(sends[0]!.content).toBe(text);
  });

  it('真流式已经追到全文：finish 不再重复发送', async () => {
    const { editor, sends } = createHarness();
    const text = '戊'.repeat(400);
    editor.push(text);
    await drainQueue();
    const before = sends.length;
    expect(before).toBe(1);
    await editor.finish(text);

    expect(sends).toHaveLength(before);
    expect(sends[0]!.content).toBe(text);
  });

  it('send 抛错：只记进 onError，不抛出，最终全文仍然发出去', async () => {
    const { editor, sends, errors } = createHarness({ failFirstSend: true });
    const text = '己'.repeat(400);
    await expect(editor.finish(text)).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(sends[sends.length - 1]!.content).toBe(text);
  });

  it('时间上界：假流式的累计等待不超过 (REVEAL_MAX_STEPS + 1) * intervalMs', async () => {
    const { editor, clock } = createHarness();
    editor.push('庚'.repeat(200));
    await drainQueue();
    await editor.finish('庚'.repeat(400));

    expect(clock.totalSlept).toBeLessThanOrEqual((REVEAL_MAX_STEPS + 1) * 1200);
  });

  it('revealSteps: 0 = 关闭假流式：只发一次，内容就是全文，一秒都不等', async () => {
    const { editor, sends, clock } = createHarness({ revealSteps: 0 });
    const text = '辛'.repeat(400);
    await editor.finish(text);

    expect(sends).toHaveLength(1);
    expect(sends[0]!.content).toBe(text);
    expect(clock.sleeps).toHaveLength(0);
  });

  it('revealSteps: 2：切两片再收尾，共三次发送，最后一条是全文', async () => {
    const { editor, sends } = createHarness({ revealSteps: 2 });
    const text = '壬'.repeat(400);
    await editor.finish(text);

    expect(sends).toHaveLength(3);
    expect(sends[sends.length - 1]!.content).toBe(text);
    for (const [index, sent] of sends.entries()) {
      expect(text.startsWith(sent.content)).toBe(true);
      if (index > 0) expect(sent.content.length).toBeGreaterThan(sends[index - 1]!.content.length);
    }
  });
});
