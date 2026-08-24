'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const launcher = require('../scripts/win-launcher.js');

test('requiring the Windows launcher does not execute its startup flow', () => {
  assert.equal(typeof launcher.getWorkBuddyProcesses, 'function');
  assert.equal(typeof launcher.workBuddyProcesses, 'function');
  assert.equal(typeof launcher.tasklistProcessIds, 'function');
  assert.equal(typeof launcher.workBuddyRunning, 'function');
});

test('tasklist data remains diagnostic-only', () => {
  const ids = launcher.tasklistProcessIds();
  assert.ok(ids instanceof Set);
  assert.equal(launcher.getWorkBuddyProcessesViaTasklist, undefined);
});

test('process discovery always returns an array of positive-PID records', () => {
  const rows = launcher.getWorkBuddyProcesses();
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.ok(Number(row.ProcessId) > 0);
    assert.match(String(row.Name), /\.exe$/i);
  }
});

test('process helpers preserve safe return types without a running client', () => {
  assert.ok(Array.isArray(launcher.workBuddyProcesses()));
  assert.equal(typeof launcher.workBuddyRunning(), 'boolean');
});
