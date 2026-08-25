\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut, config_agent
) VALUES (
  'cc200000-0000-4000-8000-000000000001',
  'Synthetic Retell tool cabinet', 'synthetic-retell-tool', '+41000000041',
  'retell-tool@example.invalid', 'actif', '{}'::JSONB
);

DO $test$
DECLARE
  v_claim RECORD;
  v_replay RECORD;
  v_proc REGPROCEDURE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'calendar_booking_commands'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'calendar_booking_commands_rls_not_enabled';
  END IF;
  IF pg_catalog.has_table_privilege('service_role', 'public.calendar_booking_commands', 'SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.calendar_booking_commands', 'SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('anon', 'public.calendar_booking_commands', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'calendar_booking_commands_direct_access_present';
  END IF;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.claim_calendar_booking_command(text,uuid,timestamp with time zone,uuid)'::REGPROCEDURE,
    'public.complete_calendar_booking_command(text,uuid,text,text,timestamp with time zone,timestamp with time zone)'::REGPROCEDURE,
    'public.mark_calendar_booking_command_uncertain(text,uuid)'::REGPROCEDURE
  ] LOOP
    IF pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE') THEN
      RAISE EXCEPTION 'calendar_booking_command_rpc_grants_invalid proc=%', v_proc;
    END IF;
  END LOOP;

  SELECT * INTO STRICT v_claim FROM public.claim_calendar_booking_command(
    repeat('a', 64),
    'cc200000-0000-4000-8000-000000000001',
    '2026-09-10T10:00:00Z',
    '11111111-1111-4111-8111-111111111111'
  );
  IF v_claim.outcome <> 'claimed' THEN
    RAISE EXCEPTION 'calendar_booking_command_not_claimed result=%', v_claim;
  END IF;

  SELECT * INTO STRICT v_replay FROM public.claim_calendar_booking_command(
    repeat('a', 64),
    'cc200000-0000-4000-8000-000000000001',
    '2026-09-10T10:00:00Z',
    '22222222-2222-4222-8222-222222222222'
  );
  IF v_replay.outcome <> 'in_progress' THEN
    RAISE EXCEPTION 'calendar_booking_command_concurrent_replay_not_fenced result=%', v_replay;
  END IF;

  IF NOT public.complete_calendar_booking_command(
    repeat('a', 64),
    '11111111-1111-4111-8111-111111111111',
    'synthetic-booking-uid', 'accepted',
    '2026-09-10T10:00:00Z', '2026-09-10T10:30:00Z'
  ) THEN
    RAISE EXCEPTION 'calendar_booking_command_completion_failed';
  END IF;

  SELECT * INTO STRICT v_replay FROM public.claim_calendar_booking_command(
    repeat('a', 64),
    'cc200000-0000-4000-8000-000000000001',
    '2026-09-10T10:00:00Z',
    '33333333-3333-4333-8333-333333333333'
  );
  IF v_replay.outcome <> 'replay'
     OR v_replay.provider_booking_uid <> 'synthetic-booking-uid'
     OR v_replay.booked_start <> '2026-09-10T10:00:00Z'::TIMESTAMPTZ THEN
    RAISE EXCEPTION 'calendar_booking_command_success_replay_invalid result=%', v_replay;
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_claim RECORD;
  v_result RECORD;
BEGIN
  SELECT * INTO STRICT v_claim FROM public.claim_calendar_booking_command(
    repeat('b', 64),
    'cc200000-0000-4000-8000-000000000001',
    '2026-09-11T10:00:00Z',
    '44444444-4444-4444-8444-444444444444'
  );
  IF NOT public.mark_calendar_booking_command_uncertain(
    repeat('b', 64), '44444444-4444-4444-8444-444444444444'
  ) THEN
    RAISE EXCEPTION 'calendar_booking_command_uncertain_transition_failed';
  END IF;
  SELECT * INTO STRICT v_result FROM public.claim_calendar_booking_command(
    repeat('b', 64),
    'cc200000-0000-4000-8000-000000000001',
    '2026-09-11T10:00:00Z',
    '55555555-5555-4555-8555-555555555555'
  );
  IF v_result.outcome <> 'uncertain' THEN
    RAISE EXCEPTION 'calendar_booking_command_uncertain_was_replayed result=%', v_result;
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_command_key TEXT := repeat('c', 64);
BEGIN
  INSERT INTO public.calendar_booking_commands (
    command_key, cabinet_id, requested_start, status, lease_owner, created_at
  ) VALUES (
    v_command_key,
    'cc200000-0000-4000-8000-000000000001',
    '2024-01-10T10:00:00Z',
    'processing',
    '66666666-6666-4666-8666-666666666666',
    pg_catalog.now() - INTERVAL '25 months'
  );
  PERFORM * FROM public.purge_ancient_calendar_registry();
  IF EXISTS (
    SELECT 1 FROM public.calendar_booking_commands WHERE command_key = v_command_key
  ) THEN
    RAISE EXCEPTION 'calendar_booking_command_retention_not_enforced';
  END IF;
END;
$test$;

ROLLBACK;
