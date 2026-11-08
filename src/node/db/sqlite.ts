/// <reference types="node" />
/**
 * §30.2 自托管 Node 上的 SqlDatabase：node:sqlite 之上的一层薄壳。
 *
 * 仓储层（src/workers/db/**）是照着 D1 写的，所以这层壳的重点不是「封装 SQLite」，
 * 而是把 D1 被用到的那几条语义原样搬过来，并把 node:sqlite 不收的绑定值先折算掉。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqlDatabase, SqlResult, SqlStatement } from '../../core/db/sql';

type Binding = null | number | string | bigint | Uint8Array;

/**
 * node:sqlite 只收 null/number/bigint/string/ArrayBufferView，布尔和 undefined 直接抛
 * "Provided value cannot be bound to SQLite parameter"；D1 的语义是 undefined -> NULL、布尔 -> 0/1。
 */
function toBinding(value: unknown): Binding {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  // 对象/数组在仓储层从没被绑过；静默字符串化会把类型错误藏进数据里，宁可当场炸
  throw new Error('UNSUPPORTED_BINDING: ' + Object.prototype.toString.call(value));
}

function toBindings(values: readonly unknown[]): Binding[] {
  return values.map(toBinding);
}

export function createSqliteDatabase(filePath: string): SqlDatabase {
  // 父目录不存在时 SQLite 只会回一句「unable to open database file」，看不出是目录缺失
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);

  function createStatement(sql: string, values: readonly unknown[]): SqlStatement {
    // 懒编译：log-store 在构造期就 prepare 且跨请求复用，但参数要等 bind 才齐，
    // 提前 prepare 只是把同一句 SQL 编两遍。
    let prepared: StatementSync | null = null;
    const compiled = (): StatementSync => {
      if (prepared === null) prepared = db.prepare(sql);
      return prepared;
    };

    return {
      // bind 必须产出新实例：log-store.ts:30-31 在构造期只 prepare 一次、prune 就地 bind 一次，
      // 若 bind 改自身状态，后续请求的 bind 会把那一次的绑定洗掉（参数串味）。
      bind(...nextValues: unknown[]): SqlStatement {
        return createStatement(sql, nextValues);
      },

      async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
        const rows = compiled().all(...toBindings(values)) as T[];
        return { results: rows };
      },

      async first<T = Record<string, unknown>>(): Promise<T | null> {
        // d1-repository.ts:320 用 row === null 判空：undefined 漏下去会变成「有行但字段全 undefined」
        const row = compiled().get(...toBindings(values));
        return row === undefined ? null : (row as T);
      },

      async run(): Promise<unknown> {
        return compiled().run(...toBindings(values));
      },
    };
  }

  return {
    prepare(query: string): SqlStatement {
      return createStatement(query, []);
    },

    async batch(statements: SqlStatement[]): Promise<unknown> {
      if (statements.length === 0) return [];
      // 批量写（messages/emoji_descriptions/runtime_logs）靠整批一个事务：任何一条失败，
      // 前面已经执行的那几条必须一起消失，否则表里留下半批数据。
      db.exec('BEGIN');
      try {
        const results: unknown[] = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error: unknown) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 回滚自己也失败说明事务已经不在，能报给调用方的还是原始那条错
        }
        throw error;
      }
    },
  };
}
