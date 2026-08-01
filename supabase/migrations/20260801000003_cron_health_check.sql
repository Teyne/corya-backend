-- =============================================================================
-- Corya — Surveillance des crons + élagage cron.job_run_details
-- Date : 2026-08-01
-- Auteur : sub-agent database-compliance
--
-- Session 4 — pièce D du chantier « résilience du worker ».
--
-- OBJECTIF
--   1. Exposer un accès SÛR à cron.job_run_details depuis le backend :
--      le schéma `cron` n'est pas exposé via PostgREST, un
--      supabase.from('cron.job_run_details') échoue. On le fait via une
--      SECURITY DEFINER dans le schéma public.
--   2. Élaguer cron.job_run_details : pg_cron n'élague jamais cette table,
--      elle croît indéfiniment (une ligne par exécution de chaque cron,
--      soit ~458 lignes/jour avec les 8 crons actifs — voir le détail
--      volumétrique dans le bloc §2 plus bas).
--   3. Documenter l'INVENTAIRE RÉEL des 6 crons actifs + le 7e ajouté ici.
--
-- CE QUE J'AI CHANGÉ dans la fonction get_cron_health() proposée
-- ---------------------------------------------------------------
-- Version d'audit du fondateur : voir brief. Modifications :
--
--   1. search_path VERROUILLÉ à `pg_catalog, pg_temp` (au lieu de
--      `cron, public`). Rationale : une SECURITY DEFINER doit résoudre
--      TOUS ses identifiants sans dépendre du search_path de l'appelant.
--      On schéma-qualifie explicitement `cron.job` et `cron.job_run_details`.
--      pg_catalog en tête garantit que les opérateurs et types système
--      restent résolubles. C'est le pattern recommandé côté sécurité PG.
--
--   2. Colonne `last_run_at` AJOUTÉE (dernière exécution quel que soit
--      le statut). Sans elle, on ne peut PAS distinguer :
--        - « ce cron n'a jamais tourné » (nouveau, désactivé silencieuse-
--          ment, jamais planifié)   -> last_run_at NULL, last_success_at NULL
--        - « ce cron tourne mais échoue toujours » (bug applicatif)
--                                    -> last_run_at récent, last_success_at NULL
--        - « ce cron a arrêté de tourner » (pg_cron cassé, base migrée)
--                                    -> last_run_at ancien, last_success_at ancien
--      Cette distinction est nécessaire pour choisir la bonne alerte.
--
--   3. Colonne `total_runs_last_24h` AJOUTÉE : un cron */5 doit produire
--      ~288 exécutions/jour ; un cron horaire, 24 ; un cron quotidien, 1.
--      Écart brutal = signal fort. Coût négligeable (même GROUP BY).
--
--   4. Colonne `failed_runs_last_24h` AJOUTÉE : compléte total_runs_last_24h.
--      Le backend peut calculer un taux d'échec 24 h.
--
--   5. Filtre `d.database = current_database()` : sur Supabase managé les
--      crons tournent tous dans `postgres` (la base par défaut), donc
--      c'est un no-op en pratique. Mais si un jour on ajoute une seconde
--      base au projet, la fonction ne remonte que les crons de la base
--      courante — pas de faux positifs cross-base.
--
--   6. ARRAY_AGG safe : sur zéro ligne, ARRAY_AGG renvoie NULL (pas une
--      erreur), et [1] sur NULL renvoie NULL. C'est le comportement
--      recherché (cron sans exécution = last_status NULL). Rien à changer,
--      mais on documente pour ne pas y revenir.
--
--   7. REVOKE / GRANT identiques à la proposition : execute réservé au
--      service_role.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. get_cron_health — vue de santé de tous les crons actifs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_cron_health()
RETURNS TABLE (
  jobname                        TEXT,
  schedule                       TEXT,
  last_run_at                    TIMESTAMPTZ,
  last_success_at                TIMESTAMPTZ,
  last_status                    TEXT,
  seconds_since_last_run         NUMERIC,
  seconds_since_last_success     NUMERIC,
  total_runs_last_24h            BIGINT,
  failed_runs_last_24h           BIGINT
)
LANGUAGE sql
SECURITY DEFINER
-- search_path minimal : pg_catalog pour les opérateurs/types système,
-- pg_temp obligatoire côté hygiène SECURITY DEFINER. Toutes les tables
-- non-système sont schéma-qualifiées ci-dessous.
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    j.jobname::TEXT,
    j.schedule::TEXT,
    MAX(d.end_time)                                            AS last_run_at,
    MAX(d.end_time) FILTER (WHERE d.status = 'succeeded')      AS last_success_at,
    (ARRAY_AGG(d.status ORDER BY d.start_time DESC NULLS LAST))[1]::TEXT
                                                               AS last_status,
    EXTRACT(EPOCH FROM (NOW() - MAX(d.end_time)))              AS seconds_since_last_run,
    EXTRACT(EPOCH FROM (NOW() - MAX(d.end_time)
                        FILTER (WHERE d.status = 'succeeded'))) AS seconds_since_last_success,
    COUNT(*) FILTER (WHERE d.start_time > NOW() - INTERVAL '24 hours')
                                                               AS total_runs_last_24h,
    COUNT(*) FILTER (WHERE d.start_time > NOW() - INTERVAL '24 hours'
                       AND d.status <> 'succeeded')            AS failed_runs_last_24h
  FROM cron.job j
  LEFT JOIN cron.job_run_details d
    ON d.jobid = j.jobid
   AND d.database = current_database()
  WHERE j.active = true
  GROUP BY j.jobname, j.schedule;
