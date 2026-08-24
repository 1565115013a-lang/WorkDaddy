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
const { getProfile, profileDataDir } = require('./profiles.js');
const { isTargetForProfile } = require('./cdp-targets.js');

const SCRIPTS_DIR = __dirname;
const HOST = '127.0.0.1';
const PROFILE_ID = process.env.WBSWITCH_PROFILE || 'workbuddy-cn';
if (!process.env.WBSWITCH_PROFILE) process.env.WBSWITCH_PROFILE = PROFILE_ID;
const PROFILE = getProfile(PROFILE_ID);
const WBS_BRAND = PROFILE.appName || 'WorkDaddy'; // 品牌显示名跟随 profile（WorkDaddy AI / WorkDaddy）
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  profileDataDir(PROFILE);
const DEFAULT_UI_PORT = { 'workbuddy-cn': 47832, 'workbuddy-ai': 47833, 'codebuddy-cn': 47834, 'codebuddy-intl': 47835 }[PROFILE.id] || 47832;
const UI_PORT = parseInt(process.env.WBSWITCH_PORT || String(DEFAULT_UI_PORT), 10);
const PROFILE_CDP_PORTS = {
  'workbuddy-cn': [9222, 9226, 9227, 9228, 9229, 9230, 9231, 9232],
  'workbuddy-ai': [9223, 9233, 9234, 9235, 9236, 9237, 9238, 9239],
  'codebuddy-cn': [9224],
  'codebuddy-intl': [9225],
};
const DEFAULT_CDP_PORT = (PROFILE_CDP_PORTS[PROFILE.id] || [9222])[0];
const cliCdpPort = process.argv.find((arg) => /^--cdp-port=\d+$/i.test(arg));
let CDP_PORT = parseInt(process.env.WBSWITCH_CDP_PORT || (cliCdpPort ? cliCdpPort.split('=')[1] : '') || String(DEFAULT_CDP_PORT), 10);
const CDP_PORT_FILE = path.join(DATA_DIR, 'cdp-port.json');
const ELEVATED_HELPER_MODE = process.argv.includes('--inject-helper');
// 便携版/低速磁盘上的 WorkBuddy 首次启动可能超过 20 秒；超时只应在足够长的窗口后报告。
const CDP_STARTUP_TIMEOUT_MS = 60000;
// PR#8 实机确认 WorkBuddy 两个版本分别使用 WorkBuddy.exe / WorkBuddyAI.exe。
// 两者都纳入探测和退出；路径过滤负责避免 CN launcher 误杀 AI 的同名族进程。
const PROFILE_PROCESS_NAMES = new Set(
  PROFILE.kind === 'workbuddy' ? ['workbuddy.exe', 'workbuddyai.exe'] :
    PROFILE.id === 'codebuddy-intl' ? ['codebuddy.exe'] : ['codebuddy.exe']
);

function log(...args) {
  const line = `[launcher] ${new Date().toISOString()} [client=${PROFILE.name}] [profile=${PROFILE.id}] ${args.join(' ')}\n`;
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
  // 与 daemon.js 的候选顺序保持一致：首选/持久化端口之后，扫描完整的本机回环端口池。
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
    const s = net.connect({ port, host: HOST });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 1200);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function isLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      if (available) {
        try { server.close(() => resolve(true)); } catch (_) { resolve(true); }
      } else {
        try { server.close(); } catch (_) {}
        resolve(false);
      }
    };
    server.once('error', () => finish(false));
    server.listen({ host: HOST, port }, () => finish(true));
  });
}

