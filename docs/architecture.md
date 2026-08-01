# Corya — Architecture globale

## Vue d'ensemble

Corya est une plateforme d'accueil téléphonique IA pour cabinets médicaux romands. Ce document décrit l'architecture technique globale, partagée par tous les sub-agents.

## Sous-domaines et responsabilités

| Sous-domaine | Rôle | Stack | Agent responsable |
|---|---|---|---|
| `corya.ch` | Site vitrine marketing | Framer/Astro (TBD) | Non couvert ici |
| `api.corya.ch` | Backend webhook + logique métier | Node.js/Express | `backend-webhook` |
| `app.corya.ch` | Back-office admin interne | Next.js 14 | `frontend-admin` |
| `crm.corya.ch` | CRM prospection interne | Lovable app | Non couvert ici |
| `status.corya.ch` | Page publique de statut | BetterStack | Non couvert ici |
| Supabase (Zurich) | DB + Auth + Storage | PostgreSQL 15 | `database-compliance` |

## Flux principal : un appel entrant

```
1. Patient compose le numéro du cabinet
2. Le cabinet a configuré chez son opérateur un renvoi conditionnel 
   (occupé/hors heures) vers un numéro Peoplefone géré par Corya
3. Peoplefone route l'appel vers Retell AI via SIP trunking
4. L'agent Retell (configuré pour ce cabinet) décroche et gère la conversation
5. En fin d'appel, Retell envoie un webhook à api.corya.ch
6. Backend Corya, de façon SYNCHRONE (doit répondre 200 sous ~10 s, sinon
   Retell retente) :
   - Vérifie la signature du webhook via le SDK Retell
   - Identifie le cabinet via le numéro appelé
   - Extrait les données structurées de l'appel
   - Enregistre l'appel dans la table appels
   - Enfile un job `process_appel` dans la table jobs, puis répond 200
7. Le worker (process séparé) reprend la main de façon ASYNCHRONE :
   - Génère le PDF récap (Puppeteer)
   - Upload le PDF dans Supabase Storage
   - Envoie l'email au cabinet avec le PDF joint
8. La secrétaire du cabinet reçoit l'email et rappelle le patient si besoin
```

## Pipeline asynchrone post-appel

Le traitement lourd ne peut pas se faire dans la requête webhook : Retell exige
un 200 sous ~10 s et retente sinon. D'où une file de travail persistante en
base, qui survit à un redémarrage Jelastic.

### Table `jobs`

Machine à états : `pending → processing → succeeded | failed | dead_letter`.
Il n'y a **pas** d'état `retrying` — un retry est un simple retour à `pending`
avec `run_after` repoussé, ce qui fait de `claim_jobs` le point unique de prise
en charge.

Colonnes de verrouillage : `locked_at` / `locked_by` (et non `started_at`).

