const assert = require('node:assert/strict');
const test = require('node:test');

const { extractCreditSegments, sortCreditSegments } = require('../scripts/credit-segments.js');

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
