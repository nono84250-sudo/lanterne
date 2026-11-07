'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { tmpDir } = require('../helpers');
const { rulesAllow, compareDotted, inVersionRange } = require('../../src/manifest/rules');
const { parseMaven, libraryKey, safeRelPath } = require('../../src/manifest/maven');
const { mergeVersion, resolveVersion, checkId, resolveAlias, getVersionManifest } = require('../../src/manifest/versions');
const { resolveLibraries } = require('../../src/install/plan');
const { neoforgePrefix, fixRepoUrl, mavenVersions, normalizeLoader } = require('../../src/loaders');

const WIN = { name: 'windows', arch: 'x86_64', version: '10.0.22631' };
const OLDWIN = { name: 'windows', arch: 'x86_64', version: '10.0.10240' };
const MAC = { name: 'osx', arch: 'arm64', version: '23.1.0' };
const LINUX = { name: 'linux', arch: 'x86_64', version: '6.1' };
const X86 = { name: 'windows', arch: 'x86', version: '10.0.19045' };

test('règles : système, processeur, fonctionnalités', () => {
  assert.equal(rulesAllow(undefined, { os: WIN }), true);
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'osx' } }], { os: WIN }), false);
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'osx' } }], { os: MAC }), true);
  assert.equal(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], { os: MAC }), false);
  assert.equal(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], { os: LINUX }), true);
  assert.equal(rulesAllow([{ action: 'allow', os: { arch: 'x86' } }], { os: X86 }), true);
  assert.equal(rulesAllow([{ action: 'allow', os: { arch: 'x86' } }], { os: WIN }), false);
  assert.equal(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], { os: WIN, features: { is_demo_user: true } }), true);
  assert.equal(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], { os: WIN, features: {} }), false);
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], { os: WIN }), true);
  // expression invalide ou trop longue : jamais de plantage
  assert.equal(rulesAllow([{ action: 'allow', os: { version: '(' } }], { os: WIN }), false);
});

test('règles 26.x : versionRange (min inclus, max exclu)', () => {
  const zgc = [{ action: 'allow', os: { name: 'windows', versionRange: { min: '10.0.17134' } } }];
  const g1 = [{ action: 'allow', os: { name: 'windows', versionRange: { max: '10.0.17134' } } }];
  assert.equal(rulesAllow(zgc, { os: WIN }), true);
  assert.equal(rulesAllow(g1, { os: WIN }), false);
  assert.equal(rulesAllow(zgc, { os: OLDWIN }), false);
  assert.equal(rulesAllow(g1, { os: OLDWIN }), true);
  assert.equal(compareDotted('10.0.17134', '10.0.17134'), 0);
  assert.equal(inVersionRange({ min: '1.2', max: '1.3' }, '1.2.5'), true);
});

