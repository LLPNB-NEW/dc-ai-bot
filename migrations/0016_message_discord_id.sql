-- 回灌历史消息时得靠 Discord 自己的消息 id 判重：同一批消息可能被抓两遍（脚本重跑、429 重试、分页边界重叠），
-- 唯一索引让 INSERT ... ON CONFLICT(discord_id) DO NOTHING 一句话就兜住幂等。
-- 运行时（gateway → conversations.append）不填这一列，所以老行留 NULL；
-- SQLite 的唯一索引允许多个 NULL，因此现有 1900 多行不需要回填。
ALTER TABLE messages ADD COLUMN discord_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_discord_id ON messages (discord_id);
