param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$LauncherPath
)

$ErrorActionPreference = 'Stop'

function Quote-WindowsArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value.IndexOfAny([char[]]@([char]0, [char]10, [char]13, [char]34)) -ge 0) {
    throw 'Invalid relaunch argument path.'
  }
  return [char]34 + $Value + [char]34
}

$node = [IO.Path]::GetFullPath($NodePath)
$launcher = [IO.Path]::GetFullPath($LauncherPath)
$scriptsRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node runtime is missing.' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Windows launcher is missing.' }
if (-not $launcher.StartsWith($scriptsRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Windows launcher is outside the installed scripts directory.'
}

# Shell.Application delegates ShellExecute to the interactive Explorer shell.
# With normal UAC this yields the desktop user's standard token. If UAC is
# genuinely disabled, Explorer has no filtered token and the marker prevents a
# relaunch loop; the Node launcher then continues in the only available mode.
$shell = New-Object -ComObject Shell.Application
$arguments = '--experimental-sqlite ' + (Quote-WindowsArgument $launcher) + ' --desktop-shell-relaunch'
$shell.ShellExecute($node, $arguments, (Split-Path -Parent $launcher), 'open', 0)
