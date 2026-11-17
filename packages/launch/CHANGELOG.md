# Historique / Changelog

## 0.1.0 (non publié)

Première version du moteur.

- Licence : GNU GPL v3 (GPL-3.0-only), à la place de MIT (le code déjà mis en ligne sous MIT avant ce changement reste disponible sous MIT).

- Installation et lancement de Minecraft Java : vanilla, Fabric, Quilt, NeoForge, Forge (ancien avant 1.13 et récent).
- Minecraft 1.7.10 vérifié jusqu'au menu, en vanilla et avec Forge (Java 8, natives LWJGL 2, ancien installeur), sous Linux, et la version Windows sous Wine ; ajouté aux essais réels.
- Essais réels : un jeu qui se ferme tout seul après le menu compte maintenant comme un échec.
- Fabric / Quilt : la version du chargeur prise par défaut est la plus récente stable, même si la liste reçue n'est pas triée
  (Quilt pour 26.x proposait une ancienne version, qui plantait avec Java 25).
- Java automatique (runtime officiel Mojang, y compris Java 25 pour 26.x), avec repli x64 sur Mac Apple et Windows ARM.
- Progression (Mo, vitesse, temps restant, étapes), Pause / Reprendre / Annuler, reprise après coupure.
- Hors-ligne et bascule automatique si Internet est coupé ; mode démo ; Quick Play.
- `verify()` et `repair()` (ne retélécharge que les fichiers abîmés).
- Contrôle par empreinte avant chaque lancement ; journaux du jeu lisibles, jeton masqué, export anonymisé.
- Sécurité : voir [SECURITY.md](SECURITY.md).
- Messages d'erreur en français et en anglais : option `lang: 'fr' | 'en'` (prepare, install, launch, verify, repair…),
  `setLanguage()`, `err.setLanguage()`, `err.userMessages`, `ERROR_MESSAGES_EN`. Les codes ne changent pas ;
  chaque erreur a en plus une propriété `lang` ('fr' ou 'en').
