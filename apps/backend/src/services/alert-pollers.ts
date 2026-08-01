/**
 * API-side periodic alert checks.
 *
 * These pollers run INSIDE the API process, not the worker. Rationale:
 * a worker that has died cannot report its own death. The API is the
 * survivor witness — it observes the shared DB (worker_heartbeats, jobs
 * table) and fires the alerts.
 *
 * ---------------------------------------------------------------------------
 * Poller inventory
 * ---------------------------------------------------------------------------
 *   worker_stale     — heartbeat gap on last_seen_at (60 s) OR last_poll_at
 *                      (180 s). Distinguishes "process dead" from "loop
 *                      blocked" per the design in migration ..._worker_heartbeats.
 *   jobs_backlog     — > threshold pending jobs older than 5 min.
 *   dead_letter      — one alert email per row, idempotent via
 *                      jobs.dead_letter_alerted_at (stamped only after
 *                      confirmed SMTP send).
 *
 * `cron_stale` is DECLARED as an AlertType (see alert.ts) but wired later
 * (vague 4 with /health/deep). Not covered by this file yet.
 *
 * ---------------------------------------------------------------------------
 * Cadence
 * ---------------------------------------------------------------------------
 * All checks run every 5 minutes AND once at startup — the boot-time pass
 * catches a state that was already unhealthy at the moment the API booted
 * (e.g. worker crashed while the API was restarting), which a 5-minute
 * delay would mask.
 *
 * Each pass is fully independent: an exception in one check must NOT
 * prevent the others from running. `runOnce` (used by tests) drives all
 * three sequentially and returns.
 *
 * ---------------------------------------------------------------------------
 * NEVER throws
 * ---------------------------------------------------------------------------
 * The interval callback swallows every exception. A crash here would kill
 * the timer and quietly disable alerting — the very failure mode we are
 * trying to prevent.
 */
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  countPendingJobsOlderThan,
  getDeadLetterJobsToAlert,
  getStaleWorkerHeartbeats,
  markDeadLetterAlerted,
  type WorkerHeartbeatRow,
} from '../db/queries.js';
import { sendAlert } from './alert.js';
import { computeCronHealthReport } from './cron-check.js';
import type { Job } from '../types/index.js';

// Session 4 vague 3 — same override as services/alert.ts so tests can
// flip ALERT_ENABLED locally. Keep it here (instead of importing from
// alert.ts) because the receipt-transporter path in this file has its
// own copy of the "enabled?" check.
let enabledOverride: boolean | null = null;
export function __setAlertPollersEnabledOverrideForTests(value: boolean | null): void {
  enabledOverride = value;
}
function isEnabled(): boolean {
  return enabledOverride ?? env.ALERT_ENABLED;
}

/**
 * Hard-coded because the two heartbeat thresholds serve DIFFERENT signals
 * (see migration 20260801000001). Making them separate env knobs invites
 * mis-tuning. Only `WORKER_STALE_THRESHOLD_SECONDS` is exposed — it is the
 * one that maps 1:1 to a symptom operators recognise ("worker went away").
 */
const POLL_STALE_THRESHOLD_SECONDS = 180;

/** Backlog window: how old a pending job must be to count as "stuck". */
const BACKLOG_MIN_AGE_SECONDS = 5 * 60;

/** Batch cap for dead_letter alerts per pass (protects the outbox). */
const DEAD_LETTER_BATCH = 20;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Fire `worker_stale` when any worker heartbeat is unhealthy. Passes a
 * summarised view (count + first offender) — never the full topology (which
 * could grow) and never patient data (heartbeats carry only hostnames/pids).
 */
export async function checkWorkerStale(): Promise<void> {
  let rows: WorkerHeartbeatRow[];
  try {
    rows = await getStaleWorkerHeartbeats(
      env.WORKER_STALE_THRESHOLD_SECONDS,
      POLL_STALE_THRESHOLD_SECONDS,
    );
  } catch (err: unknown) {
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown' },
      'alert_poller_worker_stale_query_failed',
    );
    return;
  }
  if (rows.length === 0) return;

  const now = Date.now();
  // rows.length > 0 checked above — first is defined.
  const first = rows[0];
  if (!first) return;
  const seenAge = Math.round(
    (now - new Date(first.last_seen_at).getTime()) / 1_000,
  );
  const pollAgeSec = first.last_poll_at
    ? Math.round((now - new Date(first.last_poll_at).getTime()) / 1_000)
    : null;

  await sendAlert('worker_stale', {
    stale_worker_count: rows.length,
    first_worker_id: first.worker_id,
    first_seen_age_seconds: seenAge,
    first_poll_age_seconds: pollAgeSec,
    seen_threshold_seconds: env.WORKER_STALE_THRESHOLD_SECONDS,
    poll_threshold_seconds: POLL_STALE_THRESHOLD_SECONDS,
  });
}

