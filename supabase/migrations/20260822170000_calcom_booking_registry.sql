-- =============================================================================
-- Corya - Cal.com booking registry and event-driven reconciliation
--
-- The registry deliberately stores no attendee name, e-mail, telephone,
-- notes, answers or meeting URL. Cal.com webhook bodies are authenticated in
-- the API, reduced to this allowlist, and never persisted verbatim.
-- =============================================================================

BEGIN;

CREATE TABLE public.calendar_bookings (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id                    UUID        NOT NULL
    REFERENCES public.cabinets(id) ON DELETE CASCADE,
  source_appel_id               UUID
    REFERENCES public.appels(id) ON DELETE SET NULL,
  provider                      TEXT        NOT NULL DEFAULT 'cal.com',
  provider_booking_uid          TEXT        NOT NULL,
  previous_provider_booking_uid TEXT,
  provider_event_type_id        TEXT        NOT NULL,
  status                        TEXT        NOT NULL,
  start_at                      TIMESTAMPTZ NOT NULL,
  end_at                        TIMESTAMPTZ NOT NULL,
  last_trigger_event            TEXT        NOT NULL,
  last_provider_event_at        TIMESTAMPTZ NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calendar_bookings_provider_check
    CHECK (provider = 'cal.com'),
  CONSTRAINT calendar_bookings_uid_check
    CHECK (provider_booking_uid <> '' AND length(provider_booking_uid) <= 200),
  CONSTRAINT calendar_bookings_previous_uid_check
    CHECK (
      previous_provider_booking_uid IS NULL
      OR (
        previous_provider_booking_uid <> ''
        AND length(previous_provider_booking_uid) <= 200
      )
    ),
  CONSTRAINT calendar_bookings_event_type_check
    CHECK (provider_event_type_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT calendar_bookings_status_check
    CHECK (status IN ('confirmed', 'rescheduled', 'cancelled', 'rejected')),
  CONSTRAINT calendar_bookings_trigger_check
    CHECK (last_trigger_event IN (
      'BOOKING_CREATED',
      'BOOKING_RESCHEDULED',
      'BOOKING_CANCELLED',
      'BOOKING_REJECTED'
    )),
  CONSTRAINT calendar_bookings_time_order_check CHECK (end_at > start_at),
  CONSTRAINT calendar_bookings_provider_uid_unique
    UNIQUE (provider, provider_booking_uid)
);

CREATE INDEX idx_calendar_bookings_cabinet_start
  ON public.calendar_bookings(cabinet_id, start_at DESC, id DESC);

CREATE INDEX idx_calendar_bookings_unlinked_confirmed
  ON public.calendar_bookings(cabinet_id, start_at)
  WHERE source_appel_id IS NULL AND status = 'confirmed';

CREATE TABLE public.calendar_booking_events (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id           UUID        NOT NULL
    REFERENCES public.cabinets(id) ON DELETE CASCADE,
  booking_id           UUID        REFERENCES public.calendar_bookings(id)
    ON DELETE CASCADE,
  provider             TEXT        NOT NULL DEFAULT 'cal.com',
  event_key             TEXT        NOT NULL,
  trigger_event         TEXT        NOT NULL,
  provider_booking_uid TEXT        NOT NULL,
  provider_created_at  TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calendar_booking_events_provider_check
    CHECK (provider = 'cal.com'),
  CONSTRAINT calendar_booking_events_key_check
    CHECK (event_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT calendar_booking_events_trigger_check
    CHECK (trigger_event IN (
      'BOOKING_CREATED',
      'BOOKING_RESCHEDULED',
      'BOOKING_CANCELLED',
      'BOOKING_REJECTED'
    )),
  CONSTRAINT calendar_booking_events_uid_check
    CHECK (provider_booking_uid <> '' AND length(provider_booking_uid) <= 200),
  CONSTRAINT calendar_booking_events_provider_key_unique
    UNIQUE (provider, event_key)
);

CREATE INDEX idx_calendar_booking_events_cabinet_received
  ON public.calendar_booking_events(cabinet_id, received_at DESC, id DESC);

COMMENT ON TABLE public.calendar_bookings IS
  'Registre technique des reservations fournisseur. Aucune identite invite, '
  'adresse e-mail, telephone, note, reponse de formulaire ou URL de reunion.';

COMMENT ON TABLE public.calendar_booking_events IS
  'Preuves techniques idempotentes des webhooks Cal.com; corps brut jamais stocke.';

ALTER TABLE public.calendar_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_booking_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.calendar_bookings
FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.calendar_booking_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendar_bookings
TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendar_booking_events
TO service_role;

CREATE FUNCTION public.persist_calcom_booking_event(
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
  v_candidate_ids UUID[];
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

  -- Serialize both webhook-first and Retell-first reconciliation for one
  -- cabinet. Without this lock, two concurrent transactions could each miss
  -- the other's uncommitted row and leave a valid pair unlinked forever.
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
    SELECT cb.id, cb.source_appel_id
      INTO v_booking_id, v_source_appel_id
      FROM public.calendar_bookings AS cb
     WHERE cb.provider = 'cal.com'
       AND cb.provider_booking_uid = p_provider_booking_uid;

    -- A replay is also a repair opportunity (for example if the original
    -- Cal.com event preceded the Retell call). It remains fail-closed when
    -- zero or several technical candidates exist.
    IF v_booking_id IS NOT NULL
       AND v_source_appel_id IS NULL
       AND p_trigger_event IN ('BOOKING_CREATED', 'BOOKING_RESCHEDULED') THEN
      SELECT pg_catalog.array_agg(a.id ORDER BY a.created_at DESC, a.id DESC)
        INTO v_candidate_ids
        FROM public.appels AS a
       WHERE a.cabinet_id = v_cabinet_id
         AND a.resultat = 'rdv_pris'
         AND (
           a.rdv_date = p_start_at
           OR (
             a.date_appel <= p_provider_created_at
             AND p_provider_created_at <= a.date_appel
               + pg_catalog.make_interval(secs => COALESCE(a.duree_secondes, 0))
               + INTERVAL '5 minutes'
           )
         );

      IF pg_catalog.cardinality(v_candidate_ids) = 1 THEN
        v_source_appel_id := v_candidate_ids[1];
        UPDATE public.calendar_bookings AS replay_booking
           SET source_appel_id = v_source_appel_id,
               updated_at = pg_catalog.clock_timestamp()
         WHERE replay_booking.id = v_booking_id
           AND replay_booking.source_appel_id IS NULL;
      END IF;
    END IF;

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
  RETURNING current_booking.id, current_booking.source_appel_id
  INTO v_booking_id, v_source_appel_id;

  IF v_booking_id IS NULL THEN
    SELECT cb.id, cb.source_appel_id
      INTO v_booking_id, v_source_appel_id
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

  IF v_status = 'confirmed' AND v_source_appel_id IS NULL THEN
    SELECT pg_catalog.array_agg(a.id ORDER BY a.created_at DESC, a.id DESC)
      INTO v_candidate_ids
      FROM public.appels AS a
     WHERE a.cabinet_id = v_cabinet_id
       AND a.resultat = 'rdv_pris'
       AND (
         a.rdv_date = p_start_at
         OR (
           a.date_appel <= p_provider_created_at
           AND p_provider_created_at <= a.date_appel
             + pg_catalog.make_interval(secs => COALESCE(a.duree_secondes, 0))
             + INTERVAL '5 minutes'
         )
       );

    IF pg_catalog.cardinality(v_candidate_ids) = 1 THEN
      v_source_appel_id := v_candidate_ids[1];
      UPDATE public.calendar_bookings AS target_booking
         SET source_appel_id = v_source_appel_id,
             updated_at = pg_catalog.clock_timestamp()
       WHERE target_booking.id = v_booking_id
         AND target_booking.source_appel_id IS NULL;
    END IF;
  END IF;

  UPDATE public.calendar_booking_events AS target_event
     SET booking_id = v_booking_id
   WHERE target_event.id = v_event_id;

  RETURN QUERY
  SELECT v_booking_id, v_cabinet_id, v_source_appel_id, 'applied'::TEXT;
END;
$function$;

COMMENT ON FUNCTION public.persist_calcom_booking_event(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Persiste idempotemment un evenement Cal.com allowliste, resout le cabinet '
  'par eventTypeId et rapproche un appel seulement si le candidat est unique.';

REVOKE ALL ON FUNCTION public.persist_calcom_booking_event(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_calcom_booking_event(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

CREATE FUNCTION public.reconcile_calendar_booking_for_appel(
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
  v_booking_ids UUID[];
  v_booking_id UUID;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 0)
  );

  IF NOT EXISTS (
    SELECT 1
      FROM public.appels AS a
     WHERE a.id = p_appel_id
       AND a.cabinet_id = p_cabinet_id
       AND a.resultat = 'rdv_pris'
       AND a.date_appel = p_call_started_at
       AND (a.rdv_date IS NOT DISTINCT FROM p_booking_start_at)
  ) THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.array_agg(cb.id ORDER BY cb.created_at DESC, cb.id DESC)
    INTO v_booking_ids
    FROM public.calendar_bookings AS cb
   WHERE cb.cabinet_id = p_cabinet_id
     AND cb.status = 'confirmed'
     AND (cb.source_appel_id IS NULL OR cb.source_appel_id = p_appel_id)
     AND (
       (p_booking_start_at IS NOT NULL AND cb.start_at = p_booking_start_at)
       OR EXISTS (
         SELECT 1
           FROM public.calendar_booking_events AS cbe
          WHERE cbe.booking_id = cb.id
            AND cbe.provider_created_at >= p_call_started_at
            AND cbe.provider_created_at <= p_call_ended_at + INTERVAL '5 minutes'
       )
     );

  IF pg_catalog.cardinality(v_booking_ids) IS DISTINCT FROM 1 THEN
    RETURN NULL;
  END IF;

  v_booking_id := v_booking_ids[1];
  UPDATE public.calendar_bookings
     SET source_appel_id = p_appel_id,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_booking_id;

  RETURN v_booking_id;
END;
$function$;

COMMENT ON FUNCTION public.reconcile_calendar_booking_for_appel(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Rapproche un appel rdv_pris et une reservation confirmee uniquement quand '
  'cabinet et horaire produisent exactement un candidat.';

REVOKE ALL ON FUNCTION public.reconcile_calendar_booking_for_appel(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_calendar_booking_for_appel(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

CREATE FUNCTION public.purge_ancient_calendar_registry()
RETURNS TABLE(events_deleted INTEGER, bookings_deleted INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_events INTEGER;
  v_bookings INTEGER;
BEGIN
  DELETE FROM public.calendar_booking_events
   WHERE received_at < NOW() - INTERVAL '24 months';
  GET DIAGNOSTICS v_events = ROW_COUNT;

  DELETE FROM public.calendar_bookings
   WHERE end_at < NOW() - INTERVAL '24 months';
  GET DIAGNOSTICS v_bookings = ROW_COUNT;

  RETURN QUERY SELECT v_events, v_bookings;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_ancient_calendar_registry()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ancient_calendar_registry()
TO service_role;

DO $cron_replace$
BEGIN
  PERFORM cron.unschedule('purge-ancient-logs-actions');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron_replace$;

SELECT cron.schedule(
  'purge-ancient-logs-actions',
  '17 4 15 * *',
  $$
    SELECT
      public.purge_ancient_logs_actions(),
      public.purge_ancient_portal_audit_events(),
      public.purge_ancient_calendar_registry();
  $$
);

COMMIT;
