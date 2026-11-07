'use strict';

/**
 * Chargeurs de mods : Fabric, Quilt, NeoForge, Forge.
 * Chaque chargeur produit un JSON de version « moddé » qui hérite de la
 * version de base (inheritsFrom), enregistré dans versions/<id>/<id>.json.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { LaunchError } = require('../errors');
const { getJson, getText } = require('../net/http');
const { downloadFile, sha1File } = require('../net/download');
const { layout, checkId, readJsonFile, writeJsonFile, isNetworkError } = require('../manifest/versions');
const { parseMaven, safeRelPath } = require('../manifest/maven');
const { compareDotted } = require('../manifest/rules');
const { openZip } = require('../zip/zip');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/';
const MOJANG_LIBRARIES = 'https://libraries.minecraft.net/';

const SAFE_LOADER_VERSION = /^[A-Za-z0-9._\-+]{1,64}$/;

function normalizeLoader(loader) {
  const l = String(loader || 'vanilla').toLowerCase().replace(/[\s_-]/g, '');
  if (l === '' || l === 'vanilla' || l === 'none') return 'vanilla';
  if (LOADERS.includes(l)) return l;
  throw new LaunchError('INVALID_OPTION', `chargeur « ${String(loader).slice(0, 30)} »`);
}

function checkLoaderVersion(v) {
  if (v === undefined || v === null || v === '' || v === 'latest' || v === 'recommended') return null;
  if (!SAFE_LOADER_VERSION.test(String(v))) throw new LaunchError('INVALID_OPTION', 'version du chargeur');
  return String(v);
}

/** Corrige les vieilles adresses Forge (http, ancien site) vers le maven officiel en https. */
function fixRepoUrl(url) {
  if (!url) return MOJANG_LIBRARIES;
  let u = String(url).trim();
  u = u.replace(/^http:\/\//i, 'https://');
  u = u.replace(/^https:\/\/files\.minecraftforge\.net\/maven\/?/i, FORGE_MAVEN);
  if (!u.endsWith('/')) u += '/';
  return u;
}

/** Lit l'empreinte « .sha1 » publiée à côté d'un fichier sur un dépôt maven. */
async function fetchSha1(url, net) {
  try {
    const txt = (await getText(url + '.sha1', { ...net, maxBytes: 4096 })).trim();
    const m = /^([0-9a-fA-F]{40})\b/.exec(txt);
    return m ? m[1].toLowerCase() : null;
  } catch (err) {
    if (err instanceof LaunchError && err.code === 'HTTP_STATUS' && err.status === 404) return null;
    throw err;
  }
}

/**
 * Bibliothèque « maven » (nom + url de dépôt, sans downloads) → format complet
 * avec empreinte SHA-1 (lue sur le dépôt si absente), pour que tout soit vérifiable.
 */
async function completeLibrary(lib, net) {
  if (lib.downloads && (lib.downloads.artifact || lib.downloads.classifiers)) return lib;
  const m = parseMaven(lib.name);
  const url = fixRepoUrl(lib.url) + m.path;
  let sha1 = typeof lib.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(lib.sha1) ? lib.sha1.toLowerCase() : null;
  if (!sha1) sha1 = await fetchSha1(url, net);
  if (!sha1) throw new LaunchError('INTEGRITY', `pas d'empreinte publiée pour ${lib.name}`);
  const artifact = { path: m.path, url, sha1 };
  if (typeof lib.size === 'number') artifact.size = lib.size;
  const out = { name: lib.name, downloads: { artifact } };
  if (lib.rules) out.rules = lib.rules;
  return out;
}

async function completeLibraries(libs, net, concurrency = 8) {
  const out = new Array(libs.length);
  let i = 0;
  const worker = async () => {
    while (i < libs.length) {
      const k = i++;
      out[k] = await completeLibrary(libs[k], net);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, libs.length) }, worker));
  return out;
}

/** Cherche un profil déjà installé (pour le mode hors-ligne). */
async function findInstalled(root, test) {
  const L = layout(root);
  let names = [];
  try { names = await fsp.readdir(L.versions); } catch { return null; }
  const matches = names.filter(test).sort((a, b) => compareDotted(b.replace(/[^0-9.]/g, '.'), a.replace(/[^0-9.]/g, '.')));
  for (const n of matches) {
    const j = await readJsonFile(path.join(L.versions, n, `${n}.json`));
    if (j) return n;
  }
  return null;
}

