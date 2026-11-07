'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LaunchError, fromSystemError } = require('../errors');
const { getJson } = require('../net/http');
const { downloadFile, sha1File } = require('../net/download');
const { libraryKey } = require('./maven');

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._\-+ ]{0,98}[A-Za-z0-9_\-+])?$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Dossiers partagés (cache commun à toutes les instances). */
function layout(root) {
  const r = path.resolve(root);
  return {
    root: r,
    versions: path.join(r, 'versions'),
    libraries: path.join(r, 'libraries'),
    assets: path.join(r, 'assets'),
    runtime: path.join(r, 'runtime'),
    cache: path.join(r, 'cache'),
  };
}

function checkId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id.includes('..') || RESERVED.test(id)) throw new LaunchError('INVALID_OPTION', `nom de version « ${String(id).slice(0, 40)} »`);
  return id;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null; // fichier abîmé : on le retéléchargera
    throw fromSystemError(err, file);
  }
}

async function writeJsonFile(file, data) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const part = `${file}.${crypto.randomBytes(6).toString('hex')}.part`;
    await fsp.writeFile(part, JSON.stringify(data, null, 2), { flag: 'wx' });
    await fsp.rename(part, file);
  } catch (err) {
    throw fromSystemError(err, file);
  }
}

/** Erreur « pas d'Internet » (y compris un portail Wi-Fi captif qui redirige ailleurs). */
function isNetworkError(err) {
  if (!(err instanceof LaunchError)) return false;
  if (['NETWORK', 'TIMEOUT'].includes(err.code)) return true;
  return !!err.redirected && ['INSECURE_URL', 'HOST_NOT_ALLOWED'].includes(err.code);
}

function validManifest(m) {
  return !!(m && typeof m === 'object' && m.latest && typeof m.latest.release === 'string' && Array.isArray(m.versions) &&
    m.versions.every((v) => v && typeof v.id === 'string' && typeof v.url === 'string'));
}

/**
 * Liste des versions Mojang. En ligne : téléchargée et gardée en cache.
 * Hors-ligne (ou Internet coupé) : on relit le cache.
 */
async function getVersionManifest(opts) {
  const L = layout(opts.root);
  const cacheFile = path.join(L.cache, 'version_manifest_v2.json');
  if (!opts.offline) {
    try {
      const data = await getJson(VERSION_MANIFEST_URL, opts.net);
      if (!validManifest(data)) throw new LaunchError('MANIFEST_INVALID', 'liste des versions');
      await writeJsonFile(cacheFile, data);
      return data;
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      const cached = await readJsonFile(cacheFile);
      if (validManifest(cached)) {
        // Internet coupé : on signale que la liste vient du cache (l'appelant passe en hors-ligne).
        Object.defineProperty(cached, 'fromCache', { value: true, enumerable: false });
        return cached;
      }
      throw new LaunchError('OFFLINE', 'liste des versions', { cause: err });
    }
  }
  const cached = await readJsonFile(cacheFile);
  if (!validManifest(cached)) throw new LaunchError('OFFLINE', 'liste des versions jamais téléchargée');
  return cached;
}

/** Résout « latest » / « latest-snapshot » en vrai numéro. */
function resolveAlias(manifest, id) {
  if (id === 'latest' || id === 'release' || id === 'derniere' || id === 'dernière') return manifest.latest.release;
  if (id === 'latest-snapshot' || id === 'snapshot') return manifest.latest.snapshot;
  return id;
}

/**
 * Charge le JSON d'une version (vanilla ou déjà installée), en le
 * téléchargeant et le vérifiant si besoin.
 */
