import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig } from 'vitest/config';

// 迁移在配置期（Node 侧）读盘，作为绑定注入 workerd；test/setup.ts 里再 apply 到 env.DB
const migrations = await readD1Migrations('./migrations');

const WORKER_ENTRY = './src/workers/index.ts';
const workerEntryPath = fileURLToPath(new URL(WORKER_ENTRY, import.meta.url));

// pool 会无条件 import wrangler.toml 的 main；M0 阶段 src/workers/index.ts 由 M6 交付，
// 尚未存在时把该 import 指向空模块，文件落地后本插件自动失效、不再介入
const stubMissingWorkerEntry = existsSync(workerEntryPath)
  ? []
  : [
      {
        name: 'stub-missing-worker-entry',
        enforce: 'pre' as const,
        resolveId(id: string) {
          const normalized = id.replace(/\\/g, '/');
          if (normalized === workerEntryPath.replace(/\\/g, '/')) return '\0stub-worker-entry';
          return null;
        },
        load(id: string) {
          if (id === '\0stub-worker-entry') return 'export default { fetch() { return new Response("stub"); } };';
          return null;
        },
      },
    ];

export default defineConfig({
  plugins: [
    ...stubMissingWorkerEntry,
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        d1Databases: ['DB'],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    // Node 专属测试要真磁盘与 node:sqlite，workerd 池里连 node:os/node:sqlite 都解析不了，
    // 放在这里只会变成「整套 suite 加载失败」；它们由 vitest.node.config.ts（npm run test:node）真跑
    exclude: [...configDefaults.exclude, 'test/node.*.test.ts', 'test/*.node.test.ts'],
  },
});
