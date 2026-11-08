# lanterne

**Un moteur de lancement Minecraft Java pour Node.js, sûr, sans dépendance et facile à intégrer dans un launcher.**

lanterne télécharge, installe et lance Minecraft Java Edition, en vanilla ou avec un chargeur de mods
(Fabric, Quilt, NeoForge, Forge ancien et récent). Le bon Java est téléchargé automatiquement chez Mojang.

> English: [README.en.md](README.en.md)

## Pourquoi ce projet

Créer son propre launcher Minecraft demande de refaire un travail long et délicat : lire les manifestes de Mojang,
télécharger des milliers de fichiers, installer les chargeurs de mods, trouver le bon Java, construire la commande de lancement…
Les outils existants sont souvent anciens, s'appuient sur beaucoup de dépendances, ou ne vérifient pas assez
ce qu'ils téléchargent puis exécutent.

lanterne part de trois principes :

- **La sécurité d'abord.** Un launcher exécute du code venu d'Internet sur le PC du joueur. Chaque fichier est vérifié
  (HTTPS imposé, liste de sites officiels, empreinte SHA-1 et taille), les archives ZIP piégées sont refusées,
  les options Java dangereuses sont bloquées et le jeton du joueur n'apparaît jamais dans les journaux.
- **Zéro dépendance.** Uniquement Node.js. Moins de code tiers, c'est moins de risques et moins de maintenance.
- **Simple à utiliser.** Trois étapes : `prepare()` (ce qu'il faut télécharger), `install()` (avec progression,
  pause et annulation), `launch()`. Des messages d'erreur clairs, en français et en anglais.

## Ce que ça fait

- Minecraft Java de la 1.8.9 à la toute dernière version, snapshots compris.
- Vanilla, Fabric, Quilt, NeoForge, Forge (avant et après 1.13).
- Java automatique : la version exacte demandée par Mojang, téléchargée chez Mojang.
- Progression détaillée (Mo, vitesse, temps restant), pause, reprise, annulation, reprise après coupure.
- Hors-ligne : relance d'une version déjà installée, bascule automatique si Internet est coupé.
- Comptes Microsoft (le jeton vient du launcher), hors-ligne et démo ; Quick Play.
- `verify()` et `repair()` : contrôle de chaque fichier et retéléchargement des seuls fichiers abîmés.
- Journaux du jeu lisibles et export anonymisé pour le support.

## Exemple

```js
const { prepare, install, launch } = require('lanterne-launch');

const plan = await prepare({ version: '1.21.4', loader: 'fabric', root: dossierCommun, gameDir: dossierInstance });
await install(plan, { onProgress: (p) => console.log(p.percent, '%') });

const jeu = await launch({ plan, account: { type: 'offline', name: 'Steve' }, memory: { max: 4096 } });
jeu.on('fermeture', (code) => console.log('Jeu fermé', code));
```

La documentation complète est ici : [packages/launch](packages/launch/README.md).

## Toutes les commandes

### Fonctions principales

| Fonction | Rôle |
|---|---|
| `prepare(options)` | prépare un « plan » : liste des fichiers à télécharger, taille totale (`plan.tailleMo`), Java nécessaire. Rien de gros n'est téléchargé |
| `install(plan, { onProgress, control })` | télécharge et installe tout, avec progression (pourcentage, Mo/s, temps restant) |
| `launch({ plan, account, memory, ... })` | lance le jeu et renvoie un objet « jeu » (voir plus bas) |
| `verify(plan ou version, options)` | contrôle chaque fichier installé (empreinte SHA-1) |
| `repair(plan ou version, options)` | retélécharge seulement les fichiers abîmés ou manquants |
| `listVersions({ root, offline })` | liste des versions Minecraft (dernière version, dernière snapshot, toutes les versions) |
| `createControl()` | télécommande d'installation : `pause()`, `resume()`, `cancel()` |

Les noms français `verifier()`, `reparer()` et `anonymiser()` marchent aussi.

### Options de `prepare()`

| Option | Rôle |
|---|---|
| `version` | `"1.21.4"`, `"latest"` (dernière version), `"snapshot"` (dernière snapshot) |
| `loader` | `vanilla` (par défaut), `fabric`, `quilt`, `forge`, `neoforge` |
| `loaderVersion` | version précise du chargeur (sinon la version recommandée) |
| `root` | dossier commun à toutes les instances (versions, bibliothèques, assets, Java) |
| `gameDir` | dossier de l'instance (mondes, mods, options) |
| `offline` | `true` : ne jamais aller sur Internet |
| `java` | `"auto"` (par défaut), le chemin d'un Java, ou `"java"` (celui du système) |
| `allowedHosts` | liste des sites autorisés (par défaut : Mojang et chargeurs officiels) |
| `fullCheck` | `true` : contrôle complet des empreintes dès la préparation |

