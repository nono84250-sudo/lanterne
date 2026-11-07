'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { tmpDir } = require('../helpers');
const { buildArgs, maskSecrets, offlineUuid, normalizeAccount } = require('../../src/launch/args');
const { launch, lineSplitter } = require('../../src/launch/launch');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SECRETSECRETSECRET123';

function fakePlan(root, version, extra = {}) {
  return {
    id: version.id,
    mcVersion: version.id,
    root,
    gameDir: path.join(root, 'instance'),
    version,
    clientJar: path.join(root, 'versions', version.id, `${version.id}.jar`),
    libraries: [
      { name: 'a:b:1', path: path.join(root, 'libraries', 'a.jar'), classpath: true, native: false },
      { name: 'n:n:1:natives-linux', path: path.join(root, 'libraries', 'n.jar'), classpath: false, native: true },
    ],
    generated: [],
    assetIndex: { id: '1.8', virtual: false, mapToResources: false, objects: [] },
    logging: { argument: '-Dlog4j.configurationFile=${path}', path: path.join(root, 'assets', 'log_configs', 'client.xml') },
    java: { executable: process.execPath, auto: true },
    missing: [],
    files: [],
    ...extra,
  };
}

const MSA = { type: 'msa', name: 'Steve', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', accessToken: TOKEN, xuid: '123' };

test('UUID hors-ligne identique au jeu officiel', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('comptes : pseudo et jeton vérifiés', () => {
  assert.throws(() => normalizeAccount({ type: 'offline', name: 'a b' }), { code: 'INVALID_OPTION' });
  assert.throws(() => normalizeAccount({ type: 'offline', name: 'x' }), { code: 'INVALID_OPTION' });
  assert.throws(() => normalizeAccount({ type: 'msa', name: 'Steve', uuid: 'zz', accessToken: TOKEN }), { code: 'INVALID_OPTION' });
  const d = normalizeAccount({ type: 'demo' });
  assert.equal(d.demo, true);
});

test('arguments anciens (1.8.9) : liste propre, natives, classpath, jeton', () => {
  const root = '/r';
  const v = { id: '1.8.9', type: 'release', mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}' };
  const b = buildArgs(fakePlan(root, v), { account: MSA, memory: { max: 4096, min: '1G' }, quickPlay: { multiplayer: 'play.example.org:25566' } });
  const a = b.args;
  assert.equal(a[0], '-Xmx4096M');
  assert.equal(a[1], '-Xms1G');
  assert.ok(a.includes('-Dlog4j.configurationFile=' + path.join(root, 'assets', 'log_configs', 'client.xml')));
  assert.ok(a.some((x) => x.startsWith('-Djava.library.path=') && x.endsWith(path.join('versions', '1.8.9', 'natives'))));
  const cp = a[a.indexOf('-cp') + 1].split(path.delimiter);
  assert.deepEqual(cp, [path.join(root, 'libraries', 'a.jar'), path.join(root, 'versions', '1.8.9', '1.8.9.jar')]);
  assert.equal(a[a.indexOf('--accessToken') + 1], TOKEN);
  assert.equal(a[a.indexOf('--uuid') + 1], '069a79f444e94726a5befca90e38aaf5');
  assert.equal(a[a.indexOf('--userType') + 1], 'msa');
  assert.deepEqual(a.slice(-4), ['--server', 'play.example.org', '--port', '25566']);
  assert.ok(!a.some((x) => x.includes('${')), 'aucune variable non remplacée');
});

test('arguments modernes : règles, démo, résolution, Quick Play, options Mojang 26.x', () => {
  const v = {
    id: '26.3', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    arguments: {
      'default-user-jvm': [{ value: ['-Xms2G', '-Xmx4G', '-XX:+UseCompactObjectHeaders'] }],
      game: ['--username', '${auth_player_name}', { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
        { rules: [{ action: 'allow', features: { is_quick_play_singleplayer: true } }], value: ['--quickPlaySingleplayer', '${quickPlaySingleplayer}'] }],
      jvm: ['-Djava.library.path=${natives_directory}/java', '-cp', '${classpath}'],
    },
  };
  const plan = fakePlan('/r', v);
  let a = buildArgs(plan, { account: { type: 'demo' }, resolution: { width: 800, height: 600 }, quickPlay: { singleplayer: 'Monde' } }).args;
  assert.ok(a.includes('--demo'));
  assert.deepEqual(a.slice(a.indexOf('--width'), a.indexOf('--width') + 4), ['--width', '800', '--height', '600']);
  assert.equal(a[a.indexOf('--quickPlaySingleplayer') + 1], 'Monde');
  assert.ok(a.includes('-Xmx4G') && a.includes('-XX:+UseCompactObjectHeaders'));
  // mémoire choisie : remplace celle conseillée par Mojang
  a = buildArgs(plan, { account: { name: 'Alex' }, memory: { max: 3000 } }).args;
  assert.ok(a.includes('-Xmx3000M') && !a.includes('-Xmx4G') && !a.includes('-Xms2G'));
  assert.ok(!a.includes('--demo'));
});

test('jeton masqué dans les journaux', () => {
  const s = maskSecrets(`x --accessToken ${TOKEN} y token:${TOKEN}:abc`, [TOKEN]);
  assert.ok(!s.includes('SECRET'));
  assert.ok(maskSecrets('jwt eyJabcdefghijkl.eyJabcdefghijkl.abcdefghijklmnop', []).includes('***'));
  assert.equal(maskSecrets('--accessToken abc', []), '--accessToken ***');
});

test('journaux XML de Mojang remis en lignes lisibles', () => {
  const lines = [];
  const s = lineSplitter((l) => lines.push(l));
  s.push('<log4j:Event logger="a" timestamp="1700000000000" level="INFO" thread="Render thread">\n<log4j:Message><![CDATA[Bonjour]]></log4j:Message>\n</log4j:Event>\nligne simple\n');
  s.end();
  assert.match(lines[0], /\[Render thread\/INFO\]: Bonjour$/);
  assert.equal(lines[1], 'ligne simple');
});

test('lancement réel d\'un processus : journal, jeton jamais visible, fermeture', async () => {
  const root = await tmpDir();
  // Faux « Java » : Node lui-même, qui affiche ses arguments (dont le jeton).
  const v = {
    id: 'faux', type: 'release', mainClass: 'Main',
    arguments: { jvm: ['-e', 'console.log(process.argv.join(" ")); console.error("erreur test"); setTimeout(()=>process.exit(3),50)'], game: ['--accessToken', '${auth_access_token}'] },
  };
  const plan = fakePlan(root, v, { libraries: [], logging: null });
  const game = await launch({ plan, account: MSA });
  const lines = [];
  game.on('journal', (l) => lines.push(l));
  const code = await new Promise((r) => game.on('fermeture', r));
  assert.equal(code, 3);
  const all = lines.join('\n') + game.exporterJournal() + game.command;
  assert.ok(all.includes('erreur test'));
  assert.ok(!all.includes('SECRETSECRET'), 'le jeton ne doit jamais apparaître');
  await fsp.rm(root, { recursive: true, force: true });
});

test('Java absent : erreur claire, jamais de plantage', async () => {
  const root = await tmpDir();
  const plan = fakePlan(root, { id: 'x', mainClass: 'M', arguments: { jvm: [], game: [] } }, { java: { executable: path.join(root, 'pas-de-java'), auto: true } });
  await assert.rejects(launch({ plan, account: { name: 'Steve' } }), { code: 'JAVA_MISSING' });
  await fsp.rm(root, { recursive: true, force: true });
});

test('version pas installée : erreur claire', async () => {
  const plan = fakePlan('/r', { id: 'x', mainClass: 'M' }, { missing: [{}] });
  await assert.rejects(launch({ plan }), { code: 'NOT_INSTALLED' });
});

test('arrêter() termine le jeu', async () => {
  const root = await tmpDir();
  const v = { id: 'long', mainClass: 'Main', arguments: { jvm: ['-e', 'setInterval(()=>{},1000)'], game: [] } };
  const game = await launch({ plan: fakePlan(root, v, { libraries: [], logging: null }), account: { name: 'Steve' } });
  setTimeout(() => game.arreter(), 100);
  await new Promise((r) => game.on('fermeture', r));
  assert.equal(game.exited, true);
  await fsp.rm(root, { recursive: true, force: true });
});
