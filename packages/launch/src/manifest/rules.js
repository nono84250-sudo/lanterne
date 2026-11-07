'use strict';

const os = require('node:os');

/** Système courant au format Mojang. */
function currentPlatform() {
  const p = process.platform;
  const name = p === 'win32' ? 'windows' : p === 'darwin' ? 'osx' : 'linux';
  const a = process.arch;
  const arch = a === 'x64' ? 'x86_64' : a === 'ia32' ? 'x86' : a === 'arm64' ? 'arm64' : a;
  return { name, arch, version: os.release() };
}

/** Convertit un « arch » Mojang (x86, arm64…) pour comparer avec le nôtre. */
function archMatches(ruleArch, arch) {
  if (ruleArch === arch) return true;
  if (ruleArch === 'x86' && arch === 'x86') return true;
  if (ruleArch === 'x86_64' && arch === 'x86_64') return true;
  if (ruleArch === 'arm64' && arch === 'arm64') return true;
  return false;
}

function safeRegexTest(pattern, value) {
  if (typeof pattern !== 'string' || pattern.length > 200) return false;
  try { return new RegExp(pattern).test(value); } catch { return false; }
}

/** Compare deux versions « 10.0.17134 » morceau par morceau. */
function compareDotted(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** versionRange {min, max} (nouveau format Mojang 26.x) : min inclus, max exclu. */
function inVersionRange(range, version) {
  if (!range || typeof range !== 'object') return true;
  if (range.min && compareDotted(version, range.min) < 0) return false;
  if (range.max && compareDotted(version, range.max) >= 0) return false;
  return true;
}

/**
 * Applique une liste de règles Mojang.
 * @param {Array<any>|undefined} rules
 * @param {{os?: {name: string, arch: string, version?: string}, features?: Record<string, boolean>}} ctx
 */
function rulesAllow(rules, ctx = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const plat = ctx.os || currentPlatform();
  const features = ctx.features || {};
  let allowed = false;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== plat.name) match = false;
      if (rule.os.arch && !archMatches(rule.os.arch, plat.arch)) match = false;
      if (rule.os.version && !safeRegexTest(rule.os.version, plat.version || '')) match = false;
      if (rule.os.versionRange && !inVersionRange(rule.os.versionRange, plat.version || '')) match = false;
    }
    if (rule.features && typeof rule.features === 'object') {
      for (const [k, v] of Object.entries(rule.features)) {
        if (Boolean(features[k]) !== Boolean(v)) { match = false; break; }
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

module.exports = { currentPlatform, rulesAllow, compareDotted, inVersionRange };
