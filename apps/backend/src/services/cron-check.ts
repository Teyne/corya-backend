/**
 * pg_cron surveillance helper.
 *
 * ---------------------------------------------------------------------------
 * What "stale" means for a cron
 * ---------------------------------------------------------------------------
 * Three distinct failure modes must be detectable — contract from
 * database-compliance, mirroring the RPC `get_cron_health()`:
 *   1. `last_run_at IS NULL`        → cron never scheduled / never fired.
 *   2. seconds_since_last_run       → cron dead (pg_cron itself broken).
 *   3. last_success_at old          → cron runs but always fails.
 *
 * The tolerances live in code (not env vars) because they map to the
 * schedules baked into the migrations and vary wildly per cron
 * (from 15 min for `requeue-stuck-jobs` to 32 days for `purge-ancient-appels`).
 * Making them env-configurable would encourage ops to silence a failing
 * check by loosening the tolerance — the opposite of the intent.
 *
 * ---------------------------------------------------------------------------
 * Anomalies of configuration
 * ---------------------------------------------------------------------------
 * Two shapes deserve visibility:
 *   - Cron in DB but no tolerance → `unknown_cron_in_db` reason; safest
 *     default is to REPORT IT AS STALE so a rogue job added out-of-band
 *     surfaces on the health probe. This also handles a new cron shipped
 *     in a migration where somebody forgot to update this file.
 *   - Tolerance defined but cron absent from DB → `missing_cron` reason;
 *     the cron may have been unscheduled by accident.
 *
 * Both are surfaced with a stable `reason` string in the stale list.
 *
 * ---------------------------------------------------------------------------
 * Zero PII
 * ---------------------------------------------------------------------------
 * Cron rows carry only job names + timing stats — no patient data
 * possible. The stale list echoed in /health/deep contains only jobnames
 * and reasons, no timestamps of failing rows to keep the payload compact
 * for external monitoring.
 */
import { getCronHealth, type CronHealthRow } from '../db/queries.js';

/**
 * Tolerance in SECONDS after which a cron is considered stale.
 * Every ACTIVE cron produced by our migrations must have an entry here.
 *
 * Rationale per cron (kept short so a future maintainer sees the intent):
 *   - purge-expired-audio           : runs hourly. 2 h = 1 skipped run tolerated.
 *   - anonymize-old-transcripts     : runs daily at 03:00. 26 h = 2 h grace.
 *   - purge-old-pdfs                : runs daily at 03:30. 26 h = 2 h grace.
 *   - purge-ancient-appels          : monthly, 1st @ 04:00. 32 days = 2 days grace.
 *   - requeue-stuck-jobs            : every 5 min. 15 min = 3 missed ticks.
 *   - requeue-stuck-file-deletions  : every 10 min. 30 min = 3 missed ticks.
 *   - purge-stale-worker-heartbeats : weekly Sun 05:00. 8 days = 1 day grace.
 *   - purge-cron-run-details        : weekly Sun 05:30. 8 days = 1 day grace.
 */
export const CRON_TOLERANCES_SECONDS = {
  'purge-expired-audio': 2 * 3600,
  'anonymize-old-transcripts': 26 * 3600,
  'purge-old-pdfs': 26 * 3600,
  'purge-ancient-appels': 32 * 24 * 3600,
  'requeue-stuck-jobs': 15 * 60,
  'requeue-stuck-file-deletions': 30 * 60,
  'purge-stale-worker-heartbeats': 8 * 24 * 3600,
  'purge-cron-run-details': 8 * 24 * 3600,
} as const;

/** Reason a cron is flagged stale. Kept as a stable string union. */
export type CronStaleReason =
  | 'never_run'
  | 'stale_last_run'
  | 'stale_last_success'
  | 'missing_cron'
  | 'unknown_cron_in_db';

export interface StaleCron {
  jobname: string;
  reason: CronStaleReason;
  /** Tolerance in seconds — omitted for the "unknown cron" case. */
  tolerance_seconds?: number;
  /** How stale the failing signal is (only present when applicable). */
  age_seconds?: number;
}

export interface CronCheckReport {
  jobs_checked: number;
  stale: StaleCron[];
}

/**
 * Evaluate a single row against its expected tolerance. Returns null when
 * healthy, a StaleCron with a reason otherwise.
 */
function evaluateRow(row: CronHealthRow, toleranceSec: number): StaleCron | null {
  // 1. Never run — worst case.
  if (row.last_run_at === null || row.seconds_since_last_run === null) {
    return { jobname: row.jobname, reason: 'never_run', tolerance_seconds: toleranceSec };
  }
  // 2. Dead — last_run_at too old.
  if (row.seconds_since_last_run > toleranceSec) {
    return {
      jobname: row.jobname,
      reason: 'stale_last_run',
      tolerance_seconds: toleranceSec,
      age_seconds: Math.round(row.seconds_since_last_run),
    };
  }
  // 3. Runs but never succeeds — last_success_at stale.
  //    Either never succeeded (null) or older than tolerance.
  if (
    row.last_success_at === null ||
    row.seconds_since_last_success === null ||
    row.seconds_since_last_success > toleranceSec
  ) {
    return {
      jobname: row.jobname,
      reason: 'stale_last_success',
      tolerance_seconds: toleranceSec,
      age_seconds:
        row.seconds_since_last_success === null
          ? undefined
          : Math.round(row.seconds_since_last_success),
    };
  }
  return null;
}

/**
 * Compute the cron health report from a snapshot of rows.
 *
 * Pure function — DB access lives in `queries.getCronHealth`. That keeps
 * the check testable with hand-crafted rows and re-usable from BOTH the
 * /health/deep handler AND the periodic alert poller.
 */
export function reportCronHealth(rows: CronHealthRow[]): CronCheckReport {
  const stale: StaleCron[] = [];
  const seenNames = new Set<string>();

  // Compare each DB row against its tolerance entry.
  for (const row of rows) {
    seenNames.add(row.jobname);
    const tolerance = (CRON_TOLERANCES_SECONDS as Record<string, number | undefined>)[row.jobname];
    if (tolerance === undefined) {
      // Cron present in DB but nobody defined a tolerance for it. A new
      // cron shipped in a migration without this file being updated, or
      // an out-of-band manual `cron.schedule(...)`. Loudly report it.
      stale.push({ jobname: row.jobname, reason: 'unknown_cron_in_db' });
      continue;
    }
    const evaluation = evaluateRow(row, tolerance);
    if (evaluation !== null) stale.push(evaluation);
  }

  // Now the inverse: entries in the tolerance table that never appeared
  // in the DB snapshot. Someone unscheduled a cron by mistake.
  for (const jobname of Object.keys(CRON_TOLERANCES_SECONDS)) {
    if (!seenNames.has(jobname)) {
      stale.push({
        jobname,
        reason: 'missing_cron',
        tolerance_seconds:
          (CRON_TOLERANCES_SECONDS as Record<string, number>)[jobname],
      });
    }
  }

  return {
    jobs_checked: seenNames.size,
    stale,
  };
}

/**
 * Convenience wrapper: fetch + evaluate. Used by both consumers.
 */
export async function computeCronHealthReport(): Promise<CronCheckReport> {
  const rows = await getCronHealth();
  return reportCronHealth(rows);
}
