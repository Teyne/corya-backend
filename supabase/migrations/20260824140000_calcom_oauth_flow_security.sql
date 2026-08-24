-- Complete per-cabinet Cal.com OAuth/PKCE lifecycle.
-- Raw OAuth state, authorization codes and PKCE verifiers never enter public
-- tables. Verifiers and provider tokens live only in Supabase Vault.

BEGIN;

CREATE TABLE public.calendar_oauth_redirect_uris (
  redirect_uri TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    redirect_uri = 'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  )
);

INSERT INTO public.calendar_oauth_redirect_uris (redirect_uri)
VALUES ('https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback');

CREATE TABLE public.calendar_oauth_flows (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  cabinet_id UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_digest BYTEA NOT NULL UNIQUE,
  verifier_secret_id UUID,
  redirect_uri TEXT NOT NULL REFERENCES public.calendar_oauth_redirect_uris(redirect_uri),
  requested_scopes TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'completed', 'failed', 'expired', 'superseded')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    requested_scopes = ARRAY[
      'BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'
    ]::TEXT[]
  ),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '10 minutes'),
  CHECK ((status = 'pending') = (verifier_secret_id IS NOT NULL)),
  CHECK ((status IN ('consumed', 'completed', 'failed')) = (consumed_at IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX calendar_oauth_flows_one_pending_per_cabinet
  ON public.calendar_oauth_flows (cabinet_id)
  WHERE status = 'pending';

CREATE INDEX calendar_oauth_flows_cleanup_idx
  ON public.calendar_oauth_flows (status, expires_at, created_at);

CREATE TABLE public.calendar_connection_audit_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  cabinet_id UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES public.calendar_connections(id) ON DELETE SET NULL,
  flow_id UUID REFERENCES public.calendar_oauth_flows(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('portal_user', 'system')),
  actor_user_id UUID,
  action TEXT NOT NULL CHECK (action IN (
    'oauth_started', 'oauth_connected', 'oauth_denied', 'oauth_failed',
    'oauth_replay_rejected', 'refresh_failed', 'revoked'
  )),
  reason_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (actor_type = 'portal_user' AND actor_user_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_user_id IS NULL)
  ),
  CHECK (
    reason_code IS NULL OR reason_code IN (
      'access_denied', 'token_exchange_failed', 'scope_mismatch',
      'event_type_invalid', 'state_expired', 'state_replayed',
      'verifier_missing', 'refresh_transient', 'refresh_invalid_grant',
      'user_requested', 'provider_revoked'
    )
  )
);

CREATE INDEX calendar_connection_audit_cabinet_created_idx
  ON public.calendar_connection_audit_events (cabinet_id, created_at DESC, id DESC);
CREATE INDEX calendar_connection_audit_retention_idx
  ON public.calendar_connection_audit_events (created_at);
CREATE UNIQUE INDEX calendar_connection_audit_one_replay_per_flow_idx
  ON public.calendar_connection_audit_events (flow_id, action)
  WHERE action = 'oauth_replay_rejected' AND flow_id IS NOT NULL;

ALTER TABLE public.calendar_connections
  ADD COLUMN event_type_id TEXT,
  ADD COLUMN event_type_title TEXT,
  ADD COLUMN event_type_length_minutes INTEGER,
  ADD COLUMN configured_scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'
  ]::TEXT[],
  ADD COLUMN token_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN refresh_lease_owner UUID,
  ADD COLUMN refresh_lease_until TIMESTAMPTZ,
  ADD COLUMN last_refreshed_at TIMESTAMPTZ,
  ADD COLUMN oauth_flow_id UUID REFERENCES public.calendar_oauth_flows(id) ON DELETE SET NULL,
  ADD CONSTRAINT calendar_connections_event_type_id_check CHECK (
    event_type_id IS NULL OR event_type_id ~ '^[1-9][0-9]{0,19}$'
  ),
  ADD CONSTRAINT calendar_connections_event_type_metadata_check CHECK (
    (event_type_id IS NULL AND event_type_title IS NULL AND event_type_length_minutes IS NULL)
    OR (
      event_type_id IS NOT NULL
      AND event_type_title IS NOT NULL
      AND pg_catalog.char_length(event_type_title) BETWEEN 1 AND 120
      AND event_type_title !~ '[[:cntrl:]]'
      AND event_type_length_minutes BETWEEN 5 AND 480
    )
  ),
  ADD CONSTRAINT calendar_connections_configured_scopes_check CHECK (
    configured_scopes = ARRAY[
      'BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'
    ]::TEXT[]
  ),
  ADD CONSTRAINT calendar_connections_token_generation_check CHECK (token_generation >= 0),
  ADD CONSTRAINT calendar_connections_refresh_lease_check CHECK (
    (refresh_lease_owner IS NULL) = (refresh_lease_until IS NULL)
  );

