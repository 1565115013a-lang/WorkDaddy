#!/usr/bin/env bash
# 安装 WorkBuddy 多账号切换器（CDP 版）
# 1) 创建备份目录并首次同步当前账号
# 2) 注册 launchd 常驻守护进程（登录自启 + 崩溃自动拉起）
# 用法: bash scripts/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.workbuddy.workdaddy"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_LABEL="com.workbuddy.hellobuddy"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
DEFAULT_DATA_DIR="$HOME/Library/Application Support/WorkDaddy"
LEGACY_DATA_DIR="$HOME/Library/Application Support/HelloBuddy"
if [ "${WBSWITCH_DATA_DIR:-}" = "$LEGACY_DATA_DIR" ]; then
  DATA_DIR="$DEFAULT_DATA_DIR"
else
  DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
fi
UI_PORT="${WBSWITCH_PORT:-47832}"
CDP_PORT="${WBSWITCH_CDP_PORT:-}"

# 找一个可用的 node（优先 managed，其次 PATH）
NODE=""
for c in \
  "/Users/h/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
  "/Users/h/.nvm/versions/node/v20.20.2/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "错误: 未找到 node，请先安装 Node.js"; exit 1
fi

REPORTER="$DIR/scripts/sentry-report.js"
report_install_failure() {
  local code="$1"
  if [ -f "$REPORTER" ]; then
    "$NODE" "$REPORTER" \
      --stage macos-install \
      --message "install.sh 失败 (exit=${code})" \
      --extra-json "{\"exitCode\":${code}}" >/dev/null 2>&1 || true
  fi
}
on_install_exit() {
  local code="$?"
  if [ "$code" -ne 0 ]; then report_install_failure "$code"; fi
  return "$code"
}
trap on_install_exit EXIT

echo "==> 创建备份目录: $DATA_DIR"
mkdir -p "$DATA_DIR/accounts"
chmod 700 "$DATA_DIR"

echo "==> 停止旧版 HelloBuddy 守护进程（保留旧备份，首次同步时自动迁移）"
launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LEGACY_PLIST"
pkill -f "$DIR/scripts/daemon.js" 2>/dev/null || true

echo "==> 首次同步当前登录账号"
if ! "$NODE" "$DIR/scripts/sync.js"; then
  "$NODE" "$REPORTER" --stage macos-sync --message "首次同步当前账号失败" >/dev/null 2>&1 || true
  echo "   (首次同步失败，守护进程启动后会自动重试)"
fi

echo "==> 注册 launchd 守护进程: $LABEL"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${DIR}/scripts/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA_DIR}/daemon.log</string>
  <key>StandardErrorPath</key><string>${DATA_DIR}/daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WBSWITCH_DATA_DIR</key><string>${DATA_DIR}</string>
    <key>WBSWITCH_PORT</key><string>${UI_PORT}</string>
PLISTEOF
if [ -n "$CDP_PORT" ]; then
  cat >> "$PLIST" <<PLISTEOF
    <key>WBSWITCH_CDP_PORT</key><string>${CDP_PORT}</string>
PLISTEOF
fi
cat >> "$PLIST" <<'PLISTEOF'
  </dict>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
LAUNCHD_OK=1
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/tmp/wbswitch-launchctl.err; then
  LAUNCHD_OK=0
  echo "   ⚠️ launchd 注册失败（若你是从 WorkBuddy 应用内执行的安装，这是正常现象）。"
  echo "     手动在【终端】中执行以下命令即可注册开机自启："
  echo "       launchctl bootstrap gui/\$(id -u) \"$PLIST\""
fi
if [ "$LAUNCHD_OK" = "1" ]; then
  sleep 1
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true
fi

echo "==> 启动守护进程（后台）"
WBSWITCH_DATA_DIR="$DATA_DIR" nohup "$NODE" "$DIR/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 &
disown 2>/dev/null || true
echo "   pid: $!"

echo "==> 等待守护进程就绪"
UI_UP=0
for i in $(seq 1 10); do
  if curl -s -m 1 "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1; then UI_UP=1; break; fi
  sleep 1
done

echo ""
echo "=============================================="
echo "✅ 安装完成！"
echo "   Web 界面 : http://127.0.0.1:${UI_PORT}"
echo "   备份目录 : ${DATA_DIR}"
echo "   CDP 端口 : ${CDP_PORT:-自动选择 (9222-9232/9333，端口占用会自动切换)}"
if [ "$LAUNCHD_OK" = "1" ]; then
  echo "   开机自启 : launchd 已注册 ✅"
else
  echo "   开机自启 : 未注册 ⚠️（在终端执行 launchctl bootstrap 注册，见上方命令）"
fi
echo ""
echo "下一步：让 CDP 生效（可选但推荐）"
echo "   bash \"$DIR/scripts/relaunch-with-cdp.sh\""
echo "   将以自动选择的 --remote-debugging-port 重启 WorkBuddy，"
echo "   之后登录/切换账号会实时自动备份，切换后可直接刷新窗口。"
echo "=============================================="

# 尝试打开管理界面
open "http://127.0.0.1:${UI_PORT}" 2>/dev/null || true
exit 0
