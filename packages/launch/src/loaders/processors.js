'use strict';

/**
 * « Processeurs » Forge / NeoForge : petits programmes Java officiels fournis
 * par l'installeur, qui fabriquent le jeu modifié. On les lance nous-mêmes,
 * avec une liste d'arguments (jamais de ligne de commande interprétée).
 * Le seul processeur qui télécharge (DOWNLOAD_MOJMAPS) est remplacé par notre
 * téléchargeur sécurisé.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LaunchError, fromSystemError } = require('../errors');
const { parseMaven } = require('../manifest/maven');
const { layout, readJsonFile, writeJsonFile } = require('../manifest/versions');
const { downloadFile, sha1File, isFileValid } = require('../net/download');
const { openZip } = require('../zip/zip');

function libPath(L, coord) {
  return path.join(L.libraries, ...parseMaven(coord).path.split('/'));
}

/** Lit « Main-Class » dans le MANIFEST.MF d'un jar. */
async function mainClassOf(jar) {
  const zip = await openZip(jar);
  try {
    const buf = await zip.readEntry('META-INF/MANIFEST.MF', 1024 * 1024);
    if (!buf) return null;
    const txt = buf.toString('utf8').replace(/\r?\n /g, '');
    const m = /^Main-Class:\s*(\S+)\s*$/m.exec(txt);
    return m ? m[1] : null;
  } finally {
    await zip.close();
  }
}

function markerPath(L, id) {
  return path.join(L.versions, id, '.lanterne-processed.json');
}

/** Les processeurs ont-ils déjà tourné et leurs fichiers sont-ils intacts ? */
async function processorsDone(plan) {
  if (!plan.forge || !plan.forge.processors.length) return true;
  const L = layout(plan.root);
  const marker = await readJsonFile(markerPath(L, plan.id));
  if (!marker || !Array.isArray(marker.outputs) || marker.installer !== plan.forge.full) return false;
  for (const o of marker.outputs) {
    if (!(await isFileValid(o))) return false;
  }
  return true;
}

