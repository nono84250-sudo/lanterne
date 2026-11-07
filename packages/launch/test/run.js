'use strict';

/**
 * Lance les tests automatiques (node:test, intégré à Node) avec le certificat
 * du faux serveur local ajouté aux certificats de confiance. Marche sous
 * Windows, Mac et Linux.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cert = path.join(__dirname, 'fixtures', 'test-cert.pem');
let caFile = cert;
if (process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)) {
  caFile = path.join(os.tmpdir(), `lanterne-test-ca-${process.pid}.pem`);
  fs.writeFileSync(caFile, fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') + '\n' + fs.readFileSync(cert, 'utf8'));
}
const dir = path.join(__dirname, 'unit');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(dir, f));
const extra = process.argv.slice(2);
const env = { ...process.env, NODE_EXTRA_CA_CERTS: caFile, NODE_NO_WARNINGS: '1' };
// Pas de proxy pour le faux serveur local.
env.NO_PROXY = [env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');
// --use-openssl-ca ignorerait NODE_EXTRA_CA_CERTS sur certaines machines.
if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace('--use-openssl-ca', '').trim();
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...extra, ...files], { stdio: 'inherit', env });
if (caFile !== cert) fs.rmSync(caFile, { force: true });
process.exit(r.status === null ? 1 : r.status);
