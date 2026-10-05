# CloudMap

Application auto-hébergée qui scanne un compte AWS, un abonnement Azure ou un projet Google Cloud
**en lecture seule**, découvre les services utilisés, déduit les flux réseau et génère un diagramme
d'architecture interactif. Utilisable avec ou sans compte (mode invité : rien n'est enregistré).

## À propos

CloudMap est développé avec l'assistance de **Claude** (Anthropic). En revanche,
**l'application elle-même ne contient aucune intelligence artificielle** : aucun
modèle d'IA, aucun appel à un service d'IA, aucune donnée envoyée à un tiers. Les
scans se font uniquement par des appels **en lecture seule** aux API du
fournisseur de cloud, et les résultats restent sur votre poste ou votre serveur
(voir [docs/securite.md](docs/securite.md)).

## Installer CloudMap : quatre façons

Les versions publiées sont sur la page
[Releases](https://github.com/tonyparquet/cloudmap/releases/latest).

### 1. Application Windows

1. Téléchargez `CloudMap-<version>-windows-x64.exe` (installeur) ou `…-windows-x64.zip` (version
   portable, sans installation).
2. Lancez l'installeur. L'application n'étant pas signée, Windows SmartScreen affiche « Windows a
   protégé votre ordinateur » : cliquez sur **Informations complémentaires** puis
   **Exécuter quand même**.
3. Ouvrez CloudMap depuis le menu Démarrer : créez un compte ou continuez sans compte.

Les données restent sur le poste (`%APPDATA%\CloudMap\`). Détails : [docs/bureau.md](docs/bureau.md).

### 2. Application macOS (Apple Silicon)

1. Téléchargez `CloudMap-<version>-macos-arm64.dmg`, ouvrez-le et glissez **CloudMap** dans
   **Applications**.
2. Premier lancement : l'application n'étant pas signée, faites **clic droit → Ouvrir**, puis
   **Ouvrir**. Si macOS refuse encore :
   `xattr -dr com.apple.quarantine /Applications/CloudMap.app`
3. Créez un compte ou continuez sans compte.

Les données restent sur le poste (`~/Library/Application Support/CloudMap/`).

### 3. Sur le poste, depuis les sources (Windows, macOS, Linux)

Prérequis : [Node.js 22](https://nodejs.org/) et pnpm (`corepack enable`), OpenSSL.

```sh
git clone https://github.com/tonyparquet/cloudmap.git cloudmap && cd cloudmap
pnpm install
pnpm start        # https://localhost:8443
```

Un certificat auto-signé est généré pour `localhost` (le navigateur l'indique : continuez vers le
site), l'application n'écoute que sur 127.0.0.1 et les données sont dans `.data/`. Pour essayer avec
les profils de démonstration : `pnpm dev`.

### 4. Serveur avec Docker Compose (équipe)

Prérequis : Docker 24+ avec Compose v2, OpenSSL.

```sh
git clone https://github.com/tonyparquet/cloudmap.git cloudmap && cd cloudmap/deploy
mkdir -p secrets
openssl rand -base64 32 > secrets/master_key   # clé maître : à sauvegarder à part
# Certificat TLS : copiez le vôtre en secrets/tls_cert.pem et secrets/tls_key.pem, ou, pour un essai :
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 90 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout secrets/tls_key.pem -out secrets/tls_cert.pem
sudo chown 10001:10001 secrets/* && sudo chmod 400 secrets/*
PUBLIC_ORIGIN=https://localhost:8443 docker compose up -d --build
```

Ouvrez `https://localhost:8443` (ou votre nom public dans `PUBLIC_ORIGIN`). Sur un serveur accessible
en réseau, réservez l'outil aux comptes créés par un administrateur : `access.guests: false` et
`access.selfRegistration: false` dans `app.yaml`. Traefik, sauvegarde, mise à jour et rotation de la
clé maître : [docs/deploiement.md](docs/deploiement.md).

## Documentation

- Spécification complète : [CLAUDE.md](CLAUDE.md)
- Sécurité (modèle de menace, chiffrement, authentification, mode invité) : [docs/securite.md](docs/securite.md)
- Signaler une vulnérabilité : [SECURITY.md](SECURITY.md)
- Rôle en lecture seule à créer chez le client : AWS [docs/iam/](docs/iam/), Azure
  [docs/azure/](docs/azure/), Google Cloud [docs/gcp/](docs/gcp/)
- Versions et publication : [docs/publication.md](docs/publication.md), [CHANGELOG.md](CHANGELOG.md)
- Décisions d'implémentation : [docs/decisions.md](docs/decisions.md)

## Développement

```sh
pnpm install
pnpm dev          # https://localhost:8443, profils de démonstration, interface reconstruite à chaque modification
```

Commandes : `pnpm build`, `pnpm test`, `pnpm e2e`, `pnpm lint`, `pnpm typecheck`, `pnpm check`,
`pnpm cli scan --profile <profil-aws> --regions eu-west-3`, `pnpm cli rotate-master-key`,
`pnpm desktop:start`, `pnpm desktop:dist`, `pnpm desktop:e2e` (application de bureau),
`pnpm release X.Y.Z` (publication d'une version).
