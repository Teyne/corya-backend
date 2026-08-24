\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut, config_agent
) VALUES
  (
    'cc100000-0000-4000-8000-000000000001',
    'Synthetic OAuth production', 'synthetic-oauth-production', '+41000000031',
    'oauth-production@example.invalid', 'actif',
    '{"demonstration_mode":false,"calendar":{"provider":"cal.com"}}'::JSONB
  ),
  (
    'cc100000-0000-4000-8000-000000000002',
    'Synthetic OAuth demo', 'synthetic-oauth-demo', '+41000000032',
    'oauth-demo@example.invalid', 'actif',
    '{"demonstration_mode":true,"calendar":{"provider":"cal.com"}}'::JSONB
  ),
  (
    'cc100000-0000-4000-8000-000000000003',
    'Synthetic OAuth truthy string', 'synthetic-oauth-string', '+41000000033',
    'oauth-string@example.invalid', 'actif',
    '{"demonstration_mode":"true","calendar":{"provider":"cal.com"}}'::JSONB
  ),
  (
    'cc100000-0000-4000-8000-000000000004',
    'Synthetic OAuth missing flag', 'synthetic-oauth-missing', '+41000000034',
    'oauth-missing@example.invalid', 'actif',
    '{"calendar":{"provider":"cal.com"}}'::JSONB
  );

DO $test$
DECLARE
  v_proc REGPROCEDURE;
  v_path TEXT;
  v_security_definer BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'calendar_connections'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'calendar_connections_rls_not_enabled';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'calendar_connections'
       AND column_name IN (
         'access_token', 'refresh_token', 'api_key', 'secret', 'token',
         'email', 'name', 'phone', 'payload', 'raw_body'
       )
  ) THEN
    RAISE EXCEPTION 'calendar_connections_contains_plaintext_or_pii_column';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'public.calendar_connections', 'SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.calendar_connections', 'SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('service_role', 'public.calendar_connections', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'calendar_connections_direct_role_access_present';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'calendar_connections'
  ) THEN
    RAISE EXCEPTION 'calendar_connections_has_non_deny_default_policy';
  END IF;

  v_proc := 'public.protect_calendar_connection_write()'::REGPROCEDURE;
  IF pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE') THEN
    RAISE EXCEPTION 'calendar_connection_trigger_function_executable';
  END IF;

  SELECT p.prosecdef,
         COALESCE((
           SELECT setting
             FROM pg_catalog.unnest(p.proconfig) AS setting
            WHERE setting LIKE 'search_path=%'
         ), '')
    INTO v_security_definer, v_path
    FROM pg_catalog.pg_proc p
   WHERE p.oid = v_proc::OID;
  IF NOT v_security_definer OR v_path <> 'search_path=pg_catalog, pg_temp' THEN
    RAISE EXCEPTION 'calendar_connection_trigger_not_hardened path=%', v_path;
  END IF;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.upsert_calcom_oauth_connection(uuid,text,text,timestamp with time zone,text[],text)'::REGPROCEDURE,
    'public.get_calcom_connection_credentials(uuid)'::REGPROCEDURE,
    'public.set_calcom_connection_state(uuid,text,text)'::REGPROCEDURE,
    'public.revoke_calcom_connection(uuid)'::REGPROCEDURE
  ] LOOP
    IF pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE') THEN
      RAISE EXCEPTION 'calendar_connection_rpc_exposed_to_user_role proc=%', v_proc;
    END IF;
    IF NOT pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE') THEN
      RAISE EXCEPTION 'calendar_connection_rpc_missing_service_grant proc=%', v_proc;
    END IF;

    SELECT p.prosecdef,
           COALESCE((
             SELECT setting
               FROM pg_catalog.unnest(p.proconfig) AS setting
              WHERE setting LIKE 'search_path=%'
           ), '')
      INTO v_security_definer, v_path
      FROM pg_catalog.pg_proc p
     WHERE p.oid = v_proc::OID;

    IF NOT v_security_definer OR v_path <> 'search_path=pg_catalog, pg_temp' THEN
      RAISE EXCEPTION 'calendar_connection_rpc_not_hardened proc=% path=%', v_proc, v_path;
    END IF;
  END LOOP;
