-- Corya — privacy and SQL privilege hardening.
-- Append-only migration: historical migrations remain immutable.

-- A seven-day-old call must no longer retain patient identity, a linkable
-- caller fingerprint, free text, practitioner identity or transcript data.
CREATE OR REPLACE FUNCTION public.anonymize_old_transcripts()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  anonymized_count INTEGER;
BEGIN
  UPDATE public.appels
  SET patient_nom = NULL,
      patient_prenom = NULL,
      patient_telephone = NULL,
      numero_appelant_hash = NULL,
      numero_appelant_masque = NULL,
      motif_appel = NULL,
      rdv_praticien = NULL,
      transcript = NULL,
      transcript_anonymise = NULL
  WHERE created_at < pg_catalog.now() - INTERVAL '7 days'
    AND (
      patient_nom IS NOT NULL
      OR patient_prenom IS NOT NULL
      OR patient_telephone IS NOT NULL
      OR numero_appelant_hash IS NOT NULL
      OR numero_appelant_masque IS NOT NULL
      OR motif_appel IS NOT NULL
      OR rdv_praticien IS NOT NULL
      OR transcript IS NOT NULL
      OR transcript_anonymise IS NOT NULL
    );

  GET DIAGNOSTICS anonymized_count = ROW_COUNT;
  RETURN anonymized_count;
END;
$$;

COMMENT ON FUNCTION public.anonymize_old_transcripts() IS
  'Efface après 7 jours les identifiants patient, empreintes appelant, textes '
  'libres, praticien et transcripts. Conserve uniquement les dimensions '
  'techniques et agrégables nécessaires aux statistiques de service.';

-- No application role may create objects in the API-exposed public schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- Maintenance/trigger functions are internal capabilities. PostgreSQL grants
-- EXECUTE to PUBLIC by default, so revoke explicitly and keep service_role.
REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;

REVOKE EXECUTE ON FUNCTION public.purge_expired_audio() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_audio() TO service_role;

REVOKE EXECUTE ON FUNCTION public.anonymize_old_transcripts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_old_transcripts() TO service_role;

REVOKE EXECUTE ON FUNCTION public.purge_ancient_appels() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ancient_appels() TO service_role;

REVOKE EXECUTE ON FUNCTION public.purge_old_pdfs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_pdfs() TO service_role;

REVOKE EXECUTE ON FUNCTION public.purge_stale_worker_heartbeats(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_stale_worker_heartbeats(INTERVAL) TO service_role;

-- Legacy SECURITY DEFINER functions already schema-qualify their relations.
-- Remove the writable public schema from name resolution as defence in depth.
ALTER FUNCTION public.is_admin_user() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.claim_jobs(TEXT, INT, INT) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.complete_job(UUID) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.fail_job(UUID, TEXT, INT) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.requeue_stuck_jobs(INTERVAL) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.worker_heartbeat_alive(TEXT, TEXT) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.worker_heartbeat_poll(TEXT, BIGINT) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.fail_job_permanent(UUID, TEXT) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.requeue_stuck_file_deletions() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.claim_file_deletions(TEXT, INTEGER, INTEGER) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.worker_heartbeat_deletion_poll(TEXT, BIGINT) SET search_path = pg_catalog, pg_temp;