ALTER TABLE public.calendar_oauth_redirect_uris ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_oauth_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_connection_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.calendar_oauth_redirect_uris FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.calendar_oauth_flows FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.calendar_connection_audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.calendar_connection_audit_events TO service_role;

CREATE FUNCTION public.record_calendar_connection_audit(
  p_cabinet_id UUID,
  p_connection_id UUID,
  p_flow_id UUID,
  p_actor_type TEXT,
  p_actor_user_id UUID,
  p_action TEXT,
  p_reason_code TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.calendar_connection_audit_events (
    cabinet_id, connection_id, flow_id, actor_type, actor_user_id, action, reason_code
  ) VALUES (
    p_cabinet_id, p_connection_id, p_flow_id, p_actor_type, p_actor_user_id,
    p_action, p_reason_code
  )
  ON CONFLICT (flow_id, action)
    WHERE action = 'oauth_replay_rejected' AND flow_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_calendar_connection_audit(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.begin_calcom_oauth_flow(
  p_cabinet_id UUID,
  p_actor_user_id UUID,
  p_redirect_uri TEXT
)
RETURNS TABLE (
  flow_id UUID,
  state TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  redirect_uri TEXT,
  requested_scopes TEXT[],
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_state TEXT;
  v_verifier TEXT;
  v_verifier_secret_id UUID;
  v_old RECORD;
BEGIN
  IF p_cabinet_id IS NULL OR p_actor_user_id IS NULL OR p_redirect_uri IS NULL THEN
    RAISE EXCEPTION 'calcom_oauth_begin_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.cabinet_memberships AS cm
     WHERE cm.cabinet_id = p_cabinet_id
       AND cm.user_id = p_actor_user_id
       AND cm.role = 'admin'
       AND cm.actif
  ) THEN
    RAISE EXCEPTION 'calcom_oauth_admin_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.calendar_oauth_redirect_uris AS r
     WHERE r.redirect_uri = p_redirect_uri AND r.enabled
  ) THEN
    RAISE EXCEPTION 'calcom_oauth_redirect_not_allowed';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 7140062026)
  );

  FOR v_old IN
    SELECT id, verifier_secret_id, status
      FROM public.calendar_oauth_flows
     WHERE cabinet_id = p_cabinet_id AND status IN ('pending', 'consumed')
     FOR UPDATE
  LOOP
    DELETE FROM vault.secrets WHERE id = v_old.verifier_secret_id;
    UPDATE public.calendar_oauth_flows
       SET status = CASE WHEN v_old.status = 'pending' THEN 'superseded' ELSE 'failed' END,
           verifier_secret_id = NULL
     WHERE id = v_old.id;
  END LOOP;

  v_state := pg_catalog.rtrim(
    pg_catalog.replace(pg_catalog.replace(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+', '-'
    ), '/', '_'), '='
  );
  v_verifier := pg_catalog.rtrim(
    pg_catalog.replace(pg_catalog.replace(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+', '-'
    ), '/', '_'), '='
  );
  v_verifier_secret_id := vault.create_secret(
    v_verifier,
    'corya_calcom_pkce_' || pg_catalog.gen_random_uuid()::TEXT,
    'Corya Cal.com one-time PKCE verifier',
    NULL
  );

  INSERT INTO public.calendar_oauth_flows (
    cabinet_id, actor_user_id, state_digest, verifier_secret_id,
    redirect_uri, requested_scopes, expires_at
  ) VALUES (
    p_cabinet_id,
    p_actor_user_id,
    extensions.digest(v_state, 'sha256'),
    v_verifier_secret_id,
    p_redirect_uri,
    ARRAY['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ']::TEXT[],
    pg_catalog.now() + INTERVAL '10 minutes'
  )
  RETURNING id, calendar_oauth_flows.redirect_uri,
            calendar_oauth_flows.requested_scopes, calendar_oauth_flows.expires_at
       INTO flow_id, redirect_uri, requested_scopes, expires_at;

  state := v_state;
  code_challenge := pg_catalog.rtrim(
    pg_catalog.replace(pg_catalog.replace(
      pg_catalog.encode(extensions.digest(v_verifier, 'sha256'), 'base64'), '+', '-'
    ), '/', '_'), '='
  );
  code_challenge_method := 'S256';
  PERFORM public.record_calendar_connection_audit(
    p_cabinet_id, NULL, flow_id, 'portal_user', p_actor_user_id,
    'oauth_started', NULL
  );
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.consume_calcom_oauth_flow(p_state TEXT)
RETURNS TABLE (
  outcome TEXT,
  flow_id UUID,
  cabinet_id UUID,
  actor_user_id UUID,
  code_verifier TEXT,
  redirect_uri TEXT,
  requested_scopes TEXT[],
  exchange_deadline TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_flow public.calendar_oauth_flows%ROWTYPE;
BEGIN
  IF p_state IS NULL
     OR pg_catalog.char_length(p_state) NOT BETWEEN 43 AND 128
     OR p_state !~ '^[A-Za-z0-9_-]+$' THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_flow
    FROM public.calendar_oauth_flows
   WHERE state_digest = extensions.digest(p_state, 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;

  flow_id := v_flow.id;
  cabinet_id := v_flow.cabinet_id;
  actor_user_id := v_flow.actor_user_id;
  redirect_uri := v_flow.redirect_uri;
  requested_scopes := v_flow.requested_scopes;

  IF v_flow.status <> 'pending' THEN
    outcome := 'replayed';
    PERFORM public.record_calendar_connection_audit(
      v_flow.cabinet_id, NULL, v_flow.id, 'system', NULL,
      'oauth_replay_rejected', 'state_replayed'
    );
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_flow.expires_at <= pg_catalog.now() THEN
    DELETE FROM vault.secrets WHERE id = v_flow.verifier_secret_id;
    UPDATE public.calendar_oauth_flows
       SET status = 'expired', verifier_secret_id = NULL
     WHERE id = v_flow.id;
    PERFORM public.record_calendar_connection_audit(
      v_flow.cabinet_id, NULL, v_flow.id, 'system', NULL,
      'oauth_failed', 'state_expired'
    );
    outcome := 'expired';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT decrypted_secret INTO code_verifier
    FROM vault.decrypted_secrets
   WHERE id = v_flow.verifier_secret_id;
  DELETE FROM vault.secrets WHERE id = v_flow.verifier_secret_id;
  IF code_verifier IS NULL THEN
    UPDATE public.calendar_oauth_flows
       SET status = 'failed', verifier_secret_id = NULL,
           consumed_at = pg_catalog.now()
     WHERE id = v_flow.id;
    PERFORM public.record_calendar_connection_audit(
      v_flow.cabinet_id, NULL, v_flow.id, 'system', NULL,
      'oauth_failed', 'verifier_missing'
    );
    outcome := 'failed';
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.calendar_oauth_flows
     SET status = 'consumed', verifier_secret_id = NULL,
         consumed_at = pg_catalog.now()
   WHERE id = v_flow.id;
  outcome := 'consumed';
  exchange_deadline := pg_catalog.now() + INTERVAL '2 minutes';
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.complete_calcom_oauth_flow(
  p_flow_id UUID,
  p_access_token TEXT,
  p_refresh_token TEXT,
  p_access_token_expires_at TIMESTAMPTZ,
  p_granted_scopes TEXT[],
  p_provider_account_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  outcome TEXT,
  connection_id UUID,
  status TEXT,
  access_token_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_flow public.calendar_oauth_flows%ROWTYPE;
  v_connection RECORD;
  v_scopes TEXT[];
BEGIN
  SELECT cabinet_id INTO v_flow.cabinet_id
    FROM public.calendar_oauth_flows
   WHERE id = p_flow_id;
  IF NOT FOUND THEN
    outcome := 'replayed';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_flow.cabinet_id::TEXT, 7140062026)
  );
  SELECT * INTO v_flow FROM public.calendar_oauth_flows
   WHERE id = p_flow_id FOR UPDATE;
  IF NOT FOUND OR v_flow.status <> 'consumed' THEN
    outcome := 'replayed';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_flow.consumed_at + INTERVAL '2 minutes' <= pg_catalog.now() THEN
    UPDATE public.calendar_oauth_flows SET status = 'failed' WHERE id = v_flow.id;
    PERFORM public.record_calendar_connection_audit(
      v_flow.cabinet_id, NULL, v_flow.id, 'portal_user', v_flow.actor_user_id,
      'oauth_failed', 'token_exchange_failed'
    );
    outcome := 'expired';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT ARRAY(SELECT DISTINCT s FROM pg_catalog.unnest(p_granted_scopes) AS s ORDER BY s)
    INTO v_scopes;
  IF v_scopes IS DISTINCT FROM v_flow.requested_scopes THEN
    UPDATE public.calendar_oauth_flows SET status = 'failed' WHERE id = v_flow.id;
    PERFORM public.record_calendar_connection_audit(
      v_flow.cabinet_id, NULL, v_flow.id, 'portal_user', v_flow.actor_user_id,
      'oauth_failed', 'scope_mismatch'
    );
    outcome := 'scope_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO STRICT v_connection
    FROM public.upsert_calcom_oauth_connection(
      v_flow.cabinet_id, p_access_token, p_refresh_token,
      p_access_token_expires_at, v_scopes, p_provider_account_id
    );
  UPDATE public.calendar_connections
     SET configured_scopes = v_scopes,
         oauth_flow_id = v_flow.id,
         event_type_id = NULL,
         event_type_title = NULL,
         event_type_length_minutes = NULL,
         token_generation = token_generation + 1,
         refresh_lease_owner = NULL,
         refresh_lease_until = NULL
   WHERE id = v_connection.connection_id;
  UPDATE public.calendar_oauth_flows
     SET status = 'completed', completed_at = pg_catalog.now()
   WHERE id = v_flow.id;
  PERFORM public.record_calendar_connection_audit(
    v_flow.cabinet_id, v_connection.connection_id, v_flow.id,
    'portal_user', v_flow.actor_user_id, 'oauth_connected', NULL
  );

  outcome := 'connected';
  connection_id := v_connection.connection_id;
  status := v_connection.status;
  access_token_expires_at := v_connection.access_token_expires_at;
  updated_at := v_connection.updated_at;
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.fail_calcom_oauth_flow(p_flow_id UUID, p_reason_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_flow public.calendar_oauth_flows%ROWTYPE;
BEGIN
  IF p_reason_code NOT IN ('access_denied', 'token_exchange_failed', 'event_type_invalid') THEN
    RAISE EXCEPTION 'calcom_oauth_failure_reason_invalid';
  END IF;
  SELECT * INTO v_flow FROM public.calendar_oauth_flows
   WHERE id = p_flow_id FOR UPDATE;
  IF NOT FOUND OR v_flow.status <> 'consumed' THEN RETURN FALSE; END IF;
  UPDATE public.calendar_oauth_flows SET status = 'failed' WHERE id = v_flow.id;
  PERFORM public.record_calendar_connection_audit(
    v_flow.cabinet_id, NULL, v_flow.id, 'portal_user', v_flow.actor_user_id,
    CASE WHEN p_reason_code = 'access_denied' THEN 'oauth_denied' ELSE 'oauth_failed' END,
    p_reason_code
  );
  RETURN TRUE;
END;
$function$;

CREATE FUNCTION public.get_calcom_connection_status(p_cabinet_id UUID)
RETURNS TABLE (
  connection_id UUID,
  status TEXT,
  event_type_id TEXT,
  event_type_title TEXT,
  event_type_length_minutes INTEGER,
  configured_scopes TEXT[],
  granted_scopes TEXT[],
  access_token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  error_code TEXT,
  demonstration_mode BOOLEAN,
  runtime_ready BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT cc.id, cc.status, cc.event_type_id, cc.event_type_title,
         cc.event_type_length_minutes, cc.configured_scopes, cc.granted_scopes,
         cc.access_token_expires_at, cc.connected_at, cc.last_refreshed_at,
         cc.error_code,
         COALESCE(c.config_agent -> 'demonstration_mode' = 'true'::JSONB, FALSE),
         COALESCE(
           cc.status = 'connected'
           AND cc.event_type_id IS NOT NULL
           AND cc.granted_scopes = cc.configured_scopes,
           FALSE
         )
    FROM public.cabinets AS c
    LEFT JOIN public.calendar_connections AS cc
      ON cc.cabinet_id = c.id AND cc.provider = 'cal.com'
   WHERE c.id = p_cabinet_id;
$function$;

CREATE FUNCTION public.set_calcom_event_type(
  p_cabinet_id UUID,
  p_actor_user_id UUID,
  p_event_type_id TEXT,
  p_title TEXT,
  p_length_minutes INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_event_type_id IS NULL OR p_event_type_id !~ '^[1-9][0-9]{0,19}$'
     OR p_title IS NULL OR pg_catalog.char_length(p_title) NOT BETWEEN 1 AND 120
     OR p_title ~ '[[:cntrl:]]'
     OR p_length_minutes NOT BETWEEN 5 AND 480 THEN
    RAISE EXCEPTION 'calcom_event_type_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.cabinet_memberships AS cm
     WHERE cm.cabinet_id = p_cabinet_id AND cm.user_id = p_actor_user_id
       AND cm.role = 'admin' AND cm.actif
  ) THEN
    RAISE EXCEPTION 'calcom_oauth_admin_required';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 7140062026)
  );
  UPDATE public.calendar_connections
     SET event_type_id = p_event_type_id,
         event_type_title = p_title,
         event_type_length_minutes = p_length_minutes
   WHERE cabinet_id = p_cabinet_id AND provider = 'cal.com'
     AND status = 'connected';
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_calcom_connection_credentials(p_cabinet_id UUID)
RETURNS TABLE (
  connection_id UUID, status TEXT, access_token TEXT, refresh_token TEXT,
  access_token_expires_at TIMESTAMPTZ, granted_scopes TEXT[],
  provider_account_id TEXT, demonstration_mode BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT cc.id, cc.status,
         CASE WHEN cc.status = 'connected'
                    AND cc.granted_scopes = cc.configured_scopes
                    AND cc.access_token_expires_at > pg_catalog.now()
              THEN access_secret.decrypted_secret ELSE NULL END,
         NULL::TEXT,
         cc.access_token_expires_at,
         COALESCE(cc.granted_scopes, ARRAY[]::TEXT[]), cc.provider_account_id,
         COALESCE(c.config_agent -> 'demonstration_mode' = 'true'::JSONB, FALSE)
    FROM public.cabinets AS c
    LEFT JOIN public.calendar_connections AS cc
      ON cc.cabinet_id = c.id AND cc.provider = 'cal.com'
    LEFT JOIN vault.decrypted_secrets AS access_secret ON access_secret.id = cc.access_secret_id
   WHERE c.id = p_cabinet_id;
$function$;

CREATE FUNCTION public.claim_calcom_oauth_refresh(
  p_cabinet_id UUID,
  p_lease_owner UUID,
  p_min_validity_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
  outcome TEXT,
  connection_id UUID,
  token_generation BIGINT,
  refresh_token TEXT,
  configured_scopes TEXT[],
  event_type_id TEXT,
  lease_until TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_connection public.calendar_connections%ROWTYPE;
BEGIN
  IF p_lease_owner IS NULL OR p_min_validity_seconds NOT BETWEEN 60 AND 600 THEN
    RAISE EXCEPTION 'calcom_refresh_claim_invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 7140062026)
  );
  SELECT * INTO v_connection FROM public.calendar_connections
   WHERE cabinet_id = p_cabinet_id AND provider = 'cal.com' FOR UPDATE;
  IF NOT FOUND OR v_connection.status NOT IN ('connected', 'expired') THEN
    outcome := 'unavailable'; RETURN NEXT; RETURN;
  END IF;
  connection_id := v_connection.id;
  token_generation := v_connection.token_generation;
  configured_scopes := v_connection.configured_scopes;
  event_type_id := v_connection.event_type_id;
  IF v_connection.refresh_lease_until > pg_catalog.now() THEN
    outcome := 'busy'; RETURN NEXT; RETURN;
  END IF;
  IF v_connection.status = 'connected'
     AND v_connection.access_token_expires_at >
       pg_catalog.now() + pg_catalog.make_interval(secs => p_min_validity_seconds) THEN
    outcome := 'not_due'; RETURN NEXT; RETURN;
  END IF;
  SELECT decrypted_secret INTO refresh_token FROM vault.decrypted_secrets
   WHERE id = v_connection.refresh_secret_id;
  IF refresh_token IS NULL THEN
    UPDATE public.calendar_connections
       SET status = 'error', error_code = 'refresh_invalid_grant',
           refresh_lease_owner = NULL, refresh_lease_until = NULL
     WHERE id = v_connection.id;
    outcome := 'unavailable'; RETURN NEXT; RETURN;
  END IF;
  lease_until := pg_catalog.now() + INTERVAL '30 seconds';
  UPDATE public.calendar_connections
     SET refresh_lease_owner = p_lease_owner, refresh_lease_until = lease_until
   WHERE id = v_connection.id;
  outcome := 'claimed';
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.complete_calcom_oauth_refresh(
  p_connection_id UUID,
  p_lease_owner UUID,
  p_expected_generation BIGINT,
  p_access_token TEXT,
  p_refresh_token TEXT,
  p_access_token_expires_at TIMESTAMPTZ,
  p_granted_scopes TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_connection public.calendar_connections%ROWTYPE;
  v_scopes TEXT[];
BEGIN
  SELECT ARRAY(SELECT DISTINCT s FROM pg_catalog.unnest(p_granted_scopes) AS s ORDER BY s)
    INTO v_scopes;
  IF pg_catalog.char_length(p_access_token) NOT BETWEEN 1 AND 8192
     OR pg_catalog.char_length(p_refresh_token) NOT BETWEEN 1 AND 8192
     OR p_access_token_expires_at <= pg_catalog.now() THEN RETURN FALSE; END IF;
  SELECT * INTO v_connection FROM public.calendar_connections
   WHERE id = p_connection_id FOR UPDATE;
  IF NOT FOUND OR v_connection.refresh_lease_owner IS DISTINCT FROM p_lease_owner
     OR v_connection.refresh_lease_until <= pg_catalog.now()
     OR v_connection.token_generation <> p_expected_generation
     OR v_scopes IS DISTINCT FROM v_connection.configured_scopes THEN RETURN FALSE; END IF;
  PERFORM vault.update_secret(v_connection.access_secret_id, p_access_token, NULL, NULL, NULL);
  PERFORM vault.update_secret(v_connection.refresh_secret_id, p_refresh_token, NULL, NULL, NULL);
  UPDATE public.calendar_connections
     SET status = 'connected', error_code = NULL,
         access_token_expires_at = p_access_token_expires_at,
         granted_scopes = v_scopes,
         token_generation = token_generation + 1,
         refresh_lease_owner = NULL, refresh_lease_until = NULL,
         last_refreshed_at = pg_catalog.now()
   WHERE id = v_connection.id;
  RETURN TRUE;
END;
$function$;

CREATE FUNCTION public.fail_calcom_oauth_refresh(
  p_connection_id UUID,
  p_lease_owner UUID,
  p_expected_generation BIGINT,
  p_reason_code TEXT,
  p_terminal BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_connection public.calendar_connections%ROWTYPE;
BEGIN
  IF (p_terminal AND p_reason_code <> 'refresh_invalid_grant')
     OR (NOT p_terminal AND p_reason_code <> 'refresh_transient') THEN
    RAISE EXCEPTION 'calcom_refresh_failure_invalid';
  END IF;
  SELECT * INTO v_connection FROM public.calendar_connections
   WHERE id = p_connection_id FOR UPDATE;
  IF NOT FOUND OR v_connection.refresh_lease_owner IS DISTINCT FROM p_lease_owner
     OR v_connection.refresh_lease_until <= pg_catalog.now()
     OR v_connection.token_generation <> p_expected_generation THEN RETURN FALSE; END IF;
  UPDATE public.calendar_connections
     SET status = CASE WHEN p_terminal THEN 'error' ELSE 'expired' END,
         error_code = CASE WHEN p_terminal THEN p_reason_code ELSE NULL END,
         refresh_lease_owner = NULL, refresh_lease_until = NULL
   WHERE id = v_connection.id;
  PERFORM public.record_calendar_connection_audit(
    v_connection.cabinet_id, v_connection.id, NULL, 'system', NULL,
    'refresh_failed', p_reason_code
  );
  RETURN TRUE;
END;
$function$;

CREATE FUNCTION public.disconnect_calcom_oauth_connection(
  p_cabinet_id UUID,
  p_actor_user_id UUID,
  p_reason_code TEXT DEFAULT 'user_requested'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_connection_id UUID;
  v_connection_status TEXT;
  v_old RECORD;
  v_result BOOLEAN;
BEGIN
  IF p_reason_code NOT IN ('user_requested', 'provider_revoked') THEN
    RAISE EXCEPTION 'calcom_disconnect_reason_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.cabinet_memberships AS cm
     WHERE cm.cabinet_id = p_cabinet_id AND cm.user_id = p_actor_user_id
       AND cm.role = 'admin' AND cm.actif
  ) THEN RAISE EXCEPTION 'calcom_oauth_admin_required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 7140062026)
  );
  SELECT id, status INTO v_connection_id, v_connection_status FROM public.calendar_connections
   WHERE cabinet_id = p_cabinet_id AND provider = 'cal.com';
  FOR v_old IN SELECT id, verifier_secret_id, status FROM public.calendar_oauth_flows
    WHERE cabinet_id = p_cabinet_id AND status IN ('pending', 'consumed') FOR UPDATE
  LOOP
    DELETE FROM vault.secrets WHERE id = v_old.verifier_secret_id;
    UPDATE public.calendar_oauth_flows
       SET status = CASE WHEN v_old.status = 'pending' THEN 'superseded' ELSE 'failed' END,
           verifier_secret_id = NULL
     WHERE id = v_old.id;
  END LOOP;
  IF v_connection_status = 'revoked' THEN
    RETURN TRUE;
  END IF;
  v_result := public.revoke_calcom_connection(p_cabinet_id);
  IF v_result THEN
    UPDATE public.calendar_connections
       SET event_type_id = NULL, event_type_title = NULL,
           event_type_length_minutes = NULL,
           refresh_lease_owner = NULL, refresh_lease_until = NULL
     WHERE id = v_connection_id;
    PERFORM public.record_calendar_connection_audit(
      p_cabinet_id, v_connection_id, NULL, 'portal_user', p_actor_user_id,
      'revoked', p_reason_code
    );
  END IF;
  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.purge_calcom_oauth_security_state(p_limit INTEGER DEFAULT 500)
RETURNS TABLE (
  flows_expired INTEGER,
  flows_deleted INTEGER,
  audit_deleted INTEGER,
  vault_secrets_deleted INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_flow RECORD;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'calcom_oauth_purge_limit_invalid';
  END IF;
  flows_expired := 0; flows_deleted := 0; audit_deleted := 0; vault_secrets_deleted := 0;
  FOR v_flow IN
    SELECT id, verifier_secret_id FROM public.calendar_oauth_flows
     WHERE status = 'pending' AND expires_at <= pg_catalog.now()
     ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    DELETE FROM vault.secrets WHERE id = v_flow.verifier_secret_id;
    IF FOUND THEN vault_secrets_deleted := vault_secrets_deleted + 1; END IF;
    UPDATE public.calendar_oauth_flows
       SET status = 'expired', verifier_secret_id = NULL WHERE id = v_flow.id;
    flows_expired := flows_expired + 1;
  END LOOP;
  DELETE FROM public.calendar_oauth_flows WHERE id IN (
    SELECT id FROM public.calendar_oauth_flows
     WHERE status <> 'pending' AND created_at < pg_catalog.now() - INTERVAL '24 hours'
     ORDER BY created_at, id LIMIT p_limit
  );
  GET DIAGNOSTICS flows_deleted = ROW_COUNT;
  DELETE FROM public.calendar_connection_audit_events WHERE id IN (
    SELECT id FROM public.calendar_connection_audit_events
     WHERE created_at < pg_catalog.now() - INTERVAL '12 months'
     ORDER BY created_at, id LIMIT p_limit
  );
  GET DIAGNOSTICS audit_deleted = ROW_COUNT;
  RETURN NEXT;
END;
$function$;

-- Mutations now go through one-time flow / lease / audited wrappers.
REVOKE EXECUTE ON FUNCTION public.upsert_calcom_oauth_connection(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT[], TEXT)
  FROM service_role;
REVOKE EXECUTE ON FUNCTION public.set_calcom_connection_state(UUID, TEXT, TEXT)
  FROM service_role;
REVOKE EXECUTE ON FUNCTION public.revoke_calcom_connection(UUID)
  FROM service_role;

REVOKE ALL ON FUNCTION public.begin_calcom_oauth_flow(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_calcom_oauth_flow(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_calcom_oauth_flow(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_calcom_oauth_flow(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_calcom_connection_status(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_calcom_event_type(UUID, UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_calcom_oauth_refresh(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_calcom_oauth_refresh(UUID, UUID, BIGINT, TEXT, TEXT, TIMESTAMPTZ, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_calcom_oauth_refresh(UUID, UUID, BIGINT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.disconnect_calcom_oauth_connection(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_calcom_oauth_security_state(INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_calcom_oauth_flow(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_calcom_oauth_flow(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_calcom_oauth_flow(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_calcom_oauth_flow(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_calcom_connection_status(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_calcom_event_type(UUID, UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_calcom_oauth_refresh(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_calcom_oauth_refresh(UUID, UUID, BIGINT, TEXT, TEXT, TIMESTAMPTZ, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_calcom_oauth_refresh(UUID, UUID, BIGINT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.disconnect_calcom_oauth_connection(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_calcom_oauth_security_state(INTEGER) TO service_role;

-- Keep the monitored cron name/schedule; append only the bounded OAuth cleanup.
DO $cron_replace$
BEGIN
  PERFORM cron.unschedule('purge-expired-audio');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron_replace$;

SELECT cron.schedule(
  'purge-expired-audio',
  '0 * * * *',
  $$ SELECT public.purge_expired_audio(), public.purge_calcom_oauth_security_state(); $$
);

COMMIT;
