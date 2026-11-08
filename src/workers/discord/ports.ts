import type { ChannelKey, ConversationSummary, SummaryOutcome, TurnContext, TurnResult } from '../../core/types';

/**
 * M2 的 ChatService 在结构上满足此接口；这里只声明本层真正用到的方法，
 * 以免 Discord 层反向依赖 src/core/chat/**（architecture §16.3）。
 */
export interface ChatEvents {
  onProgress?: (partialText: string) => void | Promise<void>;
}

export interface ChatRunner {
  run(ctx: TurnContext, events?: ChatEvents): Promise<TurnResult>;
  reset(key: ChannelKey): Promise<void>;
  /** §17.5：/summary 的默认路径，把该频道全部未总结消息总结掉 */
  summarize(key: ChannelKey): Promise<SummaryOutcome | null>;
  getSummary(key: ChannelKey): Promise<ConversationSummary | null>;
}
