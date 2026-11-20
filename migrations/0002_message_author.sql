-- 记忆里给每条消息记上发言人名字：线上历史只有 role/content，模型分不清频道里谁在说话。
-- 老行保持 NULL，读侧按「无名字」处理（不加前缀），不需要回填。
ALTER TABLE messages ADD COLUMN author_name TEXT;
