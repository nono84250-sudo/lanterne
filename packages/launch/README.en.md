# lanterne-launch

Engine that **downloads, installs and launches Minecraft Java Edition**: vanilla, Fabric, Quilt, NeoForge and Forge
(legacy and modern). Zero dependencies: Node.js 22+ only.

> Independent project, not affiliated with Mojang or Microsoft. No Minecraft files are bundled: everything is
> downloaded on the player's machine from official servers. **No support is guaranteed**: provided as is (MIT).

[Version française](README.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Quick start

```js
const { prepare, install, launch, verify, repair, createControl } = require('lanterne-launch');

const plan = await prepare({ version: '1.21.4', loader: 'fabric', root: sharedDir, gameDir: instanceDir });
console.log(plan.tailleMo, 'MB,', plan.fichiers, 'files');

const control = createControl();            // control.pause() / resume() / cancel()
await install(plan, { control, onProgress: (p) => console.log(p.percent, '%', p.speedMBs, 'MB/s') });

const game = await launch({ plan, account: { type: 'offline', name: 'Steve' }, memory: { max: 4096 } });
game.on('log', (line, meta) => console.log(meta.source, line));   // token always masked
game.on('exit', (code) => console.log('exit', code));
// game.stop();  game.exportLog();  // anonymised: no token, username, UUID or home folder

await verify({ version: '1.21.4', loader: 'fabric', root: sharedDir });   // full SHA-1 check
await repair({ version: '1.21.4', loader: 'fabric', root: sharedDir });   // re-downloads damaged files only
```

## `prepare()` options

| Option | Meaning |
|---|---|
| `version` | `"1.21.4"`, `"latest"`, `"snapshot"`… |
| `loader` | `vanilla` (default), `fabric`, `quilt`, `forge`, `neoforge` |
| `loaderVersion` | exact loader version (default: recommended / stable) |
| `root` | shared folder (`versions/`, `libraries/`, `assets/`, `runtime/`) |
| `gameDir` | instance folder (saves, mods, options) |
| `offline` | never use the network. If the network is down, the engine falls back to what is installed. |
| `java` | `"auto"` (default: exact Java required by Mojang, downloaded from Mojang), a path, or `"java"` (from PATH) |
| `allowedHosts` | allowed sites (default: Mojang + official loaders). Non-standard ports must be listed as `host:port`. |
| `fullCheck` | check every file's hash during `prepare()` |

For Forge and NeoForge, `prepare()` already downloads the official installer (a few MB) because it holds the file list.

## Accounts (`launch`)

- `{ type: 'msa', name, uuid, accessToken, xuid? }`: Microsoft account. Sign-in is done by your launcher with **your own
  application (client) ID**, not by this engine.
- `{ type: 'offline', name }`, `{ type: 'demo' }`.

Other options: `memory`, `quickPlay`, `resolution`, `jvmArgs` (replaces Mojang's `default-user-jvm`), `gameArgs`,
`onLog`, `fastLaunch` (size check only instead of full SHA-1 before launch).

## Errors

All errors are `LaunchError` with a stable `code` and a French end-user message (`err.userMessage`).

## Tests

```
npm test              # automated tests (local fake HTTPS server, malicious ZIPs, network cuts, disk full…)
npm run test:live     # real end-to-end matrix (long, downloads several GB)
```

## License

MIT. "Minecraft" is a trademark of Mojang AB; this project is not endorsed by or associated with Mojang or Microsoft.
