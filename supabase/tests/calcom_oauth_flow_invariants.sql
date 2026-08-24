\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
) VALUES
('cf010000-0000-4000-8000-000000000001','oauth-admin@example.invalid','',NOW(),NOW(),NOW(),'{}','{}',FALSE),
('cf010000-0000-4000-8000-000000000002','oauth-viewer@example.invalid','',NOW(),NOW(),NOW(),'{}','{}',FALSE);

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut, config_agent
) VALUES
('cf020000-0000-4000-8000-000000000001','Synthetic OAuth flow A','synthetic-oauth-flow-a','+41000000041','oauth-a@example.invalid','actif','{"demonstration_mode":false}'::JSONB),
('cf020000-0000-4000-8000-000000000002','Synthetic OAuth flow B','synthetic-oauth-flow-b','+41000000042','oauth-b@example.invalid','actif','{}'::JSONB);

INSERT INTO public.cabinet_memberships (id, cabinet_id, user_id, role, actif) VALUES
('cf030000-0000-4000-8000-000000000001','cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001','admin',TRUE),
('cf030000-0000-4000-8000-000000000002','cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000002','viewer',TRUE),
('cf030000-0000-4000-8000-000000000003','cf020000-0000-4000-8000-000000000002','cf010000-0000-4000-8000-000000000001','admin',TRUE);

CREATE TEMP TABLE oauth_test_state (
  label TEXT PRIMARY KEY,
  flow_id UUID,
  state TEXT,
  verifier_secret_id UUID,
  connection_id UUID,
  generation BIGINT
);

DO $test$
DECLARE
  v_proc REGPROCEDURE;
  v_path TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('calendar_connections','calendar_oauth_flows','calendar_connection_audit_events')
       AND column_name IN (
         'state','code','code_verifier','access_token','refresh_token','api_key',
         'email','phone','ip','user_agent','payload','raw_body'
       )
  ) THEN RAISE EXCEPTION 'oauth_security_table_contains_secret_or_pii_column'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname='public' AND tablename IN (
       'calendar_oauth_redirect_uris','calendar_oauth_flows','calendar_connection_audit_events'
     )
  ) THEN RAISE EXCEPTION 'oauth_security_table_has_policy'; END IF;

  IF pg_catalog.has_table_privilege('service_role','public.calendar_oauth_flows','SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('authenticated','public.calendar_oauth_flows','SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('anon','public.calendar_oauth_flows','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'oauth_flow_direct_access_present';
  END IF;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.begin_calcom_oauth_flow(uuid,uuid,text)'::REGPROCEDURE,
    'public.consume_calcom_oauth_flow(text)'::REGPROCEDURE,
    'public.complete_calcom_oauth_flow(uuid,text,text,timestamp with time zone,text[],text)'::REGPROCEDURE,
    'public.fail_calcom_oauth_flow(uuid,text)'::REGPROCEDURE,
    'public.get_calcom_connection_status(uuid)'::REGPROCEDURE,
    'public.get_calcom_connection_credentials(uuid)'::REGPROCEDURE,
    'public.set_calcom_event_type(uuid,uuid,text,text,integer)'::REGPROCEDURE,
    'public.claim_calcom_oauth_refresh(uuid,uuid,integer)'::REGPROCEDURE,
    'public.complete_calcom_oauth_refresh(uuid,uuid,bigint,text,text,timestamp with time zone,text[])'::REGPROCEDURE,
    'public.fail_calcom_oauth_refresh(uuid,uuid,bigint,text,boolean)'::REGPROCEDURE,
    'public.disconnect_calcom_oauth_connection(uuid,uuid,text)'::REGPROCEDURE,
    'public.purge_calcom_oauth_security_state(integer)'::REGPROCEDURE
  ] LOOP
    IF NOT pg_catalog.has_function_privilege('service_role',v_proc::OID,'EXECUTE')
       OR pg_catalog.has_function_privilege('anon',v_proc::OID,'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated',v_proc::OID,'EXECUTE') THEN
      RAISE EXCEPTION 'oauth_rpc_privilege_invalid proc=%',v_proc;
    END IF;
    SELECT COALESCE((SELECT x FROM pg_catalog.unnest(p.proconfig) x WHERE x LIKE 'search_path=%'),'')
      INTO v_path FROM pg_catalog.pg_proc p WHERE p.oid=v_proc::OID;
    IF v_path <> 'search_path=pg_catalog, pg_temp' THEN
      RAISE EXCEPTION 'oauth_rpc_search_path_invalid proc=% path=%',v_proc,v_path;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('service_role',
       'public.upsert_calcom_oauth_connection(uuid,text,text,timestamp with time zone,text[],text)'::REGPROCEDURE::OID,'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role',
       'public.set_calcom_connection_state(uuid,text,text)'::REGPROCEDURE::OID,'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role',
       'public.revoke_calcom_connection(uuid)'::REGPROCEDURE::OID,'EXECUTE') THEN
    RAISE EXCEPTION 'legacy_oauth_mutator_still_exposed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'calendar_connections'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%provider%event_type_id%'
  ) THEN
    RAISE EXCEPTION 'oauth_event_type_globally_unique';
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_credentials RECORD;
BEGIN
  SELECT * INTO STRICT v_credentials
    FROM public.get_calcom_connection_credentials('cf020000-0000-4000-8000-000000000002');
  IF v_credentials.demonstration_mode IS NULL OR v_credentials.demonstration_mode THEN
    RAISE EXCEPTION 'oauth_demonstration_mode_not_fail_closed';
  END IF;
