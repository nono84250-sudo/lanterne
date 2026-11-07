'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, serve, tmpDir, sha1 } = require('../helpers');
const { checkUrl, getJson, getBuffer } = require('../../src/net/http');
const { downloadFile, downloadAll, isFileValid } = require('../../src/net/download');
const { createControl } = require('../../src/net/control');

const HOSTS = ['localhost'];
const body = crypto.randomBytes(300_000);
const bodySha = sha1(body);

let srv;
let dir;
test.before(async () => {
  dir = await tmpDir();
  srv = await startServer({
    '/ok': serve(body),
    '/json': serve(Buffer.from('{"a":1}')),
    '/badjson': serve(Buffer.from('{pas du json')),
    '/cut': serve(body, { cutFirst: true }),
    '/slow': serve(body, { slow: 20_000, delay: 30 }),
    '/hang': () => { /* ne répond jamais */ },
    '/big': serve(Buffer.concat([body, body])),
    '/err500': (req, res) => { res.statusCode = 500; res.end('x'); },
    '/redir-ok': (req, res) => { res.statusCode = 302; res.setHeader('location', '/ok'); res.end(); },
    '/redir-http': (req, res) => { res.statusCode = 302; res.setHeader('location', `http://localhost:${srv.port}/ok`); res.end(); },
    '/redir-other': (req, res) => { res.statusCode = 301; res.setHeader('location', `https://127.0.0.1:${srv.port}/ok`); res.end(); },
    '/redir-evil': (req, res) => { res.statusCode = 302; res.setHeader('location', 'https://evil.example.com/x'); res.end(); },
    '/loop': (req, res) => { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); },
    '/flaky': (req, res, ctx) => { if (ctx.hits['/flaky'] < 3) { res.statusCode = 503; return res.end(); } serve(body)(req, res, ctx); },
  });
  HOSTS.push(`localhost:${srv.port}`); // un port non standard doit être autorisé explicitement
});
test.after(async () => { await srv.close(); await fsp.rm(dir, { recursive: true, force: true }); });

const opts = (o = {}) => ({ allowedHosts: HOSTS, retryDelay: 10, ...o });

test('checkUrl : refuse http, site non autorisé, identifiants', () => {
  assert.throws(() => checkUrl('http://localhost/x', HOSTS), { code: 'INSECURE_URL' });
  assert.throws(() => checkUrl('https://evil.example.com/x', HOSTS), { code: 'HOST_NOT_ALLOWED' });
  assert.throws(() => checkUrl('https://user:pw@localhost/x', HOSTS), { code: 'INSECURE_URL' });
  assert.throws(() => checkUrl('pas une url', HOSTS), { code: 'INSECURE_URL' });
  assert.throws(() => checkUrl('file:///etc/passwd', HOSTS), { code: 'INSECURE_URL' });
  assert.equal(checkUrl('https://LOCALHOST./x', HOSTS).hostname, 'localhost.');
  // Liste par défaut : seulement les sites officiels.
  assert.ok(checkUrl('https://piston-meta.mojang.com/x'));
  assert.throws(() => checkUrl('https://crafatar.com/x'), { code: 'HOST_NOT_ALLOWED' });
});

test('getJson : lit un JSON, refuse un JSON abîmé', async () => {
  assert.deepEqual(await getJson(srv.url('/json'), opts()), { a: 1 });
  await assert.rejects(getJson(srv.url('/badjson'), opts()), { code: 'MANIFEST_INVALID' });
  await assert.rejects(getJson(srv.url('/absent'), opts()), { code: 'HTTP_STATUS', status: 404 });
});

test('redirections : https vers site autorisé OK, http ou autre site refusés', async () => {
  assert.equal(sha1(await getBuffer(srv.url('/redir-ok'), opts())), bodySha);
  await assert.rejects(getBuffer(srv.url('/redir-http'), opts()), { code: 'INSECURE_URL' });
  await assert.rejects(getBuffer(srv.url('/redir-other'), opts()), { code: 'HOST_NOT_ALLOWED' });
  await assert.rejects(getBuffer(srv.url('/redir-evil'), opts()), { code: 'HOST_NOT_ALLOWED' });
  await assert.rejects(getBuffer(srv.url('/loop'), opts()), { code: 'TOO_MANY_REDIRECTS' });
});

test('plafond de taille en mémoire', async () => {
  await assert.rejects(getBuffer(srv.url('/ok'), opts({ maxBytes: 1000 })), { code: 'TOO_LARGE' });
});

test('délai maximum dépassé', async () => {
  await assert.rejects(getBuffer(srv.url('/hang'), opts({ timeout: 300 })), { code: 'TIMEOUT' });
});

test('serveur éteint : erreur NETWORK claire', async () => {
  const dead = await startServer({});
  const port = dead.port;
  HOSTS.push(`localhost:${port}`);
  await dead.close();
  await assert.rejects(getBuffer(`https://localhost:${port}/x`, opts()), { code: 'NETWORK' });
});

test('téléchargement : empreinte + taille OK, pas de .part restant', async () => {
  const f = path.join(dir, 'a', 'ok.bin');
  await downloadFile({ url: srv.url('/ok'), path: f, sha1: bodySha, size: body.length }, opts());
  assert.equal(sha1(fs.readFileSync(f)), bodySha);
  assert.equal(fs.existsSync(f + '.part'), false);
  assert.equal(await isFileValid({ path: f, sha1: bodySha, size: body.length }), true);
});

test('fichier corrompu (mauvaise empreinte) : refusé, rien n\'est écrit', async () => {
  const f = path.join(dir, 'bad.bin');
  await assert.rejects(downloadFile({ url: srv.url('/ok'), path: f, sha1: '0'.repeat(40) }, opts({ retries: 1 })), { code: 'INTEGRITY' });
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.existsSync(f + '.part'), false);
});

