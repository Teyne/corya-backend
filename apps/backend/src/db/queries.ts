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
import { getServiceClient } from '../config/supabase.js';
import type {
  AppelInsertRow,
  AppelProcessingRow,
  CabinetProcessingRow,
  Job,
  JobInsertRow,
  ProcessAppelPayload,
} from '../types/index.js';

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
  const { data, error } = await supabase
    .from('cabinets')
    .select('id, numero_corya, email_notification, email_notification_cc')
    .eq('numero_corya', toNumber)
    .eq('statut', 'actif')
    .maybeSingle<CabinetRow>();

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
  const { data, error } = await supabase
    .from('appels')
    .insert(row)
    .select('id')
    .single<{ id: string }>();

  if (!error && data) {
    return { appelId: data.id, duplicate: false };
  }

  // Postgres unique_violation. Supabase surfaces it as code '23505'.
  if (error && error.code === '23505') {
    const { data: existing, error: lookupErr } = await supabase
      .from('appels')
      .select('id')
      .eq('retell_call_id', row.retell_call_id)
      .single<{ id: string }>();
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
  const { error } = await supabase.from('jobs').insert(row);

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
 * Reserve up to `batchSize` due jobs for this worker. The RPC atomically
 * flips their status to 'processing', stamps `locked_by = workerId`, and
 * INCREMENTS `attempts` — so the returned `attempts` value already reflects
 * the current try (use it as-is for backoff decisions).
 *
 * Concurrent workers see disjoint rows thanks to the RPC's internal
 * SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * Returns [] when no jobs are ready. Never throws on empty result.
 */
export async function claimJobs(
  workerId: string,
  batchSize: number,
): Promise<Job[]> {
  const supabase = getServiceClient();
  // Supabase-js types RPC results as `any` (no generated types file). We
  // cast the RESULT object to a narrow shape before destructuring so
  // downstream code stays typed. Anything the RPC contract violates
  // (e.g. non-array data) is silently coerced to an empty array.
  const rpcResult = (await supabase.rpc('claim_jobs', {
    p_worker_id: workerId,
    p_batch_size: batchSize,
  })) as { data: unknown; error: { message: string } | null };
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
  const { error } = await supabase.rpc('complete_job', { p_job_id: jobId });
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
  const { error } = await supabase.rpc('fail_job', {
    p_job_id: jobId,
    p_error: errorMessage,
    p_backoff_seconds: backoffSeconds,
  });
  if (error) {
    throw new Error(`db_fail_job_failed: ${error.message}`);
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
  const { error } = await supabase
    .from('jobs')
    .update({ payload })
    .eq('id', jobId);
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
  const { data, error } = await supabase
    .from('appels')
    .select(
      'id, cabinet_id, retell_call_id, date_appel, duree_secondes, resultat, motif_appel, patient_nom, patient_prenom, patient_telephone, rdv_date, rdv_praticien, transcript, pdf_url, email_status',
    )
    .eq('id', appelId)
    .maybeSingle<AppelProcessingRow>();
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
  const { data, error } = await supabase
    .from('cabinets')
    .select('id, nom, email_notification, email_notification_cc, statut')
    .eq('id', cabinetId)
    .maybeSingle<CabinetProcessingRow>();
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
  const { error } = await supabase
    .from('appels')
    .update({ pdf_url: objectPath })
    .eq('id', appelId);
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
  const { error } = await supabase
    .from('appels')
    .update({
      email_status: 'sent',
      pdf_envoye_at: new Date().toISOString(),
    })
    .eq('id', appelId);
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
  const { error } = await supabase
    .from('appels')
    .update({ email_status: 'failed' })
    .eq('id', appelId);
  if (error) {
    throw new Error(`db_mark_email_failed_failed: ${error.message}`);
  }
}
