# lanterne-launch

Moteur qui **télécharge, installe et lance Minecraft Java** : vanilla, Fabric, Quilt, NeoForge et Forge (ancien et récent).
Zéro dépendance : uniquement ce que Node.js (22 ou plus) fournit.

> Projet indépendant, non affilié à Mojang ni Microsoft. Aucun fichier de Minecraft n'est inclus :
> tout est téléchargé chez le joueur, depuis les serveurs officiels.
> **Aucun support garanti** : fourni tel quel (licence MIT).

[English version](README.en.md) · [Sécurité](SECURITY.md) · [Historique](CHANGELOG.md)

## En bref

```js
const { prepare, install, launch, verify, repair, createControl } = require('lanterne-launch');

// 1. Ce qu'il faut télécharger (rien de gros n'est encore fait)
const plan = await prepare({ version: '1.21.4', loader: 'fabric', root: dossier, gameDir: dossierInstance });
console.log(plan.tailleMo, 'Mo,', plan.fichiers, 'fichiers');

// 2. Installer, avec progression, Pause et Annuler
const controle = createControl();           // controle.pause() / resume() / cancel()
await install(plan, { control: controle, onProgress: (p) => console.log(p.percent, '%', p.speedMBs, 'Mo/s', p.etaSeconds, 's') });

// 3. Lancer
const jeu = await launch({ plan, account: { type: 'offline', name: 'Steve' }, memory: { max: 4096 } });
jeu.on('journal', (ligne) => console.log(ligne));   // jeton toujours masqué
jeu.on('fermeture', (code) => console.log('fin', code));
// jeu.arreter();                        // fermeture propre (monde sauvegardé), forcée après 30 s ; arreter({ force: true })
// jeu.exporterJournal();                  // pour le support : sans jeton, pseudo, UUID ni dossier personnel
// jeu.exporterJournal({ source: 'jeu' }); // seulement les lignes du jeu (ou 'lanceur')

// Bonus
await verify({ version: '1.21.4', loader: 'fabric', root: dossier });   // contrôle chaque fichier (SHA-1)
await repair({ version: '1.21.4', loader: 'fabric', root: dossier });   // ne retélécharge que les fichiers abîmés
```

## Options de `prepare()`

