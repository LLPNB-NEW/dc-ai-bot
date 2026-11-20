-- 0045: QQ 只给 msg_idx / ref_msg_idx，不给被引用消息的发送者。
-- 自己留一份短期索引，引用消息到达时才能还原「谁、说了什么」。
-- 独立表，不动 messages；7 天后自动过期，旧消息本来也没有 msg_idx。
CREATE TABLE IF NOT EXISTS qq_quote_index (
  account_id TEXT NOT NULL,
  chat_type TEXT NOT NULL CHECK (chat_type IN ('qq_group', 'qq_c2c')),
  chat_id TEXT NOT NULL,
  msg_idx TEXT NOT NULL,
  platform_message_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  user_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id, chat_type, chat_id, msg_idx)
);

CREATE INDEX IF NOT EXISTS qq_quote_index_expiry_idx
  ON qq_quote_index (expires_at);
