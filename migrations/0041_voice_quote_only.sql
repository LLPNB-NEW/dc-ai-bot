-- 0041: 语音回复的朗读范围：1 = 只念引号里的台词（默认，保持旧行为），0 = 整段照念。
-- 开关打开但正文一个引号都没有时仍整段照念，旧库升级不用回填；脏值由读侧落回 1。
ALTER TABLE voice_settings ADD COLUMN quote_only INTEGER NOT NULL DEFAULT 1;
