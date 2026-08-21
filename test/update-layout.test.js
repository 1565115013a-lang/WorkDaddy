const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8');

test('Windows updater launches the installed scripts launcher', () => {
  const script = read('apply-update.ps1');
  assert.match(script, /Join-Path\s+\(Join-Path\s+\$AppDir\s+'scripts'\)\s+'launcher\.cmd'/);
  assert.match(script, /Join-Path\s+\(Join-Path\s+\$AppDir\s+'scripts'\)\s+'launcher-hidden\.vbs'/);
});

test('Windows updater stops the watchdog before waiting for the API port', () => {
  const script = read('apply-update.ps1');
  const stop = script.indexOf('taskkill /F /T /PID $wpid');
  const wait = script.indexOf('$waitSec = 0');
  assert.notEqual(stop, -1);
  assert.notEqual(wait, -1);
  assert.ok(stop < wait, 'watchdog shutdown must precede the port wait');
});

test('Windows install and update release a locked launcher before replacing it', () => {
  const install = read('install-win.ps1');
  const update = read('apply-update.ps1');
  assert.match(install, /FileShare\]\s*::None/);
  assert.match(install, /launcher\.cmd/);
  assert.match(install, /Get-CimInstance\s+Win32_Process/);
  assert.match(install, /taskkill \/F \/T \/PID/);
  assert.ok(install.indexOf('Release-LockedLauncher') < install.indexOf('robocopy $SrcDir $targetScripts'), 'install must release launcher before robocopy');
  assert.match(update, /FileShare\]\s*::None/);
  assert.match(update, /launcher\.cmd/);
  assert.match(update, /Get-CimInstance\s+Win32_Process/);
  assert.ok(update.indexOf('Release-LockedLauncher') < update.indexOf('Move-Item -Force $AppDir $oldDir'), 'update must release launcher before moving the old app');
});

test('macOS updater stops the daemon before waiting for the API port', () => {
  const script = read('apply-update.sh');
  const stop = script.indexOf('pkill -f');
  const wait = script.indexOf('for i in $(seq 1 30)');
  assert.notEqual(stop, -1);
  assert.notEqual(wait, -1);
  assert.ok(stop < wait, 'daemon shutdown must precede the port wait');
});

test('account switching refreshes WorkBuddy after replacing auth without restarting it', () => {
  const script = read('daemon.js');
  const lib = read('lib.js');
  const routeStart = script.indexOf("if (req.method === 'POST' && p === '/api/switch')");
  assert.notEqual(routeStart, -1);
  const route = script.slice(routeStart, routeStart + 2600);
  const copy = route.indexOf('switchTo(DATA_DIR, uid, log)');
  assert.notEqual(copy, -1);
  assert.match(route, /await reloadWorkBuddyPage\(\)/);
  assert.doesNotMatch(route, /await quitWorkBuddy\(\)/);
  assert.doesNotMatch(route, /await relaunchWorkBuddy\(\)/);
  assert.match(lib, /function retireLogoutMarker/);
  assert.match(lib, /retireLogoutMarker\(log\);/);
});

