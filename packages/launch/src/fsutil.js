'use strict';

const fsp = require('node:fs/promises');

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

module.exports = { rename };
