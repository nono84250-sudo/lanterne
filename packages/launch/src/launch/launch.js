'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { EventEmitter } = require('node:events');
const { LaunchError, fromSystemError } = require('../errors');
const { buildArgs, maskSecrets } = require('./args');
const { prepare } = require('../install/plan');
const { extractNatives } = require('../install/install');
const { isFileValid, sha1File } = require('../net/download');
const { processorsDone } = require('../loaders/processors');
const { probeJava } = require('../java/runtime');

const MAX_LOG_LINES = 5000;
const MAX_LINE_LENGTH = 8192; // une ligne stockée ne dépasse pas 8 Ko
const FLUSH_AT = 64 * 1024; // ligne sans fin : on vide par morceaux…
const KEEP_TAIL = 4096; // …en gardant la fin, pour ne jamais couper un jeton en deux

/**
 * Remplace les données personnelles (pseudo, identifiant, dossier personnel)
 * avant d'envoyer un journal au support.
 */
function anonymize(text, info = {}) {
  let s = String(text);
  const repl = (needle, by) => { if (needle && needle.length >= 3) s = s.split(needle).join(by); };
  const home = os.homedir();
  repl(home, '<dossier personnel>');
  if (home.includes('\\')) repl(home.replace(/\\/g, '/'), '<dossier personnel>');
  if (info.uuid) {
    const u = String(info.uuid).replace(/-/g, '').toLowerCase();
    const dashed = `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
    s = s.replace(new RegExp(`${u}|${dashed}`, 'gi'), '<uuid>');
  }
  if (info.name && /^[A-Za-z0-9_]{3,16}$/.test(info.name)) {
    s = s.replace(new RegExp(`(?<![A-Za-z0-9_])${info.name}(?![A-Za-z0-9_])`, 'g'), '<joueur>');
  }
  for (const k of ['xuid', 'clientId']) {
    const v = info[k] && String(info[k]);
    if (v && v !== '0' && v.length >= 4) s = s.split(v).join(`<${k}>`);
  }
  let user = '';
  try { user = os.userInfo().username; } catch { /* rien */ }
  if (user && user.length >= 3 && /^[\w.-]+$/.test(user)) {
    s = s.replace(new RegExp(`(?<![\\w.-])${user.replace(/[.]/g, '\\.')}(?![\\w-])`, 'g'), '<utilisateur>');
  }
  return s;
}

/**
 * Jeu lancé. Événements (noms du PDF, puis alias anglais) :
 *   'journal' / 'log'      (ligne: string, { source: 'jeu'|'lanceur', flux: 'stdout'|'stderr' })
 *   'fermeture' / 'exit'   (code: number|null, signal: string|null)
 *   'erreur'               (err: LaunchError)
 */
class GameProcess extends EventEmitter {
  constructor(child, secrets, info) {
    super();
    // Le processus n'est pas énumérable : console.log(jeu) n'affiche pas ses arguments (donc pas le jeton).
    Object.defineProperty(this, 'child', { value: child, enumerable: false });
    this.pid = child.pid;
    this.stopRequested = false;
    Object.defineProperty(this, 'secrets', { value: secrets, enumerable: false });
    Object.defineProperty(this, '_who', { value: { name: info.playerName, uuid: info.playerUuid, xuid: info.xuid, clientId: info.clientId }, enumerable: false });
    this.info = { id: info.id, javaPath: info.javaPath, pid: info.pid };
    this.lines = [];
    this.exited = false;
    this.exitCode = null;
  }

  _log(line, meta) {
    let masked = maskSecrets(line, this.secrets);
    if (masked.length > MAX_LINE_LENGTH) masked = masked.slice(0, MAX_LINE_LENGTH) + ' […]';
    this.lines.push({ source: meta.source, text: masked });
    if (this.lines.length > MAX_LOG_LINES) this.lines.shift();
    this.emit('journal', masked, meta);
    this.emit('log', masked, meta);
  }

  /** Arrête le jeu (doucement, puis de force après 10 s). */
  arreter() {
    if (this.exited) return;
    this.stopRequested = true;
    if (process.platform === 'win32') {
      // Sous Windows, kill() force l'arrêt tout de suite : on demande d'abord la fermeture
      // de la fenêtre (comme cliquer sur la croix), pour que le monde soit sauvegardé.
      try {
        const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
        const tk = spawn(path.join(sysRoot, 'System32', 'taskkill.exe'), ['/PID', String(this.pid), '/T'], { shell: false, windowsHide: true, stdio: 'ignore' });
        tk.on('error', () => { try { this.child.kill(); } catch { /* rien */ } });
      } catch { try { this.child.kill(); } catch { /* rien */ } }
    } else {
      try { this.child.kill(); } catch { /* déjà fini */ }
    }
    const t = setTimeout(() => { if (!this.exited) try { this.child.kill('SIGKILL'); } catch { /* rien */ } }, 10_000);
    if (t.unref) t.unref();
  }

  stop() { this.arreter(); }

  /**
   * Journal prêt à envoyer au support : jamais de jeton, et par défaut sans
   * pseudo, identifiant ni dossier personnel.
   * @param {{source?: 'jeu'|'lanceur', anonyme?: boolean, anonymize?: boolean}} [opts]
   */
  exporterJournal(opts = {}) {
    const anon = opts.anonyme ?? opts.anonymize ?? true;
    const lines = this.lines.filter((l) => !opts.source || l.source === opts.source);
    const text = lines.map((l) => `[${l.source}] ${l.text}`).join('\n') + '\n';
    return anon ? anonymize(text, this._who) : text;
  }

  exportLog(opts) { return this.exporterJournal(opts); }
}

/**
 * Le jeu écrit ses journaux en XML (configuration log4j de Mojang).
 * On les remet en lignes lisibles : « [12:00:01] [Render thread/INFO]: message ».
 */
function xmlEventToLines(xml) {
  const attr = (n) => { const m = new RegExp(`${n}="([^"]*)"`).exec(xml); return m ? m[1] : ''; };
  const cdata = (tag) => {
    const m = new RegExp(`<log4j:${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></log4j:${tag}>`).exec(xml);
    return m ? m[1] : '';
  };
  const ts = Number(attr('timestamp'));
  const time = Number.isFinite(ts) && ts > 0 ? new Date(ts).toTimeString().slice(0, 8) : '';
  const head = `[${time}] [${attr('thread')}/${attr('level')}]: `;
  const lines = cdata('Message').split(/\r?\n/).map((l, i) => (i === 0 ? head + l : l));
  const thr = cdata('Throwable');
  if (thr) lines.push(...thr.split(/\r?\n/).filter(Boolean));
  return lines;
}

