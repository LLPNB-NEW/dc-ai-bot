-- 表情选择的独立模型（§21.2）：单行表，CHECK (id = 1) 把「全局只有一套」写进约束。
-- 空提供方 / 空模型都只是「还没配」，读侧据此返回 null，老库无需回填。

CREATE TABLE IF NOT EXISTS reaction_model (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表：全局只有一套表情模型
  enabled INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
