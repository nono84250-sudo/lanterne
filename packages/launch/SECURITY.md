# Sécurité / Security

## Signaler une faille / Reporting a vulnerability

Merci de **ne pas** ouvrir de ticket public. Écrivez en privé aux mainteneurs (adresse de contact ajoutée lors de la
publication du dépôt ; sur GitHub : onglet « Security » → « Report a vulnerability »). Aucun délai de réponse n'est garanti : ce projet est fourni tel quel.

Please do **not** open a public issue. Use GitHub's private vulnerability reporting. No response time is guaranteed.

## Ce que le moteur garantit

| Risque | Protection |
|---|---|
| Fichier modifié en route | HTTPS obligatoire à chaque étape, même après redirection. Empreinte SHA-1 **obligatoire** et taille vérifiées pour chaque fichier. Écriture dans un `.part` (jamais via un lien symbolique), puis renommage. |
| Site non officiel | Liste blanche : Mojang, Fabric, Quilt, NeoForge, Forge. Port standard uniquement, sauf s'il est écrit explicitement. Les portails Wi-Fi captifs sont traités comme « pas d'Internet ». |
| Archive piégée | Extracteur maison : refuse `../`, chemins absolus, `C:`, UNC, caractère nul, `:`, noms réservés Windows, point/espace final, doublons. Ignore les liens symboliques et les droits spéciaux. Plafonds de taille, de nombre et de taux de compression (bombes ZIP), plus bas pour les natives. |
| Commande détournée | Java est lancé avec une liste d'arguments (`shell: false`). Les options Java venant des fichiers téléchargés passent par une **liste blanche** : tout ce qui n'est pas connu est ignoré (par exemple `-javaagent`, `@fichier`, `-XX:On…`, `-Dminecraft.api.*.host`, `-Dlog4j.configurationFile` distant). La configuration des journaux de Mojang est toujours appliquée en dernier. Le jeton n'est jamais placé dans les options Java. |
| Lien qui sort du dossier Java | Les liens du runtime Mojang ne sont créés que s'ils restent dans son dossier et visent un vrai fichier. |
| Expression piégée (ReDoS) | Les règles « os.version » ne sont évaluées que si elles sont simples (64 caractères au plus). |
| Fichier local abîmé ou remplacé | Avant chaque lancement : empreinte complète du jeu, des bibliothèques et de tous les fichiers du Java automatique (sauf la documentation), sauf `fastLaunch`. Les fichiers produits par l'installeur d'un chargeur sans empreinte publiée sont contrôlés par leur taille. |
| Fuite du jeton | Masqué dans tous les journaux et dans `jeu.command`, absent de `console.log(jeu)` et des erreurs, jamais dans `account`. Exception voulue : `buildArgs()` (outil avancé) le contient dans `args`/`secrets` — à ne jamais journaliser. `exporterJournal()` retire aussi le pseudo, l'UUID et le dossier personnel. |

## Limites connues (à connaître)

- **Empreintes des dépôts maven** : certaines bibliothèques de Fabric, Quilt et Forge n'ont pas d'empreinte dans leur
  fichier de version. Le moteur lit alors le fichier `.sha1` publié **sur le même serveur**. Cela protège contre un
  fichier abîmé, pas contre un serveur officiel lui-même compromis.
- **Jeton visible dans la liste des processus** : Minecraft reçoit le jeton en argument (`--accessToken`), comme avec
  le launcher officiel. Un autre programme lancé par le même utilisateur peut le voir. C'est imposé par le jeu.
- **Programmes d'installation Forge / NeoForge** : ils sont exécutés localement (Java). Ils viennent du dépôt officiel
  et sont vérifiés par empreinte, mais leur code n'est pas contrôlé par ce moteur.
- **Dossier commun** : utilisez un dossier propre à l'utilisateur (par exemple dans `%APPDATA%` ou `~/.local/share`),
  pas un dossier partagé où d'autres comptes peuvent écrire.
