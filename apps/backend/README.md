# @corya/backend

API Express et worker TypeScript de Corya. Prérequis : Node 20+ et npm 10+.

## Installation et validation

```bash
cd apps/backend
npm ci
npm run dev          # API
npm run worker:dev   # worker, autre terminal
npm test -- --run
npm run test:e2e
npm run type-check
npm run lint
```

La configuration est lue depuis `apps/backend/.env.local`, puis depuis le `.env.local` à la racine du dépôt. Copier la racine `.env.example`; Supabase et Retell sont obligatoires. SMTP, token de health et alertes deviennent obligatoires en production selon la validation Zod.

## Processus

- API : webhook Retell signé, `/health`, `/health/deep` protégé, pollers d'alertes.
- Worker : pipeline PDF/Storage/SMTP, purge Retell à +48 h et consommation séparée de `file_deletions_outbox`.
- Les deux boucles du worker ont des heartbeats séparés et récupèrent les verrous zombies.

`/health/deep` vérifie DB, Storage, worker, backlog et neuf crons. `?full=1` ajoute un vrai `verify()` SMTP. Sans `X-Health-Token` valide, la route répond 404. Le résultat est caché pendant `HEALTH_DEEP_CACHE_MS`.

Les tests unitaires et e2e sont hermétiques : pas de DB, SMTP, Retell ou Chromium réel. Les scripts de diagnostic ne partagent pas tous cette garantie ; lire `scripts/README.md` avant usage.

La documentation d'architecture et les opérations de déploiement sont à la racine du dépôt. Les migrations du 2 août 2026 doivent précéder le déploiement de ce worker.