test('maven : noms → chemins, refus des noms dangereux', () => {
  assert.equal(parseMaven('org.lwjgl:lwjgl:3.3.1').path, 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar');
  assert.equal(parseMaven('org.lwjgl:lwjgl:3.3.1:natives-windows').path, 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar');
  assert.equal(parseMaven('de.oceanlabs.mcp:mcp_config:1.20.1-2023@zip').path, 'de/oceanlabs/mcp/mcp_config/1.20.1-2023/mcp_config-1.20.1-2023.zip');
  assert.equal(parseMaven('net.fabricmc:sponge-mixin:0.16.3+mixin.0.8.7').file, 'sponge-mixin-0.16.3+mixin.0.8.7.jar');
  for (const bad of ['a:b', '..:x:1', 'a:..:1', 'a:b:../../x', 'a/b:c:1', 'a:b:1:c:d', 'a:b:1@../x']) {
    assert.throws(() => parseMaven(bad), { code: 'MANIFEST_INVALID' }, bad);
  }
  assert.equal(libraryKey('org.ow2.asm:asm:9.6'), 'org.ow2.asm:asm');
  assert.equal(libraryKey('org.lwjgl:lwjgl:3.3:natives-linux'), 'org.lwjgl:lwjgl:natives-linux');
  assert.throws(() => safeRelPath('../x'), { code: 'MANIFEST_INVALID' });
  assert.throws(() => safeRelPath('/etc/x'), { code: 'MANIFEST_INVALID' });
  assert.throws(() => safeRelPath('C:/x'), { code: 'MANIFEST_INVALID' });
  assert.equal(safeRelPath('a/b/c.jar'), 'a/b/c.jar');
});

test('noms de version : refus des noms dangereux', () => {
  assert.equal(checkId('1.21.4'), '1.21.4');
  assert.equal(checkId('fabric-loader-0.16.9-1.21.4'), 'fabric-loader-0.16.9-1.21.4');
  for (const bad of ['../x', 'a/b', 'a\\b', '', '.', 'x'.repeat(200), 'a\u0000']) assert.throws(() => checkId(bad), { code: 'INVALID_OPTION' });
});

test('héritage : l\'enfant remplace les bibliothèques du parent, arguments ajoutés', () => {
  const parent = {
    id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', type: 'release',
    libraries: [{ name: 'org.ow2.asm:asm:9.1' }, { name: 'com.google:guava:31' }],
    arguments: { game: ['--a'], jvm: ['-cp', '${classpath}'] },
    assetIndex: { id: '5' }, downloads: { client: {} }, javaVersion: { component: 'java-runtime-gamma' },
    logging: { client: { argument: 'x' } },
  };
  const child = {
    id: 'forge', inheritsFrom: '1.20.1', mainClass: 'cpw.Boot',
    libraries: [{ name: 'org.ow2.asm:asm:9.6' }],
    arguments: { game: ['--launchTarget', 'forgeclient'], jvm: ['-p', 'x'] },
    logging: {},
  };
  const m = mergeVersion({ ...parent, _chain: ['1.20.1'] }, child);
  assert.equal(m.mainClass, 'cpw.Boot');
  assert.deepEqual(m.libraries.map((l) => l.name), ['org.ow2.asm:asm:9.6', 'com.google:guava:31']);
  assert.deepEqual(m.arguments.game, ['--a', '--launchTarget', 'forgeclient']);
  assert.deepEqual(m.arguments.jvm, ['-cp', '${classpath}', '-p', 'x']);
  assert.equal(m.assetIndex.id, '5');
  assert.deepEqual(m.logging, parent.logging, 'logging vide ne doit pas effacer celui du parent');
  assert.deepEqual(m._chain, ['1.20.1', 'forge']);
  assert.equal(m.inheritsFrom, undefined);
});

test('héritage depuis le disque (hors-ligne), boucle refusée', async () => {
  const root = await tmpDir();
  const w = async (id, data) => {
    await fsp.mkdir(path.join(root, 'versions', id), { recursive: true });
    await fsp.writeFile(path.join(root, 'versions', id, `${id}.json`), JSON.stringify(data));
  };
  await w('base', { id: 'base', mainClass: 'A', libraries: [{ name: 'a:b:1' }] });
  await w('mod', { id: 'mod', inheritsFrom: 'base', mainClass: 'B', libraries: [{ name: 'a:c:1' }] });
  await w('boucle', { id: 'boucle', inheritsFrom: 'boucle' });
  const v = await resolveVersion('mod', { root, offline: true });
  assert.equal(v.mainClass, 'B');
  assert.equal(v.libraries.length, 2);
  await assert.rejects(resolveVersion('boucle', { root, offline: true }), { code: 'MANIFEST_INVALID' });
  await assert.rejects(getVersionManifest({ root, offline: true }), { code: 'OFFLINE' });
  // Hors-ligne sans liste des versions en cache : on ne sait pas, c'est un manque d'Internet.
  await assert.rejects(resolveVersion('absent', { root, offline: true }), { code: 'OFFLINE' });
  // Avec la liste en cache, une version inconnue est bien « introuvable ».
  await fsp.mkdir(path.join(root, 'cache'), { recursive: true });
  await fsp.writeFile(path.join(root, 'cache', 'version_manifest_v2.json'), JSON.stringify({ latest: { release: 'base' }, versions: [{ id: 'base', url: 'https://x/base.json' }] }));
  await assert.rejects(resolveVersion('absent', { root, offline: true }), { code: 'VERSION_NOT_FOUND' });
  await assert.rejects(resolveVersion('base2', { root, offline: true }), { code: 'VERSION_NOT_FOUND' });
  await fsp.rm(root, { recursive: true, force: true });
});

test('alias de version', () => {
  const m = { latest: { release: '26.3', snapshot: '26.4-snapshot-7' } };
  assert.equal(resolveAlias(m, 'latest'), '26.3');
  assert.equal(resolveAlias(m, 'dernière'), '26.3');
  assert.equal(resolveAlias(m, 'snapshot'), '26.4-snapshot-7');
  assert.equal(resolveAlias(m, '1.8.9'), '1.8.9');
});

test('bibliothèques : natives anciennes (classifiers, ${arch}), règles, maven', () => {
  const L = { libraries: '/r/libraries' };
  const v = {
    libraries: [
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4',
        natives: { linux: 'natives-linux', windows: 'natives-windows-${arch}' },
        extract: { exclude: ['META-INF/'] },
        downloads: { classifiers: {
          'natives-linux': { path: 'o/l/natives-linux.jar', url: 'https://libraries.minecraft.net/o/l/natives-linux.jar', sha1: 'a'.repeat(40), size: 1 },
          'natives-windows-64': { path: 'o/l/natives-windows-64.jar', url: 'https://libraries.minecraft.net/o/l/w.jar', sha1: 'b'.repeat(40), size: 2 },
        } },
      },
      { name: 'only:mac:1', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'only/mac/1/mac-1.jar', url: 'https://x/y', sha1: 'c'.repeat(40) } } },
      { name: 'net.fabricmc:intermediary:1.21', url: 'https://maven.fabricmc.net/', sha1: 'd'.repeat(40), size: 9 },
      { name: 'net.minecraftforge:forge:1.12.2', downloads: { artifact: { path: 'net/minecraftforge/forge/1.12.2/forge.jar', url: '', sha1: 'e'.repeat(40) } } },
    ],
  };
  const lin = resolveLibraries(v, L, LINUX, {});
  assert.deepEqual(lin.map((l) => [l.name, l.native]), [
    ['org.lwjgl.lwjgl:lwjgl-platform:2.9.4:natives-linux', true],
    ['net.fabricmc:intermediary:1.21', false],
    ['net.minecraftforge:forge:1.12.2', false],
  ]);
  assert.equal(lin[1].url, 'https://maven.fabricmc.net/net/fabricmc/intermediary/1.21/intermediary-1.21.jar');
  assert.equal(lin[2].url, null, 'fourni par l\'installeur');
  const win = resolveLibraries(v, L, WIN, {});
  assert.equal(win[0].name, 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4:natives-windows-64');
  assert.equal(resolveLibraries(v, L, MAC, {}).some((l) => l.name === 'only:mac:1'), true);
  // chemin dangereux dans un JSON : refusé
  assert.throws(() => resolveLibraries({ libraries: [{ name: 'a:b:1', downloads: { artifact: { path: '../../evil.jar', url: 'https://x' } } }] }, L, LINUX, {}), { code: 'MANIFEST_INVALID' });
});

test('chargeurs : noms, adresses corrigées, versions NeoForge', () => {
  assert.equal(normalizeLoader('NeoForge'), 'neoforge');
  assert.equal(normalizeLoader(undefined), 'vanilla');
  assert.throws(() => normalizeLoader('optifine'), { code: 'INVALID_OPTION' });
  assert.equal(fixRepoUrl('http://files.minecraftforge.net/maven/'), 'https://maven.minecraftforge.net/');
  assert.equal(fixRepoUrl(undefined), 'https://libraries.minecraft.net/');
  assert.equal(fixRepoUrl('https://maven.fabricmc.net'), 'https://maven.fabricmc.net/');
  assert.equal(neoforgePrefix('1.21.11'), '21.11.');
  assert.equal(neoforgePrefix('1.21'), '21.0.');
  assert.equal(neoforgePrefix('26.3'), '26.3.0.');
  assert.equal(neoforgePrefix('26.3.1'), '26.3.1.');
  assert.deepEqual(mavenVersions('<versions><version>1</version><version>2-beta</version></versions>'), ['1', '2-beta']);
});
