-- 「内置默认提示词」与「当前对话身份块」两份兜底文案：后台可编辑，没有行 = 用代码里的默认。
-- 只建表、不动任何已有表：这一段必须能直接跑在已有生产库上（只做加法）。
-- key 只认 'fallback' 与 'identity'，故意不加 CHECK：越界值由读侧直接忽略，将来加新 key 不用再迁移。
-- content 原样存（保留换行与缩进）：它是一份模板正文，不是一行摘要。
CREATE TABLE IF NOT EXISTS prompt_defaults (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
