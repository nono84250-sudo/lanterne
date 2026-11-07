'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { LaunchError } = require('../errors');
const { rulesAllow, currentPlatform } = require('../manifest/rules');

const LAUNCHER_NAME = 'lanterne';
const LAUNCHER_VERSION = '0.1.0';

/** UUID hors-ligne, identique à celui du jeu officiel (« OfflinePlayer:pseudo »). */
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Normalise le compte.
 *  - { type: 'msa', name, uuid, accessToken, xuid?, clientId? } : compte Microsoft (connexion faite par le launcher)
 *  - { type: 'offline', name } : hors-ligne (solo)
 *  - { type: 'demo' } ou demo: true : mode démo
 */
function normalizeAccount(acc = {}) {
  const type = acc.type || (acc.accessToken ? 'msa' : 'offline');
  if (type === 'msa') {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(acc.name || '')) throw new LaunchError('INVALID_OPTION', 'pseudo du compte');
    if (typeof acc.accessToken !== 'string' || acc.accessToken.length < 8) throw new LaunchError('INVALID_OPTION', 'jeton du compte');
    const uuid = String(acc.uuid || '').replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(uuid)) throw new LaunchError('INVALID_OPTION', 'identifiant du compte');
    return { type: 'msa', name: acc.name, uuid, accessToken: acc.accessToken, xuid: acc.xuid || '0', clientId: acc.clientId || '0', demo: !!acc.demo };
  }
  const name = acc.name || (type === 'demo' ? 'Player' : '');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new LaunchError('INVALID_OPTION', 'pseudo hors-ligne (3 à 16 lettres, chiffres ou _)');
  return {
    type: 'offline',
    name,
    uuid: offlineUuid(name).replace(/-/g, ''),
    accessToken: crypto.randomBytes(16).toString('hex'), // jeton factice
    xuid: '0',
    clientId: '0',
    demo: type === 'demo' || !!acc.demo,
  };
}

function expandList(list, features, plat) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      if (!rulesAllow(item.rules, { os: plat, features })) continue;
      const v = item.value;
      if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string'));
      else if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

function substitute(arg, vars) {
  return arg.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

function memoryArg(v, flag) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return `${flag}${s}M`;
  if (/^\d+[kKmMgG]$/.test(s)) return `${flag}${s}`;
  throw new LaunchError('INVALID_OPTION', 'mémoire');
}

/**
 * Construit la commande Java complète : liste d'arguments (jamais une ligne
 * de commande à interpréter).
 * @returns {{javaPath: string, args: string[], account: object, secrets: string[]}}
 */
