-- 0012: 摘要注入 system 的字符预算；0 = 未设置，运行时用默认 4000（SUMMARY_MAX_CHARS）
ALTER TABLE channel_memory_settings ADD COLUMN summary_max_chars INTEGER NOT NULL DEFAULT 0;
