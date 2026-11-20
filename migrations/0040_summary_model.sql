-- 0040: 摘要模型单独一套（单行表）；没有行 = 沿用聊天路由
CREATE TABLE IF NOT EXISTS summary_model (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