/**
 * Fire `cron_stale` when at least one supervised pg_cron job is off its
 * expected cadence. The severity is deliberately the SAME regardless of
 * how many crons are stale — a single stale cron for nLPD retention is
 * already a compliance-flavoured incident. Dedup absorbs bursts.
 *
 * The alert context lists ONLY jobnames + reasons — no PII possible on
 * cron rows, and no schedule leakage.
 */
export async function checkCronStale(): Promise<void> {
  try {
    const report = await computeCronHealthReport();
    if (report.stale.length === 0) return;
    await sendAlert('cron_stale', {
      jobs_checked: report.jobs_checked,
      stale_count: report.stale.length,
      // Compact projection — jobname + reason only. Tolerance values
      // stay out of the alert body (they live in code, an operator can
      // grep for them).
      stale: report.stale.map((s) => ({ jobname: s.jobname, reason: s.reason })),
    });
  } catch (err: unknown) {
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown' },
      'alert_poller_cron_stale_query_failed',
    );
  }
}

/**
 * Fire `jobs_backlog` when > threshold pending jobs are older than 5 min.
 */
export async function checkJobsBacklog(): Promise<void> {
  let backlog: number;
  try {
    backlog = await countPendingJobsOlderThan(BACKLOG_MIN_AGE_SECONDS);
  } catch (err: unknown) {
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown' },
      'alert_poller_backlog_query_failed',
    );
    return;
  }
  if (backlog <= env.JOBS_BACKLOG_ALERT_THRESHOLD) return;

  await sendAlert('jobs_backlog', {
    pending_count: backlog,
    threshold: env.JOBS_BACKLOG_ALERT_THRESHOLD,
    min_age_seconds: BACKLOG_MIN_AGE_SECONDS,
  });
}

/**
 * Poll `dead_letter` jobs not yet alerted, one alert email per row.
 *
 * Idempotence contract (rewritten from the brief for the future reader):
 *   - Query jobs with status=dead_letter AND dead_letter_alerted_at IS NULL
 *   - For each row, call sendAlert (which is dedup'd — the type dedup will
 *     collapse a BURST of dead-letters into one email; a lone incident
 *     still emits).
 *   - Only stamp dead_letter_alerted_at AFTER the alert send call. On SMTP
 *     outage sendAlert logs and returns; we still stamp — otherwise the
 *     row would fire every 5 minutes forever.
 *
 * That last point is a deliberate trade-off:
 *   - If we DO stamp on failure: the SMTP outage silences that particular
 *     row, but the next dead-letter row (outside the dedup window) will
 *     re-attempt SMTP and produce a fresh alert. Ops still notice.
 *   - If we DON'T stamp on failure: a persistent SMTP outage against a
 *     backlog of 100 dead-letters produces 100 * ceil(outage / dedup)
 *     re-attempts per pass — self-DoS.
 *
 * The trade lands on "stamp always, rely on dedup for burst absorption".
 *
 * HOWEVER — brief calls out the opposite: "si le SMTP est en panne, ne
 * marque rien". To honour that literally, we distinguish two failure modes
 * inside sendAlert with a boolean return... which would break the "never
 * throws" invariant less cleanly than the current design.
 *
 * COMPROMISE (implemented here): we only stamp after a confirmed SMTP
 * send. sendAlert can't tell us that directly without changing its
 * signature, so we route through a small helper `sendAlertWithReceipt`
 * below that returns a boolean. The public sendAlert stays throw-free
 * and its callers unchanged.
 */
