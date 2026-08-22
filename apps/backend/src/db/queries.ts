/**
 * Typed DB access — the ONLY module that talks to Supabase.
 *
 * Everything else calls into these functions. That keeps compliance-sensitive
 * work (RLS bypass via service role, insertion of PII columns) inside one
 * reviewable surface.
 *
 * All functions return plain JS types or `null` (for "not found"). They
 * throw only on truly unexpected DB errors, never on empty result sets.
 */
import { getAuthClient, getServiceClient } from '../config/supabase.js';
import { env } from '../config/env.js';
import type {
  AppelInsertRow,
  AppelProcessingRow,
  CabinetProcessingRow,
  CalcomBookingEventInput,
  CalcomBookingEventResult,
  FileDeletion,
  Job,
  JobInsertRow,
  PersistCallAnalyzedInput,
  ProcessAppelPayload,
} from '../types/index.js';
import { withTimeout } from '../utils/timeout.js';
import type {
  PortalAuthUser,
  PortalCabinetPatch,
  PortalCabinetRow,
  PortalCallRow,
  PortalCallsQuery,
  PortalDashboardSnapshot,
  PortalMembership,
  PortalPractice,
  PortalTeamRow,
} from '../admin/types.js';

/**
 * Small helper — every Supabase call in this file goes through here.
 *
 * Two responsibilities:
 *   1. Enforce a bounded execution time on the network round-trip (the
 *      historical "hung Supabase request pins a worker slot" incident).
 *   2. Pass an AbortController down to supabase-js. supabase-js's query
 *      builder exposes `.abortSignal(signal)`; when the deadline fires,
 *      withTimeout calls `abort()`, and the underlying `fetch` call
 *      terminates — freeing the server-side connection instead of
 *      leaking it.
 *
 * The Storage helpers use a similar pattern but without abortSignal (the
 * Storage client does not expose it) — see comment in services/storage.ts.
 *
 * `label` MUST be a constant string — it lands in TimeoutError.message,
 * in the logger, and (through the fail_job path) in `jobs.last_error`.
 */
export function withDbTimeout<T>(
  build: (signal: AbortSignal) => PromiseLike<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  return withTimeout(
    build(controller.signal),
    env.TIMEOUT_DB_MS,
    label,
    { signal: controller },
  );
}

export interface CabinetRow {
  id: string;
  numero_corya: string;
  email_notification: string;
  email_notification_cc: string | null;
}

/**
 * Find the cabinet whose Corya-assigned number matches `toNumber`.
 * Returns null if no cabinet is mapped — the webhook route logs a warn and
 * still answers 200 so Retell never retries.
 *
 * Only `actif` cabinets are returned. `pause` and `resilie` cabinets should
 * not be routed to at all: the webhook handler treats a missing cabinet
 * exactly as an unroutable call.
 */
export async function findCabinetByCoryaNumber(
  toNumber: string,
): Promise<CabinetRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('cabinets')
        .select('id, numero_corya, email_notification, email_notification_cc')
        .eq('numero_corya', toNumber)
        .eq('statut', 'actif')
        .abortSignal(signal)
        .maybeSingle<CabinetRow>(),
    'db:findCabinetByCoryaNumber',
  );

  if (error) {
    throw new Error(`db_find_cabinet_failed: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Idempotent insert of an `appels` row.
 *
 * Uses the `retell_call_id` unique constraint for de-duplication. On
 * conflict we do NOT update the row — a replayed webhook must be a no-op.
 *
 * Return value:
 *   - `{ appelId, duplicate: false }` if the row was actually inserted
 *   - `{ appelId, duplicate: true  }` if a row with the same
 *                                       retell_call_id already existed
 */
export async function insertAppelIdempotent(
  row: AppelInsertRow,
): Promise<{ appelId: string; duplicate: boolean }> {
  const supabase = getServiceClient();

  // supabase-js has no "INSERT ... ON CONFLICT DO NOTHING RETURNING id" in a
  // single call. We simulate it in two steps: try the insert, if unique-
  // violation then look up the existing row. That keeps our behaviour
  // idempotent without needing a stored proc.
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('appels')
        .insert(row)
        .select('id')
        .abortSignal(signal)
        .single<{ id: string }>(),
    'db:insertAppelIdempotent',
  );

  if (!error && data) {
    return { appelId: data.id, duplicate: false };
  }

  // Postgres unique_violation. Supabase surfaces it as code '23505'.
  if (error && error.code === '23505') {
    const { data: existing, error: lookupErr } = await withDbTimeout(
      (signal) =>
        supabase
          .from('appels')
          .select('id')
          .eq('retell_call_id', row.retell_call_id)
          .abortSignal(signal)
          .single<{ id: string }>(),
      'db:insertAppelIdempotent:lookup',
    );
    if (lookupErr || !existing) {
      throw new Error(
        `db_insert_appel_conflict_but_lookup_failed: ${lookupErr?.message ?? 'no_row'}`,
      );
    }
    return { appelId: existing.id, duplicate: true };
  }

  throw new Error(`db_insert_appel_failed: ${error?.message ?? 'unknown'}`);
}

/**
 * Enqueue a job. The `(type, appel_id) WHERE status IN ('pending',
 * 'processing')` unique partial index enforces that a job can't be enqueued
 * twice while active. If we hit that conflict, the intent is already in
 * flight — return silently instead of surfacing an error.
 *
 * Returns true if a new row was inserted, false if a duplicate was skipped.
 */
export async function enqueueJobIdempotent(row: JobInsertRow): Promise<boolean> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) => supabase.from('jobs').insert(row).abortSignal(signal),
    'db:enqueueJobIdempotent',
  );

  if (!error) return true;
  if (error.code === '23505') {
    // Already queued or being processed. Idempotent success.
    return false;
  }
  throw new Error(`db_enqueue_job_failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Session 3 — post-call pipeline access
// ---------------------------------------------------------------------------
//
// The worker uses `claim_jobs`, `complete_job` and `fail_job` RPCs (see
// supabase/migrations/20260731100000_job_claim_and_pdf_purge.sql). These
// wrappers exist so the rest of the code never touches supabase-js
// directly, and so a future move to a different queue backend is a
// localised change.

/**
 * Reserve up to `batchSize` due jobs for this worker.
 *
 * Session 4 update: the RPC now ALSO reclaims zombies (rows stuck in
 * `processing` for longer than `staleAfterSeconds`). See migration
 * 20260801000000. A reclaimed row is returned as any other claim — the
 * caller sees `attempts > 1` and can log it as a zombie for observability,
 * but no code path branches on that: the pipeline is idempotent by
 * checkpoint (see `services/appel-processor.ts`).
 *
 * Concurrent workers see disjoint rows thanks to the RPC's internal
 * `SELECT ... FOR UPDATE SKIP LOCKED`. The RPC also enforces
 * `attempts < max_attempts`, so an exhausted job is never re-served.
 *
 * Returns [] when no jobs are ready. Never throws on empty result — proven
 * by a non-regression test in tests/workers/job-worker.test.ts.
 */
export async function claimJobs(
  workerId: string,
  batchSize: number,
  staleAfterSeconds: number,
): Promise<Job[]> {
  const supabase = getServiceClient();
  // Supabase-js types RPC results as `any` (no generated types file). We
  // cast the RESULT object to a narrow shape before destructuring so
  // downstream code stays typed. Anything the RPC contract violates
  // (e.g. non-array data) is silently coerced to an empty array.
  const rpcResult = (await withDbTimeout(
    (signal) =>
      supabase
        .rpc('claim_jobs', {
          p_worker_id: workerId,
          p_batch_size: batchSize,
          p_stale_after_seconds: staleAfterSeconds,
        })
        .abortSignal(signal),
    'db:claimJobs',
  )) as { data: unknown; error: { message: string } | null };
  if (rpcResult.error) {
    throw new Error(`db_claim_jobs_failed: ${rpcResult.error.message}`);
  }
  const rows = Array.isArray(rpcResult.data) ? (rpcResult.data as unknown[]) : [];
  return rows as Job[];
}

/**
 * Mark a job as succeeded. Idempotent — calling twice is a no-op on the
 * second call. The RPC also clears `locked_at` / `locked_by` / `last_error`.
 */
export async function completeJob(jobId: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) => supabase.rpc('complete_job', { p_job_id: jobId }).abortSignal(signal),
    'db:completeJob',
  );
  if (error) {
    throw new Error(`db_complete_job_failed: ${error.message}`);
  }
}