// ---------------------------------------------------------------- Fabric / Quilt

async function installFabricLike(kind, mc, loaderVersion, opts) {
  const meta = kind === 'fabric' ? FABRIC_META : QUILT_META;
  const prefix = kind === 'fabric' ? 'fabric-loader-' : 'quilt-loader-';
  const offlineFind = () => findInstalled(opts.root, (n) => n.startsWith(prefix) && n.endsWith('-' + mc) && (!loaderVersion || n === `${prefix}${loaderVersion}-${mc}`));
  if (opts.offline) {
    const id = await offlineFind();
    if (!id) throw new LaunchError('OFFLINE', `${kind} ${mc} jamais installé`);
    return { versionId: id, loaderVersion: id.slice(prefix.length, -(mc.length + 1)) };
  }
  try {
    let lv = loaderVersion;
    if (!lv) {
      const list = await getJson(`${meta}/versions/loader/${encodeURIComponent(mc)}`, opts.net);
      if (!Array.isArray(list) || list.length === 0) throw new LaunchError('LOADER_NOT_FOUND', `${kind} pour ${mc}`);
      const versions = list.map((x) => x && x.loader).filter(Boolean);
      const pick = kind === 'fabric'
        ? (versions.find((x) => x.stable) || versions[0])
        : (versions.find((x) => !/[-+]/.test(x.version)) || versions[0]);
      lv = checkLoaderVersion(pick.version);
    }
    let profile;
    try {
      profile = await getJson(`${meta}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(lv)}/profile/json`, opts.net);
    } catch (err) {
      if (err instanceof LaunchError && err.code === 'HTTP_STATUS' && (err.status === 404 || err.status === 400)) throw new LaunchError('LOADER_NOT_FOUND', `${kind} ${lv} pour ${mc}`);
      throw err;
    }
    if (!profile || typeof profile.id !== 'string' || !Array.isArray(profile.libraries)) throw new LaunchError('MANIFEST_INVALID', kind);
    const id = checkId(profile.id);
    const L = layout(opts.root);
    const file = path.join(L.versions, id, `${id}.json`);
    const existing = await readJsonFile(file);
    if (existing && existing._lanterne && existing._lanterne.complete) return { versionId: id, loaderVersion: lv };
    profile.libraries = await completeLibraries(profile.libraries, opts.net);
    profile.inheritsFrom = profile.inheritsFrom || mc;
    profile._lanterne = { loader: kind, loaderVersion: lv, complete: true };
    await writeJsonFile(file, profile);
    return { versionId: id, loaderVersion: lv };
  } catch (err) {
    if (isNetworkError(err)) {
      const id = await offlineFind();
      if (id) return { versionId: id, loaderVersion: id.slice(prefix.length, -(mc.length + 1)) };
      throw new LaunchError('OFFLINE', `${kind} ${mc}`, { cause: err });
    }
    throw err;
  }
}

// ---------------------------------------------------------------- Forge / NeoForge

function mavenVersions(xml) {
  return [...String(xml).matchAll(/<version>([^<]{1,80})<\/version>/g)].map((m) => m[1]);
}

/** NeoForge : 1.21.11 → « 21.11. », 1.21 → « 21.0. », 26.3 → « 26.3.0. », 26.3.1 → « 26.3.1. » */
function neoforgePrefix(mc) {
  const p = mc.split('.');
  if (p[0] === '1') return `${p[1]}.${p[2] || '0'}.`;
  return `${p[0]}.${p[1] || '0'}.${p[2] || '0'}.`;
}

