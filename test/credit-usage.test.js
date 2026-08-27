'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { updateDailyBaseline, pruneBaselines } = require('../scripts/credit-usage.js');

test('first observation of the day establishes the baseline and reports 0 used', () => {
  const cache = {};
  const r = updateDailyBaseline(cache, 'u1', '2026-08-27', 500);
  assert.equal(r.todayUsed, 0);
  assert.deepEqual(r.cache.u1, { date: '2026-08-27', base: 500 });
});

test('same-day lower balance reports the difference as today-used', () => {
  const cache = { u1: { date: '2026-08-27', base: 500 } };
  const r = updateDailyBaseline(cache, 'u1', '2026-08-27', 320);
  assert.equal(r.todayUsed, 180);
  // 基线不变
  assert.deepEqual(r.cache.u1, { date: '2026-08-27', base: 500 });
});

test('cross-day resets the baseline and reports 0 used', () => {
  const cache = { u1: { date: '2026-08-26', base: 10 } };
  const r = updateDailyBaseline(cache, 'u1', '2026-08-27', 400);
  assert.equal(r.todayUsed, 0);
  assert.deepEqual(r.cache.u1, { date: '2026-08-27', base: 400 });
});

test('same-day balance increase (top-up/check-in) raises baseline, never negative used', () => {
  // 今天先用掉一部分，再签到增多 → 已用归零且基线抬高
  let cache = { u1: { date: '2026-08-27', base: 500 } };
  cache = updateDailyBaseline(cache, 'u1', '2026-08-27', 400).cache;
  const r = updateDailyBaseline(cache, 'u1', '2026-08-27', 600);
  assert.equal(r.todayUsed, 0);
  assert.deepEqual(r.cache.u1, { date: '2026-08-27', base: 600 });
});

test('returns null when credits is null/undefined/non-finite and does not touch cache', () => {
  const cache = {};
  for (const bad of [null, undefined, NaN, 'abc']) {
    const r = updateDailyBaseline(cache, 'u1', '2026-08-27', bad);
    assert.equal(r.todayUsed, null);
    assert.deepEqual(r.cache, {});
  }
});

test('rounds today-used to two decimals and clamps at zero', () => {
  const cache = { u1: { date: '2026-08-27', base: 100 } };
  const r = updateDailyBaseline(cache, 'u1', '2026-08-27', 99.999);
  assert.equal(r.todayUsed, 0); // 差 0.001 → 四舍五入到 0
});

test('prunes stale baselines older than the retention window', () => {
  // 保留近 7 天：cutoff = 2026-08-27 − 7 = 2026-08-20，因此 08-20 及之后保留，08-20 之前删除
  const cache = {
    u1: { date: '2026-08-01', base: 1 },
    u2: { date: '2026-08-27', base: 2 },
    u3: { date: '2026-08-20', base: 3 },
  };
  const r = pruneBaselines(cache, '2026-08-27', 7);
  assert.equal(r.changed, true);
  assert.deepEqual(Object.keys(r.cache).sort(), ['u2', 'u3']);
});

test('prune reports no change when nothing is stale', () => {
  const cache = { u1: { date: '2026-08-27', base: 5 } };
  const r = pruneBaselines(cache, '2026-08-27', 30);
  assert.equal(r.changed, false);
  assert.deepEqual(Object.keys(r.cache), ['u1']);
});

test('daemon wires today-used into the /api/credits response', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /updateDailyBaseline/);
  assert.match(daemon, /todayUsedFor\(uid, r\.credits\)/);
  assert.match(daemon, /todayUsed,/);
  assert.match(daemon, /credit-daily-baseline\.json/);
});

test('renderer consumes todayUsed/totalDosage from /api/credits', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /state\.accounts\[i\]\.todayUsed = todayUsed/);
  assert.match(inject, /state\.accounts\[i\]\.used = used/);
  assert.match(inject, /creditUsageHtml\(account\)/);
  assert.match(inject, /今日已用/);
  assert.match(inject, /\.wbs-credit-usage/);
});