| Option | Rôle |
|---|---|
| `version` | `"1.21.4"`, `"latest"`, `"snapshot"`… |
| `loader` | `vanilla` (défaut), `fabric`, `quilt`, `forge`, `neoforge` |
| `loaderVersion` | version précise du chargeur (sinon : la recommandée / stable) |
| `root` | dossier commun : `versions/`, `libraries/`, `assets/`, `runtime/` partagés entre toutes les instances |
| `gameDir` | dossier de l'instance (sauvegardes, mods, options) |
| `offline` | `true` : ne jamais aller sur Internet (relance d'une version déjà installée). Si Internet est coupé, le moteur bascule tout seul sur ce qui est déjà installé. |
| `java` | `"auto"` (défaut : le Java exact demandé par Mojang, téléchargé chez Mojang), le chemin d'un Java, ou `"java"` (celui du PATH). Un Java fourni est essayé avant le lancement et doit être assez récent. |
| `allowedHosts` | liste des sites autorisés (par défaut : Mojang + chargeurs officiels uniquement). Un port non standard doit être écrit (`hôte:port`). |
| `fullCheck` | `true` : contrôle l'empreinte de chaque fichier dès `prepare()` (plus lent) |

À savoir : pour Forge et NeoForge, `prepare()` télécharge déjà le programme d'installation officiel (quelques Mo),
car la liste des fichiers est dedans. Ce petit téléchargement n'a pas de barre de progression ; il s'annule avec `control` ou `annuler`.
Si un serveur officiel est en panne (erreur 5xx), le moteur joue avec ce qui est déjà installé, comme sans Internet.

## Comptes (`launch`)

- `{ type: 'msa', name, uuid, accessToken, xuid?, clientId? }` : compte Microsoft (la connexion se fait dans le launcher, pas ici).
- `{ type: 'offline', name }` : hors-ligne (solo).
- `{ type: 'demo' }` : mode démo.

Autres options : `memory: { min, max }` (Mo), `quickPlay: { singleplayer | multiplayer | realms }`, `resolution: { width, height }`, `jvmArgs`, `gameArgs`, `onLog`.

- Avant chaque lancement, le jeu, les bibliothèques et les fichiers essentiels de Java sont contrôlés par empreinte SHA-1 (mis en cache, rapide après le premier lancement).
  `fastLaunch: true` se contente des tailles. Un fichier abîmé donne `NOT_INSTALLED` : il suffit d'appeler `repair()`.
- Si `jvmArgs` est donné, les options Java conseillées par Mojang (`default-user-jvm`) ne sont pas ajoutées.
- La connexion Microsoft n'est pas faite par ce moteur : le launcher la fait avec **son propre identifiant d'application** (client ID).

## Erreurs

Toutes les erreurs sont des `LaunchError` avec un `code` précis et un message clair en français (`err.userMessage`) :
`NETWORK`, `OFFLINE`, `TIMEOUT`, `DISK_FULL`, `PERMISSION`, `INTEGRITY`, `INSECURE_URL`, `HOST_NOT_ALLOWED`,
`ZIP_UNSAFE`, `ZIP_TOO_LARGE`, `VERSION_NOT_FOUND`, `LOADER_NOT_FOUND`, `JAVA_MISSING`, `JAVA_UNSUPPORTED`,
`JAVA_TOO_OLD`, `LOADER_INSTALL_FAILED`, `NOT_INSTALLED`, `LAUNCH_FAILED`, `GAME_CRASHED` (événement `erreur` si le jeu plante), `CANCELLED`, `INTERNAL`…

## Sécurité (dès la conception) — détails dans [SECURITY.md](SECURITY.md)

- HTTPS obligatoire, même après une redirection ; liste des sites autorisés (Mojang, Fabric, Quilt, NeoForge, Forge).
- Empreinte SHA-1 (et taille quand elle est connue) vérifiée pour **chaque** fichier ; écriture dans un `.part` puis renommage.
- Délai maximum, nouvelles tentatives, reprise après coupure.
- Extracteur ZIP maison : refuse `../`, chemins absolus, `C:\`, caractère nul, doublons ; ignore les liens symboliques ;
  n'applique jamais les droits spéciaux ; s'arrête si un fichier dépasse la taille annoncée ; plafonne le total (bombe ZIP).
- Java démarré avec une **liste d'arguments** (jamais de ligne de commande interprétée).
- Jeton du joueur masqué avant d'arriver dans les journaux ; il n'est jamais renvoyé par l'API.
- Options Java venant des fichiers téléchargés : **liste blanche** (seules les options connues de Mojang et des chargeurs passent ; `-javaagent`, `@fichier`, `-XX:OnError`, `-Dminecraft.api.*`, `-Dlog4j.configurationFile=https://…` sont refusées et signalées dans le journal).
- Forge / NeoForge : les programmes d'installation officiels sont lancés localement ; le seul qui télécharge
  (cartes de noms Mojang) est remplacé par le téléchargeur sécurisé.

## Tests

```
npm test            # tests automatiques (faux serveur HTTPS local, ZIP piégés, coupures, disque plein…)
node test/live/smoke.js 1.20.1 forge     # essai réel : installe et lance jusqu'au menu
npm run test:live                        # toute la matrice d'essais réels (long)
node test/live/compare-mclc.js           # commande identique à minecraft-launcher-core 3.18 (classpath, options du jeu)
```

## Licence

MIT. « Minecraft » est une marque de Mojang AB ; ce projet n'est ni approuvé ni associé à Mojang ou Microsoft.
