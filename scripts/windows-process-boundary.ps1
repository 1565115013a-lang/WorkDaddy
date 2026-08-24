function ConvertTo-WindowsCommandLineArgs {
  param([Parameter(Mandatory = $true)][string]$CommandLine)
  if (-not ('WorkDaddyCommandLineParser' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WorkDaddyCommandLineParser {
  [DllImport("shell32.dll", SetLastError = true)]
  private static extern IntPtr CommandLineToArgvW(
    [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
    out int argc);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static string[] Parse(string commandLine) {
    int argc;
    IntPtr argv = CommandLineToArgvW(commandLine, out argc);
    if (argv == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      string[] result = new string[argc];
      for (int index = 0; index < argc; index++) {
        IntPtr item = Marshal.ReadIntPtr(argv, index * IntPtr.Size);
        result[index] = Marshal.PtrToStringUni(item);
      }
      return result;
    } finally {
      LocalFree(argv);
    }
  }
}
'@
  }
  return [WorkDaddyCommandLineParser]::Parse($CommandLine)
}

function Resolve-StrictWindowsPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [scriptblock]$PathResolver
  )
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "路径不是绝对路径: $Path"
  }
  $resolved = if ($PathResolver) {
    & $PathResolver $Path
  } else {
    (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
  }
  if ([string]::IsNullOrWhiteSpace([string]$resolved) -or -not [IO.Path]::IsPathRooted([string]$resolved)) {
    throw "无法解析绝对路径: $Path"
  }
  return [IO.Path]::GetFullPath([string]$resolved).TrimEnd('\', '/')
}

function Test-SameWindowsPath {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right,
    [scriptblock]$PathResolver
  )
  try {
    $leftPath = Resolve-StrictWindowsPath -Path $Left -PathResolver $PathResolver
    $rightPath = Resolve-StrictWindowsPath -Path $Right -PathResolver $PathResolver
    return [StringComparer]::OrdinalIgnoreCase.Equals($leftPath, $rightPath)
  } catch {
    return $false
  }
}

function Test-StrictCommandTokenPath {
  param(
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$ExpectedPath,
    [scriptblock]$PathResolver
  )
  if ([string]::IsNullOrEmpty($Token) -or $Token -cne $Token.Trim() -or
      $Token.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0) { return $false }
  return Test-SameWindowsPath -Left $Token -Right $ExpectedPath -PathResolver $PathResolver
}

function ConvertTo-WorkDaddyProcessRecord {
  param([Parameter(Mandatory = $true)]$Process)
  $processId = 0
  if (-not [int]::TryParse([string]$Process.ProcessId, [ref]$processId) -or $processId -le 0 -or
      [string]::IsNullOrWhiteSpace([string]$Process.Name) -or
      [string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath) -or
      [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) { throw 'CIM 进程身份字段不完整' }
  $ownerResult = Invoke-CimMethod -InputObject $Process -MethodName GetOwner -ErrorAction Stop
  if ($ownerResult.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace([string]$ownerResult.User)) {
    throw "无法确认 PID $processId 的进程所有者"
  }
  $owner = if ([string]::IsNullOrWhiteSpace([string]$ownerResult.Domain)) {
    [string]$ownerResult.User
  } else { ([string]$ownerResult.Domain + '\' + [string]$ownerResult.User) }
  $arguments = [string[]]@(ConvertTo-WindowsCommandLineArgs -CommandLine ([string]$Process.CommandLine))
  if ($arguments.Count -eq 0 -or @($arguments | Where-Object { $null -eq $_ }).Count -ne 0) {
    throw "PID $processId 的原生 Arguments 无效"
  }
  $currentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  return [pscustomobject]@{
    ProcessId = $processId
    ParentProcessId = [int]$Process.ParentProcessId
    Name = [string]$Process.Name
    ExecutablePath = Resolve-StrictWindowsPath -Path ([string]$Process.ExecutablePath)
    CommandLine = [string]$Process.CommandLine
    ArgumentsSource = 'CommandLineToArgvW'
    Arguments = $arguments
    Owner = $owner
    OwnerIsCurrent = [StringComparer]::OrdinalIgnoreCase.Equals($owner, $currentOwner)
  }
}

function Test-ExactNodeEntryCommandLine {
  param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$ExpectedScript,
    [string]$ExpectedNode = '',
    [scriptblock]$PathResolver
  )
  try {
    $arguments = @(ConvertTo-WindowsCommandLineArgs -CommandLine $CommandLine)
    if ($arguments.Count -lt 2) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedNode) -and
        -not (Test-StrictCommandTokenPath -Token $arguments[0] -ExpectedPath $ExpectedNode -PathResolver $PathResolver)) {
      return $false
    }
    $entryIndex = 1
    if ($arguments[$entryIndex] -ceq '--experimental-sqlite') { $entryIndex++ }
    if ($entryIndex -ge $arguments.Count) { return $false }
    if ($arguments.Count -ne ($entryIndex + 1)) { return $false }
    return Test-StrictCommandTokenPath -Token $arguments[$entryIndex] -ExpectedPath $ExpectedScript -PathResolver $PathResolver
  } catch {
    return $false
  }
}

