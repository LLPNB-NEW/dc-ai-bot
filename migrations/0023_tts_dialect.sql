-- 0023: 语音合成接口增加第二种上游方言（小米 MiMo），与原有 OpenAI 形状并存。
-- 老行没有这一列，DEFAULT 'openai' 让它们原样继续走 /audio/speech；CHECK 与仓储读侧一起挡住脏值。
ALTER TABLE tts_settings ADD COLUMN dialect TEXT NOT NULL DEFAULT 'openai' CHECK (dialect IN ('openai', 'mimo'));
