\set ON_ERROR_STOP on

BEGIN;

DO $test$
DECLARE
  v_proc REGPROCEDURE :=
    'public.record_portal_pdf_download_authorization(uuid,uuid,uuid)'::REGPROCEDURE;
  v_config TEXT[];
BEGIN
  SELECT p.proconfig INTO STRICT v_config
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_proc::OID;
  IF pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE')
     OR NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
    RAISE EXCEPTION 'portal_pdf_audit_function_security_contract_wrong';
  END IF;
END;
$test$;

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut
) VALUES (
  'e2000000-0000-4000-8000-000000000001',
  'Synthetic PDF audit cabinet', 'synthetic-pdf-audit-cabinet',
  '+41000000501', 'pdf-audit@example.invalid', 'actif'
);

INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, pdf_url, email_status
) VALUES (
  'e3000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000001', 'pdf-audit-call-001',
  pg_catalog.now(),
  'e2000000-0000-4000-8000-000000000001/2026-08/e3000000-0000-4000-8000-000000000001.pdf',
  'sent'
);

-- The PDF migration must preserve every action introduced by the earlier
-- portal_team_management migration.
SET LOCAL ROLE service_role;
INSERT INTO public.portal_audit_events (
  cabinet_id, actor_user_id, action, changed_fields
) VALUES (
  'e2000000-0000-4000-8000-000000000001',
  'e4000000-0000-4000-8000-000000000001',
  'team_member_disabled',
  ARRAY['status']::TEXT[]
);
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT public.record_portal_pdf_download_authorization(
  'e2000000-0000-4000-8000-000000000001',
  'e4000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000001'
);
RESET ROLE;

DO $test$
DECLARE
  v_event public.portal_audit_events%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_event
    FROM public.portal_audit_events
   WHERE entity_id = 'e3000000-0000-4000-8000-000000000001';
  IF v_event.action <> 'pdf_download_authorized'
     OR v_event.entity_type <> 'call'
     OR v_event.changed_fields <> ARRAY[]::TEXT[] THEN
    RAISE EXCEPTION 'portal_pdf_audit_payload_wrong';
  END IF;

  IF pg_catalog.to_jsonb(v_event)::TEXT ~* '(token|path|url|ip|user.agent)' THEN
    RAISE EXCEPTION 'portal_pdf_audit_payload_contains_forbidden_field';
  END IF;
END;
$test$;

ROLLBACK;

SELECT 'PORTAL_PDF_DELIVERY_AUDIT_INVARIANTS_PASS' AS result;
