-- 0024：语气提示词（三层）+ 语音情绪判断（judge）凭据。
-- judge 走与 TTS key 同一套密文列：库里只有密文与掩码，明文只在运行时出现。
ALTER TABLE tts_settings ADD COLUMN judge_url TEXT NOT NULL DEFAULT '';
ALTER TABLE tts_settings ADD COLUMN judge_key_sealed TEXT NOT NULL DEFAULT '';
ALTER TABLE tts_settings ADD COLUMN judge_key_hint TEXT NOT NULL DEFAULT '';
ALTER TABLE tts_settings ADD COLUMN judge_model TEXT NOT NULL DEFAULT '';

-- 每条语音先判断情绪用的提示词：channel > guild > global，global 的 scope_id 恒为 ''。
CREATE TABLE IF NOT EXISTS tts_style_prompts (
  scope TEXT NOT NULL CHECK (scope IN ('channel', 'guild', 'global')),
  scope_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
