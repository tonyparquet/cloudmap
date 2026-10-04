# CLAUDE.md — CloudMap

Application web auto-hébergée qui **scanne un compte AWS**, **découvre tous les services utilisés**, **déduit les flux réseau** et génère un **diagramme d'architecture interactif** dans le style défini plus bas (thème sombre, conteneurs imbriqués Région > VPC > Zone > Sous-réseau, pastilles d'état, ports sur les liens).

Ce fichier est la spécification complète. **Construis l'application entière en une seule passe**, en suivant l'ordre de la section 17, jusqu'à ce que tous les critères de la section 18 soient remplis.

---

## 0. Règles non négociables

0. **Dossier de travail unique : la racine de ce dépôt.** Tout le projet est créé dans ce dossier et uniquement dans celui-ci. Ne lis, ne crée, ne modifie ni ne supprime aucun fichier en dehors (pas de fichiers dans le dossier personnel, pas de configuration globale, pas d'installation système). Les dépendances s'installent localement (`node_modules` du projet), les certificats de développement, données et fichiers temporaires vont dans des sous-dossiers du projet (`.dev/`, `.data/`, `.tmp/`, tous ignorés par git). Si une action semble nécessiter de sortir de ce dossier, arrête-toi et demande.
1. **Aucune donnée client dans le code.** Pas d'ID de compte, de région, de nom de ressource, de domaine ou d'URL en dur. Tout vient de l'interface, de la configuration (`CONFIG_DIR`) ou des données (`DATA_DIR`).
2. **Portabilité totale** : la même image Docker sert tous les clients et projets. Changer de client = créer un autre profil dans l'interface, jamais modifier le code.
3. **Lecture seule stricte côté AWS** : uniquement des appels `Describe*`, `List*`, `Get*` (hors valeurs de secrets), `sts:AssumeRole`, `sts:GetCallerIdentity`, `sts:GetSessionToken`, CloudWatch/Logs Insights en lecture. Jamais d'appel en écriture. Un test vérifie qu'aucun appel SDK hors liste blanche n'existe dans le code (section 16).
4. **Les identifiants AWS sont saisis dans l'interface web.** La section 4 (sécurité) est **bloquante** : l'application refuse de démarrer si les conditions de sécurité ne sont pas remplies.
5. **Jamais la valeur d'un secret** (Secrets Manager, SSM SecureString, variables d'environnement Lambda/ECS) : uniquement les noms et métadonnées.
6. TypeScript `strict` partout, aucun `any` non justifié, validation de toutes les entrées avec `zod`.
7. Tout le texte de l'interface est en **français** (fichier `apps/web/src/i18n/fr.ts`, prêt pour d'autres langues).

---

## 1. Stack technique

| Élément | Choix |
|---|---|
| Monorepo | pnpm workspaces, Node.js 22 LTS |
| Langage | TypeScript 5 strict |
| Backend | Fastify 5 (HTTPS natif), AWS SDK for JavaScript v3 |
| Expressions des règles | JSONata |
| Frontend | React 19 + Vite, React Flow (`@xyflow/react`), ELK.js pour la mise en page, Zustand pour l'état |
| Validation | zod (partagé front/back) |
| Stockage | Fichiers dans `DATA_DIR` + SQLite (`better-sqlite3`) pour utilisateurs, sessions, profils et journal d'audit |
| Chiffrement | `node:crypto` (AES-256-GCM, HKDF), Argon2id (`argon2`) pour les mots de passe |
| MFA | TOTP (`otplib`) |
| Tests | Vitest, Playwright (E2E sur le mode démo) |
| Qualité | ESLint (typescript-eslint strict), Prettier |
| Conteneur | Docker multi-stage, utilisateur non-root, système de fichiers en lecture seule |

---

## 2. Arborescence

```
.
├── CLAUDE.md
├── package.json / pnpm-workspace.yaml / tsconfig.base.json
├── packages/
│   ├── core/            # types, modèle de graphe, moteur de règles, inférence des flux, diff
│   ├── scanner/         # collecteurs AWS, gestion des quotas, snapshot brut
│   └── security/        # chiffrement, coffre d'identifiants, helpers de redaction
├── apps/
│   ├── server/          # API Fastify HTTPS, auth, sessions, orchestration des scans
│   ├── web/             # interface React
│   └── cli/             # scanner hors-ligne (produit un snapshot JSON importable)
├── config/              # valeurs par défaut, copiées dans CONFIG_DIR au premier démarrage
│   ├── app.yaml
│   ├── theme.yaml
│   ├── rules/*.yaml     # catalogue déclaratif, un fichier par service
│   └── icons/           # icônes AWS (voir 9.3) + icônes génériques de repli
├── fixtures/
│   └── demo-snapshot.json   # snapshot fictif reproduisant l'exemple de la section 9.5
├── docs/
│   ├── iam/trust-policy.json
│   ├── iam/readonly-policy.json
│   ├── deploiement.md
│   └── securite.md
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── traefik/dynamic.yml   # options TLS 1.3 + transport HTTPS vers l'app
└── scripts/
    ├── gen-dev-cert.sh       # certificat auto-signé pour le développement uniquement
    └── fetch-icons.ts        # récupère le pack officiel AWS Architecture Icons
```

---

## 3. Configuration (aucune valeur client)

