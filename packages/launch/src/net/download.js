'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LaunchError, fromSystemError, isCancel } = require('../errors');
const { secureGet } = require('./http');
const { normalizeControl, createControl } = require('./control');

const DEFAULT_MAX_UNKNOWN_SIZE = 1024 * 1024 * 1024; // 1 Go si la taille n'est pas annoncée

/** Empreinte SHA-1 d'un fichier (lecture en flux). null si absent. */
async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  try {
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) hash.update(chunk);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw fromSystemError(err, file);
  }
  return hash.digest('hex');
}

/**
 * Le fichier est-il présent et correct ?
 * @param {{path: string, sha1?: string, size?: number}} f
 * @param {{quick?: boolean}} [opts] quick = taille seulement (vérif rapide)
 */
async function isFileValid(f, opts = {}) {
  let st;
  try { st = await fsp.stat(f.path); } catch { return false; }
  if (!st.isFile()) return false;
  if (typeof f.size === 'number' && f.size >= 0 && st.size !== f.size) return false;
  if (opts.quick || !f.sha1) return true;
  return hashMatches(f, await sha1File(f.path));
}

/** L'empreinte correspond-elle (ou une des empreintes acceptées) ? */
function hashMatches(f, digest) {
  if (!f.sha1) return true;
  if (!digest) return false;
  if (digest === f.sha1.toLowerCase()) return true;
  return Array.isArray(f.sha1Alt) && f.sha1Alt.some((h) => String(h).toLowerCase() === digest);
}

