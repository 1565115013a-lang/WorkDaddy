'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const launcherSource = fs.readFileSync(path.join(root, 'scripts', 'win-launcher.js'), 'utf8');
const daemonSource = fs.readFileSync(path.join(root, 'scripts', 'daemon.js'), 'utf8');
const watchdogSource = fs.readFileSync(path.join(root, 'scripts', 'watchdog.js'), 'utf8');
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
  assert.match(launcherSource, /queryNodeProcesses\(\)/);
  assert.match(launcherSource, /uniqueNodeProcess\(nodeBin, WATCHDOG_SCRIPT\)/);
  assert.match(launcherSource, /uniqueNodeProcess\(nodeBin, DAEMON_SCRIPT\)/);
  assert.match(launcherSource, /assertSameProcessIdentity/);
  assert.match(launcherSource, /requireCurrentOwner:\s*true/);
  for (const source of [launcherSource, daemonSource, watchdogSource]) {
    assert.match(source, /buildNativeProcessQuery/);
    assert.match(source, /windows-process-boundary\.ps1/);
    assert.match(source, /-ExecutionPolicy['"],\s*['"]Bypass/);
  }
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
