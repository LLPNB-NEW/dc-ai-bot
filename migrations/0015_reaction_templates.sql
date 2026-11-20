-- 表情模型素材模板的三层配置：global / guild / channel 各至多一行，命中哪层整份用哪层。
-- 只建表、不动任何已有表：这一段必须能直接跑在已有生产库上（0015 只做加法）。
-- scope_id：global 恒为空串，guild 存 guildId，channel 存 channelId；空串给 DEFAULT 是为了 global 那一行不用特判。
CREATE TABLE IF NOT EXISTS reaction_templates (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
