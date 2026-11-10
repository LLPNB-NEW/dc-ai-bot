-- 世界书一层可以有多本（§79）：每本一行，book_id 由服务端生成，enabled 是整本开关。
-- 旧表的主键是 (scope, scope_id)，一层只能存一本；老行按 "scope:scope_id" 生成 bookId 原样保留。
DROP TABLE IF EXISTS world_books_next;
CREATE TABLE world_books_next (
  book_id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  book_json TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  imported_at TEXT NOT NULL
);
INSERT INTO world_books_next (book_id, scope, scope_id, name, book_json, entry_count, enabled, imported_at)
  SELECT scope || ':' || scope_id, scope, scope_id, name, book_json, entry_count, 1, imported_at FROM world_books;
DROP TABLE world_books;
ALTER TABLE world_books_next RENAME TO world_books;
CREATE INDEX IF NOT EXISTS idx_world_books_layer ON world_books (scope, scope_id);

-- 粘性/冷却的记账键也要带书：两本书都有 id=1 的条目，只看 entry_id 会串账。
-- 旧行没法判断属于哪一本（旧版本只有层内唯一的一本），直接清空——它最多影响几轮粘性，不值得猜。
DROP TABLE IF EXISTS world_book_state;
CREATE TABLE world_book_state (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  entry_id INTEGER NOT NULL,
  sticky_until INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id, book_id, entry_id)
);
