\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  is_super_admin
) VALUES (
  'a1000000-0000-4000-8000-000000000001',
  'portal-audit@example.invalid', '', NOW(), NOW(), NOW(), '{}', '{}', FALSE
);

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut, config_agent
) VALUES (
  'a2000000-0000-4000-8000-000000000001',
  'Synthetic portal audit', 'synthetic-portal-audit', '+41000000201',
  'portal-audit-cabinet@example.invalid', 'actif',
  '{"legacy":{"keep":true},"portal":{"settings":{"notifyOnFailure":true,"weeklyDigest":false},"assistant":{"language":"fr-CH"}}}'::JSONB
);

INSERT INTO public.cabinet_memberships (
  id, cabinet_id, user_id, role, actif
) VALUES (
  'a2500000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'admin', TRUE
);

INSERT INTO public.portal_audit_events (
  id, cabinet_id, actor_user_id, action, changed_fields, created_at
) VALUES
  (
    'a3000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'settings_updated', ARRAY['city'], NOW() - INTERVAL '25 months'
  ),
  (
    'a3000000-0000-4000-8000-000000000002',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'assistant_updated', ARRAY['language'], NOW()
  );

-- Exact minimal schema, constraints, indexes, RLS and policy inventory.
DO $test$
DECLARE
  v_difference_count INTEGER;
  v_constraint_definition TEXT;
BEGIN
  WITH expected(column_name, data_type, is_nullable) AS (
    VALUES
      ('id'::NAME, 'uuid'::TEXT, 'NO'::TEXT),
      ('cabinet_id'::NAME, 'uuid'::TEXT, 'NO'::TEXT),
      ('actor_user_id'::NAME, 'uuid'::TEXT, 'NO'::TEXT),
      ('action'::NAME, 'text'::TEXT, 'NO'::TEXT),
      ('changed_fields'::NAME, 'ARRAY'::TEXT, 'NO'::TEXT),
      ('created_at'::NAME, 'timestamp with time zone'::TEXT, 'NO'::TEXT)
  ), actual AS (
    SELECT c.column_name::NAME, c.data_type::TEXT, c.is_nullable::TEXT
      FROM information_schema.columns AS c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'portal_audit_events'
  )
  SELECT COUNT(*) INTO v_difference_count
    FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) AS differences;
  IF v_difference_count <> 0 THEN
    RAISE EXCEPTION 'portal_audit_schema_mismatch';
  END IF;

  IF NOT COALESCE((
    SELECT c.relrowsecurity
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'portal_audit_events'
  ), FALSE) THEN
    RAISE EXCEPTION 'portal_audit_rls_disabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'portal_audit_events'
  ) THEN
    RAISE EXCEPTION 'portal_audit_policy_exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_class AS t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_class AS rt ON rt.oid = c.confrelid
      JOIN pg_catalog.pg_namespace AS rn ON rn.oid = rt.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'portal_audit_events'
       AND c.contype = 'f'
       AND c.confdeltype = 'c'
       AND rn.nspname = 'public'
       AND rt.relname = 'cabinets'
  ) THEN
    RAISE EXCEPTION 'portal_audit_cabinet_fk_missing';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid)
    INTO STRICT v_constraint_definition
    FROM pg_catalog.pg_constraint AS c
    JOIN pg_catalog.pg_class AS t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'portal_audit_events'
     AND c.conname = 'portal_audit_events_changed_fields_allowlist_check';

  IF pg_catalog.strpos(v_constraint_definition, 'settings_updated') = 0
     OR pg_catalog.strpos(v_constraint_definition, 'assistant_updated') = 0
     OR pg_catalog.strpos(v_constraint_definition, 'notificationEmail') = 0
     OR pg_catalog.strpos(v_constraint_definition, 'emergencyProtocol') = 0 THEN
    RAISE EXCEPTION 'portal_audit_allowlist_constraint_incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'portal_audit_events'
       AND indexname = 'idx_portal_audit_events_cabinet_created'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'portal_audit_events'
       AND indexname = 'idx_portal_audit_events_created_at'
  ) THEN
    RAISE EXCEPTION 'portal_audit_index_missing';
  END IF;
