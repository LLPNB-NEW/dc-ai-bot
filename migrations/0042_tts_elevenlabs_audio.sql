-- 0042：加第四种方言（elevenlabs），并给音乐工具两个可后台调整的时长。
-- SQLite 不能改 CHECK，所以重建表；必须把 0022/0023/0024/0032 的列全部带上。
-- 默认值就是产品初值：默认 60 秒、上限 300 秒；上限另受 ElevenLabs 的 10 分钟硬限制约束。
CREATE TABLE tts_settings_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL DEFAULT '',
  key_sealed TEXT NOT NULL DEFAULT '',
  key_hint TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  dialect TEXT NOT NULL DEFAULT 'openai' CHECK (dialect IN ('openai','mimo','gemini','elevenlabs')),
  judge_url TEXT NOT NULL DEFAULT '',
  judge_key_sealed TEXT NOT NULL DEFAULT '',
  judge_key_hint TEXT NOT NULL DEFAULT '',
  judge_model TEXT NOT NULL DEFAULT '',
  music_default_ms INTEGER NOT NULL DEFAULT 60000,
  music_max_ms INTEGER NOT NULL DEFAULT 300000
);

INSERT INTO tts_settings_new (
  id, url, key_sealed, key_hint, model, voice, updated_at, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model, music_default_ms, music_max_ms
)
SELECT id, url, key_sealed, key_hint, model, voice, updated_at, dialect, judge_url, judge_key_sealed, judge_key_hint, judge_model, 60000, 300000
FROM tts_settings;

DROP TABLE tts_settings;
ALTER TABLE tts_settings_new RENAME TO tts_settings;
