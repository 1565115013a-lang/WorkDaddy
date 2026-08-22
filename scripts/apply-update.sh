#!/usr/bin/env bash
# WorkDaddy macOS 自动更新辅助脚本。
# 这个脚本必须是独立进程：daemon 会在它启动后退出，脚本负责停服、替换、校验和重启。
set -Eeuo pipefail

SRC_APP="${1:?缺少源 app 路径}"
APP_PATH="${2:?缺少目标 app 路径}"
UI_PORT="${3:-47832}"
LOG="${4:-$HOME/Library/Application Support/WorkDaddy/update/apply.log}"
ATTEMPT_ID="${5:-unknown}"
LABEL="com.workbuddy.workdaddy"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

timestamp() { date -u '+%FT%TZ'; }
log() { printf '[apply] %s %s\n' "$(timestamp)" "$*"; }
fail() {
  local code="${2:-1}"
  log "FAILED code=$code message=$1"
  exit "$code"
}
on_unhandled_error() {
  local code="$?"
  log "FAILED code=$code command=${BASH_COMMAND:-unknown}"
  exit "$code"
}
trap on_unhandled_error ERR

log "start attempt=$ATTEMPT_ID src=$SRC_APP dst=$APP_PATH port=$UI_PORT pid=$$"
[ -d "$SRC_APP" ] || fail "源应用不存在: $SRC_APP" 10
[ -f "$SRC_APP/Contents/Info.plist" ] || fail "源应用缺少 Contents/Info.plist" 11
[ -f "$SRC_APP/Contents/Resources/scripts/daemon.js" ] || fail "源应用缺少 daemon.js" 12
[ -x "$SRC_APP/Contents/MacOS/launcher" ] || fail "源应用 launcher 不可执行" 13

# KeepAlive/launchd 是异步的；先停服务，再按进程和端口确认旧 daemon 已退出。
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>&1 || log "launchctl bootout 返回非零（可能本来未注册）"
launchctl remove "$LABEL" 2>&1 || log "launchctl remove 返回非零（可能本来未注册）"
pkill -f "$APP_PATH/Contents/Resources/scripts/daemon.js" 2>&1 || true
pkill -f "WorkDaddy.app/Contents/Resources/scripts/daemon.js" 2>&1 || true

PORT_READY=0
for i in $(seq 1 30); do
  if ! lsof -nP -ti tcp:"$UI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then PORT_READY=1; break; fi
  sleep 1
done
if [ "$PORT_READY" != "1" ]; then
  log "端口 $UI_PORT 在 30 秒后仍被占用，拒绝覆盖应用"
  fail "旧 daemon 未退出" 20
fi

OLD_PATH="${APP_PATH}.old"
rm -rf "$OLD_PATH"
if [ -e "$APP_PATH" ]; then
  mv "$APP_PATH" "$OLD_PATH" || fail "无法备份旧应用: $APP_PATH" 21
fi

rollback() {
  local code="${1:-30}"
  log "开始回滚 code=$code"
  pkill -f "$APP_PATH/Contents/Resources/scripts/daemon.js" 2>&1 || true
  rm -rf "$APP_PATH" || true
  if [ -e "$OLD_PATH" ]; then
    mv "$OLD_PATH" "$APP_PATH" || log "回滚失败: $OLD_PATH -> $APP_PATH"
  fi
  if [ -x "$APP_PATH/Contents/MacOS/launcher" ]; then
    open -n "$APP_PATH" || log "回滚后启动旧应用失败"
  fi
  exit "$code"
}

mkdir -p "$(dirname "$APP_PATH")"
cp -R "$SRC_APP" "$APP_PATH" || rollback 22
chmod -R u+rwX "$APP_PATH" || rollback 23
xattr -cr "$APP_PATH" 2>&1 || log "清除隔离属性失败（继续，可能已无隔离属性）"

[ -f "$APP_PATH/Contents/Info.plist" ] || rollback 24
[ -f "$APP_PATH/Contents/Resources/scripts/daemon.js" ] || rollback 25
[ -x "$APP_PATH/Contents/MacOS/launcher" ] || rollback 26

# open 只负责派发应用，随后必须验证新的 daemon 真的回来了；不能把 open 返回 0 当作更新成功。
open -n "$APP_PATH" || rollback 27
log "已派发新版应用，等待 daemon 端口恢复"
READY=0
for i in $(seq 1 45); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  log "新版 daemon 在 45 秒内未恢复，保留日志与旧版备份: $OLD_PATH"
  rollback 28
fi

log "done attempt=$ATTEMPT_ID app=$APP_PATH"
exit 0
