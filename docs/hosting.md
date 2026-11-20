# 自托管运行手册（Ubuntu + Node）

> 这份文档是**照着做就能跑起来**的操作单：从一台空 Ubuntu 到 `https://example.com` 上线，
> 再把 Cloudflare 上的数据和 Discord 入口搬过来。
> 架构层面的"为什么"（双轨、`SqlDatabase` 契约、网关单一 timer）在
> `docs/architecture.md` §30，这里只讲"怎么做"。

- 目标形态：一台小机器（t3.micro 1 GiB 够用；本次生产实际是 m7i-flex.large 8 GiB，见 §12）跑 `docker compose`，两个容器 —— `bot`（Node 22 单文件 `dist/server.mjs`）+ `caddy`（自动 HTTPS）。
- 公网地址：**不绑弹性 IP**，用实例当前的动态 IP，靠 systemd 定时器把 A 记录跟住它（见 §14）；IP 变了最多 2 分钟自愈。
- 数据：一个 SQLite 文件 `./data/dc-ai-bot.sqlite3`，没有别的状态（网关不落盘任何东西，重启即全新 IDENTIFY）。
- 附属服务：`pg-relay`（Gemini playground 执行器接入层，独立 compose 项目 `/opt/pg-relay`）。
- 门牌：`GATEWAY_BUILD = 'memory-unlimited-1'`（`src/workers/gateway/engine.ts:136`）。日志里看到
  `[node] listening on :8787 db=... build=memory-unlimited-1` 与 `[gateway] node host started build=memory-unlimited-1` 才算这一版在跑
  现版为 `memory-unlimited-1`：记忆注入不再有字数预算，全部累积记忆进 prompt；没有新迁移、总数仍 45。上一版 `reply-full-1`（Discord 当前轮引用全文），再上一版 `executor-control-1`。

## 0 开工前必须知道的四件事

1. **`KEY_ENCRYPTION_SECRET` 必须与 Cloudflare 线上现用的值逐字节一致。** 库里存的厂商 API Key 是用它
   AES-256-GCM 加密的（`provider_keys` 表），填错不是"重新登录"而是"全部解不开、只能逐条重填"。
   详见 §3 的警告框。
2. **同一个 bot token 不能双开长连接。** 必须先把 Cloudflare 那套停掉，再起这台；中间机器人会离线 30–60 秒（§9）。
3. **迁移文件在镜像里，不用挂载。** runner 阶段会把仓库的 `migrations/` 一起拷进 `/app/migrations`（§5），
   升级镜像就带最新迁移；跑过哪些记在库里的 `_migrations` 表，重启只补没跑过的。
4. **Cloudflare 那套不要删 `wrangler.toml`、不要动 D1。** 它是最好的回退路径：自托管出问题时
   `npx wrangler deploy` 就能回去（§10.4）。

---

## 1 机器准备

### 1.1 系统与内核

Ubuntu 26.04 LTS，t3.micro（2 vCPU / 1 GiB / 8 GB 磁盘起）。1 GiB 内存跑 `npm ci` + vite + esbuild
必然吃 swap，**先加 2 GB swap 再干活**（`Dockerfile` 已经把构建堆上限压到 512 MB，但没 swap 仍可能被 OOM killer 干掉）：

```bash
# 2 GiB swap 文件，重启后自动挂
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 内存吃紧时优先换出匿名页，别把 SQLite 的页缓存顶掉
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
sudo sysctl --system

free -h          # 确认 Swap 那行不是 0
```

### 1.2 打补丁、开防火墙

```bash
sudo apt update && sudo apt -y upgrade

sudo ufw allow OpenSSH
sudo ufw --force enable
sudo ufw status verbose
```

80/443 等 Caddy 起来之前再放（§7），现在放开只会让扫描器先来：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp     # HTTP/3
```

---

## 2 装 Docker（官方 apt 源，含 compose 插件）

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER"     # 重新登录（或 newgrp docker）才生效
docker compose version               # 有输出即 compose 插件到位
```

> 如果 `apt-get update` 报 Docker 源 404：说明该 Ubuntu 版本的 codename 在 Docker 源里还没发布。
> 把上面的 `$VERSION_CODENAME` 换成 Docker 已发布的最近一版（如 `noble`）即可，装出来的 Docker 一样能用。

---

## 3 取代码与填配置

### 3.1 落代码

```bash
git clone <仓库地址> dc-ai-bot
cd dc-ai-bot
```

没有远端可拉时，从本机把工作区传上去（`node_modules`/`dist`/`.wrangler` 会被 `.dockerignore` 挡住，不必排除）：

```bash
# 在本地执行
scp -r "DC AI BOT" ubuntu@<服务器IP>:/home/ubuntu/dc-ai-bot
```

### 3.2 填 `.env`

```bash
cp .env.example .env
chmod 600 .env
```

`.env` 里六个 secret 逐项对照（值从 Cloudflare / Discord 后台取，**不要自造**）：

| 变量 | 从哪来 | 能不能改 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → Bot → Reset Token | 只能由 Discord 轮换；改完必须同步改后台 |
| `DISCORD_PUBLIC_KEY` | Developer Portal → General Information | 不能改，跟应用绑定 |
| `DISCORD_APPLICATION_ID` | 同上（纯数字） | 不能改 |
| `ADMIN_PASSWORD` | 自己定，后台登录口令 | 随时可改，重启容器生效 |
| `SESSION_SECRET` | 自己生成，≥32 字符随机串 | 可改，代价是所有人被踢下线 |
| `KEY_ENCRYPTION_SECRET` | **Cloudflare 线上现用的同一个值** | **绝对不要改**（见下） |

剩下的非 secret 项按默认即可：`PORT=8787`、`DB_PATH=/data/dc-ai-bot.sqlite3`、
`SITE_ADDRESS=example.com`、`ACME_EMAIL=<你的邮箱>`（必填，邮箱留空会让 Caddyfile 的全局块解析失败）。

**语音回复是可选功能**：现行（`memory-unlimited-1`）TTS / 音乐 / 音效 / 变声四个模型仍都可在「语音」页修改，空串回落内置默认；详细契约见 `docs/architecture.md` §90。

> ⚠️ **`KEY_ENCRYPTION_SECRET` 必须与 Cloudflare 上现用的值逐字节一致**
>
> - 它是厂商 API Key 的 AES-256-GCM 主密钥（32 字节随机数的 base64，形如 `openssl rand -base64 32` 的输出）。
> - 库里（`provider_keys` 表）存的是**密文**。换个值不会报错，只会让所有已存 Key 解密失败：
>   后台 Key 列表打不开、聊天请求全部 500。
> - 复制时注意三个坑：**末尾的 `=` 不能丢**、**不要多一个换行**、**不要"顺便"重新生成**。
> - 万一真的丢了：已存的 Key 无法恢复，只能在后台逐条重填；届时应先轮换厂商 Key 再填。
> - 迁移完用一条真 Key 试一次"连通性测试"：能列出模型就说明这个值对了。

```bash
# 校验没有多余空白/换行（长度应当是 44，末位是 =）
awk -F= '/^KEY_ENCRYPTION_SECRET=/{print length($2)}' .env
```

---

## 4 数据目录属主

容器里跑的是 `USER node`（uid/gid 1000）。`./data` 由宿主机创建，属主默认是你的登录用户；
**不授权给 1000 的话 SQLite 直接 `SQLITE_CANTOPEN`**：

```bash
mkdir -p data
sudo chown -R 1000:1000 data
ls -ln data      # 两列 uid/gid 都应是 1000
```

---

## 5 `migrations/` 在镜像里，不用挂载

运行镜像会把仓库的 `migrations/` 一起打进去（`/app/migrations`），入口启动时从工作目录读它、把没跑过的
按文件名顺序执行一遍。**迁移文件已打进镜像，无需挂载；升级镜像即带最新迁移**——不需要
`docker-compose.override.yml`，也不需要额外挂卷（`./data:/data` 那条基础 `docker-compose.yml` 已经带了）。

- 升级：`git pull && docker compose up -d --build`，新迁移随镜像生效（§10.1）。
- 幂等：账本是库里的 `_migrations` 表，每次启动只补没跑过的，跑过的一律跳过。
- 想确认镜像里到底有哪些迁移：`docker compose exec bot ls migrations`。
- 唯一要手工介入的例外：**表已经建好、但 `_migrations` 是空的**（D1 带 schema 全量导出后再导入），
  用 `--mark-migrations-applied` 认账（§8.5），别让它重放 `CREATE TABLE`。

