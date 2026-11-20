#!/usr/bin/env bash
# 每天把数据库一致性快照 + 无秘密配置打包推到 Google Drive，由 systemd timer 以 root 调用（见 docs/hosting.md §17）。
# 所有路径都能用同名环境变量覆盖，方便在别的机器上演练；unit 里不加变量，一律走默认值。
# 带 --if-requested 的是「后台按钮」那条路：后台写 backup-request.json，dc-ai-bot-backup-request.timer 每分钟问一次，
# 没有请求文件就一个字不打地退出（exit 0），有请求就当场跑一轮并把结果写进 backup-status.json（§17.6、§17.7）。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dc-ai-bot}"
DB_PATH="${DB_PATH:-/opt/dc-ai-bot/data/dc-ai-bot.sqlite3}"
REMOTE="${REMOTE:-gdrive}"
REMOTE_DIR="${REMOTE_DIR:-dc-ai-bot-backup}"
LOCAL_DIR="${LOCAL_DIR:-/var/backups/dc-ai-bot}"
KEEP_REMOTE="${KEEP_REMOTE:-30}"
KEEP_LOCAL="${KEEP_LOCAL:-3}"
RCLONE_CONF="${RCLONE_CONF:-/root/.config/rclone/rclone.conf}"
LOCK_FILE="${LOCK_FILE:-/var/lock/dc-ai-bot-backup.lock}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_REMOTE_PRUNE="${SKIP_REMOTE_PRUNE:-0}"
# 请求 / 状态文件落在被挂进容器的数据目录（宿主 /opt/dc-ai-bot/data，容器内 /data）
STATE_DIR="${STATE_DIR:-/opt/dc-ai-bot/data}"
REQUEST_FILE="${REQUEST_FILE:-$STATE_DIR/backup-request.json}"
STATUS_FILE="${STATUS_FILE:-$STATE_DIR/backup-status.json}"

REMOTE_PATH="$REMOTE:$REMOTE_DIR"
# 清理只认本脚本产出的名字，目录里别的东西一律不碰
ARCHIVE_RE='^dc-ai-bot-[0-9]{8}T[0-9]{6}Z\.tar\.gz$'

IF_REQUESTED=0
for arg in "$@"; do
  case "$arg" in
    --if-requested) IF_REQUESTED=1 ;;
    *) printf '用法：%s [--if-requested]\n' "${0##*/}" >&2; exit 2 ;;
  esac
done

# 每分钟被问一次的那条路：没有请求文件就立刻退出，不写日志、不碰状态文件
if [ "$IF_REQUESTED" = "1" ] && [ ! -f "$REQUEST_FILE" ]; then
  exit 0
fi

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die_env() {
  FAIL_REASON="环境缺件：$*"
  log "环境缺件：$*"
  # 环境缺件也要吃掉请求：否则 timer 每分钟重试一次，而且后台永远拿 409（看不到真正的失败原因）
  if [ -f "$REQUEST_FILE" ]; then
    RUN_SOURCE="manual"
    RUN_ID="$(read_request_id)"
    rm -f "$REQUEST_FILE" || true
  fi
  exit 2
}

# --- 状态文件（后台读它）：写不进去最多丢一次状态，绝不能影响备份本身的成败 ---
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  printf '%s' "$s"
}

status_write() {
  local dir tmp
  dir="$(dirname "$STATUS_FILE")"
  tmp="$dir/.backup-status.json.$$"
  if mkdir -p "$dir" 2>/dev/null && printf '%s\n' "$1" >"$tmp" 2>/dev/null && mv -f "$tmp" "$STATUS_FILE" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  log "提示：状态文件写不进去（$STATUS_FILE），本轮状态丢弃，备份结果不受影响"
}

status_running() {
  status_write "$(printf '{"phase":"running","id":"%s","source":"%s","startedAt":"%s"}' \
    "$(json_escape "$RUN_ID")" "$RUN_SOURCE" "$STARTED_AT")"
}

status_done() {
  status_write "$(printf '{"phase":"done","id":"%s","source":"%s","startedAt":"%s","finishedAt":"%s","file":"%s","bytes":%s,"keptRemote":%s,"remote":"%s"}' \
    "$(json_escape "$RUN_ID")" "$RUN_SOURCE" "$STARTED_AT" "$(iso_now)" \
    "$(json_escape "$name")" "$bytes" "$kept_remote" "$(json_escape "$REMOTE_PATH")")"
}

