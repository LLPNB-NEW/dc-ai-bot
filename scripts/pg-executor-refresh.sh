#!/usr/bin/env bash
# cron 入口：真正的调度逻辑在 pg-executor-refresh.py；保留这个 wrapper 让旧 crontab 不用改路径。
set -u
exec python3 /usr/local/bin/pg-executor-refresh.py "$@"
