\set ON_ERROR_STOP on

BEGIN;

-- Synthetic, minimized fixtures. No patient field, transcript, audio URL or
-- PDF path from a real person is used by this test.
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  is_super_admin
) VALUES
  (
    '91000000-0000-4000-8000-000000000001',
    'portal-a@example.invalid', '', NOW(), NOW(), NOW(), '{}', '{}', FALSE
  ),
  (
    '91000000-0000-4000-8000-000000000002',
    'portal-b@example.invalid', '', NOW(), NOW(), NOW(), '{}', '{}', FALSE
  ),
  (
    '91000000-0000-4000-8000-000000000003',
    'portal-none@example.invalid', '', NOW(), NOW(), NOW(), '{}', '{}', FALSE
  );

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut
) VALUES
  (
    '92000000-0000-4000-8000-000000000001',
    'Synthetic portal A', 'synthetic-portal-a', '+41000000101',
    'cabinet-a@example.invalid', 'actif'
  ),
  (
    '92000000-0000-4000-8000-000000000002',
    'Synthetic portal B', 'synthetic-portal-b', '+41000000102',
    'cabinet-b@example.invalid', 'actif'
  ),
  (
    '92000000-0000-4000-8000-000000000003',
    'Synthetic portal cascade', 'synthetic-portal-cascade', '+41000000103',
    'cabinet-c@example.invalid', 'actif'
  );

INSERT INTO public.cabinet_memberships (
  id, cabinet_id, user_id, role, actif
) VALUES
  (
    '93000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'admin', TRUE
  ),
  (
    '93000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000002',
    'viewer', TRUE
  ),
  (
    '93000000-0000-4000-8000-000000000003',
    '92000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    'admin', FALSE
  ),
  (
    '93000000-0000-4000-8000-000000000004',
    '92000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    'admin', TRUE
  ),
  (
    '93000000-0000-4000-8000-000000000005',
    '92000000-0000-4000-8000-000000000003',
    '91000000-0000-4000-8000-000000000003',
    'admin', TRUE
  );

INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, resultat
) VALUES
  (
    '94000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    'synthetic-portal-call-a', NOW(), 'message'
  ),
  (
    '94000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000002',
    'synthetic-portal-call-b', NOW(), 'message'
  );

INSERT INTO storage.objects (id, bucket_id, name)
VALUES (
  '95000000-0000-4000-8000-000000000001',
  'pdf-recaps',
  'synthetic-only/portal-invariant.pdf'
);

