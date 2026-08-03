/**
 * Job worker — drains the `jobs` table and dispatches by type.
 *
 * ---------------------------------------------------------------------------
 * Loop shape
 * ---------------------------------------------------------------------------
 *   forever:
 *     rows = claim_jobs(worker_id, batch_size)   // atomic reserve
 *     if rows.empty:
 *        sleep(pollInterval)
 *     else:
 *        Promise.all(rows.map(process))
 *        // re-drain IMMEDIATELY on non-empty batches. Waiting for the
 *        // poll interval here would push the "email in < 10s after
 *        // webhook" SLA in a burst.
 *
 * ---------------------------------------------------------------------------
 * Concurrency
 * ---------------------------------------------------------------------------
 * We run the batch in parallel with `Promise.all`. The DB-side
 * SELECT ... FOR UPDATE SKIP LOCKED inside `claim_jobs` guarantees a job is
 * assigned to only one worker; the batch itself never contains the same
 * job twice.
 *
 * ---------------------------------------------------------------------------
 * Graceful shutdown
 * ---------------------------------------------------------------------------
 * On SIGTERM/SIGINT we set `stopping = true` and STOP claiming new work.
 * In-flight jobs are awaited before we close the Puppeteer browser and the
 * SMTP transporter. This matches Jelastic's normal restart semantics —
 * a job cut mid-SMTP would be the worst case (partial send).
 *
 * ---------------------------------------------------------------------------
 * Job type routing
 * ---------------------------------------------------------------------------
 * The worker actively handles both current canonical types:
 *   - `process_appel` runs the PDF / Storage / email pipeline.
 *   - `purge_audio_retell` performs the direct Retell deletion scheduled
 *     at +AUDIO_RETENTION_HOURS (48 h by default).
 * `KNOWN_UNIMPLEMENTED_JOB_TYPES` remains an empty compatibility hook. The
 * generic unknown-type branch therefore concerns no currently accepted type;
 * it stays loud for bad enqueues or a migration/code mismatch.
 */
import { hostname } from 'node:os';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  claimJobs,
  completeJob,
  failJob,
  forceDeadLetter,
  workerHeartbeatAlive,
  workerHeartbeatPoll,
} from '../db/queries.js';
import type { Job } from '../types/index.js';
import {
  EmailPipelineError,
  PdfPipelineError,
  processAppelJob,
} from '../services/appel-processor.js';
import { PermanentEmailError } from '../services/email.js';
import { computeBackoffSeconds } from '../utils/backoff.js';
import { sendAlert } from '../services/alert.js';
import { deleteRetellCall } from '../services/retell.js';
import { toLogFields } from '../utils/errors.js';

/**
 * Error classes whose `.message` is constant-by-construction and therefore
 * safe to persist in `jobs.last_error` (compliance-audited whitelist).
 *
 * ANY other Error class — including Postgres errors surfaced by
 * supabase-js, Puppeteer errors that may embed rendered HTML fragments
 * (containing patient name + transcript), and Nodemailer errors that can
 * mirror the SMTP response — has an UNTRUSTED message and MUST be
 * downgraded to a class-name marker before crossing the DB boundary.
 */
const PII_SAFE_ERROR_NAMES: ReadonlySet<string> = new Set([
  PdfPipelineError.name,
  EmailPipelineError.name,
  PermanentEmailError.name,
]);

/** Empty compatibility hook; every accepted current job type has a handler. */
export const KNOWN_UNIMPLEMENTED_JOB_TYPES: ReadonlySet<string> = new Set();

/**
 * ---------------------------------------------------------------------------
 * Retell deletion paths
 * ---------------------------------------------------------------------------
 *
 * `purge_audio_retell` is an active direct handler: `services/appel.ts`
 * schedules it at `date_appel + AUDIO_RETENTION_HOURS`, then this worker
 * calls Retell and completes the job.
 *
 * `file_deletions_outbox` is separate. It persists physical-deletion orders
 * created by SQL retention flows and provides fenced claim/retry/recovery.
 * The two paths can safely converge on the same remote call because deletion
 * is idempotent: a second attempt returning `not_found` is a success.
 */