function Test-ExactCmdLauncherCommandLine {
  param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$ExpectedLauncher,
    [string]$ExpectedCmd = '',
    [scriptblock]$PathResolver
  )
  try {
    $arguments = @(ConvertTo-WindowsCommandLineArgs -CommandLine $CommandLine)
    if ($arguments.Count -lt 1 -or
        (-not [string]::IsNullOrWhiteSpace($ExpectedCmd) -and
         -not (Test-StrictCommandTokenPath -Token $arguments[0] -ExpectedPath $ExpectedCmd -PathResolver $PathResolver))) {
      return $false
    }
    if ($arguments.Count -eq 5 -and
        $arguments[1] -ieq '/d' -and $arguments[2] -ieq '/c' -and
        $arguments[3] -ieq 'call') {
      return Test-StrictCommandTokenPath -Token $arguments[4] -ExpectedPath $ExpectedLauncher -PathResolver $PathResolver
    }
    if ($arguments.Count -eq 3 -and $arguments[1] -ieq '/c') {
      return Test-StrictCommandTokenPath -Token $arguments[2] -ExpectedPath $ExpectedLauncher -PathResolver $PathResolver
    }
    return $false
  } catch {
    return $false
  }
}

function Get-StrictProcessRecord {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  if ($ProcessId -le 0) { throw "无效 PID: $ProcessId" }
  $rows = @(Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction Stop)
  if ($rows.Count -eq 0) { return $null }
  if ($rows.Count -ne 1) { throw "PID $ProcessId 的 CIM 记录不唯一" }
  $record = ConvertTo-WorkDaddyProcessRecord -Process $rows[0]
  if ([int]$record.ProcessId -ne $ProcessId) { throw "PID $ProcessId 的 CIM 记录不匹配" }
  return $record
}

function Assert-SameProcessOwner {
  param([Parameter(Mandatory = $true)]$Process)
  $currentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$Process.Owner, $currentOwner)) {
    throw "PID $($Process.ProcessId) 不属于当前用户"
  }
}

function Assert-NodeProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][int]$ExpectedPid,
    [Parameter(Mandatory = $true)][string]$ExpectedScript
  )
  if ([int]$Process.ProcessId -ne $ExpectedPid -or [string]$Process.Name -ine 'node.exe') {
    throw "PID $ExpectedPid 不是目标 Node 进程"
  }
  Assert-SameProcessOwner -Process $Process
  $executable = Resolve-StrictWindowsPath -Path ([string]$Process.ExecutablePath)
  if ([IO.Path]::GetFileName($executable) -ine 'node.exe') {
    throw "PID $ExpectedPid 的可执行文件不是 node.exe"
  }
  if (-not (Test-ExactNodeEntryCommandLine -CommandLine ([string]$Process.CommandLine) -ExpectedScript $ExpectedScript -ExpectedNode $executable)) {
    throw "PID $ExpectedPid 的 Node 入口脚本不匹配"
  }
  return $Process
}

