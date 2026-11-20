-- 0043: 音乐/音效/变声的模型 ID 也可以在后台改。
-- 空串 = 用代码内置默认；不改表结构，只在 0042 的 tts_settings 上追加三列。
ALTER TABLE tts_settings ADD COLUMN music_model TEXT NOT NULL DEFAULT '';
ALTER TABLE tts_settings ADD COLUMN sound_effect_model TEXT NOT NULL DEFAULT '';
ALTER TABLE tts_settings ADD COLUMN voice_changer_model TEXT NOT NULL DEFAULT '';
