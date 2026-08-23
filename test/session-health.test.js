const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { classifySessionHealth } = require('../scripts/inject.js');

test('session health keeps selectors for the current WorkBuddy message and error DOM', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(source, /_assistantMessage_/);
  assert.match(source, /_errorBanner_/);
  assert.match(source, /_retryBtn_/);
  assert.match(source, /setBuildInterval\(scanSessionHealth, 1000\)/);
});

test('session health treats a visible decision prompt as blocked', () => {
  assert.deepEqual(
    classifySessionHealth({ observed: true, blocked: true, busy: true }),
    { status: 'blocked', confidence: 'high', reason: 'decision-prompt' },
  );
});

test('session health treats provider errors as errors even after the UI stops streaming', () => {
  assert.deepEqual(
    classifySessionHealth({ observed: true, error: true, idleForMs: 20000, assistantTextLength: 120 }),
    { status: 'error', confidence: 'high', reason: 'error-ui' },
  );
});

test('session health recognises a normal assistant response with completion actions', () => {
  assert.deepEqual(
    classifySessionHealth({ observed: true, hasAssistant: true, hasCompletionActions: true, assistantTextLength: 240, idleForMs: 5000 }),
    { status: 'completed', confidence: 'medium', reason: 'assistant-actions' },
  );
});

test('session health does not reuse old assistant actions after an empty generation', () => {
  assert.deepEqual(
    classifySessionHealth({
      observed: true,
      assistantChanged: false,
      hasAssistant: true,
      hasCompletionActions: true,
      assistantTextLength: 240,
      idleForMs: 9000,
    }),
    { status: 'suspected', confidence: 'low', reason: 'idle-without-completion' },
  );
});

test('session health gives an explicit completion marker highest confidence', () => {
  assert.deepEqual(
    classifySessionHealth({ observed: true, completionMarker: true, idleForMs: 3000 }),
    { status: 'completed', confidence: 'high', reason: 'completion-marker' },
  );
});

test('session health does not call a user stop abnormal', () => {
  assert.deepEqual(
    classifySessionHealth({ observed: true, manualStop: true, idleForMs: 10000 }),
    { status: 'stopped', confidence: 'high', reason: 'manual-stop' },
  );
});

test('session health flags an empty provider response for review', () => {
  assert.deepEqual(
    classifySessionHealth({ observed: true, hasAssistant: false, idleForMs: 9000 }),
    { status: 'suspected', confidence: 'medium', reason: 'empty-assistant' },
  );
});

test('session health flags a long response that ends without completion evidence', () => {
  assert.deepEqual(
    classifySessionHealth({ observed: true, hasAssistant: true, assistantTextLength: 2000, looksTruncated: true, idleForMs: 9000 }),
    { status: 'suspected', confidence: 'low', reason: 'truncated-assistant' },
  );
});
