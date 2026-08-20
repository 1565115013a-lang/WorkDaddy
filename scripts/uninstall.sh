#!/usr/bin/env bash
# 卸载 WorkBuddy 多账号切换器（保留备份数据）
# 用法: bash scripts/uninstall.sh
set -euo pipefail

LABEL="com.workbuddy.hellobuddy"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DATA_DIR="${WBSWITCH_DATA_DIR:-$HOME/Library/Application Support/HelloBuddy}"

echo "==> 停止并移除 launchd 守护进程"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "==> 完成"
echo "   备份数据保留在: $DATA_DIR"
echo "   如需彻底删除备份，请手动执行: rm -rf \"$DATA_DIR\""
