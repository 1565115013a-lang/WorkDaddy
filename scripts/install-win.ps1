# WorkDaddy Windows 安装脚本（install.sh 的 Windows 对应物）
# 用法：双击 install-win.cmd，或 powershell -ExecutionPolicy Bypass -File install-win.ps1
# 作用：复制到安装目录 → 初始化数据目录 → 注册登录自启(HKCU Run) → 启动 launcher（自动拉起 daemon + 以 CDP 模式重启 WorkBuddy）
# 全程用户态，无需管理员权限。
param(
  [string]$SrcDir = $PSScriptRoot,
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy')
)

$ErrorActionPreference = 'Continue'
$targetScripts = Join-Path $AppDir 'scripts'

Write-Host '=============================================================='
Write-Host ' WorkDaddy Windows 安装'
Write-Host '=============================================================='
Write-Host ("  源目录   : " + $SrcDir)
Write-Host ("  安装目录 : " + $AppDir)

# 1) 复制（排除开发/临时文件；node_modules/ws 随包带入）
if (-not (Test-Path (Join-Path $SrcDir 'daemon.js'))) {
  Write-Host '错误：源目录中找不到 daemon.js，请从仓库 scripts/ 目录运行本脚本。'
  exit 1
}
New-Item -ItemType Directory -Force -Path $targetScripts | Out-Null
robocopy $SrcDir $targetScripts /E /XF *.log .DS_Store /XD win\probe
$rc = $LASTEXITCODE
if ($rc -ge 8) {
  Write-Host "复制失败（robocopy=$rc）"
  exit 2
}

# 2) 数据目录
$dataDir = Join-Path $env:APPDATA 'WorkDaddy'
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'accounts') | Out-Null

# 2.5) Logo 图标：随安装复制到安装目录根（桌面快捷方式用），源在 scripts 同级的 WorkDaddy.ico
$logoIcoSrc = Join-Path $SrcDir 'WorkDaddy.ico'
$logoIco = Join-Path $AppDir 'WorkDaddy.ico'
if (Test-Path $logoIcoSrc) {
  try { Copy-Item $logoIcoSrc $logoIco -Force; Write-Host ('  图标复制 : ' + $logoIco) } catch {}
}

# 3) 登录自启（HKCU Run，登录时自动跑 launcher.cmd；崩溃自愈由 watchdog 负责）
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$launcher = Join-Path $targetScripts 'launcher.cmd'
try {
  Set-ItemProperty -Path $runKey -Name 'WorkDaddy' -Value ('"' + $launcher + '"')
  Write-Host '  自启注册：HKCU\...\Run\WorkDaddy = ' $launcher
} catch {
  Write-Host ('  自启注册失败（可忽略，之后手动双击 launcher.cmd 即可）: ' + $_.Exception.Message)
}

# 4) 启动（daemon + 以 CDP 模式重启 WorkBuddy + 注入）
Write-Host '  正在启动 WorkDaddy（如果 WorkBuddy 正在运行，会重启它以开启调试模式）...'
if (Test-Path $launcher) {
  Start-Process -FilePath $launcher -WorkingDirectory (Split-Path $launcher)
} else {
  Write-Host '  警告：launcher.cmd 不存在，跳过自动启动（请到安装目录手动双击）'
}

# 5) 创建桌面快捷方式「WorkDaddy」
#    用 cmd.exe 作为目标程序 + /c 调用脚本，绕开 .cmd/.bat 文件关联被改（如被篡改成记事本）的坑，
#    保证在任何 Windows 上双击桌面图标都能正常启动。
$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not $desktopDir) { $desktopDir = Join-Path $env:USERPROFILE 'Desktop' }
$lnkPath = Join-Path $desktopDir 'WorkDaddy.lnk'
# Logo 图标（macOS 版同款黑白的 WorkBuddy 机器人，打包时置于安装目录根）
$logoIco = Join-Path $AppDir 'WorkDaddy.ico'
try {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $sc.TargetPath       = "$env:ComSpec"                       # cmd.exe —— 与文件关联无关，始终可执行
  $sc.Arguments        = '/d /c call "' + $launcher + '"'  # 由当前 cmd 解释执行，不触发 Explorer 关联
  $sc.WorkingDirectory = (Split-Path $launcher)
  $sc.Description      = 'WorkDaddy – WorkBuddy 增强工具（双击启动）'
  if (Test-Path $logoIco) { $sc.IconLocation = $logoIco + ',0' }   # 用官方 logo，而非 cmd 默认图标
  $sc.Save()
  Write-Host ('  桌面快捷方式 : ' + $lnkPath)
  if (Test-Path $logoIco) { Write-Host ('  图标         : ' + $logoIco) }
} catch {
  Write-Host ('  桌面快捷方式创建失败（可忽略，之后可手动创建）: ' + $_.Exception.Message)
}

Write-Host '=============================================================='
Write-Host ' 安装完成！'
Write-Host ("  安装目录 : " + $AppDir)
Write-Host ("  数据目录 : " + $dataDir)
Write-Host ('  备份账号 : ' + (Join-Path $dataDir 'accounts'))
Write-Host '  卸载     : 运行安装目录 scripts\uninstall-win.ps1'
Write-Host '=============================================================='