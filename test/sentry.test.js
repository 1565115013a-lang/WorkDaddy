'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const reporter = path.join(repoRoot, 'scripts', 'sentry-report.js');

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
