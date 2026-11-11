-- 生图自定义的三层配置：global / guild / channel 各至多一行。
-- model / base_url 为空 = 这一项沿用上层；key_sealed 为空 = 本层没配 Key，
-- 读侧逐字段合并后再落到默认模型与当前聊天 Key，不在这里写默认值。
-- apiKey 只存 AES 密文与掩码，明文绝不进库、也不进 HTTP 响应。
CREATE TABLE IF NOT EXISTS image_settings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  key_sealed TEXT NOT NULL DEFAULT '',
  key_hint TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
