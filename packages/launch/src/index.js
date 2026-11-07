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

const { LaunchError, MESSAGES, wrap } = require('./errors');
const { createControl } = require('./net/control');
const { DEFAULT_ALLOWED_HOSTS } = require('./net/http');
const { prepare } = require('./install/plan');
const { install, verify, repair } = require('./install/install');
const { launch, anonymize } = require('./launch/launch');
const { extractZip, readZipEntry } = require('./zip/zip');
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
// Accepte un plan, des options de prepare(), ou (version, options).
async function toPlan(a, b) {
  if (a && typeof a === 'object' && Array.isArray(a.files)) return a;
  if (typeof a === 'string') return prepare({ ...(b || {}), version: a });
  return prepare(a || {});
}
async function verifier(a, b) { return verify(await toPlan(a, b)); }
async function reparer(a, b) {
  const plan = await toPlan(a, b);
  return repair(plan, typeof a === 'string' ? b : (a && Array.isArray(a.files) ? b : { ...(a || {}), ...(b || {}) }));
}

const api = {
  prepare: wrap(prepare),
  install: wrap(install),
  launch: wrap(launch),
  verify: wrap(verifier),
  repair: wrap(reparer),
  listVersions: wrap(listVersions),
};

module.exports = {
  ...api,
  verifier: api.verify,
  reparer: api.repair,
  createControl,
  buildArgs,
  maskSecrets,
  /** Retire pseudo, UUID, xuid et dossier personnel d'un texte (journaux d'installation à envoyer au support). */
  anonymiser: anonymize,
  anonymize,
  /** Extracteur ZIP sûr (refuse ../, liens, bombes…). */
  extractZip: wrap(extractZip),
  readZipEntry: wrap(readZipEntry),
  offlineUuid,
  probeJava,
  LaunchError,
  ERROR_MESSAGES: MESSAGES,
  LOADERS,
  DEFAULT_ALLOWED_HOSTS,
};
