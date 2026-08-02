/**
 * Unit tests — services/cron-check.ts (session 4 vague 4).
 *
 * Pure function under test — no DB access, hand-crafted rows.
 *
 * We prove:
 *   - all healthy → no stale entries
 *   - `last_run_at IS NULL` → reason `never_run`
 *   - `seconds_since_last_run > tolerance` → reason `stale_last_run`
 *   - runs fresh but `seconds_since_last_success` too old → reason `stale_last_success`
 *   - a cron in DB not in the tolerance map → reason `unknown_cron_in_db`
 *   - a cron in the tolerance map absent from DB → reason `missing_cron`
 *   - jobs_checked reflects the number of DISTINCT rows in DB
 */
import { describe, expect, it } from 'vitest';
import {
  CRON_TOLERANCES_SECONDS,
  reportCronHealth,
} from '../../src/services/cron-check.js';
import type { CronHealthRow } from '../../src/db/queries.js';

const KNOWN_NAMES = Object.keys(CRON_TOLERANCES_SECONDS) as Array<
  keyof typeof CRON_TOLERANCES_SECONDS
>;

function healthy(jobname: string, ageSec = 5): CronHealthRow {
  return {
    jobname,
    schedule: '* * * * *',
    last_run_at: new Date(Date.now() - ageSec * 1_000).toISOString(),
    last_success_at: new Date(Date.now() - ageSec * 1_000).toISOString(),
    last_status: 'succeeded',
    seconds_since_last_run: ageSec,
    seconds_since_last_success: ageSec,
    total_runs_last_24h: 100,
    failed_runs_last_24h: 0,
    first_seen_at: null,
  };
}

describe('reportCronHealth', () => {
  it('returns zero stale entries when every supervised cron is healthy', () => {
    const rows = KNOWN_NAMES.map((n) => healthy(n));
    const report = reportCronHealth(rows);
    expect(report.jobs_checked).toBe(KNOWN_NAMES.length);
    expect(report.stale).toEqual([]);
  });

  it('flags never_run when last_run_at is null', () => {
    const [first, ...rest] = KNOWN_NAMES;
    if (first === undefined) throw new Error('table empty');
    const broken: CronHealthRow = {
      ...healthy(first),
      last_run_at: null,
      last_success_at: null,
      seconds_since_last_run: null,
      seconds_since_last_success: null,
    };
    const report = reportCronHealth([broken, ...rest.map((n) => healthy(n))]);
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]).toMatchObject({ jobname: first, reason: 'never_run' });
  });

  it('keeps a newly registered cron neutral until its first period elapses', () => {
    const [first, ...rest] = KNOWN_NAMES;
    if (first === undefined) throw new Error('table empty');
    const fresh = {
      ...healthy(first),
      last_run_at: null,
      last_success_at: null,
      seconds_since_last_run: null,
      seconds_since_last_success: null,
      first_seen_at: new Date().toISOString(),
    };
    const report = reportCronHealth([fresh, ...rest.map((n) => healthy(n))]);
    expect(report.stale).toEqual([]);
    expect(report.pending_first_run).toEqual([first]);
  });

  it('flags stale_last_run when seconds_since_last_run exceeds the tolerance', () => {
    const tolerance = CRON_TOLERANCES_SECONDS['requeue-stuck-jobs']; // 15 min
    const broken: CronHealthRow = {
      ...healthy('requeue-stuck-jobs'),
      seconds_since_last_run: tolerance + 1,
    };
    const others = KNOWN_NAMES.filter((n) => n !== 'requeue-stuck-jobs').map((n) => healthy(n));
    const report = reportCronHealth([broken, ...others]);
    const entry = report.stale.find((s) => s.jobname === 'requeue-stuck-jobs');
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe('stale_last_run');
    expect(entry?.tolerance_seconds).toBe(tolerance);
    expect(entry?.age_seconds).toBe(tolerance + 1);
  });

  it('flags stale_last_success when the cron runs but hasnt succeeded recently', () => {
    const tolerance = CRON_TOLERANCES_SECONDS['purge-expired-audio']; // 2 h
    const broken: CronHealthRow = {
      ...healthy('purge-expired-audio', 30),
      // last_run_at fresh (30 s ago), last_success_at old.
      last_success_at: new Date(Date.now() - (tolerance + 100) * 1_000).toISOString(),
      seconds_since_last_success: tolerance + 100,
    };
    const others = KNOWN_NAMES.filter((n) => n !== 'purge-expired-audio').map((n) => healthy(n));
    const report = reportCronHealth([broken, ...others]);
    const entry = report.stale.find((s) => s.jobname === 'purge-expired-audio');
    expect(entry?.reason).toBe('stale_last_success');
    expect(entry?.age_seconds).toBe(tolerance + 100);
  });

  it('flags unknown_cron_in_db when a row has no tolerance entry', () => {
    const rows: CronHealthRow[] = [
      ...KNOWN_NAMES.map((n) => healthy(n)),
      healthy('rogue-cron-added-by-someone'),
    ];
    const report = reportCronHealth(rows);
    const rogue = report.stale.find((s) => s.jobname === 'rogue-cron-added-by-someone');
    expect(rogue?.reason).toBe('unknown_cron_in_db');
    expect(rogue?.tolerance_seconds).toBeUndefined();
  });

  it('flags missing_cron when a tolerance entry has no DB row', () => {
    // Drop one of the supervised crons from the DB snapshot.
    const rows = KNOWN_NAMES.filter((n) => n !== 'purge-expired-audio').map((n) => healthy(n));
    const report = reportCronHealth(rows);
    const missing = report.stale.find((s) => s.jobname === 'purge-expired-audio');
    expect(missing?.reason).toBe('missing_cron');
    expect(missing?.tolerance_seconds).toBe(
      CRON_TOLERANCES_SECONDS['purge-expired-audio'],
    );
  });

  it('jobs_checked reflects the DISTINCT count of DB rows', () => {
    const rows = KNOWN_NAMES.slice(0, 3).map((n) => healthy(n));
    const report = reportCronHealth(rows);
    expect(report.jobs_checked).toBe(3);
  });
});