---

## 6 起服务与健康检查

```bash
docker compose up -d --build          # 首次在 1 GiB 机器上大约 3–8 分钟
docker compose logs -f bot
```

正常启动依次出现（顺序固定）：

```text
[node] 迁移检查完成 applied=44 skipped=0
[node] listening on :8787 db=/data/dc-ai-bot.sqlite3 build=memory-unlimited-1 web=/app/dist/web/
[gateway] node host started build=memory-unlimited-1
[gateway] IDENTIFY intents=37376 → wss://gateway.discord.gg/?v=10&encoding=json
gateway HELLO heartbeat_interval=41250ms → IDENTIFY(op2) intents=37376
```

从 29 个迁移的库升到 30 个迁移时（`context-tool-1` / `context-tool-3` 那一版）先多这两行，顺序在 `listening` 之前：

```text
[node] 迁移已执行：0030_context_tool_mode.sql
[node] 迁移检查完成 applied=1 skipped=29
```
更早的 `voice-quote-only-1` 新增了 `0041_voice_quote_only.sql`：从 40 个迁移的库升级会多 `迁移已执行` 与 `applied=1 skipped=40` 两行，升级后再重启就是 `applied=0 skipped=41`；这一版给 `voice_settings` 加 `quote_only INTEGER NOT NULL DEFAULT 1`，后台决定语音只念引号台词还是整段照念，默认仍是只念引号。上一版（`qq-group-history-1`）没有新迁移：从 40 个迁移的库升级仍是 `applied=0 skipped=40`；那一版让 QQ 群未 @ 的消息也写入当前绑定的共享历史，只落库、不回话。上一版（`summary-model-1`）**有新迁移 `0040_summary_model.sql`**：从 39 个迁移的库升级会多 `迁移已执行` 与 `applied=1 skipped=39` 两行，升级后再重启就是 `applied=0 skipped=40`；这一版新建单行表 `summary_model`，只存摘要/补记要用的全局 provider + model，未配置时摘要仍走聊天路由。上一版（`summary-platform-1`）**有新迁移 `0039_message_platform.sql`**：从 38 个迁移的库升级会多 `迁移已执行` 与 `applied=1 skipped=38` 两行，升级后再重启就是 `applied=0 skipped=39`；这一版给 `messages` 加 `platform` / `platform_kind` 两列（老行空串 = 没记过平台，不猜），只影响摘要素材，不改已有记忆段。再上一版（`platform-anchor-1`）没有新迁移：从 38 个迁移的库升级仍是 `applied=0 skipped=38`；那一版在 QQ 与 Discord 的 system 天头加平台锚点。再上一版（`qq-bridge-1`）才有 `0038_qq_bridge.sql`：从 37 个迁移的库升上来会多 `迁移已执行` 与 `applied=1 skipped=37` 两行，升级后再重启就是 `applied=0 skipped=38`；那一版新建 `conversations` / `conversation_links` / `qq_presets`，并从已有频道播种会话，`messages` 的键不变。QQ 凭证来自 `.env` 的 `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`，缺了只记「QQ 渠道不启用」。

上一版（`route-reasoning-1`）**有新迁移 `0037_route_reasoning.sql`**：从 36 个迁移的库升上来会多这两行，账本是 `applied=1 skipped=36`；升级后再重启就是 `applied=0 skipped=37`。这一版只给 `routes` 加一列 `reasoning_effort TEXT`（NULL = 这一层不设），不改老行的值。

历史版本的部署包、备份与生产回执不随仓库发布。

- 现版迁移总数 45；生产部署与回执不随仓库发布。
- `0041_voice_quote_only.sql` 给 `voice_settings` 加 `quote_only INTEGER NOT NULL DEFAULT 1`（1 = 只念引号台词，默认；0 = 整段照念，旧库不回填），见 `docs/architecture.md` §88。
- `0040_summary_model.sql` 建单行表 `summary_model`（`id INTEGER PRIMARY KEY CHECK (id = 1)` 加 `provider` / `model` / `updated_at`），存摘要与补记要用的全局模型；没有配置行时摘要走聊天路由，见 `docs/architecture.md` §86。
- `0039_message_platform.sql` 给 `messages` 加 `platform` / `platform_kind`（TEXT NOT NULL DEFAULT ''）：老行空串表示没记录，摘要不补猜；新行由 QQ / Discord 入口写入平台，见 `docs/architecture.md` §85。
- 现版标记是 `build=memory-unlimited-1`；上一版 `reply-full-1`，再上一版 `executor-control-1`；迁移总数 45（`0045_qq_quote_index.sql` 已应用）。
- **用 Windows 侧的 `git archive` 打包上传时，必须先 `git -c core.autocrlf=false archive`**：`core.autocrlf=true` 的检出会让 archive 把 LF 翻成 CRLF，`*.sh` 的 shebang 变成 `#!/usr/bin/env bash\r`，systemd 启动报 `env: $'bash\r': No such file or directory`（退出码 127），脚本一行都不执行、请求文件也不会被消费。仓库根的 `.gitattributes` 已把 `*.sh`/`*.service`/`*.timer` 钉成 `eol=lf`。

**健康检查**：`bot` 的 8787 只在 compose 网络里，**没有发布到宿主机**，所以 `curl http://127.0.0.1:8787`
连不上是正常的。三种查法任选：

```bash
# ① 进容器问自己（最直接，绕开证书与入口）
docker compose exec bot node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(t=>console.log(t))"

# ② 从 Caddy 容器走 compose 网络
docker compose exec caddy wget -qO- http://bot:8787/api/health

# ③ 走域名（证书签发成功之后才有意义）
curl -fsS https://example.com/api/health
```

期望输出：`{"ok":true,"version":"0.1.0"}`。

首页也是同一套检查：`curl -fsS https://example.com/ | head -3` 应该是一页 HTML（SPA 回退），
后台在 `https://example.com/admin`，用 `ADMIN_PASSWORD` 登录。

---

## 7 DNS 与证书

### 7.1 先把记录设成 DNS only（灰云）

Cloudflare DNS 里给 `example.com` 建 A 记录指向服务器公网 IP，**Proxy status 必须是 DNS only（灰云）**，
TTL 自动即可。原因：Caddy 用 HTTP-01 签证书，走橙云时请求由 Cloudflare 边缘代答，
验证路径极易变成"边缘 ↔ 源站"的循环重定向（`ERR_TOO_MANY_REDIRECTS`），Caddy 一直拿不到证书。

```bash
dig +short example.com          # 应当直接是服务器 IP
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
docker compose up -d               # 起 caddy
docker compose logs -f caddy       # 等 "certificate obtained successfully"
```

证书拿到后 `docker compose ps` 里 caddy 是 healthy，`curl -I https://example.com/` 返回 200。

### 7.2 证书稳了以后是否回橙云

可以，但要先改这三处，否则一定出问题：

1. **SSL/TLS 加密模式改 `Full (strict)`**（不要 Flexible）——Caddy 侧是真证书，Flexible 会造成无限重定向。
2. **关掉或确认 `Always Use HTTPS` 的行为**：边缘已经在跳 HTTPS，源站 Caddyfile 的 `@entrypoint` 规则
   也会加 `no-cache`；两边同时插 `Strict-Transport-Security` 没问题，但要避免"边缘 HTTP → 源站 308 → 边缘"这类环。
3. **别让 Cloudflare 缓存 `/api/*` 与 `/interactions*`**：Caddyfile 已经给这两类打了 `no-store`，
   但橙云下要在 Cloudflare 侧确认没有 Page Rule / Cache Rule 强制缓存它们（Discord 交互签名请求被缓存就是 401）。

另外：橙云后 HTTP-01 续期仍能工作（端口 80 会转发到源站），但如果你想彻底躲开边缘，
可以改成 DNS-01（Caddy 的 `tls` 指令 + Cloudflare DNS 插件）——那是另一套配置，不在本文范围。

---

## 8 数据搬迁：从 D1 到 SQLite

**原则**：先让服务端用迁移把 11 张表建出来 → 停服务 → 灌数据 → 再启动。
`wrangler d1 export` 用 `--no-schema` 只导数据（DDL 由迁移负责），所以灌进空库会全部
`no such table` —— 顺序不能反。**导入时 bot 必须停着**：两边同时写同一个 SQLite 文件会把库写坏。

