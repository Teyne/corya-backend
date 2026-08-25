\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at, last_sign_in_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'team-admin@example.invalid', '', NOW(), NOW(), NOW(), NOW(), '{}', '{}', FALSE),
  ('b1000000-0000-4000-8000-000000000002', 'team-viewer@example.invalid', '', NOW(), NULL, NOW(), NOW(), '{}', '{}', FALSE),
  ('b1000000-0000-4000-8000-000000000003', 'team-target@example.invalid', '', NOW(), NULL, NOW(), NOW(), '{}', '{}', FALSE);

INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut, config_agent
) VALUES (
  'b2000000-0000-4000-8000-000000000001',
  'Synthetic portal team', 'synthetic-portal-team', '+41000000261',
  'team-cabinet@example.invalid', 'actif', '{}'::JSONB
);

INSERT INTO public.cabinet_memberships (cabinet_id, user_id, role, actif) VALUES
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'admin', TRUE),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'viewer', TRUE);

-- Browser roles cannot discover users or mutate memberships through the RPCs.
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  BEGIN
    PERFORM public.find_portal_auth_user_by_email('team-admin@example.invalid');
    RAISE EXCEPTION 'authenticated_auth_lookup_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.list_portal_team_summaries('b2000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'authenticated_team_list_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.apply_portal_membership_mutation_with_audit(
      'b2000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000003',
      'team_member_invited', 'viewer'
    );
    RAISE EXCEPTION 'authenticated_team_mutation_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SET LOCAL ROLE service_role;

DO $test$
DECLARE
  v_user_id UUID;
  v_invited BOOLEAN;
  v_email TEXT;
BEGIN
  SELECT public.find_portal_auth_user_by_email(' TEAM-ADMIN@example.invalid ')
    INTO v_user_id;
  IF v_user_id <> 'b1000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'portal_auth_lookup_wrong_result';
  END IF;

  SELECT invitation_pending, email
    INTO v_invited, v_email
    FROM public.list_portal_team_summaries('b2000000-0000-4000-8000-000000000001')
   WHERE user_id = 'b1000000-0000-4000-8000-000000000002';
  IF v_invited IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'portal_team_invitation_status_wrong';
  END IF;
  IF v_email IS DISTINCT FROM 'team-viewer@example.invalid' THEN
    RAISE EXCEPTION 'portal_team_email_projection_wrong';
  END IF;
END;
$test$;

-- A viewer cannot act as the cabinet administrator.
DO $test$
BEGIN
  BEGIN
    PERFORM public.apply_portal_membership_mutation_with_audit(
      'b2000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000002',
      'b1000000-0000-4000-8000-000000000003',
      'team_member_invited', 'viewer'
    );
    RAISE EXCEPTION 'viewer_team_mutation_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

SELECT public.apply_portal_membership_mutation_with_audit(
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000003',
  'team_member_invited', 'viewer'
);

SELECT public.apply_portal_membership_mutation_with_audit(
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000003',
  'team_member_role_updated', 'admin'
);

SELECT public.apply_portal_membership_mutation_with_audit(
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000003',
  'team_member_disabled', NULL
);

DO $test$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.cabinet_memberships
     WHERE cabinet_id = 'b2000000-0000-4000-8000-000000000001'
       AND user_id = 'b1000000-0000-4000-8000-000000000003'
       AND actif
  ) THEN
    RAISE EXCEPTION 'portal_team_disable_not_applied';
  END IF;

  IF (
    SELECT COUNT(*) FROM public.portal_audit_events
     WHERE cabinet_id = 'b2000000-0000-4000-8000-000000000001'
       AND action IN (
         'team_member_invited',
         'team_member_role_updated',
         'team_member_disabled'
       )
  ) <> 3 THEN
    RAISE EXCEPTION 'portal_team_audit_count_wrong';
  END IF;

  BEGIN
    PERFORM public.apply_portal_membership_mutation_with_audit(
      'b2000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000001',
      'team_member_disabled', NULL
    );
    RAISE EXCEPTION 'portal_team_self_disable_succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

ROLLBACK;

SELECT 'PORTAL_TEAM_MANAGEMENT_INVARIANTS_PASS' AS result;