END;
$test$;

-- ACLs are checked through catalogues and actual role execution.
DO $test$
DECLARE
  v_proc REGPROCEDURE;
  v_config TEXT[];
  v_security_definer BOOLEAN;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name = 'portal_audit_events'
       AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema = 'public'
       AND table_name = 'portal_audit_events'
       AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'portal_audit_client_acl_exists';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'service_role', 'public.portal_audit_events', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.portal_audit_events', 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.portal_audit_events', 'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.portal_audit_events', 'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.portal_audit_events', 'TRUNCATE'
  ) THEN
    RAISE EXCEPTION 'portal_audit_service_table_acl_wrong';
  END IF;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.record_portal_audit_event(uuid,uuid,text,text[])'::REGPROCEDURE,
    'public.apply_portal_cabinet_patch_with_audit(uuid,uuid,text,timestamp with time zone,jsonb,text[])'::REGPROCEDURE,
    'public.purge_ancient_portal_audit_events()'::REGPROCEDURE
  ] LOOP
    IF EXISTS (
         SELECT 1
           FROM pg_catalog.pg_proc AS p
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
           ) AS acl
          WHERE p.oid = v_proc::OID
            AND acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE') THEN
      RAISE EXCEPTION 'portal_audit_function_acl_wrong function=%', v_proc::TEXT;
    END IF;

    SELECT p.proconfig, p.prosecdef INTO v_config, v_security_definer
      FROM pg_catalog.pg_proc AS p WHERE p.oid = v_proc::OID;
    IF NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
      RAISE EXCEPTION 'portal_audit_function_search_path_wrong function=%', v_proc::TEXT;
    END IF;

    IF v_proc = 'public.purge_ancient_portal_audit_events()'::REGPROCEDURE
       AND NOT v_security_definer THEN
      RAISE EXCEPTION 'portal_audit_purge_not_security_definer';
    END IF;
    IF v_proc = 'public.record_portal_audit_event(uuid,uuid,text,text[])'::REGPROCEDURE
       AND v_security_definer THEN
      RAISE EXCEPTION 'portal_audit_insert_unnecessarily_security_definer';
    END IF;
  END LOOP;
END;
$test$;

SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  BEGIN
    PERFORM 1 FROM public.portal_audit_events LIMIT 1;
    RAISE EXCEPTION 'authenticated_portal_audit_read_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.record_portal_audit_event(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated',
      ARRAY['city']
    );
    RAISE EXCEPTION 'authenticated_portal_audit_rpc_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_portal_cabinet_patch_with_audit(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated',
      NOW(),
      '{"nom":"Denied"}'::JSONB,
      ARRAY['practiceName']
    );
    RAISE EXCEPTION 'authenticated_atomic_portal_patch_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $test$
BEGIN
  BEGIN
    INSERT INTO public.portal_audit_events (
      cabinet_id, actor_user_id, action, changed_fields
    ) VALUES (
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated', ARRAY['city']
    );
    RAISE EXCEPTION 'anon_portal_audit_insert_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SET LOCAL ROLE service_role;

-- Atomic patch: merge deltas on the locked fresh config, return exactly the
-- PortalCabinetRow projection and append the matching audit before commit.
DO $test$
DECLARE
  v_expected_updated_at TIMESTAMPTZ;
  v_result RECORD;
  v_audit_count INTEGER;
  v_assistant_audit_count_before INTEGER;
