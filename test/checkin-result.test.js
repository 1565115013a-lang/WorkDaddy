'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyCheckinResult } = require('../scripts/checkin-result.js');

test('check-in requires an explicit successful response code', () => {
  assert.equal(classifyCheckinResult({ httpOk: true, code: undefined, message: 'OK' }).ok, false);
  assert.equal(classifyCheckinResult({ httpOk: true, code: 0, message: 'OK' }).ok, true);
  assert.equal(classifyCheckinResult({ httpOk: false, code: 0, message: 'OK' }).ok, false);
});

test('code 10001 is cached only when it explicitly means already checked in', () => {
  assert.equal(classifyCheckinResult({ httpOk: true, code: 10001, message: '今日已签到' }).ok, true);
  assert.equal(classifyCheckinResult({ httpOk: true, code: 10001, message: '活动未开启' }).ok, false);
  assert.equal(classifyCheckinResult({ httpOk: true, code: 10001, message: '请求成功' }).ok, false);
});
