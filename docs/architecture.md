# Architecture technique Corya

État local vérifié le 3 août 2026. Les changements vague 7 restent à publier.

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
- finalise succès et échec uniquement avec le lease exact `(worker_id, locked_at)` ;
- réessaie avec backoff, puis passe en `dead_letter` ;
- laisse le poller API réclamer durablement les alertes `dead_letter`, les
  acquitter après SMTP, ou les libérer/reprendre après expiration du lease ;
- met à jour `last_deletion_poll_at`, distinct de la boucle jobs.

Les preuves terminales `deleted` et `not_found` sont purgées lorsque leur
`source_appel_id` n'a plus de ligne `appels`. Les rares preuves sans source
sont purgées 24 mois après `deleted_at`. Un `dead_letter` n'est jamais purgé
automatiquement : il représente une suppression physique potentiellement non
aboutie et reste remédiable.

## Santé et exploitation

- `/health` : liveness légère.
- `/health/deep` : DB, Storage, worker, boucle de suppression, backlog, dix
  crons et SMTP optionnel ; endpoint masqué sans token. L'absence de
  `last_deletion_poll_at` est neutre (`deletion_loop_not_started`) ; une valeur
  de plus de 180 s dégrade le résultat (`deletion_loop_stale`).
- Les erreurs externes sont structurées (`err_name`, message nettoyé, code/détails/hint et une cause) sans données patient.
- Dix crons sont attendus, dont les purges mensuelles de `logs_actions` après
  24 mois et des preuves terminales de l'outbox.
- Un cron nouvellement enregistré reste `pending_first_run` pendant au plus sa période normale ; les crons déjà présents sont seedés à la migration et restent surveillés immédiatement.

## Déploiement restant

Les migrations `20260802000000` à `20260802000003` doivent être appliquées
dans l'ordre avant l'API et le nouveau worker. Elles sont append-only : avant
publication, confirmer avec `supabase migration list` que les quatre versions
sont réellement absentes de la cible. Si l'une existe déjà, ne pas modifier le
fichier historique ; créer une migration correctrice.

Le marqueur SQL `get_wave7_contract_version() = 7` est vérifié au démarrage de
l'API et du worker. Un schéma incomplet provoque donc un échec de démarrage,
avant trafic HTTP ou consommation de l'outbox. Après autorisation, renseigner
`FILE_DELETION_*`, vérifier Retell/SMTP/Storage, appliquer les migrations,
déployer API puis worker, et contrôler `/health/deep`, les deux heartbeats et
les dix crons. Le test SQL local est :

```bash
supabase start
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/wave7_invariants.sql
```

Il utilise une base locale jetable, des données synthétiques et un
`ROLLBACK`; il n'est jamais exécuté contre une cible distante.

En cas d'incident après publication, arrêter ou revenir d'abord le worker pour
interrompre les suppressions, puis revenir à l'API précédente. Préférer ce
rollback applicatif aux migrations down : le schéma vague 7 est additif et le
binaire précédent le tolère. Une suppression Storage, Retell ou
`logs_actions` déjà exécutée ne se défait pas par rollback applicatif ; elle
exige la procédure de restauration du fournisseur ou un backup/PITR validé.
