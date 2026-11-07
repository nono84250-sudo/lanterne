'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { makeZip, tmpDir } = require('../helpers');
const { openZip, extractZip, readZipEntry, safeParts } = require('../../src/zip/zip');

let dir;
test.before(async () => { dir = await tmpDir(); });
test.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

let n = 0;
async function zipFile(entries) {
  const f = path.join(dir, `z${n++}.zip`);
  await fsp.writeFile(f, makeZip(entries));
  return f;
}
const out = () => path.join(dir, `out${n++}`);

test('extraction normale (compressé + stocké), dossiers créés', async () => {
  const f = await zipFile([
    { name: 'a.txt', data: 'bonjour' },
    { name: 'sous/b.txt', data: 'monde', method: 0 },
    { name: 'vide/' },
    { name: 'META-INF/MANIFEST.MF', data: 'x' },
  ]);
  const d = out();
  const written = await extractZip(f, d, { exclude: ['META-INF/'] });
  assert.equal(written.length, 2);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'bonjour');
  assert.equal(fs.readFileSync(path.join(d, 'sous', 'b.txt'), 'utf8'), 'monde');
  assert.equal(fs.existsSync(path.join(d, 'META-INF')), false);
});

for (const [label, name] of [
  ['../', '../evil.txt'],
  ['../ caché', 'a/../../evil.txt'],
  ['antislash', '..\\evil.txt'],
  ['chemin absolu', '/etc/evil'],
  ['lecteur Windows', 'C:\\evil.txt'],
  ['lecteur Windows /', 'C:/evil.txt'],
  ['chemin UNC', '\\\\serveur\\x'],
  ['caractère nul', 'a\u0000b.txt'],
  ['points Windows', 'a/.. /evil'],
  ['flux NTFS', 'a.txt:secret'],
]) {
  test(`ZIP piégé refusé : ${label}`, async () => {
    const f = await zipFile([{ name: 'ok.txt', data: 'x' }, { name, data: 'pirate' }]);
    const d = out();
    await assert.rejects(extractZip(f, d), { code: 'ZIP_UNSAFE' });
    assert.equal(fs.existsSync(path.join(dir, 'evil.txt')), false);
  });
}

test('lien symbolique dans le zip : ignoré', async () => {
  const f = await zipFile([{ name: 'lien', data: '/etc/passwd', unixMode: 0o120777 }, { name: 'ok.txt', data: 'x' }]);
  const d = out();
  await extractZip(f, d);
  assert.equal(fs.existsSync(path.join(d, 'lien')), false);
  assert.equal(fs.existsSync(path.join(d, 'ok.txt')), true);
});

test('droits spéciaux (SUID, exécutable) jamais appliqués', { skip: process.platform === 'win32' }, async () => {
  const f = await zipFile([{ name: 'suid', data: 'x', unixMode: 0o104755 }]);
  const d = out();
  await extractZip(f, d);
  const mode = fs.statSync(path.join(d, 'suid')).mode & 0o7777;
  assert.equal(mode & 0o4000, 0);
  assert.equal(mode & 0o111, 0);
});

test('deux fichiers au même nom (même avec majuscules) : refusé', async () => {
  await assert.rejects(extractZip(await zipFile([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]), out()), { code: 'ZIP_UNSAFE' });
  await assert.rejects(extractZip(await zipFile([{ name: 'A.txt', data: '1' }, { name: 'a.TXT', data: '2' }]), out()), { code: 'ZIP_UNSAFE' });
});

test('bombe ZIP : taille annoncée dépassée → arrêt', async () => {
  const big = Buffer.alloc(5_000_000, 0);
  const f = await zipFile([{ name: 'bombe', data: big, declaredSize: 1000 }]);
  const d = out();
  await assert.rejects(extractZip(f, d), { code: 'ZIP_TOO_LARGE' });
  assert.equal(fs.existsSync(path.join(d, 'bombe')), false);
  assert.equal(fs.existsSync(path.join(d, 'bombe.part')), false);
});

test('bombe ZIP : taux de compression suspect refusé', async () => {
  const big = Buffer.alloc(50_000_000, 0);
  const f = await zipFile([{ name: 'bombe', data: big }]);
  await assert.rejects(extractZip(f, out()), { code: 'ZIP_TOO_LARGE' });
});