function buildArgs(plan, opts = {}) {
  const v = plan.version;
  const plat = currentPlatform();
  const account = normalizeAccount(opts.account || opts.compte || { type: 'offline', name: 'Player' });
  const quick = opts.quickPlay || null;
  const res = opts.resolution || null;
  const features = {
    is_demo_user: account.demo,
    has_custom_resolution: !!(res && res.width && res.height),
    has_quick_plays_support: !!(quick && quick.path),
    is_quick_play_singleplayer: !!(quick && quick.singleplayer),
    is_quick_play_multiplayer: !!(quick && quick.multiplayer),
    is_quick_play_realms: !!(quick && quick.realms),
  };

  const L = { libraries: path.join(plan.root, 'libraries'), assets: path.join(plan.root, 'assets') };
  const nativesDirectory = path.join(plan.root, 'versions', plan.id, 'natives');
  const cpSeen = new Set();
  const cp = [];
  for (const lib of plan.libraries) {
    if (!lib.classpath) continue;
    if (cpSeen.has(lib.path)) continue;
    cpSeen.add(lib.path);
    cp.push(lib.path);
  }
  if (!cpSeen.has(plan.clientJar)) cp.push(plan.clientJar);

  const ai = plan.assetIndex;
  const virtualDir = path.join(L.assets, 'virtual', ai.id);
  const assetsRoot = ai.mapToResources ? path.join(plan.gameDir, 'resources') : ai.virtual ? virtualDir : L.assets;
  const vars = {
    auth_player_name: account.name,
    version_name: plan.id,
    game_directory: plan.gameDir,
    assets_root: assetsRoot,
    game_assets: ai.virtual || ai.mapToResources ? assetsRoot : L.assets,
    assets_index_name: ai.id,
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken,
    auth_session: `token:${account.accessToken}:${account.uuid}`,
    auth_xuid: account.xuid,
    clientid: account.clientId,
    user_type: account.type === 'msa' ? 'msa' : 'legacy',
    user_properties: '{}',
    version_type: opts.versionType || v.type || 'release',
    natives_directory: nativesDirectory,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: cp.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: L.libraries,
    resolution_width: res ? res.width : '',
    resolution_height: res ? res.height : '',
    quickPlayPath: quick && quick.path ? quick.path : '',
    quickPlaySingleplayer: quick && quick.singleplayer ? quick.singleplayer : '',
    quickPlayMultiplayer: quick && quick.multiplayer ? quick.multiplayer : '',
    quickPlayRealms: quick && quick.realms ? quick.realms : '',
  };

  // --- JVM
  const jvm = [];
  const memMax = memoryArg(opts.memory && opts.memory.max !== undefined ? opts.memory.max : (opts.memoire && opts.memoire.max), '-Xmx');
  const memMin = memoryArg(opts.memory && opts.memory.min !== undefined ? opts.memory.min : (opts.memoire && opts.memoire.min), '-Xms');
  if (memMax) jvm.push(memMax);
  if (memMin) jvm.push(memMin);
  // Options JVM conseillées par Mojang (26.x) : on garde, sauf la mémoire si l'appelant l'a choisie.
  const defaults = expandList(v.arguments && v.arguments['default-user-jvm'], features, plat)
    .filter((a) => !((memMax || memMin) && /^-Xm[sx]/.test(a)));
  jvm.push(...defaults);
  if (Array.isArray(opts.jvmArgs)) jvm.push(...opts.jvmArgs.map(String));
  if (plan.logging && !opts.noLogConfig) jvm.push(plan.logging.argument.replace('${path}', plan.logging.path));

  if (v.arguments && Array.isArray(v.arguments.jvm)) {
    jvm.push(...expandList(v.arguments.jvm, features, plat));
  } else {
    if (plat.name === 'osx') jvm.push('-XstartOnFirstThread');
    if (plat.name === 'windows') jvm.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
    if (plat.arch === 'x86') jvm.push('-Xss1M');
    jvm.push('-Djava.library.path=${natives_directory}', '-Dminecraft.launcher.brand=${launcher_name}', '-Dminecraft.launcher.version=${launcher_version}', '-cp', '${classpath}');
  }

  // --- Jeu
  let game;
  if (v.arguments && Array.isArray(v.arguments.game)) {
    game = expandList(v.arguments.game, features, plat);
  } else {
    game = String(v.minecraftArguments || '').split(/\s+/).filter(Boolean);
    if (account.demo) game.push('--demo');
    if (features.has_custom_resolution) game.push('--width', '${resolution_width}', '--height', '${resolution_height}');
  }
  // Quick Play sur les vieilles versions : --server / --port.
  if (quick && quick.multiplayer && !(v.arguments && v.arguments.game && JSON.stringify(v.arguments.game).includes('quickPlayMultiplayer'))) {
    const [host, port] = String(quick.multiplayer).split(':');
    game.push('--server', host);
    if (port) game.push('--port', port);
  }
  if (Array.isArray(opts.gameArgs)) game.push(...opts.gameArgs.map(String));

  if (typeof v.mainClass !== 'string' || !/^[A-Za-z0-9_.$]+$/.test(v.mainClass)) throw new LaunchError('MANIFEST_INVALID', 'mainClass');
  const args = [...jvm.map((a) => substitute(a, vars)), v.mainClass, ...game.map((a) => substitute(a, vars))];
  return { javaPath: plan.java.executable, args, account, secrets: [account.accessToken, vars.auth_session], nativesDirectory };
}

/** Masque les secrets (jeton du joueur) dans un texte : jamais écrit en clair. */
function maskSecrets(text, secrets) {
  let s = String(text);
  for (const sec of secrets || []) {
    if (sec && sec.length >= 8) s = s.split(sec).join('***');
  }
  // Par sécurité : tout ce qui suit --accessToken, et les jetons JWT reconnaissables.
  s = s.replace(/(--accessToken[ =]+)\S+/g, '$1***');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***');
  return s;
}

module.exports = { buildArgs, maskSecrets, normalizeAccount, offlineUuid, LAUNCHER_NAME, LAUNCHER_VERSION };
