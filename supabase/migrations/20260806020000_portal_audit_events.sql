-- =============================================================================
-- Corya - Minimal Portal audit events
--
-- Only technical identifiers and allowlisted changed field names are stored.
-- Values, patient data, e-mail addresses, IP addresses, headers, tokens and
-- user-agent strings have no column and cannot enter changed_fields.
-- =============================================================================

BEGIN;

CREATE TABLE public.portal_audit_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id      UUID        NOT NULL
    REFERENCES public.cabinets(id) ON DELETE CASCADE,
  actor_user_id   UUID        NOT NULL,
  action          TEXT        NOT NULL,
  changed_fields  TEXT[]      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portal_audit_events_action_check
    CHECK (action IN ('settings_updated', 'assistant_updated')),
  CONSTRAINT portal_audit_events_changed_fields_nonempty_check
    CHECK (
      pg_catalog.cardinality(changed_fields) BETWEEN 1 AND 13
      AND pg_catalog.array_position(changed_fields, NULL) IS NULL
    ),
  CONSTRAINT portal_audit_events_changed_fields_allowlist_check
    CHECK (
      (
        action = 'settings_updated'
        AND changed_fields <@ ARRAY[
          'practiceName',
          'specialty',
          'addressLine',
          'postalCode',
          'city',
          'timezone',
          'notificationEmail',
          'ccEmail',
          'openingHours',
          'practitioners',
          'weeklyDigest',
          'notifyOnFailure'
        ]::TEXT[]
      )
      OR
      (
        action = 'assistant_updated'
        AND changed_fields <@ ARRAY[
          'publicName',
          'greeting',
          'language',
          'businessHours',
          'afterHoursBehaviour',
          'allowedRequests',
          'forbiddenRequests',
          'transferRules',
          'maskedTransferNumber',
          'emergencyProtocol',
          'shareableInformation',
          'minimalCollection',
          'confirmAppointments'
        ]::TEXT[]
      )
    )
);

COMMENT ON TABLE public.portal_audit_events IS
  'Journal Portal minimaliste : identifiants techniques, action allowlistee et '
  'noms de champs modifies uniquement. Retention maximale 24 mois.';

COMMENT ON COLUMN public.portal_audit_events.actor_user_id IS
  'UUID Auth technique de l acteur. Pas d email, nom, IP, header, token ou user-agent.';

COMMENT ON COLUMN public.portal_audit_events.changed_fields IS
  'Noms camelCase allowlistes uniquement; aucune valeur avant/apres.';

CREATE INDEX idx_portal_audit_events_cabinet_created
  ON public.portal_audit_events(cabinet_id, created_at DESC, id DESC);

CREATE INDEX idx_portal_audit_events_created_at
  ON public.portal_audit_events(created_at);

ALTER TABLE public.portal_audit_events ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: deny by default for browser-facing roles.

REVOKE ALL PRIVILEGES ON TABLE public.portal_audit_events
FROM PUBLIC, anon, authenticated;

DO $column_acl_cleanup$
DECLARE
  v_columns TEXT;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_columns
    FROM pg_catalog.pg_attribute AS a
   WHERE a.attrelid = 'public.portal_audit_events'::REGCLASS
     AND a.attnum > 0
     AND NOT a.attisdropped;

  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
    'ON TABLE public.portal_audit_events FROM PUBLIC, anon, authenticated',
    v_columns
  );
END;
$column_acl_cleanup$;

-- Audit rows are append-only for the application. Physical deletion is only
-- available through the bounded SECURITY DEFINER retention function below.
REVOKE ALL PRIVILEGES ON TABLE public.portal_audit_events FROM service_role;
GRANT SELECT, INSERT ON TABLE public.portal_audit_events TO service_role;

