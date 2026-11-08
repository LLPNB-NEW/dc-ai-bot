# DC AI BOT

Discord 上的多模型 AI 助手：Slash 命令 + 后台管理台，可跑在 Cloudflare Workers（Hono + D1）
或自托管 Node + SQLite 上。

## 能力

- **Discord**：`/chat` `/model` `/persona` `/reset` `/summary` `/help`；@ 与 `/chat` 都是边生成边编辑同一条消息。
- **后台管理**：分层提示词（global / guild / channel，可多段、可排序）、分层路由（primary + fallbacks）、
  厂商密钥（AES-256-GCM 入库，界面只见末 4 位）、长期记忆与历史、语音、表情模板、世界书、备份。
- **多供应商**：OpenAI 兼容（含自建网关）、Anthropic、Gemini，按路由切换、失败自动降级。
- **长期记忆**：频道内消息永久保留，按条数注入最近原文，每 N 条自动追加一段摘要，可手动连续总结。
- **上下文工具模式**（按频道开关）：只发一条固定 user 消息，把预设、世界书、记忆与历史塞进 `context` 工具描述体，
  正文由 `story_reply` 交付——实测能避开把用户原话当顶层消息触发的拒答。
- **画图**：预设里写 `draw_image` 就让模型自己画，图以附件直接发出，随后还带一两句台词（模型没给台词时只发图；历史里存台词，纯图存 `[图片]`）。

## 快速开始

```bash
npm ci                        # Node >= 22.13
npm run db:migrate:local      # 建本地 D1 表
cp .dev.vars.example .dev.vars
npm run build:web             # 产出 dist/web
npm run dev                   # http://127.0.0.1:8787
```

`.dev.vars` 六个变量：

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_PUBLIC_KEY=...       # 64 位十六进制，验签用
DISCORD_APPLICATION_ID=...
ADMIN_PASSWORD=...           # 后台登录口令
SESSION_SECRET=...           # >= 32 字符随机串
KEY_ENCRYPTION_SECRET=...    # 32 字节随机数的 base64，换掉后已存密钥全部失效
```

启动后在后台依次配好：**路由**（例如 primary = `openai-compat / deepseek-chat`）→ **密钥**（provider 与路由对上，
自建网关把 baseUrl 填成 `https://your-gateway/v1`）→ 可选 **提示词**（global 放通用设定，guild / channel 整组覆盖）。

## 接到 Discord

Discord 只回调公网 HTTPS，先开隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:8787   # 或 ngrok http 8787
```

1. 开发者后台 **Interactions Endpoint URL** 填 `https://<公网地址>/interactions`，保存时的 PING 会自动通过。
2. 注册命令：`DISCORD_APPLICATION_ID=<id> DISCORD_BOT_TOKEN=<token> npm run register`（加 `-- --dry-run` 只看不发）。
3. **OAuth2 → URL Generator** 勾 `bot` + `applications.commands`，把 bot 拉进服务器，频道里发 `/chat prompt:你好`。

## 部署

```bash
npx wrangler d1 create dc-ai-bot        # database_id 填进 wrangler.toml
npx wrangler secret put DISCORD_BOT_TOKEN   # 六个变量逐个
npm run db:migrate:remote
npm run build:web && npx wrangler deploy
```

部署完把 `https://<worker>.workers.dev/interactions` 填进 Interactions Endpoint URL。
自托管（Ubuntu + Node + Docker + Caddy）见 `docs/hosting.md`。

## 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地 wrangler dev（含 D1 与静态资源） |
| `npm test` / `npm run test:node` | Worker 侧 / Node 侧测试 |
| `npm run typecheck` / `typecheck:web` | Worker 与后台前端类型检查 |
| `npm run build:web` | 构建后台前端到 `dist/web` |
| `npm run db:migrate:local` / `:remote` | 应用 `migrations/` |
| `npm run register` | 全量覆盖注册 `src/workers/discord/commands.ts` 里的命令 |

## 代码结构

```
src/workers/index.ts   Worker 入口：/interactions、/api/**、静态资源
src/node/main.ts       Node 入口（自托管，同一套装配）
src/workers/           http（后台 API）/ discord / db / crypto / gateway
src/core/              提示词与路由解析、记忆窗口、供应商适配、对话服务
web/                   后台前端（React + Vite）
migrations/            D1 迁移
test/                  单测与 e2e 冒烟
```

## 文档

- `docs/architecture.md` —— 契约与模块归属（改代码前先看）
- `docs/operations.md` —— 部署 / 回滚 / 轮换 / 排障 / 已知限制
- `docs/hosting.md` —— 自托管运行手册

常见故障：Discord 401（公钥或路径不对）、`NO_ROUTE_CONFIGURED`（没配路由）、`NO_KEY_FOR_PROVIDER`（路由里的 provider 没有可用密钥）。
