'use strict';

/**
 * Chargeurs de mods : Fabric, Quilt, NeoForge, Forge.
 * Chaque chargeur produit un JSON de version « moddé » qui hérite de la
 * version de base (inheritsFrom), enregistré dans versions/<id>/<id>.json.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { LaunchError, fromSystemError } = require('../errors');
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
  // Ancien Forge : empreintes listées dans « checksums » (l'une d'elles doit correspondre).
  const alts = Array.isArray(lib.checksums) ? lib.checksums.filter((c) => typeof c === 'string' && /^[0-9a-f]{40}$/i.test(c)).map((c) => c.toLowerCase()) : [];
  if (!sha1 && alts.length) sha1 = alts.shift();
  if (!sha1) throw new LaunchError('INTEGRITY', `pas d'empreinte publiée pour ${lib.name}`);
  const artifact = { path: m.path, url, sha1 };
  if (alts.length) artifact.sha1Alt = alts;
  if (typeof lib.size === 'number') artifact.size = lib.size;
  const out = { name: lib.name, downloads: { artifact } };
  if (lib.rules) out.rules = lib.rules;
  return out;
}

async function completeLibraries(libs, net, concurrency = 8, known = {}) {
  const out = new Array(libs.length);
  let i = 0;
  const worker = async () => {
    while (i < libs.length) {
      const k = i++;
      const lib = libs[k];
      // Empreinte déjà connue (installation précédente) : pas besoin d'Internet.
      const pre = lib && typeof lib.name === 'string' && !lib.sha1 && typeof known[lib.name] === 'string' ? { ...lib, sha1: known[lib.name] } : lib;
      out[k] = await completeLibrary(pre, net);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, libs.length) }, worker));
  return out;
}

/** Cherche un profil déjà installé (pour le mode hors-ligne). */
async function findInstalled(root, test, accept) {
  const L = layout(root);
  let names = [];
  try { names = await fsp.readdir(L.versions); } catch { return null; }
  const matches = names.filter(test).sort((a, b) => compareDotted(b.replace(/[^0-9.]/g, '.'), a.replace(/[^0-9.]/g, '.')));
  for (const n of matches) {
    const j = await readJsonFile(path.join(L.versions, n, `${n}.json`));
    if (!j) continue;
    if (accept && !(await accept(n))) continue;
    return n;
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
  if (mc === '1.20.1') {
    // NeoForge 1.20.1 : publié sous l'ancien nom « net.neoforged:forge ».
    const xml1 = await getText(`${NEOFORGE_MAVEN}net/neoforged/forge/maven-metadata.xml`, net);
    const all1 = mavenVersions(xml1).filter((v) => v.startsWith('1.20.1-'));
    if (!all1.length) throw new LaunchError('LOADER_NOT_FOUND', 'NeoForge pour 1.20.1');
    const lv1 = loaderVersion || all1.map((v) => v.slice(7)).sort(compareDotted).pop();
    const full1 = `1.20.1-${lv1}`;
    if (!all1.includes(full1)) throw new LaunchError('LOADER_NOT_FOUND', `NeoForge ${lv1} pour 1.20.1`);
    return { full: full1, lv: lv1, installerUrl: `${NEOFORGE_MAVEN}net/neoforged/forge/${full1}/forge-${full1}-installer.jar` };
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

/** Groupes maven qu'un installeur a le droit de poser depuis son dossier « maven/ ». */
function ownGroups(kind) {
  return kind === 'forge' ? ['net/minecraftforge/'] : ['net/neoforged/'];
}

/**
 * Lit l'installeur (sans rien écrire) : profil, version.json, processeurs.
 * @returns {Promise<{version: object, legacy: object|null, forge: object}>}
 */
async function readInstaller(kind, info, installerPath, zip) {
  const profileBuf = await zip.readEntry('install_profile.json', 8 * 1024 * 1024);
  if (!profileBuf) throw new LaunchError('LOADER_INSTALL_FAILED', 'install_profile.json absent');
  let profile;
  try { profile = JSON.parse(profileBuf.toString('utf8')); } catch { throw new LaunchError('LOADER_INSTALL_FAILED', 'install_profile.json illisible'); }
  if (!profile || typeof profile !== 'object') throw new LaunchError('LOADER_INSTALL_FAILED', 'install_profile.json');
  const forge = { kind, installerPath, processors: [], data: {}, libraries: [], mc: info.mc, full: info.full };
  if (profile.install && profile.versionInfo) {
    // Ancien format (Forge 1.5 → 1.12.2 ancien) : versionInfo + jar « universal » dans l'installeur.
    const coord = parseMaven(String(profile.install.path));
    if (!coord.path.startsWith('net/minecraftforge/')) throw new LaunchError('LOADER_INSTALL_FAILED', 'jar universal hors de Forge');
    return { version: profile.versionInfo, legacy: { coord, filePath: safeRelPath(String(profile.install.filePath)), name: profile.install.path }, forge };
  }
  const jsonPath = safeRelPath(String(profile.json || '/version.json').replace(/^\//, ''));
  const vbuf = await zip.readEntry(jsonPath, 8 * 1024 * 1024);
  if (!vbuf) throw new LaunchError('LOADER_INSTALL_FAILED', 'version.json absent');
  let version;
  try { version = JSON.parse(vbuf.toString('utf8')); } catch { throw new LaunchError('LOADER_INSTALL_FAILED', 'version.json illisible'); }
  forge.libraries = Array.isArray(profile.libraries) ? profile.libraries : [];
  forge.processors = (Array.isArray(profile.processors) ? profile.processors : []).filter((p) => p && typeof p.jar === 'string' && (!Array.isArray(p.sides) || p.sides.includes('client')));
  forge.data = profile.data && typeof profile.data === 'object' ? profile.data : {};
  return { version, legacy: null, forge };
}

async function installForgeLike(kind, mc, loaderVersion, opts) {
  const L = layout(opts.root);
  const markerName = (id) => path.join(L.versions, id, '.lanterne-loader.json');
  // NeoForge 1.20.1 porte les mêmes numéros que Forge 47.1.x : identifiant local distinct.
  const localId = (versionId) => (kind === 'neoforge' && mc === '1.20.1' ? `neoforge-${versionId}` : versionId);
  const installerFile = (full) => path.join(L.cache, 'installers', `${kind}-${full}-installer.jar`);

  /** Résultat à partir d'une installation déjà faite (marqueur + installeur intact). */
  const fromMarker = async (id) => {
    const marker = await readJsonFile(markerName(id));
    if (!marker || marker.loader !== kind || typeof marker.full !== 'string' || !SAFE_LOADER_VERSION.test(marker.full)) return null;
    const installerPath = installerFile(marker.full);
    if (!marker.installerSha1 || (await sha1File(installerPath)) !== marker.installerSha1) return null;
    if (!(await readJsonFile(path.join(L.versions, id, `${id}.json`)))) return null;
    // Les processeurs sont relus dans l'installeur vérifié (jamais pris dans un fichier local).
    const zip = await openZip(installerPath);
    try {
      const r = await readInstaller(kind, { mc, full: marker.full }, installerPath, zip);
      r.forge.libraries = await completeLibraries(r.forge.libraries, opts.net, 8, marker.librarySha1 || {});
      return { versionId: id, loaderVersion: marker.loaderVersion, forge: r.forge.processors.length ? r.forge : null };
    } finally {
      await zip.close();
    }
  };
  const offlineFind = async () => {
    let found = null;
    await findInstalled(opts.root, (n) => kind === 'forge'
      ? (n.startsWith(`${mc}-forge`) && (!loaderVersion || n.includes(loaderVersion)))
      : mc === '1.20.1'
        ? (n.startsWith('neoforge-1.20.1-forge-') && (!loaderVersion || n.endsWith(loaderVersion)))
        : (n.startsWith('neoforge-') && n.slice(9).startsWith(loaderVersion || neoforgePrefix(mc))),
    async (n) => { found = await fromMarker(n); return !!found; });
    return found;
  };
  if (opts.offline) {
    const r = await offlineFind();
    if (!r) throw new LaunchError('OFFLINE', `${kind} ${mc} jamais installé`);
    return r;
  }
  let info;
  let sha1;
  try {
    info = await resolveForgeVersion(kind, mc, loaderVersion, opts.net);
    if (!SAFE_LOADER_VERSION.test(info.full) || !SAFE_LOADER_VERSION.test(String(info.lv)) || info.full.includes('..')) {
      throw new LaunchError('LOADER_NOT_FOUND', 'numéro de version du chargeur invalide');
    }
    info.mc = mc;
    sha1 = await fetchSha1(info.installerUrl, opts.net);
  } catch (err) {
    if (isNetworkError(err)) {
      const r = await offlineFind();
      if (r) return r;
      throw new LaunchError('OFFLINE', `${kind} ${mc}`, { cause: err });
    }
    throw err;
  }
  if (!sha1) throw new LaunchError('INTEGRITY', `pas d'empreinte publiée pour l'installeur ${kind}`);

  // 1. L'installeur officiel (vérifié par son empreinte publiée).
  const installerPath = installerFile(info.full);
  const rel = path.relative(L.cache, installerPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new LaunchError('LOADER_NOT_FOUND', 'chemin d\'installeur invalide');
  if ((await sha1File(installerPath)) !== sha1) {
    await downloadFile({ url: info.installerUrl, path: installerPath, sha1 }, { ...opts.net, control: opts.control });
  }

  // 2. Déjà installé avec ce même installeur ? On ne refait rien (et on ne touche à
  //    aucun fichier qu'une instance en cours pourrait utiliser).
  const zip = await openZip(installerPath);
  try {
    const { version, legacy, forge } = await readInstaller(kind, info, installerPath, zip);
    if (!version || typeof version.id !== 'string') throw new LaunchError('LOADER_INSTALL_FAILED', 'profil sans nom');
    const id = checkId(localId(version.id));
    const marker = await readJsonFile(markerName(id));
    if (marker && marker.loader === kind && marker.installerSha1 === sha1 && (await readJsonFile(path.join(L.versions, id, `${id}.json`)))) {
      forge.libraries = await completeLibraries(forge.libraries, opts.net, 8, marker.librarySha1 || {});
      return { versionId: id, loaderVersion: marker.loaderVersion, forge: forge.processors.length ? forge : null };
    }

    const tmpDir = path.join(L.cache, 'tmp', `${kind}-${info.full}-${process.pid}`);
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      if (legacy) {
        // Jar universal → libraries/<chemin maven de Forge>.
        const target = path.join(L.libraries, ...legacy.coord.path.split('/'));
        const entry = zip.getEntry(legacy.filePath);
        if (!entry) throw new LaunchError('LOADER_INSTALL_FAILED', 'jar universal absent');
        await zip.extractTo(tmpDir, { filter: (n) => n === legacy.filePath });
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.rename(path.join(tmpDir, ...legacy.filePath.split('/')), target);
        const universalSha1 = await sha1File(target);
        const libs = [];
        for (const lib of Array.isArray(version.libraries) ? version.libraries : []) {
          if (!lib || typeof lib.name !== 'string') continue;
          if (lib.clientreq === false) continue;
          if (lib.name === legacy.name) {
            libs.push({ name: lib.name, downloads: { artifact: { path: legacy.coord.path, url: '', sha1: universalSha1, size: entry.uncompressedSize } } });
            continue;
          }
          const clean = { name: lib.name, url: lib.url, checksums: lib.checksums };
          if (lib.rules) clean.rules = lib.rules;
          if (lib.natives) { clean.natives = lib.natives; clean.extract = lib.extract; }
          libs.push(clean);
        }
        version.libraries = await completeLibraries(libs.filter((l) => !l.natives), opts.net);
        version.libraries.push(...libs.filter((l) => l.natives));
      } else {
        // Bibliothèques embarquées (dossier maven/) : seulement celles du chargeur
        // lui-même, et sans écraser une bibliothèque partagée valide.
        const groups = ownGroups(kind);
        await zip.extractTo(tmpDir, { strip: 'maven/', filter: (n) => groups.some((g) => n.startsWith(g)) });
        for (const f of await listFiles(tmpDir)) {
          const relp = path.relative(tmpDir, f);
          const target = path.join(L.libraries, relp);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.rename(f, target).catch(async (err) => {
            // Fichier verrouillé (instance en cours sous Windows) mais identique : on le garde.
            if ((await sha1File(target)) === (await sha1File(f))) return;
            throw err;
          });
        }
        version.libraries = await completeLibraries(Array.isArray(version.libraries) ? version.libraries : [], opts.net);
        forge.libraries = await completeLibraries(forge.libraries, opts.net);
      }
    } catch (err) {
      throw err instanceof LaunchError ? err : fromSystemError(err, tmpDir);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    version.id = id;
    version.inheritsFrom = version.inheritsFrom || mc;
    delete version._comment_;
    version._lanterne = { loader: kind, loaderVersion: info.lv, complete: true };
    await writeJsonFile(path.join(L.versions, id, `${id}.json`), version);
    // Empreintes des bibliothèques des processeurs, pour pouvoir réinstaller hors-ligne.
    const librarySha1 = {};
    for (const l of forge.libraries) if (l.downloads && l.downloads.artifact && l.downloads.artifact.sha1) librarySha1[l.name] = l.downloads.artifact.sha1;
    await writeJsonFile(markerName(id), { loader: kind, loaderVersion: info.lv, full: info.full, installerSha1: sha1, librarySha1 });
    return { versionId: id, loaderVersion: info.lv, forge: forge.processors.length ? forge : null };
  } finally {
    await zip.close();
  }
}

async function listFiles(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  try { await walk(dir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return out;
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
