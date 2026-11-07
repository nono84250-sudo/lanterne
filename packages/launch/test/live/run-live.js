'use strict';

/**
 * Essais réels (Internet + vrai Minecraft) : toute la matrice demandée, une
 * version après l'autre, puis un résumé. Long (plusieurs Go la première fois).
 *   node test/live/run-live.js                 → toute la matrice
 *   node test/live/run-live.js 1.20.1 fabric   → un seul essai
 * Sous Linux sans écran, xvfb-run est utilisé s'il est installé.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MATRIX = [
  ['1.8.9', 'vanilla'], ['1.8.9', 'forge'],
  ['1.12.2', 'vanilla'], ['1.12.2', 'forge'], ['1.12.2', 'vanilla', '--demo'],
  ['1.20.1', 'vanilla'], ['1.20.1', 'fabric'], ['1.20.1', 'quilt'], ['1.20.1', 'forge'], ['1.20.1', 'neoforge'],
  ['1.21.11', 'vanilla'], ['1.21.11', 'fabric'], ['1.21.11', 'quilt'], ['1.21.11', 'forge'], ['1.21.11', 'neoforge'],
  ['1.21.11', 'vanilla', '--offline'],
  ['latest', 'vanilla'], ['latest', 'fabric'], ['latest', 'forge'], ['latest', 'neoforge'], ['latest', 'quilt'],
];

const smoke = path.join(__dirname, 'smoke.js');
const args = process.argv.slice(2);
const runs = args.length ? [args] : MATRIX;
const useXvfb = process.platform === 'linux' && !process.env.DISPLAY && spawnSync('which', ['xvfb-run']).status === 0;

const results = [];
for (const run of runs) {
  const t0 = Date.now();
  const cmd = useXvfb ? 'xvfb-run' : process.execPath;
  const cmdArgs = useXvfb ? ['-a', '-s', '-screen 0 1280x720x24', process.execPath, smoke, ...run] : [smoke, ...run];
  console.log(`\n=== ${run.join(' ')} ===`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', timeout: 25 * 60_000 });
  results.push({ run: run.join(' '), ok: r.status === 0, s: Math.round((Date.now() - t0) / 1000) });
}

console.log('\nRésumé :');
for (const r of results) console.log(`  ${r.ok ? 'OK   ' : 'ÉCHEC'} ${r.run.padEnd(28)} ${r.s} s`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
