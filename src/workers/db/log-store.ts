import type { SqlDatabase } from '../../core/db/sql';
import type { LogStore } from '../../core/ports';
import type { LogEntry, LogLevel, LogScope, StoredLogEntry } from '../../core/types';

/** 环形表默认保留条数；超出即按 id 从旧到新删（§19.5） */
export const DEFAULT_LOG_KEEP = 800;

interface LogRow {
  id: number;
  created_at: string;
  level: LogLevel;
  scope: LogScope;
  message: string;
}

/** 库里是 created_at，契约里是 createdAt；显式列名映射，不用 SELECT * */
function toStoredLogEntry(row: LogRow): StoredLogEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    level: row.level,
    scope: row.scope,
    message: row.message,
  };
}

export function createLogStore(db: SqlDatabase, keep: number = DEFAULT_LOG_KEEP): LogStore {
  // keep 是唯一旋钮：非数字/小于 1 一律回落到默认值，避免把表删空
  const retention = Number.isFinite(keep) && keep >= 1 ? Math.trunc(keep) : DEFAULT_LOG_KEEP;
  const insert = db.prepare('INSERT INTO runtime_logs (created_at, level, scope, message) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM runtime_logs WHERE id <= (SELECT MAX(id) - ? FROM runtime_logs)').bind(retention);

  return {
    async append(entries: LogEntry[]): Promise<void> {
      if (entries.length === 0) return;
      // 一次 append 多条共用同一个 batch：插入几条 + 最后一条 prune，写与清在同一事务里
      const statements = entries.map((entry) =>
        insert.bind(entry.createdAt, entry.level, entry.scope, entry.message),
      );
      // 行数不足 keep 时右值为负或 NULL，天然不删，无需先 COUNT
      statements.push(prune);
      await db.batch(statements);
    },

    async list(afterId: number, limit: number): Promise<StoredLogEntry[]> {
      const { results } = await db
        .prepare('SELECT id, created_at, level, scope, message FROM runtime_logs WHERE id > ? ORDER BY id ASC LIMIT ?')
        .bind(afterId, limit)
        .all<LogRow>();
      return (results ?? []).map(toStoredLogEntry);
    },
  };
}
