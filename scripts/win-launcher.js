#!/usr/bin/env node
/**
 * WorkDaddy Windows 启动器（macOS launcher 的 Windows 对应物，node 实现）
 *
 * 幂等三步：
 *   1) 确保 daemon 运行 —— watchdog 常驻（崩溃自动拉起）；daemon 版本与内置不一致时强制重启
 *   2) WorkBuddy 已在 CDP 模式（优先 9222，端口被占用时自动发现）→ 直接注入组件即完成
 *   3) 否则退出 WorkBuddy 并以自动选择的 CDP 端口重启 → 等端口 → 注入
 *
 * 由 launcher.cmd 调用（cmd 负责兜底找 node），也可 node win-launcher.js 直接运行。
 * 所有操作用户态完成（HKCU / %LOCALAPPDATA% / %APPDATA%），无需管理员权限。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { captureMessage, captureException } = require('./sentry-report.js');

const SCRIPTS_DIR = __dirname;
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WorkDaddy');
const UI_PORT = parseInt(process.env.WBSWITCH_PORT || '47832', 10);
const cliCdpPort = process.argv.find((arg) => /^--cdp-port=\d+$/i.test(arg));
let CDP_PORT = parseInt(process.env.WBSWITCH_CDP_PORT || (cliCdpPort ? cliCdpPort.split('=')[1] : '') || '0', 10);
const CDP_PORT_FILE = path.join(DATA_DIR, 'cdp-port.json');
const ELEVATED_HELPER_MODE = process.argv.includes('--inject-helper');

function log(...args) {
  const line = `[launcher] ${new Date().toISOString()} ${args.join(' ')}\n`;
  try { process.stdout.write(line); } catch (_) {}
  try { fs.appendFileSync(path.join(DATA_DIR, 'launcher.log'), line); } catch (_) {}
}

// ---------- 小工具 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function reportAndExit(code, message, stage = 'windows-launcher') {
  try { await captureMessage(message, { stage, extra: { exitCode: code } }); } catch (_) {}
  process.exit(code);
}

function validCdpPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function readCdpPortFile() {
  try {
    const port = JSON.parse(fs.readFileSync(CDP_PORT_FILE, 'utf8')).port;
    return validCdpPort(port) ? port : 0;
  } catch (_) { return 0; }
}

function writeCdpPortFile(port) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CDP_PORT_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ port, updatedAt: new Date().toISOString() }) + '\n');
    fs.renameSync(tmp, CDP_PORT_FILE);
  } catch (e) { log('保存 CDP 端口配置失败: ' + e.message); }
}

function cdpPortCandidates() {
  const result = [];
  const add = (port) => { if (validCdpPort(port) && !result.includes(port)) result.push(port); };
  add(CDP_PORT);
  add(readCdpPortFile());
  for (let port = 9222; port <= 9232; port++) add(port);
  add(9333);
  return result;
}

// 当前进程是否为管理员（Windows）
function isElevated() {
  try {
    const r = spawnSync(
      'net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }
    );
    return r.status === 0;
  } catch (_) { return false; }
}

// 以管理员身份运行"重启注入助手"（child 脚本），launcher 本体保持普通权限。
// 返回是否已成功派发（派发后 launcher 立即退出，由助手完成真正的重启+注入）。
function spawnElevatedHelper() {
  const nodeBin = process.execPath;                 // 当前 node
  const childJs = path.join(SCRIPTS_DIR, 'win-inject-helper.js');
  if (!fs.existsSync(childJs)) return false;
  // 用 UTF-16LE 编码 PowerShell 命令，避免安装目录含中文时经过当前代码页导致路径乱码；
  // Node 参数顺序必须是「脚本路径 → 脚本参数」，否则 --inject-helper 会被 Node 当成自身选项。
  const childArg = '"' + childJs + '"';
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Start-Process -FilePath ' + psQuote(nodeBin) + ' ' +
      '-ArgumentList @(' + [psQuote(childArg), psQuote('--inject-helper'), psQuote(String(CDP_PORT))].join(', ') + ') ' +
      '-Verb RunAs -WindowStyle Hidden',
  ].join('; ');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const ps = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedCommand,
  ];
  try {
    const r = spawnSync('powershell', ps, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    if (r.error || r.status !== 0) {
      log('提权助手派发失败: ' + (r.error ? r.error.message : 'powershell exit ' + r.status));
      return false;
    }
    return true;
  } catch (e) {
    log('提权助手派发异常: ' + e.message);
    return false;
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 1200);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function httpGet(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function httpPost(port, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 1500 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function isWorkBuddyCdp() {
  return isWorkBuddyCdpAt(CDP_PORT);
}

async function isWorkBuddyCdpAt(port) {
  const version = await httpGet(port, '/json/version');
  if (!version || version.status !== 200) return false;
  try {
    const info = JSON.parse(version.body || '{}');
    return /workbuddy|codebuddy/i.test([info.Browser, info['User-Agent']].filter(Boolean).join(' '));
  } catch (_) { return false; }
}

async function configureCdpPort() {
  for (const port of cdpPortCandidates()) {
    if (await isWorkBuddyCdpAt(port)) {
      CDP_PORT = port;
      writeCdpPortFile(port);
      log('发现 WorkBuddy CDP 端口: ' + port);
      return port;
    }
  }
  for (const port of cdpPortCandidates()) {
    if (!(await portOpen(port))) {
      CDP_PORT = port;
      writeCdpPortFile(port);
      log('选择空闲 CDP 端口: ' + port);
      return port;
    }
  }
  throw new Error('9222-9232、9333 均被占用，无法启动 WorkBuddy CDP');
}

function psOut(cmd) {
  try {
    return spawnSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).stdout || '';
  } catch (_) { return ''; }
}

function readDaemonVersion() {
  try {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'daemon.js'), 'utf8');
    const m = src.match(/DAEMON_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

// ---------- 定位 node（托管优先：.workbuddy\binaries\node\versions\<v>\node.exe，其次 PATH） ----------
function findNode() {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  let verDirs = [];
  try {
    verDirs = fs.readdirSync(base)
      .map((d) => path.join(base, d, 'node.exe'))
      .filter((p) => fs.existsSync(p))
      .sort();
  } catch (_) {}
  if (verDirs.length) return verDirs[verDirs.length - 1];
  try {
    const r = spawnSync('node', ['-v'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.status === 0) return 'node';
  } catch (_) {}
  return null;
}

// ---------- 定位 WorkBuddy.exe（环境变量 > 运行进程 > 注册表 > 常见路径） ----------
let wbBinaryCache = null;
function findWorkBuddy() {
  if (wbBinaryCache) return wbBinaryCache;
  const tryFile = (p) => { try { if (p && fs.existsSync(p)) return p; } catch (_) {} return null; };
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (envBin) return (wbBinaryCache = envBin);
  try {
    const p = psOut('Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path').split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  try {
    const p = psOut("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | Select-Object -First 1 DisplayIcon,InstallLocation | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ Join-Path $_.InstallLocation 'WorkBuddy.exe' } }").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  for (const c of [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    'D:\\workbody\\WorkBuddy\\WorkBuddy.exe',
  ]) {
    const hit = tryFile(c);
    if (hit) return (wbBinaryCache = hit);
  }
  return null;
}

// ---------- 1. 确保 daemon 运行 ----------
function watchdogAlive() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    if (!pid) return false;
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 && /node/i.test(r.stdout);
  } catch (_) { return false; }
}

function daemonRunning() {
  return portOpen(UI_PORT);
}

async function ensureDaemon(nodeBin) {
  fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
  // 已有 daemon：检查版本一致性（旧版本代码继续注入会出兼容问题）
  const st = await httpGet(UI_PORT, '/api/status');
  if (st && st.status === 200) {
    let runningVer = '';
    try { runningVer = (JSON.parse(st.body).version || ''); } catch (_) {}
    const want = readDaemonVersion();
    if (runningVer === want) {
      log('daemon 已在运行且版本一致 (' + runningVer + ')，跳过启动');
      return true;
    }
    log('检测到旧版 daemon (' + runningVer + ' != ' + want + ')，强制重启');
    stopDaemonByPort();
  } else if (watchdogAlive()) {
    log('watchdog 在运行但 daemon 未就绪，等待其拉起...');
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (daemonRunning()) { log('daemon 已就绪'); return true; }
    }
    log('等待超时，主动拉起 watchdog');
  }
  // 启动 watchdog（它负责启动 daemon + 崩溃拉起）
  if (!watchdogAlive()) {
    log('启动 watchdog: ' + nodeBin);
    const child = spawn(nodeBin, [path.join(SCRIPTS_DIR, 'watchdog.js')], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (daemonRunning()) { log('daemon 已就绪'); return true; }
  }
  log('等待 daemon 就绪超时');
  return daemonRunning();
}

function stopDaemonByPort() {
  // 杀 watchdog（会连带杀 daemon）→ 兜底按端口杀
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    if (pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    try { fs.unlinkSync(path.join(DATA_DIR, 'watchdog.pid')); } catch (_) {}
  } catch (_) {}
  // 兜底：杀监听 UI 端口的进程
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).stdout || '';
  const lines = out.split(/\r?\n/).filter((l) => l.includes(':' + UI_PORT) && /LISTENING/i.test(l));
  const pids = new Set();
  for (const l of lines) {
    const m = l.trim().split(/\s+/);
    const pid = m[m.length - 1];
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true });
  }
  return pids.size > 0;
}

// ---------- 2/3. WorkBuddy CDP 处理 ----------
function workBuddyRunning() {
  try {
    const r = spawnSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    return r.status === 0 && /"WorkBuddy\.exe"/i.test(r.stdout || '');
  } catch (_) {
    return true;
  }
}

function runTaskkill(args) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const p = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    p.on('error', (error) => finish({ code: null, error }));
    p.on('exit', (code, signal) => finish({ code, signal, error: null }));
    timer = setTimeout(() => finish({ code: null, error: new Error('taskkill 超时') }), 10000);
  });
}

async function waitForWorkBuddyExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning()) return true;
    await sleep(200);
  }
  return !workBuddyRunning();
}

async function quitWorkBuddy() {
  if (!workBuddyRunning()) return true;
  await runTaskkill(['/IM', 'WorkBuddy.exe']);
  if (await waitForWorkBuddyExit(1800)) return true;
  await runTaskkill(['/F', '/T', '/IM', 'WorkBuddy.exe']);
  if (await waitForWorkBuddyExit(4000)) return true;
  throw new Error('无法确认 WorkBuddy 已退出');
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * 从管理员 launcher 启动 WorkBuddy 时，不能直接 spawn 子进程：Electron/Chromium
 * 在部分 Windows 环境以高完整性令牌启动会出现白屏。通过 Explorer 的 ShellExecute
 * 让桌面 shell 以当前用户令牌创建 GUI 进程；普通权限 launcher 仍走同一条路径。
 */
