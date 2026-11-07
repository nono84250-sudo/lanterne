'use strict';

const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { LaunchError, fromSystemError } = require('../errors');
const { buildArgs, maskSecrets } = require('./args');
const { prepare } = require('../install/plan');
const { extractNatives } = require('../install/install');

const MAX_LOG_LINES = 5000;

/**
 * Jeu lancé. Événements (noms du PDF, puis alias anglais) :
 *   'journal' / 'log'      (ligne: string, { source: 'jeu'|'lanceur', flux: 'stdout'|'stderr' })
 *   'fermeture' / 'exit'   (code: number|null, signal: string|null)
 *   'erreur'               (err: LaunchError)
 */
class GameProcess extends EventEmitter {
  constructor(child, secrets, info) {
    super();
    this.child = child;
    this.pid = child.pid;
    this.secrets = secrets;
    this.info = info;
    this.lines = [];
    this.exited = false;
    this.exitCode = null;
  }

  _log(line, meta) {
    const masked = maskSecrets(line, this.secrets);
    this.lines.push(`[${meta.source}] ${masked}`);
    if (this.lines.length > MAX_LOG_LINES) this.lines.shift();
    this.emit('journal', masked, meta);
    this.emit('log', masked, meta);
  }

  /** Arrête le jeu (doucement, puis de force après 10 s). */
  arreter() {
    if (this.exited) return;
    try { this.child.kill(); } catch { /* déjà fini */ }
    const t = setTimeout(() => { if (!this.exited) try { this.child.kill('SIGKILL'); } catch { /* rien */ } }, 10_000);
    if (t.unref) t.unref();
  }

  stop() { this.arreter(); }

  /** Journal complet (sans jeton), prêt à envoyer au support. */
  exporterJournal() {
    return this.lines.join('\n') + '\n';
  }

  exportLog() { return this.exporterJournal(); }
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
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 64 * 1024) { handle(buf); buf = ''; }
    },
    end() {
      if (buf) handle(buf);
      buf = '';
      if (xml !== null) { onLine(xml); xml = null; }
    },
  };
}

/**
 * Lance le jeu.
 * @param {object} opts  soit { plan, … }, soit les options de prepare() + :
 *   account|compte, memory|memoire {min,max}, quickPlay, resolution, jvmArgs, gameArgs, gameDir
 * @returns {Promise<GameProcess>}
 */
async function launch(opts = {}) {
  let plan = opts.plan;
  if (!plan) plan = await prepare(opts);
  if (plan.missing && plan.missing.length) throw new LaunchError('NOT_INSTALLED', `${plan.missing.length} fichier(s) manquant(s)`);

  try {
    await fsp.access(plan.java.executable);
  } catch {
    throw new LaunchError('JAVA_MISSING', plan.java.executable);
  }
  await extractNatives(plan);
  try { await fsp.mkdir(plan.gameDir, { recursive: true }); } catch (err) { throw fromSystemError(err, plan.gameDir); }

  const built = buildArgs(plan, opts);
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
      return reject(new LaunchError('LAUNCH_FAILED', err && err.code, { cause: err }));
    }
    const game = new GameProcess(child, built.secrets, { id: plan.id, javaPath: built.javaPath, pid: child.pid });
    // La commande, sans le jeton, pour le débogage.
    game.command = maskSecrets([built.javaPath, ...built.args].join(' '), built.secrets);
    let spawned = false;
    const out = lineSplitter((l) => game._log(l, { source: 'jeu', flux: 'stdout' }));
    const errS = lineSplitter((l) => game._log(l, { source: 'jeu', flux: 'stderr' }));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errS.push(d));
    child.on('spawn', () => {
      spawned = true;
      game._log(`Démarrage de ${plan.id} (pid ${child.pid})`, { source: 'lanceur', flux: 'stdout' });
      resolve(game);
    });
    child.on('error', (err) => {
      const e = new LaunchError(err.code === 'ENOENT' ? 'JAVA_MISSING' : 'LAUNCH_FAILED', err.code, { cause: err });
      if (!spawned) return reject(e);
      game.emit('erreur', e);
    });
    child.on('close', (code, signal) => {
      out.end(); errS.end();
      game.exited = true;
      game.exitCode = code;
      game._log(`Fin du jeu (code ${code}${signal ? ', ' + signal : ''})`, { source: 'lanceur', flux: 'stdout' });
      game.emit('fermeture', code, signal);
      game.emit('exit', code, signal);
    });
  });
}

module.exports = { launch, GameProcess, lineSplitter, xmlEventToLines };
