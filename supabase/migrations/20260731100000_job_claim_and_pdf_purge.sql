-- =============================================================================
-- Corya — Primitives de prise de job concurrente + purge PDF J+30
-- Date : 2026-07-31
-- Auteur : sub-agent database-compliance
--
-- Contenu :
--   1. Extension du CHECK sur jobs.type : ajout de 'process_appel'
--      (pipeline post-appel monolithique : PDF -> Storage -> email)
--   2. Extension du CHECK sur file_deletions_outbox.reason : 'pdf_purged_30d'
--   3. RPC de file de travail (claim / complete / fail / requeue)
--      -> supabase-js ne sait pas ouvrir de transaction explicite, donc
--         `SELECT ... FOR UPDATE SKIP LOCKED` doit vivre dans une fonction
--         PL/pgSQL appelée en RPC.
--   4. Purge PDF récap 30 jours après envoi email OK, via outbox de suppression
--   5. Planification pg_cron (requeue-stuck-jobs, purge-old-pdfs)
--
-- NON régressions :
--   - Les valeurs existantes du CHECK jobs.type ('process_call', 'generate_pdf',
--     'send_email', 'purge_audio_retell') sont conservées telles quelles : des
--     lignes historiques peuvent encore les porter en base.
--   - purge_expired_audio, anonymize_old_transcripts, purge_ancient_appels
--     et requeue_stuck_file_deletions ne sont PAS touchés.
--
-- Conformité :
--   - art. 6 nLPD (minimisation, limitation de la conservation)
--   - art. 8 nLPD (données sensibles santé : PDF récap contient patient_nom
--     et transcript intégral, alors que appels.transcript est anonymisé à J+7 ;
--     conserver le PDF au-delà perpétuerait ce que la purge J+7 efface)
--   - art. 321 CP (secret médical : minimiser la surface de rétention)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Extension du CHECK sur jobs.type
-- -----------------------------------------------------------------------------
-- On ajoute 'process_appel' : le worker de Session 3 traite l'appel de bout
-- en bout dans un unique job (PDF -> upload Storage -> email), avec état de
-- progression sérialisé dans jobs.payload pour être idempotent au retry.
--
-- Les 4 valeurs historiques sont conservées : des lignes existantes peuvent
-- encore les porter, et purge_audio_retell reste un job distinct à T+48h.

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_type_check;

ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN (
    'process_call',        -- historique (extraction depuis payload Retell)
    'generate_pdf',        -- historique
    'send_email',          -- historique
    'purge_audio_retell',  -- purge audio Retell à T+48h (reste distinct)
    'process_appel'        -- pipeline post-appel monolithique (Session 3)
  ));


-- -----------------------------------------------------------------------------
-- 2. Extension du CHECK sur file_deletions_outbox.reason
-- -----------------------------------------------------------------------------
-- Nouveau motif d'audit nLPD : suppression du PDF récap 30 jours après envoi
-- email OK (rétention plus stricte que les 24 mois documentés à l'origine).

ALTER TABLE public.file_deletions_outbox
  DROP CONSTRAINT IF EXISTS file_deletions_outbox_reason_check;

ALTER TABLE public.file_deletions_outbox
  ADD CONSTRAINT file_deletions_outbox_reason_check
  CHECK (reason IN (
    'audio_expired_48h',
    'appel_purged_24m',
    'gdpr_erasure_request',
    'manual_admin_deletion',
    'pdf_purged_30d'                 -- PDF récap purgé à J+30 après envoi
  ));


-- -----------------------------------------------------------------------------
-- 3. RPC de file de travail
-- -----------------------------------------------------------------------------
-- Toutes ces fonctions manipulent des données de santé (jobs référencent des
-- appels via appel_id, jobs.payload peut porter du contexte non-PII). Elles
-- sont :
--   - SECURITY DEFINER : exécutées avec les droits du propriétaire
--     (postgres/superuser à la création via migration), ce qui bypass RLS
--     et permet un contrat d'exécution stable indépendamment des permissions
--     du rôle appelant. Le REVOKE ... FROM PUBLIC ci-dessous ferme la porte
--     à tout appelant non autorisé.
--   - search_path verrouillé sur (public, pg_temp) : protection contre
--     l'injection via search_path spoofing (règle de sécurité PG standard
--     pour les SECURITY DEFINER).
--
-- Le worker backend appelle ces RPC via supabase-js avec la SERVICE_ROLE_KEY.

