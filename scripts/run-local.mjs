// 本机运行入口：把 data/local.env 读进 process.env，再加载打包好的 dist/server.mjs。
// 用法：node scripts/run-local.mjs [env 文件路径]（默认 data/local.env）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const envPath = process.argv[2] ?? join(repoRoot, 'data', 'local.env');

for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

process.chdir(repoRoot);
await import(join(repoRoot, 'dist', 'server.mjs'));
