# Architecture technique Corya

État vérifié le 4 août 2026. Les migrations Wave 7
`20260802000000` à `20260802000003`, la corrective append-only
`20260803000000` et l'intake atomique `20260804010000` sont appliqués sur la
cible Supabase liée. Les environnements Jelastic API et worker exécutent le
même artefact précompilé immuable au SHA Git
`550d9a13406a191d097b76fa96521bc3644facc7` ; leurs contrôles de santé sont
verts. La configuration Retell et calendrier reste une phase distincte avant
l'ouverture à de vrais patients.

## Composants

| Composant | Technologie | État |
|---|---|---|
| API d'essai Jelastic | Node.js 24.18.0, Express, TypeScript, PM2 | active, `/health` et `/health/deep` validés |
| Worker d'essai Jelastic | même paquet npm, processus et environnement séparés | actif, sans accès SLB, Chromium et heartbeats validés |
| Données | Supabase Postgres + Storage privé | schéma versionné par migrations |
| Téléphonie | Retell AI + SDK officiel | webhook et suppression d'appel implémentés |
| PDF | Puppeteer | implémenté |
| E-mail métier | SMTP Infomaniak, port 587 STARTTLS | implémenté |
| Site `corya.ch` | dépôt séparé TanStack Start/React, Lovable, Cloudflare | actif |
| Back-office `app.corya.ch` | aucun code dans les dépôts vérifiés | projet futur |
| BetterStack/status public | configuration annoncée historiquement | non activée/confirmée |

## Chemin d'un appel

1. Express reçoit le webhook Retell et vérifie la signature sur le corps brut.
2. La route appelle `persist_call_analyzed`, qui insère atomiquement l'appel et
   les deux jobs `process_appel` et `purge_audio_retell`. Elle ne répond `200`
   qu'après le commit PostgreSQL. Une panne ou un timeout DB renvoie `500` afin
   que Retell rejoue ; un rejeu est idempotent et répare un type de job absent.
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

## État déployé et travail restant

Les migrations `20260802000000` à `20260802000003`, la corrective
`20260803000000` et l'intake atomique `20260804010000` sont alignés localement
et à distance. La corrective résout le conflit PL/pgSQL observé dans
`get_cron_health()` sans modifier les migrations historiques. L'intake
atomique supprime le risque d'acquitter un `call_analyzed` avant sa persistance
durable. Le 4 août 2026, l'API et le worker Jelastic sont actifs dans deux
environnements séparés. L'API répond en HTTPS et `/health/deep` confirme la DB,
le Storage, le worker, la boucle de suppression, le backlog et les dix crons.
Le worker n'a aucun accès SLB.

Les deux nœuds exécutent l'archive précompilée
`corya-backend-550d9a13-prod.zip`, construite depuis le SHA Git complet
`550d9a13406a191d097b76fa96521bc3644facc7`, avec le SHA-256
`AA345BDDE19026B38BDF2B386B085056724814710FD2FC4D502D24475CF1D878`.
Les condensats des entrypoints, du lockfile et de la configuration PM2 ont été
comparés aux fichiers locaux. Les deux processus sont restés `online` sans
restart ; les preflights, les endpoints de santé, le smoke Chromium et le
contrôle de confidentialité des logs sont verts.

Les heartbeats artificiels `dev-worker-local` et ceux des anciens processus
worker d'essai ont été supprimés de manière ciblée après vérification de leur
absence de job ou de lease actif. Seul le heartbeat du worker courant doit
rester frais. Cette opération n'a affecté ni job, ni lease, ni outbox.

Le marqueur SQL `get_wave7_contract_version() = 7` est vérifié au démarrage de
l'API et du worker. Un schéma incomplet provoque donc un échec de démarrage,
avant trafic HTTP ou consommation de l'outbox. Ces contrôles ont été validés
dans l'essai ; ils devront être rejoués lors de chaque publication de
production. Le test SQL local est :

```bash
supabase start
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/wave7_invariants.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/call_analyzed_intake_invariants.sql
```

Il utilise une base locale jetable, des données synthétiques et un
`ROLLBACK`; il n'est jamais exécuté contre une cible distante.

L'artefact précompilé immuable et son déploiement identique sur les deux rôles
sont validés. L'ouverture à de vrais patients reste conditionnée à un rollback
rejoué avec l'artefact précédent, à la validation des sauvegardes/PITR et de la
rétention des logs, puis à la configuration et aux essais réels de Retell, du
numéro téléphonique, du calendrier et des transferts humains.

En cas d'incident après publication, arrêter ou revenir d'abord le worker pour
interrompre les suppressions, puis revenir à l'API précédente. Préférer ce
rollback applicatif aux migrations down : le schéma vague 7 est additif et le
binaire précédent le tolère. Une suppression Storage, Retell ou
`logs_actions` déjà exécutée ne se défait pas par rollback applicatif ; elle
exige la procédure de restauration du fournisseur ou un backup/PITR validé.
