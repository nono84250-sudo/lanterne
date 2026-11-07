'use strict';

/**
 * Toutes les erreurs du moteur passent par LaunchError : un code précis
 * (stable, pour le code appelant) et un message clair en français (pour le joueur).
 */

const MESSAGES = {
  NETWORK: 'Problème de connexion Internet pendant le téléchargement.',
  OFFLINE: 'Internet semble coupé, et les fichiers nécessaires ne sont pas encore installés.',
  TIMEOUT: 'Le serveur met trop de temps à répondre.',
  HTTP_STATUS: 'Le serveur a répondu par une erreur.',
  INSECURE_URL: 'Adresse refusée : seules les adresses sécurisées (https) sont acceptées.',
  HOST_NOT_ALLOWED: 'Adresse refusée : ce site ne fait pas partie des sites autorisés.',
  TOO_MANY_REDIRECTS: 'Le serveur redirige trop de fois.',
  INTEGRITY: 'Un fichier téléchargé est abîmé (empreinte ou taille incorrecte).',
  TOO_LARGE: 'Un fichier est plus gros que prévu.',
  DISK_FULL: 'Plus de place sur le disque.',
  PERMISSION: "Accès refusé à un dossier ou un fichier (droits d'écriture).",
  FILESYSTEM: 'Erreur en lisant ou en écrivant un fichier sur le disque.',
  ZIP_INVALID: "Une archive (zip ou jar) est illisible ou abîmée.",
  ZIP_UNSAFE: 'Une archive contient un fichier dangereux : extraction refusée.',
  ZIP_TOO_LARGE: 'Une archive est anormalement grosse une fois décompressée (bombe ZIP ?).',
  VERSION_NOT_FOUND: "Cette version de Minecraft n'existe pas.",
  LOADER_NOT_FOUND: "Ce chargeur de mods n'existe pas pour cette version.",
  MANIFEST_INVALID: 'Les informations de version reçues sont illisibles.',
  NOT_INSTALLED: "Cette version n'est pas (complètement) installée.",
  JAVA_MISSING: 'Java est introuvable. Il faut installer Java ou activer Java automatique.',
  JAVA_UNSUPPORTED: "Aucun Java automatique n'existe pour cet ordinateur.",
  JAVA_FAILED: "Java n'a pas pu démarrer.",
  LOADER_INSTALL_FAILED: "L'installation du chargeur de mods a échoué.",
  LAUNCH_FAILED: "Le jeu n'a pas pu démarrer.",
  CANCELLED: 'Opération annulée.',
  INVALID_OPTION: 'Option invalide.',
  INTERNAL: 'Erreur inattendue du moteur.',
};

class LaunchError extends Error {
  /**
   * @param {keyof MESSAGES|string} code
   * @param {string} [detail] précision technique (jamais de jeton dedans)
   * @param {{cause?: unknown, url?: string, file?: string, status?: number}} [extra]
   */
  constructor(code, detail, extra = {}) {
    const base = MESSAGES[code] || 'Erreur inconnue.';
    super(detail ? `${base} (${detail})` : base, extra.cause ? { cause: extra.cause } : undefined);
    this.name = 'LaunchError';
    this.code = code;
    this.userMessage = base;
    this.detail = detail || '';
    if (extra.url) this.url = extra.url;
    if (extra.file) this.file = extra.file;
    if (extra.status) this.status = extra.status;
  }
}

/** Transforme une erreur système Node (ENOSPC, EACCES…) en LaunchError. */
function fromSystemError(err, file) {
  if (err instanceof LaunchError) return err;
  if (err && err.name === 'AbortError') return new LaunchError('CANCELLED', undefined, { cause: err });
  const code = err && err.code;
  const extra = { cause: err, file };
  if (code === 'ENOSPC' || code === 'EDQUOT') return new LaunchError('DISK_FULL', file, extra);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new LaunchError('PERMISSION', file, extra);
  if (code && /^E[A-Z]+$/.test(code)) return new LaunchError('FILESYSTEM', `${code}${file ? ' ' + file : ''}`, extra);
  return new LaunchError('FILESYSTEM', err && err.message, extra);
}

/**
 * Toute erreur qui sort du moteur devient une LaunchError (code + message clair).
 * Les erreurs système (ENOSPC, EACCES…) gardent leur sens ; le reste devient INTERNAL.
 */
function toLaunchError(err) {
  if (err instanceof LaunchError) return err;
  if (err && (err.name === 'AbortError' || (err.code && /^E[A-Z]+$/.test(err.code)))) return fromSystemError(err);
  return new LaunchError('INTERNAL', err && err.message ? String(err.message).slice(0, 200) : undefined, { cause: err });
}

/** Enveloppe une fonction async pour que ses erreurs soient toujours des LaunchError. */
function wrap(fn) {
  const w = async function (...args) {
    try { return await fn.apply(this, args); } catch (err) { throw toLaunchError(err); }
  };
  Object.defineProperty(w, 'name', { value: fn.name });
  return w;
}

function isCancel(err) {
  return err && (err.code === 'CANCELLED' || err.name === 'AbortError');
}

module.exports = { LaunchError, MESSAGES, fromSystemError, toLaunchError, wrap, isCancel };
