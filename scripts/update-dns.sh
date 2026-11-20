#!/usr/bin/env bash
# 把 Cloudflare 上的 A 记录跟住这台实例当前的公有 IPv4（不用弹性 IP 的替代方案）。
# 安装步骤与设计说明见 docs/hosting.md §14。
set -euo pipefail

ZONE_ID="${ZONE_ID:-<CLOUDFLARE_ZONE_ID>}"
RECORD_NAME="${RECORD_NAME:-example.com}"
TOKEN_FILE="${TOKEN_FILE:-/etc/dc-ai-bot/cloudflare.token}"
LOG_TAG="dc-ai-bot-dns"

log() { logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true; echo "$*"; }

md="http://169.254.169.254/latest"
imds_token="$(curl -sS --max-time 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "$md/api/token" || true)"
if [ -z "$imds_token" ]; then
  log "读不到 IMDS token，跳过本次检查"
  exit 1
fi
current_ip="${IP_OVERRIDE:-$(curl -sS --max-time 5 -H "X-aws-ec2-metadata-token: $imds_token" "$md/meta-data/public-ipv4" || true)}"
if [ -z "$current_ip" ]; then
  log "这台实例当前没有公有 IPv4（已停止？），跳过"
  exit 0
fi

api="https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records"
auth="Authorization: Bearer $(cat "$TOKEN_FILE")"

records="$(curl -sS --max-time 10 -H "$auth" "$api?type=A&name=$RECORD_NAME")"
record_id="$(printf '%s' "$records" | grep -o '"id":"[a-f0-9]\{32\}"' | head -1 | cut -d'"' -f4)"
record_ip="$(printf '%s' "$records" | grep -o '"content":"[0-9.]*"' | head -1 | cut -d'"' -f4)"

if [ -z "$record_id" ]; then
  log "Cloudflare 上没有 $RECORD_NAME 的 A 记录，跳过（先用 dns.mjs 建一条）"
  exit 1
fi
if [ "$record_ip" = "$current_ip" ]; then
  log "$RECORD_NAME 已指向 $current_ip，无需改动"
  exit 0
fi

result="$(curl -sS --max-time 10 -X PATCH -H "$auth" -H 'content-type: application/json' \
  --data "{\"content\":\"$current_ip\",\"proxied\":false,\"ttl\":60}" "$api/$record_id")"
if printf '%s' "$result" | grep -q '"success":true'; then
  log "已把 $RECORD_NAME 从 $record_ip 改到 $current_ip"
else
  log "改记录失败：$(printf '%s' "$result" | head -c 300)"
  exit 1
fi