async function resolveForgeVersion(kind, mc, loaderVersion, net) {
  if (kind === 'forge') {
    const xml = await getText(`${FORGE_MAVEN}net/minecraftforge/forge/maven-metadata.xml`, net);
    const all = mavenVersions(xml).filter((v) => v.startsWith(mc + '-'));
    if (!all.length) throw new LaunchError('LOADER_NOT_FOUND', `Forge pour ${mc}`);
    let lv = loaderVersion;
    if (!lv) {
      const promos = await getJson(FORGE_PROMOS, net);
      lv = promos && promos.promos && (promos.promos[`${mc}-recommended`] || promos.promos[`${mc}-latest`]);
      if (!lv) lv = all.map((v) => v.slice(mc.length + 1).split('-')[0]).sort(compareDotted).pop();
    }
    const full = all.find((v) => v === `${mc}-${lv}` || v.startsWith(`${mc}-${lv}-`));
    if (!full) throw new LaunchError('LOADER_NOT_FOUND', `Forge ${lv} pour ${mc}`);
    return { full, lv, installerUrl: `${FORGE_MAVEN}net/minecraftforge/forge/${full}/forge-${full}-installer.jar` };
  }
  const xml = await getText(`${NEOFORGE_MAVEN}net/neoforged/neoforge/maven-metadata.xml`, net);
  const prefix = neoforgePrefix(mc);
  const all = mavenVersions(xml).filter((v) => v.startsWith(prefix));
  if (!all.length) throw new LaunchError('LOADER_NOT_FOUND', `NeoForge pour ${mc}`);
  let lv = loaderVersion;
  if (!lv) {
    const stable = all.filter((v) => !/-(beta|alpha|rc)/i.test(v));
    lv = (stable.length ? stable : all).sort((a, b) => compareDotted(a.split('-')[0], b.split('-')[0])).pop();
  }
  if (!all.includes(lv)) throw new LaunchError('LOADER_NOT_FOUND', `NeoForge ${lv} pour ${mc}`);
  return { full: lv, lv, installerUrl: `${NEOFORGE_MAVEN}net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar` };
}

