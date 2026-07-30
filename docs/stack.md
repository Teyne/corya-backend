# Corya — Stack technique verrouillé

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

## Frontend app.corya.ch

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
| Région | Frankfurt eu-central-1 | US, Asia |
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
Supabase = DB + Auth + Storage + Realtime dans un seul service, région Frankfurt disponible, tarification prévisible. Coût zéro au démarrage.

**Pourquoi Puppeteer et pas pdfkit ?**
Puppeteer = HTML/CSS pour le template (facile à modifier, testable dans un navigateur), qualité de rendu supérieure. Le coût mémoire du headless Chrome est acceptable pour un usage occasionnel (< 100 PDFs/heure au MVP).

## Ajouts de dépendances

Toute nouvelle dépendance NPM/pip nécessite validation. Critères :

1. **Maintenue activement** : dernière release < 12 mois
2. **Licence commerciale** : MIT, Apache 2.0, ISC OK. GPL non.
3. **Origine** : préférer les libs EU/CH quand disponibles
4. **Alternative** : pourquoi pas construire soi-même en 20 lignes ?

Aucun agent n'ajoute une lib sans que le fondateur ait validé explicitement.