Types de jobs enfilés : `process_appel` (pipeline complet PDF → Storage → email)
et `purge_audio_retell` (suppression de l'audio chez Retell à T+48 h). Les types
historiques `generate_pdf` et `send_email` restent dans la contrainte CHECK pour
les lignes anciennes, mais ne sont plus enfilés : ils ont été fusionnés en un
job monolithique.

**`purge_audio_retell` n'a pas encore de handler.** Le worker le route
directement en `dead_letter` (`last_error = 'not_implemented:purge_audio_retell'`)
**sans déclencher d'alerte** — sans quoi chaque appel produirait un email
d'alerte 48 h plus tard. Le silence est borné à ce seul type, listé dans
`KNOWN_UNIMPLEMENTED_JOB_TYPES` (`src/workers/job-worker.ts`) ; tout autre type
non géré reste bruyant. Voir l'écart connu documenté dans `docs/compliance.md`.

### Idempotence

Le job `process_appel` persiste sa progression étape par étape dans sa colonne
`payload` (JSONB), sous `payload.steps` :

| Champ | Signification |
|---|---|
| `pdf_uploaded_at` | Le PDF a été rendu et uploadé |
| `storage_path` | Chemin de l'objet : `{cabinet_id}/{yyyy-mm}/{appel_id}.pdf` |
| `email_sent_at` | L'email a été accepté par le SMTP |

Un retry reprend là où il s'est arrêté. Défense supplémentaire :
`appels.email_status = 'sent'` court-circuite tout envoi.

Fenêtre de rejeu connue et assumée : si le process meurt entre l'accusé SMTP et
l'écriture de `email_sent_at`, le retry renvoie l'email. Sans clé d'idempotence
côté SMTP, c'est structurel. Un récap envoyé deux fois vaut mieux qu'un récap
jamais envoyé.

### Prise de job

`SELECT ... FOR UPDATE SKIP LOCKED` est impossible depuis supabase-js
(PostgREST n'ouvre pas de transaction explicite). La prise est donc déléguée à
Postgres via des RPC `SECURITY DEFINER` réservées au `service_role` :

- `claim_jobs(p_worker_id, p_batch_size DEFAULT 5, p_stale_after_seconds DEFAULT 300)`
  — réserve un **batch** (pas un job unique), retourne `SETOF jobs`. Claim les
  `pending` mûrs **et** les zombies (`processing` verrouillés depuis trop
  longtemps), en priorisant les `pending`. Ne claim jamais un job dont
  `attempts >= max_attempts`. Incrémente `attempts` à la prise, ce qui borne un
  worker qui crashe systématiquement.
- `complete_job(p_job_id)` — passage en `succeeded`.
- `fail_job(p_job_id, p_error, p_backoff_seconds)` — retour à `pending` avec
  backoff, ou `dead_letter` si les tentatives sont épuisées. `p_error` doit être
  **déjà rédacté** : aucune chaîne d'origine externe (Postgres, Puppeteer,
  Nodemailer, Supabase) ne doit y entrer.
- `requeue_stuck_jobs(p_stuck_after DEFAULT '10 minutes')` — filet de sécurité
  en pg_cron. Remet en `pending` les jobs bloqués, et bascule directement en
  `dead_letter` ceux dont les tentatives sont épuisées (sans quoi ils resteraient
  coincés en `pending`, invisibles, jamais alertés).

Le seuil de `claim_jobs` (5 min) est volontairement **plus court** que celui de
`requeue_stuck_jobs` (10 min) : un worker sain doit pouvoir reprendre un zombie
avant que le cron ne s'en mêle.

### Worker

Process **séparé** de l'API (`npm run worker`), en dev comme en prod : Puppeteer
n'a rien à faire dans le process Express. Polling à 2 s, re-drain immédiat après
un batch non vide (nécessaire pour tenir « email en moins de 10 s après le
webhook »), backoff exponentiel avec jitter plafonné à 5 min, arrêt gracieux sur
SIGTERM/SIGINT qui laisse finir les jobs en vol avant de fermer Puppeteer et le
transporteur SMTP.

## Flux secondaire : accès admin

```
1. Fondateur ou père se connecte à app.corya.ch
2. Magic link envoyé à son email pro
3. Après clic, session Supabase créée
4. Middleware Next.js vérifie que l'email est dans admin_users
5. Accès aux dashboards, listes appels, gestion cabinets
6. Toutes les actions loggées dans logs_actions
```

## Communications inter-services

### api.corya.ch ↔ Supabase
- Client Supabase avec service role key (accès complet)
- Aucun accès public direct à Supabase depuis internet

### app.corya.ch ↔ api.corya.ch
- Authentification via JWT Supabase (transmis en header Authorization)
- Backend vérifie le JWT ET que l'email est dans admin_users
- Toutes les mutations passent par l'API, pas directement par Supabase

### app.corya.ch ↔ Supabase (auth uniquement)
- Uniquement pour l'auth (magic link, refresh token)
- Lecture/écriture data toujours via api.corya.ch

### api.corya.ch ↔ Retell
- Webhook entrant : Retell → api.corya.ch (validation signature)
- API sortante : api.corya.ch → Retell (config agents, purge audio)

## Tâches planifiées (pg_cron)

Tous les crons tournent **en UTC** sur Supabase managé, soit 1 à 2 h de décalage
avec l'heure suisse selon la saison. Les horaires ci-dessous sont donc en UTC.

| Job | Planification | Rôle |
|---|---|---|
| `purge-expired-audio` | `0 * * * *` | Suppression de l'audio Retell à 48 h |
| `anonymize-old-transcripts` | `0 3 * * *` | Anonymisation des transcripts à J+7 |
| `purge-old-pdfs` | `30 3 * * *` | Suppression des PDF récap à J+30 |
| `purge-ancient-appels` | `0 4 1 * *` | Suppression des appels à 24 mois |
| `requeue-stuck-jobs` | `*/5 * * * *` | Filet worker : requeue ou `dead_letter` |
| `requeue-stuck-file-deletions` | `*/10 * * * *` | Filet outbox de suppression fichiers |

Les deux derniers ne sont pas des purges nLPD, mais leur arrêt casse
silencieusement la résilience du pipeline : ils sont surveillés au même titre
que les autres.

La suppression physique des fichiers (Storage, audio Retell) ne se fait pas en
SQL : les fonctions de purge alimentent la table `file_deletions_outbox`, que le
backend est censé consommer. Cela garde la logique d'appel externe côté
applicatif.

⚠️ **Ce consommateur n'existe pas encore** (constat Session 4). L'outbox se
remplit, personne ne la vide : les PDF sont déréférencés à J+30 mais leur
binaire reste dans le bucket, et l'audio n'est pas supprimé chez Retell. Écart
détaillé dans `docs/compliance.md`, résolution prévue en Session 5 priorité 1.

## Environnements

- **Local dev** : Node backend sur `localhost:3000`, Next front sur `localhost:3001`, Supabase local optionnel ou instance dev
- **Staging** : `api-staging.corya.ch`, `app-staging.corya.ch`, Supabase projet séparé
- **Prod** : `api.corya.ch`, `app.corya.ch`, Supabase projet prod

Aucun cross-environnement (staging ne parle jamais à la DB prod).

## Sécurité globale

- HTTPS/TLS 1.2+ obligatoire partout
- Secrets dans variables d'environnement Jelastic
- Rate limiting sur endpoints publics (webhook 100 req/s, API interne 10 req/s/user)
- Audit trail obligatoire pour toute action admin (`logs_actions`)
- Purges automatiques nLPD (voir `docs/compliance.md`)
