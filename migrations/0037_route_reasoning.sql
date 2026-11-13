-- 0037: 模型路由的可选思考强度；NULL = 这一层不设（上下文工具模式仍回退到 low）
ALTER TABLE routes ADD COLUMN reasoning_effort TEXT;
