# Corya backend

Backend de Corya pour la réception des appels Retell, la persistance Supabase et le pipeline post-appel. Ce dépôt n'est pas un workspace npm : toutes les commandes se lancent dans `apps/backend/`.

## Flux réel

`Retell -> webhook Express signé -> Supabase -> worker -> PDF Puppeteer -> Storage privé -> notification Infomaniak -> Portail authentifié`

Le même processus worker exécute deux boucles indépendantes : la file `jobs` et l'outbox de suppressions physiques. Chacune possède son propre heartbeat. Les migrations Supabase sont dans `supabase/migrations/`.

Le site public est un dépôt séparé, actuellement dans `../corya-frontend/corya/` : TanStack Start/React, Cloudflare et Lovable. Il ne s'agit pas du back-office Next.js décrit dans les anciennes notes.

## Commandes

```bash
cd apps/backend
npm ci
npm run dev
npm run worker:dev
npm test -- --run
npm run test:e2e
npm run type-check
npm run lint
npm run build
```

Copier `.env.example` vers `.env.local`, sans versionner les secrets. L'API et le worker sont des processus distincts en production. Aucun déploiement Jelastic ni application de migration distante n'est automatique depuis ce dépôt.

## Vague 7 : prérequis de mise en service

La vague 7 rend effective la suppression physique issue de
`file_deletions_outbox`, avec deux protections : les finalisations sont
fencées par le lease exact `(worker_id, locked_at)`, et les alertes
`dead_letter` sont réclamées et acquittées durablement par le poller API.
Les preuves terminales `deleted` / `not_found` sont purgées avec l'appel
source ; sans appel source, elles sont conservées au plus 24 mois. Les
`dead_letter` restent visibles jusqu'à remédiation manuelle.

Les quatre migrations `20260802000000` à `20260802000003` ont été appliquées
à la cible le 3 août 2026 et le contrat distant retourne `7`. Elles restent
append-only et ne doivent jamais être réécrites. Le premier smoke API distant
a exposé une ambiguïté PL/pgSQL dans `get_cron_health()` ; la migration
correctrice `20260803000000` doit être appliquée avant l'activation de l'API et
du worker. Les deux processus refusent de démarrer si le marqueur SQL de
contrat vague 7 n'est pas exactement `7`.

Pour le contrat SQL, uniquement sur une base Supabase locale jetable après
application des migrations :

```bash
supabase start
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/wave7_invariants.sql
```

Le script utilise uniquement des identifiants synthétiques et annule ses
mutations. Il ne doit jamais viser une base distante.

## Documentation de référence

- `docs/architecture.md` : architecture déployable et état réel
- `docs/compliance.md` : règles nLPD et écarts encore manuels
- `docs/registre-traitements.md` : registre versionné
- `.claude/session4-decisions.md` : historique des décisions de résilience

Les documents de prompts de sessions sont historiques : le code, les migrations non appliquées et les documents ci-dessus priment.