function launchWorkBuddy(wb) {
  const args = '--remote-debugging-port=' + CDP_PORT;
  if (isElevated()) {
    const command = [
      '$shell = New-Object -ComObject Shell.Application',
      '$shell.ShellExecute(' + [
        psQuote(wb),
        psQuote(args),
        psQuote(path.dirname(wb)),
        "'open'",
        '1',
      ].join(', ') + ')',
    ].join('; ');
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { stdio: 'ignore', windowsHide: true, timeout: 15000 }
    );
    if (result.status === 0) {
      log('WorkBuddy 已通过 Explorer ShellExecute 以当前用户权限启动');
      return true;
    }
    log('ShellExecute 启动 WorkBuddy 失败，改用 explorer.exe 兜底 (code=' + result.status + ')');
    try {
      const shell = spawn('explorer.exe', [wb, args], { detached: true, stdio: 'ignore', windowsHide: true });
      shell.unref();
      return true;
    } catch (e) {
      log('explorer.exe 启动 WorkBuddy 失败: ' + e.message);
    }
  }

  const child = spawn(wb, [args], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => { log('启动 WorkBuddy 失败: ' + e.message); });
  child.unref();
  return true;
}

async function injectNow() {
  // daemon 的 /api/inject 是 POST
  try { await httpPost(UI_PORT, '/api/inject'); } catch (_) {}
}

