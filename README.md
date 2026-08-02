# Corya backend

Backend de Corya pour la réception des appels Retell, la persistance Supabase et le pipeline post-appel. Ce dépôt n'est pas un workspace npm : toutes les commandes se lancent dans `apps/backend/`.

## Flux réel

`Retell -> webhook Express signé -> Supabase -> worker -> PDF Puppeteer -> Storage privé -> e-mail Infomaniak`

Le même processus worker exécute deux boucles indépendantes : la file `jobs` et l'outbox de suppressions physiques. Chacune possède son propre heartbeat. Les migrations Supabase sont dans `supabase/migrations/`.

Le site public est un dépôt séparé, actuellement dans `../corya-frontend/corya/` : TanStack Start/React, Cloudflare et Lovable. Il ne s'agit pas du back-office Next.js décrit dans les anciennes notes.

## Commandes

```bash
cd apps/backend
npm ci
npm run dev
npm run worker:dev
npm test -- --run
npm run type-check
npm run lint
```

Copier `.env.example` vers `.env.local`, sans versionner les secrets. L'API et le worker sont des processus distincts en production. Aucun déploiement Jelastic ni application de migration distante n'est automatique depuis ce dépôt.

## Documentation de référence

- `docs/architecture.md` : architecture déployable et état réel
- `docs/compliance.md` : règles nLPD et écarts encore manuels
- `docs/registre-traitements.md` : registre versionné
- `.claude/session4-decisions.md` : historique des décisions de résilience

Les documents de prompts de sessions sont historiques : le code, les migrations non appliquées et les documents ci-dessus priment.
