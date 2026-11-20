import { defineConfig } from 'vitest/config';

// Node 侧（自托管服务、SQLite、静态文件、网关 WebSocket）测试：要真磁盘与 node:* 模块，
// workerd 池给不了；这两个 glob 与 vitest.config.ts 的 exclude 必须一一对应，漏一边就会两边都跑或两边都不跑。
export default defineConfig({
  test: {
    root: '.',
    environment: 'node',
    include: ['test/node.*.test.ts', 'test/*.node.test.ts'],
  },
});