$$;

COMMENT ON FUNCTION public.get_cron_health() IS
  'Santé des crons pg_cron actifs de la base courante. Distingue "jamais '
  'tourné" (last_run_at NULL) de "tourne mais échoue" (last_run_at récent, '
  'last_success_at NULL/ancien). SECURITY DEFINER — appelé par le poller '
  'backend via service_role.';

REVOKE ALL     ON FUNCTION public.get_cron_health() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_cron_health() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_cron_health() TO service_role;


-- -----------------------------------------------------------------------------
-- 2. purge_cron_run_details — élagage de cron.job_run_details
-- -----------------------------------------------------------------------------
-- pg_cron n'élague JAMAIS cette table. La suppression dans le schéma cron
-- nécessite les droits du propriétaire (postgres sur Supabase). D'où
-- SECURITY DEFINER + search_path verrouillé.
--
-- Volumétrie réelle (8 crons actifs après cette migration) :
--
--   purge-expired-audio            0 * * * *      hourly       ~24 /j
--   anonymize-old-transcripts      0 3 * * *      daily          ~1 /j
--   purge-old-pdfs                 30 3 * * *     daily          ~1 /j
--   purge-ancient-appels           0 4 1 * *      monthly     ~0.03 /j
--   requeue-stuck-jobs             */5 * * * *   every 5 min  ~288 /j
--   requeue-stuck-file-deletions   */10 * * * *  every 10 min ~144 /j
--   purge-stale-worker-heartbeats  0 5 * * 0      weekly       ~0.14 /j
--   purge-cron-run-details         30 5 * * 0     weekly       ~0.14 /j
--   -----------------------------------------------------------------
--   Total                                                     ~458 /j
--
--   Rétention 90 jours ⇒ steady state ~41 250 lignes.
--   À ~500 B/ligne (command + status + message), ~20 MB. Absorbable sur
--   Supabase Free (500 MB db) sans marge d'inquiétude.
--
-- Politique : conserver 90 jours (arbitrage fondateur Session 4).
--   Justification : une panne de cron silencieuse peut n'être détectée
--   qu'à la fenêtre de purge mensuelle suivante ; un post-mortem nLPD
--   (art. 24 — notification de violation) doit pouvoir remonter au-delà
--   d'un cycle mensuel pour reconstituer une chaîne d'exécutions
--   défaillantes. 30 jours enferme dans le mois calendaire courant et ne
--   couvre pas les scénarios cross-mois.

CREATE OR REPLACE FUNCTION public.purge_cron_run_details(
  p_retain INTERVAL DEFAULT INTERVAL '90 days'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  DELETE FROM cron.job_run_details
  WHERE end_time IS NOT NULL
    AND end_time < NOW() - p_retain;
  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

COMMENT ON FUNCTION public.purge_cron_run_details(INTERVAL) IS
  'Élague cron.job_run_details des entrées plus anciennes que p_retain. '
  'SECURITY DEFINER : accède au schéma cron avec les droits du propriétaire '
  '(postgres). Cron hebdomadaire.';

REVOKE ALL     ON FUNCTION public.purge_cron_run_details(INTERVAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_cron_run_details(INTERVAL) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_cron_run_details(INTERVAL) TO service_role;


-- -----------------------------------------------------------------------------
-- 3. Planification du cron d'élagage
-- -----------------------------------------------------------------------------
-- Hebdomadaire, dimanche 05:30 UTC (après purge-stale-worker-heartbeats
-- à 05:00, pour ne pas concourir sur la même minute).

DO $$
BEGIN
  PERFORM cron.unschedule('purge-cron-run-details');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-cron-run-details',
  '30 5 * * 0',                       -- dimanche 05:30 UTC
  $$ SELECT public.purge_cron_run_details(); $$
);


-- -----------------------------------------------------------------------------
-- 4. Inventaire des crons (documentation dans la migration)
-- -----------------------------------------------------------------------------
-- 8 crons actifs après cette migration (7 métiers + 1 auto-élagage) :
--
-- | Job                             | Planification    | Rôle                           |
-- |---------------------------------|------------------|--------------------------------|
-- | purge-expired-audio             | 0 * * * *        | nLPD 48h audio Retell          |
-- | anonymize-old-transcripts       | 0 3 * * *        | nLPD J+7 PII patient           |
-- | purge-old-pdfs                  | 30 3 * * *       | nLPD J+30 PDF récap            |
-- | purge-ancient-appels            | 0 4 1 * *        | nLPD 24 mois appels            |
-- | requeue-stuck-jobs              | */5 * * * *      | Résilience worker jobs         |
-- | requeue-stuck-file-deletions    | */10 * * * *     | Résilience worker outbox       |
-- | purge-stale-worker-heartbeats   | 0 5 * * 0        | Hygiène table heartbeats       |
-- | purge-cron-run-details          | 30 5 * * 0       | Hygiène table cron pg_cron     |
--
-- Décision Session 4 : les 8 sont surveillés. Les fenêtres de tolérance
-- exposées côté backend (constantes typées TypeScript) sont documentées
-- dans le rapport de synthèse remis à l'agent principal.


-- =============================================================================
-- Fin de migration.
-- =============================================================================
