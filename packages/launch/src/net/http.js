'use strict';

const { LaunchError } = require('../errors');

/** Sites officiels autorisés par défaut (Mojang + chargeurs). Rien d'autre. */
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'meta.fabricmc.net',
  'maven.fabricmc.net',
  'meta.quiltmc.org',
  'maven.quiltmc.org',
  'maven.neoforged.net',
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
]);

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 30_000;
const USER_AGENT = 'lanterne-launch/0.1';

/**
 * Vérifie qu'une adresse est en https et vers un site autorisé.
 * @returns {URL}
 */
function checkUrl(raw, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  let url;
  try {
    url = raw instanceof URL ? raw : new URL(String(raw));
  } catch {
    throw new LaunchError('INSECURE_URL', 'adresse illisible');
  }
  if (url.protocol !== 'https:') throw new LaunchError('INSECURE_URL', url.protocol + '//' + url.host, { url: url.href });
  if (url.username || url.password) throw new LaunchError('INSECURE_URL', 'identifiants dans l\'adresse', { url: url.origin });
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Port standard uniquement, sauf si « hôte:port » est explicitement autorisé (tests locaux).
  const ok = url.port === '' ? allowedHosts.includes(host) : allowedHosts.includes(`${host}:${url.port}`);
  if (!ok) throw new LaunchError('HOST_NOT_ALLOWED', url.port ? `${host}:${url.port}` : host, { url: url.href });
  return url;
}

/** Transforme une erreur de fetch en LaunchError précise. */
function mapFetchError(err, url, timedOut, userSignal) {
  if (err instanceof LaunchError) return err;
  if (userSignal && userSignal.aborted) return new LaunchError('CANCELLED', undefined, { cause: err });
  if (timedOut) return new LaunchError('TIMEOUT', hostOf(url), { cause: err, url });
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  return new LaunchError('NETWORK', [code, hostOf(url)].filter(Boolean).join(' '), { cause: err, url });
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * GET sécurisé : https obligatoire à chaque étape, redirections suivies à la main
 * et revérifiées, délai maximum. Renvoie la réponse (corps non lu) et un
 * « watchdog » à appeler à chaque morceau reçu pour repousser le délai.
 *
 * @param {string|URL} rawUrl
 * @param {{allowedHosts?: string[], timeout?: number, signal?: AbortSignal, headers?: Record<string,string>}} [opts]
 */
async function secureGet(rawUrl, opts = {}) {
  const allowedHosts = opts.allowedHosts || DEFAULT_ALLOWED_HOSTS;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const userSignal = opts.signal;
  if (userSignal && userSignal.aborted) throw new LaunchError('CANCELLED');

  let url = checkUrl(testMirror ? mirrorUrl(rawUrl) : rawUrl, allowedHosts);
  for (let hop = 0; ; hop++) {
    const ctrl = new AbortController();
    let timedOut = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
      if (timer.unref) timer.unref();
    };
    const onUserAbort = () => ctrl.abort();
    if (userSignal) userSignal.addEventListener('abort', onUserAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
    };
    arm();
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...(opts.headers || {}) },
      });
    } catch (err) {
      cleanup();
      throw mapFetchError(err, url.href, timedOut, userSignal);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try { await res.body?.cancel(); } catch { /* rien */ }
      cleanup();
      if (hop >= MAX_REDIRECTS) throw new LaunchError('TOO_MANY_REDIRECTS', url.host, { url: url.href });
      let next;
      try { next = new URL(res.headers.get('location'), url); } catch { throw new LaunchError('INSECURE_URL', 'redirection illisible'); }
      try {
        url = checkUrl(next, allowedHosts); // HTTPS + site autorisé, même après redirection
      } catch (err) {
        err.redirected = true; // ex. portail Wi-Fi captif : traité comme « pas d'Internet » pour le repli hors-ligne
        throw err;
      }
      continue;
    }
    return {
      res,
      url: url.href,
      /** à appeler à chaque morceau reçu */
      tick: arm,
      /** suspend le délai (pendant une pause voulue par le joueur) */
      hold: () => clearTimeout(timer),
      done: cleanup,
      isTimedOut: () => timedOut,
      mapError: (err) => mapFetchError(err, url.href, timedOut, userSignal),
    };
  }
}

// Tests automatiques uniquement (non exporté par le paquet) : toutes les adresses
// sont envoyées vers un faux serveur local « https://localhost:port/<site>/<chemin> ».
// La liste des sites autorisés s'applique toujours à l'adresse finale.
let testMirror = null;
function __setTestMirror(base) { testMirror = base ? String(base).replace(/\/?$/, '/') : null; }
function mirrorUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return raw; }
  if (u.href.startsWith(testMirror)) return u.href;
  return `${testMirror}${u.host}${u.pathname}${u.search}`;
}

/** Lit tout le corps en mémoire, avec plafond (pour les petits JSON). */
async function getBuffer(url, opts = {}) {
  const maxBytes = opts.maxBytes || 64 * 1024 * 1024;
  const r = await secureGet(url, opts);
  try {
    if (r.res.status !== 200) {
      try { await r.res.body?.cancel(); } catch { /* rien */ }
      if (r.res.status === 404) throw new LaunchError('HTTP_STATUS', `404 ${hostOf(r.url)}`, { url: r.url, status: 404 });
      throw new LaunchError('HTTP_STATUS', `${r.res.status} ${hostOf(r.url)}`, { url: r.url, status: r.res.status });
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of r.res.body) {
        r.tick();
        total += chunk.length;
        if (total > maxBytes) throw new LaunchError('TOO_LARGE', hostOf(r.url), { url: r.url });
        chunks.push(Buffer.from(chunk));
      }
    } catch (err) {
      throw r.mapError(err);
    }
    return Buffer.concat(chunks);
  } finally {
    r.done();
  }
}

async function getJson(url, opts = {}) {
  const buf = await getBuffer(url, opts);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new LaunchError('MANIFEST_INVALID', hostOf(url), { url: String(url) });
  }
}

async function getText(url, opts = {}) {
  return (await getBuffer(url, opts)).toString('utf8');
}

module.exports = { DEFAULT_ALLOWED_HOSTS, checkUrl, secureGet, getBuffer, getJson, getText, USER_AGENT, __setTestMirror };