### 8.1 第 1 步：在 Cloudflare 侧导出（你的机器上，需要 wrangler 已登录）

库名以仓库 `wrangler.toml` 为准：`database_name = "dc-ai-bot"`（绑定的 binding 是 `DB`，
`database_id = <D1_DATABASE_ID>`）。

```bash
npx wrangler d1 export dc-ai-bot --remote --no-schema --output=d1-export.sql
```

- `--remote` = 线上库（省略就是本地 `.wrangler/state` 那份，别搞错）。
- `--no-schema` = 只导数据。表结构由 `migrations/` 建，避免 `CREATE TABLE` 撞车。
- 产出里会混着三类 D1 专有行，导入脚本会自动跳过（见 8.3）。

### 8.2 第 2 步：传到服务器

```bash
scp d1-export.sql ubuntu@<服务器IP>:/home/ubuntu/dc-ai-bot/
```

### 8.3 第 3 步：建表 → 停服务 → 导入 → 再启动

```bash
cd /home/ubuntu/dc-ai-bot

# ① 先让迁移把表建出来（首次启动一次即可；看到 applied=28 就 Ctrl-C 也行，用 -d 起的话见 §6）
docker compose up -d --build
docker compose logs bot | grep '迁移检查完成'      # applied=28 skipped=0

# ② 停服务：导入期间绝不能有第二个写入者
docker compose stop bot

# ③ 导入（先确认属主，容器里是 uid 1000）
sudo chown -R 1000:1000 data
docker compose run --rm --no-deps \
  -v "$PWD:/work:ro" \
  bot node /work/scripts/import-sql.mjs /data/dc-ai-bot.sqlite3 /work/d1-export.sql

# ④ 再启动
sudo chown -R 1000:1000 data
docker compose up -d
```

`scripts/import-sql.mjs` 做的事（`node scripts/import-sql.mjs <sqlite 文件> <导出.sql>`）：

- 逐行过滤掉三类 D1 导出专有内容：`PRAGMA defer_foreign_keys=TRUE`（只对 D1 那次导出批有意义）、
  `INSERT INTO "d1_migrations"`（D1 的账本，Node 侧用 `_migrations`）、
  `INSERT INTO "sqlite_sequence"`（`AUTOINCREMENT` 会按导入后的 `max(rowid)` 自行恢复）。
- 其余 `INSERT` 在**一个事务**里执行，任何一条失败整批回滚，并打印"第几条语句"与出错语句的前 200 字符。
- 成功后打印每张表的行数，直接和导出侧对账。

服务器上没有 `node` 也能导入：上面的 `docker compose run ... bot node ...` 用的就是 bot 镜像里的 Node 22；
如果本机装了 Node ≥ 22.13，也可以直接在宿主机跑 `node scripts/import-sql.mjs data/dc-ai-bot.sqlite3 d1-export.sql`。

### 8.4 对账参照（本次生产导出的真实规模，不是期望值）

```text
文件 727 KB、1659 条 INSERT、跳过 15 行
messages 1463 / runtime_logs 147 / emoji_descriptions 36 / prompts 4 / emoji_aliases 3
conversation_summaries 2 / provider_keys 1 / reaction_model 1 / routes 1 / channel_memory_settings 1
```

导入后 `provider_keys` 的密文能不能解开，取决于 `.env` 里的 `KEY_ENCRYPTION_SECRET`：
这一份导出已实测用 Cloudflare 现用值灌进 `node:sqlite` 后 11 个迁移全绿、行数与导出完全一致、
密文能解出明文。也就是说 §3 那条"逐字节一致"的要求是硬要求，不是保守建议。

### 8.5 `--mark-migrations-applied` 什么时候用

**只在"库里的表已经建好，但 `_migrations` 账本还是空的"这种情况下用**，否则 `runMigrations`
会在第一个 `CREATE TABLE` 上撞 `table already exists`。典型两种：

- 你用的是**带 schema 的导出**（去掉了 `--no-schema`），灌完后表已存在、账本是 D1 的 `d1_migrations`；
- 手工建过表、或者从别处拷了一份库过来。

```bash
docker compose stop bot
docker compose run --rm --no-deps bot node dist/server.mjs --mark-migrations-applied
# [node] mark-migrations-applied db=/data/dc-ai-bot.sqlite3 marked=11
# [node] 新认账：0001_init.sql, ..., 0011_summary_span.sql
# [node] 未执行的迁移已全部记为已执行，不会重放任何 SQL
docker compose up -d
```

这个开关只记账、不跑任何 SQL、也不要求六个 secret 齐全（只需要 `DB_PATH`），跑完退出码 0。
按 §8.3 那条路（`--no-schema` + 先建表）走的，**不需要**它。

---

## 9 切换 Discord 入口

### 9.1 先停旧的（不能双开）

同一个 bot token 起两条 Gateway 长连接，Discord 会互相踢；更糟的是 D1 和 SQLite 变成两份库，
消息分流写入、记忆错乱。所以顺序是**先停旧、再切入口**：

```bash
npx wrangler delete --name dc-ai-bot      # 或在 Cloudflare 面板里把 Worker 停掉/删掉
```

`wrangler.toml` 不要删、D1 不要删 —— 它们是回滚用的（§10.4）。

### 9.2 改 Interactions Endpoint URL

Discord Developer Portal → 你的应用 → **General Information** → **Interactions Endpoint URL**：

```text
https://example.com/interactions
```

点 **Save** 时 Discord 会立刻向这个地址发一次 PING，**必须已经拿到证书、bot 容器在跑**，
否则报 `The specified interactions endpoint url could not be verified`（签名对不上也会报同一句，
多半是 `DISCORD_PUBLIC_KEY` 填错）。

- 路径要写 `/interactions`；`/discord/interactions` 也认（两个都在 `INTERACTION_PATHS` 里）。
- 离线窗口：旧连接断开后 Discord 需要 30–60 秒清掉 presence，这段机器人显示离线，属正常。
- 斜杠命令走这条 HTTP 入口；普通消息聊天走 bot 自己的 Gateway 长连接，两者都要通才算完整切换。

### 9.3 验收

```bash
docker compose logs --tail=50 bot | grep -E '\[node\]|\[gateway\]'
#   [gateway] IDENTIFY ...          连上了
#   [gateway] node host started build=memory-unlimited-1   心跳在跳、门牌是这一版
```

然后在 Discord 里：发一条普通消息（应回复）、跑一次 `/summary`（HTTP 入口通）、
贴一个表情（网关事件通）。三样都通即切换完成。

---

## 10 日常运维

### 10.1 升级

```bash
cd /home/ubuntu/dc-ai-bot
git pull
docker compose up -d --build
docker compose logs -f bot | grep -E '迁移检查完成|listening on'
```

- 迁移是幂等的：新版本带来的迁移会在启动时自动补上（`applied=N`），已记账的跳过。
- 升级期间 bot 会短暂离线（容器重建），不需要动 Discord 后台的 URL。

### 10.2 备份

每日备份已经配好（§17）：每天北京时间 04:00 由 `dc-ai-bot-backup.timer` 把一致性快照推到 Google Drive。
下面这些是手工留档 / 排错时的做法。

数据库就一个文件，备份 = 拷它。**先停容器**（或至少确认没有写入），否则可能拷到半条事务：

```bash
docker compose stop bot
cp data/dc-ai-bot.sqlite3 "data/backup-$(date +%F-%H%M).sqlite3"
docker compose start bot
ls -lh data/                     # 注意可能还有 -wal / -shm，一起拷才最保险
```

装了 `sqlite3` CLI 的话，不停机也能做一致性快照（自动备份走的就是这条路）：

```bash
sqlite3 data/dc-ai-bot.sqlite3 ".backup 'data/backup.sqlite3'"
sqlite3 data/backup.sqlite3 "PRAGMA integrity_check;"     # 必须是 ok，不是就别拿去恢复
```

不想等定时器，手跑一遍完整流程（含上传与保留策略）：

```bash
sudo DRY_RUN=1 /opt/dc-ai-bot/bin/backup-to-drive.sh    # 只快照+打包，不碰网盘
sudo /opt/dc-ai-bot/bin/backup-to-drive.sh
sudo journalctl -u dc-ai-bot-backup.service -n 30 --no-pager
```

