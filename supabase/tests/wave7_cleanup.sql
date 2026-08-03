\set ON_ERROR_STOP on

-- Cleanup is intentionally limited to the fixed synthetic Wave 7 fixtures.
-- UUIDs alone are insufficient authorization to delete: every target must
-- also match its non-patient fixture sentinels.
BEGIN;

WITH fixture_ids(id) AS (
  VALUES
    ('72000000-0000-0000-0000-000000000001'::UUID),
    ('72000000-0000-0000-0000-000000000002'::UUID),
    ('72000000-0000-0000-0000-000000000003'::UUID),
    ('72000000-0000-0000-0000-000000000010'::UUID),
    ('72000000-0000-0000-0000-000000000011'::UUID),
    ('72000000-0000-0000-0000-000000000012'::UUID),
    ('72000000-0000-0000-0000-000000000013'::UUID)
)
DELETE FROM public.file_deletions_outbox f
USING fixture_ids x
WHERE f.id = x.id
  AND f.reason = 'manual_admin_deletion'
  AND f.enqueued_by = 'sql_wave7_test';

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

DO $$
DECLARE
  v_outbox_count INTEGER;
  v_appel_count  INTEGER;
  v_cabinet_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER
  INTO v_outbox_count
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
    AND reason = 'manual_admin_deletion'
    AND enqueued_by = 'sql_wave7_test';

  SELECT COUNT(*)::INTEGER
  INTO v_appel_count
  FROM public.appels
  WHERE id = '71000000-0000-0000-0000-000000000001'
    AND cabinet_id = '70000000-0000-0000-0000-000000000001'
    AND retell_call_id = 'sql-wave7-synthetic-call';

  SELECT COUNT(*)::INTEGER
  INTO v_cabinet_count
  FROM public.cabinets
  WHERE id = '70000000-0000-0000-0000-000000000001'
    AND slug = 'sql-wave7-synthetic-cabinet';

  IF v_outbox_count <> 0 OR v_appel_count <> 0 OR v_cabinet_count <> 0 THEN
    RAISE EXCEPTION
      'wave7 cleanup incomplete: outbox=%, appels=%, cabinets=%',
      v_outbox_count, v_appel_count, v_cabinet_count;
  END IF;

  RAISE NOTICE 'wave7 cleanup verified: outbox=%, appels=%, cabinets=%',
    v_outbox_count, v_appel_count, v_cabinet_count;
END;
$$;
