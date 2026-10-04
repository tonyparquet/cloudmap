# Journal des modifications

Évolutions notables de Cartographe AWS. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions selon le
[versionnage sémantique](https://semver.org/lang/fr/). Chaque version publiée porte le tag `vX.Y.Z`
(`pnpm release X.Y.Z`, voir `docs/publication.md`).

## [Non publié]

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

[Non publié]: https://github.com/tonyparquet/aws_map/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/tonyparquet/aws_map/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/tonyparquet/aws_map/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tonyparquet/aws_map/releases/tag/v1.0.0