async function installForgeLike(kind, mc, loaderVersion, opts) {
  const L = layout(opts.root);
  const markerName = (id) => path.join(L.versions, id, '.lanterne-loader.json');
  const offlineFind = async () => {
    const id = await findInstalled(opts.root, (n) => kind === 'forge'
      ? (n.startsWith(`${mc}-forge`) && (!loaderVersion || n.includes(loaderVersion)))
      : (n.startsWith('neoforge-') && n.slice(9).startsWith(loaderVersion || neoforgePrefix(mc))));
    if (!id) return null;
    const marker = await readJsonFile(markerName(id));
    return marker ? { versionId: id, loaderVersion: marker.loaderVersion, forge: marker.forge } : null;
  };
  if (opts.offline) {
    const r = await offlineFind();
    if (!r) throw new LaunchError('OFFLINE', `${kind} ${mc} jamais installé`);
    return r;
  }
  let info;
  try {
    info = await resolveForgeVersion(kind, mc, loaderVersion, opts.net);
  } catch (err) {
    if (isNetworkError(err)) {
      const r = await offlineFind();
      if (r) return r;
      throw new LaunchError('OFFLINE', `${kind} ${mc}`, { cause: err });
    }
    throw err;
  }

  // 1. L'installeur officiel (vérifié par son empreinte publiée).
  const installerPath = path.join(L.cache, 'installers', `${kind}-${info.full}-installer.jar`);
  const sha1 = await fetchSha1(info.installerUrl, opts.net);
  if (!sha1) throw new LaunchError('INTEGRITY', `pas d'empreinte publiée pour l'installeur ${kind}`);
  if ((await sha1File(installerPath)) !== sha1) {
    await downloadFile({ url: info.installerUrl, path: installerPath, sha1 }, { ...opts.net, control: opts.control });
  }

  // 2. Lecture du profil d'installation.
  const zip = await openZip(installerPath);
  try {
    const profileBuf = await zip.readEntry('install_profile.json', 8 * 1024 * 1024);
    if (!profileBuf) throw new LaunchError('LOADER_INSTALL_FAILED', 'install_profile.json absent');
    let profile;
    try { profile = JSON.parse(profileBuf.toString('utf8')); } catch { throw new LaunchError('LOADER_INSTALL_FAILED', 'install_profile.json illisible'); }

    let version;
    const forge = { kind, installerPath, processors: [], data: {}, libraries: [], mc, full: info.full };

    if (profile.install && profile.versionInfo) {
      // Ancien format (Forge 1.5 → 1.12.2 ancien) : versionInfo + jar « universal » dans l'installeur.
      version = profile.versionInfo;
      const coord = parseMaven(profile.install.path);
      const filePath = safeRelPath(profile.install.filePath);
      const target = path.join(L.libraries, ...coord.path.split('/'));
      const entry = zip.getEntry(filePath);
      if (!entry) throw new LaunchError('LOADER_INSTALL_FAILED', 'jar universal absent');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const tmpDir = path.join(L.cache, 'tmp', `${kind}-${info.full}`);
      await fsp.rm(tmpDir, { recursive: true, force: true });
      await zip.extractTo(tmpDir, { filter: (n) => n === filePath });
      await fsp.rename(path.join(tmpDir, ...filePath.split('/')), target);
      await fsp.rm(tmpDir, { recursive: true, force: true });
      const universalSha1 = await sha1File(target);
      const libs = [];
      for (const lib of version.libraries || []) {
        if (!lib || typeof lib.name !== 'string') continue;
        if (lib.clientreq === false) continue;
        if (lib.name === profile.install.path) {
          libs.push({ name: lib.name, downloads: { artifact: { path: coord.path, url: '', sha1: universalSha1, size: entry.uncompressedSize } } });
          continue;
        }
        const clean = { name: lib.name, url: lib.url };
        if (lib.rules) clean.rules = lib.rules;
        if (lib.natives) { clean.natives = lib.natives; clean.extract = lib.extract; }
        libs.push(lib.natives ? lib : clean);
      }
      version.libraries = await completeLibraries(libs.filter((l) => !l.natives), opts.net);
      version.libraries.push(...libs.filter((l) => l.natives));
    } else {
      // Format moderne (spec 0/1) : version.json + bibliothèques + « processeurs ».
      const jsonPath = safeRelPath(String(profile.json || '/version.json').replace(/^\//, ''));
      const vbuf = await zip.readEntry(jsonPath, 8 * 1024 * 1024);
      if (!vbuf) throw new LaunchError('LOADER_INSTALL_FAILED', 'version.json absent');
      try { version = JSON.parse(vbuf.toString('utf8')); } catch { throw new LaunchError('LOADER_INSTALL_FAILED', 'version.json illisible'); }
      // Les bibliothèques embarquées dans l'installeur (dossier maven/).
      await zip.extractTo(L.libraries, { strip: 'maven/' });
      version.libraries = await completeLibraries(version.libraries || [], opts.net);
      forge.libraries = await completeLibraries(profile.libraries || [], opts.net);
      forge.processors = (profile.processors || []).filter((p) => !p.sides || p.sides.includes('client'));
      forge.data = profile.data || {};
    }

    if (!version || typeof version.id !== 'string') throw new LaunchError('LOADER_INSTALL_FAILED', 'profil sans nom');
    const id = checkId(version.id);
    version.inheritsFrom = version.inheritsFrom || mc;
    delete version._comment_;
    version._lanterne = { loader: kind, loaderVersion: info.lv, complete: true };
    await writeJsonFile(path.join(L.versions, id, `${id}.json`), version);
    const result = { versionId: id, loaderVersion: info.lv, forge: forge.processors.length ? forge : null };
    await writeJsonFile(markerName(id), result);
    return result;
  } finally {
    await zip.close();
  }
}

/**
 * Installe (métadonnées seulement) le chargeur voulu et renvoie l'id de version à lancer.
 * @returns {Promise<{versionId: string, loaderVersion: string|null, forge?: any}>}
 */
async function ensureLoader({ loader, mcVersion, loaderVersion, ...opts }) {
  const kind = normalizeLoader(loader);
  const lv = checkLoaderVersion(loaderVersion);
  if (kind === 'vanilla') return { versionId: mcVersion, loaderVersion: null };
  if (kind === 'fabric' || kind === 'quilt') return installFabricLike(kind, mcVersion, lv, opts);
  return installForgeLike(kind, mcVersion, lv, opts);
}

module.exports = { LOADERS, ensureLoader, normalizeLoader, fixRepoUrl, neoforgePrefix, completeLibrary, mavenVersions };
