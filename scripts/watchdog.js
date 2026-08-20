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
const { spawn } = require('child_process');

const SCRIPTS_DIR = __dirname;
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WorkDaddy');
const PID_FILE = path.join(DATA_DIR, 'watchdog.pid');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
  // 前台运行时也输出（便于手动调试）
  try { process.stdout.write(line); } catch (_) {}
}

/** 读取 PID 文件并检测进程是否存活（Windows: tasklist /FI） */
function pidFileAlive() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!pid || pid === process.pid) return false;
    const r = require('child_process').spawnSync(
      'tasklist',
      ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    return r.status === 0 && /node/i.test(r.stdout);
  } catch (_) {
    return false;
  }
}

if (process.argv.includes('stop')) {
  log('收到 stop 指令，退出中...');
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid && pid !== process.pid) {
      require('child_process').spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    }
  } catch (_) {}
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
}

// 单实例保护
if (pidFileAlive()) {
  log('已有 watchdog 实例在运行，本实例退出');
  process.exit(0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));

let child = null;
let stopping = false;
let restartDelay = 3000; // 初始 3s，连续崩溃递增，上限 60s

function startDaemon() {
  if (stopping) return;
  const node = process.execPath;
  const args = ['--experimental-sqlite', path.join(SCRIPTS_DIR, 'daemon.js')];
  log('启动 daemon: ' + node + ' ' + args.join(' '));
  child = spawn(node, args, { stdio: 'ignore', windowsHide: true, env: process.env });
  child.on('error', (e) => {
    log('daemon 启动错误: ' + e.message);
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) { log('daemon 已退出（watchdog 停止中）'); return; }
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
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(0);
  }, 800);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);