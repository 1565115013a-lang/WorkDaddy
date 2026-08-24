#!/usr/bin/env bash
# WorkDaddy macOS dmg 打包（壳子不动原则）
# ============================================================
# 铁律：壳子（WorkDaddy.app 结构 / launcher / Info.plist / 权限 / 签名）永不改动，
#       只覆盖内部前端代码（daemon.js / inject.js / theme-patches.js 等）。
# 背景：1.0.4 首版 dmg 打不开，根因是打包源 app 的 launcher 丢了可执行位
#       （-rw-rw-r--），hdiutil 打包后 macOS 拒绝启动不可执行的 CFBundleExecutable。
# 本脚本每次打包前自检并恢复 launcher 可执行位 + 按 1.0.3 壳的原权限覆盖代码，
# 保证产出包的壳与 1.0.3 完全一致（launcher md5 不变、Info.plist 不变）。
# 用法: bash scripts/build-mac-dmg.sh
# 产出: release/macos/WorkDaddy-<ver>.dmg（ver 取自 daemon.js 的 DAEMON_VERSION）
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

VERSION="${WORKDADDY_BUILD_VERSION:-$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误：发布版本必须是 x.y.z，实际为 ${VERSION}" >&2
  exit 2
fi
APP="WorkDaddy.app"
PROFILE="${WORKDADDY_BUILD_PROFILE:-}"
if [ -z "$PROFILE" ]; then
  for profile in workbuddy-cn workbuddy-ai; do
    WORKDADDY_BUILD_PROFILE="$profile" bash "$0"
  done
  exit 0
fi
case "$PROFILE" in
  workbuddy-ai) PACKAGE_APP_NAME="WorkDaddy AI"; OUT="release/macos/WorkDaddy-AI-${VERSION}.dmg" ;;
  *) PROFILE="workbuddy-cn"; PACKAGE_APP_NAME="WorkDaddy"; OUT="release/macos/WorkDaddy-${VERSION}.dmg" ;;
esac
VERSION_CODE="$(printf '%s' "$VERSION" | tr -d '.')"

echo "==> profile: ${PROFILE}"
echo "==> 版本: ${VERSION}"
echo "==> 产物: ${OUT}"

# 1) 壳完整性自检：launcher 必须有可执行位（1.0.3 原版为 -rwxr-xr-x）
chmod 755 "$APP/Contents/MacOS/launcher"
echo "==> launcher 可执行位已保证: $(stat -f '%Sp' "$APP/Contents/MacOS/launcher")"

# 2) 只覆盖前端代码（保留壳的其余一切：launcher/Info.plist/builtin/node_modules/theme-audit.js）
for f in daemon.js session-db.js inject.js theme-patches.js credit-segments.js credit-resource-queries.js lib.js profiles.js cdp-targets.js sentry-report.js install.sh relaunch-with-cdp.sh uninstall.sh apply-update.sh; do
  [ -f "scripts/$f" ] && cp "scripts/$f" "$APP/Contents/Resources/scripts/$f"
done
# 恢复这些文件的壳权限（与 1.0.3 壳内一致：sh/lib/daemon 755，inject/theme-patches 644）
chmod 755 "$APP/Contents/Resources/scripts/daemon.js" \
  "$APP/Contents/Resources/scripts/lib.js" \
  "$APP/Contents/Resources/scripts/sentry-report.js" \
  "$APP/Contents/Resources/scripts/install.sh" \
  "$APP/Contents/Resources/scripts/relaunch-with-cdp.sh" \
  "$APP/Contents/Resources/scripts/uninstall.sh" \
  "$APP/Contents/Resources/scripts/apply-update.sh"
chmod 644 "$APP/Contents/Resources/scripts/session-db.js" \
  "$APP/Contents/Resources/scripts/inject.js" \
  "$APP/Contents/Resources/scripts/theme-patches.js"
echo "==> 前端代码已覆盖（权限按壳原样）"

# 3) 打包：staging 放 WorkDaddy.app + Applications 软链（与 1.0.3 dmg 同构）
STAGE="$(mktemp -d)"
PACKAGE_APP="$STAGE/${PACKAGE_APP_NAME}.app"
cp -R "$APP" "$PACKAGE_APP"
sed -i.bak "s|^PROFILE=.*|PROFILE=\"${PROFILE}\"|" "$PACKAGE_APP/Contents/MacOS/launcher"
rm -f "$PACKAGE_APP/Contents/MacOS/launcher.bak"
if [ "$PROFILE" = "workbuddy-ai" ]; then
  perl -0pi -e 's/<string>WorkDaddy<\/string>/<string>WorkDaddy AI<\/string>/g' "$PACKAGE_APP/Contents/Info.plist"
