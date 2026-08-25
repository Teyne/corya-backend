-- =============================================================================
-- Corya - Portal team management
--
-- Membership mutations are tenant-scoped, admin-only and audited without
-- storing e-mail addresses or any other value in the audit trail. The existing
-- last-active-admin trigger remains the concurrency-safe final barrier.
-- =============================================================================

BEGIN;

ALTER TABLE public.portal_audit_events
  DROP CONSTRAINT portal_audit_events_action_check,
  DROP CONSTRAINT portal_audit_events_changed_fields_allowlist_check;

ALTER TABLE public.portal_audit_events
  ADD CONSTRAINT portal_audit_events_action_check
    CHECK (action IN (
      'settings_updated',
      'assistant_updated',
      'team_member_invited',
      'team_member_role_updated',
      'team_member_disabled'
    )),
  ADD CONSTRAINT portal_audit_events_changed_fields_allowlist_check
    CHECK (
      (
        action = 'settings_updated'
        AND changed_fields <@ ARRAY[
          'practiceName', 'specialty', 'addressLine', 'postalCode', 'city',
          'timezone', 'notificationEmail', 'ccEmail', 'openingHours',
          'practitioners', 'weeklyDigest', 'notifyOnFailure'
        ]::TEXT[]
      )
      OR
      (
        action = 'assistant_updated'
        AND changed_fields <@ ARRAY[
          'publicName', 'greeting', 'language', 'businessHours',
          'afterHoursBehaviour', 'allowedRequests', 'forbiddenRequests',
          'transferRules', 'maskedTransferNumber', 'emergencyProtocol',
          'shareableInformation', 'minimalCollection', 'confirmAppointments'
        ]::TEXT[]
      )
      OR (action = 'team_member_invited' AND changed_fields <@ ARRAY['role', 'status']::TEXT[])
      OR (action = 'team_member_role_updated' AND changed_fields <@ ARRAY['role']::TEXT[])
      OR (action = 'team_member_disabled' AND changed_fields <@ ARRAY['status']::TEXT[])
    );

CREATE FUNCTION public.find_portal_auth_user_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT u.id
    FROM auth.users AS u
   WHERE pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
   ORDER BY u.created_at, u.id
   LIMIT 1
$function$;

COMMENT ON FUNCTION public.find_portal_auth_user_by_email(TEXT) IS
  'Résout un UUID Auth côté service uniquement. Ne retourne ni ne journalise l adresse e-mail.';

REVOKE ALL ON FUNCTION public.find_portal_auth_user_by_email(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_portal_auth_user_by_email(TEXT)
  TO service_role;

CREATE FUNCTION public.list_portal_team_summaries(p_cabinet_id UUID)
RETURNS TABLE (
  user_id UUID,
  role TEXT,
  actif BOOLEAN,
  created_at TIMESTAMPTZ,
  email TEXT,
  invitation_pending BOOLEAN,
  last_seen_at TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    cm.user_id,
    cm.role,
    cm.actif,
    cm.created_at,
    COALESCE(u.email, ''),
    u.last_sign_in_at IS NULL AS invitation_pending,
    u.last_sign_in_at AS last_seen_at
  FROM public.cabinet_memberships AS cm
  JOIN auth.users AS u ON u.id = cm.user_id
  WHERE cm.cabinet_id = p_cabinet_id
  ORDER BY cm.created_at, cm.user_id
$function$;

COMMENT ON FUNCTION public.list_portal_team_summaries(UUID) IS
  'Liste des membres pour le BFF service-role. L API décide si l adresse e-mail est visible selon le rôle.';

REVOKE ALL ON FUNCTION public.list_portal_team_summaries(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_portal_team_summaries(UUID)
  TO service_role;

CREATE FUNCTION public.apply_portal_membership_mutation_with_audit(
  p_cabinet_id UUID,
  p_actor_user_id UUID,
  p_target_user_id UUID,
  p_action TEXT,
  p_role TEXT DEFAULT NULL
)
RETURNS public.cabinet_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_membership public.cabinet_memberships;
  v_fields TEXT[];
BEGIN
  IF p_action NOT IN (
    'team_member_invited',
    'team_member_role_updated',
    'team_member_disabled'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'portal_team_action_invalid';
  END IF;

  IF p_target_user_id = p_actor_user_id
     AND p_action IN ('team_member_role_updated', 'team_member_disabled') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'portal_team_self_mutation_forbidden';
  END IF;

  PERFORM 1
    FROM public.cabinet_memberships AS actor
   WHERE actor.cabinet_id = p_cabinet_id
     AND actor.user_id = p_actor_user_id
     AND actor.role = 'admin'
     AND actor.actif
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'portal_admin_membership_required';
  END IF;

  IF p_action IN ('team_member_invited', 'team_member_role_updated')
     AND (p_role IS NULL OR p_role NOT IN ('admin', 'viewer')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'portal_team_role_invalid';
  END IF;

  IF p_action = 'team_member_invited' THEN
    INSERT INTO public.cabinet_memberships (cabinet_id, user_id, role, actif)
    VALUES (p_cabinet_id, p_target_user_id, p_role, TRUE)
    ON CONFLICT (cabinet_id, user_id) DO UPDATE
      SET role = EXCLUDED.role,
          actif = TRUE,
          updated_at = NOW()
    RETURNING * INTO v_membership;
    v_fields := ARRAY['role', 'status']::TEXT[];
  ELSIF p_action = 'team_member_role_updated' THEN
    UPDATE public.cabinet_memberships
       SET role = p_role,
           updated_at = NOW()
     WHERE cabinet_id = p_cabinet_id
       AND user_id = p_target_user_id
     RETURNING * INTO v_membership;
    v_fields := ARRAY['role']::TEXT[];
  ELSE
    UPDATE public.cabinet_memberships
       SET actif = FALSE,
           updated_at = NOW()
     WHERE cabinet_id = p_cabinet_id
       AND user_id = p_target_user_id
     RETURNING * INTO v_membership;
    v_fields := ARRAY['status']::TEXT[];
  END IF;

  IF v_membership.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'portal_team_member_not_found';
  END IF;

  PERFORM public.record_portal_audit_event(
    p_cabinet_id,
    p_actor_user_id,
    p_action,
    v_fields
  );

  RETURN v_membership;
END;
$function$;

COMMENT ON FUNCTION public.apply_portal_membership_mutation_with_audit(UUID, UUID, UUID, TEXT, TEXT) IS
  'Mutation équipe tenant-scopée et auditée. Le trigger existant protège le dernier administrateur actif.';

REVOKE ALL ON FUNCTION public.apply_portal_membership_mutation_with_audit(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_portal_membership_mutation_with_audit(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;

COMMIT;
