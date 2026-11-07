# Historique / Changelog

## 0.1.0 (non publié)

Première version du moteur.

- Installation et lancement de Minecraft Java : vanilla, Fabric, Quilt, NeoForge, Forge (ancien avant 1.13 et récent).
- Java automatique (runtime officiel Mojang, y compris Java 25 pour 26.x), avec repli x64 sur Mac Apple et Windows ARM.
- Progression (Mo, vitesse, temps restant, étapes), Pause / Reprendre / Annuler, reprise après coupure.
- Hors-ligne et bascule automatique si Internet est coupé ; mode démo ; Quick Play.
- `verify()` et `repair()` (ne retélécharge que les fichiers abîmés).
- Contrôle par empreinte avant chaque lancement ; journaux du jeu lisibles, jeton masqué, export anonymisé.
- Sécurité : voir [SECURITY.md](SECURITY.md).
