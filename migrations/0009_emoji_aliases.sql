-- 表情别名（§24.3）：管理员手工配，一个别名只指向一个表情
CREATE TABLE IF NOT EXISTS emoji_aliases (
  guild_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  emoji_id TEXT NOT NULL,
  emoji_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, alias)
);