> 备份包里**没有 `.env`**：里面是 Discord token、管理员密码、`KEY_ENCRYPTION_SECRET`，网盘上不该有秘密。

### 10.3 看日志

```bash
docker compose logs -f --tail=200 bot            # 跟随
docker compose logs --since 1h bot | grep gateway
docker compose logs --tail=100 caddy             # 证书 / 入口问题看这里
docker compose ps                                # 容器状态与重启次数
```

日志已经按 `json-file` 限了 10 MB × 3 个文件，不会把 8 GB 磁盘写满。

### 10.4 回滚到 Cloudflare

```bash
# ① 回 Cloudflare（.wrangler 凭据在的话一条命令）
npx wrangler deploy

# ② Discord Developer Portal 把 Interactions Endpoint URL 改回 Worker 地址
#    https://dc-ai-bot.<你的子域>.workers.dev/interactions

# ③ 停本机服务（否则两边同时持有同一个 bot token 的长连接）
docker compose down
```

⚠️ **回滚会丢自托管期间的新数据**：云端的 D1 只到今天导出那一刻。
自托管跑过之后产生的消息、日志、总结都在 `data/dc-ai-bot.sqlite3` 里，要带走就反向导：

```bash
sqlite3 data/dc-ai-bot.sqlite3 .dump > reverse.sql   # 再按 wrangler d1 execute --remote --file 灌回 D1
```

保守做法：切换前先按 §10.2 备一份，回滚当天再备一份。

---

## 11 排错速查

| 现象 | 原因与处理 |
| --- | --- |
| `[node] 迁移失败（目录 migrations 必须在工作目录下）` | 跑的是旧镜像（没有 `migrations/`）：`git pull && docker compose up -d --build` 重建；`docker compose exec bot ls migrations` 应能看到 `0001_init.sql`（§5） |
| `SQLITE_CANTOPEN` 或 `unable to open database file` | `data/` 属主不是 1000：`sudo chown -R 1000:1000 data`（§4） |
| `[node] 配置不完整：缺环境变量：XXX` | `.env` 少了那一项，或改完没重启容器（`docker compose up -d` 会重建） |
| 后台 Key 列表报解密失败 / 聊天全 500 | `KEY_ENCRYPTION_SECRET` 与 Cloudflare 现用值不一致（§3 警告框） |
| 启动撞 `table already exists` | 库里表已建好但账本为空 → 先跑 `--mark-migrations-applied`（§8.5） |
| Caddy 反复签不到证书 / `ERR_TOO_MANY_REDIRECTS` | DNS 还是橙云 → 改 DNS only（灰云），放行 80/443，重试（§7.1） |
| `[gateway] 连接关闭（code 4004）` 一直退避重连 | `DISCORD_BOT_TOKEN` 无效/已轮换；同时检查旧 Worker 是不是还在跑同一个 token |
| bot 回复重复、行为像两个人在抢 | Cloudflare 那套没停干净（§9.1）：同一 token 不能双开 |
| Discord 保存 Interactions URL 报 "could not be verified" | 证书没通 / 容器没起 / `DISCORD_PUBLIC_KEY` 填错 |
| 页面 404 但 `/api/health` 正常 | `dist/web` 没进镜像（重建镜像）；日志里会有 `[node] 静态目录不存在` 警告 |
| 容器被 OOM killed（`docker inspect` 看 `OOMKilled=true`） | 确认 swap 已开（§1.1）；`mem_limit` 是 640m，构建阶段不吃这个限制 |
| 停服务后要等 25 秒才退出 | 有在飞请求/后台任务没排空；超过 25 秒会强制退出（`[node] 优雅退出超过 25000ms，强制结束`） |

---

## 附：整套命令一路抄下来

```bash
# 1) 系统
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile
sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo apt update && sudo apt -y upgrade
sudo ufw allow OpenSSH && sudo ufw --force enable

# 2) Docker（见 §2 完整命令）
# 3) 代码与 .env（见 §3，KEY_ENCRYPTION_SECRET 必须与线上一致）
# 4) 目录属主
mkdir -p data && sudo chown -R 1000:1000 data

# 5) migrations 已在镜像里（见 §5），无需挂载

# 6) 起服务
docker compose up -d --build
docker compose logs -f bot

# 7) 健康检查（8787 不出 compose 网络）
docker compose exec bot node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(t=>console.log(t))"

# 8) DNS 灰云 + 放行 80/443 → 等 Caddy 证书 → curl -I https://example.com/

# 9) 迁移数据（§8）：导出 → scp → 建表 → stop → import-sql.mjs → up -d → 对账

# 10) 停旧 Worker（wrangler delete）→ 改 Interactions URL 为 https://example.com/interactions
```

---

## 12 EC2 部署的实际记录（2026-10-27，同一台机器，最终形态见 §14）

手册前面是「通用做法」，这一节是这台机器的**实际参数**，排错时先看这里。

### 12.1 机器与网络

| 项目 | 实际值 |
| --- | --- |
| 实例 | `i-0459e3c0060d93ece`（名字 Discord bot），us-east-2（俄亥俄） |
| 机型 / 系统 | **m7i-flex.large**（2 vCPU / 8 GiB，不是 t3.micro），Ubuntu 26.04.1 LTS，内核 7.0.0-1014-aws |
| 内网 IP | `10.0.0.12` |
| 公网 IP | 弹性 IP **203.0.113.10**（已从动态 IP 换成 EIP，防重启后解析失效） |
| 域名 | `example.com` → A 记录 → 203.0.113.10，**DNS only（灰云）** |
| 证书 | Let's Encrypt，`tls-alpn-01` 自动签发，ACME 邮箱 `admin@example.com` |
| 代码目录 | `/opt/dc-ai-bot`（`.env` 故意不带 dot 前缀，权限 600） |
| 数据库 | `/opt/dc-ai-bot/data/dc-ai-bot.sqlite3`，属主 `1000:1000`，权限 640 |
| compose 项目名 | `dc-ai-bot`（容器 `dc-ai-bot-bot-1`、`dc-ai-bot-caddy-1`） |

### 12.2 切换当天的顺序（留档，回滚时反着看）

1. 本地 `npx wrangler d1 export dc-ai-bot --remote --no-schema` → `data/prod-data-2.sql`（743,207 字节）。
2. 本地用 `node:sqlite` 建库并跑完 11 个迁移，再 `node scripts/import-sql.mjs`（这次 **1705 条导入 / 15 条跳过**），对账 `messages 1509`。
3. 用 `.dev.vars` 的 `KEY_ENCRYPTION_SECRET` **实解**过 `provider_keys.ciphertext`（`v1.<iv>.<cipher>`）→ 解密成功，证明密钥逐字节一致。
4. 停旧：`npx wrangler secret delete DISCORD_BOT_TOKEN --name dc-ai-bot`（Worker 与 D1 都留着 = 回退路径）。
5. 起新：`docker compose up -d --no-build bot` → 日志里 `gateway READY as 示例机器人`。
6. 建 DNS 记录（灰云）→ `docker compose up -d caddy` → 3 秒签完证书，`/api/health` 返回 `{"ok":true,"version":"0.1.0"}`。
7. 改 Discord Interactions Endpoint URL 为 `https://example.com/interactions`（Discord 当场做签名校验，PATCH 返回 200 即通过）。

### 12.3 运维通道（SSH）

这台机器的 22 端口从**某些网络**（如本机所在的代理/运营商）出网是被拦的：TCP 能连上但握手前被掐，
`ssh` 报 `kex_exchange_identification: Connection closed by remote host`。两条可用通道：

- **AWS 控制台 EC2 Instance Connect**（浏览器终端，零配置，推荐日常用）。
- **Cloudflare Worker 的 WebSocket↔TCP 隧道**：把 SSH 塞进 WSS 走 443 出去。需要的是一个临时 Worker（`cloudflare:sockets`）
  加上本地一个把 stdin/stdout 接到 WebSocket 的小客户端；注意客户端必须把 `open` 之前收到的 stdin **排队**，
  直接丢会得到 `Bad packet length` / `message authentication code incorrect`。

另外：Ubuntu 26.04 的 sshd 是 **socket 激活**（`ssh.socket`），往 `/etc/ssh/sshd_config.d/` 里写 `Port 443` **不会**生效——
监听端口由 `ssh.socket` 的 `ListenStream` 决定。想换端口要 `systemctl edit ssh.socket` 或用 `ssh -p` 直连现有端口。

