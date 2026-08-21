#!/usr/bin/env bash
# WorkDaddy Windows 发布包打包脚本（在 macOS/Linux 上运行即可产出 Windows zip）
# 产出：release/windows/WorkDaddy-<ver>-win64.zip（顶层含 scripts\，供 install-win.cmd / apply-update.ps1 使用）
# 可选：内置 node_modules/ws（面板 DevTools 代理依赖；无则代理功能降级，其余功能不受影响）
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

VERSION="${WORKDADDY_BUILD_VERSION:-$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)}"
OUT="release/windows/WorkDaddy-${VERSION}-win64.zip"

echo "==> 版本: ${VERSION}"
echo "==> 产物: ${OUT}"

# 1) 内置 ws（面板 DevTools 代理需要）；已存在则跳过
if [ ! -d scripts/node_modules/ws ]; then
  echo "==> 生成 node_modules/ws（DevTools 代理依赖）"
  TMPNODE="$(mktemp -d)"
  (cd "$TMPNODE" && npm init -y >/dev/null 2>&1 && npm install ws --no-audit --no-fund >/dev/null 2>&1)
  mkdir -p scripts/node_modules
  rm -rf scripts/node_modules/ws
  mv "$TMPNODE/node_modules/ws" scripts/node_modules/ws
  rm -rf "$TMPNODE"
fi

# 2) 内置资产（官方壁纸 + nebula 主题，单一来源：WorkDaddy.app/Contents/Resources/scripts/builtin）
#    仓库 scripts/ 本身不含 builtin，必须从 app 打包产物复制，否则 Windows 面板会显示「暂无官方壁纸」
BUILTIN_SRC="$DIR/WorkDaddy.app/Contents/Resources/scripts/builtin"
if [ -d "$BUILTIN_SRC" ]; then
  echo "==> 内置资产 builtin -> scripts/builtin（$(find "$BUILTIN_SRC/wallpapers" -name '*.webp' | wc -l | tr -d ' ') 张壁纸 + 主题）"
  mkdir -p scripts/builtin
  cp -R "$BUILTIN_SRC/." scripts/builtin/
else
  echo "==> 警告: 未找到内置资产 $BUILTIN_SRC（无 WorkDaddy.app？），打包将不含官方壁纸/主题"
fi

# 3) 打包：staging 目录，把两个顶层入口文件 + scripts/ 一起打进 zip 根（解压即见一键安装/启动）
#    注意 apply-update.ps1 复用本结构（需 zip 内存在 scripts\daemon.js 做 srcRoot 判定）
STAGE="$(mktemp -d)"
rm -f "$OUT"
# 3.1) 顶层入口（zip 根）：Install-WorkDaddy.cmd / Start-WorkDaddy.cmd
cp scripts/Install-WorkDaddy.cmd "$STAGE/Install-WorkDaddy.cmd"
cp scripts/Start-WorkDaddy.cmd "$STAGE/Start-WorkDaddy.cmd"
cat > "$STAGE/安装失败自主解决提示词.txt" <<'EOF'
WorkDaddy Windows 安装失败自助修复
==================================

你是 WorkDaddy 的故障修复 agent。用户已经无法正常安装或启动 WorkDaddy，请在用户明确授权的范围内完成排查、修复和自动上报。

一、准备源码

1. 在一个新的临时目录执行：

   git clone https://github.com/babygoton/WorkDaddy.git
   cd WorkDaddy

2. 先阅读 README.md、scripts/install-win.ps1、scripts/install-win.cmd、scripts/launcher.cmd、scripts/win-launcher.js、scripts/daemon.js，以及用户提供的 PowerShell/cmd 错误和 %APPDATA%\\WorkDaddy\\*.log。不要读取、复制、上传或修改以下内容：

   - %APPDATA%\\WorkDaddy\\accounts\\
   - WorkBuddy 登录文件、Cookie、数据库、环境变量、私有密钥

二、复现问题

1. 只在源码目录中操作。优先从源码根目录执行：

   powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\install-win.ps1

2. 如果需要验证启动流程，再执行：

   .\\scripts\\launcher.cmd

3. 记录实际失败命令、完整错误文本、Windows 版本、Node 版本和 WorkBuddy 版本。不要猜测根因。

三、修复问题

