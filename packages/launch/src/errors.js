'use strict';

/**
 * Toutes les erreurs du moteur passent par LaunchError : un code précis
 * (stable, pour le code appelant) et un message clair pour le joueur,
 * en français ('fr', par défaut) ou en anglais ('en').
 *
 * Every engine error is a LaunchError: a stable `code` (for the calling code)
 * and a clear end-user message in French ('fr', default) or English ('en').
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
  JAVA_TOO_OLD: 'Ce Java est trop ancien pour cette version de Minecraft.',
  GAME_CRASHED: "Le jeu s'est arrêté à cause d'une erreur (voir le journal).",
  LOADER_INSTALL_FAILED: "L'installation du chargeur de mods a échoué.",
  LAUNCH_FAILED: "Le jeu n'a pas pu démarrer.",
  CANCELLED: 'Opération annulée.',
  INVALID_OPTION: 'Option invalide.',
  INTERNAL: 'Erreur inattendue du moteur.',
};

const MESSAGES_EN = {
  NETWORK: 'Internet connection problem during download.',
  OFFLINE: 'The Internet seems to be down, and the required files are not installed yet.',
  TIMEOUT: 'The server is taking too long to respond.',
  HTTP_STATUS: 'The server responded with an error.',
  INSECURE_URL: 'Address refused: only secure (https) addresses are accepted.',
  HOST_NOT_ALLOWED: 'Address refused: this site is not on the list of allowed sites.',
  TOO_MANY_REDIRECTS: 'The server redirected too many times.',
  INTEGRITY: 'A downloaded file is damaged (wrong checksum or size).',
  TOO_LARGE: 'A file is larger than expected.',
  DISK_FULL: 'The disk is full.',
  PERMISSION: 'Access denied to a folder or file (write permissions).',
  FILESYSTEM: 'Error while reading or writing a file on the disk.',
  ZIP_INVALID: 'An archive (zip or jar) is unreadable or damaged.',
  ZIP_UNSAFE: 'An archive contains a dangerous file: extraction refused.',
  ZIP_TOO_LARGE: 'An archive is abnormally large once decompressed (ZIP bomb?).',
  VERSION_NOT_FOUND: 'This Minecraft version does not exist.',
  LOADER_NOT_FOUND: 'This mod loader does not exist for this version.',
  MANIFEST_INVALID: 'The version information received is unreadable.',
  NOT_INSTALLED: 'This version is not (fully) installed.',
  JAVA_MISSING: 'Java was not found. Install Java or enable automatic Java.',
  JAVA_UNSUPPORTED: 'No automatic Java is available for this computer.',
  JAVA_FAILED: 'Java could not start.',
  JAVA_TOO_OLD: 'This Java is too old for this Minecraft version.',
  GAME_CRASHED: 'The game stopped because of an error (see the log).',
  LOADER_INSTALL_FAILED: 'The mod loader installation failed.',
  LAUNCH_FAILED: 'The game could not start.',
  CANCELLED: 'Operation cancelled.',
  INVALID_OPTION: 'Invalid option.',
  INTERNAL: 'Unexpected engine error.',
};

const UNKNOWN = { fr: 'Erreur inconnue.', en: 'Unknown error.' };
const MESSAGES_BY_LANG = Object.freeze({ fr: MESSAGES, en: MESSAGES_EN });
const LANGS = Object.freeze(Object.keys(MESSAGES_BY_LANG));

let defaultLang = 'fr';

/** 'fr', 'FR', 'fr-FR', 'en_US'… → 'fr' | 'en' ; sinon null. */
function normalizeLang(lang) {
  if (typeof lang !== 'string') return null;
  const l = lang.trim().toLowerCase().split(/[-_]/)[0];
  return LANGS.includes(l) ? l : null;
}

/** Option lang absente : undefined, null ou chaîne vide (langue par défaut). */
function isUnset(lang) { return lang === undefined || lang === null || lang === ''; }

function invalidLang(lang) {
  // eslint-disable-next-line no-use-before-define
  return new LaunchError('INVALID_OPTION', `lang: ${String(lang).slice(0, 20)} (fr | en)`);
}