function Assert-CmdLauncherIdentity {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$ExpectedLauncher
  )
  if ([string]$Process.Name -ine 'cmd.exe') { throw "PID $($Process.ProcessId) 不是 cmd.exe" }
  Assert-SameProcessOwner -Process $Process
  $systemCmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
  if (-not (Test-SameWindowsPath -Left ([string]$Process.ExecutablePath) -Right $systemCmd)) {
    throw "PID $($Process.ProcessId) 的 cmd.exe 路径不匹配"
  }
  if (-not (Test-ExactCmdLauncherCommandLine -CommandLine ([string]$Process.CommandLine) -ExpectedLauncher $ExpectedLauncher -ExpectedCmd $systemCmd)) {
    throw "PID $($Process.ProcessId) 的 launcher.cmd 入口不匹配"
  }
  return $Process
}

function Get-UniqueNodeProcessForScript {
  param([Parameter(Mandatory = $true)][string]$ExpectedScript)
  $matches = @()
  $rows = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  foreach ($row in $rows) {
    if ([string]$row.Name -ine 'node.exe' -or
        [string]::IsNullOrWhiteSpace([string]$row.CommandLine)) {
      throw 'Node 进程身份字段不完整，无法证明目标进程不存在'
    }
    if (-not (Test-ExactNodeEntryCommandLine -CommandLine ([string]$row.CommandLine) -ExpectedScript $ExpectedScript)) {
      continue
    }
    $processId = 0
    if (-not [int]::TryParse([string]$row.ProcessId, [ref]$processId) -or $processId -le 0) {
      throw '目标 Node 进程 PID 无效'
    }
    $record = Get-StrictProcessRecord -ProcessId $processId
    if ($null -eq $record) { throw "目标 Node 进程 PID=$processId 在身份验证期间消失" }
    $matches += ,(Assert-NodeProcessIdentity -Process $record -ExpectedPid $processId -ExpectedScript $ExpectedScript)
  }
  if ($matches.Count -gt 1) { throw "目标 Node 入口存在多个进程: $ExpectedScript" }
  if ($matches.Count -eq 0) { return $null }
  return $matches[0]
}

function Get-ListeningProcessIdsFromLines {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string[]]$Lines
  )
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($line in $Lines) {
    $parts = ([string]$line).Trim() -split '\s+'
    if ($parts.Count -lt 5 -or $parts[3] -notmatch '^LISTENING$') { continue }
    if ($parts[1] -notmatch (':' + [regex]::Escape([string]$Port) + '$')) { continue }
    $parsed = 0
    if (-not [int]::TryParse($parts[$parts.Count - 1], [ref]$parsed) -or $parsed -le 0) {
      throw "端口 $Port 的监听 PID 无效"
    }
    [void]$ids.Add($parsed)
  }
  return @($ids)
}

function Get-UniqueListeningProcessId {
  param([Parameter(Mandatory = $true)][int]$Port)
  $netstat = Join-Path ([Environment]::SystemDirectory) 'netstat.exe'
  $lines = @(& $netstat -ano -p tcp 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "无法查询端口 $Port 的监听进程" }
  $ids = @(Get-ListeningProcessIdsFromLines -Port $Port -Lines $lines)
  if ($ids.Count -gt 1) { throw "端口 $Port 的监听 PID 不唯一" }
  if ($ids.Count -eq 0) { return $null }
  return [int]$ids[0]
}