async function loadVersionJson(id, opts) {
  checkId(id);
  const L = layout(opts.root);
  const file = path.join(L.versions, id, `${id}.json`);
  const local = await readJsonFile(file);

  let entry = null;
  if (!opts.offline) {
    try {
      const manifest = opts.manifest || await getVersionManifest(opts);
      entry = manifest.versions.find((v) => v.id === id) || null;
    } catch (err) {
      if (!(err instanceof LaunchError && err.code === 'OFFLINE')) throw err;
    }
  } else if (!local) {
    const manifest = await readJsonFile(path.join(L.cache, 'version_manifest_v2.json'));
    if (manifest && manifest.versions.some((v) => v.id === id)) throw new LaunchError('OFFLINE', id);
  }

  if (entry) {
    if (local && (!entry.sha1 || (await sha1File(file)) === entry.sha1)) return local;
    try {
      await downloadFile({ url: entry.url, path: file, sha1: entry.sha1 }, { ...opts.net, retries: 3 });
    } catch (err) {
      if (isNetworkError(err) && local) return local;
      if (isNetworkError(err)) throw new LaunchError('OFFLINE', id, { cause: err });
      throw err;
    }
    const data = await readJsonFile(file);
    if (!data) throw new LaunchError('MANIFEST_INVALID', id);
    return data;
  }
  if (local) return local;
  throw new LaunchError('VERSION_NOT_FOUND', id);
}

/**
 * Fusionne une version moddée (enfant) avec sa version de base (parent),
 * comme le launcher officiel (« inheritsFrom »).
 */
function mergeVersion(parent, child) {
  const out = { ...parent, ...child };
  delete out.inheritsFrom;
  // Bibliothèques : l'enfant passe d'abord et remplace le même artefact du parent.
  // On ne dédoublonne PAS le parent avec lui-même : Mojang liste parfois deux
  // fois la même bibliothèque avec des règles opposées (ex. lwjgl osx / autres).
  const childLibs = (Array.isArray(child.libraries) ? child.libraries : []).filter((l) => l && typeof l.name === 'string');
  const parentLibs = (Array.isArray(parent.libraries) ? parent.libraries : []).filter((l) => l && typeof l.name === 'string');
  const childKeys = new Set(childLibs.map((l) => libraryKey(l.name) + (l.natives ? ':natives' : '')));
  out.libraries = [...childLibs, ...parentLibs.filter((l) => !childKeys.has(libraryKey(l.name) + (l.natives ? ':natives' : '')))];
  // Arguments modernes : on ajoute ceux de l'enfant à ceux du parent.
  if (parent.arguments || child.arguments) {
    const pa = parent.arguments || {};
    const ca = child.arguments || {};
    out.arguments = {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(ca)])) {
      out.arguments[k] = [...(Array.isArray(pa[k]) ? pa[k] : []), ...(Array.isArray(ca[k]) ? ca[k] : [])];
    }
  }
  // Le jeu de base (jar, sons et textures) vient TOUJOURS de Mojang : un profil
  // de chargeur ne peut pas le remplacer.
  for (const k of ['assetIndex', 'assets', 'downloads']) {
    if (parent[k] !== undefined) out[k] = parent[k]; else delete out[k];
  }
  if (child.javaVersion === undefined && parent.javaVersion !== undefined) out.javaVersion = parent.javaVersion;
  // Un « logging » vide chez l'enfant (Forge 1.12) ne doit pas effacer celui du parent.
  out.logging = child.logging && Object.keys(child.logging).length ? child.logging : parent.logging;
  // Jar du jeu : seulement si l'enfant en nomme un (ancien Forge : « jar: 1.8.9 »).
  // Sinon, comme le launcher officiel, le jar de base est copié sous le nom de
  // la version moddée (Forge récent en a besoin pour ignorer le bon fichier).
  out.jar = child.jar || null;
  out._chain = [...(parent._chain || [parent.id]), child.id];
  return out;
}

/** Charge une version et toute sa chaîne « inheritsFrom ». */
async function resolveVersion(id, opts, depth = 0) {
  if (depth > 8) throw new LaunchError('MANIFEST_INVALID', 'héritage trop profond');
  const data = await loadVersionJson(id, opts);
  if (!data || typeof data !== 'object') throw new LaunchError('MANIFEST_INVALID', id);
  if (data.inheritsFrom) {
    const parent = await resolveVersion(checkId(data.inheritsFrom), opts, depth + 1);
    return mergeVersion(parent, data);
  }
  return { ...data, jar: data.jar || data.id, _chain: [data.id] };
}

module.exports = {
  VERSION_MANIFEST_URL, layout, checkId, getVersionManifest, resolveAlias, loadVersionJson,
  resolveVersion, mergeVersion, readJsonFile, writeJsonFile, isNetworkError,
};