BEGIN
  SELECT updated_at INTO STRICT v_expected_updated_at
    FROM public.cabinets
   WHERE id = 'a2000000-0000-4000-8000-000000000001';

  SELECT * INTO STRICT v_result
    FROM public.apply_portal_cabinet_patch_with_audit(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated',
      v_expected_updated_at,
      '{"nom":"Synthetic portal renamed","portalSettings":{"weeklyDigest":true}}'::JSONB,
      ARRAY['weeklyDigest', 'practiceName']
    );

  IF v_result.nom <> 'Synthetic portal renamed'
     OR v_result.id <> 'a2000000-0000-4000-8000-000000000001'
     OR v_result.updated_at IS NULL
     OR v_result.updated_at <= v_expected_updated_at
     OR v_result.config_agent #>> '{legacy,keep}' <> 'true'
     OR v_result.config_agent #>> '{portal,settings,notifyOnFailure}' <> 'true'
     OR v_result.config_agent #>> '{portal,settings,weeklyDigest}' <> 'true'
     OR v_result.config_agent #>> '{portal,assistant,language}' <> 'fr-CH' THEN
    RAISE EXCEPTION 'atomic_portal_patch_merge_or_return_contract_wrong';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_audit_count
    FROM public.portal_audit_events
   WHERE cabinet_id = 'a2000000-0000-4000-8000-000000000001'
     AND actor_user_id = 'a1000000-0000-4000-8000-000000000001'
     AND action = 'settings_updated'
     AND changed_fields = ARRAY['practiceName', 'weeklyDigest'];
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'atomic_portal_patch_audit_missing_or_duplicated count=%', v_audit_count;
  END IF;

  -- A stale writer must neither mutate the cabinet nor append an audit row.
  SELECT COUNT(*)::INTEGER INTO v_assistant_audit_count_before
    FROM public.portal_audit_events
   WHERE cabinet_id = 'a2000000-0000-4000-8000-000000000001'
     AND action = 'assistant_updated';

  BEGIN
    PERFORM public.apply_portal_cabinet_patch_with_audit(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'assistant_updated',
      v_expected_updated_at,
      '{"portalAssistant":{"language":"de-CH"}}'::JSONB,
      ARRAY['language']
    );
    RAISE EXCEPTION 'atomic_portal_stale_patch_succeeded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  IF (SELECT config_agent #>> '{portal,assistant,language}' FROM public.cabinets
       WHERE id = 'a2000000-0000-4000-8000-000000000001') <> 'fr-CH'
     OR (SELECT COUNT(*) FROM public.portal_audit_events
          WHERE cabinet_id = 'a2000000-0000-4000-8000-000000000001'
            AND action = 'assistant_updated') <> v_assistant_audit_count_before THEN
    RAISE EXCEPTION 'atomic_portal_stale_patch_left_side_effect';
  END IF;

  BEGIN
    PERFORM public.apply_portal_cabinet_patch_with_audit(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated',
      v_result.updated_at,
      '{}'::JSONB,
      ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'atomic_portal_empty_patch_succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_portal_cabinet_patch_with_audit(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated',
      v_result.updated_at,
      '{"nom":"Mismatch"}'::JSONB,
      ARRAY['city']
    );
    RAISE EXCEPTION 'atomic_portal_audit_mismatch_succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$test$;

DO $test$
DECLARE
  v_event_id UUID;
BEGIN
  v_event_id := public.record_portal_audit_event(
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'settings_updated',
    ARRAY['practiceName', 'city', 'practiceName']
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.portal_audit_events
     WHERE id = v_event_id
       AND cabinet_id = 'a2000000-0000-4000-8000-000000000001'
       AND actor_user_id = 'a1000000-0000-4000-8000-000000000001'
       AND action = 'settings_updated'
       AND changed_fields = ARRAY['city', 'practiceName']
  ) THEN
    RAISE EXCEPTION 'portal_audit_rpc_contract_mismatch';
  END IF;

  BEGIN
    PERFORM public.record_portal_audit_event(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated', ARRAY['patientName']
    );
    RAISE EXCEPTION 'portal_audit_unknown_field_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.record_portal_audit_event(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'assistant_updated', ARRAY['notificationEmail']
    );
    RAISE EXCEPTION 'portal_audit_cross_action_field_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.record_portal_audit_event(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_deleted', ARRAY['city']
    );
    RAISE EXCEPTION 'portal_audit_unknown_action_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.record_portal_audit_event(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'settings_updated', ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'portal_audit_empty_fields_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$test$;

