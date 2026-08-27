const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { extractCreditSegments, sortCreditSegments, mergeCreditSegments, parseEnterpriseUsage, ENTERPRISE_EDITIONS } = require('../scripts/credit-segments.js');
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

test('parses enterprise usage: remaining = limitNum - credit, cycleResetTime carried', () => {
  const parsed = parseEnterpriseUsage({ code: 0, data: { credit: 1500, limitNum: 2000, cycleResetTime: '2026-09-01 00:00:00' } }, '企业配额');
  assert.equal(parsed.unlimited, false);
  assert.equal(parsed.credits, 500);
  assert.equal(parsed.total, 2000);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.cycleResetTime, new Date('2026-09-01 00:00:00').getTime());
  assert.equal(parsed.segments.length, 1);
  assert.equal(parsed.segments[0].remaining, 500);
  assert.equal(parsed.segments[0].total, 2000);
  assert.equal(parsed.segments[0].source, '企业配额');
});

test('parses unlimited enterprise usage (limitNum === -1) without a numeric balance', () => {
  const parsed = parseEnterpriseUsage({ data: { credit: 0, limitNum: -1, cycleResetTime: '' } }, '企业配额');
  assert.equal(parsed.unlimited, true);
  assert.equal(parsed.credits, 0);
  assert.equal(parsed.total, 0);
  assert.deepEqual(parsed.segments, []);
});

test('rejects malformed enterprise usage payloads', () => {
  assert.equal(parseEnterpriseUsage(null, 'x'), null);
  assert.equal(parseEnterpriseUsage({}, 'x'), null);
  assert.equal(parseEnterpriseUsage({ data: { credit: 'abc', limitNum: 'oops' } }, 'x'), null);
});

test('enterprise editions match the official ENTERPRISE_EDITIONS set', () => {
  assert.deepEqual(ENTERPRISE_EDITIONS, ['ultimate', 'exclusive']);
});

test('daemon branches to the enterprise endpoint for enterprise accounts', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /\/v2\/billing\/meter\/get-enterprise-user-usage/);
  assert.match(daemon, /ENTERPRISE_EDITIONS/);
  assert.match(daemon, /x-enterprise-id/);
  assert.match(daemon, /x-tenant-id/);
  assert.match(daemon, /parseEnterpriseUsage/);
});