function Stop-VerifiedProcess {
  param([Parameter(Mandatory = $true)]$Process)
  $targetPid = [int]$Process.ProcessId
  $current = Get-StrictProcessRecord -ProcessId $targetPid
  if ($null -eq $current) { return }
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$current.Name, [string]$Process.Name) -or
      -not [StringComparer]::OrdinalIgnoreCase.Equals([string]$current.ExecutablePath, [string]$Process.ExecutablePath) -or
      -not [StringComparer]::OrdinalIgnoreCase.Equals([string]$current.Owner, [string]$Process.Owner) -or
      -not [StringComparer]::Ordinal.Equals([string]$current.CommandLine, [string]$Process.CommandLine)) {
    throw "PID $targetPid 在终止前发生身份变化"
  }
  $taskkill = Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
  & $taskkill /F /PID $targetPid 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "taskkill 无法结束已验证进程 PID=$targetPid" }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ($null -eq (Get-StrictProcessRecord -ProcessId $targetPid)) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "已验证进程 PID=$targetPid 未退出"
}

function Stop-VerifiedWorkDaddyLifecycle {
  param(
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ExpectedWatchdogScript,
    [Parameter(Mandatory = $true)][string]$ExpectedDaemonScript
  )
  $pidFile = Join-Path $DataDir 'watchdog.pid'
  $pidFileExists = Test-Path -LiteralPath $pidFile
  $watchdogPid = $null
  $staleWatchdogPidFile = $false
  if ($pidFileExists) {
    $pidText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop).Trim()
    $parsedWatchdogPid = 0
    if ($pidText -notmatch '^[1-9][0-9]*$' -or
        -not [int]::TryParse($pidText, [ref]$parsedWatchdogPid) -or $parsedWatchdogPid -le 0) {
      throw 'watchdog.pid 内容无效'
    }
    $watchdogPid = $parsedWatchdogPid
  }

  # PID 文件只是候选；即使文件缺失，也要从完整 Node 列表证明精确入口不存在。
  $watchdog = Get-UniqueNodeProcessForScript -ExpectedScript $ExpectedWatchdogScript
  if ($pidFileExists) {
    $pidCandidate = Get-StrictProcessRecord -ProcessId $watchdogPid
    if ($null -ne $pidCandidate) {
      [void](Assert-NodeProcessIdentity -Process $pidCandidate -ExpectedPid $watchdogPid -ExpectedScript $ExpectedWatchdogScript)
      if ($null -eq $watchdog -or [int]$watchdog.ProcessId -ne $watchdogPid) {
        throw 'watchdog.pid 与枚举到的精确 watchdog 进程不一致'
      }
    } elseif ($null -ne $watchdog) {
      throw 'watchdog.pid 指向不存在的 PID，但发现了另一个精确 watchdog 进程'
    } else {
      $staleWatchdogPidFile = $true
    }
  }

  $listenerPid = Get-UniqueListeningProcessId -Port $Port
  $daemon = Get-UniqueNodeProcessForScript -ExpectedScript $ExpectedDaemonScript
  if ($null -ne $listenerPid) {
    $listener = Get-StrictProcessRecord -ProcessId $listenerPid
    if ($null -eq $listener) { throw "端口 $Port 的监听 PID 在验证期间消失" }
    [void](Assert-NodeProcessIdentity -Process $listener -ExpectedPid $listenerPid -ExpectedScript $ExpectedDaemonScript)
    if ($null -eq $daemon -or [int]$daemon.ProcessId -ne $listenerPid) {
      throw "端口 $Port 的监听 PID 与枚举到的精确 daemon 进程不一致"
    }
  }

  # 所有候选先完成身份验证；外来监听进程不会导致任何 WorkDaddy 进程被提前终止。
  if ($null -ne $watchdog) { Stop-VerifiedProcess -Process $watchdog }
  if ($null -ne $daemon) {
    if ((Get-UniqueListeningProcessId -Port $Port) -ne $listenerPid) {
      throw "端口 $Port 的监听 PID 在终止前发生变化"
    }
    Stop-VerifiedProcess -Process $daemon
  }
  if ($null -ne (Get-UniqueListeningProcessId -Port $Port)) {
    throw "端口 $Port 未释放"
  }
  if ($staleWatchdogPidFile) {
    if (-not (Test-Path -LiteralPath $pidFile)) { return }
    $currentPidText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop).Trim()
    if ($currentPidText -cne [string]$watchdogPid) {
      throw 'watchdog.pid 在清理前发生变化'
    }
    if ($null -ne (Get-StrictProcessRecord -ProcessId $watchdogPid) -or
        $null -ne (Get-UniqueNodeProcessForScript -ExpectedScript $ExpectedWatchdogScript)) {
      throw 'watchdog.pid 在清理前不再能证明为 stale 状态'
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop
  }
}