END;
$test$;

-- The database exposes the demo fallback flag only for the exact JSON boolean.
DO $test$
DECLARE
  v_demo BOOLEAN;
  v_string BOOLEAN;
  v_missing BOOLEAN;
BEGIN
  SELECT demonstration_mode INTO STRICT v_demo
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000002'
    );
  SELECT demonstration_mode INTO STRICT v_string
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000003'
    );
  SELECT demonstration_mode INTO STRICT v_missing
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000004'
    );
  IF v_demo IS NOT TRUE OR v_string IS NOT FALSE OR v_missing IS NOT FALSE THEN
    RAISE EXCEPTION 'demonstration_mode_not_fail_closed demo=% string=% missing=%',
      v_demo, v_string, v_missing;
  END IF;
END;
$test$;

-- Initial OAuth connection persists only Vault references in the tenant table.
DO $test$
DECLARE
  v_result RECORD;
  v_credentials RECORD;
  v_access_id UUID;
  v_refresh_id UUID;
BEGIN
  SELECT * INTO STRICT v_result
    FROM public.upsert_calcom_oauth_connection(
      'cc100000-0000-4000-8000-000000000001',
      'synthetic-access-token-v1',
      'synthetic-refresh-token-v1',
      '2030-08-24T12:00:00Z',
      ARRAY['BOOKING_READ', 'BOOKING_WRITE', 'BOOKING_READ'],
      'synthetic_account_01'
    );
  IF v_result.status <> 'connected' THEN
    RAISE EXCEPTION 'oauth_initial_connection_not_connected result=%', v_result;
  END IF;

  SELECT access_secret_id, refresh_secret_id
    INTO STRICT v_access_id, v_refresh_id
    FROM public.calendar_connections
   WHERE cabinet_id = 'cc100000-0000-4000-8000-000000000001';
  IF v_access_id IS NULL OR v_refresh_id IS NULL OR v_access_id = v_refresh_id THEN
    RAISE EXCEPTION 'oauth_vault_references_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_access_id)
     OR NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_refresh_id) THEN
    RAISE EXCEPTION 'oauth_vault_secrets_missing';
  END IF;

  SELECT * INTO STRICT v_credentials
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000001'
    );
  IF v_credentials.access_token <> 'synthetic-access-token-v1'
     OR v_credentials.refresh_token <> 'synthetic-refresh-token-v1'
     OR v_credentials.demonstration_mode IS NOT FALSE
     OR v_credentials.granted_scopes <> ARRAY['BOOKING_READ', 'BOOKING_WRITE']::TEXT[] THEN
    RAISE EXCEPTION 'oauth_credentials_read_invalid result=%', v_credentials;
  END IF;
END;
$test$;

-- A second tenant receives independent Vault references and cannot influence
-- the first tenant's credentials through the cabinet-scoped read RPC.
DO $test$
DECLARE
  v_production RECORD;
  v_demo RECORD;
BEGIN
  PERFORM public.upsert_calcom_oauth_connection(
    'cc100000-0000-4000-8000-000000000002',
    'synthetic-demo-access-token',
    'synthetic-demo-refresh-token',
    '2030-08-24T12:00:00Z',
    ARRAY['BOOKING_READ'],
    'synthetic_account_02'
  );
  SELECT * INTO STRICT v_production
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000001'
    );
  SELECT * INTO STRICT v_demo
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000002'
    );
  IF v_production.connection_id = v_demo.connection_id
     OR v_production.access_token = v_demo.access_token
     OR v_production.refresh_token = v_demo.refresh_token
     OR v_production.demonstration_mode IS NOT FALSE
     OR v_demo.demonstration_mode IS NOT TRUE THEN
    RAISE EXCEPTION 'oauth_tenant_isolation_failed';
  END IF;
END;
$test$;

-- Replay/rotation is idempotent: same row and Vault UUIDs, updated ciphertext.
DO $test$
DECLARE
  v_before RECORD;
  v_after RECORD;
  v_credentials RECORD;
