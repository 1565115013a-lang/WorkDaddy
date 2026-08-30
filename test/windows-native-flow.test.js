'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { launchWindowsInstaller } = require('../scripts/windows-installer-launch.js');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Windows native launcher is the packaged user-level entry point', () => {
  const installer = read('scripts/win/workdaddy.iss');
  const build = read('scripts/build-win-zip.sh');
  const source = read('scripts/windows-native/main.go');

  assert.match(installer, /Filename: "\{app\}\\WorkDaddyLauncher\.exe"/);
  assert.doesNotMatch(installer, /launcher-hidden\.vbs|wscript\.exe/i);
  assert.match(build, /WorkDaddyLauncher\.exe/);
  assert.match(source, /TokenElevation/);
  assert.match(source, /CreateMutexW/);
  assert.match(source, /WBSWITCH_NATIVE_LAUNCHER/);
  assert.match(source, /mbRetryCancel/);
});

test('normal Windows startup does not use Explorer de-elevation or CIM', () => {
  const launcher = read('scripts/win-launcher.js');
  const watchdog = read('scripts/watchdog.js');

  assert.match(launcher, /async function nativeStartupMain/);
  assert.match(launcher, /WBSWITCH_NATIVE_LAUNCHER/);
  const nativeStart = launcher.slice(
    launcher.indexOf('async function nativeStartupMain'),
    launcher.indexOf('// ---------- legacy script entry ----------')
  );
  assert.doesNotMatch(nativeStart, /Get-CimInstance|windows-relaunch-standard|quitWorkBuddy/);
  assert.doesNotMatch(watchdog, /Get-CimInstance|windows-process-boundary|pending\.json/);
});

test('installer waits for the exact profile client with a visible recheck dialog', () => {
  const installer = read('scripts/win/workdaddy.iss');

  assert.match(installer, /function EnsureWorkBuddyClosed/);
  assert.match(installer, /--check-workbuddy/);
  assert.match(installer, /Caption := '\u91cd\u65b0\u68c0\u6d4b'/);
  assert.match(installer, /Caption := '\u7ed3\u675f\u8fdb\u7a0b'/);
  assert.match(installer, /Caption := '\u53d6\u6d88'/);
  assert.match(installer, /--terminate-workbuddy/);
  assert.match(installer, /--stop-lifecycle/);
  assert.match(installer, /IsAdminInstallMode/);
  assert.match(installer, /当前安装程序是以管理员权限运行的/);
  assert.match(installer, /ExecAsOriginalUser\(/);
  assert.match(installer, /runasoriginaluser/);
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /CloseApplications=no/);
});

test('Windows update opens the verified Setup visibly and keeps daemon alive', () => {
  const daemon = read('scripts/daemon.js');
  const inject = read('scripts/inject.js');
  const windowsBranchStart = daemon.indexOf('if (IS_WIN) {', daemon.indexOf('function applyUpdate()'));
  const macBranchStart = daemon.indexOf("const scriptPath = path.join(__dirname, 'apply-update.sh')", windowsBranchStart);
  const windowsBranch = daemon.slice(windowsBranchStart, macBranchStart);

  assert.match(windowsBranch, /launchWindowsInstaller\(srcPackage\)/);
  assert.match(windowsBranch, /installer-opened/);
  assert.doesNotMatch(windowsBranch, /apply-update\.ps1|apply-update\.vbs|pending\.json|process\.exit/);
  assert.doesNotMatch(windowsBranch, /VERYSILENT|SILENT/i);
  assert.match(inject, /\u6253\u5f00\u5b89\u88c5\u7a0b\u5e8f/);
  assert.match(inject, /function showWindowsInstallerReady[\s\S]*\u6253\u5f00\u5b89\u88c5\u7a0b\u5e8f/);
  assert.match(inject, /WBS_PLATFORM === 'win32'[\s\S]*showWindowsInstallerReady/);
});

test('Windows installer launch uses a visible detached process without shell arguments', async () => {
  let call = null;
  let unreferenced = false;
  const fakeSpawn = (file, args, options) => {
    call = { file, args, options };
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => { unreferenced = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const child = launchWindowsInstaller('C:\\Updates\\WorkDaddy-Setup-9.9.9.exe', fakeSpawn);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  assert.deepEqual(call, {
    file: 'C:\\Updates\\WorkDaddy-Setup-9.9.9.exe',
    args: [],
    options: { detached: true, stdio: 'ignore', windowsHide: false },
  });
  assert.equal(unreferenced, true);
  assert.throws(() => launchWindowsInstaller('C:\\Updates\\legacy.zip', fakeSpawn), /Setup\.exe/);
});

test('macOS update still uses the existing apply-update shell script', () => {
  const daemon = read('scripts/daemon.js');
  const applyStart = daemon.indexOf('function applyUpdate()');
  const branch = daemon.slice(applyStart, daemon.indexOf('// ================', applyStart));
  assert.match(branch, /apply-update\.sh/);
  assert.match(branch, /extractAppFromDmg/);
  assert.match(branch, /spawn\('bash'/);
});

test('native helper keeps WorkBuddy CN and AI process detection isolated', () => {
  const source = read('scripts/windows-native/main.go');
  const launcher = read('scripts/win-launcher.js');
  assert.match(source, /workbuddy-cn[\s\S]*WorkBuddy\.exe/);
  assert.match(source, /workbuddy-ai[\s\S]*WorkBuddyAI\.exe/);
  assert.match(source, /QueryFullProcessImageNameW/);
  assert.match(source, /func terminateWorkBuddy\(profile string\)/);
  assert.match(source, /uniqueRunningWorkBuddyPath/);
  assert.match(source, /terminateExactProcess\(int\(match\.PID\), expectedPath, "WorkBuddy"\)/);
  assert.match(source, /lifecycle stop requires standard user privilege/);
  assert.match(launcher, /path\.join\(programFiles, 'WorkBuddy', 'WorkBuddy\.exe'\)/);
  assert.match(launcher, /path\.join\(programFilesX86, 'WorkBuddy', 'WorkBuddy\.exe'\)/);
});

test('native lifecycle cleanup accepts a PID that exits during exact inspection', () => {
  const source = read('scripts/windows-native/main.go');
  const missingPath = source.indexOf('if actual == ""');
  const exitedCheck = source.indexOf('procWaitForSingleObject.Call(uintptr(handle), 2000)', missingPath);
  const mismatch = source.indexOf('return false, exitIdentityMismatch', missingPath);
  assert.ok(missingPath >= 0 && exitedCheck > missingPath && mismatch > exitedCheck);
  assert.match(source.slice(exitedCheck, mismatch), /waitResult == waitObject0[\s\S]*return false, 0, nil/);
});
