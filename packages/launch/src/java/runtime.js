'use strict';

/**
 * Java automatique : le Java exact demandé par Mojang pour chaque version
 * (8, 17, 21, 25…), téléchargé depuis les serveurs Mojang, comme le launcher officiel.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LaunchError, fromSystemError } = require('../errors');
const { getJson } = require('../net/http');
const { downloadFile } = require('../net/download');
const { readJsonFile, writeJsonFile, isNetworkError } = require('../manifest/versions');
const { safeRelPath } = require('../manifest/maven');

const RUNTIME_INDEX_URL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9\-_.]{0,63}$/;

/** Clé de plateforme Mojang pour cet ordinateur. */
function runtimePlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'x64' ? 'windows-x64' : arch === 'ia32' ? 'windows-x86' : arch === 'arm64' ? 'windows-arm64' : null;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : arch === 'x64' ? 'mac-os' : null;
  if (platform === 'linux') return arch === 'x64' ? 'linux' : arch === 'ia32' ? 'linux-i386' : null;
  return null;
}

/** Chemin de l'exécutable Java dans un runtime installé. */
function javaExecutable(dir, platform = process.platform) {
  if (platform === 'win32') return path.join(dir, 'bin', 'javaw.exe');
  if (platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(dir, 'bin', 'java');
}

/** Composant Java voulu par une version (les très vieilles n'en disent rien : Java 8). */
function componentFor(version) {
  const c = version && version.javaVersion && version.javaVersion.component;
  return typeof c === 'string' && SAFE_COMPONENT.test(c) ? c : 'jre-legacy';
}

/**
 * Prépare la liste des fichiers du Java voulu.
 * @returns {Promise<{component: string, platform: string, dir: string, executable: string,
 *   files: Array<any>, links: Array<{path: string, target: string}>, executables: string[], dirs: string[]}>}
 */
async function planRuntime(component, opts) {
  if (!SAFE_COMPONENT.test(component)) throw new LaunchError('MANIFEST_INVALID', 'composant Java');
  let platform = opts.platformKey || runtimePlatform();
  if (!platform) throw new LaunchError('JAVA_UNSUPPORTED', `${process.platform} ${process.arch}`);
  const base = path.join(opts.runtimeDir, component);
  const manifestCache = path.join(base, `${platform}.manifest.json`);

  let manifest = null;
  if (!opts.offline) {
    try {
      const index = await getJson(RUNTIME_INDEX_URL, opts.net);
      let entries = index[platform] && index[platform][component];
      // Mac Apple : certains vieux Java n'existent qu'en Intel (Rosetta).
      if ((!entries || !entries.length) && platform === 'mac-os-arm64') {
        platform = 'mac-os';
        entries = index[platform] && index[platform][component];
      }
      if (!entries || !entries.length) throw new LaunchError('JAVA_UNSUPPORTED', `${component} pour ${platform}`);
      const m = entries[0].manifest;
      const file = path.join(base, `${platform}.manifest.json`);
      await downloadFile({ url: m.url, path: file, sha1: m.sha1, size: m.size }, { ...opts.net, retries: 3 });
      manifest = await readJsonFile(file);
    } catch (err) {
      if (!isNetworkError(err)) throw err;
    }
  }
  if (!manifest) manifest = await readJsonFile(path.join(base, `${platform}.manifest.json`)) || await readJsonFile(manifestCache);
  if (!manifest || typeof manifest.files !== 'object') throw new LaunchError('OFFLINE', `Java ${component} jamais téléchargé`);

  const dir = path.join(base, platform);
  const files = [];
  const links = [];
  const executables = [];
  const dirs = [];
  for (const [rel, info] of Object.entries(manifest.files)) {
    const safe = safeRelPath(rel);
    const abs = path.join(dir, ...safe.split('/'));
    if (info.type === 'directory') dirs.push(abs);
    else if (info.type === 'file') {
      const raw = info.downloads && info.downloads.raw;
      if (!raw || !raw.url) throw new LaunchError('MANIFEST_INVALID', `Java ${rel}`);
      files.push({ url: raw.url, path: abs, sha1: raw.sha1, size: raw.size, stage: 'java' });
      if (info.executable) executables.push(abs);
    } else if (info.type === 'link' && typeof info.target === 'string') {
      links.push({ path: abs, target: info.target });
    }
  }
  return { component, platform, dir, executable: javaExecutable(dir), files, links, executables, dirs };
}

/** Après téléchargement : droits d'exécution et liens internes (jamais vers l'extérieur). */
async function finishRuntime(rt) {
  for (const d of rt.dirs) {
    try { await fsp.mkdir(d, { recursive: true }); } catch (err) { throw fromSystemError(err, d); }
  }
  if (process.platform !== 'win32') {
    for (const f of rt.executables) {
      try { await fsp.chmod(f, 0o755); } catch (err) { throw fromSystemError(err, f); }
    }
    const root = path.resolve(rt.dir);
    for (const l of rt.links) {
      const resolved = path.resolve(path.dirname(l.path), l.target);
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel) || path.isAbsolute(l.target)) continue; // lien qui sort : ignoré
      try {
        await fsp.mkdir(path.dirname(l.path), { recursive: true });
        await fsp.rm(l.path, { force: true });
        await fsp.symlink(l.target, l.path);
      } catch (err) { throw fromSystemError(err, l.path); }
    }
  }
}

/**
 * Vérifie qu'un Java démarre et renvoie sa version majeure.
 * Lancé avec une liste d'arguments (pas de ligne de commande interprétée).
 */
function probeJava(javaPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try {
      // java -version écrit sur stderr ; java.exe plutôt que javaw.exe pour lire la sortie.
      const exe = process.platform === 'win32' ? javaPath.replace(/javaw\.exe$/i, 'java.exe') : javaPath;
      child = spawn(exe, ['-version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new LaunchError('JAVA_MISSING', javaPath, { cause: err }));
    }
    const t = setTimeout(() => { child.kill(); reject(new LaunchError('JAVA_FAILED', 'délai dépassé')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => { clearTimeout(t); reject(new LaunchError(err.code === 'ENOENT' ? 'JAVA_MISSING' : 'JAVA_FAILED', javaPath, { cause: err })); });
    child.on('close', (code) => {
      clearTimeout(t);
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      if (code !== 0 || !m) return reject(new LaunchError('JAVA_FAILED', `code ${code}`));
      const major = m[1] === '1' ? Number(m[2]) : Number(m[1]);
      resolve({ major, output: out.trim().split(/\r?\n/)[0] });
    });
  });
}

module.exports = { RUNTIME_INDEX_URL, runtimePlatform, javaExecutable, componentFor, planRuntime, finishRuntime, probeJava };
