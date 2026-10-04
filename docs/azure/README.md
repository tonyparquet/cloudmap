# Azure : accès en lecture seule

Le Cartographe lit un abonnement Azure **uniquement** par Azure Resource Graph
(`POST /providers/Microsoft.ResourceGraph/resources`, requêtes KQL en lecture) et par la lecture de
l'abonnement (`GET /subscriptions/<id>`). Le client HTTP du scanner n'accepte que des GET et ce seul
POST de requête vers `management.azure.com` : tout autre appel est refusé avant d'atteindre le réseau.

Jamais lu : valeurs de Key Vault (secrets, clés, certificats), clés de comptes de stockage, SAS,
chaînes de connexion, paramètres d'application (App Service / Functions), identifiants de registre ou
de cluster. Les propriétés de ce type présentes dans une réponse sont supprimées avant enregistrement.

Les commandes ci-dessous ne contiennent que des espaces réservés : `<SUBSCRIPTION_ID>`,
`<MANAGEMENT_GROUP_ID>`, `<APP_ID>`.

## Option 1 (recommandée) : jeton temporaire

Avec un compte disposant au moins du rôle **Lecteur** (`Reader`) sur l'abonnement :

```sh
az login
az account set --subscription <SUBSCRIPTION_ID>
az account get-access-token --resource https://management.azure.com --query accessToken -o tsv
```

Coller le jeton dans le formulaire d'identifiants du profil. Il expire seul (environ 1 h) et n'est
conservé qu'en mémoire du serveur.

## Option 2 : principal de service dédié

### 1. Rôle personnalisé en lecture seule

[`role-lecture-seule.json`](role-lecture-seule.json) accorde `*/read` (aucune action `…/action`,
aucune action de données) et exclut explicitement les actions de lecture de clés et de secrets. Le
rôle intégré **Lecteur** (`Reader`) convient aussi.

Remplacer `<SUBSCRIPTION_ID>` dans `AssignableScopes` (ou y mettre
`/providers/Microsoft.Management/managementGroups/<MANAGEMENT_GROUP_ID>`), puis :

```sh
az role definition create --role-definition @role-lecture-seule.json
```

### 2. Principal de service et attribution

```sh
az ad sp create-for-rbac --name cartographe-lecture-seule --years 1 \
  --role "Cartographe - lecture seule" \
  --scopes /subscriptions/<SUBSCRIPTION_ID>
```

La sortie donne `appId` (client), `tenant` et `password` (secret client) : les saisir dans le
formulaire d'identifiants. Le secret est échangé immédiatement contre un jeton temporaire ; il n'est
conservé (chiffré) que si « Mémoriser » est coché.

Abonnement supplémentaire pour le même principal :

```sh
az role assignment create --assignee <APP_ID> \
  --role "Cartographe - lecture seule" \
  --scope /subscriptions/<SUBSCRIPTION_ID>
```

## Vue Organisation (groupes d'administration, stratégies, rôles)

La vue Organisation lit les groupes d'administration, les abonnements, les affectations Azure Policy
et les attributions de rôles visibles par l'identité. Pour la hiérarchie complète, attribuer le rôle
au niveau du groupe d'administration racine (ou de celui qui couvre le périmètre) :

```sh
az role assignment create --assignee <APP_ID> \
  --role "Cartographe - lecture seule" \
  --scope /providers/Microsoft.Management/managementGroups/<MANAGEMENT_GROUP_ID>
```

Sans ce droit, la vue n'affiche que les abonnements lisibles, avec un avertissement.

Les principaux (utilisateurs, groupes, principaux de service) apparaissent par leur type et le début
de leur identifiant : leurs noms nécessiteraient Microsoft Graph, qui n'est pas interrogé.

## Révocation

```sh
az ad sp delete --id <APP_ID>
az role definition delete --name "Cartographe - lecture seule"
```
