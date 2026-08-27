'use strict';
/* ===== 会话模块发送链路与忙碌判定的回归测试（与 inject.js / daemon.js 同源复制逻辑） ===== */
const assert = require('node:assert');
const AC_FIXED_TEXT = '如果未完成，继续执行；已完成则回复"已完成"';

/* ———— 同源：发送证据判定（inject acVerifySent 的核心规则）————
 * 成功 = 末条含固定文案 且（出现发送前不存在的新 user-message-* ID ｜ 数量增加 ｜ 末条变化 兜底）。 */
function acSendEvidenceFreshed(before, after) {
  if (!before || !after) return false;
  if (!after.last) return false;
  if (after.last.indexOf(AC_FIXED_TEXT) < 0) return false;
  const newId = before.ids && before.ids.length && after.lastId && before.ids.indexOf(after.lastId) < 0;
  if (newId) return true;
  return after.count > before.count || (!!before.last && after.last !== before.last);
}

/* ———— 同源：忙碌元素判定（inject acIsBusyEl 遍历首个可见有效元素）———— */
function busyElVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null) return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  if (el.hasAttribute && (el.hasAttribute('disabled') || el.disabled)) return false;
  return true;
}
function acFirstBusyEl(els) {
  if (!els || !els.length) return null;
  for (var i = 0; i < els.length; i++) {
    if (busyElVisible(els[i])) return els[i];
  }
  return null;
}

/* ———— 同源：count-shrink 重置语义（inject acOnMutation 数量减少分支）————
 * 保留 judgedMessages（7→6→7 时旧消息不重复判定），重置 feedback/计时 */
function applyCountShrink(c, stat, keepJudged) {
  return {
    lastMsgCount: stat.count,
    lastActiveTxt: stat.txt || '',
    activeMessage: stat.content || null,
    feedbackSeen: false,
    feedbackAt: 0,
    lastMutationAt: Date.now(),
    judgedMessages: keepJudged ? (c && c.judgedMessages) : new Set(),
  };
}

/* ———— 测试 1：仅输入框清空、无新消息 → 不判定成功 ———— */
{
  const before = { count: 3, last: '上一个问题' };
  const after = { count: 3, last: '上一个问题' }; // 无新用户消息
  assert.strictEqual(acSendEvidenceFreshed(before, after), false, '输入框空但没有新消息不得判定发送成功');
  console.log('✓ 空输入无新消息 → 不判成功');
}

/* ———— 测试 2：CDP 发送后用户消息数 +1 且含固定文案 → 判定成功 ———— */
{
  const before = { count: 3, last: '上一个问题' };
  const after = { count: 4, last: '如果未完成，继续执行；已完成则回复"已完成"' };
  assert.strictEqual(acSendEvidenceFreshed(before, after), true, '新用户消息出现应判定成功');
  console.log('✓ 新用户消息（含固定文案）→ 判定成功');
}

/* ———— 测试 3：数量未变但末条变化为非固定文案 → 不判定成功（不是我们的发送） ———— */
{
  const before = { count: 3, last: 'A' };
  const after = { count: 3, last: 'B' };
  assert.strictEqual(acSendEvidenceFreshed(before, after), false, '末条变化但无固定文案不是本次发送结果');
  console.log('✓ 末条变化但非固定文案 → 不判成功');
}

/* ———— 测试 4：before 快照缺失 → 不判定成功 ———— */
{
  assert.strictEqual(acSendEvidenceFreshed(null, { count: 1, last: '如果未完成，继续执行；已完成则回复"已完成"' }), false);
  console.log('✓ 无发送前快照 → 不判成功');
}

/* ———— 测试 5：数量增加但末条是用户手动输入的其他内容 → 不判定成功（P1 关键场景） ———— */
{
  const before = { count: 3, last: '旧消息' };
  const after = { count: 4, last: '用户手动输入的其他内容' };
  assert.strictEqual(acSendEvidenceFreshed(before, after), false, '数量增加但末条非固定文案不能判定成功');
  console.log('✓ 数量增但末条非固定文案 → 不判成功');
}

