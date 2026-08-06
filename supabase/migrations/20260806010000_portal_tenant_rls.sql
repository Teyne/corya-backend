-- =============================================================================
-- Corya - Portal tenant membership foundation and client isolation
--
-- Trust boundary:
--   - browser roles (anon/authenticated) never access PostgREST or Storage raw;
--   - the portal BFF authenticates the user and calls the Express API;
--   - Express authorizes the cabinet explicitly, then uses service_role.
--
-- This migration is forward-only and transactionally replaces the historical
-- global admin policies. It intentionally creates no client-facing policy.
-- =============================================================================

BEGIN;

-- Dedicated cabinet membership model. Internal Corya operators remain in
-- admin_users and are not implicitly cabinet members.
CREATE TABLE public.cabinet_memberships (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id UUID        NOT NULL
    REFERENCES public.cabinets(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL,
  actif       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cabinet_memberships_role_check
    CHECK (role IN ('admin', 'viewer')),
  CONSTRAINT cabinet_memberships_cabinet_user_key
    UNIQUE (cabinet_id, user_id)
);

CREATE INDEX idx_cabinet_memberships_user_id
  ON public.cabinet_memberships(user_id);

CREATE INDEX idx_cabinet_memberships_active_cabinet_role
  ON public.cabinet_memberships(cabinet_id, role)
  WHERE actif = TRUE;

CREATE TRIGGER trigger_cabinet_memberships_updated_at
BEFORE UPDATE ON public.cabinet_memberships
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Serialize every membership mutation per cabinet. In particular, two
-- concurrent transactions cannot each demote/delete a different active admin
-- after observing the other one. Updates moving a membership between cabinets
-- lock both cabinets in deterministic advisory-key order.
CREATE FUNCTION public.protect_last_active_cabinet_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_old_lock BIGINT;
  v_new_lock BIGINT;
  v_removes_old_admin BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cabinet_memberships_truncate_forbidden';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_lock := pg_catalog.hashtextextended(OLD.cabinet_id::TEXT, 8349271);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_lock := pg_catalog.hashtextextended(NEW.cabinet_id::TEXT, 8349271);
  END IF;

  -- Coordinate with cabinet deletion before taking the advisory mutex. The
  -- ordered parent-row locks avoid a membership/delete-cascade lock inversion.
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.cabinets AS c
     WHERE c.id = NEW.cabinet_id
     FOR KEY SHARE;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM 1
      FROM public.cabinets AS c
     WHERE c.id = OLD.cabinet_id
     FOR KEY SHARE;
  ELSE
    PERFORM 1
      FROM public.cabinets AS c
     WHERE c.id IN (OLD.cabinet_id, NEW.cabinet_id)
     ORDER BY c.id
     FOR KEY SHARE;
  END IF;

  IF v_old_lock IS NOT NULL AND v_new_lock IS NOT NULL
     AND v_old_lock IS DISTINCT FROM v_new_lock THEN
    IF v_old_lock < v_new_lock THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(v_old_lock);
      PERFORM pg_catalog.pg_advisory_xact_lock(v_new_lock);
    ELSE
      PERFORM pg_catalog.pg_advisory_xact_lock(v_new_lock);
      PERFORM pg_catalog.pg_advisory_xact_lock(v_old_lock);
    END IF;
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(
      COALESCE(v_old_lock, v_new_lock)
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_removes_old_admin := OLD.actif AND OLD.role = 'admin';
  ELSIF TG_OP = 'UPDATE' THEN
    v_removes_old_admin :=
      OLD.actif
      AND OLD.role = 'admin'
      AND (
        NEW.cabinet_id IS DISTINCT FROM OLD.cabinet_id
        OR NOT NEW.actif
        OR NEW.role <> 'admin'
      );
  END IF;

  -- A cabinet deletion may legitimately cascade all memberships. At the time
  -- its FK cascade runs, the parent cabinet is no longer visible here.
  IF v_removes_old_admin
     AND EXISTS (
       SELECT 1
       FROM public.cabinets AS c
       WHERE c.id = OLD.cabinet_id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.cabinet_memberships AS cm
       WHERE cm.cabinet_id = OLD.cabinet_id
         AND cm.role = 'admin'
         AND cm.actif
         AND cm.id <> OLD.id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cabinet_requires_active_admin';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.protect_last_active_cabinet_admin()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trigger_cabinet_memberships_protect_last_admin
BEFORE INSERT OR UPDATE OR DELETE ON public.cabinet_memberships
FOR EACH ROW EXECUTE FUNCTION public.protect_last_active_cabinet_admin();

CREATE TRIGGER trigger_cabinet_memberships_forbid_truncate
BEFORE TRUNCATE ON public.cabinet_memberships
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_last_active_cabinet_admin();

-- Remove every historical global client policy by its exact deployed name.
DROP POLICY IF EXISTS "Admins can read cabinets" ON public.cabinets;
DROP POLICY IF EXISTS "Admins can insert cabinets" ON public.cabinets;
DROP POLICY IF EXISTS "Admins can update cabinets" ON public.cabinets;
DROP POLICY IF EXISTS "Admins can read appels" ON public.appels;
DROP POLICY IF EXISTS "Admins can view admin list" ON public.admin_users;
DROP POLICY IF EXISTS "Admins can read logs" ON public.logs_actions;
DROP POLICY IF EXISTS "pdf_recaps_admin_read" ON storage.objects;

-- RLS remains an independent deny-by-default barrier. No browser policy is
-- created for cabinets, appels, memberships, internal tables or Storage.
ALTER TABLE public.cabinets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appels                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cabinet_memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logs_actions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_deletions_outbox  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_heartbeats      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_first_seen        ENABLE ROW LEVEL SECURITY;

-- Close both table-level and any pre-existing column-level grants for browser
-- roles. Column ACL cleanup prevents a stale grant from exposing patient_*,
-- transcript, audio_url, pdf_url or other raw fields despite table revocation.
REVOKE ALL PRIVILEGES ON TABLE
  public.cabinets,
  public.appels,
  public.cabinet_memberships,
  public.admin_users,
  public.logs_actions,
  public.jobs,
  public.file_deletions_outbox,
  public.worker_heartbeats,
  public.cron_first_seen
FROM PUBLIC, anon, authenticated;

DO $acl_cleanup$
DECLARE
  v_table_name TEXT;
  v_columns TEXT;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'cabinets',
    'appels',
    'cabinet_memberships',
    'admin_users',
    'logs_actions',
    'jobs',
    'file_deletions_outbox',
    'worker_heartbeats',
    'cron_first_seen'
  ] LOOP
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum)
      INTO v_columns
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_table_name)
       AND a.attnum > 0
       AND NOT a.attisdropped;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      'ON TABLE public.%2$I FROM PUBLIC, anon, authenticated',
      v_columns,
      v_table_name
    );
  END LOOP;
END;
$acl_cleanup$;

-- Preserve the privileged server contract explicitly instead of relying on
-- default privileges or role inheritance.
GRANT ALL PRIVILEGES ON TABLE
  public.cabinets,
  public.appels,
  public.cabinet_memberships,
  public.admin_users,
  public.logs_actions,
  public.jobs,
  public.file_deletions_outbox,
  public.worker_heartbeats,
  public.cron_first_seen
TO service_role;

REVOKE ALL ON FUNCTION public.is_admin_user()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_user() TO service_role;

-- The three existing pdf-recaps service_role policies are intentionally left
-- unchanged: write_only, update and delete. There is no client SELECT policy.

COMMIT;
