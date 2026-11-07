'use strict';

/**
 * lanterne-launch : moteur qui télécharge, installe et lance Minecraft
 * (vanilla, Fabric, Quilt, NeoForge, Forge). Zéro dépendance : uniquement Node.js.
 *
 *   const { prepare, install, launch, createControl } = require('lanterne-launch');
 *   const plan = await prepare({ version: '1.21.4', loader: 'fabric', root: dossier });
 *   const c = createControl();
 *   await install(plan, { control: c, onProgress: (p) => console.log(p.percent) });
 *   const jeu = await launch({ plan, account: { type: 'offline', name: 'Steve' } });
 *   jeu.on('journal', console.log); jeu.on('fermeture', (code) => …); jeu.arreter();
 */

const { LaunchError, MESSAGES } = require('./errors');
const { createControl } = require('./net/control');
const { DEFAULT_ALLOWED_HOSTS } = require('./net/http');
const { prepare } = require('./install/plan');
const { install, verify, repair } = require('./install/install');
const { launch } = require('./launch/launch');
const { buildArgs, maskSecrets, offlineUuid } = require('./launch/args');
const { getVersionManifest } = require('./manifest/versions');
const { LOADERS } = require('./loaders');
const { probeJava } = require('./java/runtime');

/** Liste des versions Minecraft (en ligne, ou depuis le cache hors-ligne). */
async function listVersions(opts = {}) {
  const m = await getVersionManifest({ root: opts.root || opts.dossier, offline: !!opts.offline, net: { allowedHosts: opts.allowedHosts } });
  return { latest: m.latest, versions: m.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })) };
}

/** Raccourcis « verifier(version) / reparer(version) » du PDF : options de prepare(). */
async function verifier(opts) { return verify(opts && opts.files ? opts : await prepare({ ...opts, offline: opts.offline })); }
async function reparer(opts, more) { return repair(opts && opts.files ? opts : await prepare(opts), more); }

module.exports = {
  prepare,
  install,
  launch,
  verify: verifier,
  repair: reparer,
  verifier,
  reparer,
  createControl,
  listVersions,
  buildArgs,
  maskSecrets,
  offlineUuid,
  probeJava,
  LaunchError,
  ERROR_MESSAGES: MESSAGES,
  LOADERS,
  DEFAULT_ALLOWED_HOSTS,
};
