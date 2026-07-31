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
 * Unknown job type routing
 * ---------------------------------------------------------------------------
 * The worker knows how to run `process_appel`. Any other type ends up in
 * `dead_letter` via `fail_job` with a clear error message — we don't crash
 * the worker just because someone enqueued a type we haven't wired yet.
 */
import { hostname } from 'node:os';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { claimJobs, completeJob, failJob } from '../db/queries.js';
import type { Job } from '../types/index.js';
import {
  EmailPipelineError,
  PdfPipelineError,
  processAppelJob,
} from '../services/appel-processor.js';
import { computeBackoffSeconds } from '../utils/backoff.js';

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
]);

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
 */
async function handleOne(job: Job): Promise<void> {
  const corr = { job_id: job.id, job_type: job.type, attempt: job.attempts };
  try {
    if (job.type === 'process_appel') {
      await processAppelJob(job);
      await completeJob(job.id);
      logger.info(corr, 'job_completed');
      return;
    }

    // Unknown type — we don't crash. We fail the job with a clear message
    // and let the RPC decide whether that becomes a retry (pointless, but
    // harmless) or a dead_letter (which is what we want after enough tries).
    logger.warn(corr, 'job_type_not_handled_by_this_worker');
    await failJob(
      job.id,
      `unhandled_job_type:${job.type}`,
      computeBackoffSeconds(job.attempts),
    );
    return;
  } catch (err: unknown) {
    // nLPD compliance (session 3.1 audit):
    //   - We log ONLY the error CLASS NAME. We NEVER put `err.message` in
    //     a log line — an external error (Postgres, Puppeteer, Supabase,
    //     Nodemailer) can carry a fragment of patient data in its message.
    //   - We persist only a REDACTED failure marker in `jobs.last_error`
    //     via `redactedFailureMessage`. Whitelisted classes
    //     (PdfPipelineError / EmailPipelineError) have constant messages
    //     by construction and are safe to keep verbatim.
    const errName = err instanceof Error ? err.name : 'unknown';
    logger.warn({ ...corr, err_name: errName }, 'job_failed_will_retry_or_dead_letter');
    try {
      await failJob(
        job.id,
        redactedFailureMessage(err),
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
    }
  }
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

  let stopping = false;
  const isStopping = (): boolean => stopping;

  const stoppedPromise = (async (): Promise<void> => {
    logger.info(
      { worker_id: workerId, poll_ms: pollIntervalMs, batch: batchSize },
      'job_worker_started',
    );
    while (!stopping) {
      let batch: Job[] = [];
      try {
        batch = await claimJobs(workerId, batchSize);
      } catch (err: unknown) {
        // A DB blip should not kill the worker. Log and back off a bit.
        logger.error(
          { err_name: err instanceof Error ? err.name : 'unknown' },
          'job_claim_failed',
        );
        await interruptibleSleep(Math.max(1_000, pollIntervalMs), isStopping);
        continue;
      }

      if (batch.length === 0) {
        if (runOnce) break;
        await interruptibleSleep(pollIntervalMs, isStopping);
        continue;
      }

      // Run the batch in parallel. Each handleOne is fault-isolated.
      await Promise.all(batch.map((job) => handleOne(job)));

      // Non-empty batch: re-drain IMMEDIATELY (do not wait pollInterval).
      // Critical for the sub-10-s email SLA on the webhook path.
      if (runOnce) break;
    }
    logger.info('job_worker_stopped');
  })();

  const stop = (): void => {
    stopping = true;
  };

  return { stop, stopped: stoppedPromise };
}
