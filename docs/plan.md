# 实施计划 · DC AI BOT

## 决策记录（访谈结论，已获确认）

| 议题 | 结论 | 理由 |
|---|---|---|
| 技术栈 | TypeScript；workerd 运行时；本地 Node 22 开发 | 本机 node 22.13.0/npm 10.9.2 已就绪，docker 不可用 |
| Discord 接入 | HTTP Interactions（Ed25519 验签），斜杠命令 | Workers 无法承载 Gateway 长连接；官方 serverless 形态 |
| 部署形态 | 单个 Cloudflare Worker：Interactions + D1 + 同 Worker 静态托管 SPA | 单份部署物，与"接入 CF worker 空间"一致 |
| 供应商 | openai-compat（baseURL 可配）+ anthropic + gemini | 一个兼容层覆盖 OpenAI/DeepSeek/Kimi/Qwen/Ollama 等 |
| 功能范围 | 核心对话 + 频道级模型/人格/提示词 + 会话记忆 + 渐进式"流式" | 正好覆盖"多供应商 + 提示词可调" |
| 配置入口 | 分层 global/guild/channel；Web 后台 + 斜杠命令双入口 | 开发者改库、运营改命令，无需额外前端 |
| 密钥 | 厂商 key 加密入 D1（AES-256-GCM），后台可增删多把、回显脱敏 | 运营可自助轮换 |
| 持久化 | D1（SQLite 方言） | 无 docker；D1 为 Workers 原生 |
| 验收凭据 | 有厂商 API key、无 Discord Bot Token | 故验收=mock/本地 workerd，可选真模型联调 |
| 可移植性 | core 层零平台依赖；HTTP 用 Hono（Node 亦可跑） | 用户提出"后续效果不好可能上 AWS" |

**待验证假设**：单管理员单 Bot 多 guild；记忆按 (guild, channel) 共享；记忆按频道注入最近 50 条原文（再叠加 200000 字符安全阀，更早的靠摘要兜底；库里永不删除），每 50 条未总结消息后台大总结一次——2026-10-26 四次口径变更，「全量历史注入」与「20 轮/40 条摘要」均已废弃；渐进编辑间隔 1200ms、上限 12 次；界面中文；登录限速 10 次/5 分钟/isolate；不做真实 CF 部署。

**已排除**：better-sqlite3（原生模块不可用）、discord.js v14（依赖 Node ws/zlib + Gateway）、Durable Object 持 Gateway（社区非官方方案）、分体部署（与 CF 意图不符）、Next.js（Vite SPA 更契合静态托管）、Postgres/JSON 文件。

## 波次与任务

| 波次 | 任务 | 交付 | 依赖 |
|---|---|---|---|
| W1 | M0 基座 | 脚手架 + `core/types.ts` + `core/ports.ts` + `prompt/template.ts` + D1 仓储 + SecretBox + 迁移 + 基座测试 | 无 |
| W2（并行） | M1 供应商 | 三适配器 + SSE + 契约测试 | M0 |
| W2（并行） | M2 对话核心 | prompt resolver + routing + memory + chat service + 测试 | M0 |
| W2（并行） | M3 Discord | 验签 + interactions + REST 客户端 + 渐进编辑 + 命令 + 测试 | M0、M2 契约 |
| W2（并行） | M4 后台 API | Hono 路由 + Cookie 鉴权 + CRUD + 测试 | M0 |
| W2（并行） | M5 SPA | 登录/提示词/路由/密钥四页 + 构建产物 `dist/web` | API 契约 |
| W3 | M6 集成与文档 | `workers/index.ts` 装配 + E2E + README + operations + .env.example + 命令注册脚本 | W2 全部 |

## 验收清单（逐条验证，不接受"应该可以"）

- [ ] `npm install` 成功，`npm run typecheck` 零错误（src+test+web）
- [ ] `npm test` 全绿（含 providers/chat/discord/admin/e2e）
- [ ] `npm run build:web` 产出 `dist/web/index.html`
- [ ] `wrangler dev` 可启动，`GET /api/health` 返回 200
- [ ] 伪造签名的 interactions 请求 → 401；PING → `{"type":1}`；`/chat` → `{"type":5}` 且随后出现 ≥1 次 PATCH
- [ ] 三适配器请求线缆与 §7 一致（有测试断言 URL/headers/body）
- [ ] 提示词三层优先级可测；未知模板变量保存被 400 拒
- [ ] 密钥入库为密文，API 只回显 hint；未登录访问 /api/prompts → 401
- [ ] 记忆按频道隔离，prune 生效；`/reset` 清空
- [ ] fallback 链：主模型失败自动用备用模型并记录 attempts
- [ ] `grep` 校验：`src/core` 无 `cloudflare:` / `node:` / `hono` / `react` 引用
- [ ] README 含：本地起服务、6 个 secret 的填写、Discord 应用创建与 endpoints 配置、命令注册步骤
