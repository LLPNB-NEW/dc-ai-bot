-- 后台「实时日志」（§19.4）：入口 Worker 与网关 DO 是不同实例，只有 D1 能同时看到两边的事件；内存方案在驱逐后丢失。
-- 保留最近 800 条，每次写入顺带清理（§19.5），所以这张表是环形表不是流。
-- AUTOINCREMENT 不能省：普通 INTEGER PRIMARY KEY 在删行后会复用 id，前端 after=id 的轮询游标会漏条目。

CREATE TABLE IF NOT EXISTS runtime_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL
);
