\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut
) VALUES (
  'a4000000-0000-4000-8000-000000000001',
  'Synthetic intake test', 'synthetic-intake-test', '+41000000001',
  'synthetic@example.invalid', 'actif'
);

-- The privileged intake RPC must stay inaccessible to user-facing roles and
-- must execute with a fixed, non-public search path.
DO $test$
DECLARE
  v_proc REGPROCEDURE :=
    'public.persist_call_analyzed(jsonb,jsonb,jsonb,timestamp with time zone,text)'::REGPROCEDURE;
  v_security_definer BOOLEAN;
  v_config TEXT[];
BEGIN
  IF pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon_can_execute_persist_call_analyzed';
  END IF;
  IF pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated_can_execute_persist_call_analyzed';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role_cannot_execute_persist_call_analyzed';
  END IF;

  SELECT p.prosecdef, p.proconfig
    INTO v_security_definer, v_config
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_proc::OID;

  IF NOT COALESCE(v_security_definer, FALSE) THEN
    RAISE EXCEPTION 'persist_call_analyzed_not_security_definer';
  END IF;
  IF NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
    RAISE EXCEPTION 'persist_call_analyzed_search_path_not_fixed config=%', v_config;
  END IF;
END;
$test$;

-- Success creates the appel and exactly both intents.
DO $test$
DECLARE
  v_result RECORD;
BEGIN
  SELECT * INTO STRICT v_result FROM public.persist_call_analyzed(
    '{"cabinet_id":"a4000000-0000-4000-8000-000000000001","retell_call_id":"synthetic-intake-success","date_appel":"2026-08-04T00:00:00Z"}',
    '{"version":1,"steps":{}}',
    '{"retell_call_id":"synthetic-intake-success"}',
    '2026-08-05T00:00:00Z',
    'synthetic-correlation'
  );
  IF v_result.duplicate IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'first_intake_not_marked_new duplicate=%', v_result.duplicate;
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_appel UUID;
  v_count INTEGER;
  v_process_count INTEGER;
  v_purge_count INTEGER;
BEGIN
  SELECT id INTO v_appel FROM public.appels
   WHERE retell_call_id = 'synthetic-intake-success';
  SELECT
    count(*),
    count(*) FILTER (
      WHERE type = 'process_appel'
        AND payload = '{"version":1,"steps":{}}'::JSONB
        AND status = 'pending'
        AND run_after = CURRENT_TIMESTAMP
        AND correlation_id = 'synthetic-correlation'
    ),
    count(*) FILTER (
      WHERE type = 'purge_audio_retell'
        AND payload = '{"retell_call_id":"synthetic-intake-success"}'::JSONB
        AND status = 'pending'
        AND run_after = '2026-08-05T00:00:00Z'::TIMESTAMPTZ
        AND correlation_id = 'synthetic-correlation'
    )
    INTO v_count, v_process_count, v_purge_count
    FROM public.jobs
   WHERE appel_id = v_appel;
  IF v_count <> 2 THEN RAISE EXCEPTION 'expected_two_jobs got=%', v_count; END IF;
  IF v_process_count <> 1 THEN
    RAISE EXCEPTION 'process_job_contract_mismatch got=%', v_process_count;
  END IF;
  IF v_purge_count <> 1 THEN
    RAISE EXCEPTION 'purge_job_contract_mismatch got=%', v_purge_count;
  END IF;

  -- Simulate the historical crash between enqueues, then replay.
  DELETE FROM public.jobs
   WHERE appel_id = v_appel AND type = 'purge_audio_retell';
END;
$test$;

DO $test$
DECLARE
  v_result RECORD;
BEGIN
  SELECT * INTO STRICT v_result FROM public.persist_call_analyzed(
    '{"cabinet_id":"a4000000-0000-4000-8000-000000000001","retell_call_id":"synthetic-intake-success","date_appel":"2026-08-04T00:00:00Z"}',
    '{"version":1,"steps":{}}',
    '{"retell_call_id":"synthetic-intake-success"}',
    '2026-08-05T00:00:00Z',
    'synthetic-correlation-replay'
  );
  IF v_result.duplicate IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'replay_not_marked_duplicate duplicate=%', v_result.duplicate;
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_appel UUID;
  v_count INTEGER;
  v_repaired_purge_count INTEGER;
