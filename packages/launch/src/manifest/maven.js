'use strict';

const { LaunchError } = require('../errors');

const SAFE = /^[A-Za-z0-9._\-+]+$/;
// Noms interdits par Windows (CON, NUL, COM1…), avec ou sans extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * « groupe:artefact:version[:classifier][@ext] » → morceaux + chemin relatif.
 * Refuse tout morceau dangereux (../, /, etc.).
 */
function parseMaven(coord) {
  if (typeof coord !== 'string') throw new LaunchError('MANIFEST_INVALID', 'nom de bibliothèque');
  let ext = 'jar';
  let c = coord;
  const at = c.indexOf('@');
  if (at >= 0) { ext = c.slice(at + 1); c = c.slice(0, at); }
  const parts = c.split(':');
  if (parts.length < 3 || parts.length > 4) throw new LaunchError('MANIFEST_INVALID', `bibliothèque ${coord}`);
  const [group, artifact, version, classifier] = parts;
  for (const p of [artifact, version, classifier, ext].filter((x) => x !== undefined)) {
    if (!SAFE.test(p) || /^\.+$/.test(p) || p.endsWith('.') || RESERVED.test(p)) throw new LaunchError('MANIFEST_INVALID', `bibliothèque ${coord}`);
  }
  for (const g of group.split('.')) {
    if (!SAFE.test(g) || /^\.*$/.test(g) || RESERVED.test(g)) throw new LaunchError('MANIFEST_INVALID', `bibliothèque ${coord}`);
  }
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  const path = `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
  return { group, artifact, version, classifier: classifier || null, ext, file, path };
}

/** Clé de dédoublonnage : groupe:artefact[:classifier] (sans version). */
function libraryKey(name) {
  try {
    const m = parseMaven(name);
    return `${m.group}:${m.artifact}${m.classifier ? ':' + m.classifier : ''}`;
  } catch {
    return String(name);
  }
}

/** Vérifie qu'un chemin relatif fourni par un JSON ne sort pas du dossier. */
function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new LaunchError('MANIFEST_INVALID', 'chemin vide');
  const n = p.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes(':')) throw new LaunchError('MANIFEST_INVALID', `chemin interdit ${p}`);
  const parts = n.split('/');
  for (const s of parts) {
    if (s === '' || s === '.' || /^[ .]+$/.test(s) || /[<>"|?*;\x00-\x1f]/.test(s) || /[ .]$/.test(s) || RESERVED.test(s)) {
      throw new LaunchError('MANIFEST_INVALID', `chemin interdit ${p}`);
    }
  }
  return parts.join('/');
}

module.exports = { parseMaven, libraryKey, safeRelPath, RESERVED };
