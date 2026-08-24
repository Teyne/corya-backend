-- Per-cabinet Cal.com OAuth registry.
--
-- OAuth access and refresh tokens are stored only in Supabase Vault. The
-- public table contains opaque Vault UUID references and bounded, non-secret
-- operational metadata. The temporary process-level demonstration API key is
-- deliberately not persisted here: callers may use it only when the exact
-- JSON boolean at cabinets.config_agent.demonstration_mode is true.

CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

DO $migration$
BEGIN
  -- Current hosted/local Supabase Vault adds an optional key UUID after the
  -- documented secret/name/description arguments. Pin that callable contract
  -- here so a platform mismatch fails before any registry object is created.
  IF pg_catalog.to_regprocedure('vault.create_secret(text,text,text,uuid)') IS NULL
     OR pg_catalog.to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'calcom_vault_function_contract_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'vault'
       AND table_name = 'decrypted_secrets'
       AND column_name = 'decrypted_secret'
  ) THEN
    RAISE EXCEPTION 'calcom_vault_decrypted_view_contract_missing';
  END IF;
END;
$migration$;

CREATE TABLE public.calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'cal.com'
    CHECK (provider = 'cal.com'),
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'expired', 'revoked', 'error')),
  access_secret_id UUID,
  refresh_secret_id UUID,
  access_token_expires_at TIMESTAMPTZ,
  granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  provider_account_id TEXT,
  error_code TEXT,
  connected_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cabinet_id, provider),
  CHECK (
    access_secret_id IS NULL
    OR refresh_secret_id IS NULL
    OR access_secret_id <> refresh_secret_id
  ),
  CHECK (cardinality(granted_scopes) <= 32),
  CHECK (
    provider_account_id IS NULL
    OR (
      char_length(provider_account_id) BETWEEN 1 AND 200
      AND provider_account_id ~ '^[A-Za-z0-9._-]+$'
    )
  ),
  CHECK (
    error_code IS NULL
    OR (
      char_length(error_code) BETWEEN 1 AND 80
      AND error_code ~ '^[a-z0-9_:-]+$'
    )
  ),
  CHECK ((status = 'error') = (error_code IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (
    (status = 'revoked'
      AND access_secret_id IS NULL
      AND refresh_secret_id IS NULL
      AND access_token_expires_at IS NULL)
    OR
    (status <> 'revoked'
      AND access_secret_id IS NOT NULL
      AND refresh_secret_id IS NOT NULL
      AND access_token_expires_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.calendar_connections IS
  'Tenant-scoped Cal.com OAuth metadata. Token values live only in Supabase Vault.';
COMMENT ON COLUMN public.calendar_connections.access_secret_id IS
  'Opaque reference to an encrypted Supabase Vault access token.';
COMMENT ON COLUMN public.calendar_connections.refresh_secret_id IS
  'Opaque reference to an encrypted Supabase Vault refresh token.';

CREATE INDEX calendar_connections_status_idx
  ON public.calendar_connections (status, access_token_expires_at);

CREATE UNIQUE INDEX calendar_connections_access_secret_uidx
  ON public.calendar_connections (access_secret_id)
  WHERE access_secret_id IS NOT NULL;

CREATE UNIQUE INDEX calendar_connections_refresh_secret_uidx
  ON public.calendar_connections (refresh_secret_id)
  WHERE refresh_secret_id IS NOT NULL;

ALTER TABLE public.calendar_connections ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.calendar_connections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.calendar_connections FROM service_role;

CREATE FUNCTION public.protect_calendar_connection_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.provider <> 'cal.com' THEN
    RAISE EXCEPTION 'calendar_connection_provider_invalid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.unnest(NEW.granted_scopes) AS scope(value)
     WHERE pg_catalog.char_length(scope.value) NOT BETWEEN 1 AND 120
        OR scope.value !~ '^[A-Za-z0-9._:/-]+$'
  ) THEN
    RAISE EXCEPTION 'calendar_connection_scopes_invalid';
  END IF;

  NEW.granted_scopes := ARRAY(
    SELECT DISTINCT scope.value
      FROM pg_catalog.unnest(NEW.granted_scopes) AS scope(value)
     ORDER BY scope.value
  );
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.protect_calendar_connection_write() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER protect_calendar_connection_write
BEFORE INSERT OR UPDATE ON public.calendar_connections
FOR EACH ROW EXECUTE FUNCTION public.protect_calendar_connection_write();

CREATE FUNCTION public.upsert_calcom_oauth_connection(
  p_cabinet_id UUID,
  p_access_token TEXT,
  p_refresh_token TEXT,
  p_access_token_expires_at TIMESTAMPTZ,
  p_granted_scopes TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_provider_account_id TEXT DEFAULT NULL
)
RETURNS TABLE (
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
  v_connection public.calendar_connections%ROWTYPE;
  v_existing BOOLEAN := FALSE;
  v_access_secret_id UUID;
  v_refresh_secret_id UUID;
BEGIN
  IF p_cabinet_id IS NULL
     OR p_access_token IS NULL
     OR pg_catalog.char_length(p_access_token) NOT BETWEEN 1 AND 8192
     OR p_refresh_token IS NULL
     OR pg_catalog.char_length(p_refresh_token) NOT BETWEEN 1 AND 8192
     OR p_access_token_expires_at IS NULL
     OR p_access_token_expires_at <= pg_catalog.now()
     OR p_granted_scopes IS NULL
     OR pg_catalog.cardinality(p_granted_scopes) > 32
     OR (p_provider_account_id IS NOT NULL AND (
       pg_catalog.char_length(p_provider_account_id) NOT BETWEEN 1 AND 200
       OR p_provider_account_id !~ '^[A-Za-z0-9._-]+$'
     ))
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(p_granted_scopes) AS scope(value)
        WHERE pg_catalog.char_length(scope.value) NOT BETWEEN 1 AND 120
           OR scope.value !~ '^[A-Za-z0-9._:/-]+$'
     ) THEN
    RAISE EXCEPTION 'calcom_oauth_connection_invalid';
  END IF;

  -- Serialize all state and Vault mutations for one tenant.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 7140062026)
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.cabinets WHERE id = p_cabinet_id FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION 'calcom_oauth_cabinet_not_found';
  END IF;

  SELECT *
    INTO v_connection
    FROM public.calendar_connections
   WHERE cabinet_id = p_cabinet_id
     AND provider = 'cal.com'
   FOR UPDATE;
  v_existing := FOUND;

  IF v_existing AND v_connection.access_secret_id IS NOT NULL THEN
    v_access_secret_id := v_connection.access_secret_id;
    PERFORM vault.update_secret(v_access_secret_id, p_access_token, NULL, NULL, NULL);
  ELSE
    v_access_secret_id := vault.create_secret(
      p_access_token,
      'corya_calcom_access_' || pg_catalog.gen_random_uuid()::TEXT,
      'Corya Cal.com OAuth access token',
      NULL
    );
  END IF;

  IF v_existing AND v_connection.refresh_secret_id IS NOT NULL THEN
    v_refresh_secret_id := v_connection.refresh_secret_id;
    PERFORM vault.update_secret(v_refresh_secret_id, p_refresh_token, NULL, NULL, NULL);
  ELSE
    v_refresh_secret_id := vault.create_secret(
      p_refresh_token,
      'corya_calcom_refresh_' || pg_catalog.gen_random_uuid()::TEXT,
      'Corya Cal.com OAuth refresh token',
      NULL
    );
  END IF;

  INSERT INTO public.calendar_connections (
    id,
    cabinet_id,
    provider,
    status,
    access_secret_id,
    refresh_secret_id,
    access_token_expires_at,
    granted_scopes,
    provider_account_id,
    error_code,
    connected_at,
    revoked_at
  ) VALUES (
    COALESCE(v_connection.id, pg_catalog.gen_random_uuid()),
    p_cabinet_id,
    'cal.com',
    'connected',
    v_access_secret_id,
    v_refresh_secret_id,
    p_access_token_expires_at,
    ARRAY(
      SELECT DISTINCT scope.value
        FROM pg_catalog.unnest(p_granted_scopes) AS scope(value)
       ORDER BY scope.value
    ),
    p_provider_account_id,
    NULL,
    pg_catalog.now(),
    NULL
  )
  ON CONFLICT (cabinet_id, provider) DO UPDATE
     SET status = 'connected',
         access_secret_id = EXCLUDED.access_secret_id,
         refresh_secret_id = EXCLUDED.refresh_secret_id,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         granted_scopes = EXCLUDED.granted_scopes,
         provider_account_id = EXCLUDED.provider_account_id,
         error_code = NULL,
         connected_at = pg_catalog.now(),
         revoked_at = NULL
  RETURNING calendar_connections.id,
            calendar_connections.status,
            calendar_connections.access_token_expires_at,
            calendar_connections.updated_at
       INTO connection_id, status, access_token_expires_at, updated_at;

  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.get_calcom_connection_credentials(p_cabinet_id UUID)
RETURNS TABLE (
  connection_id UUID,
  status TEXT,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  granted_scopes TEXT[],
  provider_account_id TEXT,
  demonstration_mode BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT cc.id,
         cc.status,
         CASE
           WHEN cc.status = 'connected'
            AND cc.access_token_expires_at > pg_catalog.now()
             THEN access_secret.decrypted_secret
           ELSE NULL
         END,
         CASE
           WHEN cc.status IN ('connected', 'expired')
             THEN refresh_secret.decrypted_secret
           ELSE NULL
         END,
         cc.access_token_expires_at,
         COALESCE(cc.granted_scopes, ARRAY[]::TEXT[]),
         cc.provider_account_id,
         COALESCE(
           c.config_agent -> 'demonstration_mode' = 'true'::JSONB,
           FALSE
         )
    FROM public.cabinets AS c
    LEFT JOIN public.calendar_connections AS cc
      ON cc.cabinet_id = c.id
     AND cc.provider = 'cal.com'
    LEFT JOIN vault.decrypted_secrets AS access_secret
      ON access_secret.id = cc.access_secret_id
    LEFT JOIN vault.decrypted_secrets AS refresh_secret
      ON refresh_secret.id = cc.refresh_secret_id
   WHERE c.id = p_cabinet_id;
$function$;

CREATE FUNCTION public.set_calcom_connection_state(
  p_cabinet_id UUID,
  p_status TEXT,
  p_error_code TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_status NOT IN ('expired', 'error')
     OR (p_status = 'expired' AND p_error_code IS NOT NULL)
     OR (p_status = 'error' AND (
       p_error_code IS NULL
       OR pg_catalog.char_length(p_error_code) NOT BETWEEN 1 AND 80
       OR p_error_code !~ '^[a-z0-9_:-]+$'
     )) THEN
    RAISE EXCEPTION 'calcom_connection_state_invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 7140062026)
  );

  UPDATE public.calendar_connections
     SET status = p_status,
         error_code = CASE WHEN p_status = 'error' THEN p_error_code ELSE NULL END,
         revoked_at = NULL
   WHERE cabinet_id = p_cabinet_id
     AND provider = 'cal.com'
     AND status <> 'revoked';

  RETURN FOUND;
END;
$function$;

CREATE FUNCTION public.revoke_calcom_connection(p_cabinet_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_connection public.calendar_connections%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cabinet_id::TEXT, 7140062026)
  );

  SELECT *
    INTO v_connection
    FROM public.calendar_connections
   WHERE cabinet_id = p_cabinet_id
     AND provider = 'cal.com'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_connection.status = 'revoked' THEN
    RETURN TRUE;
  END IF;

  DELETE FROM vault.secrets
   WHERE id IN (v_connection.access_secret_id, v_connection.refresh_secret_id);

  UPDATE public.calendar_connections
     SET status = 'revoked',
         access_secret_id = NULL,
         refresh_secret_id = NULL,
         access_token_expires_at = NULL,
         granted_scopes = ARRAY[]::TEXT[],
         provider_account_id = NULL,
         error_code = NULL,
         revoked_at = pg_catalog.now()
   WHERE id = v_connection.id;

  RETURN TRUE;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_calcom_oauth_connection(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT[], TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_calcom_connection_credentials(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_calcom_connection_state(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_calcom_connection(UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_calcom_oauth_connection(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT[], TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_calcom_connection_credentials(UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_calcom_connection_state(UUID, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_calcom_connection(UUID)
  TO service_role;
