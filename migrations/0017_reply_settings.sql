-- §38 假流式切片次数的三层配置：global / guild / channel 各至多一行，命中哪层用哪层。
-- 只建表、不动任何已有表：这一段必须能直接跑在已有生产库上（0017 只做加法）。
-- scope_id：global 恒为空串，guild 存 guildId，channel 存 channelId；空串给 DEFAULT 是为了 global 那一行不用特判。
-- reveal_steps 故意不加 CHECK：越界值由读侧当「这一层没配置」处理，将来放宽上限不用再迁移。
CREATE TABLE IF NOT EXISTS reply_settings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  reveal_steps INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
