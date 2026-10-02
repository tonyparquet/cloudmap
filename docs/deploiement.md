# Déploiement

L'image Docker est **unique pour tous les clients** : aucune valeur client n'y figure. Changer de
client = créer un autre profil dans l'interface.

## Prérequis

- Docker 24+ et Docker Compose v2.
- Un certificat TLS valide pour le nom public (ou le nom interne si l'application est derrière Traefik).
- Une **clé maître** de 32 octets aléatoires :

```sh
mkdir -p deploy/secrets
openssl rand -base64 32 > deploy/secrets/master_key
cp /chemin/fullchain.pem deploy/secrets/tls_cert.pem
cp /chemin/privkey.pem   deploy/secrets/tls_key.pem
# Le conteneur tourne sous l'UID 10001 : il doit pouvoir lire les secrets, et personne d'autre.
sudo chown 10001:10001 deploy/secrets/*
sudo chmod 400 deploy/secrets/*
```

L'application **refuse de démarrer** (message explicite, code de sortie 1) si `TLS_CERT_FILE`,
`TLS_KEY_FILE`, `MASTER_KEY_FILE` ou `PUBLIC_ORIGIN` manque, si le certificat est expiré ou ne
correspond pas à la clé, si `PUBLIC_ORIGIN` n'est pas en `https://`, ou si la clé maître ne
correspond pas aux données déjà chiffrées.

## Déploiement autonome (certificat fourni)

```sh
cd deploy
PUBLIC_ORIGIN=https://carto.exemple.fr docker compose up -d --build
docker compose ps        # état « healthy » : healthcheck HTTPS sur /healthz
```

L'application écoute uniquement en HTTPS TLS 1.3 sur le port 8443 (aucun écouteur HTTP). Vérification :

```sh
openssl s_client -connect carto.exemple.fr:8443 -tls1_2 </dev/null   # refusé
openssl s_client -connect carto.exemple.fr:8443 -tls1_3 </dev/null   # accepté
```

Au premier accès, l'assistant crée le compte administrateur (TOTP obligatoire).

## Derrière Traefik

1. Monter `deploy/traefik/dynamic.yml` dans Traefik (fournisseur `file`) et l'autorité qui a signé le
   certificat interne de l'application dans `/etc/traefik/certs/carto-ca.pem` ; adapter `serverName`
   au nom présent dans ce certificat.
2. Traefik expose deux points d'entrée `web` (80, redirigé vers HTTPS) et `websecure` (443, options
   TLS `modern` : TLS 1.3, `sniStrict`).
3. Démarrer avec le nom public et la plage du réseau Docker de Traefik :

```sh
PUBLIC_ORIGIN=https://carto.exemple.fr PUBLIC_HOST=carto.exemple.fr \
TRUSTED_PROXY_CIDRS=172.18.0.0/16 docker compose up -d
```

Le trafic reste chiffré de bout en bout (rechiffrement vers l'application, certificat vérifié).
`X-Forwarded-*` n'est pris en compte que pour les adresses de `TRUSTED_PROXY_CIDRS`. On peut retirer
la publication du port 8443 dans `docker-compose.yml` si seul Traefik doit atteindre l'application.

## Identité AWS de l'outil (optionnel)

Avec `HUB_CREDENTIALS=default-chain`, l'outil utilise son propre rôle (instance EC2, tâche ECS…) pour
assumer les rôles clients sans qu'aucune clé ne soit saisie. Le rôle client est décrit dans
`docs/iam/` (page « Aide » de l'interface, External ID propre à chaque profil).

## OIDC

`AUTH_MODE=oidc`, `OIDC_ISSUER` (https), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET_FILE` (secret Docker),
`OIDC_ADMIN_GROUP`, et optionnellement `OIDC_EDITOR_GROUP` et `OIDC_GROUPS_CLAIM` (défaut `groups`).
URL de retour à déclarer chez le fournisseur : `<PUBLIC_ORIGIN>/api/auth/oidc/callback`.

## Sauvegarde

- **DATA_DIR** (volume `data`) : base `app.db` (utilisateurs, profils, identifiants chiffrés, audit),
  snapshots, mises en page, journaux. Sauvegarde à chaud possible (`sqlite3 app.db ".backup ..."`).
- **Clé maître** : à sauvegarder **séparément** (coffre de secrets). Sans elle, les identifiants
  mémorisés et les secrets TOTP sont irrécupérables ; avec elle seule, rien n'est lisible.
- **CONFIG_DIR** (volume `config`) : règles et thème personnalisés.

## Rotation de la clé maître

```sh
openssl rand -base64 32 > deploy/secrets/master_key.nouvelle
docker compose stop carto
docker compose run --rm --entrypoint node \
  -v "$PWD/secrets/master_key.nouvelle:/run/secrets/master_key_nouvelle:ro" carto \
  apps/cli/dist/main.mjs rotate-master-key --new-key-file /run/secrets/master_key_nouvelle
mv deploy/secrets/master_key.nouvelle deploy/secrets/master_key
docker compose up -d
```

## Mise à jour

```sh
git pull && cd deploy && docker compose build && docker compose up -d
```

Les migrations SQLite sont appliquées automatiquement au démarrage (versionnées, une seule fois).

## Scan hors-ligne (CLI)

Sur un poste ayant accès au compte (profil AWS standard, SSO…) :

```sh
pnpm cli scan --profile <profil-aws> --regions eu-west-3
```

Le fichier `snapshot-<compte>-<date>.json` produit s'importe dans la page « Import ».
