param(
  [Parameter(Mandatory = $true)][string]$BoundaryPath,
  [Parameter(Mandatory = $true)][string]$AppDir,
  [ValidateSet('workbuddy-cn', 'workbuddy-ai')][string]$Profile = 'workbuddy-cn'
)

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -ne $false) {
    [Console]::Error.WriteLine('Refusing to prepare WorkDaddy installation with elevated privileges.')
    exit 5
  }
} catch {
  [Console]::Error.WriteLine('Cannot verify that the installer is running as a standard user.')
  exit 5
}

if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) { exit 0 }

$ErrorActionPreference = 'Stop'
$diagnosticFile = Join-Path ([IO.Path]::GetTempPath()) 'WorkDaddy-prepare-install.log'
try {
  [IO.File]::AppendAllText(
    $diagnosticFile,
    ('[' + [DateTime]::UtcNow.ToString('o') + '] start profile=' + $Profile + ' appDir=' + $AppDir + [Environment]::NewLine),
    (New-Object Text.UTF8Encoding($false)))
  . $BoundaryPath
  $dataRoot = Join-Path $env:APPDATA 'WorkDaddy'
  $dataDir = if ($Profile -eq 'workbuddy-ai') { Join-Path $dataRoot 'profiles\workbuddy-ai' } else { $dataRoot }
  $uiPort = if ($Profile -eq 'workbuddy-ai') { 47833 } else { 47832 }
  Stop-VerifiedWorkDaddyLifecycle `
    -DataDir $dataDir `
    -Port $uiPort `
    -ExpectedWatchdogScript (Join-Path $AppDir 'scripts\watchdog.js') `
    -ExpectedDaemonScript (Join-Path $AppDir 'scripts\daemon.js')
  exit 0
} catch {
  try {
    [IO.File]::AppendAllText(
      $diagnosticFile,
      ('[' + [DateTime]::UtcNow.ToString('o') + '] failed profile=' + $Profile + ' error=' + $_.Exception.Message + [Environment]::NewLine),
      (New-Object Text.UTF8Encoding($false)))
  } catch {}
  [Console]::Error.WriteLine('Cannot safely stop the existing WorkDaddy lifecycle: ' + $_.Exception.Message)
  exit 2
}