/**
 * Record a job failure. The RPC decides whether this becomes a retry
 * (`status = 'pending'`, `run_after = now() + backoff`) or a terminal
 * `dead_letter`, based on `attempts` vs `max_attempts`.
 *
 * `errorMessage` MUST be REDACTED already — never a patient name, phone
 * number, motif or transcript fragment. The RPC truncates to 500 chars as
 * defence in depth but the primary contract is on our side.
 */
export async function failJob(
  jobId: string,
  errorMessage: string,
  backoffSeconds: number,
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .rpc('fail_job', {
          p_job_id: jobId,
          p_error: errorMessage,
          p_backoff_seconds: backoffSeconds,
        })
        .abortSignal(signal),
    'db:failJob',
  );
  if (error) {
    throw new Error(`db_fail_job_failed: ${error.message}`);
  }
}

/**
 * Force a job into `dead_letter` immediately, bypassing the attempts-based
 * decision of `fail_job`.
 *
 * ---------------------------------------------------------------------------
 * Why this bypass exists
 * ---------------------------------------------------------------------------
 * The RPC `fail_job` only flips to `dead_letter` once `attempts >=
 * max_attempts`. That is correct for TRANSIENT errors — a temporary SMTP
 * hiccup deserves the full retry budget.
 *
 * PERMANENT errors (SMTP 550/551/553/554: mailbox unknown, blocked,
 * syntax error) are different: retrying 5 times against a bad recipient
 * wastes 5 * SMTP_TIMEOUT of wall-clock, spams the relay, and delays the
 * dead_letter alert by hours. The correct behaviour is "fail terminally,
 * NOW".
 *
 * ---------------------------------------------------------------------------
 * Session 4 vague 5 — recâblage sur la RPC `fail_job_permanent`
 * ---------------------------------------------------------------------------
 * Vague 3 implémentait cette bascule via un UPDATE direct côté client,
 * guardé par `WHERE status='processing'`. database-compliance a depuis
 * livré la RPC dédiée `public.fail_job_permanent(p_job_id UUID, p_error TEXT)`.
 *
 * Contrat garanti par la migration :
 *   - Passage en `dead_letter`, libération de `locked_at`/`locked_by`,
 *     `last_error` tronqué à 500 chars côté SQL.
 *   - IGNORE délibérément `attempts` — c'est tout l'intérêt.
 *   - `WHERE id = p_job_id AND status = 'processing'` : no-op assumée si
 *     le job a déjà transité (par requeue_stuck_jobs ou fail_job).
 *
 * Bénéfices vs. UPDATE direct :
 *   - Toutes les transitions d'état redescendent côté SQL — un audit
 *     via `information_schema` / triggers reste centralisé.
 *   - Le service_role peut à terme se voir retirer les droits UPDATE
 *     directs sur `public.jobs` sans casser ce chemin.
 *
 * `errorMessage` MUST be redacted (constant string or class name marker),
 * same contract as `fail_job`.
 */
export async function forceDeadLetter(
  jobId: string,
  errorMessage: string,
): Promise<void> {
  const supabase = getServiceClient();
  // Truncate côté client — défense en profondeur, la RPC tronque aussi
  // mais on borne d'abord le payload réseau.
  const truncated = errorMessage.slice(0, 500);
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .rpc('fail_job_permanent', {
          p_job_id: jobId,
          p_error: truncated,
        })
        .abortSignal(signal),
    'db:forceDeadLetter',
  );
  if (error) {
    throw new Error(`db_force_dead_letter_failed: ${error.message}`);
  }
}

