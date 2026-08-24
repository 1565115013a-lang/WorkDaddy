'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const reporter = path.join(repoRoot, 'scripts', 'sentry-report.js');
const { telemetryEnabled } = require(reporter);
const daemonSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'daemon.js'), 'utf8');
const injectSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'inject.js'), 'utf8');

function dryRun(profile) {
  const result = childProcess.spawnSync(process.execPath, [reporter, '--dry-run', '--stage', 'test', '--message', 'profile test'], {
    cwd: repoRoot,
    env: { ...process.env, WBSWITCH_PROFILE: profile, WORKDADDY_TELEMETRY: '0' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Sentry events identify WorkBuddy CN and WorkBuddy AI without account data', () => {
  const cn = dryRun('workbuddy-cn');
  assert.equal(cn.tags.client, 'workbuddy');
  assert.equal(cn.tags.client_name, 'WorkBuddy');
  assert.equal(cn.tags.workbuddy_variant, 'workbuddy');
  assert.deepEqual(cn.contexts.client, { name: 'WorkBuddy', profile: 'workbuddy-cn', variant: 'workbuddy' });

  const ai = dryRun('workbuddy-ai');
  assert.equal(ai.tags.client, 'workbuddy-ai');
  assert.equal(ai.tags.client_name, 'WorkBuddy AI');
  assert.equal(ai.tags.workbuddy_variant, 'workbuddy-ai');
  assert.deepEqual(ai.contexts.client, { name: 'WorkBuddy AI', profile: 'workbuddy-ai', variant: 'workbuddy-ai' });
  assert.doesNotMatch(JSON.stringify(ai), /accessToken|refreshToken|cookie|password/i);
});

test('diagnostic telemetry is opt-in', () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ WORKDADDY_TELEMETRY: '0' }), false);
  assert.equal(telemetryEnabled({ WORKDADDY_TELEMETRY: 'true' }), false);
  assert.equal(telemetryEnabled({ WORKDADDY_TELEMETRY: '1' }), true);
});

test('disabled telemetry returns before sending or draining the outbox', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-telemetry-'));
  const outbox = path.join(dataDir, 'telemetry', 'outbox');
  const queued = path.join(outbox, 'queued.json');
  try {
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(queued, '{}');
    const script = `require(${JSON.stringify(reporter)}).captureMessage('disabled test').then((result) => process.stdout.write(JSON.stringify(result)))`;
    const result = childProcess.spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: { ...process.env, WBSWITCH_DATA_DIR: dataDir, WORKDADDY_TELEMETRY: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { disabled: true });
    assert.equal(fs.existsSync(queued), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('production daemon does not persist composer contents through a debug route', () => {
  assert.doesNotMatch(daemonSource, /\/api\/save-composer/);
  assert.doesNotMatch(daemonSource, /composer-captures|composer-debug\.json/);
});

test('renderer diagnostics are local opt-in, redacted, and token authenticated', () => {
  assert.match(daemonSource, /const DIAGNOSTIC_LOGS_ENABLED = process\.env\.WORKDADDY_DIAGNOSTIC_LOGS === '1'/);
  assert.equal((daemonSource.match(/if \(!DIAGNOSTIC_LOGS_ENABLED\) break;/g) || []).length, 2);
  assert.doesNotMatch(daemonSource, /!origin[^\n]+\/api\/breadcrumb/);
  assert.match(daemonSource, /\[breadcrumb\][^\n]+redactDiagnosticText/);
  assert.match(daemonSource, /if \(!shouldPersistBreadcrumb\(body\)\) return json/);
  assert.match(daemonSource, /replace\(\/__WBS_DIAGNOSTIC_LOGS__\/g, DIAGNOSTIC_LOGS_ENABLED \? 'true' : 'false'\)/);
  assert.match(daemonSource, /注入脚本页面抛错[^\n]+redactDiagnosticText\(desc, 500\)/);

  const errorHookStart = injectSource.indexOf('function wbsReportErr');
  const errorHookEnd = injectSource.indexOf("window.addEventListener('error'", errorHookStart);
  assert.ok(errorHookStart >= 0 && errorHookEnd > errorHookStart);
  const errorHook = injectSource.slice(errorHookStart, errorHookEnd);
  assert.match(injectSource, /var WBS_DIAGNOSTIC_LOGS = __WBS_DIAGNOSTIC_LOGS__/);
  assert.match(errorHook, /if \(WBS_DIAGNOSTIC_LOGS\) \{[\s\S]+\/api\/breadcrumb/);
  assert.equal((errorHook.match(/\/api\/breadcrumb/g) || []).length, 1);

  const start = daemonSource.indexOf('function redactDiagnosticText');
  const end = daemonSource.indexOf('function validCdpPort', start);
  assert.ok(start >= 0 && end > start);
  const getDiagnosticHelpers = new Function(`${daemonSource.slice(start, end)}; return { redactDiagnosticText, shouldPersistBreadcrumb };`);
  const helpers = getDiagnosticHelpers();
  const redacted = helpers.redactDiagnosticText('authorization: Basic dXNlcjpwYXNz password="two words" secret=plain apiKey="sk-test" cookie: sid=private eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123', 300);
  assert.doesNotMatch(redacted, /dXNlcjpwYXNz|two words|plain|sk-test|sid=private|eyJhbGci/);
  assert.match(redacted, /redacted/i);
  const jwtRedacted = helpers.redactDiagnosticText('failure eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123', 200);
  assert.doesNotMatch(jwtRedacted, /eyJhbGci|signature123/);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'crash:error:private', extra: { stack: 'private' } }, false), false);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'operational', extra: { stack: 'private' } }, false), false);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'enqueue:done' }, false), true);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'crash:error:private' }, true), true);
  assert.doesNotMatch(injectSource, /crumb\([^\n]+\+\s*sessionId/);
});

test('privacy documentation distinguishes local data from required remote services', () => {
  const readme = require('node:fs').readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /零远程通信/);
  assert.match(readme, /WORKDADDY_TELEMETRY=1/);
  assert.match(readme, /WORKDADDY_DIAGNOSTIC_LOGS=1/);
  assert.match(readme, /GitHub Releases/);
  assert.match(readme, /WorkBuddy 官方 API/);
  assert.doesNotMatch(readme, /内置导入密钥/);
  assert.match(readme, /每次导出随机 salt/);
  assert.match(readme, /模型连通测试/);
  assert.match(readme, /对应 API Key/);
});

test('packaged repair instructions require consent before telemetry', () => {
  const prompts = [
    fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, '安装失败自主解决提示词.txt'), 'utf8'),
  ];
  for (const instructions of prompts) {
    assert.doesNotMatch(instructions, /五、自动上报/);
    assert.match(instructions, /必须.*用户.*明确同意/);
    assert.match(instructions, /不要替用户设置遥测环境变量/);
    assert.match(instructions, /disabled=true 表示遥测未启用、没有发送/);
  }
});
