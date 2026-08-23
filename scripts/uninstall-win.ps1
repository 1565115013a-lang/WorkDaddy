# WorkDaddy Windows 卸载脚本（uninstall.sh 的 Windows 对应物）
# 用法：powershell -ExecutionPolicy Bypass -File uninstall-win.ps1
# 默认保留备份数据（%APPDATA%\WorkDaddy）；加 -RemoveData 一并删除。
param(
  [switch]$RemoveData,
  [string]$AppDir = '',
  [string]$Profile = '__WBS_DEFAULT_PROFILE__'
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Profile) -or $Profile -eq '__WBS_DEFAULT_PROFILE__') { $Profile = 'workbuddy-cn' }
if ($Profile -ne 'workbuddy-ai') { $Profile = 'workbuddy-cn' }
$productName = if ($Profile -eq 'workbuddy-ai') { 'WorkDaddy AI' } else { 'WorkDaddy' }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $env:LOCALAPPDATA (Join-Path 'Programs' $productName) }
$dataRoot = Join-Path $env:APPDATA 'WorkDaddy'
$dataDir = if ($Profile -eq 'workbuddy-ai') { Join-Path $dataRoot 'profiles\workbuddy-ai' } else { $dataRoot }

Write-Host ('卸载 ' + $productName + '...')

# 1) 移除登录自启（兼容 WorkDaddy / WorkDaddy AI 两个 profile）
try {
  foreach ($runName in @('WorkDaddy', 'WorkDaddy AI')) {
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $runName -ErrorAction SilentlyContinue
  }
  Write-Host '  已移除登录自启项'
} catch {}

# 2) 停止 watchdog + daemon
$pidFile = Join-Path $dataDir 'watchdog.pid'
if (Test-Path $pidFile) {
  try {
    $wpid = [int]((Get-Content $pidFile -Raw).Trim())
    if ($wpid -gt 0) { taskkill /F /T /PID $wpid 2>$null | Out-Null }
  } catch {}
}
foreach ($line in (netstat -ano | Select-String (':4783\d\s') | Select-String 'LISTENING')) {
  $parts = ($line.ToString().Trim() -split '\s+')
  $pid2 = $parts[$parts.Count - 1]
  if ($pid2 -match '^\d+$') { taskkill /F /T /PID $pid2 2>$null | Out-Null }
}

# 3) 删除安装目录
if (Test-Path $AppDir) {
  Remove-Item -Recurse -Force $AppDir -ErrorAction SilentlyContinue
  Write-Host ('  已删除安装目录: ' + $AppDir)
}

# 4) 数据目录（可选）
if ($RemoveData) {
  if (Test-Path $dataDir) {
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
    Write-Host ('  已删除数据目录（含账号备份）: ' + $dataDir)
  }
} else {
  Write-Host ('  已保留备份数据（含账号备份）: ' + $dataDir)
}

Write-Host '卸载完成。'
if (-not $RemoveData) {
  Write-Host '如需同时删除账号备份，请重新运行：uninstall-win.ps1 -RemoveData'
}
