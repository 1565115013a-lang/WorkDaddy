'use strict';

const fs = require('fs');
const path = require('path');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function emptyTarget(configured = false, source = 'default') {
  return { configured, binary: '', version: '', source };
}

function readWorkBuddyTarget({ dataDir, profileId, env = process.env } = {}) {
  const envBinary = clean(env.WBSWITCH_WORKBUDDY_BIN);
  const envVersion = clean(env.WBSWITCH_WORKBUDDY_VERSION);
  if (envBinary) {
    return { configured: true, binary: envBinary, version: envVersion, source: 'environment' };
  }

  if (!dataDir) return emptyTarget();
  const targetFile = path.join(dataDir, 'workbuddy-target.json');
  let raw;
  try {
    raw = fs.readFileSync(targetFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyTarget();
    return emptyTarget(true, 'file');
  }

  let target;
  try {
    target = JSON.parse(raw);
  } catch (_) {
    return emptyTarget(true, 'file');
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return emptyTarget(true, 'file');
  }

  const configuredProfile = clean(target.profileId || target.profile);
  if (configuredProfile && profileId && configuredProfile !== clean(profileId)) {
    return emptyTarget(true, 'file');
  }
  return {
    configured: true,
    binary: clean(target.binary || target.executable || target.path),
    version: envVersion || clean(target.version),
    source: 'file',
  };
}

module.exports = { readWorkBuddyTarget };