status_failed() {
  status_write "$(printf '{"phase":"failed","id":"%s","source":"%s","startedAt":"%s","finishedAt":"%s","error":"%s"}' \
    "$(json_escape "$RUN_ID")" "$RUN_SOURCE" "$STARTED_AT" "$(iso_now)" "$(json_escape "$1")")"
}

# 请求文件是后台写的：坏 JSON 就当没有 id（空串），不能让一个残缺文件把备份挡下来
read_request_id() {
  sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST_FILE" 2>/dev/null | head -1
}

# 失败一律走这里：先把原因记下来（给状态文件用），再让 trap 收尾
fail() { FAIL_REASON="$*"; log "$*"; exit 1; }

on_exit() {
  local code=$?
  if [ -n "$TMP" ]; then rm -rf "$TMP" 2>/dev/null || true; fi
  if [ "$code" -ne 0 ]; then
    if [ "$RUN_STARTED" = "0" ]; then
      # 前置检查就挂了：running 还没写，按请求文件在不在补出 source 与 id
      STARTED_AT="$(iso_now)"
      if [ -f "$REQUEST_FILE" ]; then
        RUN_SOURCE="manual"
        RUN_ID="$(read_request_id)"
      fi
    fi
    status_failed "${FAIL_REASON:-备份失败，退出码 $code（详见 journalctl）}"
  fi
}

TMP=""
FAIL_REASON=""
STARTED_AT=""
RUN_ID=""
RUN_SOURCE="daily"
RUN_STARTED=0
trap on_exit EXIT

# --- 前置检查 ---
[ "$(id -u)" -eq 0 ] || die_env "必须以 root 运行（要读 600 的 rclone.conf 与数据库）"
command -v rclone >/dev/null 2>&1 || die_env "rclone 不在 PATH"
command -v sqlite3 >/dev/null 2>&1 || die_env "sqlite3 不在 PATH（apt install -y sqlite3）"
[ -f "$DB_PATH" ] || die_env "数据库不在：$DB_PATH"
[ -f "$RCLONE_CONF" ] || die_env "rclone 配置不在：$RCLONE_CONF"
log "前置检查通过 db=$DB_PATH remote=$REMOTE_PATH"

# --- 并发保护：上一轮还在跑就安静退出，不算失败 ---
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "上一轮备份还在跑（$LOCK_FILE 被占用），本轮跳过"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dc-ai-bot-backup.XXXXXX")"

# --- 谁点的这一轮：请求文件在 = 后台按钮（manual），不在 = 每日定时（daily） ---
if [ -f "$REQUEST_FILE" ]; then
  RUN_SOURCE="manual"
  RUN_ID="$(read_request_id)"
  rm -f "$REQUEST_FILE" || true
  log "收到后台请求 id=${RUN_ID:-未知}，这一轮按手动备份跑"
fi
STARTED_AT="$(iso_now)"
RUN_STARTED=1
status_running

# --- 数据库一致性快照（不停容器）---
log "开始快照源库"
sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$TMP/dc-ai-bot.sqlite3'" || fail "快照失败，放弃本轮"
[ -s "$TMP/dc-ai-bot.sqlite3" ] || fail "快照文件不存在或为空，放弃本轮"

integrity="$(sqlite3 "$TMP/dc-ai-bot.sqlite3" 'PRAGMA integrity_check;' 2>/dev/null || printf 'error')"
if [ "$integrity" != "ok" ]; then
  fail "integrity_check 未通过（$integrity），不推送坏备份"
fi
log "快照 integrity_check=ok"

# --- 配置只带无秘密的两个文件 ---
# .env 里是 Discord token、管理员密码、KEY_ENCRYPTION_SECRET，网盘上不该有秘密，所以永不打包。
for f in Caddyfile docker-compose.yml; do
  if [ -f "$APP_DIR/$f" ]; then
    cp "$APP_DIR/$f" "$TMP/$f"
  else
    log "提示：$APP_DIR/$f 不在，本轮不含它"
  fi
done

# --- MANIFEST：出一份能对账的清单 ---
db_bytes="$(wc -c < "$TMP/dc-ai-bot.sqlite3" | tr -d ' ')"
user_version="$(sqlite3 "$TMP/dc-ai-bot.sqlite3" 'PRAGMA user_version;' 2>/dev/null || printf 'n/a')"
migrations="$(sqlite3 "$TMP/dc-ai-bot.sqlite3" 'SELECT count(*) FROM _migrations;' 2>/dev/null || printf 'n/a')"
messages="$(sqlite3 "$TMP/dc-ai-bot.sqlite3" 'SELECT count(*) FROM messages;' 2>/dev/null || printf 'n/a')"
gateway_build=""
engine_ts="$APP_DIR/src/workers/gateway/engine.ts"
if [ -r "$engine_ts" ]; then
  gateway_build="$(sed -n "s/.*GATEWAY_BUILD = '\([^']*\)'.*/\1/p" "$engine_ts" | head -1 || true)"
