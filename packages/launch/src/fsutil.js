'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Renommage avec nouvelles tentatives sous Windows : un antivirus (Defender) ou
 * l'indexation garde parfois le fichier ouvert quelques instants (EPERM, EBUSY, EACCES).
 */
async function rename(from, to) {
  if (process.platform !== 'win32') return fsp.rename(from, to);
  let wait = 20;
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err && err.code)) throw err;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 500);
    }
  }
}

/**
 * Cherche un programme dans le PATH, jamais dans le dossier courant
 * (Windows y regarderait d'abord : un java.exe posé dans le dossier du jeu serait lancé).
 */
async function findInPath(name) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter((d) => d && d !== '.' && path.isAbsolute(d));
  const exts = process.platform === 'win32'
    ? (/\.[a-z0-9]+$/i.test(name) ? [''] : String(process.env.PATHEXT || '.EXE;.COM').split(';').filter((e) => /^\.(exe|com)$/i.test(e)))
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        if (process.platform !== 'win32') await fsp.access(p, fs.constants.X_OK);
        return p;
      } catch { /* suivant */ }
    }
  }
  return null;
}

module.exports = { rename, findInPath };
