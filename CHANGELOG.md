# Journal des modifications

Évolutions notables de CloudMap. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions selon le
[versionnage sémantique](https://semver.org/lang/fr/). Chaque version publiée porte le tag `vX.Y.Z`
(`pnpm release X.Y.Z`, voir `docs/publication.md`).

## [Non publié]

## [1.4.0] - 2026-10-05

### Ajouté

- Icônes officielles par fournisseur : `pnpm fetch-icons` récupère désormais les packs **AWS**,
  **Azure** et **Google Cloud** (vers `config/icons/aws|azure|gcp/`) et les sert selon le préfixe du
  nom d'icône. Les ressources Azure et GCP s'affichent avec leurs icônes officielles, comme AWS. Sans
  les packs, le repli par icône générique de catégorie reste en place.

### Corrigé

- Montée de version : les nouvelles règles par défaut (dont Azure, Google Cloud) sont désormais
  ajoutées à une installation existante au démarrage, sans écraser les fichiers modifiés. Avant, un
  `CONFIG_DIR` déjà initialisé restait figé : les ressources d'un fournisseur ajouté après coup
  s'affichaient en nœuds génériques (libellé = identifiant complet, pas d'icône, pas de hiérarchie).

## [1.3.0] - 2026-10-05

### Ajouté

- Compte facultatif : à l'ouverture, se connecter, créer un compte (le premier administre
  l'installation) ou continuer **sans compte**. En mode invité, rien n'est enregistré ni journalisé :
  tout disparaît à la déconnexion. Un invité qui crée un compte garde son travail.
- Double authentification activable (et désactivable) plus tard, depuis « Mon compte ».
- Dossiers et sous-dossiers pour ranger les profils et leurs diagrammes, avec glisser-déposer.
- Réglages `access` dans `app.yaml` pour désactiver le mode invité ou la création libre de comptes.
- Quatre façons d'installer CloudMap, décrites dans le README : application Windows, application
  macOS, sur le poste depuis les sources (`pnpm start`) et serveur Docker Compose.

### Corrigé

- Les liens de l'interface transmettent leurs libellés d'accessibilité (logo, badge de mise à jour).

## [1.2.1] - 2026-10-04

### Modifié

- Formulaire de profil plus vivant : sections numérotées (Compte, Régions, Accès) qui se cochent une
  fois complètes, cartes de choix et cases à cocher animées, régions en pastilles avec « Tout » /
  « Aucune » par continent, identifiant du compte validé en direct, barre d'actions qui indique ce
  qu'il reste à compléter. Animations désactivées si le système demande moins de mouvement.

## [1.2.0] - 2026-10-04

### Modifié

- L'application s'appelle désormais **CloudMap** (anciennement Cartographe AWS) : interface,
  application de bureau, installeurs `CloudMap-<version>-…`, image et service Docker `cloudmap`,
  paquets `@cloudmap/*`, CLI (`CLOUDMAP_ACCESS_TOKEN`), rôles en lecture seule par défaut
  (`CloudMapLectureSeule`…), émetteur TOTP.
- Formulaire de profil plus compact : page plus large, fournisseur, champs et modes d'accès en ligne,
  régions sur plusieurs colonnes, boutons d'enregistrement toujours visibles.

### Mise à niveau

- Application de bureau : au premier lancement, CloudMap reprend les données de l'ancienne
  application (macOS : accès au trousseau à accepter une fois). Windows : l'installeur remplace
  l'ancienne version.
- Docker : copier une fois les volumes `cartographe-aws_*` vers `cloudmap_*` (voir
  `docs/deploiement.md`). La clé maître ne change pas ; les identifiants mémorisés et les secrets
  TOTP sont migrés automatiquement au démarrage.
- Les rôles déjà créés chez les clients continuent de fonctionner (ARN complet enregistré dans chaque
  profil). Les entrées TOTP existantes restent valables.

## [1.1.0] - 2026-10-04

### Ajouté

