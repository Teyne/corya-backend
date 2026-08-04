-- Atomically persist a Retell call_analyzed event and its two durable jobs.
-- The RPC either commits all rows or none. Replays repair a historically
-- missing job without recreating one that already reached a terminal state.

CREATE OR REPLACE FUNCTION public.persist_call_analyzed(
  p_appel JSONB,
  p_process_payload JSONB,
  p_purge_payload JSONB,
  p_purge_run_after TIMESTAMPTZ,
  p_correlation_id TEXT DEFAULT NULL
)
RETURNS TABLE(appel_id UUID, duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_appel_id UUID;
  v_inserted BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.appels (
    cabinet_id, retell_call_id, date_appel, duree_secondes,
    numero_appelant_hash, numero_appelant_masque, resultat, motif_appel,
    patient_nom, patient_prenom, patient_telephone, rdv_date,
    rdv_praticien, transcript, transcript_anonymise, audio_url,
    audio_expires_at
  ) VALUES (
    (p_appel->>'cabinet_id')::UUID,
    p_appel->>'retell_call_id',
    (p_appel->>'date_appel')::TIMESTAMPTZ,
    (p_appel->>'duree_secondes')::INTEGER,
    p_appel->>'numero_appelant_hash',
    p_appel->>'numero_appelant_masque',
    p_appel->>'resultat',
    p_appel->>'motif_appel',
    p_appel->>'patient_nom',
    p_appel->>'patient_prenom',
    p_appel->>'patient_telephone',
    (p_appel->>'rdv_date')::TIMESTAMPTZ,
    p_appel->>'rdv_praticien',
    p_appel->>'transcript',
    p_appel->>'transcript_anonymise',
    p_appel->>'audio_url',
    (p_appel->>'audio_expires_at')::TIMESTAMPTZ
  )
  ON CONFLICT (retell_call_id) DO NOTHING
  RETURNING id INTO v_appel_id;

  IF v_appel_id IS NOT NULL THEN
    v_inserted := TRUE;
  ELSE
    SELECT a.id INTO v_appel_id
      FROM public.appels AS a
     WHERE a.retell_call_id = p_appel->>'retell_call_id'
     FOR UPDATE;
    IF v_appel_id IS NULL THEN
      RAISE EXCEPTION 'persist_call_analyzed_conflict_without_row';
    END IF;
  END IF;

  INSERT INTO public.jobs (type, appel_id, payload, correlation_id)
  SELECT 'process_appel', v_appel_id, p_process_payload, p_correlation_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.jobs AS j
     WHERE j.type = 'process_appel' AND j.appel_id = v_appel_id
  );

  INSERT INTO public.jobs (type, appel_id, payload, run_after, correlation_id)
  SELECT 'purge_audio_retell', v_appel_id, p_purge_payload,
         p_purge_run_after, p_correlation_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.jobs AS j
     WHERE j.type = 'purge_audio_retell' AND j.appel_id = v_appel_id
  );

  RETURN QUERY SELECT v_appel_id, NOT v_inserted;
END;
$function$;

COMMENT ON FUNCTION public.persist_call_analyzed(JSONB, JSONB, JSONB, TIMESTAMPTZ, TEXT) IS
  'Atomically persists one call_analyzed appel and its process/purge jobs; replays repair missing jobs.';

REVOKE ALL ON FUNCTION public.persist_call_analyzed(JSONB, JSONB, JSONB, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_call_analyzed(JSONB, JSONB, JSONB, TIMESTAMPTZ, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_call_analyzed(JSONB, JSONB, JSONB, TIMESTAMPTZ, TEXT) TO service_role;
