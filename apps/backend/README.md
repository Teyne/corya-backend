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

| Script              | Effet                                            |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Démarre en watch via `tsx`                       |
| `npm run build`     | Compile TypeScript vers `dist/`                  |
| `npm run start`     | Démarre le build (`node dist/index.js`)          |
| `npm test`          | Exécute la suite Vitest (single run)             |
| `npm run test:watch`| Vitest en mode watch                             |
| `npm run lint`      | ESLint 9 flat config                             |
| `npm run type-check`| `tsc --noEmit`                                   |

## Démarrage rapide

```bash
npm install
npm run dev
# puis dans un autre terminal :
curl -s http://localhost:3000/health | jq
# → { "status": "ok", "version": "0.1.0", "timestamp": "2026-..." }
```

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
