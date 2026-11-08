import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll } from 'vitest';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      /** vitest.config.ts 用 readD1Migrations 读盘后注入，见 setupFiles */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

// 每个测试文件跑在独立 storage 栈上，setup 会随之重跑；applyD1Migrations 自身幂等
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