function Assert-DaemonStatusIdentity {
  param(
    [Parameter(Mandatory = $true)]$Status,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ExpectedProfile,
    [Parameter(Mandatory = $true)][ValidateScript({ -not [string]::IsNullOrWhiteSpace($_) })][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$ExpectedDaemonScript,
    [string]$ExpectedBuildId = ''
  )
  $statusPid = 0
  if ($null -eq $Status -or
      (($Status.pid -isnot [int]) -and ($Status.pid -isnot [long])) -or
      [int64]$Status.pid -le 0 -or [int64]$Status.pid -gt [int]::MaxValue -or
      [string]$Status.privilege -cne 'standard' -or
      [string]$Status.profile.id -cne $ExpectedProfile) {
    throw 'daemon 状态身份字段无效'
  }
  $statusPid = [int]$Status.pid
  if ([string]$Status.version -cne $ExpectedVersion) {
    throw 'daemon version 不匹配'
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedBuildId) -and [string]$Status.buildId -cne $ExpectedBuildId) {
    throw 'daemon buildId 不匹配'
  }
  $listenerPid = Get-UniqueListeningProcessId -Port $Port
  if ($null -eq $listenerPid -or $listenerPid -ne $statusPid) {
    throw 'daemon 状态 PID 与监听 PID 不一致'
  }
  $daemon = Get-StrictProcessRecord -ProcessId $listenerPid
  if ($null -eq $daemon) { throw 'daemon 监听进程在身份验证期间消失' }
  return Assert-NodeProcessIdentity -Process $daemon -ExpectedPid $listenerPid -ExpectedScript $ExpectedDaemonScript
}

function Test-ExclusiveFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    return $true
  } catch {
    return $false
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Release-VerifiedLauncherLock {
  param([Parameter(Mandatory = $true)][string]$LauncherPath)
  if (Test-ExclusiveFile -Path $LauncherPath) { return $true }
  $matches = @()
  $systemCmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
  $rows = @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction Stop)
  foreach ($row in $rows) {
    if ([string]::IsNullOrWhiteSpace([string]$row.CommandLine)) {
      throw '存在无法验证命令行的 cmd.exe，拒绝释放 launcher 锁'
    }
    if (Test-ExactCmdLauncherCommandLine -CommandLine ([string]$row.CommandLine) -ExpectedLauncher $LauncherPath -ExpectedCmd $systemCmd) {
      $record = Get-StrictProcessRecord -ProcessId ([int]$row.ProcessId)
      if ($null -eq $record) { throw 'launcher cmd.exe 在身份验证期间消失' }
      $matches += ,(Assert-CmdLauncherIdentity -Process $record -ExpectedLauncher $LauncherPath)
    }
  }
  if ($matches.Count -ne 1) { throw "launcher.cmd 锁进程数量不是 1: $($matches.Count)" }
  Stop-VerifiedProcess -Process $matches[0]
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-ExclusiveFile -Path $LauncherPath) { return $true }
    Start-Sleep -Milliseconds 200
  }
  throw "launcher.cmd 文件锁未释放: $LauncherPath"
}
