/**
 * Shared types across the backend.
 *
 * The Retell payload type mirrors the fields the backend consumes; it is
 * NOT an exhaustive mirror of Retell's schema. We only pull what we need.
 */

/**
 * Retell emits THREE events per phone call:
 *   1. `call_started`  — agent picked up (no transcript/analysis)
 *   2. `call_ended`    — call finished (still no analysis)
 *   3. `call_analyzed` — analysis complete, transcript + custom fields ready
 *
 * Only `call_analyzed` drives business logic; the other two are logged and
 * acknowledged with 200. All three arrive on the same endpoint (see
 * routes/webhooks.ts).
 *
 * Fields marked optional on `call_analyzed` reflect Retell's contract:
 * e.g. `from_number` is absent on web calls, `recording_url` may take a few
 * seconds to appear.
 */

/**
 * `call_started` — minimal shape. We only rely on `call_id` for correlation
 * logs. Any additional field Retell adds is tolerated (validation uses
 * passthrough).
 */
export interface RetellCallStarted {
  event: 'call_started';
  call: {
    call_id: string;
    call_type?: 'phone_call' | 'web_call';
    agent_id?: string;
    agent_name?: string;
    call_status?: string;
    start_timestamp?: number;
    [key: string]: unknown;
  };
  event_timestamp?: number;
  [key: string]: unknown;
}

/**
 * `call_ended` — same minimal contract as `call_started`. Kept as a distinct
 * type to make the discriminated union in retell.ts unambiguous.
 */
export interface RetellCallEnded {
  event: 'call_ended';
  call: {
    call_id: string;
    call_type?: 'phone_call' | 'web_call';
    [key: string]: unknown;
  };
  event_timestamp?: number;
  [key: string]: unknown;
}

/**
 * `call_analyzed` — the event we actually process. This IS a strict shape:
 * anything the backend reads is validated by zod.
 */
export interface RetellCallAnalyzed {
  event: 'call_analyzed';
  call: {
    call_id: string;
    agent_id: string;
    call_type: 'phone_call' | 'web_call';
    call_status: string;
    from_number?: string;
    to_number?: string;
    duration_ms?: number;
    start_timestamp: number;
    end_timestamp?: number;
    disconnect_reason?: string;
    transcript?: string;
    recording_url?: string;
    public_log_url?: string;
    call_analysis?: {
      call_summary?: string;
      user_sentiment?: 'Positive' | 'Neutral' | 'Negative' | 'Unknown';
      call_successful?: boolean;
      custom_analysis_data?: Record<string, unknown>;
    };
  };
}

/** Discriminated union of every Retell event we accept. */
export type RetellWebhookEvent =
  | RetellCallStarted
  | RetellCallEnded
  | RetellCallAnalyzed;

/**
 * Result of a webhook processing run. Purely for internal logging + tests;
 * never sent to Retell.
 */
export type WebhookProcessResult =
  | { kind: 'inserted'; appelId: string; cabinetId: string }
  | { kind: 'duplicate'; retellCallId: string }
  | { kind: 'cabinet_not_found'; toNumber: string };

/**
 * Shape of the row inserted into `public.appels`. Kept close to the SQL
 * migration; any drift is a bug.
 */
export interface AppelInsertRow {
  cabinet_id: string;
  retell_call_id: string;
  date_appel: string; // ISO 8601
  duree_secondes: number | null;
  numero_appelant_hash: string | null;
  numero_appelant_masque: string | null;
  resultat: AppelResultat | null;
  motif_appel: string | null;
  patient_nom: string | null;
  patient_prenom: string | null;
  patient_telephone: string | null;
  rdv_date: string | null;
  rdv_praticien: string | null;
  transcript: string | null;
  transcript_anonymise: string | null;
  audio_url: string | null;
  audio_expires_at: string | null;
  // NOTE: pdf_url is INTENTIONALLY not inserted here. Convention (see
  // supabase/migrations/20260730130000): pdf_url stores the Storage OBJECT
  // PATH `{cabinet_id}/{yyyy-mm}/{appel_id}.pdf`, filled ONLY by the
  // generate_pdf worker once the PDF is uploaded. Storing a signed URL here
  // would break the 24-month Storage purge which parses this field.
}

export type AppelResultat =
  | 'rdv_pris'
  | 'message'
  | 'transfere'
  | 'urgence'
  | 'echec'
  | 'refus';

/**
 * All job type discriminators accepted by the `jobs.type` CHECK constraint.
 *
 * Historical values (`process_call`, `generate_pdf`, `send_email`) are kept
 * for backwards compatibility with rows possibly still present in the DB from
 * earlier sessions. `process_appel` is the current canonical value: a single
 * monolithic job that runs the full post-call pipeline (PDF -> Storage
 * upload -> email), with per-step checkpoints in its `payload` for
 * idempotency at retry.
 *
 * `purge_audio_retell` remains a distinct job scheduled ~48 h after the call.
 */
export type JobType =
  | 'process_call'
  | 'generate_pdf'
  | 'send_email'
  | 'purge_audio_retell'
  | 'process_appel';