/**
 * Persist a job's progress checkpoint. Called between steps of the
 * post-call pipeline so a crashed worker retry can skip completed steps.
 *
 * Merging strategy: we OVERWRITE `payload` with the caller's value. The
 * caller is expected to have merged with the previous payload before
 * calling — the appel-processor keeps its own in-memory copy for this.
 */
export async function updateJobPayload(
  jobId: string,
  payload: ProcessAppelPayload,
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) => supabase.from('jobs').update({ payload }).eq('id', jobId).abortSignal(signal),
    'db:updateJobPayload',
  );
  if (error) {
    throw new Error(`db_update_job_payload_failed: ${error.message}`);
  }
}

/**
 * Fetch the appel row the worker needs. Returns null if the row does not
 * exist (e.g. purged by pg_cron between the enqueue and the claim), in
 * which case the caller should just complete the job silently — there is
 * no work to do.
 */
export async function getAppelForProcessing(
  appelId: string,
): Promise<AppelProcessingRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('appels')
        .select(
          'id, cabinet_id, retell_call_id, date_appel, duree_secondes, resultat, motif_appel, patient_nom, patient_prenom, patient_telephone, rdv_date, rdv_praticien, transcript, pdf_url, email_status',
        )
        .eq('id', appelId)
        .abortSignal(signal)
        .maybeSingle<AppelProcessingRow>(),
    'db:getAppelForProcessing',
  );
  if (error) {
    throw new Error(`db_get_appel_failed: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Fetch the cabinet for pipeline decisions. Returns null when the row
 * doesn't exist — again, the worker should treat this as "nothing to do".
 *
 * Unlike `findCabinetByCoryaNumber`, this one DOES return paused and
 * terminated cabinets: the worker needs to see them to short-circuit
 * explicitly (see `services/appel-processor.ts`).
 */
export async function getCabinetForProcessing(
  cabinetId: string,
): Promise<CabinetProcessingRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('cabinets')
        .select('id, nom, email_notification, email_notification_cc, statut')
        .eq('id', cabinetId)
        .abortSignal(signal)
        .maybeSingle<CabinetProcessingRow>(),
    'db:getCabinetForProcessing',
  );
  if (error) {
    throw new Error(`db_get_cabinet_failed: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Persist the Storage object path on the appel row once the PDF is
 * uploaded. `pdf_url` stores the RAW object path (`{cabinet_id}/{yyyy-mm}/
 * {appel_id}.pdf`) — never a signed URL — so pg_cron purges can locate the
 * file (see `purge_old_pdfs`).
 */
export async function setAppelPdfPath(
  appelId: string,
  objectPath: string,
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('appels')
        .update({ pdf_url: objectPath })
        .eq('id', appelId)
        .abortSignal(signal),
    'db:setAppelPdfPath',
  );
  if (error) {
    throw new Error(`db_set_pdf_path_failed: ${error.message}`);
  }
}

/**
 * Mark the appel's email as sent. `pdf_envoye_at` is the anchor used by the
 * J+30 PDF purge (`purge_old_pdfs`) — so it MUST be set on send success,
 * not on send attempt.
 */
export async function markAppelEmailSent(appelId: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('appels')
        .update({
          email_status: 'sent',
          pdf_envoye_at: new Date().toISOString(),
        })
        .eq('id', appelId)
        .abortSignal(signal),
    'db:markAppelEmailSent',
  );
  if (error) {
    throw new Error(`db_mark_email_sent_failed: ${error.message}`);
  }
}

/**
 * Flip `email_status` to 'failed'. Called only when the job runs out of
 * retries (dead_letter) — transient failures leave the status alone.
 */
