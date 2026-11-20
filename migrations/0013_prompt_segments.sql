-- §11：提示词从「一层一段正文 + 人格」改成「一层多段」。
-- prompts 表退化成「这一层有配置」的容器（只剩 temperature / max_tokens / updated_at），正文搬进 prompt_segments。
CREATE TABLE IF NOT EXISTS prompt_segments (
  id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user')),
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  placement TEXT NOT NULL CHECK (placement IN ('before', 'after')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, id)
);

CREATE INDEX IF NOT EXISTS idx_prompt_segments_scope ON prompt_segments(scope, scope_id, position);

-- 回填：旧 system_prompt 是 NOT NULL，每层都搬成 '基本设定'；persona 可能为 NULL 或只剩空白，那种不该变成一段空人格
INSERT INTO prompt_segments (id, scope, scope_id, position, name, role, content, enabled, placement, updated_at)
SELECT 'legacy-main', scope, scope_id, 0, '基本设定', 'system', system_prompt, 1, 'before', updated_at
FROM prompts;

INSERT INTO prompt_segments (id, scope, scope_id, position, name, role, content, enabled, placement, updated_at)
SELECT 'legacy-persona', scope, scope_id, 1, '人格', 'system', persona, 1, 'before', updated_at
FROM prompts
WHERE persona IS NOT NULL AND trim(persona) <> '';

-- 正文已经搬走，旧列留着只会让两个写入口并存
ALTER TABLE prompts DROP COLUMN persona;
ALTER TABLE prompts DROP COLUMN system_prompt;