### 12.4 已知仍待办

- ~~数据库每日备份还没配~~ 已配（2026-10-28）：`dc-ai-bot-backup.timer` 每天北京时间 04:00 把快照推到 Google Drive，留 30 份，见 §17。
- 安全组目前只放行 22/80/443；**22 未限制来源 IP**，建议收敛到固定出口。

---

## 13 本机运行 + Cloudflare Tunnel（2026-10-27 试跑一轮，已退役，见 §14）

§12 那台 EC2 已经停用（容器 `docker compose down`，实例可停掉/释放）。现在 bot 跑在**本机 Windows** 上，
域名的公网入口改由 Cloudflare 命名隧道提供——不需要公网 IP、不需要开端口、不需要证书。

### 13.1 两条链路

```
Discord  ──(bot 主动外连的 gateway 长连接)──▶  本机 node  dist/server.mjs
Discord  ──(HTTPS 交互请求)──▶ Cloudflare 边缘 ──(隧道)──▶ 本机 127.0.0.1:8787
```

普通聊天只走第一条；斜杠命令、按钮、后台网页走第二条。所以**只要隧道断了，聊天还活着、斜杠命令会 404**。

### 13.2 本机上的四个文件

| 文件 | 作用 |
| --- | --- |
| `data/local.env` | 六个 secret + `PORT=8787` + `DB_PATH=<仓库>/data/local-prod.sqlite3`（由 `.dev.vars` 生成，勿入库） |
| `scripts/run-local.mjs` | 入口：读上面的 env 进 `process.env`，再 `await import('dist/server.mjs')`（打包产物不认识 dotenv） |
| `data/cloudflared-dc-bot.yml` | 隧道配置：`tunnel: <TUNNEL_ID>`，ingress `example.com → http://127.0.0.1:8787` |
| `data/start-bot.cmd`、`data/start-tunnel.cmd` | 两条启动命令，已复制到「启动」文件夹，登录即自动拉起 |

启动：

```bash
npm run build:node                       # 有代码改动才需要，产出 dist/server.mjs
node scripts/run-local.mjs &             # 日志：data/local-bot.log
cloudflared --config data/cloudflared-dc-bot.yml tunnel run dc-ai-bot &   # 日志：data/cloudflared.log
curl -s http://127.0.0.1:8787/api/health   # 本地直连
curl -s https://example.com/api/health  # 过隧道，跟 Discord 看到的相同
```

### 13.3 DNS 的差别

- 原来（§12）：`example.com` 是 **A 记录 → EC2 弹性 IP**，灰云，证书由 Caddy 签。
- 现在：同一条记录变成 **CNAME → `<TUNNEL_ID>.cfargotunnel.com`，橙云**，证书由 Cloudflare 边缘提供。
- A 记录已删除；`cloudflared tunnel route dns` 默认会挑 `~/.cloudflared/config.yaml` 里的那条隧道，**必须核对 CNAME 里的 UUID 是不是本 bot 的 tunnel**（这台机器上还跑着另一条 `other-api` 隧道，很容易指错）。

### 13.4 边界与代价

- **机器不能睡眠/关机**：一睡 bot 立刻离线，斜杠命令报「应用未响应」。电源计划里把睡眠关掉。
- 重启后靠「启动」文件夹里的两个 `.cmd` 自恢复；它们用 `>>` 追加日志，出问题先看 `data/local-bot.log` 与 `data/cloudflared.log`。
- 不再有 25 秒优雅退出的约束（那是给 Docker 的 SIGTERM 准备的），本机直接关窗口就是硬停；SQLite 用 WAL，硬停最多丢最后一个未 checkpoint 的事务。
- 想回云端：`npx wrangler deploy` + 把 Interactions URL 改回 Worker 地址 + 停本机两个进程（见 §10.4）；或者照 §12 重开那台 EC2。
- **2026-10-27 已回 EC2 常驻**，本机这轮退役：
  「启动」文件夹里的两个 `.cmd` 已删除，本机不再自动起 bot 与隧道；隧道与配置保留为应急入口。最终形态见 §14。

## 14 最终形态：EC2 常驻 + 动态 IP 自动同步（2026-10-27 起）

§13 的本机 + 隧道只试跑了一轮。已定：**bot 回 EC2 常驻，不绑弹性 IP** —— 实例六个月内免费、到期就不用了，
没必要为 IPv4 再付一份钱，也不想多管一个 EIP 资源。代价是**停止再启动后公有 IPv4 会变**，得让域名自己跟上。

### 14.1 为什么放掉弹性 IP 也不涨价

AWS 自 2024-02-01 起，**所有公有 IPv4 不管是不是弹性 IP 都按 $0.005/小时计费**（≈$3.65/月）。
所以「释放 EIP 换动态 IP」省的只有运维复杂度，账单不变；真正的大头是实例本身
（m7i-flex.large ≈$0.1246/小时 ≈$91/月）。

代价只有一个：停止再启动（或 AWS 维护迁移）之后 IP 会变，域名会指向一台不存在的机器。2026-10-27 搬回来时就撞上了：
旧的 `203.0.113.10` 变成黑洞（TCP 能连、**一个字节都不回**），SSH 报
`Connection timed out during banner exchange`、`Connection to UNKNOWN port 65535 timed out`。
判断办法：到控制台读实例当前的「公有 IPv4 地址」，别相信记忆里的旧值。

### 14.2 用 systemd 定时器把 A 记录跟住 IP

脚本与 unit 都在仓库里：`scripts/update-dns.sh`、`scripts/dc-ai-bot-dns.service`、`scripts/dc-ai-bot-dns.timer`。
逻辑：读 IMDSv2 拿本机 `public-ipv4` → 查 Cloudflare 上 `example.com` 的 A 记录 → 不一致就 PATCH
（`proxied=false`、`ttl=60`）。只碰 A 记录，证书与 Caddy 都不用动。

安装（一次性，把仓库里的文件传上去后执行）：

```bash
sudo mkdir -p /opt/dc-ai-bot/bin /etc/dc-ai-bot
sudo install -m 755 scripts/update-dns.sh /opt/dc-ai-bot/bin/update-dns.sh
sudo install -m 600 cf.token /etc/dc-ai-bot/cloudflare.token          # Cloudflare API token（Zone.DNS 编辑权，只勾 example.com）
sudo install -m 644 scripts/dc-ai-bot-dns.service /etc/systemd/system/
sudo install -m 644 scripts/dc-ai-bot-dns.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dc-ai-bot-dns.timer
sudo systemctl start dc-ai-bot-dns.service        # 立刻跑一次
journalctl -t dc-ai-bot-dns -n 5 --no-pager       # 每次运行的结论
```

- 节奏：`OnBootSec=90s` + `OnUnitActiveSec=120s` + `OnUnitInactiveSec=120s` —— 开机 90 秒后先跑一次，之后每 2 分钟一次。
- 幂等：IP 没变时只写一行「已指向 …，无需改动」，不发 PATCH。
- 实例**停止**时没有 `public-ipv4`，脚本直接跳过（不会删记录）；开机后有 1–2 分钟窗口域名仍指向旧 IP。
- 自检（2026-10-27 实测）：建一条 `ddns-test.example.com A 127.0.0.1`，跑
  `sudo RECORD_NAME=ddns-test.example.com /opt/dc-ai-bot/bin/update-dns.sh` →
  `已把 ddns-test.example.com 从 127.0.0.1 改到 <当前 IP>`，随后删掉临时记录。
- 哪天愿意绑弹性 IP：`sudo systemctl disable --now dc-ai-bot-dns.timer`，A 记录改成 EIP 即可。

### 14.3 本机那套的收尾

- 「启动」文件夹里的 `DC AI Bot.cmd` / `DC AI Tunnel.cmd` 已删除，本机不再自动起 bot 与隧道。
- 隧道 `dc-ai-bot`（`<TUNNEL_ID>`）与 `data/cloudflared-dc-bot.yml` 保留，当应急入口；
  另一条 `other-api`（Windows 服务 `cloudflared-other-api`）是别的服务，**不要碰**。
- 数据库以 EC2 上的 `/opt/dc-ai-bot/data/dc-ai-bot.sqlite3` 为准；本机 `data/local-prod.sqlite3` 只是搬回来那一刻的快照。

### 14.4 换 IP 之后要做的两件事

