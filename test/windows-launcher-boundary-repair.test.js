'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const launcherSource = fs.readFileSync(path.join(root, 'scripts', 'win-launcher.js'), 'utf8');
const daemonSource = fs.readFileSync(path.join(root, 'scripts', 'daemon.js'), 'utf8');
const watchdogSource = fs.readFileSync(path.join(root, 'scripts', 'watchdog.js'), 'utf8');
const hiddenLauncherSource = fs.readFileSync(path.join(root, 'scripts', 'launcher-hidden.vbs'), 'utf8');
const installerSource = fs.readFileSync(path.join(root, 'scripts', 'win', 'workdaddy.iss'), 'utf8');
const chineseLanguageSource = fs.readFileSync(path.join(root, 'scripts', 'win', 'ChineseSimplified.isl'), 'utf8');
const boundarySource = fs.readFileSync(path.join(root, 'scripts', 'windows-process-boundary.js'), 'utf8');
const powershellSource = fs.readFileSync(path.join(root, 'scripts', 'windows-process-boundary.ps1'), 'utf8');
const boundary = require('../scripts/windows-process-boundary.js');

const resolveWindows = (value) => path.win32.normalize(value);
const withNativeArguments = (row, args) => ({
  ...row,
  ArgumentsSource: 'CommandLineToArgvW',
  Arguments: args,
});

test('termination process records require a confirmed current owner', () => {
  const base = {
    ProcessId: 701,
    Name: 'node.exe',
    ExecutablePath: 'C:\\Node\\node.exe',
    CommandLine: '"C:\\Node\\node.exe" "C:\\WorkDaddy\\scripts\\daemon.js"',
  };
  const parse = (row) => boundary.parseCimProcessResult(
    { status: 0, stdout: JSON.stringify(row) },
    { requireCommandLine: true, requireCurrentOwner: true }
  );

  assert.equal(parse({ ...base, Owner: 'DESKTOP\\alice', OwnerIsCurrent: true })[0].Owner, 'DESKTOP\\alice');
  assert.throws(() => parse(base), /owner/i);
  assert.throws(
    () => parse({ ...base, Owner: 'DESKTOP\\bob', OwnerIsCurrent: false }),
    /owner|current/i
  );
});

test('same-process revalidation rejects PID reuse and owner changes', () => {
  const original = withNativeArguments({
    ProcessId: 702,
    Name: 'node.exe',
    ExecutablePath: 'C:\\Node\\node.exe',
    CommandLine: '"C:\\Node\\node.exe" "C:\\WorkDaddy\\scripts\\watchdog.js"',
    Owner: 'DESKTOP\\alice',
    OwnerIsCurrent: true,
  }, ['C:\\Node\\node.exe', 'C:\\WorkDaddy\\scripts\\watchdog.js']);
  assert.equal(boundary.assertSameProcessIdentity(original, { ...original }).ProcessId, 702);
  assert.throws(
    () => boundary.assertSameProcessIdentity(original, { ...original, Owner: 'DESKTOP\\bob' }),
    /identity|owner/i
  );
  assert.throws(
    () => boundary.assertSameProcessIdentity(original, { ...original, CommandLine: original.CommandLine + ' stop' }),
    /identity|command/i
  );
});

test('native argv evidence is mandatory, structured, and bound to expected paths', () => {
  const node = 'C:\\Node\\node.exe';
  const script = 'C:\\WorkDaddy\\daemon.js';
  const base = { ProcessId: 712, Name: 'node.exe', ExecutablePath: node, CommandLine: `"${node}" "${script}"` };
  assert.throws(() => boundary.filterVerifiedNodeProcesses(node, script, [base], resolveWindows), /Arguments|native/i);
  assert.throws(
    () => boundary.filterVerifiedNodeProcesses(node, script, [{ ...base, ArgumentsSource: 'untrusted', Arguments: [node, script] }], resolveWindows),
    /Arguments|native|source/i
  );
  assert.throws(
    () => boundary.filterVerifiedNodeProcesses(node, script, [{ ...base, ArgumentsSource: 'CommandLineToArgvW', Arguments: [node, 7] }], resolveWindows),
    /Arguments|string/i
  );
  assert.deepEqual(
    boundary.filterVerifiedNodeProcesses(node, script, [withNativeArguments(base, [node, 'C:\\Other\\daemon.js'])], resolveWindows),
    []
  );
  assert.equal(boundary.splitWindowsCommandLine, undefined);
  assert.doesNotMatch(boundarySource, /function\s+splitWindowsCommandLine/);
});

