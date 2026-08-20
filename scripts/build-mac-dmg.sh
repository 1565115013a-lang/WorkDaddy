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
# 产出: release/WorkDaddy-<ver>.dmg（ver 取自 daemon.js 的 DAEMON_VERSION）
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

VERSION="$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)"
APP="WorkDaddy.app"
OUT="release/WorkDaddy-${VERSION}.dmg"

echo "==> 版本: ${VERSION}"
echo "==> 产物: ${OUT}"

# 1) 壳完整性自检：launcher 必须有可执行位（1.0.3 原版为 -rwxr-xr-x）
chmod 755 "$APP/Contents/MacOS/launcher"
echo "==> launcher 可执行位已保证: $(stat -f '%Sp' "$APP/Contents/MacOS/launcher")"

# 2) 只覆盖前端代码（保留壳的其余一切：launcher/Info.plist/builtin/node_modules/theme-audit.js）
for f in daemon.js inject.js theme-patches.js lib.js install.sh relaunch-with-cdp.sh uninstall.sh apply-update.sh; do
  [ -f "scripts/$f" ] && cp "scripts/$f" "$APP/Contents/Resources/scripts/$f"
done
# 恢复这些文件的壳权限（与 1.0.3 壳内一致：sh/lib/daemon 755，inject/theme-patches 644）
chmod 755 "$APP/Contents/Resources/scripts/daemon.js" \
  "$APP/Contents/Resources/scripts/lib.js" \
  "$APP/Contents/Resources/scripts/install.sh" \
  "$APP/Contents/Resources/scripts/relaunch-with-cdp.sh" \
  "$APP/Contents/Resources/scripts/uninstall.sh" \
  "$APP/Contents/Resources/scripts/apply-update.sh"
chmod 644 "$APP/Contents/Resources/scripts/inject.js" \
  "$APP/Contents/Resources/scripts/theme-patches.js"
echo "==> 前端代码已覆盖（权限按壳原样）"

# 3) 打包：staging 放 WorkDaddy.app + Applications 软链（与 1.0.3 dmg 同构）
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/WorkDaddy.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "WorkDaddy" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$OUT" >/dev/null
rm -rf "$STAGE"

echo "==> 完成: $(ls -lh "$OUT" | awk '{print $5}')"
echo "    校验: hdiutil attach -nobrowse -readonly '$OUT' 后检查"
echo "          launcher 权限必须为 rwxr-xr-x、daemon.js 版本为 ${VERSION}"
