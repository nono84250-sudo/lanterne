'use strict';

/**
 * Comparaison avec l'ancienne bibliothèque (minecraft-launcher-core 3.18.2).
 * Les commandes de MCLC ont été capturées une fois (test/fixtures/mclc-3.18.2-commands.json,
 * sans chemins ni jeton). Ici, on reconstruit la nôtre sur des versions déjà installées
 * (node test/live/smoke.js d'abord) et on compare :
 *   - classe principale et classpath (même liste de fichiers) : doivent être identiques ;
 *   Versions : 1.8.9, 1.12.2, 1.16.5, 1.19.4, 1.20.1, 1.20.6, 1.21.11 et Fabric 1.20.1, capturées sous Linux.
 *   26.x n'est pas comparable : MCLC 3.18 ne sait pas la lancer. Les options Java ne sont pas comparées :
 *   MCLC ajoute ses propres réglages (-XX:-UseAdaptiveSizePolicy…) et oublie la config log4j de Mojang.
 *   - arguments du jeu : mêmes options. Différences connues et voulues :
 *       --assetIndex : nous prenons l'index officiel (ex. « 5 »), MCLC prend le numéro de version ;
 *       --userType   : « legacy » (hors-ligne, comme le launcher officiel), MCLC met « mojang ».
 *   node test/live/compare-mclc.js [dossier]
 */

const path = require('node:path');
const fs = require('node:fs');
const lib = require('../../src');

const EXPECTED_DIFF = new Set(['--assetIndex', '--userType']);
// Avec un chargeur, MCLC passe le numéro du jeu de base dans --version ; nous, l'id de la version lancée (comme le launcher officiel).
const LOADER_DIFF = new Set(['--version']);

(async () => {
  const root = process.argv[2] || path.join(__dirname, '..', '..', '.live-root');
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'mclc-3.18.2-commands.json'), 'utf8'));
  let bad = 0;
  for (const [version, theirs] of Object.entries(ref)) {
    const plan = await lib.prepare({ version, root, offline: true });
    const { args } = lib.buildArgs(plan, { account: { type: 'offline', name: 'Testeur' } });
    const mi = args.indexOf(plan.version.mainClass);
    const jvm = args.slice(0, mi);
    const game = args.slice(mi + 1);
    const cp = jvm[jvm.indexOf('-cp') + 1].split(path.delimiter).map((p) => path.basename(p)).sort();
    const keys = {};
    for (let i = 0; i < game.length; i++) if (game[i].startsWith('--')) keys[game[i]] = game[i + 1];
    const problems = [];
    if (plan.version.mainClass !== theirs.mainClass) problems.push(`classe principale ${plan.version.mainClass} ≠ ${theirs.mainClass}`);
    if (JSON.stringify(cp) !== JSON.stringify(theirs.classpath)) problems.push('classpath différent');
    for (const k of new Set([...Object.keys(keys), ...Object.keys(theirs.game)])) {
      if (!(k in keys)) problems.push(`option ${k} absente chez nous`);
      else if (!(k in theirs.game)) problems.push(`option ${k} en plus chez nous`);
      else if (theirs.game[k] !== '*' && theirs.game[k] !== keys[k] && !EXPECTED_DIFF.has(k) && !(plan.version._chain.length > 1 && LOADER_DIFF.has(k))) problems.push(`${k} : ${keys[k]} ≠ ${theirs.game[k]}`);
    }
    console.log(`${problems.length ? 'DIFFÉRENT' : 'ÉQUIVALENT'} ${version}${problems.length ? ' : ' + problems.join(' ; ') : ''}`);
    bad += problems.length ? 1 : 0;
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