function isRetryable(err) {
  if (!(err instanceof LaunchError)) return true;
  if (err.code === 'HTTP_STATUS') return !err.status || err.status >= 500 || err.status === 429 || err.status === 408;
  return ['NETWORK', 'TIMEOUT', 'INTEGRITY'].includes(err.code);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => { clearTimeout(t); reject(new LaunchError('CANCELLED')); };
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

const SAFE_SHA1 = /^[0-9a-f]{40}$/;

function checkHash(file) {
  const h = typeof file.sha1 === 'string' ? file.sha1.toLowerCase() : '';
  if (!SAFE_SHA1.test(h)) throw new LaunchError('INTEGRITY', `pas d'empreinte SHA-1 valable pour ${path.basename(String(file.path))}`, { file: file.path });
  return h;
}

/** Le .part ne doit jamais être un lien (sinon on écrirait ailleurs). */
async function preparePart(part, expectedSize) {
  let st = null;
  try { st = await fsp.lstat(part); } catch { /* absent */ }
  if (st && (!st.isFile() || st.isSymbolicLink())) {
    await fsp.rm(part, { force: true, recursive: false }).catch(() => {});
    if (st.isDirectory()) throw new LaunchError('FILESYSTEM', `dossier à la place de ${path.basename(part)}`);
    st = null;
  }
  if (st && st.size > 0 && (expectedSize === null || st.size < expectedSize)) return { offset: st.size, ino: st.ino };
  if (st) await fsp.rm(part, { force: true }).catch(() => {});
  return { offset: 0, ino: null };
}

/**
 * Télécharge UN fichier : https + sites autorisés, écriture dans .part,
 * reprise (Range) si un .part existe, contrôle taille + SHA-1, puis renommage.
 * L'empreinte SHA-1 est obligatoire.
 *
 * @param {{url: string, path: string, sha1: string, sha1Alt?: string[], size?: number}} file
 */
async function downloadOnce(file, opts = {}) {
  const control = normalizeControl(opts);
  const onBytes = opts.onBytes || (() => {});
  const expectedSha1 = checkHash(file);
  const expectedSize = Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null;
  const maxBytes = expectedSize ?? (opts.maxBytes || DEFAULT_MAX_UNKNOWN_SIZE);
  const part = file.path + '.part';

  try { await fsp.mkdir(path.dirname(file.path), { recursive: true }); } catch (err) { throw fromSystemError(err, path.dirname(file.path)); }

  let { offset, ino } = await preparePart(part, expectedSize);
  await control.wait();
  const headers = offset > 0 ? { range: `bytes=${offset}-` } : {};
  const r = await secureGet(file.url, { allowedHosts: opts.allowedHosts, timeout: opts.timeout, signal: control.signal, headers });
  const { res } = r;
  let fh = null;
  let counted = 0;
  const deadline = Date.now() + (opts.maxDuration || 30 * 60 * 1000);
  try {
    let append = false;
    if (offset > 0 && res.status === 206) {
      const cr = res.headers.get('content-range') || '';
      const m = /^bytes (\d+)-/.exec(cr);
      if (m && Number(m[1]) === offset) append = true;
      else {
        await fsp.rm(part, { force: true }).catch(() => {});
        throw new LaunchError('NETWORK', 'reprise refusée par le serveur', { url: r.url });
      }
    } else if (res.status === 416 && offset > 0) {
      // Le .part est déjà complet (ou faux) : on repart de zéro à la prochaine tentative.
      await fsp.rm(part, { force: true }).catch(() => {});
      throw new LaunchError('NETWORK', 'reprise impossible, nouvel essai', { url: r.url });
    } else if (res.status !== 200) {
      throw new LaunchError('HTTP_STATUS', `${res.status} ${new URL(r.url).host}`, { url: r.url, status: res.status });
    }
    if (!append) offset = 0;

    const hash = crypto.createHash('sha1');
    let written = 0;
    try {
      if (append) {
        fh = await fsp.open(part, fs.constants.O_RDWR | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
        const st = await fh.stat();
        if (!st.isFile() || (ino !== null && st.ino !== ino)) throw new LaunchError('FILESYSTEM', `${path.basename(part)} remplacé pendant la reprise`);
        // On relit le début déjà téléchargé pour l'empreinte.
        const buf = Buffer.alloc(1 << 20);
        let pos = 0;
        while (pos < offset) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, offset - pos), pos);
          if (!bytesRead) break;
          hash.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
        written = offset;
        onBytes(offset);
        counted += offset;
      } else {
        await fsp.rm(part, { force: true }).catch(() => {});
        // Création exclusive : échoue si un fichier ou un lien est apparu entre-temps.
        fh = await fsp.open(part, 'wx', 0o644);
      }
    } catch (err) { throw err instanceof LaunchError ? err : fromSystemError(err, part); }

    try {
      for await (const chunk of res.body) {
        r.tick();
        if (control.paused) {
          r.hold(); // le délai réseau ne court pas pendant une pause
          await control.wait();
          r.tick();
        }
        if (control.cancelled) throw new LaunchError('CANCELLED');
        if (Date.now() > deadline) throw new LaunchError('TIMEOUT', `${path.basename(file.path)} trop long à télécharger`, { url: r.url });
        written += chunk.length;
        if (written > maxBytes) throw new LaunchError(expectedSize !== null ? 'INTEGRITY' : 'TOO_LARGE', `${path.basename(file.path)} plus gros que prévu`, { url: r.url, file: file.path });
        hash.update(chunk);
        try {
          await fh.write(chunk);
        } catch (err) { throw fromSystemError(err, part); }
        onBytes(chunk.length);
        counted += chunk.length;
      }
    } catch (err) {
      if (err instanceof LaunchError) throw err;
      throw r.mapError(err);
    }
    try { await fh.close(); } catch (err) { throw fromSystemError(err, part); }
    fh = null;

    if (expectedSize !== null && written !== expectedSize) {
      if (written > expectedSize) await fsp.rm(part, { force: true }).catch(() => {});
      throw new LaunchError(written < expectedSize ? 'NETWORK' : 'INTEGRITY', `${path.basename(file.path)} incomplet (${written}/${expectedSize})`, { url: r.url, file: file.path });
    }
    const digest = hash.digest('hex');
    if (!hashMatches({ ...file, sha1: expectedSha1 }, digest)) {
      await fsp.rm(part, { force: true }).catch(() => {});
      throw new LaunchError('INTEGRITY', path.basename(file.path), { url: r.url, file: file.path });
    }
    try {
      await fsp.rename(part, file.path);
    } catch (err) { throw fromSystemError(err, file.path); }
    return { bytes: written, sha1: digest };
  } catch (err) {
    // Les octets comptés pour ce fichier sont retirés de la progression.
    if (counted) onBytes(-counted);
    throw err;
  } finally {
    if (fh) await fh.close().catch(() => {});
    r.done();
  }
}

