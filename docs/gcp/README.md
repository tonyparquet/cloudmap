# Google Cloud : accès en lecture seule

CloudMap inventorie un projet Google Cloud avec **Cloud Asset Inventory** (types de ressources de
la page Scan), lit la hiérarchie **Resource Manager** (organisation, dossiers, projets), les
**règles d'administration** (Org Policy v2) et les **liaisons IAM** des groupes et utilisateurs
(`searchAllIamPolicies`). Tous les appels sont des `GET` vers `*.googleapis.com` ; aucune écriture,
aucune valeur de secret, aucun objet Cloud Storage n'est lu.

Remplacez les valeurs entre chevrons ; rien n'est propre à un client dans l'application.

## 1. Activer les API dans le projet scanné

```sh
gcloud services enable cloudasset.googleapis.com cloudresourcemanager.googleapis.com \
  orgpolicy.googleapis.com --project=<PROJET>
```

## 2. Créer le rôle personnalisé

Vue complète de l'organisation (recommandé) :

```sh
gcloud iam roles create cloudmapLecture --organization=<ID_ORGANISATION> \
  --file=docs/gcp/role-lecture-seule.yaml
```

Un seul projet :

```sh
gcloud iam roles create cloudmapLecture --project=<PROJET> \
  --file=docs/gcp/role-lecture-seule-projet.yaml
```

Équivalent avec des rôles prédéfinis : `roles/cloudasset.viewer`, `roles/browser` et
`roles/orgpolicy.policyViewer`. N'accordez pas `roles/secretmanager.secretAccessor`,
`roles/storage.objectViewer` ni de rôle d'administration.

Sans droit sur l'organisation, le projet est traité comme **membre** : seuls ses dossiers parents
lisibles apparaissent dans la vue Organisation, avec un avertissement (ce n'est pas une erreur de scan).

## 3. Obtenir un jeton temporaire (recommandé)

Évitez les clés de compte de service : elles sont permanentes et sont la première cause de fuite
d'identifiants Google Cloud. Préférez un jeton d'une heure, collé dans la page « Identifiants » du profil.

**Option A : emprunt d'identité d'un compte de service, sans clé.**

```sh
gcloud iam service-accounts create cloudmap-lecture --project=<PROJET> \
  --display-name="CloudMap (lecture seule)"

# Rôle sur l'organisation (ou --project=<PROJET> et le rôle de projet)
gcloud organizations add-iam-policy-binding <ID_ORGANISATION> \
  --member="serviceAccount:cloudmap-lecture@<PROJET>.iam.gserviceaccount.com" \
  --role="organizations/<ID_ORGANISATION>/roles/cloudmapLecture"

# Autoriser votre compte à emprunter l'identité du compte de service
gcloud iam service-accounts add-iam-policy-binding \
  cloudmap-lecture@<PROJET>.iam.gserviceaccount.com \
  --member="user:<VOUS@DOMAINE>" --role="roles/iam.serviceAccountTokenCreator"

# Jeton d'une heure à coller dans CloudMap
gcloud auth print-access-token \
  --impersonate-service-account=cloudmap-lecture@<PROJET>.iam.gserviceaccount.com
```

**Option B : votre propre compte**, s'il dispose du rôle ci-dessus et d'aucun autre droit inutile :

```sh
gcloud auth print-access-token
```

Un jeton collé hérite de **tous** les droits du compte qui l'a émis : CloudMap ne lit qu'en `GET`,
mais affiche un avertissement si le compte possède des droits d'écriture sur le projet.

Si Google répond qu'un « projet de quota » est requis, utilisez l'option A : le jeton d'un compte de
service est rattaché à son propre projet.

## 4. Clé de compte de service (déconseillé)

Si aucune autre option n'est possible, une clé JSON est acceptée : elle est échangée immédiatement
contre un jeton de portée `cloud-platform.read-only` (Google refuse alors toute écriture, quels que
soient les rôles IAM) et n'est conservée que si « Mémoriser (chiffré) » est coché. Supprimez la clé
dans Google Cloud dès qu'elle n'est plus utile :

```sh
gcloud iam service-accounts keys list \
  --iam-account=cloudmap-lecture@<PROJET>.iam.gserviceaccount.com
gcloud iam service-accounts keys delete <ID_CLE> \
  --iam-account=cloudmap-lecture@<PROJET>.iam.gserviceaccount.com
```

## Ce qui est lu, et ce qui ne l'est jamais

| Lu                                                                                     | Jamais lu                                                        |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Métadonnées des ressources (Cloud Asset `assets.list`, contenu `RESOURCE`)             | Valeurs des secrets (`secretmanager.versions.access`)            |
| Noms des variables d'environnement Cloud Run / Functions, références de secrets        | Valeurs des variables d'environnement, substitutions Cloud Build |
| Métadonnées d'instance `created-by` et `instance-template`                             | Scripts de démarrage, clés SSH, autres métadonnées d'instance    |
| Organisation, dossiers, projets, règles d'administration                               | Objets Cloud Storage (`storage.objects.*`)                       |
| Liaisons IAM des groupes et utilisateurs sur l'organisation, les dossiers, les projets | Clés de comptes de service, authentification maître GKE          |
