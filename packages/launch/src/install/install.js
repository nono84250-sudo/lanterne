'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { LaunchError, fromSystemError } = require('../errors');
const { downloadAll, isFileValid, sha1File, safeLog } = require('../net/download');
const { normalizeControl } = require('../net/control');
const { extractZip } = require('../zip/zip');
const { safeRelPath } = require('../manifest/maven');
const { finishRuntime } = require('../java/runtime');
const { runProcessors, processorsDone } = require('../loaders/processors');
const { checkFiles } = require('./plan');

const NATIVE_LIMITS = { maxEntries: 5000, maxEntrySize: 64 * 1024 * 1024, maxTotalSize: 256 * 1024 * 1024 };

function nativesDir(plan) {
  return path.join(plan.root, 'versions', plan.id, 'natives');
}

/** Extrait les natives (anciennes versions) avec l'extracteur ZIP sûr. */
async function extractNatives(plan, control) {
  const dir = nativesDir(plan);
  const natives = plan.libraries.filter((l) => l.native);
  await fsp.mkdir(dir, { recursive: true }).catch((err) => { throw fromSystemError(err, dir); });
  const marker = path.join(dir, '.lanterne-natives');
  const want = natives.map((n) => `${n.name}@${n.sha1 || ''}`).sort().join('\n');
  try { if ((await fsp.readFile(marker, 'utf8')) === want) return dir; } catch { /* à faire */ }
  for (const n of natives) {
    // Les natives sont de petites archives : limites bien plus basses que par défaut.
    await extractZip(n.path, dir, {
      exclude: n.exclude || ['META-INF/'],
      signal: control && control.signal,
      limits: NATIVE_LIMITS,
    });
  }
  await fsp.writeFile(marker, want).catch((err) => { throw fromSystemError(err, marker); });
  return dir;
}

/** Très vieilles versions : sons et textures copiés sous leur vrai nom. */
async function materializeAssets(plan) {
  const ai = plan.assetIndex;
  if (!ai.virtual && !ai.mapToResources) return;
  const base = ai.mapToResources ? path.join(plan.gameDir, 'resources') : path.join(plan.root, 'assets', 'virtual', ai.id);
  for (const o of ai.objects) {
    const rel = safeRelPath(o.name);
    const target = path.join(base, ...rel.split('/'));
    const st = await fsp.lstat(target).catch(() => null);
    if (st && !st.isSymbolicLink() && st.isFile() && (await isFileValid({ path: target, sha1: o.hash, size: o.size }, { quick: true }))) continue;
    if (st && (st.isSymbolicLink() || !st.isFile())) {
      if (st.isDirectory()) throw new LaunchError('FILESYSTEM', `dossier à la place de ${rel}`);
      await fsp.unlink(target).catch((err) => { throw fromSystemError(err, target); }); // jamais écrire à travers un lien
    }
    await safeCopy(o.path, target);
  }
}

/** Copie sûre : vers un .part au nom aléatoire créé en exclusif (jamais via un lien), puis renommage. */
async function safeCopy(from, to) {
  const part = `${to}.${crypto.randomBytes(6).toString('hex')}.part`;
  try {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, part, fs.constants.COPYFILE_EXCL);
    await fsp.rename(part, to);
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw fromSystemError(err, to);
  }
}

async function copyClientJar(plan) {
  const c = plan.copyJar;
  if (!c) return;
  const st = await fsp.lstat(c.to).catch(() => null);
  if (st && st.isFile() && (await isFileValid({ path: c.to, sha1: c.sha1, size: c.size }, { quick: false }))) return;
  if (st && !st.isDirectory()) await fsp.unlink(c.to).catch(() => {});
  await safeCopy(c.from, c.to);
}

/** Tout ce qui suit les téléchargements. */
async function finish(plan, control, onLog, onProgress) {
  const log = safeLog(onLog);
  const step = (stage, message) => {
    log(`[lanceur] ${message}`);
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, etape: stage, phase: 'finish', message, percent: 100, pourcentage: 100 }); } catch { /* l'appelant ne doit pas casser l'installation */ }
    }
  };
  if (plan.java && plan.java.runtime) { step('java', 'Préparation de Java'); await finishRuntime(plan.java.runtime); }
  if (plan.copyJar) { step('jeu', 'Copie du jeu pour le chargeur'); await copyClientJar(plan); }
  step('natives', 'Extraction des bibliothèques natives');
  await extractNatives(plan, control);
  step('sons et textures', 'Mise en place des sons et textures');
  await materializeAssets(plan);
  if (plan.forge && plan.forge.processors && plan.forge.processors.length) {
    step('chargeur', `Installation de ${plan.loader} (peut prendre une minute)`);
    await runProcessors(plan, { javaPath: plan.java.executable, control, onLog: log });
  }
  for (const g of plan.generated) {
    if (!(await isFileValid(g, { quick: true }))) throw new LaunchError('NOT_INSTALLED', path.basename(g.path));
  }
  try { await fsp.mkdir(plan.gameDir, { recursive: true }); } catch (err) { throw fromSystemError(err, plan.gameDir); }
}