export async function markAppelEmailFailed(appelId: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('appels')
        .update({ email_status: 'failed' })
        .eq('id', appelId)
        .abortSignal(signal),
    'db:markAppelEmailFailed',
  );
  if (error) {
    throw new Error(`db_mark_email_failed_failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Session 4 — worker heartbeats & alerting queries
// ---------------------------------------------------------------------------
//
// Two heartbeat RPCs (`worker_heartbeat_alive` / `worker_heartbeat_poll`)
// with DECOUPLED tempos:
//   - alive : written every WORKER_HEARTBEAT_INTERVAL_MS by a setInterval
//     INDEPENDENT of the polling loop → answers "process is alive"
//   - poll  : written on every polling-loop tick → answers "loop advances"
// See migration 20260801000001 for the SQL contract.

/**
 * Alive-tick. Small write, called every 10 s. `version` is only sent on the
 * first tick after boot (RPC coalesces to keep the previously-known value
 * when NULL is passed) — the caller is free to pass it every time; the
 * network cost is negligible.
 */
export async function workerHeartbeatAlive(
  workerId: string,
  version: string | null,
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .rpc('worker_heartbeat_alive', {
          p_worker_id: workerId,
          p_version: version,
        })
        .abortSignal(signal),
    'db:workerHeartbeatAlive',
  );
  if (error) {
    throw new Error(`db_worker_heartbeat_alive_failed: ${error.message}`);
  }
}

/**
 * Poll-tick. Called after each `claim_jobs` return (batch empty or drained).
 * `jobsProcessedDelta` is the number of jobs the current tick processed —
 * incremented atomically into the monotonic counter server-side.
 */
export async function workerHeartbeatPoll(
  workerId: string,
  jobsProcessedDelta: number,
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .rpc('worker_heartbeat_poll', {
          p_worker_id: workerId,
          p_jobs_processed_delta: jobsProcessedDelta,
        })
        .abortSignal(signal),
    'db:workerHeartbeatPoll',
  );
  if (error) {
    throw new Error(`db_worker_heartbeat_poll_failed: ${error.message}`);
  }
}

/**
 * Row shape returned by `worker_heartbeats`. Only the columns we actually
 * read in the API poller — we do NOT expose `version` etc. to the log
 * pipeline unless a diagnostic surfaces the need.
 */
export interface WorkerHeartbeatRow {
  worker_id: string;
  last_seen_at: string;
  last_poll_at: string | null;
  last_deletion_poll_at: string | null;
}

/**
 * Return the workers whose heartbeats look unhealthy — either the process
 * has not ticked in `seenThresholdSec` (dead process) or the polling loop
 * has not advanced in `pollThresholdSec` (blocked loop). Rows are filtered
 * SERVER-SIDE so the poller does not pull the whole table.
 *
 * We only consider workers with a NON-NULL `last_poll_at` for the poll
 * check — a fresh worker that has just written its first alive-tick but
 * hasn't polled yet is not stale.
 */
export async function getStaleWorkerHeartbeats(
  seenThresholdSec: number,
  pollThresholdSec: number,
): Promise<WorkerHeartbeatRow[]> {
  const supabase = getServiceClient();
  const nowMs = Date.now();
  const seenCutoff = new Date(nowMs - seenThresholdSec * 1_000).toISOString();
  const pollCutoff = new Date(nowMs - pollThresholdSec * 1_000).toISOString();

  // supabase-js's .or() runs the two comparators in a single SQL OR. The
  // NULL guard on last_poll_at is expressed via the composite predicate:
  // "last_poll_at is not null AND last_poll_at < pollCutoff".
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('worker_heartbeats')
        .select('worker_id, last_seen_at, last_poll_at, last_deletion_poll_at')
        .or(
          `last_seen_at.lt.${seenCutoff},and(last_poll_at.not.is.null,last_poll_at.lt.${pollCutoff}),and(last_deletion_poll_at.not.is.null,last_deletion_poll_at.lt.${pollCutoff})`,
        )
        .abortSignal(signal),
    'db:getStaleWorkerHeartbeats',
  );

  if (error) {
    throw new Error(`db_get_stale_workers_failed: ${error.message}`);
  }
  // Supabase-js infers columns from the select string, so `data` already
  // types as WorkerHeartbeatRow[] | null — no cast needed.
  return data ?? [];
}

/**
 * Count `pending` jobs whose `run_after` is older than `olderThanSeconds`.
 * Used by the backlog alerting poller.
 *
 * We use `run_after`, not `created_at`: a job with a future `run_after`
 * (e.g. `purge_audio_retell` at +48 h) is NOT a backlog symptom — it's just
 * scheduled ahead. The intent is "should be running now, isn't".
 */
export async function countPendingJobsOlderThan(
  olderThanSeconds: number,
): Promise<number> {
  const supabase = getServiceClient();
  const cutoff = new Date(Date.now() - olderThanSeconds * 1_000).toISOString();
  const { count, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .lt('run_after', cutoff)
        .abortSignal(signal),
    'db:countPendingJobsOlderThan',
  );
  if (error) {
    throw new Error(`db_count_backlog_failed: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Fetch dead-letter jobs that have NOT yet been alerted. Chronological
 * order so the oldest incident bubbles up first. `limit` is a hard cap to
 * bound a single poller pass; the next pass will drain the rest.
 */
export async function getDeadLetterJobsToAlert(limit: number): Promise<Job[]> {
  const supabase = getServiceClient();
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('jobs')
        .select('*')
        .eq('status', 'dead_letter')
        .is('dead_letter_alerted_at', null)
        .order('created_at', { ascending: true })
        .limit(limit)
        .abortSignal(signal),
    'db:getDeadLetterJobsToAlert',
  );
  if (error) {
    throw new Error(`db_get_dead_letter_jobs_failed: ${error.message}`);
  }
  return (data ?? []) as Job[];
}

/**
 * Stamp `dead_letter_alerted_at = NOW()` for a specific job. Contract
 * (see migration 20260801000000): this write happens EXCLUSIVELY here and
 * ONLY after a confirmed SMTP send. If SMTP is in outage, the caller does
 * NOT invoke this — the next poller pass will re-attempt.
 */
// ---------------------------------------------------------------------------
// Session 4 vague 4 — health / readiness probe queries
// ---------------------------------------------------------------------------

/**
 * Cheapest DB round-trip available. Used by /health/deep to prove that
 * the connection pool is alive and the credentials still work. Success
 * criterion is simply "no error thrown / no supabase error object".
 *
 * We select `id` LIMIT 1 on `cabinets` (a stable table with an index on
 * the primary key). `SELECT 1` is not expressible through supabase-js
 * without a raw RPC; this is the closest equivalent with the same cost.
 *
 * Timeout is passed by the caller (health handler uses 2 s per brief).
 */
export async function pingDb(timeoutMs: number): Promise<void> {
  const supabase = getServiceClient();
  const controller = new AbortController();
  const { error } = await withTimeout(
    supabase
      .from('cabinets')
      .select('id', { head: true, count: 'exact' })
      .limit(1)
      .abortSignal(controller.signal),
    timeoutMs,
    'db:ping',
    { signal: controller },
  );
  if (error) {
    throw new Error(`db_ping_failed: ${error.message}`);
  }
}

/**
 * Latest heartbeat across ALL workers — used by /health/deep to answer
 * "is at least one worker still alive?". We do NOT expose the full row
 * (worker_id embeds hostname/pid, potentially useful topology info) —
 * just the freshest `last_seen_at` and how old it is.
 */
export async function getMostRecentHeartbeat(): Promise<{ last_seen_at: string } | null> {
  const supabase = getServiceClient();
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('worker_heartbeats')
        .select('last_seen_at')
        .order('last_seen_at', { ascending: false })
        .limit(1)
        .abortSignal(signal)
        .maybeSingle<{ last_seen_at: string }>(),
    'db:getMostRecentHeartbeat',
  );
  if (error) {
    throw new Error(`db_get_most_recent_heartbeat_failed: ${error.message}`);
  }
  return data ?? null;
}

