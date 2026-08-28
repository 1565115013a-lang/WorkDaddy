'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replaceFileWithRetry } = require('../scripts/atomic-file-write.js');

test('atomic replacement retries transient Windows temp writes and destination renames', () => {
  let writes = 0;
  let renames = 0;
  const sleeps = [];
  const files = new Set();
  const fakeFs = {
    writeFileSync(file) {
      writes++;
      if (writes < 3) throw Object.assign(new Error('temporary filesystem failure'), { code: 'UNKNOWN' });
      files.add(file);
    },
    chmodSync() {},
    renameSync(source, destination) {
      renames++;
      if (renames === 1) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      assert.equal(files.has(source), true);
      files.delete(source);
      files.add(destination);
    },
    unlinkSync(file) { files.delete(file); },
  };

  replaceFileWithRetry('C:\\Users\\me\\.workbuddy\\settings.json', '{}\n', undefined, {
    fs: fakeFs,
    platform: 'win32',
    sleep: (ms) => sleeps.push(ms),
    suffix: () => 'fixed',
  });

  assert.equal(writes, 3);
  assert.equal(renames, 2);
  assert.equal(files.has('C:\\Users\\me\\.workbuddy\\settings.json'), true);
  assert.equal([...files].some((file) => file.includes('.wbs-tmp-')), false);
  assert.equal(sleeps.length, 3);
});

test('atomic replacement does not retry non-transient write failures', () => {
  let writes = 0;
  const fakeFs = {
    writeFileSync() { writes++; throw Object.assign(new Error('parent missing'), { code: 'ENOENT' }); },
    chmodSync() {},
    renameSync() {},
    unlinkSync() {},
  };
  assert.throws(() => replaceFileWithRetry('C:\\missing\\settings.json', '{}', undefined, {
    fs: fakeFs, platform: 'win32', sleep: () => {}, suffix: () => 'fixed',
  }), /parent missing/);
  assert.equal(writes, 1);
});
