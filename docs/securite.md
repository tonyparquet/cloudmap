# Sécurité

## Modèle de menace

| Menace                                         | Mesures                                                                                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interception réseau                            | HTTPS uniquement, TLS 1.3 seul (suites AES-256-GCM, ChaCha20-Poly1305, AES-128-GCM ; courbes X25519, P-256, P-384), HSTS preload, rechiffrement derrière Traefik, pas d'écouteur HTTP.        |
| Vol des identifiants AWS saisis                | Écriture seule vers le serveur ; en mémoire par défaut, liés à la session ; chiffrement d'enveloppe si « Mémoriser » ; jamais renvoyés au navigateur ; redaction des journaux et erreurs.     |
| Identifiants trop puissants                    | Refus du compte racine, vérification du compte, échange immédiat contre des identifiants temporaires, avertissement si `SimulatePrincipalPolicy` montre des droits d'écriture.                |
| Action destructrice sur AWS                    | Appels en lecture seule uniquement, vérifiés par un test statique de liste blanche ; politique IAM fournie avec refus explicite des lectures de secrets.                                      |
| Fuite de secrets applicatifs du client         | Aucune lecture de valeur (Secrets Manager, SSM, variables d'environnement Lambda/ECS, buildspec) : noms et métadonnées seulement.                                                             |
| Usurpation de session, CSRF, clickjacking, XSS | Cookie `__Host-` Secure HttpOnly SameSite=Strict, identifiant opaque de 256 bits haché en base, jeton CSRF synchronisé + contrôle d'`Origin`, CSP stricte à nonce, `frame-ancestors 'none'`.  |
| Force brute                                    | Argon2id (64 Mio, t=3), 5 essais / 15 min par compte et par IP puis verrouillage progressif, TOTP obligatoire avec anti-rejeu, limitation globale de l'API.                                   |
| Accès entre clients                            | Profils cloisonnés par groupes (`allowedGroups`), rôles `admin` / `editor` / `viewer`, profil d'un autre groupe invisible (404).                                                              |
| SSRF via les sondes                            | HTTPS par défaut, IP privées / link-local / réservées bloquées (sauf option explicite du profil), métadonnées cloud toujours bloquées, contrôle à la résolution DNS, redirections revalidées. |
| Import malveillant                             | Schéma zod strict, taille maximale, rejet de `__proto__` / `constructor`.                                                                                                                     |
| Compromission du conteneur                     | Non-root (UID 10001), système de fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges`, image minimale sans npm.                                                                    |
| Répudiation                                    | Journal d'audit en ajout seul (triggers SQLite), sans valeur d'identifiant, export CSV.                                                                                                       |

## Application de bureau (poste local)

| Menace                                                                              | Mesures                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accès depuis le réseau                                                              | Serveur lié à `127.0.0.1` uniquement ; aucune règle de pare-feu ni port exposé.                                                                                                             |
| Autre processus local qui se fait passer pour l'application, ou interception locale | TLS 1.3 avec certificat généré par installation et **épinglé** par la fenêtre ; authentification + TOTP inchangées : un processus local qui joint le port doit tout de même s'authentifier. |
| Vol de la clé maître sur disque                                                     | Clé chiffrée par le système (DPAPI / Trousseau), liée à la session de l'utilisateur ; jamais écrite en clair (`loadConfig` la reçoit en mémoire).                                           |
| Contenu web malveillant dans la fenêtre                                             | `contextIsolation`, `sandbox`, pas de Node, aucune permission, navigation et nouvelles fenêtres limitées à l'origine locale, CSP stricte du serveur.                                        |
| Détournement du binaire Electron                                                    | Fusibles : pas de `ELECTRON_RUN_AS_NODE`, pas d'inspecteur ni de `NODE_OPTIONS`, archive à intégrité vérifiée ; signature Authenticode / Developer ID dès que fournie.                      |
| Logiciel malveillant avec les droits de l'utilisateur                               | Hors périmètre (il peut lire la session du système) ; les identifiants AWS restent temporaires et en mémoire par défaut, les clés longues ne sont mémorisées que sur demande.               |

## Identifiants AWS

- Types acceptés : clés temporaires (recommandé), clés d'utilisateur IAM + rôle + External ID,
  clés d'utilisateur IAM seules (avertissement), rôle + External ID via l'identité de l'outil.
- Contrôles serveur : format (zod), `sts:GetCallerIdentity`, refus de `:root`, compte du profil.
- Clés longue durée : échangées immédiatement (`AssumeRole` ou `GetSessionToken`, 1 h par défaut).
  Conservées seulement si « Mémoriser (chiffré) » est coché.
- En mémoire : effacés à la déconnexion, à l'expiration de la session ou après
  `credentials.memoryTtlMinutes`.
- Chiffrement d'enveloppe : une DEK aléatoire par entrée chiffre la donnée (AES-256-GCM, IV de
  12 octets aléatoires) ; la DEK est chiffrée par une KEK dérivée de la clé maître (HKDF-SHA256).
  AAD = `profileId|credentialRef`. Une empreinte HMAC de la clé maître détecte au démarrage une
  clé qui ne correspond pas aux données.
- Les secrets TOTP sont chiffrés de la même manière (AAD `totp|<utilisateur>`).

## Authentification

- Mode local : assistant du premier administrateur, mot de passe ≥ 14 caractères absent de la liste
  locale de mots de passe courants, TOTP obligatoire pour tous, 10 codes de secours à usage unique.
- Mode OIDC : Authorization Code + PKCE, `state` et `nonce` vérifiés, groupes lus dans le jeton.
- Sessions : inactivité 30 min, durée absolue 8 h, régénération à la connexion et à l'élévation.
- Ré-authentification (mot de passe + TOTP, ou nouvelle connexion OIDC) exigée pour les
  identifiants, la suppression d'un profil et la gestion des utilisateurs.

## Rotation de la clé maître

Procédure dans `docs/deploiement.md` : serveur arrêté, `cli rotate-master-key` rechiffre toutes les
DEK (identifiants et TOTP) dans une transaction, incrémente la version, puis remplacement du secret.
L'ancienne clé ne déchiffre plus rien ; conserver une sauvegarde chiffrée de DATA_DIR antérieure à la
rotation avec l'ancienne clé, tant que la nouvelle n'a pas été validée.

## Signaler une vulnérabilité

Ne publiez pas de détails : contactez l'équipe d'exploitation responsable de votre instance.
