# Contribuer / Contributing

Merci de votre intérêt pour lanterne ! / Thanks for your interest in lanterne!

## Signaler un bug / Reporting a bug

Ouvrez un ticket (onglet « Issues ») avec : la version de Node.js, le système (Windows, macOS, Linux),
ce que vous avez fait, ce qui s'est passé et ce que vous attendiez.
**Ne collez jamais de jeton de connexion** ni d'informations personnelles dans un ticket.

Open an issue with your Node.js version, OS, what you did, what happened and what you expected.
**Never paste an access token** or personal data in an issue.

## Faille de sécurité / Security issue

Pas de ticket public : suivez [SECURITY.md](packages/launch/SECURITY.md). / No public issue: follow [SECURITY.md](packages/launch/SECURITY.md).

## Proposer une modification / Pull requests

1. Une modification par demande, avec des tests. / One change per pull request, with tests.
2. `npm test` doit passer à 100 %. / `npm test` must pass fully.
3. Règles du projet / Project rules:
   - zéro dépendance externe / zero runtime dependencies;
   - seulement les serveurs officiels (Mojang, Microsoft, chargeurs officiels), aucun service tiers /
     official servers only, no third-party services;
   - aucun fichier de Minecraft ni de mod dans le dépôt / no Minecraft or mod files in the repository;
   - le jeton du joueur ne doit jamais apparaître dans un journal / the player's token must never be logged.

En contribuant, vous acceptez que votre code soit publié sous [licence MIT](LICENSE).
By contributing, you agree that your code is released under the [MIT licence](LICENSE).
