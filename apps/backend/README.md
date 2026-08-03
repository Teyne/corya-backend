# @corya/backend

API Express et worker TypeScript de Corya. Prérequis : Node.js 24 LTS
(24.18.0 ciblé sur Jelastic) et npm 10+.

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
npm run build
npm run smoke:puppeteer -- --renders 3 --timeout-ms 15000
```

La configuration est lue depuis `apps/backend/.env.local`, puis depuis le `.env.local` à la racine du dépôt. Copier la racine `.env.example`; Supabase et Retell sont obligatoires. SMTP, token de health et alertes deviennent obligatoires en production selon la validation Zod.

## Processus

- API : webhook Retell signé, `/health`, `/health/deep` protégé, pollers d'alertes.
- Worker : pipeline PDF/Storage/SMTP, purge Retell à +48 h et consommation séparée de `file_deletions_outbox`.
- Les deux boucles du worker ont des heartbeats séparés et récupèrent les verrous zombies.
- API et worker vérifient au démarrage le marqueur SQL de contrat vague 7 ; si
  les quatre migrations du 2 août ne sont pas toutes présentes, le démarrage
  échoue avant toute écoute HTTP ou prise de travail.

`/health/deep` vérifie DB, Storage, worker, boucle de suppression, backlog et
dix crons. `last_deletion_poll_at = NULL` signifie que la boucle n'a pas
encore démarré et reste neutre ; une valeur âgée de plus de 180 s rend le
résultat `degraded`. `?full=1` ajoute un vrai `verify()` SMTP. Sans
`X-Health-Token` valide, la route répond 404. Le résultat est caché pendant
`HEALTH_DEEP_CACHE_MS`.

Les tests unitaires et e2e sont hermétiques : pas de DB, SMTP, Retell ou Chromium réel. Les scripts de diagnostic ne partagent pas tous cette garantie ; lire `scripts/README.md` avant usage.

Le préflight Jelastic est documenté dans docs/jelastic-deployment.md et
s'exécute, après le build, avec npm run preflight:jelastic -- --role api ou
--role worker.

La documentation d'architecture et les opérations de déploiement sont à la
racine du dépôt. Les migrations `20260802000000` à `20260802000003` sont
appliquées à distance depuis le 3 août 2026. Elles ne se réécrivent jamais :
le correctif runtime de `get_cron_health()` est donc livré dans la migration
append-only `20260803000000`, à appliquer avant l'activation des processus.
