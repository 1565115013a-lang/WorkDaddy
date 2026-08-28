'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { profileUiPortCandidates, selectPersistedUiPort } = require('../scripts/ui-port.js');

test('UI fallback ports stay disjoint across profiles and avoid the Windows dynamic range', () => {
  const profiles = ['workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl'];
  const lists = profiles.map((profile) => profileUiPortCandidates(profile));
  for (let i = 0; i < lists.length; i++) {
    assert.equal(new Set(lists[i]).size, lists[i].length);
    assert.equal(lists[i].slice(1).every((port) => port < 46000), true);
    for (let j = i + 1; j < lists.length; j++) {
      assert.deepEqual(lists[i].filter((port) => lists[j].includes(port)), []);
    }
  }
});

test('only a current-profile UI port can be restored from persistent state', () => {
  assert.equal(selectPersistedUiPort('workbuddy-cn', { profileId: 'workbuddy-cn', port: 17832 }), 17832);
  assert.equal(selectPersistedUiPort('workbuddy-cn', { profileId: 'workbuddy-ai', port: 17833 }), null);
  assert.equal(selectPersistedUiPort('workbuddy-cn', { profileId: 'workbuddy-cn', port: 17833 }), null);
});