// ---------- main ----------
(async () => {
  // 入口级 breadcrumb 必须先于 Node/PowerShell/进程探测写出，避免管理员启动时
  // 探测耗时让 Windows Terminal 看起来像“空白无响应”；同一行也会落到 launcher.log。
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  log('启动入口: scripts=' + SCRIPTS_DIR + ' data=' + DATA_DIR + ' pid=' + process.pid);
  const nodeBin = findNode();
  if (!nodeBin) {
    log('未找到 Node.js（需 .workbuddy\\binaries 托管 node 或 PATH 中的 node）');
    console.error('错误：未找到 Node.js。请先安装 Node.js 或安装 WorkBuddy（自带托管 node）。');
    await reportAndExit(1, '未找到 Node.js（WorkBuddy 托管运行时或 PATH）', 'windows-launcher-node');
    return;
  }
  await configureCdpPort();

  // 提权助手接管时，先停掉普通权限启动的 watchdog/daemon，避免两个权限级别的
  // daemon 同时占用端口；WorkBuddy GUI 后续仍由 ShellExecute 以用户权限启动。
  if (ELEVATED_HELPER_MODE) {
    log('提权流程：接管普通权限 daemon');
    stopDaemonByPort();
    await sleep(800);
  }
  await ensureDaemon(nodeBin);

  // 已在 CDP 模式 → 幂等注入
  if (await isWorkBuddyCdp()) {
    await injectNow();
    log('WorkBuddy 已在调试模式（端口 ' + CDP_PORT + '），组件已注入');
    console.log('WorkDaddy：WorkBuddy 已在调试模式，组件已注入 ✓');
    process.exit(0);
  }

  // 未开 CDP → 需要重启 WorkBuddy 带调试端口
  const wb = findWorkBuddy();
  if (!wb) {
    console.error('未找到 WorkBuddy.exe。可用环境变量 WBSWITCH_WORKBUDDY_BIN 指定完整路径。');
    log('未找到 WorkBuddy.exe');
    await reportAndExit(2, '未找到 WorkBuddy.exe', 'windows-launcher-workbuddy-path');
    return;
  }

  // WorkBuddy 常装在 C:\Program Files（受保护特权目录），结束已提升的旧进程可能需要管理员权限。
  // 若当前非管理员：派发提权助手（触发一次 UAC）后立即退出，由助手完成重启+注入，
  // 避免普通双击时卡在黑屏空转等 20 秒。
  if (!isElevated()) {
    log('非管理员权限：派发提权助手重启 WorkBuddy（唤醒 UAC）');
    console.log('需要管理员权限以重启 WorkBuddy 进入调试模式，正在请求授权...');
    if (spawnElevatedHelper()) {
      console.log('已发起提权请求，点击 UAC「是」后将自动完成重启与注入。');
      process.exit(0);
    }
    // 派发失败则仍退回当前进程尝试（容错）
    log('提权派发失败，退回当前进程直接重启');
  }

  log('重启 WorkBuddy（带 --remote-debugging-port=' + CDP_PORT + '，GUI 使用当前用户权限）: ' + wb);
  console.log('正在以调试模式重启 WorkBuddy（约几秒）...');

  await quitWorkBuddy();
  await sleep(500);
  launchWorkBuddy(wb);

  let ok = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await isWorkBuddyCdp()) { ok = true; break; }
  }
  if (ok) {
    await sleep(1500);
    await injectNow();
    log('WorkBuddy 已启动（调试模式），组件已注入');
    console.log('WorkDaddy：WorkBuddy 已启动（调试模式），组件已注入 ✓');
  } else {
    log('等待 20 秒未检测到调试端口 ' + CDP_PORT);
    console.log('等待超时：未检测到调试端口 ' + CDP_PORT + '。可手动执行：cd /d ' + path.dirname(wb) + ' && "' + wb + '" --remote-debugging-port=' + CDP_PORT);
    await captureMessage('等待 20 秒未检测到 WorkBuddy CDP 端口', { stage: 'windows-launcher-cdp-timeout', extra: { cdpPort: CDP_PORT, workBuddy: wb } }).catch(() => {});
  }
  process.exit(ok ? 0 : 3);
})().catch((e) => {
  log('launcher 异常: ' + (e && e.stack || e));
  console.error('WorkDaddy 启动异常: ' + (e && e.message || e));
  captureException(e, { stage: 'windows-launcher-uncaught' }).catch(() => {}).finally(() => process.exit(4));
});
