'use strict';

/**
 * Extracteur ZIP sûr, fait maison avec zlib de Node.
 * Règles : refuser tout chemin qui sort du dossier (../, C:\, chemin absolu,
 * caractère nul), ignorer les liens symboliques, ne jamais appliquer les droits
 * spéciaux, refuser deux fichiers au même nom, s'arrêter si un fichier dépasse
 * la taille annoncée et plafonner le total (bombe ZIP), écrire en flux.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { LaunchError, fromSystemError } = require('../errors');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const DEFAULTS = {
  maxEntries: 200_000,
  maxEntrySize: 1024 * 1024 * 1024, // 1 Go par fichier
  maxTotalSize: 4 * 1024 * 1024 * 1024, // 4 Go au total
  maxCentralDirSize: 128 * 1024 * 1024,
  maxRatio: 1000, // décompressé / compressé (au-delà d'1 Mo)
};

const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (bytesRead === 0) throw new LaunchError('ZIP_INVALID', 'archive tronquée');
    off += bytesRead;
  }
  return buf;
}

/** Vérifie un nom d'entrée et renvoie ses morceaux, ou lève ZIP_UNSAFE. */
function safeParts(name) {
  if (typeof name !== 'string' || name.length === 0) throw new LaunchError('ZIP_UNSAFE', 'nom vide');
  if (name.includes('\0')) throw new LaunchError('ZIP_UNSAFE', 'caractère nul');
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/')) throw new LaunchError('ZIP_UNSAFE', `chemin absolu : ${name}`);
  if (/^[a-zA-Z]:/.test(n) || n.includes(':')) throw new LaunchError('ZIP_UNSAFE', `chemin Windows interdit : ${name}`);
  const parts = n.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new LaunchError('ZIP_UNSAFE', `sortie du dossier : ${name}`);
    // Windows ignore les points/espaces finaux : « ..  » ou « .. . » = « .. »
    if (/^[ .]+$/.test(p)) throw new LaunchError('ZIP_UNSAFE', `sortie du dossier : ${name}`);
    if (/[<>"|?*;\x00-\x1f]/.test(p)) throw new LaunchError('ZIP_UNSAFE', `caractère interdit : ${name}`);
    // Windows retire les points/espaces finaux et réserve CON, NUL, COM1… : refusés.
    if (/[ .]$/.test(p)) throw new LaunchError('ZIP_UNSAFE', `nom terminé par un point ou un espace : ${name}`);
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(p)) throw new LaunchError('ZIP_UNSAFE', `nom réservé par Windows : ${name}`);
  }
  return parts;
}

/**
 * Ouvre une archive et lit son sommaire (répertoire central).
 * @param {string} file
 * @param {Partial<typeof DEFAULTS>} [limits]
 */
async function openZip(file, limits = {}) {
  const lim = { ...DEFAULTS, ...limits };
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch (err) { throw fromSystemError(err, file); }
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new LaunchError('ZIP_INVALID', 'trop petit');
    const tailLen = Math.min(size, 65535 + 22);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new LaunchError('ZIP_INVALID', 'fin d\'archive introuvable');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // ZIP64
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = eocd - 20;
      if (locPos >= 0 && tail.readUInt32LE(locPos) === SIG_EOCD64_LOC) {
        const eocd64Off = Number(tail.readBigUInt64LE(locPos + 8));
        if (eocd64Off + 56 > size) throw new LaunchError('ZIP_INVALID', 'zip64 invalide');
        const e64 = await readAt(fh, eocd64Off, 56);
        if (e64.readUInt32LE(0) !== SIG_EOCD64) throw new LaunchError('ZIP_INVALID', 'zip64 invalide');
        count = Number(e64.readBigUInt64LE(32));
        cdSize = Number(e64.readBigUInt64LE(40));
        cdOffset = Number(e64.readBigUInt64LE(48));
      }
    }
    if (count > lim.maxEntries) throw new LaunchError('ZIP_TOO_LARGE', `${count} fichiers`);
    if (cdSize > lim.maxCentralDirSize || cdOffset + cdSize > size) throw new LaunchError('ZIP_INVALID', 'sommaire invalide');

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) throw new LaunchError('ZIP_INVALID', 'sommaire abîmé');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttrs = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new LaunchError('ZIP_INVALID', 'sommaire abîmé');
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800) ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      // extra ZIP64
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff && q + 8 <= e + 4 + len) { uncompressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff && q + 8 <= e + 4 + len) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      const unixMode = (madeBy >> 8) === 3 ? (externalAttrs >>> 16) & 0xffff : 0;
      const isSymlink = (unixMode & 0o170000) === 0o120000;
      const isDirectory = name.endsWith('/') || name.endsWith('\\') || (externalAttrs & 0x10) === 0x10;
      entries.push({ name, method, flags, crc, compressedSize, uncompressedSize, localOffset, isSymlink, isDirectory, encrypted: (flags & 1) === 1 });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipArchive(file, fh, size, entries, lim);
  } catch (err) {
    await fh.close().catch(() => {});
    throw err instanceof LaunchError ? err : new LaunchError('ZIP_INVALID', err && err.message, { cause: err });
  }
}

