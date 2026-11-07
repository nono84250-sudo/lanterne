'use strict';

const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const FIX = path.join(__dirname, 'fixtures');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function tmpDir(prefix = 'lanterne-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Faux serveur HTTPS local. routes : { '/chemin': (req, res, ctx) => void }
 * ctx.hits compte les appels, ctx.ranges garde les en-têtes Range reçus.
 */
async function startServer(routes) {
  const ctx = { hits: {}, ranges: [] };
  const server = https.createServer({ key: fs.readFileSync(path.join(FIX, 'test-key.pem')), cert: fs.readFileSync(path.join(FIX, 'test-cert.pem')) }, (req, res) => {
    const u = new URL(req.url, 'https://localhost');
    ctx.hits[u.pathname] = (ctx.hits[u.pathname] || 0) + 1;
    if (req.headers.range) ctx.ranges.push(req.headers.range);
    const h = routes[u.pathname];
    if (!h) { res.statusCode = 404; return res.end('absent'); }
    h(req, res, ctx);
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    ctx,
    url: (p) => `https://localhost:${port}${p}`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

/** Sert un contenu fixe, avec gestion du Range (reprise). */
function serve(buf, opts = {}) {
  return (req, res, ctx) => {
    const n = ctx.hits[new URL(req.url, 'https://x').pathname];
    let body = buf;
    let status = 200;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (range && !opts.noRange) {
      const start = Number(range[1]);
      body = buf.subarray(start);
      status = 206;
      res.setHeader('content-range', `bytes ${start}-${buf.length - 1}/${buf.length}`);
    }
    res.statusCode = status;
    res.setHeader('content-length', body.length);
    if (opts.cutFirst && n === 1) {
      // coupe la connexion au milieu
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => res.socket.destroy(), 30);
      return;
    }
    if (opts.slow) {
      let i = 0;
      const step = () => {
        if (i >= body.length) return res.end();
        res.write(body.subarray(i, i + opts.slow));
        i += opts.slow;
        setTimeout(step, opts.delay || 20);
      };
      return step();
    }
    res.end(body);
  };
}

// ---------------------------------------------------------------- Fabrique de ZIP de test

/**
 * Construit un zip. entries : [{ name, data?, method?: 0|8, unixMode?, declaredSize?, crc?, raw?: Buffer }]
 * declaredSize permet de mentir sur la taille (bombe), crc de mentir sur l'empreinte.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const method = e.method ?? 8;
    const comp = e.raw || (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = e.crc ?? zlib.crc32(data);
    const size = e.declaredSize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { tmpDir, startServer, serve, makeZip, sha1, FIX };
