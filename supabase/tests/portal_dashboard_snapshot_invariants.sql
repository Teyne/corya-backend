\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut
) VALUES
  (
    'b2000000-0000-4000-8000-000000000001',
    'Synthetic dashboard target', 'synthetic-dashboard-target',
    '+41000000301', 'dashboard-target@example.invalid', 'actif'
  ),
  (
    'b2000000-0000-4000-8000-000000000002',
    'Synthetic dashboard other', 'synthetic-dashboard-other',
    '+41000000302', 'dashboard-other@example.invalid', 'actif'
  ),
  (
    'b2000000-0000-4000-8000-000000000003',
    'Synthetic dashboard empty', 'synthetic-dashboard-empty',
    '+41000000303', 'dashboard-empty@example.invalid', 'actif'
  );

INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes,
  numero_appelant_hash, numero_appelant_masque, resultat, motif_appel,
  patient_nom, patient_prenom, patient_telephone, rdv_date, rdv_praticien,
  transcript, transcript_anonymise, audio_url, pdf_url, email_status
) VALUES
  (
    'b3000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-001',
    NOW() - INTERVAL '1 day', 60, 'FORBIDDEN_HASH_CANARY', 'FORBIDDEN_MASK_CANARY',
    'rdv_pris', 'rendez-vous synthetique', 'FORBIDDEN_PATIENT_CANARY',
    'FORBIDDEN_FIRSTNAME_CANARY', 'FORBIDDEN_PHONE_CANARY',
    NOW() + INTERVAL '2 days', 'practitioner-1', 'FORBIDDEN_TRANSCRIPT_CANARY',
    'FORBIDDEN_ANON_TRANSCRIPT_CANARY', 'FORBIDDEN_AUDIO_CANARY',
    'FORBIDDEN_PDF_PATH_CANARY', 'sent'
  ),
  (
    'b3000000-0000-4000-8000-000000000002',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-002',
    NOW() - INTERVAL '1 day', 120, NULL, NULL, 'message',
    'message synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'pending'
  ),
  (
    'b3000000-0000-4000-8000-000000000003',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-003',
    NOW() - INTERVAL '1 day', -5, NULL, NULL, 'echec',
    'echec synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'failed'
  ),
  (
    'b3000000-0000-4000-8000-000000000004',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-004',
    NOW() - INTERVAL '1 day', NULL, NULL, NULL, NULL,
    'resultat absent synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, 'pending'
  ),
  (
    'b3000000-0000-4000-8000-000000000005',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-005',
    NOW() - INTERVAL '1 day', 30, NULL, NULL, 'transfere',
    'transfert synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, 'sent'
  ),
  (
    'b3000000-0000-4000-8000-000000000006',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-006',
    NOW() - INTERVAL '1 day', 45, NULL, NULL, 'urgence',
    'urgence synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, 'bounced'
  ),
  (
    'b3000000-0000-4000-8000-000000000007',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-007',
    NOW() - INTERVAL '1 day', 15, NULL, NULL, 'refus',
    'refus synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'FORBIDDEN_RECENT_PDF_PATH_CANARY', 'sent'
  ),
  (
    'b3000000-0000-4000-8000-000000000008',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-008',
    NOW() - INTERVAL '10 days', 100, NULL, NULL, 'rdv_pris',
    'ancien rendez-vous synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, 'sent'
  ),
  (
    'b3000000-0000-4000-8000-000000000009',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-009',
    NOW() - INTERVAL '40 days', 200, NULL, NULL, 'message',
    'ancien message synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, 'sent'
  ),
  (
    'b3000000-0000-4000-8000-000000000010',
    'b2000000-0000-4000-8000-000000000001', 'dashboard-call-010',
    NOW() - INTERVAL '91 days', 999, NULL, NULL, 'echec',
    'hors periode synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, 'failed'
  ),
  (
    'b3000000-0000-4000-8000-000000000011',
    'b2000000-0000-4000-8000-000000000002', 'dashboard-call-011',
    NOW() - INTERVAL '1 day', 500, NULL, NULL, 'rdv_pris',
    'autre cabinet synthetique', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, 'sent'
  );