- Microsoft Azure et Google Cloud : profils par abonnement ou projet, identifiants saisis dans
  l'interface (jeton de la CLI, principal de service, clé de compte de service), scan en lecture
  seule, diagramme réseau avec flux NSG / pare-feu VPC, vue Organisation, vue multi-comptes,
  comptes d'organisation, imports et profils de démonstration.
- Page « Aide » par fournisseur (rôle en lecture seule et commandes).
- CLI : scan hors-ligne Azure et Google Cloud (`--provider`, jeton lu dans `CARTO_ACCESS_TOKEN`).

### Modifié

- Le journal des modifications met à jour ses liens de comparaison à chaque version.

## [1.0.1] - 2026-10-04

### Corrigé

- macOS (application non signée) : la signature ad hoc n'active plus le runtime renforcé, dont la
  validation des bibliothèques pouvait empêcher le lancement de l'application.

## [1.0.0] - 2026-10-04

Première version publiée.

### Ajouté

- Scan en lecture seule d'un compte AWS (réseau, calcul, équilibrage, données, CI/CD, sécurité,
  observabilité), inventaire générique (Resource Explorer, AWS Config) pour les types sans collecteur,
  permissions manquantes signalées sans interrompre le scan, progression en direct.
- Diagramme d'architecture interactif : Région > VPC > zone > sous-réseau, pastilles d'état, ports
  sur les liens, flux déduits des groupes de sécurité, NACL et routes, flux observés (Flow Logs),
  filtres, recherche, panneau de détail, mise en page conservée entre deux scans.
- Catalogue de règles déclaratif (YAML + JSONata) : ajouter un service ne demande aucune recompilation.
- Comparaison de deux snapshots ; exports SVG, PNG, PDF, draw.io et JSON ; inventaire exportable en CSV.
- CLI de scan hors ligne (snapshot importable) et rotation de la clé maître.
- Mise en route guidée d'un compte : identifiants (collage d'un bloc AWS, aide aux clés temporaires,
  correction du compte en un clic), premier scan, ouverture automatique du diagramme.
- Identifiants saisis dès la création du profil ; réutilisation des clés mémorisées d'un autre profil.
- Vue Organisation : comptes, OU, SCP / RCP et autres politiques, administrateurs délégués, groupes
  et permission sets IAM Identity Center.
- Vue multi-comptes : un cadre par compte, liens inter-comptes (appairages VPC, Transit Gateways
  partagés, groupes de sécurité et relations d'un compte à l'autre).
- Scan de toute une organisation : profils membres créés depuis un profil hub, rôle en lecture seule
  déployé par StackSet, scan en série.
- Application de bureau Windows et macOS (Electron) : serveur local sur 127.0.0.1 en TLS 1.3,
  certificat épinglé, clé maître protégée par le système.
- Recherche de mise à jour dans l'application, journal des modifications et versions taguées.
- Ergonomie : fil d'Ariane, recherche de profils, régions repliables, icônes SVG, identité visuelle.

### Sécurité

- HTTPS TLS 1.3 uniquement, en-têtes stricts (CSP à nonce, HSTS…), démarrage refusé sans TLS ni clé
  maître.
- Authentification locale avec TOTP obligatoire ou OIDC, sessions `__Host-`, CSRF, ré-authentification
  pour les actions sensibles, limitation des tentatives, rôles et cloisonnement par groupes.
- Identifiants AWS en écriture seule, en mémoire par défaut, chiffrement d'enveloppe s'ils sont
  mémorisés, jamais renvoyés au navigateur ni journalisés ; appels AWS en lecture seule vérifiés par
  un test de liste blanche ; aucune lecture de valeur secrète.
- Journal d'audit en ajout seul, protection SSRF des sondes HTTP.

### Problèmes connus

- Installeurs Windows et macOS non signés : avertissement SmartScreen / Gatekeeper au premier
  lancement (voir `docs/bureau.md`).
- macOS : Apple Silicon uniquement.

[Non publié]: https://github.com/tonyparquet/aws_map/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/tonyparquet/aws_map/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/tonyparquet/aws_map/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/tonyparquet/aws_map/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/tonyparquet/aws_map/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tonyparquet/aws_map/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/tonyparquet/aws_map/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tonyparquet/aws_map/releases/tag/v1.0.0