function httpGet(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: p, timeout: 1500 }, (res) => {
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
    const req = http.request({ host: HOST, port, path: p, method: 'POST', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 20000) body = body.slice(0, 20000); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
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
  const [version, targets] = await Promise.all([
    httpGet(port, '/json/version'),
    httpGet(port, '/json/list'),
  ]);
  if (!version || version.status !== 200 || !targets || targets.status !== 200) return false;
  try {
    const info = JSON.parse(version.body || '{}');
    const list = JSON.parse(targets.body || '[]');
    if (Array.isArray(list) && list.some((target) => isTargetForProfile(target, PROFILE))) return true;
    // 某些版本隐藏页面强信号；只有同安装目录进程的精确参数带着该端口时才允许兜底。
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
    // TCP connect 对无响应的残留 socket 可能返回超时并误报空闲；bind 才能确认新进程能否监听。
    if (await isLocalPortAvailable(port)) {
      CDP_PORT = port;
      writeCdpPortFile(port);
      log('选择可绑定 CDP 端口: ' + port);
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
function getWorkBuddyProcessesViaCim() {
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

function parseTasklistOutput(raw) {
  const processes = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) continue;
    processes.push({
      ProcessId: Number(match[2]),
      ParentProcessId: null,
      Name: match[1],
      ExecutablePath: null,
      CommandLine: '',
      processSource: 'tasklist',
    });
  }
  return processes;
}

function getWorkBuddyProcessesViaTasklist() {
  const processes = [];
  for (const name of PROFILE_PROCESS_NAMES) {
    try {
      const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      processes.push(...parseTasklistOutput(result.stdout));
    } catch (_) {}
  }
  return processes;
}

function getWorkBuddyProcesses() {
  const cimProcesses = getWorkBuddyProcessesViaCim();
  // CIM 偶发返回空或不可解析时，tasklist 仍能提供 PID，避免把运行中的客户端误判为不存在。
  return cimProcesses.length ? cimProcesses : getWorkBuddyProcessesViaTasklist();
}

function sameWindowsPath(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

function workBuddyProcesses(binary = null) {
  return getWorkBuddyProcesses().filter((p) => {
    if (!PROFILE_PROCESS_NAMES.has(String(p.Name || '').toLowerCase())) return false;
    if (!binary) return true;
    // tasklist 回退没有路径，只接受与目标二进制同名的主进程，避免跨客户端误杀。
    if (!p.ExecutablePath) return String(p.Name || '').toLowerCase() === path.basename(binary).toLowerCase();
    // WorkBuddy 可能把 Electron 主进程拆成同目录下的 CodeBuddy.exe/辅助宿主；按安装目录归组。
    return sameWindowsPath(p.ExecutablePath, binary) ||
      sameWindowsPath(path.dirname(p.ExecutablePath), path.dirname(binary));
  });
}

function targetProcessNames(binary = null) {
  const names = new Set();
  const normalized = String(binary || '').toLowerCase();
  for (const p of getWorkBuddyProcesses()) {
    if (!PROFILE_PROCESS_NAMES.has(String(p.Name || '').toLowerCase())) continue;
    if (binary) {
      if (!p.ExecutablePath && String(p.Name || '').toLowerCase() !== path.basename(binary).toLowerCase()) continue;
      if (p.ExecutablePath && !(
        sameWindowsPath(p.ExecutablePath, binary) ||
        sameWindowsPath(path.dirname(p.ExecutablePath), path.dirname(binary))
      )) continue;
    }
    names.add(String(p.Name).toLowerCase());
  }
  if (names.size) return names;
  if (normalized.endsWith('workbuddyai.exe') || PROFILE.id === 'workbuddy-ai') return new Set(['workbuddyai.exe']);
  return new Set(['workbuddy.exe']);
}

function tasklistProcessIds(names = PROFILE_PROCESS_NAMES) {
  const ids = new Set();
  for (const name of names) {
    try {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const m = line.match(/^"[^"]+","(\d+)"/);
        if (m) ids.add(m[1]);
      }
    } catch (_) {}
  }
  return ids;
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
  const profileBin = tryFile(PROFILE.appPath);
  if (profileBin) return (wbBinaryCache = profileBin);
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
    path.join(process.env.LOCALAPPDATA || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.APPDATA || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'WorkBuddy.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'workbuddy', 'current', 'WorkBuddy.exe'),
    'D:\\workbuddy\\WorkBuddy.exe',
  ];
  if (PROFILE.id === 'workbuddy-ai') {
    roots.unshift(
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'WorkBuddyAI', 'WorkBuddyAI.exe')
    );
  }
  if (process.env.WBSWITCH_WORKBUDDY_DIR) roots.push(path.join(process.env.WBSWITCH_WORKBUDDY_DIR, 'WorkBuddy.exe'));
  for (const candidate of roots) {
    const hit = tryFile(candidate);
    if (hit) return (wbBinaryCache = hit);
  }
  // 兼容 Electron/Squirrel 把 exe 放在 app-5.3.14 等版本子目录的安装方式；
  // 只扫描明确的客户端目录，避免递归扫描整盘或整个用户目录。
  try {
    const scanDirs = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy'),
      path.join(process.env.LOCALAPPDATA || '', 'WorkBuddy'),
      path.join(process.env.APPDATA || '', 'WorkBuddy'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy'),
      path.join(process.env.LOCALAPPDATA || '', 'CodeBuddy'),
    ];
    if (PROFILE.id === 'workbuddy-ai') {
      scanDirs.unshift(
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI'),
        path.join(process.env.LOCALAPPDATA || '', 'WorkBuddyAI')
      );
    }
    const names = PROFILE.id === 'workbuddy-ai'
      ? ['WorkBuddyAI.exe', 'WorkBuddy.exe']
      : ['WorkBuddy.exe', 'CodeBuddy.exe'];
    const rootArgs = scanDirs.map(psQuote).join(', ');
    const nameArgs = names.map(psQuote).join(', ');
    const command = [
      '$roots=@(' + rootArgs + ')',
      '$names=@(' + nameArgs + ')',
      'foreach($root in $roots){',
      'if(-not (Test-Path -LiteralPath $root -PathType Container)){continue}',
      '$hit=Get-ChildItem -LiteralPath $root -File -Recurse -Depth 5 -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name } | Select-Object -First 1 -ExpandProperty FullName',
      'if($hit){$hit;break}',
      '}',
    ].join('; ');
    const p = psOut(command).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  // 兼容类似 D:\Software\workbuddy\WorkBuddy.exe 的便携目录。
  try {
    const driveRoots = psOut('(Get-PSDrive -PSProvider FileSystem).Root').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const root of driveRoots) {
      roots.push(path.join(root, 'Software', 'workbuddy', 'WorkBuddy.exe'));
      roots.push(path.join(root, 'workbuddy', 'WorkBuddy.exe'));
      roots.push(path.join(root, 'WorkBuddy', 'WorkBuddy.exe'));
    }
  } catch (_) {}
  for (const candidate of roots) {
    const hit = tryFile(candidate);
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
  if (binary) {
    // CIM 能看到同族进程但路径明确属于另一个安装目录时，不应把它当成当前客户端仍在运行。
    // 路径未知则保守认为仍在运行，后续 tasklist/PID 回退会尝试结束并写出诊断。
    const unknownPath = getWorkBuddyProcesses().some((p) =>
      PROFILE_PROCESS_NAMES.has(String(p.Name || '').toLowerCase()) && !p.ExecutablePath
    );
    if (!unknownPath) return false;
  }
  // CIM 失败时保守回退到 tasklist，避免误判为已退出后把启动参数交给旧实例。
  try {
    const names = binary ? targetProcessNames(binary) : PROFILE_PROCESS_NAMES;
    const filters = Array.from(names).map((name) =>
      spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      })
    );
    return filters.some((r) => r.status === 0 && names.has(
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

function runElevatedTaskkillPids(pids) {
  const clean = Array.from(new Set(pids.map((pid) => String(pid)).filter((pid) => /^\d+$/.test(pid))));
  if (!clean.length) return { code: 0, error: null };
  const args = ['/F', '/T'];
  for (const pid of clean) args.push('/PID', pid);
  const command = [
    '$p = Start-Process -FilePath ' + psQuote('taskkill.exe') +
      ' -ArgumentList @(' + args.map(psQuote).join(', ') + ') -Verb RunAs -WindowStyle Hidden -Wait -PassThru',
    'exit $p.ExitCode',
  ].join('; ');
  try {
    const result = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: 'ignore' });
    return {
      code: result.status,
      error: result.error ? result.error.message : null,
    };
  } catch (e) {
    return { code: null, error: e.message };
  }
}

async function waitForWorkBuddyExit(timeoutMs, binary = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning(binary)) return true;
    await sleep(200);
  }
  return !workBuddyRunning(binary);
}

function exitSnapshot(binary = null) {
  return {
    binary: binary ? path.basename(binary) : null,
    processes: processDiagnostics(binary),
    tasklistPids: Array.from(tasklistProcessIds(targetProcessNames(binary))),
  };
}

async function killForExit(args, stage) {
  const result = await runTaskkill(args);
  const error = result.error ? result.error.message : '';
  log(`[exit] ${stage} taskkill=${args.join(' ')} code=${result.code == null ? 'null' : result.code}${error ? ' error=' + error : ''}`);
  return result;
}

async function quitWorkBuddy(binary) {
  const initial = workBuddyProcesses(binary);
  const targetNames = targetProcessNames(binary);
  if (!initial.length && !workBuddyRunning(binary)) return true;

  log(`[exit] 开始确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
  // 按实际 PID 精确结束安装目录中的进程树；CIM 不可用时退回 tasklist，避免
  // “检测到仍在运行但没有 PID”导致无条件等待后上报无法退出。
  const pids = new Set(initial.map((p) => String(Number(p.ProcessId))).filter((pid) => pid !== '0'));
  if (!pids.size) for (const pid of tasklistProcessIds(targetNames)) pids.add(pid);
  for (const pid of pids) {
    await killForExit(['/T', '/PID', pid], '优雅结束进程树');
  }
  if (await waitForWorkBuddyExit(2500, binary)) {
    log(`[exit] 已确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
    return true;
  }

  // 单实例宿主可能在第一次 taskkill 后重新生成辅助进程；刷新 PID 集合再强杀两轮。
  for (let round = 1; round <= 2; round++) {
    const current = new Set(workBuddyProcesses(binary).map((p) => String(Number(p.ProcessId))).filter((pid) => pid !== '0'));
    if (!current.size) for (const pid of tasklistProcessIds(targetNames)) current.add(pid);
    log(`[exit] 强制结束第 ${round} 轮 snapshot=${JSON.stringify(exitSnapshot(binary))}`);
    for (const pid of current) await killForExit(['/F', '/T', '/PID', pid], `强制结束第${round}轮`);
    if (await waitForWorkBuddyExit(2500, binary)) {
      log(`[exit] 强制结束后已确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
      return true;
    }
  }

  // CIM 无法返回 PID 时按 PR#8 的两个精确镜像名兜底；最终结果仍必须经过检测确认。
  for (const name of targetNames) await killForExit(['/F', '/T', '/IM', name], '镜像名兜底');
  if (await waitForWorkBuddyExit(5000, binary)) {
    log(`[exit] 镜像名兜底后已确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
    return true;
  }
  // 进程路径/CIM 信息缺失时，普通 taskkill 可能因旧 WorkBuddy 以管理员权限运行而失败。
  // 最后只对已确认属于目标镜像的剩余 PID 请求一次 UAC，避免按名称误杀其他客户端。
  const beforeElevated = exitSnapshot(binary);
  const remainingPids = new Set([
    ...beforeElevated.tasklistPids,
    ...beforeElevated.processes.map((p) => p.pid).filter(Boolean),
  ]);
  if (remainingPids.size) {
    const elevated = runElevatedTaskkillPids(Array.from(remainingPids));
    log(`[exit] 提权 PID 兜底 taskkill=${Array.from(remainingPids).join(',')} code=${elevated.code == null ? 'null' : elevated.code}${elevated.error ? ' error=' + elevated.error : ''}`);
    if (await waitForWorkBuddyExit(10000, binary)) {
      log(`[exit] 提权 PID 兜底后已确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
      return true;
    }
  }
  const final = exitSnapshot(binary);
  log(`[exit] 无法确认退出 profile=${PROFILE.id} final=${JSON.stringify(final)}`);
  const names = final.processes.map((p) => p.name).filter(Boolean).join(',') || 'unknown';
  const pidsLeft = final.processes.map((p) => p.pid).filter(Boolean).join(',') || final.tasklistPids.join(',') || 'unknown';
  throw new Error(`${PROFILE.name} 无法确认已退出（剩余镜像=${names}; PID=${pidsLeft}）`);
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
  let retryOnNextPort = false;
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
    if (!retryOnNextPort && Date.now() - launchStartedAt >= 5000 && diagnostics.length === 0 &&
        await isLocalPortAvailable(CDP_PORT)) {
      const nextPort = await findNextAvailableCdpPort(CDP_PORT);
      if (nextPort) {
        retryOnNextPort = true;
        CDP_PORT = nextPort;
        writeCdpPortFile(nextPort);
        log('当前 CDP 端口未成功监听，改用备用端口重试: ' + nextPort);
        start();
        continue;
      }
    }
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

async function findNextAvailableCdpPort(exclude) {
  for (const port of cdpPortCandidates()) {
    if (port === exclude) continue;
    if (await isWorkBuddyCdpAt(port)) return port;
    if (await isLocalPortAvailable(port)) return port;
  }
  return 0;
}

async function injectNow() {
  // daemon 的 /api/inject 是 POST
  const response = await httpPost(UI_PORT, '/api/inject');
  if (!response) throw new Error('注入请求无响应');
  let payload = null;
  try { payload = JSON.parse(response.body || '{}'); } catch (_) {}
  if (response.status !== 200 || !payload || payload.ok !== true || payload.mounted !== true) {
    const detail = payload && payload.error ? ': ' + payload.error : ` (HTTP ${response.status})`;
    throw new Error('WorkDaddy 组件注入失败' + detail);
  }
  return payload;
}

// ---------- main ----------
if (require.main === module) (async () => {
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
    console.log(WBS_BRAND + '：WorkBuddy 已在调试模式，组件已注入 ✓');
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
    console.log(WBS_BRAND + '：WorkBuddy 已启动（调试模式），组件已注入 ✓');
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
  console.error(WBS_BRAND + ' 启动异常: ' + (e && e.message || e));
  captureException(e, { stage: 'windows-launcher-uncaught' }).catch(() => {}).finally(() => process.exit(4));
});

module.exports = {
  getWorkBuddyProcesses,
  getWorkBuddyProcessesViaCim,
  getWorkBuddyProcessesViaTasklist,
  parseTasklistOutput,
  workBuddyProcesses,
  tasklistProcessIds,
  targetProcessNames,
  workBuddyRunning,
  isElevated,
};