-- Catalogue contract: exact signature/result, index, stable invoker and ACLs.
DO $test$
DECLARE
  v_proc REGPROCEDURE :=
    'public.get_portal_dashboard_snapshot(uuid,text)'::REGPROCEDURE;
  v_config TEXT[];
  v_security_definer BOOLEAN;
  v_volatility "char";
  v_index_definition TEXT;
BEGIN
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
    RAISE EXCEPTION 'portal_dashboard_function_acl_wrong';
  END IF;

  SELECT p.proconfig, p.prosecdef, p.provolatile
    INTO STRICT v_config, v_security_definer, v_volatility
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_proc::OID;

  IF v_security_definer
     OR v_volatility <> 's'
     OR NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
    RAISE EXCEPTION 'portal_dashboard_function_security_contract_wrong';
  END IF;

  IF pg_catalog.pg_get_function_result(v_proc::OID) <>
     'TABLE(period_start timestamp with time zone, total_calls bigint, total_duration_seconds bigint, appointments bigint, volume_by_date jsonb, outcomes jsonb, recent_calls jsonb)' THEN
    RAISE EXCEPTION 'portal_dashboard_function_result_contract_wrong got=%',
      pg_catalog.pg_get_function_result(v_proc::OID);
  END IF;

  SELECT i.indexdef INTO STRICT v_index_definition
    FROM pg_catalog.pg_indexes AS i
   WHERE i.schemaname = 'public'
     AND i.tablename = 'appels'
     AND i.indexname = 'idx_appels_cabinet_date_id';
  IF pg_catalog.strpos(
       v_index_definition,
       '(cabinet_id, date_appel DESC, id DESC)'
     ) = 0 THEN
    RAISE EXCEPTION 'portal_dashboard_index_contract_wrong got=%', v_index_definition;
  END IF;
END;
$test$;

SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  BEGIN
    PERFORM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000001', '7d'
    );
    RAISE EXCEPTION 'authenticated_portal_dashboard_rpc_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $test$
BEGIN
  BEGIN
    PERFORM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000001', '7d'
    );
    RAISE EXCEPTION 'anon_portal_dashboard_rpc_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SET LOCAL ROLE service_role;

DO $test$
DECLARE
  v_snapshot RECORD;
  v_expected_date TEXT;
  v_key_difference_count INTEGER;
