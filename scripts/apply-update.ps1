# WorkDaddy Windows 自动更新替换脚本（apply-update.sh 的 Windows 对应物）
# 由 daemon.js applyUpdate() 调用，参数：
#   $1 更新包 zip 路径（update 目录里下载好的 WorkDaddy-<ver>.zip）
#   $2 安装目录（默认 %LOCALAPPDATA%\Programs\WorkDaddy）
#   $3 本地 API 端口（等待旧 daemon 退出用，默认 47832）
# 流程：等端口释放 → 杀 watchdog/daemon → 备份旧目录(.old 可回滚) → 解压替换 → 拉起
# 注意：Windows 运行中的 exe/js 有文件锁，必须先杀进程再替换。
param(
  [Parameter(Mandatory = $true)][string]$SrcZip,
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy'),
  [string]$Port = '47832'
)

$ErrorActionPreference = 'Continue'
$DataDir = Join-Path $env:APPDATA 'WorkDaddy'
$LogDir = Join-Path $DataDir 'update'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'apply.log'
Start-Transcript -Path $Log -Append -Force

Write-Host "[apply] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') start src=$SrcZip dst=$AppDir"

# 1) 杀 watchdog（会连带终止 daemon；PID 文件在数据目录）
$pidFile = Join-Path $DataDir 'watchdog.pid'
if (Test-Path $pidFile) {
  try {
    $wpid = [int]((Get-Content $pidFile -Raw).Trim())
    if ($wpid -gt 0) { taskkill /F /T /PID $wpid 2>$null | Out-Null }
  } catch {}
}

# 2) 兜底：按 API 端口杀残留进程
# watchdog PID 可能来自旧版本或已失效；不要在端口仍被占用时无条件等待 30 秒。
$waitSec = 0
while ($waitSec -lt 10) {
  $listening = @(netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING')
  if ($listening.Count -eq 0) { break }
  # 给被 taskkill 的进程最多几秒退出；仍占用时立即强制清理，避免更新假死。
  if ($waitSec -ge 3) {
    foreach ($line in $listening) {
      $parts = ($line.ToString().Trim() -split '\s+')
      $pid2 = $parts[$parts.Count - 1]
      if ($pid2 -match '^\d+$') { taskkill /F /T /PID $pid2 2>$null | Out-Null }
    }
  }
  Start-Sleep -Seconds 1
  $waitSec++
}
$listening = @(netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING')
foreach ($line in $listening) {
  $parts = ($line.ToString().Trim() -split '\s+')
  $pid2 = $parts[$parts.Count - 1]
  if ($pid2 -match '^\d+$') { taskkill /F /T /PID $pid2 2>$null | Out-Null }
}
Start-Sleep -Seconds 1

# 3) 备份旧目录（回滚：move AppDir.old AppDir）
$oldDir = $AppDir + '.old'
if (Test-Path $oldDir) { Remove-Item -Recurse -Force $oldDir -ErrorAction SilentlyContinue }
if (Test-Path $AppDir) { Move-Item -Force $AppDir $oldDir -ErrorAction SilentlyContinue }

# 4) 解压新版到临时目录，再移动到位（Expand-Archive 无法原地覆盖已存在目录）
$tmpDir = Join-Path $env:TEMP ("workdaddy-update-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
  Expand-Archive -Path $SrcZip -DestinationPath $tmpDir -Force
} catch {
  Write-Host "[apply] 解压失败: $($_.Exception.Message)"
  if (Test-Path $oldDir) { Move-Item -Force $oldDir $AppDir -ErrorAction SilentlyContinue }  # 回滚
  Stop-Transcript
  exit 1
}

# 定位 zip 内的应用根：顶层含 scripts\daemon.js（打包结构）→ 顶层即根；个别情况顶层直接是文件
$srcRoot = $tmpDir
if (-not (Test-Path (Join-Path $tmpDir 'scripts\daemon.js')) -and -not (Test-Path (Join-Path $tmpDir 'daemon.js'))) {
  $hit = Get-ChildItem $tmpDir -Recurse -Filter 'daemon.js' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $srcRoot = Split-Path $hit.FullName -Parent }
}
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

# 复制内容（robocopy /MIR 保留结构；失败则回滚）
$rc = 1
robocopy $srcRoot $AppDir /MIR /NFL /NDL /NJH /NJS /NP
$rc = $LASTEXITCODE  # robocopy 0-7 都算成功
if ($rc -ge 8) {
  Write-Host "[apply] 复制失败(robocopy=$rc)，回滚旧版本"
  Remove-Item -Recurse -Force $AppDir -ErrorAction SilentlyContinue
  if (Test-Path $oldDir) { Move-Item -Force $oldDir $AppDir }
  Stop-Transcript
  exit 2
}

# 5) 校验启动器后清理备份并拉起（launcher 幂等：检测 daemon 后启动 watchdog）
$launcher = Join-Path (Join-Path $AppDir 'scripts') 'launcher.cmd'
$launcherVbs = Join-Path (Join-Path $AppDir 'scripts') 'launcher-hidden.vbs'
if (-not (Test-Path $launcher)) {
  Write-Host '[apply] 新版本缺少 scripts\\launcher.cmd，回滚旧版本'
  Remove-Item -Recurse -Force $AppDir -ErrorAction SilentlyContinue
  if (Test-Path $oldDir) { Move-Item -Force $oldDir $AppDir -ErrorAction SilentlyContinue }
  Stop-Transcript
  exit 3
}
if (Test-Path $launcherVbs) {
  # wscript.exe 不创建控制台，自动更新重启时也不再弹出空白 Windows Terminal。
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('//nologo "' + $launcherVbs + '"') -WorkingDirectory (Split-Path $launcher)
} else {
  # 兼容旧版本目录：直接启动 launcher.cmd。
  Start-Process -FilePath $launcher -WorkingDirectory (Split-Path $launcher)
}
Remove-Item -Recurse -Force $oldDir -ErrorAction SilentlyContinue
Write-Host "[apply] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') done"
Stop-Transcript
exit 0
