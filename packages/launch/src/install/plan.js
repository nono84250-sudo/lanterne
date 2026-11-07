'use strict';

/**
 * prepare() : calcule TOUT ce qu'il faut pour une version (rien de gros n'est
 * téléchargé, seulement les petits fichiers d'information), et ce qui manque.
 */

const path = require('node:path');
const { LaunchError } = require('../errors');
const { rulesAllow, currentPlatform } = require('../manifest/rules');
const { parseMaven, safeRelPath } = require('../manifest/maven');
const { layout, getVersionManifest, resolveAlias, resolveVersion, readJsonFile, checkId, isNetworkError } = require('../manifest/versions');
const { downloadFile, isFileValid } = require('../net/download');
const { ensureLoader, normalizeLoader, fixRepoUrl } = require('../loaders');
const { componentFor, planRuntime } = require('../java/runtime');

const RESOURCES_URL = 'https://resources.download.minecraft.net/';
const SAFE_HASH = /^[0-9a-f]{40}$/;

function natiivesClassifier(lib, plat) {
  const c = lib.natives && lib.natives[plat.name];
  if (!c) return null;
  return String(c).replace('${arch}', plat.arch === 'x86' ? '32' : '64');
}

/**
 * Liste des bibliothèques à utiliser sur cet ordinateur.
 * @returns {Array<{name: string, path: string, url: string|null, sha1?: string, size?: number,
 *          native: boolean, classpath: boolean, exclude?: string[]}>}
 */
function resolveLibraries(version, L, plat, features) {
  const out = [];
  for (const lib of version.libraries || []) {
    if (!lib || typeof lib.name !== 'string') continue;
    if (!rulesAllow(lib.rules, { os: plat, features })) continue;
    const dl = lib.downloads || {};
    if (lib.natives) {
      const classifier = natiivesClassifier(lib, plat);
      if (classifier) {
        let a = dl.classifiers && dl.classifiers[classifier];
        if (!a) {
          const m = parseMaven(`${lib.name}:${classifier}`);
          a = { path: m.path, url: fixRepoUrl(lib.url) + m.path, sha1: lib.sha1 };
        }
        out.push(entry(lib.name + ':' + classifier, a, L, { native: true, classpath: false, exclude: (lib.extract && lib.extract.exclude) || ['META-INF/'] }));
      }
      if (dl.artifact) out.push(entry(lib.name, dl.artifact, L, { native: false, classpath: true }));
      continue;
    }
    if (dl.artifact) {
      out.push(entry(lib.name, dl.artifact, L, { native: false, classpath: true }));
    } else if (!lib.downloads) {
      const m = parseMaven(lib.name);
      out.push(entry(lib.name, { path: m.path, url: fixRepoUrl(lib.url) + m.path, sha1: lib.sha1, size: lib.size }, L, { native: false, classpath: true }));
    }
  }
  return out;
}

function entry(name, a, L, extra) {
  const rel = safeRelPath(a.path || parseMaven(name).path);
  const sha1 = typeof a.sha1 === 'string' && SAFE_HASH.test(a.sha1.toLowerCase()) ? a.sha1.toLowerCase() : undefined;
  return {
    name,
    path: path.join(L.libraries, ...rel.split('/')),
    url: a.url ? String(a.url) : null,
    sha1,
    size: typeof a.size === 'number' ? a.size : undefined,
    sha1Alt: Array.isArray(a.sha1Alt) ? a.sha1Alt.filter((h) => SAFE_HASH.test(h)) : undefined,
    ...extra,
  };
}

async function loadAssetIndex(version, L, opts) {
  const ai = version.assetIndex;
  if (!ai || typeof ai.id !== 'string') return { id: version.assets || 'legacy', objects: {}, file: null, info: null };
  const id = checkId(ai.id);
  const file = path.join(L.assets, 'indexes', `${id}.json`);
  const info = { url: ai.url, path: file, sha1: ai.sha1, size: ai.size, stage: 'sons et textures' };
  if (!(await isFileValid(info))) {
    if (opts.offline) throw new LaunchError('OFFLINE', `index des sons et textures ${id}`);
    try {
      await downloadFile(info, { ...opts.net, control: opts.control });
    } catch (err) {
      if (isNetworkError(err)) throw new LaunchError('OFFLINE', `index ${id}`, { cause: err });
      throw err;
    }
  }
  const data = await readJsonFile(file);
  if (!data || typeof data.objects !== 'object') throw new LaunchError('MANIFEST_INVALID', `index ${id}`);
  return { id, objects: data.objects, virtual: !!data.virtual, mapToResources: !!data.map_to_resources, file, info };
}