END;
$test$;

DO $test$
BEGIN
  BEGIN
    PERFORM public.begin_calcom_oauth_flow(
      'cf020000-0000-4000-8000-000000000001',
      'cf010000-0000-4000-8000-000000000002',
      'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
    );
    RAISE EXCEPTION 'viewer_started_oauth';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'calcom_oauth_admin_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.begin_calcom_oauth_flow(
      'cf020000-0000-4000-8000-000000000001',
      'cf010000-0000-4000-8000-000000000001',
      'https://evil.example.invalid/callback'
    );
    RAISE EXCEPTION 'unlisted_redirect_started_oauth';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'calcom_oauth_redirect_not_allowed' THEN RAISE; END IF;
  END;
END;
$test$;

DO $test$
DECLARE
  v_first RECORD;
  v_second RECORD;
  v_first_secret UUID;
BEGIN
  SELECT * INTO STRICT v_first FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  SELECT verifier_secret_id INTO STRICT v_first_secret
    FROM public.calendar_oauth_flows WHERE id=v_first.flow_id;
  IF pg_catalog.char_length(v_first.state) <> 43
     OR pg_catalog.char_length(v_first.code_challenge) <> 43
     OR v_first.code_challenge_method <> 'S256'
     OR v_first.requested_scopes <> ARRAY['BOOKING_READ','BOOKING_WRITE','EVENT_TYPE_READ','PROFILE_READ']::TEXT[]
     OR NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id=v_first_secret) THEN
    RAISE EXCEPTION 'oauth_begin_contract_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM public.calendar_oauth_flows WHERE id=v_first.flow_id AND state_digest=convert_to(v_first.state,'UTF8')) THEN
    RAISE EXCEPTION 'oauth_raw_state_persisted';
  END IF;

  SELECT * INTO STRICT v_second FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE id=v_first_secret)
     OR NOT EXISTS (SELECT 1 FROM public.calendar_oauth_flows WHERE id=v_first.flow_id AND status='superseded') THEN
    RAISE EXCEPTION 'oauth_pending_flow_not_superseded';
  END IF;
  INSERT INTO oauth_test_state(label,flow_id,state,verifier_secret_id)
  SELECT 'connect',v_second.flow_id,v_second.state,verifier_secret_id
    FROM public.calendar_oauth_flows WHERE id=v_second.flow_id;