export interface JobInsertRow {
  type: JobType;
  appel_id: string;
  payload: Record<string, unknown>;
  run_after?: string; // ISO 8601, defaults to NOW() server-side if omitted
  /**
   * Session 4: opaque correlation key stamped by the webhook handler for
   * end-to-end log tracing. Column is nullable in DB (migration
   * 20260801000002) so pre-Session-4 rows and legacy tests without the
   * field remain valid.
   */
  correlation_id?: string | null;
}

/**
 * A row returned by the `claim_jobs` RPC — mirrors `public.jobs`.
 *
 * The RPC already flipped `status` to `'processing'` and INCREMENTED
 * `attempts`, so this value reflects the post-claim state. The worker uses
 * `attempts` directly for its backoff computation.
 *
 * Session 4 additions:
 *   - `correlation_id` : opaque tracing key stamped by the webhook at enqueue
 *     time (see migration 20260801000002). NULL for jobs enqueued before the
 *     migration.
 *   - `dead_letter_alerted_at` : audit flag set EXCLUSIVELY by the API-side
 *     poller AFTER a successful alert email (see migration 20260801000000).
 *     Backend never mutates this from any other path.
 */
export interface Job {
  id: string;
  type: JobType;
  appel_id: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  correlation_id: string | null;
  dead_letter_alerted_at: string | null;
}

/** A claimed physical-deletion order. Contains technical identifiers only. */
export interface FileDeletion {
  id: string;
  target: 'supabase_storage' | 'retell_audio';
  bucket: string | null;
  object_path: string | null;
  external_ref: string | null;
  reason: 'audio_expired_48h' | 'appel_purged_24m' | 'gdpr_erasure_request' | 'manual_admin_deletion';
  status: 'pending' | 'processing' | 'deleted' | 'failed' | 'dead_letter' | 'not_found';
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  source_appel_id: string | null;
  source_cabinet_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * A row from `public.cabinets` — only the columns the worker reads.
 * `statut` gates whether the pipeline actually runs (paused/terminated
 * cabinets short-circuit successfully with no PDF and no email).
 */
export interface CabinetProcessingRow {
  id: string;
  nom: string;
  email_notification: string;
  email_notification_cc: string | null;
  statut: 'actif' | 'pause' | 'resilie';
}

/**
 * A row from `public.appels` — only the columns the worker reads (i.e. the
 * data the PDF and the email need). Purposefully NOT re-exporting the full
 * shape: the worker must never fetch or hold on to fields it does not need.
 */
export interface AppelProcessingRow {
  id: string;
  cabinet_id: string;
  retell_call_id: string;
  date_appel: string;
  duree_secondes: number | null;
  resultat: AppelResultat | null;
  motif_appel: string | null;
  patient_nom: string | null;
  patient_prenom: string | null;
  patient_telephone: string | null;
  rdv_date: string | null;
  rdv_praticien: string | null;
  transcript: string | null;
  pdf_url: string | null;
  email_status: 'pending' | 'sent' | 'failed' | 'bounced';
}

/**
 * ---------------------------------------------------------------------------
 * `process_appel` job payload — persistent checkpoint schema
 * ---------------------------------------------------------------------------
 *
 * Written into `jobs.payload` (JSONB). Every field is OPTIONAL because a
 * retry may find the row in any intermediate state, including the very first
 * shape produced by the webhook handler (`{ to, cc, version: 1 }`).
 *
 * Idempotence contract, in order:
 *   1. If `steps.pdf_uploaded_at` is set AND `steps.storage_path` is set,
 *      SKIP PDF generation and Storage upload.
 *   2. If `steps.email_sent_at` is set, SKIP the email send. Combined with
 *      the defence-in-depth read on `appels.email_status === 'sent'`, an
 *      email is NEVER sent twice for the same appel.
 *
 * We deliberately store a MONOTONIC schema version so a future breaking
 * change is a schema bump rather than a silent shape drift. Missing
 * `version` is treated as v1 for graceful reads.
 */
export interface ProcessAppelPayload {
  /** Payload schema version. Missing = 1. Bump on breaking changes. */
  version?: number;
  /** Primary recipient of the email (cabinet.email_notification). */
  to?: string;
  /** Optional CC recipient (cabinet.email_notification_cc). */
  cc?: string | null;
  /** Progress checkpoints — see file-level idempotence contract. */
  steps?: {
    /** ISO timestamp when the PDF was uploaded to Supabase Storage. */
    pdf_uploaded_at?: string;
    /** Storage object path — `{cabinet_id}/{yyyy-mm}/{appel_id}.pdf`. */
    storage_path?: string;
    /** ISO timestamp when the email was successfully accepted by SMTP. */
    email_sent_at?: string;
  };
  /**
   * Index signature to allow this interface to satisfy JSONB Record shapes
   * expected by `JobInsertRow.payload`. Only the fields above are read by
   * the pipeline — extras are tolerated (forward-compat).
   */
  [key: string]: unknown;
}
