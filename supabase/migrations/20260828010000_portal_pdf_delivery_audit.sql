-- Corya — fail-closed audit for authenticated PDF download authorization.

ALTER TABLE public.portal_audit_events
  ADD COLUMN entity_type TEXT,
  ADD COLUMN entity_id UUID;

ALTER TABLE public.portal_audit_events
  DROP CONSTRAINT portal_audit_events_action_check,
  DROP CONSTRAINT portal_audit_events_changed_fields_nonempty_check,
  DROP CONSTRAINT portal_audit_events_changed_fields_allowlist_check;

ALTER TABLE public.portal_audit_events
  ADD CONSTRAINT portal_audit_events_action_check
    CHECK (action IN (
      'settings_updated',
      'assistant_updated',
      'team_member_invited',
      'team_member_role_updated',
      'team_member_disabled',
      'pdf_download_authorized'
    )),
  ADD CONSTRAINT portal_audit_events_changed_fields_shape_check
    CHECK (
      pg_catalog.array_position(changed_fields, NULL) IS NULL
      AND (
        (action IN (
          'settings_updated',
          'assistant_updated',
          'team_member_invited',
          'team_member_role_updated',
          'team_member_disabled'
        )
          AND pg_catalog.cardinality(changed_fields) BETWEEN 1 AND 13)
        OR
        (action = 'pdf_download_authorized'
          AND pg_catalog.cardinality(changed_fields) = 0)
      )
    ),
  ADD CONSTRAINT portal_audit_events_changed_fields_allowlist_check
    CHECK (
      (action = 'settings_updated' AND changed_fields <@ ARRAY[
        'practiceName', 'specialty', 'addressLine', 'postalCode', 'city',
        'timezone', 'notificationEmail', 'ccEmail', 'openingHours',
        'practitioners', 'weeklyDigest', 'notifyOnFailure'
      ]::TEXT[])
      OR
      (action = 'assistant_updated' AND changed_fields <@ ARRAY[
        'publicName', 'greeting', 'language', 'businessHours',
        'afterHoursBehaviour', 'allowedRequests', 'forbiddenRequests',
        'transferRules', 'maskedTransferNumber', 'emergencyProtocol',
        'shareableInformation', 'minimalCollection', 'confirmAppointments'
      ]::TEXT[])
      OR
      (action = 'team_member_invited'
        AND changed_fields <@ ARRAY['role', 'status']::TEXT[])
      OR
      (action = 'team_member_role_updated'
        AND changed_fields <@ ARRAY['role']::TEXT[])
      OR
      (action = 'team_member_disabled'
        AND changed_fields <@ ARRAY['status']::TEXT[])
      OR
      (action = 'pdf_download_authorized' AND changed_fields = ARRAY[]::TEXT[])
    ),
  ADD CONSTRAINT portal_audit_events_entity_check
    CHECK (
      (action = 'pdf_download_authorized'
        AND entity_type = 'call'
        AND entity_id IS NOT NULL)
      OR
      (action <> 'pdf_download_authorized'
        AND entity_type IS NULL
        AND entity_id IS NULL)
    );

COMMENT ON COLUMN public.portal_audit_events.entity_type IS
  'Type technique allowlisté. Uniquement call pour une autorisation PDF.';
COMMENT ON COLUMN public.portal_audit_events.entity_id IS
  'UUID technique de l appel autorisé. Aucun chemin, URL, token, IP ou user-agent.';

CREATE INDEX idx_portal_audit_events_entity
  ON public.portal_audit_events(cabinet_id, entity_type, entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE FUNCTION public.record_portal_pdf_download_authorization(
  p_cabinet_id UUID,
  p_actor_user_id UUID,
  p_call_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_event_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.appels AS a
     WHERE a.id = p_call_id
       AND a.cabinet_id = p_cabinet_id
       AND a.pdf_url IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'portal_pdf_not_found';
  END IF;

  INSERT INTO public.portal_audit_events (
    cabinet_id,
    actor_user_id,
    action,
    changed_fields,
    entity_type,
    entity_id
  ) VALUES (
    p_cabinet_id,
    p_actor_user_id,
    'pdf_download_authorized',
    ARRAY[]::TEXT[],
    'call',
    p_call_id
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$function$;

COMMENT ON FUNCTION public.record_portal_pdf_download_authorization(UUID, UUID, UUID) IS
  'Journalise avant émission du ticket une autorisation PDF. Échec fermé : '
  'aucun ticket ne doit être retourné si cet insert échoue.';

REVOKE ALL ON FUNCTION public.record_portal_pdf_download_authorization(UUID, UUID, UUID)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_portal_pdf_download_authorization(UUID, UUID, UUID)
TO service_role;
