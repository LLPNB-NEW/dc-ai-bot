-- 长期记忆：每个 (guild, channel) 只留一条「已总结到这里」的摘要，原文仍在 messages 里供短期窗口复用。
CREATE TABLE IF NOT EXISTS conversation_summaries (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  covered_until_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);
