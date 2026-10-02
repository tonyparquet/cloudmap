# Avancement (section 17 de CLAUDE.md)

- [ ] 1. Squelette du monorepo, tsconfig, lint, scripts, Vitest
- [ ] 2. `packages/security` : chiffrement d'enveloppe, redaction, + tests
- [ ] 3. `packages/core` : types zod, moteur de règles JSONata, classification des sous-réseaux, inférence des flux, `buildGraph`, regroupement, diff, + tests
- [ ] 4. `fixtures/demo-snapshot.json` conforme à 9.5 et toutes les règles YAML de la section 6
- [ ] 5. `packages/scanner` : orchestrateur, collecteurs de 5.2, inventaire générique, + tests avec mocks et test de liste blanche
- [ ] 6. `apps/server` : HTTPS TLS 1.3, contrôles de démarrage, en-têtes, SQLite + migrations, auth locale + TOTP + OIDC, sessions, CSRF, rôles, profils, identifiants, scans + SSE, snapshots, import, layouts, audit, + tests de sécurité
- [ ] 7. `apps/web` : thème, pages de la section 10, diagramme React Flow + ELK, nœuds et conteneurs, interactions, exports
- [ ] 8. `apps/cli` : scan hors-ligne, rotation de la clé maître
- [ ] 9. Icônes : `scripts/fetch-icons.ts`, `map.yaml`, icônes génériques de repli
- [ ] 10. `deploy/`, `docs/`, `README.md`
- [ ] 11. Tests E2E, puis `pnpm check` vert
- [ ] 12. Vérification finale de la section 18
