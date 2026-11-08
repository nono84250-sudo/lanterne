# lanterne

**A Minecraft Java launch engine for Node.js: secure, dependency-free and easy to embed in a launcher.**

lanterne downloads, installs and launches Minecraft Java Edition, vanilla or with a mod loader
(Fabric, Quilt, NeoForge, legacy and modern Forge). The right Java runtime is downloaded automatically from Mojang.

> Français : [README.md](README.md)

## Why this project

Building your own Minecraft launcher means redoing long and delicate work: reading Mojang's manifests,
downloading thousands of files, installing mod loaders, finding the right Java, building the launch command…
Existing tools are often old, pull in many dependencies, or do not check enough of what they download and then run.

lanterne is built on three principles:

- **Security first.** A launcher runs code from the Internet on the player's computer. Every file is verified
  (HTTPS enforced, allow-list of official hosts, SHA-1 hash and size), malicious ZIP archives are rejected,
  dangerous Java options are blocked and the player's token never shows up in logs.
- **Zero dependencies.** Node.js only. Less third-party code means less risk and less maintenance.
- **Simple to use.** Three steps: `prepare()` (what needs downloading), `install()` (with progress,
  pause and cancel), `launch()`. Clear error messages in English and French.

## Features

- Minecraft Java from 1.8.9 up to the latest release, snapshots included.
- Vanilla, Fabric, Quilt, NeoForge, Forge (before and after 1.13).
- Automatic Java: the exact runtime Mojang asks for, downloaded from Mojang.
- Detailed progress (MB, speed, time left), pause, resume, cancel, resume after a network drop.
- Offline: relaunch an installed version, automatic fallback when the Internet is down.
- Microsoft accounts (the token comes from the launcher), offline and demo; Quick Play.
- `verify()` and `repair()`: checks every file and re-downloads only damaged ones.
- Readable game logs and anonymised export for support.

## Example

```js
const { prepare, install, launch } = require('lanterne-launch');

const plan = await prepare({ version: '1.21.4', loader: 'fabric', root: sharedDir, gameDir: instanceDir });
await install(plan, { onProgress: (p) => console.log(p.percent, '%') });

const game = await launch({ plan, account: { type: 'offline', name: 'Steve' }, memory: { max: 4096 } });
game.on('exit', (code) => console.log('Game closed', code));
```

Full documentation: [packages/launch](packages/launch/README.en.md).

## All commands

### Main functions

| Function | Purpose |
|---|---|
| `prepare(options)` | builds a "plan": files to download, total size (`plan.tailleMo`), required Java. Nothing big is downloaded yet |
| `install(plan, { onProgress, control })` | downloads and installs everything, with progress (percent, MB/s, time left) |
| `launch({ plan, account, memory, ... })` | starts the game and returns a "game" object (see below) |
| `verify(plan or version, options)` | checks every installed file (SHA-1 hash) |
| `repair(plan or version, options)` | re-downloads only damaged or missing files |
| `listVersions({ root, offline })` | Minecraft versions (latest release, latest snapshot, all versions) |
| `createControl()` | install remote control: `pause()`, `resume()`, `cancel()` |

French aliases `verifier()`, `reparer()` and `anonymiser()` also work.

### `prepare()` options

| Option | Purpose |
|---|---|
| `version` | `"1.21.4"`, `"latest"` (latest release), `"snapshot"` (latest snapshot) |
| `loader` | `vanilla` (default), `fabric`, `quilt`, `forge`, `neoforge` |
| `loaderVersion` | exact loader version (otherwise the recommended one) |
| `root` | folder shared by all instances (versions, libraries, assets, Java) |
| `gameDir` | instance folder (worlds, mods, options) |
| `offline` | `true`: never go online |
| `java` | `"auto"` (default), a path to Java, or `"java"` (the system one) |
| `allowedHosts` | allowed hosts (default: Mojang and official loaders) |
| `fullCheck` | `true`: full hash check during preparation |

### `launch()` options

| Option | Purpose |
|---|---|
| `account` | `{ type: 'msa', name, uuid, accessToken }` (Microsoft), `{ type: 'offline', name }` or `{ type: 'demo' }` |
| `memory` | `{ min, max }` in MB |
| `resolution` | window `{ width, height }` |
| `quickPlay` | jump straight into a singleplayer world, a server or a Realm |
| `jvmArgs`, `gameArgs` | extra Java and game options |
| `fastLaunch` | `true`: quick check (sizes only) before launch |
| `onLog` | called for every log line |

### The "game" object returned by `launch()`

| Command | Purpose |
|---|---|
| `game.on('log', line => ...)` | every log line, token always masked |
| `game.on('exit', code => ...)` | the game closed |
| `game.on('erreur', err => ...)` | the game crashed (`GAME_CRASHED`) or failed to start |
| `game.stop()` | clean shutdown (world saved), forced after 30 s; `{ force: true }` to force now |
| `game.exportLog()` | log for support, without token, username, UUID or home folder |

### Advanced tools

| Function | Purpose |
|---|---|
| `buildArgs(plan, options)` | builds the Java command without launching (contains the token: never log it) |
| `maskSecrets(text, secrets)` | masks secrets in a text |
| `anonymize(text, info)` | removes username, UUID and home folder from a text |
| `probeJava(path)` | tests a Java runtime and returns its version |
| `offlineUuid(name)` | offline UUID for a username, computed like the game does |
| `extractZip(file, dir)` / `readZipEntry(file, name)` | safe ZIP extractor |
| `LaunchError`, `ERROR_MESSAGES` | errors with a precise `code` and a clear message (`err.userMessage`) |
| `LOADERS`, `DEFAULT_ALLOWED_HOSTS` | supported loaders and default allowed hosts |

### Terminal commands

```
npm test                                   # all automated tests (no Internet access)
npm run test:live -w packages/launch       # all real-world runs (long)
node packages/launch/test/live/smoke.js 1.20.1 forge   # one real run: install and launch to the menu
```

## Repository layout

| Folder | Content |
|---|---|
| [`packages/launch`](packages/launch) | the `lanterne-launch` engine (code, tests, docs) |

Sister library: [lanterne-skins](https://github.com/nono84250-sudo/lanterne-skins), for heads, skins and capes.

## Installation

The package is not published on npm yet. In the meantime:

```
git clone https://github.com/nono84250-sudo/lanterne.git
cd lanterne
npm test
```

Requires Node.js 22 or later.

## Quality

- Automated tests against a local fake server: normal cases, errors, network loss, full disk,
  corrupted files, malicious ZIPs.
- Real end-to-end runs (install then launch to the main menu) on 1.8.9, 1.12.2, 1.20.1, 1.21.x
  and the latest release, vanilla and with every loader.
- Dedicated code reviews for bugs, security and specification compliance.

## Contributing

Bug reports and suggestions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
For a security issue, please follow [SECURITY.md](packages/launch/SECURITY.md) (private reporting).

## License

[MIT](LICENSE). No Minecraft files are bundled: everything is downloaded on the player's machine from official servers.

Independent project, not affiliated with Mojang or Microsoft. "Minecraft" is a trademark of Mojang AB.
