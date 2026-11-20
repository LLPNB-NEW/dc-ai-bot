#!/usr/bin/env python3
"""宿主侧执行器调度器：每分钟跑一次，读后台写下的 JSON，必要时刷新 AI Studio 页面。

后台（容器内）只能写数据目录里的文件，碰不到 Docker / systemd；这个脚本是唯一有权限
重启浏览器并把结果写回 executor-status.json 的一方。三个文件的名字与形状必须与
src/node/executor-files.ts 保持一致。
"""
import fcntl
import json
import os
import secrets
import subprocess
import sys
import time
import traceback
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(os.environ.get("PG_EXECUTOR_BASE", "/opt/pg-executor"))
DATA_DIR = Path(os.environ.get("PG_EXECUTOR_DATA_DIR", "/opt/dc-ai-bot/data"))
CONTROL_FILE = DATA_DIR / "executor-control.json"
REQUEST_FILE = DATA_DIR / "executor-request.json"
STATUS_FILE = DATA_DIR / "executor-status.json"
LOCK_FILE = BASE / "guard.lock"
LOG_FILE = BASE / "refresh.log"
INJECT = BASE / "bin" / "inject.py"
CHECK = BASE / "bin" / "check-executor.py"
PYLIB = BASE / "pylib"
HEALTH_URL = os.environ.get("PG_EXECUTOR_HEALTH_URL", "https://example.com/pg/healthz")
RELAY_ENV = Path(os.environ.get("PG_RELAY_ENV", "/opt/pg-relay/.env"))

DEFAULT_INTERVAL_MINUTES = 30
MIN_INTERVAL_MINUTES = 1
MAX_INTERVAL_MINUTES = 1440
INJECT_TIMEOUT_SECONDS = 200
LOCK_WAIT_SECONDS = 20
PENDING_SETTLE_SECONDS = 5
AFTER_SETTLE_SECONDS = 5


