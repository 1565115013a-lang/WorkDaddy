#!/usr/bin/env bash
# WorkDaddy Windows 发布包打包脚本（在 macOS/Linux 上运行即可产出 Windows zip）
# 产出：release/WorkDaddy-<ver>-win64.zip（顶层含 scripts\，供 install-win.cmd / apply-update.ps1 使用）
# 可选：内置 node_modules/ws（面板 DevTools 代理依赖；无则代理功能降级，其余功能不受影响）
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

VERSION="$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)"
OUT="release/WorkDaddy-${VERSION}-win64.zip"

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
# 3.1a) Windows 故障排查提示词（供用户在安装失败时交给修复 agent）
if [ -f "$DIR/安装失败自主解决提示词.txt" ]; then
  cp "$DIR/安装失败自主解决提示词.txt" "$STAGE/安装失败自主解决提示词.txt"
fi
# 3.2) scripts\ 本体（含 node_modules/ws、builtin）
cp -R scripts "$STAGE/scripts"
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
# 3.3.5) 非 ASCII 文件名守护：仅允许根目录的故障排查提示词，其余路径必须保持 ASCII。
#        macOS 自带 Info-ZIP 会使用 UTF-8 条目写入；安装/更新脚本本身仍全部使用 ASCII 路径。
NON_ASCII_PATHS="$(find "$STAGE" -not -path '*/node_modules/*' 2>/dev/null | LC_ALL=C grep '[^ -~]' || true)"
UNEXPECTED_NON_ASCII="$(printf '%s\n' "$NON_ASCII_PATHS" | LC_ALL=C grep -v '安装失败自主解决提示词\.txt$' || true)"
if [ -n "$UNEXPECTED_NON_ASCII" ]; then
  echo "==> ERROR: 发布包包含未批准的非 ASCII 文件路径，已终止打包！"
  printf '%s\n' "$UNEXPECTED_NON_ASCII" | head -20
  rm -rf "$STAGE"
  exit 3
fi
echo "==> 非 ASCII 文件名守护通过（仅包含批准的故障排查提示词）"
# 3.4) 打包：优先使用 Python zipfile，确保中文提示词写入 UTF-8 文件名标记。
#      macOS 自带 zip 会把中文文件名按本地代码页写入，Windows/Python 解压后会出现乱码。
#      没有 Python 且需要中文提示词时直接失败，避免生成名字损坏的发布包。
if command -v python3 >/dev/null 2>&1; then
  python3 - "$STAGE" "$DIR/$OUT" <<'PY'
import os
import sys
import zipfile

stage, output = sys.argv[1:]
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for root, dirs, files in os.walk(stage):
        dirs.sort()
        files.sort()
        for name in dirs:
            source = os.path.join(root, name)
            arcname = os.path.relpath(source, stage).replace(os.sep, '/') + '/'
            archive.write(source, arcname)
        for name in files:
            source = os.path.join(root, name)
            arcname = os.path.relpath(source, stage).replace(os.sep, '/')
            archive.write(source, arcname)
PY
elif [ -f "$STAGE/安装失败自主解决提示词.txt" ]; then
  echo "==> ERROR: 包含中文故障排查提示词，但当前环境没有 python3，无法生成 UTF-8 ZIP。"
  rm -rf "$STAGE"
  exit 4
elif command -v zip >/dev/null 2>&1; then
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