1. 等定时器把 A 记录改掉，或手跑 `sudo systemctl start dc-ai-bot-dns.service`（`journalctl -t dc-ai-bot-dns -n 3` 看结论）。
2. 把本机 `data/sshconf` 里的 `HostName` 改成新 IP（SSH 走隧道 Worker，见 §12 的两条通道）。

### 14.5 换掉 API token（2026-10-27 做过一次）

最初那个 token（`cf-token.bak`）一度被 git 跟踪过，历史里还在，所以换掉了。Cloudflare 的 API token **不能原地改值**，只能「新建一条 + 删掉旧那条」：

1. 控制台 https://dash.cloudflare.com/profile/api-tokens → **Create Token** → 模板「**Edit zone DNS**」→ Zone Resources 选 *Specific zone: example.com*。
2. 新值存到仓库根的 `cf.token`（已被 `.gitignore` 挡住），然后
   `sudo install -m 600 cf.token /etc/dc-ai-bot/cloudflare.token` 覆盖服务器上那份，
   `sudo systemctl start dc-ai-bot-dns.service` 确认它认得新值（日志应打「已指向 …，无需改动」）。
3. 回控制台把旧那条 **Delete**。验证：旧值打 `/user/tokens/verify` 返回 `Invalid API Token`，新值仍是 `active`。
4. 本次那条 token 没有「API Tokens: Edit」权限（调用返回 `code 9109 Unauthorized`），
   所以**换 token 这一步只能在控制台点**，脚本做不了。

## 16. 从 Discord 回灌历史消息

2026-10-27 服务器被误删重建，库里最后一条消息停在 `2026-10-27T08:48:10.789Z`，
之后那约 24 小时的消息只在 Discord 上（主频道 `<ID-6>`，两万多条）。
`scripts/import-discord.mjs` 用 Bot REST 把这段抓回来写进 `messages`，**幂等，可以反复跑**：
地基是 `migrations/0016_message_discord_id.sql` 给 `messages` 加的 `discord_id` 唯一索引。

脚本只用 Node 内置模块（`node:sqlite` / `node:fs`），不需要装任何依赖，也不需要构建——
镜像的 runner 阶段已经把它拷到 `/app/scripts/`。

### 16.1 前置：先让库里长出 0016

`0016` 是纯加法：`ALTER TABLE messages ADD COLUMN discord_id TEXT`（可空）+ `CREATE UNIQUE INDEX idx_messages_discord_id`。
老行**不用回填**：SQLite 的唯一索引允许多个 NULL，而运行时写入（`src/workers/db/d1-repository.ts`）不填这一列。

拿到新镜像后照常 `sudo docker compose up -d --build`，bot 启动时会自己把迁移跑完。想先确认一下：

```bash
sudo docker compose exec -T bot node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/data/dc-ai-bot.sqlite3", { readOnly: true });
console.log(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name).join(","));
'
# 末尾应该出现 discord_id；没有就别急着跑脚本，它也会自己停下来提示「先跑迁移」
```

### 16.2 参数（全部走环境变量）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DISCORD_BOT_TOKEN` | 是 | — | 需要有该频道的 Read Message History 权限；容器环境里本来就有 |
| `CHANNEL_ID` | 是 | — | 要回灌的频道，主频道是 `<ID-6>` |
| `AFTER_ISO` | 是 | — | 只抓这个时刻**之后**的消息；填库里最后一条的时间 |
| `DB_PATH` | 否 | `/data/dc-ai-bot.sqlite3` | 容器内路径，对应宿主机 `./data/dc-ai-bot.sqlite3` |
| `MAX_PAGES` | 否 | `400` | 每页 100 条，默认上限 4 万条，防止跑飞 |
| `DRY_RUN` | 否 | 空 | 填 `1` 只统计不写库（也不建库文件） |

`AFTER_ISO` 内部会转成 snowflake 当 `after` 参数：`((BigInt(Date.parse(AFTER_ISO)) - 1420070400000n) << 22n).toString()`。
`after` 是「严格更新」，所以那一条本身不会被重复抓；就算抓到了也会被唯一索引挡掉。

### 16.3 先试跑，只统计不写库

```bash
cd /opt/dc-ai-bot
sudo docker compose exec -T -e DRY_RUN=1 -e CHANNEL_ID=<ID-6> -e AFTER_ISO=2026-10-27T08:48:10.789Z \
  bot node --input-type=module < scripts/import-discord.mjs
```

输出末尾是 `done {...}`：`fetched` 是抓到的条数，`pages` 是翻了几页，`first` / `last` 是这段的时间范围。
`DISCORD_BOT_TOKEN` 不用手写——容器环境里已经有，脚本也从不打印它。
这里用 `exec -T`（不带 TTY）才接得住重定向进来的 stdin。

### 16.4 真跑

```bash
cd /opt/dc-ai-bot
sudo cp data/dc-ai-bot.sqlite3 data/dc-ai-bot.sqlite3.bak-$(date +%Y%m%d-%H%M)   # 先留一份
sudo docker compose exec -T -e CHANNEL_ID=<ID-6> -e AFTER_ISO=2026-10-27T08:48:10.789Z \
  bot node --input-type=module < scripts/import-discord.mjs
```

- bot 可以继续跑：写库是一页一个事务，连接上还设了 `PRAGMA busy_timeout = 5000`，撞锁最多等 5 秒。
  真怕互相干扰就先 `sudo docker compose stop bot`，跑完再 `start`——停机期间的新消息不会丢，重跑一次就补上。
- 每 20 页打一行 `progress pages=… inserted=… last=<时间>`，最后一行是 `done {...}`；
  `inserted + skipped` 应当等于 `fetched`。
- 中途断掉直接重跑：已经进去的行会被 `ON CONFLICT(discord_id) DO NOTHING` 跳过（`skipped` 涨、`inserted` 归零就是跑全了）。

### 16.5 跑完怎么验

```bash
sudo docker compose exec -T bot node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/data/dc-ai-bot.sqlite3", { readOnly: true });
const one = (sql) => db.prepare(sql).get();
console.log(one("SELECT count(*) AS total, count(discord_id) AS with_id FROM messages"));
console.log(one("SELECT min(created_at) AS first, max(created_at) AS last FROM messages WHERE discord_id IS NOT NULL"));
console.log(one("SELECT count(*) AS dupes FROM (SELECT discord_id FROM messages WHERE discord_id IS NOT NULL GROUP BY discord_id HAVING count(*) > 1)"));
'
```

`dupes` 必须是 0（唯一索引保证）；`first` 应该紧接在 `2026-10-27T08:48:10.789Z` 之后，`last` 是你跑之前最后一条消息的时间。

### 16.6 限速与容错

- **429**：读响应体里的 `retry_after`（秒，可能是小数，比如 `0.25`）睡完重试**同一页**，最多 6 次；
  拿不到这个字段就退回 `Retry-After` 响应头，再不行按 1 秒。
- **网络错误**（`fetch failed` / `UND_ERR_SOCKET` 之类）：按 1s、3s、7s 退避重试，最多 3 次，仍失败就打印中文错误并以退出码 1 结束。
- 页与页之间固定睡 300ms，两万多条约 240 页，整体几分钟量级，不会撞 Discord 的全局桶。
- 退出码：缺必填环境变量是 `2`（并列出缺哪几个），真跑失败是 `1`，正常是 `0`。

### 16.7 已知边界

- `role` 按 `author.bot` 判定：bot 自己发的记 `assistant`，其他人（包括其他机器人）记 `user`，和运行时写入的语义一致。
- 纯图片/贴纸这类 `content` 为空的消息也会入库，`content` 记空串——库里没有附件表，回灌不还原附件。
- 引用的原消息已被删除时只有 `reply_to_id`，`reply_to_author*` / `reply_to_content` 是空串（这四列是 `NOT NULL DEFAULT ''`，写 `NULL` 会直接报错）。
- `discord_id` 只是给导入幂等用的，运行时读消息（`toChatMessage`）不看它，所以老行是 NULL 完全没问题。
- 脚本不建表、不改表结构：迁移是 bot 的事，它只校验 `discord_id` 在不在。

## 17. 自动备份到谷歌网盘

每天北京时间 04:00，把数据库一致性快照 + 两个无秘密配置文件打包推到 Google Drive 的 `gdrive:dc-ai-bot-backup/`：
远端留最近 30 份、本地（`/var/backups/dc-ai-bot`）留最近 3 份。仓库里三个件：
`scripts/backup-to-drive.sh`、`scripts/dc-ai-bot-backup.service`、`scripts/dc-ai-bot-backup.timer`。
**它不属于 bot**：不进镜像、不改业务代码，只有服务器上这套 systemd 单元在跑。

