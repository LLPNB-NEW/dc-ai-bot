-- 0044: 旧版在 tts-style-1 之后就不再使用 model 列，但历史行可能还留着上一个方言的模型名。
-- 这一版重新把 model 当覆盖值；先清空所有旧值，避免切到 ElevenLabs 后仍拿 gemini 的模型名去请求。
-- 只清一次；之后后台保存的自定义模型不会被这条迁移动到。
UPDATE tts_settings SET model = '';
