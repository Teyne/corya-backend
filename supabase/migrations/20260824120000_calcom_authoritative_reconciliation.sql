-- =============================================================================
-- Corya - Authoritative Cal.com reconciliation before post-call processing
--
-- Cal.com is the authoritative source for a confirmed booking. Retell remains
-- useful for routing the call, but a Retell result of echec/NULL must not hide
-- a uniquely authenticated Cal.com booking created during that call.
--
-- Privacy: the matching key is strictly technical (cabinet, provider event
-- timestamp and booking start). No attendee identity or contact data is read,
-- persisted or logged here.
-- =============================================================================

BEGIN;

-- One call can authoritatively explain at most one provider booking. Existing
-- duplicates indicate an ambiguous historical state and deliberately abort the
-- migration instead of choosing a row silently.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.calendar_bookings
     WHERE source_appel_id IS NOT NULL
     GROUP BY source_appel_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'calendar_booking_source_appel_not_unique';
  END IF;
END;
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_bookings_source_appel_unique
  ON public.calendar_bookings(source_appel_id)
  WHERE source_appel_id IS NOT NULL;

-- Internal primitive used by both delivery orders. Exactly one endpoint must
-- be supplied. The match is accepted only when it is unique in BOTH
-- directions: one eligible call for the booking and one eligible booking for
-- the call. The cabinet advisory lock serializes Cal.com-first, Retell-first
-- and replay transactions.
CREATE OR REPLACE FUNCTION public.reconcile_authoritative_calcom_pair(
  p_cabinet_id UUID,
  p_booking_id UUID DEFAULT NULL,
  p_appel_id UUID DEFAULT NULL
)
RETURNS TABLE(reconciled_booking_id UUID, reconciled_appel_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_booking_ids UUID[];
  v_appel_ids UUID[];
  v_booking_id UUID;
  v_appel_id UUID;
BEGIN
  IF p_cabinet_id IS NULL
     OR ((p_booking_id IS NULL) = (p_appel_id IS NULL)) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'calendar_reconciliation_invalid_target';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 0)
  );

  IF p_booking_id IS NOT NULL THEN
    -- Direction booking -> call.
    SELECT pg_catalog.array_agg(a.id ORDER BY a.date_appel DESC, a.id DESC)
      INTO v_appel_ids
      FROM public.calendar_bookings AS cb
      JOIN public.appels AS a
        ON a.cabinet_id = cb.cabinet_id
       AND a.motif_appel = 'prendre_rendez_vous'
     WHERE cb.id = p_booking_id
       AND cb.cabinet_id = p_cabinet_id
       AND cb.status = 'confirmed'
       AND (cb.source_appel_id IS NULL OR cb.source_appel_id = a.id)
       AND NOT EXISTS (
         SELECT 1
           FROM public.calendar_bookings AS linked
          WHERE linked.source_appel_id = a.id
            AND linked.id <> cb.id
       )
       AND (a.rdv_date IS NULL OR a.rdv_date = cb.start_at)
       AND EXISTS (
           SELECT 1
             FROM public.calendar_booking_events AS cbe
            WHERE cbe.booking_id = cb.id
              AND cbe.trigger_event IN ('BOOKING_CREATED', 'BOOKING_RESCHEDULED')
              AND cbe.provider_created_at >= a.date_appel
              AND cbe.provider_created_at <= a.date_appel
                + pg_catalog.make_interval(secs => COALESCE(a.duree_secondes, 0))
                + INTERVAL '5 minutes'
       );

    IF pg_catalog.cardinality(v_appel_ids) IS DISTINCT FROM 1 THEN
      RETURN;
    END IF;
    v_appel_id := v_appel_ids[1];

    -- Reverse uniqueness: the chosen call must not fit another booking.
    SELECT pg_catalog.array_agg(cb.id ORDER BY cb.created_at DESC, cb.id DESC)
      INTO v_booking_ids
      FROM public.calendar_bookings AS cb
      JOIN public.appels AS a ON a.id = v_appel_id
     WHERE cb.cabinet_id = p_cabinet_id
       AND cb.status = 'confirmed'
       AND (cb.source_appel_id IS NULL OR cb.source_appel_id = a.id)
       AND NOT EXISTS (
         SELECT 1
           FROM public.calendar_bookings AS linked
          WHERE linked.source_appel_id = a.id
            AND linked.id <> cb.id
       )
       AND (a.rdv_date IS NULL OR a.rdv_date = cb.start_at)
       AND EXISTS (
           SELECT 1
             FROM public.calendar_booking_events AS cbe
            WHERE cbe.booking_id = cb.id
              AND cbe.trigger_event IN ('BOOKING_CREATED', 'BOOKING_RESCHEDULED')
              AND cbe.provider_created_at >= a.date_appel
              AND cbe.provider_created_at <= a.date_appel
                + pg_catalog.make_interval(secs => COALESCE(a.duree_secondes, 0))
                + INTERVAL '5 minutes'
       );

    IF pg_catalog.cardinality(v_booking_ids) IS DISTINCT FROM 1
       OR v_booking_ids[1] <> p_booking_id THEN
      RETURN;
    END IF;
    v_booking_id := p_booking_id;
  ELSE
    -- Direction call -> booking.
    SELECT pg_catalog.array_agg(cb.id ORDER BY cb.created_at DESC, cb.id DESC)
      INTO v_booking_ids
      FROM public.appels AS a
      JOIN public.calendar_bookings AS cb
        ON cb.cabinet_id = a.cabinet_id
     WHERE a.id = p_appel_id
       AND a.cabinet_id = p_cabinet_id
       AND a.motif_appel = 'prendre_rendez_vous'
       AND cb.status = 'confirmed'
       AND (cb.source_appel_id IS NULL OR cb.source_appel_id = a.id)
       AND NOT EXISTS (
         SELECT 1
           FROM public.calendar_bookings AS linked
          WHERE linked.source_appel_id = a.id
            AND linked.id <> cb.id
       )
       AND (a.rdv_date IS NULL OR a.rdv_date = cb.start_at)
       AND EXISTS (
           SELECT 1
             FROM public.calendar_booking_events AS cbe
            WHERE cbe.booking_id = cb.id
              AND cbe.trigger_event IN ('BOOKING_CREATED', 'BOOKING_RESCHEDULED')
              AND cbe.provider_created_at >= a.date_appel
              AND cbe.provider_created_at <= a.date_appel
                + pg_catalog.make_interval(secs => COALESCE(a.duree_secondes, 0))
                + INTERVAL '5 minutes'
       );

    IF pg_catalog.cardinality(v_booking_ids) IS DISTINCT FROM 1 THEN
      RETURN;
    END IF;
    v_booking_id := v_booking_ids[1];

    -- Reverse uniqueness: the chosen booking must not fit another call.
    SELECT pg_catalog.array_agg(a.id ORDER BY a.date_appel DESC, a.id DESC)
      INTO v_appel_ids
      FROM public.calendar_bookings AS cb
      JOIN public.appels AS a
        ON a.cabinet_id = cb.cabinet_id
       AND a.motif_appel = 'prendre_rendez_vous'
     WHERE cb.id = v_booking_id
       AND cb.cabinet_id = p_cabinet_id
       AND cb.status = 'confirmed'
       AND (cb.source_appel_id IS NULL OR cb.source_appel_id = a.id)
       AND NOT EXISTS (
         SELECT 1
           FROM public.calendar_bookings AS linked
          WHERE linked.source_appel_id = a.id
            AND linked.id <> cb.id
       )
       AND (a.rdv_date IS NULL OR a.rdv_date = cb.start_at)
       AND EXISTS (
           SELECT 1
             FROM public.calendar_booking_events AS cbe
            WHERE cbe.booking_id = cb.id
              AND cbe.trigger_event IN ('BOOKING_CREATED', 'BOOKING_RESCHEDULED')
              AND cbe.provider_created_at >= a.date_appel
              AND cbe.provider_created_at <= a.date_appel
                + pg_catalog.make_interval(secs => COALESCE(a.duree_secondes, 0))
                + INTERVAL '5 minutes'
       );

    IF pg_catalog.cardinality(v_appel_ids) IS DISTINCT FROM 1
       OR v_appel_ids[1] <> p_appel_id THEN
      RETURN;
    END IF;
    v_appel_id := p_appel_id;
  END IF;

  -- The CTE makes linkage and authoritative promotion one SQL statement.
  -- If the booking was linked concurrently to another call, no call is
  -- promoted. The partial unique index additionally protects the reverse side.
  RETURN QUERY
  WITH linked AS (
    UPDATE public.calendar_bookings AS cb
       SET source_appel_id = v_appel_id,
           updated_at = pg_catalog.clock_timestamp()
     WHERE cb.id = v_booking_id
       AND cb.cabinet_id = p_cabinet_id
       AND cb.status = 'confirmed'
       AND (cb.source_appel_id IS NULL OR cb.source_appel_id = v_appel_id)
    RETURNING cb.id, cb.start_at
  ), promoted AS (
    UPDATE public.appels AS a
       SET resultat = 'rdv_pris',
           rdv_date = linked.start_at
      FROM linked
     WHERE a.id = v_appel_id
       AND a.cabinet_id = p_cabinet_id
       AND a.motif_appel = 'prendre_rendez_vous'
    RETURNING linked.id AS booking_id, a.id AS appel_id
  ), accelerated AS (
    UPDATE public.jobs AS j
       SET run_after = LEAST(j.run_after, pg_catalog.clock_timestamp())
      FROM promoted
     WHERE j.appel_id = promoted.appel_id
       AND j.type = 'process_appel'
       AND j.status = 'pending'
    RETURNING j.id
  )
  SELECT promoted.booking_id, promoted.appel_id
    FROM promoted;
