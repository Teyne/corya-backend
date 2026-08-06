-- =============================================================================
-- Corya - Exact Portal dashboard snapshot
--
-- Aggregate the selected period inside one PostgreSQL statement. Only the
-- existing minimal Portal call projection can leave the database: never a
-- caller number/hash, patient field, transcript, audio URL, Retell identifier
-- or PDF path.
-- =============================================================================

BEGIN;

CREATE INDEX idx_appels_cabinet_date_id
  ON public.appels(cabinet_id, date_appel DESC, id DESC);

CREATE FUNCTION public.get_portal_dashboard_snapshot(
  p_cabinet_id UUID,
  p_period TEXT
)
RETURNS TABLE (
  period_start TIMESTAMPTZ,
  total_calls BIGINT,
  total_duration_seconds BIGINT,
  appointments BIGINT,
  volume_by_date JSONB,
  outcomes JSONB,
  recent_calls JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_period_start TIMESTAMPTZ;
BEGIN
  IF p_cabinet_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'portal_dashboard_cabinet_id_required';
  END IF;

  v_period_start := pg_catalog.statement_timestamp() - CASE p_period
    WHEN '7d' THEN INTERVAL '7 days'
    WHEN '30d' THEN INTERVAL '30 days'
    WHEN '90d' THEN INTERVAL '90 days'
    ELSE NULL
  END;

  IF v_period_start IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'portal_dashboard_period_invalid';
  END IF;

  -- This RETURN QUERY is the only data-reading SQL command in the function.
  -- At READ COMMITTED, the complete dashboard therefore uses one statement
  -- snapshot even while calls are inserted or updated concurrently.
  RETURN QUERY
  WITH cabinet_scope AS MATERIALIZED (
    SELECT c.id
      FROM public.cabinets AS c
     WHERE c.id = p_cabinet_id
  ), snapshot_calls AS MATERIALIZED (
    SELECT
      a.id,
      a.date_appel,
      a.duree_secondes,
      a.resultat,
      a.motif_appel,
      (a.pdf_url IS NOT NULL) AS has_pdf,
      a.email_status,
      a.rdv_date,
      a.rdv_praticien
    FROM public.appels AS a
    JOIN cabinet_scope AS scope ON scope.id = a.cabinet_id
    WHERE a.date_appel >= v_period_start
  ), metrics AS (
    SELECT
      pg_catalog.count(*)::BIGINT AS metric_total_calls,
      COALESCE(
        pg_catalog.sum(
          GREATEST(COALESCE(c.duree_secondes, 0), 0)::BIGINT
        ),
        0::NUMERIC
      )::BIGINT AS metric_total_duration_seconds,
      pg_catalog.count(*) FILTER (
        WHERE c.resultat = 'rdv_pris'
      )::BIGINT AS metric_appointments
    FROM snapshot_calls AS c
  ), volume AS (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'date', daily.call_date::TEXT,
          'calls', daily.call_count
        )
        ORDER BY daily.call_date
      ),
      '[]'::JSONB
    ) AS payload
    FROM (
      SELECT
        (c.date_appel AT TIME ZONE 'UTC')::DATE AS call_date,
        pg_catalog.count(*)::BIGINT AS call_count
      FROM snapshot_calls AS c
      GROUP BY (c.date_appel AT TIME ZONE 'UTC')::DATE
    ) AS daily
  ), outcome_counts AS (
    SELECT
      COALESCE(c.resultat, 'echec') AS resultat,
      pg_catalog.count(*)::BIGINT AS outcome_count
    FROM snapshot_calls AS c
    GROUP BY COALESCE(c.resultat, 'echec')
  ), outcome_payload AS (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'resultat', catalogue.resultat,
        'count', COALESCE(counts.outcome_count, 0::BIGINT)
      )
      ORDER BY catalogue.ordinal
    ) AS payload
    FROM (
      VALUES
        ('rdv_pris'::TEXT, 1),
        ('message'::TEXT, 2),
        ('transfere'::TEXT, 3),
        ('urgence'::TEXT, 4),
        ('refus'::TEXT, 5),
        ('echec'::TEXT, 6)
    ) AS catalogue(resultat, ordinal)
    LEFT JOIN outcome_counts AS counts USING (resultat)
  ), recent_payload AS (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', recent.id,
          'date_appel', recent.date_appel,
          'duree_secondes', recent.duree_secondes,
          'resultat', recent.resultat,
          'motif_appel', recent.motif_appel,
          'has_pdf', recent.has_pdf,
          'email_status', recent.email_status,
          'rdv_date', recent.rdv_date,
          'rdv_praticien', recent.rdv_praticien
        )
        ORDER BY recent.date_appel DESC, recent.id DESC
      ),
      '[]'::JSONB
    ) AS payload
    FROM (
      SELECT c.*
        FROM snapshot_calls AS c
       ORDER BY c.date_appel DESC, c.id DESC
       LIMIT 5
    ) AS recent
  )
  SELECT
    v_period_start,
    metrics.metric_total_calls,
    metrics.metric_total_duration_seconds,
    metrics.metric_appointments,
    volume.payload,
    outcome_payload.payload,
    recent_payload.payload
  FROM cabinet_scope
  CROSS JOIN metrics
  CROSS JOIN volume
  CROSS JOIN outcome_payload
  CROSS JOIN recent_payload;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'portal_cabinet_not_found';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.get_portal_dashboard_snapshot(UUID, TEXT) IS
  'Retourne en un snapshot SQL les agregats Portal exacts et cinq appels '
  'recents minimaux. Aucun numero, patient, transcript, audio, Retell ou path PDF.';

REVOKE ALL ON FUNCTION public.get_portal_dashboard_snapshot(UUID, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_portal_dashboard_snapshot(UUID, TEXT)
TO service_role;

COMMIT;
