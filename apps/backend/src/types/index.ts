/**
 * Shared types across the backend.
 *
 * The Retell payload type mirrors the fields the backend consumes; it is
 * NOT an exhaustive mirror of Retell's schema. We only pull what we need.
 */

/**
 * The single Retell webhook event we handle today. `call_analyzed` is the
 * moment where the transcript and structured analysis are ready — we do NOT
 * subscribe to `call_ended` because it fires earlier and lacks analysis.
 *
 * Fields marked optional here reflect Retell's contract: e.g. `from_number`
 * is absent on web calls, `recording_url` may take a few seconds to appear.
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
