'use strict';

const INACTIVE_MESSAGE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/i;
const ALREADY_MESSAGE = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already\s*(?:checked[- ]?in|claimed)|already/i;

function numericCode(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Accept only an explicit successful response from the official check-in API.
 * A successful HTTP status alone is insufficient because gateways can return
 * an empty or non-JSON 200 response. Code 10001 is accepted only when its
 * message proves that today's check-in was already completed.
 */
function classifyCheckinResult({ httpOk, code, message }) {
  const normalizedCode = numericCode(code);
  const text = String(message || '');
  const inactive = INACTIVE_MESSAGE.test(text);
  const already = normalizedCode === 10001 && !inactive && ALREADY_MESSAGE.test(text);
  const ok = !!httpOk && !inactive && (normalizedCode === 0 || already);
  return { ok, already, inactive, code: normalizedCode, message: text };
}

module.exports = { classifyCheckinResult, INACTIVE_MESSAGE, ALREADY_MESSAGE };
