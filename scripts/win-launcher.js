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
// 便携版/低速磁盘上的 WorkBuddy 首次启动可能超过 20 秒；超时只应在足够长的窗口后报告。
const CDP_STARTUP_TIMEOUT_MS = 60000;
const WORKBUDDY_PROCESS_NAMES = new Set(['workbuddy.exe', 'codebuddy.exe', 'workbuddyai.exe']);

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

async function isWorkBuddyCdpAt(port, binary = null) {
  const version = await httpGet(port, '/json/version');
  if (!version || version.status !== 200) return false;
  try {
    const info = JSON.parse(version.body || '{}');
    if (/workbuddy|codebuddy/i.test([info.Browser, info['User-Agent']].filter(Boolean).join(' '))) return true;
    // 某些 WorkBuddy 版本隐藏 Electron 品牌；端口响应 + 同安装目录进程的精确参数仍可确认归属。
    return Boolean(binary && workBuddyProcesses(binary).some((p) => processCdpPort(p) === Number(port)));
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

// 进程名并不总是可靠：Electron 的单实例宿主可能以 CodeBuddy.exe 或辅助进程名存在。
// 通过 CIM 同时拿到路径、父 PID 和命令行，只在本地诊断使用；命令行正文绝不写入日志/Sentry。
function getWorkBuddyProcesses() {
  const command = [
    '$names=@("WorkBuddy.exe","CodeBuddy.exe","WorkBuddyAI.exe")',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
    '| Where-Object { $names -contains $_.Name }',
    '| Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine',
    '| ConvertTo-Json -Compress',
  ].join(' ');
  const raw = psOut(command).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((p) => p && Number(p.ProcessId) > 0);
  } catch (_) {
    return [];
  }
}

function sameWindowsPath(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

function workBuddyProcesses(binary = null) {
  return getWorkBuddyProcesses().filter((p) => {
    if (!WORKBUDDY_PROCESS_NAMES.has(String(p.Name || '').toLowerCase())) return false;
    if (!binary || !p.ExecutablePath) return true;
    // WorkBuddy 可能把 Electron 主进程拆成同目录下的 CodeBuddy.exe/辅助宿主；按安装目录归组。
    return sameWindowsPath(p.ExecutablePath, binary) ||
      sameWindowsPath(path.dirname(p.ExecutablePath), path.dirname(binary));
  });
}

function processCdpPort(process) {
  const commandLine = String(process && process.CommandLine || '');
  const match = commandLine.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/i);
  return match ? Number(match[1]) : 0;
}

function processHasCdpArg(process, port = CDP_PORT) {
  return processCdpPort(process) === Number(port);
}

function processDiagnostics(binary = null) {
  return workBuddyProcesses(binary).map((p) => ({
    pid: Number(p.ProcessId),
    parentPid: Number(p.ParentProcessId) || null,
    name: String(p.Name || ''),
    executable: path.basename(String(p.ExecutablePath || '')),
    hasCommandLine: Boolean(String(p.CommandLine || '').trim()),
    hasCdpArg: processCdpPort(p) > 0,
    cdpPort: processCdpPort(p) || null,
    hasExpectedCdpArg: processHasCdpArg(p),
  }));
}

function logProcessDiagnostics(binary, prefix = 'WorkBuddy 进程诊断') {
  const rows = processDiagnostics(binary);
  log(prefix + ': ' + (rows.length ? JSON.stringify(rows) : '无匹配进程'));
  return rows;
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

// ---------- 定位 WorkBuddy.exe（环境变量 > 运行进程 > App Paths/卸载注册表 > 常见便携路径） ----------
let wbBinaryCache = null;
function findWorkBuddy() {
  if (wbBinaryCache) return wbBinaryCache;
  const tryFile = (p) => {
    try {
      const candidate = String(p || '').trim().replace(/^"(.*)"(?:,\d+)?$/, '$1').replace(/,\d+$/, '');
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {}
    return null;
  };
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (envBin) return (wbBinaryCache = envBin);
  try {
    const p = psOut('Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path').split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  try {
    const p = psOut("Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(WorkBuddy|CodeBuddy|WorkBuddyAI)\\.exe$' -and $_.ExecutablePath } | Select-Object -First 1 -ExpandProperty ExecutablePath").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  // 便携版通常没有卸载项，但可能注册了 App Paths；优先读取其真实可执行路径。
  try {
    const p = psOut("$k=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe'); Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object { if ($_.'(default)') { $_.'(default)' } elseif ($_.Path) { $_.Path } } | Select-Object -First 1").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  try {
    const p = psOut("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | Select-Object -First 1 DisplayIcon,InstallLocation | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ Join-Path $_.InstallLocation 'WorkBuddy.exe' } }").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'workbuddy', 'current', 'WorkBuddy.exe'),
    'D:\\workbuddy\\WorkBuddy.exe',
  ];
  if (process.env.WBSWITCH_WORKBUDDY_DIR) roots.push(path.join(process.env.WBSWITCH_WORKBUDDY_DIR, 'WorkBuddy.exe'));
  // 兼容类似 D:\Software\workbuddy\WorkBuddy.exe 的便携目录，不递归扫描整盘。
  try {
    const driveRoots = psOut('(Get-PSDrive -PSProvider FileSystem).Root').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const root of driveRoots) {
      roots.push(path.join(root, 'Software', 'workbuddy', 'WorkBuddy.exe'));
      roots.push(path.join(root, 'workbuddy', 'WorkBuddy.exe'));
      roots.push(path.join(root, 'WorkBuddy', 'WorkBuddy.exe'));
    }
  } catch (_) {}
  for (const c of roots) {
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
function workBuddyRunning(binary = null) {
  const processes = workBuddyProcesses(binary);
  if (processes.length) return true;
  // CIM 失败时保守回退到 tasklist，避免误判为已退出后把启动参数交给旧实例。
  try {
    const filters = Array.from(WORKBUDDY_PROCESS_NAMES).map((name) =>
      spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      })
    );
    return filters.some((r) => r.status === 0 && WORKBUDDY_PROCESS_NAMES.has(
      String(r.stdout || '').match(/"([^"]+\.exe)"/i)?.[1]?.toLowerCase() || ''
    ));
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

async function waitForWorkBuddyExit(timeoutMs, binary = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning(binary)) return true;
    await sleep(200);
  }
  return !workBuddyRunning(binary);
}

async function quitWorkBuddy(binary) {
  const initial = workBuddyProcesses(binary);
  if (!initial.length && !workBuddyRunning(binary)) return true;

  // 按实际 PID 精确结束安装目录中的进程树，避免 /IM 只结束主进程而留下单实例宿主。
  const pids = new Set(initial.map((p) => String(Number(p.ProcessId))).filter((pid) => pid !== '0'));
  if (!pids.size) pids.add('0');
  for (const pid of pids) {
    if (pid !== '0') await runTaskkill(['/T', '/PID', pid]);
  }
  if (await waitForWorkBuddyExit(2500, binary)) return true;
  for (const pid of pids) {
    if (pid !== '0') await runTaskkill(['/F', '/T', '/PID', pid]);
  }
  if (await waitForWorkBuddyExit(5500, binary)) return true;
  logProcessDiagnostics(binary, '结束 WorkBuddy 后仍有进程');
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
      return { method: 'shell-execute' };
    }
    log('ShellExecute 启动 WorkBuddy 失败，改用 explorer.exe 兜底 (code=' + result.status + ')');
    try {
      const shell = spawn('explorer.exe', [wb, args], { detached: true, stdio: 'ignore', windowsHide: true });
      shell.unref();
      return { method: 'explorer-fallback' };
    } catch (e) {
      log('explorer.exe 启动 WorkBuddy 失败: ' + e.message);
    }
  }

  const child = spawn(wb, [args], {
    cwd: path.dirname(wb), detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', (e) => { log('启动 WorkBuddy 失败: ' + e.message); });
  child.unref();
  return { method: 'node-spawn', pid: child.pid };
}

async function waitForWorkBuddyCdp(binary) {
  const deadline = Date.now() + CDP_STARTUP_TIMEOUT_MS;
  let retryWithoutCdpArg = false;
  let lastDiagnosticAt = 0;
  let launchStartedAt = Date.now();

  const start = () => {
    const launched = launchWorkBuddy(binary);
    launchStartedAt = Date.now();
    log('WorkBuddy 启动请求已派发 method=' + launched.method + ' expectedPort=' + CDP_PORT +
      (launched.pid ? ' pid=' + launched.pid : ''));
  };
  start();

  while (Date.now() < deadline) {
    await sleep(1000);
    if (await isWorkBuddyCdpAt(CDP_PORT, binary)) return true;

    const elapsed = Date.now() - launchStartedAt;
    const diagnostics = processDiagnostics(binary);
    const hasProcessWithoutArg = diagnostics.length > 0 && diagnostics.every((p) => p.hasCommandLine) &&
      !diagnostics.some((p) => p.hasCdpArg);
    if (hasProcessWithoutArg && elapsed >= 5000 && !retryWithoutCdpArg) {
      // 单实例宿主可能接管了第一次启动请求；精确结束该安装目录的进程树后只重试一次。
      logProcessDiagnostics(binary, '启动后进程未携带 CDP 参数，准备重试');
      retryWithoutCdpArg = true;
      await quitWorkBuddy(binary);
      await sleep(1000);
      start();
      continue;
    }
    if (Date.now() - lastDiagnosticAt >= 5000) {
      lastDiagnosticAt = Date.now();
      log('等待 WorkBuddy CDP: ' + Math.min(Date.now() - (deadline - CDP_STARTUP_TIMEOUT_MS), CDP_STARTUP_TIMEOUT_MS) +
        'ms/' + CDP_STARTUP_TIMEOUT_MS + 'ms');
      if (diagnostics.length) logProcessDiagnostics(binary, '等待期间');
    }
  }

  // 端口可能在启动后被系统/其他进程抢占；超时前再扫描候选端口一次，避免只盯着旧的 9222。
  for (const port of cdpPortCandidates()) {
    if (port === CDP_PORT) continue;
    if (await isWorkBuddyCdpAt(port, binary)) {
      CDP_PORT = port;
      writeCdpPortFile(port);
      log('超时前发现 WorkBuddy 使用备用 CDP 端口: ' + port);
      return true;
    }
  }
  logProcessDiagnostics(binary, 'CDP 超时最终诊断');
  return false;
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

  await quitWorkBuddy(wb);
  await sleep(1000);
  const ok = await waitForWorkBuddyCdp(wb);
  if (ok) {
    await sleep(1500);
    await injectNow();
    log('WorkBuddy 已启动（调试模式），组件已注入');
    console.log('WorkDaddy：WorkBuddy 已启动（调试模式），组件已注入 ✓');
  } else {
    log('等待 ' + (CDP_STARTUP_TIMEOUT_MS / 1000) + ' 秒未检测到调试端口 ' + CDP_PORT);
    console.log('等待超时：未检测到调试端口 ' + CDP_PORT + '。可手动执行：cd /d ' + path.dirname(wb) + ' && "' + wb + '" --remote-debugging-port=' + CDP_PORT);
    await captureMessage('等待 ' + (CDP_STARTUP_TIMEOUT_MS / 1000) + ' 秒未检测到 WorkBuddy CDP 端口', {
      stage: 'windows-launcher-cdp-timeout',
      extra: { cdpPort: CDP_PORT, workBuddy: wb, timeoutMs: CDP_STARTUP_TIMEOUT_MS, processes: processDiagnostics(wb) },
    }).catch(() => {});
  }
  process.exit(ok ? 0 : 3);
})().catch((e) => {
  log('launcher 异常: ' + (e && e.stack || e));
  console.error('WorkDaddy 启动异常: ' + (e && e.message || e));
  captureException(e, { stage: 'windows-launcher-uncaught' }).catch(() => {}).finally(() => process.exit(4));
});
