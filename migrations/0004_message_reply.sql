-- 回复链：一条消息可能回复了更早的一条，被回复对象必须跟着消息行落库，历史才能告诉模型「谁回复谁、原话是什么」（§18.2）。
-- D1 一句 ALTER 只能加一列，所以拆成四句；四列统一 TEXT NOT NULL DEFAULT ''：老行留空串、不回填，语义等价「不知道」。

ALTER TABLE messages ADD COLUMN reply_to_id TEXT NOT NULL DEFAULT '';
-- 被回复人的显示名；空串 = 不知道（原消息作者已删除或被网关拿不到名字时），与 id 各自独立退化
ALTER TABLE messages ADD COLUMN reply_to_author TEXT NOT NULL DEFAULT '';
-- 被回复人的 Discord 用户 ID；同样可以单独缺失，提示词侧按「只有名字 / 只有 id」两种退化分别拼
ALTER TABLE messages ADD COLUMN reply_to_author_id TEXT NOT NULL DEFAULT '';
-- 被回复原文全文：存储层不截断，截到 40 字只发生在 core 的提示词侧，库里留全文才能被 /summary 与手动排查复用
ALTER TABLE messages ADD COLUMN reply_to_content TEXT NOT NULL DEFAULT '';
