'use strict';

/**
 * Parcours complet prepare → install → verify/repair → launch, sur un faux
 * « Internet » local (Mojang, Fabric, Java automatique), sans rien de réel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer, serve, tmpDir, sha1 } = require('../helpers');
const { __setTestMirror } = require('../../src/net/http');
const { runtimePlatform } = require('../../src/java/runtime');
const lanterne = require('../../src');

const isWin = process.platform === 'win32';
const plat = runtimePlatform();

// --- Contenu du faux Internet
const clientJar = Buffer.from('faux jeu');
const libJar = Buffer.from('fausse bibliothèque');
const fabricJar = Buffer.from('faux fabric');
const asset = Buffer.from('son');
const assetHash = sha1(asset);
const logXml = Buffer.from('<Configuration/>');
// « Java » : un petit script qui affiche ses arguments (ou -version).
const javaScript = Buffer.from('#!/bin/sh\nif [ "$1" = "-version" ]; then echo \'openjdk version "21.0.1"\' 1>&2; exit 0; fi\necho "ARGS $*"\nexit 0\n');

const assetIndex = Buffer.from(JSON.stringify({ objects: { 'minecraft/sounds/a.ogg': { hash: assetHash, size: asset.length } } }));
const runtimeManifest = Buffer.from(JSON.stringify({
  files: {
    bin: { type: 'directory' },
    'bin/java': { type: 'file', executable: true, downloads: { raw: { url: 'https://piston-data.mojang.com/rt/java', sha1: sha1(javaScript), size: javaScript.length } } },
    'bin/java-lien': { type: 'link', target: 'java' },
    'bin/evasion': { type: 'link', target: '../../../../../../etc/passwd' },
  },
}));
const runtimeIndex = Buffer.from(JSON.stringify({ [plat || 'linux']: { 'java-test': [{ manifest: { url: 'https://piston-meta.mojang.com/rt/manifest.json', sha1: sha1(runtimeManifest), size: runtimeManifest.length } }] } }));

const versionJson = Buffer.from(JSON.stringify({
  id: '1.0', type: 'release', mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { component: 'java-test', majorVersion: 21 },
  assetIndex: { id: '1', url: 'https://piston-meta.mojang.com/idx/1.json', sha1: sha1(assetIndex), size: assetIndex.length },
  assets: '1',
  downloads: { client: { url: 'https://piston-data.mojang.com/client.jar', sha1: sha1(clientJar), size: clientJar.length } },
  libraries: [{ name: 'com.mojang:lib:1', downloads: { artifact: { path: 'com/mojang/lib/1/lib-1.jar', url: 'https://libraries.minecraft.net/com/mojang/lib/1/lib-1.jar', sha1: sha1(libJar), size: libJar.length } } }],
  logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.xml', url: 'https://piston-data.mojang.com/log.xml', sha1: sha1(logXml), size: logXml.length }, type: 'log4j2-xml' } },
  arguments: {
    game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}', '--version', '${version_name}'],
    jvm: ['-javaagent:/tmp/pirate.jar', '-XX:OnOutOfMemoryError=calc.exe', '-Dsecret=${auth_access_token}', '-cp', '${classpath}'],
  },
}));
const manifest = Buffer.from(JSON.stringify({
  latest: { release: '1.0', snapshot: '1.0' },
  versions: [{ id: '1.0', type: 'release', url: 'https://piston-meta.mojang.com/v/1.0.json', sha1: sha1(versionJson) }],
}));
const fabricProfile = Buffer.from(JSON.stringify({
  id: 'fabric-loader-0.1-1.0', inheritsFrom: '1.0', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [], jvm: ['-DFabricMcEmu=net.minecraft.client.main.Main'] },
  libraries: [{ name: 'net.fabricmc:fabric-loader:0.1', url: 'https://maven.fabricmc.net/' }],
}));

// Forge ancien (format « versionInfo » + jar universal dans l'installeur)
const { makeZip } = require('../helpers');
const universal = Buffer.from('faux forge universal');
const forgeDep = Buffer.from('dépendance forge');
const forgeInstaller = makeZip([
  { name: 'install_profile.json', data: JSON.stringify({
    install: { path: 'net.minecraftforge:forge:1.0-1.0.0', filePath: 'forge-1.0-1.0.0-universal.jar' },
    versionInfo: {
      id: '1.0-Forge1.0.0', inheritsFrom: '1.0', mainClass: 'net.minecraft.launchwrapper.Launch',
      minecraftArguments: '--username ${auth_player_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker',
      libraries: [{ name: 'net.minecraftforge:forge:1.0-1.0.0' }, { name: 'org.x:dep:1', url: 'https://maven.minecraftforge.net/', checksums: [sha1(forgeDep)] }],
    },
  }) },
  { name: 'forge-1.0-1.0.0-universal.jar', data: universal },
]);

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SECRETSECRETSECRET123';

let srv;
let HOSTS;
test.before(async () => {
  srv = await startServer({
    '/piston-meta.mojang.com/mc/game/version_manifest_v2.json': serve(manifest),
    '/piston-meta.mojang.com/v/1.0.json': serve(versionJson),
    '/piston-meta.mojang.com/idx/1.json': serve(assetIndex),
    '/piston-data.mojang.com/client.jar': serve(clientJar),
    '/piston-data.mojang.com/log.xml': serve(logXml),
    '/libraries.minecraft.net/com/mojang/lib/1/lib-1.jar': serve(libJar),
    [`/resources.download.minecraft.net/${assetHash.slice(0, 2)}/${assetHash}`]: serve(asset),
    '/launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json': serve(runtimeIndex),
    '/piston-meta.mojang.com/rt/manifest.json': serve(runtimeManifest),
    '/piston-data.mojang.com/rt/java': serve(javaScript),
    '/meta.fabricmc.net/v2/versions/loader/1.0': serve(Buffer.from(JSON.stringify([{ loader: { version: '0.1', stable: true } }]))),
    '/meta.fabricmc.net/v2/versions/loader/1.0/0.1/profile/json': serve(fabricProfile),
    '/maven.fabricmc.net/net/fabricmc/fabric-loader/0.1/fabric-loader-0.1.jar': serve(fabricJar),
    '/maven.fabricmc.net/net/fabricmc/fabric-loader/0.1/fabric-loader-0.1.jar.sha1': serve(Buffer.from(sha1(fabricJar))),
    '/maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml': serve(Buffer.from('<metadata><versioning><versions><version>1.0-1.0.0</version></versions></versioning></metadata>')),
    '/files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json': serve(Buffer.from(JSON.stringify({ promos: { '1.0-recommended': '1.0.0' } }))),
    '/maven.minecraftforge.net/net/minecraftforge/forge/1.0-1.0.0/forge-1.0-1.0.0-installer.jar': serve(forgeInstaller),
    '/maven.minecraftforge.net/net/minecraftforge/forge/1.0-1.0.0/forge-1.0-1.0.0-installer.jar.sha1': serve(Buffer.from(sha1(forgeInstaller))),
    '/maven.minecraftforge.net/org/x/dep/1/dep-1.jar': serve(forgeDep),
    '/flaky/piston-meta.mojang.com/mc/game/version_manifest_v2.json': (req, res) => { res.statusCode = 503; res.end(); },
  });
  __setTestMirror(`https://localhost:${srv.port}/`);
  HOSTS = [`localhost:${srv.port}`];
});
test.after(async () => { __setTestMirror(null); await srv.close(); });

const skipNoRuntime = !plat || isWin ? 'pas de Java automatique de test pour cet ordinateur' : false;

test('vanilla : prepare → install → verify → launch (Java automatique)', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  const plan = await lanterne.prepare({ version: 'latest', root, allowedHosts: HOSTS });
  assert.equal(plan.id, '1.0');
  assert.equal(plan.java.auto, true);
  assert.ok(plan.count >= 5, `fichiers manquants : ${plan.count}`);
  assert.ok(plan.tailleMo >= 0);

  const stages = new Set();
  await lanterne.install(plan, { onProgress: (p) => stages.add(p.stage) });
  assert.ok(stages.has('java'), 'étape Java signalée');
  assert.ok(fs.existsSync(path.join(plan.java.dir, 'bin', 'java')));
  // Lien interne créé, lien qui sort du dossier ignoré.
  assert.ok(fs.lstatSync(path.join(plan.java.dir, 'bin', 'java-lien')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(plan.java.dir, 'bin', 'evasion')), false);

  const v = await lanterne.verify(plan);
  assert.equal(v.ok, true);

  const logs = [];
  const game = await lanterne.launch({ plan, account: { type: 'msa', name: 'Steve', uuid: '069a79f444e94726a5befca90e38aaf5', accessToken: TOKEN }, onLog: (l) => logs.push(l) });
  await new Promise((r) => game.on('fermeture', r));
  const all = game.exporterJournal({ anonyme: false });
  assert.ok(all.includes('ARGS'), all);
  assert.ok(!all.includes('SECRETSECRET'), 'jeton jamais visible');
  const argsLine = all.split('\n').find((l) => l.includes('ARGS'));
  assert.ok(!argsLine.includes('pirate.jar') && !argsLine.includes('calc.exe') && !argsLine.includes('-Dsecret'), 'options Java dangereuses retirées');
  assert.ok(!game.command.includes('pirate.jar'));
  assert.ok(all.includes('option Java ignorée'));
  assert.ok(!game.exporterJournal().includes('Steve'), 'pseudo retiré du journal exporté');
  assert.ok(!game.command.includes('SECRETSECRET'));
  await fsp.rm(root, { recursive: true, force: true });
});

test('fichier abîmé après installation : launch refuse, repair corrige', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  let plan = await lanterne.prepare({ version: '1.0', root, allowedHosts: HOSTS });
  await lanterne.install(plan);
  const lib = plan.libraries.find((l) => l.classpath).path;
  await fsp.writeFile(lib, Buffer.alloc(libJar.length, 0x41)); // même taille, contenu faux
  plan = await lanterne.prepare({ version: '1.0', root, allowedHosts: HOSTS });
  assert.equal(plan.count, 0, 'la vérification rapide ne voit rien (même taille)');
  await assert.rejects(lanterne.launch({ plan, account: { name: 'Steve' } }), { code: 'NOT_INSTALLED' });
  const r = await lanterne.repair(plan);
  assert.equal(r.repaired, 1);
  assert.equal(sha1(await fsp.readFile(lib)), sha1(libJar));
  await fsp.rm(root, { recursive: true, force: true });
});

test('fabric : profil, empreinte lue sur le maven, héritage de la version de base', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  const plan = await lanterne.prepare({ version: '1.0', loader: 'fabric', root, allowedHosts: HOSTS });
  assert.equal(plan.id, 'fabric-loader-0.1-1.0');
  assert.equal(plan.loaderVersion, '0.1');
  assert.ok(plan.libraries.some((l) => l.name === 'net.fabricmc:fabric-loader:0.1' && l.sha1 === sha1(fabricJar)));
  assert.ok(plan.libraries.some((l) => l.name === 'com.mojang:lib:1'), 'bibliothèques de la version de base gardées');
  assert.ok(plan.copyJar, 'jar du jeu copié sous le nom de la version moddée');
  await lanterne.install(plan);
  assert.equal((await lanterne.verify(plan)).ok, true);
  await fsp.rm(root, { recursive: true, force: true });
});

test('hors-ligne : ce qui est installé se relance sans réseau, le reste donne OFFLINE', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  const plan = await lanterne.prepare({ version: '1.0', root, allowedHosts: HOSTS });
  await lanterne.install(plan);
  const before = Object.values(srv.ctx.hits).reduce((a, b) => a + b, 0);
  const off = await lanterne.prepare({ version: '1.0', root, offline: true, allowedHosts: HOSTS });
  assert.equal(off.count, 0);
  assert.equal(off.offline, true);
  const after = Object.values(srv.ctx.hits).reduce((a, b) => a + b, 0);
  assert.equal(after, before, 'aucun accès réseau en hors-ligne');
  await assert.rejects(lanterne.prepare({ version: '1.0', loader: 'fabric', root, offline: true, allowedHosts: HOSTS }), { code: 'OFFLINE' });
  await fsp.rm(root, { recursive: true, force: true });
});

test('Internet coupé : bascule automatique sur ce qui est installé', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  await lanterne.install(await lanterne.prepare({ version: '1.0', root, allowedHosts: HOSTS }));
  __setTestMirror('https://localhost:1/'); // plus personne au bout
  try {
    const plan = await lanterne.prepare({ version: '1.0', root, allowedHosts: [...HOSTS, 'localhost:1'], timeout: 2000 });
    assert.equal(plan.offline, true);
    assert.equal(plan.count, 0);
  } finally {
    __setTestMirror(`https://localhost:${srv.port}/`);
  }
  await fsp.rm(root, { recursive: true, force: true });
});

test('version inconnue, chargeur inconnu, dossier manquant : erreurs claires', async () => {
  const root = await tmpDir();
  await assert.rejects(lanterne.prepare({ version: '9.9', root, allowedHosts: HOSTS }), { code: 'VERSION_NOT_FOUND' });
  await assert.rejects(lanterne.prepare({ version: '1.0', loader: 'optifine', root, allowedHosts: HOSTS }), { code: 'INVALID_OPTION' });
  await assert.rejects(lanterne.prepare({ version: '1.0' }), { code: 'INVALID_OPTION' });
  await assert.rejects(lanterne.prepare({ version: '../../etc', root, allowedHosts: HOSTS }), (e) => e.name === 'LaunchError');
  await fsp.rm(root, { recursive: true, force: true });
});

test('sites officiels seulement : sans autorisation du faux serveur, tout est refusé', async () => {
  const root = await tmpDir();
  // Par défaut, localhost n'est pas autorisé : prepare ne peut rien télécharger.
  await assert.rejects(lanterne.prepare({ version: '1.0', root }), (e) => ['OFFLINE', 'HOST_NOT_ALLOWED'].includes(e.code));
  await fsp.rm(root, { recursive: true, force: true });
});

test('Forge ancien : installeur vérifié, jar universal extrait, réparé s\'il est abîmé, retrouvé hors-ligne', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  let plan = await lanterne.prepare({ version: '1.0', loader: 'forge', root, allowedHosts: HOSTS });
  assert.equal(plan.id, '1.0-Forge1.0.0');
  assert.equal(plan.loaderVersion, '1.0.0');
  const uni = plan.generated.find((g) => g.name === 'net.minecraftforge:forge:1.0-1.0.0');
  assert.ok(uni, 'jar universal fourni par l\'installeur');
  assert.equal(sha1(await fsp.readFile(uni.path)), sha1(universal));
  assert.ok(plan.libraries.some((l) => l.name === 'org.x:dep:1' && l.sha1 === sha1(forgeDep)), 'empreinte « checksums » de l\'ancien Forge');
  await lanterne.install(plan);
  assert.equal((await lanterne.verify(plan)).ok, true);

  // Jar universal abîmé (même taille) : verify le voit, repair le ressort de l'installeur.
  await fsp.writeFile(uni.path, Buffer.alloc(universal.length, 0x42));
  const v = await lanterne.verify(plan);
  assert.equal(v.ok, false);
  await lanterne.repair(plan);
  assert.equal(sha1(await fsp.readFile(uni.path)), sha1(universal));

  // Jar supprimé : un nouveau prepare le remet.
  await fsp.rm(uni.path);
  plan = await lanterne.prepare({ version: '1.0', loader: 'forge', root, allowedHosts: HOSTS });
  assert.equal(sha1(await fsp.readFile(uni.path)), sha1(universal));

  // Hors-ligne : retrouvé malgré la majuscule de « Forge » dans le nom.
  const off = await lanterne.prepare({ version: '1.0', loader: 'forge', root, offline: true, allowedHosts: HOSTS });
  assert.equal(off.id, '1.0-Forge1.0.0');
  await fsp.rm(root, { recursive: true, force: true });
});

test('serveur Mojang en panne (503) : on joue avec ce qui est installé', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  await lanterne.install(await lanterne.prepare({ version: '1.0', root, allowedHosts: HOSTS }));
  __setTestMirror(`https://localhost:${srv.port}/flaky/`);
  try {
    const plan = await lanterne.prepare({ version: '1.0', root, allowedHosts: HOSTS });
    assert.equal(plan.offline, true);
    assert.equal(plan.count, 0);
  } finally {
    __setTestMirror(`https://localhost:${srv.port}/`);
  }
  await fsp.rm(root, { recursive: true, force: true });
});

test('premier lancement sans Internet : OFFLINE (et pas « version inconnue »)', async () => {
  const root = await tmpDir();
  await assert.rejects(lanterne.prepare({ version: '1.0', root, offline: true, allowedHosts: HOSTS }), { code: 'OFFLINE' });
  await fsp.rm(root, { recursive: true, force: true });
});

test('jeton jamais visible dans console.log d\'une erreur de lancement', { skip: skipNoRuntime }, async () => {
  const root = await tmpDir();
  const plan = await lanterne.prepare({ version: '1.0', root, allowedHosts: HOSTS });
  await lanterne.install(plan);
  await fsp.chmod(plan.java.executable, 0o644); // Java plus exécutable
  const err = await lanterne.launch({ plan, account: { type: 'msa', name: 'Steve', uuid: '069a79f444e94726a5befca90e38aaf5', accessToken: TOKEN } }).catch((e) => e);
  assert.equal(err.name, 'LaunchError');
  assert.ok(!require('node:util').inspect(err, { depth: 10 }).includes('SECRETSECRET'));
  await fsp.rm(root, { recursive: true, force: true });
});
