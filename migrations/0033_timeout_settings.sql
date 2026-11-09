-- 超时覆盖：一个字段一行，只有后台显式保存过才有行；没行就退回环境变量与内置默认。
-- 只建表、不动任何已有表：0033 只做加法，能直接跑在已有生产库上。
CREATE TABLE IF NOT EXISTS timeout_settings (
  name TEXT NOT NULL PRIMARY KEY,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL
);
