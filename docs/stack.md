# Corya — Stack technique verrouillé

> **Mise à jour du 2 août 2026.** Les sections Next.js sont un choix historique
> pour un futur back-office, pas un composant existant. Le site public actuel
> est dans `corya-frontend/corya` et utilise TanStack Start, React 19, Lovable
> et Cloudflare. BetterStack est prévu mais non activé/confirmé. Le backend est
> un projet npm unique sous `apps/backend/`, sans workspaces.

Toutes les décisions listées ci-dessous sont **verrouillées**. Toute remise en question doit passer par le fondateur, pas par un agent.

## Backend api.corya.ch

| Composant | Choix verrouillé | Alternative écartée |
|---|---|---|
| Runtime | Node.js 20 LTS | Deno, Bun (moins mature en prod) |
| Langage | TypeScript strict | JavaScript (perte de types utiles) |
| Framework HTTP | Express.js | Fastify (surkill au MVP), Hono |
| Validation | Zod | Yup, Joi |
| Logs | Pino | Winston, Bunyan |
| Tests | Vitest | Jest (plus lent), Mocha |
| ORM | Aucun (queries directes) | Prisma, Drizzle (au MVP) |
| PDF | Puppeteer | pdfkit, jsPDF |
| Email | Nodemailer + SMTP Infomaniak | SendGrid, Postmark (US) |
| Retell SDK | `retell-sdk` npm | Fetch manuel |

### Dépendances backend validées (session 1, 30.07.2026)

Validées explicitement par le fondateur. Elles font désormais partie de la stack verrouillée.

| Dépendance | Type | Rôle |
|---|---|---|
| `express` | prod | Framework HTTP |
| `zod` | prod | Validation env vars et payloads |
| `pino` | prod | Logs JSON structurés |
| `pino-http` | prod | Middleware de request logging |
| `cors` | prod | CORS restrictif (origin depuis env, jamais `*`) |
| `dotenv` | prod | Chargement `.env.local` |
| `retell-sdk` | prod | Vérification de la signature des webhooks. Utilisé parce que Retell ne documente pas publiquement le format exact de sa signature : notre implémentation maison n'était pas validable en conditions réelles. Le secret HMAC est la clé API (`RETELL_API_KEY`), pas un secret de webhook séparé. |
| `typescript` | dev | Compilation, mode strict |
| `tsx` | dev | Runner TS en développement (`npm run dev`) |
| `vitest` | dev | Tests unitaires et intégration |
| `supertest` | dev | Tests HTTP sans ouvrir de port |
| `pino-pretty` | dev | Pretty print des logs en développement |
| `eslint` + `typescript-eslint` | dev | Lint, flat config ESLint 9 |
| `@types/node`, `@types/express`, `@types/cors`, `@types/supertest` | dev | Typings |

Critères de validation appliqués à chaque ajout : licence permissive **MIT, Apache 2.0 ou ISC** (voir « Ajouts de dépendances » plus bas, qui fait foi — GPL exclue), dernière release < 12 mois, aucun advisory `npm audit`. Une dépendance qui ne passe pas ces trois critères n'est pas installée — l'agent s'arrête et remonte au fondateur.

### Dépendances ajoutées (session 3, 31.07.2026)

| Dépendance | Type | Rôle |
|---|---|---|
| `puppeteer` | prod | Rendu du PDF récap. Version complète (et non `puppeteer-core`) pour que Chromium soit téléchargé à l'install sans configuration manuelle. |
| `nodemailer` | prod | Notification SMTP minimale vers le portail authentifié, sans donnée patient ni pièce jointe. |
| `@types/nodemailer` | dev | Typings |

### Traitement asynchrone (verrouillé session 3)