不备份 `.env` 的理由：里面是 Discord token、管理员密码、`KEY_ENCRYPTION_SECRET`，备份要上第三方网盘，
秘密留在机器上就够了。丢了 `.env` 的恢复路径是按 §3.2 重新填（值从 Discord 后台与你自己手里取），不是从网盘捞。
同理，备份包里只有 `dc-ai-bot.sqlite3`、`Caddyfile`、`docker-compose.yml`、`MANIFEST.txt` 四样。

### 17.1 授权一次（rclone + Google OAuth 用户 token）

外部依赖两个：`rclone` 和 `sqlite3`（脚本只检查、不替你装）：

```bash
sudo apt install -y rclone sqlite3
rclone version | head -2
```

用 **OAuth 用户 token**，不用服务账号：服务账号在个人 Drive 上没有配额，上传会直接 `storageQuotaExceeded`。
remote 名字固定 `gdrive`，配置文件固定 `/root/.config/rclone/rclone.conf`（`600 root`）——脚本不生成也不写这个文件，只假设它已经配好。

服务器上没有浏览器，所以在**别的机器上取 token 再贴回来**：

```bash
# ① 在你自己那台有浏览器的机器上（装 rclone 后）取 token，浏览器里登录要备份到的那个 Google 账号
rclone authorize "drive"
#   会打印一段 {"access_token":"...","refresh_token":"...","expiry":"..."} —— 整段复制

# ② 到服务器上以 root 建 remote
sudo -i
rclone config
#   n) New remote
#   name>                    gdrive
#   Storage>                 drive
#   client_id>               （回车，用 rclone 自带的）
#   client_secret>           （回车）
#   scope>                   1   # drive：读写
#   service_account_file>    （回车）
#   Edit advanced config?    n
#   Use web browser to automatically authenticate rclone with remote?   n   ← 服务器没浏览器
#   Configure this as a Shared Drive?                                  n
#   config_token>            粘贴 ① 打印的整段 JSON
#   y) Yes this is OK   →   q) Quit config
chmod 600 /root/.config/rclone/rclone.conf
rclone lsd gdrive:                    # 能列出目录 = 授权成功
```

- 这个文件里是 refresh token，等同密码：`600 root`，不进仓库、不 scp 到别处、不进备份（脚本只读它）。
- refresh token 失效（长期不用、改密码、被撤销）时：`sudo rclone config reconnect gdrive:` 重走一遍 OAuth。
- 备份目录脚本会自己建，先在 Drive 里手建一个 `dc-ai-bot-backup` 也行，方便你审计与共享设置。

也可以完全不走交互式，直接把 remote 写进配置文件（把 ① 打印的整段 JSON 原样粘到 `token =` 后面）：

```ini
[gdrive]
type = drive
scope = drive
token = {"access_token":"ya29.<占位>","token_type":"Bearer","refresh_token":"1//<占位>","expiry":"2026-10-28T20:00:00Z"}
```

```bash
sudo install -d -m 700 /root/.config/rclone
sudo vi /root/.config/rclone/rclone.conf        # 粘上面 4 行，token 换成 ① 打印的那段
sudo chmod 600 /root/.config/rclone/rclone.conf # 必须是 600 root
sudo rclone about gdrive:                      # 打印配额/用量 = 授权成功
```

- 上面 `token =` 里是占位符，真 token 只该出现在你自己的终端与这个 600 的文件里，别贴进 issue、聊天或仓库。

### 17.2 装 systemd 单元

```bash
# 在仓库目录里执行（git pull 之后）
sudo install -d -m 755 /opt/dc-ai-bot/bin
sudo install -m 755 scripts/backup-to-drive.sh /opt/dc-ai-bot/bin/backup-to-drive.sh
sudo install -m 644 scripts/dc-ai-bot-backup.service /etc/systemd/system/
sudo install -m 644 scripts/dc-ai-bot-backup.timer   /etc/systemd/system/
sudo install -m 644 scripts/dc-ai-bot-backup-request.service /etc/systemd/system/
sudo install -m 644 scripts/dc-ai-bot-backup-request.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dc-ai-bot-backup.timer
sudo systemctl enable --now dc-ai-bot-backup-request.timer
systemctl list-timers dc-ai-bot-backup.timer --no-pager   # NEXT 应是 UTC 20:00（= 北京时间次日 04:00）
systemctl list-timers dc-ai-bot-backup-request.timer --no-pager  # NEXT 应在 1 分钟内（§17.6）
```

- 服务器时区是 UTC，所以 `OnCalendar=*-*-* 20:00:00 UTC` 就是北京时间 04:00；`Persistent=true` 让关机错过的这一轮在开机后补跑。
- `RandomizedDelaySec=5min` 把触发时间打散，避开整点抖动；`TimeoutStartSec=30min` 是硬上限。
- unit 里**没有** `User=`：必须 root 才能读 `600` 的 `rclone.conf` 与 `data/` 里的库。
  `Nice=10` + `IOSchedulingClass=best-effort`/`Priority=7` 让它在磁盘上不跟 bot 抢。
- 只升级脚本时：重新 `sudo install -m 755 scripts/backup-to-drive.sh /opt/dc-ai-bot/bin/backup-to-drive.sh`，unit 不用动、不用 `daemon-reload`。
- 停掉自动备份：`sudo systemctl disable --now dc-ai-bot-backup.timer`。
- `dc-ai-bot-backup-request.timer` 是「后台按钮」那条路（§17.6）：每分钟跑一次 `backup-to-drive.sh --if-requested`，
  没有请求文件就静默退出（journal 里不会每分钟多一行），有请求才当场跑一轮。它和每日那轮共用同一把锁、同一份脚本。
  停掉按钮这条路：`sudo systemctl disable --now dc-ai-bot-backup-request.timer`。

### 17.3 手动跑一次

```bash
sudo DRY_RUN=1 /opt/dc-ai-bot/bin/backup-to-drive.sh    # 只快照 + 打包 + 本地清理，不碰网盘
sudo /opt/dc-ai-bot/bin/backup-to-drive.sh              # 真跑
sudo journalctl -u dc-ai-bot-backup.service -n 30 --no-pager
sudo rclone lsf --files-only gdrive:dc-ai-bot-backup/ | sort | tail -3
```

成功时最后一行长这样（每步都有 UTC 时间戳前缀，journal 里直接能对）：

```
04:02:11Z backup ok file=dc-ai-bot-20261028T200000Z.tar.gz bytes=1234567 kept_remote=30
```

- 退出码：`0` 成功（含「上一轮还在跑，本轮跳过」）；`1` 快照/打包/上传/校验失败（**本地文件保留**，下一轮再传）；
  `2` 环境缺件（`rclone` 或 `sqlite3` 不在、库不在、`rclone.conf` 不在）。
- 开关：`DRY_RUN=1` 只做本地部分；`SKIP_REMOTE_PRUNE=1` 只传不删；路径变量都能用同名环境变量覆盖（演练用，unit 里别加）。
- 并发保护：`/var/lock/dc-ai-bot-backup.lock` 上的 `flock -n`，拿不到锁就记一行日志后以 `0` 退出。
- 保留策略只认 `dc-ai-bot-YYYYmmddTHHMMSSZ.tar.gz` 这个格式（UTC 时间戳，字典序即时间序），
  你自己往目录里放别的文件不会被删。

### 17.4 恢复步骤

```bash
# ① 挑一份，拉回服务器
sudo rclone lsf --files-only gdrive:dc-ai-bot-backup/ | sort | tail -5
sudo rclone copy gdrive:dc-ai-bot-backup/dc-ai-bot-20261028T200000Z.tar.gz /var/tmp/

# ② 解开看清单（平铺目录：dc-ai-bot.sqlite3 / Caddyfile / docker-compose.yml / MANIFEST.txt）
cd /var/tmp && sudo tar -xzf dc-ai-bot-20261028T200000Z.tar.gz && cat MANIFEST.txt
sudo sqlite3 /var/tmp/dc-ai-bot.sqlite3 "PRAGMA integrity_check;"    # 必须是 ok

# ③ 换库：先停容器、把现库另存一份、清掉 -wal/-shm、属主给回 1000
cd /opt/dc-ai-bot && sudo docker compose stop bot
sudo cp data/dc-ai-bot.sqlite3 "data/broken-$(date +%F-%H%M).sqlite3"
sudo cp /var/tmp/dc-ai-bot.sqlite3 data/dc-ai-bot.sqlite3
sudo rm -f data/dc-ai-bot.sqlite3-wal data/dc-ai-bot.sqlite3-shm
sudo chown 1000:1000 data/dc-ai-bot.sqlite3
sudo docker compose up -d bot
sudo docker compose logs --tail=50 bot | grep -E '迁移检查完成|listening on'
```

