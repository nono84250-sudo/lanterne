'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { LaunchError, fromSystemError } = require('../errors');
const { downloadAll, isFileValid, sha1File } = require('../net/download');
const { normalizeControl } = require('../net/control');
const { extractZip } = require('../zip/zip');
const { safeRelPath } = require('../manifest/maven');
const { finishRuntime } = require('../java/runtime');
const { runProcessors, processorsDone } = require('../loaders/processors');
const { checkFiles } = require('./plan');

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
    await extractZip(n.path, dir, { exclude: n.exclude || ['META-INF/'], signal: control && control.signal });
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
    if (await isFileValid({ path: target, sha1: o.hash }, { quick: true })) continue;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(o.path, target);
    } catch (err) { throw fromSystemError(err, target); }
  }
}

async function copyClientJar(plan) {
  const c = plan.copyJar;
  if (!c) return;
  if (await isFileValid({ path: c.to, sha1: c.sha1, size: c.size }, { quick: false })) return;
  try {
    await fsp.mkdir(path.dirname(c.to), { recursive: true });
    await fsp.copyFile(c.from, c.to + '.part');
    await fsp.rename(c.to + '.part', c.to);
  } catch (err) { throw fromSystemError(err, c.to); }
}

/** Tout ce qui suit les téléchargements. */
async function finish(plan, control, onLog) {
  if (plan.java && plan.java.runtime) await finishRuntime(plan.java.runtime);
  await copyClientJar(plan);
  await extractNatives(plan, control);
  await materializeAssets(plan);
  if (plan.forge) {
    await runProcessors(plan, { javaPath: plan.java.executable, control, onLog });
  }
  for (const g of plan.generated) {
    if (!(await isFileValid(g, { quick: true }))) throw new LaunchError('NOT_INSTALLED', path.basename(g.path));
  }
  try { await fsp.mkdir(plan.gameDir, { recursive: true }); } catch (err) { throw fromSystemError(err, plan.gameDir); }
}

function readOpts(opts = {}) {
  // Noms du PDF : { annuler, progression }
  const control = normalizeControl({ control: opts.control || (opts.annuler && opts.annuler.cancel ? opts.annuler : undefined), signal: opts.signal || (opts.annuler instanceof AbortSignal ? opts.annuler : undefined) });
  return { control, onProgress: opts.onProgress || opts.progression, onLog: opts.onLog || opts.journal, concurrency: opts.concurrency };
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
  const result = await downloadAll(plan.missing, { control, onProgress, concurrency, allowedHosts: plan.allowedHosts, timeout: opts.timeout, retries: opts.retries });
  await finish(plan, control, onLog);
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
  return { ok: damaged.length === 0 && processorsOk, damaged, checked: plan.files.length, processorsOk };
}

/** « Réparer le jeu » : ne retélécharge que les fichiers abîmés. */
async function repair(plan, opts = {}) {
  const { control, onProgress, onLog, concurrency } = readOpts(opts);
  const { damaged, processorsOk } = await verify(plan);
  for (const f of damaged) await fsp.rm(f.path, { force: true }).catch(() => {});
  if (!processorsOk && plan.forge) await fsp.rm(path.join(plan.root, 'versions', plan.id, '.lanterne-processed.json'), { force: true }).catch(() => {});
  await fsp.rm(path.join(nativesDir(plan), '.lanterne-natives'), { force: true }).catch(() => {});
  if (damaged.length && plan.offline) throw new LaunchError('OFFLINE', `${damaged.length} fichier(s) abîmé(s) à retélécharger`);
  await downloadAll(damaged, { control, onProgress, concurrency, allowedHosts: plan.allowedHosts });
  await finish(plan, control, onLog);
  return { repaired: damaged.length, files: damaged.map((f) => f.path) };
}

module.exports = { install, verify, repair, nativesDir, extractNatives, sha1File };