### 3.1 Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8443` | Port HTTPS |
| `CONFIG_DIR` | `/config` | Règles, thème, `app.yaml` |
| `DATA_DIR` | `/data` | SQLite, snapshots, mises en page, journaux |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | — | **Obligatoires.** Chemins du certificat et de la clé |
| `TLS_CA_FILE` | — | Optionnel, chaîne intermédiaire |
| `MASTER_KEY_FILE` | — | **Obligatoire.** Fichier (Docker secret) contenant 32 octets aléatoires en base64 |
| `PUBLIC_ORIGIN` | — | **Obligatoire.** Ex. `https://cloudmap.exemple.fr` (utilisé pour CORS, CSRF, cookies) |
| `TRUSTED_PROXY_CIDRS` | vide | CIDR du reverse proxy autorisé à envoyer `X-Forwarded-*` |
| `AUTH_MODE` | `local` | `local` (comptes + TOTP) ou `oidc` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET_FILE`, `OIDC_ADMIN_GROUP` | — | Si `AUTH_MODE=oidc` |
| `HUB_CREDENTIALS` | `none` | `none` ou `default-chain` : identité AWS de l'outil lui-même (rôle d'instance/tâche) pour assumer les rôles clients sans saisir de clés |
| `LOG_LEVEL` | `info` | |
| `DEMO_MODE` | `false` | Ajoute le profil « Démo » chargé depuis `fixtures/` |

Il n'existe **pas** de variable permettant de désactiver TLS. L'accès sans compte (mode invité, section 4.4) et la création libre de comptes se règlent dans `app.yaml > access` (activés par défaut, désactivables pour réserver l'outil aux comptes créés par un administrateur).

### 3.2 `app.yaml`

Paramètres non sensibles : durée de session, durée de conservation des identifiants (voir 4.3), concurrence des collecteurs, seuils de regroupement, limites de rétention des snapshots, liste des services à scanner par défaut.

### 3.3 Profils (créés dans l'interface, stockés en SQLite)

```ts
Profile = {
  id: string; name: string; client?: string; description?: string;
  accountId: string;                 // vérifié via GetCallerIdentity
  regions: string[];                 // choisies dans l'interface, + "global" implicite
  auth:
    | { kind: "assume-role-hub"; roleArn: string; externalId: string }        // via HUB_CREDENTIALS
    | { kind: "access-keys"; credentialRef: string; roleArn?: string; externalId?: string }
    | { kind: "import-only" };       // snapshots importés uniquement
  tagFilters?: { key: string; values: string[] }[];
  externalNodes?: { id: string; label: string; sublabel?: string; icon: string; linksTo?: string[] }[];
  probes?: { url: string; attachTo?: string }[];   // sondes HTTP(S) GET, attachées à un nœud
  flowLogs?: { enabled: boolean; logGroups?: string[]; lookbackHours: number };
  allowedGroups: string[];           // groupes d'utilisateurs ayant accès au profil
}
```

---

## 4. Sécurité (bloquante)

### 4.1 Transport : TLS 1.3 uniquement, de bout en bout

- Le serveur Fastify démarre **uniquement en HTTPS** avec `minVersion: "TLSv1.3"` et `maxVersion: "TLSv1.3"`. Suites autorisées : `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`, `TLS_AES_128_GCM_SHA256`. Courbes : `X25519:P-256:P-384`.
- **Démarrage refusé** si `TLS_CERT_FILE`, `TLS_KEY_FILE`, `MASTER_KEY_FILE` ou `PUBLIC_ORIGIN` manque, si le certificat est expiré, ou si `PUBLIC_ORIGIN` n'est pas en `https://`. Message d'erreur explicite.
- Aucun écouteur HTTP en clair dans l'application. La redirection 80 → 443 est faite par le reverse proxy.
- Derrière Traefik : l'app reste en HTTPS (rechiffrement). `deploy/traefik/dynamic.yml` fournit :
  - `tls.options.modern` avec `minVersion: VersionTLS13`, `sniStrict: true` ;
  - un `serversTransport` HTTPS vers l'app (certificat de l'app vérifié via `rootCAs`) ;
  - le middleware de redirection HTTP → HTTPS.
- `X-Forwarded-*` n'est pris en compte que si l'adresse source est dans `TRUSTED_PROXY_CIDRS`.
- Rechargement à chaud du certificat (surveillance des fichiers) pour supporter le renouvellement Let's Encrypt.
- Healthcheck Docker en HTTPS sur `/healthz` (ne révèle aucune information).

### 4.2 En-têtes HTTP (sur toutes les réponses)

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Content-Security-Policy` stricte : `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests`
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`
- `Permissions-Policy` désactivant caméra, micro, géolocalisation, paiement, USB, etc.
- `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`
- `Cache-Control: no-store` sur toutes les routes `/api/*`
- Aucun en-tête `Server` / `X-Powered-By`.
- Aucune ressource externe (polices, scripts, CDN) : tout est servi par l'application.

### 4.3 Identifiants AWS saisis dans l'interface

