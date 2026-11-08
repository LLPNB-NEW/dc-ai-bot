/**
 * 把 src/node/main.ts 打成单文件 dist/server.mjs。
 *
 * 为什么不用 tsc 直出：生产镜像里不装 node_modules，hono 与 @hono/node-server 必须在构建期内联，
 * 运行时外部依赖只剩 node:* 内置模块这一层。
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entryPath = fileURLToPath(new URL('../src/node/main.ts', import.meta.url));
const outfilePath = fileURLToPath(new URL('../dist/server.mjs', import.meta.url));

if (!existsSync(entryPath)) {
  // 直接给绝对路径而不是 esbuild 的 "Could not resolve"：这条分支多半发生在并行 track 还没落盘时
  console.error(`[build:node] 缺少入口文件：${entryPath}`);
  console.error('[build:node] 自托管入口由 Node 运行时 track 提供，确认它落盘后重跑。');
  process.exit(1);
}

await build({
  entryPoints: [entryPath],
  outfile: outfilePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  // 与 platform:'node' 的默认值一致：node:* 交给运行时，其余依赖全部内联进产物
  packages: 'bundle',
  logLevel: 'info',
});

console.error(`[build:node] 已产出 ${outfilePath}`);