/** Atomically persist one call_analyzed event and its two required jobs. */
export async function persistCallAnalyzed(
  input: PersistCallAnalyzedInput,
): Promise<{ appelId: string; duplicate: boolean }> {
  const supabase = getServiceClient();
  const rpcResult = (await withDbTimeout(
    (signal) =>
      supabase
        .rpc('persist_call_analyzed', {
          p_appel: input.appel,
          p_process_payload: input.processAppelPayload,
          p_purge_payload: input.purgeAudioPayload,
          p_purge_run_after: input.purgeRunAfter,
          p_correlation_id: input.correlationId,
        })
        .abortSignal(signal),
    'db:persistCallAnalyzed',
  )) as { data: unknown; error: { message: string } | null };

  if (rpcResult.error) {
    throw new Error(`db_persist_call_analyzed_failed: ${rpcResult.error.message}`);
  }
  const rows = Array.isArray(rpcResult.data)
    ? (rpcResult.data as unknown[])
    : [rpcResult.data];
  const row: unknown = rows[0];
  if (!row || typeof row !== 'object' ||
      typeof (row as { appel_id?: unknown }).appel_id !== 'string' ||
      typeof (row as { duplicate?: unknown }).duplicate !== 'boolean') {
    throw new Error('db_persist_call_analyzed_failed: invalid_result');
  }
  return {
    appelId: (row as { appel_id: string }).appel_id,
    duplicate: (row as { duplicate: boolean }).duplicate,
  };
}

/**
 * Freshest non-null heartbeat of the deletion loop across all workers.
 * A null result is neutral: no deployed worker has started that loop yet.
 */
