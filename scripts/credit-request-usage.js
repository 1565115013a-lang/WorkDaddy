'use strict';

// 今日已用积分：调用 WorkBuddy 官方接口 /billing/meter/get-user-request-usage，
// 按「今天 0 点 ~ 当前」的时间范围拉取逐条请求的积分消耗（credit），求和得到精确今日已用。
// 相比本地基线法（当日观测最大剩余 − 当前剩余），官方接口记录了每一条请求，没有跨天盲区。

// 单次请求分页大小（官方接口单页上限有限，用较大的分页减少请求次数）
const PAGE_SIZE = 100;

function formatLocalDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function startOfLocalDay(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 纯函数：对接口返回的请求记录，按 requestTime 落在 [startMs, endMs] 内过滤，汇总 credit。
 * @param {Array} rows 接口返回的 data.data[]
 * @param {number} startMs 时间范围起点（毫秒）
 * @param {number} endMs 时间范围终点（毫秒）
 * @returns {number} 该时间范围内的积分消耗总和
 */
function sumRequestCredits(rows, startMs, endMs) {
  let total = 0;
  if (!Array.isArray(rows)) return 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const credit = Number(row.credit);
    if (!Number.isFinite(credit) || credit <= 0) continue;
    const ts = parseRowTime(row.requestTime);
    if (ts === null) continue;
    if (ts >= startMs && ts <= endMs) total += credit;
  }
  return Number(total.toFixed(2));
}

// 兼容 requestTime 的常见格式：'YYYY-MM-DD HH:mm:ss' / ISO / 数字时间戳
function parseRowTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d)\s+/, '$1T'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 调用官方 get-user-request-usage，拉取 [startTime, endTime] 范围内全部请求，汇总积分消耗。
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.apiHost 例如 'https://www.codebuddy.cn'
 * @param {Date} [options.now] 当前时间（可注入，便于测试）
 * @returns {Promise<{ok:boolean, todayUsed:number|null, count:number, total:number, error?:string}>}
 */
async function fetchTodayUsage({ accessToken, apiHost, now }) {
  const result = { ok: false, todayUsed: null, count: 0, total: 0 };
  if (!accessToken || !apiHost) return result;
  const current = now instanceof Date ? now : new Date();
  const start = startOfLocalDay(current);
  const end = current;
  const startStr = formatLocalDateTime(start);
  const endStr = formatLocalDateTime(end);
  const url = `${apiHost}/billing/meter/get-user-request-usage`;

  let allRows = [];
  let serverTotal = 0;
  let page = 1;
  try {
    for (;;) {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-client-platform': 'web',
          origin: apiHost,
          referer: `${apiHost}/profile/plans-usage`,
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) WorkBuddy/5.3.14 Chrome/138.0.7204.251 Safari/537.36',
        },
        body: JSON.stringify({ startTime: startStr, endTime: endStr, pageNum: page, pageSize: PAGE_SIZE }),
        signal: AbortSignal.timeout(12000),
      });
      const text = await r.text();
      let o;
      try { o = JSON.parse(text); } catch (_) { throw new Error('解析用量接口失败'); }
      if (!r.ok) throw new Error(`用量接口 HTTP ${r.status}`);
      if (o.code !== 0) throw new Error(o.msg || `用量接口 code=${o.code}`);
      const data = o.data || {};
      serverTotal = Number(data.total) || 0;
      const rows = Array.isArray(data.data) ? data.data : [];
      allRows = allRows.concat(rows);
      if (!rows.length || allRows.length >= serverTotal || page >= 20) break;
      page++;
    }
    const todayUsed = sumRequestCredits(allRows, start.getTime(), end.getTime());
    result.ok = true;
    result.todayUsed = todayUsed;
    result.count = allRows.length;
    result.total = serverTotal;
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

module.exports = { fetchTodayUsage, sumRequestCredits, formatLocalDateTime, startOfLocalDay, parseRowTime };