BEGIN
  SELECT id INTO v_appel FROM public.appels
   WHERE retell_call_id = 'synthetic-intake-success';
  SELECT
    count(*),
    count(*) FILTER (
      WHERE type = 'purge_audio_retell'
        AND payload = '{"retell_call_id":"synthetic-intake-success"}'::JSONB
        AND run_after = '2026-08-05T00:00:00Z'::TIMESTAMPTZ
        AND correlation_id = 'synthetic-correlation-replay'
    )
    INTO v_count, v_repaired_purge_count
    FROM public.jobs
   WHERE appel_id = v_appel;
  IF v_count <> 2 THEN RAISE EXCEPTION 'replay_did_not_repair got=%', v_count; END IF;
  IF v_repaired_purge_count <> 1 THEN
    RAISE EXCEPTION 'repaired_purge_job_contract_mismatch got=%', v_repaired_purge_count;
  END IF;

  -- A replay must never recreate or overwrite a terminal job.
  UPDATE public.jobs
     SET status = 'succeeded'
   WHERE appel_id = v_appel AND type = 'process_appel';
END;
$test$;

DO $test$
DECLARE
  v_result RECORD;
  v_appel UUID;
  v_terminal_count INTEGER;
BEGIN
  SELECT * INTO STRICT v_result FROM public.persist_call_analyzed(
    '{"cabinet_id":"a4000000-0000-4000-8000-000000000001","retell_call_id":"synthetic-intake-success","date_appel":"2026-08-04T00:00:00Z"}',
    '{"version":999,"steps":{"unexpected":"must-not-overwrite"}}',
    '{"retell_call_id":"synthetic-intake-success"}',
    '2026-08-06T00:00:00Z',
    'synthetic-correlation-terminal-replay'
  );
  IF v_result.duplicate IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'terminal_replay_not_marked_duplicate duplicate=%', v_result.duplicate;
  END IF;

  SELECT id INTO STRICT v_appel FROM public.appels
   WHERE retell_call_id = 'synthetic-intake-success';
  SELECT count(*) INTO v_terminal_count
    FROM public.jobs
   WHERE appel_id = v_appel
     AND type = 'process_appel'
     AND status = 'succeeded'
     AND payload = '{"version":1,"steps":{}}'::JSONB
     AND correlation_id = 'synthetic-correlation';
  IF v_terminal_count <> 1 THEN
    RAISE EXCEPTION 'terminal_job_recreated_or_overwritten got=%', v_terminal_count;
  END IF;
  IF (SELECT count(*) FROM public.jobs
       WHERE appel_id = v_appel AND type = 'process_appel') <> 1 THEN
    RAISE EXCEPTION 'terminal_job_was_duplicated';
  END IF;
END;
$test$;

-- A failure on the second insert rolls back the appel and first job too.
DO $test$
BEGIN
  BEGIN
    PERFORM public.persist_call_analyzed(
      '{"cabinet_id":"a4000000-0000-4000-8000-000000000001","retell_call_id":"synthetic-intake-rollback","date_appel":"2026-08-04T00:00:00Z"}',
      '{"version":1,"steps":{}}',
      '{"retell_call_id":"synthetic-intake-rollback"}',
      NULL,
      'synthetic-correlation-failure'
    );
    RAISE EXCEPTION 'expected_not_null_failure';
  EXCEPTION WHEN not_null_violation THEN
    NULL;
  END;

  IF EXISTS (SELECT 1 FROM public.appels WHERE retell_call_id = 'synthetic-intake-rollback') THEN
    RAISE EXCEPTION 'appel_survived_failed_transaction';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.jobs
     WHERE correlation_id = 'synthetic-correlation-failure'
  ) THEN
    RAISE EXCEPTION 'first_job_survived_failed_transaction';
  END IF;
END;
$test$;

-- An unresolved appointment waits for the bounded Cal.com webhook grace
-- instead of becoming immediately claimable by the PDF/email worker.
DO $test$
DECLARE
  v_before TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_result RECORD;
  v_run_after TIMESTAMPTZ;
BEGIN
  SELECT * INTO STRICT v_result FROM public.persist_call_analyzed(
    '{"cabinet_id":"a4000000-0000-4000-8000-000000000001","retell_call_id":"synthetic-intake-appointment-grace","date_appel":"2026-08-04T01:00:00Z","resultat":"echec","motif_appel":"prendre_rendez_vous"}',
    '{"version":1,"steps":{}}',
    '{"retell_call_id":"synthetic-intake-appointment-grace"}',
    '2026-08-06T01:00:00Z',
    'synthetic-correlation-appointment-grace'
  );

  SELECT run_after INTO STRICT v_run_after
    FROM public.jobs
   WHERE appel_id = v_result.appel_id
     AND type = 'process_appel';

  IF v_run_after < v_before + INTERVAL '295 seconds'
     OR v_run_after > pg_catalog.clock_timestamp() + INTERVAL '305 seconds' THEN
    RAISE EXCEPTION 'appointment_grace_out_of_bounds run_after=%', v_run_after;
  END IF;
END;
$test$;

ROLLBACK;
SELECT 'CALL_ANALYZED_INTAKE_INVARIANTS_PASS' AS result;