/* ———— 测试 6：busy 元素可见性 ———— */
{
  const visible = { offsetParent: {}, getAttribute: () => null, hasAttribute: () => false, disabled: false };
  assert.strictEqual(busyElVisible(visible), true, '可见未禁用停止按钮=忙碌');
  const hidden = { offsetParent: null, getAttribute: () => null, hasAttribute: () => false, disabled: false };
  assert.strictEqual(busyElVisible(hidden), false, '不可见停止按钮≠忙碌');
  const aria = { offsetParent: {}, getAttribute: (k) => (k === 'aria-hidden' ? 'true' : null), hasAttribute: () => false, disabled: false };
  assert.strictEqual(busyElVisible(aria), false, 'aria-hidden 停止按钮≠忙碌');
  const dis = { offsetParent: {}, getAttribute: () => null, hasAttribute: (k) => k === 'disabled', disabled: true };
  assert.strictEqual(busyElVisible(dis), false, '禁用停止按钮≠忙碌');
  console.log('✓ busy 元素可见性判定（可见/隐藏/aria-hidden/disabled）');
}

/* ———— 测试 7：busy 遍历取首个有效（第一个隐藏、第二个可见 → 忙碌） ———— */
{
  const hiddenEl = { offsetParent: null, getAttribute: () => null, hasAttribute: () => false, disabled: false };
  const visibleEl = { offsetParent: {}, getAttribute: () => null, hasAttribute: () => false, disabled: false };
  assert.strictEqual(acFirstBusyEl([hiddenEl, visibleEl]), visibleEl, '跳过隐藏元素返回首个有效停止元素');
  assert.strictEqual(acFirstBusyEl([hiddenEl]), null, '全部无效 → 不忙碌');
  console.log('✓ busy 遍历首个有效元素（隐藏残留不遮蔽真实停止按钮）');
}

/* ———— 测试 8：count-shrink（保留 judgedMessages：7→6→7 不重复判定旧消息） ———— */
{
  const judged = new Set(['m7']);
  const oldState = { feedbackSeen: true, judgedMessages: judged };
  const c6 = applyCountShrink(oldState, { count: 6, txt: 'T6', content: 'MSG6' }, true);
  assert.strictEqual(c6.feedbackSeen, false, '数量减少必须清 feedbackSeen');
  assert.strictEqual(c6.feedbackAt, 0, '数量减少必须清 feedbackAt');
  assert.strictEqual(c6.lastMsgCount, 6);
  // 关键：judgedMessages 必须保留（7→6→7 时旧消息仍被标记已判定，不会重复触发）
  assert.strictEqual(c6.judgedMessages, judged, 'count-shrink 必须保留 judgedMessages 防 7→6→7 重复判定');
  console.log('✓ count-shrink 保留 judgedMessages（7→6→7 不重复判定）');
}

/* ———— 测试 9：CDP no-composer 必须失败（daemon acDispatchEnter 同源规则，层级 = cdpSend 返回的 msg.result） ———— */
{
  // cdpSend() 返回 msg.result（daemon.js:1479 p.resolve(msg.result)），
  // evaluate 返回值在 msg.result.result.value → cd 结果上为 r.result.value（r == msg.result）。
  function acEvalState(r) {
    const state = r && r.result && r.result.value;
    return state !== 'ok' ? new Error('no-composer') : null;
  }
  assert.throws(() => { const e = acEvalState({ result: { type: 'string', value: 'no-composer' } }); if (e) throw e; }, /no-composer/);
  assert.throws(() => { const e = acEvalState({}); if (e) throw e; }, /no-composer/);
  assert.doesNotThrow(() => acEvalState({ result: { type: 'string', value: 'ok' } }));
  console.log('✓ CDP no-composer（正确返回层级 r.result.value）→ 抛错');
}