test('plafond du total décompressé et du nombre de fichiers', async () => {
  const f = await zipFile([{ name: 'a', data: Buffer.alloc(3000, 1) }, { name: 'b', data: Buffer.alloc(3000, 2) }]);
  await assert.rejects(extractZip(f, out(), { limits: { maxTotalSize: 5000 } }), { code: 'ZIP_TOO_LARGE' });
  await assert.rejects(extractZip(f, out(), { limits: { maxEntries: 1 } }), { code: 'ZIP_TOO_LARGE' });
  await assert.rejects(extractZip(f, out(), { limits: { maxEntrySize: 100 } }), { code: 'ZIP_TOO_LARGE' });
});

test('fichier abîmé : mauvaise empreinte CRC', async () => {
  const f = await zipFile([{ name: 'a.txt', data: 'bonjour', crc: 12345 }]);
  await assert.rejects(extractZip(f, out()), { code: 'ZIP_INVALID' });
});

test('fichier abîmé : données compressées invalides', async () => {
  const f = await zipFile([{ name: 'a.txt', data: 'bonjour', raw: Buffer.from('pas du deflate du tout !!') }]);
  await assert.rejects(extractZip(f, out()), { code: 'ZIP_INVALID' });
});

test('archive tronquée, vide, ou pas un zip', async () => {
  const good = makeZip([{ name: 'a.txt', data: 'bonjour' }]);
  const t = path.join(dir, 'trunc.zip');
  await fsp.writeFile(t, good.subarray(0, good.length - 10));
  await assert.rejects(openZip(t), { code: 'ZIP_INVALID' });
  const e = path.join(dir, 'empty.zip');
  await fsp.writeFile(e, '');
  await assert.rejects(openZip(e), { code: 'ZIP_INVALID' });
  const p = path.join(dir, 'pas.zip');
  await fsp.writeFile(p, Buffer.alloc(5000, 7));
  await assert.rejects(openZip(p), { code: 'ZIP_INVALID' });
  await assert.rejects(openZip(path.join(dir, 'absent.zip')), { code: 'FILESYSTEM' });
});

test('méthode de compression inconnue ou fichier chiffré : refusé', async () => {
  const f = await zipFile([{ name: 'a', data: 'x', method: 14 }]);
  await assert.rejects(extractZip(f, out()), { code: 'ZIP_INVALID' });
});

test('dossier de destination détourné par un lien vers l\'extérieur : refusé', { skip: process.platform === 'win32' }, async () => {
  const d = out();
  const outside = path.join(dir, 'dehors');
  await fsp.mkdir(d, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.symlink(outside, path.join(d, 'sous'));
  const f = await zipFile([{ name: 'sous/x.txt', data: 'pirate' }]);
  await assert.rejects(extractZip(f, d), { code: 'ZIP_UNSAFE' });
  assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
});

test('lire une entrée en mémoire, avec plafond', async () => {
  const f = await zipFile([{ name: 'install_profile.json', data: '{"a":1}' }]);
  assert.equal((await readZipEntry(f, 'install_profile.json')).toString(), '{"a":1}');
  assert.equal(await readZipEntry(f, 'absent'), null);
  await assert.rejects(readZipEntry(f, 'install_profile.json', 3), { code: 'ZIP_TOO_LARGE' });
});

test('strip + filter (bibliothèques embarquées « maven/ »)', async () => {
  const f = await zipFile([{ name: 'maven/a/b.jar', data: 'jar' }, { name: 'autre.txt', data: 'x' }]);
  const d = out();
  await extractZip(f, d, { strip: 'maven/' });
  assert.equal(fs.readFileSync(path.join(d, 'a', 'b.jar'), 'utf8'), 'jar');
  assert.equal(fs.existsSync(path.join(d, 'autre.txt')), false);
});

test('safeParts : noms normaux acceptés', () => {
  assert.deepEqual(safeParts('a/./b//c.txt'), ['a', 'b', 'c.txt']);
  assert.deepEqual(safeParts('org\\lwjgl\\x.so'), ['org', 'lwjgl', 'x.so']);
});

test('un vrai .jar de Mojang (si présent localement) s\'ouvre', { skip: !process.env.LANTERNE_REAL_JAR }, async () => {
  const z = await openZip(process.env.LANTERNE_REAL_JAR);
  assert.ok(z.entries.length > 10);
  await z.close();
});
