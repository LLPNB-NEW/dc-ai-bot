-- 深度注入（SillyTavern depth_prompt 语义）：一层一行，channel / guild / global 各至多一条。
-- depth 是「倒数第几条之前」：0 = 紧接本轮用户消息之前；content 空串表示这一层关着。
CREATE TABLE IF NOT EXISTS prompt_injections (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  depth INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
