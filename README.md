# Cartographe AWS

Application web auto-hébergée qui scanne un compte AWS **en lecture seule**, découvre les services
utilisés, déduit les flux réseau et génère un diagramme d'architecture interactif.

- Spécification complète : [CLAUDE.md](CLAUDE.md)
- Déploiement (Docker, Traefik, sauvegarde, rotation de clé) : [docs/deploiement.md](docs/deploiement.md)
- Application de bureau Windows et macOS : [docs/bureau.md](docs/bureau.md)
- Versions, publication et mises à jour : [docs/publication.md](docs/publication.md) — [CHANGELOG.md](CHANGELOG.md)
- Sécurité (modèle de menace, chiffrement, authentification) : [docs/securite.md](docs/securite.md)
- Rôle IAM à créer chez le client : [docs/iam/](docs/iam/)
- Décisions d'implémentation : [docs/decisions.md](docs/decisions.md)

## Démarrage rapide (développement, mode démo)

```sh
pnpm install
pnpm dev          # https://localhost:8443 — certificat de développement auto-signé
```

Commandes : `pnpm build`, `pnpm test`, `pnpm e2e`, `pnpm lint`, `pnpm typecheck`, `pnpm check`,
`pnpm cli scan --profile <profil-aws> --regions eu-west-3`, `pnpm cli rotate-master-key`,
`pnpm desktop:start`, `pnpm desktop:dist`, `pnpm desktop:e2e` (application de bureau),
`pnpm release X.Y.Z` (publication d'une version).