BEGIN
  SELECT * INTO STRICT v_snapshot
    FROM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000001', '7d'
    );

  IF v_snapshot.total_calls <> 7
     OR v_snapshot.total_duration_seconds <> 270
     OR v_snapshot.appointments <> 1
     OR v_snapshot.period_start IS DISTINCT FROM
        pg_catalog.statement_timestamp() - INTERVAL '7 days' THEN
    RAISE EXCEPTION
      'portal_dashboard_7d_metrics_wrong calls=% duration=% appointments=% start=%',
      v_snapshot.total_calls, v_snapshot.total_duration_seconds,
      v_snapshot.appointments, v_snapshot.period_start;
  END IF;

  v_expected_date := pg_catalog.to_char(
    (pg_catalog.statement_timestamp() - INTERVAL '1 day') AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  );
  IF pg_catalog.jsonb_array_length(v_snapshot.volume_by_date) <> 1
     OR v_snapshot.volume_by_date #>> '{0,date}' <> v_expected_date
     OR (v_snapshot.volume_by_date #>> '{0,calls}')::INTEGER <> 7
     OR pg_catalog.jsonb_typeof(v_snapshot.volume_by_date #> '{0,calls}') <> 'number' THEN
    RAISE EXCEPTION 'portal_dashboard_volume_wrong payload=%',
      v_snapshot.volume_by_date;
  END IF;

  IF pg_catalog.jsonb_array_length(v_snapshot.outcomes) <> 6
     OR v_snapshot.outcomes #>> '{0,resultat}' <> 'rdv_pris'
     OR (v_snapshot.outcomes #>> '{0,count}')::INTEGER <> 1
     OR v_snapshot.outcomes #>> '{5,resultat}' <> 'echec'
     OR (v_snapshot.outcomes #>> '{5,count}')::INTEGER <> 2
     OR pg_catalog.jsonb_typeof(v_snapshot.outcomes #> '{5,count}') <> 'number' THEN
    RAISE EXCEPTION 'portal_dashboard_outcomes_wrong payload=%',
      v_snapshot.outcomes;
  END IF;

  IF pg_catalog.jsonb_array_length(v_snapshot.recent_calls) <> 5
     OR v_snapshot.recent_calls #>> '{0,id}' <>
        'b3000000-0000-4000-8000-000000000007'
     OR v_snapshot.recent_calls #>> '{4,id}' <>
        'b3000000-0000-4000-8000-000000000003'
     OR (v_snapshot.recent_calls #>> '{0,has_pdf}')::BOOLEAN IS NOT TRUE
     OR pg_catalog.jsonb_typeof(v_snapshot.recent_calls #> '{0,has_pdf}') <> 'boolean' THEN
    RAISE EXCEPTION 'portal_dashboard_recent_order_or_limit_wrong payload=%',
      v_snapshot.recent_calls;
  END IF;

  WITH expected(key) AS (
    VALUES
      ('id'::TEXT), ('date_appel'), ('duree_secondes'), ('resultat'),
      ('motif_appel'), ('has_pdf'), ('email_status'), ('rdv_date'),
      ('rdv_praticien')
  ), actual AS (
    SELECT key
      FROM pg_catalog.jsonb_object_keys(v_snapshot.recent_calls -> 0) AS keys(key)
  )
  SELECT COUNT(*)::INTEGER INTO v_key_difference_count
    FROM (
      (SELECT key FROM expected EXCEPT SELECT key FROM actual)
      UNION ALL
      (SELECT key FROM actual EXCEPT SELECT key FROM expected)
    ) AS differences;
  IF v_key_difference_count <> 0 THEN
    RAISE EXCEPTION 'portal_dashboard_recent_keys_wrong payload=%',
      v_snapshot.recent_calls -> 0;
  END IF;

  IF v_snapshot.recent_calls::TEXT LIKE '%FORBIDDEN_%'
     OR v_snapshot.recent_calls::TEXT LIKE '%retell%'
     OR v_snapshot.recent_calls::TEXT LIKE '%pdf_url%'
     OR v_snapshot.recent_calls::TEXT LIKE '%patient_%'
     OR v_snapshot.recent_calls::TEXT LIKE '%transcript%'
     OR v_snapshot.recent_calls::TEXT LIKE '%audio_url%'
     OR v_snapshot.recent_calls::TEXT LIKE '%numero_appelant%' THEN
    RAISE EXCEPTION 'portal_dashboard_recent_payload_leaks_forbidden_data payload=%',
      v_snapshot.recent_calls;
  END IF;

  SELECT * INTO STRICT v_snapshot
    FROM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000001', '30d'
    );
  IF v_snapshot.total_calls <> 8
     OR v_snapshot.total_duration_seconds <> 370
     OR v_snapshot.appointments <> 2 THEN
    RAISE EXCEPTION 'portal_dashboard_30d_metrics_wrong';
  END IF;

  SELECT * INTO STRICT v_snapshot
    FROM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000001', '90d'
    );
  IF v_snapshot.total_calls <> 9
     OR v_snapshot.total_duration_seconds <> 570
     OR v_snapshot.appointments <> 2 THEN
    RAISE EXCEPTION 'portal_dashboard_90d_metrics_wrong';
  END IF;

  SELECT * INTO STRICT v_snapshot
    FROM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000003', '7d'
    );
  IF v_snapshot.total_calls <> 0
     OR v_snapshot.total_duration_seconds <> 0
     OR v_snapshot.appointments <> 0
     OR v_snapshot.volume_by_date <> '[]'::JSONB
     OR pg_catalog.jsonb_array_length(v_snapshot.outcomes) <> 6
     OR v_snapshot.recent_calls <> '[]'::JSONB THEN
    RAISE EXCEPTION 'portal_dashboard_empty_snapshot_wrong';
  END IF;

  BEGIN
    PERFORM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000001', '365d'
    );
    RAISE EXCEPTION 'portal_dashboard_invalid_period_succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.get_portal_dashboard_snapshot(NULL, '7d');
    RAISE EXCEPTION 'portal_dashboard_null_cabinet_succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.get_portal_dashboard_snapshot(
      'b2000000-0000-4000-8000-000000000099', '7d'
    );
    RAISE EXCEPTION 'portal_dashboard_missing_cabinet_succeeded';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END;
$test$;

RESET ROLE;
ROLLBACK;

SELECT 'PORTAL_DASHBOARD_SNAPSHOT_INVARIANTS_PASS' AS result;
