const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { extractCreditSegments, sortCreditSegments, mergeCreditSegments } = require('../scripts/credit-segments.js');
const { buildCreditResourceBody } = require('../scripts/credit-resource-queries.js');

test('extracts each expiring account as an independent credit segment', () => {
  const segments = extractCreditSegments([
    { CycleCapacityRemainPrecise: '100', CycleCapacitySizePrecise: '100', DeductionEndTime: '2026-08-22 12:00:00' },
    { CycleCapacityRemainPrecise: '100', CycleCapacitySizePrecise: '100', DeductionEndTime: '2026-08-23 12:00:00' },
    { CycleCapacityRemainPrecise: '100', CycleCapacitySizePrecise: '100', DeductionEndTime: '2026-08-24 12:00:00' },
  ], 'meter');

  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((segment) => segment.remaining), [100, 100, 100]);
  assert.equal(segments[0].source, 'meter');
  assert.ok(segments[0].expiresAt < segments[1].expiresAt);
});

test('expands slice-period usage details into separate segments', () => {
  const segments = extractCreditSegments([{
    SlicePeriodUsageDetails: [
      { SlicePeriodCapacityRemainPrecise: '100', SlicePeriodCapacitySizePrecise: '100', SlicePeriodEndTime: '2026-08-22 12:00:00' },
      { SlicePeriodCapacityRemainPrecise: '100', SlicePeriodCapacitySizePrecise: '100', SlicePeriodEndTime: '2026-08-23 12:00:00' },
    ],
  }], 'daily');
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((segment) => segment.remaining), [100, 100]);
});

test('prefers cycle remaining over total capacity when a cycle is exhausted', () => {
  const segments = extractCreditSegments([
    { CycleCapacityRemainPrecise: '0', CapacityRemainPrecise: '500', EndTime: 1790000000 },
  ], 'package');
  assert.deepEqual(segments, []);
});

test('sorts expiring segments first and keeps unknown expiry last', () => {
  const sorted = sortCreditSegments([
    { remaining: 50, expiresAt: null, source: 'unknown' },
    { remaining: 100, expiresAt: 2000, source: 'later' },
    { remaining: 100, expiresAt: 1000, source: 'sooner' },
  ]);
  assert.deepEqual(sorted.map((segment) => segment.source), ['sooner', 'later', 'unknown']);
});

test('merges repeated 500-credit records into one 5000-credit grant segment', () => {
  const segments = extractCreditSegments(Array.from({ length: 10 }, () => ({
    PackageCode: 'TCACA_code_037_WxOD3MpI2o',
    CycleCapacityRemainPrecise: '500',
    CycleCapacitySizePrecise: '500',
    CycleEndTime: '2034-08-20 14:29:00',
  })), '赠送用量');
  const merged = mergeCreditSegments(segments);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].remaining, 5000);
  assert.equal(merged[0].total, 5000);
});

test('builds a v2 all-resource query without a PackageCode allowlist', () => {
  const body = buildCreditResourceBody(new Date(2026, 7, 24, 12, 34, 56));
  assert.equal(body.PageNumber, 1);
  assert.equal(body.PageSize, 100);
  assert.equal(body.ProductCode, 'p_tcaca');
  assert.deepEqual(body.Status, [0, 3]);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'PackageCodes'), false);
  assert.equal(body.PackageEndTimeRangeBegin, '2026-08-24 12:34:56');
  assert.equal(body.PackageEndTimeRangeEnd, '2127-08-24 12:34:56');
});

test('daemon calls the v2 all-resource billing endpoint', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /\/v2\/billing\/meter\/get-user-resource/);
  assert.doesNotMatch(daemon, /fetch\(`\$\{apiHost\}\/billing\/meter\/get-user-resource/);
});