export async function getMostRecentDeletionPoll(): Promise<{
  last_deletion_poll_at: string;
} | null> {
  const supabase = getServiceClient();
  const { data, error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('worker_heartbeats')
        .select('last_deletion_poll_at')
        .not('last_deletion_poll_at', 'is', null)
        .order('last_deletion_poll_at', { ascending: false })
        .limit(1)
        .abortSignal(signal)
        .maybeSingle<{ last_deletion_poll_at: string }>(),
    'db:getMostRecentDeletionPoll',
  );
  if (error) {
    throw new Error(`db_get_most_recent_deletion_poll_failed: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Row shape returned by public.get_cron_health() (migration
 * 20260801000003). We only project the fields the health check consumes;
 * the RPC returns more (24 h stats, last_status) that we leave for a
 * future admin dashboard.
 */
export interface CronHealthRow {
  jobname: string;
  schedule: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  seconds_since_last_run: number | null;
  seconds_since_last_success: number | null;
  total_runs_last_24h: number;
  failed_runs_last_24h: number;
  first_seen_at: string | null;
}

/**
 * Read the health snapshot of every ACTIVE pg_cron job in the current
 * database. The RPC is SECURITY DEFINER and bounded to the current DB
 * (see migration). Any missing/unhealthy row is interpreted by the
 * caller (services/cron-check.ts).
 */
export async function getCronHealth(): Promise<CronHealthRow[]> {
  const supabase = getServiceClient();
  const rpcResult = (await withDbTimeout(
    (signal) => supabase.rpc('get_cron_health').abortSignal(signal),
    'db:getCronHealth',
  )) as { data: unknown; error: { message: string } | null };
  if (rpcResult.error) {
    throw new Error(`db_get_cron_health_failed: ${rpcResult.error.message}`);
  }
  const rows = Array.isArray(rpcResult.data) ? (rpcResult.data as unknown[]) : [];
  return rows as CronHealthRow[];
}

export async function markDeadLetterAlerted(jobId: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await withDbTimeout(
    (signal) =>
      supabase
        .from('jobs')
        .update({ dead_letter_alerted_at: new Date().toISOString() })
        .eq('id', jobId)
        .abortSignal(signal),
    'db:markDeadLetterAlerted',
  );
  if (error) {
    throw new Error(`db_mark_dead_letter_alerted_failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Physical file-deletion outbox
// ---------------------------------------------------------------------------

export async function claimFileDeletions(
  workerId: string,
  batchSize: number,
  staleAfterSeconds: number,
): Promise<FileDeletion[]> {
  const supabase = getServiceClient();
  const result = (await withDbTimeout(
    (signal) => supabase.rpc('claim_file_deletions', {
      p_worker_id: workerId,
      p_batch_size: batchSize,
      p_stale_after_seconds: staleAfterSeconds,
    }).abortSignal(signal),
    'db:claimFileDeletions',
  )) as { data: unknown; error: { message: string } | null };
  if (result.error) throw new Error(`db_claim_file_deletions_failed: ${result.error.message}`);
  return (Array.isArray(result.data) ? result.data : []) as FileDeletion[];
}

export async function completeFileDeletion(
  deletion: FileDeletion,
  workerId: string,
  status: 'deleted' | 'not_found',
): Promise<'deleted' | 'not_found' | null> {
  const result = (await withDbTimeout(
    (signal) => getServiceClient().rpc('complete_file_deletion', {
      p_deletion_id: deletion.id,
      p_worker_id: workerId,
      // Opaque lease token: never round-trip through Date.
      p_locked_at: deletion.locked_at,
      p_status: status,
    }).abortSignal(signal),
    'db:completeFileDeletion',
  )) as { data: unknown; error: { message: string } | null };
  if (result.error) throw new Error(`db_complete_file_deletion_failed: ${result.error.message}`);
  if (result.data === null) return null;
  if (result.data === 'deleted' || result.data === 'not_found') return result.data;
  throw new Error('db_complete_file_deletion_invalid_result');
}

export async function failFileDeletion(
  deletion: FileDeletion,
  workerId: string,
  errorMessage: string,
  backoffSeconds: number,
): Promise<'pending' | 'dead_letter' | null> {
  const result = (await withDbTimeout(
    (signal) => getServiceClient().rpc('fail_file_deletion', {
      p_deletion_id: deletion.id,
      p_worker_id: workerId,
      // Opaque lease token: never round-trip through Date.
      p_locked_at: deletion.locked_at,
      p_error: errorMessage.slice(0, 500),
      p_backoff_seconds: backoffSeconds,
    }).abortSignal(signal),
    'db:failFileDeletion',
  )) as { data: unknown; error: { message: string } | null };
  if (result.error) throw new Error(`db_fail_file_deletion_failed: ${result.error.message}`);
  if (result.data === null) return null;
  if (result.data === 'pending' || result.data === 'dead_letter') return result.data;
  throw new Error('db_fail_file_deletion_invalid_result');
}

export async function claimFileDeletionDeadLetterAlerts(
  alerterId: string,
  batchSize: number,
  staleAfterSeconds: number,
): Promise<FileDeletion[]> {
  const result = (await withDbTimeout(
    (signal) => getServiceClient().rpc('claim_file_deletion_dead_letter_alerts', {
      p_alerter_id: alerterId,
      p_batch_size: batchSize,
      p_stale_after_seconds: staleAfterSeconds,
    }).abortSignal(signal),
    'db:claimFileDeletionDeadLetterAlerts',
  )) as { data: unknown; error: { message: string } | null };
  if (result.error) {
    throw new Error(`db_claim_file_deletion_dead_letter_alerts_failed: ${result.error.message}`);
  }
  return (Array.isArray(result.data) ? result.data : []) as FileDeletion[];
}

export async function markFileDeletionDeadLetterAlerted(
  deletionId: string,
  alerterId: string,
  alertLockedAt: string,
): Promise<boolean> {
  const result = (await withDbTimeout(
    (signal) => getServiceClient().rpc('mark_file_deletion_dead_letter_alerted', {
      p_deletion_id: deletionId,
      p_alerter_id: alerterId,
      // Opaque lease token: never round-trip through Date.
      p_alert_locked_at: alertLockedAt,
    }).abortSignal(signal),
    'db:markFileDeletionDeadLetterAlerted',
  )) as { data: unknown; error: { message: string } | null };
  if (result.error) {
    throw new Error(`db_mark_file_deletion_dead_letter_alerted_failed: ${result.error.message}`);
  }
  if (typeof result.data !== 'boolean') {
    throw new Error('db_mark_file_deletion_dead_letter_alerted_invalid_result');
  }
  return result.data;
}

export async function releaseFileDeletionDeadLetterAlert(
  deletionId: string,
  alerterId: string,
  alertLockedAt: string,
): Promise<boolean> {
  const result = (await withDbTimeout(
    (signal) => getServiceClient().rpc('release_file_deletion_dead_letter_alert', {
      p_deletion_id: deletionId,
      p_alerter_id: alerterId,
      // Opaque lease token: never round-trip through Date.
      p_alert_locked_at: alertLockedAt,
    }).abortSignal(signal),
    'db:releaseFileDeletionDeadLetterAlert',
  )) as { data: unknown; error: { message: string } | null };
  if (result.error) {
    throw new Error(`db_release_file_deletion_dead_letter_alert_failed: ${result.error.message}`);
  }
  if (typeof result.data !== 'boolean') {
    throw new Error('db_release_file_deletion_dead_letter_alert_invalid_result');
  }
  return result.data;
}

export async function getWave7ContractVersion(): Promise<number> {
  const result = (await withDbTimeout(
    (signal) => getServiceClient().rpc('get_wave7_contract_version').abortSignal(signal),
    'db:getWave7ContractVersion',
  )) as { data: unknown; error: { message: string } | null };
  if (result.error) throw new Error(`db_get_wave7_contract_version_failed: ${result.error.message}`);
  if (typeof result.data !== 'number') throw new Error('db_wave7_contract_version_invalid');
  return result.data;
}

export async function workerHeartbeatDeletionPoll(
  workerId: string,
  deletionsProcessedDelta: number,
): Promise<void> {
  const { error } = await withDbTimeout(
    (signal) => getServiceClient().rpc('worker_heartbeat_deletion_poll', {
      p_worker_id: workerId,
      p_deletions_processed_delta: deletionsProcessedDelta,
    }).abortSignal(signal),
    'db:workerHeartbeatDeletionPoll',
  );
  if (error) throw new Error(`db_worker_deletion_poll_failed: ${error.message}`);
}

/** Persist one authenticated, PII-free Cal.com lifecycle event atomically. */
export async function persistCalcomBookingEvent(
  input: CalcomBookingEventInput,
): Promise<CalcomBookingEventResult> {
  const supabase = getServiceClient();
  const result = await withDbTimeout(
    (signal) =>
      supabase
        .rpc('persist_calcom_booking_event', {
          p_event_key: input.eventKey,
          p_trigger_event: input.triggerEvent,
          p_provider_created_at: input.providerCreatedAt,
          p_provider_booking_uid: input.providerBookingUid,
          p_reschedule_uid: input.rescheduleUid,
          p_event_type_id: input.eventTypeId,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
        })
        .abortSignal(signal),
    'db:persistCalcomBookingEvent',
  ) as {
    data: unknown;
    error: { message: string } | null;
  };

  if (result.error) throw new Error('db_persist_calcom_booking_event_failed');
  const rows: unknown[] = Array.isArray(result.data) ? result.data : [];
  const row: unknown = rows[0] ?? null;
  if (!row || typeof row !== 'object') {
    throw new Error('db_persist_calcom_booking_event_invalid_result');
  }
  const value = row as Record<string, unknown>;
  if (
    (typeof value.booking_id !== 'string' && value.booking_id !== null) ||
    typeof value.cabinet_id !== 'string' ||
    (typeof value.source_appel_id !== 'string' && value.source_appel_id !== null) ||
    (value.outcome !== 'applied' && value.outcome !== 'duplicate')
  ) {
    throw new Error('db_persist_calcom_booking_event_invalid_result');
  }

  return {
    bookingId: value.booking_id,
    cabinetId: value.cabinet_id,
    sourceAppelId: value.source_appel_id,
    outcome: value.outcome,
  };
}

/** Reconcile the opposite delivery order: Retell call after Cal.com event. */
export async function reconcileCalendarBookingForAppel(
  appelId: string,
  cabinetId: string,
  callStartedAt: string,
  callEndedAt: string,
  bookingStartAt: string | null,
): Promise<string | null> {
  const supabase = getServiceClient();
  const result = await withDbTimeout(
    (signal) =>
      supabase
        .rpc('reconcile_calendar_booking_for_appel', {
          p_appel_id: appelId,
          p_cabinet_id: cabinetId,
          p_call_started_at: callStartedAt,
          p_call_ended_at: callEndedAt,
          p_booking_start_at: bookingStartAt,
        })
        .abortSignal(signal),
    'db:reconcileCalendarBookingForAppel',
  ) as { data: unknown; error: { message: string } | null };

  if (result.error) throw new Error('db_reconcile_calendar_booking_failed');
  if (result.data === null || typeof result.data === 'string') return result.data;
  throw new Error('db_reconcile_calendar_booking_invalid_result');
}

// ---------------------------------------------------------------------------
// Portal administration queries
// ---------------------------------------------------------------------------

const PORTAL_CALL_COLUMNS = [
  'id',
  'cabinet_id',
  'date_appel',
  'duree_secondes',
  'resultat',
  'motif_appel',
  'rdv_date',
  'rdv_praticien',
  'pdf_url',
  'pdf_envoye_at',
  'email_status',
  'created_at',
].join(', ');

const PORTAL_CABINET_COLUMNS = [
  'id',
  'nom',
  'type_cabinet',
  'adresse',
  'npa',
  'ville',
  'email_notification',
  'email_notification_cc',
  'statut',
  'config_agent',
  'updated_at',
].join(', ');

/** Validate a bearer token through Supabase Auth before service-role access. */
export async function authenticatePortalAccessToken(
  token: string,
): Promise<PortalAuthUser | null> {
  const authClient = getAuthClient();
  if (!authClient) throw new Error('portal_auth_not_configured');

  const { data, error } = await withTimeout(
    authClient.auth.getUser(token),
    env.TIMEOUT_AUTH_MS,
    'auth:getUser',
  );

  if (error) {
    const status = typeof error.status === 'number' ? error.status : 0;
    if (status === 400 || status === 401 || status === 403) return null;
    throw new Error('portal_auth_unavailable');
  }
  if (!data.user) return null;

  const metadata = data.user.user_metadata;
  const candidate =
    typeof metadata.full_name === 'string'
      ? metadata.full_name
      : typeof metadata.name === 'string'
        ? metadata.name
        : '';
  return {
    id: data.user.id,
    email: data.user.email ?? '',
    displayName: candidate.trim().slice(0, 120),
  };
}

/**
 * Re-read active memberships on every request. When no cabinet is requested,
 * ordering by cabinet_id makes multi-cabinet selection deterministic.
 */
export async function resolvePortalMembership(
  userId: string,
  requestedCabinetId?: string,
): Promise<PortalMembership | null> {
  const supabase = getServiceClient();
  let query = supabase
    .from('cabinet_memberships')
    .select('cabinet_id, role')
    .eq('user_id', userId)
    .eq('actif', true)
    .order('cabinet_id', { ascending: true })
    .limit(1);
  if (requestedCabinetId !== undefined) {
    query = query.eq('cabinet_id', requestedCabinetId);
  }
  const { data, error } = await withDbTimeout(
    (signal) => query.abortSignal(signal).maybeSingle<{ cabinet_id: string; role: 'admin' | 'viewer' }>(),
    'db:resolvePortalMembership',
  );
  if (error) throw new Error('portal_membership_lookup_failed');
  return data ? { cabinetId: data.cabinet_id, role: data.role } : null;
}

/** List only this authenticated user's active cabinet memberships. */
export async function listPortalPractices(userId: string): Promise<PortalPractice[]> {
  const { data, error } = await withDbTimeout(
    (signal) =>
      getServiceClient()
        .from('cabinet_memberships')
        .select('cabinet_id, role, cabinets!inner(id, nom)')
        .eq('user_id', userId)
        .eq('actif', true)
        .order('cabinet_id', { ascending: true })
        .abortSignal(signal),
    'db:listPortalPractices',
  );
  if (error) throw new Error('portal_practices_list_failed');

  const practices: PortalPractice[] = [];
  for (const value of (data ?? []) as unknown[]) {
    if (typeof value !== 'object' || value === null) continue;
    const row = value as Record<string, unknown>;
    const joined = row.cabinets;
    if (typeof joined !== 'object' || joined === null || Array.isArray(joined)) continue;
    const cabinet = joined as Record<string, unknown>;
    if (
      typeof cabinet.id === 'string'
      && typeof cabinet.nom === 'string'
      && (row.role === 'admin' || row.role === 'viewer')
    ) {
      practices.push({ id: cabinet.id, name: cabinet.nom, role: row.role });
    }
  }
  return practices;
}

export async function getPortalCabinet(cabinetId: string): Promise<PortalCabinetRow | null> {
  const { data, error } = await withDbTimeout(
    (signal) =>
      getServiceClient()
        .from('cabinets')
        .select(PORTAL_CABINET_COLUMNS)
        .eq('id', cabinetId)
        .abortSignal(signal)
        .maybeSingle<PortalCabinetRow>(),
    'db:getPortalCabinet',
  );
  if (error) throw new Error('portal_cabinet_lookup_failed');
  return data ?? null;
}

function portalPeriodStart(period: PortalCallsQuery['period']): string {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function applyPortalCallFilters<T extends {
  gte(column: string, value: string): T;
  eq(column: string, value: string): T;
  not(column: string, operator: string, value: null): T;
  or(filters: string): T;
}>(query: T, filters: PortalCallsQuery): T {
  let filtered = query.gte('date_appel', portalPeriodStart(filters.period));
  if (filters.outcome) filtered = filtered.eq('resultat', filters.outcome);
  if (filters.practitionerId) filtered = filtered.eq('rdv_praticien', filters.practitionerId);
  if (filters.summaryStatus === 'complete') {
    filtered = filtered.not('pdf_url', 'is', null).eq('email_status', 'sent');
  } else if (filters.summaryStatus === 'pending') {
    filtered = filtered.eq('email_status', 'pending');
  } else if (filters.summaryStatus === 'failed') {
    filtered = filtered.or('email_status.eq.failed,email_status.eq.bounced');
  }
  return filtered;
}

export async function listPortalCalls(
  cabinetId: string,
  filters: PortalCallsQuery,
): Promise<{ rows: PortalCallRow[]; total: number }> {
  const supabase = getServiceClient();
  const start = (filters.page - 1) * filters.pageSize;
  let query = supabase
    .from('appels')
    .select(PORTAL_CALL_COLUMNS, { count: 'exact' })
    .eq('cabinet_id', cabinetId);
  query = applyPortalCallFilters(query, filters);
  const sortDuration = filters.sort.startsWith('duration_');
  const ascending = filters.sort.endsWith('_asc');
  query = query.order(sortDuration ? 'duree_secondes' : 'date_appel', {
    ascending,
    nullsFirst: false,
  });
  if (sortDuration) {
    query = query.order('date_appel', { ascending, nullsFirst: false });
  }
  query = query.order('id', { ascending });
  const { data, error, count } = await withDbTimeout(
    (signal) => query.range(start, start + filters.pageSize - 1).abortSignal(signal),
    'db:listPortalCalls',
  );
  if (error) throw new Error('portal_calls_list_failed');
  return { rows: (data ?? []) as unknown as PortalCallRow[], total: count ?? 0 };
}

function portalDashboardNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Read exact dashboard aggregates and recent calls from one SQL snapshot. */
export async function getPortalDashboardSnapshot(
  cabinetId: string,
  period: PortalCallsQuery['period'],
): Promise<PortalDashboardSnapshot> {
  const result = await withDbTimeout(
    (signal) => getServiceClient()
      .rpc('get_portal_dashboard_snapshot', {
        p_cabinet_id: cabinetId,
        p_period: period,
      })
      .abortSignal(signal),
    'db:getPortalDashboardSnapshot',
  ) as unknown as { data: unknown; error: unknown };
  if (typeof result.error === 'object' && result.error !== null) {
    const rpcError = result.error as Record<string, unknown>;
    if (rpcError.code === 'P0002') throw new Error('portal_cabinet_not_found');
  }
  if (result.error) throw new Error('portal_dashboard_snapshot_failed');

  const values = Array.isArray(result.data) ? result.data as unknown[] : [];
  const value: unknown = values[0] ?? null;
  if (typeof value !== 'object' || value === null) {
    throw new Error('portal_dashboard_snapshot_failed');
  }
  const row = value as Record<string, unknown>;
  const totalCalls = portalDashboardNumber(row.total_calls);
  const totalDurationSeconds = portalDashboardNumber(row.total_duration_seconds);
  const appointments = portalDashboardNumber(row.appointments);
  if (
    typeof row.period_start !== 'string'
    || totalCalls === null
    || totalDurationSeconds === null
    || appointments === null
    || !Array.isArray(row.volume_by_date)
    || !Array.isArray(row.outcomes)
    || !Array.isArray(row.recent_calls)
  ) {
    throw new Error('portal_dashboard_snapshot_failed');
  }

  return {
    periodStart: row.period_start,
    totalCalls,
    totalDurationSeconds,
    appointments,
    volume: row.volume_by_date as PortalDashboardSnapshot['volume'],
    outcomes: row.outcomes as PortalDashboardSnapshot['outcomes'],
    recentCalls: row.recent_calls as PortalDashboardSnapshot['recentCalls'],
  };
}

export async function getPortalCall(
  cabinetId: string,
  callId: string,
): Promise<PortalCallRow | null> {
  const { data, error } = await withDbTimeout(
    (signal) =>
      getServiceClient()
        .from('appels')
        .select(PORTAL_CALL_COLUMNS)
        .eq('cabinet_id', cabinetId)
        .eq('id', callId)
        .abortSignal(signal)
        .maybeSingle<PortalCallRow>(),
    'db:getPortalCall',
  );
  if (error) throw new Error('portal_call_lookup_failed');
  return data ?? null;
}

export async function listPortalTeam(cabinetId: string): Promise<PortalTeamRow[]> {
  const { data, error } = await withDbTimeout(
    (signal) =>
      getServiceClient()
        .from('cabinet_memberships')
        .select('user_id, role, actif, created_at')
        .eq('cabinet_id', cabinetId)
        .order('created_at', { ascending: true })
        .abortSignal(signal),
    'db:listPortalTeam',
  );
  if (error) throw new Error('portal_team_list_failed');
  return data ?? [];
}

/**
 * Apply the allowlisted cabinet delta and its technical audit event in the
 * same PostgreSQL transaction. The RPC performs the config merge while
 * holding the cabinet row lock. Only serialization conflicts are retried.
 */
export async function applyPortalCabinetPatchWithAudit(
  cabinetId: string,
  actorUserId: string,
  action: 'settings_updated' | 'assistant_updated',
  patch: PortalCabinetPatch,
  changedFields: string[],
  initialExpectedUpdatedAt: string,
): Promise<PortalCabinetRow> {
  let expectedUpdatedAt = initialExpectedUpdatedAt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = (await withDbTimeout(
      (signal) =>
        getServiceClient()
          .rpc('apply_portal_cabinet_patch_with_audit', {
            p_cabinet_id: cabinetId,
            p_actor_user_id: actorUserId,
            p_action: action,
            p_expected_updated_at: expectedUpdatedAt,
            p_patch: patch,
            p_changed_fields: changedFields,
          })
          .abortSignal(signal),
      'db:applyPortalCabinetPatchWithAudit',
    )) as {
      data: unknown;
      error: { code?: string; message: string } | null;
    };

    if (!result.error) {
      const row: unknown = Array.isArray(result.data) ? result.data[0] : null;
      if (typeof row !== 'object' || row === null) {
        throw new Error('portal_cabinet_atomic_update_invalid_result');
      }
      return row as PortalCabinetRow;
    }
    if (result.error.code === 'P0002') throw new Error('portal_cabinet_not_found');
    if (result.error.code === '42501') throw new Error('portal_admin_membership_required');
    if (result.error.code !== '40001') throw new Error('portal_cabinet_atomic_update_failed');
    if (attempt === 2) break;

    const current = await getPortalCabinet(cabinetId);
    if (!current) throw new Error('portal_cabinet_not_found');
    expectedUpdatedAt = current.updated_at;
  }
  throw new Error('portal_cabinet_concurrent_update');
}