-- Schema, constraints, indexes, RLS and policy inventory are checked with
-- schema-aware catalogue joins.
DO $test$
DECLARE
  v_table_name TEXT;
  v_count INTEGER;
  v_proc REGPROCEDURE :=
    'public.protect_last_active_cabinet_admin()'::REGPROCEDURE;
  v_config TEXT[];
  v_source TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_class AS t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'cabinet_memberships'
       AND c.conname = 'cabinet_memberships_cabinet_user_key'
       AND c.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'membership_unique_constraint_missing';
  END IF;

  IF (
    SELECT COUNT(*)
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_class AS t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_class AS rt ON rt.oid = c.confrelid
      JOIN pg_catalog.pg_namespace AS rn ON rn.oid = rt.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'cabinet_memberships'
       AND c.contype = 'f'
       AND c.confdeltype = 'c'
       AND (
         (rn.nspname = 'public' AND rt.relname = 'cabinets')
         OR (rn.nspname = 'auth' AND rt.relname = 'users')
       )
  ) <> 2 THEN
    RAISE EXCEPTION 'membership_cascade_foreign_keys_incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'cabinet_memberships'
       AND indexname = 'idx_cabinet_memberships_user_id'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'cabinet_memberships'
       AND indexname = 'idx_cabinet_memberships_active_cabinet_role'
  ) THEN
    RAISE EXCEPTION 'membership_index_missing';
  END IF;

  FOREACH v_table_name IN ARRAY ARRAY[
    'cabinets', 'appels', 'cabinet_memberships', 'admin_users',
    'logs_actions', 'jobs', 'file_deletions_outbox',
    'worker_heartbeats', 'cron_first_seen'
  ] LOOP
    IF NOT COALESCE((
      SELECT t.relrowsecurity
        FROM pg_catalog.pg_class AS t
        JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname = v_table_name
    ), FALSE) THEN
      RAISE EXCEPTION 'rls_disabled_on_%', v_table_name;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'public' AND tablename = v_table_name
    ) THEN
      RAISE EXCEPTION 'unexpected_client_policy_on_%', v_table_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies
     WHERE (schemaname, tablename, policyname) IN (
       ('public', 'cabinets', 'Admins can read cabinets'),
       ('public', 'cabinets', 'Admins can insert cabinets'),
       ('public', 'cabinets', 'Admins can update cabinets'),
       ('public', 'appels', 'Admins can read appels'),
       ('public', 'admin_users', 'Admins can view admin list'),
       ('public', 'logs_actions', 'Admins can read logs'),
       ('storage', 'objects', 'pdf_recaps_admin_read')
     )
  ) THEN
    RAISE EXCEPTION 'historical_global_policy_survived';
  END IF;

  WITH expected(policyname, command_name) AS (
    VALUES
      ('pdf_recaps_service_write_only'::NAME, 'INSERT'::TEXT),
      ('pdf_recaps_service_update'::NAME, 'UPDATE'::TEXT),
      ('pdf_recaps_service_delete'::NAME, 'DELETE'::TEXT)
  ), actual AS (
    SELECT p.policyname, p.cmd AS command_name
      FROM pg_catalog.pg_policies AS p
     WHERE p.schemaname = 'storage'
       AND p.tablename = 'objects'
       AND p.policyname LIKE 'pdf_recaps_service_%'
       AND p.roles = ARRAY['service_role']::NAME[]
  )
  SELECT COUNT(*) INTO v_count
    FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) AS differences;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'service_role_storage_policy_set_changed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies AS p
     WHERE p.schemaname = 'storage'
       AND p.tablename = 'objects'
       AND p.roles && ARRAY['public', 'anon', 'authenticated']::NAME[]
  ) THEN
    RAISE EXCEPTION 'client_storage_policy_exists';
  END IF;

  SELECT p.proconfig, pg_catalog.pg_get_functiondef(p.oid)
    INTO v_config, v_source
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_proc::OID;

  IF NOT COALESCE((
    SELECT p.prosecdef FROM pg_catalog.pg_proc AS p WHERE p.oid = v_proc::OID
  ), FALSE) THEN
    RAISE EXCEPTION 'last_admin_guard_not_security_definer';
  END IF;
  IF NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
    RAISE EXCEPTION 'last_admin_guard_search_path_not_fixed config=%', v_config;
  END IF;
  IF pg_catalog.strpos(v_source, 'pg_advisory_xact_lock') = 0 THEN
    RAISE EXCEPTION 'last_admin_guard_missing_transaction_lock';
  END IF;

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
     OR pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE') THEN
    RAISE EXCEPTION 'last_admin_guard_acl_not_minimal';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
         ) AS acl
        WHERE p.oid = 'public.is_admin_user()'::REGPROCEDURE::OID
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', 'public.is_admin_user()'::REGPROCEDURE::OID, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', 'public.is_admin_user()'::REGPROCEDURE::OID, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'is_admin_user_client_execute_survived';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
    'service_role', 'public.is_admin_user()'::REGPROCEDURE::OID, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'is_admin_user_service_execute_missing';
  END IF;
END;
$test$;

