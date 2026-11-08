# syntax=docker/dockerfile:1

# 构建阶段：Web 前端与 Node 入口都在这里产出，运行镜像因此完全不需要 node_modules
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# t3.micro 只有 1 GiB 内存，vite 与 esbuild 同时展开时默认堆上限足以触发 OOM killer
ENV NODE_OPTIONS=--max-old-space-size=512

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build:web
RUN node scripts/build-node.mjs

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# 只拷产物：镜像里没有源码，也没有 devDependencies
COPY --from=builder /app/dist/server.mjs ./dist/server.mjs
COPY --from=builder /app/dist/web ./dist/web
# 运维脚本（dump / 从 Discord 回灌历史等）：镜像里不装构建工具，直接拿构建阶段的 scripts/，用 stdin 喂给 node 跑
COPY --from=builder /app/scripts ./scripts
# 运行时按 cwd 读迁移文件（src/node/main.ts 的 MIGRATIONS_DIR='migrations'），不拷进来首启就报「迁移失败」
COPY --from=builder /app/migrations ./migrations

# 兜底目录：绑定挂载覆盖后属主取宿主机，宿主机 ./data 需交给 uid 1000 才写得到
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 8787

CMD ["node", "dist/server.mjs"]