END;
$test$;

DO $test$
DECLARE
  v_state TEXT;
  v_flow UUID;
  v_secret UUID;
  v_result RECORD;
  v_replay RECORD;
BEGIN
  SELECT state,flow_id,verifier_secret_id INTO STRICT v_state,v_flow,v_secret
    FROM oauth_test_state WHERE label='connect';
  SELECT * INTO STRICT v_result FROM public.consume_calcom_oauth_flow(v_state);
  IF v_result.outcome <> 'consumed' OR v_result.flow_id <> v_flow
     OR v_result.actor_user_id <> 'cf010000-0000-4000-8000-000000000001'::UUID
     OR pg_catalog.char_length(v_result.code_verifier) <> 43
     OR EXISTS (SELECT 1 FROM vault.secrets WHERE id=v_secret) THEN
    RAISE EXCEPTION 'oauth_consume_contract_invalid result=%',v_result;
  END IF;
  SELECT * INTO STRICT v_replay FROM public.consume_calcom_oauth_flow(v_state);
  IF v_replay.outcome <> 'replayed' OR v_replay.code_verifier IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_replay_not_rejected result=%',v_replay;
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_flow UUID;
  v_bad RECORD;
  v_begin RECORD;
  v_consume RECORD;
  v_ok RECORD;
BEGIN
  SELECT flow_id INTO STRICT v_flow FROM oauth_test_state WHERE label='connect';
  SELECT * INTO STRICT v_bad FROM public.complete_calcom_oauth_flow(
    v_flow,'synthetic-access-bad','synthetic-refresh-bad',pg_catalog.now()+INTERVAL '30 minutes',
    ARRAY['EVENT_TYPE_READ'],NULL
  );
  IF v_bad.outcome <> 'scope_mismatch' THEN RAISE EXCEPTION 'oauth_scope_mismatch_accepted'; END IF;

  SELECT * INTO STRICT v_begin FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  SELECT * INTO STRICT v_consume FROM public.consume_calcom_oauth_flow(v_begin.state);
  SELECT * INTO STRICT v_ok FROM public.complete_calcom_oauth_flow(
    v_begin.flow_id,'synthetic-access-good','synthetic-refresh-good',pg_catalog.now()+INTERVAL '30 minutes',
    ARRAY['PROFILE_READ','EVENT_TYPE_READ','BOOKING_WRITE','BOOKING_READ'],'synthetic_account'
  );
  IF v_ok.outcome <> 'connected' THEN RAISE EXCEPTION 'oauth_complete_failed result=%',v_ok; END IF;
  INSERT INTO oauth_test_state(label,flow_id,connection_id)
  VALUES('connected',v_begin.flow_id,v_ok.connection_id);
END;
$test$;

DO $test$
DECLARE
  v_begin RECORD;
  v_consume RECORD;
BEGIN
  SELECT * INTO STRICT v_begin FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000002','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  SELECT * INTO STRICT v_consume FROM public.consume_calcom_oauth_flow(v_begin.state);
  IF v_consume.outcome <> 'consumed'
     OR NOT public.fail_calcom_oauth_flow(v_begin.flow_id,'access_denied')
     OR public.fail_calcom_oauth_flow(v_begin.flow_id,'access_denied') THEN
    RAISE EXCEPTION 'oauth_failure_not_idempotent';
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_status RECORD;
  v_credentials RECORD;