/* ———— 测试 10：按钮兜底必须写文案且查禁用（含 aria-disabled） ———— */
{
  function btnCanClick(btn) {
    return !!btn && !btn.disabled && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true';
  }
  assert.strictEqual(btnCanClick(null), false, '无按钮不能点');
  assert.strictEqual(btnCanClick({ disabled: true, hasAttribute: () => false, getAttribute: () => null }), false, '禁用按钮不能点');
  assert.strictEqual(btnCanClick({ disabled: false, hasAttribute: () => false, getAttribute: (k) => (k === 'aria-disabled' ? 'true' : null) }), false, 'aria-disabled 按钮不能点');
  assert.strictEqual(btnCanClick({ disabled: false, hasAttribute: () => false, getAttribute: () => null }), true, '可用按钮可点');
  console.log('✓ 按钮兜底：存在且未禁用（含 aria-disabled）才可点击');
}

/* ———— 同源：消息稳定签名（inject acMsgSignature）————
 * 优先 data-message-request-id（.cb-assistant-message 稳定消息 ID，唯一不碰撞、重建免疫）；
 * 无 ID 回退 len + 前96 + 后96（防模板前缀碰撞）。 */
function acMsgSignature(content, pickText) {
  if (!content) return '';
  if (content.closest) {
    const row = content.closest('.cb-assistant-message');
    const mid = row && row.getAttribute('data-message-request-id');
    if (mid) return 'id:' + mid;
  }
  const t = ((pickText && pickText(content)) || (content.textContent || '')).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length + ':' + t.slice(0, 96) + ':' + t.slice(-96);
}

/* ———— 测试 11：不同 DOM 节点、同一消息文本 → 签名一致（虚拟列表 7→6→7 重建后判重仍有效） ———— */
{
  const nodeA = { textContent: '这是一条被判定过的助手消息     内容\n  第二行' };
  const nodeB = { textContent: '这是一条被判定过的助手消息 内容\n  第二行' }; // 重建后的新节点，文本等价
  const sigA = acMsgSignature(nodeA, (n) => n.textContent);
  const sigB = acMsgSignature(nodeB, (n) => n.textContent);
  assert.strictEqual(sigA, sigB, '虚拟列表重建后同一消息签名必须一致');
  // 同文本签名入 Set 后 has 命中 → 不会重复判定
  const judged = new Set([sigA]);
  assert.strictEqual(judged.has(sigB), true, '重建节点仍命中已判定签名');
  const nodeC = { textContent: '完全不同内容的消息' };
  assert.strictEqual(judged.has(acMsgSignature(nodeC, (n) => n.textContent)), false);
  console.log('✓ 消息签名判重（虚拟列表重建免疫）');
}

/* ———— 测试 12：不同消息、相同前 96 字符 → 签名不同（模板前缀不碰撞） ———— */
{
  const commonHead = '此处是相同的模板前缀，用于测试签名碰撞场景，长度足够超过九十六个字符吗——再补一段确保前缀完全一样，实际回复正文从这里开始完全不同的内容：';
  const text1 = commonHead + '第一条回复的正文内容，讲的是甲主题，结尾甲甲甲甲甲甲甲';
  const text2 = commonHead + '第二条回复的正文内容，讲的是乙主题，结尾乙乙乙乙乙乙乙乙乙乙乙乙乙';
  const s1 = acMsgSignature({ textContent: text1 }, (n) => n.textContent);
  const s2 = acMsgSignature({ textContent: text2 }, (n) => n.textContent);
  assert.notStrictEqual(s1, s2, '前 96 字符相同但整体不同 → 签名必须不同（防模板前缀碰撞）');
  console.log('✓ 签名防碰撞（同前缀不同文本 → 不同签名）');
}