/**
 * @param {object} opts
 * @param {string} opts.version      « 1.21.4 », « latest »…
 * @param {string} [opts.loader]     vanilla | fabric | quilt | forge | neoforge
 * @param {string} [opts.loaderVersion]
 * @param {string} opts.root         dossier commun (cache partagé) — alias « dossier »
 * @param {string} [opts.gameDir]    dossier de l'instance (sauvegardes, mods…)
 * @param {boolean} [opts.offline]   ne jamais aller sur Internet
 * @param {'auto'|string} [opts.java] 'auto' (défaut) ou chemin d'un Java
 * @param {string[]} [opts.allowedHosts]
 */
async function prepare(opts = {}) {
  const root = opts.root || opts.dossier;
  if (!root || typeof root !== 'string') throw new LaunchError('INVALID_OPTION', 'dossier (root) manquant');
  if (!opts.version) throw new LaunchError('INVALID_OPTION', 'version manquante');
  const L = layout(root);
  const net = { allowedHosts: opts.allowedHosts, timeout: opts.timeout, signal: opts.control ? opts.control.signal : opts.signal };
  const ctx = { root: L.root, offline: !!opts.offline, net, control: opts.control };
  const plat = currentPlatform();
  const loader = normalizeLoader(opts.loader);

  let mcVersion = String(opts.version);
  if (!opts.offline) {
    try {
      ctx.manifest = await getVersionManifest(ctx);
      mcVersion = resolveAlias(ctx.manifest, mcVersion);
      if (!ctx.manifest.versions.some((v) => v.id === mcVersion)) {
        // Peut être un profil moddé déjà installé (ex. « fabric-loader-…-1.21.4 »).
        const local = await readJsonFile(path.join(L.versions, checkId(mcVersion), `${mcVersion}.json`));
        if (!local) throw new LaunchError('VERSION_NOT_FOUND', mcVersion);
      }
    } catch (err) {
      if (!(err instanceof LaunchError && err.code === 'OFFLINE')) throw err;
      ctx.offline = true; // Internet coupé : on continue avec ce qui est déjà là
    }
  }
  if (ctx.offline && /^(latest|release|snapshot|latest-snapshot|derni[eè]re)$/.test(mcVersion)) {
    const cached = await readJsonFile(path.join(L.cache, 'version_manifest_v2.json'));
    if (!cached) throw new LaunchError('OFFLINE', 'dernière version inconnue');
    mcVersion = resolveAlias(cached, mcVersion);
  }
  checkId(mcVersion);

  const ld = await ensureLoader({ loader, mcVersion, loaderVersion: opts.loaderVersion, ...ctx });
  const version = await resolveVersion(ld.versionId, ctx);
  const baseId = version._chain[0];
  const id = ld.versionId;

  const files = [];
  // 1. Le jeu (jar client de la version de base).
  const client = version.downloads && version.downloads.client;
  const baseJar = path.join(L.versions, baseId, `${baseId}.jar`);
  if (client && client.url) files.push({ url: client.url, path: baseJar, sha1: client.sha1, size: client.size, stage: 'jeu' });
  let clientJar = baseJar;
  let copyJar = null;
  if (id !== baseId) {
    const jarId = checkId(version.jar && version.jar !== id ? version.jar : id);
    if (jarId === id) {
      // Comme le launcher officiel : copie du jar de base sous le nom de la version moddée.
      clientJar = path.join(L.versions, id, `${id}.jar`);
      copyJar = { from: baseJar, to: clientJar, sha1: client && client.sha1, size: client && client.size };
    } else {
      clientJar = path.join(L.versions, jarId, `${jarId}.jar`);
    }
  }

  // 2. Librairies (+ natives).
  const features = {};
  const libraries = resolveLibraries(version, L, plat, features);
  const generated = [];
  for (const lib of libraries) {
    if (lib.url) files.push({ url: lib.url, path: lib.path, sha1: lib.sha1, sha1Alt: lib.sha1Alt, size: lib.size, stage: 'librairies' });
    else generated.push(lib); // fourni par l'installeur du chargeur
  }
  if (ld.forge) {
    for (const lib of resolveLibraries({ libraries: ld.forge.libraries }, L, plat, features)) {
      if (lib.url) files.push({ url: lib.url, path: lib.path, sha1: lib.sha1, size: lib.size, stage: 'chargeur' });
    }
  }

  // 3. Sons et textures (cache partagé).
  const assetIndex = await loadAssetIndex(version, L, ctx);
  const assetObjects = [];
  for (const [name, obj] of Object.entries(assetIndex.objects)) {
    const hash = obj && String(obj.hash || '').toLowerCase();
    if (!SAFE_HASH.test(hash)) throw new LaunchError('MANIFEST_INVALID', `asset ${name}`);
    const sub = hash.slice(0, 2);
    const p = path.join(L.assets, 'objects', sub, hash);
    assetObjects.push({ name, hash, path: p });
    files.push({ url: `${RESOURCES_URL}${sub}/${hash}`, path: p, sha1: hash, size: obj.size, stage: 'sons et textures' });
  }

  // 4. Configuration des journaux (log4j, corrige la faille Log4Shell).
  let logging = null;
  const lc = version.logging && version.logging.client;
  if (lc && lc.file && lc.file.url && typeof lc.argument === 'string') {
    const lid = safeRelPath(String(lc.file.id || 'client.xml'));
    logging = { argument: lc.argument, path: path.join(L.assets, 'log_configs', lid.replace(/\//g, '_')) };
    files.push({ url: lc.file.url, path: logging.path, sha1: lc.file.sha1, size: lc.file.size, stage: 'jeu' });
  }

  // 5. Java automatique (inclus d'office), sauf si un Java est donné.
  let java;
  if (opts.java && opts.java !== 'auto') {
    java = { component: null, executable: path.resolve(String(opts.java)), auto: false };
  } else {
    const component = componentFor(version);
    const rt = await planRuntime(component, { runtimeDir: L.runtime, offline: ctx.offline, net });
    files.push(...rt.files);
    java = { component, executable: rt.executable, dir: rt.dir, auto: true, runtime: rt };
  }

  // Ce qui manque (vérification rapide par la taille ; « verify » contrôle tout).
  const missing = [];
  const seen = new Set();
  const unique = [];
  for (const f of files) {
    const k = path.resolve(f.path);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(f);
  }
  await checkFiles(unique, missing, { quick: !opts.fullCheck });
  const totalBytes = missing.reduce((s, f) => s + (f.size || 0), 0);

  return {
    id,
    mcVersion,
    loader,
    loaderVersion: ld.loaderVersion,
    root: L.root,
    gameDir: path.resolve(opts.gameDir || opts.dossierInstance || L.root),
    offline: ctx.offline,
    allowedHosts: opts.allowedHosts,
    version,
    clientJar,
    copyJar,
    libraries,
    generated,
    forge: ld.forge || null,
    assetIndex: { id: assetIndex.id, virtual: assetIndex.virtual, mapToResources: assetIndex.mapToResources, objects: assetObjects },
    logging,
    java,
    files: unique,
    missing,
    totalBytes,
    count: missing.length,
    // Noms du PDF
    get taille() { return this.totalBytes; },
    get tailleMo() { return +(this.totalBytes / 1048576).toFixed(1); },
    get fichiers() { return this.count; },
  };
}

async function checkFiles(files, missing, opts) {
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const f = files[i++];
      if (!(await isFileValid(f, opts))) missing.push(f);
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, worker));
}

module.exports = { prepare, resolveLibraries, checkFiles, RESOURCES_URL };
