-- 频道级记忆配置（§26.2）：一个频道一行；没有行 = 代码默认（50 / 50）
CREATE TABLE IF NOT EXISTS channel_memory_settings (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  history_max_messages INTEGER NOT NULL,
  summary_every_messages INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, channel_id)
);
