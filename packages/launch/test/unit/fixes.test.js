'use strict';

/** Tests des corrections demandées par la première relecture. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { tmpDir, makeZip, startServer, serve, sha1 } = require('../helpers');
const { buildArgs } = require('../../src/launch/args');
const { lineSplitter, anonymize } = require('../../src/launch/launch');
const { mergeVersion } = require('../../src/manifest/versions');
const { createControl } = require('../../src/net/control');
const { downloadFile } = require('../../src/net/download');
const { safeRelPath, parseMaven } = require('../../src/manifest/maven');
const { rulesAllow } = require('../../src/manifest/rules');
const { runtimePlatform, finishRuntime } = require('../../src/java/runtime');
const { extractZip } = require('../../src/zip/zip');
const { toLaunchError, LaunchError } = require('../../src/errors');
const { verify } = require('../../src/install/install');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SECRETSECRETSECRET123';
const MSA = { type: 'msa', name: 'Steve', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', accessToken: TOKEN };

function plan(version) {
  return {
    id: version.id, root: '/r', gameDir: '/r/i', version, clientJar: '/r/c.jar', libraries: [],
    assetIndex: { id: '1', objects: [] }, logging: null, java: { executable: 'java' },
  };
}

test('options Java venant d\'un JSON : les dangereuses sont retirées, celles de l\'appelant gardées', () => {
  const v = {
    id: 'x', mainClass: 'M',
    arguments: {
      jvm: ['-javaagent:a.jar', '-agentlib:jdwp=x', '-agentpath:/x', '@/tmp/args', '-Xbootclasspath/a:x', '-XX:OnError=sh',
        '-XX:OnOutOfMemoryError=x', '-XX:StartFlightRecording', '-Dtok=${auth_access_token}', '-Dok=1', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-cp', '${classpath}'],
      game: ['--accessToken', '${auth_access_token}'],
    },
  };
  const logs = [];
  const r = buildArgs(plan(v), { account: MSA, jvmArgs: ['-Dmine=1'], onLog: (l) => logs.push(l) });
  const joined = r.args.join(' ');
  for (const bad of ['javaagent', 'agentlib', 'agentpath', '@/tmp', 'Xbootclasspath', 'OnError', 'OnOutOfMemory', 'FlightRecording', '-Dtok']) {
    assert.ok(!joined.includes(bad), bad);
  }
  assert.ok(r.args.includes('-Dok=1') && r.args.includes('--add-opens') && r.args.includes('-Dmine=1'));
  assert.ok(r.args.includes(TOKEN), 'le jeton reste dans les arguments du jeu');
  assert.equal(r.ignored.length, 9);
  assert.equal(logs.length, 9);
  assert.ok(!logs.join('').includes('SECRETSECRET'));
  assert.equal(r.account.accessToken, undefined, 'le jeton ne ressort pas dans account');
});

test('options conseillées par Mojang (26.x) : ignorées si l\'appelant donne les siennes', () => {
  const v = { id: 'x', mainClass: 'M', arguments: { 'default-user-jvm': ['-Xmx2G', '-XX:+UseG1GC'], jvm: [], game: [] } };
  assert.ok(buildArgs(plan(v), {}).args.includes('-XX:+UseG1GC'));
  const r = buildArgs(plan(v), { jvmArgs: ['-XX:+UseZGC'] });
  assert.ok(!r.args.includes('-XX:+UseG1GC') && r.args.includes('-XX:+UseZGC'));
  const m = buildArgs(plan(v), { memory: { max: 4096 } });
  assert.ok(m.args.includes('-Xmx4096M') && !m.args.includes('-Xmx2G'));
});

test('fusion des versions : LWJGL du parent n\'est jamais perdu', () => {
  const parent = { id: 'p', mainClass: 'P', libraries: [
    { name: 'org.lwjgl:lwjgl:3.3.1' }, { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux' }, { name: 'org.lwjgl:lwjgl:3.3.1', rules: [{ action: 'allow', os: { name: 'osx' } }] },
    { name: 'org.ow2.asm:asm:9.1' },
  ], assetIndex: { id: 'p' }, downloads: { client: {} } };
  const child = { id: 'c', mainClass: 'C', libraries: [{ name: 'org.ow2.asm:asm:9.6' }], assetIndex: { id: 'evil' } };
  const m = mergeVersion(parent, child);
  const names = m.libraries.map((l) => l.name);
  assert.equal(names.filter((n) => n === 'org.lwjgl:lwjgl:3.3.1').length, 2, 'variantes par OS gardées');
  assert.ok(names.includes('org.lwjgl:lwjgl:3.3.1:natives-linux'));
  assert.ok(names.includes('org.ow2.asm:asm:9.6') && !names.includes('org.ow2.asm:asm:9.1'), 'l\'enfant remplace');
  assert.equal(m.assetIndex.id, 'p', 'les sons et textures viennent toujours du jeu de base');
  assert.equal(m.mainClass, 'C');
});

test('contrôle : une annulation interne n\'annule pas celui de l\'appelant', async () => {
  const parent = createControl();
  const child = createControl(parent);
  child.cancel();
  assert.equal(parent.cancelled, false);
  const c2 = createControl(parent);
  parent.pause();
  assert.equal(c2.paused, true);
  let done = false;
  const w = c2.wait().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false);
  parent.resume();
  c2.resume();
  await w;
  parent.cancel();
  assert.equal(c2.cancelled, true);
  child.dispose(); c2.dispose();
});

test('un même fichier demandé deux fois en même temps : un seul téléchargement', async () => {
  const body = Buffer.alloc(50_000, 7);
  const srv = await startServer({ '/f': serve(body, { slow: 50_000, delay: 5 }) });
  const dir = await tmpDir();
  try {
    const f = { url: srv.url('/f'), path: path.join(dir, 'f.bin'), sha1: sha1(body), size: body.length };
    const o = { allowedHosts: [`localhost:${srv.port}`] };
    await Promise.all([downloadFile(f, o), downloadFile({ ...f }, o)]);
    assert.equal(srv.ctx.hits['/f'], 1);
    assert.equal(sha1(await fsp.readFile(f.path)), sha1(body));
  } finally { await srv.close(); await fsp.rm(dir, { recursive: true, force: true }); }
});

test('noms Windows interdits, point final, « ; » : refusés', () => {
  for (const bad of ['CON', 'nul.txt', 'a/COM1/b', 'a./b', 'a /b', 'x;y', 'C:x', 'a\\..\\b', '..', './a']) {
    assert.throws(() => safeRelPath(bad), { code: 'MANIFEST_INVALID' }, bad);
  }
  assert.equal(safeRelPath('a\\b/c.txt'), 'a/b/c.txt');
  assert.throws(() => parseMaven('a:con:1'), { code: 'MANIFEST_INVALID' });
  assert.throws(() => parseMaven('a:b:1.'), { code: 'MANIFEST_INVALID' });
});

test('règles : expression piégée (ReDoS) ignorée, jamais exécutée', () => {
  const t = Date.now();
  const r = rulesAllow([{ action: 'allow', os: { name: 'linux', version: '^(a+)+$' } }], { os: { name: 'linux', arch: 'x86_64', version: 'a'.repeat(40) + 'b' } });
  assert.equal(r, false);
  assert.ok(Date.now() - t < 100);
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], { os: { name: 'windows', version: '10.0.19045' } }), true);
});

test('Java automatique : ordinateurs ARM', () => {
  assert.equal(runtimePlatform('darwin', 'arm64'), 'mac-os-arm64');
  assert.equal(runtimePlatform('win32', 'arm64'), 'windows-arm64');
  assert.equal(runtimePlatform('linux', 'arm64'), null);
  assert.equal(runtimePlatform('linux', 'x64'), 'linux');
});

test('Java automatique : un lien ne sort jamais du dossier, ne vise ni dossier ni lien', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmpDir();
  const rt = path.join(dir, 'rt');
  await fsp.mkdir(path.join(rt, 'bin'), { recursive: true });
  await fsp.writeFile(path.join(rt, 'bin', 'java'), 'x');
  await fsp.mkdir(path.join(rt, 'lib'));
  await finishRuntime({
    dir: rt, dirs: [], executables: [path.join(rt, 'bin', 'java')],
    links: [
      { path: path.join(rt, 'bin', 'ok'), target: 'java' },
      { path: path.join(rt, 'bin', 'out'), target: '../../outside' },
      { path: path.join(rt, 'bin', 'abs'), target: '/etc/passwd' },
      { path: path.join(rt, 'bin', 'dir'), target: '../lib' },
      { path: path.join(rt, 'bin', 'chain'), target: 'ok' },
    ],
  });
  assert.ok(fs.lstatSync(path.join(rt, 'bin', 'ok')).isSymbolicLink());
  for (const n of ['out', 'abs', 'dir', 'chain']) assert.equal(fs.existsSync(path.join(rt, 'bin', n)), false, n);
  assert.ok((fs.statSync(path.join(rt, 'bin', 'java')).mode & 0o111) !== 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('ZIP : « ./META-INF » est bien exclu (nom normalisé avant le filtre)', async () => {
  const dir = await tmpDir();
  const z = path.join(dir, 'n.jar');
  await fsp.writeFile(z, makeZip([{ name: './META-INF/x.SF', data: 'sig' }, { name: 'lib.so', data: 'n' }]));
  await extractZip(z, path.join(dir, 'out'), { exclude: ['META-INF/'] });
  assert.ok(fs.existsSync(path.join(dir, 'out', 'lib.so')));
  assert.equal(fs.existsSync(path.join(dir, 'out', 'META-INF')), false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('journal : caractère UTF-8 coupé entre deux morceaux, jeton jamais coupé en deux', () => {
  const lines = [];
  const s = lineSplitter((l) => lines.push(l));
  const e = Buffer.from('Bonjour éàü\n');
  s.push(e.subarray(0, 9)); s.push(e.subarray(9));
  assert.equal(lines[0], 'Bonjour éàü');
  // Ligne énorme sans retour : vidée par morceaux, mais le jeton reste entier.
  const big = 'x '.repeat(40_000) + TOKEN + ' fin';
  s.push(Buffer.from(big)); s.end();
  assert.ok(lines.slice(1).some((l) => l.includes(TOKEN)), 'jeton entier dans un seul morceau');
});

test('journal exporté : pseudo, identifiant et dossier personnel retirés', () => {
  const home = os.homedir();
  const t = anonymize(`Setting user: Steve\nUUID 069a79f444e94726a5befca90e38aaf5 / 069a79f4-44e9-4726-a5be-fca90e38aaf5\n${home}/x\nSteveBot reste`, { name: 'Steve', uuid: '069a79f444e94726a5befca90e38aaf5' });
  assert.ok(!/\bSteve\b/.test(t));
  assert.ok(t.includes('SteveBot'));
  assert.ok(!t.includes('069a79f4'));
  if (home.length >= 3) assert.ok(!t.includes(home));
});

test('erreurs : tout devient LaunchError avec un message clair', () => {
  assert.equal(toLaunchError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code, 'DISK_FULL');
  assert.equal(toLaunchError(new TypeError('boom')).code, 'INTERNAL');
  const le = new LaunchError('NETWORK');
  assert.equal(toLaunchError(le), le);
});

test('vérifier : la copie du jeu pour le chargeur est contrôlée aussi', async () => {
  const dir = await tmpDir();
  const to = path.join(dir, 'v', 'v.jar');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, 'faux');
  const r = await verify({ files: [], forge: null, copyJar: { to, sha1: sha1(Buffer.from('vrai')), size: 4 }, generated: [], root: dir, id: 'v' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.incomplete, [to]);
  await fsp.rm(dir, { recursive: true, force: true });
});
