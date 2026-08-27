'use strict';

// 今日已用积分：基于「当日观测到的最大剩余值」做基线，跨天自动重置。
// 取最大剩余而非最早值，是因为当日可能发生签到/充值等增发，用最大剩余可避免
// 把今日已用算成负值或偏大。缺点（面板关闭 + 跨天期间消耗）无法精确覆盖，仅做近似。
// 本模块只包含纯计算逻辑，文件读写由调用方（daemon）负责，便于回归测试。

/**
 * 依据本次观测到的剩余积分，更新某账号的「当日基线缓存」并计算「今日已用」。
 * @param {object} cache 基线缓存 { [uid]: { date: 'YYYY-MM-DD', base: number } }
 * @param {string} uid 账号 uid
 * @param {string} today 今天日期字符串（'YYYY-MM-DD'）
 * @param {number|null|undefined} credits 当前剩余积分；非有限数/空时不记账
 * @returns {{ cache: object, todayUsed: number|null }} 更新后的缓存与今日已用
 */
function updateDailyBaseline(cache, uid, today, credits) {
  const result = { cache, todayUsed: null };
  if (!uid || credits === null || credits === undefined || !Number.isFinite(Number(credits))) {
    return result;
  }
  const value = Number(credits);
  let entry = cache[uid];
  // 跨天或首次见到 → 以当前剩余为基线，今日已用为 0
  if (!entry || entry.date !== today) {
    cache[uid] = { date: today, base: value };
    result.todayUsed = 0;
    return result;
  }
  const base = Number(entry.base);
  // 当日出现增发（剩余比基线还高）→ 抬高基线，今日已用归零
  if (value > base) {
    entry.base = value;
    result.todayUsed = 0;
    return result;
  }
  result.todayUsed = Math.max(0, Number((base - value).toFixed(2)));
  return result;
}

/**
 * 清理过期的基线记录（保留近 retainDays 天）。today 当天的记录始终保留。
 * @param {object} cache
 * @param {string} today 今天日期字符串（'YYYY-MM-DD'）
 * @param {number} retainDays 保留天数
 * @returns {{ cache: object, changed: boolean }} 清理后的缓存与是否有变更
 */
function pruneBaselines(cache, today, retainDays) {
  const cutoff = new Date(today + 'T00:00:00');
  cutoff.setDate(cutoff.getDate() - retainDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let changed = false;
  for (const uid of Object.keys(cache)) {
    const date = cache[uid] && cache[uid].date;
    if (typeof date !== 'string' || date < cutoffStr) {
      if (date !== today) { delete cache[uid]; changed = true; }
    }
  }
  return { cache, changed };
}

module.exports = { updateDailyBaseline, pruneBaselines };
