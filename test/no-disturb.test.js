/**
 * 免打扰模块核心逻辑单测（与 scripts/daemon.js 中实现保持同步，纯内存模拟 settings 对象）。
 * 运行：node test/no-disturb.test.js
 */
'use strict';
const assert = require('assert');

// ===== 与 daemon.js 同源的常量与函数（改动 daemon 时需同步此处）=====
const WBS_SYSTEM_LEVEL_TOOLS = ['wsl', 'wsl.exe', 'wslconfig', 'wslconfig.exe', 'wmic', 'wmic.exe', 'sc', 'sc.exe', 'reg', 'reg.exe', 'schtasks', 'schtasks.exe'];
const WBS_COMMON_EXCLUDED_CMDS = ['npm', 'pnpm', 'yarn', 'npx', 'node', 'python3', 'python', 'git', 'curl', 'wget', 'brew'];
const WBS_EXTRA_ALLOW_WRITE = ['/tmp', '/var/tmp', '~/Downloads', '~/Desktop', '~/Documents', '~/Pictures', '~/Movies', '~/Music'];
const WBS_SWITCH_NAMES = ['outsideWrite', 'commands', 'bulkDelete', 'systemTools', 'autoApprove'];

function removeListItems(arr, items) {
  if (!Array.isArray(arr)) return arr;
  const drop = new Set(items);
  return arr.filter((x) => !drop.has(x));
}
function ensureSandboxObj(settings) {
  if (!settings.sandbox || typeof settings.sandbox !== 'object') settings.sandbox = {};
  return settings.sandbox;
}
function applyNoDisturbSwitch(settings, ns, name, enabled) {
  const sb = ensureSandboxObj(settings);
  const recordAndMerge = (key, items) => {
    const cur = Array.isArray(sb[key]) ? sb[key] : [];
    const newAdded = items.filter((x) => !cur.includes(x));
    if (!Array.isArray(ns.added[name]) || !ns.added[name].length) ns.added[name] = newAdded;
    return Array.from(new Set(cur.concat(items)));
  };
  const rollback = (key, items) => {
    const cur = Array.isArray(sb[key]) ? sb[key] : [];
    const added = ns.added[name];
    const drop = new Set(added && added.length ? added : items);
    return cur.filter((x) => !drop.has(x));
  };
  if (name === 'outsideWrite') {
    if (enabled) {
      sb.extraAllowWrite = recordAndMerge('extraAllowWrite', WBS_EXTRA_ALLOW_WRITE);
    } else {
      sb.extraAllowWrite = rollback('extraAllowWrite', WBS_EXTRA_ALLOW_WRITE);
      delete ns.added[name];
    }
  } else if (name === 'commands') {
    if (enabled) {
      sb.excludedCommands = recordAndMerge('excludedCommands', WBS_COMMON_EXCLUDED_CMDS);
    } else {
      sb.excludedCommands = rollback('excludedCommands', WBS_COMMON_EXCLUDED_CMDS);
      delete ns.added[name];
    }
  } else if (name === 'systemTools') {
    if (enabled) {
      sb.excludedCommands = recordAndMerge('excludedCommands', WBS_SYSTEM_LEVEL_TOOLS);
    } else {
      sb.excludedCommands = rollback('excludedCommands', WBS_SYSTEM_LEVEL_TOOLS);
      delete ns.added[name];
    }
  } else if (name === 'bulkDelete') {
    if (enabled) {
      sb.safeDeleteBulkThreshold = 99999;
      if (!sb.dataSecurity || typeof sb.dataSecurity !== 'object') sb.dataSecurity = {};
      sb.dataSecurity.batchDeleteApprovalThreshold = 99999;
      sb.safeDeleteRuntimeEnabled = true;
      if (!sb.fileBackup || typeof sb.fileBackup !== 'object') sb.fileBackup = {};
      sb.fileBackup.enabled = true;
    } else {
      delete sb.safeDeleteBulkThreshold;
      if (sb.dataSecurity && typeof sb.dataSecurity === 'object') delete sb.dataSecurity.batchDeleteApprovalThreshold;
    }
  }
}
function makeNs() {
  return { state: {}, added: {} };
}

// ===== 测试 =====
function freshSettings() {
  // 模拟用户现有配置（含 WorkBuddy UI 写入的键，必须原样保留）
  return {
    enabledPlugins: { 'x-plug': true },
    sandbox: {
      extraAllowWrite: ['~/.custom-user-path'], // 用户手动加的
      excludedCommands: ['git'], // 用户手动加的
    },
    personalization: { customPrompt: '用户自定义指令' },
  };
}

