#!/usr/bin/env bash
# 备份 data 目录（作品文件 + 论坛 + 密码摘要）
# 用法：bash backup.sh [/opt/student-site]
# 建议加进 cron：0 3 * * * /opt/student-site/deploy/backup.sh >/dev/null 2>&1

set -euo pipefail

APP_DIR="${1:-/opt/student-site}"
SRC="$APP_DIR/data"
DST="$APP_DIR/backups"

mkdir -p "$DST"
tar -czf "$DST/data-$(date +%F).tar.gz" -C "$SRC" .
find "$DST" -name 'data-*.tar.gz' -mtime +14 -delete

echo "已备份到 $DST/data-$(date +%F).tar.gz"
