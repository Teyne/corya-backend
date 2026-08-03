# Session 4 — état complet

Dernière mise à jour : 2026-08-02, soir — post-merge PR #8, migrations appliquées,
validation locale effectuée.

Ce document sert de source de vérité pour reprendre la Session 4 après une
coupure. Il est écrit parce que le brief de la Session 4 avait été rédigé
depuis une documentation qui ne décrivait pas le code réel — voir §1.

---

## 1. Les 7 écarts entre le brief initial et le code réel

Le brief de Session 4 supposait un worker qui n'est pas celui construit en
Session 3. Cause racine : `docs/architecture.md` décrivait encore le
traitement post-webhook comme **synchrone** — ni worker, ni table `jobs`, ni
checkpoints n'y figuraient. Les docs n'avaient pas divergé, elles étaient
muettes. **Corrigé pendant cette session** (voir §4).

| # | Le brief supposait | La réalité |
|---|---|---|
| 1 | `claim_next_job(p_worker_id)`, un job à la fois | `claim_jobs(p_worker_id, p_batch_size DEFAULT 5, p_stale_after_seconds DEFAULT 300)` → `SETOF public.jobs`, **par batch**. Aucune fonction `claim_next_job` n'existe. |
| 2 | Statut `running` | Statut **`processing`**. États : `pending → processing → succeeded \| failed \| dead_letter`. Pas d'état `retrying` : un retry est un retour à `pending`. |
| 3 | Colonne `started_at` | Colonnes **`locked_at`** / **`locked_by`**. |
| 4 | Checkpoints `pdf_done`, `storage_done`, `email_done` | **`payload.steps.{pdf_uploaded_at, storage_path, email_sent_at}`** (JSONB). Le déclencheur `pdf_orphelin` = `storage_path` présent + `email_sent_at` absent. |
| 5 | Le reclaim des zombies n'existait pas, « l'appel est perdu définitivement » | `requeue_stuck_jobs()` existait **déjà** en pg_cron toutes les 5 min. Le vrai défaut était ailleurs : un zombie épuisé était rejoué une fois de trop (risque de renvoi d'email) — voir §2.1. |
| 6 | 4 crons actifs, `purge-old-pdfs` à `0 4 * * *` | **6 crons actifs** (8 après les migrations de cette session), et `purge-old-pdfs` tourne à **`30 3 * * *`** (03:30 **UTC**). |
| 7 | Le piège `RETURNS jobs` renvoyant une ligne de NULLs | Ne s'applique pas : `RETURNS SETOF` donne un **tableau vide** côté supabase-js. Test de non-régression ajouté malgré tout. |

Point connexe : `/health` existait déjà **inline dans `src/index.ts`**, sans
`routes/health.ts` et sans `uptime_seconds`. Il a été extrait dans
`src/routes/health.ts` pendant cette session.

---

## 2. Les 5 corrections du fondateur

### 2.1 Filtre `attempts` dans `requeue_stuck_jobs` **ET** `claim_jobs`

Le point le plus important de la session. Si seul `claim_jobs` filtre sur
`attempts < max_attempts`, un job épuisé remis en `pending` par le cron n'est
plus jamais claim : il reste **coincé en `pending` indéfiniment, invisible,
sans jamais atteindre `dead_letter`**, donc sans jamais déclencher d'alerte.
Pire que le rebond `pending`/`processing` initialement redouté.

Corrigé aux deux endroits. `requeue_stuck_jobs` bascule désormais directement
en `dead_letter` les jobs bloqués dont les tentatives sont épuisées, avec
`last_error = 'stuck_job_exhausted_attempts'` (constante, sans PII).

Corollaire imposé : le SQL ne peut pas envoyer d'email. D'où la colonne
`jobs.dead_letter_alerted_at`, écrite **exclusivement par le backend, après
un envoi SMTP confirmé**, pour que le poller API alerte exactement une fois.

### 2.2 Heartbeat à deux champs

- `last_seen_at` — `setInterval` **indépendant** de la boucle de polling,
  période 10 s (`WORKER_HEARTBEAT_INTERVAL_MS`), seuil d'alerte **60 s**.
  Répond à « le process est vivant ».
- `last_poll_at` — écrit à **chaque tick** de la boucle, seuil **180 s**.
  Répond à « la boucle tourne ».

Un seul champ donnerait soit des fausses alertes sur batch lent, soit un
angle mort sur worker bloqué dans un job qui pend.

### 2.3 Fenêtre de rejeu email : assumée et documentée

Entre l'accusé SMTP et l'écriture de `payload.steps.email_sent_at`, si le
process meurt, le retry renvoie l'email. **Sans clé d'idempotence côté SMTP,
c'est structurel.** Décision : réduire la fenêtre au minimum, la documenter,
assumer le doublon. Un récap envoyé deux fois vaut mieux qu'un récap jamais
envoyé. Ne pas y consacrer de temps.

### 2.4 WARN explicite au démarrage si `ALERT_ENABLED=false`

Émis sur l'**API et le worker**. Il ne doit pas être possible de croire que
les alertes tournent alors qu'elles sont coupées. Un second WARN distinct
signale le cas « alerting actif mais `ALERT_EMAIL` absent ».

### 2.5 Correction des docs

`docs/architecture.md` et `docs/stack.md` remis en phase avec le code réel,
pour que la divergence à l'origine des 7 écarts ne survive pas à la session.

---

## 3. Arbitrages

| Sujet | Décision | Motif |
|---|---|---|
| Rate limiting | **Implémentation maison**, pas `express-rate-limit` | Un compteur global à fenêtre fixe fait ~25 lignes. La librairie apporterait surtout le piège `ERR_ERL_PERMISSIVE_TRUST_PROXY`, qui ne se manifeste qu'en prod. |
| Mock SMTP en test | **Pas de `nodemailer-mock`** | `email.ts` expose déjà `__setTransporterForTests`, utilisé par les tests existants. La lib dupliquerait une infra qui marche. |
| Portée du check crons | **Les 6 (puis 8) crons surveillés**, pas seulement les 4 purges nLPD | `requeue-stuck-jobs` et `requeue-stuck-file-deletions` ne sont pas des purges, mais leur arrêt casse silencieusement toute la résilience. |
| `ALERT_EMAIL`, `HEALTH_DEEP_TOKEN` | **Requises en production uniquement** | Les rendre requises partout casserait `npm run dev` et la suite de tests tant que `.env.local` n'est pas à jour. |
| Heartbeat | **10 s** (pas à chaque tick de 2 s) | À 2 s, 43 000 écritures/jour/worker pour aucun signal supplémentaire, le seuil de détection étant à 60 s. |
| `cron.job_run_details` | **90 jours** de rétention | Décidé par le fondateur pour l'audit long. ⚠️ **La migration `20260801000003` porte encore 30 jours** — voir §5. |
| Registre art. 12 | **Vague 6**, pas vague 1 | Rédaction juridique, ne bloque personne, et plus juste écrite une fois le dispositif d'alerting en place. |
| Format du registre | **Fichier markdown versionné**, pas de table ni d'endpoint | Document à produire au PFPDT sur demande, pas une API. Git donne en plus un historique horodaté qui prouve la tenue à jour. |
| Zéro nouvelle dépendance npm | Tenu sur toute la session | — |

---

## 4. Fait et vérifié

Vérifications faites par l'agent principal lui-même, pas seulement rapportées
par les sub-agents.

### Vague 1 — migrations (`database-compliance`)
- `20260801000000_claim_jobs_reclaim.sql` — reclaim des zombies dans
  `claim_jobs`, filtre `attempts` aux deux endroits, bascule `dead_letter`
  dans `requeue_stuck_jobs`, colonne `dead_letter_alerted_at` + index partiel.
- `20260801000001_worker_heartbeats.sql` — table + RPC
  `worker_heartbeat_alive` / `worker_heartbeat_poll`, RLS deny-by-default.
- `20260801000002_jobs_correlation_id.sql` — colonne nullable, aucun backfill.
- `20260801000003_cron_health_check.sql` — `get_cron_health()` en
  `SECURITY DEFINER`, `search_path` verrouillé à `pg_catalog, pg_temp`,
  + élagage de `cron.job_run_details`.
- `20260801000004_fail_job_permanent.sql` — RPC de bascule `dead_letter`
  ignorant délibérément `attempts`, pour les erreurs SMTP permanentes.

Le seuil de `claim_jobs` (5 min) est **strictement inférieur** à celui de
`requeue_stuck_jobs` (10 min) : un worker sain doit pouvoir reprendre un
zombie avant que le cron ne s'en mêle.

### Vague 2 — résilience + alerting (117 tests)
`alert.ts` (dédup en mémoire, ne throw jamais), `alert-pollers.ts`
(`worker_stale`, `jobs_backlog`, poller `dead_letter`), heartbeat à deux
champs, `dead_letter` propre. Les pollers tournent dans l'**API**, pas dans
le worker : un worker mort ne peut pas signaler sa propre mort.

### Vague 3 — retry SMTP, timeouts, correlation ID (146 tests)
Classification transitoire/permanent des erreurs SMTP (550/551/553/554 →
échec immédiat, pas 5 tentatives sur une adresse invalide), `withTimeout` sur
toutes les I/O externes avec `AbortController` côté Supabase et
`page.setDefaultTimeout` côté Puppeteer, middleware de correlation ID avec
validation de l'en-tête entrant.

### Vague 4 — health + rate limit (176 tests)
`/health/deep` protégé par `X-Health-Token` en comparaison à temps constant
(avec garde de longueur avant `timingSafeEqual`), 404 si invalide, cache 60 s
avec single-flight, 5 checks + `smtp` sur `?full=1` uniquement. Rate limiter
maison, global et non par IP. `trust proxy` en valeur **numérique**.

### Vague 5 — recâblage RPC, e2e, doc (176 unit + 5 e2e)
`forceDeadLetter` recâblé sur `fail_job_permanent`. Tests e2e **hermétiques**
(aucun SMTP réel, aucune base réelle) couvrant reclaim, `dead_letter` après
`max_attempts`, et `pdf_orphelin` avec contrôle d'absence de PII.
README et `docs/compliance.md` à jour.

### Docs
`docs/architecture.md` et `docs/stack.md` corrigés par l'agent principal.
`docs/registre-traitements.md` rédigé (7 traitements, transferts US
documentés, traitement 6 marqué non actif).

---

## 5. Ce qui reste

### 5.1 Correctif d'alerting sur type de job non implémenté — ✅ **fait**

`appel.ts:205` enfile un job `purge_audio_retell` à chaque appel, à +48 h. Le
worker ne gère que `process_appel` et routait tout autre type vers `failJob` →
`dead_letter`. Avant la Session 4 c'était silencieux ; **depuis la vague 2,
chaque `dead_letter` déclenche une alerte**. Au premier déploiement : flux
d'alertes pour un mécanisme jamais implémenté.

Correctif appliqué : `KNOWN_UNIMPLEMENTED_JOB_TYPES` (`src/workers/job-worker.ts`)
route `purge_audio_retell` directement en `dead_letter` via `fail_job_permanent`,
avec `last_error = 'not_implemented:purge_audio_retell'` (chaîne constante, pas
de concaténation d'erreur externe), log `job_type_known_but_unimplemented`, et
**aucune alerte**. Un type réellement inconnu conserve `failJob` + alerte. Trois
tests : type connu-non-implémenté silencieux, type inconnu bruyant, et défense en
profondeur (échec de `forceDeadLetter` ne réveille pas l'alerte). Le test
préexistant qui utilisait `purge_audio_retell` comme exemple de « type inconnu »
a été requalifié sur un type factice. Documenté dans `docs/compliance.md` et
`docs/architecture.md`.

### 5.2 `cron.job_run_details` à 90 jours — ✅ **fait**

La migration `20260801000003` n'ayant jamais été poussée, la valeur a été
corrigée **en place** (`p_retain INTERVAL DEFAULT INTERVAL '90 days'`) plutôt que
par une migration correctrice, qui aurait pollué l'historique pour rien.
Volumétrie recalculée au passage : le commentaire annonçait ~2 000 lignes/jour,
le vrai chiffre sur les 8 crons schedulés est **~458/jour**, soit ~41 250 lignes
(~20 MB) en régime stationnaire à 90 jours — sans effet sur le quota Supabase
Free. `CRON_TOLERANCES_SECONDS['purge-cron-run-details']` reste à 8 jours : cette
tolérance porte sur la fréquence d'exécution, pas sur la rétention.

### 5.3 Écart de conformité majeur — `file_deletions_outbox` sans consommateur *(historique, résolu localement en vague 7)*

Le constat ci-dessous décrit l'état observé le 1er août, avant la vague 7. Il
ne décrit plus le code local : la boucle de consommation, les finalisations
fencées et l'alerting persistant sont désormais implémentés ; voir §10 pour le
contrat de publication restant.

**À la date de ce constat, aucun fichier de `src/` ne référençait
`file_deletions_outbox`.** Vérifié directement. Conséquences :

- `purge_old_pdfs()` met `pdf_url` à NULL et enfile un ordre de suppression,
  **mais personne ne le consomme**. Le binaire reste dans le bucket
  `pdf-recaps` indéfiniment, avec nom du patient, téléphone et transcript.
- L'audio Retell n'est jamais supprimé non plus.

La garantie annoncée en Session 3 (« aucun PDF ne survit plus de 30 jours »)
est vraie de la migration SQL, **fausse du système** : la moitié applicative
n'existe pas. L'audit nLPD de Session 3 ne l'avait pas vu — il examinait le
pipeline PDF/email, pas la chaîne de suppression.

Lot à part, décision du fondateur en attente : implémenter le consommateur
d'outbox + l'appel API Retell de suppression d'enregistrement.

L'écart est désormais **écrit noir sur blanc** dans `docs/compliance.md`
(encadré « Écart connu ») et dans `docs/architecture.md`, plutôt que laissé
implicite dans une doc qui décrivait un consommateur inexistant. Tant qu'il
subsiste, la rétention effective de l'audio est celle du dashboard Retell — à
vérifier et documenter côté fondateur.

### 5.4 Deux écarts mineurs remontés par le registre

- **BetterStack** est déclaré comme sous-traitant dans `docs/compliance.md`
  mais n'apparaît que dans un fichier de test. Soit l'ingestion se fait
  uniquement côté Jelastic (à confirmer), soit l'entrée doit être retirée ou
  marquée « prévue, non active ».
- **`logs_actions`** n'a aucune purge planifiée alors que 24 mois sont
  annoncés. Se règle en une petite migration.

### 5.5 Points nécessitant une validation juridique (registre)

Qualification sous-traitant vs responsable conjoint, validité du consentement
exprès par annonce au décroché, terminologie « anonymisé » vs
« pseudonymisé » pour le transcript à 24 mois, formulation des CCT suisses,
création effective de `privacy@corya.ch`, DPA cabinet ↔ Corya.

### 5.6 Livraison

PR `feat(session4): worker resilience, alerting, robustness, nLPD art.12
registre` — créée une fois §5.1 et §5.2 traités. État à la livraison :
**178 tests unitaires + 5 e2e verts**, `type-check` et `lint` propres.

Après merge, côté fondateur : `supabase db push` (5 migrations
`20260801000000` à `20260801000004`), mise à jour de `.env.local` avec les 19
nouvelles variables, génération de `HEALTH_DEEP_TOKEN`. Si §5.4 (purge
`logs_actions`) est traité plus tard, le compte de migrations à pousser
changera.

---

## 6. Écarts découverts pendant la validation locale (1er août, soir)

Trois écarts supplémentaires entre la documentation et la réalité, découverts
en appliquant les migrations et en validant le pipeline en local. Même famille
que les 7 du §1. **À corriger en vague 7.**

### 6.1 Schéma réel de la table `jobs`

Relevé via `information_schema.columns`. Les noms annoncés dans les docs
depuis la Session 3 sont faux :

| Doc annonçait | Colonne réelle |
|---|---|
| `worker_id` | **`locked_by`** |
| `started_at` | **`locked_at`** |
| `scheduled_for` | **`run_after`** |
| `error` | **`last_error`** |
| `retell_call_id` | **n'existe pas** — c'est `appel_id` (UUID, colonne dédiée) |
| `completed_at` | n'existe pas |

Schéma complet réel : `id`, `type`, `appel_id`, `payload`, `status`,
`attempts`, `max_attempts`, `run_after`, `locked_at`, `locked_by`,
`last_error`, `created_at`, `updated_at`, `dead_letter_alerted_at`,
`correlation_id`.

Le schéma réel est meilleur que celui de la doc : `appel_id` en colonne
dédiée plutôt qu'enfoui dans le payload, et `dead_letter_alerted_at` pour
l'exactement-une-fois.

### 6.2 Pas de `package.json` à la racine — pas de workspaces npm

`git ls-files | grep '^package'` ne retourne rien. Le fichier n'a **jamais
été versionné** et n'existe pas sur disque. Le dépôt n'est pas un monorepo
npm workspaces : c'est une arborescence de dossiers avec un seul projet npm,
`apps/backend/`.

**Toutes les commandes `npm` se lancent depuis `apps/backend/`.** Toutes les
commandes `git`, `gh`, `supabase` et celles touchant `.env.local` se lancent
depuis la racine.

Les docs annoncent « monorepo workspaces » depuis la Session 1. À corriger
dans `docs/architecture.md`, `docs/stack.md`, `CLAUDE.md` et
`corya_architecture_technique.md`.

Ne pas créer de `package.json` racine à ce stade : le hoisting des
`node_modules` déplacerait Chromium et les chemins Puppeteer, pour zéro
bénéfice.

### 6.3 Deux migrations de la Session 3 n'avaient jamais été appliquées

Le premier `supabase db push` a révélé deux migrations en attente :
`20260731100000_job_claim_and_pdf_purge.sql` et
`20260731110000_purge_old_pdfs_cover_unsent.sql`. Les docs de Session 3
affirmaient pourtant « migrations appliquées ✅ ».

Appliquées le 1er août sans incident. Leçon : vérifier l'état réel via
`supabase db push` (qui liste avant d'agir) plutôt que de se fier à la doc.

### 6.4 `never_run` traité comme un échec — faux positif sur tout cron neuf

`cron-check.ts` classe `last_run_at IS NULL` en `reason: 'never_run'`, donc en
échec. Conséquence immédiate : les deux crons hebdomadaires créés par les
migrations de cette session (`purge-cron-run-details` et
`purge-stale-worker-heartbeats`, tous deux le dimanche) déclenchent
`cron_stale` dès le premier poller et jusqu'à leur première exécution.

Tentative de contournement écartée : appeler les fonctions manuellement en SQL
n'écrit rien dans `cron.job_run_details` — seul pg_cron y écrit lors de ses
exécutions planifiées.

**Correctif à faire en vague 7** : un cron actif dont la création est plus
récente que sa période d'exécution ne doit pas être considéré en panne.
Piste : comparer avec une date de création de job, ou introduire un statut
neutre `pending_first_run` distinct de l'échec.

### 6.5 `ALERT_ENABLED=false` — temporaire, à réactiver

Conséquence de §6.4. Mis à `false` dans `.env.local` le 1er août pour éviter
un flux d'alertes en fausse alarme pendant la validation locale.

**À remettre à `true` le dimanche 2 août au soir**, après le premier passage
des deux crons hebdomadaires. Alarme posée côté fondateur (02.08, 20h).

Le WARN `alerting_disabled` au démarrage de l'API et du worker (correction
§2.4) est la garantie que cet état ne passe pas inaperçu. Vérifié en local :
le poller détecte bien `cron_stale` et loggue `alert_suppressed_disabled` —
toute la chaîne fonctionne, seule la sortie email est coupée.

---

## 7. État de la validation locale (1er août, soir)

Tout ce qui suit a été vérifié manuellement sur la machine du fondateur.

| Élément | Résultat |
|---|---|
| PR #8 | Mergée sur `main` (`5daf2fb`) |
| Migrations | 5 appliquées (`20260801000000` → `20260801000004`) + 2 rattrapées de la Session 3 |
| Tests | **178 unitaires verts**, `type-check` propre |
| `.env.local` | 51 variables, `diff` avec `.env.example` vide |
| Worker | Démarre. `worker_id: dev-worker-local`, `poll_ms: 2000`, `batch: 5`, `stale_after_seconds: 300`, `heartbeat_interval_ms: 10000` |
| API | Démarre sur le port 3000, correlation ID présent dans toutes les réponses |
| WARN alerting | Émis sur l'API **et** le worker ✅ |
| `alert_suppressed_disabled` | Émis sur `cron_stale` ✅ — détection OK, sortie coupée |
| `/health/deep` sans token | **404** `{"error":"not_found"}` ✅ |
| `/health/deep` avec token | **503 `degraded`** — `db` ok (246 ms), `storage` ok (282 ms), `worker` ok (`last_seen_seconds_ago: 1`), `jobs_backlog` ok, `crons` ko (2 × `never_run`, attendu) |
| Fuite d'info | Aucune URL, aucun ID interne, aucun nom de bucket dans la réponse ✅ |
| `get_cron_health()` | Fonctionne — 8 crons, 0 échec, `purge-old-pdfs` bien à `30 3 * * *` |
| Reclaim manuel | **Non testé** — `test:email-pipeline` court-circuite (`email_already_sent_skip`) et n'enfile aucun job réel. Couvert par `worker-resilience.e2e.test.ts`. |

Le script `test:email-pipeline` appelle le processeur directement avec un
`job_id` factice (`00000000-0000-0000-0000-000000000001`) : il ne passe pas
par la file `jobs`. Pour un test de reclaim manuel, il faut insérer un job
réel et utiliser le flag `force_resend` du script.

---

## 8. Contexte externe acté le 1er août

### Retell — rétention audio

Ramenée à **1 jour** dans le dashboard. C'est la seule garantie réelle sur
l'audio tant que §5.3 n'est pas traité (le job `purge_audio_retell` part en
`dead_letter` silencieux).

Retell propose trois niveaux de stockage : intégralité des données, tout sauf
les PII (scrubbing), ou attributs de base seulement (métadonnées, sans
enregistrements ni transcriptions). **À évaluer** : un niveau plus restrictif
réduirait l'exposition art. 321 CP, mais il faut vérifier par un appel de test
que le payload webhook contient toujours nom, téléphone et motif — sans quoi
le PDF récap serait incomplet.

### Peoplefone — numéro obtenu

- Numéro : **+41 32 552 00 11** (préfixe 032 Neuchâtel, conforme à la cible)
- SIP trunking vers un tiers : **autorisé**
- ⚠️ **Numéro d'essai** : test jusqu'au **31.08.2026**, incapacité à partir du
  10.09.2026, retiré le 30.10.2026. À convertir en abonnement payant avant fin
  août, sous peine de perdre le numéro après avoir configuré le trunking et
  possiblement communiqué le numéro à un prospect.

### Supabase — DPA

Data Processing Addendum intégré aux Terms of Service v3, effectif le
01.08.2026. Aucun DPA signé séparément n'est nécessaire. Documents archivés
côté fondateur. Restent à obtenir : **Retell** et **Infomaniak**.

---

## 9. Périmètre réalisé localement en vague 7

Par ordre de priorité :

1. **§5.3** — consommateur `file_deletions_outbox` + suppression audio côté
   Retell. Écart de conformité majeur.
2. **§5.4** — purge `logs_actions` à 24 mois ; BetterStack marqué « prévu,
   non actif » dans `docs/compliance.md` et le registre.
3. **§6.4** — `never_run` sur cron récent ne doit pas être un échec.
4. **§6.1 / §6.2** — corriger `docs/architecture.md`, `docs/stack.md` et
   `CLAUDE.md` : noms de colonnes réels de `jobs`, absence de workspaces npm,
   commandes npm depuis `apps/backend/`.

Piste structurelle à évoquer : générer la documentation du schéma depuis la
base plutôt que de l'écrire à la main. Trois écarts doc/code découverts en une
seule journée — le problème est le procédé, pas les occurrences.

---

## 10. Vague 7 — état local final (3 août 2026)

La vague 7 raccorde localement le consommateur de `file_deletions_outbox`, la
suppression Retell, la purge `logs_actions`, le registre `cron_first_seen`, le
heartbeat de suppression et les finalisations concurrentes sûres. Les appels
`complete_file_deletion` et `fail_file_deletion` n'agissent que si le couple
`(worker_id, locked_at)` correspond encore au lease obtenu par le claim.

Les alertes `file_deletion_dead_letter` ne sont plus émises par le worker : un
poller API persistant les réclame sous lease, les marque remises seulement après
SMTP confirmé, les libère en cas d'échec et les reprend après expiration. Les
preuves terminales `deleted` / `not_found` sont purgées avec leur appel source,
ou 24 mois après `deleted_at` sans source ; les `dead_letter` restent pour
remédiation. Dix crons sont attendus, dont les purges terminale d'outbox et de
`logs_actions`.

`/health/deep` expose la boucle de suppression : `last_deletion_poll_at = NULL`
est neutre (`deletion_loop_not_started`), tandis qu'une valeur de plus de 180 s
dégrade le health (`deletion_loop_stale`). L'API et le worker vérifient avant
tout démarrage `get_wave7_contract_version() = 7`; un schéma vague 7 incomplet
est donc fail-fast.

Ces changements ne sont pas déployés. Avant publication, confirmer par
`supabase migration list` que les quatre migrations
`20260802000000`–`20260802000003` sont réellement non appliquées. Elles sont
append-only : si l'une est déjà appliquée, ne pas la modifier et créer une
migration correctrice. Si elles sont absentes, les appliquer dans cet ordre
avant l'API puis le worker. Valider le contrat uniquement sur Supabase local
jetable :

```bash
supabase start
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/wave7_invariants.sql
```

Le script n'utilise que des identifiants synthétiques et annule ses mutations.
En incident, arrêter/revenir d'abord le worker, puis l'API ; conserver les
migrations additives. Les suppressions physiques déjà effectuées et les lignes
`logs_actions` purgées nécessitent une restauration fournisseur ou backup/PITR,
pas un rollback applicatif. BetterStack reste prévu/non confirmé.
