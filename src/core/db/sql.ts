/**
 * §30 自托管（Ubuntu + Node）：数据库的最小读写面。
 *
 * 两个实现都要结构化满足这里：
 *   - Cloudflare 的 `D1Database`（Workers 入口直接传 env.DB，无需适配）
 *   - `createSqliteDatabase()`（src/node/db/sqlite.ts，node:sqlite 之上）
 *
 * 仓储层（src/workers/db/**）只依赖本文件，因此不能再 import @cloudflare/workers-types 的任何类型。
 * 形状是照着 D1 实际被用到的那一小撮方法裁出来的（见 docs/architecture.md §30.3）：
 * prepare/bind/all/first/run/batch —— 全仓库没有用到 raw()/meta/success。
 */
export interface SqlResult<T> {
  results: T[];
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  /** 没有命中时必须返回 null（D1 的语义），不是 undefined */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  /** 语义要求：整批在一个事务里，任何一条失败整批回滚 */
  batch(statements: SqlStatement[]): Promise<unknown>;
}