// Un même fichier n'est jamais téléchargé deux fois en même temps (cache partagé).
const inFlight = new Map();

/** Télécharge un fichier avec nouvelles tentatives (attente croissante). */
async function downloadFile(file, opts = {}) {
  const key = path.resolve(String(file.path));
  while (inFlight.has(key)) {
    await inFlight.get(key).catch(() => {});
    if (await isFileValid(file)) return { bytes: 0, sha1: file.sha1, skipped: true };
  }
  const p = downloadWithRetries(file, opts);
  inFlight.set(key, p);
  try { return await p; } finally { if (inFlight.get(key) === p) inFlight.delete(key); }
}

async function downloadWithRetries(file, opts) {
  const control = normalizeControl(opts);
  const retries = opts.retries ?? 4;
  const log = opts.onLog || (() => {});
  let lastErr;
  let attempt = 0;
  for (;;) {
    const epoch = control.pauseEpoch;
    try {
      return await downloadOnce(file, { ...opts, control });
    } catch (err) {
      lastErr = err instanceof LaunchError ? err : fromSystemError(err, file.path);
      if (isCancel(lastErr) || control.cancelled) throw new LaunchError('CANCELLED');
      if (!isRetryable(lastErr)) break;
      // Un échec causé par une pause (connexion coupée par le serveur) ne compte pas.
      if (control.pauseEpoch === epoch) attempt++;
      if (attempt > retries) break;
      if (lastErr.code === 'INTEGRITY') await fsp.rm(file.path + '.part', { force: true }).catch(() => {});
      log(`[réseau] nouvel essai ${attempt}/${retries} pour ${path.basename(String(file.path))} : ${lastErr.code}`);
      await sleep(Math.min(8000, (opts.retryDelay ?? 500) * 2 ** Math.max(0, attempt - 1)), control.signal);
    }
  }
  log(`[réseau] échec : ${path.basename(String(file.path))} : ${lastErr.code}`);
  throw lastErr;
}

/**
 * Progression : octets, vitesse (moyenne glissante), temps restant, par étape.
 */
class Progress {
  constructor(files, onProgress) {
    this.onProgress = onProgress || (() => {});
    this.totalBytes = 0;
    this.doneBytes = 0;
    this.totalFiles = files.length;
    this.doneFiles = 0;
    this.stages = {};
    for (const f of files) {
      const s = f.stage || 'autre';
      this.stages[s] ||= { totalBytes: 0, doneBytes: 0, totalFiles: 0, doneFiles: 0 };
      this.stages[s].totalBytes += f.size || 0;
      this.stages[s].totalFiles += 1;
      this.totalBytes += f.size || 0;
    }
    this.unknownSizes = files.some((f) => !Number.isSafeInteger(f.size));
    this.samples = [[Date.now(), 0]];
    this.lastEmit = 0;
    this.stage = null;
  }

  bytes(stage, n) {
    this.doneBytes += n;
    const s = this.stages[stage || 'autre'];
    if (s) s.doneBytes += n;
    this.stage = stage;
    this.emit(false);
  }

  fileDone(stage) {
    this.doneFiles += 1;
    const s = this.stages[stage || 'autre'];
    if (s) s.doneFiles += 1;
    this.emit(false);
  }