RESET ROLE;

-- Force the audit INSERT to fail after the cabinet UPDATE inside the RPC. The
-- whole statement must roll back, proving there is no durable mutation + 503
-- split-brain state.
ALTER TABLE public.portal_audit_events
  ADD CONSTRAINT portal_audit_test_force_assistant_failure
  CHECK (action <> 'assistant_updated') NOT VALID;

SET LOCAL ROLE service_role;
DO $test$
DECLARE
  v_expected_updated_at TIMESTAMPTZ;
  v_config_before JSONB;
  v_audit_count_before INTEGER;
BEGIN
  SELECT updated_at, config_agent
    INTO STRICT v_expected_updated_at, v_config_before
    FROM public.cabinets
   WHERE id = 'a2000000-0000-4000-8000-000000000001';
  SELECT COUNT(*)::INTEGER INTO v_audit_count_before
    FROM public.portal_audit_events;

  BEGIN
    PERFORM public.apply_portal_cabinet_patch_with_audit(
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'assistant_updated',
      v_expected_updated_at,
      '{"portalAssistant":{"language":"de-CH"}}'::JSONB,
      ARRAY['language']
    );
    RAISE EXCEPTION 'atomic_portal_forced_audit_failure_did_not_fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF (SELECT updated_at FROM public.cabinets
       WHERE id = 'a2000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM v_expected_updated_at
     OR (SELECT config_agent FROM public.cabinets
          WHERE id = 'a2000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM v_config_before
     OR (SELECT COUNT(*) FROM public.portal_audit_events) <> v_audit_count_before THEN
    RAISE EXCEPTION 'atomic_portal_audit_failure_did_not_rollback_update';
  END IF;
END;
$test$;

RESET ROLE;
ALTER TABLE public.portal_audit_events
  DROP CONSTRAINT portal_audit_test_force_assistant_failure;

DO $test$
DECLARE
  v_purged INTEGER;
BEGIN
  v_purged := public.purge_ancient_portal_audit_events();
  IF v_purged <> 1 THEN
    RAISE EXCEPTION 'portal_audit_purge_wrong_count got=%', v_purged;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.portal_audit_events
     WHERE id = 'a3000000-0000-4000-8000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.portal_audit_events
     WHERE id = 'a3000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'portal_audit_purge_wrong_rows';
  END IF;

  v_purged := public.purge_ancient_portal_audit_events();
  IF v_purged <> 0 THEN
    RAISE EXCEPTION 'portal_audit_purge_not_idempotent got=%', v_purged;
  END IF;
END;
$test$;

SET LOCAL ROLE service_role;
DO $test$
BEGIN
  BEGIN
    UPDATE public.portal_audit_events
       SET action = 'assistant_updated'
     WHERE id = 'a3000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'service_role_portal_audit_update_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;

DO $test$
DECLARE
  v_count INTEGER;
  v_schedule TEXT;
  v_command TEXT;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_count
    FROM cron.job WHERE active;
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'portal_audit_changed_active_cron_count got=%', v_count;
  END IF;

  SELECT schedule, command INTO STRICT v_schedule, v_command
    FROM cron.job
   WHERE jobname = 'purge-ancient-logs-actions'
     AND active;
  IF v_schedule <> '17 4 15 * *'
     OR pg_catalog.strpos(v_command, 'purge_ancient_logs_actions') = 0
     OR pg_catalog.strpos(v_command, 'purge_ancient_portal_audit_events') = 0 THEN
    RAISE EXCEPTION 'portal_audit_retention_cron_contract_wrong';
  END IF;
END;
$test$;

ROLLBACK;

SELECT 'PORTAL_AUDIT_EVENTS_INVARIANTS_PASS' AS result;