/**
 * Build the string persisted into `jobs.last_error`. The RPC truncates to
 * 500 chars as defence in depth, but the primary contract is that the
 * caller passes a REDACTED string.
 *
 * Rule:
 *   - Whitelisted error class → keep the message (constant by construction).
 *   - Anything else → keep only the class name + a generic marker so a
 *     future maintainer investigating dead_letter rows knows to look at
 *     the logs, not at this column, for the raw message.
 */
function redactedFailureMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown:non_error_thrown';
  if (PII_SAFE_ERROR_NAMES.has(err.name)) {
    return `${err.name}:${err.message}`;
  }
  return `${err.name}:redacted_external_error`;
}

export interface JobWorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  /**
   * When true, the loop exits after the first drain cycle. Used by tests
   * to run a single pass instead of an infinite loop. Never true in prod.
   */
  runOnce?: boolean;
  /**
   * Advisory: how long a `processing` row must be locked before claim_jobs
   * treats it as a zombie. Defaults to `env.JOB_STALE_AFTER_SECONDS`.
   * Exposed for tests only.
   */
  staleAfterSeconds?: number;
  /**
   * Advisory: alive-tick period in ms. Defaults to
   * `env.WORKER_HEARTBEAT_INTERVAL_MS`. Tests pass a short value to keep
   * the suite fast.
   */
  heartbeatIntervalMs?: number;
  /**
   * Advisory: version string reported to worker_heartbeats.version. Read
   * from package.json by the process entry point. Optional here so tests
   * can omit it.
   */
  version?: string | null;
}

/**
 * Build a stable worker id: env override wins, otherwise a hostname/pid
 * combo that a human can decipher when looking at `jobs.locked_by`.
 */
export function resolveWorkerId(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  if (env.WORKER_ID && env.WORKER_ID.length > 0) return env.WORKER_ID;
  return `worker-${hostname()}-${process.pid}`;
}

/**
 * A tiny sleeper that resolves early if the shutdown flag flips. Keeps the
 * poll interval from becoming a hard shutdown delay.
 */
