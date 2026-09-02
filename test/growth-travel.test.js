'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchTravelConfig, fetchTravelStatus, departTravel } = require('../scripts/growth-travel.js');

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async () => ({ ok, status, text: async () => text });
}

test('fetchTravelConfig 返回地点列表', async () => {
  const r = await fetchTravelConfig('tok', {
    fetchImpl: mockFetch({ code: 0, data: { enabled: true, locations: [{ id: 'loc1', name: '三亚' }, { id: 'loc2', name: '成都' }] } }),
  });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.locations, [{ id: 'loc1', name: '三亚' }, { id: 'loc2', name: '成都' }]);
});

test('fetchTravelConfig 无地点时 enabled=false', async () => {
  const r = await fetchTravelConfig('tok', {
    fetchImpl: mockFetch({ code: 0, data: { locations: [] } }),
  });
  assert.equal(r.enabled, false);
  assert.deepEqual(r.locations, []);
});

test('fetchTravelStatus 返回 state', async () => {
  const r = await fetchTravelStatus('tok', {
    fetchImpl: mockFetch({ code: 0, data: { state: 'traveling', location: { id: 'loc1' }, depart_at: 1, arrive_at: 2 } }),
  });
  assert.equal(r.state, 'traveling');
  assert.equal(r.locationId, 'loc1');
});

test('departTravel 成功返回 ok', async () => {
  const r = await departTravel('tok', 'loc1', {
    fetchImpl: mockFetch({ code: 0, data: { state: 'traveling' } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'traveling');
});

test('departTravel 携带 location_id', async () => {
  let captured = null;
  const impl = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { state: 'traveling' } }) };
  };
  await departTravel('tok', 'loc-9', { fetchImpl: impl });
  assert.deepEqual(captured, { location_id: 'loc-9' });
});

test('departTravel 报错（already traveling）抛错', async () => {
  await assert.rejects(
    departTravel('tok', 'loc1', {
      fetchImpl: mockFetch({ code: 400, msg: 'already traveling' }, { ok: false, status: 400 }),
    }),
    /already traveling/
  );
});

test('缺 accessToken 抛错', async () => {
  await assert.rejects(
    fetchTravelConfig('', { fetchImpl: mockFetch({ code: 0 }) }),
    /参数不完整/
  );
});
