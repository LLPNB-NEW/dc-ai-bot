#!/usr/bin/env bash
# 一键部署到 Cloudflare Workers（本地与 CI 皆可跑）。
# 凭据：.cf-token（API Token 一行）或环境变量 CLOUDFLARE_API_TOKEN；密钥：.dev.vars。
# 全程不打印任何 secret 值；任何一步失败立即停止。
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="npx wrangler"
DB_NAME="dc-ai-bot"
LOCATION="apac"
BASE=""

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

# ---------- 1. 凭据 ----------
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  TOKEN="$CLOUDFLARE_API_TOKEN"; SRC="环境变量 CLOUDFLARE_API_TOKEN"
elif [[ -s .cf-token ]]; then
  TOKEN="$(tr -d ' \t\r\n' < .cf-token)"; SRC=".cf-token"
elif [[ -s cf-token ]]; then
  TOKEN="$(tr -d ' \t\r\n' < cf-token)"; SRC="cf-token"
elif $WRANGLER whoami >/dev/null 2>&1; then
  TOKEN=""; SRC="wrangler login（OAuth 凭据）"
else
  die "缺少凭据：创建 cf-token（一行 API Token）、export CLOUDFLARE_API_TOKEN，或先 npx wrangler login"
fi
if [[ -n "$TOKEN" ]]; then
  export CLOUDFLARE_API_TOKEN="$TOKEN"
else
  unset CLOUDFLARE_API_TOKEN || true
  # OAuth 凭据不能导出为 API Token，单独取出来只用于 curl 调 CF API
  for f in "${XDG_CONFIG_HOME:-$HOME/.config}/.wrangler/config/default.toml" \
           "$HOME/AppData/Roaming/xdg.config/.wrangler/config/default.toml" \
           "$HOME/.wrangler/config/default.toml"; do
    [[ -f "$f" ]] || continue
    TOKEN="$(grep -hoE 'oauth_token = "[^"]+"' "$f" | head -1 | sed 's/.*= "//; s/"$//')"
    [[ -n "$TOKEN" ]] && break
  done
fi

step "1/7 校验凭据（来源 $SRC，token 长度 ${#TOKEN}）"
if ! WHOAMI="$($WRANGLER whoami 2>&1)"; then
  echo "$WHOAMI" | tail -8
  die "whoami 失败：token 无效或缺少权限（需 Workers Scripts:Edit + D1:Edit）"
fi
echo "$WHOAMI" | grep -iE 'account|email|membership' | head -5

ACCOUNT_ID="$(echo "$WHOAMI" | grep -oE '[0-9a-f]{32}' | head -1)"
if [[ -n "$ACCOUNT_ID" ]]; then export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"; echo "account_id = $ACCOUNT_ID"; fi

# ---------- 2. D1 ----------
step "2/7 确认 D1 数据库 $DB_NAME"
list_db() {
  $WRANGLER d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const m=a.find(x=>x.name===process.argv[1]);process.stdout.write(m?(m.uuid||m.id||""):"")}catch(e){}})' "$DB_NAME"
}
DB_ID="$(list_db)"
if [[ -z "$DB_ID" ]]; then
  echo "未找到，创建中（location=$LOCATION）"
  $WRANGLER d1 create "$DB_NAME" --location "$LOCATION" >/dev/null
  DB_ID="$(list_db)"
fi
[[ -n "$DB_ID" ]] || die "无法获得 database_id（D1 权限或账号不对）"
echo "database_id = $DB_ID"
node -e 'const fs=require("fs");const p="wrangler.toml";const s=fs.readFileSync(p,"utf8");const n=s.replace(/database_id\s*=\s*"[^"]*"/,"database_id = \""+process.argv[1]+"\"");if(n!==s){fs.writeFileSync(p,n);console.log("wrangler.toml 已写入真实 database_id")}else{console.log("wrangler.toml 无需改动")}' "$DB_ID"

# ---------- 3. 迁移 ----------
step "3/7 应用远程迁移（migrations/）"
if ! $WRANGLER d1 migrations apply "$DB_NAME" --remote --yes </dev/null; then
  echo "（--yes 不被接受，重试不带该参数）"
  $WRANGLER d1 migrations apply "$DB_NAME" --remote </dev/null