-- No table or column privilege remains for browser-facing roles. service_role
-- keeps the complete server-side contract used after explicit authorization.
DO $test$
DECLARE
  v_table_name TEXT;
  v_role_name TEXT;
  v_privilege TEXT;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name IN (
         'cabinets', 'appels', 'cabinet_memberships', 'admin_users',
         'logs_actions', 'jobs', 'file_deletions_outbox',
         'worker_heartbeats', 'cron_first_seen'
       )
       AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'client_table_acl_survived';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.column_privileges
     WHERE table_schema = 'public'
       AND table_name IN (
         'cabinets', 'appels', 'cabinet_memberships', 'admin_users',
         'logs_actions', 'jobs', 'file_deletions_outbox',
         'worker_heartbeats', 'cron_first_seen'
       )
       AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'client_column_acl_survived';
  END IF;

  FOREACH v_table_name IN ARRAY ARRAY[
    'cabinets', 'appels', 'cabinet_memberships', 'admin_users',
    'logs_actions', 'jobs', 'file_deletions_outbox',
    'worker_heartbeats', 'cron_first_seen'
  ] LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role', 'public.' || v_table_name, v_privilege
      ) THEN
        RAISE EXCEPTION 'service_role_missing_%_on_%', v_privilege, v_table_name;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT pg_catalog.has_table_privilege(
      'service_role', 'storage.objects', v_privilege
    ) THEN
      RAISE EXCEPTION 'service_role_missing_%_on_storage_objects', v_privilege;
    END IF;
  END LOOP;

  FOREACH v_role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF pg_catalog.has_column_privilege(
        v_role_name, 'public.appels', 'patient_nom', v_privilege
      ) OR pg_catalog.has_column_privilege(
        v_role_name, 'public.appels', 'transcript', v_privilege
      ) OR pg_catalog.has_column_privilege(
        v_role_name, 'public.appels', 'audio_url', v_privilege
      ) OR pg_catalog.has_column_privilege(
        v_role_name, 'public.appels', 'pdf_url', v_privilege
      ) THEN
        RAISE EXCEPTION 'sensitive_appel_column_exposed_to_%', v_role_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$test$;

-- Runtime checks use the real Supabase roles. Expected errors are caught only
-- by their SQLSTATE; an unexpectedly successful operation raises and fails the
-- script under ON_ERROR_STOP.
SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', TRUE
);

DO $test$
DECLARE
  v_count INTEGER;
  v_table_name TEXT;
BEGIN
  BEGIN
    PERFORM 1 FROM public.cabinets LIMIT 1;
    RAISE EXCEPTION 'authenticated_raw_cabinet_read_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  FOREACH v_table_name IN ARRAY ARRAY[
    'cabinet_memberships', 'logs_actions', 'jobs', 'file_deletions_outbox'
  ] LOOP
    BEGIN
      EXECUTE pg_catalog.format(
        'SELECT 1 FROM public.%I LIMIT 1', v_table_name
      );
      RAISE EXCEPTION 'authenticated_raw_%_read_succeeded', v_table_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  BEGIN
    PERFORM 1 FROM public.appels LIMIT 1;
    RAISE EXCEPTION 'authenticated_raw_appel_read_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.cabinet_memberships (cabinet_id, user_id, role)
    VALUES (
      '92000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000003',
      'viewer'
    );
    RAISE EXCEPTION 'authenticated_membership_insert_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.is_admin_user();
    RAISE EXCEPTION 'authenticated_is_admin_user_execute_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_count
      FROM storage.objects
     WHERE id = '95000000-0000-4000-8000-000000000001';
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'authenticated_storage_read_succeeded';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO storage.objects (id, bucket_id, name)
    VALUES (
      '95100000-0000-4000-8000-000000000001',
      'pdf-recaps', 'synthetic-only/authenticated-insert-denied.pdf'
    );
    RAISE EXCEPTION 'authenticated_storage_insert_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE storage.objects
       SET metadata = storage.objects.metadata
     WHERE id = '95000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'authenticated_storage_update_succeeded';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM storage.objects
     WHERE id = '95000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'authenticated_storage_delete_succeeded';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '', TRUE);

DO $test$
DECLARE
  v_count INTEGER;
  v_table_name TEXT;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'cabinet_memberships', 'logs_actions', 'jobs', 'file_deletions_outbox'
  ] LOOP
    BEGIN
      EXECUTE pg_catalog.format(
        'SELECT 1 FROM public.%I LIMIT 1', v_table_name
      );
      RAISE EXCEPTION 'anon_raw_%_read_succeeded', v_table_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  BEGIN
    SELECT COUNT(*) INTO v_count
      FROM storage.objects
     WHERE id = '95000000-0000-4000-8000-000000000001';
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'anon_storage_read_succeeded';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO storage.objects (id, bucket_id, name)
    VALUES (
      '95200000-0000-4000-8000-000000000001',
      'pdf-recaps', 'synthetic-only/anon-insert-denied.pdf'
    );
    RAISE EXCEPTION 'anon_storage_insert_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE storage.objects
       SET metadata = storage.objects.metadata
     WHERE id = '95000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'anon_storage_update_succeeded';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM storage.objects
     WHERE id = '95000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'anon_storage_delete_succeeded';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SET LOCAL ROLE service_role;