/* ———— 测试 13：稳定消息 ID 优先（data-message-request-id 唯一、重建免疫、文本无关） ———— */
{
  function fakeClosest(rowEl) { return function (sel) { return sel === '.cb-assistant-message' ? rowEl : null; }; }
  const id = 'a2ad477fb2be44a59d3fbf1487963956';
  // 同一 ID、不同 DOM 节点（虚拟列表重建）→ 签名一致
  const n1 = { closest: fakeClosest({ getAttribute: (k) => (k === 'data-message-request-id' ? id : null) }), textContent: 'A' };
  const n2 = { closest: fakeClosest({ getAttribute: (k) => (k === 'data-message-request-id' ? id : null) }), textContent: 'B' };
  assert.strictEqual(acMsgSignature(n1), acMsgSignature(n2), '同一消息 ID → 签名一致（与文本无关）');
  // 不同 ID → 签名不同（重新生成/新回复换 ID = 重新判定）
  const n3 = { closest: fakeClosest({ getAttribute: (k) => (k === 'data-message-request-id' ? 'other-id-xyz' : null) }), textContent: 'A' };
  assert.notStrictEqual(acMsgSignature(n1), acMsgSignature(n3), '不同消息 ID → 签名不同');
  // 无 ID 回退文本签名
  const n4 = { closest: () => null, textContent: '无 ID 的旧消息内容 AAAA' };
  const n5 = { closest: () => null, textContent: '无 ID 的旧消息内容 AAAA' };
  assert.strictEqual(acMsgSignature(n4), acMsgSignature(n5), '无 ID 回退文本签名（同文本一致）');
  console.log('✓ 稳定消息 ID 优先判重（唯一/重建免疫/重新生成换 ID 重新判定）');
}

/* ———— 测试 14：发送证据用 user-message-ID（新 ID 出现 = 发送成功，不依赖数量/文本位置） ———— */
{
  const before = { count: 5, last: '旧消息', lastId: 'user-message-a', ids: ['user-message-a', 'user-message-b', 'user-message-c', 'user-message-d', 'user-message-e'] };
  const after = { count: 6, last: '如果未完成，继续执行；已完成则回复"已完成"', lastId: 'user-message-f', ids: [...before.ids, 'user-message-f'] };
  assert.strictEqual(acSendEvidenceFreshed(before, after), true, '新 user-message-id 且含固定文案 → 判定成功');
  // 数量未增但出现新 ID → 仍判成功（DOM 卸载旧节点场景）
  const after2 = { count: 5, last: '如果未完成，继续执行；已完成则回复"已完成"', lastId: 'user-message-g', ids: ['user-message-c', 'user-message-d', 'user-message-e', 'user-message-g'] };
  assert.strictEqual(acSendEvidenceFreshed(before, after2), true, '数量未增但新 ID 出现 → 判定成功');
  // 数量增加但无新 ID 且末条非固定文案 → 不判成功
  const after3 = { count: 6, last: '用户手动输入的其他内容', lastId: 'user-message-h', ids: [...before.ids, 'user-message-h'] };
  assert.strictEqual(acSendEvidenceFreshed(before, after3), false, '数量增但末条非固定文案 → 不判成功');
  // snap=null（DOM 异常）→ 不抛异常、不判成功
  assert.strictEqual(acSendEvidenceFreshed(before, null), false, 'snap 为 null → 不判成功');
  // 末条含固定文案但为「页面原本就有的消息」：count 未变、文本未变、lastId 空 → 不判成功（空 ID 不得当新 ID，不重复判定已有消息）
  const beforeLast = { count: 5, last: '如果未完成，继续执行；已完成则回复"已完成"', lastId: 'user-message-a', ids: ['user-message-a', 'user-message-b', 'user-message-c', 'user-message-d', 'user-message-e'] };
  const after4 = { count: 5, last: '如果未完成，继续执行；已完成则回复"已完成"', lastId: '', ids: [] };
  assert.strictEqual(acSendEvidenceFreshed(beforeLast, after4), false, 'lastId 空且数量文本未变 → 不判成功');
  // 发送前无 id 集（降级 DOM）：末条文本变化为固定文案 → 文本兜底生效，应判成功
  const after5 = { count: 5, last: '如果未完成，继续执行；已完成则回复"已完成"', lastId: 'user-message-x', ids: ['user-message-x'] };
  assert.strictEqual(acSendEvidenceFreshed({ count: 5, last: '旧消息', lastId: '', ids: [] }, after5), true, '无 id 集时末条文本变化为固定文案 → 文本兜底判成功');
  console.log('✓ 发送证据 user-message-ID（新 ID + 固定文案 + 空值防护）');
}

/* ———— 同源：baseline 门控（inject acOnMutation/acSettleCheck 的 awaitingNewReply 守卫） ————
 * 返回 true = 仍在等待新回复（baseline 未解除）→ 绝不判定/发送；返回 false = 可进入正常判定。 */
