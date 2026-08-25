-- Idempotence fence for Retell-triggered Cal.com booking commands.
--
-- The command stores only technical identifiers and provider timestamps. The
-- caller name, phone, e-mail, transcript and raw Retell payload never enter
-- this table. A command that becomes uncertain is never replayed
-- automatically: this deliberately prefers a manual check over a duplicate
-- appointment after a provider timeout.

BEGIN;

CREATE TABLE public.calendar_booking_commands (
  command_key TEXT PRIMARY KEY
    CHECK (command_key ~ '^[0-9a-f]{64}$'),
  cabinet_id UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  requested_start TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('processing', 'succeeded', 'uncertain')),
  lease_owner UUID,
  provider_booking_uid TEXT,
  provider_status TEXT,
  booked_start TIMESTAMPTZ,
  booked_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CHECK ((status = 'processing') = (lease_owner IS NOT NULL)),
  CHECK (
    status <> 'succeeded'
    OR (
      provider_booking_uid IS NOT NULL
      AND provider_booking_uid ~ '^[A-Za-z0-9._:-]{1,200}$'
      AND provider_status IS NOT NULL
      AND provider_status ~ '^[A-Za-z0-9_-]{1,40}$'
      AND booked_start IS NOT NULL
      AND booked_end IS NOT NULL
      AND booked_end > booked_start
    )
  )
);

CREATE INDEX idx_calendar_booking_commands_cabinet_created
  ON public.calendar_booking_commands (cabinet_id, created_at DESC);

ALTER TABLE public.calendar_booking_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.calendar_booking_commands
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_calendar_booking_command(
  p_command_key TEXT,
  p_cabinet_id UUID,
  p_requested_start TIMESTAMPTZ,
  p_lease_owner UUID
)
RETURNS TABLE (
  outcome TEXT,
  provider_booking_uid TEXT,
  provider_status TEXT,
  booked_start TIMESTAMPTZ,
  booked_end TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_command public.calendar_booking_commands%ROWTYPE;
BEGIN
  IF p_command_key IS NULL
     OR p_command_key !~ '^[0-9a-f]{64}$'
     OR p_cabinet_id IS NULL
     OR p_requested_start IS NULL
     OR p_lease_owner IS NULL THEN
    RAISE EXCEPTION 'calendar_booking_command_invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_command_key, 7140062027)
  );

  SELECT * INTO v_command
    FROM public.calendar_booking_commands
   WHERE command_key = p_command_key
   FOR UPDATE;

  IF NOT FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cabinets
       WHERE id = p_cabinet_id AND statut = 'actif'
       FOR KEY SHARE
    ) THEN
      RAISE EXCEPTION 'calendar_booking_command_cabinet_unavailable';
    END IF;

    INSERT INTO public.calendar_booking_commands (
      command_key, cabinet_id, requested_start, status, lease_owner
    ) VALUES (
      p_command_key, p_cabinet_id, p_requested_start, 'processing', p_lease_owner
    );
    outcome := 'claimed';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_command.cabinet_id <> p_cabinet_id
     OR v_command.requested_start <> p_requested_start THEN
    RAISE EXCEPTION 'calendar_booking_command_conflict';
  END IF;

  outcome := CASE v_command.status
    WHEN 'succeeded' THEN 'replay'
    WHEN 'uncertain' THEN 'uncertain'
    ELSE 'in_progress'
  END;
  provider_booking_uid := v_command.provider_booking_uid;
  provider_status := v_command.provider_status;
  booked_start := v_command.booked_start;
  booked_end := v_command.booked_end;
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.complete_calendar_booking_command(
  p_command_key TEXT,
  p_lease_owner UUID,
  p_provider_booking_uid TEXT,
  p_provider_status TEXT,
  p_booked_start TIMESTAMPTZ,
  p_booked_end TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_command_key IS NULL
     OR p_command_key !~ '^[0-9a-f]{64}$'
     OR p_lease_owner IS NULL
     OR p_provider_booking_uid IS NULL
     OR p_provider_booking_uid !~ '^[A-Za-z0-9._:-]{1,200}$'
     OR p_provider_status IS NULL
     OR p_provider_status !~ '^[A-Za-z0-9_-]{1,40}$'
     OR p_booked_start IS NULL
     OR p_booked_end IS NULL
     OR p_booked_end <= p_booked_start THEN
    RAISE EXCEPTION 'calendar_booking_command_completion_invalid';
  END IF;

  UPDATE public.calendar_booking_commands
     SET status = 'succeeded',
         lease_owner = NULL,
         provider_booking_uid = p_provider_booking_uid,
         provider_status = p_provider_status,
         booked_start = p_booked_start,
         booked_end = p_booked_end,
         updated_at = pg_catalog.now()
   WHERE command_key = p_command_key
     AND status = 'processing'
     AND lease_owner = p_lease_owner;
  RETURN FOUND;
END;
$function$;

CREATE FUNCTION public.mark_calendar_booking_command_uncertain(
  p_command_key TEXT,
  p_lease_owner UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_command_key IS NULL
     OR p_command_key !~ '^[0-9a-f]{64}$'
     OR p_lease_owner IS NULL THEN
    RAISE EXCEPTION 'calendar_booking_command_uncertain_invalid';
  END IF;

  UPDATE public.calendar_booking_commands
     SET status = 'uncertain',
         lease_owner = NULL,
         updated_at = pg_catalog.now()
   WHERE command_key = p_command_key
     AND status = 'processing'
     AND lease_owner = p_lease_owner;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_calendar_booking_command(TEXT, UUID, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_calendar_booking_command(TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_calendar_booking_command_uncertain(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_calendar_booking_command(TEXT, UUID, TIMESTAMPTZ, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_calendar_booking_command(TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_calendar_booking_command_uncertain(TEXT, UUID)
  TO service_role;

-- Reuse the existing monthly calendar-registry cron so command fences follow
-- the same 24-month retention without adding an eleventh monitored cron.
CREATE OR REPLACE FUNCTION public.purge_ancient_calendar_registry()
RETURNS TABLE(events_deleted INTEGER, bookings_deleted INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_events INTEGER;
  v_bookings INTEGER;
BEGIN
  DELETE FROM public.calendar_booking_commands
   WHERE created_at < pg_catalog.now() - INTERVAL '24 months';

  DELETE FROM public.calendar_booking_events
   WHERE received_at < pg_catalog.now() - INTERVAL '24 months';
  GET DIAGNOSTICS v_events = ROW_COUNT;

  DELETE FROM public.calendar_bookings
   WHERE end_at < pg_catalog.now() - INTERVAL '24 months';
  GET DIAGNOSTICS v_bookings = ROW_COUNT;

  RETURN QUERY SELECT v_events, v_bookings;
END;
$function$;

COMMIT;