fi
perl -0pi -e "s/<string>1\\.0\\.8<\\/string>/<string>${VERSION}<\\/string>/g; s/<string>108<\\/string>/<string>${VERSION_CODE}<\\/string>/g" "$PACKAGE_APP/Contents/Info.plist"
# 无论源码壳当前版本如何，每次产物都必须让 daemon 版本与安装包版本一致。
perl -0pi -e "s/(const DAEMON_VERSION = ')[^']+(';)/\${1}${VERSION}\${2}/" \
  "$PACKAGE_APP/Contents/Resources/scripts/daemon.js"
# 壳内可能残留旧的 release-x.y.z；只替换 Build ID 的版本段，保留日期/功能后缀。
perl -0pi -e "s/(const DAEMON_BUILD_ID = 'release-)[0-9]+\\.[0-9]+\\.[0-9]+/\${1}${VERSION}/" \
  "$PACKAGE_APP/Contents/Resources/scripts/daemon.js"
if ! grep -q "const DAEMON_VERSION = '${VERSION}';" "$PACKAGE_APP/Contents/Resources/scripts/daemon.js" \
  || ! grep -q "const DAEMON_BUILD_ID = 'release-${VERSION}-" "$PACKAGE_APP/Contents/Resources/scripts/daemon.js"; then
  echo "错误：产物 daemon.js 的版本或 Build ID 与 ${VERSION} 不一致" >&2
  exit 1
fi
# app 壳可能携带滞后的 package.json；同步版本元数据，避免旧值覆盖关于页/诊断信息。
if [ -f "$PACKAGE_APP/Contents/Resources/scripts/package.json" ]; then
  perl -0pi -e "s/(\"version\"\s*:\s*\")([^\"]+)(\")/\${1}${VERSION}\${3}/" \
    "$PACKAGE_APP/Contents/Resources/scripts/package.json"
fi
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/安装失败自主解决提示词.txt" <<'EOF'
WorkDaddy macOS 安装失败自助修复
============================

你是 WorkDaddy 的故障修复 agent。用户已经无法正常安装或启动 WorkDaddy，请在用户明确授权的范围内完成排查和修复。任何诊断上报都是可选的外部操作，必须另行取得用户对本次报告的明确同意。

一、准备与排查

1. 在临时目录执行：
   git clone https://github.com/babygoton/WorkDaddy.git
   cd WorkDaddy
2. 阅读 README.md、scripts/install.sh、scripts/relaunch-with-cdp.sh、scripts/daemon.js，结合用户提供的错误复现问题。
3. 只在源码目录操作；不要读取、复制、上传或修改 ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/、~/Library/Application Support/WorkDaddy/accounts/、数据库、Cookie、环境变量、私钥或完整日志。
4. 记录一条关键错误、系统/Node/WorkBuddy 版本和可复现命令；不要粘贴完整日志。
5. 可复现时运行 `bash scripts/install.sh` 和 `bash scripts/relaunch-with-cdp.sh`。

二、修复与验证

1. 只修改源码，保持用户数据和脱敏逻辑不变。
2. 先确认根因；无法确认时明确写“未确认”，不要猜测。
3. 运行：
   node --check scripts/sentry-report.js
   node --check scripts/daemon.js
   node --test test/*.test.js

三、生成短报告

在源码根目录写 WORKDADDY_FIX_REPORT.md。报告硬上限 3500 字符，最多包含：问题/根因、修改文件及目的、测试汇总、用户下一步。每项用短句；只引用一条脱敏错误，不附完整日志、命令输出、账号数据或凭据。

四、可选诊断上报（必须由用户明确同意）

默认不要执行诊断上报，也不要替用户设置遥测环境变量。只有用户明确同意、已经自行设置 `WORKDADDY_TELEMETRY=1`，并且修复通过测试后，才可执行：

   node scripts/sentry-report.js --stage agent-fix --level info --message-file WORKDADDY_FIX_REPORT.md --tags-json '{"source":"workbuddy-agent","status":"fixed","platform":"macos"}'

命令输出必须是 JSON。看到 disabled=true 表示遥测未启用、没有发送，这是正常结果；看到 sent=true 表示已发送；看到 queued=true 表示网络暂时不可用，报告已写入 WorkDaddy 的 telemetry/outbox，后续会在遥测保持启用时重试。不要把 token、账号备份、数据库或完整日志放进 WORKDADDY_FIX_REPORT.md。

如果测试仍未通过，不得伪造 fixed 状态；仅在用户明确同意上报时，才可以改用 status=unresolved，并在报告中写清楚阻塞原因。
EOF
rm -f "$OUT"
hdiutil create -volname "$PACKAGE_APP_NAME" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$OUT" >/dev/null
rm -rf "$STAGE"

echo "==> 完成: $(ls -lh "$OUT" | awk '{print $5}')"
echo "    校验: hdiutil attach -nobrowse -readonly '$OUT' 后检查"
echo "          launcher 权限必须为 rwxr-xr-x、daemon.js 版本为 ${VERSION}"
