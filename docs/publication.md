# Versions, publication et mises à jour

## Versions

- Version unique du produit : `version` du `package.json` racine (serveur, CLI, application de
  bureau ; injectée à la construction). Versionnage sémantique : `MAJEURE.MINEURE.CORRECTIF`.
- Chaque version publiée porte un tag git annoté `vX.Y.Z` dont le message reprend ses notes.
- [`CHANGELOG.md`](../CHANGELOG.md) : chaque évolution notable s'ajoute au fil de l'eau dans la
  section « Non publié » (Ajouté, Modifié, Corrigé, Sécurité…).

## Publier une version

```sh
pnpm release 1.1.0                    # « Non publié » → [1.1.0] - date, versions, commit, tag v1.1.0
git push origin main --follow-tags    # le tag déclenche la CI de publication
```

Le script refuse une version qui n'est pas supérieure à la précédente, un arbre de travail modifié,
une branche autre que `main`, et un journal sans entrée « Non publié ».

La CI [`publication.yml`](../.github/workflows/publication.yml) vérifie tout (`pnpm check`), construit
l'application de bureau sur Windows (NSIS + ZIP) et sur macOS Apple Silicon (DMG + ZIP), puis crée
la release GitHub `vX.Y.Z` avec ces fichiers et les notes du journal. Signature : voir
[`bureau.md`](bureau.md#signature).

## Recherche de mise à jour dans l'application

- Le serveur consulte la dernière release (`config/app.yaml` → `updates.feedUrl`, API GitHub) au plus
  une fois par `updates.intervalHours` (24 h), à la demande de l'interface ; le navigateur n'appelle
  jamais GitHub (CSP). Seule la version courante est transmise (en-tête `User-Agent`).
- Administrateurs : badge « Mise à jour X.Y.Z » dans la barre du haut, carte « Version et mises à
  jour » dans **Configuration** (bouton « Rechercher les mises à jour », notes de la nouvelle version,
  lien de téléchargement). Tous les utilisateurs : nouveautés de la version installée dans **Aide**.
- Désactivation : `updates: { enabled: false }` dans `app.yaml`.
- **Dépôt privé** : l'API GitHub ne montre ses releases qu'avec un jeton. Serveur : fichier
  `UPDATES_TOKEN_FILE` (jeton à granularité fine, lecture seule du contenu de ce dépôt). Application
  de bureau : aucun jeton n'est embarqué ; la recherche fonctionne si les releases sont publiques
  (dépôt public, ou flux de releases public indiqué dans `updates.feedUrl`).
- L'installation de la nouvelle version reste manuelle (téléchargement de l'installeur) : la mise à
  jour automatique exige des installeurs signés.
