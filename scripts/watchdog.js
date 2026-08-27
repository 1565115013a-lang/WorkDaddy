#!/usr/bin/env node
/**
 * WorkDaddy Windows 守护进程（对应 macOS launchd 的 KeepAlive 能力）
 *
 * 职责：spawn daemon.js 并常驻监听；daemon 崩溃/退出后自动拉起（指数退避防抖）。
 * 单实例：PID 文件锁（%DATA_DIR%\watchdog.pid），重复启动直接退出。
 * 更新流程：apply-update.ps1 先按 PID 杀本进程，再做文件替换。
 *
 * 用法: node watchdog.js
 *       node watchdog.js stop   # 停止：杀 daemon + 退出自己
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const {
  assertSameProcessIdentity,
  assertStandardWindowsPrivilege,
  assertVerifiedNodeProcess,
  buildNativeProcessQuery,
  filterVerifiedNodeProcesses,
  parseCimProcessResult,
} = require('./windows-process-boundary.js');
const { getProfile, profileDataDir } = require('./profiles.js');

if (process.platform === 'win32') assertStandardWindowsPrivilege();

const SCRIPTS_DIR = __dirname;
const PROFILE_ID = process.env.WBSWITCH_PROFILE || 'workbuddy-cn';
const PROFILE = getProfile(PROFILE_ID);
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  profileDataDir(PROFILE);
const PID_FILE = path.join(DATA_DIR, 'watchdog.pid');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');
const UPDATE_PENDING_FILE = path.join(DATA_DIR, 'update', 'pending.json'); // 自动更新进行中标记（update 目录由 apply 流程创建）
const DAEMON_FILE = path.join(SCRIPTS_DIR, 'daemon.js');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
  // 前台运行时也输出（便于手动调试）
  try { process.stdout.write(line); } catch (_) {}
}

function readPidFile() {
  try {
    const text = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== text) {
      throw new Error('watchdog.pid 内容无效');
    }
    return pid;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function runProcessQuery(whereClause) {
  const helper = path.join(__dirname, 'windows-process-boundary.ps1');
  const expectedNode = String(process.execPath).replace(/'/g, "''");
  const command = buildNativeProcessQuery(helper,
    `Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -ieq 'node.exe' -and $_.ExecutablePath -ieq '${expectedNode}' } | Where-Object { ${whereClause} }`);
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  return parseCimProcessResult(result, {
    requireCommandLine: true, requireCurrentOwner: true, requireNativeArguments: true,
  });
}

function queryProcess(pid) {
  return runProcessQuery(`[int]$_.ProcessId -eq ${pid}`);
}

function queryWatchdogProcessFamily(pid) {
  return runProcessQuery(`[int]$_.ProcessId -eq ${pid} -or [int]$_.ParentProcessId -eq ${pid}`);
}

function queryWatchdogProcesses() {
  return runProcessQuery("$_.Name -eq 'node.exe'");
}

function pidFileState() {
  const pid = readPidFile();
  if (!pid) {
    const untracked = filterVerifiedNodeProcesses(
      process.execPath, __filename, queryWatchdogProcesses()
    ).filter((item) => item.ProcessId !== process.pid)
      .map((item) => assertSameProcessIdentity(item, item));
    if (untracked.length) {
      return { kind: 'untracked', pid: null, processIds: untracked.map((item) => item.ProcessId) };
    }
    return { kind: 'absent', pid: null };
  }
  if (pid === process.pid) return { kind: 'self', pid };
  const processes = queryWatchdogProcessFamily(pid);
  if (!processes.length) return { kind: 'stale', pid };
  const watchdog = assertVerifiedNodeProcess(pid, process.execPath, __filename, processes);
  assertSameProcessIdentity(watchdog, watchdog);
  return { kind: 'verified', pid, watchdog, processes };
}

function removePidFileIf(pid) {
  const current = readPidFile();
  if (current !== pid) throw new Error('watchdog.pid 在操作期间发生变化，拒绝删除');
  fs.unlinkSync(PID_FILE);
}

function verifiedDaemonChildren(watchdogPid, processes) {
  const matches = filterVerifiedNodeProcesses(process.execPath, DAEMON_FILE, processes)
    .map((item) => assertSameProcessIdentity(item, item));
  for (const daemon of matches) {
    if (!Number.isSafeInteger(daemon.ParentProcessId) || daemon.ParentProcessId !== watchdogPid) {
      throw new Error(`无法验证 daemon PID=${daemon.ProcessId} 的 watchdog 父进程`);
    }
  }
  return matches;
}

function terminateVerifiedProcess(original, expectedScript, label, expectedParentPid, allowMissing = false) {
  const processes = queryProcess(original.ProcessId);
  if (!processes.length) {
    if (allowMissing) return false;
    throw new Error(`结束前无法再次验证 ${label} PID=${original.ProcessId}`);
  }
  const verified = assertVerifiedNodeProcess(
    original.ProcessId, process.execPath, expectedScript, processes
  );
  assertSameProcessIdentity(original, verified);
  if (expectedParentPid !== undefined && verified.ParentProcessId !== expectedParentPid) {
    throw new Error(`结束前无法再次验证 ${label} PID=${original.ProcessId} 的父进程`);
  }
  const result = spawnSync('taskkill', ['/F', '/PID', String(original.ProcessId)], {
    stdio: 'ignore', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`无法结束已验证 ${label} PID=${original.ProcessId}`);
  }
  if (queryProcess(original.ProcessId).length) {
    throw new Error(`${label} PID=${original.ProcessId} 在结束后仍然存在`);
  }
  return true;
}

function stopVerifiedWatchdog() {
  const state = pidFileState();
  if (state.kind === 'absent') return;
  if (state.kind === 'self') throw new Error('stop 命令不能结束自身');
  if (state.kind === 'untracked') {
    throw new Error(`检测到没有 PID 文件的 watchdog 进程 PID=${state.processIds.join(',')}，无法确定当前 profile，拒绝结束`);
  }
  if (state.kind === 'stale') {
    removePidFileIf(state.pid);
    log('已清理确认不存在的旧 watchdog.pid');
    return;
  }
  const daemons = verifiedDaemonChildren(state.pid, state.processes);
  // 先结束守护进程，防止它在 daemon 退出后竞态拉起新实例；子进程逐个复验并结束。
  terminateVerifiedProcess(state.watchdog, __filename, 'watchdog');
  for (const daemon of daemons) {
    terminateVerifiedProcess(daemon, DAEMON_FILE, 'daemon', state.pid, true);
  }
  removePidFileIf(state.pid);
}

if (process.argv.includes('stop')) {
  log('收到 stop 指令，退出中...');
  stopVerifiedWatchdog();
  process.exit(0);
}

// 单实例保护：用户可写 PID 文件只作候选，必须用 CIM 路径和命令行证明真实身份。
const existing = pidFileState();
if (existing.kind === 'verified') {
  log('已有 watchdog 实例在运行，本实例退出');
  process.exit(0);
}
if (existing.kind === 'self') throw new Error('watchdog.pid 意外指向当前进程');
if (existing.kind === 'stale') {
  removePidFileIf(existing.pid);
  log('已清理确认不存在的旧 watchdog.pid，继续启动');
}
if (existing.kind === 'untracked') {
  throw new Error(`检测到没有 PID 文件的 watchdog 进程 PID=${existing.processIds.join(',')}，拒绝启动重复实例`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid), { flag: 'wx' });

let child = null;
let stopping = false;
let restartDelay = 3000; // 初始 3s，连续崩溃递增，上限 60s

function startDaemon() {
  if (stopping) return;
  const node = process.execPath;
  const args = ['--experimental-sqlite', DAEMON_FILE];
  log('启动 daemon: ' + node + ' ' + args.join(' '));
  child = spawn(node, args, { stdio: 'ignore', windowsHide: true, env: process.env });
  child.on('error', (e) => {
    log('daemon 启动错误: ' + e.message);
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) { log('daemon 已退出（watchdog 停止中）'); return; }
    // 自动更新标记存在：daemon 是在「更新替换」窗口内退出的（apply-update.ps1 正在换文件），
    // 绝不能立刻重启 daemon 抢占 47832 端口，否则会干扰替换甚至导致更新失败（历史偶发根因）。
    // 标记由 apply-update.ps1 成功/失败后删除；删除后靠新版 launcher/手动启动重新拉起。
    if (fs.existsSync(UPDATE_PENDING_FILE)) {
      log('检测到更新标记 pending.json，跳过自动重启 daemon（等待 apply-update.ps1 完成替换）');
      return;
    }
    log('daemon 退出 code=' + code + ' signal=' + signal + '，' + restartDelay + 'ms 后重启');
    setTimeout(startDaemon, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
  // 正常存活 60s 后重置退避
  setTimeout(() => { restartDelay = 3000; }, 60000);
}

startDaemon();

// 优雅停止：外部 kill（更新前）或 Ctrl+C
function shutdown() {
  if (stopping) return;
  stopping = true;
  log('watchdog 收到停止信号，结束 daemon');
  if (child) {
    try { child.kill(); } catch (_) {}
  }
  setTimeout(() => {
    try { removePidFileIf(process.pid); } catch (_) {}
    process.exit(0);
  }, 800);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
