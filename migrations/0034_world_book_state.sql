-- 世界书的粘性/冷却记账：按频道存一份条目状态，轮次口径就是该频道已存的消息条数。
-- 服务端整份覆盖写（先按 guild_id/channel_id 删，再插入当前还有粘性/冷却的条目），
-- 所以这张表只描述「最近一次判定之后」的状态，不保留历史。
-- 私聊没有服务器，guild_id 存空串，与 messages、conversation_summaries 同口径。
CREATE TABLE IF NOT EXISTS world_book_state (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  entry_id INTEGER NOT NULL,
  sticky_until INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id, entry_id)
);
