-- 世界书（SillyTavern lorebook）：一层一行，channel / guild / global 各至多一本，导入即整本覆盖。
-- book_json 存的是解析后的规范化 WorldBook（不是酒馆原文）：读侧不再二次解析原文，正文按条目取用。
CREATE TABLE IF NOT EXISTS world_books (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  book_json TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
