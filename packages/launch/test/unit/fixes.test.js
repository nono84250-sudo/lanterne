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
  assert.ok(!r.args.includes('-Dok=1'), 'option inconnue : refusée (liste blanche)');
  assert.ok(r.args.includes('--add-opens') && r.args.includes('java.base/java.lang=ALL-UNNAMED') && r.args.includes('-Dmine=1'));
  assert.ok(r.args.includes(TOKEN), 'le jeton reste dans les arguments du jeu');
  assert.equal(r.ignored.length, 10);
  assert.equal(logs.length, 10);
  assert.ok(!logs.join('').includes('SECRETSECRET'));
  assert.equal(r.account.accessToken, undefined, 'le jeton ne ressort pas dans account');
});

test('liste blanche : envoi du jeton ailleurs ou journal piégé refusés, options Forge/NeoForge gardées', () => {
  const jvm = ['-Dminecraft.api.env=custom', '-Dminecraft.api.auth.host=https://evil', '-Dlog4j.configurationFile=https://evil/x.xml',
    '-Djavax.net.ssl.trustStore=/x', '-Dhttps.proxyHost=evil', '-XX:ArchiveClassesAtExit=/x', '-Dfabric.addMods=/x',
    '-p', '${library_directory}/a.jar', '--add-modules', 'ALL-MODULE-PATH', '--add-exports', 'java.base/sun.security.util=cpw.mods.securejarhandler',
    '-DignoreList=a,b', '-Dfml.pluginLayerLibraries=x', '--enable-native-access=ALL-UNNAMED', '-XX:+UseZGC', '-cp', '${classpath}'];
  const p = { ...plan({ id: 'x', mainClass: 'M', arguments: { jvm, game: [] } }), logging: { argument: '-Dlog4j.configurationFile=${path}', path: '/r/log.xml' } };
  const r = buildArgs(p, {});
  const j = r.args.join(' ');
  for (const bad of ['minecraft.api', 'evil', 'trustStore', 'Archive', 'addMods']) assert.ok(!j.includes(bad), bad);
  for (const good of ['-p', 'ALL-MODULE-PATH', '-DignoreList=a,b', '-Dfml.pluginLayerLibraries=x', '--enable-native-access=ALL-UNNAMED', '-XX:+UseZGC']) assert.ok(r.args.includes(good), good);
  assert.equal(r.args.filter((a) => a.startsWith('-Dlog4j.configurationFile')).length, 1);
  assert.equal(r.args.at(-2), '-Dlog4j.configurationFile=/r/log.xml', 'config des journaux de Mojang en dernier');
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

// ---- Tour 2

test('fusion : un JSON local dont l\'identifiant ne correspond pas au dossier est refusé', async () => {
  const { resolveVersion } = require('../../src/manifest/versions');
  const root = await tmpDir();
  await fsp.mkdir(path.join(root, 'versions', 'custom'), { recursive: true });
  await fsp.writeFile(path.join(root, 'versions', 'custom', 'custom.json'), JSON.stringify({ id: '../../../ailleurs/x', mainClass: 'M' }));
  await assert.rejects(resolveVersion('custom', { root, offline: true }), { code: 'MANIFEST_INVALID' });
  await fsp.rm(root, { recursive: true, force: true });
});

test('ZIP : aucun dossier créé de l\'autre côté d\'un lien', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmpDir();
  const out = path.join(dir, 'out');
  const ailleurs = path.join(dir, 'ailleurs');
  await fsp.mkdir(out); await fsp.mkdir(ailleurs);
  await fsp.symlink(ailleurs, path.join(out, 'lib'));
  const z = path.join(dir, 'z.zip');
  await fsp.writeFile(z, makeZip([{ name: 'lib/a/b/c.txt', data: 'x' }]));
  await assert.rejects(extractZip(z, out), { code: 'ZIP_UNSAFE' });
  assert.equal(fs.existsSync(path.join(ailleurs, 'a')), false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('sons et textures (anciennes versions) : jamais écrits à travers un lien', { skip: process.platform === 'win32' }, async () => {
  const { install } = require('../../src/install/install');
  const dir = await tmpDir();
  const obj = path.join(dir, 'assets', 'objects', 'aa', 'h');
  await fsp.mkdir(path.dirname(obj), { recursive: true });
  await fsp.writeFile(obj, 'son');
  const victim = path.join(dir, 'victime.txt');
  const gameDir = path.join(dir, 'inst');
  await fsp.mkdir(path.join(gameDir, 'resources'), { recursive: true });
  await fsp.symlink(victim, path.join(gameDir, 'resources', 'a.ogg'));
  await install({
    id: 't', root: dir, gameDir, offline: false, files: [], missing: [], libraries: [], generated: [], forge: null, copyJar: null,
    assetIndex: { id: 'pre', virtual: false, mapToResources: true, objects: [{ name: 'a.ogg', hash: sha1(Buffer.from('son')), path: obj, size: 3 }] },
    java: { auto: false, executable: 'java' },
  });
  assert.equal(fs.existsSync(victim), false, 'la cible du lien n\'est pas créée');
  assert.equal(fs.lstatSync(path.join(gameDir, 'resources', 'a.ogg')).isSymbolicLink(), false);
  assert.equal(await fsp.readFile(path.join(gameDir, 'resources', 'a.ogg'), 'utf8'), 'son');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('pause + annulation : une attente sur un fichier déjà en cours s\'arrête tout de suite', async () => {
  const body = Buffer.alloc(200_000, 3);
  const srv = await startServer({ '/p': serve(body, { slow: 20_000, delay: 20 }) });
  const dir = await tmpDir();
  try {
    const f = { url: srv.url('/p'), path: path.join(dir, 'p.bin'), sha1: sha1(body), size: body.length };
    const o = { allowedHosts: [`localhost:${srv.port}`] };
    const c1 = createControl();
    const first = downloadFile(f, { ...o, control: c1 });
    await new Promise((r) => setTimeout(r, 30));
    c1.pause();
    const c2 = createControl();
    const second = downloadFile({ ...f }, { ...o, control: c2 });
    setTimeout(() => c2.cancel(), 30);
    const t = Date.now();
    await assert.rejects(second, { code: 'CANCELLED' });
    assert.ok(Date.now() - t < 1000);
    c1.cancel();
    await first.catch(() => {});
  } finally { await srv.close(); await fsp.rm(dir, { recursive: true, force: true }); }
});

test('contrôle enfant : son annulation le réveille même si le parent est en pause', async () => {
  const parent = createControl();
  parent.pause();
  const child = createControl(parent);
  const w = child.wait();
  setTimeout(() => child.cancel(), 20);
  await assert.rejects(w, { code: 'CANCELLED' });
  child.dispose();
});

test('journal exporté : xuid et identifiant client retirés aussi', () => {
  const t = anonymize('--xuid 2535412345678901 --clientId abcdclientid', { xuid: '2535412345678901', clientId: 'abcdclientid' });
  assert.ok(!t.includes('2535412345678901') && !t.includes('abcdclientid'));
});

test('liste blanche : AUCUNE option Java réelle (Mojang 1.13→26.x, Fabric, Quilt, Forge, NeoForge) n\'est refusée', () => {
  const real = require('../fixtures/real-jvm-args.json');
  for (const [id, a] of Object.entries(real)) {
    const r = buildArgs(plan({ id, mainClass: 'M', arguments: { ...a, game: [] } }), {});
    assert.deepEqual(r.ignored, [], id);
  }
});

test('liste blanche : valeurs piégées refusées (classpath, module-path, chemins des natives, fabric.*)', () => {
  const jvm = ['-cp', '\\\\evil\\share\\payload.jar', '-p', '/tmp/x', '--add-modules', 'ALL-MODULE-PATH',
    '-Djava.library.path=\\\\evil\\share', '-Dorg.lwjgl.librarypath=/tmp/attacker', '-Djava.library.path=${natives_directory}/../../x',
    '-Dfabric.gameJarPath=/tmp/evil.jar', '-DlibraryDirectory=\\\\evil\\libs', '-Dfml.x=/etc/passwd'];
  const r = buildArgs(plan({ id: 'x', mainClass: 'M', arguments: { jvm, game: [] } }), {});
  const j = r.args.join(' ');
  for (const bad of ['evil', '/tmp/', 'attacker', 'passwd', '..']) assert.ok(!j.includes(bad), bad);
  assert.ok(r.args.includes('ALL-MODULE-PATH'));
});
