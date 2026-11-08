/**
 * Workers 的 ExecutionContext.waitUntil 在 Node 侧没有对应物：进程不退出就等于任务还在，
 * 但测试和优雅关闭都需要"把已经收下的后台任务等干净"。这层只负责记账。
 */

export interface TaskTracker {
  waitUntil(task: Promise<unknown>): void;
  drain(): Promise<void>;
  pending(): number;
}

export function createTaskTracker(onError: (error: unknown) => void): TaskTracker {
  const tasks = new Set<Promise<unknown>>();

  return {
    waitUntil(task: Promise<unknown>): void {
      tasks.add(task);
      // 入表即接住 rejection：晚一步挂 handler 就可能先冒出 unhandledRejection，
      // 而这里的 onError 是唯一的报错出口。删除只发生在 then 里，因此一定晚于 add。
      void task.then(
        () => {
          tasks.delete(task);
        },
        (error: unknown) => {
          tasks.delete(task);
          try {
            onError(error);
          } catch (handlerError) {
            // onError 自己抛错会变成派生 Promise 的 rejection，等于绕过了这道兜底
            console.error('[task-tracker] onError 自身抛出：', handlerError);
          }
        },
      );
    },

    async drain(): Promise<void> {
      // 循环而不是单次 allSettled：onError 回调和等待期间都可能有新任务入表，
      // 集合为空才是"真的没有活着的任务"。
      while (tasks.size > 0) {
        await Promise.allSettled([...tasks]);
      }
    },

    pending(): number {
      return tasks.size;
    },
  };
}
