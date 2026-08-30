'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const compat = require('../scripts/workbuddy-compat.js');

function visibleElement(className) {
  return {
    className: className || '',
    children: [],
    getBoundingClientRect() { return { width: 120, height: 32, left: 20 }; },
  };
}

test('composer toolbar selection prefers the modern DOM and falls back to legacy DOM', () => {
  const modern = visibleElement('cr-input-toolbar__right');
  const legacy = visibleElement('_item_hash _gapLarge_hash');
  const modernDocument = {
    querySelector(selector) { return selector === 'div.cr-input-toolbar__right' ? modern : null; },
    querySelectorAll() { return [legacy]; },
  };
  assert.deepEqual(compat.findComposerToolbar(modernDocument), { kind: 'modern', element: modern });

  const legacyDocument = {
    querySelector() { return null; },
    querySelectorAll() { return [legacy]; },
  };
  assert.deepEqual(compat.findComposerToolbar(legacyDocument), { kind: 'legacy', element: legacy });
});

test('queue adapter selection prefers prototype-capable modern adapter and retains legacy fallback', () => {
  const modernAdapter = Object.create({
    enqueueConversationMessageQueueItem() {},
    pauseConversationMessageQueue() {},
  });
  const modernRoot = visibleElement();
  modernRoot.__reactFiber$test = { memoizedProps: { adapter: modernAdapter }, return: null };
  const modernDocument = {
    querySelector(selector) { return selector === '#root > div' ? modernRoot : null; },
  };
  assert.deepEqual(compat.findQueueAdapter(modernDocument), { kind: 'modern', adapter: modernAdapter });

  const legacyAdapter = {
    enqueueConversationMessageQueueItem() {},
    pauseConversationMessageQueue() {},
  };
  const legacyRoot = visibleElement();
  legacyRoot.__reactFiber$test = { memoizedProps: { value: legacyAdapter }, return: null };
  const legacyDocument = {
    querySelector(selector) { return selector === '.voice-mic-wrap' ? legacyRoot : null; },
  };
  assert.deepEqual(compat.findQueueAdapter(legacyDocument), { kind: 'legacy', adapter: legacyAdapter });
});

test('selected conversation lookup is capability based rather than profile based', () => {
  const selected = {
    className: 'conversation-item',
    firstElementChild: { className: '_card_hash _selected_hash' },
    getAttribute(name) { return name === 'data-conversation-id' ? 'conversation-modern' : null; },
  };
  const documentLike = {
    querySelectorAll(selector) {
      return selector === '.conversation-item[data-conversation-id]' ? [selected] : [];
    },
    querySelector() { return null; },
  };
  assert.equal(compat.getSelectedConversationId(documentLike), 'conversation-modern');
});

test('injected compatibility is packaged and AI theme access is no longer profile-gated', () => {
  const root = path.join(__dirname, '..');
  const daemon = fs.readFileSync(path.join(root, 'scripts', 'daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(root, 'scripts', 'inject.js'), 'utf8');
  const macBuild = fs.readFileSync(path.join(root, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  const winVerify = fs.readFileSync(path.join(root, 'scripts', 'verify-win.cmd'), 'utf8');

  assert.match(daemon, /workbuddy-compat\.js/);
  assert.match(macBuild, /workbuddy-compat\.js/);
  assert.match(winVerify, /workbuddy-compat\.js/);
  assert.match(inject, /WBS_COMPAT\.findComposerToolbar\(document\)/);
  assert.match(inject, /WBS_COMPAT\.findQueueAdapter\(document\)/);
  assert.match(inject, /if \(!CAPS\.theme\)/);
  assert.doesNotMatch(inject, /if \(!CAPS\.theme \|\| WBS_PROFILE_IS_AI\)/);
  assert.doesNotMatch(inject, /migrateWorkBuddyAiThemeOnce/);
});
