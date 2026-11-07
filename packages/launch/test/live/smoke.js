'use strict';

/**
 * Essai réel : prépare, installe et lance une version, attend le menu principal,
 * fait une capture d'écran (si DISPLAY est défini) puis arrête le jeu.
 *   node test/live/smoke.js <version> [loader] [dossier] [--offline] [--demo]
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('../../src');

const MENU_MARKERS = [
  /Sound engine started/i,
  /OpenAL initialized/i,
  /Created: \d+x\d+x\d+ minecraft:textures\/atlas\/blocks\.png-atlas/i,
  /Created: \d+x\d+x?\d* minecraft:textures\/atlas\/blocks/i,
  /SoundSystem shutting down/i,
];

async function main() {
  const [version, loader = 'vanilla', dir = path.join(__dirname, '..', '..', '.live-root')] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const offline = process.argv.includes('--offline');
  const demo = process.argv.includes('--demo');
  const t0 = Date.now();
  const plan = await lib.prepare({ version, loader, root: dir, gameDir: path.join(dir, 'instances', `${version}-${loader}`), offline });
  console.log(`[plan] ${plan.id} : ${plan.fichiers} fichier(s) à télécharger, ${plan.tailleMo} Mo, Java ${plan.java.component}`);
  let last = 0;
  await lib.install(plan, {
    onProgress: (p) => {
      if (Date.now() - last > 3000) { last = Date.now(); console.log(`[install] ${p.percent}% ${p.doneMB}/${p.totalMB} Mo ${p.speedMBs} Mo/s étape=${p.stage}`); }
    },
    onLog: (l) => { if (process.env.VERBOSE) console.log(l); },
  });
  console.log(`[install] terminé en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const game = await lib.launch({ plan, account: demo ? { type: 'demo', name: 'Demo_Player' } : { type: 'offline', name: 'Testeur' }, memory: { max: 2048 } });
  const tl = Date.now();
  let reached = false;
  let loaderSeen = false;
  const LOADER_RE = /(Loading Minecraft .* with (Fabric|Quilt) Loader|Forge Mod Loader version|MinecraftForge v|ModLauncher running|Forge mod loading|neoforge|Fabric Loader \d|FML)/i;
  const tail = [];
  game.on('journal', (l) => {
    tail.push(l); if (tail.length > 40) tail.shift();
    if (process.env.VERBOSE) console.log(l);
    if (!loaderSeen && loader !== 'vanilla' && LOADER_RE.test(l)) { loaderSeen = true; console.log(`[chargeur] ${l.slice(0, 200)}`); }
    if (!reached && MENU_MARKERS.some((r) => r.test(l))) {
      reached = true;
      console.log(`[jeu] menu atteint après ${((Date.now() - tl) / 1000).toFixed(0)} s : ${l.slice(0, 160)}`);
      setTimeout(() => {
        if (process.env.DISPLAY && process.env.SHOT) {
          try { execFileSync('import', ['-window', 'root', process.env.SHOT]); console.log(`[capture] ${process.env.SHOT}`); } catch (e) { console.log('[capture] échec', e.message); }
        }
        game.arreter();
      }, Number(process.env.SHOT_DELAY || 15000));
    }
  });
  const timeout = setTimeout(() => { console.log('[jeu] délai dépassé'); game.arreter(); }, Number(process.env.GAME_TIMEOUT || 240000));
  const code = await new Promise((r) => game.on('fermeture', r));
  clearTimeout(timeout);
  if (!reached) { console.log('--- dernières lignes ---\n' + tail.join('\n')); }
  console.log(`[résultat] ${version} ${loader} : ${reached ? 'OK menu atteint' : 'ÉCHEC'} (code ${code})`);
  process.exit(reached ? 0 : 1);
}

main().catch((e) => { console.error('[erreur]', e.code, e.message); process.exit(2); });