BEGIN
  SELECT * INTO STRICT v_status FROM public.get_calcom_connection_status('cf020000-0000-4000-8000-000000000001');
  IF v_status.runtime_ready OR v_status.event_type_id IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_runtime_ready_before_event_selection';
  END IF;
  SELECT * INTO STRICT v_credentials FROM public.get_calcom_connection_credentials('cf020000-0000-4000-8000-000000000001');
  IF v_credentials.access_token <> 'synthetic-access-good' OR v_credentials.refresh_token IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_access_token_unavailable_for_event_type_discovery';
  END IF;
  IF NOT public.set_calcom_event_type(
    'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001',
    '6723841','Consultation de démonstration',30
  ) THEN RAISE EXCEPTION 'oauth_event_selection_failed'; END IF;
  SELECT * INTO STRICT v_status FROM public.get_calcom_connection_status('cf020000-0000-4000-8000-000000000001');
  IF NOT v_status.runtime_ready OR v_status.event_type_id <> '6723841' THEN
    RAISE EXCEPTION 'oauth_runtime_not_ready_after_event_selection';
  END IF;
  SELECT * INTO STRICT v_credentials FROM public.get_calcom_connection_credentials('cf020000-0000-4000-8000-000000000001');
  IF v_credentials.access_token <> 'synthetic-access-good' OR v_credentials.refresh_token IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_runtime_credentials_invalid';
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_begin RECORD;
  v_consume RECORD;
  v_complete RECORD;
  v_status RECORD;
BEGIN
  SELECT * INTO STRICT v_begin FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000002','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  SELECT * INTO STRICT v_consume FROM public.consume_calcom_oauth_flow(v_begin.state);
  SELECT * INTO STRICT v_complete FROM public.complete_calcom_oauth_flow(
    v_begin.flow_id,'synthetic-access-first','synthetic-refresh-first',
    pg_catalog.now()+INTERVAL '30 minutes',
    ARRAY['BOOKING_READ','BOOKING_WRITE','EVENT_TYPE_READ','PROFILE_READ'],'synthetic_account_first'
  );
  IF v_complete.outcome <> 'connected' OR NOT public.set_calcom_event_type(
    'cf020000-0000-4000-8000-000000000002','cf010000-0000-4000-8000-000000000001',
    '6723841','Consultation de démonstration',30
  ) THEN RAISE EXCEPTION 'oauth_reconnect_fixture_failed'; END IF;

  SELECT * INTO STRICT v_begin FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000002','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  SELECT * INTO STRICT v_consume FROM public.consume_calcom_oauth_flow(v_begin.state);
  SELECT * INTO STRICT v_complete FROM public.complete_calcom_oauth_flow(
    v_begin.flow_id,'synthetic-access-second','synthetic-refresh-second',
    pg_catalog.now()+INTERVAL '30 minutes',
    ARRAY['BOOKING_READ','BOOKING_WRITE','EVENT_TYPE_READ','PROFILE_READ'],'synthetic_account_second'
  );
  SELECT * INTO STRICT v_status FROM public.get_calcom_connection_status(
    'cf020000-0000-4000-8000-000000000002'
  );
  IF v_complete.outcome <> 'connected' OR v_status.runtime_ready
     OR v_status.event_type_id IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_reconnect_preserved_unverified_event_type';
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_connection UUID;
  v_claim RECORD;
  v_busy RECORD;
  v_generation BIGINT;
BEGIN
  SELECT connection_id INTO STRICT v_connection FROM oauth_test_state WHERE label='connected';
  PERFORM public.set_calcom_connection_state('cf020000-0000-4000-8000-000000000001','expired',NULL);
  SELECT * INTO STRICT v_claim FROM public.claim_calcom_oauth_refresh(
    'cf020000-0000-4000-8000-000000000001','cf040000-0000-4000-8000-000000000001',120
  );
  SELECT * INTO STRICT v_busy FROM public.claim_calcom_oauth_refresh(
    'cf020000-0000-4000-8000-000000000001','cf040000-0000-4000-8000-000000000002',120
  );
  IF v_claim.outcome <> 'claimed' OR v_claim.refresh_token <> 'synthetic-refresh-good'
     OR v_busy.outcome <> 'busy' OR v_busy.refresh_token IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_refresh_claim_not_exclusive';
  END IF;
  IF public.complete_calcom_oauth_refresh(
    v_connection,'cf040000-0000-4000-8000-000000000002',v_claim.token_generation,
    'synthetic-access-wrong','synthetic-refresh-wrong',pg_catalog.now()+INTERVAL '30 minutes',v_claim.configured_scopes
  ) THEN RAISE EXCEPTION 'oauth_refresh_wrong_owner_accepted'; END IF;
  IF NOT public.complete_calcom_oauth_refresh(
    v_connection,'cf040000-0000-4000-8000-000000000001',v_claim.token_generation,
    'synthetic-access-rotated','synthetic-refresh-rotated',pg_catalog.now()+INTERVAL '30 minutes',v_claim.configured_scopes
  ) THEN RAISE EXCEPTION 'oauth_refresh_complete_failed'; END IF;
  SELECT token_generation INTO STRICT v_generation FROM public.calendar_connections WHERE id=v_connection;
  IF v_generation <> v_claim.token_generation+1 THEN RAISE EXCEPTION 'oauth_refresh_generation_not_incremented'; END IF;
