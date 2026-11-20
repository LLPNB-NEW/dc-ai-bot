-- 0039: 每条消息记住自己来自哪个平台；老行空串 = 未记录，摘要不猜平台
ALTER TABLE messages ADD COLUMN platform TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN platform_kind TEXT NOT NULL DEFAULT '';
