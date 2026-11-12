# 运维手册（DC AI BOT）

面向已经部署或正在运维这套 Worker 的同学：部署、回滚、迁移、轮换、看日志、排障、已知限制。
契约细节见 `docs/architecture.md`；从零跑通见 `README.md`。

- 运行时：Cloudflare Workers（单 Worker 同时提供 API 与 SPA）
- 存储：D1（`DB`），五张表 `prompts` / `routes` / `provider_keys` / `messages` / `conversation_summaries`
- 请求面：`POST /interactions`（Discord，公网必须可达）、`/api/**`（管理台，Cookie 鉴权）、其余 → `dist/web`

---

## 1. 部署

### 1.1 首次

```bash
npx wrangler d1 create dc-ai-bot          # 把输出里的 database_id 填进 wrangler.toml
npm ci
npm run db:migrate:remote                 # 远端建表，必须先于首次部署完成
npm run build:web                         # 产出 dist/web，deploy 时一起上传
npx wrangler deploy
```

六个 secret 用 `npx wrangler secret put <NAME>` 逐个注入（不要写进 wrangler.toml，也不要入库）：
`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`DISCORD_APPLICATION_ID`、`ADMIN_PASSWORD`、`SESSION_SECRET`、
`KEY_ENCRYPTION_SECRET`。

### 1.2 日常发布（改了 Worker 代码）

```bash
npm test && npm run typecheck && npm run typecheck:web   # 本地先过闸
npx wrangler deploy                                      # 前端没改可以不重新 build:web
```

改了 `web/**` 必须先 `npm run build:web`，否则 `dist/web` 还是旧的。
改了 `migrations/**` 必须先 `npm run db:migrate:remote` 再 deploy（先迁移后上代码）。

### 1.3 发布顺序建议

1. `npm run db:migrate:remote`（只在有迁移时）
2. `npm run build:web`（只在 `web/` 有改动时）
3. `npx wrangler deploy`
4. 冒烟：`curl -s https://<域名>/api/health` → `{"ok":true,"version":"..."}`；Discord 里发一次 `/chat`；后台登录取一次路由列表。

---

## 2. 回滚

```bash
npx wrangler deployments list          # 看历史版本与版本号
npx wrangler rollback [版本号]         # 不带参数回退到上一个版本
```

- 回滚只回代码，**不会**回滚 D1 数据与迁移。若新版本带了破坏性迁移，回滚代码后旧代码可能读不了新表结构 ——
  这也是"迁移只做加列/加表、不删列"的原因。
- 前端回滚要把 `dist/web` 一起回退：`git checkout <旧提交> -- web/ && npm run build:web && npx wrangler deploy`。
- Discord 侧没有版本概念：只要 Interactions Endpoint URL 不变，回滚对 Discord 透明。

---

## 3. D1 迁移

```bash
npm run db:migrate:local        # 本地 .wrangler/state，开发时用
npm run db:migrate:remote       # 线上库，deploy 之前跑
npx wrangler d1 migrations list DC     # 看还有哪些没应用（本地加 --local）
```

新增迁移：在 `migrations/` 里按 `0002_xxx.sql`、`0003_xxx.sql` 递增命名，内容保持幂等友好
（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN`）。已应用的迁移文件不要再改内容——wrangler 按文件名记账。

备份与恢复：

```bash
npx wrangler d1 export dc-ai-bot --remote --output backup-$(date +%F).sql
npx wrangler d1 execute dc-ai-bot --remote --command "SELECT COUNT(*) FROM messages"
```

> 迁移没跑就 deploy 的典型症状：所有 `/api/**` 返回 `{"error":"INTERNAL"}`，`wrangler tail` 里是
> `D1_ERROR: no such table: routes`。补跑 `npm run db:migrate:remote` 即可，无需重新部署。

---

## 4. 轮换密钥与口令

| Secret | 轮换影响 | 操作 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | 影响回填消息（PATCH `@original`）与命令注册 | Portal **Bot → Reset Token** → `wrangler secret put DISCORD_BOT_TOKEN`，然后重跑 `npm run register` |
| `DISCORD_PUBLIC_KEY` | 影响验签；不一致时所有交互 401 | Portal **General Information → Public Key** 变更后立刻 `wrangler secret put DISCORD_PUBLIC_KEY` |
| `DISCORD_APPLICATION_ID` | 影响回填 URL 里的 application id 与注册目标 | 与 Portal 保持一致，一般不动 |
| `ADMIN_PASSWORD` | 后台旧口令立即失效 | `wrangler secret put ADMIN_PASSWORD` |
| `SESSION_SECRET` | 已签发的 Cookie 全部失效（需重新登录） | `wrangler secret put SESSION_SECRET` |
| `KEY_ENCRYPTION_SECRET` | **已入库的厂商 key 全部解不开** | 换之前记下各 key 明文；换后在后台**重新录入**所有 key |

```bash
npx wrangler secret put KEY_ENCRYPTION_SECRET     # 值必须是 32 字节随机数的 base64
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

secret 生效不需要重新部署，下一次请求即生效；但 isolate 会被新建，进行中的长请求可能用旧值完成。

厂商 API key 的轮换在**后台密钥页**做：新增一把 → 确认 `/chat` 正常 → 停用或删除旧的一把。
（同一 provider 可以同时启用多把，按适用模型排序后逐把尝试，§20.4；停用立即不再参与选择，密钥本身保留，随时可以在同一行点「启用」恢复。）

---

## 5. 日志与观测

```bash
npx wrangler tail                        # 实时日志（pretty）
npx wrangler tail --format json          # 结构化
npx wrangler tail --status error         # 只看 5xx
```

- Worker 侧日志只记录错误摘要（`console.error`），**不打印任何密钥明文**；Discord REST 失败会带 `discord HTTP <status>: <body 前 300 字>`。
- 想确认"某频道现在用的哪个模型/哪层提示词"：后台路由/提示词页看层级，或 `GET /api/conversations?guildId=..&channelId=..` 看最近消息。
- D1 抽查：`npx wrangler d1 execute dc-ai-bot --remote --command "SELECT id,provider,key_hint,enabled FROM provider_keys"`
  （`key_hint` 只有末 4 位，密文列不要外传）。
- 管理台登录有按 IP 的限速：5 分钟内 10 次失败后返回 `429 {"error":"TOO_MANY_ATTEMPTS"}`，窗口按 isolate 计。

---

## 6. 常见故障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| Discord 保存 Endpoint URL 失败 / 交互全 401 | `DISCORD_PUBLIC_KEY` 与 Portal 不一致；或 URL 打到了站点首页；或中间层改写了 body | 核对公钥 64 位 hex 原样粘贴；确认 URL 以 `/interactions` 结尾；隧道别加会改 body 的中间件 |
| `{"error":"MISSING_SECRET","name":"..."}` | 该分支需要的 secret 没配 | 按 `name` 补 `wrangler secret put`（缺 `KEY_ENCRYPTION_SECRET` 时连密钥都存不了） |
| 用户看到"还没有配置模型路由" / 日志 `NO_ROUTE_CONFIGURED` | 该 guild/channel/global 没有任何路由 | 后台路由页配 `global` 一条，或给该频道所在服务器配 guild 层 |
| 日志 `NO_KEY_FOR_PROVIDER` | 路由指向的 provider 下没有 enabled 的密钥 | 后台密钥页新增该 provider 的 key |
| 日志 `ALL_PROVIDERS_FAILED: [...]` | primary 与 fallbacks 全部失败（key 错、额度、网络） | 看方括号里每条 `<provider> HTTP <status>: <body>`；后台 key 测试按钮验证连通性 |
| 后台/接口 429 | 登录失败次数过多；或厂商返回 429 | 等 5 分钟窗口过去；厂商 429 说明触发了上游限速，换 key 或加 fallback |
| 所有 `/api/**` 返回 `{"error":"INTERNAL"}` | D1 迁移没跑 / 表不存在 | `npm run db:migrate:remote`，见第 3 节 |
| `/api/keys/:id/test` 返回 `501 PROBE_UNAVAILABLE` | 装配时没注入 probeKey（自建入口） | 用本仓库的 `src/workers/index.ts` 入口；它已注入 provider `listModels` |
| `/api/keys/:id/test` 返回 `502` | 上游拒绝（key 错 / baseUrl 错 / 网络） | 响应里的 `error` 就是上游原文，按它改 baseUrl 或换 key |
| Discord 里 `/chat` 一直"应用未响应" | 交互 3 秒内没 ACK（Worker 冷启动过慢、部署未完成） | 重试；看 `wrangler tail` 是否有请求进来；确认 deploy 的版本是当前提交 |
| 回复停在一半不再更新 | 渐进编辑有 1200ms 间隔与 12 次上限；超长文本按 1900 字截断并加"…(已截断)" | 属预期行为；需要更长内容请让模型分段 |
| 命令列表里看不到 `/chat` | 全局命令缓存未过期，或 `npm run register` 没跑成功 | 重跑 `npm run register`（会打印每条命令 id）；等缓存过期或改用 guild 级注册 |

---

## 7. 已知限制（如实记录）

1. **`GET /api/conversations` 返回的 `createdAt` 可能缺省**：§6.2 的 `ConversationStore.loadRecent` 只回
   `role`/`content`，没有时间戳；接口只有在数据行里确实带 `createdAt` 时才输出该字段。想做时间轴要改 store 契约。
2. **Discord 交互没有做 timestamp ±5 分钟新鲜度校验**：验签覆盖 `timestamp + body`，能防篡改，但签名过的旧请求可被重放。
   需要的话在验签后加一个时间窗判断（`Date.now()/1000` 与 header 的差 > 300s 直接 401）。
3. **`guildName` / `channelName` 在提示词模板里渲染为空串**：交互 payload 只给 guild/channel 的 id，不带名称，
   所以 `{{guild_name}}` / `{{channel_name}}` 目前是空。要展示名称得额外调 Discord API 查缓存。
4. **测试框架已改名，跑 `npm test` 会打 deprecation 警告**：`@cloudflare/vitest-pool-workers` 官方已改名为
   `@cloudflare/vitest-plugin`，当前版本仍可用但会打印一条 WARNING；迁移时按提示跑
   `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`。同一原因，
   `cloudflare:test` 的 `fetchMock` 在本版本不可用，`test/e2e.smoke.test.ts` 改用替换 `globalThis.fetch` 拦出网。

### 实现层面另有三处需要知道

- 入口每次请求重建 `secretBox` / 仓储 / 对话服务 / 管理台（避免跨请求串号），只有无状态的
  `providers` 在 isolate 内缓存一份；冷启动量级是微秒级，不必优化。
- 缺 secret 时不抛顶层错：`/api/health` 永远 200，其余分支回 `500 {"error":"MISSING_SECRET","name":"..."}`，
  这样"部署了但忘了配 secret"能自救。实测（无 `.dev.vars` 直接 `wrangler dev`）：
  `/api/health` → 200，`/api/prompts` → `MISSING_SECRET / KEY_ENCRYPTION_SECRET`，`/` → 200 HTML。
- **`src/workers/index.ts` 里除默认导出外不能再有运行时具名导出**（`export interface` 这类纯类型没问题）。
  workerd 要求入口模块的每个具名导出都是函数或 ExportedHandler，多一个字符串常量就会在启动时报
  `Incorrect type for map entry 'X': the provided value is not of type 'function or ExportedHandler'`
  并让整个 Worker 起不来。常量改成模块内 `const` 即可。

---

## 8. 容量与成本提示

- 免费额度下 D1 每日读/写行数是最先撞墙的指标；`messages` 表**消息永久保留，按频道累计**（不再有裁剪，
  一个频道聊得越多，每轮注入的历史就越长，注入只由条数决定（`memory-nolimit-1` 起字符安全阀已去掉），条数填大就是每轮 prompt 更长更贵）。
- 每个 `/chat` 至少 1 次上游请求 + 1 次 Discord PATCH（长回复按 1200ms 节流，最多 12 次）。
- 想看用量：Cloudflare 面板 → Workers → Metrics；上游费用看各家后台。

---

## 9. 本次线上部署实录（2026-10-25）

**线上地址**：https://dc-ai-bot.<subdomain>.workers.dev（Cloudflare Account `<CLOUDFLARE_ACCOUNT_ID>`，workers.dev 子域 `<subdomain>`）

| 资源 | 实际值 |
| --- | --- |
| Worker | `dc-ai-bot`（Workers Assets + D1 双绑定） |
| D1 | `dc-ai-bot` → `database_id = <D1_DATABASE_ID>`（location `apac`），`migrations/0001_init.sql` 已应用 |
| Secrets | 6 个：`KEY_ENCRYPTION_SECRET`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`DISCORD_PUBLIC_KEY`、`DISCORD_APPLICATION_ID`、`DISCORD_BOT_TOKEN` |
| Discord 应用 | 示例机器人 / `<ID-7>` |
| 交互端点 | `PATCH /applications/@me` 写入 `https://dc-ai-bot.<subdomain>.workers.dev/interactions`（Discord 侧校验 PING 通过，HTTP 200） |
| 斜杠命令 | 已注册 5 条（`/chat` `/model` `/persona` `/reset` `/help`） |

### 部署时踩到并已处理的坑

1. **wrangler 4.152.0 在账号上不支持新版 `workers/workers/{id}/versions` 资源**：脚本上传成功（`Uploaded dc-ai-bot`）后，wrangler 还会调 `/accounts/{id}/workers/workers/dc-ai-bot`，该接口在本账号回 `10007 This Worker does not exist on your account`，导致整次 `deploy` 被误判失败。`scripts/deploy.sh` 现在把「已出现 `Uploaded` 且报错含 `workers/workers|10007`」视为非致命，并以脚本列表/线上可达为准。
2. **上传成功但 workers.dev 路由没开**：上述提前退出使 wrangler 跳过了开启子域路由的收尾步骤，线上回 404 `error code: 1042`。脚本现在补一步 `POST /workers/scripts/{name}/subdomain`（body `{"enabled":true,"previews_enabled":false}`），并在解析不到域名时用 `GET /workers/subdomain` 拼出站点地址。
3. **`d1 migrations apply --remote --yes` 不被该版本接受**：脚本回退到不带 `--yes`，非交互环境下仍然应用成功。
4. **API Token 权限不足会伪装成「认证失败」**：只有 D1 Read 时 `d1 create` 报 `Authentication error [code: 10000]`（不是 403）。改用 `wrangler login` 的 OAuth 凭据后正常；脚本保留了 OAuth 回退分支（从 wrangler 配置里取 `oauth_token` 供 curl 调 CF API）。
5. **Secret 生效有延迟**：`wrangler secret put` 成功到线上 env 可见之间可能隔数十秒，冒烟脚本对 `/api/health` 做了最多 10 次 × 3 秒重试。
6. **公钥必须与 `GET /applications/@me` 的 `verify_key` 逐字符一致**：肉眼抄写易错一个字符（本次抄错过 `0fc301` vs 真实 `0fe301`），错了之后 Discord 会拒绝保存交互端点。核对命令：`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/applications/@me | grep -o '"verify_key":"[^"]*"'`。

### 上线后仍需人工完成

1. **把机器人拉进服务器**（部署时 0 个服务器）：`https://discord.com/api/oauth2/authorize?client_id=<ID-7>&scope=bot+applications.commands&permissions=2048`
2. **在后台加至少一家厂商 API Key**（Keys 页 / `POST /api/keys`）：没有 key 时 `/chat` 会以 `NO_KEY_FOR_PROVIDER` 失败。
3. 建议**重置 Discord 客户端密钥**：排障过程中它曾出现在聊天记录里；客户端密钥与 Bot Token 不同，前者不影响本 bot 运行。
---

## 10. 常驻 Gateway 连接（bot 在线状态）

纯 HTTP Interactions 架构下，Discord 只在你推送交互时才「看见」这个 bot，成员列表里它**永远显示离线**——
在线状态只能由一条到 Gateway 的 WebSocket 连接产生。第 10 节就是补上这条连接：一个 Durable Object
（DO）持有一条常驻 socket，**只做**连接 / IDENTIFY / 心跳 / presence 上报 / 断线重连与恢复。
最初它 `intents = 0`、不接收任何事件；为支持普通消息回复（§11）现已升到 `intents = 37376`（含 MESSAGE_CONTENT 特权位），
斜杠命令仍然走 `/interactions` 的老路径，交互行为一行未变。

### 10.1 配置（`wrangler.toml`）

```toml
[[durable_objects.bindings]]
name = "GATEWAY_PRESENCE"
class_name = "GatewayPresence"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GatewayPresence"]

[triggers]
crons = ["*/5 * * * *"]
```

- 类名 `GatewayPresence` 在入口 `src/workers/index.ts` 里以**具名 class 导出**，`class_name` 必须与之一致；
  DO 的 class 只能靠入口模块的 export map 找到（这也是第 7 节那条「入口不能有值导出」约束的由来）。
- `tag = "v1"` 的 migration 一旦上线就**不能改**，后续改动要新开 `v2`。
- cron 只负责「定期把 DO 叫醒做一次保活自检」，心跳节奏由 DO 自己的 alarm 决定，两者互不替代。
- 该 DO **没有公开路由**：只有 `GATEWAY_PRESENCE` 绑定和两个内部路径（`/ensure`、`/status`），
  任何 `/api/**` 或根路径都碰不到它。

### 10.2 一条连接的生命周期

| 阶段 | 行为 |
| --- | --- |
| 触发 | cron → `scheduled()` → `stub.fetch(https://gateway.internal/ensure)`；或 DO 自己的 alarm |
| 连接 | 无 session 走 `wss://gateway.discord.gg/?v=10&encoding=json`；有 session 走 READY 给的 `resume_gateway_url` |
| op10 HELLO | 取 `heartbeat_interval`，按它的 **0.9 倍**排第一次心跳；有 `session_id` 发 RESUME(op6)，否则 IDENTIFY(op2) |
| presence | IDENTIFY 的 `d.presence` 固定为 `{status:'online', since:null, activities:[{name:'/chat 或 @我 聊天', type:0}], afk:false}` |
| 心跳 | 每次 alarm 发 op1（`d` = 最近一次收到的 `s`，没有则 `null`），并立刻排下一拍 |
| 存活确认 | 收到 op11 → 清「未确认」标记；下一拍到来时标记还在 → 判定连接已死，关掉重连 |
| op0 READY | 存 `session_id`、`resume_gateway_url`，日志打出 `user.username`，退避计数清零 |
| op7 RECONNECT | 主动关闭 → 按退避重连 |
| op9 INVALID_SESSION | 清 session（`session_id`/`resume_gateway_url`/`s`），1~5 秒随机延迟后重新 IDENTIFY |
| 重连退避 | 1s 起步、逐次翻倍、封顶 60s，再叠 ±25% 随机抖动 |

### 10.3 为什么这套时序扛得住驱逐

DO 被驱逐后 `setInterval` / `setTimeout` 全部作废，**只有 `state.storage.setAlarm()` 会被 workerd 重新唤起**。
所以心跳、退避重连、INVALID_SESSION 延迟一律表达成「排一次 alarm」，并且每一次 alarm 处理完都会把下一次排上
（HELLO 排心跳、心跳排下一拍、关闭事件排重连、连上后先排一个 15 秒握手看门狗）。
结果：即使实例被回收，只要 storage 里还有 pending alarm，DO 就会被叫醒，从持久化的
`session_id` / `resume_gateway_url` / `s` 继续 RESUME——这也是只持久化这 5 个「跨驱逐有意义」字段的原因，
`awaitingAck` / `connected` 这类属于单条 socket 的瞬时状态在重载时一律复位。

### 10.4 观测与排障

- **看日志**：`npx wrangler tail dc-ai-bot`，过滤关键字 `[gateway]`。正常序列是
  `正在连接 ...（IDENTIFY）` → `HELLO heartbeat_interval=41250ms → IDENTIFY(op2)` → `READY as <bot 用户名>`，
  之后每 ~37 秒一次静默心跳（心跳不记日志，避免刷屏）。
- **本地手动触发一次**：`npx wrangler dev --test-scheduled`，然后
  `curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"`；DO 的内部路径不对外，所以线上不要指望用 curl 直接敲。
- **`tokenConfigured:false`**：`DISCORD_BOT_TOKEN` 没进到 env（`wrangler secret put` 后有数十秒延迟，见 §9 坑 5）。
  此时 DO 只记一条 `未配置 DISCORD_BOT_TOKEN，跳过 Gateway 连接` 就安静退出，**不会**让 Worker 报错。
- **反复 `INVALID_SESSION`**：session 被服务端作废（换 token、Discord 侧重置等），DO 会自动丢弃旧 session 重新 IDENTIFY，
  通常几十秒内自愈；持续刷这条才是问题，先核对 Bot Token 是否被重置。
- **bot 依旧离线**：先确认这次部署包含了 `[[durable_objects.bindings]]` 与 `[triggers]`（`npx wrangler deploy --dry-run` 会列出
  `env.GATEWAY_PRESENCE (GatewayPresence) Durable Object`）；再确认 bot 已被拉进服务器（§9 未完成事项 1）。
  presence 上报与普通消息回复都**不需要**在 Discord Developer Portal 开任何 privileged intent（见 §11.2）。

### 10.5 成本

- 心跳约每 37 秒一拍，折算每天约 2.3k 次 alarm 唤醒 + cron 每 5 分钟 288 次，量级在 DO 免费额度内。
- DO 只在唤醒时计费，空闲不烧钱；被驱逐后靠 alarm 回来，不需要保活脚本。


## 11. 不用斜杠命令也能聊天（普通消息 → 回复）

### 11.1 能力边界

- 复用 §10 那条常驻 Gateway 连接收 `MESSAGE_CREATE`，触发规则：
  - **私聊**：一律回（正文去掉 @ 前缀后交给模型）；
  - **服务器频道**：只在 **@bot** 或 **回复 bot 的消息** 时回，其余闲聊一律静默，避免 bot 到处插话；
  - **机器人**（含 bot 自己）的消息一律跳过，防止自激循环。
- intents 默认 = `GATEWAY_INTENTS_FULL` = `GUILD_MESSAGES(1<<9=512) | DIRECT_MESSAGES(1<<12=4096) | MESSAGE_CONTENT(1<<15=32768)`
  = **37376**。其中 `MESSAGE_CONTENT` 是**特权位**，必须在开发者门户 Bot 页签勾上 **MESSAGE CONTENT INTENT**（见 §11.2）。
  **不勾的后果**：事件照样到，但 guild 频道消息的 `content` 会被 Discord 抹成空串——线上实测日志是
  `[gateway] dispatch MESSAGE_CREATE guild=… channel=…` 紧接 `[gateway] 跳过消息（empty）`。
- 降级档 `GATEWAY_INTENTS_MINIMAL` = `GUILD_MESSAGES | DIRECT_MESSAGES` = **4608** 仍以常量保留（拿不到频道正文），
  只在 4014 之后「宁可不收正文也要先连上」时使用（§11.3），**不是默认档**。
- 回复走 `POST /channels/{id}/messages`（Bot token；交互回调那条 webhook 路走不通），
  先发 typing，超过 1900 字符按段落分片；`allowed_mentions` 是 `{ parse: ['users'] }` —— 她写 `<@id>` 会真的 ping 到人，
  `@everyone` / `@here` / `<@&角色id>` 仍不解析（安全边界）；服务器频道里的回复还会在正文前自动拼 `<@提问者id> `，
  私聊与斜杠命令输出不加（§25.8，契约见 `docs/architecture.md` §39）。
- 消息处理挂在 `ctx.waitUntil` 上，**不参与**心跳/重连的串行链：模型跑十几秒也不会拖慢 §10 的保活时序。
- 斜杠命令仍然走 HTTP Interactions，两条路互不影响；记忆（该频道全量历史，§14）与斜杠命令共用同一套会话键。
- 频道里**既没 @ 也没回复 bot** 的闲聊即便正文可读也不会回：触发规则由 `shouldRespond` 决定，与是否申请特权位无关。
  要改成「频道里每条都回」，只需放宽 `shouldRespond`（intents 已经是全量档）。

### 11.2 门户配置：必须开启 MESSAGE CONTENT INTENT

Discord Developer Portal → 你的应用 → **Bot** → *Privileged Gateway Intents* → 勾上 **MESSAGE CONTENT INTENT** → **Save Changes**。

- **为什么必须开**：默认档 37376 含 `MESSAGE_CONTENT(1<<15)`。这个位没在门户勾上时，Discord 仍然投递 `MESSAGE_CREATE`，
  但 guild 频道消息的 `content` 是空串，于是被 `shouldRespond` 判成 `empty` 跳过——现象就是「@ 了没反应」。
  实测日志：`[gateway] dispatch MESSAGE_CREATE guild=<ID-2> channel=<ID-6>` → `[gateway] 跳过消息（empty）`。
- 私聊（DM）不受影响：DM 正文随 `DIRECT_MESSAGES` 位投递，始终可读。
- 另外仍要确认 bot 在目标频道有 **View Channel / Send Messages / Read Message History** 权限：
  网关不会向没有 View Channel 的频道投递事件（这时日志连 `dispatch MESSAGE_CREATE` 都不会出现）。
- 不要为了「省掉门户操作」把默认档退回 4608：那样频道里永远拿不到正文。

### 11.3 4014 防御路径与自动恢复（门户还没勾时就会出现）

门户里没勾 MESSAGE CONTENT 时，Discord 用 close code **4014**（`DISALLOWED_INTENTS`）拒掉 `intents=37376` 的 IDENTIFY。DO 的处理：

1. 记一条日志（数值都打出来，便于对账）：
   ```
   [gateway] gateway 4014 DISALLOWED_INTENTS：Discord 拒绝了本次 intents（门户里 MESSAGE CONTENT 可能没开），冷却期内降级为 intents=0（只保在线）重连，600000ms 后自动回到全量档 37376 重试
   ```
2. 冷却窗口 `INTENTS_RETRY_AFTER_MS = 600000`（**10 分钟**）内用 `intents=0` 重连：放弃所有事件、只保住在线状态，
   不会拿同一个码反复撞门；
3. 冷却到期后 `intentsFor()` 重新返回 **37376**（全量档，不是 4608），下一次握手自动重新 IDENTIFY。
   因为 `sessionIntents` 记的是握手当时**真正谈成**的档位，`resumable()` 一旦发现它与当前档不一致就放弃 RESUME、强制 IDENTIFY，
   所以你在门户勾上之后 **最多等 10 分钟就自动恢复，不用重新部署，也不用清 DO storage**。

### 11.4 排障

- **@bot 没反应**：先看 `npx wrangler tail dc-ai-bot` 有没有 `gateway READY as ...`，
  确认 `botUserId` 有值（`GET /status` 内部路径会带出来，公开路由敲不到）；
  如果有 `4014 DISALLOWED_INTENTS`，说明门户里的 MESSAGE CONTENT 没勾（或勾了还没保存），看 §11.3 的冷却自愈。
- **正文到底有没有到（判读口径）**：dispatch 日志已带量纲、且**从不打印正文**：
  `[gateway] dispatch MESSAGE_CREATE guild=<id|dm> channel=<id> mentions=<n> textLen=<n> rawLen=<n>`。
  `rawLen=0` = Discord 压根没投递 content（门户没勾 MESSAGE CONTENT INTENT，走 §11.2 + §11.3 的自愈）；
  `rawLen>0 且 textLen=0` = 用户只发了一个 @ 提及，后面没写字。
- **@ 了但没写字**：不再静默跳过，但也不替用户编话。`shouldRespond` 判出 `empty-addressed` 后只交一句
  事实标记 `（对方只 @ 了你，没有写正文）`（`EMPTY_ADDRESSED_NOTE`），怎么接、要不要问、说多长全由她自己判断；
  这句标记和普通消息一样进 `chat.run`、写 `messages`、受 1900 字分片约束。日志行是
  `[gateway] 空正文 → 她自己接（empty-addressed） guild=... mentions=... textLen=0 ...`。
  旧的 `跳过消息（empty）` 这个 reason 已删除，看到它说明跑的是旧版本。
- **有日志但没有回帖**：看 `[gateway] 回复生成失败` / `发送回复失败`。前者多半是后台模型路由/Key 的问题
  （与斜杠命令共用同一套配置），后者是 bot 少了 Send Messages 权限。
- **频道里怎么 @ 都不回，但私聊正常**：`shouldRespond` 认 `mentions` 数组和正文里的 `<@id>`/`<@!id>` 两种形态，
  若是客户端把提及折叠成了别的渲染形式、或消息是从别的频道/线程转发过来的，可能命中 `not-addressed` 分支；
  把这条消息的原始 `MESSAGE_CREATE` 打出来核对 `mentions` 字段即可。
- **bot 回复了自己**：不应该发生（机器人消息一律跳过）；若出现，先确认 `author.bot` 字段没被上游改写。

---

## 12. 记忆里的发言人署名

同一个频道里多个人跟 bot 说话时，历史若只有 `role`/`content`，模型分不清哪句是谁说的
（线上表现：她反复问「你是小明吗」「我这边看到的只是消息呀」）。从 `migrations/0002_message_author.sql` 起，
`messages` 多一列 `author_name`：

| 环节 | 行为 |
| --- | --- |
| 写 | `/chat` 与普通消息回复把 Discord 显示名（`member.nick` → `global_name` → `username`）落到 `author_name`；助手自己那句落 bot 名；未传或全空白写 `NULL` |
| 读 | `loadRecent` 只把「非空的 `author_name`」回给上层；迁移前的老行是 `NULL`，读出来 `author` 为空，按「无名字」处理 |
| 拼历史 | 进模型请求前 user 轮次拼成 `[MM-DD HH:mm] <名字>(<用户ID>)：<正文>`（**全角冒号**），assistant 轮次带时刻但不带名字，当前这一轮同样署名 |
| 用户 ID | 落在 `messages.user_id`（老行是 `''`）；有 ID 才拼括号，同名用户靠 ID 区分，模型也能直接 @ 到正确的人 |

- **库里存原始正文**，名字前缀只存在于模型请求里：`GET /api/conversations` 的 `content` 仍是原话，不受影响。
- 名字为空（老数据 / 私聊无显示名）时**不加前缀**，不会出现 `undefined：` 这种行；名字有、ID 空时只拼 `<名字>：`。
- `loadRecent`（管理后台）与 `loadAll`（全量注入）都只把非空 `author_name` 回给上层，前缀在字符安全阀计数**之前**拼上，
  所以名字也占 `historyMaxChars`（每行多几个字符）。
- **发布顺序**：这条迁移必须先 `npm run db:migrate:remote`（见 §1.2、§3）再 deploy；否则写消息会报
  `D1_ERROR: table messages has no column named author_name`（§6 那张表的同类故障）。
- 抽查：`npx wrangler d1 execute dc-ai-bot --remote --command "SELECT id,role,author_name,substr(content,1,20) FROM messages ORDER BY id DESC LIMIT 10"`。

### 12.1 时间戳（`[MM-DD HH:mm]`，北京时间）

`messages.created_at` 从第一版迁移就在写，但在这次改动之前**没有任何读取路径把时刻交给模型**——模型分不清「上一条是刚才说的，还是三天前说的」。现在每一行历史都带时刻：

| 环节 | 行为 |
| --- | --- |
| 格式 | `[10-25 11:00] 小明(<ID-1>)：正文`：月-日 时:分，**固定北京时间（UTC+8）**。workerd 跑在 UTC，故按毫秒平移后再取 `getUTC*` 渲染，与运行环境时区无关（将来迁 AWS 也不会变） |
| 写 | `append` 时上层给了 `createdAt` 就落这个值，没给才由库侧补 `nowIso()`；每条回复的本轮时刻只取一次，写库与拼提示词用的是同一个 ISO 串 |
| 读 | `loadRecent` / `loadAll` / `loadAfter` 三处 SELECT 都取 `created_at`，非空才回 `createdAt` 键（老行不会冒出空串） |
| 谁带戳 | user 与 assistant 行都带（模型才知道自己上次回复的时间）；摘要素材 `formatTranscript` 每行同样带 |
| 不带戳 | 为空或解析不了的时刻一律当「没有时间」，返回空串而不是 `[NaN-NaN NaN:NaN]`；显式构造、未给时刻的消息可以没有前缀 |
| 边界 | 时刻前缀在字符安全阀计数**之前**拼上，所以也占 `historyMaxChars`；库里存的仍是原始正文 |
| 回复开头 | 模型会模仿历史行，把时刻写进自己的回复开头（实测 109 条 assistant 行里 51 条如此）。落库、最终正文、流式进度都先过 `stripStamp`，只剥开头一处，正文中间的方括号不动 |

---

## 13. 部署后 DO 可能仍在跑旧代码（2026-10-25 实录）

**现象**：deploy 成功、deployments list 最新版本也对，但线上行为仍是旧逻辑。本次实例：署名功能（§12）部署于 00:14:41，用户 00:16:53 的消息写入后 author_name 仍是 NULL；稍后再发一条，author_name 正常写入 卡利亞士兵 / DC AI BOT。中间差的不是代码，是**实例**。

**原因**：GatewayPresence 这个 Durable Object 实例是长驻的（WebSocket + 每 37 秒 alarm），新版本部署后旧实例可能在内存里继续服务一段时间才被替换/驱逐。入口 Worker 的 HTTP 路径（/api/*、/interactions）不受影响 —— 只有 DO 内的逻辑会滞后。

**判定方法**：src/workers/gateway/engine.ts 里的 GATEWAY_BUILD 常量会打在两条日志里：

- `[gateway] alarm build=<tag>` —— 每拍心跳打一次，**不需要用户发消息**，cron 每 5 分钟就能看见；
- `[gateway] dispatch build=<tag> ...` —— 每条消息打一次。

```bash
npx wrangler tail dc-ai-bot --format json   # 前台跑，另一窗口看；重定向到文件不会刷新
```

看到的 tag 与刚部署的版本不一致 ⇒ 旧实例还在，等它被替换即可（通常几分钟内），不要怀疑代码本身，也别急着再改一遍。

**排查顺序建议**：① 先看 build= 标记确认实例版本；② 再怀疑 D1 列/迁移（§6、§12）；③ 最后才怀疑业务逻辑。
---

## 14. 最近 50 条原文 + 自动/手动摘要

**注入窗口 = 最近 50 条原文**（2026-10-26 四次改口径）：库里的消息**永久保留、永不删除**，但每轮只把最近
50 条（`DEFAULT_HISTORY_MAX_MESSAGES`）原文注入提示词；另外每 50 条未总结消息**后台自动生成一段新记忆**，
追加到该频道累积记忆正文的尾部（只增不减、老段永不改写，`docs/architecture.md` §31）。
累积记忆按字数预算**从新到旧**注入 system——两者并存是刻意的（记忆兜住窗口外的旧内容）。
摘要按 `(guild_id, channel_id)` 存在 `conversation_summaries`（`migrations/0003_conversation_summary.sql`）：

| 环节 | 行为 |
| --- | --- |
| 触发 | **每条消息 1 次模型调用**（流式）；只注入最近 50 条原文（频道级可配，≥ 2 无上限；注入只由条数决定，那道 20 万字符安全阀已在 `memory-nolimit-1` 去掉）。**每 50 条未总结消息额外触发 1 次摘要调用**（后台 `waitUntil`，不占回复时延） |
| 素材 | 素材 = 游标之后所有未总结消息；自动与手动共用。自动路径只把「游标之后的原文」写成**一段新记忆**追加到正文尾部（不重写老段），积压超过单批上限时只取最旧的一批 |
| 游标 | `covered_until_id` 记下已总结到 `messages.id` 的最大值（只推进到已落库的最后一条，本轮未落库的那条留给下一次），下次自动或手动总结都只取 `id > 游标` 的新消息 |
| 时间段 | `covered_from` / `covered_to` 记下**这一段**记忆里最早/最晚一条消息的 `created_at`（`migrations/0011_summary_span.sql`），每段各写各的、不再与上一段合并；段头就是它渲染出来的。手改摘要正文（§22）沿用行里已有的时间段 |
| 素材上限 | 单批 = `min(500, max(50, 阈值))`：阈值留在默认 50 就一批 50 条，调到 200 就一批 200 条，调到 2000 也只一批 500 条、靠后面的轮次追平（`summaryBatchLimit`，`memory-nolimit-1`）。积压超过单批上限时只取**最旧**的一批，游标也只推进到这批的最后一条，下一轮接着总结——任何一条都不会被跳过 |
| 生成 | 复用当前生效路由（channel > guild > global）的 primary，失败按 fallbacks 换下一个；非流式调用 |
| 上限 | 写侧**没有上限**：提示词不再要求字数，落库也不截断（`normalizeSummary` 只 trim、剥围栏），模型写多长就存多长。唯一约束在**注入侧**：默认 4000 字（`SUMMARY_MAX_CHARS`），后台记忆页可按频道改成 500..20000（`summaryMaxChars`，`0`/留空 = 仍按 4000，§23.1）。正文永不截断丢失，超预算的老段只留在库里 |
| 进上下文 | 累积记忆按字数预算**从新到旧**装满后注入 system（最近 50 条原文同时注入，重复是刻意的）；库里没有摘要时该段不出现。**每段自带段头** `【记忆段】（覆盖 10-25 22:40 ~ 10-26 14:30，最后一句约在 10-26 下午两点半）`——括号里是被总结那些消息的落库时刻（取用户发言的时刻，不是总结的时刻），只有一头时写「覆盖到 …」，两头都不知道就只留 `【记忆段】`；段内永远旧→新，超预算的老段不进上下文（详见 `docs/architecture.md` §27、§31.3） |
| 重置 | `/reset` 同时清空本频道的消息与**整段长期记忆**（累积记忆从 0 重来），频道里回「已清空本频道的对话记录与长期记忆摘要。」 |

### 14.1 手动入口

| 命令 | 作用 |
| --- | --- |
| `/summary` | 立刻把本频道**全部**还没总结的消息总结一次，回帖「已总结 N 条消息（模型 X）」+ 摘要正文 |
| `/summary view:true` | 只看当前摘要与游标，不调模型、不改库 |

两条都是**先 ACK（`type:5`）再 PATCH** 原消息，与 `/chat` 同一条路径：结果和异常都编辑进同一条回复。
没有可总结内容时回「这个频道还没有可总结的内容」；`view` 且从未总结过时回「这个频道还没有摘要」。
`NO_ROUTE_CONFIGURED` / `ALL_PROVIDERS_FAILED` / `SUMMARY_EMPTY` 这三种最常见原因已翻成中文可操作提示。

### 14.2 空 @ 不污染记忆

只 @ 了 bot、正文是空的回合，交给模型的是一句事实标记「（对方只 @ 了你，没有写正文）」，
不再替用户编一句问话——她回什么由她自己判断。落库的就是这句标记本身（不再另设占位原文，
`TurnContext.storedUserText` 只留给「提示里的话与用户真说了什么不一致」的其它场合）：
注入的原文与手动 `/summary` 读到的都是这一句，不会出现「用户说了某句他从没说过的话」这种失真记录。

### 14.3 迁移（先迁移，再部署）

```bash
npx wrangler d1 migrations apply dc-ai-bot --remote
```

漏这一步的表现：`/chat` 与普通回复照常工作（自动摘要失败被吞掉，只打日志），手动 `/summary` 回
`D1_ERROR: no such table: conversation_summaries`（频道里看到的是回帖「总结失败：…」）；自动摘要则按
「`[chat] 读取摘要失败，按无摘要继续：…`」或「`[chat] 自动摘要失败：…`」出现在日志里。

### 14.4 失败与观测

- 自动摘要在**回复发出之后**跑（`waitUntil`），任何失败都被吞掉：回复本身永不受影响，只会少一张摘要。
- 日志关键字：`[chat] turn ... hist=<n> sum=<n> history=<n> dropped=<m> summaryLen=<n> systemLen=<n>`（每轮一行：
  `hist`/`sum` 是本轮真正生效的注入条数与自动总结阈值，来自频道配置或默认值，见 §23；`history` 是实际保留条数、
  因超限丢弃的最旧条数、注入的摘要长度、system 长度；`summaryLen=0` 表示本轮没有摘要段；`sum=0` 表示自动总结被关掉）、
  `[chat] 历史超出 <budget> 字符，已丢弃最旧 <m> 条`（warn，只有超限才打）、
  `[chat] 自动摘要完成 covered=<id> msgs=<n> len=<n>`（后台摘要成功：游标、条数、摘要长度）、
  `[chat] 自动摘要失败：`（后台摘要落库/生成失败，已吞掉）、
  `[chat] 自动摘要触发失败（不影响回复）：`（触发环节就抛了，回复照旧）、
  `[chat] 读取摘要失败，按无摘要继续：`（注入前读摘要失败，本轮按无摘要跑）、`discord 总结失败` /
  `discord 总结结果编辑失败`（手动 `/summary`，后者多半是 bot 少了权限）。
- 手动 `/summary` 的失败一定会回帖；自动摘要的失败只进日志，所以「为什么没有摘要」要查上面四条 `[chat] 自动摘要` /
  `读取摘要` 关键字，注入量的对照看 `history=<n>` 与 `summaryLen=<n>`。
- 频道记忆（未 @ 的人类发言也落库）：成功打 `[gateway] 记录消息（not-addressed）guild=… channel=…`（只有 id 与量纲，
  不含正文）；缺绑定时打 `[gateway] 缺少 DB / KEY_ENCRYPTION_SECRET 绑定，无法记录频道消息`；
  写失败打 `[gateway] 记录消息失败：…`（异常被吃掉，回复路径不受影响）。
- 成本口径：每条频道消息 1 次 D1 写；不影响回复时延（落在 `ctx.waitUntil` 里，与心跳/重连也不互相阻塞）。
- **DO 里的行为同样受 §13 影响**：deploy 之后旧 DO 实例可能还在跑旧代码，注入窗口与自动总结阈值（含 §23 的频道级配置）都要等实例被替换才生效。
  先用 `[gateway] alarm build=<tag>` 确认实例已经换成新版本（现在标记 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（23469§54）；上一次构建 `reply-tool-2`（行为与现版相同，只是验收时临时在成功日志尾部多带 `rawLen=` / `rawShell=` 两个诊断字段，`len=472 … rawLen=505 rawShell=<game>:1,</game>:1` 就是它留下的证据；现已下线）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `director-6`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `director-5`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；再前一版 `director-2` 是导演模式可观测性补丁（念法仍是再前一版那一套——judge 先按 mimo 导演模式改写要念的文本、Discord 上显示的文字仍是原文，三档 `0` 关闭（逐字朗读）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，迁移 `0025`/25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`，§47.8、§25.16），更早的 `voice-log-1`（语音发出后补一条成功日志、迁移仍 `0024`/24，§25.14、§47.7），再往前的 `tts-nolimit-1`（朗读不再设字数上限、迁移仍 `0024`/24，§47.7），更早以前的 `tts-tags-1` 是「assistant 正文开头的标签 + 正文逐字校验」那版（§25.15），更早的 `tts-style-1` 是「自然语言语气行 + `role:user` 消息」那版（朗读语气三层 + 可选情绪判断模型，§25.15 与 `docs/architecture.md` §47）；接口类型（dialect）那版见 §25.14 与 `docs/architecture.md` §46.7；前一版 `tts-admin-1` 是 TTS 接口搬进后台那版、见 §25.14 与 §46；再前一版 `prompt-scope-1` 是内置默认与身份块三层可配那版、见 §25.13 与 §45；再前一版 `voice-2` 是按指令模式补上【语音】提示段那版、`mode = 1` 的【语音】段从它起才有，见 §25.12 与 `docs/architecture.md` §44.1；再前一版 `voice-1` 是语音回复那版；§30 起同一枚门牌也跑在自托管的 Node 宿主上，见 `docs/hosting.md`；门牌含义：最近 50 条原文注入 + 频道全量记忆（库里永不删除） + 每 50 条未总结消息后台大总结（累积记忆只增不减） + 回复链与贴表情（贴表情用 PUT） + 后台实时日志 + 同供应商换 Key + 供应商超时 180s 一起生效；§20 的表情描述、§21 的表情别名、§23 的频道级记忆配置（注入条数 / 自动总结阈值，默认仍是 50 / 50）、§28 的一次多个表情 + 指定目标消息、§29 的 @ 路径流式回复（占位消息边生成边改）、§33 的贴表情文案三层自定义（见本节 §28）、§34 的贴表情素材模板三层自定义与「表情模型看最近 20 条历史」（见 §29）、§35 的选择性补记（后台按时间范围挑一段补一段记忆，游标不动，见本文件 §22.7）、§29.6 的假流式（上游整段返回时切片挤出去，见本文件 §25.7）、§38 的假流式片数三层可配（后台「回复」页，0 = 关闭）、§39 的服务器频道回复自动 @ 提问者 + `allowed_mentions` 只放开解析用户（`@everyone` / `@here` / `@角色` 仍禁，见 §25.8 与 `docs/architecture.md` §39；`mention-1` 是前一版）、`mention-2` 的前缀与「…(已截断)」一起进正文预算（`docs/architecture.md` §39.2，前一版）、`reply-continue-1` 的被掐断半句自动续写（`docs/architecture.md` §40，前一版）、`stream-edit-1` 的边说边编辑（服务层不再节流、模型每来一块就立刻推、节流只在编辑器 1200ms 一改且最多 20 次，续写的每一段同样边收边推，`docs/architecture.md` §29.7，前一版）、`empty-note-1` 的只 @ 不说话（不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接由她自己判断，见 §14.2，前一版）、`none-head-1` 的回复正文首行 `NONE` 由服务层剥掉（见 §28.6，前一版）、`vision-main-1` 的主对话模型接图（同轮只下载一份、只进首段与表情请求、续写不带图，见本文件 §19.7 与 `docs/architecture.md` §22.9，前一版）→ `vision-main-2` 的后台三层识图开关（后台「回复」页第二张卡片，默认开、每条消息现读一次；关掉后主对话请求不带图、表情模型照旧能看，见本文件 §19.8 与 `docs/architecture.md` §41，前一版）→ `mention-once-2` 的同一个人一条回复只 @ 一次（自动加在正文开头的 @ 前缀算那一次；正文里重复的 `<@id>` 换成显示名，查不到名字就整段去掉标签，见本文件 §25.10 与 `docs/architecture.md` §42，前一版）→ `pg-errors-1` 的「故障」页看中继报错（中继 `GET /admin/errors` + bot `/api/pg-errors`，见 §25.11 与 `docs/architecture.md` §43，前一版）→ `voice-1` 的语音回复（文字回复结束后可发一条 mp3 附件、三档三层开关，见 §25.12 与 `docs/architecture.md` §44，前一版）→ `voice-2` 的按指令模式提示段（提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，见 §25.12 与 `docs/architecture.md` §44.1，前一版）→ `prompt-scope-1` 的内置默认（`fallback`）与身份块（`identity`）可编辑（`prompt_defaults` 两个 key × 三层；解析顺序三层提示词 → 三层内置默认 → 代码常量；三层都没配时输出与上一版逐字相同；§25.13、`docs/architecture.md` §45，前一版）→ `tts-admin-1` 的 TTS 接口搬进后台（地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听；§25.14、`docs/architecture.md` §46，前一版）→ `tts-mimo-1` 的接口类型（dialect）（同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`，音频在 `choices[0].message.audio.data`、没有 `speed`；老行默认 `openai`、行为不变，迁移 `0023`、迁移总数 23；§25.14、`docs/architecture.md` §46.7，前一版）→ `tts-style-1` 的朗读语气三层（channel / guild / global）+ 可选情绪判断模型（模型不再可写、按接口类型取内置默认（`tts-1` / `mimo-v2.5-tts`）；迁移 `0024`、迁移总数 24；§25.15、`docs/architecture.md` §47，前一版）→ `tts-tags-1` 的朗读语气改成 assistant 正文开头的标签 + 正文逐字校验（标签贴 assistant 正文最前面、正文任意处可插 `[音频标签]`、不再发 `user` 消息；§25.15、§47.7，前一版）也打在这个门牌上，见 §20.6、§24.5 与 §25.5），别急着改第二遍。
- **`wrangler tail` 在本机会丢事件**：日志里出现 `Tail connection lost. Reconnecting`（代理环境常见）时段内的行补不回来，
  实测入口 Worker 与 DO 的 `[chat] turn` 整段消失而 `[gateway] alarm` 还在。验证关键行为时以 D1 数据（`messages` /
  `conversation_summaries` 的 `covered_until_id` 与 `length(summary)`）为准，日志只作旁证；必要时重开 tail 再看新事件。

---

## 15. 回复链与贴表情

**需求口径**：群聊里「谁在回谁」本身就是语义的一部分——只给一串并列的句子，模型分不清一句「嗯」是在同意上面哪一条。
所以这次明确两条要求：

1. 模型要知道这条消息回复了谁、被引用的原话是什么；
2. 模型可以给自己的回复贴表情——服务器里的自定义表情与 unicode 表情都行，最多 10 个（`MAX_REACTIONS = 10`，多贴只是刷屏；一次多个与「指名贴到某条消息」见 §24）。

### 15.1 迁移（先迁移，再部署）

```bash
npx wrangler d1 migrations apply dc-ai-bot --remote
```

这一步会应用 `migrations/0004_message_reply.sql`：给 `messages` 加四列 `reply_to_id` / `reply_to_author` /
`reply_to_author_id` / `reply_to_content`，统一 `TEXT NOT NULL DEFAULT ''`。**老行不回填**——空串的语义就是「不知道」，
升级之前的历史不会在提示词里凭空长出一段引用。漏掉这一步的表现：回复照常工作，落库时报
`[gateway] 记录消息失败：… D1_ERROR: table messages has no column named reply_to_id`，回复链一条也存不下来。

### 15.2 怎么工作

| 环节 | 行为 |
| --- | --- |
| 解析 | 网关读 `referenced_message` 的 id / 作者名 / 作者 id / 全文（`src/workers/gateway/message.ts`）；四个字段各自独立退化，缺一个不会拼出 `undefined` |
| 记忆行 | user 行末尾补 ` ↳ 回复 名字(id)：「原文前 40 字」`（`replySuffix` 在 `src/core/chat/react.ts`，拼行在 `src/core/chat/line.ts`）；超 40 字补 `…`，原文空白则整段省略引文，名字与 id 都没有时退化成「回复一条更早的消息」 |
| 只挂用户行 | assistant 行永远不带 `replyTo`：模型自己的发言不成链，历史里也不会出现「回复自己」 |
| 存全文 | 库里 `reply_to_content` 存被回复消息的全文，截到 40 字只发生在提示词侧，`/summary` 与人工排查看到的都是全文 |
| 表情清单 | 网关把该服务器的自定义表情放进 `TurnContext.customEmojis`，core 在 system 末尾补一段【可用自定义表情】（`renderEmojiBlock`，最多列 40 个 `:名字:`）；每个服务器内存缓存 10 分钟（`EMOJI_CACHE_TTL_MS`） |
| 教它怎么用 | system 里恒定有一段【表情】（`renderReactionGuide`，正文三层可配见 §28，无清单也出现）：正文可写 emoji，想贴到对方消息上就在末尾写 `[[react:😄]]` / `[[react:名字]]`，自定义表情也可以直接写 `:名字:`。顺序 = 预设 `before` 段（`system` 天头）→ 身份块 → 提及规则 → 表情规则块 → 语音提示 → 自定义表情清单 → 可贴表情目标 → 世界书 → 预设 `after` 段（收尾）；长期记忆摘要不进 `system`，跟着本轮那条 user 消息发（`preset-head-1` 起，`docs/architecture.md` §52.2） |
| 正文渲染 | 发消息前 `resolveInlineEmojis(text, customEmojis)`（`src/workers/discord/emoji.ts`）把命中清单的 `:名字:` 换成 `<:名字:id>`（animated 用 `<a:`），再按 1900 字符切段；未命中的名字原样保留，已成型的标记不会被二次替换 |
| 剥指令 | 模型在正文里写 `[[react:😄]]`，core 的 `splitReactDirectives` 剥掉并按出现顺序去重、截到 10 个（§24），放进 `TurnResult.reactions`；流式进度用 `visibleText` 提前剪掉半截指令，频道里看不到这个语法 |
| 谁去贴 | 网关在回复**发出之后**调 `PUT /channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me`（动词是 PUT，写 POST 会被 Discord 回 405），贴到触发本轮的那条消息上；写 `名字` / `:名字:`（大小写不敏感）或 `名字:id` 时换成该服的 `name:id`，unicode 表情原样用，都不匹配就跳过不发 |
| 空正文兜底 | 模型只写指令、正文空了时：网关回「（模型没有返回内容）」（`src/workers/gateway/engine.ts:702`），斜杠路径同样兜底（`src/workers/discord/handler.ts:376`） |

### 15.3 失败与观测

- 取表情清单失败只 warn：`[gateway] 取自定义表情失败：…`，本轮按空清单继续（system 里没有那一段，模型写 `:名字:` 也解析不出来），**回复不受影响**；失败结果同样进 10 分钟缓存，不至于每条消息都去打一次注定失败的 REST。
- 贴表情失败只 warn，每个表情各自 try：`[gateway] 贴表情失败（<表情>）：…`；名字不在清单里（或既不是 unicode 也不是清单里的表情）是 `[gateway] 表情不在该服务器的清单里，跳过：<表情>`——这类值不发给 Discord，避免 400 Unknown Emoji。
- 这些 warn 都发生在回复**发出之后**，所以表情出问题永远不会让用户少收到一条回复。
- 排障顺序：① 先看 D1 里回复链四列有没有值（落库了才算真记下）：

```bash
npx wrangler d1 execute dc-ai-bot --remote --command "SELECT id,role,substr(reply_to_author,1,20),substr(reply_to_content,1,20) FROM messages ORDER BY id DESC LIMIT 10"
```

- ② 再看 `wrangler tail` 里的 `[gateway] dispatch build=…` 与上面三条 warn。

### 15.4 已知边界

- **斜杠命令不贴表情、也不渲染正文自定义表情**：`/chat` 走 Interactions 路径，按契约忽略 `TurnResult.reactions`（交互消息是 bot 自己的，没有「触发消息」可贴），且没有表情清单注入，正文里的 `:名字:` 会以原文字面显示。想在回复上看到自定义表情，用普通 @ 消息路径。
- **被回复的消息已删除**：Discord 给 `referenced_message = null`，这条按普通消息处理，记忆里没有 `↳ 回复` 后缀。
- **私聊没有自定义表情**：`guildId` 为空直接空清单，连 REST 都不打，只有 unicode 表情可用。
- **表情清单 10 分钟缓存**：新加的自定义表情最长要等一档过期才进提示词；同一档内被删掉的表情仍会被解析成 `name:id`，贴的时候 Discord 回 404，只 warn 不报错。
- **DO 换码有延迟**：这套逻辑跑在常驻 Durable Object 里，deploy 之后旧实例可能还在跑旧代码（§13）。现在门牌号 `GATEWAY_BUILD = 'context-tool-3'`（当时：上下文工具模式——开关打开的频道把预设正文、长期记忆摘要与最近历史塞进 `context` 工具的描述体，`messages` 只发一条固定句，正文由 `story_reply` 交付，只在开关打开的频道生效、其它频道一个字节不变，迁移 0030、迁移总数 30，§55）；再往前 `GATEWAY_BUILD = 'reply-tool-3'`（32981§54）；前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ 上一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio>]`；方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=…`，只记标签 / 字节数 / 字数与 mode，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（`docs/architecture.md` §47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（`docs/architecture.md` §47）；`'tts-mimo-1'` 那一版记的是`src/workers/gateway/engine.ts:129` 顶部的常量；这一版加接口类型（dialect）——同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`（音频在 `choices[0].message.audio.data`，没有 `speed`），老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§25.14、`docs/architecture.md` §46.7；前一版 `tts-admin-1` 把 TTS 接口搬进后台——地址 / Key / 模型 / 默认音色只认后台「语音」页（`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改），`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听，§46；
再前一版 `prompt-scope-1` 把内置默认与身份块改成三层可配——`prompt_defaults` 两个 key × 三层（内置默认 `fallback` / 身份块 `identity`）、解析顺序三层提示词 → 三层内置默认 → 代码常量，「恢复默认」只删当前那一层，§25.13、`docs/architecture.md` §45；再前一版 `'voice-2'` 是按指令模式补上【语音】提示段：只有 `mode = 1` 注入、教模型在正文里单独写一行 `[[voice]]`，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§25.12、`docs/architecture.md` §44.1；再前一版 `'voice-1'` 是语音回复（文字回复结束后可发一条 mp3 附件、三档三层开关，§44）；再前一版 `'pg-errors-1'` 是后台「故障」页看 PG 中继报错（§25.11、§43）；再前一版 `'mention-once-2'` 是同一个人一条回复只 @ 一次（§42），再前一版 `'vision-main-2'`，再再前一版 `'vision-main-1'`，再再再前一版 `'none-head-1'`），`[gateway] alarm build=reply-tool-3` 出现即代表实例已换新。

---

## 16. 实时日志与自动重试

后台的「实时日志」页不再需要一直挂着 `wrangler tail`：运行期事件落进 D1 的 `runtime_logs` 表（`migrations/0005_runtime_logs.sql`），前端轮询同一张表。写入永远不挡业务路径——只在 `ctx.waitUntil` 里插一行、写失败只 warn。

### 16.1 怎么在后台打开

- 浏览器打开管理后台（`/api/**` 之外都由 `ASSETS` 提供，SPA 回退），用 `ADMIN_PASSWORD` 登录后点顶栏的**实时日志**标签（`web/src/App.tsx:16`，与「提示词」「模型路由」「供应商密钥」并列）。
- 数据来自 `GET /api/logs?after=<id>&limit=<n>`（Cookie 鉴权，未登录 401），返回 `{ items: StoredLogEntry[], latest: number }`：`items` 按 `id` 升序，`latest` 就是下一轮的游标（结果为空时等于传进来的 `after`）。`after` 缺省 0，`limit` 缺省 200 并夹在 1..500。
- 页面首次挂载用 `after=0&limit=200` 拉一段历史，之后每 **2 秒** 带上一轮的 `latest` 拉增量；内存里最多留 **500** 条，超出从头丢。
- 支持暂停 / 继续（暂停期间不发请求）、清空当前视图（只清屏，不动 D1）、按级别（`info` / `warn` / `error`）与 scope（`chat` / `provider` / `summary` / `gateway` / `admin`）过滤；时间列等宽 `HH:mm:ss`。
- 轮询失败只在页内提示一行，不弹窗也不清屏：后台短暂连不上不影响你已经看到的历史行。

### 16.2 保留策略与写入路径

- 只留最近 **800** 条（`DEFAULT_LOG_KEEP = 800`，`src/workers/db/log-store.ts:5`）。每次 append 在同一个 batch 里先插再删：`DELETE FROM runtime_logs WHERE id <= (SELECT MAX(id) - ? FROM runtime_logs)`；行数不足 800 时右值为负或 NULL，天然不删，不需要先 COUNT。
- 一条 `LogEntry` 只有 `level` + `scope` + `message` + `createdAt`（ISO 字符串）四个字段，没有 trace id、没有请求 id 这类高基数维度。高频事件（每一条下行帧、每次心跳、每次轮询）**不记**，否则 800 条会被刷屏冲掉真正有用的那几行。
- 写入走 `ctx.waitUntil(...)`：入口 Worker 用请求自带的 `ctx`，Gateway DO 用 `this.#ctx`；写失败只打 `console.warn('[log] 写日志失败：…')`，不影响回复。`scheduled` 没有 `ctx`，那里需要记日志时直接 `await` 并 try/catch（cron 保活异常就是这条路径）。
- 同一份 `createLogStore(env.DB)` 在入口两处（ChatService 与 AdminApp）与 DO 内各建一次，读写的是同一张表、同一套 800 条保留规则。

### 16.3 自动重试

模型调用（`src/core/providers/rt.ts`）只加**一层**重试，规则很短：

| 情况 | 是否重试 |
| --- | --- |
| 状态 `429` / `500` / `502` / `503` / `504` | 重试一次 |
| `fetch` 抛网络错误（DNS、连接被重置、非 abort 的超时等） | 重试一次 |
| `400` / `401` / `403` / `404` / `422` | 不重试（参数或鉴权问题，重发只会再错一次） |
| 调用方 `AbortSignal` 取消（`AbortError`） | 不重试（用户已经不要这次结果了） |

- 两次尝试之间固定退避 **800 ms**（`RETRY_DELAY_MS = 800`），不做指数退避、不看 `Retry-After`：最坏情况只多等一次退避，不会把一次回复拖成十几秒。
- `MAX_ATTEMPTS = 2` 是**总尝试次数**（首发 + 1 次重试），不是「重试 2 次」。
- 最终失败的报错串格式没变：`<provider> HTTP <status>: <body 前 300 字>`；后台日志里的 `回复失败 …` 与 `wrangler tail` 里看到的是同一行文字。
- 重试只发生在 provider 请求这一层：摘要、贴表情、落库都不重试，各自 try/catch 后只记一行日志，绝不影响已经发出去的回复。

### 16.4 排障顺序

先看后台日志 → 再看 D1 → 最后才上 `wrangler tail`：

1. **后台「实时日志」**：一次请求通常就是一串 `chat` / `provider` 行，最省事。`error` / `warn` 一眼能分出是回复失败、摘要失败、还是 provider 重试后仍然失败（`provider` scope 的行会连着重试一起出现）。
2. **D1**：日志只证明「发生过」，要确认「结果如何」必须查表——`messages`（含回复链四列）与 `conversation_summaries.covered_until_id` / `length(summary)`。日志里没有正文，所以「它到底回了什么」只能看 `messages`。
3. **`wrangler tail`**：只在前两者覆盖不到时才用（DO 内部细节、`ctx.waitUntil` 之外的异常、部署瞬间的报错）。本机 tail 会丢事件（见 §5），关键行为不要以它为准。

### 16.5 为什么日志里没有消息正文

- 频道消息与模型回复的正文一律**不写日志**。日志表是跨会话共享的环形表（只留 800 条、任何登录后台的人都能看），正文是用户内容，写进去等于给它开了一份没有保留期管理、没有脱敏、也没有访问审计的第二副本。
- 所以 chat / summary 的事件只记量纲：`回复成功 model=<provider>/<model> history=<n> dropped=<n> ms=<duration> len=<n>`、`自动摘要完成 covered=<id> msgs=<n> len=<n>`；失败行只截错误信息前 **300** 字（那是 provider 的报错，不是用户正文）。
- 要看内容就去 D1 的 `messages`（有明确的生命周期与删除路径）。复现问题时，用 `history` / `dropped` / `len` / `ms` 这几个数字加 `messages` 里的对应行足够定位。
- 同理，`登录失败 ip=<ip>` 只记来源 IP（`CF-Connecting-IP`，取不到写 `unknown`），不记口令、不记 Cookie。

### 16.6 已知边界

- **日志从这一版开始才有**：deploy 之前的请求不会追溯出现，`runtime_logs` 里第一行的时间就是你部署的时刻。
- **2 秒是前端最细粒度**（§19.11）：再短没有意义，只会把 D1 读放大。
- **DO 换码有延迟**（同 §15.4 / §13）：deploy 之后旧实例可能还在跑旧代码，`[gateway] alarm build=summary-order-2` 出现（`GATEWAY_BUILD = 'summary-order-2'`）才代表网关侧的六类事件真的开始落库。
- **日志不是审计**：它能被 800 条环形覆盖，也可能因为写失败而缺失；要长期留存的结论请落在 D1 的业务表里。

## 17. Key 与模型的对应（哪个模型用哪把 Key）

路由里写了哪个供应商的模型，就用**那把供应商的 Key**；一把不行再在**同一个供应商内**换下一把。旧实现只取「最早启用的那一把」（SQL 里 `LIMIT 1`），所以同一个 provider 配了多把 Key 时，后面的永远用不到——这一版把这条路径改掉了。

### 17.1 迁移

```bash
npx wrangler d1 migrations apply dc-ai-bot --remote   # 应用 0006_key_models.sql
```

新增一列 `provider_keys.models`（`TEXT NOT NULL DEFAULT ''`，逗号分隔）。老数据不用回填：空串解析成空数组，语义是「这把 Key 什么模型都能跑」，与升级前的行为一致。

### 17.2 后台怎么填「适用模型」

- 打开管理台 → **供应商密钥** → 新建或已有那把 Key 的「适用模型」输入框。
- 逗号分隔（中文逗号也认），例如 `deepseek-*、deepseek-v4-pro`；**留空 = 全部**。
- 支持尾部通配：`deepseek-*` 命中 `deepseek-chat` / `deepseek-v4-pro`。最多 20 项，每项 1..64 字符；字符集是字母、数字、`._:-` 加结尾 `*`（字母按 unicode 算，中文模型名如 `假流式-pg-gemini-4-argon` 也收；逗号、斜杠、空格不收，写错返回 `BAD_MODELS`）。
- 名单是**排序偏好不是硬约束**：没被声明的 Key 仍在候选里，只是排在后面。这样新模型上线时不必先去改 Key 名单也能跑通。

### 17.3 同一供应商内选 Key 的顺序

| 档 | 什么情况 | 位置 |
| --- | --- | --- |
| 0 | 名单里显式命中这个模型（含 `前缀*` 命中） | 最前 |
| 1 | 名单为空，或只有 `*`（通用） | 中间 |
| 2 | 名单声明的是别的模型 | 最后 |

同档内保持创建时间升序（`created_at, id`），也就是你在后台建 Key 的先后顺序。三档全部参与尝试——不是「声明不匹配就不用」。

### 17.4 什么时候换下一把 Key

| 情况 | 行为 |
| --- | --- |
| 这把 Key 在**产出第一个字符之前**失败（`4xx` / `5xx` / 网络错误，各自已按 §16.3 重试过一次） | 换同供应商下一把 Key 重试这次回复 |
| 已经**开始产出可见文本**之后才失败 | **不换**：直接把这个候选模型计为失败，走路由的 `fallbacks`（换 Key 会让同一条消息从头重写，用户会看到文字跳变） |
| 同供应商所有 Key 都失败 | 这个候选模型失败，错误记**最后一把 Key** 的原始报错；继续试 `fallbacks` 里的下一个模型 |
| 这个供应商一把 enabled 的 Key 都没有 | 记 `NO_KEY_FOR_PROVIDER`（不再尝试该模型） |
| 全部候选都失败 | 回复 `所有模型都调用失败`，后台日志里有完整的 `ALL_PROVIDERS_FAILED` 明细 |

摘要请求是非流式的，所以它会把这把供应商的 Key 逐把试完（§14）。

### 17.5 怎么确认是哪把 Key 在干活

后台「实时日志」里，成功的回复行末尾多了 ` key=<备注>`：

```
回复成功 model=openai-compat/deepseek-v4-pro key=小明 history=632 dropped=0 ms=21044 len=418
```

`key=` 后面是你给那把 Key 起的**备注**（`label`），不会是密钥、也不会是密钥片段。失败行里没有 `key=`，错误串就是最后一把 Key 拿到的原始报错——一眼能看出是「这条模型名这把 Key 不认识」还是「这把 Key 本身失效」。

### 17.6 已知边界

- **名单只影响顺序**，删掉/改错名单不会让某把 Key 彻底不可用；反过来，名单写对了也可能因为前面那把更早的通用 Key 成功而被它先接走（通用档排在显式命中之后，所以正常不会）。
- **调用次数上限变高**：单次回复最坏 = `候选模型数 × 同供应商 Key 数 × 2`（每把 Key 各自重试一次，§16.3）。配 5 把 Key 时，一个持续故障的模型名会让一次回复多等几轮超时。
- **只在同一 provider 内换**：跨供应商仍靠路由的 `fallbacks`，换 Key 不会跨供应商。
- **改了名单立即生效**：每次请求都重新读库，没有缓存；但也意味着你改完那一刻正在跑的回复仍按旧顺序。
- **删 Key 不改路由**：路由里写完的 `<provider>/<model>` 不会因为 Key 被删而自动改写。
- **名单只能在新建 Key 时填**：管理台目前没有「改已存在 Key」的入口；要给老 Key 补名单只能删掉重建（密钥要重新粘贴一次）。

## 18. 表情模型

主回复模型不必再惦记表情：后台另配一个（通常更便宜的）模型，每轮回复之后再单独问它一次「贴不贴、贴哪个」。
它只是**附加的一次调用**——没启用、配错、失败，全都只影响「贴不贴」，正文、落库、摘要一字不变。

> §24 起表情模型可以一次挑多个、还能指名贴到别的消息；18.2 写的「只挑一个」是它第一次落地时的样子，口径以 §24 为准。

### 18.1 打开方式

管理台顶栏**表情**标签（`web/src/pages/ReactionPage.tsx`）：

1. 勾上「启用表情模型（每轮回复后多一次调用）」。
2. **供应商**下拉选 `openai-compat` / `anthropic` / `gemini`（与路由页、密钥页同一套枚举）。
3. **模型名**填供应商的**原始模型名**（如 `deepseek-chat`、`gpt-4o-mini`）：不做别名映射，也不会被路由表的 `primary` / `fallbacks` 改写。
4. 点**保存**，页面出现「已保存」。

背后的接口两条，形状**不一样**：

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/reaction-model` | `{ config: { enabled, provider, model } }`；一行都没配过时 `{ enabled:false, provider:'openai-compat', model:'' }` |
| PUT | `/api/reaction-model` | body `{ enabled, provider, model }`；成功回**配置本体**（不是 `{ config }`） |

- **不勾启用**、**模型名留空**、或表里根本还没这一行 = 关：行为与没有这个功能完全一致，只剩主模型自己写在正文里的 `[[react:…]]`（§15）。
- 勾了启用但模型名是空白 → `400 { error: 'BAD_REACTION_MODEL' }`（前端会先拦一次「启用表情模型后必须填写模型名称」）。
- 供应商不在 `openai-compat` / `anthropic` / `gemini` 之内 → 同样 400 `BAD_REACTION_MODEL`。**关掉时允许模型名留空**，所以「先关再清空」不会被拒。

### 18.2 怎么工作

1. 普通消息（§11）的回复**已经流式发完、且已经落库**之后才问（`src/core/chat/service.ts:862-868`：在 `conversations.append` 与自动摘要触发之后）。正文此刻已经确定，问不问得到都不会再改它。
2. 用你配的**那一个**供应商 + **那一家自己的 Key** 发一次**非流式**请求；同供应商配了多把 Key 时按 §17.3 的顺序逐把试。
3. system 是**三层解析后的贴表情文案**（§28；`buildReactionRequest` 的 `input.guide`，三层都没配时是内置默认，渲染层会在前面补【表情】标题）：只输出表情本身（unicode emoji，或清单里的 `:名字:`）；**不值得贴就一行 `[[react:…]]` 都不写**（none-head-1 起共用默认文案不再提 `NONE`），`NONE` 这个约定只在表情请求这一侧——由 `NO_REACTION_NOTE` 单独拼在 system 末尾（§28.6），不要解释、不要标点、不要代码围栏。§18 时这一段是写死的 `REACTION_SYSTEM_PROMPT`，本版已删除。
4. user 一侧是三段拼起来的：
   - `【对方的消息】` + 触发这条回复的那条消息正文；
   - `【我的回复】` + 本轮回复的最终正文（已剥掉 `[[react:…]]` 与行首假时刻，就是用户看到的那份）；
   - `【可用自定义表情】` + 清单（写成 `:名字:`，去重，**最多 40 个**）——服务器一个自定义表情都没有时这一段整段不出现。
5. 输出逐行解析成表情清单（`normalizeReactions`）：§18 时是单值版 `normalizeReaction`（取第一行 → 整段是 `[[react:X]]` 就取 X → 剥掉包裹的反引号与引号 → 空、`NONE`、`none`、`无`、`不贴` 都判为不贴 → 含空白只取第一个 token → 长度超过 64 字符判为不贴），§24 起改成一行一个、逐行判定。
6. 与主模型自己写在正文里的 `[[react:…]]` **合并**：主模型的排前面，去重保序，**最多 10 个**（`MAX_REACTIONS = 10`），缺省贴在**触发这条回复的那条消息**上（§15）；一次多个与指名目标见 §24。

### 18.3 什么时候不贴

| 情况 | 表现 |
| --- | --- |
| 功能没启用（`enabled=false`） | 不问，一次调用都不发 |
| 没配置（表里还没有这一行，读出来是 null） | 同上 |
| 这一轮不是普通消息（斜杠命令） | 不问：没有可贴表情的触发消息（§15） |
| 该供应商下没有可用 Key | 记一行 `[chat] 表情模型没有可用 Key`，不贴 |
| 该供应商所有 Key 都失败 | 记一行 `[chat] 表情选择失败：<原因>`，不贴 |
| 模型回 `NONE` / `none` / `无` / `不贴`，或输出为空 | 正常结果，不贴 |
| 输出解析不出来（超过 64 字符等） | 不贴 |
| 名字不在该服务器的自定义表情清单里 | 不贴，网关侧记 `[gateway] 表情不在该服务器的清单里，跳过：<表情>`（§15） |

**以上每一条都只影响「贴不贴」**：正文、落库、摘要、回复链完全不受影响，也不会让这一轮回复失败或重问一次模型。

### 18.4 观测

- **成功**：写进 D1 的 `runtime_logs`，`scope=chat`、`level=info`，后台**实时日志**页直接可见（§16.1）：

  ```
  表情选择 model=openai-compat/deepseek-chat value=😄 ms=842 images=0
  ```

  四个字段分别是供应商/模型、最终选中的表情、这一次调用的耗时、这一次请求带了几张图（`images=0` 表示没带图或读图失败，失败会另有 §19 那条 warn）；只记量纲不记正文（§16.5）。
- **没有可用 Key**：`[chat] 表情模型没有可用 Key`。
- **调用失败**：`[chat] 表情选择失败：<最后一把 Key 的原始报错>`。
- 这两条 `[chat] …` 是 `console.warn`，只走 Worker 的 console，要看就上 `npx wrangler tail`（§16.4）；`runtime_logs` 只由 `emit()` 显式写入，这一版只为**成功**那条接了 `emit`。
- 图片的边界与两条下载/读图 warn 见 §19。

### 18.5 迁移

```bash
npx wrangler d1 migrations apply dc-ai-bot --remote   # 应用 0007_reaction_model.sql
```

`migrations/0007_reaction_model.sql` 建一张单行表 `reaction_model`：`id INTEGER PRIMARY KEY CHECK (id = 1)`，其余是 `enabled` / `provider` / `model` / `updated_at`。
保存走 `INSERT … ON CONFLICT (id) DO UPDATE`，永远只写 `id = 1` 那一行。**老库不需要回填**：没有这一行、或行里 `provider` / `model` 还是空串，读侧都当「还没配」返回 null。

### 18.6 已知边界

- **只换 Key，不换模型**：同一供应商内逐把 Key 试完就结束，没有 `fallbacks`、也不跨供应商兜底——配的模型挂了，这轮就是不贴。
- **斜杠命令路径不贴表情**：命令回合不设 `wantReactions`，一次调用都不发（与 §15「斜杠命令不贴」同一条边界）。
- **清单上限 40 个**（`REACTION_MAX_CATALOG = 40`）：服务器自定义表情再多也只列前 40 个，否则几百个名字会把这一跳的 prompt 撑开。
- **开销与主模型同量级**：这一跳的输入含**整条回复正文**，长回复时它的 token 量级和一个普通请求相当；想省就把模型选成最便宜的那一档。
- **后台「启用」但模型名留空会被拒**：`400 { error: 'BAD_REACTION_MODEL' }`（§18.1）。
- **改配置立即生效**：每次回复都重新读库、没有缓存；但改完那一刻正在跑的回复仍按旧配置。

---

## 19. 多模态图片（主对话与表情模型都能看图）

§18 的那个表情模型可以**顺带看图**：它挑表情时，除了对方的消息与你的回复，还能拿到最多 4 张图片。
**`vision-main-1` 起主对话模型也接同一轮那几张图**（只进首段请求、续写请求不带图，§19.7）；注入的最近 50 条原文、摘要素材、落库正文仍然全是纯文字。本节 19.1–19.6 记的是表情模型那一侧的原始口径，标「历史」的就是 `vision-main-1` 之前的行为。

### 19.1 打开方式与前提

四个条件同时成立才会看图，缺一个就退化成纯文字（行为与 §18 逐字相同）：

| 条件 | 在哪看 |
| --- | --- |
| 表情模型**已启用**（`enabled=true`） | 后台「表情」页（§18.1） |
| **模型名非空**（读出来不是 null） | 同上；启用但留空保存会被 `400 BAD_REACTION_MODEL` 拒（§18.1） |
| 网关**接了读图钩子** | `src/workers/gateway/engine.ts:667-674`：本轮收到可用附件才挂 `context.loadImages`，没图连键都不设 |
| 该供应商**有可用 Key** | 后台「密钥」页（§17）；没 Key 时连下载都不会发生 |

- **模型支不支持读图是供应商的事**：配一个不支持读图的小模型，图片发过去也会被忽略或被上游拒，表现就是「问了也白问」。想真用它看图，选一个多模态模型名。
- **`vision-main-1` 之前主对话模型怎么配都不会看图**（历史口径）：图片当时只进那一次表情请求，@bot 一句「看看这张图」主模型答不上来。现在它会接着看同一轮的图——条件是网关接了读图钩子、主对话那条链有可用 Key、且选的是多模态模型名（§19.7）。

### 19.2 看哪几张图（顺序与上限）

判定与收集都在 `src/workers/gateway/images.ts`：

| 规则 | 行为 |
| --- | --- |
| 来源与顺序 | 触发这条回复的**那条消息**的附件在前，它**回复的那条消息**（referenced_message）的附件在后（`collectImageRefs`，`images.ts:110-123`） |
| 张数上限 | **最多 4 张**（`MAX_IMAGES = 4`，`images.ts:11`）；两个来源加起来超过 4 张就**只取前 4 张**，后面的静默丢弃 |
| 单张大小 | **≤ 5MB**（`MAX_IMAGE_BYTES = 5 * 1024 * 1024`，`images.ts:14`）；超过 5MB、size 缺失或为 0 的直接跳过 |
| 类型判定（优先） | `content_type` 以 `image/` 开头就收 |
| 类型判定（兜底） | 只有 `content_type` **缺失或空串**时才按 URL 扩展名猜：`.png` `.jpg` `.jpeg` `.webp` `.gif` |
| 明确不接受 | `content_type` 是 `video/*`、`application/pdf` 之类，**即使扩展名像图片也丢弃** |

- 扩展名兜底只看 URL 的**路径部分**：先切掉 `?` 与 `#` 之后的签名串（`urlPath`，`images.ts:56-59`），所以 `xx.png?ex=…&hm=…` 照样认。
- 顺序是契约的一部分：模型按数组顺序看图，所以「对方这条」排在「它回复的那条」之前。

### 19.3 什么时候根本不会下载

下载是**懒加载**：只有走到真要发表情请求那一刻才抓图（`src/core/chat/service.ts:860`）。
下面这几种情况**一个字节都不会下载**——这是运维最常误解的一点，别以为「开了功能就一定在拉图」：

| 情况 | 代码证据 | 表现 |
| --- | --- | --- |
| 表情模型没启用 | `service.ts:925`（`cfg === null || cfg.enabled !== true` 直接返回空数组） | 不问模型、不下载 |
| 表里没有这一行 / 模型名为空 | `service.ts:923-925`（读侧当没配、返回 null，§18.5） | 同上 |
| 网关没接读图钩子 | `service.ts:830`（`ctx.loadImages === undefined` 返回空数组） | 有表情、没有图 |
| 该供应商没有可用 Key | `service.ts:853-860`：先查 Key，没有就 warn 返回，**下载排在这之后** | 记 `[chat] 表情模型没有可用 Key`，不下载 |
| 两条消息都没有可用附件 | `engine.ts:668-674`（空数组时不挂钩子） | 纯文字请求 |

最后一条的关键：收集阶段（类型 / 大小 / 张数）判定不通过时是**静默**的，不打任何日志。所以「日志里 `images=0`、可消息里明明有图」通常就是附件在收集阶段就被丢了——视频、PDF、超 5MB、size 缺失。

### 19.4 失败与观测

**两条 warn，逐字如下，都只走 Worker console（`npx wrangler tail`），不进 `runtime_logs`：**

| 文案 | 打在哪 | 触发条件 |
| --- | --- | --- |
| `[gateway] 图片下载失败：<url>` | `images.ts:149` / `:154` / `:160` | 非 2xx、空体、抛错（超时 / 中断 / URL 过期）三者一律同待遇，逐张跳过 |
| `[chat] 读取图片失败，按无图继续：<reason>` | `service.ts:834` | 读图整体抛错 |

- 两条都只是**少看几张图**：表情照样挑、回复照样发，绝不会因为图片让这一轮失败或重问模型。
- 下载是一张张串行做的：坏一张不影响后面的，warn 也只针对那一张。

**成功那条写在 D1 的 `runtime_logs`**（`scope=chat`、`level=info`，后台**实时日志**页可见，§16.1）：

```
表情选择 model=<provider>/<model> value=<表情> ms=<毫秒> images=<张数>
```

- `images=` 是**这次真正发出去的张数**，0 也照写（`service.ts:889-898`）。
- `images=0` 只说明「这次请求没带图」：要么本来就没有附件，要么读图失败了——后者会另有一条上面那个 `[chat] 读取图片失败…` 的 warn，两条一起看才判得准。
- 同章另两条（`[chat] 表情模型没有可用 Key`、`[chat] 表情选择失败：<原因>`）见 §18.3 / §18.4。

### 19.5 已知边界

| 边界 | 说明 |
| --- | --- |
| 斜杠命令不看图 | `/chat` 等命令路径**从不设** `loadImages`（与 `wantReactions` 同源；`engine.ts:667-674` 只有普通消息路径挂它），命令里附的图一定看不到 |
| 不落库 | 图片不进 `conversations`、不进历史注入、不进摘要：`LlmImage` 只活在这一轮请求的内存里，重放历史永远看不到那张图 |
| URL 会过期 | Discord 附件 URL 带签名，所以**每次都重新下、不缓存**；事后拿日志里的 URL 再 curl 多半是 403/404 |
| `content_type` 优先 | 上游给了 `content_type` 就按它判：`video/*`、`application/pdf` 即使 `.png` 结尾也丢 |
| 超限静默 | 超过 4 张只取前 4、单张 >5MB 直接忽略、size 缺失也忽略——全部在收集阶段丢，**不打日志** |
| 成本 | 图片进上下文会显著抬高这一跳的 token；想省就只开给便宜的多模态小模型（§18.6） |

### 19.6 门牌与换码

网关多模态第一版的门牌是 `vision-1`（历史），识图那两版是 `vision-main-1` 与 `vision-main-2`（§19.7、§19.8）；现在门牌是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（51415§54）；上一次构建 `reply-tool-2`（行为与现版相同，只是验收时临时在成功日志尾部多带 `rawLen=` / `rawShell=` 两个诊断字段，`len=472 … rawLen=505 rawShell=<game>:1,</game>:1` 就是它留下的证据；现已下线）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `director-6`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `director-5`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio>]`；方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=…`，只记标签 / 字节数 / 字数与 mode，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（`docs/architecture.md` §47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（`docs/architecture.md` §47）；`'tts-mimo-1'` 那一版记的是§25.14、`docs/architecture.md` §46.7，接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`，老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23）；前一版 `tts-admin-1`，§46 记 TTS 接口搬进后台：地址 / Key / 模型 / 默认音色只认后台「语音」页，加密入库只回掩码，`VOICE_TTS_*` 那一版起不生效，每条消息现读一次；再前一版 `prompt-scope-1` 是内置默认与身份块可编辑那版、§25.13、§45；再前一版 `voice-2` 是按指令模式补上【语音】段那版、§25.12、§44.1；再前一版 `voice-1` 是语音回复那版、§44；再前一版 `pg-errors-1` 是后台「故障」页看 PG 中继报错那版，§25.11、§43；再前一版 `mention-once-2` 是同一个人一条回复只 @ 一次那版，§25.10、§42：

```bash
npx wrangler tail dc-ai-bot            # 看 [gateway] alarm build=reply-tool-3
```

- `src/workers/gateway/engine.ts:129`：`GATEWAY_BUILD = 'context-tool-3'`（当时：上下文工具模式——开关打开的频道把预设正文、长期记忆摘要与最近历史塞进 `context` 工具的描述体，`messages` 只发一条固定句，正文由 `story_reply` 交付，只在开关打开的频道生效、其它频道一个字节不变，迁移 0030、迁移总数 30，§55）；再往前 `GATEWAY_BUILD = 'reply-tool-3'`（56400§54）；前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ 上一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio>]`；方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=…`，只记标签 / 字节数 / 字数与 mode，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（`docs/architecture.md` §47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（`docs/architecture.md` §47）；`'tts-mimo-1'` 那一版记的是这一版加接口类型（dialect）——同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`，老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），§46.7、§25.14；前一版 `tts-admin-1` 把 TTS 接口搬进后台——地址 / Key / 模型 / 默认音色只认后台「语音」页（`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改），`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听，§46；再前一版 `prompt-scope-1` 把内置默认与身份块改成三层可配——`prompt_defaults` 两个 key × 三层（`fallback` / `identity`）、解析顺序三层提示词 → 三层内置默认 → 代码常量、身份块模板逐行丢弃，§45、§25.13；再前一版 `voice-2` 是按指令模式补上【语音】提示段：只有 `mode = 1` 注入、教模型写一行 `[[voice]]`，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§44.1、§25.12；再前一版 `voice-1` 是语音回复：文字回复结束后可发一条 mp3 附件、三档三层开关，§44；再前一版 `pg-errors-1` 是后台「故障」页看 PG 中继报错那版，§43、§25.11；再前一版 `mention-once-2` 是同一个人一条回复只 @ 一次那版，§42；再前一版 `vision-main-2` 是识图开关那一版，§19.8；再前一版 `vision-main-1` 是主对话接图那一版，§19.7；`vision-1` 是 §22 落地那一版；网关逻辑全在 `src/workers/gateway/engine.ts`，历史入口文件只剩 re-export，它打在两条日志上：`[gateway] alarm build=reply-tool-3`（心跳，每拍一次，不用等消息）与 `[gateway] dispatch build=reply-tool-3 …`（每条消息）。
- **只有看到 `build=reply-tool-3` 才说明 DO 已经在跑这一版**。GatewayPresence 是长驻实例，新版本部署后旧实例会继续服务一段，**被驱逐后才换码**（通常几分钟到数小时，§13）。
- 还在旧 tag 时的典型表现：表情照挑，但请求里**没有图**（`vision-main-1` 之前主对话的首段请求同样不带图），日志那行也**没有 ` images=` 字段**。这不是 bug，别改代码，等驱逐。
- 同理，实时日志里翻到的老记录没有 `images=` 是版本差异，不是丢字段（§18.4 的样例就是 vision-1 之前的形态）。

### 19.7 主对话模型接图（`vision-main-1` 起）

同一轮里主对话的首段请求与表情请求共用**同一份**图片；续写请求不带图。运维要看的四件事：

| 看什么 | 预期与代码证据 |
| --- | --- |
| 网关有没有收到图 | 消息里得真带附件：最多 4 张（`MAX_IMAGES = 4`，`src/workers/gateway/images.ts:11`）、单张 ≤ 5MB（`MAX_IMAGE_BYTES = 5 * 1024 * 1024`，`:14`）、只认 `image/*`；§19.2 的收集规则对主对话这一侧**逐字照旧** |
| 一轮只下一份 | 网关挂的钩子自带同轮 memo（`src/workers/gateway/engine.ts:667-674`：`imageRefs` 非空才挂，`cachedImages ??= loadImages(imageRefs, imageFetch)`），服务层再包一层 turn 级 memo（`turnImages` / `loadTurnImages`，`src/core/chat/service.ts:820-837`）：主对话在模型 / Key 循环**之外**取一次（`:1037`），表情那一路共用同一个 promise（`:1197`）。日志里不该出现「同一张图下了两遍」 |
| 请求带了没 | 首段请求有图才带 `images`（`src/core/chat/service.ts:1071-1076`，条件展开——无图时请求形状与旧版逐字相同）；续写另建对象、**绝不带图**（`:1108-1116`）；成功日志的 ` images=<张数>` 紧跟 `cont=`（`:1183-1186`），无图时整行与旧版一样 |
| 读图失败 | 只记一条 warn `[chat] 读取图片失败，按无图继续：<reason>` 然后按无图继续，回复照样发（`src/core/chat/service.ts:829-837`） |

- **斜杠命令仍然不看图**（§19.5 第一条）：命令路径不设 `loadImages`，`/chat` 里附的图一定看不到。
- **图片仍然不落库**（§19.5 第二条）：`vision-main-1` 没改这一点，重放历史仍看不到那张图。
- 主对话模型支不支持读图仍是供应商的事（§19.1 第一条）：配一个纯文本模型，图发过去会被忽略或被上游拒。

### 19.8 识图开关（`vision-main-2` 起）

`vision-main-2` 起「主对话模型看不看图」是一个后台开关，位置是网页后台「回复」页的**第二张卡片**（第一张是 §25.7 的假流式片数）：选层级 → 填 ID → 开 / 关 → 保存。三层（**频道 > 服务器 > 全局**），第一层有合法值就盖住后一层；三层都没有就是**开**（等于 `vision-main-1` 的行为）。

- 私聊没有频道层，只有服务器层与全局层。
- 每条消息现读一次、不缓存：改完下一条消息就生效，不用重启、不用等缓存过期。
- 关掉的表现：**主对话模型看不到图**（首段请求里没有图，请求形状与「这一轮本来就没图」逐字相同），**表情模型照旧能看到这一轮的图**（§19.7）——这条能把「开关被关了」与「图在收集阶段就被丢掉」区分开：后者表情那一侧同样看不到。
- 关掉不增加下载：一轮里图片仍然只下一份（§19.7），关掉只是主对话那一侧不去要；表情模型没启用时，关掉后一次都不下载。
- 读开关失败不影响回复：读不出来按「这一层没配」继续下一层，三层全读不出来就是默认（开），回复照常生成、照常发。
- 契约、表结构与错误码见 `docs/architecture.md` §41；抱怨「看不到图」时的排查顺序见 §28.7。

## 20. 自定义表情认图（表情描述）

Discord 只把自定义表情的**名字 + ID** 交给机器人，图本身看不到。服务器里没有名字含「奶龙」的表情时，
群里有人要贴一个清单里没有俗称的表情，bot 只能回「没有这个表情」——哪怕库里就躺着一张长得一模一样的二创像素图。
§23 的做法是让**表情模型自己看表情图**，写一句中文描述存进 D1，之后提示词里就写成 `:laugh:`(黄色胖角色站立掐腰)。

### 20.1 为什么需要它

| 阶段 | 主提示词里的清单 | bot 对「给我贴奶龙」的反应 |
| --- | --- | --- |
| 没有描述 | `:laugh:` `:e94c105494eef01fe3ee53dea6fe9925:` | 名字对不上，回「没有这个表情」 |
| 有描述 | `:laugh:`(黄色胖角色站立掐腰) | 能按外形对上；但描述里没有「奶龙」二字时，挑不挑得中仍看模型自己的联想 |

- 描述**只进提示词**：正文、历史、摘要、落库一律不变（§23.8）。
- **如实记录**：36 个表情全部认出来了，但模型认不出那张图就是奶龙（二创像素图），描述里没有「奶龙」二字，实际写的是「黄色胖角色站立掐腰」。这功能解决的是「看得出长得像」，不是「叫得出名字」；想让它按名字认，得在提示词或人设里另外交代。

### 20.2 怎么用

后台「表情」页（§18.1）下方有一块独立区块，标题是「认表情（让模型看表情图，生成中文描述）」（`web/src/pages/ReactionPage.tsx:177`）：

| 元素 | 行为 |
| --- | --- |
| 服务器 ID 输入框 | 填**纯数字雪花号**（例如 `1234567890123456789`）；为空时两个按钮都是灰的（`ReactionPage.tsx:128`） |
| `认新表情` | `force=false`：只认**还没有描述**的表情，已有的原样不动 |
| `全部重认` | `force=true`：覆盖已有描述，先弹一次 `全部重认会覆盖已有的中文描述，确定继续？`（`ReactionPage.tsx:109`） |
| 结果行 | `已认 N 个，失败 M 个`（`ReactionPage.tsx:115`） |
| 结果列表 | 每行 `名字(id) → 描述`，最多显示 **50** 条，超出只写「还有 X 条」（`EMOJI_PREVIEW_LIMIT = 50`，`ReactionPage.tsx:24`） |

- 用的是「表情」页**上半部分配的那个模型**（供应商 + 模型名，§18），不另外配一套。
- **不要求 `enabled=true`**：表情模型关着也能先把描述认好（§23.4 第 2 步）。
- 一次认图是一个同步请求（`POST /api/emojis/describe`），期间按钮显示「认图中…」/「重认中…」，别关页面。
- 成本实测：36 个表情一次认完 = **6 次模型调用**（每批 6 个）、**约 25 秒**，返回 `described: 36` / `failed: 0`，耗时 25272 毫秒。

### 20.3 描述存在哪、什么时候刷新

表 `emoji_descriptions`，迁移 `0008_emoji_descriptions.sql`：

| 列 | 说明 |
| --- | --- |
| `guild_id` | 服务器 ID |
| `emoji_id` | 表情 ID。描述**按 id 存**，改名不会跟着变 |
| `name` | 认图时清单里的名字，仅供排查 |
| `description` | 一句中文，最多 20 字（`DESCRIBE_MAX_CHARS = 20`） |
| `updated_at` | 写入时刻（ISO） |

- 主键 `(guild_id, emoji_id)`；一条 `INSERT … ON CONFLICT (guild_id, emoji_id) DO UPDATE`。
- **一批认图同刻落库**：`updated_at` 只取一次「现在」，同批各行时间戳一致；写入走 `db.batch`，整批一次往返、原子提交（`src/workers/db/d1-repository.ts:562-575`）。

刷新规则：

| 场景 | 会不会自动重认 |
| --- | --- |
| 服务器**新增**表情 | 会。网关取清单时发现缺描述，就在 `ctx.waitUntil` 里后台补认，**一次最多 12 个**（`EMOJI_DESCRIBE_LIMIT = 12`，`engine.ts:138`） |
| 表情**改名** | 不会。清单里名字变了、描述还是旧的 → 点一次 `全部重认` |
| 手动点按钮 | 立刻生效；`全部重认` 覆盖已有描述 |
| 没人说话 | 不会。补认挂在「取清单」上，而清单缓存 10 分钟（`EMOJI_CACHE_TTL_MS = 600_000`，`engine.ts:135`） |

- 后台补认**绝不阻塞回复**：挂在 `waitUntil` 里，失败只留一条 `[emoji] 后台补认失败：…`（`engine.ts:927-929`）。「新表情过一阵自己就有描述了」是正常现象，不必点按钮。
- 补认只补**没有描述**的那些，不覆盖已认好的。

描述进了哪两处（§23.5）：

| 渲染点 | 位置 | 写法 |
| --- | --- | --- |
| 主提示词的自定义表情段 | `renderEmojiBlock`，`src/core/chat/service.ts:166` | `:名字:`(描述) |
| 表情模型看到的清单 | `renderCatalog`，`src/core/chat/reaction.ts:54` | 同上 |

- 描述为空（缺行或空串）维持 `:名字:`，不加括号。
- 去重规则与 **40 个**上限都不变：描述只改变单个条目的写法。

### 20.4 失败与观测

**四条 warn，逐字如下，都只走 Worker console（`npx wrangler tail`），不进 `runtime_logs`：**

| 文案 | 打在哪 | 触发条件 | 后果 |
| --- | --- | --- | --- |
| `[emoji] 下载表情失败：<url>` | `src/workers/emoji/describe.ts:91` / `:96` / `:101` | 非 2xx、空响应体、抛错（超时 / CDN 拦） | **只影响这一张**：该表情计 `failed` 并从本批剔除，同批其它照认 |
| `[emoji] 认图失败：<错误>` | `describe.ts:208` | 某批所有可用 Key 都失败（无 Key、模型不支持读图、上游报错） | 该批全部计 `failed`，**继续下一批** |
| `[emoji] 写描述失败：…` | `describe.ts:226` | D1 写入抛错 | 该批已解析出的条数改计 `failed` |
| `[emoji] 读描述失败：…` | 网关 `engine.ts:888`；认图侧 `describe.ts:113` | 读表抛错 | 网关退回「只有名字」的老清单，**本轮也不补认**（写库多半同样不可用） |

- **成功的认图结果不进实时日志页**：只有按钮下面那行「已认 N 个，失败 M 个」和 D1 里的行。
- 另外三条更少见的（同样只在 `wrangler tail` 里看）：`[emoji] 读表情模型配置失败：…`（`describe.ts:150`）、`[emoji] 认图依赖不可用：…`（`engine.ts:913`，`DB` 或 `KEY_ENCRYPTION_SECRET` 缺失、仓储建不起来）、`[emoji] 后台补认排不进 waitUntil：…`（`engine.ts:932`）。

排障顺序（症状 → 先看哪里）：

| 症状 | 先看 |
| --- | --- |
| `已认 0 个，失败 0 个` | 要么这台服务器**已经全部有描述**，要么没有自定义表情；要覆盖就点 `全部重认` |
| 全部 failed | `[emoji] 认图失败：…`——多半是模型不支持读图，或该供应商没配 Key（§21、§17） |
| 零星 failed | `[emoji] 下载表情失败：<url>`——单个表情图挂了，点一次 `全部重认` 重试 |
| 400 `BAD_GUILD_ID` | 服务器 ID 没填或只有空格（`src/workers/http/app.ts:506-509`）；后端只判空，**不校验是否全数字** |
| 页面报「认表情失败：…」 | 服务器 ID 写错，或 bot 不在那台服务器：`listGuildEmojis` 抛错（`src/workers/discord/rest.ts:145-148`）是认图唯一会往上抛的一步，整条路由没有 try/catch，直接 500 |
| 501 `DESCRIBE_UNAVAILABLE` | 部署里没注入 `describeEmojis`（`src/workers/index.ts:196`）；老版本就是这样 |
| 401 | 管理台没登录 / cookie 过期（两条路由都在鉴权中间件之后） |

### 20.5 已知边界

| 边界 | 说明 |
| --- | --- |
| 只进提示词 | 描述不写进消息、不进最近 50 条原文、不进摘要、不动落库正文 |
| 模型不支持读图 | 认图只会失败并留 `[emoji] 认图失败：…`，清单退回「只有名字」；换一个支持视觉的模型名（§21） |
| 动画表情只取一帧 | 下载 `<id>.gif` 原图交给模型，只能看见一帧 |
| 描述最多 20 字 | 超出截断（`DESCRIBE_MAX_CHARS`）；注入侧不再二次截断 |
| 按服务器存 | 描述挂在 `guild_id` 上；私聊没有自定义表情，也就没有描述 |
| 认不出名字 | 「长得像」能认，「叫什么」认不出（20.1 的奶龙就是例子） |
| 改名不重认 | 名字变了描述还是旧的，要手动 `全部重认` |
| 斜杠命令带不进去 | `/chat` 等命令路径根本**不注入表情清单**（`src/workers/discord/handler.ts:367-380` 不设 `customEmojis`，§18.7），命令回合既没有名字也没有描述 |
| 一次性成本 | 认完即落库，之后只有新表情才补（每批 6 个，36 个约 6 次调用 / 25 秒） |

### 20.6 门牌与换码

网关这一版（§20 的表情描述 + §21 的表情别名 + §23 的频道级记忆配置 + §28 的一次多个表情 + 指定目标消息 + §27 的多段提示词 + §34 的贴表情素材模板）的门牌是 `summary-order-2`：

```bash
npx wrangler tail dc-ai-bot            # 看 [gateway] alarm build=summary-order-2
```

- `src/workers/gateway/engine.ts` 的 `GATEWAY_BUILD`：`const GATEWAY_BUILD = 'summary-order-2';`，打在 `[gateway] alarm build=summary-order-2`（心跳，每拍一次）与 `[gateway] dispatch build=summary-order-2 …`（每条消息）两行上。
- 还看到 `emoji-alias-1`（或更早的 `emoji-vision-2` / `emoji-vision-1`）说明 DO 仍在跑旧版本：补认、别名与 §23 的频道级记忆配置都要等实例被驱逐后才生效（通常几分钟到数小时，§13）。这不是 bug，别改代码（与 §19.6 同一条道理）。

## 21. 表情别名（管理员手工配）

§20 让模型**看得见**表情图，却解决不了「这个表情其实叫奶龙」——`laugh` 的描述是「黄色胖角色站立掐腰」，
描述里没有「奶龙」二字，挑不挑得中全看模型自己的联想。别名是人工补的那一层：管理员把「奶龙」指到 `laugh`，
清单里就同时出现 `:laugh:` 与别名「奶龙」，模型此后两种叫法都认。契约见 §24（`docs/architecture.md`）。

### 21.1 为什么需要它

| 阶段 | 主提示词里的清单 | bot 对「给我贴奶龙」的反应 |
| --- | --- | --- |
| 没有别名 | `:laugh:`(黄色胖角色站立掐腰) | 描述里没有「奶龙」二字，挑不挑得中看模型自己的联想（§20.1） |
| 配了别名「奶龙」 | `:laugh:`(黄色胖角色站立掐腰) 别名「奶龙」 | 清单里就写着「奶龙」，挑 `:laugh:` 就对；就算它写 `:奶龙:`，发出去也是真表情 |

- 描述靠模型自己看，别名靠人配：前者解决「看得出来长得像」，后者解决「叫得出名字」。
- **如实记录**：§20 实测 36 个表情全部认出，但那张二创像素图的描述写的是「黄色胖角色站立掐腰」，模型认不出它就是奶龙。别名把「奶龙」直接写进清单，不再依赖模型联想。
- 别名只改我们的提示词与解析，**不动 Discord 里的表情名**（§24.9 第 2 条）。

### 21.2 怎么用

后台「表情」页（§18.1）最下面一块，标题「表情别名（管理员手工配）」（`web/src/pages/ReactionPage.tsx:313`），
区块说明就一句：「配了别名之后，模型看到 `:laugh:` 也知道它叫「奶龙」，你直接让它贴奶龙就行。」（`:315`）。

| 元素 | 行为 |
| --- | --- |
| 服务器 ID 输入框 | 与 §20 那块**共用同一个**输入框（同一个 `guildId` 状态），填**纯数字雪花号**；停下 400ms 才去拉接口（`ALIAS_LOAD_DELAY = 400`，`ReactionPage.tsx:33`） |
| 别名输入框 | placeholder「例如：奶龙」（`:323`）。后端校验：trim 后 1–24 个字符，且不得含冒号、空白、`<`、`>`（`src/workers/http/app.ts:116-123`）；不合格时页面显示「别名不合法：1–24 个字符，不能含冒号、空白、尖括号」（`ReactionPage.tsx:53`） |
| 目标表情下拉 | 选项文本 `name (id)`（`:339`），数据来自 `GET /api/emojis/live`（该服真实表情，按 name 升序）。没填服务器 ID 时写「先填服务器 ID，再从这里选表情」，该服没有自定义表情时写「该服务器没有自定义表情」（`:331-335`） |
| `添加` | `PUT /api/emoji-aliases`；成功后在页面写「已添加：奶龙 → laugh(<ID-5>)」（`:193`）并重拉列表。服务器 ID / 别名 / 目标表情任一为空、或正在请求时按钮是灰的（`aliasDisabled`，`:221`）；请求期间文案变「添加中…」（`:346`） |
| 别名列表 | 每行 `别名 → name (id)` + 一个「删除」（`:357-374`），数据来自 `GET /api/emoji-aliases`，按别名升序（`src/workers/db/d1-repository.ts:595`） |
| `删除` | `DELETE /api/emoji-aliases?guildId=&alias=`；页面写「已删除别名：奶龙」（`:210`）。别名本来就不存在时后端也回 200，连点两下不会报错（`d1-repository.ts:614-617`） |
| 空态 | 没填服务器 ID：「填上面的服务器 ID 后会列出已配的别名」；填了但没有：「这个服务器还没有配别名」（`:352-355`） |

- 失败一律**写在页面上**（`aliasError`，`:351`），不弹 alert 盖住结果：501 显示「服务端没有接上 Discord 表情清单，暂时无法选目标表情」，502 显示「拉取该服务器表情失败：确认机器人仍在该服务器里」（`ReactionPage.tsx:55-56`）。
- 拉列表是**先别名再表情**，所以后端没注入表情清单（501）时，已配的别名照样列得出来（`:171-180`）。
- 前端四个函数都在 `web/src/api.ts`：`fetchLiveEmojis`（`:379-390`）、`fetchEmojiAliases`（`:393-405`）、`saveEmojiAlias`（`:408-423`）、`deleteEmojiAlias`（`:425-430`）。

### 21.3 别名进到哪

| 落点 | 写法 | 位置 |
| --- | --- | --- |
| 主提示词的自定义表情段 | `:laugh:`(黄色胖角色站立掐腰) 别名「奶龙」 | `withEmojiDescription` + `renderEmojiBlock`，`src/core/chat/service.ts:157-166` / `:172-187` |
| 表情模型看到的清单 | 同上，**逐字一致** | `withEmojiDescription` + `renderCatalog`，`src/core/chat/reaction.ts:45-54` / `:60-75` |
| 正文里的 `:奶龙:` | 发出去是真实表情 `<:laugh:<ID-5>>` | `resolveInlineEmojis`，`src/workers/discord/emoji.ts:34-52`（网关调用点 `src/workers/gateway/engine.ts:715`） |
| 模型写的 `[[react:奶龙]]` | Reaction API 收到 `laugh:<ID-5>` | `resolveReactionEmoji`，`emoji.ts:61-88`（调用点 `engine.ts:1003`） |

- 清单条目只有三种形态：`:名字:`、`:名字:`(描述)、`:名字:`(描述) 别名「a、b」；描述与别名 trim 后为空就各自不出现，没描述没别名的表情仍是光秃秃的 `:名字:`（`service.ts:157-166`、`reaction.ts:45-54`）。多个别名按 `、` 拼，顺序取列表的别名升序（`:160-163`）。
- **真名优先于别名**：`resolveInlineEmojis` 先查真名再查别名（`emoji.ts:47`）；`resolveReactionEmoji` 先把整张表按真名扫完才轮到别名（`:76-84`）。别名撞到某个表情的真名时真名说了算，同名表情不会被别名抢走。
- **输出永远用真实表情名**：正文拼的是 `<:laugh:id>`（`emoji.ts:50`），贴表情回的是 `laugh:id`（`:78`、`:82`）。Discord 只认真名，别名只是我们自己叫它的方式。
- 中文别名能匹配到，靠 `:名字:` 的正则放宽：`EMOJI_TOKEN` 的 `:名字:` 分支从 `[A-Za-z0-9_~]{2,32}` 改成 `[^\s:<>]{2,32}`（`emoji.ts:16`）；尖括号分支 `<a?:[A-Za-z0-9_~]{2,32}:\d+>` 不变，先匹配先返回，不会被二次替换。
- **不在清单里的别名静默失效**：注入侧仍按 `:名字:` 判重、上限 40 条（`MAX_EMOJI_IN_PROMPT = 40`，`service.ts:149`；表情模型侧 `REACTION_MAX_CATALOG = 40`），别名不单独占一条。别名指向的表情没进这 40 条，或这条别名指不到该服任何表情而被 `attachAliases` 就地丢掉（`engine.ts:180-194`），它既不进提示词，解析层也换不出标记——模型照着写 `:奶龙:` 只会原样留在正文里。

### 21.4 存在哪

表 `emoji_aliases`，迁移 `migrations/0009_emoji_aliases.sql`：

| 列 | 说明 |
| --- | --- |
| `guild_id` | 服务器 ID |
| `alias` | 别名本身，例如「奶龙」 |
| `emoji_id` | 目标表情的 Discord 表情 ID |
| `emoji_name` | 目标表情的真实名字，例如 `laugh` |
| `created_at` | 第一次配这个别名的时刻（ISO），**重复添加不重写** |

- 主键 `(guild_id, alias)`：一个别名在一台服务器只指向一个表情。
- 写：一条 `INSERT … ON CONFLICT (guild_id, alias) DO UPDATE SET emoji_id = excluded.emoji_id, emoji_name = excluded.emoji_name`（`src/workers/db/d1-repository.ts:601-612`）——重复添加**只换指向**，`created_at` 取插入那一刻的 `nowIso()`、冲突分支不更新它，所以改指向不会洗掉「什么时候配的」。
- 读：显式列名 `SELECT alias, emoji_id, emoji_name … WHERE guild_id = ? ORDER BY alias ASC`（`:595`），`guild_id` / `created_at` 都不出仓储。
- 删：`DELETE … WHERE guild_id = ? AND alias = ?`，命中 0 行也算成功（`:614-617`）。
- 仓储挂在 `createRepositories` 的返回值上（`:625` 的 `emojiAliases`）；管理 API 拿的是 `deps.emojiAliases`（`src/workers/index.ts:198`），网关读同一份（`engine.ts:908`）。

### 21.5 失败与观测

**读别名失败只有一条 warn，逐字如下，同样只走 Worker console（`npx wrangler tail`），不进 `runtime_logs`：**

| 文案 | 打在哪 | 触发条件 | 后果 |
| --- | --- | --- | --- |
| `[emoji] 读别名失败：<错误>` | `src/workers/gateway/engine.ts:893` | 网关切清单时读 `emoji_aliases` 抛错（D1 不可用、表没建） | **按没有别名继续**：清单退回「只有名字/描述」，本轮回复一字不受影响（`:890-895`） |

- 它与 §20.4 的 `[emoji] 读描述失败：…`（`:634`）在同一次装配里，两件事互不牵连：读描述失败不影响别名照挂，反之亦然。
- 两次读都只发生在**既有的 10 分钟缓存**里（`EMOJI_CACHE_TTL_MS = 600_000`，`engine.ts:135`），没有新增每消息一次查询。
- 依赖缺失（`DB` 或 `KEY_ENCRYPTION_SECRET` 没配、仓储建不起来）时 `#describeDeps()` 直接返回 null，别名整段跳过，连 warn 都没有（`:645-648`，与 §20.4 最后一条同一个口径）。

后台三档失败码（后端只回码，页面翻成中文）：

| 状态 | 码 | 含义 | 代码 |
| --- | --- | --- | --- |
| 400 | `BAD_GUILD_ID` | 服务器 ID 没填或只有空白（后端只判空，**不校验是否全数字**） | `src/workers/http/app.ts:110-113`；四条路由各自 `:535` / `:557` / `:566` / `:582` |
| 400 | `BAD_ALIAS` | 别名 trim 后为空、超过 24 字、或含 `:` / 空白 / `<` / `>` | `app.ts:116-123`（`MAX_ALIAS_CHARS = 24`、`ALIAS_FORBIDDEN = /[:\s<>]/`）；`PUT` `:569`、`DELETE` `:585` |
| 400 | `BAD_EMOJI` | `emojiId` 不是纯数字或短于 15 位；`emojiName` 不匹配 `^[A-Za-z0-9_~]{2,32}$` | `app.ts:126-139`；`PUT` `:571-572` |
| 501 | `EMOJI_LIST_UNAVAILABLE` | 部署里没注入 `listEmojis`（`src/workers/index.ts:199` 才注入，老版本没有） | `app.ts:537-538` |
| 502 | `EMOJI_LIST_FAILED` | Discord 调不通（bot 不在那台服务器、token 失效），**不回错误原文** | `app.ts:540-546` |
| 401 | — | 管理台没登录 / cookie 过期（四条路由都在 `ALL /api/*` 鉴权中间件之后） | — |

排障顺序（症状 → 先看哪里）：

| 症状 | 先看 |
| --- | --- |
| 目标表情下拉是空的 | 先填服务器 ID；仍是空的就看 501（没注入）与 502（拉不到）——后者多为 bot 已不在该服务器 |
| 添加报「别名不合法」 | 冒号、空白、尖括号都算非法字符；中文可以用 |
| 添加成功了但清单没变 | 网关缓存 10 分钟（`EMOJI_CACHE_TTL_MS`）才换；还不变就回到 21.3 查两条：别名指向的表情是否进了那 40 条、`[emoji] 读别名失败：…` 是否在刷 |

### 21.6 已知边界

| 边界 | 说明 |
| --- | --- |
| 只按服务器配 | 别名挂在 `guild_id` 上；同一个表情在另一台服务器要各配一次（§24.9 第 1 条） |
| 一个别名一个表情 | 主键 `(guild_id, alias)`，重复添加只换指向，不洗 `created_at` |
| 同一表情可配多个别名 | 一个表情挂「奶龙」「小黄龙」两个别名，清单里拼成 别名「奶龙、小黄龙」；解析层两种叫法都认 |
| 表情被删则别名失效 | 该服清单里没有这个表情了，`attachAliases` 就地丢弃这条别名，不报错、不占位（`engine.ts:180-194`） |
| 只进提示词与解析 | 别名不动 Discord 里的表情名，也不写进消息、历史、摘要与落库正文 |
| 斜杠命令带不进去 | `/chat` 等命令路径照旧**不注入表情清单**（`src/workers/discord/handler.ts:367-380` 的 `buildTurnContext` 不设 `customEmojis`，与 §20.5 最后一条同一条道理），别名对它没有影响 |
| 改完不立刻生效 | 别名与描述同在 10 分钟缓存里，改完最多 10 分钟才对 @ 路径生效（斜杠以外） |
| 门牌与换码 | 这一版门牌是 `summary-order-2`（`src/workers/gateway/engine.ts` 的 `GATEWAY_BUILD`）；看到 `[gateway] alarm build=summary-order-2` 才说明 DO 已换到这一版，旧实例的处理见 §20.6 |
## 22. 后台手动改摘要

摘要由模型自动生成、每轮都注入 system（§14 / architecture §17），但过去后台**看不到也改不了**：模型把人名写错、
把细节记反、或者覆盖楼层卡在错误位置时，只能等下一轮覆盖，或者直接去改 D1。这一版管理台多一个「摘要」页，
把 `conversation_summaries` 这张表直接摆出来：能查（全部摘要 + 某频道最近消息）、能改（正文 + 覆盖楼层）、
能删、能立刻重算一次。契约见 architecture §25（路由 §25.3、校验 §25.4、装配 §25.5、页面 §25.6、边界 §25.7）。

- **不新增表、不新增迁移**：读写的还是 §14 那张 `conversation_summaries`（`migrations/0003_conversation_summary.sql`），`(guild_id, channel_id)` 一行。
- 手改能碰的只有两个字段：`summary`（正文）与 `covered_until_id`（覆盖楼层）。生成逻辑一个字没动——「重新总结」调的是
  `/summary` 命令用的**同一个** `ChatService.summarize`（`src/core/chat/service.ts:340`，装配在 `src/workers/index.ts:212-213`），不存在第二套总结代码。
- 仓储只多一个读全表的方法：`SummaryStore.list()`（`src/core/ports.ts:70`，实现 `src/workers/db/d1-repository.ts:530`，
  `ORDER BY guild_id ASC, channel_id ASC` 且显式列名、不用 `SELECT *`）；楼层点选用的最新消息走新增的
  `ConversationStore.loadLatest()`（`src/core/ports.ts:63` / `src/workers/db/d1-repository.ts:642`，SQL 是 `ORDER BY created_at DESC, id DESC LIMIT ?`，
  返回前 `reverse()`，所以调用方拿到的永远是**时间升序**（同值按 id 破平），与 `loadRecent` / `loadAfter` / `loadBetween` 一致）。

### 22.1 为什么需要它

| 场景 | 只能等下一轮覆盖时的表现 | 现在 |
| --- | --- | --- |
| 摘要写歪（人名记错、把「下周」记成「上周」） | 这段摘要每轮都在 system 里（§14「进上下文」），错的事实会一直污染后续对话。老段只增不改、`buildSummaryRequest` 只喂新增原文（architecture §31.2），错的地方不会自己消失，只会一直被带下去 | 改正文 → 保存，下一轮回复就用新的 |
| 覆盖楼层卡在错误位置 | `covered_until_id` 只由 `summarize` 推进（`src/core/chat/service.ts:328`）：卡在后面 → 中间那段原文永远进不了摘要；卡在前面 → 同一段被反复总结 | 直接改数字（见 22.3） |
| 有一段不想被记住 | 没有任何入口，只能改库 | 把覆盖楼层改大，主动放弃那一段 |
| 想在下次自动摘要之前先看新版摘要 | 自动摘要要等「未总结消息满 50 条」才触发（§14），`/summary` 又只能在 Discord 里敲 | 点「重新总结」，立刻跑一次 |

一句话：摘要从「模型的黑箱产物」变成可以就地修的运维对象。

### 22.2 怎么用

后台顶栏的**摘要**标签（`web/src/App.tsx:18`，页面 `web/src/pages/SummaryPage.tsx`）。页面是三张卡片：**读取摘要**（`guildId` / `channelId` 两个输入 +「读取」+ 全部摘要列表，`SummaryPage.tsx:269-317`）、**正文与覆盖楼层**（正文 + 覆盖楼层 + 三个按钮，`:319-366`）、**最近消息**（`:368-393`）——§25.6 说的四件事就装在这三张卡里。逐个元素：

| 元素 | 行为 |
| --- | --- |
| 服务器 ID | 纯数字雪花号，手填——后台枚举不了 bot 加入了哪些服务器（与「表情」页同一口径）。后端只校验 `/^\d{1,32}$/`（`src/workers/http/app.ts:132-138`），**不查频道是否存在**，填错只会读到空摘要与空消息列表（§25.7 第 6 条） |
| 频道 ID | 同上。在 Discord 里开「开发者模式」后右键频道 → 复制频道 ID；粘进来的空格、`#`、`<#…>` 都不认 |
| `读取` | `GET /api/summaries/messages`（`app.ts:677-686`）：把返回填进「最近消息」，`limit` 缺省 50、上限 200（`app.ts:51-52`、`:682-683`）。它**只读原文**，不读摘要正文——正文在右侧列表里点 |
| 全部摘要列表 | `GET /api/summaries`（`app.ts:688`）：打开页面先拉一次（`SummaryPage.tsx:106-108`），一次拉全表、按 `guild_id`、`channel_id` 升序；每行是 `频道 ID`（可点的按钮）`· 服务器 ID · 覆盖到 #id · 更新时间`（`SummaryPage.tsx:304-315`，§25.6 第 1 条）。一条都没有时后端回 `{ items: [] }`（不是 404），页面显示「还没有任何摘要」 |
| 点列表里的一行 | 把这一行的正文与覆盖楼层载进表单（§25.6 第 1 条）；这一步是纯本地动作、不打接口，「最近消息」仍要点一次「读取」才会拉（`SummaryPage.tsx:170`） |
| 正文 | `textarea`。保存时 `trim()` 后必须是 1..8000 字（`MAX_SUMMARY_CHARS = 8000`，`app.ts:53`、`:698-699`）；4000 是注入预算的默认值 `SUMMARY_MAX_CHARS`（`src/core/chat/summary.ts`），频道级 `summaryMaxChars` 可覆盖（§23.1），手写留了一倍余量（超预算只影响进上下文的量，不动库里正文，§14）。换行原样保存、原样注入，不做 markdown 处理（§25.7 第 7 条）；保存是**整段替换**，`【记忆段】` 段头要自己留着（§25.7 第 8 条） |
| 覆盖楼层 | 数字输入框，旁注「0 = 从头重算」（§25.6 第 2 条）。页面先本地校验：空输入按 0，不是纯数字或超出安全整数范围就当场报「覆盖楼层必须是非负整数（0 = 从头重算）」（`parseCoveredUntil`，`SummaryPage.tsx:68-74`、`:193`）；通过后由后端定上界 0..该频道当前最大 `messages.id`（`app.ts:701-706`，上界由 `latestMessageId` 用 `loadLatest(key, 1)` 取，`:295-299`）；数字框回传纯数字串也照收（`readCoveredUntilId`，`:283-292`） |
| 最近消息 | 每行 `#id · 发言人 · 正文前 30 字`（§25.6 第 3 条）。`author` / `createdAt` 在库里是空值时这两个键**整个不出现**（`summaryMessageDto`，`app.ts:263-280`），所以老消息只显示 `#id · 正文` |
| 点最近消息里的一行 | 把这条的 `id` 填进「覆盖楼层」——比手敲雪花号可靠得多 |
| `保存` | `PUT /api/summaries`（`app.ts:690-718`）：成功回 200 + 保存后的 `ConversationSummary`，页面提示「已保存」。`updatedAt` 取服务端当前时刻，客户端给的时间不认（`:708-715`，§25.4） |
| `重新总结` | `POST /api/summaries/regenerate`（`app.ts:729-748`）：成功把返回的 `summary` / `coveredUntilId` 写回表单；正文非空时先弹一次确认，免得手写的稿子被模型结果整段盖掉（`SummaryPage.tsx:215-216`）；没有素材时是 409 `NO_SUMMARY_MATERIAL`（`:746`）。走的是与 `/summary` 同一条 `summarize`，一次只总结一批（§25.7 第 4 条） |
| `删除` | `DELETE /api/summaries`（`app.ts:720-727`）：先弹一次确认（`SummaryPage.tsx:240`），成功清空表单；这条摘要本来不存在也回 200 `{ ok: true }`（`:724-726`），连点两下不会报错 |

- 五条路由都挂在 `ALL /api/*` 鉴权之后（`app.ts:287`，注册处 `:676` 有注释），没登录 / Cookie 过期一律 401，与 §16.1 的 `/api/logs` 同一条中间件。
- 保存是**整行覆盖**（`ON CONFLICT (guild_id, channel_id) DO UPDATE`，`src/workers/db/d1-repository.ts:540-545`）：只想改正文也得把覆盖楼层原样带上，否则它会被一起写掉。
- 客户端只做两件本地检查：覆盖楼层是不是非负整数（`SummaryPage.tsx:68-74`），以及写操作有没有确定的频道目标——ID 改过之后三个按钮全部禁用并提示重新「读取」，免得把上一条的正文写到别的频道（`:262-265`、`:329-331`）；同一时刻也只允许一件事在跑（`:32`）。其余不合格输入一律由后端回码、页面按 `describeSummaryError`（`:47-65`）翻成中文——「填错了会怎样」的答案都在 22.5。

### 22.3 覆盖楼层到底是什么

`coveredUntilId`（表里叫 `covered_until_id`）的语义只有一句：**已经总结到 `messages.id` 等于这一条的那条消息，
下次只捞比它新的**（architecture §17.2、§25.1）。它不是「条数」、不是时间戳，是 `messages` 的自增主键，也就是一条**水位线**。

- 取素材：`summarize` 每次都走 `loadAfter(key, cursor)`，SQL 条件是 `id > cursor`（`src/workers/db/d1-repository.ts:469`）；
  `cursor = summaries.get(key)?.coveredUntilId ?? 0`（`src/core/chat/service.ts:266-268`）。
- 推进它：落库时写 `coveredUntilId`，取的是**这次真正送进素材的最后一条已落库消息**的 id（`service.ts:327-335`）；
  素材被单批上限截断时就只推到这批的最后一条。手改就是直接改这条水位线。
- 上界硬校验：`coveredUntilId > 该频道当前最大 messages.id` 直接 400（`app.ts:704-706`）。理由写在 §25.4：游标一旦越过最新消息，
  自动摘要会**长期不触发**，而日志里看不出原因。

| 改法 | 实际发生什么 | 什么时候这么用 |
| --- | --- | --- |
| 改小（例如从 `#900` 改成 `#700`） | `id > 700` 的那 200 条重新落进「未总结」区间，下一次自动或手动总结会把它们写成**又一段新记忆**追加到尾部 | 摘要漏掉了一段事实，要让模型重读原文 |
| 改大（例如从 `#700` 改成 `#900`） | 这 200 条被主动放弃：以后不会再进摘要。`messages` 一个字都不动（库里永久保留，§14），只是「没被总结」 | 一段跑题 / 刷屏的原文不想污染摘要 |
| `0` | 下一次总结从最旧的消息重新算，结果**追加**成新的一段；旧段正文仍在库里（`buildSummaryRequest` 只喂新增原文，architecture §31.2） | 大改口径，想重录一遍 |

- 「改大」不等于删除：被放弃的只是「进摘要」这条路，**最近 50 条原文该注入还是注入**（`DEFAULT_HISTORY_MAX_MESSAGES = 50`，
  `src/core/memory/window.ts:7`）——注入窗口与摘要游标是两条独立的线（§14）。
- 「改小」会有重复感：老段里可能已经写过这段内容，重新压一遍是在尾部**追加**一段，不是替换老段。
  看着重复就顺手把正文改顺——这正是这一页存在的意义。
- 楼层数字是**消息 id**，不是序号：`#900` 不会连着出现，号段之间是别的频道用掉的；拿不准就点「最近消息」里的一行。

### 22.4 五条接口一览表

全部在 `src/workers/http/app.ts`，全部在 `ALL /api/*` 鉴权之后（未登录 401）：

| 方法 | 路径 | 入参 | 成功 | 实现 |
| --- | --- | --- | --- | --- |
| GET | `/api/summaries` | 无 | `{ items: ConversationSummary[] }`；没有摘要时 `[]` | `app.ts:688` |
| GET | `/api/summaries/messages` | `guildId`、`channelId`、`limit`（缺省 50，上限 200） | `{ items: [{ id, role, author, content, createdAt }] }`，`author` / `createdAt` 缺失时**不出现该键** | `app.ts:677-686` |
| PUT | `/api/summaries` | body `{ guildId, channelId, summary, coveredUntilId }` | 200，保存后的 `ConversationSummary` | `app.ts:690-718` |
| DELETE | `/api/summaries` | `guildId`、`channelId`（query） | `{ ok: true }`；本来没有也回 200 | `app.ts:720-727` |
| POST | `/api/summaries/regenerate` | body `{ guildId, channelId }` | `{ outcome: SummaryOutcome }`；没有可总结素材时 `{ error: NO_SUMMARY_MATERIAL, outcome: null }` + 409 | `app.ts:729-748` |

- `SummaryOutcome` 沿用 §17.2：`{ summary, coveredUntilId, summarizedMessages, model }`；`summarizedMessages` 是这批素材的条数，
  `model` 是真正出结果的那个模型（`service.ts:336` 返回的就是这些字段）。
- `GET /api/summaries/messages` 的 `limit` 非法或 ≤0 时用缺省 50，超过 200 按 200（`app.ts:682-683`）；返回的 `items` 永远是时间升序（按 `created_at`，同值按 `id` 破平）——不是 id 升序，见 architecture §35.7。
- `PUT` / `POST` 的 body 读不出来（空 body、坏 JSON）按 400 `BAD_CHANNEL_KEY` 处理（`app.ts:692-695`、`:730-733`），不会回 500。
- `DELETE` 从 query 取键（`app.ts:721`），不是 body；它不读摘要就能删，语义是「确保它不在」。

### 22.5 失败与观测

后台这五条路由只会回下面这几个码（后端只回码，页面翻成中文）：

| 状态 | 码 | 含义 | 处理办法 |
| --- | --- | --- | --- |
| 400 | `BAD_CHANNEL_KEY` | `guildId` / `channelId` 为空或不匹配 `/^\d{1,32}$/`（`app.ts:134-138`）；`PUT` / `POST` 的 body 坏掉也走这个码（`:693`、`:731`） | 检查是不是粘进了空格、`#`、`<#…>` 这种标记；频道 ID 是纯数字雪花号 |
| 400 | `BAD_SUMMARY` | 正文 `trim()` 后为空、或超过 8000 字（`app.ts:698-699`） | 空正文等于「留个空摘要」，注入侧会当成没有记忆，所以直接拒；4000 字以上不拒、也不截正文，只在注入时按预算从新到旧装（§14）；预算本身可在记忆页按频道调，§23.1 |
| 400 | `BAD_COVERED_UNTIL` | 不是非负整数，或大于该频道当前最大 `messages.id`（`app.ts:701-706`） | 点「最近消息」里的一行重新取号；空频道只能填 0 |
| 409 | `NO_SUMMARY_MATERIAL` | 「重新总结」时 `summarize` 返回 `null`：游标之后没有新对话可总结（累积记忆只吃新对话，`service.ts:266-273`） | 这个频道确实没有新素材；先「读取」看「最近消息」是不是空的 |
| 501 | `SUMMARY_UNAVAILABLE` | 部署里没注入 `summarizeChannel`（`app.ts:735-736`） | 装配在 `src/workers/index.ts:212-213`：确认跑的是最新部署，别在页面上反复重试 |
| 502 | `SUMMARY_FAILED` | `summarize` 抛错，回 502 带 `detail`（`app.ts:739-745`） | 看 `detail`，按下一张表对号 |
| 401 | — | 没登录 / Cookie 过期（五条路由都在鉴权之后） | 重新登录 |

**`detail` 从哪来**：它就是 `summarize` 抛出的异常消息，原样截前 **300** 字（`MAX_SUMMARY_DETAIL_CHARS`，`app.ts:54`、`:743-744`），
不包装、不带堆栈，页面只在前面加一句「重新总结失败：」（`SummaryPage.tsx:53-58`）。
它与 Discord 的 `/summary` 回帖**不完全一样**：那边会把 `NO_ROUTE_CONFIGURED` / `ALL_PROVIDERS_FAILED` / `SUMMARY_EMPTY` 翻成人话（`src/workers/discord/handler.ts:442-448`），其余才原样拼成「总结失败：<原文>」（`:450`）；后台这页只给原文、不翻译，所以两处看到的字面可能不同。最常见的四种——
**它们来自核心层，不是本接口的状态码**（`src/core/chat/service.ts`）：

| `detail` 里的串 | 含义 | 处理 |
| --- | --- | --- |
| `NO_ROUTE_CONFIGURED` | channel / guild / global 三层都没有路由（`service.ts:281`） | 去「路由」页配一条 global |
| `NO_KEY_FOR_PROVIDER` | 路由指到的供应商没有启用的 Key（`service.ts:293`，作为一次 attempt 记进明细） | 去「密钥」页补一把该供应商的 Key |
| `ALL_PROVIDERS_FAILED: [...]` | primary + fallbacks 全败，方括号里是每次尝试的 `model` 与错误（`service.ts:320`） | 按里面的 provider 报错改配置或换模型（§17） |
| `SUMMARY_EMPTY` | 模型回了空摘要，`normalizeSummary` 之后是空串（`service.ts:324`） | 空摘要不落库（落库会把游标推过去、那批原文再也总结不回来），重试或换模型 |

观测：

- 「重新总结」与 `/summary`、自动摘要打的是**同一行日志**：`[chat] 自动摘要完成 covered=<id> msgs=<n> len=<n>`，
  同时进 console 与 `runtime_logs`（scope `summary`，`service.ts:343-354`）。改完点一次重新总结，去「实时日志」页筛 `summary` 就能看到游标推到了哪一条。
- `保存` / `删除` 是纯 D1 写，不写 `runtime_logs`（§25 没给这两条安排日志）。要确认改动落库，
  直接看 `conversation_summaries` 那一行的 `summary` / `covered_until_id` / `updated_at`——`updated_at` 就是你保存的那一刻。
- 失败的码只写在页面上（§25.6 第 4 条的中文映射），不进日志表：所以「点保存报 400」这类问题要去浏览器 Network 里看响应，别在后台日志里找。
- 自动摘要自己的推进与失败仍是 §14.4 那一套关键字，这一页不影响它们。

### 22.6 已知边界

| 边界 | 说明 |
| --- | --- |
| 只影响本频道，立即生效 | 手改只动该 `(guild_id, channel_id)` 一行；下一轮回复 `readSummary` 读到的就是新值（`service.ts:360-365`），不需要重启 Worker（§25.7 第 1 条） |
| 改小 = 重新纳入，改大 = 放弃一段 | 改小把一段原文重新纳入待总结；改大主动放弃那一段：既不写摘要，也不进提示词（§25.7 第 2 条） |
| 删掉摘要 = 从 0 重来 | 删掉后游标回落到 0（`coveredUntilId` 为空即 0，`service.ts:267`）。这条路由只删 `conversation_summaries` 那一行，`messages` 一个字都不动；但若之前用过 `/reset`，那条路径会把本频道的原文一起删（`src/workers/db/d1-repository.ts:514-516` 清 `messages`、`src/core/chat/service.ts:660` 清摘要）——已经不在库里的原文不会回来，库里还剩什么就总结什么（§25.7 第 3 条） |
| 一次只总结一批 | 「重新总结」按当前游标往后取，与 `/summary` 同一条代码路径，一次最多 `min(500, max(50, 阈值))` 条（`summaryBatchLimit`；`src/core/chat/summary.ts:27`）；积压更多就多点几次，每次都接着上一次的游标，任何一条都不会被跳过（§25.7 第 4 条） |
| 并发保存后写覆盖 | 没有版本号：两个管理员同时改同一行，后保存的盖掉先保存的，属已知边界（§25.7 第 5 条、YAGNI） |
| 不校验频道存在 | 填一个空频道或打错的频道只会读到空摘要与空消息列表，不会回「频道不存在」（§25.7 第 6 条）；`PUT` 的上界校验在空频道上等于只能填 0 |
| 换行原样保留 | 正文里的换行原样保存与注入，不做 markdown 处理：写 `**加粗**` 就真的是一串星号进提示词（§25.7 第 7 条） |

七条之外没有刻意设计的行为：遇到表里没写的现象，按 architecture §25.7 逐条对号，对不上就是 bug。

### 22.7 选择性补记（按时间范围挑一段补记忆）

自动总结只吃「游标之后」的新消息；游标一过，那段历史就不会再被自动总结碰到。需要人工挑一段老对话补一条记忆时用这一节（门牌 `summary-order-2`，实现口径见 `docs/architecture.md` §35）。

**什么时候用**

- 自动总结漏了一段：Worker 挂过、绑定修好之前那段时间的消息没被总结（§13 的旧实例仍跑旧代码时也会漏）。
- 想让某段特定讨论（一次事故、一次拍板的决定）单独成段，而不是被揉进几千字的大段里。
- 手动改摘要改坏了，想从原文重新压一段出来——注意补记是**追加**，旧段不会被替换。

**后台怎么操作**（顶栏「摘要」页）

1. 填服务器 / 频道 ID（只填数字 ID）。
2. 填起止时间（两个时间框是 `datetime-local`，按你本机时区读，页面自己转成 ISO 再发；区间含首尾两端，按消息的 `created_at` 文本比较）。
3. 点「查看命中」：回 `{ count, tooLarge, firstAt, lastAt, samples }`——`count` 是命中条数（超过 500 时最多报到 501）、`tooLarge` 标出「范围太宽」、`samples` 是首尾各最多 3 条样本（`[YYYY-MM-DD HH:mm] 名字：正文前 40 字`，北京时间）。这一步只查库、不花模型调用，**永远回 200**：看到 `tooLarge: true` 就自己把范围改小再查，预览不会替你拆批（页面上这时「补记」是禁用的，必须是「同一个频道 + 同一段时间」查过命中才点得动）。
4. 点「补记」：把这段原文交给摘要模型压成一段，追加到该频道记忆尾部；段头【记忆段】写的是**这段实际命中消息的首末时刻**（`created_at`，与你在框里填的差几秒到几分钟都可能），不是游标时刻。成功后日志打 `[chat] 补记完成 from=… to=… msgs=… len=…`（`runtime_logs` 里另有一行带 `model=`）：`msgs` 是压进这一段的条数，`len` 是追加之后整份记忆的总字数。

**一次最多 500 条**：与自动总结共用 `SUMMARY_BATCH_SAFE_MAX`（`src/core/chat/service.ts`）这条硬上限，理由也相同——一次总结调用最多吃这么多条，再多就把模型撑爆。补记为了「看到多少就压多少」故意不循环多批，超了由人缩范围。

**想「只在自己点的时候才总结」**：把该频道的自动总结阈值设 0（§23，等于关闭自动总结），然后两个手动手段随便混用：

- 后台「重新总结」按钮（与斜杠 `/summary` 同一条代码路径）：吃 `min(500, max(50, 阈值))` 条没总结的消息，阈值 0 时就是 500 条，**会推进游标**。
- 「选择性补记」：挑任意时间范围，**不动游标**，所以不会替你「跳过」自动总结本该覆盖的那一段。

**补记完怎么在库里核对**（D1 `conversation_summaries`，键是 `guild_id + channel_id`）

```sql
-- 段数：summary 里【记忆段】的出现次数（每个段头 5 个字，除以 5 就是段数）
SELECT guild_id, channel_id, covered_until_id, covered_from, covered_to,
       (length(summary) - length(replace(summary, '【记忆段】', ''))) / 5 AS segments
FROM conversation_summaries WHERE guild_id = ? AND channel_id = ?;
```

- 补记前后 `covered_until_id` / `covered_from` / `covered_to` **必须一模一样**：不动游标就是这三列不动。
- `segments` 应该 +1，`length(summary)` 变大。
- 新段段头的括号里应是这段**实际命中消息**的首末时刻（与你填的那两个相近，边界上可能差几秒）。

**失败码一览**

| 报错 | 含义 | 怎么办 |
| --- | --- | --- |
| `BAD_CHANNEL_KEY`（400） | 服务器 / 频道 ID 不是纯数字 | 只填数字 ID |
| `BAD_TIME_RANGE`（400） | 缺时间、格式不对，或起点晚于终点 | 两个框都填 ISO 时间，且 `from` 早于 `to` |
| `RANGE_TOO_LARGE`（400，带 `limit: 500`） | 这段命中超过 500 条（只在点「补记」时回；「查看命中」用 `tooLarge` 标，不报错） | 缩小时间范围再补 |
| `NO_SUMMARY_MATERIAL`（409） | 这个范围一条消息都没有，或这个部署没接摘要存储 | 先用「查看命中」确认 `count`：0 条就换范围；`count` 有值却还 409 就是部署没接线 |
| `SUMMARY_UNAVAILABLE`（501） | 这个部署没注入补记依赖（`previewBackfill` / `backfillSummary`） | 确认跑的是最新部署：两条路由挂在 Worker 入口，部署即生效；这不是 Key 的问题——没路由 / 没 Key 会在 502 的 `detail` 里报 |
| `SUMMARY_FAILED`（502，带 `detail`） | 上游全失败 / 超时，或模型回了一段空正文（`detail` = `SUMMARY_EMPTY`），`detail` 是摘要异常的前 300 字 | 按 `detail` 判断，换供应商或换时间段重试 |

**已知边界**

- 时间按 `messages.created_at` 的 ISO 文本比较（写入格式统一是 `2026-10-28T12:34:56.789Z`，字典序等于时间序），不按 `id`、也不按本地时区。
- 同一段补两次会追加两段：追加语义不做去重，补之前先用「查看命中」确认。
- 放不进 500 条的范围不会被切成几批：一条都不写，直接报错。
- 补记不重算 `covered_from` / `covered_to`，所以「摘要」页显示的覆盖楼层仍按自动总结那一路的口径。
- 两条路由挂在 Worker 入口（`src/workers/http/app.ts`），部署即生效、不用等 DO 换码；但读的是 D1，与 DO 实例新旧无关。

## 23. 频道级记忆配置

「每轮注入多少条原文」与「攒够多少条未总结消息自动总结一次」过去都写死在两个常量里：入口的 `CHAT_CONFIG`（`src/workers/index.ts:60`）与网关的 `MESSAGE_CHAT_CONFIG`（`src/workers/gateway/engine.ts:156`），两处都是 50 / 50。这一版把这两个数字搬进 D1：**每个频道各自一套**，后台多一个「记忆」标签。之后注入预算也搬进同一张表（`summaryMaxChars`，表里的 `summary_max_chars`，迁移 `migrations/0012_memory_budget.sql`），变成第三个可配项。契约见 architecture §26（数据 §26.2、取值 §26.3、路由 §26.4、装配 §26.5、页面 §26.6、边界 §26.7）。

- 不新增全局默认层，也不动 `messages` / `conversation_summaries`：只多一张 `channel_memory_settings`（迁移 `migrations/0010_channel_memory.sql:2-9`，主键 `(guild_id, channel_id)`）。
- 上面那两个常量一个字段都没删，仍然是最底层的兜底（architecture §26.5 第 2 条）。
- 页面在 `web/src/pages/MemoryPage.tsx`，顶栏标签叫「记忆」（`web/src/App.tsx:20` 的 `{ id: 'memory', label: '记忆' }`，挂载在 `:75`）。

### 23.1 这几个数字管什么

| 字段 | 表里的列 | 管什么 | 缺省 |
| --- | --- | --- | --- |
| `historyMaxMessages` | `history_max_messages` | **每轮注入最近多少条原文**：`tailMessages(history, historyMaxMessages)` 只留最近 N 条（`src/core/chat/service.ts:561`），更早的内容由累积记忆兜底（`docs/architecture.md` §31） | 50（`DEFAULT_HISTORY_MAX_MESSAGES`，`src/core/memory/window.ts:7`） |
| `summaryEveryMessages` | `summary_every_messages` | **未总结消息攒到多少条触发一次自动总结**：游标之后攒够 N 条才在后台跑一次 `summarize`（`src/core/chat/service.ts:415-417`） | 50（`DEFAULT_SUMMARY_EVERY_MESSAGES`，`src/core/chat/service.ts:95`） |
| `summaryMaxChars` | `summary_max_chars` | **注入 system 时最多装多少字的累积记忆**：按段从新到旧装满，装不下的老段留在库里、不进上下文（§14、architecture §31.3） | 4000（`SUMMARY_MAX_CHARS`，`src/core/chat/summary.ts:23`）；`0` = 未设置 |

- **没有行 = 默认 50 / 50 + 预算 4000**：表里没有 `(guild_id, channel_id)` 这一行就按代码默认走。`summary_max_chars = 0`（或这一列缺席）也按「未设置」→ 4000 走，所以「留空」与「4000」在运行时是同一件事。HTTP 层读到空行时临时拼一份、把 `updatedAt` 留成空串（`src/workers/http/app.ts:786-793`），默认值由装配层从 core 常量传进去（`src/workers/index.ts:219-222`，HTTP 层不 import `chat/service.ts`，§16.5）；前端也有一份同样的兜底（`MEMORY_DEFAULTS`，`web/src/api.ts:644-647`）。
- **取值顺序**：频道行 > `config` > 代码默认，逐字段独立回退（`resolveTurnMemory`，`src/core/chat/service.ts:137-150`）。预算还多一层口径：频道 `summaryMaxChars > 0` 才盖过全局 `config.summaryMaxChars`，两者都 `<= 0`（或 `NaN`）就退到 `SUMMARY_MAX_CHARS = 4000`。有行就整行生效，**不做逐字段合并**（architecture §26.2 最后一条）——后台保存时两个字段是一起提交的（23.3 的 `PUT` 只认整对）。
- **只按频道生效**：同一台服务器的两个频道要各配一次，没有「这台服务器统一 80 条」这种层（architecture §26.7 第 1 条）。
- **每次回复都现读一次 D1，没有缓存**：`run()` 把 `readChannelMemory(key)` 并进原来那批并行查询（7 项 → 8 项，`src/core/chat/service.ts:532-543`）。所以改完既不用重启 Worker，也不存在缓存过期问题——唯一要等的是 @ 路径的 DO 换码（23.4）。
- 阈值 `<= 0` 一律折算成 0 = 关闭自动总结；正数一律至少 2（`src/core/chat/service.ts:142-143`）。预算 `<= 0` 与 `NaN` 一律当「未设置」→ 4000，不会变成「注入 0 字」。

### 23.2 怎么配

后台顶栏**「记忆」**标签（`web/src/App.tsx:20`、`:75`）。页面是三块卡片：**读取频道配置**（`MemoryPage.tsx:278-310`）、**记忆参数**（`:312-378`）、**已保存的频道**（`:380-402`）。照着点：

1. **填服务器 ID + 频道 ID → 点「读取」**（`MemoryPage.tsx:232-256`）。两个都是纯数字雪花号，只能手填——后台枚举不了 bot 加入了哪些服务器（与「摘要」「表情」页同一口径）。在 Discord 里开「开发者模式」后右键频道 → 复制频道 ID；粘进来的空格、`#`、`<#…>` 都不认。
2. **改三个数字**（`:327-364`）：注入条数（旁注「默认 50，≥ 2，不设上限」）、自动总结阈值（旁注「默认 50；0 = 关闭自动总结，否则 ≥ 2，不设上限」）、记忆注入预算（`:351-364`，标签「记忆注入预算（字符；默认 4000，范围 500–20000）」，`min=500`/`max=20000`/`step=100`，可留空）。预算下面有一行帮助文案（`:365-368`）：「默认 4000；越大记忆越全，但每轮 prompt 越贵；超出预算的老段仍留在库里，不删也不改」。第三个输入另起一行：`.row` 不换行、`.field.memory-number` 固定 260px，三只并排会把 3fr 列撑破（`web/src/styles.css:147-151`、`:582-585`）。
3. **点「保存」**（`:301-303`）→ `PUT /api/memory-settings`，成功后提示「已保存：服务器 … · 频道 … · 窗口 N · 阈值 N · 预算 N（更新于 …）」（`:230`；阈值填 0 时写的是「关闭自动总结」，预算为 0/未设置时写的是运行时默认 4000，`describeRow` 在 `:78-94`）并刷新右侧列表。

几个必须知道的交互：

| 现象 / 按钮 | 实际行为 |
| --- | --- |
| 没「读取」就想保存 | 「保存」是禁用的：必须先有一次成功的读取把表单绑到确定频道（`saveDisabled`，`MemoryPage.tsx:216-220`），提示行写着「先在上面填服务器 / 频道 ID 点「读取」，或点右侧列表的一行把它载入表单」（`:269-275`） |
| 读完又改了 ID | 绑定失效（`keyStale`，`:218`），「保存」重新禁用，提示「ID 改过了：请重新点「读取」，免得把参数写到别的频道」——防止把 A 频道的数字写进 B 频道 |
| 读到 `updatedAt === ''` | 提示「这个频道还没单独设置过，显示的是默认值」（`MemoryPage.tsx:125-129`）：D1 里没有这一行，屏幕上是 50 / 50 与预算 4000 |
| 已保存列表 | 只列**保存过**的频道（`GET /api/memory-settings`，`app.ts:797-798`）；一行是 `频道 ID · 服务器 ID · 窗口 N · 阈值 N · 预算 N`，阈值 0 显示「关闭」、预算 0 显示 4000（`MemoryPage.tsx:386-401`）；点一行把 ID 填进表单并重新读一次（`:145-150`）；一条都没有时提示「还没有任何频道单独设置过」（`:315`） |
| **关掉自动总结** | 阈值填 `0` 保存（填 `1` 会被拒，见 23.3）。关掉的只是**自动**那一路：`/summary` 命令与后台「重新总结」仍可随时手动跑（architecture §26.7 第 2 条） |
| **恢复默认** | 「恢复默认」按钮 → `DELETE /api/memory-settings`，删掉这一行回到 50 / 50 与默认预算 4000（`MemoryPage.tsx:239-265`、`app.ts:856-863`）；先弹一次确认框（`:192`），因为删行**不保留历史值**（23.6） |
| 同一时刻只允许一件事 | 读、保存、恢复默认共用一个 `busy`（`MemoryPage.tsx:23-24`、`:80`），跑着的时候按钮互相禁用 |

### 23.3 取值范围与错误码

| 字段 | 合法值 | 出处 |
| --- | --- | --- |
| `historyMaxMessages` | 整数 **≥ 2**、不设上限 | `MIN_MEMORY_MESSAGES = 2`（`src/workers/http/app.ts`；上限常量 `MAX_MEMORY_MESSAGES` 已在 `memory-nolimit-1` 删掉），判定 `isHistoryMaxMessages` |
| `summaryEveryMessages` | 整数 **0** 或 **≥ 2**、不设上限 | `0` = 关闭自动总结；`1` 无意义所以要拒（`isSummaryEveryMessages`，`:324-327`） |
| `summaryMaxChars` | 整数 **0** 或 **500..20000**（含端点） | `0` = 未设置（运行时 4000）；`1..499` 与 `20001+` 都拒（`MIN_SUMMARY_MAX_CHARS = 500` / `MAX_SUMMARY_MAX_CHARS = 20000`，`app.ts:63-65`；判定 `isSummaryMaxChars` `:329-332`、收值 `readSummaryMaxChars` `:334-341`） |

- 收数字的口径：整数或纯数字串都收；小数、负数、布尔一律不合法（`readMemoryCount`，`app.ts:307-317`，与 §22.3 的 `readCoveredUntilId` 同一口径）。预算的键**可以整个不传**：缺键与 `0` 同义（`readSummaryMaxChars`，`app.ts:334-341`）。
- 前端先拦一遍（`MemoryPage.tsx:194-216`：条数/阈值在 `:194-203`，预算在 `:204-216`），服务端再校验一遍（`app.ts:831-842`）——绕过页面直接打接口同样会被拒。预算留空或填 `0` 都按「未设置」提交（`parseBudget`，`:57-63`）。
- `updatedAt` 只由服务端取：`app.ts:818-825` 发起写入、`src/workers/db/d1-repository.ts:612-633` 的 `put()` 补当前时刻并回写整行，客户端传什么都不认。

四条接口（全部 JSON；全部挂在 `ALL /api/*` 鉴权之后，**没登录 / Cookie 过期一律 401**，注册处 `app.ts:780` 有注释）：

| 方法 | 路径 | 入参 | 成功 | 实现 |
| --- | --- | --- | --- | --- |
| GET | `/api/memory-settings` | 无 | `{ items: ChannelMemoryConfig[] }`，**只列已保存的行** | `app.ts:797-798` |
| GET | `/api/memory-settings/channel` | `guildId`、`channelId`（query） | `{ config: ChannelMemoryConfig }`；没有行时 `updatedAt: ''`、`summaryMaxChars: 4000`，另两个数字是服务端默认值 | `app.ts:805-819` |
| PUT | `/api/memory-settings` | body `{ guildId, channelId, historyMaxMessages, summaryEveryMessages, summaryMaxChars? }` | 200，保存后的整行；预算为 0 时不建这个键（列里落 0，读侧仍按未设置） | `app.ts:824-854` |
| DELETE | `/api/memory-settings` | `guildId`、`channelId`（query，不是 body） | `{ ok: true }`；本来没有也回 200 | `app.ts:828-835` |

错误码（后端只回码，页面翻成中文）：

| 状态 | 码 | 什么时候 | 出处 |
| --- | --- | --- | --- |
| 400 | `BAD_CHANNEL_KEY` | `guildId` / `channelId` 缺失、为空或不匹配 `/^\d{1,32}$/`；`PUT` 的 body 读不出来（空 body、坏 JSON）也走这个码 | `SNOWFLAKE_PATTERN` / `readChannelKey`（`app.ts:142-148`）；`GET channel` `:783`、`PUT` `:803-805`、`DELETE` `:830` |
| 400 | `BAD_MEMORY_SETTINGS` | 三个数字任一不合法：条数小于 2、阈值既不是 0 也不是 ≥ 2、预算不是 0 也不是 500..20000（非整数同样拒） | `app.ts:831-842` |
| 401 | — | 没登录 / Cookie 过期 | 四条都在 `ALL /api/*` 鉴权之后 |

### 23.4 什么时候生效

一句话：**从下一轮回复起生效**，不重启 Worker、不等缓存——每次回复都现场读一次 D1（23.1 最后两条）。分路径看：

| 路径 | 生效时机 | 为什么 |
| --- | --- | --- |
| 斜杠命令（`/chat` 等，走入口 Worker） | **部署即生效** | 每个请求现建 `createChatService({ ...data, … })`（`src/workers/index.ts:160-167`），`channelMemory` 随 `...data` 从 `createRepositories` 一起带进来（`src/workers/db/d1-repository.ts:729`），没有跨请求缓存 |
| 普通消息（@ bot，走常驻 Gateway / DO） | **要等 DO 换码** | DO 里每条消息同样现建 chat 并现读 D1（`src/workers/gateway/engine.ts:625-634`），所以只要实例跑的是这一版，改完下一条消息立刻按新数字走；但 deploy 之后旧实例可能还在跑旧代码（§13），旧代码根本不会去读这张表 |

门牌：`GATEWAY_BUILD = 'summary-order-2'`（`src/workers/gateway/engine.ts` 顶部的常量），打在 `[gateway] alarm build=summary-order-2`（心跳）与 `[gateway] dispatch build=summary-order-2 …`（每条消息）两行上。**看到 `summary-order-2` 才说明 DO 换到这一版**；还看到 `reaction-guide-1` / `memory-nolimit-1`（或更早的 `emoji-alias-1` / `emoji-vision-2` / `emoji-vision-1`）说明实例没换，@ 路径的配置要等实例被驱逐（通常几分钟到数小时，§13）——这不是 bug，别改代码。

怎么确认「当前真正生效的数字」——看 `[chat] turn` 那一行（`src/core/chat/service.ts:582-595`）：

- `hist=<n>`：本轮生效的**注入条数**（频道行值，没有行就是 50）；`sum=<n>`：本轮生效的**自动总结阈值**（`0` 表示这轮不自动总结）。这两个数就是 23.1 那两个字段的最终取值（`resolveTurnMemory`，`:137-150`）。
- **预算不在这一行里**（`[chat] turn` 的字段没变）：要看预算是否生效，比 `summaryLen=` 与 `systemLen=`——`summaryLen` 是库里累积正文的**全量**长度（不受预算约束），`systemLen` 才是真正注入了多少。把预算调小后 `systemLen` 跟着变小、`summaryLen` 不动，就是这个频道生效了（§31.3）。
- `history=<n> of=<m> dropped=<k>`：**实际**注入的条数 / 该频道库里的总条数 / 一共丢了多少条。`hist` 是「允许注入多少」，`history` 是「真的注入了多少」——字符安全阀已去掉（`memory-nolimit-1`），`history` 只会在「库里没这么多条」时小于 `hist`（新频道、刚 `/reset`）。
- 例：把某频道注入条数改成 120，下一条回复的日志应当是 `hist=120`，且 `history=` 不超过 120；把阈值改成 0，日志是 `sum=0`，此后再没有自动的 `[chat] 自动摘要完成` 行。
- 反例（最容易踩的）：日志是 `hist=50 sum=50` 而你自以为配了 200 / 30——说明这个频道**没有生效的行**：要么 ID 填错（配置写到了别的频道），要么 @ 路径的 DO 还没换码（`build=` 仍是旧门牌）。

### 23.5 失败与观测

- **读配置失败不影响回复**：`readChannelMemory` 只有一条降级日志 `[chat] 读取频道记忆配置失败，按默认继续：<原因>`（`src/core/chat/service.ts:392-400`，日志在 `:397`），本轮按 `config` / 代码默认（50 / 50）走完，用户看到的正文一字不差。这条**不进** `runtime_logs`（§26 没给它安排事件）。
- **摘要相关日志保持原样**：`[chat] 自动摘要失败：<原因>`（`service.ts:419-422`）、`[chat] 自动摘要触发失败（不影响回复）：<原因>`（`:424-426`）。关键字与 §14.4 一模一样，本节没有新增任何事件类型。
- **字符阀已去掉（`memory-nolimit-1`）**：上面那条「历史超出 … 字符，再丢最旧 k 条」的日志不会再出现——注入只由条数决定，不再按字符裁剪（architecture §31.8）。
- **写配置不写 `runtime_logs`**：`PUT` / `DELETE` 是纯 D1 写。要确认改动落库，直接看 `channel_memory_settings` 那一行——`updated_at` 就是你保存的那一刻。

排障顺序（症状 → 先看哪里）：

| 症状 | 先看 |
| --- | --- |
| 改完没反应 | 先看日志里 `hist=` / `sum=` 是不是你以为的值（23.4）。**是** → 配置已生效，差异来自字符阀或摘要素材上限（23.6）；**不是** → 继续往下看 |
| 日志是 `hist=50 sum=50`，但页面说配过 | ① 服务器 / 频道 ID 对不对（配置按 `(guild_id, channel_id)` 精确匹配，错一位就是另一行）；② @ 路径看门牌：`[gateway] alarm build=` 是不是 `summary-order-2` |
| 表里有行，日志却是默认值 | 看是哪条路径：入口 Worker 有没有部署上；DO 有没有换码（旧实例读不到这张表） |
| 日志出现 `[chat] 读取频道记忆配置失败，按默认继续：` | D1 侧的问题（表没建 / 迁移 `0010` 没跑 / 绑定断了）。这条 warn 是唯一信号，回复不受影响，先补迁移（§3） |
| 阈值设了，自动总结还是不触发 | ① 日志 `sum=` 是不是 0（0 = 关闭）；② 游标之后是不是真攒够了 N 条（`pending.length < summaryEveryMessages` 就不总结，`service.ts:417`）；③ 配了 500 而频道一天只来几条，那就是还没攒够 |
| 点保存报 400 | 去浏览器 Network 看响应体：`BAD_CHANNEL_KEY` 是 ID 格式，`BAD_MEMORY_SETTINGS` 是数字越界（23.3）。这类码只写在页面上，不进日志表（与 §22.5 同一口径） |

直连 D1 核对那一行（只读；写一律走后台，别手改 `updated_at`）：

```bash
npx wrangler d1 execute dc-ai-bot --remote --command "SELECT guild_id, channel_id, history_max_messages, summary_every_messages, updated_at FROM channel_memory_settings ORDER BY guild_id, channel_id"
```

### 23.6 已知边界

| 边界 | 说明 |
| --- | --- |
| 只在频道维度 | 一个频道一行；同一服务器的不同频道要各配一次，没有「全局默认」层，默认值就是代码里的 50 / 50（`DEFAULT_HISTORY_MAX_MESSAGES` / `DEFAULT_SUMMARY_EVERY_MESSAGES`，architecture §26.7 第 1 条） |
| 0 只关自动总结 | `/summary` 命令与后台「重新总结」仍可手动触发，走同一条 `summarize`，不受阈值影响（§26.7 第 2 条） |
| 条数是唯一闸 | 注入只由条数决定：字符安全阀已去掉（`memory-nolimit-1`，architecture §31.8），`hist` 与 `history` 的差只剩「库里没这么多条」（§26.7 第 4 条） |
| 摘要素材上限跟着本配置走 | 一次总结最多吃 `min(500, max(50, 阈值))` 条（`summaryBatchLimit`）：阈值 200 就一批 200 条，留在默认 50 就仍是 50 条，阈值超过 500 也只一批 500 条、靠循环多批追平；它限制的是「一次总结吃多少」，不是「每轮注入多少」（§26.7 第 6 条） |
| 删除行不保留历史值 | 「恢复默认」是 `DELETE`，删掉就没了；想留着旧数字就先抄下来（§26.7 第 5 条） |
| 并发后写覆盖 | 没有版本号：两个管理员同时改同一行，后保存的盖掉先保存的（`ON CONFLICT … DO UPDATE`，`src/workers/db/d1-repository.ts:617-624`），属已知边界（YAGNI） |
| 不校验频道存在 | 填一个不存在或打错的频道 ID 也能保存成功，只是永远没有回复去读它（`readChannelKey` 只校验格式，`app.ts:142-148`），与 §22.6「不校验频道存在」同一口径 |
| 每轮多算一趟读库 | `channelMemory.get()` 并进原来那批并行查询（`service.ts:532-543`），不串行等待、不增加回复时延；代价只是每轮多一次 D1 读 |

表里之外没有刻意设计的行为：遇到没写的现象，按 architecture §26.7 逐条对号，对不上就是 bug。

---

## 24. 贴表情：一次多个 + 指定目标消息

§15 定下的口径是「贴到触发它的那条消息上，最多 2 个」，§18 的表情模型那一版也只肯挑一个。这一版两条都放开：**一次最多 10 个**，而且能**指名贴到别的消息**——某条具体消息，或某个人的最近一条。契约见 architecture §28，本节只写运营侧怎么用、出问题看哪里。

一句话记法：`[[react:😄]]` 还是老行为（贴触发那条），后面接 `@目标` 就能换个地方贴。

### 24.1 怎么用（三种写法）

模型在正文里（表情模型的回答里同理）写这三种之一：

| 写法 | 贴到哪 | 判据 |
| --- | --- | --- |
| `[[react:😄]]` | **触发这一轮回复**的那条消息 | 没有 `@`，与 §15 完全一致，老写法照旧有效 |
| `[[react:😄@消息ID]]` | `@` 右边那个 ID 的那条消息 | 右边去空白后**全是数字且 15..20 位** → 当 Discord 消息 ID |
| `[[react:😄@作者名]]` | 该作者**最近一条**消息 | 右边不全是数字 → 当作者名（长度 1..32），在 24.2 那份清单里找 |

- 一次最多 **10 个**（`MAX_REACTIONS`，`src/core/chat/react.ts:4`）：按出现顺序去重，超过第 10 个的直接丢掉，**不报错**——表情贴不上不能影响已经生成好的回复。
- 主模型写在正文里的与表情模型挑的会**合并去重**，主模型的排前面（`mergeReactions`，`src/core/chat/service.ts`）。
- 表情模型可以一次给多个：**一行一个，最多 10 行**；**一次挑多个时每条都要写目标**（`表情@消息ID` 或 `表情@作者名`），分开贴到各自对应的那条消息、别全堆在对方这条；只挑一个才允许省略目标；**没有值得贴的就一行 `[[react:…]]` 都不写**（none-head-1 起共用默认文案不再提 `NONE`；`NONE` 只是表情请求那一侧的约定，见 §28.6）。
- 一条指令里目标只有一个：`ReactionRequest`（`src/core/types.ts:228`）的 `messageId` 与 `authorName` **互斥**，最多一个有值；两个都没有就是贴触发那条。
- 正文里**照旧不要**堆表情：`:名字:` 的渲染能力保留（发出去是真表情，§15.2），但「一次贴 10 个」是让它需要时贴，不是每句都刷一排。
- **2026-10-26 二次改口径（分散贴）**：以前提示词写的是「不写 @ 就贴在对方那条」，线上表现是几个表情全堆在 @ 她的那条消息上。主模型与表情模型两处提示词因此改成「一次贴多个时每条都要写目标，分开贴到各自对应的消息」。
- **2026-10-27 三次改口径（代码兜底，改成按最近说话的人分配）**：只改提示词不够——线上日志里表情模型几乎从不写 `@`（例如 `value=:OMG:,:laugh:,:heihei:,:lovelove:,:emoji_32:` 一个目标都没有），主模型又连着给同一个人写三次 `@名字`（`laugh@小明,OMG@小明,bengzhu@小明`），几个表情还是全堆在那一条上。现在**一律**先过 `spreadReactions`（`src/core/chat/react.ts`）：按聊天记录里**谁最近说过话**排一份名单，一条表情一个人、从最近的那个开始；模型点了名的先占位，**同一条消息被点第二次就顺延给下一位**；同一作者只留最新那条、机器人自己的消息不进名单。只有一个表情时不动；作者名在清单里找不到时照旧跳过并 warn（不悄悄贴到别人身上）。完整口径见 architecture §28.9。

### 24.2 它能看到哪些消息

可贴目标不是「全频道任选」，而是一份**当轮现拉的清单**（`messages` 表里没有 Discord 消息 ID，只能走 REST，§28.4）：

1. **最近 10 条频道消息**（`listChannelMessages`，`src/workers/discord/rest.ts` → `GET /channels/{channelId}/messages?limit=<n>`，新的在前，最多要 10 条）；
2. **触发这一轮的那条**（消息 ID、作者、正文前 30 字）；
3. **被回复的那条**（这条本身是回复的时候）。

触发那条通常已经在那 10 条里，所以候选最多 12 条；按消息 ID 去重后截到 **10 条**，渲染成 system 末尾的一段（放进 `TurnContext.reactionTargets`，`src/core/types.ts:221`）：

```
【可贴表情的消息】
#123456789012345678 卡利亞士兵：「给我们贴大量的emoji」
```

- 清单窗口就是 **10 条**：只有这份清单里的消息贴得到（24.6 第 1 条）。
- 清单里每行是一条 `ReactionTarget`（`src/core/types.ts:237`）：Discord 消息 ID + 展示名 + 作者 ID + 正文前 30 字。「@作者名」拿的就是那个展示名。
- REST 拉不到（token 失效、限流、网络）时**不阻塞回复**：只 warn `[gateway] 读最近消息失败：…`，清单退化成「触发那条 + 被回复那条」。

### 24.3 什么时候不会贴

| 情况 | 表现 | 为什么 |
| --- | --- | --- |
| 表情模型未启用 / 模型名留空 / 该供应商没有 Key | 只贴主模型正文里自己写的 `[[react:…]]`，一条都没写就一个也不贴 | §18.1：关着等于没这个功能；配了却调不通是 `[chat] 表情选择失败：` |
| 目标不在清单里（ID 对不上、作者名匹配不到） | 跳过这一条，其余照贴 | warn `[gateway] 贴表情目标不在清单里，跳过：…`；只允许贴清单里的消息（§28.7） |
| 表情不在该服务器的清单里 | 跳过这一条 | warn `[gateway] 表情不在该服务器的清单里，跳过：…`；不发给 Discord，避免 400 Unknown Emoji（§15.3） |
| 模型答 `NONE`（`none` / `无` / `不贴` 同义） | 这一轮不贴 | `normalizeReactions` 逐行判定，判为「不贴」的行直接跳过 |
| 斜杠命令（`/chat` 等） | 不贴，也不认 `reactions` | 交互路径不设 `reactionTargets`，按契约忽略 `reactions`（§18.7 / §15.4 不变） |
| 正文里堆一串 `:名字:` | 这不是「多贴」，只是正文变长 | 本功能管的是贴到消息上的 reaction，与正文渲染是两件事 |
| 一次多个但模型没给任何目标（或给了同一个目标好几次） | 按聊天记录里最近说过话的次序一人一条，撞了同一条就顺延；说的人不够才叠 | §28.9 代码兜底（`spreadReactions`）；不再全堆在 @ 她的那条上 |

另有几条**静默丢弃**（不 warn，设计如此）：整条指令超过 64 字符、`@` 右边的作者名超过 32 字符、表情名去空白后为空、与前面重复、以及第 11 个及以后。

### 24.4 失败与观测

贴表情全程在回复**已经发出去之后**跑，任何失败都只是 warn，用户不会因此少收一条回复（与 §15.3 同一口径）。这一版相关的 warn 四条，都在网关的 `#react` 与它的前置查询里（`src/workers/gateway/engine.ts`）：

| 文案 | 什么时候 | 影响 |
| --- | --- | --- |
| `[gateway] 读最近消息失败：` | 拉「最近 10 条」的 REST 挂了 | 清单退化成「触发 + 被回复」，照样能贴，只是挑不到更早的消息 |
| `[gateway] 贴表情目标不在清单里，跳过：` | 目标 ID 或作者名在当轮清单里找不到 | 只跳过这一条，其余照贴 |
| `[gateway] 表情不在该服务器的清单里，跳过：` | 值既不是 unicode 也不在该服清单里 | 只跳过这一条；不会向 Discord 发注定 400 的请求 |
| `[gateway] 贴表情失败（<表情>）：` | `PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me` 本身失败（表情被删、消息被删、没权限、限流） | 只跳过这一条；同一条也进 `runtime_logs`（§16） |

**成功**没有 warn 可看，看两处：

- `runtime_logs` 里表情模型那一行（`level=info`、`source=chat`）：`表情选择 model=<供应商>/<模型> value=<挑中的表情> ms=<耗时> images=<这次发了张数>`（`emit('info', 'chat', …)`，`src/core/chat/service.ts`）。**这一行不出现、也没有失败 warn** = 表情模型答了 NONE（没挑中）；连模型都没配就是没开（§18.1）。
- `runtime_logs` 里同一轮还有一行（`level=info`、`source=gateway`）：`贴表情 计划 👍→<消息ID>,🎉→<消息ID>`——这是**最终要贴的**表情与目标（已算上自动分散），只写 ID 不写正文。想知道「会贴到哪几条」看这一行最快。看到 `→本回合:<消息ID>` 表示模型没点名，按约定贴在本轮要回的那条上（不是出错；`→?` 这种写法已经没有了）。
- 频道里肉眼可见：被贴的那条消息下面出现 reaction。不是触发那条，说明模型写了 `@目标` 或代码兜底分散到了别人。

排障顺序（症状 → 先看哪里）：

| 症状 | 先看 |
| --- | --- |
| 要 10 个只贴了两个 | ① 模型到底写了几条（正文里的 `[[react:…]]` 会被剥掉，只能从结果看）；② 第 11 个及以后按设计丢弃；③ 重复的按设计去重 |
| 贴到了别的消息 | 不是 bug：模型写了 `@消息ID` / `@作者名`。要它贴回触发那条，就在提示词或这句话里说清楚「贴我这条」 |
| 指名贴没贴上，只剩 warn「目标不在清单里」 | 目标太老（不在最近 10 条里）、ID 打错、或作者名与清单里的展示名对不上（大小写不敏感，其它字符要一致） |
| 一条都没贴，日志里也没有 `表情选择` | 表情模型没开或模型名没填（§18.1）；不影响正文 |
| 几个表情全堆在 @ 她的那条 | 先看门牌 `[gateway] alarm build=summary-order-2`（旧门牌 = 旧代码，等 DO 换码）；门牌是新的就不是 bug——新代码只贴模型点名的目标，想让它分给大家得让它写 `[[react:😄@all]]`（§28.3） |
| 换了码还是只会贴一个 | 看门牌 `[gateway] alarm build=summary-order-2`，出现才是这一版（24.5）；一个表情本来就只贴触发那条 |

### 24.5 迁移（无新表、无新迁移）

- **不加表、不加迁移**：目标清单每轮从 Discord REST 现拉，`ReactionRequest` / `ReactionTarget` 只活在提示词与内部传参里，一个字段都不落库（`src/core/types.ts:228` / `:237`）。`messages` 表也没有（将来也不打算加）Discord 消息 ID——这正是清单只能走 REST 的原因（§28.4）。
- **没有新的配置项**：用不用、贴几个、贴哪里，全在模型的输出里，后台没有开关要拨；表情模型的开关照旧在「表情」页（§18.1）。
- **换码**：门牌换成 `summary-order-2`（`GATEWAY_BUILD`，`src/workers/gateway/engine.ts:129`），`[gateway] alarm build=summary-order-2` 出现才说明 DO 换到这一版。部署后旧实例可能还在跑旧代码（§13）：还看到 `memory-nolimit-1` / `emoji-alias-1` 之类更早的门牌，就是还没换——那会儿素材模板还是写死的、也看不到历史，等实例被驱逐（通常几分钟到数小时）再试，别改代码。
- **斜杠命令路径不受影响**：本来就不贴（§15.4），这次也没给它开 `reactionTargets`。

### 24.6 已知边界

| 边界 | 说明 |
| --- | --- |
| 清单窗口 10 条 | 候选是最近 10 条频道消息 + 触发那条 + 被回复那条，去重后截到 10 条；**更早的消息贴不到**，要贴就先回复那条（回复会把被回复的消息带进清单） |
| 同名取最新 | 「@作者名」在清单里命中多条时只取**最近一条**；同一个人更早的发言贴不到 |
| 改名就对不上 | 清单里的名字是 Discord 当前展示名；作者改名后清单里就是新名字，旧写法匹配不到 |
| 每贴一个一次 REST | 10 个就是 10 次 `PUT …/reactions/<emoji>/@me`；没有批量接口，一次调用贴不了一排（限流与成本口径见 §8） |
| 老消息要回复它才能贴 | 与第 1 条是同一件事：清单只装得下 10 条，历史消息得靠「回复它」或「@它的作者」被带进来 |
| REST 失败不阻塞 | 读最近消息失败只 warn（24.4），清单退化后可能挑不到想贴的那条 |
| 目标只认清单 | 不在清单里的 ID / 作者一律跳过并 warn，不会拿它去 Discord 试一把 |
| 斜杠命令不认 | 不设 `reactionTargets`、忽略 `reactions`（§18.7 / §15.4） |

对不上这张表的怪现象，按 architecture §28.8 逐条对号，对不上就是 bug。
---

## 25. 流式回复（@ 路径也能边生成边显示，2026-10-27）

**需求口径**：「@ 渠道要流式传输」——斜杠命令早就一条消息边生成边改，@ 路径却是等整段生成完（线上实测 22 秒）才一次性发出去，群里这二十多秒只有「正在输入」。

### 25.1 观感

1. 收到消息先只有「正在输入」；**首个 token 到了才发第一条消息**，内容就是正文开头（`POST …?wait=true`，图的是响应里的消息 id）。不发空的 `…` 占位——早先那一版发，群里会先看到一条孤零零的省略号。
2. 之后**不换消息**，而是 `PATCH` 这同一条：每 1200ms 把最新进度顶上去，群里看到的是同一句话越写越长。
3. 最后那次 PATCH 一定是最终全文（贴表情在它之后，照旧）。
4. 超过 1900 字的长回复：只有第一条滚动显示，剩下的等生成完再连发（Discord 单条上限，拆不拆由 `chunkMessage` 决定）。
5. 一个进度都没等到（秒回 / 空回复）：不建消息，直接发一条。

### 25.2 什么时候不流式（退回老行为）

| 情形 | 表现 | 日志 |
| --- | --- | --- |
| 首条消息发不出去（403 / 429 / 断网 / 没有 `MANAGE_MESSAGES` 之外的权限问题） | 不 PATCH，直接一次 POST 发全文，与流式之前一模一样 | `[gateway] 首条消息发送失败，退回整段发送：<错误>` |
| 一个字都没等到（秒回 / 空回复） | 不建消息、不留占位，直接 POST 一条 | 无 |
| 某次 PATCH 失败 | 只记一行，不打断这一轮；后面的编辑会把全文兜回去 | `[gateway] 流式编辑失败：<错误>` |
| 模型整段失败 | 已经建了消息就把那条改成 `回复生成失败：<错误>`；还没建就只发一条失败提示——不会留下半句或孤零零的 `…` | 原有失败日志照旧 |
| 斜杠命令（`/chat`） | 本来就是流式的，行为不变（§16） | `[chat] turn …` |

### 25.3 预算与限流

| 项 | 值 | 出处 |
| --- | --- | --- |
| 编辑间隔 | ≥ 1200ms | `intervalMs`（`src/workers/discord/editor.ts` 的 `createProgressiveEditor`；服务层已不节流，节奏只由这一层决定，§29.7） |
| 最多编辑次数 | 20（进度最多用掉 19，最后一次留给全文） | `STREAM_MAX_EDITS`（同文件） |
| 单条上限 | 1900 字 | `MESSAGE_CHUNK_LIMIT`（`src/workers/gateway/message.ts`） |
| 进度文本 | 已剥掉 `[[react:…]]` 与开头的假时刻，且只取第一段 | core 的 `onProgress` + `chunkMessage(...)[0]` |

Discord 对同一频道的 PATCH 有桶限制，上面这组值留了余量；要调只改常量，别在调用点加特判。

### 25.4 怎么确认在用新代码

- 门牌：`GATEWAY_BUILD = 'context-tool-3'`（当时：上下文工具模式——开关打开的频道把预设正文、长期记忆摘要与最近历史塞进 `context` 工具的描述体，`messages` 只发一条固定句，正文由 `story_reply` 交付，只在开关打开的频道生效、其它频道一个字节不变，迁移 0030、迁移总数 30，§55）；再往前 `GATEWAY_BUILD = 'reply-tool-3'`（107348§54）；前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `'director-6'`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）→ 上一版 `'director-5'`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio>]`；方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=…`，只记标签 / 字节数 / 字数与 mode，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（`docs/architecture.md` §47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（`docs/architecture.md` §47）；`'tts-mimo-1'` 那一版记的是`src/workers/gateway/engine.ts:129`；§46.7 记这一版：接口类型（dialect）——同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`，老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），排错见 §25.14；前一版 §46 记 `tts-admin-1`：TTS 接口搬进后台——地址 / Key / 模型 / 默认音色只认后台「语音」页（`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改），`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听，排错见 §25.14；再前一版 §45 记 `prompt-scope-1`：内置默认（`fallback`）与身份块（`identity`）都能在后台改——`prompt_defaults` 两个 key × 三层、解析顺序三层提示词 → 三层内置默认 → 代码常量、三层都没配时输出与上一版逐字相同，排错见 §25.13；§44.1 记再前一版 `voice-2`：按指令模式补上【语音】段——只有 `mode = 1` 注入、教模型在正文里单独写一行 `[[voice]]`，位置在表情规则块之后、自定义表情清单之前，`0` 与 `2` 不注入；§44 记再前一版 `voice-1`：语音回复（文字回复结束后可发一条 mp3 附件、三档三层开关，§25.12）；再前一版 `'pg-errors-1'` 是后台「故障」页看 PG 中继报错（§43）；再前一版 `'mention-once-2'`（同一个人一条回复只 @ 一次，§42），再前一版 `'vision-main-2'`，再再前一版 `'vision-main-1'`，再再再前一版 `'none-head-1'`，日志 `[gateway] alarm build=reply-tool-3` 出现才说明 DO 换到这一版（§13）；`fake-stream-1` 是假流式第一版（片数写死 6、不可关），`fake-stream-2` 起片数三层可配（§25.7、`docs/architecture.md` §38），这两版都是历史；`mention-1` 起服务器频道里的回复自动在正文前 @ 提问者、`allowed_mentions` 只放开解析用户（§25.8、`docs/architecture.md` §39，前一版）；`mention-2` 把 @ 前缀与「…(已截断)」一起算进正文预算，回复打满 1900 时不再吃掉正文尾巴（§25.8、`docs/architecture.md` §39.2，前一版）；`reply-continue-1` 把被掐断的半句自动续上、仍然只有一条消息，成功日志在续过时多一个 `cont=<次数>`（§25.9、`docs/architecture.md` §40，前一版）；`stream-edit-1` 把整条回复改成边说边编辑：服务层不再节流、模型每来一块就立刻推，节流只在编辑器（1200ms 一改、最多 20 次），续写的每一段同样边收边推（§25.7、`docs/architecture.md` §29.7，前一版）；`empty-note-1` 改的是只 @ 不说话：不再替用户编一句问话，只交一句事实标记「（对方只 @ 了你，没有写正文）」，怎么接、说什么全由她自己判断（§14.2、`docs/architecture.md` §33.9，前一版）；`none-head-1` 改的是回复正文开头单独一行 `NONE` 由服务层剥掉、共用默认文案改成「一行 `[[react:…]]` 都不写」，`NONE` 只留给表情请求那一侧（§28.6、`docs/architecture.md` §33.9，前一版）；`vision-main-1` 起主对话模型也接同一轮那几张图：网关 `imageRefs` 一轮只下载一份、只进主对话首段与表情请求、续写不带图、读图失败按无图继续，上限 4 张 / 单张 5MB，无图时请求形状逐字不变（§19.7、§28.7、`docs/architecture.md` §22.9，前一版）→ `vision-main-2` 的后台三层识图开关（后台「回复」页第二张卡片，默认开；关掉只影响主对话模型，表情模型照旧能看，§19.8、`docs/architecture.md` §41，前一版）→ `mention-once-2` 的同一个人一条回复只 @ 一次（自动加在正文开头的 @ 前缀算那一次；正文里重复的 `<@id>` 换成显示名，查不到名字就整段去掉标签，§25.10、`docs/architecture.md` §42，前一版）→ `voice-1` 的语音回复（文字回复结束后可发一条 mp3 附件、三档三层开关，§25.12、`docs/architecture.md` §44，前一版）→ `voice-2` 的按指令模式提示段（提示词以前从没教过 `[[voice]]`，`mode = 1` 等于永远不触发；现在只有 `mode = 1` 注入【语音】段，`0` 与 `2` 不注入、普通消息提示词与前一版逐字相同，§25.12、`docs/architecture.md` §44.1，前一版）→ `prompt-scope-1` 的内置默认（`fallback`）与身份块（`identity`）可编辑（`prompt_defaults` 两个 key × 三层；解析顺序三层提示词 → 三层内置默认 → 代码常量；三层都没配时输出与上一版逐字相同；§25.13、`docs/architecture.md` §45，前一版）→ `tts-admin-1` 的 TTS 接口搬进后台（地址 / Key / 模型 / 默认音色只认后台「语音」页——`tts_settings` 单行表、AES-256-GCM 加密入库、接口只回掩码、留空不改，`VOICE_TTS_*` 四个环境变量那一版起完全不生效，每条消息现读一次、改完下一条就生效，后台另有独立「语音」页与试听；§25.14、`docs/architecture.md` §46，前一版）→ `tts-mimo-1` 的接口类型（dialect）（同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`，音频在 `choices[0].message.audio.data`、没有 `speed`；老行默认 `openai`、行为不变，迁移 `0023`、迁移总数 23；§25.14、`docs/architecture.md` §46.7，前一版）→ `tts-style-1` 的朗读语气三层（channel / guild / global）+ 可选情绪判断模型（模型不再可写、按接口类型取内置默认（`tts-1` / `mimo-v2.5-tts`）；迁移 `0024`、迁移总数 24；§25.15、`docs/architecture.md` §47，前一版）→ `tts-tags-1` 的朗读语气改成 assistant 正文开头的标签 + 正文逐字校验（标签贴 assistant 正文最前面、正文任意处可插 `[音频标签]`、不再发 `user` 消息；§25.15、§47.7，前一版）。
- 直观验证：@ 她一句长问题，应该先只有「正在输入」，**等第一个字出来才冒出第一条消息**（内容不是 `…` 而是正文开头），随后这条消息越写越长，而不是等十几秒才蹦出整段。
- 老门牌（`stream-reply-1` = 先推 `…` 占位那版；`react-spread-3` 及更早 = 完全没有流式）还在跑旧代码，等实例被驱逐再试。

### 25.5 迁移

- **没有迁移**：不改表、不加配置项，纯网关行为。
- 斜杠命令路径（入口 Worker）部署即生效；@ 路径要等 DO 换码（§13）。

### 25.6 已知边界

| 边界 | 说明 |
| --- | --- |
| 只有第一条流式 | 超过 1900 字的部分在生成完之后才补发，那几条不滚动（2026-10-27 定的口径） |
| 首字之前没消息 | 模型迟迟不吐第一个 token 时群里只有「正在输入」——这是「首字到了才发」的代价（要更早可见就得发空占位，§29.1） |
| 半句会留痕 | 已经发出去的消息在进程被硬杀掉时会停在半句（正常结束必被改成全文） |
| 编辑不是逐字 | 观感是「每 1200ms 跳一段」，不是打字机；要更细就缩间隔，代价是限流风险 |
| 20 次预算 | 极长的回复在 20 次编辑后就不再滚动了，但最后一次 PATCH 仍是全文第一段 |
| 不影响落库 | 落库、回复链、贴表情、摘要都还是最终文本那一套（§18 / §28） |

对不上这张表的怪现象，按 architecture §29.4 逐条对号，对不上就是 bug。

### 25.7 假流式（`fake-stream-1` 那一版起，`fake-stream-2` 起片数可配）：两个现象怎么读

| 现象 | 怎么读 |
| --- | --- |
| 回复比平时慢几秒才出现文字 | 上游整段一次性返回时，网关先把整段拿到手、再切片挤出去（每片之间 ≥ 1200ms，片数取当前频道解析出来的那一档、默认 6，再加收尾的全文，即默认最多 7 次发送、最坏多花约 8 秒）。这是**在挤包，不是卡住**：日志里没有新报错，最终全文一定会到 |
| 回复一次性蹦出全文 | 文本本来就短（还差不到 24 字就不再动画），或者模型整段极快返回、`push` 已经把全文推上去过（那条路一次都不重发）；也可能是当前频道解析出来就是 **0（已关闭）** |
| 关了还是一次性蹦出 | 先确认那层真的存了（后台「回复」页的列表里能看见这一行、片数是 0），再确认没被更高层覆盖——**频道 > 服务器 > 全局**，前一层有值就盖住后一层：服务器层配 0、而这条频道自己配了 6，则照样会挤 |

- 口径与代码位置见 `docs/architecture.md` §29.6；这套逻辑只在 `src/workers/discord/editor.ts`，斜杠与 @ 两个调用点只传参数。
- **服务层已不节流，观感由编辑器节奏决定（1200ms 一改）**：模型每来一块就立刻推给编辑器，最终多久改一次这条消息只看 `intervalMs`(1200ms) 与 `maxEdits`(20)，所以「慢几秒才出现文字」这类问题先按下面那张表对号，别去服务层找节流（§29.7）。
- **要调快慢或关掉**：后台「回复」页，三层（**频道 > 服务器 > 全局**，前一层有值就盖住后一层），填 `0` 就是关闭假流式（一次发全文）；片数合法区间 `0..10`、默认 `6`，契约见 `docs/architecture.md` §38。
- **改完立刻生效**：每条消息开流前现读一次配置、不缓存，保存后下一条回复就用新值——不用重启、不用等缓存过期；只是 @ 路径要 DO 已经换成 `mention-2` 或更新的门牌（本版 `pg-errors-1`）才认这个开关（§25.4）。

### 25.8 @ 人（`mention-1` 起，`mention-2` 修预算；当前门牌见 §25.10）：两个现象怎么读

| 现象 | 怎么读 |
| --- | --- |
| 她 @ 了人、但对方没收到通知 | 先确认那条回复是**在服务器频道里**发的——私聊不加前缀，正文里根本没有 `<@id>` 就没有 ping 目标。再确认她写的是 `<@id>` 形式（`<@!id>` 也算）而不是纯文本「@某某」：Discord 只认这两串 id 标记，纯文本「@某某」从来不会 ping。都不是的话看门牌是否已到 `mention-2`（§25.4）——`mention-1` 之前的门牌上 `allowed_mentions` 还是 `parse: []`，写了 `<@id>` 也不会亮 |
| 有人被 `@everyone` 骚扰 | 这一版之后 `@everyone` / `@here` / `<@&角色id>` **一律不解析**，只有用户提及会真的 ping。若还出现，先查门牌是否已到 `mention-2`（§25.4）——`mention-1` 之前的实例上斜杠那条路仍按 Discord 默认值全解析，所以这个症状最可能是「DO / Node 还没换码」，不是这一版本身 |

- 契约与两条路径的落地见 `docs/architecture.md` §39；预算算法（前缀与「…(已截断)」都先从正文预算里扣：设前缀长度为 P，斜杠路径 1900 = P + (1900 - P - 6) + 6、@ 路径 1900 = P + (1900 - P)；真实 snowflake 下 P = 23，即 1900 = 23 + 1871 + 6 与 1900 = 23 + 1877）在 §39.2。看门牌是否够新只能决定「前缀有没有」，前缀把正文尾巴挤掉这件事从 `mention-2` 起才没有。
- 前缀只加给服务器频道里的回复：私聊不加，斜杠命令的 `/总结`、`/记忆` 与错误提示这类命令输出也不加。

### 25.9 回复只有半句（`reply-continue-1` 起）：三个现象怎么读

| 现象 | 怎么读 |
| --- | --- |
| 频道里的回复只有半句、句尾停在一个词中间 | 先看那条 `回复成功 …` 日志末尾有没有 `cont=<次数>`：`cont=1` 表示这条被自动续过一次（值就是这一轮实际续写的次数），正文是合并后的完整版，落库也只有一条消息（§40.2）。有 `cont=` 却仍然读不通，说明它在次数上限（最多续 2 次）或累计上限（3000 字）处停了——该看模型那边为什么续不出来，而不是判据没生效。 |
| 偶尔一次回复比平时多花一次模型请求的时间 | 这是 `[END]` 自撤：判据把一条本来就完整的回复判成了截断，于是多问了一次「接着说」，模型看到那段其实已经写完，就只回 `[END]`，这条回复原样保留、一个字都不改（§40.2）。所以「多出来一次请求」不代表内容被改过；判据到底救没救到，看日志里有没有 `cont=`。 |
| 续写那一次失败了 | 只会多一条 `warn` 级日志（`chat` 来源），这条回复仍按成功记、频道里已经写出来的正文不变，`messages` 里存的还是那半句（§40.2）。这是设计内的降级：续写是补救不是主路，别把它当成「生成失败」去排查模型路由。 |

- 判据为什么不用标点、双信号各管什么，见 `docs/architecture.md` §40.1；`@` 路径与 `/chat` 走的是同一个回合循环，所以两条路的读法一致。
- `cont=` 只在真的续过时才出现：日志里没有它，就是这条回复一次续写都没发生（§40.2）。

### 25.10 回复里同一个人被 @ 了好几次（`mention-once-1` 起，`mention-once-2` 扩了名字来源）

| 现象 | 怎么读 |
| --- | --- |
| 一条回复里同一个人被 @ 了不止一次 | 这是 `mention-once-1` 之前的行为：自动加在正文开头的 @ 前缀点一次名，模型又在正文里自己写了一次 `<@id>`；Discord 每见到一处 `<@id>` 都算一次提及，那个人于是被 ping 了好几回。 |
| 同一个人第二次出现变成了名字 | 这是 `mention-once-1` 起的行为，不是 bug：每条回复只 ping 同一个人一次，重复的那几处换成聊天记录里的显示名，正文照样读得通。 |
| 名字不对，或者干脆没有名字 | 显示名取 `messages` 表的 `author_name`（§12），在这一频道的**全部历史**里找（`mention-once-2` 起，不再只取注入窗口那 50 条），同一个人改过昵称就取最近那个；迁移前的老行是 `NULL`，读出来没有名字——这时整段 `<@id>` 会被去掉，不会留下裸的 `@`，也不会留下半截 id。 |

- **根因**：提示词里每一行历史都是 `[MM-DD HH:mm] 显示名(用户ID)：正文`（§12、`docs/architecture.md` §18.3），模型看得见 id，就可能在回答里也写一次 `<@id>`；这与自动前缀叠在一起，同一个人就被 ping 了好几回。
- **现在的行为**：每条回复只 ping 同一个人一次——自动加在正文开头的 @ 前缀算那一次；正文里同一人再出现时换成显示名、不带 `@`；查不到名字就整段去掉标签。计数按「每条回复」算一次，跨多条 Discord 消息也一样；私聊不加前缀、也不做这件事。
- **提示词一侧**：系统提示里加了一条规则教她写昵称或绰号，@ 过之后同一个人再出现直接写名字；代码那一步只是兜底。
- **看哪里**：① 直接看频道里那条回复的正文——还剩几个 `<@id>` 就是还有几个真 ping；② 后台「实时日志」标签（§16）看这一轮有没有失败 / 告警（本项是正常行为，不是错误）；③ 门牌是否已经到 `mention-once-2` 或更新（`[gateway] alarm build=reply-tool-3` / `[node] listening … build=reply-tool-3`，§25.4、§13）——旧门牌上没有这道兜底，等 DO 换码。
- 契约与代码位置见 `docs/architecture.md` §42；@ 前缀与 `allowed_mentions` 的既有口径见 §25.8 与 `docs/architecture.md` §39。

### 25.11 模型 / 中继报错怎么查（`pg-errors-1` 起）

门牌到 `pg-errors-1` 之后，后台顶栏多了一个「故障」标签（`web/src/App.tsx:36`）：它列的是 **PG 中继最近失败的请求**，数据来自中继的 `GET /admin/errors`（经 Caddy 是 `/pg/admin/errors`），bot 侧由 `/api/pg-errors` 代理。契约与字段逐条见 `docs/architecture.md` §43，本节只说运维怎么读。**旧门牌上没有这一页**：标签都不出现，别去找开关。

**一行读一条失败**：列是时间 / 错误码 / 模型 / key / 耗时 / 原因。

| 看到什么 | 怎么读 |
| --- | --- |
| `executor_timeout`，耗时那一列几万毫秒 | 中继把请求交给执行器后没等到回应。多半是那台机器上的有头 Chrome / Xvfb 卡住，或同一把 key 的请求排太长。先看中继日志里的执行器几行，再看那台机器的负载 |
| `502` 一类非 2xx 的状态 + 原因里带上游的话 | 中继的上游（playground）回了非 200，原因那列就是它转述的原话。同一时段多条同码，按上游故障处理，别在 bot 这侧改配置 |
| `api_key_required` / `api_key_rejected` | 执行器连中继时没带 key、或那把 key 不在中继 `.env` 的 `API_KEYS` 里（`studio-api 的 server.js:618` / `:624`）。这是中继内部握手失败，不是 bot 的回复请求失败 |
| 模型那列有值、key 那列是掩码 | 能对上「哪把 key 跑哪个模型」；掩码只留头尾几位，想看完整 key 只能去后台「密钥」页看 hint（见 `docs/architecture.md` §11 的 `GET /api/keys`，那里也只回 `keyHint`） |
| 原因末尾带「（已重试 N 次）」 | 这一条是重试过 N 次才交出来的；原因本身最多 500 字符，超出就被截断 |
| 顶部「共 N 条（已丢弃 M 条）」 | `N` 是当前条数（不会超过 200）；`M` 是中继进程启动以来被挤出缓冲的累计条数。`M` 变大不是故障，只说明更早的看不到了 |

- **中继重启就清空**：缓冲只在进程内存里，不是审计日志。要留证据就翻中继的 docker 日志。
- **这页会自己定时拉**，忙的时候可以「暂停自动刷新」，徽标会写当前状态；单条能复制，也能一次复制全部，贴给别人比对截图省事。

**501 与 502 各意味着什么**：

| 结果 | 页面上看到 | 真实含义 | 怎么办 |
| --- | --- | --- | --- |
| 501 | 「未配置 PG 中继：后台缺环境变量 PG_ERRORS_URL / PG_ERRORS_TOKEN」 | bot 根本没拿到中继地址或 token（`src/node/main.ts:140-144`），这条路由回 `PG_ERRORS_UNAVAILABLE`。**其它页面与 `/api/health` 完全不受影响** | 给 bot 补两个环境变量、`docker compose up -d` 重启；不补也只是这一页没有数据源 |
| 502 | 「中继暂时取不到报错：<一句中文原因>」 | 地址配了，但这次没拿到可用数据：连不上、超时、中继回非 200、返回不是 JSON、形状不对（`src/core/pg-errors.ts:113-150`）。`detail` 就是那句原因 | 先读 `detail`：连不上 / 超时改地址与网络；中继回 401 多半是 `PG_ERRORS_TOKEN` 不在中继 `API_KEYS` 里；中继回 5xx 看中继日志 |

- 501 / 502 **不会**把表洗成空：上一次成功拉到的数据还留在表里，失败提示单独挂着。
- 这两条错误码只在「故障」页出现，`web/src/api.ts:1620` 把它们翻成中文；不影响回复，也不影响别的前端页面。

**和另外几节的关系**：

- **§31 回复失败排错**：§31 读的是 bot 这侧的三处证据（`回复失败` / `ALL_PROVIDERS_FAILED` 日志、`runtime_logs`、频道里那条消息）。怀疑问题在中继那一端时，来「故障」页对同一时间段的条目——两边时间戳能对上，就不用再猜。
- **§19 多模态**：识图请求走同一条中继，所以「图没被模型看到」先看 §19.4 的失败口径与 §28.7 的逐条排错，再回「故障」页确认同一时刻有没有条目；**「故障」页没有条目不等于图没被丢弃**（跳过图片只写中继日志，不记成失败条目）。
- **门牌**：这页要 `pg-errors-1` 或更新——日志里 `[node] listening … build=reply-tool-3` 或 `[gateway] alarm build=reply-tool-3`（§25.4、§13）；旧门牌上这个标签不存在。

### 25.12 语音发不出来怎么查（`voice-1` 起）

`voice-1` 起文字回复可以再配一条语音：正文发完之后合成一段 mp3，作为**单独一条附件消息**发到同一个频道。开关在后台「语音」页的「语音回复」卡片（`tts-admin-1` 起从「回复」页搬过去；三档 + 音色 + 语速），三层取值（**频道 > 服务器 > 全局**）；合成用的地址 / Key / 模型 / 默认音色也在这一页（「语音合成接口」卡片，§25.14）。契约见 `docs/architecture.md` §44 与 §46，这里只列「没声音」的几种原因，按这个顺序对号。

| 看到什么 | 怎么读 | 怎么办 |
| --- | --- | --- |
| 一点动静都没有，日志里连 `[voice]` 都没有 | `mode = 0`（关闭，也是默认值）：三层里命中的第一层是 0，或者三层都没配 | 后台「回复」页选层级，把三档选到 1 或 2 再保存；注意是**频道 > 服务器 > 全局**，服务器层配了 0 会盖住全局层 |
| 明明选了 2 还是没有，日志里也没有 `[voice]` | TTS 没配：后台「语音」页状态条显示「未配置：语音回复不会发出声音」（库里没有行、`url` 空、`key` 空三者任一）。`tts-admin-1` 起**只认后台配置**，`VOICE_TTS_*` 四个环境变量不生效、可以删 | 去后台「语音」页填地址与 Key（首次必须给 Key；编辑时 Key 留空 = 保留原 Key），点「试听」听到声音再保存。地址要 http/https 且 ≤500 字，Key ≤500 字；模型 / 音色可以空（模型按 `tts-1`、音色用服务端默认） |
| 日志里有 `[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…` | 这条语音正常发出去了：成功日志是 `voice-log-1` 起补的，只记标签 / 字节数 / 字数 / mode / director（`'director-2'` 起还可能带一个可选的 `rejected=` 段，只有导演模式退回原文时才出现）；`'director-4'` 起后面还可能跟一个可选的 `judge=` 段，放的是 judge 那一行的完整一行、不截断，**正文绝不整段进日志**（日志里不出现用户 / 模型正文的整段，这一段的例外口径见 §19.1） | 不用管。`tag=无` = 这次没有语气标签（没配 judge、judge 失败 / 超时，或标签没通过逐字校验）；字数是念的正文长度、`bytes` 是 mp3 字节数，两种单位、对不上是正常的。gateway 路径可在后台运行日志页按 `level=info`、`scope=gateway` 查到 |
| 既没有 `[voice] 已发送 …` 也没有 `[voice] 语音发送失败 …` | 这一轮根本没进入合成：`mode` 与标签判定的结果（`0` 关闭、`1` 没写 `[[voice]]`），或者这条回复没有可念的正文——不是接口坏了 | 先看本节第 1 条核对 `mode` 与三层设置，再看这一轮正文末尾有没有 `[[voice]]`；真合成过就一定有「已发送」或「语音发送失败」其中一条 |
| 日志里有 `[voice] 语音发送失败 …`，状态码 401 / 403 | 端点拒了：401 多半是 Key 不对或过期，403 是这把 Key 没有该模型 / 该音色的权限 | 在后台「语音」页换 Key（要换就填新的，留空保留原 Key）、改模型或换音色；「试听」能复现同一个错（§25.14），不用等真回复。失败只 warn、不重试，回复本身照常 |
| `mode = 1` 时有时有、有时没有 | 这一档只有模型在正文里写了 `[[voice]]` 才发；指令本身被剥掉，频道里看不到它 | 想每条都发就改成 2；想让她自己判断，就在提示词里教她什么时候写 `[[voice]]` |
| 选了 `1`，但从来没有语音（日志里连 `[voice]` 都没有） | `mode = 1` 是「她写了 `[[voice]]` 才发」，而这一档要靠提示词教她这条写法：`voice-2` 起 `mode = 1` 的 system 里才有一段【语音】（固定文案见 `docs/architecture.md` §44.1，位置在表情规则块之后、自定义表情清单之前） | ① 先确认实例是 `voice-2` 或更新（§25.4、§13），再看这一轮的 system 里有没有【语音】段——前一版 `voice-1` 根本没有这一段，那一档当时等于不触发；② 确认有段之后再看日志里有没有 `[voice]`：有段、有指令才会有；想每条都发就改成 `2`（`2` 不注入这一段、也不需要它） |
| 语音是发出来了，但读到「…(已截断)」这类痕迹 | 朗读文本不是原文：@ 提及、markdown 记号、结尾的「…(已截断)」都会先被清掉，再压空白——这一版起**不设字数上限**，本服务不再自己截 | 设计内行为；念多长由上游接口决定，上游嫌长就整条合成失败（日志 `[voice] 语音发送失败 …`、回复照常、只是这条没声音） |
| 日志里没有失败、mp3 也生成了，频道里却没有那条附件 | 附件发不出去：bot 在该频道缺 **Attach Files**（附文件）权限，Discord 回 403，日志里就是那条 `[voice] 语音发送失败` | 频道权限里给 bot 勾上 Attach Files（顺带确认 Send Messages / View Channel）；改完下一条回复就生效 |

- 失败一律只 warn：合成与上传都在文字回复发完之后，任何一步失败都不影响那条回复（不改、不删、不回滚），也不自动重试——下一条回复再试。
- **成功也留一条 info（`voice-log-1` 起）**：读法只有三种——有 `[voice] 已发送 …` 就是这条正常；有 `[voice] 语音发送失败 …` 才是失败；两条都**没有**说明这一轮根本没进入合成（`mode` 与标签判定的结果），不是接口坏了。成功那条只记标签 / 字节数 / 字数 / mode / director（`director` 就是这条用的导演档位，`tag` 优先取 judge 给的风格组）、正文绝不整段进日志（`'director-4'` 起还可能跟一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断），所以日志里查不到整段念了什么内容是设计如此；写这条日志本身抛错也不影响这条语音已经发出去（返回值仍是 `sent: true`）。gateway 路径可在后台运行日志页按 `level=info`、`scope=gateway` 查到，Discord 交互路径没有级别、只进控制台（契约见 `docs/architecture.md` §44.3、§47.7）。
- 本轮只发 **mp3 附件**，不发 Discord 语音气泡；看到「一条没有正文、只有一个音频文件」的消息是正常的。
- **`mode = 1` 的提示段（`voice-2` 起）**：这一段只在 `mode = 1` 时进 system，逐字文案与位置见 `docs/architecture.md` §44.1；`0` 与 `2` 不注入——`0` 注入只会让她白写一行废指令（写了也不发），`2` 每条都发、不需要指令。前一版 `voice-1` 不存在这一段，所以那一版的 `1` 永远不触发。
- 门牌：要 `voice-1` 或更新（§25.4、§13）——旧门牌上这条支线根本不存在，日志里也不会有 `[voice]`。
- **TTS 配置本身的排查（语音页状态条 → 试听 → `TTS_NOT_CONFIGURED` / `TTS_UPSTREAM` → mode → 日志）见 §25.14**：`tts-admin-1` 起地址与 Key 只在后台配，不再看 `.env`。

### 25.13 提示词改了没生效怎么查（`prompt-scope-1` 起）

`prompt-scope-1` 起主模型最底层也**分层可配**：后台「提示词」页最上面那张卡片分三层 tab（channel / guild / global，每个 tab 带自己的「已配置 / 未配置」状态），两块编辑区——`fallback` 是三层提示词段落都为空时那段「基本设定」，`identity` 是每轮追加的【当前对话】身份块。保存与「恢复默认」**只作用于当前 tab 那一层**；每块下方有 500ms 防抖的实时预览，卡片底部还有一块只读的「代码内置（只读）」（代码里那两段原文，变量保持 `{{}}` 原样，外加固定示例数据的渲染预览——这里改不生效）。改了看不出差别，按下面顺序对号；契约见 `docs/architecture.md` §45。

| 看到什么 | 怎么读 | 怎么办 |
| --- | --- | --- |
| 改的是 `fallback`，频道里一点变化都没有 | 顺序是三层提示词（channel > guild > global）→ 三层内置默认（channel > guild > global）→ 代码常量：前三层**只要有一层配了提示词段落**，`fallback` 就根本不会被选中 | 在「提示词」页看各 tab 的「已配置」状态，改命中的那一层或把它删掉；只想改兜底，就先确认这个频道 / 服务器 / 全局三层都没有提示词段落 |
| 三层提示词确实都空、`fallback` 也在全局层保存过，输出还是旧文案 | 兜底自己也分三层：频道层 / 服务器层没配就往下找，全局层也没有那一行才落到代码常量 `DEFAULT_PROMPT` | 看当前 tab 是不是你保存的那一层（未配置的层在 `GET` 里根本没有对应行）；「恢复默认」只删当前这一层，删完得到的是「往下层回落」，不一定回到代码常量 |
| 全局层删掉以后，某个频道还是老样子 | 设计内：那个频道层或服务器层自己配过，删全局层不影响它们 | 逐层检查 tab 状态，只删真正命中的那一层 |
| `identity` 改了，身份块的行数不对 | 逐行渲染：某行引用的变量为空就整行丢弃、渲染后空白行也丢、全丢光则整块不出现；私聊没有服务器名与频道名，「这里：」那一行本来就不该有 | 按 `docs/architecture.md` §45.4 的变量表改；要「和上一版一样」就把三层 `identity` 都清掉——没配时走 `formatIdentityBlock`、输出逐字不变 |
| `identity` 三层都清掉之后身份块又变回老样子 | 设计内：三层都没配就不渲染模板，直接由 `formatIdentityBlock` 拼那句【当前对话】 | 想保留自定义就在对应那一层重新存一份 |
| 保存直接报错，模板存不进去 | 400 `BAD_PROMPT_KEY`（key 不是 `fallback` / `identity`）、400 `BAD_SCOPE` / `BAD_REQUEST`（scope 不对，或频道 / 服务器层没填 ID）、400 `BAD_PROMPT_CONTENT`（非字符串、空、超 20000 字）、400 `UNKNOWN_TEMPLATE_VAR`（占位符不在这个 key 的变量表里，响应带 `vars`） | 照 `vars` 改占位符；`fallback` 只有 5 个变量、`identity` 有 6 个（§45.4、§45.5）。预览里的警示色只点名、不挡编辑 |

- 升级后行为不变：三层都没配时 system 与身份块与上一版逐字相同（有测试断言）；从 `0020` 升上来的老库，旧行被搬成 `('global', '')`，即「全局层配了这一份」，升级前生效的那一份升级后照样生效。
- 迁移没跑上、表不存在：读库失败按「没配」继续——`fallback` 回代码常量、`identity` 回 `formatIdentityBlock` 那句，回复本身照常，不会因此报错；看启动日志里的 `迁移检查完成 applied=25 skipped=0`（`docs/hosting.md` 有这行日志示例），缺 `0025` 就把迁移跑上。
- 门牌：§25.13 这一版是 `prompt-scope-1`；当前要 `preset-head-1` 或更新（§25.4、§13；TTS 走 `tts-admin-1` 起的后台「语音」页、`tts-mimo-1` 起多一种方言、`tts-style-1` 起带朗读语气三层与可选情绪判断模型、`tts-tags-1` 起把语气改成 assistant 正文开头的标签 + 正文逐字校验、`tts-nolimit-1` 起不再限制朗读字数、`director-1` 起念之前先过导演模式；`director-2` 起后台试听能带档位、响应带 `directorRejected`、
`director-3` 起判断超时按字数给预算（15 秒起步 + 每字 40 毫秒、封顶 45 秒）并多一种 `judge` 退回原因、`director-4` 起成功日志在 `rejected=` 之后多一个可选的 `judge=` 段、试听响应多 `judgeLine` 且页面多一行「判断模型写的是：…」（§47.8、§25.16），§25.14 与 §25.15）——旧门牌上没有这些路由，后台也看不到那张分层卡片与只读区。

### 25.14 语音没声音怎么查（`tts-admin-1` 起；`tts-mimo-1` 加接口类型；`tts-style-1` 加朗读语气与情绪判断模型；`tts-tags-1` 改标签 + 逐字校验；`tts-nolimit-1` 起不设字数上限；`voice-log-1` 起补一条成功日志；`director-1` 起导演模式；`director-2` 补试听档位与拒绝原因；`director-3` 改判断超时预算 + 多一种 `judge`；`director-4` 把 judge 那一行带进日志与试听；`director-5` 把导演档的提示词改成正文逐句语气标签、唱歌只在整体风格组标一次 `(唱歌)`；前一版 `director-6` 只把诊断用的 judge 行从截断改成完整一行（日志 `judge=` 段与试听 `judgeLine` 都不再截断，念法与迁移都没动））

`tts-admin-1` 起 TTS 的地址 / Key / 默认音色**只从后台「语音」页读**（`tts-style-1` 起模型也不再是字段：库里 `model` 列只留历史值、合成侧不读，按接口类型取内置默认，后台没有这个输入框）（四个 `VOICE_TTS_*` 环境变量完全不生效），每条消息现读一次、改完下一条消息就生效，进程里不缓存明文。回复、表情、摘要这些照常、只是没有声音时，按下面这个顺序对号；契约见 `docs/architecture.md` §46。`tts-mimo-1` 起同一份配置还能选两种上游方言（接口类型 `openai` / `mimo`，§46.7），所以第 5、6 条专门看方言。同一页自 `tts-style-1` 起还有「朗读语气」与「情绪判断模型」（`tts-tags-1` 起标签写在正文最前面、judge 抄回的正文要过逐字校验；`tts-nolimit-1` 起朗读字数不再设上限，`voice-log-1` 起语音发出后补一条 `[voice] 已发送 …` 成功日志（读法见本节表格头两行）），**有声音但没有语气**不走这一节、按 §25.15 对号（契约见 `docs/architecture.md` §47）。

1. **先看「语音」页的状态条**：显示「已配置（掩码）」才说明库里有一行、地址与 Key 都非空；显示「未配置：语音回复不会发出声音」就是这三者缺一（没有行 / `url` 空 / `key` 空）。状态条下面若多一行「服务器还留着 `VOICE_TTS_*` 环境变量，这一版只认后台配置，可以删掉」，那只是提示——这些变量不参与取值。
2. **再点「试听」**：它把表单里已填的字段发过去（Key 留空用已存的），**不落库**。听得到声音就说明地址 / Key / 音色这条链路是通的（模型这一项已经没有了：`tts-style-1` 起模型由接口类型唯一决定），问题在 mode、频道或语气（往下看第 5 条与 §25.15）；听不到就看第 3、4 条的错误码。成功时卡片上会显示「{bytes} 字节 / {durationMs} ms」——字节数为 0 不正常，耗时接近 30 秒就是上游超时；`director-4` 起，被导演模式退回时卡片上还会多一行「判断模型写的是：…」（判据见 §25.16）。
3. **400 `TTS_NOT_CONFIGURED`**：地址或 Key 没配（试听时也没有可用的已存值）。去「语音」页补上，首次必须给 Key；只改了别的字段、Key 留空又没有已存值，同样是这个码。
4. **502 `TTS_UPSTREAM`**：上游报错或超时（30 秒）。先换地址试、再换 Key 试，都不行就是上游当时不可用，稍后再试；响应里的 `durationMs` 能看出是立刻失败还是等到超时。
5. **接口类型是不是选错了**：`openai` 方言走 `POST {url}/audio/speech`、`mimo` 方言走 `POST {url}/chat/completions`，选错就是把一种形状的请求发到另一家上游——典型现象是 502 `TTS_UPSTREAM`（上游回 404 / 鉴权失败 / 解析不出 JSON），试听同样会失败。先看地址像谁家：`https://api.openai.com/v1` 这类是 OpenAI 兼容，`https://api.xiaomimimo.com/v1` 是小米 MiMo，切回正确的那一档、重填该家的 Key 与模型再试听。模型这一项不用再管：`tts-style-1` 起模型由接口类型唯一决定（`openai` → `tts-1`、`mimo` → `mimo-v2.5-tts`），后台没有输入框、库里那一列只留历史值，换方言不必跟着改模型（§47.1）；另外 MiMo 没有 `speed` 参数，语速在这一档不生效（不是故障）。
6. **400 `BAD_TTS_DIALECT`**：请求里的接口类型不是合法值（只有 `openai` / `mimo`）。一般是后台页面传了别的字符串、或老缓存的表单；刷新语音页重选一档再保存。库里不会写进不认识的方言——写侧先挡成 400，读侧还会把非 `mimo` 的值当 `openai`（§46.7）。
7. **语音回复的三档 `mode` 是不是 0**：命中的第一层是 0（或三层都没配）就不发语音。在「语音」页的「语音回复」卡片里选层级，把三档选到 1 或 2 再保存（取值细节见 §25.12）。
8. **这一层是不是配了 `mode = 0`**：顺序是**频道 > 服务器 > 全局**，服务器层配了 0 会盖住全局层的 2；逐层看「已配置 / 未配置」，只改真正命中的那一层。
9. **最后看日志里有没有 `读取语音合成配置失败，本轮不发语音`**：有这一行表示这一轮**读库失败**（不是没配）——语音是附加项，读不到就按未配置继续、绝不因此让这一轮回复失败。按这行后面的错误原文查 D1 与迁移：启动日志应是 `迁移检查完成 applied=25 skipped=0`，缺 `0025` 就把迁移跑上（`docs/hosting.md`）。
10. **保存直接报错**：400 `BAD_TTS_URL`（地址不是 http/https 或超 500 字）、400 `BAD_TTS_KEY`（Key 空或超 500 字）、400 `BAD_TTS_DIALECT`（接口类型不是 `openai` / `mimo`）、400 `BAD_TTS_JUDGE`（情绪判断模型的地址不是 http(s) 或超长：地址 ≤500、Key ≤500、模型 ≤100）、400 `BAD_REQUEST`（音色超 100 字）。按响应里的 `message` 改；试听失败也会按这几类给中文原因。保存「朗读语气」是另一组码：400 `BAD_TTS_STYLE`（非字符串或超 2000 字）、400 `BAD_SCOPE` / `BAD_REQUEST`（层级不对、频道 / 服务器层没填 ID），见 §25.15。

**顺带：想直接看 judge 到底怎么写的**（`director-4` 起）——真实语音那条成功日志行尾会多一个 `judge=` 段，放的就是 judge 那一行的完整一行、不截断（`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，回调抛错不影响念法）；有它就能把模型写的与原文摆在一起看，`director=1` 退回时也不必只凭 `rejected=verbatim` 猜。`rejected=judge` 而**没有**这一段，说明判断模型这次没答上来（没配、超时、非 2xx、坏 JSON、抛错），不是日志漏记。试听卡片上那行「判断模型写的是：…」与它是同一个值（响应字段 `judgeLine`，`src/workers/http/app.ts:1468`、`:1516`），同样只在退回时出现。

### 25.15 语音有声音但没有语气（`tts-style-1` 起；`tts-tags-1` 起改成标签 + 逐字校验；`tts-nolimit-1` 起不设字数上限）

`tts-style-1` 起朗读语气是**可选件**：三层（频道 / 服务器 / 全局）都没存提示词，听感就与上一版逐字相同——只有字、没有腔调。`tts-tags-1` 起产出形状变了：不再把一行自然语言指令当 `role:user` 消息发出去，而是把**标签贴在 assistant 正文最前面**（`(怅然)正文`），judge 抄回的正文还要过一遍**逐字校验**，对不上就只保留标签、正文用原文。`tts-nolimit-1` 起字数也不再设上限（`toSpeechText` 只清理、试听只 `trim`，`JUDGE_MAX_TOKENS` 从 1200 提到 4000），所以「正文很长」本身不再是被截断的理由——别把上游的合成失败误当成被截断。所以「有声音、没语气」按这条链对号，契约见 `docs/architecture.md` §47 与 §47.7。

1. **先看标签写法**：标签必须在 assistant 消息 content 的**最前面**，形如 `(怅然)今天的风有点凉。`；括号支持半角 `()`、全角 `（）`、方括号 `[]`、黑框 `【】`，多风格写在同一括号里、分隔符不限（`(怅然/低语)`）。写成「正文…（怅然）」或「怅然：正文」都不算标签——`applyJudgeLine`（`src/core/voice/style.ts:249`）只认行首括号；整行不超过 20 字且没有 `。！？；` 时才会把整行当标签。后台「朗读语气」卡片上那四个示例 chips（`web/src/pages/VoicePage.tsx:791-804`）就是可用的形状。
2. **再看 `GET /api/tts-settings` 里的 `judgeConfigured`**：为 `false` 说明情绪判断模型没配齐（`judgeUrl` / `judgeModel` / 库里那把密钥三者缺一），这时标签退回**提示词本身**（`normalizeStyleTag` 把提示词压成一层括号），提示词写得泛（例如只写「自然一点」），听感上等于没语气。要按这条回复的情绪调腔调，先配齐三项再试听（`judgeKey` 只从库里取，试听接口不接受临时密钥）。
3. **再看 `GET /api/tts-style` 有没有配置层**：`items` 为空 = 三层都没存，等于没配语气；有行就看 `scope` / `scopeId` 是不是你改的那一层——真发语音时按 **channel → guild → global** 取第一个 `trim()` 非空的层（`docs/architecture.md` §47.3）。
4. **记住试听只认 global 层，而且响应能自证**：`POST /api/tts-settings/test` 不带 `style` 时只拿 **global 层**提示词 + 库里的 judge 走一次 `composeVoiceSpeech`，频道层与服务器层**不参与**（§47.4）。响应里 `styleUsed` 是最终用的标签（带括号，或 `null`）、`speechUsed` 是**最终念的正文**；`styleUsed` 为 `null` 就是「这一次没有标签」，不是「生成了没显示」。所以「在频道层存了语气、点试听却没变化」是设计内——要验证频道层只能在这个频道真发一条语音。带 `style` 试听时它按标签归一化、正文一个字不动（`speechUsed` = 你传的 `text`）。
5. **念出来把 `[轻笑]` 也念了，或正文像被改过**：先看响应里的 `speechUsed`——它才是实际发出去的正文，正常情况下与原文逐字相同（`applyJudgeLine` 只在校验通过时采用 judge 抄回的正文，`composeVoiceSpeech` 最后还有一道 `stripVoiceTags` 保险）。逐字校验不过时**标签保留、正文退回原文**（judge 加的 `[音频标签]` 与它给的逐句念法就一起没生效，听感是「语气对了、细节没了」）——这一版起朗读正文不设字数上限（`toSpeechText` 只清理、试听只 `trim`），所以 `speechUsed` 短不等于被截断；judge 的输出上限是 `JUDGE_MAX_TOKENS = 4000`（`src/core/voice/style.ts:46`），前一版 1200 在长回复上抄不全，抄不全只会退回原文、不会改字。`[音频标签]`（`[轻笑]`、`[叹气]`、`[语速加快]`、`[沉默片刻]`）只影响念法；被逐字念出来时，检查它是不是写在了风格标签的位置（风格标签只能是正文最前面的一对括号）。
6. **最后看运行时日志里 `voice-reply` 的 warn**：取提示词失败、judge 超时（`judgeTimeoutMs` 的预算用尽：15 秒 + 每字 40 毫秒、封顶 45 秒，前一版是固定 `JUDGE_TIMEOUT_MS = 8000`；`src/core/voice/style.ts:33-40`）、judge 非 2xx、judge 回了一段不能用的文本，这几类都只 `console.warn` 并回退，**语音照发、只是没有标签**（`src/workers/discord/voice-reply.ts:50-55` 与 `:58-73`；判定顺序见 `:36-44`，超时/失败绝不会拦住发送）。日志里没有这条 warn、声音也正常，那基本是「标签没写在行首」或「改的是没命中的那一层」。
7. **保存语气直接报错**：400 `BAD_TTS_STYLE`（`content` 非字符串或超 2000 字）、400 `BAD_SCOPE`（`scope` 不是 `channel` / `guild` / `global`）、400 `BAD_REQUEST`（频道层 / 服务器层没填 `scopeId`）。保存 `trim()` 后为空**不是错误**：它删掉这一层并回 `{ ok: true, removed: true }`——想「恢复默认」就这么做（与 §25.13 那条「恢复默认只删当前那一层」同口径）。

---

### 25.16 导演模式怎么查（`director-1` 起；`director-2` 补试听档位、拒绝原因与日志段；`director-3` 把判断超时改成按字数给预算、多一种 `judge` 退回原因；`director-4` 把 judge 那一行带进日志与试听；`director-5` 把导演档的提示词改成正文逐句语气标签、唱歌只在整体风格组标一次 `(唱歌)`；前一版 `director-6` 只把诊断用的 judge 行从截断改成完整一行（日志 `judge=` 段与试听 `judgeLine` 都不再截断，念法与迁移都没动））

导演模式不改 Discord 上显示的文字，只改送进合成的那段文本：judge 先按 mimo 导演模式把要念的话改写一遍，放行时语音文本就是 judge 那一整行、`tag` 置空（风格组已经长在正文开头，再当标签拼前缀会念两遍）；三档 `director` 存在 `voice_settings.director`（`0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写），频道 / 服务器 / 全局三层各存一行，后台「语音」页「语音回复」卡片的下拉保存时随 `mode` / `voice` / `speed` 整行 `PUT`，没有 `PATCH`。

这一节讲的念法全是 `'director-1'` 定的；`'director-2'` 只补可观测性——试听可以带档位、响应多 `director` 与 `directorRejected`、成功日志在退回时多一个 `rejected=` 段；`'director-3'` 只改判断超时的给法、多一种退回原因 `judge`；`'director-4'` 只把 judge 那一行带进日志与试听——成功日志多一个可选的 `judge=` 段、试听响应多 `judgeLine`、页面多一行「判断模型写的是：…」；`'director-5'` 只改导演档（`1` / `2` 档）的提示词规则——正文每一句前面都要加一个写语气或说话方式的括号标签，唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在那一处标一次、不再给每句歌词加标签，`0` 档 `JUDGE_SYSTEM`、两条护栏、接口、日志与 UI 一个字没动；前一版 `'director-6'` 只把诊断用的 judge 行从截断改成完整一行——成功日志 `judge=` 段与试听响应 `judgeLine` 都是判断模型回的完整一行、不截断（原先会截掉超长部分），念法、提示词、接口与迁移一个字没动。六版的念法与 `'director-1'` 逐字相同。

判断超时现在按字数给预算：`JUDGE_TIMEOUT_FLOOR_MS`（`src/core/voice/style.ts:33`，15 秒）起步 + 每字 `JUDGE_TIMEOUT_PER_CHAR_MS`（`:34`，40 毫秒），封顶 `JUDGE_TIMEOUT_CAP_MS`（`:35`，45 秒），算法在 `judgeTimeoutMs(chars)`（`:38-40`）、调用点是 `:423` 的 `AbortSignal.timeout(judgeTimeoutMs(charCount(original)))`。**前一版是固定 8 秒**（`JUDGE_TIMEOUT_MS = 8000`，本版已删掉这个常量）：148 字那条真实回复 judge 要 8.1 秒才回，被 8 秒整条掐断，导演模式于是退回原文——`director=1` 在真机上看着和 `0` 档一样，`directorRejected` 还是 `null`，日志里看不出是被超时掐的。这条正是本版要修的。

判据按顺序看：

1. `[gateway] alarm build=reply-tool-3`（或 `[node] listening … build=reply-tool-3`）——旧实例还在跑旧代码时先等换码（§25.4、§13）。
2. 后台「语音」页那张卡片的下拉是不是 `0`：`0` 档行为与上一版逐字相同，judge 只给一行标签、正文一个字都不许改；「没生效」先确认不是停在 `0`。前一版 `director-6` 只把诊断用的 judge 行从截断改成完整一行——成功日志 `judge=` 段与试听 `judgeLine` 都是判断模型回的完整一行、不截断，念法、提示词、接口、日志别的部分与迁移都没动，所以「听感没变化」是设计内，不是没升级。
3. 启动日志 `迁移检查完成 applied=25 skipped=0`，缺 `0025_director_mode.sql` 就把迁移跑上；`PUT /api/voice-settings` 的 `director` 缺省按 `0` 处理，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`（读侧脏值也落回 `0`）；`GET /api/voice-settings` 快照里的 `directorModes: [0, 1, 2]` 就是下拉的三个选项。
4. 成功日志 `[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…[ rejected=…]`：`director` 就是这条用的档位；`tag=无` + `director=1`/`2` 通常说明风格组已经长在正文开头（tag 置空是设计）；`tag` 有值说明这一条退回了原文（`1` 档括号段删掉后与原文对不上、`2` 档字数越界或残留 `[[voice]]` 之类指令都会退回）；`director-4` 起行尾还可能多一个 `judge=` 段，见下一条。
5. 末尾有 `rejected=` 就读成「导演模式试过、但被护栏退回了，念的是原文」，后面跟的是原因：`empty` 判断模型只回了一个风格组、没有正文；`verbatim` `1` 档候选去掉标签后与原文不逐字相同；`residue` `2` 档候选里还留着 `[[...]]` 指令残留；`ratio` `2` 档候选去掉标签后字数不在原文 `0.3` 到 `3` 倍之间（原文不足 20 字时上限放宽为原文 + 200 字）；`judge` 判断模型压根没给出可用的一行（没配 judge、超时、非 2xx、JSON 坏、抛异常）——**看到 `rejected=judge` 是判断模型没答上来，不是护栏拦的**。**没有这一段**说明导演模式放行（或压根没走：`0` 档、没配 judge），放行时念的是 judge 改写后的那一份。
6. 行尾的 `judge=`（`director-4` 起）：`judge=` 后面就是 judge 那一行的完整一行、不截断（`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，回调抛错不影响念法），有它就说明判断模型确实答上来了——`rejected=` 与 `judge=` 同时出现时，把这一段与原文对一遍就能分清是「写歪了」（内容对不上）还是「字数越界」（`ratio`）；`rejected=judge` 而**没有** `judge=` 段，说明判断模型压根没答上来（没配、超时、非 2xx、坏 JSON、抛异常）。后台「语音」页试听结果里那行「判断模型写的是：…」是同一份内容：响应字段 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、`:1493`、`:1516`；前端 `web/src/api.ts:2183`、`:2368-2369`），只在 `directorRejected` 不为 `null` 时显示（`web/src/pages/VoicePage.tsx:403-404`）。

三条限制照实说：

- `2` 档念出来的话与屏幕上写的会不一致——judge 会口语化改写，这是设计，不是串台。
- 标签（`(怅然)` 之类）是否被 mimo 真正演绎，无法从服务端证实：接口只回音频字节，日志只能证明标签进了合成请求。
- `mimo` 合成自己还有一条 30 秒超时（本版没动）：实测 700 字以上的文本经常直接回 `502 {code:'TTS_UPSTREAM'}`——那是合成侧的超时，与本版改的判断超时无关，长文照样会失败，这一版不解决。

后台「试听」（`POST /api/tts-settings/test`）默认按 `0` 档，body 里带可选 `director` 才走导演提示词；非法档位回 `400 BAD_DIRECTOR_MODE`（这道校验排在「TTS 未配置」检查之后）。响应在 `speechUsed`、`styleUsed` 之后多两个字段：`director` 回显这次用的档位，`directorRejected` 是 `null` 或 `empty` / `verbatim` / `residue` / `ratio` / `judge` 五种之一（读法见上面判据 5）；请求仍可选 `director`、缺省 `0`、非法值回 `400 BAD_DIRECTOR_MODE`，契约不变；放行或被退回到原文时 `speechUsed` 就是真正送进合成的那一份。这张试听卡片自己也有一个「导演模式（仅这次试听）」下拉（缺省 `0`，选项取快照的 `directorModes`）：选 `1` / `2` 时结果区多一行「导演模式：…」，放行写「（这次放行了改写）」、退回写「（退回原文：<中文原因>）」，不用翻库或看日志；它只影响这一次试听，不改任何一层存的档位。契约见 `docs/architecture.md` §47.8、日志形状见 §44.3，门牌见 §25.4。

## 26. 自托管（Ubuntu + Node）

§30 起同一份代码多了第二个宿主：一台 Ubuntu 上的 Node 进程（`dist/server.mjs`）。Cloudflare 那套**一行没动**，
仍是生产与回退路径；这一节只说"要换到自托管时，运维要知道什么"，**逐条命令在 `docs/hosting.md`**，不在这里重复。

### 26.1 一句话版本

```bash
# 服务器上（Ubuntu 26.04 + Docker），细节见 hosting.md §1–§6
mkdir -p data && sudo chown -R 1000:1000 data     # 容器里是 uid 1000，否则 SQLite CANTOPEN
cp .env.example .env                              # 六个 secret；KEY_ENCRYPTION_SECRET 必须与线上逐字节一致
docker compose up -d --build
docker compose exec bot node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(t=>console.log(t))"
```

### 26.2 与 Cloudflare 的四处差异（容易踩的）

| 项 | Cloudflare | 自托管 Node | 落点 |
| --- | --- | --- | --- |
| 数据库 | D1（`wrangler d1 …`） | 一个 SQLite 文件 `/data/dc-ai-bot.sqlite3`，迁移账本是 `_migrations` 表 | hosting.md §8 |
| 迁移目录 | `wrangler.toml` 的 `migrations_dir` | 迁移 SQL 打进镜像（`/app/migrations`），无需挂载；改了迁移要重建镜像 | hosting.md §5 |
| 后台任务 | `ctx.waitUntil`，随请求存活 | `TaskTracker`，随进程存活；停机时 `drain()` 等它们在飞的任务 | architecture §30.5 |
| 网关状态 | DO `storage`（跨 alarm、可 RESUME） | 进程内存，重启即全新 IDENTIFY（不落盘任何网关状态） | architecture §30.4 |

### 26.3 换过去/换回来的顺序（只有一个正确答案）

- **换过去**：先在 Cloudflare 侧 `wrangler d1 export … --remote --no-schema` 导出 → 服务器上让迁移先建表 →
  **停 bot** → `node scripts/import-sql.mjs` 导入 → 再起 → 最后才 `wrangler delete` 并把 Discord 的
  Interactions Endpoint URL 改成 `https://example.com/interactions`。
- **同一 bot token 不能双开**：不停旧的就起新的，两条 Gateway 长连接会互相踢，而且写入分裂成 D1 与 SQLite 两份库。
- **换回来**：`npx wrangler deploy` + 把 Interactions URL 改回 Worker 地址 + `docker compose down`；
  自托管期间的新数据不会自动回到 D1（要带走就反向导出，hosting.md §10.4）。

### 26.4 排错先看哪里

- `[node] 迁移失败（目录 migrations 必须在工作目录下）` → 跑的是没有 `migrations/` 的旧镜像，重建即可：`git pull && docker compose up -d --build`（hosting.md §5）。
- `SQLITE_CANTOPEN` → `data/` 属主不是 1000（hosting.md §4）。
- 后台 Key 全部解不开 → `KEY_ENCRYPTION_SECRET` 与线上不一致（hosting.md §3 的警告框）。
- 门牌对不上：Node 宿主打 `[node] listening on :8787 … build=summary-order-2` 与 `[gateway] alarm build=summary-order-2`；
  两者都没有就是容器没起或跑的是旧镜像。完整的现象-原因对照表在 hosting.md §11。

---

## 27. 多段提示词（2026-10-28，`prompt-bounds-1`；现在门牌 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（139704§54）；上一次构建 `reply-tool-2`（行为与现版相同，只是验收时临时在成功日志尾部多带 `rawLen=` / `rawShell=` 两个诊断字段，`len=472 … rawLen=505 rawShell=<game>:1,</game>:1` 就是它留下的证据；现已下线）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `director-6`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `director-5`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio>]`；方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=…`，只记标签 / 字节数 / 字数与 mode，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（`docs/architecture.md` §47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（`docs/architecture.md` §47）；`'tts-mimo-1'` 那一版记的是§25.14、§46.7；上一版 `tts-admin-1` 见 §25.14、§46；再上一版 `prompt-scope-1` 见 §25.13、§45，见 §22.7、§25.8、§25.9 与 `docs/architecture.md` §29.7、§35、§40）

后台「提示词」页不再是「一段正文 + 一段人格」，而是**一层一组段**：每段有名字、角色（system / user）、正文、开关和位置，顺序由你在页面上排。契约在 architecture §32，这一节只说怎么用、什么时候生效、出错怎么看。

### 27.1 怎么配

1. 后台「提示词」页选层级（global / guild / channel）并填 `scopeId`（guild / channel 层必须填，global 恒为 `''`），点「读取」。
2. 旧库升级后每层自带两条段：`基本设定`（原「系统提示词」）与 `人格`（原 `persona`，**原来为空的行没有这条**），见 §27.4。
3. 「新增段」加一行：**名字**必填（trim 后不能为空，只是给人看的标签）、**角色**、**正文**、**位置**、**开关**。
4. **排序**＝页面上的行顺序：保存时按下标写 `position`（0..n-1），页面上谁在前，注入就谁在前。
5. **开关**：关掉的段留在库里、不进 prompt——想临时停一段别删，关掉就行；想恢复再打开。
6. 「保存」是一次 `PUT /api/prompts`，**整组替换**（不是增量）：页面上有什么就存什么，删掉的行保存后就真没了。
7. 斜杠命令 `/persona` 改的是 channel 层的同一批数据（选项还是 `view` / `persona` / `system`），不另存一份。

### 27.2 角色：system 与 user

| 角色 | 落到哪 | 效果 |
| --- | --- | --- |
| `system` | 拼进 system 提示词 | 当「设定」读：规则、世界观、说话风格 |
| `user` | 变成 `messages` 里的一批 user 消息，**排在历史之前** | 当「说过的话」读：酒馆式先铺几条设定对话，再接真实聊天 |

角色是**每段自己选**的：同一层既有 system 段、也有 user 段完全正常。`user` 段不占 system 的位置，它排在历史之前、本轮这句话之前。

### 27.3 位置：before / after 怎么理解

`placement` 只管 `role=system` 的段：`before` 段贴在整个 `system` 的最前面（天头），`after` 段贴在最后（收尾）——`identity-head-1` 那版它决定的是「贴在身份块与记忆块之间那一段区间的哪一边」，`preset-head-1` 起两边各归一头（§52.2）；`identity-off-1` 起有 `before` 段时身份块整块不出现，天头直接就是第一段预设（§53.3）：

| placement | 落在哪 | 什么时候用 |
| --- | --- | --- |
| `before`（默认，回填出来的段都是它） | `system` 的最前面（天头），身份块之前（`identity-off-1` 起有 `before` 段时身份块不出现，天头就是第一段预设，§53.3；`identity-head-1` 那版在身份块与表情块之后、长期记忆之前；`preset-4` 及以前在 `system` 最前） | 基本设定、世界观、称呼规则：模型最先看到，像「总纲」 |
| `after` | 世界书与表情块**之后**，`system` 的最后一块（`identity-head-1` 那版在记忆/摘要块之后；`preset-4` 及以前在表情规则之前） | 输出格式、本轮补充要求：贴着对话更近，不容易被长记忆淹掉 |

- 两组各自按 `position` 升序排，`before` 组整体在 `after` 组之前。
- 完整顺序（`identity-off-1` 起）：① `before` 段（天头）→ ② 身份块（**只在没有任何前置预设段时出现**，有 `before` 段时这一步是空的）→ ③ 提及规则 → ④ 表情规则 / 语音提示 / 自定义表情清单 / 可贴表情目标 → ⑤ 世界书 → ⑥ `after` 段（收尾）；长期记忆摘要不在 `system` 里，拼在本轮那条 user 消息最前面（`docs/architecture.md` §53.3、§52.2）。
- `role=user` 的段**不看** `placement`：它们只按 `position` 排在历史之前。
- 变量照旧渲染：`{{bot_name}}` / `{{user_name}}` / `{{guild_name}}` / `{{channel_name}}` / `{{date}}`。渲染后是空的段整段跳过（不产生空消息）。

### 27.4 迁移与回填（先迁移，再部署）

`migrations/0013_prompt_segments.sql`：

| 动作 | 内容 |
| --- | --- |
| 建表 | `prompt_segments`（`id` / `scope` / `scope_id` / `position` / `name` / `role` / `content` / `enabled` / `placement` / `updated_at`，主键 `(scope, scope_id, id)`）+ 索引 `idx_prompt_segments_scope` |
| 回填 `system_prompt` | 段 `legacy-main`，名称「基本设定」，`position 0`，system / before / 启用 |
| 回填 `persona`（非空才建） | 段 `legacy-persona`，名称「人格」，`position 1`，system / before / 启用 |
| 收尾 | `ALTER TABLE prompts DROP COLUMN persona` / `DROP COLUMN system_prompt`；`prompts` 行只剩 `temperature` / `max_tokens` / `updated_at` |

- 顺序不能反：**先跑迁移再部署新代码**，否则新代码读不到 `prompt_segments`。
- 自托管要重建镜像：迁移只在构建时进镜像（§26.2）。
- 回填后行为与升级前等价（同序、同内容，只多出段与块之间的空行），详见 architecture §32.6。

### 27.5 清空要用删除，不是存空

- 想清空某一层：点「删除」（`DELETE /api/prompts`，body `{scope, scopeId}`）。
- **存空数组不是清空**：`segments: []` 会被 400 `BAD_PROMPT_SEGMENTS` 拒掉，一个段都不会落库。「这层不要提示词」只有删除这一条路，所以页面上误删所有行再保存不会静默清空。

### 27.6 作用域：还是整组覆盖

- 命中顺序没变：channel > guild > global，**整组覆盖**——命中哪层就只用那层的**全部**段。
- **不跨层拼接**：channel 层只要配了段，guild / global 的段一条都不进来（哪怕 channel 层只放了一段）。
- 三层都没有段 → 回落到内置默认提示词（architecture §8），与旧版「三层全空」一致。
- `temperature` / `maxTokens` 跟着同一层走，不跨层取。

### 27.7 失败与观测

| 现象 | 原因 / 处理 |
| --- | --- |
| 保存 400 `BAD_PROMPT_SEGMENTS` | 段名 trim 后为空 / `role` 或 `placement` 非法 / `enabled` 不是布尔 / `content` 不是字符串 / `id` 重复 / `segments` 为空数组（§27.5） |
| 保存 400 `BAD_SCOPE` | `scope` 不在 `global` / `guild` / `channel` 里 |
| 保存 400 `BAD_REQUEST` | guild / channel 层的 `scopeId` 没填（或填的不是字符串）；`temperature` 不在 `0..2`、`maxTokens` 不是 `1..100000` 的整数（§27.9）；后台对这类码只显示通用错误提示，不会有专门文案 |
| 保存 400 `UNKNOWN_TEMPLATE_VAR` | 正文里写了不认识的 `{{…}}`：只认 5 个变量（§27.3），返回的 `vars` 就是出错的几个。**只看启用的段**，停用段里写错变量不会挡保存（§27.9） |
| 改了提示词，@ 路径没反应 | 看门牌：`[gateway] alarm build=summary-order-2` 出现才说明 DO 换到这一版（§13）；斜杠命令路径部署即生效 |
| 段写了却没进 prompt | ① 这层 `enabled` 关了；② 渲染后是空的（整段跳过）；③ 你改的不是命中层（§27.6）；④ `role=user` 的段不进 system，去 `messages` 里找 |

### 27.8 已知边界

- 段只影响发给模型的那份 `messages`：不写进历史、不进摘要、不改落库正文。
- 段是**整组替换**：页面上保存时少一行就是少一段，没有「只改这一段」的接口。
- `UNKNOWN_TEMPLATE_VAR` 只拦「不认识的变量名」，不拦「变量没问题但放在不妥的位置」——那只能靠看回复。
- 空段整段跳过，不产生空 user 消息。
- 段 id 只在同一层内唯一，不同层可以有同名段；改名不动 id，排序也不会改 id。

### 27.9 本版补的两道校验（`prompt-bounds-1`）

- **`temperature` 只收 `0..2`，`maxTokens` 只收 `1..100000` 的整数**：越界回 400 `BAD_REQUEST`。这两个值原样进模型请求，存一个 `-1` 或 `1.5` 会让那一层的**每一轮**调用都失败，而报错在运行时看不见来源，所以拦在保存这一步。`/api/routes` 用的是同一把尺。
- **停用的段不参与未知变量检查**：停用的段既不进 system 也不进 messages，写错 `{{var}}` 不该挡保存；启用的段照旧拦。
- 范围常量在 `src/workers/http/app.ts:71-72`（`TEMPERATURE_BOUNDS` / `MAX_TOKENS_BOUNDS`），改范围只改这两处；architecture §32.8 是同一件事的完整口径。

---

## 28. 贴表情提示词（2026-10-28，门牌 `reaction-guide-1`）

**一句话**：「教模型怎么贴表情」的那段话不再是代码里的固定句子——后台「表情」页可以按 global / guild / channel 三层自己写，主模型与兜底表情模型共用这一份。同一条门牌上还改了行为：**没点名的表情不再自动分给别人**，要让 bot 给大家贴，得让它自己写 `[[react:😄@all]]`。

### 28.1 怎么改

1. 顶栏进「表情」页，往下滚到「贴表情提示词」一节（同一页面上半部分是表情模型的三态配置，见 §18）。
2. 选层级：`global`（全局）/ `guild`（服务器）/ `channel`（频道）；选 `guild` / `channel` 时填服务器 ID / 频道 ID，点「读取」。
3. 改正文，点「保存」。保存是**整段替换**这一层的文案，不是增量补丁。
4. 输入框里的 placeholder 就是内置默认文案；想改回默认就删掉这一层（§28.4）。

### 28.2 三层怎么回落

| 顺序 | 命中 | 没配时 |
| --- | --- | --- |
| 1 | `channel`：`scope=channel` + 这一层填的频道 ID | 往下看 `guild` |
| 2 | `guild`：`scope=guild` + 这一层填的服务器 ID | 往下看 `global` |
| 3 | `global`：`scope=global`（不带 ID） | 往下看内置默认 |
| 4 | 内置默认 `DEFAULT_REACTION_GUIDE`（`src/core/chat/reaction-guide.ts`） | — |

- **整组覆盖，不拼**：命中哪层就整份用哪层（和提示词段 §27 同一套惯例），不存在「guild 写两句 + channel 写三句」拼起来这回事。
- **留空 / 删行 = 这一层没有**：留空不是「用空文案」，是「这层不存在」，于是落回上一层（§28.4）。
- 系统只认模型的输出，不解析文案里的示例——文案里写 `[[react:😄@all]]` 只是教它，真正生效的是它自己写出来的那一行。

### 28.3 `@all` 怎么用

要让 bot 给「最近发过言的人」各贴一条，在回复里写：

```
[[react:😄@all]]
```

- 六个同义词随便挑：`all` / `everyone` / `大家` / `所有人` / `全员` / `*`（大小写不敏感、前后空格无影响），例如 `[[react:🎉@所有人]]`。
- 展开成「当轮清单里最近发过言的人各一条」，跳过 bot 自己的消息；一个人都没有时退回贴触发那条。
- 上限仍是 10（`MAX_REACTIONS`），去重规则照旧（§24）。
- **不写 `@all` 就不分散**：写了 `@消息ID` / `@作者名` 就只贴那一条，什么都没写就只贴触发那条（旧版「自动分给下一个人」已取消）。

### 28.4 留空 = 删这一层

- 页面把正文清空再保存，等于删掉这一层（后台调的是 DELETE），不是存一条空文案。
- 接口上直接存空正文会被 400 拒掉（`BAD_REACTION_GUIDE`），所以「这层不要」只有删除一条路。
- 删完立刻落回上一层（§28.2）：不重启、不等换码。

### 28.5 怎么确认生效

| 看什么 | 说明 |
| --- | --- |
| `[chat] turn … guide=<layer>` | 回复那一轮的日志里带 `guide=channel` / `guide=guild` / `guide=global`，打的就是这次生效的那一层；三层都没配时也记 `global`（用的是内置默认文案） |
| `[gateway] alarm build=reply-tool-3` | 门牌。文案本身部署即生效（不经 DO），但 `@all` 的展开跑在网关里，要等 DO 换码（§13） |
| `贴表情 计划 😄→<消息ID>,…` | 实际要贴的清单；写 `@all` 时这里应该出现多条不同的消息 ID |

### 28.6 常见问题

| 症状 | 先看 |
| --- | --- |
| 改了文案没反应 | ① `guide=` 打的是不是你以为的那一层（改了 global，但 channel 有配置就是 channel 生效）；② 门牌是不是 `pg-errors-1` 或更新——文案不用等换码，`@all` 的行为要等 |
| 一个表情都不贴了 | 文案把判断收紧了：把「不值得贴就一行 `[[react:…]]` 都不写」之外的余地删掉、或把贴表情写成了可选；也可能这一轮模型就是觉得不值得贴。先看回复正文里有没有 `[[react:…]]`（正文里出现 `NONE` 是另一回事，见下面那条），再看 `表情选择` 那行 |
| 回复正文开头出现单独一行 `NONE` | 模型把**表情模型那一侧**的约定当成了正文：表情请求里没有值得贴的表情时回一行 `NONE`（`NO_REACTION_NOTE`，§18.2），而共用默认文案以前也这么教，主模型偶尔照做（线上历史消息里已有这种开头，例如 `2439` / `2468` / `2470`）。现象是正文第一行只有 `NONE`、第二行起才是真的回复。**`none-head-1` 起服务层自动剥掉**：回复开头单独一行的 `NONE`（`none` / `无` / `不贴` 同义）不再进正文——`TurnResult.text`、落库正文、流式进度三处都过 `stripNoReactionHead`，整条只有 `NONE` 时原样保留、不会变成空串；先看门牌确认实例已是 `none-head-1` 或更新（`[gateway] alarm build=reply-tool-3` / `[node] listening … build=reply-tool-3`，§13），更早的门牌没有这道兜底。**历史消息里的 `NONE` 不会被回改**，要手工清理；日志里直接看正文首行即可判 |
| 贴错人 / 贴到没点名的人 | 旧门牌（`prompt-bounds-1` 及更早）才会把没点名的表情分给别人；新门牌下不写 `@all` 就只贴触发那条 |
| 想让大家各收一个，结果全在触发那条 | 文案里没教 `@all`，或模型没照着写。让它显式写 `[[react:😄@all]]`（§28.3） |
| 保存时提示 `BAD_REACTION_GUIDE` | 正文被清空了：要清这一层请点删除（§28.4）；超过 8000 字也会被拒 |
| 保存时提示 `BAD_SCOPE` / `BAD_REQUEST` | 层级选错，或 `guild` / `channel` 的 ID 没填 |

### 28.7 回复说「看不到图」/ 答非所问

主对话接图（§19.7）之后这类抱怨按三点排查，缺一条就是那一环没通——**先看后台「回复」页第二张卡片的识图开关有没有被关掉**（`vision-main-2` 起可按 global / guild / channel 三层关，默认开）：关掉时主模型看不到图，**但表情模型仍能看到这一轮的图**——这时请求里确实没有图，不是 bug，开关本身见 §19.8。三点是：

1. **网关有没有拿到图片引用**：最多 4 张（`MAX_IMAGES = 4`，`src/workers/gateway/images.ts:11`）、单张 ≤ 5MB（`MAX_IMAGE_BYTES = 5 * 1024 * 1024`，`:14`）、只认 `image/*`。超限 / 类型不对在收集阶段**静默丢弃、不打日志**（§19.2、§19.3），表现就是「明明发了图，它却说没看到」——视频、PDF、超 5MB、`size` 缺失都算这一类。读图本身抛错才会留 `[chat] 读取图片失败，按无图继续：<reason>`。
2. **中继有没有把图转成图片 part**：中继日志里会写跳过原因——超限或不合规是 `跳过图片：<原因>`、一次请求超过 4 张是 `跳过图片：本次请求最多 4 张，已丢弃后续图片。`，整条 wire 序列化超过 20,000,000 字符则是 `丢弃本次全部 <N> 张图片：…只保留文本。`（`studio-api 的 server.js` 的 `buildImagePart` / `buildWire`）。日志里出现「跳过 / 丢弃」就说明图在服务端就被拦下了，跟模型能力无关。
3. **页面执行器在不在线**：`GET /pg/healthz` 的 `executors` 数组为空 = 没有执行器能跑这一路，回复会超时或落到别的路径；数组里有条目时再看每条的 `clientVersion`——低于中继要求的 `minClientVersion` 会被直接拒（日志 `客户端版本过低（<ver>）…`），执行器上线那行是 `执行器上线 key=… version=… kind=…`。

三条都过了还答非所问，就去看首段请求到底带没带图：成功日志里 ` images=` 紧跟 `cont=`（`src/core/chat/service.ts:1183-1186`），没有这个字段就是这一轮没带图（§19.7）。

---

**与 §27 的关系**：提示词段（§27）与贴表情文案是两份独立配置，三层各管各的——改提示词段不会动贴表情文案，反之亦然。完整口径见 `docs/architecture.md` §33。

## 29. 贴表情素材模板（2026-10-28，门牌 `reaction-template-1`）

一句话：表情模型看到的那一整段素材（对方说了什么、我回了什么、最近聊了些什么、有哪些表情可选、能贴到哪几条）现在是后台可编辑的模板，global / guild / channel 三层各存一份，命中哪层整份用哪层；模板里写哪些占位符就展开哪几段，删掉某个占位符 = 那一段不出现。顺带它现在能看到**最近 20 条**聊天记录（固定常量 `REACTION_HISTORY_MESSAGES`，与频道「注入条数」设置无关）。

### 29.1 怎么改

1. 顶栏进「表情」页，往下滚到「表情素材模板」一节（在「贴表情提示词」下面）。
2. 选层级：`global`（全局默认，不用填 ID）→ `guild`（填服务器 ID）→ `channel`（填频道 ID）。选完编辑框里就是那一层当前的模板。
3. 改正文，点「保存这一层」。**保存是整份替换**：编辑器里是什么，这一层存的就是什么，没有「只改其中一段」的增量保存。
4. 想从内置默认起步：点「恢复默认」把内置默认模板填进编辑框（只填进编辑器，不落库），改完再「保存这一层」。
5. 想清掉这一层：点「删除这一层」（或「已配置的层」那一行的「删除」）。**留空保存不会清层**：空正文会被 400 `BAD_REACTION_TEMPLATE` 挡下，清层只能走删除（§29.6）。
6. 「已配置的层」按层列出「几个占位符 · 更新于 <时间>」，点「载入」把那一层读进编辑框。

### 29.2 六个占位符（写错一个都保存不了）

| 占位符 | 展开成什么 | 删掉它会怎样 |
| --- | --- | --- |
| `{{最近对话}}` | 最近 20 条频道记录，一行一条 | 模型看不到上下文，只看这一句 |
| `{{对方的消息}}` | 触发这一轮的用户原文 | 它不知道在回应什么 |
| `{{我的回复}}` | 主模型刚写的那句正文 | 它不知道给哪句话配表情 |
| `{{自定义表情}}` | 该服自定义表情清单（自带标题，最多 40 个） | 清单连标题一起消失；这一轮没清单时展开是空串 |
| `{{可贴表情的消息}}` | 当轮可贴的目标清单（自带标题） | 不能指名贴，只剩触发那条 |
| `{{表情规则}}` | 贴表情提示词的正文（§28 那一份） | 素材里不再重复一份规则（默认就没写） |

### 29.3 自查清单（保存前挨条问自己）

- 想让它知道话题在聊什么？留 `{{最近对话}}`（固定最近 20 条，条数改不了）。
- 想让它知道在回应什么？留 `{{对方的消息}}`。
- 想让它知道自己刚说了什么？留 `{{我的回复}}`。
- 想让它只在真实存在的表情里挑？留 `{{自定义表情}}`（清单为空时整段连标题一起消失）。
- 想让它指名贴到某条？留 `{{可贴表情的消息}}`（删了就只剩触发那条）。
- 想在素材里再念一遍规则？才留 `{{表情规则}}`——默认不写，规则已经在 system 里有一份（§28）。
- 至少留一个合法占位符，否则保存时 400：模板全是死文字，模型没得判断（§29.6）。

### 29.4 命中和回落

| 情况 | 模型看到的素材 |
| --- | --- |
| `channel` 有配置 | `channel` 那一整份 |
| `channel` 没有、`guild` 有 | `guild` 那一整份 |
| 只有 `global` | `global` 那一整份 |
| 三层都没有 | 内置默认模板 |

- **整份覆盖**：命中 `channel` 就不再补 `global` 的段落；只想换一段，就把另几段原样抄进来。
- 「留空」不等于「这一层没有」：留空保存会被拒，清层用「删除这一层」；删掉之后读侧自然落回上一层。

### 29.5 怎么确认生效

| 看什么 | 正常长什么样 |
| --- | --- |
| 门牌 | `[gateway] alarm build=summary-order-2` 或 `[node] listening … build=summary-order-2`；还是 `reaction-template-1` 就是 DO 没换码（§13、§24.5） |
| 命中层 | `[chat] 表情选择 … guide=<层> template=<层>`：`template=` 是你改的那一层才算命中；`guide=` 是提示词的层，两者各算各的 |
| 行为 | 把 `{{自定义表情}}` 从模板里删掉保存，下一轮它就不该再贴该服的自定义表情；加回来再发一条验一轮 |

素材本身不落日志（只记命中层与量纲），要知道线上到底发了什么，用上面「行为」那一行做对照，或临时把某段删掉比一轮。

### 29.6 常见问题

| 症状 | 先看 |
| --- | --- |
| 改了模板没反应 | ① `template=` 打的是不是你改的那一层（改了 `global`，但 `channel` / `guild` 有配置就轮不到 `global`）；② 门牌是不是 `summary-order-2`——素材的读取跑在会话里，旧实例还按写死的四段拼 |
| 素材里缺段 | ① 模板里本来就没写这个占位符（不写 = 整段不出现）；② 这一轮没有内容：没历史 / 没自定义表情清单 / 没有可贴目标，展开成空串、不留空壳 |
| 模型开始乱贴 / 贴得比之前松 | 多了最近 20 条历史，它能看见更多可接的梗。先把 `{{最近对话}}` 从模板里删掉再比一轮，分清是历史的影响还是模板结构的影响（规则仍在提示词，§28） |
| 保存报 `UNKNOWN_TEMPLATE_VAR` | 写了 6 个之外的名字（拼错、或用了提示词段那 5 个变量）。响应体 `vars` 列出具体是哪几个；**两套白名单不通用**：提示词段的变量（§27.7）在素材模板里一个都不认，反过来也一样 |
| 保存报 `BAD_REACTION_TEMPLATE` | ① 正文空（清层请点删除）；② 超过 8000 字；③ 一个合法占位符都没有 |
| 保存报 `BAD_SCOPE` / `BAD_REQUEST` | 层级选错，或 `guild` / `channel` 的 ID 没填 |
| 贴到没点名的人 | 与模板无关：旧门牌才会挪人；新门牌下不写 `@all` 就只贴触发那条（§24.5、§28.3） |

---

**与 §28 的关系**：提示词（§28，`reaction_guides`）进 system，素材模板（本节，`reaction_templates`）进 user 消息——两份独立配置、三层各管各的，改一个不影响另一个。`{{表情规则}}` 是提示词正文的一份拷贝，写它等于在素材里再念一遍（默认不写）。完整口径见 `docs/architecture.md` §34。

## 30. 网页后台手动备份（运维手册）

后台「备份」页上有个按钮：点一下，最迟一分钟宿主就跑一轮备份，跑完页面自己变结果。这条路不替代每日 04:00 那轮定时备份，只是多一个「现在就想备一份」的入口——同一份脚本、同一把锁、同一份保留策略（`docs/hosting.md` §17.6）。

### 30.1 怎么点

1. 打开后台 → 「备份」页 → 点「立即备份」。
2. 页面立刻进入「正在备份」（按钮先变「提交中…」，随后 `phase=running`）。**这一步只写了请求文件**，宿主那边还没动；最迟 1 分钟 `dc-ai-bot-backup-request.timer` 才轮到它。
3. 等结果，不要连点：已经有一份没处理的请求在，再点会被 `409 BACKUP_BUSY` 挡掉；正在跑的时候再点，是排一份**新的**请求，跑完这一轮之后还会再跑一轮（不是排队，是又按了一次）。
4. 页面刷新不会打断它：进度和结果都在宿主磁盘上（`/opt/dc-ai-bot/data/backup-status.json`），关掉页面这一轮照样跑完。

### 30.2 结果怎么看

| 页面显示 | 状态文件 | 含义 |
| --- | --- | --- |
| 正在备份 / `running` | `{"phase":"running","id":"…","source":"manual","startedAt":"…"}` | 宿主已经开跑，还没结束 |
| 上次成功 / `done` | `{"phase":"done",…,"file":"dc-ai-bot-20261028T130737Z.tar.gz","bytes":247873,"keptRemote":3,"remote":"gdrive:dc-ai-bot-backup"}` | 这一份归档已经在本地 `/var/backups/dc-ai-bot` 与 `gdrive:dc-ai-bot-backup` 上了 |
| 上次失败 / `failed` | `{"phase":"failed",…,"error":"上传失败，本地文件保留：…"}` | `error` 就是原因，与 journal 里那一行同一句话 |

命令行对口径（不确定页面上的结果是不是自己点的那一次时用）：

```bash
cat /opt/dc-ai-bot/data/backup-status.json          # 当前阶段与结果
ls -lt /var/backups/dc-ai-bot | head -3             # 本地最新几份归档
systemctl list-timers dc-ai-bot-backup-request.timer --no-pager   # 下一次轮询在几秒后
```

`status.id` 与页面点下去时拿到的 `request.id` 一致，就说明这一份结果对应自己那一次点击；`source` 是 `daily` 的那条是每日定时跑的，不是手动。

### 30.3 失败怎么自查

| 症状 | 先看 |
| --- | --- |
| 点了按钮，1 分钟过去还是 `running`（或页面没变化） | ① `systemctl is-active dc-ai-bot-backup-request.timer` 是不是 `active`（不是就 `sudo systemctl enable --now dc-ai-bot-backup-request.timer`，装单元见 `docs/hosting.md` §17.2）；② `cat /opt/dc-ai-bot/data/backup-request.json` 还在不在（不在且 `status` 没动 = 脚本被启动却提前挂了，看 ③）；③ `sudo journalctl -u dc-ai-bot-backup-request.service -n 30 --no-pager` |
| 状态文件一直是上一轮的结果，新的这份没出现 | 请求文件可能没落盘：`ls -l /opt/dc-ai-bot/data/backup-request.json`；容器与宿主看的是同一份（`./data:/data`），宿主上看不到就是后台那一步失败（接口 `501 BACKUP_UNAVAILABLE` 是另一回事，见下） |
| 页面提示 `BACKUP_UNAVAILABLE` | 这个构建没接文件系统（Cloudflare Workers 部署），按钮那条路本来就不通；要在自己机器上才有 |
| 页面提示 `BACKUP_BUSY` | 上一份请求还没被宿主消费（最多等 1 分钟），或正赶上一轮备份在跑 |
| `failed` 且 `error` 是「上一轮备份还在跑本轮跳过」以外的东西 | 按 `docs/hosting.md` §17.5 排错表逐行走：快照失败看源库、上传失败看 `rclone` 与 `/root/.config/rclone/rclone.conf`、远端删除失败看 rclone 的 `lsjson` 输出 |
| 日志里是「环境缺件：…」 | 前置检查没过（root / `rclone` / `sqlite3` / 数据库 / `/root/.config/rclone/rclone.conf`）：这一轮已经记成 `failed` 且请求文件已被消费，不会每分钟重试；按 `docs/hosting.md` §17.5 修环境后再点一次 |
| 归档在本地有、云端没有 | 看 `error`：`DRY_RUN=1` 的演练轮永远不上传（那只是手工演练，别在生产上开）；否则是上传或校验失败，本地文件按设计保留 |
| `running` 挂了一小时没动 | 单元 `TimeoutStartSec=30min`，跑飞的那轮会被 systemd 杀掉、状态可能停在 `running`；看 `journalctl -u dc-ai-bot-backup-request.service` 的尾部，下一轮手动再点一次即可 |

### 30.4 与每日定时备份的关系

- 两条路**共用同一把锁** `/var/lock/dc-ai-bot-backup.lock`：正撞上每日 04:00（UTC 20:00）那一轮，手动这轮会打一行「上一轮备份还在跑本轮跳过」退出，请求文件不删、下一分钟再来——所以点完发现多等了一分钟，通常是撞车，不是坏了。
- 两条路**共用同一份归档目录与保留策略**：本地 `/var/backups/dc-ai-bot` 留 3 份（`KEEP_LOCAL`）、远端 `gdrive:dc-ai-bot-backup` 留 30 份（`KEEP_REMOTE`）。手动多点几次不会让份数变多，只是把旧的挤出去。
- 停掉按钮这条路：`sudo systemctl disable --now dc-ai-bot-backup-request.timer`（每日那轮不受影响）。

## 31. 空回复与错误帧（`reply-error-2`，2026-10-28）

症状是「回了一条空消息」，日志却是一条成功。这一节只讲怎么在三处证据之间对号、修好之后该看到什么；契约与代码位置在 `docs/architecture.md` §37。

### 31.1 症状

- Discord 里 bot 的回复正文是占位串「（模型没有返回内容）」，或者干脆是空白。
- 频道像被忽略了一次：既没换 Key 重试，也没走 fallback 候选。
- 修复前这一幕**不会**留下任何错误日志。

### 31.2 三处证据怎么读

按顺序看，三处对上就是本节这个故障（旧代码 = 门牌 `backup-ui-1` 及更早）：

| 看哪里 | 命令 / 日志 | 怎么读 |
| --- | --- | --- |
| ① 中继侧 | `curl -s https://example.com/pg/healthz \| head -c 300` | 看 `executors[0].requestsFailed`：**在涨** = 请求确实到了执行器、执行器没答（超时那一类）；返回 `executors: []` 或 `503 executor_offline` 是执行器掉线，另一类问题 |
| ② 容器日志 | `docker compose logs bot \| grep 'len=0'` | `回复成功 … len=0` 就是「被记成成功的空回复」——`len` 是落库正文字数（`docs/architecture.md` §37.4），0 说明一个可见字符都没有 |
| ③ 错误日志 | `docker compose logs bot \| grep 'ALL_PROVIDERS_FAILED'` | 修复后同一场故障落在这里：`回复失败 ALL_PROVIDERS_FAILED: [{"model":{…},"error":"openai-compat: executor_timeout: 执行器超时"}]`，或者 `"error":"EMPTY_RESPONSE"` |

- **① + ② 同时成立**：中继在流里报了错、适配器把错误帧当空帧吞了、回合循环把零字记成成功——正是本节这个故障。
- **只有 ② 没有 ①**：中继没报错，是模型/供应商那边真回了空正文。修复后同样会被 `EMPTY_RESPONSE` 挡住（不再记成功），换 Key 之后一般就正常；连续几把都空，去查那个供应商的模型名与 Key（§17）。
- **只有 ① 没有 ②**：中继抖了一下，但这一轮最后拿到了正文（换了 Key 就好了），不用管。
- 动手前先看门牌：现在门牌是 `preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（160147§54）；上一次构建 `reply-tool-2`（行为与现版相同，只是验收时临时在成功日志尾部多带 `rawLen=` / `rawShell=` 两个诊断字段，`len=472 … rawLen=505 rawShell=<game>:1,</game>:1` 就是它留下的证据；现已下线）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，新增迁移 `0027_route_sampling.sql`、`0028_prompt_injections.sql`、迁移总数 28，§49、§50）；`preset-1`（酒馆预设导入阶段一：POST /api/prompts/import 把整份 SillyTavern 预设的文本段整层覆盖 global 层，迁移总数 26，§48）；再更早的 `director-6`（只把诊断用的 judge 行从截断改成完整一行：语音成功日志的 `judge=` 段与后台试听响应的 `judgeLine` 现在都放判断模型回的完整一行、不截断，`0` / `1` / `2` 三档念法、提示词、接口字段与位置、迁移（仍是 `0025_director_mode.sql`、总数 25）都没动；副作用是日志行可能变长，排错时按行读即可，§47.8、§25.16）；前一版 `director-5`（只改导演档（`1` / `2` 档）那句内置提示词 `JUDGE_DIRECTOR_COMMON`：正文每一句前面都要加一个括号标签写语气或说话方式（如（轻声）、（语速加快）、（笑着）），唱歌时整体风格组里要有一个 `(唱歌)`（形如 `(唱歌 温柔)`），整段歌词只在这一个地方标一次、不要给每句歌词加标签，歌词用中文；每句标签都是成对括号组，`1` 档剥掉后仍与原文逐字相同；`0` 档 `JUDGE_SYSTEM`、`2` 档字数护栏、接口、日志字段与后台 UI 一个字没动，没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.16）；再前一版 `'director-4'`（把 judge 那一行带进日志与试听：真实语音成功日志在 `rejected=` 之后多一个可选的 `judge=` 段，只放 judge 那一行（完整一行、不截断；`src/core/voice/style.ts:431` 的 `input.onJudgeLine?.(line)` 原样交出，包在 try/catch 里，回调抛错不影响念法），judge 没答上来时整段不出现（没配 judge、超时、非 2xx、坏 JSON、抛异常都算，此时 `rejected=judge`）；后台试听响应多一个 `judgeLine`（`string | null`，`src/workers/http/app.ts:1468`、响应 `:1516`，前端 `web/src/api.ts:2183`），页面在「导演模式…（退回原文：…）」之后多一行「判断模型写的是：…」，只在 `directorRejected` 不为 `null` 时显示；这一版解决的是 1 档退回时只看到 `rejected=verbatim`、判断不了模型到底怎么写的——现在能直接对比 judge 那一行与原文，区分「模型没写」「写歪了」「没答上来」（没答上来时既没有 `judge=` 段，`rejected=` 又是 `judge`）；日志口径随之从「正文绝不整段进日志」细化为「正文绝不整段进日志；judge 那一行整行带上，用于排查，不截断」；没有新迁移（仍是 `0025_director_mode.sql`、总数 25），§47.8、§25.14、§25.16、§19.1，前一版）；再前一版
`'director-3'` 是「判断超时按字数给预算 + 多一种 `judge` 退回原因」那版（固定 8 秒改成 15 秒起步 + 每字 40 毫秒、封顶 45 秒，入口 `judgeTimeoutMs(chars)`，§44.3、§47.8、§25.16）；**再前一版** `'director-2'` 是导演模式可观测性补丁（念法仍是前一版那一套——judge 先按 mimo 导演模式改写要念的文本，Discord 上显示的文字仍是原文；三档 `director` = `0` 关闭（逐字朗读，与上一版逐字相同）/ `1` 只插标签 / `2` 允许顺句改写，存 `voice_settings.director`，`1` 档把候选与原文里的成对括号段都删掉之后必须逐字相同、`2` 档去标签后字数要在原文 0.3–3 倍之间（原文不足 20 字时上限 = 原文 + 200 字）且不许残留 `[[voice]]` 之类双方括号指令，越界一律退回原文；放行时语音文本就是 judge 那一整行、tag 置空（风格组已长在正文开头，再拼前缀会念两遍）；judge 未配置 / 非 2xx / 坏 JSON / 异常一律退回原文，绝不让导演模式把一条回复弄失败；迁移 `0025_director_mode.sql`（`ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0`），迁移总数 25、首启 `applied=25 skipped=0`、从 24 升上来 `applied=1 skipped=24`；后台「语音」页多一个「导演模式」下拉、保存随 `mode` / `voice` / `speed` 整行 `PUT`（三层各存一行、没有 `PATCH`）；这一版把后台试听也接上导演档——body 里带可选 `director`（缺省 `0` = 不走导演提示词，非 `0` / `1` / `2` 回 `400 BAD_DIRECTOR_MODE`，校验排在「TTS 未配置」之后）才让 judge 按导演模式改写，响应在 `styleUsed` 之后多 `director` 与 `directorRejected`（`null` 或 `empty` / `verbatim` / `residue` / `ratio`）；成功日志从这一版起在导演模式退回原文时多一个可选的 `rejected=` 段（`[voice] 已发送 tag=<标签> bytes=<字节数> 字数=<字数> mode=<0|1|2> director=<0|1|2>[ rejected=<empty|verbatim|residue|ratio>]`；方括号里的 `rejected=` 段是 `'director-2'` 起才有的可选段、只有导演模式退回原文时才出现（放行时与 `'director-1'` 逐字相同），tag 优先取风格组、都空写 `tag=无`，字数按真正送进合成的文本算），§44.3、§47.8、§25.16，前一版）；**再前一版** `'director-1'` 是导演模式第一版（judge 先按 mimo 导演模式改写要念的文本、Discord 上显示仍是原文、三档 `director` = `0` / `1` / `2` 与四条护栏都是这一版定的，但后台试听固定按 `0` 档、响应里既没有 `director` 也没有 `directorRejected`、成功日志没有 `rejected=` 段，§47.8）；**更早的** `'voice-log-1'` 是**补一条成功日志**那版（`[voice] 已发送 tag=… bytes=… 字数=… mode=…`，只记标签 / 字节数 / 字数与 mode，正文绝不整段进日志（`director-4` 起这条末尾还会多一个可选的 `judge=` 段，带 judge 那一行的完整一行、不截断，用于排查）；没有新迁移，仍是 `0024`、迁移总数 24，§44.3、§47.7），**再更早的** `'tts-nolimit-1'` 是「朗读不再有任何字数上限」那一版（朗读正文只做清理、后台试听只去首尾空白，念多长由上游接口决定；judge 的输出上限从 1200 提到 4000，好让长正文整段抄回来（抄不全就标签保留、正文用原文）；没有新迁移（仍是 `0024`、迁移总数 24），§44.3、§46.3、§47.7）；更早的 `'tts-tags-1'` 是「assistant 正文开头的标签 + 正文逐字校验」那一版（`docs/architecture.md` §47、§47.7）；再更早的 `'tts-style-1'` 是「一行自然语言语气指令放在 `role:user` 消息里」那一版（`docs/architecture.md` §47）；`'tts-mimo-1'` 那一版记的是接口类型（dialect）：同一份配置可选 OpenAI 兼容的 `/audio/speech` 或小米 MiMo 的 `chat/completions`，老行默认 `openai`、行为不变，迁移 `0023`（迁移总数 23），见 §25.14 与 `docs/architecture.md` §46.7；前一版 `tts-admin-1` 是 TTS 接口搬进后台：地址 / Key / 模型 / 默认音色只认后台「语音」页、加密入库只回掩码、`VOICE_TTS_*` 那一版起不生效，见 §46；再前一版 `prompt-scope-1` 是内置默认与身份块改成三层可配：`fallback` 与 `identity` 各自能按 channel > guild > global 存一份、删一份，解析顺序三层提示词 → 三层内置默认 → 代码常量，见 §25.13 与 `docs/architecture.md` §45，再前一版 `voice-2` 是按指令模式补上【语音】提示段那版（只有 `mode = 1` 注入、教模型写一行 `[[voice]]`，见 §25.12 与 `docs/architecture.md` §44.1），再前一版 `voice-1` 是语音回复（文字回复结束后可发一条 mp3 附件、三档三层开关，§25.12、§44），再前一版 `pg-errors-1` 是后台「故障」页看 PG 中继报错那版（§25.11），`[gateway] alarm build=reply-tool-3` 或 `[node] listening … build=reply-tool-3` 才是最新代码（`mention-once-2` 是同一个人一条回复只 @ 一次那版、再前一版，见 §25.10；`vision-main-2` 是主模型识图的后台开关那版、再前一版，§19.8；`vision-main-1` 是主对话也接图那版、再前一版，§19.7；`none-head-1` 是回复正文首行 `NONE` 剥掉那版，见 §28.6；`empty-note-1` 是只 @ 不说话那版、再前一版，`stream-edit-1` 是边说边编辑那版、再前一版，`reply-continue-1` 是续写那版，`mention-2` 是 @ 前缀预算那版；`fake-stream-1` 是假流式写死 6 片那版、`fake-stream-2` 是片数三层可配那版，两版都是历史，也都带本节这版修复）；看到 `reply-error-2` 说明本节这版修复已经在（修复从 `reply-error-1` 起），还看到 `backup-ui-1` 或更早的门牌，说明网关实例连这版修复都还没换上（§13）——`@` 路径跑的是 DO 里那一份 ChatService，门牌没换就别急着怀疑「修没生效」。

### 31.3 修复后应该看到什么

- **不会再出现** `回复成功 … len=0`。
- 中继超时：`回复失败` 那行带 `openai-compat: executor_timeout: 执行器超时`（或 `gemini:` / `anthropic:` 前缀的同一形状），随后**自动**换同供应商下一把 Key；同供应商都不行就换路由的 `fallbacks`，最后那条 `回复成功` 会带换到的 `model=<供应商>/<模型>` 与 `key=<备注>`。
- 模型真的回了空正文：**先就地重试，不马上换**——同一个候选模型最多试 3 次（首次 + 2 次重试，重试之间不等待），具体看到什么见下面两条。
- 全部候选都失败：才有 `回复失败 ALL_PROVIDERS_FAILED: <json>`，频道里那条变成 `回复生成失败：…`；此时那段 JSON 就是「每个候选为什么失败」的清单，照它对号（Key 与模型的对应见 §17，重试口径见 §16.3 与 `docs/architecture.md` §19.7）。
- **偶发空回的正常形状**：`空回复重试 2/3 model=<供应商>/<模型> key=<备注>` 那条 warn 之后紧接着一条 `回复成功 … len=<非零>`，前后 `model=` / `key=` 一模一样——同一个候选模型就地重试就拿到了正文，既没换 Key、也没换候选模型，这种不用管。
- **连续三次空回才升级**：同一个候选模型连着三把都空（两条 `空回复重试 …` 之后再没有正文）才算它失败——这时它的 `attempts` 里才有那条 `EMPTY_RESPONSE`，然后换路由里的下一个候选模型；换到有正文的候选，`回复成功` 里的 `model=` 就变了（fallback 生效）。所有候选都空才轮到上一条那条 `ALL_PROVIDERS_FAILED`，其中 `"error":"EMPTY_RESPONSE"` 每个候选只占一条——重试次数不进这份清单。
- 已经吐出去半句之后才出错：**不会**再换 Key 重写（流式铁律，`docs/architecture.md` §20.5 与 §37.3），用户看到的是那句话没写完，然后一条失败提示。

## 32. 酒馆预设导入：步骤、报错与回滚

这一节对应后台「提示词」页顶部那块导入面板与 `POST /api/prompts/import`，契约（解析规则、宏映射、字段含义）在 `docs/architecture.md` §48。一句话记住语义：**把整份 SillyTavern 预设的文本段整层覆盖到选中的那一层**（`preset-import-1` 起 `scope` 可以选 `global` / `guild` / `channel`，不填仍是 global），导入前的旧段不保留。分层语义、存档 id 与接口契约见 `docs/architecture.md` §56；本节的步骤与报错对三层都适用。

### 32.1 导入步骤（照着做）

1. 先确认线上在跑的门牌：启动日志 `[node] listening … build=preset-import-1` 或 `[gateway] node host started build=preset-import-1`（§25.4）；迁移日志应是 `applied=30 skipped=0`（新库）或 `applied=0 skipped=30`（已经在跑 30 个迁移的库——本版没有新迁移）。
2. SillyTavern 里用「导出预设」把要用的预设存成 JSON 文件。角色卡、世界书、聊天记录都不是预设——导错会直接回 `BAD_PRESET`。
3. 打开后台「提示词」页，最上面那块导入面板：选文件，或把 JSON 直接粘进文本框。
4. 填角色名（必填）：`{{char}}` / `{{charIfNotGroup}}` 会替换成它；留空的话这两个宏原样留在文本里，只给一条 warning。
5. 在导入面板**自己的**层选择里选目标层（channel / guild / global，与页面顶部编辑区互不影响；选 channel / guild 还得填 ID，没填本地就拦住、不发请求）→ 点导入 → 二次确认（文案写明「整层覆盖 {你选的那一层}」，点取消一个请求都不发）→ 看结果区：「已写入 N 段（覆盖 M 段）」+ 写入层 + 被忽略分组（marker / 空段）+ warnings 列表。**M 就是那一层被覆盖掉的旧段数，M 不为 0 说明目标层的旧段已经没了**；其它层一个字节没动。

### 32.2 三类 400 怎么处置

先看响应体的 `error` 字段：

| `error` | 触发条件 | 处置 |
| --- | --- | --- |
| `BAD_PRESET` | body 不是 JSON 对象；`preset` 缺失或不是对象；解析器判定不是对象或缺 `prompts` 数组 | 确认导的是预设 JSON 本身（不是角色卡 / 世界书 / 打包文件的外壳）；用 SillyTavern 的「导出预设」重新导一次 |
| `NO_SEGMENTS` | 一个可用段都没解析出来（整份只有 marker 段或空段） | 换一份有实际文本段的预设；marker 段与空段本来就不导入 |
| `UNKNOWN_TEMPLATE_VAR` | **启用**段里出现白名单外的宏（停用段不查），响应多一个 `vars` 数组 | 按 `vars` 清单把宏删掉或改成白名单内的（`bot_name` / `user_name` / `guild_name` / `channel_name` / `date`），或者在预设里停用那段再导 |

`UNKNOWN_TEMPLATE_VAR` 只查启用段：停用段里的未知宏不拦导入，但以后在后台启用它，每条回复都会在渲染时抛 `UNKNOWN_TEMPLATE_VAR: <name>`（§32.3 第 5 条）——启用前先把宏改掉。

### 32.3 导入后回复不对怎么查（按顺序）

1. **段有没有进去**：后台「提示词」页切到**导入时选的那一层**看段列表（`preset-import-1` 起可以是 channel / guild / global），段名与顺序应来自预设的 `prompt_order`（预设没写 `prompt_order` 时按原顺序全启用）。
2. **旧段是不是被覆盖了**：结果区「覆盖 M 段」大于 0，说明导入前**那一层**手写的段已经没了——这通常是「语气变了 / 固定文案丢了」的真正原因。
3. **输出里有字面 `{{...}}`**：这个宏没映射到。角色名留空会让 `{{char}}` 保留原样；白名单外的宏会原样保留并记 `unknown variable`。
4. **该有设定的地方空着**：预设里 `{{description}}` / `{{persona}}` / `{{scenario}}` 这类这一版没有来源的宏是被**清空**的（不是报错），对应 warning 在结果区——这是阶段一的预期行为，不是丢数据。
5. **接口 5xx 且日志里有 `UNKNOWN_TEMPLATE_VAR: <name>`**：启用段里有白名单外宏，回 §32.2 第三条处理。
6. **以上都对但还是老回复**：先确认门牌（§25.4），再确认频道 / 服务器层没有更高优先级的段把它盖住（§25.13 那套顺序）。

### 32.4 回滚

导入是**整层覆盖**，没有撤销按钮。三条路，从快到慢：

- **重新导入旧预设**：手上还有导入前那份 JSON 的话，选同一层再导一次就是再整层覆盖回去（同时会把 `prompt_presets` 里那一层的那一行换成这份）。
- **把那一层写回去**：`PUT /api/prompts`（`src/workers/http/app.ts:756`）带完整的段数组 + 该层的 `scope` / `scopeId`，手工重建那一层；不记得旧内容时这条路等于重写。
- **恢复数据库备份**：`prompt_presets` 里存着每一层最近一次的原始 JSON，但**只写不读**——没有读取接口、后台也没有按钮，只能自己查：`SELECT id, char_name, imported_at, source_json FROM prompt_presets;`（global 层那行 `id = 'latest'`，其它层 `latest:channel:<ID>` / `latest:guild:<ID>`；SQLite 文件是 `./data/dc-ai-bot.sqlite3`，见 `docs/hosting.md` §10）。注意每层只留**最近一次**，同一层连续导入两次以上就只剩最后那份。

所以**导入前先备份**是唯一能完整回到导入前状态的可靠办法：后台「备份」页点一下即可（§30）。

### 32.5 判据

- 迁移：`migrations/` 末尾是 `0026_prompt_presets.sql`、共 26 个；启动日志 `applied=26 skipped=0`（新库）或 `applied=1 skipped=25`（从 25 个迁移的库升级）——这是 `preset-1` 那一版的数字；`preset-2` 见 §33.4，`preset-4` 见 §34.4，`preset-head-1` 到 `context-tool-5` 见 `docs/architecture.md` §52–§55，现行 `preset-import-1` 见 §56.8（仍是 30 个迁移）。
- 门牌：`preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（169512§54）；上一次构建 `reply-tool-2`（行为与现版相同，只是验收时临时在成功日志尾部多带 `rawLen=` / `rawShell=` 两个诊断字段，`len=472 … rawLen=505 rawShell=<game>:1,</game>:1` 就是它留下的证据；现已下线）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7）；`preset-2`（阶段二：路由采样参数 + 深度注入，§49、§50；`src/workers/gateway/engine.ts:129`，`test/gateway.node.test.ts:229` 同步；`preset-1` 是酒馆预设导入阶段一，§48），日志里看到 `build=reply-tool-3`。
- 数据：`SELECT scope, scope_id, count(*) FROM prompt_segments GROUP BY scope, scope_id;` 能看出每一层各有多少段（导入只该改动目标层那一行）；`SELECT id, char_name, imported_at FROM prompt_presets;` 每层一行——global 是 `latest`、其它层 `latest:<scope>:<scopeId>`，从没导过的层没有行。

## 33. 阶段二：采样参数与深度注入怎么查

这一节对应阶段二的两项能力：路由采样参数（`topP` / `topK` / `seed` / `frequencyPenalty` / `presencePenalty`）与深度注入（`prompt_injections` 一层一行）。契约（字段、范围、位置算法、跨提供方映射）在 `docs/architecture.md` §49 与 §50。一句话记住两件事：**采样留空 = 这一层不设 / 深度注入正文留空 = 这一层关着**——两者都不是「填了 0」，也不是「填了空串」，而是这一层根本没有这个设置。

### 33.1 判据链（按顺序走）

1. **门牌**：启动日志 `[node] listening … build=reply-tool-3` 或 `[gateway] node host started build=reply-tool-3`（§25.4）。看到 `preset-1` 说明跑的还是阶段一，后面几条都别查了。
2. **迁移**：日志应是 `[node] 迁移检查完成 applied=29 skipped=0`（新库）或 `applied=3 skipped=26`（从 26 个迁移的库升上来；`applied=3` 就是 `0027`、`0028`、`0029` 这三条）或 `applied=1 skipped=28`（从 28 个迁移的库升上来，只补 `0029`）。缺 0027 或 0028 说明镜像里的迁移清单还是旧的——迁移文件随镜像打进 `/app/migrations`、启动时从工作目录读（`docs/hosting.md` §5），宿主机上放一个 `.sql` 不会进容器；要用含 `0027_route_sampling.sql`、`0028_prompt_injections.sql` 的那份代码 `docker compose up -d --build` 重建镜像并重启（§5）。账本在 `_migrations` 表，重复执行是幂等的。
3. **两个接口直接看配置**：
   - `GET /api/routes` → `{ items }`：每一项带 `scope` / `scopeId` 与它自己的五项采样（没设的键**不出现**，不是 `null`）。
   - `GET /api/prompt-injections` → `{ items }`：一层一行，带 `content` / `depth` / `role` / `updatedAt`；写进去过的行都在，哪怕 `content` 是空串（空串就是「这一层关着」）。深度注入那边仓储没接线时回 `501 INJECTION_UNAVAILABLE`（`src/workers/http/app.ts:811`）；路由仓储是必需依赖、没有这个 501。
4. **`PUT` 的 400 码各是什么意思**（四个都是 `PUT /api/prompt-injections` 的，采样那边只有既有的 `BAD_REQUEST`）：

   | `error` | 意味着什么 | 怎么改 |
   | --- | --- | --- |
   | `BAD_SCOPE` | `scope` / `scopeId` 不合法（scope 必须是 `global` / `guild` / `channel`，后两者要非空 ID） | 按后台那三层的选择重发；`global` 层的 `scopeId` 必须是空串 |
   | `BAD_INJECTION_CONTENT` | `content` 不是字符串，或超过 20000 字 | 空串是合法的（= 关掉这一层）；只是不能缺字段、不能超长 |
   | `BAD_INJECTION_DEPTH` | `depth` 不是 0–50 的整数（小数、负数、字符串都算） | 填 0–50 的整数；超出现在历史长度的 depth 会在插入时被 clamp，但**不会**被接口接受成 51 |
   | `BAD_INJECTION_ROLE` | `role` 不是 `system` / `user` / `assistant` | 从后台下拉里选，别手拼别的值 |

   采样参数那边（`PUT /api/routes`）越界或非数字一律回既有的 `400 BAD_REQUEST`，没有新错误码：`topP` 0–1、`topK` 1–1000 的整数、`seed` 0–2147483647 的整数、两个 penalty -2–2。
5. **采样参数没生效**，按这两步：
   - 先看**路由三层哪层命中**：路由是「整层对象优先」（`channel > guild > global`），命中的那一层就是全部——如果频道层有一行但没填 `topP`，服务器层填了也不会生效。用 `GET /api/routes` 看 `scope` / `scopeId`，确认实际生效的是哪一行。
   - 再看**该 provider 认不认这个参数**：`anthropic` 只发 `top_p`（`top_k` / `seed` / 两个 penalty 填了也不发）；`openai-compat` 没有 `top_k`（填了也不发）；`gemini` 五项都发。发出去但上游忽略的，日志里看不出来——线缆上确实没有那个键，或上游自己丢掉了。
   - 还要记得这两项不跟提示词层：采样五项只从路由取，提示词层的 `temperature` / `maxTokens` 与它们无关。
6. **深度注入没插进去**，按这三步：
   - 先看**是不是空正文**：`content` 为空白（含全空格 / 换行）的那一层等于关着，解析会继续往下一层找；三层都空就什么都不插（`GET /api/prompt-injections` 看那三层实际存的 `content`）。
   - 再看 **depth 是否超过历史长度被 clamp**：位置是 `messages.length - 1 - depth`，depth 先 clamp 到 `[0, messages.length - 1]`；depth 大于历史条数时落在**最前面**（`messages[0]` 之前），看起来就像「插到了很早的位置」，不是没插。
   - 最后确认这条路走不走注入：主对话（首段与续写）会注入；表情（`src/core/chat/reaction.ts`）与识图（`src/core/chat/emoji-describe.ts`）**故意不注入**、也不设采样。另：`role=system` 的注入在 `anthropic` 线缆上按 `user` 发、在 `gemini` 上也占 `user` 的角色位，这是适配器口径，不是注入丢了。

### 33.2 回滚（三条路，从快到慢）

- **删行**：直接对数据库动手最直接。`prompt_injections`：`DELETE FROM prompt_injections WHERE scope = 'channel' AND scope_id = '<频道ID>';`（`global` 层的 `scope_id` 是空串）。采样参数不想删整行路由，就把五列置空：`UPDATE routes SET top_p = NULL, top_k = NULL, seed = NULL, frequency_penalty = NULL, presence_penalty = NULL WHERE scope = '<层>' AND scope_id = '<ID>';`（`NULL` 才是「不设」；写 0 是有效值）。
- **走接口**：深度注入用 `DELETE /api/prompt-injections`，body `{ scope, scopeId }`，命中 0 行也回 `{ ok: true }`（幂等）。采样没有单独的 `DELETE` 参数接口——`DELETE /api/routes`（`src/workers/http/app.ts:1054`）删的是**整层路由**（连 `primary` / `fallbacks` 一起没），只想清采样就这样做：`PUT /api/routes` 带上原来的 `primary` / `fallbacks`、**不带**那五个键，UPSERT 会把五列写成 `NULL`。
- **恢复备份**：上面两条都做错、或要回到某个确定时刻时，用后台「备份」页那一套恢复数据库（§30）。注意备份是**整库**：恢复会把两条能力之外的配置（提示词、路由、语音、记忆设置）一起带回备份时刻。

### 33.3 两条限制（照实说）

- **`anthropic` 只有 `top_p`**：`top_k` / `seed` / `frequencyPenalty` / `presencePenalty` 在这条线缆上填了也不发（`src/core/providers/anthropic.ts:82-83` 的注释与映射）。同一个路由换到 `anthropic`，那四项从「生效」变成「静默不生效」，日志不会报错。
- **`role=system` 的注入在 `anthropic` 上按 `user` 发**：Anthropic 的 `messages[].role` 只接受 `user` / `assistant`（`src/core/providers/anthropic.ts:34-36` 的 `wireMessage`）；`gemini` 也把非 `assistant` 映射成 `user`。所以同一条注入换 provider 后「说话人位置」会变——内容还在，但不再是 system 角色。

### 33.4 判据

- 迁移：`migrations/` 末尾是 `0027_route_sampling.sql`、`0028_prompt_injections.sql`，共 28 个；启动日志 `applied=28 skipped=0`（新库）或 `applied=2 skipped=26`（从 26 个迁移的库升级）——这是 `preset-2` 那一版的数字；`preset-3` 起是 29 个、末尾 `0029_world_books.sql`；`preset-4`（前一版）仍是 29、没有新迁移，见 §34.4；现行 `preset-head-1` 同样 29、没有新迁移，见 `docs/architecture.md` §52。
- 门牌：`preset-import-2`（现版：导入酒馆预设时，预设里自己关着的段也带进来、保持停用，后台可逐段打开；停用段不搬去深度注入，宏照样映射，§58；无新迁移、迁移总数仍是 30。上一版 `context-stream-1`（上下文工具模式的上游从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），但仍整段攒完才交付、分支内一次进度都不推；适配器把 `choices[0].delta.tool_calls` 逐帧交出来（`ToolCallDelta`），服务层按 `index` 拼回完整工具调用再交给 `readToolReply`，空回与续写的判据一个字没动，§57）。再上一版 `preset-import-1`（酒馆预设导入可以选层——`scope` = `global` / `guild` / `channel`，整层覆盖目标层、其它层不动，采样参数按目标层继承，历史后指令写同一层的深度注入，原始 JSON 按层各存一行，§56）。再上一版 `context-tool-5`（把钉死的 `tool_choice` 改回 `'auto'`，`src/core/chat/service.ts:1236`）、`context-tool-4`（已回退，曾把 `tool_choice` 钉成回复工具）、`context-tool-3`（上下文工具模式首版），三版定位见 §55.1）；再往前 `reply-tool-3`（175225§54）；上一次构建 `reply-tool-2`（行为与现版相同，只是验收时临时在成功日志尾部多带 `rawLen=` / `rawShell=` 两个诊断字段，`len=472 … rawLen=505 rawShell=<game>:1,</game>:1` 就是它留下的证据；现已下线）；前一版 `reply-tool-1`（把模型写在正文里的 `story_reply` 工具调用壳剥掉再发——壳不再作为正文发到频道；同时把 tools 定义发进请求，当前中继对 tools 是空转的兼容性保留，无新迁移、迁移总数仍 29，§54）；再前一版 `identity-off-1`（有预设段时不再追加身份块——这一轮有效提示词里只要有任何启用的 `before` 段，`system` 里就没有身份块；身份块只在没有前置预设段时兜底，无新迁移、迁移总数仍 29，§53）；再再前一版 `preset-head-1`（预设 `before` 段回到 `system` 天头、长期记忆摘要搬出 `system` 改拼在本轮那条 user 消息最前面，无新迁移、迁移总数仍 29，§52）；再再再前一版 `identity-head-1`（身份块去掉 Discord 平台措辞、平台元信息回到 `system` 天头，无新迁移、迁移总数仍 29，§52）；再往前 `preset-4`（阶段四：酒馆预设导入的段顺序按提示词链还原，迁移总数仍 29，§48.8）；`preset-3`（阶段三：世界书 + 酒馆预设导入器修正，新增迁移 `0029_world_books.sql`、迁移总数 29，§51、§48.7；`src/workers/gateway/engine.ts:129`；`preset-2`（阶段二：路由采样参数 + 深度注入，§49、§50）；`preset-1` 是酒馆预设导入阶段一，§32），日志里看到 `build=reply-tool-3`。
- 数据：`SELECT scope, scope_id, top_p, top_k, seed, frequency_penalty, presence_penalty FROM routes;` 看采样五列（`NULL` = 不设）；`SELECT scope, scope_id, depth, role, length(content) AS n, updated_at FROM prompt_injections ORDER BY scope, scope_id;` 看注入三层。

## 34. 世界书与预设破限怎么查

这一节管两件事：世界书没生效，以及导完酒馆预设破限仍然失效。世界书这一半按「一层多本 + 酒馆五档」写（当前门牌 `worldbook-multi-1`）；预设导入那一半仍按 `preset-import-2` 的口径，两边是两套存储，互不覆盖。

### 34.1 判据链

按顺序走，走完还不行再看 §34.2 的回滚路。

1. **门牌**：启动日志 `[node] listening … build=worldbook-multi-1` 或 `[gateway] node host started build=worldbook-multi-1`（§25.4）。还是 `worldbook-crud-1` 及更早，说明镜像没换上去——先换版本，别的判据都别往下看。
2. **迁移**：`migrations/` 末尾是 `0035_world_books_multi.sql`、共 35 个。从 34 个迁移的库升上来是 `[node] 迁移已执行：0035_world_books_multi.sql` + `迁移检查完成 applied=1 skipped=34`；新库首次启动 `applied=35 skipped=0`；已经在 35 个的库是 `applied=0 skipped=35`。0035 会重建 `world_book_state` 并清空旧记账（旧表分不清一条账属于哪本书），升级后第一轮的粘性/冷却从零开始是预期。表没建起来时世界书接口回 `501 WORLDBOOK_UNAVAILABLE`，那是 store 没接线，不是数据丢了。
3. **这一层有没有书**：`curl -s http://127.0.0.1:8787/api/world-book -H 'x-admin-token: ADMIN_PASSWORD'` 看 `items`——同一 `scope` / `scopeId` 可以有多行，每行一个 `bookId`，带 `name`、`enabled`、`entryCount`、`importedAt`。层间仍是 `channel > guild > global` **整层互斥**：频道层只要有一本 `enabled: true` 的书，服务器层与全局层就完全不参与；频道层的书全停用才会落到下一层。层内启用的书**全部同时参与**，不是只取第一本。
4. **条目对不对**：看 `entryCount` 与 `entries` 摘要里的 `enabled` / `constant` / `order` / `position` / `probability` / `group`。`enabled:false` 的条目不参与；非常驻又没有 `keys` 的条目在导入时进了 `ignored`（`reason=noKeys`），不计入 `entryCount`。摘要回这本的全部条目（不含正文），正文在编辑单条时单独取。
5. **回复里有没有 `【世界书】`**：抓一条真实回复的请求体看。四档 system 锚点各自带一次 `【世界书】` 标题（↑Char 在最前、↓Char 在预设段之后、↑AN 在世界书段、↓AN 在 system 末尾），@D 是独立消息、**不带标题**。整段都不存在就是没命中或这层没有启用的书；存在但内容不对，才去查条目。
6. **命中不了先看关键词、扫描窗口与节奏字段**：每条按自己的 `scanDepth ?? 书级默认` 建窗口，默认 4、上限 20，编辑表单里可以直接改；更早的对话不参与触发。`caseSensitive` 为真时大小写要一模一样，`wholeWords` 为真时只有整词算，`selective` 条目还要 `secondaryKeys` 按 `selectiveLogic` 一起命中。另外四件事会让条目「看起来没触发」：`probability < 100` 时掷骰没过、`delay` 还没到轮次、`cooldown` 还在冷却、同 `group` 里权重更高的另一条赢了。想验证这一层通不通，先塞一条 `constant` 条目——它每轮必插，不受关键词、窗口和概率影响。
7. **导入后段数从 46 变 28 是不是丢段**：拿 `Meowssiah_1.9.12.json` 这份真实预设置为基准，旧版导入 46 段、约 9 万字符；`preset-3` 导入是 **28 段、正文合计 4,465 字**，`ignored = {disabled: 17, marker: 8}`。`preset-import-2` 起那 17 段不再进 `ignored`，而是作为停用段一并导入（§58），所以段数会比 28 多、`ignored` 只剩 marker / empty / badRole 三类，后台不再有「预设里关着的段（disabled）」那一栏——看不到这一组是预期，不是丢段。这一版没有动预设导入。
8. **导入后段顺序不对**：先回读 `GET /api/prompts`（`src/workers/http/app.ts:770`，要登录 Cookie）——`items` 里 global 那一项的 `segments` 按 `position` 升序排出来的 `name`，应与酒馆里那条提示词链逐项对得上；对不上再看顺序表取自哪一组：`preset-4` 起取第一个非空的顺序表（`src/core/prompt/sillytavern.ts:136-138`），写在 `100001` 那一组也照样还原，顺序表之外的段接在末尾（`src/core/prompt/sillytavern.ts:231-234`）。

### 34.2 三条回滚路

1. **停用或删掉某一本**（最轻，只影响世界书）：后台「提示词」页「世界书」卡片里每本一行——取消勾选「启用」只让这本不参与，同名同层的书照旧；「删除本书」只删这一本。等价接口：
   - 停用：`curl -X PATCH http://127.0.0.1:8787/api/world-book -H 'x-admin-token: ADMIN_PASSWORD' -H 'content-type: application/json' -d '{"bookId":"<bookId>","enabled":false}'`
   - 删除：`curl -X DELETE http://127.0.0.1:8787/api/world-book -H 'x-admin-token: ADMIN_PASSWORD' -H 'content-type: application/json' -d '{"bookId":"<bookId>"}'`

   注意两处都只认 **JSON body** 里的 `bookId`，不再是 `{"scope","scopeId"}`（旧写法现在会回 `400 BAD_BOOK_ID`）。这一层一本不剩时，system 立刻回到没有世界书的样子（与旧版逐字相同）。
2. **重新导入旧预设**：世界书和预设是两套存储——重导预设只覆盖文本段与 global 深度注入，不动 `world_books` 表；所以「破限变回去了」先把旧预设 JSON 原样再导一次（二次确认里那句「会一并覆盖 global 深度注入」是真的），世界书那层不用碰。反过来要把某一本世界书退回旧版本，`POST /api/world-book/import` 传旧 JSON **会新增一本**（重名加「（2）」），旧的那本要自己停用或删掉。
3. **回滚版本**：把 `src/workers/gateway/engine.ts:133` 的 `GATEWAY_BUILD` 连同镜像一起退回上一版 `worldbook-crud-1`，确认启动日志回到 `build=worldbook-crud-1`。0035 不回滚：旧代码读 `world_books` 时列名已变（这条回滚只适用于「代码已部署但行为不对」的短窗口，真要退回单本时代还得恢复 0035 之前的库备份）。更稳的做法是保留新代码、在后台停用新书。

### 34.3 限制（别当 bug 报）

- 只有关键词触发：没有向量检索、没有递归触发；概率、包含组、粘性、冷却、延迟、扫描深度都已按酒馆口径接上（§51.3、§77）。
- 层间互斥：一次只有一层参与，不是三层相加；层内多本则全部参与。
- 没有总字数上限：旧版 4000 字预算已取消，条目太长会直接占上下文窗口。
- 导入永远是新增：同层重名加「（2）」后缀，不会覆盖旧书；一本书整本导入，条目可在后台逐条改/删/新建。
- @D 的 `depth` 比酒馆差一位：这里 `depth = 0` 是本轮用户消息之前，酒馆是最后一条之后（刻意偏离，见 §51.5）。
- 粘性/冷却按 `bookId + entryId` 记账：删掉再导入同一本书算新书，状态清零。
- 破限还在提示词之外受上游约束：`src/core/providers/gemini.ts` 里没有 `safetySettings`，Gemini 的服务端安全过滤仍可能拦；`{{lastUserMessage}}` 这类宏仍被清空（`CLEARED_MACROS`），预设里依赖它的段会缺内容；除 jailbreak 外 ST 的 nsfw 槽等位置语义仍按 before 处理；导入仍无撤销。

### 34.4 判据

- 迁移：末尾 `0035_world_books_multi.sql`、共 35 个；启动日志 `applied=35 skipped=0`（新库）、`applied=1 skipped=34`（从 34 个升级）或 `applied=0 skipped=35`（已升级）。
- 门牌：`build=worldbook-multi-1`（`src/workers/gateway/engine.ts:133`，`test/gateway.node.test.ts:229` 同步）。
- 数据：`SELECT book_id, scope, scope_id, name, enabled, entry_count, imported_at FROM world_books ORDER BY scope, scope_id, imported_at;` 同一层多行是正常的；`world_book_state` 的 `book_id` 与书对应。
- 请求：system 里出现 `【世界书】` 且后面是命中条目的正文；@D 条目作为独立消息插在历史里，没有标题。
- 台账：`runtime_logs` 同一轮那条 `[chat] turn …` 末尾的 `world=<注入条数>/<参与条数>` 可以快速判断这轮有没有书参与；日志里没有 `world=` 段说明跑的还是很旧的镜像。

## 35. 上下文工具模式（context-stream-1，上一版；现版 `context-tool-6` 见 §37）怎么查

这一版给每个频道加了一个开关：`channel_memory_settings.context_tool`（迁移 `0030_context_tool_mode.sql`，0 = 关、1 = 开）。只有开关打开的频道才走新形状——把预设正文、长期记忆摘要与最近历史塞进 `context` 工具的描述体，`messages` 只发一条固定句「请继续 context 中的互动游戏。」，正文由模型调 `story_reply` 交付。**没打开的频道一个字节不变**（请求、日志、流式与续写都和 `reply-tool-3` 时一样）。上游请求自 `context-stream-1` 起从非流式 `chat()` 改成流式 `chatStream()`（`stream: true`），**但整段攒完才交付**，见下面前四条判据（`docs/architecture.md` §57）。

1. **先对门牌**：`[node] listening … build=context-tool-6`、`[gateway] node host started build=context-tool-6`、`[gateway] alarm build=context-tool-6`。看到 `build=context-stream-1` 说明是这一节讲的那一版、不是现版（现版见 §37）；看到 `build=preset-import-2` 是上一版（§58）；看到 `build=preset-import-1` 或更早说明再往前几档，都没换到这一版。历史小节里写的 `build=reply-tool-3` 是那一版的判据，按当前门牌对号。
2. **唯一核心判据：成功日志尾部有没有 `mode=context`**。这一模式的成功行是 `回复成功 … ms=… len=… mode=context`（`src/core/chat/service.ts:1526`）；没有这个尾标就是老路径。别拿 `len` 判断模式——拒答也可能有正文。
3. **流式不等于会多出中间日志**：`runtime_logs` 里 `mode=context` 那条仍然只在**成功之后**出现一次。上游从 `context-stream-1` 起是流式 `chatStream()`，但分支内一次 `emitProgress` 都不调（推进度的是 `src/core/chat/service.ts:1345` 那个 `else` 分支），所以流式在日志里**看不到任何中间行**。
4. **看到「context 模式没有任何中间进度」是设计如此，不是坏**：这一模式的正文在 `story_reply` 的 `game_content` 里、不在 delta 里，半截参数 JSON 推出去只会是乱码；拼回与解析都要等流结束，那时正文已经有了（`docs/architecture.md` §57.5）。
5. **看到 `空回复重试 n/… model=… key=…`＝模型没调 `story_reply`**（`service.ts:1551-1561`）：正文只在 `story_reply` 的参数里，只调 `context` 或什么都不调，这一轮就是空的。先查模型有没有照着两个工具的 schema 走，再查上游是否把 `tools` 丢了。**重试满 3 次仍落 `EMPTY_RESPONSE`**，说明这一轮流里既没有正文、也没有可用的工具调用（拼不回完整的 `game_content`），不是日志丢了。**`context-tool-6` 起，只调 `context` 交白卷会先补一次交付回合、仍空才重试**，见 §37。
6. **确认开关真的落库**：频道记忆设置的 GET 里 `contextTool` 为 `true`；PUT 时**不传 `contextTool` 等于显式写 0**（`src/workers/http/app.ts:2068-2092`，读侧把 `undefined` 当 `false`），所以整份设置提交必须带当前值。非法值回 `400 BAD_CONTEXT_TOOL`；后台复选框在 `web/src/pages/MemoryPage.tsx:382`（文案 `:385`）。
7. **迁移数**：本版**没有新迁移**，总数仍是 30。新库 `applied=30 skipped=0`；29 个迁移的库升级是 `applied=1 skipped=29`（那是引入 `0030` 的那一版）；30 个迁移的库再跑是 `applied=0 skipped=30`。只加列、不改老列。
8. **线上样本**（2026-11-07，生产 203.0.113.10，样本取于 `build=context-tool-3`）：频道 `<ID-9>` 打开开关（`updated_at 15:51:14`）后 15:52:17 `ms=28091 len=773 mode=context`、15:54:49 `ms=104809 len=844 mode=context`，两条都进角色正文；同频道 15:49:31 关着开关那条 `len=180` 是拒答且没有 `mode=context`。当时这一模式是非流式的（**历史**：`context-tool-1` … `context-tool-5`）；`context-stream-1` 起上游改流式，但仍整段攒完才交付，`ms` 量的还是同一件事（28s / 105s 属正常），别拿它当卡死。
9. **回退**：后台取消勾选即回 `reply-tool-3` 的形状，列留在库里；镜像回退到 `reply-tool-3` 或更早时旧代码忽略这一列，`preset-import-1` 那一版也是这套形状。

## 36. 预设导入写哪一层（preset-import-1，再上一版；`preset-import-2` 见 `docs/architecture.md` §58）怎么查

这一版起导入可以在 global / guild / channel 里选一层（语义与代码见 `docs/architecture.md` §56）；下面是线上排查顺序。

**停用段的判据（`preset-import-2` 起）**：导入结果区会出现一行「其中 N 段是预设里关着的，已按停用导入；要让它们生效，就在下面的列表里逐段打开。」（`web/src/pages/PromptsPage.tsx:403-408`），段列表里这些行未勾选、`enabled=false`。老版本（`preset-import-1` 及更早）没有这句话，反而会在结果里看到 `ignored` 的 `reason='disabled'` 这一类（后台「预设里关着的段（disabled）」分组）——**现在看不到这一组是预期**，那些段已经作为停用段进了段表，不是丢段；要确认就数段表里 `enabled = 0` 的行，或回读 `GET /api/prompts` 里这段的 `enabled`。

1. **先对门牌**：启动日志里 `build=context-tool-6`（`[node] listening … build=context-tool-6` / `[gateway] node host started build=context-tool-6` / `[gateway] alarm build=context-tool-6`）；`build=preset-import-2` 是上一版（§58）、`build=context-stream-1` 是再上一版、`build=preset-import-1` 是再再上一版（能选层，但预设里关着的段仍被丢掉，§58）。**导入只写了 global 层 → 跑的是 `context-tool-5` 或更早**：那些版本把目标 key、存档 id、注入层、响应 `scope` 全写死 global（§56.1），不是参数没生效。
2. **查存档行**：`SELECT id, char_name, imported_at FROM prompt_presets ORDER BY imported_at DESC;` 应该能看到 `latest` / `latest:channel:<ID>` / `latest:guild:<ID>` 多行——导过几层就有几行。**只有一行 `latest` 且刚刚导过非 global 层 = 跑的是旧版**；同一层重复导入只更新那一行、`imported_at` 变新，其它行不动。
3. **查某层有没有被覆盖**：把层换成实际目标层再跑，例如
   `SELECT scope, scope_id, position, name FROM prompt_segments WHERE scope = 'channel' AND scope_id = '<ID>' ORDER BY position;`
   导入后这些段名应来自预设的 `prompt_order`；同时用 `SELECT scope, scope_id, count(*) FROM prompt_segments GROUP BY scope, scope_id;` 对比——**只有目标层那一行变了**。global 层的判据就是 `scope = 'global' AND scope_id = ''`。
4. **查深度注入**：`SELECT scope, scope_id, depth, substr(content, 1, 40) FROM prompt_injections WHERE scope = 'channel' AND scope_id = '<ID>';` 预设里的后指令（jailbreak 等）应该出现在**目标层**这一行；跑到 global（`scope='global' AND scope_id=''`）就是旧版。预设里没有后指令时该层旧注入保持不变（不清空）。
5. **400 BAD_SCOPE 的两种成因**：(a) `scope` 传了但不是 `channel` / `guild` / `global`——含大小写不符（`'GLOBAL'`）或非字符串（`5`）；(b) 非 global 层没给**非空字符串** `scopeId`——缺字段、`''`、数字都算。两种都在**任何写库之前**被拦掉（`src/workers/http/app.ts:948-950`），改对参数重试即可，不用清数据；与 `BAD_PRESET`（JSON 读不出/不是对象）不是一回事。后台在非 global 没填 ID 时本地就拦住、不发请求，抓包看不到请求属正常。
6. **采样参数按层看**：`temperature` / `maxTokens` 从**目标层**旧 `PromptConfig` 继承，不传就看不出版本差异。频道层自己设的 `0.4` 不会被 global 的 `0.85` 顶掉，`maxTokens` 也不会从 global 的 `777` 上浮（`test/prompt.import.test.ts:448-450`）。
7. **迁移**：本版没有新迁移，仍是 30 个；升级只加 `prompt_presets` 表行、不改表结构——启动账本应是 `applied=0 skipped=30`（新库 `applied=30 skipped=0`）。看到 `applied=1 skipped=29` 说明跑的是引入 `0030` 的那一版（`context-tool-1` / `context-tool-3`），详见 architecture §56.8。
8. **回退**：镜像退回 `context-tool-5` 或更早，导入就回到旧口径，目标层固定是 global；已经写进 guild / channel 的段、注入与存档行留在库里但旧代码不读，行为与升级前一致。

## 37. context-tool-6（现版）的判据：补交付回合怎么看

这一版只治一件事：开了 `contextTool` 的频道里，模型只调 `context` 就收尾、一个字正文都不交时，先补一次交付回合再谈重试。契约见 `docs/architecture.md` §59。

1. **想知道有没有补交付，先看 build**：`build=context-tool-6` 才有这段代码；`build=preset-import-2` 及更早没有补交付，只调 `context` 就是空回。门牌对号见 §35 第 1 条与 `docs/hosting.md`。
2. **看到 `空回补交付 model=… key=…`＝这一轮走过补交付**（`src/core/chat/service.ts:1367-1387`）：说明首回合模型只调了 `context`、正文为空。这条 warn 是修复生效的证据，不是故障；成功行仍带 `mode=context`。
3. **连续多轮都出现 `空回复重试` 且每轮 5–11 秒**：上游模型在空转工具回合（`name=context`、`finish=stop`、`completion_tokens` 21–26），先查路由与 key 额度（`argon` 429）；补交付只能救「只调 `context`」这一种空回，救不了额度问题。
4. **回复正常但耗时 60–150 秒**：多半已经落到 `deepseek-v4-pro` 兜底（补交付也空、空回次数用尽后换的候选），不是补交付本身慢。
5. **一次都没看到 `空回补交付`、但确实空回过**：先按第 1 条确认 build；`contextTool` 没开的频道本来就不走这条路径，日志里也没有 `mode=context`。
6. **迁移与回退**：没有新迁移，仍是 30 个，账本 `applied=0 skipped=30`；镜像回退到 `preset-import-2` 即回到「只调 `context` 就是空回」的老行为，数据不动。

## 38. self-name-1（现版）的判据：署名与「你自己」怎么看

这一版只动署名：谁说话用哪个名字、被回复的对象是谁。契约见 `docs/architecture.md` §60。

1. **先对 build**：`build=self-name-1`。更早的门牌（`key-unicode-1` 及以前）没有这段代码：被回复的对象只可能是 `global_name ?? username`，机器人账号没有 `global_name`，所以永远显示账号名「示例机器人」。
2. **判据一**：有人回复机器人自己那条消息时，`messages` 新行的 `reply_to_author` 是 `你自己`；同一行 `reply_to_author_id` 仍是机器人的 user id。
3. **判据二**：其它人的回复署名与落库 `author_name` 都是服务器昵称（载荷 `member.nick`）；没有昵称才退回 `global_name`、再退回账号名，三者全空落「未知用户」。
4. **她还是把某个名字当外人**：先查那个名字在当前频道 `prompt_segments` 里是不是就是她的角色名（分层取频道层，全局默认段不参与）；§60 只保证「被回复对象」与「作者名」的口径，不改预设里的身份设定。
5. **回退**：镜像回退到 `key-unicode-1` 即回到旧口径；没有新迁移（仍 30 个，账本 `applied=0 skipped=30`），库里已经写下的「你自己」不会回改。

## 39. recall-tags-1（现版）的判据：两段记忆的标签怎么看

这一版只加提示词标签：长期记忆套 `<recall>`、短期历史（仅上下文工具模式）套 `<recent>`。契约见 `docs/architecture.md` §61。

1. **先对 build**：`build=recall-tags-1`。更早的门牌（`self-name-1` 及以前）拼出来的描述体里没有任何标签。
2. **标签不进日志、也不进库**：描述体只在请求里，`runtime_logs` 只记 `mode=context`、模型、耗时、长度；`conversation_summaries.summary` 与 `messages.content` 里出现 `<recall>` 只可能是模型自己抄进正文的（见第 4 条）。
3. **要看标签本身**：跑单测——`npx vitest run test/chat.context-tool.test.ts test/summary.logic.test.ts test/chat.summary.test.ts`，看「§61 记忆标签」与 `renderSummaryBlock` 那几条；要直观看线上那一份，把 `service.ts:1229` 的 `contextBody` 临时 `console.log` 一行再重建镜像（看完就撤）。
4. **回复里出现 `<recall>` 或 `<recent>`**：说明模型把标签抄进了正文，现有 `stripWrapperTags` 不剥这两个标签；把这行正文与 `messages.content` 对一下，确认是模型写的而不是我们拼进去的。
5. **普通模式看不到 `<recent>` 是正常的**：这一模式的历史是 `messages` 数组，不是一段文本，标签只包文本块（§61.3）。
6. **标签名已经被人点名了**：`prompt_segments` 里已有三段频道层的「🧪历史回顾」（`position=35`、`placement=before`，频道 `<ID-6>` / `<ID-4>` / `<ID-8>`，2026-11-07T20:16:01Z 起）写着「先从历史记录<recall>和<recent>还有世界设定里回忆…」——**改标签名必须同时改这三段**，否则预设指着一个不存在的块。
7. **回退**：镜像回退 `self-name-1` 即回到旧提示词；没有新迁移（仍 30 个，账本 `applied=0 skipped=30`）。

## 40. history-del-2 的判据：怎么确认「删一条短期记忆」真的删了

这一版给后台加了「历史」页：列出某个频道最近 50 条短期记忆（`messages`），每行一个删除按钮，删的时候**库里那行与 Discord 里那条一起删**。契约见 `docs/architecture.md` §62。

1. **先对 build**：`build=history-del-2`。后台顶部 Tab 里应出现「历史」（在「摘要」与「记忆」之间）；更早的镜像（`recall-tags-1` 及以前）没有这个 Tab，`DELETE /api/messages/:id` 也不存在。
2. **读列表**：填服务器 ID 与频道 ID 后点「读取」，列表按最新在最上面排（接口本身是 id 升序，页面反过来了）。列表为空多半是填错了 key——接口对「这个频道没有消息」和「key 写错」都回空数组。
3. **删一条之后核对三处**：
   - 页面提示里会写 Discord 侧的结局（`已删除` / `Discord 里找不到那条` / `时间窗里有多条一模一样的内容` / `没配 bot token` / `失败（状态码）`）；
   - 库里：`GET /api/summaries/messages?guildId=…&channelId=…` 少了那一行（页面本身也会把它从列表里滤掉）；
   - Discord 里：那条消息真的没了。
4. **Discord 没删掉是允许的**：结局不是 `deleted` 时库里的行**照样删掉了**（顺序是先删 Discord、再删库）。`ambiguous` 说明时间窗里有两条一模一样的内容，代码不猜；`not_found` 多半是迁移 0016 以前的老行（没有 `discord_id`），正文又被编辑过。
   - 结局若是 `skipped`（提示「没接线 Discord 删除」），说明宿主没把 `pruneDiscordMessage` 传进后台 app——两条装配路径 `src/workers/index.ts` 与 `src/node/main.ts` 必须都接（线上跑的是后者）；同时 `deleted` 应为 `true`，回 `false` 而库里那行确实没了，说明 `removeById` 没读到这套库的 `run()` 返回形状。
5. **别指望它动长期记忆**：`conversation_summaries` 一段都不改。要改摘要去「摘要」页。
6. **删错了没有撤销**：这一版只有 DELETE，没有回收站。真要救回来只能从备份里捞（`data/backup-message-<id>.json` 那种单行备份是手工做的，不是这一版的功能）。
7. **回退**：镜像回退 `recall-tags-1` 即回到旧后台；没有新迁移（仍 30 个，账本 `applied=0 skipped=30`），已经删掉的行不会自己回来。

## 41. summary-sweep-2 的判据：怎么确认「连续总结」真的在往前走

这一版在「摘要」页加了一张「连续总结（每批 500 条）」卡片：一批一个请求，页面自动接力到没有未总结原文为止。契约见 `docs/architecture.md` §63。

1. **先对 build**：`build=summary-sweep-2`。更早的镜像（`history-del-2` 及以前）没有这张卡片，`POST /api/summaries/sweep` 也不存在（回 404）。
2. **看进度行**：点按钮并确认之后，卡片上应出现「已总结 X 条 · 还剩 Y 条」。X 只在每批回来后跳一次（不是逐条滚动），Y 是下一批还能吃的量；一批约 30–60 秒，取决于 500 条素材的长度与模型速度。
3. **每批一个请求**：浏览器网络面板里应是「一个 sweep 请求 → 200 → 紧接着下一个」，不是并发一堆。关掉页面就是停：进度已经在 `conversation_summaries.covered_until_id` 里，重新打开再点会从那里继续，不会重做。
4. **接口自检**（不看页面也能验）：带登录 cookie `POST /api/summaries/sweep` body `{guildId, channelId}`，回 200 `{ outcome, remaining }` 表示这批成功；`remaining` 应严格小于上一批的剩余（否则页面会按「没进展」停手，见第 7 条）。
5. **日志**：`runtime_logs` 每批一条 `连续总结 covered=<id> msgs=<n> 剩余=<m>`（`source=summary`），另有原有的 `[chat] 自动摘要完成`；台面「实时日志」页能直接看到。 这一行靠装配层给 `createChatService` 传 `log: sink`（`src/node/main.ts` 与 `src/workers/index.ts` 那四条后台摘要入口都要传）；接口 200 但没有这一行，就是漏了它。
6. **409 / 501 / 502 怎么读**：409 `NO_SUMMARY_MATERIAL` = 游标之后没有原文了（正常收工，不是错误）；501 `SUMMARY_UNAVAILABLE` = 宿主没把 `summarizeSweep` 传进后台 app（两条装配入口 `src/workers/index.ts` 与 `src/node/main.ts` 都要接，线上跑后者）；502 `SUMMARY_FAILED` = 模型侧失败，看 detail，游标没动，再点重试同一批。
7. **剩余不减少会停手**：页面比较前后两批的 `remaining`，本批没让它变小就停下并提示——这说明模型没产出或落库没推进游标，继续发只会空转，先查日志再动。
8. **别拿真实频道试手**：真跑会消耗模型调用并改写该频道的长期记忆。要验证就用一次性频道插几条假消息跑一批，验完把摘要与消息都删掉。
9. **回退**：镜像回退 `history-del-2` 即回到旧后台；没有新迁移（仍 30 个，账本 `applied=0 skipped=30`）。已经追加进 `conversation_summaries` 的段不会自动消失，回退也不会撤回它们。
## 42. bot-name-1 的判据：怎么确认回复署名真的用了服务器昵称

1. **先对 build**：`build=bot-name-1`。更早的镜像（`summary-sweep-2` 及以前）署名恒为 `DC AI BOT`，也没有 `src/workers/discord/bot-name.ts`。
2. **看新消息的署名**：在群里 @ 它说一句话，然后查库里最新那条 assistant 行：`author_name` 应等于该服给它挂的昵称（服务器 `<ID-2>` 上是 `示例角色`），不再是 `DC AI BOT`。
3. **REST 自检**（不看代码也能验）：容器内带 Bot token 打 `GET /guilds/<ID-2>/members/<ID-7>`，回 200 且 `nick=示例角色` 就说明这条规则有料可用；回 404 说明它不在那个服，此时写常量是预期行为。
4. **模板变量也跟着变**：预设或身份模板里若写了 `{{bot_name}}`，system 里出现的应是昵称。名字变了而模板没变，先查是不是命中了常量兜底（私聊 / 无 token / 成员接口失败）。
5. **缓存会骗人**：非空结果永久缓存、空结果缓存 5 分钟（`src/workers/discord/bot-name.ts:9`）。改了 Discord 那边的昵称，要重启进程才看得到新名字——别把它当成「没生效」。
6. **旧行与旧摘要不会自动变**：回填只改 `messages.author_name`（按 guild 分组、回填前备份 `data/backup-assistant-names.json`）；已写好的 `conversation_summaries` 正文一字不改，改了名要重新总结才会进新摘要。
7. **失败是静默的**：成员接口 403/404/超时都只吞成空串，回复照发、日志里没有错误行。怀疑解析没走通，就直接按第 3 条手打那条 GET，或看这台服务器上 `messages` 新行的 `author_name` 是否还是常量。
8. **回退**：镜像回退 `summary-sweep-2` 即回到「署名恒为 DC AI BOT」；回填过的 `author_name` 不会自己改回去，要恢复就按 `data/backup-assistant-names.json` 还原。没有新迁移（仍 30 个，账本 `applied=0 skipped=30`）。

## 43. worldbook-ctx-1 的判据：怎么确认世界书真的进了 context 描述体

1. **先对 build**：`build=worldbook-ctx-1`。更早的镜像（`bot-name-1` 及以前）里 `context` 描述体根本没有 `【世界书】` 这一段。
2. **确认频道真的在用上下文工具模式**：后台「记忆」页该频道的「上下文工具模式」得是开着的；没开就是普通模式，世界书一直都有，跟这次改动无关。
3. **确认库里有书**：`SELECT scope, scope_id, name, entry_count FROM world_books` 得有行——0 行时世界书恒为空串，描述体里当然看不到 `【世界书】`（线上到 2026-11-08 一直是 0 行）。
4. **发一句带关键词的话，再看请求体**：抓中继的 argon 落盘（`/tmp/relay-req-<ms>.json`，临时取证还开着），或直接用后台预览；`context` 工具描述体里应出现 `【世界书】` 段，位置在预设 after 段之后、`<recall>` 之前。
5. **没命中就该干净**：关键词不命中的那一轮，描述体里既不该有 `【世界书】`，也不该多出连续空行——空段由 `composeContextBody` 整段跳过。
6. **命中判定看窗口**：扫描窗口是「最近 `historyMaxMessages` 条未署名原文 + 本轮原话」，条目 `keys` 要在这段里出现；带上时刻与作者名的署名行不参与，避免拿人名当关键词的条目每轮必中。
7. **回退**：镜像回退到 `bot-name-1` 即回到「context 模式不吃世界书」；没有新迁移（仍 30 个，账本 `applied=0 skipped=30`）。

## 44. emoji-body-2 的判据：怎么确认正文真的能发自定义表情

1. **先对 build**：`build=emoji-body-2`（`docker logs dc-ai-bot-bot-1 --since 3m | grep build=`）。旧镜像 `worldbook-ctx-1` 里描述体没有【正文表情】这一段。
2. **确认是开着的**：`GET /api/body-emoji-guides`（带管理员 cookie）里的 `items` 要有行——三层都没配时这段提示词整段不出现，正文照旧不会有 `:名字:`。**默认就是关的**，这是设计而不是故障。
3. **确认频道在用上下文工具模式**：后台「记忆」页该频道的开关得是开着的；普通模式下这次只多了一小段【正文表情】，清单仍是带描述的老样子。
4. **看描述体的顺序**：临时抓一次请求（中继 `/tmp/relay-req-<ms>.json`，或后台预览 `context` 工具描述），顺序应是【世界书】→【可用自定义表情】→【正文表情】→`<recall>`。清单里只有 `:名字:`、没有括号描述与别名——这是刻意的（认图描述进剧情会污染叙述）。
5. **正文里的渲染在网关侧**：模型写 `:名字:` 之后，`resolveInlineEmojis`（`src/workers/discord/emoji.ts:34-52`）在发消息前换成 `<:名字:id>`；名字不在该服表情清单里就原样保留，看到字面 `:名字:` 说明**名字写错了**，不是渲染坏了。
6. **库只看三列**：`SELECT scope, scope_id, prompt FROM body_emoji_guides ORDER BY scope, scope_id`；同一层再 PUT 是覆盖写（不会多一行），`global` 的 `scope_id` 恒为空串。
7. **关掉就用 DELETE**：`DELETE /api/body-emoji-guides` 带 `{ scope, scopeId }`，幂等回 `{ ok: true }`；PUT 收到空串会回 `400 BAD_BODY_EMOJI_GUIDE`——「留空回上一层」只有 DELETE 这一种叫法。
8. **回退**：镜像回退 `worldbook-ctx-1` 即回到「正文只有 `[[react:…]]`」；迁移 `0031` 建的表旧版不读，留着不影响（账本会显示 `applied=0 skipped=31`）。

## 45. prompt-copy-1的判据：怎么确认预设真的搬过去了

1. **先看卡片**：后台「提示词」页上方（预设段编辑器之上）应有一张「复制预设」卡片，四个选择器依次是「来源作用域 / 来源 ID / 目标作用域 / 目标 ID」；来源与目标都选好、ID 填对之前「复制」是禁用的。
2. **点下去要有确认框**：文案是「确定把「<源>」的提示词预设复制到「<目标>」？这会覆盖目标作用域现有的预设：该层原有的段与 temperature / maxTokens 会被整层替换，其它作用域不动。」取消则一个请求都不发。
3. **结果行看两件事**：复制成功后面板上出现「已复制到 <目标>（N 段），内容来源：<来源>」——N 是目标层现在的段数，来源是**实际解析到的那层**（不是你在选择器里选的源）。
4. **源层为空时的来源会变**：来源选频道、而该频道自己没有配置时，接口会顺着 channel > guild > global > 内置默认往下取，结果行里的来源就显示落到了哪层。频道作源需要这个频道在 `messages` 里出现过（接口靠它反查 guild id）；一条消息都没有的新频道会跳过 guild 层，直接落到 global。
5. **同层复制要被拦住**：来源与目标相同（含 `global` 任意 `scopeId`）回 `400 {"error":"SAME_TARGET"}`，面板上显示对应中文提示。
6. **回读两处确认**：目标层 `GET /api/prompts?scope=<toScope>&scopeId=<toId>` 里 `segments` 与 `temperature` / `maxTokens` 应是源那份；同时 `GET /api/prompts?scope=<fromScope>...` 的源层一个字没变——复制只写目标层。
7. **库只看两张表**：`SELECT scope, scope_id, position, name, enabled, placement FROM prompt_segments WHERE scope = '<to>' AND scope_id = '<toId>' ORDER BY position` 与 `SELECT scope, scope_id, temperature, max_tokens FROM prompts WHERE scope = '<to>' AND scope_id = '<toId>'`；复制后目标层是显式配置，之后不再跟随上层。
8. **回退**：镜像回退 `emoji-body-2` 即回到「只能逐层导入」；没有新迁移（总数仍是 31），旧版不认这张卡片也不认这个接口，库结构不变。

## 46. reaction-json-1 的判据：表情选择真的走了结构化输出

1. **中继日志先看一行**：每轮回复之后那条小模型请求前应有 `结构化输出 type=json_schema`，紧接着 `生成参数 [null,null,null,null,null,null,null,"application/json",[6,…,["reaction",[1]]],["reaction"]]`——下标 8 里就是这份 schema；没有 `结构化输出` 这行说明请求根本没带 `response_format`（可能是表情模型被换成了不发这个键的供应商）。
2. **返回的是 JSON**：同一条请求的 `响应形状 text=…` 里，正文应是 `{"reaction":":名字:"}` 或 `{"reaction":"NONE"}` 这种一行 JSON，而不是裸的 `:名字:`。
3. **bot 日志照旧有「表情选择」**：`runtime_logs` 里应出现 `表情选择 model=… value=:名字: ms=…`；`value` 是解析后的表情名（不是整段 JSON），说明 `jsonReactionValues()` 已经取到字段。
4. **NONE 的轮次不贴**：`{"reaction":"NONE"}` 那轮只会有一条 `表情选择 … value=NONE`（或直接无 `贴表情` 行），不会有 `贴表情失败`。
5. **兜底仍然有效**：把表情模型临时换成会回纯文本的通道（或不发 `response_format` 的供应商），`value` 仍应从 `：名字：` 里取出来——解析顺序是 JSON 前缀尝试，失败才逐行读文本。
6. **最坏情况不影响正文**：该路请求 400 时 `askReactionModel()` 只 warn，正文照发，只是这轮没有表情；查到 `表情模型没有可用 Key` 或 provider 报错时按这条判断，不要以为主链坏了。
7. **回退**：镜像回退 `prompt-copy-1` 即回到「只靠提示词自觉回一行」；没有新迁移（总数仍是 31），中继那份 `response_format` 支持留着不影响旧客户端（不带该字段的请求逐字不变）。

## 47. reaction-effort-1 的判据：表情那条支线真的按最低档在跑

1. **中继日志成对出现**：每条表情请求前应有 `思考档位 effort=low level=1 wire=[null,null,null,1]`，紧跟其后的 `生成参数` 末位就是 `[null,null,null,1]`；只有 `生成参数` 没有 `思考档位` 那行，说明这条请求没带 `reasoning_effort`（多半是这条路又被换成了别的调用）。
2. **`include_thoughts` 必须没有**：同一行 `生成参数` 里下标 16 若是 `[1,…]`，模型会把思考摘要写进正文（开头出现「Calculating…」这类元叙述）——看到就叫回滚。
3. **耗时对比**：`runtime_logs` 里 `表情选择 … ms=` 改前常见 6–8s，改后应普遍低一截；数字变小但 `value=` 仍能取到表情名，说明这条支线只是想得快了，没有丢判断。
4. **结构化输出不受影响**：同一轮 `响应形状 text=` 仍应是一行 JSON（`{"reaction":":名字:"}` 或 `{"reaction":"NONE"}`），不是裸文本。
5. **主链没被牵动**：`回复成功 … ms=` 与正文长度跟改前同一量级；这条改动只碰表情请求的构造，主链 `reasoningEffort` 早就在 `src/core/chat/service.ts:1429` 写死。
6. **回退**：镜像回退 `reaction-json-1` 即回到「表情支线按模型默认档位想」；没有新迁移（总数仍是 31），中继不需要动（`thinking_config` 支持留着，不带 `reasoning_effort` 的请求逐字不变）。

## 48. draw-image-4 的判据：画图那一轮图与正文都发出去了

1. **先看门牌**：容器启动回执应有 `build=draw-image-4`（`[gateway] node host started build=draw-image-4`、`[node] listening on :8787 … build=draw-image-4`）；不是这个值说明包没换。
2. **预设里有画图那段**：`sudo sqlite3 /opt/dc-ai-bot/data/dc-ai-bot.sqlite3 "select position,name,enabled from prompt_segments where scope='channel' and scope_id='123456789012345678' and content like '%draw_image%'"` 应返回位置 37 的「画图」段且 `enabled=1`；没有这行就完全不会下发工具。
3. **请求里带了这条工具**：bot 那一轮的中继日志里，`工具定义按上游协议下发 … names=` 应含 `draw_image`（客户端没声明就该没有——这是门控，不是默认能力）。
4. **模型真的调了**：同一轮出现 `响应形状 … calls=draw_image(<参数长度>)`；只回文本没调工具，是模型判断这轮不该画，别当成故障。
5. **生图那行**：bot 日志 `图片回复 model=<实际模型> key=<Key 名或 custom> prompt=<字数> bytes=<字节> ms=<毫秒>`；没有后台生图配置时 `model=` 是 `gemini-nano-banana-2.1`，`key=` 是当前聊天 Key；配了自定义生图 Key 时 `key=custom`。baseUrl 必须真的有 `/images/generations`（线上 `pgl` / `pg` 才有，`ds` 一定 404）。
6. **成功行长这样**：`draw-image-4` 起应是 `回复成功 … len=<正文字数> image=1 …`；中继日志那一轮有两条 `请求`（第一条带 `draw_image`，第二条只带 `story_reply`，末尾消息带「已经发给用户了」）。`len=0` 只在第二段也交白卷时出现，那是纯图兜底。
7. **库里存什么**：有正文就存正文；纯图兜底才存 `[图片]`（长度 4）。
8. **Discord 侧核对**：纯图那条 `content` 为空、附件 `filename:"image.jpg"` / `content_type:"image/jpeg"` / 尺寸非零；有正文时先一条附件消息、紧跟一条正文消息（两段是两个请求，不会合并成一条带 caption 的消息）。
9. **失败怎么分辨**：`图片生成失败 key=ds IMAGE_HTTP 404:` = 那把 Key 的 baseUrl 没有生图端点；`upstream_http_error 上游 HTTP 502` = 上游瞬时抖动，重发一次；`IMAGE_MISSING` = 上游 2xx 但响应里没有图；`IMAGE_BAD_JSON` = 响应不是 JSON（多半是网关错误页）。
10. **事务指纹**：日志里出现 `cannot start a transaction within a transaction` 或「图都生成了却整轮 `ALL_PROVIDERS_FAILED`、`messages` 一行不落」，先查是不是又有人绕过 `batch()` 的排队并发写——§69.5 就是这一条。
11. **回退**：镜像回退到 `draw-image-3` 即回到「台词由 `say` 参数给」（预设第 37 段也要换回带 `say` 的文案）；`draw-image-2` 是只发图；`reaction-effort-1` 是「模型不会画图」；没有新迁移（总数仍是 31），中继的生图端点留着不影响不带该工具的请求。

## 49. timeout-config-1 的判据：后台改的超时真的生效，Gemini 语音真的出 WAV

1. **先看门牌**：容器启动回执应是 `[gateway] node host started build=timeout-config-1` 与 `[node] listening on :8787 … build=timeout-config-1`；还是 `draw-image-4` 说明镜像没换。
2. **迁移到位**：这一版多出 `0033_timeout_settings.sql`，日志 `迁移检查完成 applied=1 skipped=32` 只在第一次出现；`sudo sqlite3 /opt/dc-ai-bot/data/dc-ai-bot.sqlite3 "select name, value from timeout_settings"` 空表 = 还没在后台改过任何一项。
3. **页面读得到**：后台「超时」页打开就是九行 + 一张「全局倍率」卡片；此时每行都显示「（默认）」、`overridden=false`、生效值等于默认值，倍率 1。
4. **保存立刻生效**：把「中继报错查询」改成 2000 保存 → 页面回显生效 2 秒、该行变成「已被后台覆盖」；`select * from timeout_settings` 里应只有 `pgErrors` 一行（改回默认这一行会消失）。再把倍率改成 2 → 每一行的生效值翻倍，而库里的值不变（倍率存在同一个键 `multiplier` 下）。
5. **真的按新值计时**：把「语音合成」改成 5000 保存，再让机器人发一条长语音——bot 日志应是 TTS 超时失败，而不是照旧等 30 秒；把它改回 30000 或「恢复默认」，下一条语音恢复正常。
6. **Gemini 方言出 WAV**：后台「语音」页方言选「Gemini（/audio/speech，WAV）」，地址填 `https://<域名>/pg/v1`、Key 填中继 Key、音色 `Kore`，保存后点试听——返回的 `contentType` 应是 `audio/wav`（openai 方言仍是 `audio/mpeg`）。主频道发一句触发语音：Discord 附件文件名 `voice.wav`、`content_type: audio/wav`；中继日志 `语音合成 model=gemini-3.8-flash-tts voice=Kore chars=… pcm=… chunks=… format=wav ms=…`。
7. **坏输入只回 400**：未登录 GET/PUT/DELETE 都是 401；少一项、给字符串、超出该项上下限、倍率超过 10，全部 `400 BAD_TIMEOUT_SETTINGS`，页面显示「超时值不合法…」而不是把码甩出来。
8. **回退**：页面上「恢复默认」或 `DELETE /api/timeouts` 清表即回到 `.env` 与内置默认；镜像回退到 `draw-image-4` 时，0033 只是多一张空表，旧代码不读它。注意 0032 重建过 `tts_settings`（CHECK 加了 gemini），回退镜像前先确认表里没有 `dialect='gemini'` 的行，否则旧代码读侧会把它当 openai。

## 50. voice-hint-preset-1 的判据：context 模式下「按指令」真的发出语音

1. **先看门牌**：容器启动回执应是 `[gateway] node host started build=voice-hint-preset-1`；还是 `timeout-config-1` 说明镜像没换。
2. **前置状态**：`voice_settings` 至少一行 `mode=1`（本版线上是 `global / voice=Kore / speed=100 / director=1`），`tts_settings` 是 `dialect=gemini`、`url=https://relay.example.com/pg/v1`。
3. **发一条要语音的消息**（例如「用语音回我一句」），然后看三处：
   - `runtime_logs` 紧随「回复成功」应有一行 `[voice] 已发送 tag=… bytes=… 字数=… mode=… director=…`（gateway、info）；没有这行说明模型没写 `[[voice]]`（提示段没进 system）或开关不是 1。
   - `/chat` 那行 `turn … systemLen=` 在上下文模式 + 语音提示时为 142（`CONTEXT_TOOL_SYSTEM` 85 + 语音段 57），不带提示时是 85。85 说明 `voiceHint` 没挂上。
   - 中继日志 `语音合成 model=gemini-3.8-flash-tts voice=Kore chars=… pcm=… chunks=… format=wav ms=…`，其字节数应与 Discord 附件 `voice.wav`（`audio/wav`，44 字节 RIFF 头 + PCM）对得上。
4. **反面判据**：正文里出现 `[[voice]]` 字样 = 剥离没生效；有语音附件但中继没有合成日志 = 附件不是这次合成的。
5. **预设优先（voice-hint-preset-1 起）**：预设正文里写了 `[[voice]]` 就不再加代码那段，`systemLen` 会回到 85（上下文模式）——这时判「提示到没到」要看描述体里的预设原文，而不是 system 长度；预设没写则仍是 142。