function acBaselineGuard(c, currentKey) {
  if (!c.awaitingNewReply) return false;
  if (!currentKey) return true;                                   // 无 key（DOM 异常）保守跳过
  if (currentKey === c.baselineAssistantKey) return true;         // 仍是 baseline → 跳过
  c.awaitingNewReply = false;                                     // key 变化 = 第一条新回复 → 解除
  c.baselineAssistantKey = currentKey;
  return false;
}

/* ———— 测试 15：baseline 门控 —— 旧回复/旧 timer 绝不触发 ———— */
{
  const keyA = 'id:msg-a', keyB = 'id:msg-b';
  // 1) 切换会话后 baseline 仍是原消息（旧 timer 竞态/feedback/重排）→ 跳过不判
  let c1 = { awaitingNewReply: true, baselineAssistantKey: keyA };
  assert.strictEqual(acBaselineGuard(c1, keyA), true, 'awaiting 且同 baseline key → 跳过（旧回复不误判）');
  assert.strictEqual(c1.awaitingNewReply, true, '跳过不解锁');
  // 2) awaiting 且无 key（DOM 异常）→ 保守跳过
  let c2 = { awaitingNewReply: true, baselineAssistantKey: keyA };
  assert.strictEqual(acBaselineGuard(c2, ''), true, 'awaiting 且无 key → 跳过');
  // 3) awaiting 但出现新 key（第一条新回复）→ 解除，进入判定
  let c3 = { awaitingNewReply: true, baselineAssistantKey: keyA };
  assert.strictEqual(acBaselineGuard(c3, keyB), false, '新消息 key → 解锁进入判定');
  assert.strictEqual(c3.awaitingNewReply, false, '解锁后停止等待');
  assert.strictEqual(c3.baselineAssistantKey, keyB, 'baseline 更新为新消息');
  // 4) 非等待期（已收到过新回复）→ 始终放行
  let c4 = { awaitingNewReply: false, baselineAssistantKey: keyA };
  assert.strictEqual(acBaselineGuard(c4, keyA), false, '非等待期放行');
  // 5) 切回旧会话：会话切换建立新 baseline（awaiting=true）+ 旧消息 key === baseline → 不触发（场景 1 覆盖）
  console.log('✓ baseline 门控（历史/旧 timer/切回均不误触发；新 key 才解锁）');
}

/* ———— 同源：会话签名（inject acSessionSig：官方 conversation ID；取不到返回 '' 保守） ———— */
function acSessionSigFromId(id) {
  return (id && id !== 'unknown') ? 'conversation:' + id : '';
}

/* ———— 测试 16：会话签名用官方 conversation ID ———— */
{
  assert.strictEqual(acSessionSigFromId('79a7204b-8cc0-431f-8dc8-079f69440ad9'),
    acSessionSigFromId('79a7204b-8cc0-431f-8dc8-079f69440ad9'), '同一会话 ID → 签名一致');
  assert.notStrictEqual(acSessionSigFromId('conv-a'), acSessionSigFromId('conv-b'), '不同会话 ID → 签名不同（首条消息相同也能识别切换）');
  assert.strictEqual(acSessionSigFromId('unknown'), '', 'unknown → 保守空签名');
  assert.strictEqual(acSessionSigFromId(''), '', '空 → 保守空签名');
  console.log('✓ 会话签名 = 官方 conversation ID（同 ID 同签名/异 ID 异签名/未知保守）');
}

