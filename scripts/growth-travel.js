'use strict';

const TRAVEL_TIMEOUT_MS = 12000;

/**
 * WorkBuddy 成长中心「派猫猫旅行」接口封装。
 * 与签到/成长活跃同源：复用 Bearer 鉴权与 profile 归属域名（国内 www.codebuddy.cn / 国际 www.workbuddy.ai）。
 *
 * 接口（成长中心前端 bundle 实测）：
 *   GET  /activity/growth/buddy/travel/config   -> { locations: [{ id, name, ... }], intro, slogans }
 *   GET  /activity/growth/buddy/travel/status   -> { state: 'idle'|'traveling', location, depart_at, arrive_at, server_now }
 *   POST /activity/growth/buddy/travel/depart   body { location_id }  -> { state: 'traveling', ... }
 *   POST /activity/growth/buddy/travel/claim    body {}               -> { reward_credit, letter, use_deeplink }
 */

function hostBase(apiHost) {
  return String(apiHost || 'https://www.workbuddy.cn').replace(/\/+$/, '');
}

function travelHeaders(host) {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-client-platform': 'web',
    origin: host,
    referer: `${host}/profile/growth-center`,
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  };
}

async function travelRequest(accessToken, path, options = {}) {
  const host = hostBase(options.apiHost);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TRAVEL_TIMEOUT_MS;
  if (!accessToken || typeof fetchImpl !== 'function') {
    throw new Error('旅行接口参数不完整');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${host}${path}`, {
      method: options.method || 'GET',
      headers: Object.assign(travelHeaders(host), { authorization: `Bearer ${accessToken}` }),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error('旅行接口返回了无法解析的数据');
    }
    if (!response.ok) {
      const err = new Error(payload && (payload.msg || payload.message) ? String(payload.msg || payload.message) : `旅行接口 HTTP ${response.status}`);
      err.httpStatus = response.status;
      throw err;
    }
    if (payload.code !== 0 && payload.code !== undefined && payload.code !== null) {
      const err = new Error(payload.msg || `旅行接口 code=${payload.code}`);
      err.httpStatus = response.status;
      throw err;
    }
    return payload && typeof payload === 'object' ? payload.data : payload;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('旅行接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 读取旅行配置（地点列表等）。返回 { enabled, locations: [{ id, name }] } */
async function fetchTravelConfig(accessToken, options = {}) {
  const data = await travelRequest(accessToken, '/activity/growth/buddy/travel/config', {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    apiHost: options.apiHost,
  });
  const locations = data && Array.isArray(data.locations) ? data.locations : [];
  return {
    enabled: !!(data && data.enabled !== false && locations.length),
    locations: locations.map((l) => ({ id: l && l.id, name: (l && l.name) || '' })),
  };
}

/** 读取当前旅行状态。返回 { state, locationId, departAt, arriveAt } */
async function fetchTravelStatus(accessToken, options = {}) {
  const data = await travelRequest(accessToken, '/activity/growth/buddy/travel/status', {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    apiHost: options.apiHost,
  });
  return {
    state: data && data.state ? String(data.state) : 'idle',
    locationId: data && data.location && typeof data.location === 'object' ? data.location.id : null,
    departAt: data && data.depart_at ? Number(data.depart_at) : 0,
    arriveAt: data && data.arrive_at ? Number(data.arrive_at) : 0,
  };
}

/**
 * 派猫猫旅行（depart）。失败时抛出带 message 的 Error（"already traveling" / "daily limit" /
 * "no active buddy" / "location not available" 等由调用方分类处理）。
 * 成功返回 { ok: true, state }。
 */
async function departTravel(accessToken, locationId, options = {}) {
  const data = await travelRequest(accessToken, '/activity/growth/buddy/travel/depart', {
    method: 'POST',
    body: { location_id: locationId },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    apiHost: options.apiHost,
  });
  return { ok: true, state: data && data.state ? String(data.state) : 'traveling' };
}

module.exports = { fetchTravelConfig, fetchTravelStatus, departTravel };