END;
$test$;

DO $test$
DECLARE
  v_connection UUID;
  v_claim RECORD;
  v_status TEXT;
  v_error TEXT;
BEGIN
  SELECT connection_id INTO STRICT v_connection FROM oauth_test_state WHERE label='connected';
  PERFORM public.set_calcom_connection_state('cf020000-0000-4000-8000-000000000001','expired',NULL);
  SELECT * INTO STRICT v_claim FROM public.claim_calcom_oauth_refresh(
    'cf020000-0000-4000-8000-000000000001','cf040000-0000-4000-8000-000000000003',120
  );
  IF v_claim.outcome <> 'claimed'
     OR NOT public.fail_calcom_oauth_refresh(
       v_connection,'cf040000-0000-4000-8000-000000000003',v_claim.token_generation,
       'refresh_transient',FALSE
     )
     OR public.fail_calcom_oauth_refresh(
       v_connection,'cf040000-0000-4000-8000-000000000003',v_claim.token_generation,
       'refresh_transient',FALSE
     ) THEN
    RAISE EXCEPTION 'oauth_refresh_transient_failure_invalid';
  END IF;
  SELECT status,error_code INTO STRICT v_status,v_error
    FROM public.calendar_connections WHERE id=v_connection;
  IF v_status <> 'expired' OR v_error IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_refresh_transient_not_retryable';
  END IF;

  SELECT * INTO STRICT v_claim FROM public.claim_calcom_oauth_refresh(
    'cf020000-0000-4000-8000-000000000001','cf040000-0000-4000-8000-000000000004',120
  );
  IF v_claim.outcome <> 'claimed'
     OR NOT public.fail_calcom_oauth_refresh(
       v_connection,'cf040000-0000-4000-8000-000000000004',v_claim.token_generation,
       'refresh_invalid_grant',TRUE
     ) THEN
    RAISE EXCEPTION 'oauth_refresh_terminal_failure_invalid';
  END IF;
  SELECT status,error_code INTO STRICT v_status,v_error
    FROM public.calendar_connections WHERE id=v_connection;
  IF v_status <> 'error' OR v_error <> 'refresh_invalid_grant' THEN
    RAISE EXCEPTION 'oauth_refresh_terminal_not_fail_closed';
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_connection UUID;
  v_access UUID;
  v_refresh UUID;
  v_revoked_audit_count INTEGER;
BEGIN
  SELECT id,access_secret_id,refresh_secret_id INTO STRICT v_connection,v_access,v_refresh
    FROM public.calendar_connections WHERE cabinet_id='cf020000-0000-4000-8000-000000000001';
  IF NOT public.disconnect_calcom_oauth_connection(
    'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001','user_requested'
  ) THEN RAISE EXCEPTION 'oauth_disconnect_failed'; END IF;
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE id IN(v_access,v_refresh))
     OR NOT EXISTS (SELECT 1 FROM public.calendar_connections WHERE id=v_connection AND status='revoked' AND event_type_id IS NULL) THEN
    RAISE EXCEPTION 'oauth_disconnect_not_fail_closed';
  END IF;
  SELECT pg_catalog.count(*) INTO v_revoked_audit_count
    FROM public.calendar_connection_audit_events
   WHERE connection_id=v_connection AND action='revoked';
  IF NOT public.disconnect_calcom_oauth_connection(
    'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001','user_requested'
  ) OR (SELECT pg_catalog.count(*) FROM public.calendar_connection_audit_events
         WHERE connection_id=v_connection AND action='revoked') <> v_revoked_audit_count THEN
    RAISE EXCEPTION 'oauth_disconnect_not_idempotent';
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_begin RECORD;
  v_consume RECORD;
  v_complete RECORD;
