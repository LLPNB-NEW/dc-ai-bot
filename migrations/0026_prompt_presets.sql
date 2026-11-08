-- 0026：酒馆预设导入的原始 JSON 存档（单行，只留最近一次）。
-- 本阶段只写不读：后续阶段要用它读世界书与正则，所以原样存整份 preset，不做裁剪。
CREATE TABLE IF NOT EXISTS prompt_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  char_name TEXT NOT NULL,
  source_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