fi

{
  printf 'created_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'host=%s\n' "$(hostname)"
  printf 'sqlite3_version=%s\n' "$(sqlite3 --version | head -1)"
  printf 'db_source=%s\n' "$DB_PATH"
  printf 'db_snapshot_bytes=%s\n' "$db_bytes"
  printf 'db_user_version=%s\n' "$user_version"
  printf 'db_migrations=%s\n' "$migrations"
  printf 'db_messages=%s\n' "$messages"
  if [ -n "$gateway_build" ]; then printf 'gateway_build=%s\n' "$gateway_build"; fi
  printf 'includes=Caddyfile,docker-compose.yml\n'
  printf 'excludes=.env（含 secret，永不打包）\n'
  printf 'remote=%s\n' "$REMOTE_PATH"
} > "$TMP/MANIFEST.txt"

# --- 打包：成员用相对路径，解包出来是一个平铺目录 ---
mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR" 2>/dev/null || true
name="dc-ai-bot-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
ARCHIVE="$LOCAL_DIR/$name"
tar -czf "$ARCHIVE" -C "$TMP" . || { rm -f "$ARCHIVE" || true; fail "打包失败，放弃本轮"; }
chmod 600 "$ARCHIVE"
bytes="$(wc -c < "$ARCHIVE" | tr -d ' ')"
log "打包完成 $name bytes=$bytes"
if command -v sha256sum >/dev/null 2>&1; then
  log "本地 sha256 $(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
fi

# --- 上传并校验 ---
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1：跳过上传与全部远端删改"
else
  log "上传到 $REMOTE_PATH/"
  rclone copy --config "$RCLONE_CONF" --no-traverse "$ARCHIVE" "$REMOTE_PATH/" \
    || fail "上传失败，本地文件保留：$ARCHIVE"
  remote_json="$(rclone lsjson --config "$RCLONE_CONF" --files-only "$REMOTE_PATH/$name" 2>/dev/null || true)"
  remote_bytes="$(printf '%s' "$remote_json" | grep -o '"Size":[0-9]*' | head -1 | cut -d: -f2 || true)"
  if [ "$remote_bytes" != "$bytes" ]; then
    fail "上传校验失败 远端=${remote_bytes:-缺失} 本地=$bytes，本地文件保留"
  fi
  log "上传校验通过 size=$remote_bytes"
fi

# --- 本地只留最近 KEEP_LOCAL 份 ---
ls -1t "$LOCAL_DIR" 2>/dev/null | grep -E "$ARCHIVE_RE" > "$TMP/local.list" || true
local_total="$(wc -l < "$TMP/local.list" | tr -d ' ')"
if [ "$local_total" -gt "$KEEP_LOCAL" ]; then
  tail -n "+$((KEEP_LOCAL + 1))" "$TMP/local.list" | while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$LOCAL_DIR/$old"
    log "本地清理 $old"
  done
  local_total="$KEEP_LOCAL"
fi
log "本地保留 $local_total 份"

# --- 远端只留最近 KEEP_REMOTE 份；名字里是 UTC 时间戳，字典序即时间序 ---
rclone lsf --files-only --config "$RCLONE_CONF" "$REMOTE_PATH/" 2>/dev/null | grep -E "$ARCHIVE_RE" | sort > "$TMP/remote.list" || true
remote_total="$(wc -l < "$TMP/remote.list" | tr -d ' ')"
if [ "$DRY_RUN" = "1" ] || [ "$SKIP_REMOTE_PRUNE" = "1" ]; then
  kept_remote="$remote_total"
  log "跳过远端清理（dry_run=$DRY_RUN skip_prune=$SKIP_REMOTE_PRUNE），远端现有 $remote_total 份"
else
  if [ "$remote_total" -gt "$KEEP_REMOTE" ]; then
    while IFS= read -r old; do
      [ -n "$old" ] || continue
      rclone deletefile --config "$RCLONE_CONF" "$REMOTE_PATH/$old" || fail "远端删除失败：$old"
      log "远端清理 $old"
    done < <(head -n "$((remote_total - KEEP_REMOTE))" "$TMP/remote.list")
    kept_remote="$KEEP_REMOTE"
  else
    kept_remote="$remote_total"
  fi
fi

status_done
log "backup ok file=$name bytes=$bytes kept_remote=$kept_remote"