/** Message pour le joueur d'un code d'erreur, dans la langue voulue. */
function userMessageFor(code, lang) {
  const l = normalizeLang(lang) || defaultLang;
  const table = MESSAGES_BY_LANG[l];
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : UNKNOWN[l];
}

function fullMessage(code, detail, lang) {
  const base = userMessageFor(code, lang);
  return detail ? `${base} (${detail})` : base;
}

class LaunchError extends Error {
  /**
   * @param {keyof MESSAGES|string} code
   * @param {string} [detail] précision technique (jamais de jeton dedans)
   * @param {{cause?: unknown, url?: string, file?: string, status?: number, lang?: string}} [extra]
   */
  constructor(code, detail, extra = {}) {
    const lang = normalizeLang(extra.lang) || defaultLang;
    super(fullMessage(code, detail, lang), extra.cause ? { cause: extra.cause } : undefined);
    this.name = 'LaunchError';
    this.code = code;
    this.lang = lang;
    this.userMessage = userMessageFor(code, lang);
    this.detail = detail || '';
    if (extra.url) this.url = extra.url;
    if (extra.file) this.file = extra.file;
    if (extra.status) this.status = extra.status;
  }

  /**
   * Change la langue de `userMessage` et de `message` ('fr' | 'en'). Même code. Renvoie l'erreur.
   * Sans langue (undefined, null, '') : langue par défaut. Langue inconnue : INVALID_OPTION.
   */
  setLanguage(lang) {
    const l = isUnset(lang) ? defaultLang : normalizeLang(lang);
    if (!l) throw invalidLang(lang);
    const old = this.message;
    this.lang = l;
    this.userMessage = userMessageFor(this.code, l);
    this.message = fullMessage(this.code, this.detail, l);
    // Première ligne de la pile (« LaunchError: message ») dans la même langue.
    if (typeof this.stack === 'string' && old !== this.message) {
      const head = `${this.name}: ${old}`;
      if (this.stack.startsWith(head)) this.stack = `${this.name}: ${this.message}` + this.stack.slice(head.length);
    }
    return this;
  }

  /** Les deux traductions du message pour le joueur : { fr, en }. */
  get userMessages() {
    return { fr: userMessageFor(this.code, 'fr'), en: userMessageFor(this.code, 'en') };
  }
}

/** Langue utilisée quand aucune option `lang` n'est donnée ('fr' au départ). */
function setLanguage(lang) {
  // Sans langue (undefined, null, '') : retour au français (langue de départ).
  const l = isUnset(lang) ? 'fr' : normalizeLang(lang);
  if (!l) throw invalidLang(lang);
  defaultLang = l;
  return l;
}
function getLanguage() { return defaultLang; }

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

/**
 * Langue demandée dans les arguments d'un appel : option `lang` d'un objet
 * d'options, ou `plan.lang` (donnée à prepare() et gardée dans le plan).
 */
function langFromArgs(args) {
  // Les dernières options gagnent : install(plan, { lang: 'en' }) l'emporte sur plan.lang.
  for (const a of [...args].reverse()) {
    if (!a || typeof a !== 'object') continue;
    if (!isUnset(a.lang)) return a.lang;
    if (a.plan && typeof a.plan === 'object' && !isUnset(a.plan.lang)) return a.plan.lang;
  }
  return undefined;
}

/** Enveloppe une fonction async pour que ses erreurs soient toujours des LaunchError, dans la bonne langue. */
function wrap(fn) {
  const w = async function (...args) {
    const lang = langFromArgs(args);
    if (lang !== undefined && !normalizeLang(lang)) throw invalidLang(lang);
    try { return await fn.apply(this, args); } catch (err) {
      const e = toLaunchError(err);
      throw lang !== undefined ? e.setLanguage(lang) : e;
    }
  };
  Object.defineProperty(w, 'name', { value: fn.name });
  return w;
}

function isCancel(err) {
  return err && (err.code === 'CANCELLED' || err.name === 'AbortError');
}

module.exports = {
  LaunchError, MESSAGES, MESSAGES_EN, MESSAGES_BY_LANG, LANGS,
  normalizeLang, isUnset, setLanguage, getLanguage, userMessageFor,
  fromSystemError, toLaunchError, wrap, isCancel,
};
