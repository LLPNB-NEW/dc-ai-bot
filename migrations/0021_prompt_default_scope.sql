-- 0021: 兜底文案（fallback / identity）从「单行表」升级成三层：channel > guild > global。
-- 语义仍是「没有行 = 用代码里的默认」（DEFAULT_PROMPT / 身份块），所以这里只搬数据、不造行：
-- 升级前那行就是 global 层，搬完删旧表，再把新表改名回 prompt_defaults，读写代码只认一个表名。
-- 可安全跑在已有生产库上：先建新表、逐行搬成 ('global','')，再 DROP 旧表。

CREATE TABLE IF NOT EXISTS prompt_defaults_scoped (
  key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('channel', 'guild', 'global')),
  scope_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, scope, scope_id)
);

INSERT INTO prompt_defaults_scoped (key, scope, scope_id, content, updated_at)
SELECT key, 'global', '', content, updated_at FROM prompt_defaults;

DROP TABLE prompt_defaults;

ALTER TABLE prompt_defaults_scoped RENAME TO prompt_defaults;