function lineSplitter(onLine) {
  const decoder = new StringDecoder('utf8'); // un caractère coupé entre deux morceaux reste entier
  let buf = '';
  let xml = null;
  const handle = (line) => {
    if (xml !== null) {
      xml += '\n' + line;
      if (line.includes('</log4j:Event>') || xml.length > 256 * 1024) {
        for (const l of xmlEventToLines(xml)) onLine(l);
        xml = null;
      }
      return;
    }
    if (line.trimStart().startsWith('<log4j:Event')) {
      xml = line;
      if (line.includes('</log4j:Event>')) { for (const l of xmlEventToLines(xml)) onLine(l); xml = null; }
      return;
    }
    onLine(line);
  };
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      if (buf.length > FLUSH_AT) {
        // On coupe à un espace avant la fin gardée, pour ne pas couper un mot (ou un jeton).
        let cut = buf.length - KEEP_TAIL;
        const sp = buf.lastIndexOf(' ', cut);
        if (sp > 0) cut = sp;
        handle(buf.slice(0, cut));
        buf = buf.slice(cut);
      }
    },
    end() {
      buf += decoder.end();
      if (buf) handle(buf);
      buf = '';
      if (xml !== null) { onLine(xml); xml = null; }
    },
  };
}

/** Erreur système sans ses arguments (spawnargs contient le jeton). */
function cleanCause(err) {
  if (!err || typeof err !== 'object') return err;
  const e = new Error(String(err.message || '').slice(0, 200));
  e.code = err.code; e.errno = err.errno; e.syscall = err.syscall;
  return e;
}

