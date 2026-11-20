#!/usr/bin/env node
/**
 * 把 `wrangler d1 export --remote --no-schema` 产出的数据灌进 Node 侧的 SQLite。
 *
 * 为什么不能直接喂给 sqlite3：导出里有三类行在自托管侧是错的 ——
 *   PRAGMA defer_foreign_keys=TRUE  只对 D1 那一次导出批有意义；
 *   INSERT INTO "d1_migrations"     D1 的迁移账本，Node 侧用的是 _migrations（runMigrations 建）；
 *   INSERT INTO "sqlite_sequence"   自增序列，AUTOINCREMENT 会按导入后的 max(rowid) 自行恢复。
 * 表结构由 runMigrations 先建好，所以这里只跑 INSERT。
 *
 * 用法：node scripts/import-sql.mjs <sqlite 文件> <导出.sql>
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SKIPPED_TABLES = ['d1_migrations', 'sqlite_sequence'];

function keep(statement) {
  if (statement.startsWith('PRAGMA')) return false;
  return !SKIPPED_TABLES.some((table) => statement.startsWith('INSERT INTO "' + table + '"'));
}

function usage(message) {
  console.error(message);
  console.error('用法: node scripts/import-sql.mjs <sqlite 文件> <导出.sql>');
  process.exit(1);
}

const [dbPath, sqlPath] = process.argv.slice(2);
if (!dbPath || !sqlPath) usage('缺少参数。');

const lines = readFileSync(sqlPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');
const statements = lines.filter(keep);

const db = new DatabaseSync(dbPath);
// 导入是按导出顺序逐条写，父子表那点顺序差不能拦住它，否则导入必然半途而废
db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
let done = 0;
try {
  for (const statement of statements) {
    db.exec(statement);
    done += 1;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('导入失败：第 ' + (done + 1) + ' 条语句。');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('该语句：' + (statements[done] ?? '(不存在)').slice(0, 200));
  process.exit(1);
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);
console.log('已导入 ' + done + ' 条，跳过 ' + (lines.length - statements.length) + ' 条。');
for (const table of tables) {
  if (table.startsWith('sqlite_')) continue;
  const count = db.prepare('SELECT COUNT(*) AS n FROM "' + table + '"').get();
  console.log('  ' + table + ': ' + count.n);
}
