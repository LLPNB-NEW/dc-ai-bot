import { describe, expect, it } from 'vitest';
import { createTaskTracker } from '../src/node/wait-until';

describe('createTaskTracker', () => {
  it('pending 反映在飞任务数，任务结束后归零', async () => {
    const tracker = createTaskTracker(() => {});
    expect(tracker.pending()).toBe(0);
    tracker.waitUntil(Promise.resolve('a'));
    tracker.waitUntil(Promise.resolve('b'));
    expect(tracker.pending()).toBe(2);
    await tracker.drain();
    expect(tracker.pending()).toBe(0);
  });

  it('drain 期间新加入的任务也会被等到', async () => {
    const tracker = createTaskTracker(() => {});
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondDone = false;

    tracker.waitUntil(first);
    const drained = tracker.drain();
    // 关键点：这一条在 drain 已经开始之后才入表，drain 必须把它也等掉
    tracker.waitUntil(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          secondDone = true;
          resolve();
        }, 5);
      }),
    );

    releaseFirst();
    await drained;

    expect(secondDone).toBe(true);
    expect(tracker.pending()).toBe(0);
  });

  it('任务失败只回调 onError，drain 不 reject', async () => {
    const errors: unknown[] = [];
    const tracker = createTaskTracker((error) => errors.push(error));
    tracker.waitUntil(Promise.reject(new Error('后台任务炸了')));
    tracker.waitUntil(Promise.reject('非 Error 的拒绝值'));

    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe('后台任务炸了');
    expect(errors[1]).toBe('非 Error 的拒绝值');
    expect(tracker.pending()).toBe(0);
  });

  it('失败的任务不会留下 unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on?.('unhandledRejection', record);
    try {
      const tracker = createTaskTracker(() => {});
      tracker.waitUntil(Promise.reject(new Error('无人认领的拒绝')));
      await tracker.drain();
      // 让微任务与下一次事件循环都跑完，unhandledRejection 才有机会被记录
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off?.('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  it('onError 自己抛错也不会变成未处理的拒绝', async () => {
    const tracker = createTaskTracker(() => {
      throw new Error('错误回调也炸了');
    });
    tracker.waitUntil(Promise.reject(new Error('原始错误')));
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(tracker.pending()).toBe(0);
  });
});
