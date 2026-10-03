# Décisions d'implémentation

Choix faits là où la spécification (CLAUDE.md) ne tranchait pas. Principe : le plus sûr, puis le plus simple.

## Outillage

- **pnpm 12** (installé via mise sur le poste, appelé sans configuration globale) ; tous les caches
  (store pnpm, npm, Playwright, fichiers temporaires) sont confinés dans `.pnpm-store/` et `.tmp/`.
- **Node 22** dans l'image Docker (`node:22-alpine`) ; le code tourne aussi sur Node 24 (poste de dev).
- Les paquets `packages/*` sont consommés **en source TypeScript** (`exports` → `src/index.ts`) ;
  serveur et CLI sont **bundlés par esbuild** (`scripts/bundle.mjs`), seuls `better-sqlite3` et
  `argon2` (natifs) restent externes. Pas d'étape de compilation par paquet.
- `typescript-eslint` en configuration `strict` (non typée) : les règles typées doubleraient le temps
  de `pnpm check` sans gain significatif ici.

## Moteur de règles (section 6)

- **Expression ou littéral** : une chaîne est une expression JSONata si elle contient `$r` / `$all` ou
  commence par `$` ou `(`. Sinon c'est un libellé littéral (`label: "Tâche ECS"`).
- Liaisons JSONata ajoutées : `$ofType(type)` et `$byId(id)` (index précalculés, évitent des
  parcours O(n²) de `$all.resources`).
