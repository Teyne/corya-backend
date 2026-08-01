# @corya/backend — `api.corya.ch`

Backend Node.js / TypeScript / Express pour Corya : webhooks Retell, génération PDF,
envoi email SMTP Infomaniak, upload Supabase Storage, purges nLPD.

## Prérequis

- Node.js >= 20 LTS
- npm >= 10
- (Plus tard) accès aux instances Supabase / Retell / Infomaniak SMTP

## Installation

```bash
cd apps/backend
npm install
```

## Configuration

Les variables d'environnement sont chargées, dans cet ordre, sans écraser
ce que le shell exporte déjà :

1. `apps/backend/.env.local` (overrides propres au backend)
2. `<repo-root>/.env.local` (partagé monorepo, deux niveaux au-dessus)

Aucun de ces fichiers n'est commité. Copier `.env.example` à la racine du
repo pour amorcer :

```bash
cp ../../.env.example ../../.env.local
```

**Session 1** — seules les variables `NODE_ENV`, `PORT`, `APP_BASE_URL`,
`LOG_LEVEL`, `CORS_ORIGIN` sont réellement obligatoires (avec defaults). Les
variables Supabase / Retell / SMTP sont acceptées mais optionnelles ; elles
deviendront obligatoires à mesure que les sous-systèmes seront implémentés.

## Scripts

| Script              | Effet                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `npm run dev`       | Démarre l'API HTTP en watch via `tsx`                              |
| `npm run worker`    | Démarre le worker de traitement compilé (`node dist/worker.js`)    |
| `npm run worker:dev`| Worker en watch via `tsx`                                          |
| `npm run build`     | Compile TypeScript vers `dist/`                                    |
| `npm run start`     | Démarre le build API (`node dist/index.js`)                        |
| `npm test`          | Suite unit + intégration Vitest (single run, exclut e2e)           |
| `npm run test:watch`| Vitest en mode watch                                               |
| `npm run test:e2e`  | Suite end-to-end (config Vitest dédiée, cf. section ci-dessous)    |
| `npm run lint`      | ESLint 9 flat config                                               |
| `npm run type-check`| `tsc --noEmit`                                                     |

## Démarrage rapide

```bash
npm install
npm run dev
# dans un autre terminal, le worker :
npm run worker:dev
# puis pour tester :
curl -s http://localhost:3000/health | jq
# → { "status": "ok", "version": "0.1.0", "timestamp": "...", "uptime_seconds": 12 }
```

## Endpoints

### `GET /health` — liveness (public)

Réponse 200 tant que le process répond. Zéro I/O. Utilisé par le monitoring
externe (ping toutes les 3 min).

```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "2026-08-01T09:00:00.000Z",
  "uptime_seconds": 123
}
```

### `GET /health/deep` — readiness (token-protégé)

Vérifie l'état réel du système : DB, Storage, worker heartbeat, backlog
jobs, crons pg_cron. Le check SMTP (`?full=1`) est optionnel — chaque
appel ouvre une connexion SMTP authentifiée chez Infomaniak, on ne veut
pas que le monitoring le déclenche à toutes les fréquences de ping.

Protection par header `X-Health-Token`, comparé à `HEALTH_DEEP_TOKEN` en
temps constant. Sans token valide → **404** (pas 401 : on ne révèle pas
l'existence de l'endpoint).

Réponse cachée pendant `HEALTH_DEEP_CACHE_MS` (défaut 60 s).

```bash
# Base — 5 checks
curl -s http://localhost:3000/health/deep \
  -H "X-Health-Token: $HEALTH_DEEP_TOKEN" | jq

# Complet — inclut le check smtp (verify() SMTP réel)
curl -s "http://localhost:3000/health/deep?full=1" \
  -H "X-Health-Token: $HEALTH_DEEP_TOKEN" | jq
```

HTTP 200 si tous les checks sont `ok`, sinon **503**. Le champ `status`
distingue `unhealthy` (défaillance d'un check core — db, storage) de
`degraded` (défaillance auxiliaire — worker, backlog, crons, smtp).

## Tests end-to-end

`npm run test:e2e` lance la suite dans `tests/e2e/` avec sa propre config
Vitest (`vitest.e2e.config.ts`).

**Prérequis : AUCUN.** Les tests sont hermétiques :
- Le layer DB (`src/db/queries.js`) est mocké par un store en mémoire
  (`tests/e2e/harness.ts`) qui reproduit fidèlement le contrat SQL de
  `claim_jobs`, `fail_job`, `fail_job_permanent`, `complete_job`, etc.
- Puppeteer est mocké — pas de dépendance sur le binaire Chromium.
- Le SDK Retell (`retell-sdk`) est mocké — pas d'appel externe.
- Nodemailer est mocké via `email.__setTransporterForTests` — **aucune
  connexion SMTP réelle n'est ouverte**.

Les tests ne touchent JAMAIS à une base de prod ni à un SMTP réel. Ils
peuvent être lancés sans configuration particulière depuis n'importe
quelle machine, y compris Windows :

```powershell
cd apps/backend
npm run test:e2e
```

Aucun script npm n'utilise `&&` avec des commandes bash (`rm`, `cp`,
heredoc) — la suite fonctionne sous PowerShell, cmd.exe et Git Bash à
l'identique.

Scénarios couverts :
- `webhook-to-email.e2e.test.ts` — POST webhook signé → worker →
  email SMTP fake avec pièce jointe PDF non vide.
- `worker-resilience.e2e.test.ts` — reclaim d'un job zombie,
  bascule en `dead_letter` après `max_attempts`, détection
  `pdf_orphelin` (PDF uploadé sans email envoyé).

## Notes techniques

- Alias `@/*` → `src/*`. Fonctionne au runtime (`tsx` supporte les paths de
  `tsconfig.json`) et dans les tests (mappé aussi dans `vitest.config.ts`).
  `tsc` ne réécrit PAS les chemins à la compilation : si le build casse à
  cause d'un import `@/…`, préférer un import relatif plutôt que d'ajouter
  une lib de résolution — signaler la friction à l'agent principal.
- Les logs sont redactés (Pino `redact`) sur les champs patient, transcripts
  et headers d'auth, conformément à `docs/compliance.md`.
- L'app Express est exportée séparément de `listen()` pour permettre
  supertest sans binder de port.

## Session 1 — hors périmètre

Les sous-dossiers `src/services/`, `src/db/`, `src/templates/`, `src/utils/`,
`src/types/`, `src/routes/` (autres que `/health`) et `scripts/` seront
créés dans les sessions suivantes. Ne les ajouter que quand une story les
exige.
