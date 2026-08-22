\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut, config_agent
) VALUES (
  'ca100000-0000-4000-8000-000000000001',
  'Synthetic Cal registry', 'synthetic-cal-registry', '+41000000009',
  'synthetic@example.invalid', 'actif',
  '{"calendar":{"provider":"cal.com","eventTypeId":"6723841"}}'::JSONB
);

DO $test$
DECLARE
  v_columns TEXT[];
  v_proc REGPROCEDURE :=
    'public.persist_calcom_booking_event(text,text,timestamp with time zone,text,text,text,timestamp with time zone,timestamp with time zone)'::REGPROCEDURE;
BEGIN
  SELECT pg_catalog.array_agg(column_name ORDER BY column_name)
    INTO v_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('calendar_bookings', 'calendar_booking_events')
     AND column_name IN (
       'name', 'email', 'phone', 'telephone', 'notes', 'responses',
       'meeting_url', 'raw_body', 'payload'
     );
  IF COALESCE(pg_catalog.cardinality(v_columns), 0) <> 0 THEN
    RAISE EXCEPTION 'calendar_registry_contains_pii_columns columns=%', v_columns;
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE') THEN
    RAISE EXCEPTION 'user_role_can_execute_calcom_registry_rpc';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role_cannot_execute_calcom_registry_rpc';
  END IF;
END;
$test$;

-- Retell first, Cal.com second: the provider event time uniquely identifies
-- the call even when Retell did not extract rdv_date.
INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes, resultat
) VALUES (
  'ca200000-0000-4000-8000-000000000001',
  'ca100000-0000-4000-8000-000000000001',
  'synthetic-call-before-cal', '2026-08-22T17:00:00Z', 120, 'rdv_pris'
);

DO $test$
DECLARE
  v_result RECORD;
  v_replay RECORD;
BEGIN
  SELECT * INTO STRICT v_result FROM public.persist_calcom_booking_event(
    repeat('a', 64), 'BOOKING_CREATED', '2026-08-22T17:01:00Z',
    'synthetic-booking-a', NULL, '6723841',
    '2026-08-24T08:00:00Z', '2026-08-24T08:30:00Z'
  );
  IF v_result.outcome <> 'applied'
     OR v_result.source_appel_id <> 'ca200000-0000-4000-8000-000000000001'::UUID THEN
    RAISE EXCEPTION 'retell_first_reconciliation_failed result=%', v_result;
  END IF;

  SELECT * INTO STRICT v_replay FROM public.persist_calcom_booking_event(
    repeat('a', 64), 'BOOKING_CREATED', '2026-08-22T17:01:00Z',
    'synthetic-booking-a', NULL, '6723841',
    '2026-08-24T08:00:00Z', '2026-08-24T08:30:00Z'
  );
  IF v_replay.outcome <> 'duplicate'
     OR v_replay.booking_id <> v_result.booking_id THEN
    RAISE EXCEPTION 'calcom_replay_not_idempotent replay=%', v_replay;
  END IF;
END;
$test$;

-- Cal.com first, Retell second: the explicit reconciliation RPC uses the
-- provider event timestamp and links the same unique technical candidate.
SELECT * FROM public.persist_calcom_booking_event(
  repeat('b', 64), 'BOOKING_CREATED', '2026-08-22T18:01:00Z',
  'synthetic-booking-b', NULL, '6723841',
  '2026-08-25T09:00:00Z', '2026-08-25T09:30:00Z'
);

INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes, resultat
) VALUES (
  'ca200000-0000-4000-8000-000000000002',
  'ca100000-0000-4000-8000-000000000001',
  'synthetic-call-after-cal', '2026-08-22T18:00:00Z', 120, 'rdv_pris'
);

DO $test$
DECLARE
  v_booking UUID;
  v_linked UUID;
BEGIN
  v_booking := public.reconcile_calendar_booking_for_appel(
    'ca200000-0000-4000-8000-000000000002',
    'ca100000-0000-4000-8000-000000000001',
    '2026-08-22T18:00:00Z', '2026-08-22T18:02:00Z', NULL
  );
  SELECT source_appel_id INTO v_linked
    FROM public.calendar_bookings
   WHERE provider_booking_uid = 'synthetic-booking-b';
  IF v_booking IS NULL OR v_linked <> 'ca200000-0000-4000-8000-000000000002'::UUID THEN
    RAISE EXCEPTION 'cal_first_reconciliation_failed booking=% linked=%', v_booking, v_linked;
  END IF;
END;
$test$;

-- A provider replay repairs a previously unlinked booking after its Retell
-- call becomes visible, while preserving the duplicate outcome.
SELECT * FROM public.persist_calcom_booking_event(
  repeat('d', 64), 'BOOKING_CREATED', '2026-08-22T20:01:00Z',
  'synthetic-booking-replay-repair', NULL, '6723841',
  '2026-08-27T11:00:00Z', '2026-08-27T11:30:00Z'
);
INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes, resultat
) VALUES (
  'ca200000-0000-4000-8000-000000000005',
  'ca100000-0000-4000-8000-000000000001',
  'synthetic-replay-repair', '2026-08-22T20:00:00Z', 120, 'rdv_pris'
);
DO $test$
DECLARE
  v_result RECORD;
BEGIN
  SELECT * INTO STRICT v_result FROM public.persist_calcom_booking_event(
    repeat('d', 64), 'BOOKING_CREATED', '2026-08-22T20:01:00Z',
    'synthetic-booking-replay-repair', NULL, '6723841',
    '2026-08-27T11:00:00Z', '2026-08-27T11:30:00Z'
  );
  IF v_result.outcome <> 'duplicate'
     OR v_result.source_appel_id <> 'ca200000-0000-4000-8000-000000000005'::UUID THEN
    RAISE EXCEPTION 'provider_replay_did_not_repair result=%', v_result;
  END IF;
END;
$test$;

-- Two calls covering the same provider event must remain unresolved.
INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes, resultat
) VALUES
  ('ca200000-0000-4000-8000-000000000003', 'ca100000-0000-4000-8000-000000000001',
   'synthetic-ambiguous-1', '2026-08-22T19:00:00Z', 180, 'rdv_pris'),
  ('ca200000-0000-4000-8000-000000000004', 'ca100000-0000-4000-8000-000000000001',
   'synthetic-ambiguous-2', '2026-08-22T19:00:30Z', 180, 'rdv_pris');

SELECT * FROM public.persist_calcom_booking_event(
  repeat('c', 64), 'BOOKING_CREATED', '2026-08-22T19:01:00Z',
  'synthetic-booking-ambiguous', NULL, '6723841',
  '2026-08-26T10:00:00Z', '2026-08-26T10:30:00Z'
);

DO $test$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.calendar_bookings
     WHERE provider_booking_uid = 'synthetic-booking-ambiguous'
       AND source_appel_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ambiguous_booking_was_linked';
  END IF;
  IF (SELECT count(*) FROM public.calendar_booking_events) <> 4 THEN
    RAISE EXCEPTION 'unexpected_event_count';
  END IF;
END;
$test$;

ROLLBACK;