- **Champs ajoutés au schéma de règle** (tous optionnels) :
  `typeLabel` (nom lisible du type), `hidden` (ressource utilisée pour les flux/conteneurs mais non
  dessinée), `placement.container: none` (nœuds externes), `placement.vpcRef` (repli vers le VPC quand
  aucun sous-réseau ne correspond, ex. endpoint passerelle), `ips` (index IP → nœud pour les cibles
  IP et les Flow Logs), `dnsNames` (index DNS pour le résolveur `dns-name`), `awsService` (nom de
  service des endpoints VPC, pour l'inférence des sorties), `console` (URL console personnalisée),
  `details` (champs affichés dans le panneau), et sur les relations : `reverse`, `unresolved:
external`, `externalType`.
- **Types à joker** (`AWS::DMS::*`, `ec2:*`, `*`) : catégorie/icône des ressources sans règle dédiée.
  Le type exact l'emporte, puis le joker le plus long.
- Un fichier peut contenir une règle, une liste, plusieurs documents YAML ou `{ rules: [...] }`.
  Limite de 500 alias YAML par document (protection « billion laughs »).
- Le résolveur `id` accepte aussi un ARN (les `linksTo` des nœuds externes peuvent mélanger les deux).
- Libellé par défaut des règles fournies : tag `Name` s'il existe, sinon le nom AWS de la ressource.
  La fixture démo pose des tags `Name` pour reproduire les libellés de la section 9.5.

## Graphe et flux (sections 7 et 8)

- **Placement par défaut** : cadre Région (ou Global si la région est `global`).
- **Conteneurs conservés** : un VPC n'est dessiné que s'il contient au moins un nœud ; un VPC dessiné
  garde tous ses sous-réseaux, même vides (cf. `10.20.1.0/24` vide dans la démo).
- **Entrée Internet** (`0.0.0.0/0` sur une ressource d'un sous-réseau public) : l'arête part de l'IGW
  du VPC s'il est dessiné (point d'entrée réel), sinon du nœud externe « Internet ». C'est ce qui
  produit « Migration ↔ IGW » dans la démo.
- **Sorties vers les services AWS** : quand une ressource d'un sous-réseau a une relation directe
  (`data`/`network`) vers un service portant `awsService`, deux arêtes `TCP 443` sont créées :
  ressource → passerelle (endpoint VPC correspondant, sinon IGW si public, sinon NAT) et passerelle →
  service. La démo affiche donc « IGW → Secrets » (sens du trafic) pour le « Secrets → IGW » de 9.5.
  Sous-réseau isolé sans endpoint : arête `bloqué` + avertissement.
- **Endpoints VPC passerelle** : placés dans le cadre VPC (règle 9.1 « en bordure basse du VPC »)
  plutôt que dans le cadre Région de la liste 9.5.
- **NACL** : évaluées dans le sens aller uniquement (le trafic de retour éphémère n'est pas vérifié) ;
  une entrée s'applique si sa plage chevauche celle du pair.
- Plage CIDR source inconnue (ni sous-réseau, ni VPC, ni VPC appairé scanné) : nœud externe portant
  la plage. Les plages IPv6 spécifiques et les listes de préfixes sont ignorées.
- **Identifiants d'arêtes stables** : `type:source->cible:protocole` (+ `:bloque`), ce qui permet au
  diff de signaler un changement de ports comme une modification.
- Le graphe porte un champ optionnel `bytes` sur les arêtes observées (épaisseur du trait).
- **Regroupement** : clé `type + conteneur + group.key` ; identifiant de groupe déterministe ;
  « déplier » = recalcul côté serveur avec `?expand=<id>`.
- **Sondes** : sous-libellé `HTTP <code>` (ou `<chemin> <code>` si l'URL a un chemin) ; 5xx ou erreur
  → statut `erreur`, 2xx/3xx → `actif`, 4xx → statut de la règle conservé.
- **Nœuds externes du profil** : type `External::<Icône>` (git → `External::Git`…) ; un domaine
  externe détecté (ex. source CodeBuild `gitlab.com`) réutilise le nœud du profil dont l'id ou le
  libellé correspond (`gitlab`).

## Démo (section 9.5)

- Le profil Démo est décrit dans `fixtures/demo-profile.json` (nœuds externes GitLab / Navigateur et
  sondes), à côté de `fixtures/demo-snapshot.json`.
- « Migration » est un service ECS dont l'état est inconnu (`ecs:ListTasks` refusé) ; « Secrets » est
  un secret connu par l'inventaire AWS Config dont les métadonnées sont refusées. Les deux illustrent
  la règle « AccessDenied → statut inconnu ».
- Les relations de la règle d'exemple ECS (images ECR, secrets, découverte Cloud Map) ajoutent
  quelques arêtes `data`/`dependency` au-delà de la liste 9.5, qui reste intégralement couverte.

## Scanner (section 5)

- Commandes en lecture autorisées en plus de `Describe*` / `List*` / `Get*` : `BatchGet*` (CodeBuild,
  AWS Config), `Search`, `SelectResourceConfig`, `SimulatePrincipalPolicy`, `StartQuery` /
  `GetQueryResults` (Logs Insights). Toujours interdites : `GetSecretValue`, `GetParameter*`,
  `GetObject*` (test statique de liste blanche).
- Assainissement à la collecte : variables d'environnement Lambda/ECS réduites à leurs noms,
  buildspec CodeBuild retiré, variables CodeBuild en clair conservées seulement si elles désignent un
  dépôt d'images, abonnements SNS limités aux ARN / origines HTTP (pas d'e-mail ni de téléphone),
  politique SQS et `Input` des cibles EventBridge retirés.
- Compartiments S3 : listés pour tout le compte, seuls ceux des régions du profil sont conservés.
- Throttling : mode `adaptive` du SDK, puis jusqu'à 2 relances de la tâche (collecteur × région).
- Inventaire générique : les types Resource Explorer correspondant à un collecteur dédié sont
  convertis au format CloudFormation pour que les règles s'appliquent.

## Serveur (sections 4 et 11)

- **Pré-session anonyme** : `GET /api/auth/state` crée une session `anon` porteuse du jeton CSRF,
  exigé aussi pour la connexion. Les étapes intermédiaires (`anon`, `mfa`, `enroll`) expirent en 15 min.
- Les durées de `app.yaml` ne peuvent qu'être réduites (inactivité ≤ 30 min, absolue ≤ 8 h,
  ré-authentification ≤ 15 min, 5 essais de connexion au plus).
- Ré-authentification valable 5 minutes ; elle régénère l'identifiant de session.
- Limitation des connexions : 5 échecs / 15 min par compte et par IP (échecs TOTP compris), puis
  verrouillage 15 min × 2^n plafonné à 24 h, persisté en SQLite.
- TOTP ± 30 s avec anti-rejeu (dernier pas de temps mémorisé) ; secret TOTP chiffré en enveloppe ;
  10 codes de secours de 50 bits hachés en SHA-256 (entropie suffisante, Argon2 inutile).
- Mots de passe : liste locale (mots de passe et bases courants), suites triviales, identifiant interdit.
- **OIDC** : avec `SameSite=Strict`, le cookie de session n'est pas envoyé au retour du fournisseur ;
  l'état (PKCE, `state`, `nonce`) est gardé en mémoire et référencé par un cookie `__Host-oidc`
  (`SameSite=Lax`, 10 min), puis une page intermédiaire de même origine redirige vers `/`.
  Rôles : `OIDC_ADMIN_GROUP`, et `OIDC_EDITOR_GROUP` (ajouté) ; revendication `OIDC_GROUPS_CLAIM`
  (défaut `groups`). Le MFA est alors délégué au fournisseur d'identité.
- **Coffre** : identifiants en mémoire indexés par la « famille » de session (survit aux
  régénérations, effacée à la déconnexion ou à l'expiration). Les identifiants temporaires ne sont
  jamais mémorisés sur disque ; « Mémoriser » ne concerne que les clés longue durée.
- Un profil d'un autre groupe renvoie 404 (son existence n'est pas révélée). Le profil Démo est
  visible de tous en mode démo et non modifiable.
- Enregistrer une mise en page partagée exige le droit d'édition ; un lecteur peut déplacer les
  nœuds sans enregistrer.
- Journal d'audit en ajout seul garanti par des triggers SQLite ; export CSV (séparateur `;`, BOM,
  neutralisation des formules).