def now_utc():
    return datetime.now(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def log(message):
    try:
        BASE.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(iso(now_utc()) + " " + message + "\n")
    except OSError:
        pass


def read_json(path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def write_json(path, value):
    """先写同目录临时文件再 rename，宿主和后台都不会读到半截 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
    try:
        with temp.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.write("\n")
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    except OSError:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def read_config():
    value = read_json(CONTROL_FILE)
    if value is None:
        return {"enabled": True, "intervalMinutes": DEFAULT_INTERVAL_MINUTES, "updatedAt": ""}
    enabled = value.get("enabled")
    interval = value.get("intervalMinutes")
    if not isinstance(enabled, bool):
        enabled = True
    if not isinstance(interval, int) or isinstance(interval, bool) or interval < MIN_INTERVAL_MINUTES or interval > MAX_INTERVAL_MINUTES:
        interval = DEFAULT_INTERVAL_MINUTES
    updated_at = value.get("updatedAt")
    return {
        "enabled": enabled,
        "intervalMinutes": interval,
        "updatedAt": updated_at if isinstance(updated_at, str) else "",
    }


def read_request():
    value = read_json(REQUEST_FILE)
    if value is None:
        # 文件不存在是正常的；存在但坏掉时删掉，否则后台按钮会永远回 409。
        if REQUEST_FILE.exists():
            try:
                REQUEST_FILE.unlink()
                log("drop malformed request file")
            except OSError:
                pass
        return None
    request_id = value.get("id")
    requested_at = value.get("requestedAt")
    if not isinstance(request_id, str) or not isinstance(requested_at, str):
        try:
            REQUEST_FILE.unlink()
            log("drop malformed request file")
        except OSError:
            pass
        return None
    return {"id": request_id, "requestedAt": requested_at}


def read_status():
    value = read_json(STATUS_FILE)
    if value is None:
        return None
    if value.get("phase") not in ("idle", "running"):
        return None
    if not isinstance(value.get("checkedAt"), str):
        return None
    return value


def primary_key_suffix():
    try:
        with RELAY_ENV.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("API_KEYS="):
                    key = line.split("=", 1)[1].strip().split(",")[0].strip()
                    return key[-4:] if key else ""
    except OSError:
        return ""
    return ""


def read_health():
    try:
        request = urllib.request.Request(
            HEALTH_URL,
            headers={"User-Agent": "curl/8.5.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
    except Exception as error:
        return {"ok": False, "pending": None, "connected": False, "summary": "healthz 读取失败: %s" % error}

    if not isinstance(payload, dict):
        return {"ok": False, "pending": None, "connected": False, "summary": "healthz 返回非对象"}

    raw_pending = payload.get("pending")
    try:
        pending = int(raw_pending) if raw_pending is not None else None
    except (TypeError, ValueError):
        pending = None

    executors = payload.get("executors")
    if not isinstance(executors, list):
        executors = []
    suffix = primary_key_suffix()
    if suffix:
        executors = [item for item in executors if isinstance(item, dict) and str(item.get("apiKey", "")).endswith(suffix)]
    executor = executors[0] if executors else None
    if executor is None:
        return {
            "ok": False,
            "pending": pending,
            "connected": False,
            "summary": "执行器未注册（Key 后缀 %s）" % (suffix or "未知"),
        }

    result = {"ok": True, "pending": pending, "connected": True}
    for field in ("connectedSeconds", "requestsServed", "requestsFailed"):
        value = executor.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            result[field] = int(value)
    connected = result.get("connectedSeconds", 0)
    served = result.get("requestsServed", 0)
    failed = result.get("requestsFailed", 0)
    result["summary"] = "ok connectedSeconds=%s requestsServed=%s requestsFailed=%s" % (connected, served, failed)
    return result


def pending_is_busy(health):
    return health.get("pending") != 0


def write_status(status):
    write_json(STATUS_FILE, status)


def next_due_after(config, finished_at):
    if not config["enabled"]:
        return None
    return finished_at + timedelta(minutes=config["intervalMinutes"])


def next_due_from_last(config, last, now):
    """配置改过后从上次完成时间重算：改短了不必等旧到期，改长了也不会提前跑。"""
    if not config["enabled"]:
        return None
    if isinstance(last, dict):
        finished = parse_iso(last.get("finishedAt"))
        if finished is not None:
            return finished + timedelta(minutes=config["intervalMinutes"])
    return now


def idle_status(checked_at, next_due_at, last, current=None, config_updated_at=""):
    status = {"phase": "idle", "checkedAt": iso(checked_at)}
    if next_due_at is not None:
        status["nextDueAt"] = iso(next_due_at)
    if current is not None:
        status["current"] = current
    if last is not None:
        status["last"] = last
    if config_updated_at:
        status["configUpdatedAt"] = config_updated_at
    return status


def run_inject():
    env = os.environ.copy()
    env["PYTHONPATH"] = str(PYLIB) + (":" + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    BASE.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(iso(now_utc()) + " run inject.py --force\n")
        handle.flush()
        try:
            completed = subprocess.run(
                [sys.executable, str(INJECT), "--force"],
                cwd=str(BASE),
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                timeout=INJECT_TIMEOUT_SECONDS,
                check=False,
            )
            return completed.returncode, "inject exit=%s" % completed.returncode
        except subprocess.TimeoutExpired:
            return 124, "inject timeout after %ss" % INJECT_TIMEOUT_SECONDS
        except OSError as error:
            return 127, "inject failed: %s" % error


def main():
    config = read_config()
    status = read_status()
    request = read_request()
    now = now_utc()

    previous_last = status.get("last") if isinstance(status, dict) else None
    stored_config_updated_at = ""
    if isinstance(status, dict) and isinstance(status.get("configUpdatedAt"), str):
        stored_config_updated_at = status["configUpdatedAt"]
    next_due = parse_iso(status.get("nextDueAt")) if isinstance(status, dict) else None
    # 后台保存新间隔后 updatedAt 会变；不等旧 nextDueAt，按新间隔从上次完成时间重算。
    if config["updatedAt"] != stored_config_updated_at:
        next_due = next_due_from_last(config, previous_last, now)

    # 与 guard 共用锁：guard 那一路用 flock -w 20，这里拿不到就跳过，下一分钟再来。
    try:
        lock_handle = LOCK_FILE.open("a+")
    except OSError as error:
        log("skip: cannot open lock: %s" % error)
        return 0
    try:
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    log("skip: guard lock busy")
                    return 0
                time.sleep(1)

        try:
            running = subprocess.run(
                ["pgrep", "-f", str(INJECT)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError:
            running = None
        if running is not None and running.returncode == 0:
            log("skip: inject already running")
            return 0

        manual = request is not None
        scheduled_due = config["enabled"] and (next_due is None or now >= next_due)
        if not manual and not scheduled_due:
            # 不刷新也写一次 checkedAt，后台才知道宿主还在跑；下次到期时间保持不变。
            write_status(idle_status(now, next_due, previous_last, None, config["updatedAt"]))
            return 0

        source = "manual" if manual else "scheduled"
        run_id = request["id"] if manual else secrets.token_hex(16)
        started_at = now_utc()

        # 先确认没有正在生成的请求：刷新会把页面导航走，正在执行的对话会被打断。
        health = read_health()
        if pending_is_busy(health):
            reason = "pending=%s" % health.get("pending")
            log("skip: %s source=%s" % (reason, source))
            if manual:
                # 手动请求保留，宿主下一分钟再试；后台仍显示排队中。
                write_status(idle_status(started_at, next_due, previous_last, None, config["updatedAt"]))
            else:
                # 定时刷新跳过这一轮，把下次到期推到下一周期，避免每分钟重试。
                write_status(idle_status(started_at, next_due_after(config, started_at), previous_last, None, config["updatedAt"]))
            return 0

        time.sleep(PENDING_SETTLE_SECONDS)
        health = read_health()
        if pending_is_busy(health):
            reason = "pending=%s" % health.get("pending")
            log("skip: %s source=%s" % (reason, source))
            if manual:
                write_status(idle_status(started_at, next_due, previous_last, None, config["updatedAt"]))
            else:
                write_status(idle_status(started_at, next_due_after(config, started_at), previous_last, None, config["updatedAt"]))
            return 0

        before = health
        current = {"id": run_id, "source": source, "startedAt": iso(started_at)}
        write_status({"phase": "running", "checkedAt": iso(started_at), "current": current, "configUpdatedAt": config["updatedAt"]})

        rc, message = run_inject()
        time.sleep(AFTER_SETTLE_SECONDS)
        after = read_health()
        finished_at = now_utc()
        ok = rc == 0 and after.get("ok") is True and after.get("pending") == 0
        last = {
            "id": run_id,
            "source": source,
            "startedAt": iso(started_at),
            "finishedAt": iso(finished_at),
            "ok": ok,
            "message": message,
            "durationMs": int((finished_at - started_at).total_seconds() * 1000),
            "before": before,
            "after": after,
        }
        write_status(idle_status(finished_at, next_due_after(config, finished_at), last, None, config["updatedAt"]))
        log("refresh done: source=%s rc=%s ok=%s after=%s" % (source, rc, ok, after.get("summary")))

        if manual:
            try:
                REQUEST_FILE.unlink()
            except FileNotFoundError:
                pass
            except OSError as error:
                log("cannot remove request: %s" % error)
        return 0
    finally:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        lock_handle.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        log("fatal: " + traceback.format_exc().replace("\n", " | "))
        raise SystemExit(1)