| Décision | Choix | Alternative écartée |
|---|---|---|
| File de travail | Table `jobs` en Postgres | Redis/BullMQ (dépendance d'infra supplémentaire), pg-boss |
| Prise de job | RPC Postgres `claim_jobs`, `SELECT ... FOR UPDATE SKIP LOCKED` | Verrou applicatif (PostgREST n'ouvre pas de transaction explicite depuis supabase-js) |
| Granularité | Job monolithique `process_appel` avec checkpoints dans `payload.steps` | Jobs séparés PDF / email (retry plus fin, mais orchestration et idempotence plus lourdes) |
| Exécution | Process worker séparé de l'API (`npm run worker`) | Worker dans le process Express (Puppeteer y consomme trop de mémoire) |
| Retry | Backoff exponentiel avec jitter, plafond 5 min, borné par `attempts`/`max_attempts` | Backoff constant (thundering herd sur panne SMTP prolongée) |

Précisions de vocabulaire, souvent source de confusion : le statut d'un job en
cours est **`processing`** (pas `running`), les colonnes de verrouillage sont
**`locked_at`/`locked_by`** (pas `started_at`), et `claim_jobs` réserve un
**batch** (pas un job unique). Il n'existe pas de fonction `claim_next_job`.

### Règles ESLint verrouillées

Base : `@typescript-eslint` preset `recommended-type-checked`, plus :

| Règle | Niveau | Raison |
|---|---|---|
| `no-unused-vars` | error | Code mort |
| `no-console` (`allow: ["error"]`) | warn | Les logs passent par Pino, seul `console.error` toléré |
| `@typescript-eslint/no-explicit-any` | error | Cohérent avec le mode strict |
| `@typescript-eslint/no-floating-promises` | error | Critique : une promesse non attendue dans le flow webhook = PDF ou email perdu silencieusement |
| `@typescript-eslint/consistent-type-imports` | warn | Imports de types explicites |

## Frontend portail.corya.ch

| Composant | Choix verrouillé | Alternative écartée |
|---|---|---|
| Framework | Next.js 14+ App Router | Remix, Astro, Nuxt |
| Langage | TypeScript strict | JavaScript |
| Styling | Tailwind CSS | CSS Modules, styled-components |
| Composants | shadcn/ui | Material UI, Chakra |
| Auth | Supabase Auth (magic link) | NextAuth, Clerk |
| State | React Server Components + minimal client state | Redux, Zustand |
| Charts | Recharts | Chart.js, Victory |
| Formulaires | react-hook-form + zod | Formik |
| Tests | Vitest + Playwright | Cypress |

## Base de données

| Composant | Choix verrouillé | Alternative écartée |
|---|---|---|
| DB | Supabase (PostgreSQL 15 managé) | Firebase (US), Neon (US) |
| Région | Zurich (Central EU), `eu-central-2` | Frankfurt, US, Asia |
| Migrations | Supabase CLI | Prisma migrate, custom |
| Auth | Supabase Auth | Auth0, Firebase Auth |
| Storage | Supabase Storage | AWS S3, Cloudflare R2 |
| Cron jobs | pg_cron in Supabase | External scheduler |

## Infrastructure

| Composant | Choix verrouillé | Alternative écartée |
|---|---|---|
| Hébergement backend | Infomaniak Jelastic | AWS EU, Vercel, Fly.io |
| Hébergement frontend | Infomaniak Jelastic (préféré) OU Vercel EU (acceptable) | AWS US, Netlify US |
| DNS | Infomaniak | Cloudflare (US), Route 53 |
| Email SMTP | Infomaniak | SendGrid, Postmark, Mailgun |
| Monitoring | BetterStack Free | UptimeRobot, Pingdom |
| Logs collector | BetterStack Logs ou Papertrail EU | Datadog US, New Relic |
| CDN | Infomaniak natif | Cloudflare |

## Voice AI

| Composant | Choix verrouillé | Alternative écartée |
|---|---|---|
| Voice AI plateforme | Retell AI | Vapi, Bland, custom |
| LLM (démarrage) | GPT-4.1 | Claude, Gemini, Mistral |
| LLM (production ciblée) | Claude Haiku 4.5 OU GPT-4o | À déterminer par tests |
| TTS (démarrage) | ElevenLabs français | OpenAI TTS, Azure |
| TTS (production ciblée) | Cartesia Sonic | À évaluer |
| STT | Auto via Retell | - |
| Téléphonie SIP | Peoplefone | Sipcall, Twilio |

## Justifications clés

**Pourquoi Infomaniak et pas AWS ?**
Cible médicale = hébergement Suisse obligatoire pour la crédibilité et la conformité nLPD. AWS a des régions EU mais reste une entreprise US soumise au Cloud Act.

**Pourquoi pas d'ORM au MVP ?**
Au démarrage, les queries sont simples. Un ORM ajoute une couche d'abstraction et de dépendance qui coûte plus qu'il ne rapporte à ce stade. Réévaluation possible au client N°5+.

**Pourquoi Next.js et pas SvelteKit ou Astro ?**
Écosystème massif, RSC (Server Components) mature, très bonne intégration Supabase, communauté large pour dépanner. SvelteKit était considéré mais moins de composants tout faits.

**Pourquoi Supabase et pas hosted Postgres + Auth0 ?**
Supabase = DB + Auth + Storage + Realtime dans un seul service, région suisse disponible, tarification prévisible. Coût zéro au démarrage.

**Pourquoi Zurich et pas Frankfurt ?**
Choix motivé par le positionnement commercial suisse et la latence optimale pour la clientèle romande. Alternative Frankfurt écartée. Concrètement : les données médicales ne quittent jamais le territoire suisse, ce qui simplifie l'argumentaire face aux cabinets et la documentation des transferts au sens des art. 16-18 nLPD.

**Pourquoi Puppeteer et pas pdfkit ?**
Puppeteer = HTML/CSS pour le template (facile à modifier, testable dans un navigateur), qualité de rendu supérieure. Le coût mémoire du headless Chrome est acceptable pour un usage occasionnel (< 100 PDFs/heure au MVP).

## Ajouts de dépendances

Toute nouvelle dépendance NPM/pip nécessite validation. Critères :

1. **Maintenue activement** : dernière release < 12 mois
2. **Licence commerciale** : MIT, Apache 2.0, ISC OK. GPL non.
3. **Origine** : préférer les libs EU/CH quand disponibles
4. **Alternative** : pourquoi pas construire soi-même en 20 lignes ?

Aucun agent n'ajoute une lib sans que le fondateur ait validé explicitement.