BEGIN
  SELECT id, access_secret_id, refresh_secret_id INTO STRICT v_before
    FROM public.calendar_connections
   WHERE cabinet_id = 'cc100000-0000-4000-8000-000000000001';

  PERFORM public.upsert_calcom_oauth_connection(
    'cc100000-0000-4000-8000-000000000001',
    'synthetic-access-token-v2',
    'synthetic-refresh-token-v2',
    '2030-08-24T13:00:00Z',
    ARRAY['BOOKING_WRITE'],
    'synthetic_account_01'
  );

  SELECT id, access_secret_id, refresh_secret_id INTO STRICT v_after
    FROM public.calendar_connections
   WHERE cabinet_id = 'cc100000-0000-4000-8000-000000000001';
  IF v_after.id <> v_before.id
     OR v_after.access_secret_id <> v_before.access_secret_id
     OR v_after.refresh_secret_id <> v_before.refresh_secret_id THEN
    RAISE EXCEPTION 'oauth_replay_created_new_registry_or_secrets';
  END IF;

  SELECT * INTO STRICT v_credentials
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000001'
    );
  IF v_credentials.access_token <> 'synthetic-access-token-v2'
     OR v_credentials.refresh_token <> 'synthetic-refresh-token-v2' THEN
    RAISE EXCEPTION 'oauth_rotation_not_visible';
  END IF;
END;
$test$;

-- Expired exposes only the refresh credential; error exposes no credential.
DO $test$
DECLARE
  v_credentials RECORD;
BEGIN
  IF NOT public.set_calcom_connection_state(
    'cc100000-0000-4000-8000-000000000001', 'expired', NULL
  ) THEN
    RAISE EXCEPTION 'oauth_expired_transition_missing';
  END IF;
  SELECT * INTO STRICT v_credentials
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000001'
    );
  IF v_credentials.access_token IS NOT NULL
     OR v_credentials.refresh_token <> 'synthetic-refresh-token-v2' THEN
    RAISE EXCEPTION 'oauth_expired_credentials_not_fail_closed';
  END IF;

  IF NOT public.set_calcom_connection_state(
    'cc100000-0000-4000-8000-000000000001', 'error', 'provider_refresh_failed'
  ) THEN
    RAISE EXCEPTION 'oauth_error_transition_missing';
  END IF;
  SELECT * INTO STRICT v_credentials
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000001'
    );
  IF v_credentials.access_token IS NOT NULL OR v_credentials.refresh_token IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_error_exposed_credentials';
  END IF;
END;
$test$;

-- Reconnect, then revoke atomically; replayed revocation is harmless.
DO $test$
DECLARE
  v_access_id UUID;
  v_refresh_id UUID;
  v_credentials RECORD;
BEGIN
  PERFORM public.upsert_calcom_oauth_connection(
    'cc100000-0000-4000-8000-000000000001',
    'synthetic-access-token-v3',
    'synthetic-refresh-token-v3',
    '2030-08-24T14:00:00Z',
    ARRAY['BOOKING_READ'],
    NULL
  );
  SELECT access_secret_id, refresh_secret_id
    INTO STRICT v_access_id, v_refresh_id
    FROM public.calendar_connections
   WHERE cabinet_id = 'cc100000-0000-4000-8000-000000000001';

  IF NOT public.revoke_calcom_connection(
    'cc100000-0000-4000-8000-000000000001'
  ) OR NOT public.revoke_calcom_connection(
    'cc100000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'oauth_revoke_not_idempotent';
  END IF;
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE id IN (v_access_id, v_refresh_id)) THEN
    RAISE EXCEPTION 'oauth_revoke_left_vault_secret';
  END IF;

  SELECT * INTO STRICT v_credentials
    FROM public.get_calcom_connection_credentials(
      'cc100000-0000-4000-8000-000000000001'
    );
  IF v_credentials.status <> 'revoked'
     OR v_credentials.access_token IS NOT NULL
     OR v_credentials.refresh_token IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_revoked_credentials_visible';
  END IF;
END;
$test$;

ROLLBACK;