-- The service API can evaluate active/inactive and multi-cabinet membership
-- after authenticating the caller, while browser roles cannot query it raw.
DO $test$
BEGIN
  IF (
    SELECT COUNT(*) FROM public.cabinet_memberships
     WHERE user_id = '91000000-0000-4000-8000-000000000001'
       AND actif
  ) <> 1 THEN
    RAISE EXCEPTION 'service_active_membership_filter_wrong_for_user_a';
  END IF;

  IF (
    SELECT COUNT(*) FROM public.cabinet_memberships
     WHERE user_id = '91000000-0000-4000-8000-000000000002'
       AND actif
  ) <> 2 THEN
    RAISE EXCEPTION 'service_multi_cabinet_filter_wrong_for_user_b';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cabinet_memberships
     WHERE cabinet_id = '92000000-0000-4000-8000-000000000002'
       AND user_id = '91000000-0000-4000-8000-000000000001'
       AND actif
  ) THEN
    RAISE EXCEPTION 'inactive_membership_authorized';
  END IF;
END;
$test$;

-- CHECK/UNIQUE failures are captured explicitly, so neither can become a
-- silent false-positive.
DO $test$
BEGIN
  BEGIN
    INSERT INTO public.cabinet_memberships (cabinet_id, user_id, role)
    VALUES (
      '92000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000003',
      'owner'
    );
    RAISE EXCEPTION 'invalid_membership_role_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.cabinet_memberships (cabinet_id, user_id, role)
    VALUES (
      '92000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000001',
      'viewer'
    );
    RAISE EXCEPTION 'duplicate_membership_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$test$;

-- Last-active-admin guard: inactive admins do not count, demotion/deactivation/
-- deletion are rejected, a second active admin permits one removal, and the
-- remaining admin is protected. The actual two-backend race is exercised after
-- this transaction is rolled back.
DO $test$
BEGIN
  BEGIN
    UPDATE public.cabinet_memberships
       SET actif = FALSE
     WHERE id = '93000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'last_admin_deactivation_succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.cabinet_memberships
       SET role = 'viewer'
     WHERE id = '93000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'last_admin_demotion_succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    DELETE FROM public.cabinet_memberships
     WHERE id = '93000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'last_admin_delete_with_inactive_alternative_succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE public.cabinet_memberships
     SET role = 'admin', updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00'
   WHERE id = '93000000-0000-4000-8000-000000000002';

  IF (
    SELECT updated_at FROM public.cabinet_memberships
     WHERE id = '93000000-0000-4000-8000-000000000002'
  ) = TIMESTAMPTZ '2000-01-01 00:00:00+00' THEN
    RAISE EXCEPTION 'membership_updated_at_trigger_failed';
  END IF;

  DELETE FROM public.cabinet_memberships
   WHERE id = '93000000-0000-4000-8000-000000000001';

  BEGIN
    DELETE FROM public.cabinet_memberships
     WHERE id = '93000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'remaining_last_admin_delete_succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    TRUNCATE TABLE public.cabinet_memberships;
    RAISE EXCEPTION 'membership_truncate_succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$test$;

-- Deleting a cabinet remains possible and cascades its membership; the guard
-- distinguishes this lifecycle operation from removing the last member only.
DELETE FROM public.cabinets
 WHERE id = '92000000-0000-4000-8000-000000000003';

DO $test$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.cabinet_memberships
     WHERE cabinet_id = '92000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'cabinet_membership_cascade_failed';
  END IF;
END;
$test$;

RESET ROLE;
ROLLBACK;

SELECT 'PORTAL_TENANT_RLS_INVARIANTS_PASS' AS result;
