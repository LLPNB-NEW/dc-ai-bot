/**
 * 渐进编辑：把流式到达的文本按节流节奏不断改写**同一条**消息（§29）。
 *
 * 两条路共用这套规则：
 *   - 斜杠命令改写 interaction 的原始响应（./rest.ts 的 editOriginalMessage）；
 *   - @ 路径改写自己刚发出去的那条消息（./gateway/channel-rest.ts 的 editMessage；首个 token 到了才发）。
 * 规则一致：间隔 >= intervalMs、总编辑数 <= maxEdits、最后一次必然是最终全文。
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export const TRUNCATION_SUFFIX = '…(已截断)';

/** 假流式：整段到手后最多分几次挤出去；每片之间仍受 intervalMs 约束（Discord 对同一频道的 PATCH 有速率限制） */
export const REVEAL_MAX_STEPS = 6;

/** 还剩不到这么多字就不做动画，直接一次给全文（错误提示、一句话回复不该为了动画慢一秒） */
export const REVEAL_MIN_GAIN_CHARS = 24;

export function clampForDiscord(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + TRUNCATION_SUFFIX : text;
}

export interface ProgressiveEditorOptions {
  /** 写一次：@ 路径是 PATCH 某条消息，斜杠路径是 PATCH 原始响应 */
  send: (content: string) => Promise<void>;
  clock: Clock;
  intervalMs: number;
  maxEdits: number;
  maxChars: number;
  /**
   * 假流式切片次数（§38 的后台三层配置）：不传就按 REVEAL_MAX_STEPS；
   * 0 = 关闭假流式、直接一次发全文（走到 reveal 里 steps <= 0 那条分支）。
   */
  revealSteps?: number;
  onError: (error: unknown) => void;
}

export interface ProgressiveEditor {
  /** 不阻塞调用方：只记下最新文本，实际发送在内部队列里按节流节奏进行 */
  push(text: string): void;
  finish(finalText: string): Promise<void>;
}

/**
 * 渐进编辑：间隔 >= intervalMs、总编辑数 <= maxEdits、最后一次必然是最终全文。
 * 最后一次单独留一个预算，否则进度编辑可能把配额用光、最终全文发不出去。
 */
export function createProgressiveEditor(options: ProgressiveEditorOptions): ProgressiveEditor {
  const progressBudget = Math.max(0, options.maxEdits - 1);
  let edits = 0;
  let finished = false;
  let lastSentAt: number | null = null;
  let lastContent: string | null = null;
  let latest: string | null = null;
  let scheduled = false;
  let tail: Promise<void> = Promise.resolve();

  const serialize = (task: () => Promise<void>): Promise<void> => {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const waitForSlot = async (): Promise<void> => {
    if (lastSentAt === null) return;
    const wait = lastSentAt + options.intervalMs - options.clock.now();
    if (wait > 0) await options.clock.sleep(wait);
  };

  const deliver = async (text: string): Promise<void> => {
    const content = clampForDiscord(text, options.maxChars);
    if (content === lastContent) return;
    await waitForSlot();
    if (content === lastContent) return;
    try {
      await options.send(content);
      edits += 1;
      lastSentAt = options.clock.now();
      lastContent = content;
    } catch (error) {
      // 一次 PATCH 失败不该让整轮对话失败；继续用后续编辑兜住最终结果
      options.onError(error);
    }
  };

  const flush = async (): Promise<void> => {
    scheduled = false;
    while (!finished && latest !== null && edits < progressBudget) {
      const text = latest;
      latest = null;
      await deliver(text);
    }
    latest = null;
  };

  const push = (text: string): void => {
    if (finished) return;
    latest = text;
    if (scheduled) return;
    scheduled = true;
    void serialize(flush);
  };

  /**
   * 假流式：整段正文一次性到手时（模型秒回、正文在流里一次到齐），把已拿到的那部分按节奏分几片挤出去，
   * 让用户看到「在打字」而不是「一条消息直接是全文」。真流式追平全文时这里一个字节都不发。
   *
   * 时间上界：最多 REVEAL_MAX_STEPS + 1 次发送，相邻两次仍隔 intervalMs（1200ms），
   * 所以最坏多花约 8 秒，换来的是整段回复不再一次性砸出来。
   */
  const reveal = async (finalText: string): Promise<void> => {
    const target = clampForDiscord(finalText, options.maxChars);
    if (target === lastContent) return;
    const shown = lastContent === null ? 0 : lastContent.length;
    const remaining = target.length - shown;
    // 最后那一格必须留给完整全文，否则进度编辑可能把配额用光、正文只剩一截
    const budget = progressBudget - edits;
    if (remaining < REVEAL_MIN_GAIN_CHARS || budget <= 0) {
      await deliver(finalText);
      return;
    }
    // 后台可配（§38）：先把外部值收进合法区间，0 会自然落到下面 steps <= 0 那条「直接发全文」的分支
    const maxSteps = Math.max(0, Math.floor(options.revealSteps ?? REVEAL_MAX_STEPS));
    // 分母 +1 保证最后一片仍短于全文，完整全文由收尾那次 deliver(finalText) 落地
    const steps = Math.min(maxSteps, budget - 1);
    if (steps <= 0) {
      await deliver(finalText);
      return;
    }
    for (let i = 1; i <= steps; i += 1) {
      const length = shown + Math.round((remaining * i) / (steps + 1));
      await deliver(target.slice(0, length));
    }
    await deliver(finalText);
  };

  const finish = async (finalText: string): Promise<void> => {
    finished = true;
    latest = null;
    await serialize(async () => {
      await reveal(finalText);
    });
  };

  return { push, finish };
}
