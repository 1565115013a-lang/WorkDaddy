#!/usr/bin/env bash
# WorkDaddy 自动更新辅助脚本（业界标准 Sparkle 同款：独立进程接管替换，运行中的 app 无法自删）
# 由 daemon.js applyUpdate() 调用，参数：
#   $1 更新源 app 路径（update 目录里解包出的新 WorkDaddy.app）
#   $2 目标 app 路径（默认 /Applications/WorkDaddy.app）
#   $3 本地 API 端口（等待旧 daemon 退出用，默认 47832）
#   $4 日志路径
# 流程：等端口释放 → 备份旧版(.old 可回滚) → 拷贝新版 → 清隔离属性 → 拉起新版
set -uo pipefail

SRC_APP="${1:?缺少源 app 路径}"
APP_PATH="${2:-/Applications/WorkDaddy.app}"
UI_PORT="${3:-47832}"
LOG="${4:-$HOME/Library/Application Support/WorkDaddy/update/apply.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

echo "[apply] $(date '+%F %T') start src=$SRC_APP dst=$APP_PATH"

# 1) 等待旧 daemon 完全退出（端口释放）——运行中的 app 无法被替换
for i in $(seq 1 30); do
  if ! lsof -ti tcp:"$UI_PORT" >/dev/null 2>&1; then break; fi
  sleep 1
done
pkill -f "$APP_PATH/Contents/Resources/scripts/daemon.js" 2>/dev/null || true
pkill -f "scripts/daemon.js" 2>/dev/null || true
sleep 1

# 2) 备份旧版（失败可回滚：mv WorkDaddy.app.old WorkDaddy.app）
rm -rf "$APP_PATH.old"
if [ -d "$APP_PATH" ]; then
  mv "$APP_PATH" "$APP_PATH.old"
fi

# 3) 拷贝新版
mkdir -p "$(dirname "$APP_PATH")"
cp -R "$SRC_APP" "$APP_PATH"
chmod -R u+rwX "$APP_PATH"

# 4) 清 Gatekeeper 隔离属性（否则首次打开被拦；自动更新场景用户已信任过本应用）
xattr -cr "$APP_PATH" 2>/dev/null || true

# 5) 拉起新版（launcher 自带"版本不一致强制重启 daemon + 注入"逻辑）
open "$APP_PATH"

echo "[apply] $(date '+%F %T') done"
exit 0
