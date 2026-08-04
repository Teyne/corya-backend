/**
 * End-to-end orchestration for a validated Retell `call_analyzed` payload.
 *
 * The HTTP route waits for this orchestration before acknowledging Retell.
 * Its database RPC is bounded and atomic; a failure intentionally becomes
 * a 5xx so Retell can replay without leaving partial durable state.
 *
 * Steps:
 *   1. Resolve cabinet from `to_number`
 *   2. Extract structured fields (patient, motif, rdv) from
 *      `call_analysis.custom_analysis_data` — best-effort, all optional
 *   3. Insert `appels` row (idempotent on retell_call_id)
 *   4. Enqueue jobs:
 *        - `process_appel` (monolithic PDF -> upload -> email pipeline;
 *          idempotent via per-step checkpoints stored in jobs.payload)
 *        - `purge_audio_retell` scheduled at date_appel + 48 h
 *
 * PII handling:
 *   - `patient_telephone` (raw) goes into DB (purged at J+7 by DB cron)
 *   - `numero_appelant_hash` + `numero_appelant_masque` live longer for
 *     analytics
 *   - Nothing PII ever transits through log messages (only field names in
 *     structured log objects, which the logger sanitizer censors)
 */
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { findCabinetByCoryaNumber, persistCallAnalyzed } from '../db/queries.js';
import type {
  AppelInsertRow,
  AppelResultat,
  ProcessAppelPayload,
  RetellCallAnalyzed,
  WebhookProcessResult,
} from '../types/index.js';
import { hashPhoneNumber, maskPhoneNumber } from '../utils/redact.js';

const KNOWN_RESULTATS: ReadonlySet<AppelResultat> = new Set<AppelResultat>([
  'rdv_pris',
  'message',
  'transfere',
  'urgence',
  'echec',
  'refus',
]);