/* ———— 测试 17：baseline 解锁只认官方 assistant ID（文本变化/无 ID 绝不解锁） ———— */
{
  const keyA = 'id:msg-a', keyB = 'id:msg-b';
  // 无官方 ID（null）→ 保守跳过，文本变化不解锁
  let c1 = { awaitingNewReply: true, baselineAssistantKey: '' };
  assert.strictEqual(acBaselineGuard(c1, null), true, '无官方 assistant ID → 保守等待，文本变化不解锁');
  assert.strictEqual(c1.awaitingNewReply, true, '仍等待');
  // 同官方 ID（仅文本变化/渲染更新）→ 不解锁
  let c2 = { awaitingNewReply: true, baselineAssistantKey: keyA };
  assert.strictEqual(acBaselineGuard(c2, keyA), true, '官方 ID 未变（文本变化）→ 不解锁');
  // 新官方 ID → 解锁
  let c3 = { awaitingNewReply: true, baselineAssistantKey: keyA };
  assert.strictEqual(acBaselineGuard(c3, keyB), false, '新官方 assistant ID → 解锁');
  // feedback 出现但 ID 未变 → 不发送（守卫挡）
  let c4 = { awaitingNewReply: true, baselineAssistantKey: keyA, feedbackSeen: false };
  assert.strictEqual(acBaselineGuard(c4, keyA), true, 'feedback 出现但 assistant ID 未变 → 不发送');
  console.log('✓ baseline 解锁只认官方 assistant ID（文本/feedback/无 ID 均不解锁）');
}

/* ———— 同源：当前激活会话 ID（inject acActiveConversationId：adapter.currentActiveSessionId 优先
 *   → URL 参数 → active/aria-selected 的 data-conversation-id；取不到返回 '' —— 绝不回退任意会话/标题/文本） ———— */
function acActiveConvId(adapterId, urlId, activeId) {
  if (adapterId) return adapterId;  // 官方 adapter 直接暴露，最可靠
  if (urlId) return urlId;          // URL conversationId 其次
  return activeId || '';            // 仅 active/aria-selected 的官方 ID；无则空
}

/* ———— 同源：awaiting 期数量增加门控（inject acOnMutation 数量分支）————
 * awaiting=true：数量增加只刷新观察基准，解锁唯一依据 = 官方 assistant ID 变化（null/同 baseline 继续等待）
 * awaiting=false：数量增加 = 正常判定流的新回复 */
function acAwaitingCountGate(awaiting, currentKey, baselineKey) {
  if (!awaiting) return 'normal';                       // 非等待期：数量增 = 正常新回复流
  if (!currentKey) return 'wait';                       // 数量增但无官方 ID → 继续等待
  if (currentKey === baselineKey) return 'wait';        // 数量增但仍 baseline（虚拟列表重挂/回放）→ 继续等待
  return 'release';                                     // 数量增且官方 ID 变化 → 解除
}

/* ———— 测试 18：当前激活会话 ID 专用函数（adapter 优先 / 不回退任意会话） ———— */
{
  assert.strictEqual(acActiveConvId('adapter-sid', 'cid-url', 'cid-active'), 'adapter-sid', '官方 adapter.currentActiveSessionId 优先（最可靠）');
  assert.strictEqual(acActiveConvId('', 'cid-url', 'cid-active'), 'cid-url', '无 adapter 时 URL conversationId 优先');
  assert.strictEqual(acActiveConvId('', '', 'cid-active'), 'cid-active', '无 adapter 无 URL 时仅 active 的官方 ID 生效');
  assert.strictEqual(acActiveConvId('', '', ''), '', '全部取不到 → 空，即便页面存在任意 data-conversation-id 也不采（去掉任意会话兜底）');
  console.log('✓ 激活会话 ID：adapter 优先 / URL / active 生效 / 无则空（绝不回退任意会话）');
}

/* ———— 测试 19：awaiting 期数量增加不单独解锁 ———— */
{
  assert.strictEqual(acAwaitingCountGate(true, null, 'base'), 'wait', '数量 6→7 但无官方 ID → 不解除（虚拟列表重挂不被当新回复）');
  assert.strictEqual(acAwaitingCountGate(true, 'base', 'base'), 'wait', '数量增但 ID 仍 baseline → 不解除（历史回放/重排）');
  assert.strictEqual(acAwaitingCountGate(true, 'new-id', 'base'), 'release', '数量增且官方 ID 变化 → 解除');
  assert.strictEqual(acAwaitingCountGate(false, null, 'base'), 'normal', '非等待期数量增 = 正常新回复流');
  console.log('✓ awaiting 期数量增加只观察、不解锁（解锁唯一依据 = 官方 assistant ID 变化）');
}

console.log('\nall session-send tests passed');