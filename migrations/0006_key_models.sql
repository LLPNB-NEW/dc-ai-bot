-- Key 的「适用模型名单」（§20.3）：逗号分隔的原始名单，'' 表示空数组 = 全部模型都可用。
-- DEFAULT '' 让既有 Key 自动成为「通用」，老数据无需回填。

ALTER TABLE provider_keys ADD COLUMN models TEXT NOT NULL DEFAULT '';
