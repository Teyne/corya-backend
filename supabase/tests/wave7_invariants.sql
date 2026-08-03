\set ON_ERROR_STOP on

-- Corya wave 7 database contract tests.
-- Run only against a disposable, strictly local Supabase database after all
-- migrations have been applied. Multi-transaction lease fixtures are cleaned
-- explicitly; all other data mutations are rolled back.
-- All identifiers and values below are synthetic and contain no patient data.
-- Default Supabase-local command (PowerShell, with psql on PATH):
-- psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/wave7_invariants.sql

CREATE OR REPLACE FUNCTION pg_temp.assert_true(
  p_condition BOOLEAN,
  p_message   TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(p_condition, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'wave7 assertion failed: %', p_message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_worker_fencing(
  p_deletion_id      UUID,
  p_worker_id        TEXT,
  p_stale_locked_at  TIMESTAMPTZ,
  p_current_locked_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_result TEXT;
BEGIN
  PERFORM pg_temp.assert_true(
    p_current_locked_at <> p_stale_locked_at,
    'worker reclaim did not rotate locked_at'
  );

  v_result := public.complete_file_deletion(
    p_deletion_id,
    p_worker_id,
    p_stale_locked_at,
    'deleted'
  );
  PERFORM pg_temp.assert_true(v_result IS NULL, 'old worker lease finalized the row');
  RAISE NOTICE 'worker lease reclaimed: first_locked_at=%, second_locked_at=%, stale_completion=%',
    p_stale_locked_at, p_current_locked_at, COALESCE(v_result, '<null>');

  v_result := public.complete_file_deletion(
    p_deletion_id,
    p_worker_id,
    p_current_locked_at,
    'deleted'
  );
  PERFORM pg_temp.assert_true(v_result = 'deleted', 'current worker lease did not finalize');
  RAISE NOTICE 'worker current lease completion=%', v_result;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_alert_reclaim(
  p_deletion_id       UUID,
  p_alerter_id        TEXT,
  p_stale_locked_at   TIMESTAMPTZ,
  p_current_locked_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_stale_mark      BOOLEAN;
  v_stale_release   BOOLEAN;
  v_current_release BOOLEAN;
BEGIN
  PERFORM pg_temp.assert_true(
    p_current_locked_at <> p_stale_locked_at,
    'alert reclaim did not rotate locked_at'
  );

  v_stale_mark := public.mark_file_deletion_dead_letter_alerted(
    p_deletion_id,
    p_alerter_id,
    p_stale_locked_at
  );
  PERFORM pg_temp.assert_true(v_stale_mark IS FALSE, 'old alert lease marked delivered');

  v_stale_release := public.release_file_deletion_dead_letter_alert(
    p_deletion_id,
    p_alerter_id,
    p_stale_locked_at
  );
  PERFORM pg_temp.assert_true(v_stale_release IS FALSE, 'old alert lease released current lease');

  v_current_release := public.release_file_deletion_dead_letter_alert(
    p_deletion_id,
    p_alerter_id,
    p_current_locked_at
  );
  PERFORM pg_temp.assert_true(v_current_release IS TRUE, 'current alert lease was not released');

  RAISE NOTICE 'alert lease reclaimed: first_locked_at=%, second_locked_at=%, stale_mark=%, stale_release=%, current_release=%',
    p_stale_locked_at, p_current_locked_at,
    v_stale_mark, v_stale_release, v_current_release;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_alert_current_mark(
  p_deletion_id UUID,
  p_alerter_id  TEXT,
  p_locked_at   TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  v_ok := public.mark_file_deletion_dead_letter_alerted(
    p_deletion_id,
    p_alerter_id,
    p_locked_at
  );
  PERFORM pg_temp.assert_true(v_ok IS TRUE, 'current alert lease was not marked delivered');
  RAISE NOTICE 'alert current lease mark: locked_at=%, marked=%', p_locked_at, v_ok;
END;
$$;

-- Remove only fixed synthetic fixtures left by a previously interrupted run.
BEGIN;

DELETE FROM public.file_deletions_outbox
WHERE id IN (
  '72000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000002',
  '72000000-0000-0000-0000-000000000003',
  '72000000-0000-0000-0000-000000000010',
  '72000000-0000-0000-0000-000000000011',
  '72000000-0000-0000-0000-000000000012',
  '72000000-0000-0000-0000-000000000013'
)
  AND reason = 'manual_admin_deletion'
  AND enqueued_by = 'sql_wave7_test';

DELETE FROM public.appels
WHERE id = '71000000-0000-0000-0000-000000000001'
  AND cabinet_id = '70000000-0000-0000-0000-000000000001'
  AND retell_call_id = 'sql-wave7-synthetic-call';

DELETE FROM public.cabinets c
WHERE c.id = '70000000-0000-0000-0000-000000000001'
  AND c.slug = 'sql-wave7-synthetic-cabinet'
  AND NOT EXISTS (
    SELECT 1 FROM public.appels a WHERE a.cabinet_id = c.id
  );

INSERT INTO public.cabinets (
  id,
  nom,
  slug,
  email_notification
)
VALUES (
  '70000000-0000-0000-0000-000000000001',
  'sql-wave7-synthetic-cabinet',
  'sql-wave7-synthetic-cabinet',
  'sql-wave7@example.invalid'
);

INSERT INTO public.appels (
  id,
  cabinet_id,
  retell_call_id,
  date_appel
)
VALUES (
  '71000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  'sql-wave7-synthetic-call',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
);

-- ---------------------------------------------------------------------------
-- Worker lease fencing: the worker id is deliberately reused. Only the exact
-- (worker_id, locked_at) pair returned by the latest claim may finalize.
-- ---------------------------------------------------------------------------
INSERT INTO public.file_deletions_outbox (
  id, target, bucket, object_path, reason, status,
  attempts, max_attempts, run_after, enqueued_by
)
VALUES (
  '72000000-0000-0000-0000-000000000001',
  'supabase_storage',
  'pdf-recaps',
  '70000000-0000-0000-0000-000000000001/2000-01/71000000-0000-0000-0000-000000000001.pdf',
  'manual_admin_deletion',
  'pending',
  0,
  3,
  TIMESTAMPTZ '2000-01-01 00:00:00+00',
  'sql_wave7_test'
);

INSERT INTO public.file_deletions_outbox (
  id, target, bucket, object_path, reason, status,
  attempts, max_attempts, run_after, enqueued_by
)
VALUES (
  '72000000-0000-0000-0000-000000000003',
  'supabase_storage',
  'pdf-recaps',
  '70000000-0000-0000-0000-000000000001/2000-03/71000000-0000-0000-0000-000000000003.pdf',
  'manual_admin_deletion',
  'dead_letter',
  2,
  2,
  TIMESTAMPTZ '2000-03-01 00:00:00+00',
  'sql_wave7_test'
);

COMMIT;

-- ---------------------------------------------------------------------------
-- Worker lease fencing across real transactions. The first token is captured
-- verbatim by psql and is never rewritten before stale finalization is tried.
-- ---------------------------------------------------------------------------
BEGIN;

SELECT
  COUNT(*)::INTEGER AS worker_claim_a_count,
  MAX(claimed.locked_at)::TEXT AS worker_locked_at_a
FROM public.claim_file_deletions('sql-wave7-stable-worker', 100, 1) claimed
WHERE claimed.id = '72000000-0000-0000-0000-000000000001'
\gset

SELECT pg_temp.assert_true(:worker_claim_a_count::INTEGER = 1, 'worker A claim missing');

COMMIT;

SELECT pg_sleep(1.1);

BEGIN;

SELECT
  COUNT(*)::INTEGER AS worker_claim_b_count,
  MAX(claimed.locked_at)::TEXT AS worker_locked_at_b
FROM public.claim_file_deletions('sql-wave7-stable-worker', 100, 1) claimed
WHERE claimed.id = '72000000-0000-0000-0000-000000000001'
\gset

SELECT pg_temp.assert_true(:worker_claim_b_count::INTEGER = 1, 'worker B reclaim missing');

SELECT pg_temp.assert_worker_fencing(
  '72000000-0000-0000-0000-000000000001',
  'sql-wave7-stable-worker',
  :'worker_locked_at_a'::TIMESTAMPTZ,
  :'worker_locked_at_b'::TIMESTAMPTZ
);

COMMIT;

-- ---------------------------------------------------------------------------
-- Alert lease fencing across real transactions. Stale mark and release are
-- both rejected; the current release and a subsequent current mark succeed.
-- ---------------------------------------------------------------------------
BEGIN;

SELECT
  COUNT(*)::INTEGER AS alert_claim_a_count,
  MAX(claimed.dead_letter_alert_locked_at)::TEXT AS alert_locked_at_a
FROM public.claim_file_deletion_dead_letter_alerts(
  'sql-wave7-stable-alerter', 100, 1
) claimed
WHERE claimed.id = '72000000-0000-0000-0000-000000000003'
\gset

SELECT pg_temp.assert_true(:alert_claim_a_count::INTEGER = 1, 'alert claim A missing');

COMMIT;

SELECT pg_sleep(1.1);

BEGIN;

SELECT
  COUNT(*)::INTEGER AS alert_claim_b_count,
  MAX(claimed.dead_letter_alert_locked_at)::TEXT AS alert_locked_at_b
FROM public.claim_file_deletion_dead_letter_alerts(
  'sql-wave7-stable-alerter', 100, 1
) claimed
WHERE claimed.id = '72000000-0000-0000-0000-000000000003'
\gset

SELECT pg_temp.assert_true(:alert_claim_b_count::INTEGER = 1, 'alert reclaim B missing');

SELECT pg_temp.assert_alert_reclaim(
  '72000000-0000-0000-0000-000000000003',
  'sql-wave7-stable-alerter',
  :'alert_locked_at_a'::TIMESTAMPTZ,
  :'alert_locked_at_b'::TIMESTAMPTZ
);

COMMIT;

BEGIN;

SELECT
  COUNT(*)::INTEGER AS alert_claim_c_count,
  MAX(claimed.dead_letter_alert_locked_at)::TEXT AS alert_locked_at_c
FROM public.claim_file_deletion_dead_letter_alerts(
  'sql-wave7-stable-alerter', 100, 300
) claimed
WHERE claimed.id = '72000000-0000-0000-0000-000000000003'
\gset

SELECT pg_temp.assert_true(:alert_claim_c_count::INTEGER = 1, 'released alert was not reclaimed');

SELECT pg_temp.assert_alert_current_mark(
  '72000000-0000-0000-0000-000000000003',
  'sql-wave7-stable-alerter',
  :'alert_locked_at_c'::TIMESTAMPTZ
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM public.claim_file_deletion_dead_letter_alerts(
      'sql-wave7-other-alerter', 100, 300
    ) claimed
    WHERE claimed.id = '72000000-0000-0000-0000-000000000003'
  ),
  'delivered alert was claimed again'
);

COMMIT;

-- Remaining invariants are isolated and rolled back as a unit.
BEGIN;

-- ---------------------------------------------------------------------------
-- Retry budget: attempts increments at claim, first failure retries, second
-- failure reaches dead_letter, and the exhausted row is no longer claimable.
-- ---------------------------------------------------------------------------
INSERT INTO public.file_deletions_outbox (
  id, target, bucket, object_path, reason, status,
  attempts, max_attempts, run_after, enqueued_by
)
VALUES (
  '72000000-0000-0000-0000-000000000002',
  'supabase_storage',
  'pdf-recaps',
  '70000000-0000-0000-0000-000000000001/2000-02/71000000-0000-0000-0000-000000000002.pdf',
  'manual_admin_deletion',
  'pending',
  0,
  2,
  TIMESTAMPTZ '2000-02-01 00:00:00+00',
  'sql_wave7_test'
);

DO $$
DECLARE
  v_deletion_id CONSTANT UUID := '72000000-0000-0000-0000-000000000002';
  v_locked_at   TIMESTAMPTZ;
  v_result      TEXT;
  v_claim_count INTEGER;
BEGIN
  SELECT claimed.locked_at
  INTO v_locked_at
  FROM public.claim_file_deletions('sql-wave7-retry-a', 100, 300) claimed
  WHERE claimed.id = v_deletion_id;

  v_result := public.fail_file_deletion(
    v_deletion_id,
    'sql-wave7-retry-a',
    v_locked_at,
    'synthetic_transient_error',
    0
  );
  PERFORM pg_temp.assert_true(v_result = 'pending', 'first failure did not retry');

  SELECT claimed.locked_at
  INTO v_locked_at
  FROM public.claim_file_deletions('sql-wave7-retry-b', 100, 300) claimed
  WHERE claimed.id = v_deletion_id;

  v_result := public.fail_file_deletion(
    v_deletion_id,
    'sql-wave7-retry-b',
    v_locked_at,
    'synthetic_terminal_error',
    0
  );
  PERFORM pg_temp.assert_true(v_result = 'dead_letter', 'retry budget was not bounded');

  SELECT COUNT(*)::INTEGER
  INTO v_claim_count
  FROM public.claim_file_deletions('sql-wave7-retry-c', 100, 300) claimed
  WHERE claimed.id = v_deletion_id;

  PERFORM pg_temp.assert_true(v_claim_count = 0, 'dead_letter row was reclaimed');
END;
$$;

-- ---------------------------------------------------------------------------
-- Batched terminal purge. Three source-less successful proofs are eligible,
-- one source-linked proof remains while its appel exists, and dead_letter is
-- retained regardless of its alert status.
-- ---------------------------------------------------------------------------
INSERT INTO public.file_deletions_outbox (
  id, target, bucket, object_path, reason, status,
  attempts, max_attempts, run_after, enqueued_by, deleted_at
)
VALUES
  (
    '72000000-0000-0000-0000-000000000010',
    'supabase_storage', 'pdf-recaps', 'synthetic/terminal-10.pdf',
    'manual_admin_deletion', 'deleted', 1, 2, NOW(), 'sql_wave7_test',
    TIMESTAMPTZ '2000-01-10 00:00:00+00'
  ),
  (
    '72000000-0000-0000-0000-000000000011',
    'supabase_storage', 'pdf-recaps', 'synthetic/terminal-11.pdf',
    'manual_admin_deletion', 'not_found', 1, 2, NOW(), 'sql_wave7_test',
    TIMESTAMPTZ '2000-01-11 00:00:00+00'
  ),
  (
    '72000000-0000-0000-0000-000000000012',
    'supabase_storage', 'pdf-recaps', 'synthetic/terminal-12.pdf',
    'manual_admin_deletion', 'deleted', 1, 2, NOW(), 'sql_wave7_test',
    TIMESTAMPTZ '2000-01-12 00:00:00+00'
  );

INSERT INTO public.file_deletions_outbox (
  id, target, bucket, object_path, reason, status,
  attempts, max_attempts, run_after, enqueued_by,
  source_appel_id, source_cabinet_id, deleted_at
)
VALUES (
  '72000000-0000-0000-0000-000000000013',
  'supabase_storage', 'pdf-recaps', 'synthetic/terminal-linked.pdf',
  'manual_admin_deletion', 'deleted', 1, 2, NOW(), 'sql_wave7_test',
  '71000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  TIMESTAMPTZ '2000-01-13 00:00:00+00'
);

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  v_count := public.purge_terminal_file_deletions(INTERVAL '24 months', 2);
  PERFORM pg_temp.assert_true(v_count = 2, 'first purge batch was not capped at 2');

  SELECT COUNT(*)::INTEGER INTO v_count
  FROM public.file_deletions_outbox
  WHERE id IN (
    '72000000-0000-0000-0000-000000000010',
    '72000000-0000-0000-0000-000000000011',
    '72000000-0000-0000-0000-000000000012'
  );
  PERFORM pg_temp.assert_true(v_count = 1, 'first purge batch removed wrong count');

  v_count := public.purge_terminal_file_deletions(INTERVAL '24 months', 2);
  PERFORM pg_temp.assert_true(v_count = 1, 'second purge batch did not remove remainder');

  PERFORM pg_temp.assert_true(
    EXISTS (
      SELECT 1 FROM public.file_deletions_outbox
      WHERE id = '72000000-0000-0000-0000-000000000013'
    ),
    'source-linked proof was purged while appel existed'
  );

  PERFORM pg_temp.assert_true(
    EXISTS (
      SELECT 1 FROM public.file_deletions_outbox
      WHERE id = '72000000-0000-0000-0000-000000000002'
        AND status = 'dead_letter'
    ),
    'dead_letter was purged'
  );

  DELETE FROM public.appels
  WHERE id = '71000000-0000-0000-0000-000000000001'
    AND cabinet_id = '70000000-0000-0000-0000-000000000001'
    AND retell_call_id = 'sql-wave7-synthetic-call';

  v_count := public.purge_terminal_file_deletions(INTERVAL '24 months', 2);
  PERFORM pg_temp.assert_true(v_count = 1, 'orphaned source-linked proof was not purged');
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS and function ACLs through PostgreSQL catalogues.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_table_name TEXT;
  v_proc       REGPROCEDURE;
  v_policy_count INTEGER;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'file_deletions_outbox',
    'worker_heartbeats',
    'cron_first_seen'
  ] LOOP
    PERFORM pg_temp.assert_true(
      COALESCE((
        SELECT c.relrowsecurity
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = v_table_name
      ), false),
      format('RLS disabled on %s', v_table_name)
    );

    SELECT COUNT(*)::INTEGER
    INTO v_policy_count
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = v_table_name;

    PERFORM pg_temp.assert_true(
      v_policy_count = 0,
      format('unexpected RLS policy on %s', v_table_name)
    );
  END LOOP;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.claim_file_deletions(text,integer,integer)'::REGPROCEDURE,
    'public.complete_file_deletion(uuid,text,timestamp with time zone,text)'::REGPROCEDURE,
    'public.fail_file_deletion(uuid,text,timestamp with time zone,text,integer)'::REGPROCEDURE,
    'public.claim_file_deletion_dead_letter_alerts(text,integer,integer)'::REGPROCEDURE,
    'public.mark_file_deletion_dead_letter_alerted(uuid,text,timestamp with time zone)'::REGPROCEDURE,
    'public.release_file_deletion_dead_letter_alert(uuid,text,timestamp with time zone)'::REGPROCEDURE,
    'public.purge_terminal_file_deletions(interval,integer)'::REGPROCEDURE,
    'public.purge_ancient_logs_actions()'::REGPROCEDURE,
    'public.get_wave7_contract_version()'::REGPROCEDURE
  ] LOOP
    PERFORM pg_temp.assert_true(
      NOT pg_catalog.has_function_privilege('anon', v_proc::OID, 'EXECUTE'),
      format('anon can execute %s', v_proc::TEXT)
    );
    PERFORM pg_temp.assert_true(
      NOT pg_catalog.has_function_privilege('authenticated', v_proc::OID, 'EXECUTE'),
      format('authenticated can execute %s', v_proc::TEXT)
    );
    PERFORM pg_temp.assert_true(
      pg_catalog.has_function_privilege('service_role', v_proc::OID, 'EXECUTE'),
      format('service_role cannot execute %s', v_proc::TEXT)
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Ordered wave marker and exact active-cron inventory.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM pg_temp.assert_true(
    public.get_wave7_contract_version() = 7,
    'wave 7 contract marker missing or wrong'
  );

  SELECT COUNT(*)::INTEGER
  INTO v_count
  FROM cron.job
  WHERE active = true;
  PERFORM pg_temp.assert_true(v_count = 10, 'active cron count is not 10');

  WITH expected(jobname) AS (
    VALUES
      ('purge-expired-audio'::TEXT),
      ('anonymize-old-transcripts'::TEXT),
      ('purge-old-pdfs'::TEXT),
      ('purge-ancient-appels'::TEXT),
      ('requeue-stuck-jobs'::TEXT),
      ('requeue-stuck-file-deletions'::TEXT),
      ('purge-stale-worker-heartbeats'::TEXT),
      ('purge-cron-run-details'::TEXT),
      ('purge-terminal-file-deletions'::TEXT),
      ('purge-ancient-logs-actions'::TEXT)
  )
  SELECT COUNT(*)::INTEGER
  INTO v_count
  FROM (
    (SELECT jobname FROM expected
     EXCEPT
     SELECT jobname::TEXT FROM cron.job WHERE active = true)
    UNION ALL
    (SELECT jobname::TEXT FROM cron.job WHERE active = true
     EXCEPT
     SELECT jobname FROM expected)
  ) differences;

  PERFORM pg_temp.assert_true(v_count = 0, 'active cron names differ from wave 7 contract');
END;
$$;

ROLLBACK;

-- Explicit cleanup for the committed multi-transaction lease fixtures.
BEGIN;

DELETE FROM public.file_deletions_outbox
WHERE id IN (
  '72000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000002',
  '72000000-0000-0000-0000-000000000003',
  '72000000-0000-0000-0000-000000000010',
  '72000000-0000-0000-0000-000000000011',
  '72000000-0000-0000-0000-000000000012',
  '72000000-0000-0000-0000-000000000013'
)
  AND reason = 'manual_admin_deletion'
  AND enqueued_by = 'sql_wave7_test';

DELETE FROM public.appels
WHERE id = '71000000-0000-0000-0000-000000000001'
  AND cabinet_id = '70000000-0000-0000-0000-000000000001'
  AND retell_call_id = 'sql-wave7-synthetic-call';

DELETE FROM public.cabinets c
WHERE c.id = '70000000-0000-0000-0000-000000000001'
  AND c.slug = 'sql-wave7-synthetic-cabinet'
  AND NOT EXISTS (
    SELECT 1 FROM public.appels a WHERE a.cabinet_id = c.id
  );

COMMIT;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM public.file_deletions_outbox
    WHERE id IN (
      '72000000-0000-0000-0000-000000000001',
      '72000000-0000-0000-0000-000000000002',
      '72000000-0000-0000-0000-000000000003',
      '72000000-0000-0000-0000-000000000010',
      '72000000-0000-0000-0000-000000000011',
      '72000000-0000-0000-0000-000000000012',
      '72000000-0000-0000-0000-000000000013'
    )
  ),
  'outbox fixtures remained after cleanup'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.appels
    WHERE id = '71000000-0000-0000-0000-000000000001'
  ),
  'appel fixture remained after cleanup'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.cabinets
    WHERE id = '70000000-0000-0000-0000-000000000001'
  ),
  'cabinet fixture remained after cleanup'
);

SELECT
  (SELECT COUNT(*) FROM public.file_deletions_outbox WHERE id IN (
    '72000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000002',
    '72000000-0000-0000-0000-000000000003',
    '72000000-0000-0000-0000-000000000010',
    '72000000-0000-0000-0000-000000000011',
    '72000000-0000-0000-0000-000000000012',
    '72000000-0000-0000-0000-000000000013'
  )) AS remaining_outbox_fixtures,
  (SELECT COUNT(*) FROM public.appels
   WHERE id = '71000000-0000-0000-0000-000000000001') AS remaining_appel_fixtures,
  (SELECT COUNT(*) FROM public.cabinets
   WHERE id = '70000000-0000-0000-0000-000000000001') AS remaining_cabinet_fixtures;
