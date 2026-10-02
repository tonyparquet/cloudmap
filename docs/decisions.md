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