test('account switching retires WorkBuddy logout marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auth-'));
  const authFile = path.join(dir, 'workbuddy-desktop.info');
  const marker = `${authFile}.logged-out`;
  fs.writeFileSync(authFile, '{}');
  fs.writeFileSync(marker, 'logged out');
  try {
    const result = childProcess.spawnSync(
      process.execPath,
      ['-e', "require(process.argv[1]).retireLogoutMarker()", path.join(repoRoot, 'scripts', 'lib.js')],
      { env: { ...process.env, WBSWITCH_AUTH_FILE: authFile }, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seamless login refreshes the running WorkBuddy session', () => {
  const script = read('inject.js');
  const start = script.indexOf('function startSeamlessLogin');
  const end = script.indexOf('\n    // ===== 主题系统', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const seamless = script.slice(start, end);
  assert.match(seamless, /扫码确认后会自动切换到新账号\.\.\./);
  assert.match(seamless, /api\('\/api\/switch'/);
  assert.match(seamless, /reload: true/);
  assert.doesNotMatch(seamless, /没弹出来\?|点此打开授权页/);
});

test('CDP startup supports a persisted fallback port instead of hardcoding 9222', () => {
  const daemon = read('daemon.js');
  const macLauncher = fs.readFileSync(path.join(repoRoot, 'WorkDaddy.app', 'Contents', 'MacOS', 'launcher'), 'utf8');
  const winLauncher = read('win-launcher.js');
  assert.match(daemon, /cdp-port\.json/);
  assert.match(daemon, /findAvailableCdpPort/);
  assert.match(daemon, /const upstreamPort = cdp\.port/);
  assert.match(daemon, /127\.0\.0\.1:' \+ upstreamPort \+ '\/devtools\/page\//);
  assert.doesNotMatch(daemon, /new WebSocketCtor\('ws:\/\/127\.0\.0\.1:9222\/devtools\/page\//);
  assert.match(macLauncher, /cdp-port\.json/);
  assert.match(macLauncher, /--remote-debugging-port=\"\$PORT\"/);
  assert.match(winLauncher, /cdp-port\.json/);
  assert.match(winLauncher, /--remote-debugging-port=' \+ CDP_PORT/);
});

test('Windows launcher tolerates slow WorkBuddy startup beyond the old 20 second limit', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /CDP_STARTUP_TIMEOUT_MS\s*=\s*60000/);
  assert.match(launcher, /elapsedMs\s*<\s*CDP_STARTUP_TIMEOUT_MS/);
});

test('Windows launcher discovers portable WorkBuddy installations', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /App Paths/);
  assert.match(launcher, /Software[\\/].*workbuddy/i);
  assert.match(launcher, /WBSWITCH_WORKBUDDY_BIN/);
});

test('Windows relaunch restores the WorkBuddy window after starting it', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /restoreWorkBuddyWindow/);
  assert.match(daemon, /await restoreWorkBuddyWindow/);
});

test('account cards keep the compact three-row layout', () => {
  const script = read('inject.js');
  assert.match(script, /wbs-name-group/);
  assert.match(script, /wbs-secondary-row/);
  assert.match(script, /剩余积分/);
  assert.match(script, /今日已签到/);
  assert.match(script, /登录过期于/);
  assert.match(script, /wbs-credit-hidden/);
  assert.match(script, /var expired = isIdentityExpired\(a\)/);
  assert.match(script, /expired \? '' : '<button class="wbs-icon-btn wbs-acc-switch"/);
  assert.match(script, /switchBtn\.style\.display = hidden \? 'none' : ''/);
  assert.match(script, /height:5px;min-height:5px/);
  assert.match(script, /\.wbs-credit-segment:first-child\{border-radius:3px 0 0 3px\}/);
  assert.match(script, /\.wbs-credit-segment:last-child\{border-radius:0 3px 3px 0\}/);
  assert.match(script, /cursor:default/);
  assert.doesNotMatch(script, /data-tip="' \+ attrTip \+ '" title=/);
  assert.match(script, /diff <= day/);
  assert.match(script, /diff <= 3 \* day/);
  assert.match(script, /diff <= 7 \* day/);
  assert.match(script, /diff <= 15 \* day/);
  assert.match(script, /30 \* day/);
  assert.match(script, /\.wbs-credit-segment\.safe\{background:rgba\(34,197,94,\.78\)/);
  assert.match(script, /\.wbs-credit-segment\.within30\{background:rgba\(34,197,94,\.62\)/);
  assert.match(script, /\.wbs-credit-segment\.within15\{background:rgba\(34,197,94,\.46\)/);
  assert.match(script, /\.wbs-credit-segment\.within7\{background:rgba\(34,197,94,\.32\)/);
  assert.match(script, /\.wbs-credit-segment\.within3\{background:rgba\(34,197,94,\.20\)/);
  assert.match(script, /\.wbs-credit-segment\.within1\{background:rgba\(34,197,94,\.10\)/);
  assert.match(script, /html\.cb-dark \.wbs-credit-segment\.safe\{background:rgba\(126,134,255,\.82\)/);
  assert.match(script, /html\.cb-dark \.wbs-credit-segment\.within1\{background:rgba\(126,134,255,\.12\)/);
  assert.match(script, /\.wbs-checkin-tag\.ok\{background:#edf9ef/);
  assert.match(script, /html\.cb-dark \.wbs-checkin-tag\.ok\{/);
  assert.match(script, /今日已签到✓/);
  assert.doesNotMatch(script, /wbs-token-expired/);
  assert.doesNotMatch(script, /按到期时间排序/);
  assert.doesNotMatch(script, /个额度/);
  assert.doesNotMatch(script, /wbs-checkin-cell/);
});

test('robot button decorations remain visible alongside the eye states', () => {
  const script = read('inject.js');
  assert.match(script, /wbs-fab-antenna/);
  assert.match(script, /wbs-fab-ear wbs-fab-ear-left/);
  assert.match(script, /wbs-fab-ear wbs-fab-ear-right/);
  assert.match(script, /\.wbs-fab-ear\{[^}]*width:20px;height:30px[^}]*background:#141416/);
  assert.match(script, /\.wbs-fab-ear::before\{[^}]*width:12px;height:22px[^}]*background:#141416/);
  assert.doesNotMatch(script, /\.wbs-fab-ear::before\{[^}]*background:#fff/);
  assert.match(script, /\.wbs-fab-ear::after\{[^}]*width:4px;height:10px[^}]*background:#141416/);
  assert.match(script, /wbs-fab-ear-left\{left:-11px;transform:[^}]*rotate\(-8deg\)/);
  assert.match(script, /wbs-fab-ear-right\{right:-11px;transform:[^}]*rotate\(8deg\)/);
  assert.match(script, /\.wbs-fab \.click > span:not\(\.wbs-fab-antenna\):not\(\.wbs-fab-ear\)\{display:none\}/);
  assert.doesNotMatch(script, /\.wbs-fab \.click span\{display:none\}/);
  assert.match(script, /\.wbs-fab \.click \.button \.speak~\.speak\{display:none\}/);
});

test('home composer keeps the robot button at the WorkBuddy bottom-right', () => {
  const script = read('inject.js');
  assert.match(script, /\.wb-home-page \[class\*="_topRightSlotStandalone_"\] > div:nth-child\(1\) > div:nth-child\(3\)/);
  assert.match(script, /fab\.style\.right = '22px';\s*fab\.style\.bottom = '22px';/);
});

test('zero credits omit the empty-state label', () => {
  const script = read('inject.js');
  assert.match(script, /if \(!list\.length\) return Number\(credits\) === 0 \? '' : '<div class="wbs-credit-empty">暂无可用积分<\/div>'/);
});