  snapshot() {
    const now = Date.now();
    this.samples.push([now, this.doneBytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 5000) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const dt = (now - t0) / 1000;
    const speed = dt > 0.2 ? Math.max(0, (this.doneBytes - b0) / dt) : 0;
    const remaining = Math.max(0, this.totalBytes - this.doneBytes);
    return {
      stage: this.stage,
      totalBytes: this.totalBytes,
      doneBytes: this.doneBytes,
      totalFiles: this.totalFiles,
      doneFiles: this.doneFiles,
      totalMB: +(this.totalBytes / 1048576).toFixed(1),
      doneMB: +(this.doneBytes / 1048576).toFixed(1),
      speedBytes: Math.round(speed),
      speedMBs: +(speed / 1048576).toFixed(2),
      etaSeconds: speed > 0 && remaining > 0 ? Math.round(remaining / speed) : (this.doneFiles >= this.totalFiles ? 0 : null),
      percent: this.percent(),
      sizesKnown: !this.unknownSizes,
      stages: Object.fromEntries(Object.entries(this.stages).map(([k, v]) => [k, { ...v, percent: v.totalFiles ? (v.doneFiles >= v.totalFiles ? 100 : Math.min(99, Math.floor(((v.totalBytes ? v.doneBytes / v.totalBytes : v.doneFiles / v.totalFiles)) * 100))) : 100 }])),
    };
  }

  percent() {
    if (this.totalFiles === 0) return 100;
    const byFiles = Math.floor((this.doneFiles / this.totalFiles) * 100);
    if (!this.totalBytes) return byFiles;
    const byBytes = Math.min(100, Math.floor((Math.min(this.doneBytes, this.totalBytes) / this.totalBytes) * 100));
    // Tailles inconnues : on ne montre jamais 100 % avant le dernier fichier.
    if (this.unknownSizes) return this.doneFiles >= this.totalFiles ? 100 : Math.min(99, Math.min(byBytes, Math.max(byFiles, byBytes - 1)));
    return this.doneFiles >= this.totalFiles ? 100 : Math.min(99, byBytes);
  }

  emit(force) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    try { this.onProgress(this.snapshot()); } catch { /* le code appelant ne doit pas tout casser */ }
  }
}

/**
 * File de téléchargements en parallèle (8 à 16 à la fois).
 * Au premier échec définitif, tout s'arrête proprement et l'erreur est renvoyée.
 *
 * @param {Array<{url: string, path: string, sha1?: string, size?: number, stage?: string}>} files
 * @param {{concurrency?: number, control?: any, signal?: AbortSignal, onProgress?: Function,
 *          allowedHosts?: string[], timeout?: number, retries?: number, retryDelay?: number}} [opts]
 */
async function downloadAll(files, opts = {}) {
  // Contrôle interne : une erreur arrête la file sans annuler celui de l'appelant.
  const control = createControl(normalizeControl(opts));
  const concurrency = Math.max(1, Math.min(16, opts.concurrency || 12));
  // Deux entrées vers le même fichier : une seule fois.
  const seen = new Set();
  const queue = [];
  for (const f of files) {
    const key = path.resolve(f.path);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(f);
  }
  const progress = new Progress(queue, opts.onProgress);
  let index = 0;
  let failure = null;
  const inner = { ...opts };
  const worker = async () => {
    while (!failure && index < queue.length) {
      const f = queue[index++];
      try {
        await control.wait();
        await downloadFile(f, { ...inner, control, onBytes: (n) => progress.bytes(f.stage, n) });
        progress.fileDone(f.stage);
      } catch (err) {
        if (!failure) failure = err;
        if (!isCancel(err)) control.cancel();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } finally {
    control.dispose();
  }
  progress.emit(true);
  if (failure) throw failure;
  return progress.snapshot();
}

module.exports = { downloadFile, downloadAll, sha1File, isFileValid, Progress };