test('lifecycle entry matching rejects unexpected trailing arguments', () => {
  const node = 'C:\\Node\\node.exe';
  const script = 'C:\\WorkDaddy\\scripts\\watchdog.js';
  const row = (ProcessId, CommandLine, Arguments) => withNativeArguments(
    { ProcessId, Name: 'node.exe', ExecutablePath: node, CommandLine }, Arguments
  );
  const rows = [
    row(703, `"${node}" "${script}"`, [node, script]),
    row(704, `"${node}" "${script}" stop`, [node, script, 'stop']),
    row(705, `"${node}" "" "${script}"`, [node, '', script]),
    row(706, `"${node}" --experimental-sqlite "" "${script}"`, [node, '--experimental-sqlite', '', script]),
    row(707, `"${node}" ${String.raw`a\\\"b`} "${script}"`, [node, String.raw`a\"b`, script]),
    row(708, `"${node}"\r\n"${script}"`, [node, `\r\n${script}`]),
    row(709, `"${node}" """${script}"""`, [node, `"${script}"`]),
    row(710, `"${node}" "${script}""`, [node, `${script}"`]),
    row(711, `"${node}" "${script}\\\\"`, [node, `${script}\\`]),
    row(713, `"${node} " "${script}"`, [`${node} `, script]),
    row(714, `"${node}" "${script} "`, [node, `${script} `]),
    row(715, `"${node}" "${script}\r\n"`, [node, `${script}\r\n`]),
  ];
  assert.deepEqual(
    boundary.filterVerifiedNodeProcesses(node, script, rows, resolveWindows).map((row) => row.ProcessId),
    [703]
  );
});

test('launcher enumerates exact lifecycle entries and never kills process trees', () => {
  assert.doesNotMatch(launcherSource, /taskkill[^\r\n]*['"]\/T['"]/i);
  assert.doesNotMatch(launcherSource, /includeTree/);
  assert.match(launcherSource, /queryNodeProcesses\(nodeBin/);
  assert.match(launcherSource, /uniqueNodeProcess\(nodeBin, WATCHDOG_SCRIPT\)/);
  assert.match(launcherSource, /uniqueNodeProcess\(nodeBin, DAEMON_SCRIPT\)/);
  assert.match(launcherSource, /queryNodeProcesses\(nodeBin, null, path\.basename\(expectedScript\)\)/);
  assert.match(launcherSource, /watchdog\.pid 已从陈旧 PID=/);
  assert.match(launcherSource, /普通权限 launcher 复用现有服务/);
  assert.match(launcherSource, /exactDaemonStatus\(nodeBin, status, true\)/);
  assert.match(launcherSource, /assertSameProcessIdentity/);
  assert.match(launcherSource, /requireCurrentOwner:\s*true/);
  for (const source of [launcherSource, daemonSource, watchdogSource]) {
    assert.match(source, /buildNativeProcessQuery/);
    assert.match(source, /windows-process-boundary\.ps1/);
    assert.match(source, /-ExecutionPolicy['"],\s*['"]Bypass/);
  }
});

test('launcher retries while daemon listener is ready before status', () => {
  assert.match(launcherSource, /if \(!status \|\| listeners\.length !== 1\) continue/);
  assert.doesNotMatch(launcherSource, /if \(!status && listeners\.length === 0\) continue/);
});

test('daemon termination authorization is bound to current profile status and listener', () => {
  const node = 'C:\\Node\\node.exe';
  const script = 'C:\\WorkDaddy\\scripts\\daemon.js';
  const process = withNativeArguments({
    ProcessId: 716,
    Name: 'node.exe',
    ExecutablePath: node,
    CommandLine: `"${node}" "${script}"`,
  }, [node, script]);
  const input = {
    status: { pid: 716, profile: { id: 'workbuddy-cn' }, privilege: 'standard' },
    expectedProfileId: 'workbuddy-cn',
    expectedPrivilege: 'standard',
    listenerPids: [716],
    expectedNode: node,
    expectedScript: script,
    nodeProcesses: [process],
    realpath: resolveWindows,
  };

  assert.equal(boundary.assertDaemonTerminationIdentity(input).ProcessId, 716);
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({
      ...input, status: { ...input.status, profile: { id: 'workbuddy-ai' } },
    }),
    /profile/i
  );
  let foreignProfilePathChecks = 0;
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({
      ...input,
      status: { ...input.status, profile: { id: 'workbuddy-ai' } },
      realpath: (value) => { foreignProfilePathChecks++; return resolveWindows(value); },
    }),
    /profile/i
  );
  assert.equal(foreignProfilePathChecks, 0);
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({
      ...input, status: { ...input.status, privilege: 'elevated' },
    }),
    /privilege/i
  );
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({ ...input, listenerPids: [717] }),
    /listener|PID/i
  );
});

test('launcher never adopts untracked watchdogs or kills unbound daemon entries', () => {
  const stateSource = launcherSource.slice(
    launcherSource.indexOf('function watchdogState'),
    launcherSource.indexOf('function validateDaemonProcess')
  );
  const stopSource = launcherSource.slice(
    launcherSource.indexOf('async function stopDaemonByPort'),
    launcherSource.indexOf('async function ensureDaemon')
  );
  const ensureSource = launcherSource.slice(
    launcherSource.indexOf('async function ensureDaemon'),
    launcherSource.indexOf('// ---------- 2/3.')
  );
  assert.match(stateSource, /!pid[\s\S]*kind:\s*'untracked'/);
  assert.match(stopSource, /watchdog\.kind === 'untracked'[\s\S]*throw new Error/);
  assert.match(ensureSource, /watchdog\.kind === 'untracked'[\s\S]*throw new Error/);
  assert.match(stopSource, /authorizeDaemonTermination/);
  assert.doesNotMatch(stopSource, /remainingDaemon[\s\S]*killVerifiedNodeProcess\(remainingDaemon/);
  const untrackedGuard = stopSource.indexOf("watchdog.kind === 'untracked'");
  const firstKill = stopSource.indexOf('killVerifiedNodeProcess(');
  const firstPidDelete = stopSource.indexOf('removeWatchdogPidIf(');
  assert.ok(untrackedGuard >= 0 && untrackedGuard < firstKill && untrackedGuard < firstPidDelete);
});

test('PowerShell reconciles only a proven stale watchdog PID file', () => {
  assert.match(powershellSource, /\$staleWatchdogPidFile\s*=\s*\$true/);
  assert.match(powershellSource, /Get-UniqueNodeProcessForScript -ExpectedScript \$ExpectedWatchdogScript/);
  assert.match(powershellSource, /watchdog\.pid 在清理前发生变化/);
  assert.match(powershellSource, /Remove-Item -LiteralPath \$pidFile -Force -ErrorAction Stop/);
});

test('Windows launcher and watchdog recover a PID file whose process is gone', () => {
  assert.match(launcherSource, /watchdog\.kind === 'stale'[\s\S]*removeWatchdogPidIf\(watchdog\.pid\)/);
  assert.match(launcherSource, /已清理确认不存在的旧 watchdog\.pid/);
  assert.match(watchdogSource, /state\.kind === 'stale'[\s\S]*removePidFileIf\(state\.pid\)/);
  assert.match(watchdogSource, /existing\.kind === 'stale'[\s\S]*removePidFileIf\(existing\.pid\)/);
});

test('Windows launcher reconciles a reused PID file to an exact watchdog', () => {
  const stateSource = launcherSource.slice(
    launcherSource.indexOf('function watchdogState'),
    launcherSource.indexOf('function validateDaemonProcess')
  );
  assert.match(stateSource, /queryNodeProcesses\(nodeBin, \[pid\], path\.basename\(WATCHDOG_SCRIPT\)\)/);
  assert.match(stateSource, /if \(exact\) \{[\s\S]*fs\.writeFileSync\(WATCHDOG_PID_FILE, String\(exact\.ProcessId\)/);
  assert.match(stateSource, /watchdog\.pid 在修复前发生变化/);
});

test('Windows process queries are scoped to the selected Node runtime', () => {
  assert.match(launcherSource, /ExecutablePath -ieq/);
  assert.match(watchdogSource, /ExecutablePath -ieq/);
});

test('optional WorkBuddy path discovery does not make launcher startup fatal', () => {
  assert.match(launcherSource, /function bestEffortPowerShellLines\(cmd, label\)/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'App Paths'/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'卸载注册表'/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'磁盘根目录'/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'安装目录扫描'/);
});

test('verified launcher lock cleanup handles repeated hidden launches', () => {
  assert.match(powershellSource, /if \(\$matches\.Count -eq 0\)/);
  assert.match(powershellSource, /foreach \(\$match in \$matches\)/);
  assert.match(hiddenLauncherSource, /WBSWITCH_NO_PAUSE=1/);
  assert.match(hiddenLauncherSource, /shell\.Run\(command, 0, True\)/);
});

test('desktop launcher is silent and diagnostics tolerate a transient CIM failure', () => {
  assert.doesNotMatch(hiddenLauncherSource, /MsgBox/i);
  assert.match(hiddenLauncherSource, /WScript\.Quit status/);
  assert.match(launcherSource, /function processDiagnostics\(binary = null\) \{[\s\S]*try \{[\s\S]*catch \(error\)[\s\S]*return \[\];[\s\S]*\}/);
  assert.match(launcherSource, /进程诊断暂不可用/);
});

test('Windows installer uses the bundled Simplified Chinese wizard and profile branding', () => {
  assert.match(installerSource, /\[Languages\][\s\S]*ChineseSimplified\.isl/);
  assert.match(installerSource, /AppPublisher=\{#ProductName\} 团队/);
  assert.match(installerSource, /Description: "\{#StartDescription\}"/);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'build-win-installer.ps1'), 'utf8'), /创建 WorkDaddy AI 桌面快捷方式/);
  assert.match(chineseLanguageSource, /LanguageName=简体中文/);
});

test('Windows cold-start guards an already running WorkBuddy and sends a native notification', () => {
  assert.match(launcherSource, /function requireWorkBuddyClosedBeforeLaunch\(\)/);
  assert.match(launcherSource, /请先完全退出 WorkBuddy/);
  assert.match(launcherSource, /function showWindowsNotification\(title, message\)/);
  assert.match(launcherSource, /NotifyIcon/);
  assert.match(launcherSource, /spawnSync\(powershell/);
  assert.match(launcherSource, /if \(requireWorkBuddyClosedBeforeLaunch\(\)\) process\.exit\(0\)/);
  assert.match(launcherSource, /showWindowsNotification\('WorkBuddy', '正在打开 WorkBuddy，请稍等…'\)/);
});

test('Windows daemon repairs only missing cwd directories with stored session payloads', () => {
  assert.match(daemonSource, /const DAEMON_VERSION = '\d+\.\d+\.\d+'/);
  assert.match(daemonSource, /function sessionPayloadExists\(wbHome, sessionId\)/);
  assert.match(daemonSource, /function createDirectoryNoFollow\(directory\)/);
  assert.match(daemonSource, /repairMissingSessionWorkspaces\(\)\.catch/);
  assert.match(daemonSource, /sessionCwdRepairTimer = setInterval/);
  assert.match(daemonSource, /消息文件未改动/);
});
