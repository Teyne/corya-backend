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

export type JobType =
  | 'process_call'
  | 'generate_pdf'
  | 'send_email'
  | 'purge_audio_retell';

export interface JobInsertRow {
  type: JobType;
  appel_id: string;
  payload: Record<string, unknown>;
  run_after?: string; // ISO 8601, defaults to NOW() server-side if omitted
}