1. 只修改 GitHub 源码目录，不直接修改 %LOCALAPPDATA%\\Programs\\WorkDaddy 或用户数据目录。
2. 保持现有 Windows 用户态安装方式和安全边界；不要删除账号数据，不要关闭现有脱敏逻辑。
3. 修改后重新执行最小复现命令，并运行：

   node --check scripts/sentry-report.js
   node --check scripts/daemon.js
   node --check scripts/win-launcher.js
   node --test test/*.test.js

四、生成修复报告

在源码根目录创建 WORKDADDY_FIX_REPORT.md，必须包含：

   - 原始问题和复现命令
   - 确认的根因；如果没有确认，写“未确认”
   - 修改的文件和每个修改的目的
   - 测试命令和实际结果
   - 用户安装时需要重新执行的命令

五、自动上报

只有在修复已经通过测试后，执行：

   node scripts\\sentry-report.js --stage agent-fix --level info --message-file WORKDADDY_FIX_REPORT.md --tags-json '{"source":"workbuddy-agent","status":"fixed","platform":"windows"}'

命令输出必须是 JSON。看到 sent=true 表示已发送；看到 queued=true 表示网络暂时不可用，报告已写入 WorkDaddy 的 telemetry/outbox，后续会自动重试。不要把 token、账号备份、数据库或完整日志放进 WORKDADDY_FIX_REPORT.md。

如果测试仍未通过，不得伪造 fixed 状态；可以改用 status=unresolved 上报，并在报告中写清楚阻塞原因。
EOF
# 3.2) scripts\ 本体（含 node_modules/ws、builtin）
cp -R scripts "$STAGE/scripts"
if [ -n "${WORKDADDY_BUILD_VERSION:-}" ]; then
  perl -0pi -e "s/(const DAEMON_VERSION = ')[^']+(';)/\${1}${VERSION}\${2}/" \
    "$STAGE/scripts/daemon.js"
fi
# 3.2a) Logo 图标：放入 scripts\（install-win.ps1 从 SrcDir 同名找并复制到安装目录根）
if [ -f "$DIR/release/WorkDaddy.ico" ]; then
  cp "$DIR/release/WorkDaddy.ico" "$STAGE/scripts/WorkDaddy.ico"
  echo "==> 内置 logo 图标 -> scripts/WorkDaddy.ico"
else
  echo "==> 警告: 未找到 release/WorkDaddy.ico，桌面图标将回退为 cmd 默认"
fi
# 3.3) 排除开发/临时文件 + 顶层入口在 scripts\ 内的重复副本
#      （Install-WorkDaddy.cmd / Start-WorkDaddy.cmd 只应存在于 zip 根，避免用户误进
#       scripts\ 双击导致相对路径解析成 scripts\scripts\install-win.ps1 报错）
rm -rf "$STAGE/scripts/win/probe" "$STAGE/scripts/win/probe/"* 2>/dev/null || true
rm -f "$STAGE/scripts/Install-WorkDaddy.cmd" "$STAGE/scripts/Start-WorkDaddy.cmd" 2>/dev/null || true
find "$STAGE" -name '*.log' -delete 2>/dev/null || true
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true
# 3.4) 打包：zip 优先；无 zip 的环境用 Windows 系统自带 bsdtar（生成标准 / 分隔符 zip）。
#      绝不用 PowerShell Compress-Archive —— 它产出反斜杠分隔符，非标准 zip 会被解压工具把
#      scripts\daemon.js 当单个文件名，导致解压结构错乱、入口秒退。
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -r -q "$DIR/$OUT" .)
else
  tar -a -cf "$DIR/$OUT" -C "$STAGE" .
fi
rm -rf "$STAGE"

# 4) 清理临时内置到 scripts/ 的 builtin（避免污染仓库）
if [ -d "$BUILTIN_SRC" ] && [ -d scripts/builtin ]; then
  rm -rf scripts/builtin
fi

echo "==> 完成: $(ls -lh "$OUT" | awk '{print $5}')"
echo ""
echo "在 Windows 上：解压 zip 后，在顶层直接双击 Install-WorkDaddy.cmd 一键安装（自动建桌面图标+自启）；"
echo "日常启动双击 Start-WorkDaddy.cmd 或桌面 WorkDaddy 图标。"
echo "每 6 小时自动检查更新（GitHub Releases 需同时上传 .dmg 与 -win64.zip 两个资产，Windows 自动静默升级）。"
