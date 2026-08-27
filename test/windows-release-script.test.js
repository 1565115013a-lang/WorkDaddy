'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'scripts', 'build-win-release.ps1');
const launcherPath = path.join(__dirname, '..', 'scripts', 'build-win-release.cmd');
const source = fs.readFileSync(scriptPath, 'utf8');
const launcher = fs.readFileSync(launcherPath, 'utf8');

test('Windows release script interactively builds both profiles for one version', () => {
  assert.match(source, /Read-Host\s+"[^"]*版本号/);
  assert.match(source, /\$Version -notmatch '\^\\d\+\\\.\\d\+\\\.\\d\+\$'/);
  assert.match(source, /foreach \(\$profile in @\('workbuddy-cn', 'workbuddy-ai'\)\)/);
  assert.match(source, /build-win-zip\.sh/);
  assert.match(source, /build-win-installer\.ps1/);
  assert.match(source, /WORKDADDY_BUILD_PROFILE/);
  assert.match(source, /-Version \$ReleaseVersion/);
  assert.match(launcher, /build-win-release\.ps1/);
  assert.match(launcher, /ExecutionPolicy Bypass/);
});