- Icônes servies sur `/icons/:nom` (session requise) avec une CSP `sandbox`.
- Routes ajoutées à la table de la section 11 : `GET /api/snapshots/:id/inventory`,
  `POST /api/audit/export` (journalise les exports faits dans le navigateur), `GET /api/help/iam`,
  `GET /api/config/app`, `GET /api/config/services`, `GET /api/profiles/:id/credentials/available`
  (booléen pour les lecteurs, sans détail), `GET /api/admin/audit.csv`.

## Icônes (section 9.3)

- Icônes génériques dessinées pour le projet : une par catégorie (glyphe blanc sur la tuile colorée de
  la catégorie) + Git, navigateur, Internet. Résolution côté serveur : pack AWS
  (`icons/aws/<nom>.svg`) → générique du même nom → générique de la catégorie → `generic.svg`.
- `pnpm fetch-icons` : URL du pack via `AWS_ICONS_URL`, sinon recherche du lien sur la page officielle ;
  si elle échoue (la page charge ses liens en JavaScript), le script l'indique et l'application garde
  les icônes génériques. Le pack téléchargé n'est pas versionné (licence AWS).

## Tests E2E et exports (sections 10 et 16)

- `pnpm e2e` démarre son propre serveur (`scripts/e2e-server.mjs`, port 8444, données vierges dans
  `.tmp/e2e-data`, mode démo) et vérifie : création de l'administrateur + TOTP, profil Démo, nœuds et
  conteneurs de la section 9.5, panneau latéral, filtre, export SVG, absence de violation CSP.
- Navigateur Playwright et éventuelles bibliothèques système manquantes (poste WSL sans droits root :
  `libnss3`, `libnspr4`, `libasound2` extraites par `apt-get download` + `dpkg -x`) sont placés dans
  `.tmp/`, référencés par `playwright.config.ts` : rien n'est installé hors du projet.
- Exports SVG / PNG : capture du diagramme complet par html-to-image. La police Inter (sous-ensemble
  latin) est fournie explicitement, et les URL `data:` sont converties localement : la CSP stricte
  (`base-uri 'none'`, `connect-src 'self'`) reste inchangée. PDF : écrit sans dépendance (une page,
  image JPEG). draw.io : conteneurs imbriqués, tuiles et arêtes orthogonales avec les couleurs du thème.

## Mise en route d'un compte (enregistrement et premier scan)

- Parcours guidé `/profils/:id/demarrage` : Identifiants → Premier scan → Diagramme (Import →
  Diagramme pour un profil « Imports uniquement »). La création d'un profil y mène directement ;
  l'étape de départ est déduite du mode d'accès et de `/credentials/available` (sans
  ré-authentification). Le diagramme s'ouvre seul après un scan **sans erreur** ; sinon les
  permissions manquantes restent affichées, avec le lien vers la politique IAM recommandée.
