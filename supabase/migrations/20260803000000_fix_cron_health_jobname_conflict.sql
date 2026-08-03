-- Wave 7 runtime corrective: get_cron_health() failed at runtime because the
-- PL/pgSQL RETURNS TABLE output variable `jobname` was ambiguous with the
-- column named in `ON CONFLICT (jobname)`. The Wave 7 invariant harness did
-- not previously execute the RPC, so the defect was only exposed by the
-- first Jelastic API boot.
--
-- Keep this append-only: 20260802000002 is already applied remotely.

CREATE OR REPLACE FUNCTION public.get_cron_health()
RETURNS TABLE (
  jobname                        TEXT,
  schedule                       TEXT,
  last_run_at                    TIMESTAMPTZ,
  last_success_at                TIMESTAMPTZ,
  last_status                    TEXT,
  seconds_since_last_run         NUMERIC,
  seconds_since_last_success     NUMERIC,
  total_runs_last_24h            BIGINT,
  failed_runs_last_24h           BIGINT,
  first_seen_at                  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.cron_first_seen (jobname, first_seen_at)
  SELECT j.jobname, NOW()
  FROM cron.job j
  WHERE j.active = true
  ON CONFLICT ON CONSTRAINT cron_first_seen_pkey DO NOTHING;

  RETURN QUERY
  SELECT
    j.jobname::TEXT,
    j.schedule::TEXT,
    MAX(d.end_time)                                            AS last_run_at,
    MAX(d.end_time) FILTER (WHERE d.status = 'succeeded')      AS last_success_at,
    (ARRAY_AGG(d.status ORDER BY d.start_time DESC NULLS LAST))[1]::TEXT
                                                               AS last_status,
    EXTRACT(EPOCH FROM (NOW() - MAX(d.end_time)))              AS seconds_since_last_run,
    EXTRACT(EPOCH FROM (NOW() - MAX(d.end_time)
                        FILTER (WHERE d.status = 'succeeded'))) AS seconds_since_last_success,
    COUNT(*) FILTER (WHERE d.start_time > NOW() - INTERVAL '24 hours')
                                                               AS total_runs_last_24h,
    COUNT(*) FILTER (WHERE d.start_time > NOW() - INTERVAL '24 hours'
                       AND d.status <> 'succeeded')            AS failed_runs_last_24h,
    fs.first_seen_at                                           AS first_seen_at
  FROM cron.job j
  LEFT JOIN cron.job_run_details d
    ON d.jobid = j.jobid
   AND d.database = current_database()
  LEFT JOIN public.cron_first_seen fs
    ON fs.jobname = j.jobname
  WHERE j.active = true
  GROUP BY j.jobname, j.schedule, fs.first_seen_at;
END;
$$;

COMMENT ON FUNCTION public.get_cron_health() IS
  'Santé des crons pg_cron actifs. Enregistre les nouveaux crons sans '
  'ambiguïté PL/pgSQL entre le paramètre de sortie jobname et la clé primaire.';

REVOKE ALL     ON FUNCTION public.get_cron_health() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_cron_health() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_cron_health() TO service_role;