END;
$function$;

COMMENT ON FUNCTION public.reconcile_authoritative_calcom_pair(UUID, UUID, UUID) IS
  'Internal fail-closed Cal.com reconciliation. Requires a mutually unique '
  'technical match under the cabinet advisory lock, then atomically links the '
  'booking and promotes the call to rdv_pris with the provider start time.';

REVOKE ALL ON FUNCTION public.reconcile_authoritative_calcom_pair(UUID, UUID, UUID)
FROM PUBLIC, anon, authenticated, service_role;

-- Keep the public backend contract while delegating the decision to the
-- authoritative primitive. The timestamp arguments are retained for API
-- compatibility; the persisted call and authenticated registry are the source
-- of truth.
CREATE OR REPLACE FUNCTION public.reconcile_calendar_booking_for_appel(
  p_appel_id UUID,
  p_cabinet_id UUID,
  p_call_started_at TIMESTAMPTZ,
  p_call_ended_at TIMESTAMPTZ,
  p_booking_start_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_booking_id UUID;
BEGIN
  IF p_call_ended_at < p_call_started_at
     OR NOT EXISTS (
       SELECT 1
         FROM public.appels AS a
        WHERE a.id = p_appel_id
          AND a.cabinet_id = p_cabinet_id
          AND a.date_appel = p_call_started_at
     ) THEN
    RETURN NULL;
  END IF;

  SELECT r.reconciled_booking_id
    INTO v_booking_id
    FROM public.reconcile_authoritative_calcom_pair(
      p_cabinet_id,
      NULL,
      p_appel_id
    ) AS r;

  RETURN v_booking_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_calendar_booking_for_appel(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_calendar_booking_for_appel(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

-- Replace the Cal.com intake RPC so both new events and authenticated replays
-- invoke the same authoritative matcher. Provider event idempotence and stale
-- event ordering remain unchanged.
CREATE OR REPLACE FUNCTION public.persist_calcom_booking_event(
  p_event_key TEXT,
  p_trigger_event TEXT,
  p_provider_created_at TIMESTAMPTZ,
  p_provider_booking_uid TEXT,
  p_reschedule_uid TEXT,
  p_event_type_id TEXT,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ
)
RETURNS TABLE (
  booking_id UUID,
  cabinet_id UUID,
  source_appel_id UUID,
  outcome TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_cabinet_ids UUID[];
  v_cabinet_id UUID;
  v_booking_id UUID;
  v_source_appel_id UUID;
  v_event_id UUID;
  v_status TEXT;
BEGIN
  IF p_event_key !~ '^[0-9a-f]{64}$'
     OR p_provider_booking_uid IS NULL
     OR p_provider_booking_uid = ''
     OR length(p_provider_booking_uid) > 200
     OR p_event_type_id !~ '^[0-9]{1,20}$'
     OR p_end_at <= p_start_at
     OR p_trigger_event NOT IN (
       'BOOKING_CREATED',
       'BOOKING_RESCHEDULED',
       'BOOKING_CANCELLED',
       'BOOKING_REJECTED'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'calcom_booking_event_invalid';
  END IF;

  SELECT pg_catalog.array_agg(c.id ORDER BY c.id)
    INTO v_cabinet_ids
    FROM public.cabinets AS c
   WHERE c.statut = 'actif'
     AND c.config_agent #>> '{calendar,provider}' = 'cal.com'
     AND c.config_agent #>> '{calendar,eventTypeId}' = p_event_type_id;

  IF pg_catalog.cardinality(v_cabinet_ids) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'calcom_event_type_mapping_not_unique';
  END IF;
  v_cabinet_id := v_cabinet_ids[1];

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_cabinet_id::TEXT, 0)
  );

  INSERT INTO public.calendar_booking_events (
    cabinet_id,
    event_key,
    trigger_event,
    provider_booking_uid,
    provider_created_at
  ) VALUES (
    v_cabinet_id,
    p_event_key,
    p_trigger_event,
    p_provider_booking_uid,
    p_provider_created_at
  )
  ON CONFLICT (provider, event_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT cb.id
      INTO v_booking_id
      FROM public.calendar_bookings AS cb
     WHERE cb.provider = 'cal.com'
       AND cb.provider_booking_uid = p_provider_booking_uid;

    IF v_booking_id IS NOT NULL
       AND p_trigger_event IN ('BOOKING_CREATED', 'BOOKING_RESCHEDULED') THEN
      PERFORM *
        FROM public.reconcile_authoritative_calcom_pair(
          v_cabinet_id,
          v_booking_id,
          NULL
        );
    END IF;

    SELECT cb.source_appel_id
      INTO v_source_appel_id
      FROM public.calendar_bookings AS cb
     WHERE cb.id = v_booking_id;

    RETURN QUERY
    SELECT v_booking_id, v_cabinet_id, v_source_appel_id, 'duplicate'::TEXT;
    RETURN;
  END IF;

  v_status := CASE p_trigger_event
    WHEN 'BOOKING_CANCELLED' THEN 'cancelled'
    WHEN 'BOOKING_REJECTED' THEN 'rejected'
    ELSE 'confirmed'
  END;

  INSERT INTO public.calendar_bookings AS current_booking (
    cabinet_id,
    provider_booking_uid,
    previous_provider_booking_uid,
    provider_event_type_id,
    status,
    start_at,
    end_at,
    last_trigger_event,
    last_provider_event_at
  ) VALUES (
    v_cabinet_id,
    p_provider_booking_uid,
    NULLIF(p_reschedule_uid, ''),
    p_event_type_id,
    v_status,
    p_start_at,
    p_end_at,
    p_trigger_event,
    p_provider_created_at
  )
  ON CONFLICT (provider, provider_booking_uid) DO UPDATE
  SET previous_provider_booking_uid = EXCLUDED.previous_provider_booking_uid,
      provider_event_type_id = EXCLUDED.provider_event_type_id,
      status = EXCLUDED.status,
      start_at = EXCLUDED.start_at,
      end_at = EXCLUDED.end_at,
      last_trigger_event = EXCLUDED.last_trigger_event,
      last_provider_event_at = EXCLUDED.last_provider_event_at,
      updated_at = pg_catalog.clock_timestamp()
  WHERE EXCLUDED.last_provider_event_at >= current_booking.last_provider_event_at
  RETURNING current_booking.id
  INTO v_booking_id;

  IF v_booking_id IS NULL THEN
    SELECT cb.id
      INTO v_booking_id
      FROM public.calendar_bookings AS cb
     WHERE cb.provider = 'cal.com'
       AND cb.provider_booking_uid = p_provider_booking_uid;
  END IF;

  IF p_trigger_event = 'BOOKING_RESCHEDULED'
     AND NULLIF(p_reschedule_uid, '') IS NOT NULL
     AND p_reschedule_uid <> p_provider_booking_uid THEN
    UPDATE public.calendar_bookings AS previous
       SET status = 'rescheduled',
           last_trigger_event = 'BOOKING_RESCHEDULED',
           last_provider_event_at = GREATEST(
             previous.last_provider_event_at,
             p_provider_created_at
           ),
           updated_at = pg_catalog.clock_timestamp()
     WHERE previous.provider = 'cal.com'
       AND previous.provider_booking_uid = p_reschedule_uid
       AND previous.cabinet_id = v_cabinet_id;
  END IF;

  UPDATE public.calendar_booking_events AS target_event
     SET booking_id = v_booking_id
   WHERE target_event.id = v_event_id;

  IF v_status = 'confirmed' THEN
    PERFORM *
      FROM public.reconcile_authoritative_calcom_pair(
        v_cabinet_id,
        v_booking_id,
        NULL
      );
  END IF;

  SELECT cb.source_appel_id
    INTO v_source_appel_id
    FROM public.calendar_bookings AS cb
   WHERE cb.id = v_booking_id;

  RETURN QUERY
  SELECT v_booking_id, v_cabinet_id, v_source_appel_id, 'applied'::TEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_calcom_booking_event(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_calcom_booking_event(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

-- Replace the atomic Retell intake without changing its external signature.
-- Appointment-intent process_appel jobs are held for five minutes unless a
-- confirmed Cal.com link already exists. This bounded grace closes the normal
-- webhook race while keeping failed/no-booking calls operationally bounded.
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
  v_cabinet_id UUID;
  v_inserted BOOLEAN := FALSE;
  v_is_appointment BOOLEAN := FALSE;
  v_has_authoritative_booking BOOLEAN := FALSE;
  v_process_run_after TIMESTAMPTZ;
BEGIN
  v_cabinet_id := (p_appel->>'cabinet_id')::UUID;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_cabinet_id::TEXT, 0)
  );

  INSERT INTO public.appels (
    cabinet_id, retell_call_id, date_appel, duree_secondes,
    numero_appelant_hash, numero_appelant_masque, resultat, motif_appel,
    patient_nom, patient_prenom, patient_telephone, rdv_date,
    rdv_praticien, transcript, transcript_anonymise, audio_url,
    audio_expires_at
  ) VALUES (
    v_cabinet_id,
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

  SELECT a.motif_appel = 'prendre_rendez_vous'
    INTO v_is_appointment
    FROM public.appels AS a
   WHERE a.id = v_appel_id;
  v_is_appointment := COALESCE(v_is_appointment, FALSE);

  IF v_is_appointment THEN
    PERFORM *
      FROM public.reconcile_authoritative_calcom_pair(
        v_cabinet_id,
        NULL,
        v_appel_id
      );
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.calendar_bookings AS cb
     WHERE cb.source_appel_id = v_appel_id
       AND cb.cabinet_id = v_cabinet_id
       AND cb.status = 'confirmed'
  ) INTO v_has_authoritative_booking;

  v_process_run_after := CASE
    WHEN v_is_appointment AND NOT v_has_authoritative_booking
      THEN CURRENT_TIMESTAMP + INTERVAL '5 minutes'
    ELSE CURRENT_TIMESTAMP
  END;

  INSERT INTO public.jobs (type, appel_id, payload, run_after, correlation_id)
  SELECT 'process_appel', v_appel_id, p_process_payload,
         v_process_run_after, p_correlation_id
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
  'Atomically persists call_analyzed, performs authoritative Cal.com '
  'reconciliation, and holds unresolved appointment process_appel jobs for a '
  'bounded five-minute webhook grace period; replays repair missing jobs.';

REVOKE ALL ON FUNCTION public.persist_call_analyzed(JSONB, JSONB, JSONB, TIMESTAMPTZ, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_call_analyzed(JSONB, JSONB, JSONB, TIMESTAMPTZ, TEXT)
TO service_role;

COMMIT;
