# Politique de sécurité

CloudMap est un outil de sécurité : il scanne un compte cloud **en lecture seule** pour en
cartographier l'architecture. La sécurité du projet est donc une priorité. Merci de contribuer à le
garder sûr en signalant les vulnérabilités de façon responsable.

## Versions prises en charge

Seule la **dernière version publiée** reçoit les correctifs de sécurité.

| Version  | Prise en charge |
| -------- | --------------- |
| 1.5.x    | ✅              |
| &lt; 1.5 | ❌              |

Mettez à jour vers la dernière [release](https://github.com/tonyparquet/cloudmap/releases/latest)
avant de signaler un problème, afin de vérifier qu'il n'est pas déjà corrigé.

## Signaler une vulnérabilité

**N'ouvrez pas d'« issue » publique pour une faille de sécurité.**

Utilisez le **signalement privé de vulnérabilité** de GitHub :

1. Onglet **Security** du dépôt → **Report a vulnerability** (ou
   [Security Advisories](https://github.com/tonyparquet/cloudmap/security/advisories)).
2. Décrivez : la version concernée, le mode d'installation (application de bureau, sources, Docker),
   les étapes de reproduction, l'impact, et si possible une preuve de concept.

Ce canal est privé : seuls vous et les mainteneurs voyez le signalement jusqu'à la divulgation.

### Ce à quoi vous attendre

- **Accusé de réception** sous quelques jours.
- Évaluation et, si la faille est confirmée, préparation d'un correctif.
- **Divulgation coordonnée** : publication d'un avis de sécurité et d'une version corrigée ; mention
  de votre contribution si vous le souhaitez.

Merci de laisser un délai raisonnable pour le correctif avant toute divulgation publique.

## Périmètre

Concerne le code de ce dépôt (cœur, scanner, serveur, interface, application de bureau).

Rappels sur la posture de sécurité de l'outil (détails dans
[docs/securite.md](docs/securite.md)) :

- Accès cloud **strictement en lecture seule** (`Describe*` / `List*` / `Get*`), jamais d'écriture ;
  **jamais** la valeur d'un secret.
- **Aucune IA** dans l'application : aucun modèle, aucun appel à un service d'IA, aucune donnée
  envoyée à un tiers.
- Transport **TLS 1.3 uniquement**, en-têtes stricts (CSP, HSTS…), aucune ressource externe.
- Identifiants cloud **jamais** renvoyés au navigateur ni écrits en clair ; chiffrement d'enveloppe
  (AES-256-GCM), mots de passe en Argon2id, MFA TOTP.

### Hors périmètre

- Vulnérabilités d'une instance que vous avez **mal configurée** (TLS désactivé en amont, secrets
  exposés, reverse proxy non durci) plutôt que du code lui-même.
- Dépendances tierces : signalez-les d'abord à leurs mainteneurs (nous les tenons à jour).
- Ingénierie sociale, accès physique, déni de service par volume.

## Bonnes pratiques de déploiement

Suivez [docs/securite.md](docs/securite.md) et [docs/deploiement.md](docs/deploiement.md) :
sauvegarde séparée de la clé maître, rôle cloud en lecture seule
([docs/iam/](docs/iam/), [docs/azure/](docs/azure/), [docs/gcp/](docs/gcp/)), et sur un serveur
accessible en réseau, réservez l'outil aux comptes créés par un administrateur.
