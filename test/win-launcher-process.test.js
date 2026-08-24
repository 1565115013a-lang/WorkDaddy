'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const launcher = require('../scripts/win-launcher.js');

test('requiring the Windows launcher does not execute its startup flow', () => {
  assert.equal(typeof launcher.getWorkBuddyProcesses, 'function');
  assert.equal(typeof launcher.getWorkBuddyProcessesViaCim, 'function');
  assert.equal(typeof launcher.getWorkBuddyProcessesViaTasklist, 'function');
});

test('tasklist CSV fallback parses process names and PIDs', () => {
  const rows = launcher.parseTasklistOutput(
    '"WorkBuddy.exe","10436","Console","1","123,456 K"\n' +
    'INFO: No tasks are running which match the specified criteria.\n'
  );
  assert.deepEqual(rows, [{
    ProcessId: 10436,
    ParentProcessId: null,
    Name: 'WorkBuddy.exe',
    ExecutablePath: null,
    CommandLine: '',
    processSource: 'tasklist',
  }]);
});

test('tasklist fallback returns a safe array when the command is unavailable', () => {
  assert.doesNotThrow(() => launcher.getWorkBuddyProcessesViaTasklist());
  assert.ok(Array.isArray(launcher.getWorkBuddyProcessesViaTasklist()));
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
  assert.ok(launcher.targetProcessNames() instanceof Set);
  assert.equal(typeof launcher.workBuddyRunning(), 'boolean');
});