CREATE FUNCTION public.record_portal_audit_event(
  p_cabinet_id UUID,
  p_actor_user_id UUID,
  p_action TEXT,
  p_changed_fields TEXT[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_event_id UUID;
  v_changed_fields TEXT[];
BEGIN
  SELECT ARRAY(
    SELECT DISTINCT fields.changed_field
      FROM pg_catalog.unnest(p_changed_fields) AS fields(changed_field)
     ORDER BY fields.changed_field
  )
  INTO v_changed_fields;

  INSERT INTO public.portal_audit_events (
    cabinet_id,
    actor_user_id,
    action,
    changed_fields
  ) VALUES (
    p_cabinet_id,
    p_actor_user_id,
    p_action,
    v_changed_fields
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$function$;

COMMENT ON FUNCTION public.record_portal_audit_event(UUID, UUID, TEXT, TEXT[]) IS
  'Insere un evenement Portal minimal. changed_fields est deduplique et trie; '
  'les contraintes refusent toute action ou nom de champ hors allowlist.';

REVOKE ALL ON FUNCTION public.record_portal_audit_event(UUID, UUID, TEXT, TEXT[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_portal_audit_event(UUID, UUID, TEXT, TEXT[])
TO service_role;

-- The historical generic trigger uses NOW(), which is stable for the whole
-- transaction and therefore cannot serve as an optimistic-concurrency token.
-- Keep other tables unchanged and give cabinets a strictly increasing token.
CREATE FUNCTION public.set_cabinet_updated_at_monotonic()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.updated_at := GREATEST(
    pg_catalog.clock_timestamp(),
    OLD.updated_at + INTERVAL '1 microsecond'
  );
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.set_cabinet_updated_at_monotonic() IS
  'Maintient cabinets.updated_at strictement croissant pour le verrou optimiste Portal.';

REVOKE ALL ON FUNCTION public.set_cabinet_updated_at_monotonic()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER trigger_cabinets_updated_at ON public.cabinets;
CREATE TRIGGER trigger_cabinets_updated_at
BEFORE UPDATE ON public.cabinets
FOR EACH ROW EXECUTE FUNCTION public.set_cabinet_updated_at_monotonic();

-- Apply one allowlisted Portal delta and append its audit event in the same
-- PostgreSQL transaction. The row lock plus expected_updated_at comparison
-- prevents lost updates; callers may retry SQLSTATE 40001 with a fresh row.
CREATE FUNCTION public.apply_portal_cabinet_patch_with_audit(
  p_cabinet_id UUID,
  p_actor_user_id UUID,
  p_action TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_patch JSONB,
  p_changed_fields TEXT[]
)
RETURNS TABLE (
  id UUID,
  nom TEXT,
  type_cabinet TEXT,
  adresse TEXT,
  npa TEXT,
  ville TEXT,
  email_notification TEXT,
  email_notification_cc TEXT,
  statut TEXT,
  config_agent JSONB,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_current public.cabinets%ROWTYPE;
  v_config JSONB;
  v_portal JSONB;
  v_section JSONB;
  v_derived_fields TEXT[];
  v_requested_fields TEXT[];
BEGIN
  IF p_patch IS NULL
     OR pg_catalog.jsonb_typeof(p_patch) <> 'object'
     OR p_patch = '{}'::JSONB THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'portal_patch_must_be_nonempty_object';
  END IF;

  SELECT c.* INTO v_current
    FROM public.cabinets AS c
   WHERE c.id = p_cabinet_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'portal_cabinet_not_found';
  END IF;

  IF v_current.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'portal_cabinet_concurrent_update';
  END IF;

  -- Every membership mutation first locks its membership row, then reaches the
  -- cabinet through protect_last_active_cabinet_admin(). Holding the cabinet
  -- row therefore serializes revocation without taking the membership row in
  -- the inverse order (which would create a deadlock cycle).
  PERFORM 1
    FROM public.cabinet_memberships AS cm
   WHERE cm.cabinet_id = p_cabinet_id
     AND cm.user_id = p_actor_user_id
     AND cm.role = 'admin'
     AND cm.actif;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'portal_admin_membership_required';
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT fields.changed_field
      FROM pg_catalog.unnest(p_changed_fields) AS fields(changed_field)
     ORDER BY fields.changed_field
  ) INTO v_requested_fields;

  IF p_action = 'settings_updated' THEN
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_object_keys(p_patch) AS keys(patch_key)
       WHERE NOT (keys.patch_key = ANY(ARRAY[
         'nom',
         'type_cabinet',
         'adresse',
         'npa',
         'ville',
         'email_notification',
         'email_notification_cc',
         'portalSettings'
       ]::TEXT[]))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'portal_settings_patch_key_not_allowed';
    END IF;

    IF p_patch ? 'portalSettings'
       AND pg_catalog.jsonb_typeof(p_patch -> 'portalSettings') <> 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'portal_settings_delta_must_be_object';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_object_keys(
          COALESCE(p_patch -> 'portalSettings', '{}'::JSONB)
        ) AS keys(setting_key)
       WHERE NOT (keys.setting_key = ANY(ARRAY[
         'openingHours',
         'practitioners',
         'weeklyDigest',
         'notifyOnFailure'
       ]::TEXT[]))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'portal_settings_nested_key_not_allowed';
    END IF;

    SELECT ARRAY(
      SELECT derived.changed_field
        FROM (
          SELECT CASE keys.patch_key
            WHEN 'nom' THEN 'practiceName'
            WHEN 'type_cabinet' THEN 'specialty'
            WHEN 'adresse' THEN 'addressLine'
            WHEN 'npa' THEN 'postalCode'
            WHEN 'ville' THEN 'city'
            WHEN 'email_notification' THEN 'notificationEmail'
            WHEN 'email_notification_cc' THEN 'ccEmail'
          END AS changed_field
          FROM pg_catalog.jsonb_object_keys(p_patch) AS keys(patch_key)
          WHERE keys.patch_key <> 'portalSettings'
          UNION
          SELECT keys.setting_key
          FROM pg_catalog.jsonb_object_keys(
            COALESCE(p_patch -> 'portalSettings', '{}'::JSONB)
          ) AS keys(setting_key)
        ) AS derived
       ORDER BY derived.changed_field
    ) INTO v_derived_fields;
  ELSIF p_action = 'assistant_updated' THEN
    IF NOT (p_patch ? 'portalAssistant')
       OR (SELECT COUNT(*) FROM pg_catalog.jsonb_object_keys(p_patch)) <> 1
       OR pg_catalog.jsonb_typeof(p_patch -> 'portalAssistant') <> 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'portal_assistant_patch_shape_invalid';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_object_keys(p_patch -> 'portalAssistant') AS keys(assistant_key)
       WHERE NOT (keys.assistant_key = ANY(ARRAY[
         'publicName',
         'greeting',
         'language',
         'businessHours',
         'afterHoursBehaviour',
         'allowedRequests',
         'forbiddenRequests',
         'transferRules',
         'maskedTransferNumber',
         'emergencyProtocol',
         'shareableInformation',
         'minimalCollection',
         'confirmAppointments'
       ]::TEXT[]))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'portal_assistant_nested_key_not_allowed';
    END IF;

    SELECT ARRAY(
      SELECT keys.assistant_key
        FROM pg_catalog.jsonb_object_keys(p_patch -> 'portalAssistant') AS keys(assistant_key)
       ORDER BY keys.assistant_key
    ) INTO v_derived_fields;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'portal_patch_action_not_allowed';
  END IF;

  IF pg_catalog.cardinality(v_derived_fields) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'portal_patch_has_no_changed_field';
  END IF;

  IF v_requested_fields IS DISTINCT FROM v_derived_fields THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'portal_patch_audit_fields_mismatch';
  END IF;

  v_config := CASE
    WHEN pg_catalog.jsonb_typeof(v_current.config_agent) = 'object'
      THEN v_current.config_agent
    ELSE '{}'::JSONB
  END;
  v_portal := CASE
    WHEN pg_catalog.jsonb_typeof(v_config -> 'portal') = 'object'
      THEN v_config -> 'portal'
    ELSE '{}'::JSONB
  END;

  IF p_action = 'settings_updated' AND p_patch ? 'portalSettings' THEN
    v_section := CASE
      WHEN pg_catalog.jsonb_typeof(v_portal -> 'settings') = 'object'
        THEN v_portal -> 'settings'
      ELSE '{}'::JSONB
    END;
    v_portal := pg_catalog.jsonb_set(
      v_portal,
      '{settings}',
      v_section || (p_patch -> 'portalSettings'),
      TRUE
    );
  ELSIF p_action = 'assistant_updated' THEN
    v_section := CASE
      WHEN pg_catalog.jsonb_typeof(v_portal -> 'assistant') = 'object'
        THEN v_portal -> 'assistant'
      ELSE '{}'::JSONB
    END;
    v_portal := pg_catalog.jsonb_set(
      v_portal,
      '{assistant}',
      v_section || (p_patch -> 'portalAssistant'),
      TRUE
    );
  END IF;

  v_config := pg_catalog.jsonb_set(v_config, '{portal}', v_portal, TRUE);

  UPDATE public.cabinets AS c
     SET nom = CASE
           WHEN p_patch ? 'nom' THEN p_patch ->> 'nom' ELSE c.nom
         END,
         type_cabinet = CASE
           WHEN p_patch ? 'type_cabinet' THEN p_patch ->> 'type_cabinet'
           ELSE c.type_cabinet
         END,
         adresse = CASE
           WHEN p_patch ? 'adresse' THEN p_patch ->> 'adresse' ELSE c.adresse
         END,
         npa = CASE
           WHEN p_patch ? 'npa' THEN p_patch ->> 'npa' ELSE c.npa
         END,
         ville = CASE
           WHEN p_patch ? 'ville' THEN p_patch ->> 'ville' ELSE c.ville
         END,
         email_notification = CASE
           WHEN p_patch ? 'email_notification' THEN p_patch ->> 'email_notification'
           ELSE c.email_notification
         END,
         email_notification_cc = CASE
           WHEN p_patch ? 'email_notification_cc' THEN p_patch ->> 'email_notification_cc'
           ELSE c.email_notification_cc
         END,
         config_agent = v_config
   WHERE c.id = p_cabinet_id;

  -- If this insert fails, PostgreSQL rolls the cabinet UPDATE back with it.
  PERFORM public.record_portal_audit_event(
    p_cabinet_id,
    p_actor_user_id,
    p_action,
    v_derived_fields
  );

  RETURN QUERY
  SELECT
    c.id,
    c.nom,
    c.type_cabinet,
    c.adresse,
    c.npa,
    c.ville,
    c.email_notification,
    c.email_notification_cc,
    c.statut,
    c.config_agent,
    c.updated_at
  FROM public.cabinets AS c
  WHERE c.id = p_cabinet_id;
END;
$function$;

COMMENT ON FUNCTION public.apply_portal_cabinet_patch_with_audit(
  UUID, UUID, TEXT, TIMESTAMPTZ, JSONB, TEXT[]
) IS
  'Applique atomiquement un delta Portal allowliste et son audit minimal. '
  'Verrouille le cabinet, refuse updated_at obsolete (SQLSTATE 40001), fusionne '
  'les sous-objets Portal et retourne la projection PortalCabinetRow.';

REVOKE ALL ON FUNCTION public.apply_portal_cabinet_patch_with_audit(
  UUID, UUID, TEXT, TIMESTAMPTZ, JSONB, TEXT[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_portal_cabinet_patch_with_audit(
  UUID, UUID, TEXT, TIMESTAMPTZ, JSONB, TEXT[]
) TO service_role;

CREATE FUNCTION public.purge_ancient_portal_audit_events()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_purged_count INTEGER;
BEGIN
  DELETE FROM public.portal_audit_events
   WHERE created_at < NOW() - INTERVAL '24 months';

  GET DIAGNOSTICS v_purged_count = ROW_COUNT;
  RETURN v_purged_count;
END;
$function$;

COMMENT ON FUNCTION public.purge_ancient_portal_audit_events() IS
  'Supprime idempotemment les evenements Portal ages de plus de 24 mois.';

REVOKE ALL ON FUNCTION public.purge_ancient_portal_audit_events()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ancient_portal_audit_events()
TO service_role;

-- Reuse the existing monthly audit-log retention slot. The cron name, schedule
-- and total active-cron inventory stay unchanged (10), while both audit tables
-- are purged in the same bounded operation.
DO $cron_replace$
BEGIN
  PERFORM cron.unschedule('purge-ancient-logs-actions');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron_replace$;

SELECT cron.schedule(
  'purge-ancient-logs-actions',
  '17 4 15 * *',
  $$
    SELECT
      public.purge_ancient_logs_actions(),
      public.purge_ancient_portal_audit_events();
  $$
);

COMMIT;