**Types acceptés** (formulaire dédié, champs `type="password"`, `autocomplete="off"`, jamais dans l'URL) :
1. Clés d'accès temporaires (`AccessKeyId` + `SecretAccessKey` + `SessionToken`) — **option recommandée, présentée en premier**.
2. Clés d'accès d'un utilisateur IAM + ARN de rôle à assumer + External ID.
3. Clés d'accès d'un utilisateur IAM seules (avertissement visible : préférer un rôle).
4. ARN de rôle + External ID sans clé (si `HUB_CREDENTIALS=default-chain`).

**Contrôles à la saisie, côté serveur :**
- Validation du format (zod) puis `sts:GetCallerIdentity`.
- **Refus** si l'ARN appelant est le compte racine (`:root`).
- **Refus** si l'ID de compte ne correspond pas à `accountId` du profil.
- Clés longue durée : échange **immédiat** contre des identifiants temporaires (`AssumeRole` si un rôle est fourni, sinon `GetSessionToken`), durée paramétrable (défaut 1 h). Les clés longue durée ne sont conservées que si l'utilisateur coche explicitement « Mémoriser (chiffré) ».
- Avertissement (non bloquant) si `iam:SimulatePrincipalPolicy` est autorisé et montre des droits d'écriture : « Ces identifiants ne sont pas en lecture seule ».

**Stockage :**
- Par défaut : **en mémoire du serveur uniquement**, liés à la session de l'utilisateur, effacés à la déconnexion, à l'expiration de la session ou après `credentials.memoryTtlMinutes` (défaut 60).
- Si « Mémoriser » : chiffrement d'enveloppe dans SQLite. Une clé de données (DEK) aléatoire par entrée, chiffrée en AES-256-GCM par une clé dérivée (HKDF-SHA256) de la clé maître de `MASTER_KEY_FILE`. Données associées (AAD) = `profileId|credentialRef`. IV de 12 octets aléatoires, jamais réutilisé. Rotation de la clé maître supportée (`version` stockée avec chaque entrée, commande CLI `rotate-master-key`).
- Les identifiants sont **en écriture seule** pour le navigateur : après enregistrement, l'API ne renvoie que `AccessKeyId` masqué (`AKIA…7XQ2`), le type, la date d'ajout et la date d'expiration. Le secret ne retourne **jamais** au client.
- Suppression possible à tout moment ; suppression automatique quand le profil est supprimé.
- Les scans s'exécutent **côté serveur uniquement**. Le navigateur ne parle jamais directement à AWS.

**Redaction :** `packages/security` expose `redact()` appliqué au logger (pino `redact`), aux erreurs remontées au client et au journal d'audit. Motifs couverts : clés d'accès, secrets, tokens de session, en-têtes `Authorization`, cookies. Test unitaire obligatoire.

### 4.4 Authentification et sessions de l'application

- **Toute** route, sauf `/healthz`, `/login` et ses ressources statiques, exige une session : compte connecté ou session invitée.
- **Compte facultatif.** À l'ouverture, l'utilisateur crée un compte, se connecte ou continue **en invité**. Mode invité : espace de travail entièrement en mémoire du serveur (base SQLite `:memory:`, fichiers en mémoire), isolé des comptes et des autres invités, **jamais écrit sur disque ni journalisé**, détruit à la déconnexion ou à l'expiration de la session ; jamais d'accès à l'identité propre de l'outil (`HUB_CREDENTIALS`) ; nombre d'invités simultanés limité. Un invité qui crée un compte y retrouve son travail (profils, snapshots, mises en page, dossiers).
- `AUTH_MODE=local` : le premier compte créé devient administrateur ; les suivants (création libre, désactivable) sont éditeurs de leur groupe personnel. Mot de passe ≥ 14 caractères, vérifié contre une liste locale de mots de passe courants, haché en Argon2id (m=64 Mio, t=3, p=1). **TOTP facultatif**, activable ou désactivable par chaque compte depuis « Mon compte » (après ré-authentification), codes de secours (10, hachés) ; une fois activé, il est exigé à chaque connexion et à chaque ré-authentification.
- `AUTH_MODE=oidc` : Authorization Code + PKCE, vérification `state`/`nonce`, groupes lus dans le jeton pour les droits.
- Cookie de session : nom `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, identifiant opaque de 256 bits stocké haché en base. Expiration d'inactivité 30 min, absolue 8 h. Régénération à la connexion et à l'élévation.
- **CSRF** : jeton synchronisé dans un en-tête `X-CSRF-Token` sur toute requête non-GET + vérification de `Origin` = `PUBLIC_ORIGIN`.
- **Ré-authentification** (mot de passe, + TOTP s'il est activé, ou nouvelle connexion OIDC) exigée avant : saisie ou affichage de métadonnées d'identifiants, suppression d'un profil, gestion des utilisateurs.
- Limitation de débit : connexion (5 essais / 15 min par compte et par IP, puis verrouillage progressif), API globale, endpoints de scan (1 scan simultané par profil).
- Rôles : `admin` (utilisateurs, tous les profils), `editor` (créer/scanner les profils de ses groupes), `viewer` (lecture des diagrammes de ses groupes). Cloisonnement strict par `allowedGroups`.

### 4.5 Journal d'audit

Table append-only : horodatage, utilisateur, IP, action (connexion, échec, ajout/suppression d'identifiants, scan lancé/terminé, export, import, modification de profil), profil concerné, résultat. **Jamais** de valeur d'identifiant. Page de consultation réservée aux admins, export CSV.

### 4.6 Durcissement

- Conteneur non-root (UID 10001), `read_only: true`, `tmpfs` pour `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`.
- Les imports de snapshots sont validés par schéma zod, taille max configurable, rejet de tout champ inconnu dangereux.
- Requêtes sortantes des sondes HTTP : HTTPS uniquement par défaut, blocage des IP privées/link-local/metadata (`169.254.169.254`) sauf option explicite du profil, timeout court, pas de suivi de redirection vers une IP bloquée (protection SSRF).
- `pnpm audit` dans le script `check` ; dépendances épinglées (lockfile).
- `docs/securite.md` décrit le modèle de menace, les choix ci-dessus et la procédure de rotation de la clé maître.

---

## 5. Scanner (`packages/scanner`)

### 5.1 Fonctionnement

- Pour chaque région du profil + `us-east-1` pour les services globaux (CloudFront, IAM, Route 53, WAF global).
- Inventaire initial via **Resource Explorer** (si un index existe) ou **AWS Config** (si activé), pour détecter tous les types présents. Tout type sans collecteur dédié devient un **nœud générique** (icône de catégorie, libellé = nom/ID), pour ne rien manquer.
- Puis collecteurs dédiés, exécutés en parallèle avec `p-limit` (concurrence configurable), SDK en mode de retry `adaptive`, pagination complète.
- Erreur `AccessDenied` / `UnauthorizedOperation` → la ressource ou le service est marqué `status: "inconnu"` avec un avertissement, le scan continue.
- Progression envoyée en temps réel au navigateur via **Server-Sent Events** (service, région, nombre trouvé, erreurs).

### 5.2 Collecteurs dédiés (minimum)

| Domaine | Appels principaux |
|---|---|
| Réseau | `DescribeVpcs`, `DescribeSubnets`, `DescribeRouteTables`, `DescribeInternetGateways`, `DescribeNatGateways`, `DescribeVpcEndpoints`, `DescribeSecurityGroups`, `DescribeNetworkAcls`, `DescribeNetworkInterfaces`, `DescribeVpcPeeringConnections`, `DescribeTransitGatewayAttachments` |
| Calcul | EC2 `DescribeInstances`, Auto Scaling, ECS (`ListClusters`, `ListServices`, `DescribeServices`, `DescribeTaskDefinition`, `ListTasks`), Lambda (`ListFunctions`, `GetFunctionConfiguration` sans variables d'env, `ListEventSourceMappings`), EKS (clusters, nodegroups) |
| Équilibrage / entrée | ELBv2 (load balancers, listeners, target groups, target health), API Gateway REST et HTTP (APIs, stages, intégrations, VPC Links), CloudFront (distributions, origines), Route 53 (zones, enregistrements alias), WAF |
| Données | RDS (instances, clusters, subnet groups), DynamoDB, ElastiCache, S3 (buckets, région, website, politique d'accès public bloqué), EFS, SQS, SNS, EventBridge (règles, cibles), Kinesis |
| Découverte | Cloud Map (namespaces, services) |
| CI/CD | CodeBuild (projets, source, dernier build), CodePipeline, ECR (dépôts), CodeConnections |
| Sécurité | Secrets Manager et SSM Parameter Store (métadonnées uniquement), KMS (alias), ACM |
| Observabilité | CloudWatch (métriques clés pour les statuts), CloudWatch Logs Insights (Flow Logs, optionnel) |

### 5.3 Snapshot brut

```ts
RawSnapshot = {
  schemaVersion: 1;
  meta: { profileId: string; accountId: string; regions: string[]; startedAt: string; finishedAt: string; scannerVersion: string };
  resources: { arn?: string; id: string; type: string; region: string; raw: unknown; tags?: Record<string,string> }[];
  metrics?: { resourceId: string; name: string; value: number; period: string }[];
  flowObservations?: { srcIp: string; dstIp: string; dstPort: number; protocol: string; bytes: number; packets: number }[];
  probes?: { url: string; status?: number; latencyMs?: number; error?: string }[];
  errors: { service: string; region: string; code: string; message: string }[];
}
```

Le même module sert le serveur et la CLI (`apps/cli`). La CLI utilise la chaîne d'identifiants standard du poste et écrit `snapshot-<compte>-<date>.json`, importable dans l'interface (profil `import-only` ou profil existant).

---

## 6. Catalogue de règles déclaratif (`CONFIG_DIR/rules/*.yaml`)

Ajouter un service = ajouter un fichier YAML (+ un collecteur s'il n'est pas couvert par l'inventaire générique). Le moteur de règles ne connaît aucun service en dur. Les expressions sont en **JSONata**, évaluées sur la ressource (`$r`) et l'ensemble du snapshot (`$all`).

```yaml
type: AWS::ECS::Service
label: "Tâche ECS"                       # ou expression : "$r.raw.serviceName"
sublabel: "$string($r.raw.runningCount) & '/' & $string($r.raw.desiredCount) & ' tâche'"
icon: ecs
category: compute                          # détermine la couleur de la tuile
placement:
  container: subnet                        # global | region | vpc | az | subnet
  ref: "$r.raw.networkConfiguration.awsvpcConfiguration.subnets[0]"
  multi: replicate                         # replicate | first : si plusieurs sous-réseaux
securityGroups: "$r.raw.networkConfiguration.awsvpcConfiguration.securityGroups"
status:
  - when: "$r.raw.runningCount > 0"
    value: actif
  - when: "$r.raw.desiredCount = 0"
    value: en-veille
  - default: inconnu
relations:
  - kind: data
    to: "$r.raw._taskDefinition.containerDefinitions.image"     # résolu vers ECR
    resolve: ecr-image
    label: images
  - kind: data
    to: "$r.raw._taskDefinition.containerDefinitions.secrets.valueFrom"
    resolve: arn
group:
  key: "$r.raw.clusterArn"                 # regroupement si trop nombreux
```

- `kind` de relation : `network`, `cicd`, `data`, `dependency`.
- Résolveurs disponibles : `arn`, `id`, `ecr-image`, `dns-name`, `s3-bucket`, `security-group`, `target-group-targets`.
- Les règles sont validées par zod au démarrage ; une règle invalide est ignorée avec un avertissement visible dans la page « Configuration ».
- Fournir des règles pour **tous** les services de 5.2, plus des règles « nœud externe » (`External::Git`, `External::Browser`, `External::Internet`).

Relations à couvrir au minimum :
- CloudFront → origines (S3, API Gateway, ALB, domaine custom).
- Route 53 alias → CloudFront / ALB / API Gateway.
- API Gateway → intégrations ; VPC Link → NLB / ALB / Cloud Map → ECS.
- ALB/NLB → target groups → instances / IP (tâches ECS) / Lambda.
- ECS / Lambda / EC2 → ECR (images), Secrets, KMS.
- CodeBuild → source (CodeConnections / GitLab / GitHub) → ECR (via variables ou buildspec si lisible sans secret).
- EventBridge / SQS / SNS → cibles ; Lambda event source mappings.
- Endpoint VPC → service cible (S3, DynamoDB, ECR…).

---

## 7. Inférence des flux réseau (`packages/core/flows`)

### 7.1 Classification des sous-réseaux

Table de routage associée (explicite, sinon table principale du VPC) :
- route `0.0.0.0/0` (ou `::/0`) vers `igw-*` → **public** ;
- vers `nat-*` → **privé avec NAT** ;
- sinon → **privé isolé** (le sous-libellé de l'IGW indique « sans NAT » si aucun NAT dans le VPC).

### 7.2 Flux autorisés (depuis la configuration)

Pour chaque ressource portant des groupes de sécurité (via ses ENI) :
- règle entrante référençant un groupe X → arête **de chaque ressource membre de X vers la ressource**, étiquette `TCP 5432` (protocole + port ou plage) ;
- règle entrante sur CIDR → arête depuis la ressource propriétaire de cette plage si elle est connue (sous-réseau, VPC appairé), sinon depuis le nœud externe « Internet » si `0.0.0.0/0` et la ressource est dans un sous-réseau public ;
- vérification des sorties (egress) du côté source et des NACL : si un flux est bloqué par l'une d'elles, l'arête est marquée `bloqué` (rouge, pointillés) au lieu d'être supprimée ;
- sorties vers Internet via IGW / NAT / endpoints : arête `TCP 443` vers IGW ou endpoint quand la ressource doit atteindre ECR, Secrets, S3, etc.
- Fusionner les arêtes identiques (même source, cible, protocole) en une seule, plusieurs ports regroupés dans l'étiquette.

### 7.3 Flux observés (optionnels)

Si `flowLogs.enabled` : requête Logs Insights agrégée sur `lookbackHours` (src, dst, port, octets) → correspondance des IP avec les ENI connues → l'arête correspondante passe en `observée` (trait plein + épaisseur selon le volume). Flux observés sans règle déduite → arête `non expliquée` (orange). Flux autorisés jamais observés → `inutilisé` (opacité réduite), filtrables.

---

## 8. Modèle de graphe normalisé (`packages/core/graph`)

```ts
Graph = {
  containers: { id: string; kind: "global"|"region"|"vpc"|"az"|"subnet-public"|"subnet-private"; label: string; sublabel?: string; parentId?: string }[];
  nodes: { id: string; resourceRef?: string; type: string; label: string; sublabel?: string; icon: string; category: string;
           status: "actif"|"en-veille"|"arrete"|"erreur"|"inconnu"; containerId?: string; groupCount?: number; details: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; kind: "network"|"cicd"|"data"|"dependency";
           label?: string; state: "autorise"|"observe"|"bloque"|"non-explique"|"inutilise"; evidence: string[] }[];
  warnings: string[];
}
```

- `buildGraph(snapshot, rules, profile)` est une **fonction pure** (aucun appel réseau), testée sur `fixtures/demo-snapshot.json`.
- **Regroupement** : au-delà de `app.yaml > grouping.threshold` (défaut 5) ressources du même type, même conteneur et même clé `group`, création d'un nœud groupé dépliable (« 12 × Lambda »).
- `diff(graphA, graphB)` : nœuds/arêtes ajoutés, supprimés, modifiés (statut, ports).

---

## 9. Diagramme et style

### 9.1 Mise en page

- ELK.js, algorithme `layered`, direction `DOWN`, conteneurs hiérarchiques (`hierarchyHandling: INCLUDE_CHILDREN`), routage orthogonal des arêtes.
- Placement logique : nœuds externes (Git, Navigateur) en haut à gauche, services globaux (CloudFront, Route 53) en haut, cadre Région en dessous ; services régionaux hors VPC (API Gateway, S3, Cloud Map, ECR, CodeBuild, Secrets) dans le cadre Région autour du VPC ; zones de disponibilité côte à côte ; sous-réseaux privés en haut de chaque zone, publics en bas ; IGW et endpoints en bordure basse du VPC.
- L'utilisateur peut déplacer nœuds et conteneurs : positions sauvegardées dans `DATA_DIR/layouts/<profileId>.json` et réappliquées aux scans suivants (les nouveaux nœuds sont placés automatiquement).
- Bouton « Réorganiser automatiquement ».

### 9.2 Jetons de thème (`theme.yaml`, valeurs par défaut)

| Jeton | Valeur | Usage |
|---|---|---|
| `bg` | `#16131f` | Fond du canevas |
| `container.region` | `#2dd4bf`, pointillés 6/4, rayon 12 | Cadre Région + icône drapeau en haut à droite |
| `container.vpc` | `#8b5cf6`, trait plein 1.5, rayon 10 | Cadre VPC + icône en haut à gauche + CIDR |
| `container.az` | `#6b7280`, pointillés 5/4 | Zone de disponibilité |
| `container.subnetPrivate` | `#14b8a6`, trait plein | Sous-réseau privé, cadenas + CIDR |
| `container.subnetPublic` | `#84cc16`, trait plein | Sous-réseau public, cadenas + CIDR (libellé en bas) |
| `node.tile` | 44 px, rayon 8, bordure 2 px claire | Tuile d'icône |
| `category.network` | `#8c4fff` | API Gateway, CloudFront, VPC Link, IGW… |
| `category.compute` | `#ed7100` | ECS, EC2, Lambda, ECR |
| `category.database` | `#c925d1` | RDS, DynamoDB |
| `category.storage` | `#7aa116` | S3 |
| `category.devtools` | `#c925d1` / `#3f8624` | CodeBuild |
| `category.security` | `#dd344c` | Secrets Manager, KMS |
| `category.external` | `#2a2540` | Nœuds externes |
| `node.label` | `#ffffff`, 13 px, gras | Libellé |
| `node.sublabel` | `#a1a1aa`, 11 px | Sous-libellé (état, chemin) |
| `status.actif` | `#22c55e` | Pastille 8 px en haut à droite + bordure verte de la tuile |
| `status.autre` | `#a1a1aa` | Pastille grise (en veille, arrêtée, inconnue) |
| `status.erreur` | `#ef4444` | |
| `edge.network` | `#a78bfa`, 1.5 px, flèche | Flux réseau |
| `edge.cicd` | `#e879f9`, pointillés 4/4 **animés** | Chaîne CI/CD |
| `edge.data` | `#94a3b8`, 1.2 px | Dépendances de données |
| `edge.blocked` | `#ef4444`, pointillés | |
| `edge.unexplained` | `#f59e0b` | |
| `edge.label` | `#ffffff`, 11 px gras, fond `bg` | Ports (`TCP 5432`) |
| `font` | Inter (embarquée, servie localement) | |

Un thème clair et un thème « couleurs client » sont sélectionnables ; ils ne font que surcharger ces jetons.

### 9.3 Icônes

- `scripts/fetch-icons.ts` télécharge le pack officiel **AWS Architecture Icons** et copie les SVG utiles dans `config/icons/aws/` selon `config/icons/map.yaml` (type → fichier). Si le téléchargement est impossible, les icônes génériques de repli (`config/icons/generic/`, une par catégorie, dessinées pour le projet) sont utilisées : l'application doit fonctionner sans le pack officiel.
- Icônes externes génériques : dépôt Git, navigateur, Internet.

### 9.4 Interactions

- Zoom, déplacement, mini-carte, ajustement à l'écran.
- Survol d'une arête : protocole, ports, état, preuves (`sg-… règle entrante`, `flow logs : 1,2 Go`).
- Clic sur un nœud : panneau latéral (type, ID, ARN, région, tags, statut et sa source, groupes de sécurité, règles entrantes/sortantes, ressources liées, lien vers la console AWS construit dynamiquement).
- Filtres : type de flux, état de flux, catégorie, statut, tag, masquer les nœuds en veille, masquer les flux inutilisés.
- Recherche par nom / ID / IP.
- Mise en évidence du chemin : sélectionner un nœud met en avant ses flux entrants et sortants.

### 9.5 Exemple de référence (mode démo)

`fixtures/demo-snapshot.json` (données fictives, compte `000000000000`) doit produire ce diagramme :

- Externes : GitLab (« dépôt »), Navigateur (« ce poste »).
- Global : CloudFront (« HTTP 200 », actif).
- Région `eu-west-3` : S3 front (actif), API Gateway (« /api 500 »), Cloud Map (en veille), CodeBuild (réussi), ECR (images), Secrets (inconnus), Endpoint S3 (passerelle).
- VPC `10.20.0.0/16`, zones `eu-west-3a` et `eu-west-3b` :
  - privé `10.20.10.0/24` : RDS (arrêtée), Lien VPC (en veille) ;
  - privé `10.20.11.0/24` : Lien VPC (en veille) ;
  - public `10.20.0.0/24` : Migration (inconnue), Tâche ECS (0/0 tâche) ;
  - public `10.20.1.0/24` : vide ;
  - IGW (« sans NAT »).
- Flux : Navigateur → CloudFront → S3 et API Gateway ; API Gateway → Cloud Map et Liens VPC ; Lien VPC ↔ Lien VPC ; Lien VPC → Tâche ECS `TCP 8080` ; Tâche ECS → RDS `TCP 5432` ; Migration → RDS ; Tâche ECS → IGW `TCP 443` ; Secrets → IGW ; GitLab → CodeBuild → ECR (CI/CD animé) ; Migration ↔ IGW.

---

## 10. Pages de l'interface

1. **Connexion** : se connecter (+ TOTP s'il est activé), créer un compte (le premier est administrateur) ou continuer en invité. **Mon compte** : activation / désactivation du MFA, codes de secours. **Dossiers** : arborescence personnelle (dossiers / sous-dossiers) pour ranger les profils et leurs diagrammes, glisser-déposer et menu « Ranger dans… ».
2. **Profils** : liste filtrée par droits, création/édition (nom, client, compte, régions, mode d'accès, nœuds externes, sondes, Flow Logs, groupes autorisés).
3. **Identifiants du profil** (après ré-authentification) : formulaire de saisie (4.3), état (en mémoire / mémorisé chiffré, expiration), bouton « Tester » (GetCallerIdentity), bouton « Supprimer ».
4. **Scan** : choix des régions et services, lancement, progression SSE, erreurs d'accès listées clairement avec la permission manquante.
5. **Diagramme** : vue principale (section 9), sélecteur de snapshot, bouton « Comparer avec… » (diff coloré : vert ajouté, rouge supprimé, orange modifié).
6. **Inventaire** : tableau triable/filtrable de toutes les ressources trouvées, export CSV.
7. **Import** : dépôt d'un snapshot produit par la CLI.
8. **Configuration** (admin) : état des règles chargées et de leurs erreurs, thème, `app.yaml` en lecture.
9. **Utilisateurs et groupes** (admin, mode local).
10. **Journal d'audit** (admin).
11. **Aide** : comment créer le rôle IAM client (contenu de `docs/iam/` affiché avec bouton copier, External ID généré aléatoirement par profil).

Exports depuis le diagramme : SVG, PNG (2×), PDF, **draw.io** (`.drawio` XML avec conteneurs et styles), JSON du graphe.

---

## 11. API (préfixe `/api`, JSON, toutes authentifiées sauf mention)

| Méthode | Route | Description |
|---|---|---|
| POST | `/auth/login`, `/auth/totp`, `/auth/logout`, `/auth/reauth` | Authentification |
| GET | `/auth/oidc/start`, `/auth/oidc/callback` | OIDC |
| GET/POST/PUT/DELETE | `/profiles[/:id]` | Profils |
| PUT/DELETE | `/profiles/:id/credentials` | Saisie / suppression (ré-auth requise). Réponse sans secret |
| GET | `/profiles/:id/credentials/status` | Métadonnées masquées |
| POST | `/profiles/:id/credentials/test` | GetCallerIdentity |
| POST | `/profiles/:id/scans` | Lance un scan, renvoie `scanId` |
| GET | `/scans/:id/events` | SSE de progression |
| GET | `/profiles/:id/snapshots` | Liste |
| GET | `/snapshots/:id/graph` | Graphe calculé |
| GET | `/snapshots/:a/diff/:b` | Diff |
| POST | `/profiles/:id/import` | Import d'un snapshot CLI |
| GET/PUT | `/profiles/:id/layout` | Positions manuelles |
| GET | `/config/rules`, `/config/theme` | Lecture |
| GET/POST/PUT/DELETE | `/admin/users`, `/admin/groups` | Admin |
| GET | `/admin/audit` | Journal |
| GET | `/healthz` (public) | `200 ok` uniquement |

Toutes les réponses d'erreur ont la forme `{ error: { code, message } }` en français, sans trace ni donnée sensible.

---

## 12. Stockage (`DATA_DIR`)

```
DATA_DIR/
├── app.db                       # SQLite : users, groups, sessions, profiles, credentials (chiffrés), audit
├── snapshots/<profileId>/<iso-date>.json.gz
├── layouts/<profileId>.json
└── logs/
```

Rétention des snapshots configurable (nombre ou durée). Migrations SQLite versionnées dans `apps/server/src/db/migrations/`.

---

## 13. Politique IAM client (`docs/iam/`)

- `trust-policy.json` : confiance envers le compte (ou le rôle) de l'outil, condition `sts:ExternalId` obligatoire.
- `readonly-policy.json` : liste blanche des actions de la section 5.2, plus mention que `ReadOnlyAccess` (géré par AWS) fonctionne aussi. Exclure explicitement `secretsmanager:GetSecretValue`, `ssm:GetParameter*` avec déchiffrement, `s3:GetObject`.
- Commande AWS CLI d'exemple pour créer le rôle, placeholders `<ACCOUNT_ID_OUTIL>` et `<EXTERNAL_ID>` uniquement.

---

## 14. Déploiement

- `deploy/Dockerfile` : build multi-stage, image finale `node:22-alpine` minimale, non-root, `HEALTHCHECK` HTTPS, ports exposés : `8443` uniquement.
- `deploy/docker-compose.yml` : service `cloudmap`, volumes `config` et `data`, Docker secrets `master_key`, `tls_cert`, `tls_key`, `read_only`, `cap_drop`, `security_opt: no-new-privileges`, labels Traefik (router HTTPS, `tls.options=modern@file`, `serversTransport` HTTPS).
- `scripts/gen-dev-cert.sh` : certificat auto-signé **pour le développement uniquement** (`pnpm dev` l'utilise automatiquement s'il n'y en a pas).
- `docs/deploiement.md` : déploiement autonome (certificat fourni), derrière Traefik, génération de la clé maître (`openssl rand -base64 32`), sauvegarde de `DATA_DIR` et de la clé maître (séparément), mise à jour.

---

## 15. Scripts

| Script | Rôle |
|---|---|
| `pnpm dev` | Serveur + front en HTTPS local (certificat de dev), `DEMO_MODE=true` |
| `pnpm build` | Build de tous les paquets |
| `pnpm test` | Vitest |
| `pnpm e2e` | Playwright sur le mode démo |
| `pnpm lint` / `pnpm typecheck` | |
| `pnpm check` | lint + typecheck + test + `pnpm audit --prod` |
| `pnpm cli scan --profile <aws-profile> --regions eu-west-3` | Scanner hors-ligne |
| `pnpm cli rotate-master-key` | Rotation de la clé maître |

---

## 16. Tests obligatoires

- **core** : classification des sous-réseaux, inférence des flux SG (référence de groupe, CIDR, egress bloqué, NACL), fusion d'arêtes, regroupement, diff, `buildGraph` sur la fixture démo (snapshot de test du graphe et vérification des nœuds/arêtes de 9.5).
- **règles** : chargement, validation, règle invalide ignorée sans crash, chaque règle fournie évaluée sur la fixture sans erreur.
- **scanner** : collecteurs testés avec `aws-sdk-client-mock` (pagination, `AccessDenied` → `inconnu`, throttling).
- **liste blanche SDK** : test statique qui parcourt le code des collecteurs et échoue si une commande SDK ne commence pas par `Describe`, `List`, `Get` (sauf exclusions listées et interdites : `GetSecretValue`, `GetParameter` avec déchiffrement, `GetObject`) ou n'est pas dans la liste STS/Logs autorisée.
- **sécurité** :
  - le serveur refuse de démarrer sans TLS, sans clé maître ou avec `PUBLIC_ORIGIN` en http ;
  - une connexion TLS 1.2 est refusée, TLS 1.3 acceptée ;
  - en-têtes de 4.2 présents ;
  - chiffrement/déchiffrement d'enveloppe, échec si AAD ou clé différente ;
  - `redact()` masque clés, secrets, tokens ;
  - aucune route ne renvoie un `SecretAccessKey` ou un `SessionToken` (test sur toutes les réponses de l'API d'identifiants) ;
  - CSRF : requête sans jeton ou avec `Origin` différent rejetée ;
  - cookie de session avec attributs de 4.4 ;
  - limitation des tentatives de connexion ;
  - cloisonnement : un `viewer` d'un groupe ne voit pas le profil d'un autre groupe ;
  - protection SSRF des sondes.
- **mode invité** : aucune écriture dans `DATA_DIR`, isolement des comptes, pas d'identité de l'outil, reprise du travail à la création d'un compte ; MFA facultatif ; réglages `access` ; dossiers (cycles refusés, cloisonnement par utilisateur).
- **E2E** : création du compte admin puis activation du MFA, ouverture du profil Démo, affichage du diagramme, clic sur un nœud, filtre, export SVG.

---

## 17. Ordre de construction (une seule passe)

1. Squelette du monorepo, tsconfig, lint, scripts, Vitest.
2. `packages/security` : chiffrement d'enveloppe, redaction, + tests.
3. `packages/core` : types zod, moteur de règles JSONata, classification des sous-réseaux, inférence des flux, `buildGraph`, regroupement, diff, + tests.
4. `fixtures/demo-snapshot.json` conforme à 9.5 et toutes les règles YAML de la section 6.
5. `packages/scanner` : orchestrateur, collecteurs de 5.2, inventaire générique, + tests avec mocks et test de liste blanche.
6. `apps/server` : HTTPS TLS 1.3, contrôles de démarrage, en-têtes, SQLite + migrations, auth locale + TOTP + OIDC, sessions, CSRF, rôles, profils, identifiants (4.3), scans + SSE, snapshots, import, layouts, audit, + tests de sécurité.
7. `apps/web` : thème depuis `theme.yaml`, pages de la section 10, diagramme React Flow + ELK, nœuds et conteneurs personnalisés au style de 9.2, interactions de 9.4, exports.
8. `apps/cli` : scan hors-ligne, rotation de la clé maître.
9. Icônes : `scripts/fetch-icons.ts`, `map.yaml`, icônes génériques de repli.
10. `deploy/` (Dockerfile, compose, Traefik), `docs/` (IAM, déploiement, sécurité), `README.md` court renvoyant vers `docs/`.
11. Tests E2E, puis `pnpm check` vert.
12. Vérification finale de la section 18, point par point.

Ne t'arrête pas sur des questions : si un détail n'est pas spécifié, prends le choix le plus sûr et le plus simple, et note-le dans `docs/decisions.md`.

---

## 18. Critères d'acceptation

- [ ] `pnpm check` passe sans erreur ni avertissement.
- [ ] `docker compose up` démarre l'application en HTTPS TLS 1.3 ; sans certificat ou sans clé maître, elle refuse de démarrer avec un message clair.
- [ ] `openssl s_client -tls1_2` est refusé, `-tls1_3` accepté.
- [ ] Toutes les routes sauf `/healthz` et la connexion exigent une session (compte ou invité) ; une session invitée ne laisse aucune trace sur disque ; le MFA est activable par chaque compte et exigé dès qu'il est activé.
- [ ] Des identifiants saisis dans l'interface ne sont jamais renvoyés au navigateur, jamais écrits en clair sur disque, jamais présents dans les journaux.
- [ ] Le profil Démo affiche le diagramme de la section 9.5 dans le style de 9.2 (conteneurs, pastilles, ports, CI/CD animé).
- [ ] Un scan réel d'un compte en lecture seule produit un diagramme ; les services sans collecteur dédié apparaissent en nœuds génériques ; les permissions manquantes sont signalées sans faire échouer le scan.
- [ ] Ajouter un nouveau fichier de règle dans `CONFIG_DIR/rules/` change le rendu sans rebuild.
- [ ] Aucune valeur propre à un client (ID de compte, région, nom, domaine) n'existe dans le code source (hors fixture démo fictive).
- [ ] Les positions déplacées manuellement sont conservées après un nouveau scan.
- [ ] Comparaison de deux snapshots fonctionnelle.
- [ ] Exports SVG, PNG, PDF, draw.io fonctionnels.
- [ ] La CLI produit un snapshot importable.