async function interruptibleSleep(
  ms: number,
  isStopping: () => boolean,
): Promise<void> {
  if (isStopping()) return;
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms && !isStopping()) {
    await new Promise<void>((r) => setTimeout(r, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}

/**
 * Handle a single claimed job — dispatches by type, then completes / fails.
 *
 * Never throws. Any error from `processAppelJob` is turned into a
 * `fail_job` with a redacted message. This is the outermost defence: if it
 * threw, an unhandled rejection would kill the worker process.
 *
 * Session 4: when a failure exhausts `max_attempts` we ALSO fire an
 * immediate alert (`job_dead_letter`, and `pdf_orphelin` when the PDF
 * upload checkpoint exists but the email did not go out). We rely on the
 * `attempts >= max_attempts` predicate on the job we already hold — which
 * matches the exact contract of the `fail_job` RPC (see migration
 * 20260731100000). The API-side poller catches dead_letter rows produced
 * by SQL (bascule by `requeue_stuck_jobs`) that never went through this
 * path.
 */
async function handleOne(job: Job): Promise<void> {
  // Distinguish a zombie reclaim from a fresh claim in the logs. attempts > 1
  // is not a perfect proof (a genuine retry after fail_job also lands here
  // with attempts > 1), but combined with `locked_at` timing and the
  // preceding `job_claim_batch` log line it is enough for support to spot a
  // reclaim event.
  const corr = {
    job_id: job.id,
    job_type: job.type,
    attempt: job.attempts,
    max_attempts: job.max_attempts,
    correlation_id: job.correlation_id,
    reclaimed: job.attempts > 1,
  };
  try {
    if (job.type === 'process_appel') {
      await processAppelJob(job);
      await completeJob(job.id);
      logger.info(corr, 'job_completed');
      return;
    }

    if (job.type === 'purge_audio_retell') {
      // Active +48 h direct deletion. `not_found` is returned as a successful
      // idempotent status when an outbox order or Retell retention got there first.
      const callId = job.payload.retell_call_id;
      if (typeof callId !== 'string' || callId.length === 0) {
        logger.error(corr, 'retell_purge_missing_call_id');
        await sendAlert('retell_purge_failed', { ...corr, reason: 'missing_call_id' });
      } else {
        try {
          const status = await deleteRetellCall(callId);
          logger.info({ ...corr, status }, 'retell_purge_completed');
        } catch (err: unknown) {
          logger.error({ ...corr, ...toLogFields(err) }, 'retell_purge_failed');
          await sendAlert('retell_purge_failed', { ...corr, reason: 'remote_delete_failed' });
        }
      }
      await completeJob(job.id);
      return;
    }

    // Compatibility hook for a future accepted type during a staged rollout.
    // The set is currently empty, so no current job enters this branch. If a
    // type is temporarily added, fail it terminally without repeated retries;
    // `last_error` remains a constant built only from the technical type.
    if (KNOWN_UNIMPLEMENTED_JOB_TYPES.has(job.type)) {
      logger.warn(corr, 'job_type_known_but_unimplemented');
      try {
        await forceDeadLetter(job.id, `not_implemented:${job.type}`);
      } catch (forceErr: unknown) {
        // On DB failure, log and return — do NOT fall through to the
        // unknown-type branch. Standard stuck-job recovery retains ownership
        // of any later retry if this compatibility hook is ever populated.
        logger.error(
          {
            ...corr,
            ...toLogFields(forceErr),
          },
          'force_dead_letter_failed',
        );
      }
      return;
    }

    // Truly UNKNOWN type — a signal (bad enqueue, migration regression).
    // Keep the noisy behaviour: fail with backoff, alert on dead_letter.
    logger.warn(corr, 'job_type_not_handled_by_this_worker');
    await failJob(
      job.id,
      `unhandled_job_type:${job.type}`,
      computeBackoffSeconds(job.attempts),
    );
    await maybeAlertDeadLetter(job, `unhandled_job_type:${job.type}`);
    return;
  } catch (err: unknown) {
    // nLPD compliance (session 3.1 audit):
    //   - We log ONLY the error CLASS NAME. We NEVER put `err.message` in
    //     a log line — an external error (Postgres, Puppeteer, Supabase,
    //     Nodemailer) can carry a fragment of patient data in its message.
    //   - We persist only a REDACTED failure marker in `jobs.last_error`
    //     via `redactedFailureMessage`. Whitelisted classes
    //     (PdfPipelineError / EmailPipelineError / PermanentEmailError)
    //     have constant messages by construction and are safe to keep
    //     verbatim.
    const errName = toLogFields(err).err_name;
    const redacted = redactedFailureMessage(err);

    // Session 4 vague 3: PERMANENT SMTP failure short-circuits the retry
    // budget. Force dead_letter directly (see queries.forceDeadLetter) —
    // do NOT go through fail_job, which would only bump attempts and
    // waste the whole SMTP_TIMEOUT * (max_attempts - attempts) budget.
    if (err instanceof PermanentEmailError) {
      logger.error(
        { ...corr, err_name: errName, smtp_code: err.smtpCode },
        'job_permanent_failure_forcing_dead_letter',
      );
      try {
        await forceDeadLetter(job.id, redacted);
      } catch (forceErr: unknown) {
        logger.error(
          {
            ...corr,
            ...toLogFields(forceErr),
          },
          'force_dead_letter_failed',
        );
      }
      // The job is now (semantically) in dead_letter. Fire the alerts
      // unconditionally — the standard `attempts >= max_attempts` gate
      // in maybeAlertDeadLetter would not trigger here (attempts may be
      // 1). Build a synthetic post-transition Job for the alert helper.
      await alertDeadLetterUnconditional(
        { ...job, attempts: job.max_attempts, status: 'dead_letter' },
        redacted,
      );
      return;
    }

    logger.warn({ ...corr, err_name: errName }, 'job_failed_will_retry_or_dead_letter');
    try {
      await failJob(
        job.id,
        redacted,
        computeBackoffSeconds(job.attempts),
      );
    } catch (failErr: unknown) {
      // If we can't even talk to the DB to record the failure, the pg_cron
      // `requeue_stuck_jobs` net will pick this up.
      logger.error(
        {
          ...corr,
          err_name:
            failErr instanceof Error ? failErr.name : 'unknown',
        },
        'fail_job_rpc_failed',
      );
      // Also fire the alert if this was the terminal attempt — otherwise
      // the fail_job outage would double-hide the dead_letter transition.
    }
    await maybeAlertDeadLetter(job, redacted);
  }
}

/**
 * Alert path used by the force-dead-letter branch. Mirrors
 * maybeAlertDeadLetter but skips the attempts >= max_attempts gate
 * because we KNOW we just short-circuited it.
 */
async function alertDeadLetterUnconditional(job: Job, lastError: string): Promise<void> {
  const steps = readPayloadSteps(job.payload);
  const isOrphelin =
    typeof steps.storage_path === 'string' &&
    steps.storage_path.length > 0 &&
    !steps.email_sent_at;
  const context = {
    job_id: job.id,
    appel_id: job.appel_id,
    job_type: job.type,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    correlation_id: job.correlation_id,
    last_error: lastError,
    is_orphelin: isOrphelin,
    source: 'worker_immediate_permanent',
  };
  if (isOrphelin) await sendAlert('pdf_orphelin', context);
  await sendAlert('job_dead_letter', context);
}

/**
 * Fire immediate alerts when the JUST-FAILED job hit dead_letter status.
 *
 * We rely on the local `attempts >= max_attempts` predicate: it mirrors
 * fail_job's decision exactly. If fail_job's DB call itself failed above,
 * pg_cron's requeue-stuck-jobs will eventually flip it to dead_letter via
 * SQL — and the API poller will alert then. Either way the incident does
 * not slip through.
 *
 * `pdf_orphelin` is layered on top: when the PDF was uploaded (checkpoint
 * `storage_path` set) but the email was never sent (`email_sent_at`
 * missing), we have a compliance-flavoured incident (patient PII in
 * Storage without recipient notification). Fired FIRST so the operator's
 * inbox surfaces it distinctly from a generic dead_letter.
 *
 * All context passed to sendAlert is TECHNICAL: job id, type, attempts,
 * correlation id, redacted error marker. Never patient data.
 */
async function maybeAlertDeadLetter(job: Job, lastError: string): Promise<void> {
  if (job.attempts < job.max_attempts) return;

  const steps = readPayloadSteps(job.payload);
  const isOrphelin =
    typeof steps.storage_path === 'string' &&
    steps.storage_path.length > 0 &&
    !steps.email_sent_at;

  const context = {
    job_id: job.id,
    appel_id: job.appel_id,
    job_type: job.type,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    correlation_id: job.correlation_id,
    last_error: lastError,
    is_orphelin: isOrphelin,
    source: 'worker_immediate',
  };

  if (isOrphelin) {
    await sendAlert('pdf_orphelin', context);
  }
  await sendAlert('job_dead_letter', context);
}

/** Tolerant reader for the `payload.steps` checkpoint shape. */
interface StepsView {
  pdf_uploaded_at?: string;
  storage_path?: string;
  email_sent_at?: string;
}
function readPayloadSteps(payload: unknown): StepsView {
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

/**
 * Run the worker. Returns when `stop()` is called (via SIGTERM/SIGINT) and
 * the last in-flight batch has finished.
 */
export interface RunningWorker {
  stop: () => void;
  stopped: Promise<void>;
}

export function runJobWorker(options?: JobWorkerOptions): RunningWorker {
  const workerId = resolveWorkerId(options?.workerId);
  const pollIntervalMs = options?.pollIntervalMs ?? env.JOB_POLL_INTERVAL_MS;
  const batchSize = options?.batchSize ?? env.JOB_BATCH_SIZE;
  const runOnce = options?.runOnce ?? false;
  const staleAfterSeconds =
    options?.staleAfterSeconds ?? env.JOB_STALE_AFTER_SECONDS;
  const heartbeatIntervalMs =
    options?.heartbeatIntervalMs ?? env.WORKER_HEARTBEAT_INTERVAL_MS;
  const version = options?.version ?? null;

  let stopping = false;
  const isStopping = (): boolean => stopping;

  // ------------------------------------------------------------------------
  // Alive-heartbeat — INDEPENDENT of the polling loop.
  // ------------------------------------------------------------------------
  //
  // This setInterval writes `last_seen_at` even when the polling loop is
  // stuck inside a long-running job (Puppeteer render, SMTP handshake).
  // Without it, a job that pends 5 min would look like a dead process.
  //
  // We do NOT `.unref()` the timer: the worker's own graceful shutdown
  // handler MUST call stop() to clear it — leaving it unref'd would let
  // the process exit while a heartbeat is in flight, producing a truncated
  // write.
  //
  // First tick fires immediately (synchronously scheduled) so the row
  // exists in worker_heartbeats even before the polling loop's first pass.
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const fireAliveTick = (): void => {
    if (stopping) return;
    workerHeartbeatAlive(workerId, version).catch((err: unknown) => {
      // Never let a heartbeat failure kill the worker. Downgrade to warn:
      // the poller in the API will detect the resulting gap.
      logger.warn(
        { ...toLogFields(err) },
        'worker_heartbeat_alive_failed',
      );
    });
  };
  // Immediate first tick.
  fireAliveTick();
  heartbeatTimer = setInterval(fireAliveTick, heartbeatIntervalMs);

  const stoppedPromise = (async (): Promise<void> => {
    logger.info(
      {
        worker_id: workerId,
        poll_ms: pollIntervalMs,
        batch: batchSize,
        stale_after_seconds: staleAfterSeconds,
        heartbeat_interval_ms: heartbeatIntervalMs,
        version,
      },
      'job_worker_started',
    );
    while (!stopping) {
      let batch: Job[] = [];
      try {
        batch = await claimJobs(workerId, batchSize, staleAfterSeconds);
      } catch (err: unknown) {
        // A DB blip should not kill the worker. Log and back off a bit.
        logger.error(
          { ...toLogFields(err) },
          'job_claim_failed',
        );
        // Still record the poll tick so we can distinguish "DB down" (poll
        // ticks continue) from "loop stuck" (poll ticks stop).
        pollTick(workerId, 0);
        await interruptibleSleep(Math.max(1_000, pollIntervalMs), isStopping);
        continue;
      }

      // Observability: log the batch outcome. When claim_jobs returned
      // ANY reclaimed row (attempts > 1), surface it — that is our signal
      // that the zombie-reclaim path activated.
      if (batch.length > 0) {
        const reclaimedCount = batch.filter((j) => j.attempts > 1).length;
        logger.info(
          {
            worker_id: workerId,
            batch_size: batch.length,
            reclaimed_count: reclaimedCount,
          },
          'job_claim_batch',
        );
      }

      if (batch.length === 0) {
        // Non-regression: `claim_jobs` returns a real empty array (not a
        // one-row bag of NULLs). Locked behind a test in
        // tests/workers/job-worker.test.ts.
        pollTick(workerId, 0);
        if (runOnce) break;
        await interruptibleSleep(pollIntervalMs, isStopping);
        continue;
      }

      // Run the batch in parallel. Each handleOne is fault-isolated.
      await Promise.all(batch.map((job) => handleOne(job)));

      // Poll-tick AFTER the batch: counts the jobs we just processed.
      pollTick(workerId, batch.length);

      // Non-empty batch: re-drain IMMEDIATELY (do not wait pollInterval).
      // Critical for the sub-10-s email SLA on the webhook path.
      if (runOnce) break;
    }
    // Clear the alive-heartbeat timer no matter how the loop exited
    // (stop() flip, runOnce break, or a thrown error above we did not
    // catch). Leaving a live setInterval past the polling loop would
    // hold the event loop open in prod and pile handles up in tests.
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    logger.info('job_worker_stopped');
  })();

  const stop = (): void => {
    stopping = true;
    // Best-effort immediate cleanup when the caller stops us explicitly.
    // The end-of-loop cleanup above is the authoritative one — this is
    // just to shorten the window in which the timer might fire once more
    // after stop() is called.
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  return { stop, stopped: stoppedPromise };
}

/**
 * Fire-and-forget poll-tick. Kept in a helper so both the batch path and
 * the DB-blip fallback path share exactly the same error handling.
 */
function pollTick(workerId: string, jobsProcessedDelta: number): void {
  workerHeartbeatPoll(workerId, jobsProcessedDelta).catch((err: unknown) => {
    logger.warn(
      { ...toLogFields(err) },
      'worker_heartbeat_poll_failed',
    );
  });
}