### Options de `launch()`

| Option | Rôle |
|---|---|
| `account` | `{ type: 'msa', name, uuid, accessToken }` (Microsoft), `{ type: 'offline', name }` ou `{ type: 'demo' }` |
| `memory` | `{ min, max }` en Mo |
| `resolution` | `{ width, height }` de la fenêtre |
| `quickPlay` | rejoindre directement un monde solo, un serveur ou un Realm |
| `jvmArgs`, `gameArgs` | options Java et options du jeu en plus |
| `fastLaunch` | `true` : contrôle rapide (tailles seulement) avant le lancement |
| `onLog` | fonction appelée pour chaque ligne de journal |

### L'objet « jeu » renvoyé par `launch()`

| Commande | Rôle |
|---|---|
| `jeu.on('journal', ligne => ...)` (ou `'log'`) | chaque ligne du journal, jeton toujours masqué |
| `jeu.on('fermeture', code => ...)` (ou `'exit'`) | le jeu s'est fermé |
| `jeu.on('erreur', err => ...)` | le jeu a planté (`GAME_CRASHED`) ou n'a pas pu démarrer |
| `jeu.arreter()` (ou `stop()`) | fermeture propre (monde sauvegardé), forcée après 30 s ; `{ force: true }` pour forcer tout de suite |
| `jeu.exporterJournal()` (ou `exportLog()`) | journal à envoyer au support, sans jeton, pseudo, UUID ni dossier personnel |

### Outils avancés

| Fonction | Rôle |
|---|---|
| `buildArgs(plan, options)` | construit la commande Java sans lancer (contient le jeton : ne jamais l'afficher) |
| `maskSecrets(texte, secrets)` | masque des secrets dans un texte |
| `anonymize(texte, infos)` | retire pseudo, UUID et dossier personnel d'un texte |
| `probeJava(chemin)` | teste un Java et donne sa version |
| `offlineUuid(pseudo)` | UUID hors-ligne d'un pseudo, comme le jeu le calcule |
| `extractZip(fichier, dossier)` / `readZipEntry(fichier, nom)` | extracteur ZIP sûr |
| `LaunchError`, `ERROR_MESSAGES` | erreurs avec un `code` précis et un message clair (`err.userMessage`) |
| `LOADERS`, `DEFAULT_ALLOWED_HOSTS` | chargeurs gérés et sites autorisés par défaut |

### Commandes du terminal

```
npm test                                   # tous les tests automatiques (aucun accès Internet)
npm run test:live -w packages/launch       # tous les essais réels (long)
node packages/launch/test/live/smoke.js 1.20.1 forge   # un essai réel : installe et lance jusqu'au menu
```

## Organisation du dépôt

| Dossier | Contenu |
|---|---|
| [`packages/launch`](packages/launch) | le moteur `lanterne-launch` (code, tests, documentation) |

Bibliothèque sœur : [lanterne-skins](https://github.com/nono84250-sudo/lanterne-skins), pour les têtes, skins et capes.

## Installation

Le paquet n'est pas encore publié sur npm. En attendant :

```
git clone https://github.com/nono84250-sudo/lanterne.git
cd lanterne
npm test
```

Node.js 22 ou plus est nécessaire.

## Qualité

- Tests automatiques sur un faux serveur local : cas normaux, erreurs, coupure réseau, disque plein,
  fichiers corrompus, ZIP piégés.
- Essais réels de bout en bout (installation puis lancement jusqu'au menu) sur 1.8.9, 1.12.2, 1.20.1, 1.21.x
  et la dernière version, en vanilla et avec chaque chargeur.
- Relectures de code dédiées aux bugs, à la sécurité et au respect du cahier des charges.

## Contribuer

Les signalements de bugs et les propositions sont les bienvenus : voir [CONTRIBUTING.md](CONTRIBUTING.md).
Pour une faille de sécurité, merci de suivre [SECURITY.md](packages/launch/SECURITY.md) (signalement privé).

## Licence

[MIT](LICENSE). Aucun fichier de Minecraft n'est inclus : tout est téléchargé chez le joueur, depuis les serveurs officiels.

Projet indépendant, non affilié à Mojang ni Microsoft. « Minecraft » est une marque de Mojang AB.
