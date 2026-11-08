CREATE TABLE IF NOT EXISTS prompts (
  scope TEXT NOT NULL CHECK (scope IN ('global','guild','channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  persona TEXT,
  system_prompt TEXT NOT NULL,
  temperature REAL,
  max_tokens INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS routes (
  scope TEXT NOT NULL CHECK (scope IN ('global','guild','channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  primary_provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  fallbacks_json TEXT NOT NULL DEFAULT '[]',
  temperature REAL,
  max_tokens INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  ciphertext TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys (provider, enabled);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (guild_id, channel_id, id);
