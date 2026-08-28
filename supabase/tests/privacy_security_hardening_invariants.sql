\set ON_ERROR_STOP on

BEGIN;

DO $test$
DECLARE
  v_proc REGPROCEDURE;
  v_name TEXT;
  v_hardened REGPROCEDURE[] := ARRAY[
    'public.is_admin_user()'::REGPROCEDURE,
    'public.claim_jobs(text,integer,integer)'::REGPROCEDURE,
    'public.complete_job(uuid)'::REGPROCEDURE,
    'public.fail_job(uuid,text,integer)'::REGPROCEDURE,
    'public.requeue_stuck_jobs(interval)'::REGPROCEDURE,
    'public.worker_heartbeat_alive(text,text)'::REGPROCEDURE,
    'public.worker_heartbeat_poll(text,bigint)'::REGPROCEDURE,
    'public.fail_job_permanent(uuid,text)'::REGPROCEDURE,
    'public.requeue_stuck_file_deletions()'::REGPROCEDURE,
    'public.claim_file_deletions(text,integer,integer)'::REGPROCEDURE,
    'public.worker_heartbeat_deletion_poll(text,bigint)'::REGPROCEDURE
  ];
  v_internal REGPROCEDURE[] := ARRAY[
    'public.update_updated_at()'::REGPROCEDURE,
    'public.purge_expired_audio()'::REGPROCEDURE,
    'public.anonymize_old_transcripts()'::REGPROCEDURE,
    'public.purge_ancient_appels()'::REGPROCEDURE,
    'public.purge_old_pdfs()'::REGPROCEDURE,
    'public.purge_stale_worker_heartbeats(interval)'::REGPROCEDURE
  ];
  v_config TEXT[];
BEGIN
  IF pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'public_schema_create_privilege_exposed';
  END IF;

  FOREACH v_proc IN ARRAY v_hardened LOOP
    SELECT p.proconfig INTO STRICT v_config
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = v_proc::OID;
    IF NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
      v_name := v_proc::TEXT;
      RAISE EXCEPTION 'unsafe_security_definer_search_path function=% config=%',
        v_name, v_config;
    END IF;
  END LOOP;

  FOREACH v_proc IN ARRAY v_internal LOOP
    IF pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE') THEN
      v_name := v_proc::TEXT;
      RAISE EXCEPTION 'internal_function_acl_wrong function=%', v_name;
    END IF;
  END LOOP;
END;
$test$;

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut
) VALUES (
  'd2000000-0000-4000-8000-000000000001',
  'Synthetic retention cabinet', 'synthetic-retention-cabinet',
  '+41000000401', 'retention@example.invalid', 'actif'
);

INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes,
  numero_appelant_hash, numero_appelant_masque, resultat, motif_appel,
  patient_nom, patient_prenom, patient_telephone, rdv_date, rdv_praticien,
  transcript, transcript_anonymise, email_status, created_at
) VALUES (
  'd3000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001', 'retention-call-001',
  pg_catalog.now() - INTERVAL '8 days', 60,
  'SYNTHETIC_HASH', 'SYNTHETIC_MASK', 'rdv_pris', 'SYNTHETIC_MOTIF',
  'SYNTHETIC_LASTNAME', 'SYNTHETIC_FIRSTNAME', 'SYNTHETIC_PHONE',
  pg_catalog.now() + INTERVAL '1 day', 'SYNTHETIC_PRACTITIONER',
  'SYNTHETIC_TRANSCRIPT', 'SYNTHETIC_ANON_TRANSCRIPT', 'sent',
  pg_catalog.now() - INTERVAL '8 days'
);

SET LOCAL ROLE service_role;
SELECT public.anonymize_old_transcripts();
RESET ROLE;

DO $test$
DECLARE
  v_call public.appels%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_call
    FROM public.appels
   WHERE id = 'd3000000-0000-4000-8000-000000000001';

  IF v_call.patient_nom IS NOT NULL
     OR v_call.patient_prenom IS NOT NULL
     OR v_call.patient_telephone IS NOT NULL
     OR v_call.numero_appelant_hash IS NOT NULL
     OR v_call.numero_appelant_masque IS NOT NULL
     OR v_call.motif_appel IS NOT NULL
     OR v_call.rdv_praticien IS NOT NULL
     OR v_call.transcript IS NOT NULL
     OR v_call.transcript_anonymise IS NOT NULL THEN
    RAISE EXCEPTION 'seven_day_sensitive_fields_not_purged';
  END IF;

  IF v_call.resultat IS DISTINCT FROM 'rdv_pris'
     OR v_call.duree_secondes IS DISTINCT FROM 60
     OR v_call.rdv_date IS NULL THEN
    RAISE EXCEPTION 'aggregate_service_fields_unexpectedly_changed';
  END IF;
END;
$test$;

ROLLBACK;

SELECT 'PRIVACY_SECURITY_HARDENING_INVARIANTS_PASS' AS result;
