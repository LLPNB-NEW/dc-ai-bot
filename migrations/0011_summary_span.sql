-- 0011: 摘要覆盖的时间段。摘要前写「说话的时间」——要的是被总结那批消息的时刻，
-- 不是摘要生成的时刻，所以存两头（已有摘要按游标从 messages 回填）。
ALTER TABLE conversation_summaries ADD COLUMN covered_from TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_summaries ADD COLUMN covered_to TEXT NOT NULL DEFAULT '';

UPDATE conversation_summaries SET
  covered_from = COALESCE((
    SELECT m.created_at FROM messages m
    WHERE m.guild_id = conversation_summaries.guild_id
      AND m.channel_id = conversation_summaries.channel_id
      AND m.id <= conversation_summaries.covered_until_id
    ORDER BY m.id ASC LIMIT 1
  ), ''),
  covered_to = COALESCE((
    SELECT m.created_at FROM messages m
    WHERE m.guild_id = conversation_summaries.guild_id
      AND m.channel_id = conversation_summaries.channel_id
      AND m.id <= conversation_summaries.covered_until_id
    ORDER BY m.id DESC LIMIT 1
  ), '');
