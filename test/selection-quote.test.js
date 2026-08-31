'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('selection quote is a local session setting enabled by default and ordered after message navigation', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const navigationSwitch = inject.indexOf('id="wbs-sess-message-nav"');
  const quoteSwitch = inject.indexOf('id="wbs-sess-selection-quote"');
  const phraseSwitch = inject.indexOf('id="wbs-sess-phrase"');

  assert.ok(navigationSwitch >= 0 && quoteSwitch > navigationSwitch && phraseSwitch > quoteSwitch);
  assert.match(inject, /workdaddy\.session\.selectionQuoteEnabled/);
  assert.match(inject, /<span class="wbs-nd-title">引用消息文本<\/span>/);
  assert.doesNotMatch(inject, /<span class="wbs-nd-title">选中文字引用<\/span>/);
  assert.match(inject, /localStorage\.getItem\(SELECTION_QUOTE_ENABLED_KEY\) !== '0'/);
  assert.match(inject, /localStorage\.setItem\(SELECTION_QUOTE_ENABLED_KEY, enabled \? '1' : '0'\)/);
});

test('selection quote uses the official content-block insertion request and avoids direct Slate DOM edits', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /requestInsertContentBlocks/);
  assert.match(inject, /contentBlocks: \[selectionQuoteBlock\(pending\.text\)\]/);
  assert.match(inject, /type: 'resource_link'/);
  assert.match(inject, /name: '引用文本'/);
  assert.match(inject, /displayText: '引用文本'/);
  assert.match(inject, /selectionQuote: true/);
  assert.match(inject, /selection:\/\/document-selection/);
  assert.match(inject, /selectionQuoteButton\.textContent = '引用文本'/);
  assert.doesNotMatch(inject, /selectionQuoteButton\.title/);
  assert.match(inject, /sq-tooltip-wrapper \.sq-popover__locate-btn[^']*display:none!important/);
  assert.match(inject, /sq-tooltip-wrapper \.sq-popover[^']*max-height:min\(48vh,240px\)/);
  assert.doesNotMatch(inject, /function syncSelectionQuoteIcons\(\)/);
  assert.doesNotMatch(inject, /container\.innerHTML = SELECTION_QUOTE_MESSAGE_ICON/);
  assert.match(inject, /InputContextTag/);
  assert.match(inject, /slate-selection-quote-sceneTag\._hasCloseIcon:hover[^']*visibility:hidden!important/);
  assert.match(inject, /wbs-selection-quote-btn\{position:fixed;z-index:1000;/);
  assert.doesNotMatch(inject, /wbs-selection-quote-btn\{position:fixed;z-index:2147483647;/);
  assert.match(inject, /background:color-mix\(in srgb,var\(--wb-bg-hover/);
  assert.doesNotMatch(inject, /wbs-selection-quote-btn:hover[^']*border-color:var\(--wb-accent-blue/);
  assert.match(inject, /backdrop-filter:blur\(12px\) saturate\(1\.2\)/);
  assert.match(inject, /html\.cb-dark \.wbs-selection-quote-btn/);
});