- Collage d'un bloc d'identifiants (variables `AWS_*` bash / PowerShell / cmd, fichier
  `credentials`, JSON de `sts get-session-token` ou `aws configure export-credentials`) : analyse
  **locale au navigateur**, dans un champ `type="password"` qui ne garde jamais le texte collé ;
  rien n'est envoyé avant « Vérifier et enregistrer », et la validation serveur (4.3) est inchangée.
- Compte différent : l'API renvoie le code `COMPTE_DIFFERENT`. L'interface propose alors
  « Utiliser le compte X pour ce profil » : modification explicite du profil (journalisée, efface
  les identifiants mémorisés de l'ancien compte) puis nouvelle tentative. Jamais automatique.
- Formulaire de profil : ID de compte normalisé (tirets et espaces retirés), régions groupées par
  continent avec filtre, options avancées (description, nœuds externes, sondes, Flow Logs, tags)
  repliées. Mode « Rôle assumé par l'outil » désactivé si `HUB_CREDENTIALS` n'est pas configuré.
- La liste des profils expose un résumé du dernier snapshot (`lastSnapshot` : date, nombre de
  ressources et d'erreurs), affiché sur chaque carte ; aucune donnée sensible.
- Formulaire de profil, mode « Clés d'accès saisies » : les identifiants se saisissent (ou se collent)
  directement à la création, ou se choisissent parmi les clés **déjà mémorisées (chiffrées)** d'un autre
  profil que l'utilisateur peut modifier. Case « plus tard » pour les fournir à l'étape suivante. Si les
  identifiants sont refusés, le profil déjà créé est mis à jour (pas de doublon) au nouvel envoi.
- Réutilisation (`type: 'stored'`) : la liste (`GET /api/credentials/stored`) exige une
  ré-authentification et ne renvoie que des métadonnées masquées (`AKIA…7XQ2`, type, profil source,
  compte, date, ARN de rôle). Le serveur déchiffre la source (AAD = profil source), applique les mêmes
  contrôles qu'une saisie (racine refusée, compte vérifié, échange immédiat contre des identifiants
  temporaires) puis **ré-chiffre une copie** pour le profil cible (AAD = profil cible) : supprimer le
  profil source ne casse pas le profil cible. Rôle à assumer facultatif ; External ID repris de la
  source seulement si le rôle est le même. Seules les clés d'utilisateur IAM peuvent être mémorisées :
  les clés temporaires restent en mémoire (section 4.3).

## Vue Organisation (AWS Organizations, IAM Identity Center)

- Deux services de scan, actifs par défaut : `organizations` (global : organisation, racine, OU
  parcourues récursivement — séquentiellement, l'API étant fortement limitée en débit —, comptes,
  politiques de chaque type activé sur la racine avec contenu et cibles, administrateurs délégués)
  et `identitycenter` (par région : permission sets, affectations, groupes avec leur seul nombre de
  membres, utilisateurs à affectation directe réduits à leur nom). Aucune autre donnée personnelle.
- Compte membre : seule l'organisation est lisible ; elle est marquée `_scope: membre` et la vue
  Organisation l'indique en avertissement. Ce n'est pas une erreur de scan (sinon chaque compte
  membre afficherait une erreur et bloquerait l'ouverture automatique du diagramme).
- `buildOrgGraph` (fonction pure, core) : conteneurs `org` > `ou` imbriquées > comptes ; politiques
  non gérées par AWS en nœuds reliés à leurs cibles (FullAWSAccess, attachée partout, n'apparaît
  que dans les détails : politiques directes / héritées) ; groupes et utilisateurs Identity Center
  reliés aux comptes, étiquette = permission sets, visible à la sélection (`labelOnFocus`) pour
  éviter le chevauchement d'étiquettes.
- Ces ressources sont masquées du diagramme d'infrastructure par des règles déclaratives
  (`config/rules/organizations.yaml`, `hidden: true`) ; le moteur de règles reste générique.
- Les jetons de thème `org` / `ou` ont une valeur de repli : un CONFIG_DIR créé avant cette
  version fonctionne sans modification. En revanche, copier `config/rules/organizations.yaml`
  dans un CONFIG_DIR existant (les valeurs par défaut ne sont copiées qu'au premier démarrage).
- Le port des E2E est surchargeable (`E2E_PORT`, défaut 8444).

## Vue infra multi-comptes

- Composition de profils existants (chacun garde ses identifiants et ses droits) : page
  « Multi-comptes », sélection portée par l'URL (`/multi-comptes/<id>,<id>`), dernier snapshot de
  chaque profil. Chaque profil doit être visible par l'utilisateur (sinon 404, comme partout) ; la
  mise en page manuelle (`DATA_DIR/layouts/multi-<hash>.json`) n'est enregistrable que si
  l'utilisateur peut modifier tous les profils de la sélection.
- `mergeSnapshots` (core, pure) fusionne les snapshots en marquant chaque ressource de son compte
  (`account`, champ optionnel du schéma, absent hors vue multi-comptes : rien ne change pour un
  profil seul). `buildGraph` ajoute alors un cadre `account` contenant le « Global » et les régions
  du compte. Les liens inter-comptes viennent du moteur existant, sans code par service : relations
  des règles résolues par ARN/ID, groupes de sécurité référencés d'un compte à l'autre, CIDR des VPC
  appairés. Une ressource vue depuis plusieurs comptes (même ARN : Transit Gateway partagé…) n'est
  gardée qu'une fois, de préférence chez son propriétaire (compte de l'ARN).
- Ajouts génériques utiles aussi à un seul compte : collecte des Transit Gateways
  (`ec2:DescribeTransitGateways`, ARN d'origine conservé, « partagé par <compte> » s'il vient
  d'ailleurs), relation attachement → Transit Gateway, arête « appairage » entre deux VPC connus
  quand l'appairage est actif.
- Mise en page : les arêtes entre comptes ne contraignent pas ELK (elles sont dessinées mais les
  comptes restent côte à côte), comme les arêtes internes d'un VPC.
- Filtres de tags des profils non appliqués dans la vue multi-comptes (elle montre les comptes
  entiers) ; nœuds externes et sondes des profils réunis.
- Mode démo : second profil fictif « Partenaire » (`demo-partenaire`, compte 111111111111) relié à
  la démo ; les profils `demo`/`demo-…` sont en lecture seule.

## Scan de toute une organisation (profil hub)

- Nouveau mode d'accès `assume-role-profile` (« Rôle via un profil hub ») : le profil d'un compte
  membre assume son rôle en lecture seule avec les identifiants d'un autre profil (le hub, en
  général le compte de gestion). Un hub doit porter ses propres identifiants (clés d'accès ou rôle
  de l'outil) : pas de chaîne de hubs. Créer ou modifier un tel profil exige de pouvoir modifier le
  hub ; scanner ou tester un profil membre aussi (vérifié à chaque résolution), sinon les droits
  d'un groupe pourraient servir à un autre. Aucune clé n'est saisie pour un profil membre.
- Chaînage de rôles : session limitée à une heure (limite AWS). Échec d'AssumeRole → erreur
  explicite `ROLE_INACCESSIBLE` (rôle non déployé, External ID différent).
- Page « Comptes de l'organisation » (bouton « Profils des comptes… » de la vue Organisation) :
  comptes lus dans le dernier snapshot du hub, un profil créé par compte coché (nom du compte,
  régions et groupes choisis, idempotent : un compte déjà couvert par ce hub est ignoré, le compte
  du hub aussi). Un même External ID pour toute l'organisation (généré dans le navigateur) : c'est
  la valeur passée au StackSet, identique dans tous les comptes ; il reste propre à l'organisation.
- Rôle déployé par StackSet (`docs/iam/stackset-lecture-seule.yaml`) : `ReadOnlyAccess` géré par
  AWS + refus explicite de toute lecture de valeur secrète (Secrets Manager, SSM, objets S3),
  confiance au compte du hub avec condition `sts:ExternalId`. Les commandes AWS CLI affichées sont
  préremplies (compte hub, External ID, racine de l'organisation).
- Scan de tous les comptes : en série depuis le navigateur (un compte après l'autre, nouvel essai
  après une pause si la limite de lancement de scans est atteinte), puis ouverture de la vue
  multi-comptes avec le hub et ses comptes membres. La page doit rester ouverte pendant la série.
