-- 表情认图结果（§23.2）：认一次用很久，按 (guild_id, emoji_id) 唯一，
-- 改名不自动重认（描述按 emoji id 存），updated_at 由仓储按写入时刻补 ISO。

CREATE TABLE IF NOT EXISTS emoji_descriptions (
  guild_id    TEXT NOT NULL,
  emoji_id    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, emoji_id)
);