test('mauvaise taille annoncée : refusé', async () => {
  const f = path.join(dir, 'size.bin');
  await assert.rejects(downloadFile({ url: srv.url('/big'), path: f, sha1: bodySha, size: body.length }, opts({ retries: 0 })), { code: 'INTEGRITY' });
  assert.equal(fs.existsSync(f), false);
  await assert.rejects(downloadFile({ url: srv.url('/ok'), path: f, sha1: bodySha, size: body.length + 10 }, opts({ retries: 0 })), (e) => ['NETWORK', 'HTTP_STATUS', 'INTEGRITY'].includes(e.code));
  assert.equal(fs.existsSync(f), false);
});

test('coupure au milieu : nouvelle tentative avec reprise (Range)', async () => {
  const f = path.join(dir, 'cut.bin');
  await downloadFile({ url: srv.url('/cut'), path: f, sha1: bodySha, size: body.length }, opts());
  assert.equal(sha1(fs.readFileSync(f)), bodySha);
  assert.ok(srv.ctx.ranges.some((r) => /^bytes=\d+-$/.test(r) && r !== 'bytes=0-'), 'reprise attendue');
});

test('erreurs serveur passagères (503) : nouvelles tentatives', async () => {
  const f = path.join(dir, 'flaky.bin');
  await downloadFile({ url: srv.url('/flaky'), path: f, sha1: bodySha }, opts());
  assert.equal(srv.ctx.hits['/flaky'], 3);
});

test('erreur 404 : pas de nouvelle tentative inutile', async () => {
  const before = srv.ctx.hits['/nope'] || 0;
  await assert.rejects(downloadFile({ url: srv.url('/nope'), path: path.join(dir, 'nope'), sha1: bodySha }, opts()), { code: 'HTTP_STATUS' });
  assert.equal(srv.ctx.hits['/nope'] - before, 1);
});

test('fichier sans empreinte SHA-1 : refusé (empreinte obligatoire)', async () => {
  await assert.rejects(downloadFile({ url: srv.url('/ok'), path: path.join(dir, 'nosha') }, opts()), { code: 'INTEGRITY' });
  assert.equal(fs.existsSync(path.join(dir, 'nosha')), false);
});

test('site non autorisé : refusé avant toute connexion', async () => {
  await assert.rejects(downloadFile({ url: 'https://evil.example.com/x', path: path.join(dir, 'evil'), sha1: bodySha }, opts()), { code: 'HOST_NOT_ALLOWED' });
});

test('annulation pendant le téléchargement : CANCELLED, pas de fichier final', async () => {
  const f = path.join(dir, 'cancel.bin');
  const c = createControl();
  setTimeout(() => c.cancel(), 80);
  await assert.rejects(downloadFile({ url: srv.url('/slow'), path: f, sha1: bodySha }, opts({ control: c })), { code: 'CANCELLED' });
  assert.equal(fs.existsSync(f), false);
});

test('pause puis reprise : le fichier finit correct', async () => {
  const f = path.join(dir, 'pause.bin');
  const c = createControl();
  setTimeout(() => c.pause(), 50);
  setTimeout(() => c.resume(), 400);
  const t0 = Date.now();
  await downloadFile({ url: srv.url('/slow'), path: f, sha1: bodySha }, opts({ control: c }));
  assert.ok(Date.now() - t0 >= 350);
  assert.equal(sha1(fs.readFileSync(f)), bodySha);
});

test('disque plein simulé : erreur DISK_FULL claire', async () => {
  const orig = fsp.open;
  fsp.open = async (...a) => {
    const fh = await orig(...a);
    if (String(a[0]).endsWith('.part')) {
      fh.write = async () => { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; };
    }
    return fh;
  };
  try {
    await assert.rejects(downloadFile({ url: srv.url('/ok'), path: path.join(dir, 'full.bin'), sha1: bodySha }, opts()), { code: 'DISK_FULL' });
  } finally {
    fsp.open = orig;
  }
});

test('file parallèle : progression en Mo, vitesse, tout vérifié', async () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ url: srv.url('/ok'), path: path.join(dir, 'q', `${i}.bin`), sha1: bodySha, size: body.length, stage: i < 10 ? 'librairies' : 'sons et textures' }));
  files.push({ ...files[0] }); // doublon : une seule fois
  const events = [];
  const snap = await downloadAll(files, opts({ concurrency: 8, onProgress: (p) => events.push(p) }));
  assert.equal(snap.doneFiles, 20);
  assert.equal(snap.doneBytes, 20 * body.length);
  assert.equal(snap.percent, 100);
  assert.ok(events.length > 0);
  assert.ok('speedMBs' in snap && 'etaSeconds' in snap && snap.stages.librairies.doneFiles === 10);
});

test('file parallèle : un fichier corrompu arrête tout proprement', async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ url: srv.url('/slow'), path: path.join(dir, 'q2', `${i}.bin`), sha1: bodySha }));
  files.push({ url: srv.url('/ok'), path: path.join(dir, 'q2', 'bad.bin'), sha1: 'f'.repeat(40) });
  await assert.rejects(downloadAll(files, opts({ concurrency: 4, retries: 0 })), { code: 'INTEGRITY' });
});

test('file parallèle : annulation globale', async () => {
  const c = createControl();
  const files = Array.from({ length: 6 }, (_, i) => ({ url: srv.url('/slow'), path: path.join(dir, 'q3', `${i}.bin`), sha1: bodySha }));
  setTimeout(() => c.cancel(), 100);
  await assert.rejects(downloadAll(files, opts({ control: c })), { code: 'CANCELLED' });
});
