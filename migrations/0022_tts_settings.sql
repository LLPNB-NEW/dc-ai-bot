-- 0022: 语音合成接口（TTS）从环境变量改成后台可配。
-- 单行表：id 由 CHECK 钉成 1，后台每次保存都是「改那一行」，不是新增一套配置。
-- 没有行、url 为空、key_sealed 为空，三者任一都算「未配置」；key_sealed 存 AES 密文，key_hint 只存掩码。
CREATE TABLE IF NOT EXISTS tts_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL DEFAULT '',
  key_sealed TEXT NOT NULL DEFAULT '',
  key_hint TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
