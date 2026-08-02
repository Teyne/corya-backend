-- =============================================================================
-- Corya — Purge de logs_actions à 24 mois
-- Date : 2026-08-02
-- Auteur : sub-agent database-compliance
--
-- Session 4 — vague 7, pièce B : fermeture de l'écart §5.4 (« logs_actions n'a
-- aucune purge planifiée alors que 24 mois sont annoncés »).
--
-- CONTEXTE
--   docs/compliance.md annonce une rétention de 24 mois pour les logs
--   d'actions admin. La table `public.logs_actions` est en place depuis
--   20260730120000 (initial_schema.sql §3.4) mais AUCUNE purge n'a jamais été
--   planifiée. Sans cette migration, les entrées s'accumulent indéfiniment,
--   ce qui est doublement problématique :
--     - conformité : rétention de fait > 24 mois annoncés (art. 6 nLPD,
--       limitation de la conservation).
--     - opérationnel : la table est peu volumineuse par ligne, mais peut
--       porter dans `metadata` des snapshots JSONB potentiellement lourds
--       si un cabinet fait beaucoup de manipulations admin.
--
-- MODÈLE
--   Calqué EXACTEMENT sur `purge_ancient_appels` (20260731100000) : même
--   sémantique de purge par ancienneté, même signature INTEGER, même style.
--   La différence : `logs_actions` ne référence AUCUN fichier externe, donc
--   pas d'ordre à enfiler dans `file_deletions_outbox` — un DELETE simple
--   suffit.
--
-- NON-RÉGRESSION
--   - CREATE OR REPLACE + DO block défensif autour de cron.unschedule : la
--     migration est idempotente et rejouable, cohérent avec l'existant.
--   - La table `public.logs_actions` peut être en usage réel avec des lignes
--     déjà anciennes de plus de 24 mois — improbable en pratique (produit
--     lancé en 2026) mais géré : le premier passage du cron supprimera ces
--     lignes-là, ensuite régime stationnaire.
--   - `logs_actions.user_id` est déjà `ON DELETE SET NULL` vers `admin_users`
--     (initial_schema §3.4). Aucun effet cascade à craindre côté ce DELETE.
--
-- CONFORMITÉ
--   - art. 6 nLPD (limitation de la conservation) : alignement de la
--     rétention effective sur celle annoncée en documentation.
--   - art. 7 nLPD (transparence) : la doc annonçait 24 mois, la réalité le
--     respecte désormais — plus d'écart doc/technique sur ce point.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Fonction de purge
-- -----------------------------------------------------------------------------
-- 24 mois est une durée absolue par rapport à `created_at`. On ne cherche pas
-- à distinguer par type d'action ni par entité : la doc annonce 24 mois pour
-- l'ensemble.
--
-- Pas de SECURITY DEFINER (comme purge_ancient_appels) : la fonction est
-- appelée par pg_cron sous l'identité `postgres`, qui possède la table
-- `public.logs_actions`. Aucun besoin d'élévation de privilèges.

CREATE OR REPLACE FUNCTION public.purge_ancient_logs_actions()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  DELETE FROM public.logs_actions
  WHERE created_at < NOW() - INTERVAL '24 months';

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

COMMENT ON FUNCTION public.purge_ancient_logs_actions() IS
  'Supprime les entrées de logs_actions plus anciennes que 24 mois. '
  'Aligne la rétention effective sur celle annoncée dans docs/compliance.md. '
  'Base légale : art. 6 nLPD (limitation de la conservation).';


-- -----------------------------------------------------------------------------
-- 2. Planification pg_cron
-- -----------------------------------------------------------------------------
-- Choix du créneau : mensuel, décalé du 1er du mois pour NE PAS coïncider
-- avec `purge-ancient-appels` (planifié '0 4 1 * *' dans 20260730120000).
--
-- Inventaire complet des crons AVANT cette migration (cf. 20260801000003 §4) :
--
--   purge-expired-audio            0 * * * *      hourly
--   anonymize-old-transcripts      0 3 * * *      daily 03:00 UTC
--   purge-old-pdfs                 30 3 * * *     daily 03:30 UTC
--   purge-ancient-appels           0 4 1 * *      monthly (1er, 04:00 UTC)
--   requeue-stuck-jobs             */5 * * * *   every 5 min
--   requeue-stuck-file-deletions   */10 * * * *  every 10 min
--   purge-stale-worker-heartbeats  0 5 * * 0      weekly (dim. 05:00)
--   purge-cron-run-details         30 5 * * 0     weekly (dim. 05:30)
--
-- Créneau retenu : '17 4 15 * *' — le 15 de chaque mois à 04:17 UTC.
--
-- Justification :
--   - Mensuel : la table croît lentement, une purge mensuelle est très
--     suffisante (la marge est calculée en années, pas en jours).
--   - Le 15 du mois : décorrélé de purge-ancient-appels (1er). On répartit
--     la charge des purges mensuelles sur deux dates distinctes plutôt que
--     de tout empiler le 1er.
--   - 04:17 UTC : minute 17, non alignée avec */5 (00,05,10,15,20...) ni
--     avec */10 ni avec l'heure pile de purge-expired-audio (:00). pg_cron
--     ne fait pas de lock global, mais garder les fenêtres distinctes
--     simplifie la lecture de cron.job_run_details en cas d'incident.
--   - 04:xx UTC : plage nocturne européenne, comme les autres purges nLPD.
--
-- On passe à **9 crons actifs**. L'inventaire volumétrique de 20260801000003
-- §2 (~458 lignes/jour dans cron.job_run_details, ~41 250 lignes à 90 jours)
-- devient ~458,03 lignes/jour — variation négligeable, aucune mise à jour
-- de commentaire nécessaire dans la migration d'élagage.

DO $$
BEGIN
  PERFORM cron.unschedule('purge-ancient-logs-actions');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-ancient-logs-actions',
  '17 4 15 * *',                      -- le 15 du mois à 04:17 UTC
  $$ SELECT public.purge_ancient_logs_actions(); $$
);


-- =============================================================================
-- Fin de migration.
-- =============================================================================