// Empreintes déjà calculées : chemin → { size, mtimeMs, sha1 } (évite de tout relire à chaque lancement).
const hashCache = new Map();
async function cachedSha1(file) {
  const st = await fsp.stat(file);
  const c = hashCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha1;
  const sha1 = await sha1File(file);
  hashCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha1 });
  return sha1;
}

/**
 * Avant de lancer : tout ce que Java va charger est-il intact ?
 * Par défaut, empreinte SHA-1 complète du jeu, des bibliothèques et de Java
 * (mise en cache) ; fastLaunch: true se contente des tailles.
 */
async function checkReady(plan, opts) {
  if (plan.missing && plan.missing.length) throw new LaunchError('NOT_INSTALLED', `${plan.missing.length} fichier(s) manquant(s)`);
  const byPath = new Map(plan.files.map((f) => [path.resolve(f.path), f]));
  const wanted = new Set([path.resolve(plan.clientJar)]);
  if (plan.logging && plan.logging.path) wanted.add(path.resolve(plan.logging.path));
  for (const l of plan.libraries) if (l.classpath || l.native) wanted.add(path.resolve(l.path));
  if (plan.java.auto) {
    wanted.add(path.resolve(plan.java.executable));
    for (const f of plan.java.runtime ? plan.java.runtime.files : []) if (/[\\/]lib[\\/][^\\/]*\.(so|dll|dylib|jsa)$|[\\/]modules$/.test(f.path)) wanted.add(path.resolve(f.path));
  }
  if (plan.copyJar) byPath.set(path.resolve(plan.copyJar.to), { path: plan.copyJar.to, sha1: plan.copyJar.sha1, size: plan.copyJar.size });
  for (const g of plan.generated || []) byPath.set(path.resolve(g.path), g);

  const bad = [];
  for (const p of wanted) {
    const f = byPath.get(p);
    if (!f) continue; // fichier sans empreinte connue (ex. jar d'une version personnalisée)
    if (opts.fastLaunch || !f.sha1) {
      if (!(await isFileValid(f, { quick: true }))) bad.push(p);
      continue;
    }
    try {
      const digest = await cachedSha1(p);
      const ok = digest === f.sha1.toLowerCase() || (Array.isArray(f.sha1Alt) && f.sha1Alt.includes(digest));
      if (!ok) bad.push(p);
    } catch { bad.push(p); }
  }
  if (bad.length) throw new LaunchError('NOT_INSTALLED', `${bad.length} fichier(s) abîmé(s) : utilisez « réparer »`, { file: bad[0] });
  if (!(await processorsDone(plan))) throw new LaunchError('NOT_INSTALLED', `installation de ${plan.loader} pas terminée`);

  // Java : automatique (droit d'exécution) ou fourni (doit démarrer et être assez récent).
  if (plan.java.auto) {
    try {
      await fsp.access(plan.java.executable, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    } catch {
      throw new LaunchError('JAVA_MISSING', plan.java.executable);
    }
  } else {
    let exe = plan.java.executable;
    if (plan.java.bare) {
      exe = await findInPath(exe);
      if (!exe) throw new LaunchError('JAVA_MISSING', plan.java.executable);
    } else {
      try { await fsp.access(exe); } catch { throw new LaunchError('JAVA_MISSING', exe); }
    }
    const { major } = await probeJava(exe);
    const min = plan.java.minMajor || 8;
    if (major < min) throw new LaunchError('JAVA_TOO_OLD', `Java ${major}, il faut Java ${min} ou plus récent`);
    return exe; // chemin complet : c'est exactement ce Java-là qui sera lancé
  }
  return plan.java.executable;
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

/**
 * Lance le jeu.
 * @param {object} opts  soit { plan, … }, soit les options de prepare() + :
 *   account|compte, memory|memoire {min,max}, quickPlay, resolution, jvmArgs, gameArgs, gameDir,
 *   fastLaunch (contrôle par la taille seulement), onLog|journal
 * @returns {Promise<GameProcess>}
 */
async function launch(opts = {}) {
  let plan = opts.plan;
  if (!plan) plan = await prepare(opts);
  // Dossier d'instance donné au lancement : il remplace celui du plan.
  if (opts.plan && (opts.gameDir || opts.dossierInstance)) plan = { ...plan, gameDir: path.resolve(String(opts.gameDir || opts.dossierInstance)) };
  const javaExe = await checkReady(plan, opts);
  if (javaExe !== plan.java.executable) plan = { ...plan, java: { ...plan.java, executable: javaExe } };
  await extractNatives(plan);
  try { await fsp.mkdir(plan.gameDir, { recursive: true }); } catch (err) { throw fromSystemError(err, plan.gameDir); }

  const pending = [];
  const built = buildArgs(plan, { ...opts, onLog: (m) => pending.push(m) });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(built.javaPath, built.args, {
        cwd: plan.gameDir,
        shell: false, // liste d'arguments : aucun risque d'injection
        windowsHide: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
    } catch (err) {
      return reject(new LaunchError('LAUNCH_FAILED', err && err.code, { cause: cleanCause(err) }));
    }
    const game = new GameProcess(child, built.secrets, {
      id: plan.id, javaPath: built.javaPath, pid: child.pid, playerName: built.account.name, playerUuid: built.account.uuid,
      xuid: built.account.xuid, clientId: built.account.clientId,
    });
    // La commande, sans jeton ni données personnelles, pour le débogage.
    game.command = anonymize(maskSecrets([built.javaPath, ...built.args].join(' '), built.secrets), game._who);
    const userLog = opts.onLog || opts.journal;
    if (typeof userLog === 'function') game.on('journal', (l, meta) => { try { userLog(l, meta); } catch { /* rien */ } });
    let spawned = false;
    const out = lineSplitter((l) => game._log(l, { source: 'jeu', flux: 'stdout' }));
    const errS = lineSplitter((l) => game._log(l, { source: 'jeu', flux: 'stderr' }));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errS.push(d));
    child.on('spawn', () => {
      spawned = true;
      game._log(`Démarrage de ${plan.id} (pid ${child.pid})`, { source: 'lanceur', flux: 'stdout' });
      for (const m of pending) game._log(String(m).replace(/^\[lanceur\] /, ''), { source: 'lanceur', flux: 'stderr' });
      resolve(game);
    });
    child.on('error', (err) => {
      const e = new LaunchError(err.code === 'ENOENT' ? 'JAVA_MISSING' : 'LAUNCH_FAILED', err.code, { cause: cleanCause(err) });
      if (!spawned) return reject(e);
      game.emit('erreur', e);
    });
    child.on('close', (code, signal) => {
      out.end(); errS.end();
      game.exited = true;
      game.exitCode = code;
      game._log(`Fin du jeu (code ${code}${signal ? ', ' + signal : ''})`, { source: 'lanceur', flux: 'stdout' });
      // Plantage (et pas un arrêt demandé) : erreur claire pour le launcher.
      if (!game.stopRequested && code !== 0 && code !== null && game.listenerCount('erreur') > 0) {
        game.emit('erreur', new LaunchError('GAME_CRASHED', `code ${code}`));
      }
      game.emit('fermeture', code, signal);
      game.emit('exit', code, signal);
    });
  });
}

module.exports = { launch, GameProcess, lineSplitter, xmlEventToLines, anonymize, checkReady };
