# Application de bureau (Windows et macOS)

La même application que la version serveur, installée sur un poste : le serveur Cartographe AWS
tourne dans l'application, sur **127.0.0.1 uniquement** (aucun port ouvert sur le réseau), en
HTTPS TLS 1.3, et s'affiche dans sa propre fenêtre. Mêmes règles de sécurité que le déploiement
serveur : compte local + TOTP obligatoire, lecture seule stricte côté AWS, identifiants saisis dans
l'interface, chiffrés s'ils sont mémorisés.

## Installation

| Système                   | Fichier                                     | Remarque                                        |
| ------------------------- | ------------------------------------------- | ----------------------------------------------- |
| Windows 10/11 (x64)       | `Cartographe-AWS-<version>-windows-x64.exe` | Installeur (par utilisateur, sans droits admin) |
| Windows 10/11 (x64)       | `Cartographe-AWS-<version>-windows-x64.zip` | Version portable : décompresser, lancer l'exe   |
| macOS 12+ (Apple Silicon) | `Cartographe-AWS-<version>-macos-arm64.dmg` | Glisser l'application dans « Applications »     |

**Builds non signés** (tant que l'organisation n'a pas fourni ses certificats) :

- Windows : SmartScreen affiche « Windows a protégé votre ordinateur » → « Informations
  complémentaires » → « Exécuter quand même ».
- macOS : clic droit sur l'application → « Ouvrir » → « Ouvrir » (une seule fois). Si macOS indique
  que l'application est endommagée (téléchargement mis en quarantaine) :
  `xattr -dr com.apple.quarantine "/Applications/Cartographe AWS.app"`.

## Premier lancement

1. Création du compte administrateur local (mot de passe ≥ 14 caractères) et activation du TOTP
   (application d'authentification), puis conservation des codes de secours.
2. « Ajouter un compte AWS » : identifiants en lecture seule (rôle conseillé : page « Aide »).

## Données

| Système | Dossier                                          |
| ------- | ------------------------------------------------ |
| Windows | `%APPDATA%\Cartographe AWS\`                     |
| macOS   | `~/Library/Application Support/Cartographe AWS/` |

- `donnees/` : base SQLite (comptes, profils, identifiants chiffrés, journal d'audit), snapshots,
  mises en page, journaux.
- `configuration/` : règles, thème, `app.yaml` (modifiables comme en version serveur).
- `tls/` : certificat local (127.0.0.1, EC P-256, 90 jours, renouvelé automatiquement).
- `cle-maitre.chiffree` : clé maître, **chiffrée par le système** (DPAPI sous Windows, Trousseau
  sous macOS) ; elle n'est jamais écrite en clair.

**Sauvegarde** : copier le dossier ci-dessus. La clé maître étant liée à la session du système, une
restauration sur un autre poste ou pour un autre utilisateur ne peut pas déchiffrer les
identifiants mémorisés : il suffit de les saisir à nouveau (profils, snapshots et diagrammes
restent lisibles).

**Désinstallation** : Windows « Applications installées » ; macOS : supprimer l'application. Le
dossier de données est conservé ; le supprimer pour tout effacer.

## Sécurité propre à la version de bureau

- Serveur lié à `127.0.0.1`, port 48443 (ou un port libre s'il est occupé).
- La fenêtre n'accepte **que** le certificat généré pour cette installation (épinglage), sans
  l'ajouter au magasin de certificats du système.
- Fenêtre isolée : `contextIsolation`, `sandbox`, aucun accès à Node, aucune permission (caméra,
  micro, notifications…), navigation limitée à l'origine locale ; les liens HTTPS externes (console
  AWS) s'ouvrent dans le navigateur par défaut.
- Fusibles Electron : pas de mode Node (`ELECTRON_RUN_AS_NODE`), pas d'inspecteur ni de
  `NODE_OPTIONS`, code chargé uniquement depuis l'archive dont l'intégrité est vérifiée, cookies
  chiffrés.
- Une seule instance à la fois.

## Construction

```sh
pnpm install
pnpm desktop:start          # lancer l'application en développement
pnpm desktop:e2e            # test de bout en bout de l'application (Playwright + Electron)
pnpm desktop:dist           # installeur de la plateforme courante (Windows : NSIS + ZIP, macOS : DMG + ZIP)
pnpm desktop:dist --win     # depuis Linux : version Windows portable (ZIP) ; l'installeur NSIS exige Windows
```

Résultats dans `apps/desktop/dist/release/`. La CI `.github/workflows/publication.yml` construit les deux
plateformes (Windows et macOS) sur leurs machines respectives et publie les artefacts.

Modules natifs (`better-sqlite3`, `argon2`) : binaires N-API précompilés, compatibles avec Electron
sans recompilation. macOS Intel : `argon2` n'en publie pas ; ajouter la cible `x64` dans
`apps/desktop/electron-builder.yml` et construire sur un Mac Intel (compilation à l'installation).

### Signature

Fournir à la construction (secrets de la CI) :

| Plateforme | Variables                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows    | `CSC_LINK` (certificat Authenticode `.pfx`, base64), `CSC_KEY_PASSWORD`                                                                     |
| macOS      | `CSC_LINK` (Developer ID Application `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (notarisation) |

Sans certificat, Windows est produit non signé et macOS signé « ad hoc » (lançable après
confirmation, voir « Installation »).

## Différences avec la version serveur

| Sujet                                       | Serveur (Docker)                  | Bureau                                            |
| ------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| Accès                                       | Réseau, derrière Traefik          | Ce poste uniquement (127.0.0.1)                   |
| Certificat                                  | Fourni (Let's Encrypt…)           | Généré et épinglé par l'application               |
| Clé maître                                  | Docker secret (`MASTER_KEY_FILE`) | Trousseau du système (DPAPI / Keychain)           |
| Authentification                            | Locale + TOTP ou OIDC             | Locale + TOTP                                     |
| Identité AWS de l'outil (`HUB_CREDENTIALS`) | Possible                          | Désactivée : identifiants saisis dans l'interface |
| Mode démo                                   | `DEMO_MODE=true`                  | `CARTO_DEMO=true` au lancement (développement)    |