function readOpts(opts = {}) {
  // Noms du PDF : { annuler, progression }
  const control = normalizeControl({ control: opts.control || (opts.annuler && opts.annuler.cancel ? opts.annuler : undefined), signal: opts.signal || (opts.annuler instanceof AbortSignal ? opts.annuler : undefined) });
  const onLog = opts.onLog || opts.journal;
  return { control, onProgress: opts.onProgress || opts.progression, onLog: onLog ? safeLog(onLog) : undefined, concurrency: opts.concurrency };
}

/**
 * Installe ce qui manque dans le plan.
 * @param {object} plan  résultat de prepare()
 * @param {{control?: object, signal?: AbortSignal, onProgress?: Function, onLog?: Function, concurrency?: number}} [opts]
 */
async function install(plan, opts = {}) {
  const { control, onProgress, onLog, concurrency } = readOpts(opts);
  if (plan.missing.length && plan.offline) {
    throw new LaunchError('OFFLINE', `${plan.missing.length} fichier(s) à télécharger`);
  }
  if (typeof onLog === 'function') onLog(`[lanceur] Installation de ${plan.id} : ${plan.missing.length} fichier(s) à télécharger`);
  const result = await downloadAll(plan.missing, { control, onProgress, onLog, concurrency, allowedHosts: plan.allowedHosts, timeout: opts.timeout, retries: opts.retries });
  await finish(plan, control, onLog, onProgress);
  plan.missing = [];
  plan.totalBytes = 0;
  plan.count = 0;
  return result;
}

/**
 * Vérifie chaque fichier (empreinte SHA-1 complète).
 * @returns {Promise<{ok: boolean, damaged: Array<any>, checked: number}>}
 */
async function verify(plan) {
  const damaged = [];
  await checkFiles(plan.files, damaged, { quick: false });
  const processorsOk = await processorsDone(plan);
  // Copie du jeu pour le chargeur et fichiers produits par l'installeur.
  const extra = [];
  if (plan.copyJar && !(await isFileValid({ path: plan.copyJar.to, sha1: plan.copyJar.sha1, size: plan.copyJar.size }))) extra.push(plan.copyJar.to);
  for (const g of plan.generated || []) {
    if (!(await isFileValid(g))) extra.push(g.path);
  }
  const ok = damaged.length === 0 && processorsOk && extra.length === 0;
  return { ok, damaged, checked: plan.files.length, processorsOk, incomplete: extra };
}

/** « Réparer le jeu » : ne retélécharge que les fichiers abîmés. */
async function repair(plan, opts = {}) {
  const { control, onProgress, onLog, concurrency } = readOpts(opts);
  const { damaged, processorsOk, incomplete } = await verify(plan);
  // Hors-ligne : on ne supprime rien qu'on ne pourrait pas retélécharger.
  const genBad = (plan.generated || []).filter((g) => incomplete.includes(g.path));
  if ((damaged.length || genBad.length) && plan.offline) throw new LaunchError('OFFLINE', `${damaged.length + genBad.length} fichier(s) abîmé(s) à retélécharger`);
  for (const f of damaged) await fsp.rm(f.path, { force: true }).catch(() => {});
  if (plan.copyJar && incomplete.includes(plan.copyJar.to)) await fsp.rm(plan.copyJar.to, { force: true }).catch(() => {});
  if (!processorsOk && plan.forge) await fsp.rm(path.join(plan.root, 'versions', plan.id, '.lanterne-processed.json'), { force: true }).catch(() => {});
  await fsp.rm(path.join(nativesDir(plan), '.lanterne-natives'), { force: true }).catch(() => {});
  if (genBad.length) {
    // Fichiers fournis par l'installeur du chargeur : on les supprime et on les ressort de l'installeur vérifié.
    for (const g of genBad) await fsp.rm(g.path, { force: true }).catch(() => {});
    await fsp.rm(path.join(plan.root, 'versions', plan.id, '.lanterne-processed.json'), { force: true }).catch(() => {});
    if (plan.loader === 'forge' || plan.loader === 'neoforge') {
      await fsp.rm(path.join(plan.root, 'versions', plan.id, '.lanterne-loader.json'), { force: true }).catch(() => {});
      const { ensureLoader } = require('../loaders');
      await ensureLoader({
        loader: plan.loader, mcVersion: plan.mcVersion, loaderVersion: plan.loaderVersion, root: plan.root, offline: plan.offline,
        net: { allowedHosts: plan.allowedHosts, timeout: opts.timeout, signal: control.signal }, control,
      });
    }
  }
  await downloadAll(damaged, { control, onProgress, onLog, concurrency, allowedHosts: plan.allowedHosts, timeout: opts.timeout, retries: opts.retries });
  await finish(plan, control, onLog, onProgress);
  return { repaired: damaged.length, files: damaged.map((f) => f.path) };
}

module.exports = { install, verify, repair, nativesDir, extractNatives, sha1File, NATIVE_LIMITS };