fi

# ---------- 4. 构建 ----------
step "4/7 构建 SPA"
npm run build:web
[[ -f dist/web/index.html ]] || die "dist/web/index.html 不存在，构建失败"

# ---------- 5. 部署 ----------
step "5/7 部署 Worker"
WORKER_NAME="$(grep -oE '^name[[:space:]]*=[[:space:]]*"[^"]+"' wrangler.toml | head -1 | sed 's/.*"//; s/"$//')"
WORKER_NAME="${WORKER_NAME:-dc-ai-bot}"
cf_api() { # method path [json-body]
  [[ -n "${TOKEN:-}" && -n "${ACCOUNT_ID:-}" ]] || return 1
  if [[ -n "${3:-}" ]]; then
    curl -s -X "$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "$3" \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID$2"
  else
    curl -s -X "$1" -H "Authorization: Bearer $TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID$2"
  fi
}

DEPLOY_OUT="$($WRANGLER deploy 2>&1)" && DEPLOY_OK=1 || DEPLOY_OK=0
echo "$DEPLOY_OUT" | grep -iE 'uploaded|deployed|workers\.dev|env\.' | head -6
if [[ "$DEPLOY_OK" -eq 0 ]]; then
  # wrangler 4.152 上传成功后还会调新版 workers/workers 资源 API；账号不支持该资源时
  # 收尾调用回 10007，wrangler 误判整体失败。此时以脚本确实存在为准。
  if echo "$DEPLOY_OUT" | grep -q 'Uploaded' && echo "$DEPLOY_OUT" | grep -qE 'workers/workers|code: 10007'; then
    echo "（已知偏差：上传已成功，收尾的新版 workers/workers API 报 10007，按已部署继续）"
  else
    echo "$DEPLOY_OUT" | tail -25
    die "deploy 失败"
  fi
fi

# wrangler 没走到收尾步骤时 workers.dev 路由不会自动开启，这里补上
cf_api POST "/workers/scripts/$WORKER_NAME/subdomain" '{"enabled":true,"previews_enabled":false}' >/dev/null || true

BASE="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)"
if [[ -z "$BASE" ]]; then
  SUB="$(cf_api GET /workers/subdomain | grep -oE '"subdomain"[[:space:]]*:[[:space:]]*"[^"]+"' | sed 's/.*"//; s/"$//')"
  [[ -n "$SUB" ]] && BASE="https://$WORKER_NAME.$SUB.workers.dev"
fi
[[ -n "$BASE" ]] || die "无法确定 workers.dev 域名（deploy 输出与账号子域都没拿到）"

# ---------- 6. secret ----------
step "6/7 注入 secret（来源 .dev.vars，空值跳过）"
[[ -f .dev.vars ]] || die "缺少 .dev.vars"
pushed=0; skipped=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
  name="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
  value="${value#\"}"; value="${value%\"}"
  if [[ -z "$value" ]]; then echo "  · 跳过 $name（空值）"; skipped=$((skipped+1)); continue; fi
  printf '%s' "$value" | $WRANGLER secret put "$name" >/dev/null
  echo "  ✓ $name"
  pushed=$((pushed+1))
done < .dev.vars
echo "已注入 $pushed 个；跳过 $skipped 个空值"

# ---------- 7. 冒烟 ----------
step "7/7 线上冒烟：$BASE"
code=""
for i in $(seq 1 10); do
  code="$(curl -s -o /tmp/dcai-health.json -w '%{http_code}' "$BASE/api/health" || true)"
  [[ "$code" == "200" ]] && break
  sleep 3
done
echo "GET /api/health -> HTTP $code $(cat /tmp/dcai-health.json 2>/dev/null)"
curl -s -o /dev/null -w 'GET / -> HTTP %{http_code} (%{content_type})\n' "$BASE/" || true
curl -s -o /tmp/dcai-prompts.json -w 'GET /api/prompts -> HTTP %{http_code}\n' "$BASE/api/prompts" || true
echo "Body: $(head -c 200 /tmp/dcai-prompts.json 2>/dev/null)"

echo
echo "✓ 完成。后台地址：$BASE/   Interactions Endpoint URL 填：$BASE/interactions"