BEGIN
  SELECT * INTO STRICT v_begin FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  SELECT * INTO STRICT v_consume FROM public.consume_calcom_oauth_flow(v_begin.state);
  IF v_consume.outcome <> 'consumed'
     OR NOT public.disconnect_calcom_oauth_connection(
       'cf020000-0000-4000-8000-000000000001','cf010000-0000-4000-8000-000000000001','user_requested'
     ) THEN
    RAISE EXCEPTION 'oauth_disconnect_during_exchange_failed';
  END IF;
  SELECT * INTO STRICT v_complete FROM public.complete_calcom_oauth_flow(
    v_begin.flow_id,'synthetic-access-late','synthetic-refresh-late',
    pg_catalog.now()+INTERVAL '30 minutes',
    ARRAY['BOOKING_READ','BOOKING_WRITE','EVENT_TYPE_READ','PROFILE_READ'],NULL
  );
  IF v_complete.outcome <> 'replayed'
     OR NOT EXISTS (
       SELECT 1 FROM public.calendar_connections
        WHERE cabinet_id='cf020000-0000-4000-8000-000000000001' AND status='revoked'
     ) THEN
    RAISE EXCEPTION 'oauth_late_callback_reconnected_after_disconnect';
  END IF;
END;
$test$;

DO $test$
DECLARE
  v_begin RECORD;
  v_secret UUID;
  v_purge RECORD;
BEGIN
  SELECT * INTO STRICT v_begin FROM public.begin_calcom_oauth_flow(
    'cf020000-0000-4000-8000-000000000002','cf010000-0000-4000-8000-000000000001',
    'https://corya-api-trial.jcloud-ver-jpc.ik-server.com/oauth/calcom/callback'
  );
  SELECT verifier_secret_id INTO STRICT v_secret FROM public.calendar_oauth_flows WHERE id=v_begin.flow_id;
  UPDATE public.calendar_oauth_flows
     SET created_at=pg_catalog.now()-INTERVAL '2 hours',
         expires_at=pg_catalog.now()-INTERVAL '1 hour 51 minutes'
   WHERE id=v_begin.flow_id;
  SELECT * INTO STRICT v_purge FROM public.purge_calcom_oauth_security_state(10);
  IF v_purge.flows_expired <> 1 OR EXISTS(SELECT 1 FROM vault.secrets WHERE id=v_secret) THEN
    RAISE EXCEPTION 'oauth_bounded_purge_failed result=%',v_purge;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname='purge-expired-audio' AND active
      AND command LIKE '%purge_calcom_oauth_security_state%'
  ) THEN RAISE EXCEPTION 'oauth_cleanup_not_attached_to_monitored_cron'; END IF;
END;
$test$;

DO $test$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.calendar_connection_audit_events
     WHERE action NOT IN (
       'oauth_started','oauth_connected','oauth_denied','oauth_failed',
       'oauth_replay_rejected','refresh_failed','revoked'
     )
  ) THEN RAISE EXCEPTION 'oauth_audit_action_not_allowlisted'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='calendar_connection_audit_events'
       AND column_name IN ('email','name','phone','ip','user_agent','payload','error_message','token','state')
  ) THEN RAISE EXCEPTION 'oauth_audit_contains_pii_column'; END IF;
END;
$test$;

ROLLBACK;
