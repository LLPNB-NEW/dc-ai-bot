-- 0027：路由加采样参数。NULL = 这一层不设（上游用自己默认），0 是有效值，必须和 NULL 分开。
-- 列名用 snake_case 跟旧列一致；取舍在适配器里做，库里五列都存，方便换模型时保留用户填的值。
ALTER TABLE routes ADD COLUMN top_p REAL;
ALTER TABLE routes ADD COLUMN top_k INTEGER;
ALTER TABLE routes ADD COLUMN seed INTEGER;
ALTER TABLE routes ADD COLUMN frequency_penalty REAL;
ALTER TABLE routes ADD COLUMN presence_penalty REAL;