- `MANIFEST.txt` 里的 `db_migrations` / `db_messages` / `gateway_build` 就是「这份是哪个版本、有多少条消息、当时跑到哪一版 gateway」的凭据，
  恢复前后各看一眼：`db_migrations` 对 `SELECT count(*) FROM _migrations`、`db_messages` 对 `SELECT count(*) FROM messages`，两个都对得上才算真的换成功。
  （`db_user_version` 恒为 0——迁移账本在 `_migrations` 表里，不在 PRAGMA 里，所以它只当留档、别拿来对账。）
- 打包里**没有 `.env`**：整机重建还要按 §3.2 重新填，`KEY_ENCRYPTION_SECRET` 必须与原来逐字节一致，
  否则库里 `provider_keys` 的密文全部解不开（后台 Key 列表打不开、聊天全 500）。
- 备份里的 `Caddyfile` / `docker-compose.yml` 只用于对照配置漂移，别直接覆盖线上（可能比线上旧）。

### 17.5 排错

| 现象（journal / 命令输出） | 原因与处理 |
| --- | --- |
| `环境缺件：rclone 不在 PATH` | `sudo apt install -y rclone`；`sqlite3` 同理 |
| `环境缺件：rclone 配置不在` | remote 不叫 `gdrive`，或配置不在 `/root/.config/rclone/rclone.conf`（§17.1） |
| `环境缺件：必须以 root 运行` | 别用 `ubuntu` 用户手跑，`sudo` 或 `systemctl start` |
| `couldn't fetch token` / `401` / `invalid_grant` | refresh token 失效：`sudo rclone config reconnect gdrive:` |
| `storageQuotaExceeded` | 用的是服务账号（个人 Drive 无配额），换回 OAuth 用户 token |
| `上一轮备份还在跑` | 上轮超过 `TimeoutStartSec=30min`；看 journal，确认没有残留进程后 `sudo rm -f /var/lock/dc-ai-bot-backup.lock` |
| `integrity_check 未通过` | 源库本身有问题（先查 bot 日志与磁盘）。这一轮**不会上传**，云端旧的好备份不会被坏文件覆盖 |
| `上传校验失败` | 远端 size 与本地不一致（网络截断）。本地文件保留，重跑一次即可 |
| 定时器到点不跑 | `systemctl list-timers dc-ai-bot-backup.timer --no-pager`；`timedatectl` 看时钟与时区；单元改过要 `daemon-reload` |
| 点了按钮 1 分钟没动静 | 按顺序自查：① `systemctl is-active dc-ai-bot-backup-request.timer` 是不是 `active`（不是就 `sudo systemctl enable --now dc-ai-bot-backup-request.timer`）；② 请求文件在不在：`cat /opt/dc-ai-bot/data/backup-request.json`（不在 = 按钮那一步没落盘；在 = 宿主还没轮到）；③ `sudo journalctl -u dc-ai-bot-backup-request.service -n 30 --no-pager` 看是报错还是「上一轮备份还在跑」（§17.6、§17.7） |
| 云端份数多于 30 | 只清 `dc-ai-bot-YYYYmmddTHHMMSSZ.tar.gz`；手工放进去的其它文件名不在清理范围内（安全设计，不是 bug） |

```bash
sudo systemctl start dc-ai-bot-backup.service          # 立刻跑一轮（同步等它跑完）
sudo journalctl -u dc-ai-bot-backup.service --since -1h --no-pager
sudo rclone lsf --files-only gdrive:dc-ai-bot-backup/ | wc -l
ls -lt /var/backups/dc-ai-bot | head -5
```
### 17.6 网页后台手动备份

后台「备份」页上的按钮，链路长这样（容器里没有 systemd、也没有 rclone，真正干活的是宿主）：

```text
按钮 → POST /api/backup/run → /opt/dc-ai-bot/data/backup-request.json
     → dc-ai-bot-backup-request.timer（每分钟）→ backup-to-drive.sh --if-requested
     → /opt/dc-ai-bot/data/backup-status.json → GET /api/backup → 页面显示结果
```

- 宿主与容器看到的是**同一对文件**：`docker-compose.yml` 里 bot 挂的是 `./data:/data`，所以宿主的 `/opt/dc-ai-bot/data/backup-request.json` 就是容器内的 `/data/backup-request.json`，状态文件同理。
- 点下去**不是立刻开跑**：timer 是 `OnUnitActiveSec=60s`，最迟 1 分钟才轮到这一份请求；页面上先显示「正在备份」（`phase=running`），跑完变「上次成功」（带文件名、字节数、云端保留份数）或「上次失败」（带一行原因）。
- 跑的是与每日定时**同一份脚本、同一把锁**（`/var/lock/dc-ai-bot-backup.lock`）：正赶上 UTC 20:00 那轮在跑，按钮这轮就记一行「上一轮备份还在跑」跳过——不排队、不并发两个 rclone，请求文件留到下一分钟再看。
- 打包、上传、校验、保留策略与 §17.3 完全一样：归档落在 `/var/backups/dc-ai-bot`，云端仍是 `gdrive:dc-ai-bot-backup`，远端保留 30 份（`KEEP_REMOTE`）。
- 已经有一份没处理的请求时再点：`POST /api/backup/run` 回 `409 BACKUP_BUSY`，页面提示等这一轮跑完，不会排第二份。

### 17.7 状态文件与请求文件契约

两个 JSON 都在 `/opt/dc-ai-bot/data`（容器内 `/data`）：后台只写请求文件，`backup-to-drive.sh` 只写状态文件。

请求文件 `backup-request.json`（后台写）：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 32 位 hex，一轮备份的标识，会原样回写进状态文件 |
| `requestedAt` | string | 点按钮的时刻，ISO 8601 带 `Z`（UTC） |

状态文件 `backup-status.json`（脚本写，三个阶段共用一套键）：

| 键 | 出现时机 | 说明 |
| --- | --- | --- |
| `phase` | 恒有 | `running`（刚开跑）/ `done`（成功）/ `failed`（失败） |
| `id` | 恒有 | 请求文件里的 `id`；每日定时那轮是空串；请求文件坏掉时也是空串 |
| `source` | 恒有 | `manual`（请求文件在）/ `daily`（没有请求文件） |
| `startedAt` | 恒有 | 开跑时刻，ISO 8601 带 `Z` |
| `finishedAt` | `done` / `failed` | 结束时刻 |
| `file` | `done` | 归档文件名，如 `dc-ai-bot-20261028T130737Z.tar.gz` |
| `bytes` | `done` | 归档字节数 |
| `keptRemote` | `done` | 这轮结束后远端保留的份数 |
| `remote` | `done` | 远端路径，恒为 `gdrive:dc-ai-bot-backup` |
| `error` | `failed` | 单行人类可读原因，与 journal 里那一行同义 |

- **不写 `null`**：用不上的键整键省略（`running` 里没有 `finishedAt`，`done` 里没有 `error`）。
- 写入是**原子**的（同目录临时文件 + `mv`），后台任何时刻读到的都是一份完整 JSON。
- **状态写失败不影响备份成败**：`data/` 不可写时脚本只多打一行「提示：状态文件写不进去」，退出码仍由备份本身决定（不会把一轮成功的备份记成 `failed`）。
- 文件缺失或内容是坏形状：`GET /api/backup` 把那一半回 `null`，不报 500（接口与错误码见 `docs/architecture.md` §36.2）。
- **前置检查失败也会消费请求**：root / rclone / sqlite3 / 数据库 / `rclone.conf` 缺件时脚本 `exit 2`，但仍会吃掉请求文件并写 `failed`（`error` 形如「环境缺件：rclone 配置不在：…」）。所以修完环境再点一次就行——不会每分钟重试，也不会一直回 `409 BACKUP_BUSY`。