function pickString(
  bag: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!bag) return null;
  const v = bag[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function pickResultat(
  bag: Record<string, unknown> | undefined,
): AppelResultat | null {
  const raw = pickString(bag, 'resultat');
  if (!raw) return null;
  return KNOWN_RESULTATS.has(raw as AppelResultat)
    ? (raw as AppelResultat)
    : null;
}

function pickIsoDate(
  bag: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const raw = pickString(bag, key);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Compute audio_expires_at = date_appel + AUDIO_RETENTION_HOURS.
 * This MUST be set at insert time; the hourly pg_cron purge relies on it.
 */
function computeAudioExpiresAt(dateAppelIso: string): string {
  const d = new Date(dateAppelIso);
  d.setUTCMilliseconds(d.getUTCMilliseconds() + env.AUDIO_RETENTION_HOURS * 3_600_000);
  return d.toISOString();
}

export async function processCallAnalyzed(
  payload: RetellCallAnalyzed,
  correlationId: string | null = null,
): Promise<WebhookProcessResult> {
  const call = payload.call;
  const retellCallId = call.call_id;
  // Session 4 vague 3: the correlation id comes from the HTTP request
  // via middleware/correlation.ts. `retell_call_id` remains a distinct
  // log field — it is NOT a correlation id (multiple Retell events
  // arrive for the same call), but it is the strongest business
  // identifier we have.
  const logCtx = { retell_call_id: retellCallId, correlation_id: correlationId };

  // 1. Cabinet lookup ----------------------------------------------------
  if (!call.to_number) {
    logger.warn(
      logCtx,
      'webhook_missing_to_number — cannot route to cabinet',
    );
    return { kind: 'cabinet_not_found', toNumber: '' };
  }

  const cabinet = await findCabinetByCoryaNumber(call.to_number);
  if (!cabinet) {
    // to_number is a Corya-owned line, safe to log (not a patient number).
    logger.warn(
      { ...logCtx, to_number: call.to_number },
      'webhook_no_cabinet_for_to_number',
    );
    return { kind: 'cabinet_not_found', toNumber: call.to_number };
  }

  // 2. Extract structured fields ----------------------------------------
  const custom = call.call_analysis?.custom_analysis_data;

  const dateAppelIso = new Date(call.start_timestamp).toISOString();
  const dureeSecondes =
    typeof call.duration_ms === 'number'
      ? Math.round(call.duration_ms / 1000)
      : null;

  const numeroBrut = call.from_number ?? null;
  const numeroHash = numeroBrut ? hashPhoneNumber(numeroBrut) : null;
  const numeroMasque = numeroBrut ? maskPhoneNumber(numeroBrut) : null;

  const audioUrl = call.recording_url ?? null;
  const audioExpiresAt = audioUrl ? computeAudioExpiresAt(dateAppelIso) : null;

  const row: AppelInsertRow = {
    cabinet_id: cabinet.id,
    retell_call_id: call.call_id,
    date_appel: dateAppelIso,
    duree_secondes: dureeSecondes,
    numero_appelant_hash: numeroHash,
    numero_appelant_masque: numeroMasque,
    resultat: pickResultat(custom),
    motif_appel: pickString(custom, 'motif_appel'),
    patient_nom: pickString(custom, 'patient_nom'),
    patient_prenom: pickString(custom, 'patient_prenom'),
    // Prefer the number the patient GAVE the agent (custom analysis) over the
    // caller-ID, which may be withheld. Fall back to caller-ID otherwise.
    patient_telephone: pickString(custom, 'patient_telephone') ?? numeroBrut,
    rdv_date: pickIsoDate(custom, 'rdv_date'),
    rdv_praticien: pickString(custom, 'rdv_praticien'),
    transcript: call.transcript ?? null,
    transcript_anonymise: null, // filled later by an analytics job
    audio_url: audioUrl,
    audio_expires_at: audioExpiresAt,
  };

  // 3. Persist the appel and both post-processing jobs atomically --------
  // Session 3 change: the historical `generate_pdf` + `send_email` split
  // was collapsed into ONE monolithic `process_appel` job. The worker
  // (src/workers/job-worker.ts) walks the pipeline PDF -> upload -> email
  // atomically from the caller's perspective, using per-step checkpoints
  // written into jobs.payload to stay idempotent across retries.
  //
  // Both enqueues are independently idempotent thanks to the unique
  // partial index on (type, appel_id) WHERE status IN ('pending',
  // 'processing').

  const processAppelPayload: ProcessAppelPayload = {
    version: 1,
    to: cabinet.email_notification,
    cc: cabinet.email_notification_cc,
    steps: {},
  };
  // Session 4 vague 3 : le correlation_id posé ici est l'ID de REQUÊTE
  // HTTP (généré par middleware/correlation.ts). C'est ce qui permet de
  // suivre une même requête webhook du log HTTP jusqu'aux logs du worker.
  // retell_call_id reste un champ de log distinct — utile mais pas un
  // correlation id (plusieurs événements Retell arrivent pour un même
  // appel, ils partagent le retell_call_id mais pas le correlation id).
  //
  // Réconcilie l'écart n°1 de la vague 2 : on n'utilise plus retell_call_id
  // comme correlation id (choix par défaut faute de middleware à l'époque).
  const { appelId, duplicate } = await persistCallAnalyzed({
    appel: row,
    processAppelPayload,
    purgeAudioPayload: { retell_call_id: call.call_id },
    purgeRunAfter: computeAudioExpiresAt(dateAppelIso),
    correlationId,
  });

  if (duplicate) {
    logger.info({ ...logCtx, appel_id: appelId }, 'webhook_replay_reconciled');
    return { kind: 'duplicate', retellCallId, appelId };
  }

  logger.info(
    { ...logCtx, appel_id: appelId, cabinet_id: cabinet.id },
    'webhook_processed',
  );

  return { kind: 'inserted', appelId, cabinetId: cabinet.id };
}