async function runProcessors(plan, { javaPath, control, onLog }) {
  const forge = plan.forge;
  if (!forge || !forge.processors.length) return;
  if (await processorsDone(plan)) return;
  const L = layout(plan.root);
  const log = typeof onLog === 'function' ? (m) => { try { onLog(m); } catch { /* rien */ } } : () => {};
  const tmp = path.join(L.cache, 'tmp', `processors-${plan.id}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  const vars = {
    SIDE: 'client',
    MINECRAFT_JAR: path.join(L.versions, plan.mcVersion, `${plan.mcVersion}.jar`),
    MINECRAFT_VERSION: plan.mcVersion,
    ROOT: L.root,
    INSTALLER: forge.installerPath,
    LIBRARY_DIR: L.libraries,
  };
  const zip = await openZip(forge.installerPath);
  try {
    for (const [key, val] of Object.entries(forge.data || {})) {
      const v = val && typeof val.client === 'string' ? val.client : null;
      if (v === null) continue;
      if (v.startsWith('[') && v.endsWith(']')) vars[key] = libPath(L, v.slice(1, -1));
      else if (v.startsWith("'") && v.endsWith("'")) vars[key] = v.slice(1, -1);
      else if (v.startsWith('/')) {
        // Fichier à sortir de l'installeur (ex. /data/client.lzma), extraction sûre.
        const inner = v.slice(1);
        const out = path.join(tmp, 'data');
        await zip.extractTo(out, { filter: (n) => n === inner });
        vars[key] = path.join(out, ...inner.split('/'));
      } else vars[key] = v;
    }
  } finally {
    await zip.close();
  }

  const resolveArg = (a) => {
    const s = String(a);
    if (s.startsWith('[') && s.endsWith(']')) return libPath(L, s.slice(1, -1));
    return s.replace(/\{([A-Z_]+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)).replace(/^'(.*)'$/, '$1');
  };

  const outputsDone = [];
  for (const proc of forge.processors) {
    if (control && control.cancelled) throw new LaunchError('CANCELLED');
    if (control && typeof control.wait === 'function') await control.wait(); // Pause entre deux étapes
    const args = (proc.args || []).map(resolveArg);
    const outputs = Object.entries(proc.outputs || {}).map(([k, v]) => ({ path: resolveArg(k), sha1: resolveArg(v).toLowerCase() }));

    // DOWNLOAD_MOJMAPS : on télécharge nous-mêmes, depuis Mojang, avec vérification.
    const task = args[args.indexOf('--task') + 1];
    if (args.includes('--task') && task === 'DOWNLOAD_MOJMAPS') {
      const output = args[args.indexOf('--output') + 1];
      const cm = plan.version.downloads && plan.version.downloads.client_mappings;
      if (!cm || !cm.url) throw new LaunchError('LOADER_INSTALL_FAILED', 'mappings Mojang absents');
      await downloadFile({ url: cm.url, path: output, sha1: cm.sha1, size: cm.size }, { allowedHosts: plan.allowedHosts, control });
      outputsDone.push({ path: output, sha1: cm.sha1, size: cm.size });
      continue;
    }

    if (outputs.length && (await Promise.all(outputs.map((o) => isFileValid(o)))).every(Boolean)) {
      outputsDone.push(...outputs);
      continue;
    }

    const jar = libPath(L, proc.jar);
    const main = await mainClassOf(jar);
    if (!main) throw new LaunchError('LOADER_INSTALL_FAILED', `programme sans Main-Class : ${proc.jar}`);
    const cp = [jar, ...(proc.classpath || []).map((c) => libPath(L, c))].join(path.delimiter);
    log(`[installation] ${proc.jar} ${task || ''}`.trim());
    await new Promise((resolve, reject) => {
      let tail = '';
      let child;
      try {
        child = spawn(javaPath, ['-cp', cp, main, ...args], { shell: false, windowsHide: true, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return reject(new LaunchError('JAVA_FAILED', javaPath, { cause: err }));
      }
      const onData = (d) => {
        const s = d.toString();
        tail = (tail + s).slice(-4000);
        for (const line of s.split(/\r?\n/)) if (line.trim()) log(`[installation] ${line}`);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const onAbort = () => child.kill();
      if (control) control.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => reject(new LaunchError(err.code === 'ENOENT' ? 'JAVA_MISSING' : 'JAVA_FAILED', javaPath, { cause: err })));
      child.on('close', (code) => {
        if (control) control.signal.removeEventListener('abort', onAbort);
        if (control && control.cancelled) return reject(new LaunchError('CANCELLED'));
        if (code !== 0) return reject(new LaunchError('LOADER_INSTALL_FAILED', `${proc.jar} (code ${code}) ${tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`));
        resolve();
      });
    });
    for (const o of outputs) {
      if (!(await isFileValid(o))) throw new LaunchError('LOADER_INSTALL_FAILED', `fichier produit incorrect : ${path.basename(o.path)}`);
      outputsDone.push(o);
    }
  }

  // Fichiers produits sans empreinte annoncée (ex. PATCHED de NeoForge) : on note la leur.
  for (const key of ['PATCHED', 'MC_SRG', 'MC_SLIM', 'MC_EXTRA']) {
    const p = vars[key];
    if (p && path.isAbsolute(p) && !outputsDone.some((o) => o.path === p)) {
      const sha1 = await sha1File(p);
      if (sha1) outputsDone.push({ path: p, sha1 });
    }
  }
  if (vars.PATCHED && !(await sha1File(vars.PATCHED))) throw new LaunchError('LOADER_INSTALL_FAILED', 'jeu modifié non produit');
  try {
    await writeJsonFile(markerPath(L, plan.id), { installer: forge.full, outputs: outputsDone });
  } catch (err) { throw fromSystemError(err); }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

module.exports = { runProcessors, processorsDone, mainClassOf };
