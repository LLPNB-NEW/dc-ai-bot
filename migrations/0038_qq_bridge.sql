-- 0038: QQ 群/单聊与 Discord 频道共用一个逻辑会话；记忆仍落在 messages/summaries 的 (guild_id, channel_id) 上
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  preset_id TEXT,
  memory_guild_id TEXT NOT NULL,
  memory_channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (memory_guild_id, memory_channel_id)
);

CREATE TABLE IF NOT EXISTS conversation_links (
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'qq')),
  kind TEXT NOT NULL CHECK (kind IN ('discord_channel', 'qq_group', 'qq_c2c')),
  external_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (platform, kind, external_id)
);

CREATE INDEX IF NOT EXISTS conversation_links_conversation_idx
  ON conversation_links (conversation_id);

CREATE TABLE IF NOT EXISTS qq_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 把已有 Discord 频道历史纳入会话目录；Discord 的 canonical key 保持原样，所以网关无需改。
-- 私聊（guild_id 为空）没有可共享的服务器频道，不在这里登记。
INSERT OR IGNORE INTO conversations (id, name, preset_id, memory_guild_id, memory_channel_id, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  '',
  NULL,
  source.guild_id,
  source.channel_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT MAX(guild_id) AS guild_id, channel_id
  FROM (
    SELECT guild_id, channel_id FROM messages WHERE guild_id <> ''
    UNION
    SELECT guild_id, channel_id FROM conversation_summaries WHERE guild_id <> ''
    UNION
    SELECT guild_id, channel_id FROM channel_memory_settings WHERE guild_id <> ''
  )
  GROUP BY channel_id
) AS source
WHERE NOT EXISTS (
  SELECT 1 FROM conversations c
  WHERE c.memory_guild_id = source.guild_id AND c.memory_channel_id = source.channel_id
);

INSERT OR IGNORE INTO conversation_links (platform, kind, external_id, conversation_id, display_name, last_seen_at)
SELECT 'discord', 'discord_channel', c.memory_channel_id, c.id, '', c.created_at
FROM conversations c
WHERE c.memory_guild_id NOT LIKE 'qq:%';
