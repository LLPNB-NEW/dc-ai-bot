-- 0032：加第三种方言（gemini），SQLite 不能改 CHECK 所以要重建表。
-- 重建必须把 0022/0023/0024 加过的列全部带上：漏列就是老行数据被丢、读侧查不存在的字段。
CREATE TABLE tts_settings_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL DEFAULT '',
  key_sealed TEXT NOT NULL DEFAULT '',
  key_hint TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  dialect TEXT NOT NULL DEFAULT 'openai' CHECK (dialect IN ('openai','mimo','gemini')),
  judge_url TEXT NOT NULL DEFAULT '',
  judge_key_sealed TEXT NOT NULL DEFAULT '',
  judge_key_hint TEXT NOT NULL DEFAULT '',
  judge_model TEXT NOT NULL DEFAULT ''
);

INSERT INTO tts_settings_new (
  id, url, key_sealed, key_hint, model, voice, updated_at, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model
)
SELECT id, url, key_sealed, key_hint, model, voice, updated_at, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model
FROM tts_settings;

DROP TABLE tts_settings;
ALTER TABLE tts_settings_new RENAME TO tts_settings;