class ZipArchive {
  constructor(file, fh, size, entries, limits) {
    this.file = file;
    this.fh = fh;
    this.size = size;
    this.entries = entries;
    this.limits = limits;
  }

  async close() {
    if (this.fh) { const fh = this.fh; this.fh = null; await fh.close().catch(() => {}); }
  }

  getEntry(name) {
    return this.entries.find((e) => e.name === name) || null;
  }

  checkEntry(entry) {
    if (entry.encrypted) throw new LaunchError('ZIP_UNSAFE', `fichier chiffré : ${entry.name}`);
    if (entry.method !== 0 && entry.method !== 8) throw new LaunchError('ZIP_INVALID', `compression inconnue (${entry.method}) : ${entry.name}`);
    if (entry.uncompressedSize > this.limits.maxEntrySize) throw new LaunchError('ZIP_TOO_LARGE', entry.name);
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) throw new LaunchError('ZIP_INVALID', entry.name);
    if (entry.uncompressedSize > 1024 * 1024 && entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > this.limits.maxRatio) {
      throw new LaunchError('ZIP_TOO_LARGE', `taux de compression suspect : ${entry.name}`);
    }
  }

  /** Position des données compressées d'une entrée. */
  async dataStart(entry) {
    if (entry.localOffset + 30 > this.size) throw new LaunchError('ZIP_INVALID', entry.name);
    const h = await readAt(this.fh, entry.localOffset, 30);
    if (h.readUInt32LE(0) !== SIG_LOC) throw new LaunchError('ZIP_INVALID', `en-tête abîmé : ${entry.name}`);
    const start = entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    if (start + entry.compressedSize > this.size) throw new LaunchError('ZIP_INVALID', `données tronquées : ${entry.name}`);
    return start;
  }

  /** Flux décompressé d'une entrée, qui s'arrête si la taille annoncée est dépassée. */
  async openStream(entry) {
    this.checkEntry(entry);
    const start = await this.dataStart(entry);
    const raw = entry.compressedSize === 0
      ? require('node:stream').Readable.from([])
      : fs.createReadStream(null, { fd: this.fh.fd, start, end: start + entry.compressedSize - 1, autoClose: false });
    const limit = entry.uncompressedSize;
    let seen = 0;
    let crc = 0;
    const name = entry.name;
    const expectedCrc = entry.crc;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > limit) return cb(new LaunchError('ZIP_TOO_LARGE', `${name} plus gros qu'annoncé`));
        if (crc32) crc = crc32(chunk, crc);
        cb(null, chunk);
      },
      flush(cb) {
        if (seen !== limit) return cb(new LaunchError('ZIP_INVALID', `taille incorrecte : ${name}`));
        if (crc32 && (crc >>> 0) !== (expectedCrc >>> 0)) return cb(new LaunchError('ZIP_INVALID', `empreinte CRC incorrecte : ${name}`));
        cb();
      },
    });
    return { streams: entry.method === 8 ? [raw, zlib.createInflateRaw(), guard] : [raw, guard] };
  }

  /** Lit une entrée en mémoire (petits fichiers : JSON, manifestes…). */
  async readEntry(nameOrEntry, maxSize = 64 * 1024 * 1024) {
    const entry = typeof nameOrEntry === 'string' ? this.getEntry(nameOrEntry) : nameOrEntry;
    if (!entry) return null;
    if (entry.isSymlink || entry.isDirectory) return null;
    if (entry.uncompressedSize > maxSize) throw new LaunchError('ZIP_TOO_LARGE', entry.name);
    const { streams } = await this.openStream(entry);
    const chunks = [];
    const sink = new (require('node:stream').Writable)({
      write(chunk, _e, cb) { chunks.push(chunk); cb(); },
    });
    try {
      await pipeline(...streams, sink);
    } catch (err) {
      throw err instanceof LaunchError ? err : new LaunchError('ZIP_INVALID', `${entry.name}: ${err.message}`, { cause: err });
    }
    return Buffer.concat(chunks);
  }

  /**
   * Extrait l'archive dans destDir.
   * @param {string} destDir
   * @param {{filter?: (name: string) => boolean, exclude?: string[], strip?: string,
   *          signal?: AbortSignal}} [opts]
   *   exclude : préfixes ignorés (ex. ['META-INF/']) ; strip : préfixe retiré (ex. 'maven/').
   * @returns {Promise<string[]>} fichiers écrits (chemins absolus)
   */
  async extractTo(destDir, opts = {}) {
    const exclude = opts.exclude || [];
    const root = path.resolve(destDir);
    try { await fsp.mkdir(root, { recursive: true }); } catch (err) { throw fromSystemError(err, root); }
    let realRoot;
    try { realRoot = await fsp.realpath(root); } catch (err) { throw fromSystemError(err, root); }
    const chosen = [];
    const names = new Set();
    let total = 0;
    for (const entry of this.entries) {
      if (entry.isSymlink) continue; // liens symboliques : ignorés
      // Les règles (exclude, strip, filter) s'appliquent au nom NORMALISÉ (« ./META-INF/x » = « META-INF/x »).
      const all = safeParts(entry.name);
      let name = all.join('/');
      if (entry.isDirectory || !name) continue;
      if (exclude.some((x) => name.startsWith(x) || (name + '/') === x)) continue;
      if (opts.strip) {
        if (!name.startsWith(opts.strip)) continue;
        name = name.slice(opts.strip.length);
        if (!name) continue;
      }
      if (opts.filter && !opts.filter(name)) continue;
      const parts = name.split('/');
      const key = parts.join('/').toLowerCase();
      if (names.has(key)) throw new LaunchError('ZIP_UNSAFE', `deux fichiers au même nom : ${entry.name}`);
      names.add(key);
      this.checkEntry(entry);
      total += entry.uncompressedSize;
      if (total > this.limits.maxTotalSize) throw new LaunchError('ZIP_TOO_LARGE', 'total décompressé trop gros');
      chosen.push({ entry, parts });
    }
    const written = [];
    for (const { entry, parts } of chosen) {
      if (opts.signal && opts.signal.aborted) throw new LaunchError('CANCELLED');
      const target = path.join(root, ...parts);
      const rel = path.relative(root, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new LaunchError('ZIP_UNSAFE', entry.name);
      const parent = path.dirname(target);
      // Avant de créer quoi que ce soit : le dossier existant le plus profond ne doit pas mener ailleurs.
      let probe = parent;
      for (;;) {
        try { await fsp.lstat(probe); break; } catch { const up = path.dirname(probe); if (up === probe) break; probe = up; }
      }
      try {
        const realProbe = await fsp.realpath(probe);
        const rp = path.relative(realRoot, realProbe);
        if (rp.startsWith('..') || path.isAbsolute(rp)) throw new LaunchError('ZIP_UNSAFE', `dossier détourné : ${entry.name}`);
      } catch (err) { throw fromSystemError(err, probe); }
      try { await fsp.mkdir(parent, { recursive: true }); } catch (err) { throw fromSystemError(err, parent); }
      // Un dossier existant ne doit pas être un lien qui pointe ailleurs.
      let realParent;
      try { realParent = await fsp.realpath(parent); } catch (err) { throw fromSystemError(err, parent); }
      const relReal = path.relative(realRoot, realParent);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new LaunchError('ZIP_UNSAFE', `dossier détourné : ${entry.name}`);
      try {
        const st = await fsp.lstat(target);
        if (st.isSymbolicLink() || st.isDirectory()) throw new LaunchError('ZIP_UNSAFE', `cible existante interdite : ${entry.name}`);
      } catch (err) { if (err instanceof LaunchError) throw err; }
      const part = `${target}.${crypto.randomBytes(6).toString('hex')}.part`;
      const { streams } = await this.openStream(entry);
      try {
        // Création exclusive (jamais à travers un lien), droits normaux uniquement
        // (jamais SUID ni exécutable venant de l'archive).
        await pipeline(...streams, fs.createWriteStream(part, { mode: 0o644, flags: 'wx' }));
        await fsp.rename(part, target);
      } catch (err) {
        await fsp.rm(part, { force: true }).catch(() => {});
        if (err instanceof LaunchError) throw err;
        if (err && err.code && /^E[A-Z]+$/.test(err.code) && err.code !== 'Z_DATA_ERROR' && !String(err.code).startsWith('Z_')) throw fromSystemError(err, target);
        throw new LaunchError('ZIP_INVALID', `${entry.name}: ${err && err.message}`, { cause: err });
      }
      written.push(target);
    }
    return written;
  }
}

/** Raccourci : ouvre, extrait, ferme. */
async function extractZip(file, destDir, opts = {}) {
  const zip = await openZip(file, opts.limits);
  try { return await zip.extractTo(destDir, opts); } finally { await zip.close(); }
}

/** Raccourci : lit une entrée d'une archive. */
async function readZipEntry(file, name, maxSize) {
  const zip = await openZip(file);
  try { return await zip.readEntry(name, maxSize); } finally { await zip.close(); }
}

module.exports = { openZip, extractZip, readZipEntry, safeParts, ZIP_DEFAULTS: DEFAULTS };
