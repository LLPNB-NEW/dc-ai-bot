/**
 * §30.4 迁移执行器：把 migrations/*.sql 原样跑在一个 Node 侧 SQLite 文件上。
 *
 * 为什么不经过 createSqliteDatabase：一个迁移文件里有多条语句（0004/0011 的 ALTER TABLE 追加列
 * 与回填 UPDATE），SqlDatabase 只暴露单语句 prepare，这里需要 DatabaseSync.exec 整段执行。
 * 记录表名与执行顺序（按文件名升序）和 wrangler d1 migrations 同一套，所以从 D1 导出过全量数据的库
 * 可以用 markAllApplied 一次性认账，而不是重放迁移（重放会撞「列已存在」）。
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const LEDGER_TABLE = '_migrations';

/** 建库文件（父目录缺失就补）+ 保证记录表存在，再把 db 交给调用方 */
function withDatabase<T>(filePath: string, body: (db: DatabaseSync) => T): T {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ' + LEDGER_TABLE + ' (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    return body(db);
  } finally {
    db.close();
  }
}

/** 文件名即顺序（0001…0011 零填充）；不用 localeCompare，免得换机器/locale 后顺序漂移 */
function migrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function recordedNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM ' + LEDGER_TABLE).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export async function runMigrations(filePath: string, dir: string): Promise<MigrateResult> {
  return withDatabase(filePath, (db) => {
    const recorded = recordedNames(db);
    const record = db.prepare('INSERT INTO ' + LEDGER_TABLE + ' (name, applied_at) VALUES (?, ?)');
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const name of migrationFiles(dir)) {
      if (recorded.has(name)) {
        skipped.push(name);
        continue;
      }
      // 一个文件一个事务：文件里是多条语句，中途失败只回滚到本文件开头，
      // 下次重跑才不会撞上「列已存在」
      db.exec('BEGIN');
      try {
        db.exec(readFileSync(join(dir, name), 'utf8'));
        record.run(name, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error: unknown) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 回滚失败说明事务已不在，要报出去的是前面那条真正的错
        }
        throw error;
      }
      applied.push(name);
    }

    return { applied, skipped };
  });
}

/** 「D1 已导出全量数据」的一次性认账：只记账不执行；返回本次新记上的文件名 */
export async function markAllApplied(filePath: string, dir: string): Promise<string[]> {
  return withDatabase(filePath, (db) => {
    const recorded = recordedNames(db);
    const record = db.prepare('INSERT INTO ' + LEDGER_TABLE + ' (name, applied_at) VALUES (?, ?)');
    const marked: string[] = [];
    const appliedAt = new Date().toISOString();
    for (const name of migrationFiles(dir)) {
      if (recorded.has(name)) continue;
      record.run(name, appliedAt);
      marked.push(name);
    }
    return marked;
  });
}