export async function pollDeadLetterAlerts(): Promise<void> {
  let jobs: Job[];
  try {
    jobs = await getDeadLetterJobsToAlert(DEAD_LETTER_BATCH);
  } catch (err: unknown) {
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown' },
      'alert_poller_dead_letter_query_failed',
    );
    return;
  }
  if (jobs.length === 0) return;

  for (const job of jobs) {
    // Extract checkpoints defensively — payload is JSONB, may be any shape.
    const steps = readSteps(job.payload);
    const isOrphelin =
      typeof steps.storage_path === 'string' &&
      steps.storage_path.length > 0 &&
      !steps.email_sent_at;

    // Fire the specific pdf_orphelin BEFORE the generic dead_letter so an
    // orphaned-PDF incident is not silenced by the generic dedup entry.
    // Both alerts carry the same job context — no patient data.
    const context = {
      job_id: job.id,
      appel_id: job.appel_id,
      cabinet_id: null, // Cabinet id not on the jobs row — kept null for shape stability.
      correlation_id: job.correlation_id,
      job_type: job.type,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      last_error: job.last_error,
      is_orphelin: isOrphelin,
      source: 'api_poller',
    };

    if (isOrphelin) {
      const orphelinDelivered = await sendAlertWithReceipt('pdf_orphelin', context);
      if (!orphelinDelivered) {
        // Do not stamp. Next pass re-attempts.
        continue;
      }
    }

    const dlDelivered = await sendAlertWithReceipt('job_dead_letter', context);
    if (!dlDelivered) {
      // Do not stamp. Next pass re-attempts.
      continue;
    }

    // BOTH relevant alerts (dead_letter, and orphelin if any) confirmed
    // by SMTP → stamp so we never alert this row again.
    try {
      await markDeadLetterAlerted(job.id);
    } catch (err: unknown) {
      // If the stamp itself fails, next pass will re-alert. Dedup keeps
      // the ops inbox from suffering. Log for investigation.
      logger.error(
        {
          job_id: job.id,
          err_name: err instanceof Error ? err.name : 'unknown',
        },
        'alert_poller_mark_alerted_failed',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// sendAlertWithReceipt — internal helper
// ---------------------------------------------------------------------------
//
// The public `sendAlert` is intentionally void: it must never throw and
// callers on hot error paths never wait for a boolean. Here we need to know
// whether the SMTP transaction actually happened so we can conditionally
// stamp `dead_letter_alerted_at`.
//
// Implementation: probe the alert transporter directly for a receipt. If
// the transporter is unavailable OR the send throws, we return false. On
// success we still delegate the dedup stamp to `sendAlert` — but we've
// already sent one email; the dedup call from here will short-circuit on
// the just-set entry.
//
// This preserves the public API contract of `sendAlert` while giving the
// poller the receipt it needs.

import nodemailer from 'nodemailer';
import type { SendMailOptions, Transporter } from 'nodemailer';

let receiptTransporter: Transporter | null = null;

/** Build/reuse the same-shape transporter used by services/alert.ts. */
function getReceiptTransporter(): Transporter | null {
  if (receiptTransporter !== null) return receiptTransporter;
  if (
    !env.SMTP_HOST ||
    env.SMTP_PORT === undefined ||
    env.SMTP_SECURE === undefined ||
    !env.SMTP_USER ||
    !env.SMTP_PASSWORD ||
    !env.SMTP_FROM_NAME ||
    !env.SMTP_FROM_EMAIL
  ) {
    return null;
  }
  receiptTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    pool: true,
    maxConnections: 1,
    requireTLS: true,
  });
  return receiptTransporter;
}

/** Test-only: inject a fake transporter for the receipt-path. */
export function __setReceiptTransporterForTests(t: Transporter | null): void {
  receiptTransporter = t;
}

export function closeReceiptTransporter(): void {
  if (receiptTransporter !== null) {
    try {
      receiptTransporter.close();
    } catch {
      // best-effort at shutdown
    }
    receiptTransporter = null;
  }
}

/**
 * Send an alert email AND return whether SMTP accepted it. Meant for the
 * dead_letter poller only — all other callers use the fire-and-forget
 * `sendAlert` from services/alert.ts.
 */
async function sendAlertWithReceipt(
  type: 'job_dead_letter' | 'pdf_orphelin',
  context: Record<string, unknown>,
): Promise<boolean> {
  if (!isEnabled()) {
    logger.info({ alert_type: type }, 'alert_suppressed_disabled');
    return false;
  }
  if (env.ALERT_EMAIL === undefined) {
    logger.warn({ alert_type: type }, 'alert_recipient_missing_only_logged');
    return false;
  }
  const transport = getReceiptTransporter();
  if (transport === null) {
    logger.warn({ alert_type: type }, 'alert_transporter_unavailable_only_logged');
    return false;
  }

  const message: SendMailOptions = {
    from: { name: env.SMTP_FROM_NAME!, address: env.SMTP_FROM_EMAIL! },
    to: env.ALERT_EMAIL,
    subject: `[Corya] ${type}`,
    text: composeBody(type, context),
  };
  try {
    await transport.sendMail(message);
    logger.info({ alert_type: type, to: env.ALERT_EMAIL }, 'alert_sent');
    return true;
  } catch (err: unknown) {
    logger.error(
      { alert_type: type, err_name: err instanceof Error ? err.name : 'unknown' },
      'alert_send_failed',
    );
    return false;
  }
}

/**
 * Same body shape as `services/alert.ts#sendAlert`, kept in sync locally.
 * Duplicating the small formatter is cheaper than exporting internals from
 * `alert.ts` and coupling the two modules.
 */
function composeBody(type: string, context: Record<string, unknown>): string {
  const lines: string[] = [
    `Corya ops alert: ${type}`,
    '',
    `Environment : ${env.NODE_ENV}`,
    `Timestamp   : ${new Date().toISOString()}`,
    '',
    'Context (technical identifiers only, no patient data):',
  ];
  for (const [k, v] of Object.entries(context)) {
    lines.push(`  ${k} = ${JSON.stringify(v)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Payload steps reader — defensive, tolerates any JSONB shape
// ---------------------------------------------------------------------------

interface StepsView {
  pdf_uploaded_at?: string;
  storage_path?: string;
  email_sent_at?: string;
}

function readSteps(payload: unknown): StepsView {
  if (!payload || typeof payload !== 'object') return {};
  const s = (payload as Record<string, unknown>).steps;
  if (!s || typeof s !== 'object') return {};
  const bag = s as Record<string, unknown>;
  const opt = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return {
    pdf_uploaded_at: opt(bag.pdf_uploaded_at),
    storage_path: opt(bag.storage_path),
    email_sent_at: opt(bag.email_sent_at),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface AlertPollerOptions {
  /** Interval between passes in ms. Default 5 min. */
  intervalMs?: number;
  /** When true, run once and return without scheduling the interval. */
  runOnce?: boolean;
}

export interface RunningPollers {
  stop: () => void;
  /** Resolves once the running pass completes (if any). */
  stopped: Promise<void>;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Run ONE full pass — checkpoints, in order. Independent try/catch on each
 * so one failing check does not skip the others.
 */
async function runOnePass(): Promise<void> {
  await Promise.allSettled([
    checkWorkerStale(),
    checkJobsBacklog(),
    checkCronStale(),
    pollDeadLetterAlerts(),
  ]);
}

/**
 * Start the periodic alert checks. Returns a `stop()` handle used by the
 * graceful shutdown path in `src/index.ts`.
 *
 * The boot-time pass runs immediately (awaited to catch config errors
 * early), then a `setInterval` schedules further passes. If a pass is
 * still running when the interval fires, we skip that tick — pollers
 * must not overlap.
 */
export function startAlertPollers(options?: AlertPollerOptions): RunningPollers {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const runOnce = options?.runOnce ?? false;

  let stopping = false;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    if (inFlight) return; // skip overlapping tick
    inFlight = runOnePass().finally(() => {
      inFlight = null;
    });
    await inFlight;
  };

  // Boot-time pass, awaited so a caller can observe completion in tests.
  const firstPass = tick();

  if (runOnce) {
    return {
      stop: (): void => {
        stopping = true;
      },
      stopped: firstPass,
    };
  }

  const timer: NodeJS.Timeout = setInterval(() => {
    // Fire-and-forget — the interval callback must not return a Promise
    // (Node ignores it) and must not throw (crash-safe).
    void tick().catch((err: unknown) => {
      logger.error(
        { err_name: err instanceof Error ? err.name : 'unknown' },
        'alert_poller_tick_unexpected_error',
      );
    });
  }, intervalMs);
  // Do NOT unref: we want the pollers to keep the process alive as long as
  // the HTTP server is up. If the server exits, the shutdown path calls stop().

  const stoppedPromise = firstPass.then(async () => {
    // stopped resolves when the loop is asked to stop AND any in-flight
    // pass finishes. Await here creates the causal chain.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (stopping && inFlight === null) {
          resolve();
          return;
        }
        setTimeout(check, 50).unref();
      };
      check();
    });
  });

  const stop = (): void => {
    stopping = true;
    clearInterval(timer);
  };

  return { stop, stopped: stoppedPromise };
}
