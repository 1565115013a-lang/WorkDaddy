'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  sumRequestCredits,
  formatLocalDateTime,
  startOfLocalDay,
  parseRowTime,
} = require('../scripts/credit-request-usage.js');

const dayStart = new Date(2026, 7, 27, 0, 0, 0, 0).getTime(); // 2026-08-27 00:00:00 本地
const dayEnd = new Date(2026, 7, 27, 23, 59, 59, 0).getTime();

test('sums credit of requests whose requestTime falls inside the window', () => {
  const rows = [
    { credit: 0.08, requestTime: '2026-08-27 17:54:00' },
    { credit: 6.37, requestTime: '2026-08-27 17:03:00' },
    { credit: 0, requestTime: '2026-08-27 19:39:00' }, // 0 积分不计
    { credit: 1.5, requestTime: '2026-08-27 23:59:59' },
    { credit: 99, requestTime: '2026-08-26 23:59:59' }, // 昨天，不计
    { credit: 88, requestTime: '2026-08-28 00:00:00' }, // 明天，不计
  ];
  const sum = sumRequestCredits(rows, dayStart, dayEnd);
  assert.equal(sum, 7.95); // 0.08+6.37+1.5
});

test('sumRequestCredits handles missing/blank credit and rows', () => {
  assert.equal(sumRequestCredits(null, dayStart, dayEnd), 0);
  assert.equal(sumRequestCredits([], dayStart, dayEnd), 0);
  assert.equal(sumRequestCredits([{ requestTime: '2026-08-27 12:00:00' }], dayStart, dayEnd), 0);
  assert.equal(sumRequestCredits([{ credit: 'abc', requestTime: '2026-08-27 12:00:00' }], dayStart, dayEnd), 0);
});

test('sumRequestCredits supports numeric timestamp requestTime', () => {
  const ts = new Date(2026, 7, 27, 12, 0, 0).getTime(); // 毫秒
  const rows = [{ credit: 2.5, requestTime: ts }];
  assert.equal(sumRequestCredits(rows, dayStart, dayEnd), 2.5);
  // 秒级时间戳
  const s = Math.floor(ts / 1000);
  assert.equal(sumRequestCredits([{ credit: 3, requestTime: s }], dayStart, dayEnd), 3);
});

test('rounds the daily total to two decimals', () => {
  const rows = [
    { credit: 0.005, requestTime: '2026-08-27 12:00:00' },
    { credit: 0.005, requestTime: '2026-08-27 12:00:01' },
  ];
  assert.equal(sumRequestCredits(rows, dayStart, dayEnd), 0.01);
});

test('parseRowTime handles string date-time and numeric', () => {
  assert.equal(parseRowTime('2026-08-27 12:00:00'), new Date(2026, 7, 27, 12, 0, 0).getTime());
  assert.equal(parseRowTime(''), null);
  assert.equal(parseRowTime(null), null);
  assert.equal(parseRowTime('abc'), null);
  assert.equal(parseRowTime(1787800000000), 1787800000000); // 毫秒
  assert.equal(parseRowTime(1787800000), 1787800000000); // 秒 → 毫秒
});

test('formatLocalDateTime produces YYYY-MM-DD HH:mm:ss in local time', () => {
  const d = new Date(2026, 7, 27, 9, 5, 6);
  assert.equal(formatLocalDateTime(d), '2026-08-27 09:05:06');
});

test('startOfLocalDay returns midnight of the same local day', () => {
  const d = new Date(2026, 7, 27, 18, 30, 0);
  const s = startOfLocalDay(d);
  assert.equal(s.getFullYear(), 2026);
  assert.equal(s.getMonth(), 7);
  assert.equal(s.getDate(), 27);
  assert.equal(s.getHours(), 0);
  assert.equal(s.getMinutes(), 0);
  assert.equal(s.getSeconds(), 0);
});

test('daemon uses the official usage endpoint with correct params', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const module = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'credit-request-usage.js'), 'utf8');
  assert.match(daemon, /fetchTodayUsage/);
  assert.match(daemon, /todayUsedFallback/);
  // 官方接口路径与分页参数封装在模块里
  assert.match(module, /billing\/meter\/get-user-request-usage/);
  assert.match(module, /pageNum/);
  assert.match(module, /startTime/);
  assert.match(module, /sumRequestCredits/);
});

test('renderer shows only today-used, not the ambiguous total-dosage figure', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /creditUsageHtml/);
  assert.match(inject, /今日已用/);
  // TotalDosage 语义容易引起误解（实测接近剩余余额），面板只显示今日已用，不再展示累计用量
  assert.doesNotMatch(inject, /累计已用/);
});
