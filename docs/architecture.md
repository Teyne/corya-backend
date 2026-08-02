# Architecture technique Corya

État vérifié le 2 août 2026.

## Composants

| Composant | Technologie | État |
|---|---|---|
| API `api.corya.ch` | Node.js, Express, TypeScript | implémentée, non déployée sur Jelastic dans ce dépôt |
| Worker | même paquet npm, processus séparé | implémenté |
| Données | Supabase Postgres + Storage privé | schéma versionné par migrations |
| Téléphonie | Retell AI + SDK officiel | webhook et suppression d'appel implémentés |
| PDF | Puppeteer | implémenté |
| E-mail métier | SMTP Infomaniak, port 587 STARTTLS | implémenté |
| Site `corya.ch` | dépôt séparé TanStack Start/React, Lovable, Cloudflare | actif |
| Back-office `app.corya.ch` | aucun code dans les dépôts vérifiés | projet futur |
| BetterStack/status public | configuration annoncée historiquement | non activée/confirmée |

## Chemin d'un appel

1. Express reçoit le webhook Retell et vérifie la signature sur le corps brut.
2. La route répond rapidement, puis la persistance de l'appel et du job est lancée en arrière-plan. Cette séquence conserve un risque connu : une panne DB après le `200` peut acquitter un webhook sans créer de job.
3. Le worker réclame atomiquement les jobs, avec récupération des verrous zombies, checkpoints et backoff.
4. `process_appel` génère le PDF, l'upload dans `pdf-recaps` privé, crée une URL signée courte et envoie l'e-mail.
5. `purge_audio_retell`, planifié à +48 h, supprime l'appel Retell. Un échec est journalisé et alerté mais ne bloque pas la file ; la rétention Retell configurée à un jour sert de filet indépendant.

## Suppressions physiques

Les fonctions SQL inscrivent les suppressions Storage/Retell dans `file_deletions_outbox` avant d'effacer leurs références métier. Une seconde boucle du worker :

- réclame les ordres avec `FOR UPDATE SKIP LOCKED` ;
- traite l'absence distante comme un succès idempotent `not_found` ;
- réessaie avec backoff, puis passe en `dead_letter` et alerte ;
- met à jour `last_deletion_poll_at`, distinct de la boucle jobs.

## Santé et exploitation

- `/health` : liveness légère.
- `/health/deep` : DB, Storage, worker, backlog, neuf crons et SMTP optionnel ; endpoint masqué sans token.
- Les erreurs externes sont structurées (`err_name`, message nettoyé, code/détails/hint et une cause) sans données patient.
- Neuf crons sont attendus, dont la purge mensuelle de `logs_actions` après 24 mois.
- Un cron nouvellement enregistré reste `pending_first_run` pendant au plus sa période normale ; les crons déjà présents sont seedés à la migration et restent surveillés immédiatement.

## Déploiement restant

Les migrations `20260802000000` à `20260802000003` doivent être appliquées dans l'ordre avant le nouveau worker. Il faut ensuite renseigner les variables `FILE_DELETION_*`, vérifier Retell/SMTP/Storage, déployer API et worker, puis contrôler `/health/deep` et les heartbeats. Ces opérations distantes ne sont pas effectuées par la validation locale.
