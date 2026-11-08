-- §41 主模型识图的三层开关：global / guild / channel 各至多一行，命中哪层用哪层。
-- 只建表、不动任何已有表：这一段必须能直接跑在已有生产库上（0018 只做加法）。
-- scope_id：global 恒为空串（DEFAULT 就是给它用的），guild 存 guildId，channel 存 channelId。
-- enabled 故意不加 CHECK：越界值由读侧当「这一层没配置」处理，将来改语义不用再迁移。
CREATE TABLE IF NOT EXISTS vision_settings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
