# Architecture technique Corya

État revu le 22 août 2026. Le schéma versionné couvre Wave 7, l'intake Retell
atomique, le portail multi-tenant et le registre/réconciliation Cal.com. Les
environnements Jelastic API et worker sont déployés depuis le même artefact
précompilé immuable ; leur provenance exacte et leurs condensats sont relevés
dans chaque rapport de déploiement. L'environnement reste une démonstration
contrôlée, sans ouverture à de vrais patients.

## Composants

| Composant | Technologie | État |
|---|---|---|
| API d'essai Jelastic | Node.js 24.18.0, Express, TypeScript, PM2 | active, `/health` et `/health/deep` validés |
| Worker d'essai Jelastic | même paquet npm, processus et environnement séparés | actif, sans accès SLB, Chromium et heartbeats validés |
| Données | Supabase Postgres + Storage privé | schéma versionné par migrations |
| Téléphonie | Retell AI + SDK officiel | webhook et suppression d'appel implémentés |
| Calendrier | Cal.com + webhook HMAC dédié | réservation pilotée par Retell ; registre technique Corya idempotent |
| PDF | Puppeteer | implémenté |
| E-mail métier | SMTP Infomaniak, port 587 STARTTLS | implémenté |
| Site `corya.ch` | dépôt séparé TanStack Start/React, Lovable, Cloudflare | actif |
| Portail `portail.corya.ch` | React/Lovable + Supabase Auth, RLS tenant | actif en démonstration |
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

### Numéro de rappel

Le numéro utilisable pour un rappel est distinct du Caller ID technique. Le
backend n'accepte que les formats suisses `+41`, `0041` ou nationaux `0...`,
les normalise en E.164 et rejette les textes, extensions, pays étrangers,
longueurs ou préfixes incohérents. Un numéro explicitement confirmé dans
l'analyse Retell est prioritaire ; à défaut, le Caller ID validé sert de
compatibilité. Le booléen strict `rappel_autorise = false` interdit ce fallback
et laisse `patient_telephone` vide. Le hash et le masque techniques du Caller ID
restent séparés du consentement de rappel et aucun numéro n'est journalisé.

## Registre et réconciliation Cal.com

Cal.com reste la source de vérité de la réservation. Le webhook
`POST /webhooks/calcom/booking` vérifie `x-cal-signature-256` sur le corps brut,
accepte uniquement les événements de création, déplacement, annulation et
rejet, puis réduit immédiatement le payload à une liste blanche technique.
Le corps brut, le nom, l'e-mail, le téléphone, les réponses de formulaire,
les notes et les URL de réunion ne sont jamais persistés ni journalisés.

`calendar_booking_events` fournit la clé d'idempotence du webhook et
`calendar_bookings` conserve uniquement le cabinet, les UID fournisseur,
l'event type, l'état et les horaires. La réconciliation avec `appels` accepte
les deux ordres d'arrivée Retell/Cal.com. Une réservation Cal.com confirmée
est autoritaire : si le parcours est `prendre_rendez_vous` et que le couple
appel/réservation est unique dans les deux directions, la même transaction lie
les lignes et impose `resultat = rdv_pris` ainsi que l'horaire fournisseur dans
`rdv_date`, même si l'analyse Retell avait retourné `echec` ou aucune valeur.
La preuve repose toujours sur un événement Cal.com de création ou de
déplacement dans la fenêtre technique de l'appel ; lorsqu'un `rdv_date` Retell
existe, il sert uniquement de filtre de cohérence avec l'horaire fournisseur.
Un cas absent, incohérent ou ambigu reste non lié et n'est jamais promu.

Pour éviter qu'un PDF ou un e-mail ne fige l'analyse Retell avant l'arrivée du
webhook calendrier, le job `process_appel` d'un parcours rendez-vous non encore
rapproché est différé de cinq minutes. Une réconciliation réussie l'accélère
immédiatement ; le worker effectue encore une dernière réconciliation et relit
la ligne `appels` avant tout rendu durable. Cette grâce constitue un SLO borné,
pas une garantie de livraison fournisseur : un webhook exceptionnellement reçu
après cinq minutes peut corriger la base sans pouvoir rectifier un e-mail déjà
envoyé.
Les deux tables sont privées (RLS, aucun droit `anon`/`authenticated`) et sont
purgées après 24 mois par le cron mensuel existant.

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

L'API et le worker Jelastic utilisent deux environnements séparés ; le worker
n'a aucun accès SLB. Chaque vague est livrée worker puis API depuis une archive
précompilée identique et fait l'objet d'un contrôle de condensats, des
preflights de rôle, de PM2 et de `/health/deep`. Les migrations sont appliquées
avant le binaire qui les consomme. Les migrations sont append-only : le
rollback normal revient au binaire précédent et ne tente pas de supprimer les
tables nouvellement créées.

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
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/calcom_booking_registry_invariants.sql
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
