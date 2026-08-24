'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const helperPath = path.join(scriptsDir, 'windows-process-boundary.ps1');
const lifecycleScripts = ['install-win.ps1', 'uninstall-win.ps1', 'apply-update.ps1'];

test('PowerShell lifecycle scripts reject elevation before side effects', () => {
  for (const name of lifecycleScripts) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    const probe = source.indexOf('IsInRole');
    assert.ok(probe >= 0, `${name} lacks an inline privilege probe`);
    for (const marker of ['New-Item', 'Start-Transcript', 'Send-Sentry', 'Remove-Item', 'taskkill']) {
      const index = source.indexOf(marker);
      if (index >= 0) assert.ok(probe < index, `${name} performs ${marker} before its privilege probe`);
    }
    assert.doesNotMatch(source, /taskkill[^\r\n]*\/T\b/i, name);
    assert.doesNotMatch(source, /taskkill[^\r\n]*\/IM\b/i, name);
    assert.doesNotMatch(source, /CommandLine\)?\.Contains\s*\(/i, name);
  }
});

test('PowerShell boundary rejects a script appearing only in later argv', { skip: process.platform !== 'win32' }, () => {
  assert.equal(fs.existsSync(helperPath), true);
  const quotedHelper = helperPath.replace(/'/g, "''");
  const command = [
    `. '${quotedHelper}'`,
    '$resolver = { param($value) [IO.Path]::GetFullPath($value) }',
    "$expected = 'C:\\WorkDaddy\\scripts\\daemon.js'",
    "$good = Test-ExactNodeEntryCommandLine -CommandLine '\"C:\\Node\\node.exe\" --experimental-sqlite \"C:\\WorkDaddy\\scripts\\daemon.js\"' -ExpectedScript $expected -PathResolver $resolver",
    "$future = Test-ExactNodeEntryCommandLine -CommandLine '\"C:\\Node\\node.exe\" \"C:\\WorkDaddy\\scripts\\daemon.js\"' -ExpectedScript $expected -PathResolver $resolver",
    "$trailing = Test-ExactNodeEntryCommandLine -CommandLine '\"C:\\Node\\node.exe\" \"C:\\WorkDaddy\\scripts\\daemon.js\" stop' -ExpectedScript $expected -PathResolver $resolver",
    "$bad = Test-ExactNodeEntryCommandLine -CommandLine '\"C:\\Node\\node.exe\" C:\\Other\\other.js \"C:\\WorkDaddy\\scripts\\daemon.js\"' -ExpectedScript $expected -PathResolver $resolver",
    "$nodeSpace = Test-ExactNodeEntryCommandLine -CommandLine '\"C:\\Node\\node.exe \" \"C:\\WorkDaddy\\scripts\\daemon.js\"' -ExpectedNode 'C:\\Node\\node.exe' -ExpectedScript $expected -PathResolver $resolver",
    "$scriptSpace = Test-ExactNodeEntryCommandLine -CommandLine '\"C:\\Node\\node.exe\" \"C:\\WorkDaddy\\scripts\\daemon.js \"' -ExpectedScript $expected -PathResolver $resolver",
    '$scriptCrlf = Test-ExactNodeEntryCommandLine -CommandLine (\'"C:\\Node\\node.exe" "\' + $expected + "`r`n" + \'"\') -ExpectedScript $expected -PathResolver $resolver',
    "$cmdGood = Test-ExactCmdLauncherCommandLine -CommandLine '\"C:\\Windows\\System32\\cmd.exe\" /d /c call \"C:\\WorkDaddy\\scripts\\launcher.cmd\"' -ExpectedLauncher 'C:\\WorkDaddy\\scripts\\launcher.cmd' -PathResolver $resolver",
    "$cmdBad = Test-ExactCmdLauncherCommandLine -CommandLine '\"C:\\Windows\\System32\\cmd.exe\" /d /c call C:\\Other\\launcher.cmd C:\\WorkDaddy\\scripts\\launcher.cmd' -ExpectedLauncher 'C:\\WorkDaddy\\scripts\\launcher.cmd' -PathResolver $resolver",
    "$listeners = @(Get-ListeningProcessIdsFromLines -Port 47832 -Lines @('TCP 127.0.0.1:47832 0.0.0.0:0 LISTENING 777'))",
    "$ambiguous = @(Get-ListeningProcessIdsFromLines -Port 47832 -Lines @('TCP 127.0.0.1:47832 0.0.0.0:0 LISTENING 777','TCP [::1]:47832 [::]:0 LISTENING 778'))",
    `$foreign = [pscustomobject]@{ ProcessId = 777; Name = 'node.exe'; ExecutablePath = '${process.execPath.replace(/'/g, "''")}'; CommandLine = '\"${process.execPath.replace(/'/g, "''")}\" C:\\Other\\other.js \"${path.join(scriptsDir, 'daemon.js').replace(/'/g, "''")}\"'; Owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name }`,
    '$foreignRejected = $false',
    `try { [void](Assert-NodeProcessIdentity -Process $foreign -ExpectedPid 777 -ExpectedScript '${path.join(scriptsDir, 'daemon.js').replace(/'/g, "''")}') } catch { $foreignRejected = $true }`,
    '$statusRejected = $false',
    `try { [void](Assert-DaemonStatusIdentity -Status ([pscustomobject]@{ pid = '777'; version = '1.0.14'; privilege = 'standard'; profile = [pscustomobject]@{ id = 'workbuddy-cn' } }) -Port 47832 -ExpectedProfile 'workbuddy-cn' -ExpectedVersion '1.0.14' -ExpectedDaemonScript '${path.join(scriptsDir, 'daemon.js').replace(/'/g, "''")}') } catch { $statusRejected = $true }`,
    '$versionRejected = $false',
    `try { [void](Assert-DaemonStatusIdentity -Status ([pscustomobject]@{ pid = 777; version = '1.0.13'; privilege = 'standard'; profile = [pscustomobject]@{ id = 'workbuddy-cn' } }) -Port 47832 -ExpectedProfile 'workbuddy-cn' -ExpectedVersion '1.0.14' -ExpectedDaemonScript '${path.join(scriptsDir, 'daemon.js').replace(/'/g, "''")}') } catch { $versionRejected = $_.Exception.Message -match 'version' }`,
    'if ($good -and $future -and -not $trailing -and -not $bad -and -not $nodeSpace -and -not $scriptSpace -and -not $scriptCrlf -and $cmdGood -and -not $cmdBad -and $listeners.Count -eq 1 -and $listeners[0] -eq 777 -and $ambiguous.Count -eq 2 -and $foreignRejected -and $statusRejected -and $versionRejected) { exit 0 } else { exit 7 }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell source validates owner, exact launcher token, PID, and listener identity', () => {
  assert.equal(fs.existsSync(helperPath), true);
  const helper = fs.readFileSync(helperPath, 'utf8');
  assert.match(helper, /Invoke-CimMethod[^\r\n]*GetOwner/i);
  assert.match(helper, /Test-ExactCmdLauncherCommandLine/);
  assert.match(helper, /Get-UniqueListeningProcessId/);
  assert.match(helper, /function Get-UniqueNodeProcessForScript/);
  assert.match(helper, /\[Parameter\(Mandatory = \$true\)\]\[ValidateScript\(\{ -not \[string\]::IsNullOrWhiteSpace\(\$_\) \}\)\]\[string\]\$ExpectedVersion/);
  assert.match(helper, /\[string\]\$Status\.version -cne \$ExpectedVersion/);
  assert.match(helper, /Get-UniqueNodeProcessForScript -ExpectedScript \$ExpectedWatchdogScript/);
  assert.match(helper, /Get-UniqueNodeProcessForScript -ExpectedScript \$ExpectedDaemonScript/);
  assert.match(helper, /Stop-VerifiedProcess/);
  assert.match(helper, /watchdog\.pid 内容无效/);
  assert.match(helper, /\[int\]::TryParse/);
  for (const name of lifecycleScripts) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    assert.match(source, /windows-process-boundary\.ps1/);
  }
});

test('only the shared verified PowerShell boundary may invoke taskkill', () => {
  const helper = fs.readFileSync(helperPath, 'utf8');
  assert.match(helper, /function Stop-VerifiedProcess[\s\S]*\[Environment\]::SystemDirectory[\s\S]*& \$taskkill \/F \/PID/);
  assert.match(helper, /\$LASTEXITCODE -ne 0/);
  for (const name of lifecycleScripts) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    assert.doesNotMatch(source, /taskkill(?:\.exe)?\s/i, name);
  }
});
