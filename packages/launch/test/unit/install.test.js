'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, serve, tmpDir, makeZip, sha1 } = require('../helpers');
const { install, verify, repair } = require('../../src/install/install');
const { createControl } = require('../../src/net/control');

const a = crypto.randomBytes(200_000);
const b = crypto.randomBytes(150_000);
const nat = makeZip([{ name: 'liblwjgl.so', data: 'natif' }, { name: 'META-INF/MANIFEST.MF', data: 'x' }]);
const evilNat = makeZip([{ name: '../../evil.so', data: 'pirate' }]);

let srv;
test.before(async () => {
  srv = await startServer({ '/a': serve(a), '/b': serve(b, { slow: 10_000, delay: 10 }), '/nat': serve(nat), '/evil': serve(evilNat) });
});
test.after(() => srv.close());

async function makePlan(extra = {}) {
  const root = await tmpDir();
  const files = [
    { url: srv.url('/a'), path: path.join(root, 'libraries', 'a.jar'), sha1: sha1(a), size: a.length, stage: 'librairies' },
    { url: srv.url('/b'), path: path.join(root, 'assets', 'objects', 'bb', 'b'), sha1: sha1(b), size: b.length, stage: 'sons et textures' },
    { url: srv.url('/nat'), path: path.join(root, 'libraries', 'nat.jar'), sha1: sha1(nat), size: nat.length, stage: 'librairies' },
  ];
  return {
    id: 'test', mcVersion: 'test', root, gameDir: path.join(root, 'instance'), offline: false, allowedHosts: [`localhost:${srv.port}`],
    version: {}, clientJar: path.join(root, 'versions', 'test', 'test.jar'), copyJar: null,
    libraries: [{ name: 'n:n:1:natives', path: files[2].path, sha1: files[2].sha1, native: true, classpath: false, exclude: ['META-INF/'] }],
    generated: [], forge: null,
    assetIndex: { id: 't', virtual: false, mapToResources: false, objects: [] },
    logging: null, java: { executable: process.execPath, runtime: null },
    files, missing: [...files], totalBytes: files.reduce((s, f) => s + f.size, 0), count: files.length,
    ...extra,
  };
}

test('installer : tout est téléchargé, vérifié, natives extraites sans META-INF', async () => {
  const plan = await makePlan();
  const progress = [];
  await install(plan, { onProgress: (p) => progress.push(p) });
  for (const f of plan.files) assert.equal(sha1(fs.readFileSync(f.path)), f.sha1);
  const nd = path.join(plan.root, 'versions', 'test', 'natives');
  assert.equal(fs.readFileSync(path.join(nd, 'liblwjgl.so'), 'utf8'), 'natif');
  assert.equal(fs.existsSync(path.join(nd, 'META-INF')), false);
  assert.ok(progress.at(-1).percent === 100);
  assert.equal(plan.missing.length, 0);
  const v = await verify(plan);
  assert.equal(v.ok, true);
});

test('vérifier + réparer : ne retélécharge que le fichier abîmé', async () => {
  const plan = await makePlan();
  await install(plan);
  // On abîme un fichier (même taille, contenu différent) et on en supprime un autre.
  const damaged = plan.files[0].path;
  const buf = fs.readFileSync(damaged); buf[100] ^= 0xff; fs.writeFileSync(damaged, buf);
  fs.rmSync(plan.files[1].path);
  const v = await verify(plan);
  assert.equal(v.ok, false);
  assert.deepEqual(v.damaged.map((f) => f.path).sort(), [plan.files[0].path, plan.files[1].path].sort());
  const hitsBefore = { ...srv.ctx.hits };
  const r = await repair(plan);
  assert.equal(r.repaired, 2);
  assert.equal((srv.ctx.hits['/nat'] || 0) - (hitsBefore['/nat'] || 0), 0, 'le fichier sain n\'est pas retéléchargé');
  assert.equal((await verify(plan)).ok, true);
});

test('hors-ligne avec des fichiers manquants : erreur claire', async () => {
  const plan = await makePlan({ offline: true });
  await assert.rejects(install(plan), { code: 'OFFLINE' });
});

test('hors-ligne quand tout est installé : aucun accès réseau', async () => {
  const plan = await makePlan();
  await install(plan);
  const before = JSON.stringify(srv.ctx.hits);
  const again = { ...plan, offline: true, missing: [] };
  await install(again);
  assert.equal(JSON.stringify(srv.ctx.hits), before);
});

test('annuler pendant l\'installation (option « annuler » du PDF)', async () => {
  const plan = await makePlan();
  const c = createControl();
  setTimeout(() => c.cancel(), 50);
  await assert.rejects(install(plan, { annuler: c }), { code: 'CANCELLED' });
  assert.equal(fs.existsSync(plan.files[1].path), false);
});

test('pause pendant l\'installation, puis reprise', async () => {
  const plan = await makePlan();
  const c = createControl();
  setTimeout(() => c.pause(), 20);
  let pausedProgress = null;
  setTimeout(() => { pausedProgress = c.paused; c.resume(); }, 300);
  await install(plan, { control: c });
  assert.equal(pausedProgress, true);
  assert.equal((await verify(plan)).ok, true);
});

test('natives piégées (../) : refusées', async () => {
  const plan = await makePlan();
  const evil = { url: srv.url('/evil'), path: path.join(plan.root, 'libraries', 'evil.jar'), sha1: sha1(evilNat), size: evilNat.length };
  plan.files.push(evil); plan.missing.push(evil);
  plan.libraries.push({ name: 'e:e:1:natives', path: evil.path, sha1: evil.sha1, native: true, classpath: false });
  await assert.rejects(install(plan), { code: 'ZIP_UNSAFE' });
  assert.equal(fs.existsSync(path.join(plan.root, 'versions', 'evil.so')), false);
});

test('fichier fourni par un chargeur absent : erreur NOT_INSTALLED', async () => {
  const plan = await makePlan();
  plan.generated.push({ path: path.join(plan.root, 'libraries', 'forge-universal.jar') });
  await assert.rejects(install(plan), { code: 'NOT_INSTALLED' });
});

test('anciennes versions : sons copiés sous leur vrai nom (virtual)', async () => {
  const plan = await makePlan();
  plan.assetIndex = { id: 'legacy', virtual: true, mapToResources: false, objects: [{ name: 'sound/a.ogg', hash: sha1(b), path: plan.files[1].path }] };
  await install(plan);
  assert.equal(sha1(fs.readFileSync(path.join(plan.root, 'assets', 'virtual', 'legacy', 'sound', 'a.ogg'))), sha1(b));
  await fsp.rm(plan.root, { recursive: true, force: true });
});