// 1. 开启全部 5 个开关
{
  const s = freshSettings();
  for (const n of WBS_SWITCH_NAMES) applyNoDisturbSwitch(s, makeNs(), n, true);
  // 用户已有项必须保留 + 去重
  assert.ok(s.sandbox.extraAllowWrite.includes('~/.custom-user-path'), '用户 extraAllowWrite 保留');
  assert.ok(s.sandbox.excludedCommands.includes('git'), '用户 excludedCommands 保留');
  assert.ok(s.sandbox.excludedCommands.includes('npm'), 'commands 加入');
  assert.ok(s.sandbox.excludedCommands.includes('wsl'), 'systemTools 加入');
  assert.strictEqual(s.sandbox.safeDeleteBulkThreshold, 99999);
  assert.strictEqual(s.sandbox.dataSecurity.batchDeleteApprovalThreshold, 99999);
  assert.strictEqual(s.sandbox.safeDeleteRuntimeEnabled, true, '批量删除开启必须强制删除保护');
  assert.strictEqual(s.sandbox.fileBackup.enabled, true);
  // 与配置无关的键不能被动到
  assert.deepStrictEqual(s.enabledPlugins, { 'x-plug': true });
  assert.strictEqual(s.personalization.customPrompt, '用户自定义指令');
  console.log('✓ 开启全部开关：映射正确，用户配置保留，删除保护强制开启');
}

// 2. 关闭开关：移除的是我们写入的项，用户项与无关键保留；阈值恢复默认
{
  const s = freshSettings();
  const ns = makeNs(); // 模拟 daemon 持久化的 ns（跨开关复用，added 记录生效）
  for (const n of WBS_SWITCH_NAMES) applyNoDisturbSwitch(s, ns, n, true);
  for (const n of WBS_SWITCH_NAMES) applyNoDisturbSwitch(s, ns, n, false);
  assert.ok(s.sandbox.extraAllowWrite.includes('~/.custom-user-path'), '关闭后用户写路径保留');
  assert.ok(s.sandbox.excludedCommands.includes('git'), '关闭后用户排除命令保留（git 是用户原有项，不得因在清单里被误删）');
  assert.ok(!s.sandbox.excludedCommands.includes('npm'), '关闭后移除常用命令');
  assert.ok(!s.sandbox.excludedCommands.includes('wsl'), '关闭后移除系统工具');
  assert.strictEqual(s.sandbox.safeDeleteBulkThreshold, undefined, '关闭批量删除→阈值键移除');
  assert.ok(s.sandbox.dataSecurity === undefined || !('batchDeleteApprovalThreshold' in s.sandbox.dataSecurity), '批量删除阈值清理');
  console.log('✓ 关闭开关：精确移除新增项，用户数据不受影响');
}

// 3. 幂等：重复开启不重复累积；关闭后可再开
{
  const s = freshSettings();
  const ns = makeNs();
  applyNoDisturbSwitch(s, ns, 'commands', true);
  applyNoDisturbSwitch(s, ns, 'commands', true);
  const n = s.sandbox.excludedCommands.filter((x) => x === 'npm').length;
  assert.strictEqual(n, 1, 'commands 开启两次不累积');
  applyNoDisturbSwitch(s, ns, 'commands', false);
  assert.ok(!s.sandbox.excludedCommands.includes('npm'), '再关闭后移除');
  assert.ok(s.sandbox.excludedCommands.includes('git'), '用户 git 依然保留');
  console.log('✓ 幂等去重 + 关闭后保留用户项正常');
}

// 4. 批量删除关闭：阈值键清理（安全垫 safeDeleteRuntimeEnabled 保留为 CLI 默认）
{
  const s = freshSettings();
  applyNoDisturbSwitch(s, makeNs(), 'bulkDelete', true);
  applyNoDisturbSwitch(s, makeNs(), 'bulkDelete', false);
  assert.strictEqual(s.sandbox.safeDeleteBulkThreshold, undefined);
  assert.ok(s.sandbox.dataSecurity === undefined || !('batchDeleteApprovalThreshold' in s.sandbox.dataSecurity));
  console.log('✓ 批量删除关闭：阈值键清理完成');
}

console.log('\n全部免打扰核心逻辑测试通过 ✅');