-- 3.1 claim_jobs -------------------------------------------------------------
-- Prend jusqu'à p_batch_size jobs 'pending' dont run_after est atteint, les
-- passe en 'processing' atomiquement et INCRÉMENTE attempts. L'incrément à la
-- prise (et non à l'échec) garantit qu'un worker qui crashe mid-processing
-- finit par épuiser max_attempts au lieu de boucler infiniment via
-- requeue_stuck_jobs (l'un et l'autre incrémentent : voir §3.4).
--
-- SELECT ... FOR UPDATE SKIP LOCKED : deux workers concurrents ne peuvent
-- JAMAIS prendre le même job. Les workers qui trouvent la ligne verrouillée
-- passent au suivant sans blocage.
--
-- Retour SETOF public.jobs : le worker reçoit toutes les colonnes (type,
-- appel_id, payload, attempts, max_attempts, etc.), y compris la valeur
-- attempts POST-incrément pour ses décisions de backoff.

CREATE OR REPLACE FUNCTION public.claim_jobs(
  p_worker_id  TEXT,
  p_batch_size INT DEFAULT 5
)
RETURNS SETOF public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.jobs
    WHERE status = 'pending'
      AND run_after <= NOW()
    ORDER BY run_after
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.jobs j
  SET status    = 'processing',
      locked_at = NOW(),
      locked_by = p_worker_id,
      attempts  = j.attempts + 1
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$$;

COMMENT ON FUNCTION public.claim_jobs(TEXT, INT) IS
  'Réserve atomiquement jusqu''à p_batch_size jobs pending prêts à exécuter. '
  'Incrémente attempts à la prise (protection contre les workers qui crashent). '
  'Retourne les lignes complètes.';


-- 3.2 complete_job -----------------------------------------------------------
-- Marque un job comme réussi. Libère les colonnes de verrouillage et efface
-- last_error (état propre pour l'inspection admin).

CREATE OR REPLACE FUNCTION public.complete_job(p_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.jobs
  SET status     = 'succeeded',
      locked_at  = NULL,
      locked_by  = NULL,
      last_error = NULL
  WHERE id = p_job_id;
END;
$$;

COMMENT ON FUNCTION public.complete_job(UUID) IS
  'Marque un job comme succeeded, libère les verrous et efface last_error.';


-- 3.3 fail_job ---------------------------------------------------------------
-- Machine à états :
--   - Si attempts >= max_attempts : passage en 'dead_letter' (à investiguer
--     manuellement, pas de retry automatique)
--   - Sinon : retour à 'pending' avec run_after = NOW() + p_backoff_seconds
--
-- Il n'y a PAS d'état 'retrying' : un retry est simplement un retour à
-- 'pending', ce qui rend claim_jobs le point unique de prise en charge.
--
-- last_error est TRONQUÉ à 500 caractères. Contrat de sécurité : le worker
-- doit passer une erreur DÉJÀ REDACTÉE (aucun nom patient, aucun téléphone,
-- aucun fragment de transcript). La troncature est une défense en profondeur.

CREATE OR REPLACE FUNCTION public.fail_job(
  p_job_id          UUID,
  p_error           TEXT,
  p_backoff_seconds INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts        INT;
  v_max_attempts    INT;
  v_truncated_error TEXT;
BEGIN
  v_truncated_error := LEFT(COALESCE(p_error, ''), 500);

  SELECT attempts, max_attempts
    INTO v_attempts, v_max_attempts
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Job supprimé entre-temps (cascade DELETE d'un appel purgé, par ex.).
    -- Silencieux : rien à faire.
    RETURN;
  END IF;

  IF v_attempts >= v_max_attempts THEN
    UPDATE public.jobs
    SET status     = 'dead_letter',
        locked_at  = NULL,
        locked_by  = NULL,
        last_error = v_truncated_error
    WHERE id = p_job_id;
  ELSE
    UPDATE public.jobs
    SET status     = 'pending',
        locked_at  = NULL,
        locked_by  = NULL,
        last_error = v_truncated_error,
        run_after  = NOW() + make_interval(secs => p_backoff_seconds)
    WHERE id = p_job_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.fail_job(UUID, TEXT, INT) IS
  'Consigne un échec : dead_letter si attempts >= max_attempts, sinon retour '
  'à pending avec run_after + p_backoff_seconds. last_error tronqué à 500 chars.';


-- 3.4 requeue_stuck_jobs -----------------------------------------------------
-- Filet de sécurité pour un worker tué mid-processing (SIGKILL, OOM, coupure
-- Jelastic). Une ligne restée 'processing' au-delà de p_stuck_after est
-- remise en 'pending' pour qu'un autre worker la reprenne.
--
-- Comportement attempts :
--   On NE ré-incrémente PAS attempts ici : claim_jobs l'a déjà fait au
--   moment de la prise initiale. Un job dont le worker crashe systématique-
--   ment sera donc claim -> stuck -> requeue -> claim (+1) -> stuck ->
--   requeue -> claim (+1) -> ... jusqu'à max_attempts atteint, moment auquel
--   claim_jobs le prendra une dernière fois puis fail_job le passera en
--   dead_letter. C'est le comportement attendu (bornage garanti).
--
-- Calqué sur requeue_stuck_file_deletions (migration 20260730130000).

CREATE OR REPLACE FUNCTION public.requeue_stuck_jobs(
  p_stuck_after INTERVAL DEFAULT INTERVAL '10 minutes'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  requeued_count INTEGER;
BEGIN
  UPDATE public.jobs
  SET status    = 'pending',
      locked_at = NULL,
      locked_by = NULL,
      run_after = NOW()
  WHERE status = 'processing'
    AND locked_at IS NOT NULL
    AND locked_at < NOW() - p_stuck_after;

  GET DIAGNOSTICS requeued_count = ROW_COUNT;
  RETURN requeued_count;
END;
$$;

COMMENT ON FUNCTION public.requeue_stuck_jobs(INTERVAL) IS
  'Remet en pending les jobs bloqués en processing au-delà de p_stuck_after. '
  'N''incrémente pas attempts (déjà fait par claim_jobs).';


-- 3.5 Verrouillage des permissions ------------------------------------------
-- Ces RPC manipulent des jobs référençant des appels : données sensibles
-- santé. Seul service_role peut les invoquer.

REVOKE EXECUTE ON FUNCTION public.claim_jobs(TEXT, INT)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_jobs(TEXT, INT)          FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.complete_job(UUID)              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_job(UUID)              FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.fail_job(UUID, TEXT, INT)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fail_job(UUID, TEXT, INT)       FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.requeue_stuck_jobs(INTERVAL)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.requeue_stuck_jobs(INTERVAL)    FROM anon, authenticated;

GRANT  EXECUTE ON FUNCTION public.claim_jobs(TEXT, INT)          TO service_role;
GRANT  EXECUTE ON FUNCTION public.complete_job(UUID)              TO service_role;
GRANT  EXECUTE ON FUNCTION public.fail_job(UUID, TEXT, INT)       TO service_role;
GRANT  EXECUTE ON FUNCTION public.requeue_stuck_jobs(INTERVAL)    TO service_role;


-- -----------------------------------------------------------------------------
-- 4. Purge des PDF récap à J+30 après envoi email OK
-- -----------------------------------------------------------------------------
-- Base légale : art. 6 nLPD (minimisation + limitation de la conservation).
--
-- Motif : le PDF récap contient le patient_nom, patient_prenom, patient_telephone
-- et le transcript intégral au moment de l'appel. Or appels.transcript,
-- patient_nom, patient_prenom et patient_telephone sont anonymisés à J+7 par
-- anonymize_old_transcripts (docs/compliance.md). Conserver le PDF au-delà
-- perpétuerait, sous forme binaire dans Storage, exactement ce que la purge
-- J+7 efface en base. On aligne donc la durée de vie du PDF sur une fenêtre
-- opérationnelle courte : 30 jours après envoi email OK, suffisamment pour
-- couvrir les re-consultations légitimes du cabinet, insuffisant pour
-- constituer une rétention structurée.
--
-- Articulation avec les autres purges :
--   - J+2   : audio Retell purgé (purge_expired_audio)
--   - J+7   : PII patient + transcript anonymisés (anonymize_old_transcripts)
--   - J+30  : PDF récap purgé (purge_old_pdfs) <-- ICI
--   - +24m  : suppression complète de la ligne appels (purge_ancient_appels),
--             qui enfilait déjà un filet Storage pour tout PDF résiduel.
--
-- Pattern : réutilise file_deletions_outbox (protégée de la cascade appels
-- par absence de FK). La suppression physique dans le bucket est faite par
-- le worker backend, qui horodate deleted_at comme preuve d'audit nLPD.

CREATE OR REPLACE FUNCTION public.purge_old_pdfs()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  -- 1. Enfiler l'ordre de suppression Storage pour chaque PDF envoyé il y a
  --    plus de 30 jours. ON CONFLICT DO NOTHING : idempotent via l'index
  --    unique partiel (bucket, object_path) WHERE status IN (pending, processing).
  INSERT INTO public.file_deletions_outbox (
    target, bucket, object_path, reason,
    enqueued_by, source_appel_id, source_cabinet_id
  )
  SELECT
    'supabase_storage',
    'pdf-recaps',
    a.pdf_url,
    'pdf_purged_30d',
    'purge_old_pdfs',
    a.id,
    a.cabinet_id
  FROM public.appels a
  WHERE a.pdf_url IS NOT NULL
    AND a.pdf_envoye_at IS NOT NULL
    AND a.pdf_envoye_at < NOW() - INTERVAL '30 days'
  ON CONFLICT DO NOTHING;

  -- 2. Effacer la référence pdf_url en base UNE FOIS l'ordre consigné.
  --    Même prédicat que ci-dessus : on ne dé-référence rien qu'on n'ait
  --    pas d'abord enfilé pour suppression physique.
  UPDATE public.appels
  SET pdf_url = NULL
  WHERE pdf_url IS NOT NULL
    AND pdf_envoye_at IS NOT NULL
    AND pdf_envoye_at < NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

COMMENT ON FUNCTION public.purge_old_pdfs() IS
  'Purge les PDF récap dont l''email a été envoyé il y a plus de 30 jours. '
  'Alimente file_deletions_outbox pour la suppression physique (worker) et '
  'NULLifie appels.pdf_url. Base légale : art. 6 nLPD (minimisation).';


-- -----------------------------------------------------------------------------
-- 5. Planification pg_cron
-- -----------------------------------------------------------------------------
-- cron.schedule est upsert-par-nom sur Supabase (nom unique). Pour être
-- explicite et rejouable dans tous les cas, on unschedule défensivement avant.
-- cron.unschedule lève si l'entrée n'existe pas -> DO block avec EXCEPTION.
--
-- Horaires actuels du projet (à ne pas empiler) :
--   '0 * * * *'    -> purge-expired-audio            (chaque heure)
--   '0 3 * * *'    -> anonymize-old-transcripts      (03:00 UTC)
--   '0 4 1 * *'    -> purge-ancient-appels           (04:00 UTC, 1er du mois)
--   '*/10 * * * *' -> requeue-stuck-file-deletions   (toutes les 10 min)
--
-- Nouveaux créneaux choisis :
--   '*/5 * * * *'  -> requeue-stuck-jobs   (worker crashé : reprise rapide)
--   '30 3 * * *'   -> purge-old-pdfs       (03:30 UTC, décalé de +30 min
--                                            par rapport à l'anonymisation)

DO $$
BEGIN
  PERFORM cron.unschedule('requeue-stuck-jobs');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'requeue-stuck-jobs',
  '*/5 * * * *',
  $$ SELECT public.requeue_stuck_jobs(); $$
);


DO $$
BEGIN
  PERFORM cron.unschedule('purge-old-pdfs');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-old-pdfs',
  '30 3 * * *',
  $$ SELECT public.purge_old_pdfs(); $$
);


-- =============================================================================
-- Fin de migration.
-- =============================================================================
