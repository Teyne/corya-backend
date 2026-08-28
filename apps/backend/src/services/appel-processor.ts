/**
 * Post-call pipeline — the body of the `process_appel` job.
 *
 * ---------------------------------------------------------------------------
 * What runs
 * ---------------------------------------------------------------------------
 *   1. Load the appel + cabinet rows.
 *   2. Short-circuit on paused/terminated cabinet (no PDF, no email, log,
 *      return success).
 *   3. Short-circuit if `appels.email_status === 'sent'` (defence in depth).
 *   4. If `payload.steps.pdf_uploaded_at` is unset:
 *        - render PDF
 *        - upload to Supabase Storage (idempotent thanks to upsert +
 *          deterministic path)
 *        - persist `appels.pdf_url` and checkpoint in `payload.steps`
 *   5. If `payload.steps.email_sent_at` is unset:
 *        - send a minimal notification linking to the authenticated portal
 *        - mark `appels.email_status = 'sent'` + set `pdf_envoye_at`
 *        - checkpoint in `payload.steps`
 *
 * ---------------------------------------------------------------------------
 * Error semantics
 * ---------------------------------------------------------------------------
 *   - PDF generation / upload failure  -> throw `PdfPipelineError` (thrown
 *                                          to worker, which will RETRY).
 *     Also logged with `pdf_generation_failed` at level=error — this is the
 *     critical alerting event: without a PDF we cannot send the email at
 *     all, so if it keeps failing we want a loud signal.
 *   - Email send failure                -> throw `EmailPipelineError`
 *                                          (worker RETRIES with backoff).
 *   - "Nothing to do" cases (missing row, paused cabinet, already sent)
 *     return normally so the worker marks the job succeeded.
 *
 * Errors sent to the worker MUST be REDACTED: never a patient name, phone,
 * or transcript fragment. All error messages here are constant strings
 * that only carry technical identifiers.
 */
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  getAppelForProcessing,
  getCabinetForProcessing,
  markAppelEmailSent,
  reconcileCalendarBookingForAppel,
  setAppelPdfPath,
  updateJobPayload,
} from '../db/queries.js';
import type {
  Job,
  ProcessAppelPayload,
} from '../types/index.js';
import { renderAppelPdf } from './pdf.js';
import { PermanentEmailError, sendRecapEmail } from './email.js';
import {
  buildPdfObjectPath,
  uploadPdf,
} from './storage.js';
import { toLogFields } from '../utils/errors.js';

export class PdfPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfPipelineError';
  }
}

export class EmailPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailPipelineError';
  }
}

/**
 * Minimal, tolerant parse of the persisted payload. We do NOT throw on an
 * older shape — a job written by a previous version of the code must still
 * be processable. Anything missing simply resolves to "step not yet done".
 */
export function readCheckpoint(raw: unknown): ProcessAppelPayload {
  if (raw === null || typeof raw !== 'object') return {};
  const p = raw as Record<string, unknown>;
  const stepsRaw = p.steps;
  const steps =
    stepsRaw !== null && typeof stepsRaw === 'object'
      ? (stepsRaw as Record<string, unknown>)
      : {};

  const optStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const optStrOrNull = (v: unknown): string | null | undefined =>
    v === null ? null : optStr(v);

  return {
    version: typeof p.version === 'number' ? p.version : undefined,
    to: optStr(p.to),
    cc: optStrOrNull(p.cc),
    steps: {
      pdf_uploaded_at: optStr(steps.pdf_uploaded_at),
      storage_path: optStr(steps.storage_path),
      email_sent_at: optStr(steps.email_sent_at),
    },
  };
}

/**
 * Merge a new checkpoint into the current payload — never mutates the
 * argument. Kept as its own function so the checkpoint update is atomic
 * from the caller's perspective (compute new payload, persist, keep in
 * memory).
 */
function mergePayload(
  current: ProcessAppelPayload,
  patch: Partial<ProcessAppelPayload> & { steps?: Partial<NonNullable<ProcessAppelPayload['steps']>> },
): ProcessAppelPayload {
  return {
    ...current,
    ...patch,
    version: patch.version ?? current.version ?? 1,
    steps: {
      ...(current.steps ?? {}),
      ...(patch.steps ?? {}),
    },
  };
}

/**
 * Run the pipeline for a claimed `process_appel` job.
 *
 * The worker calls this exactly once per claim. Returning normally = the
 * worker will call `complete_job`. Throwing = the worker will call
 * `fail_job` with backoff.
 */
export async function processAppelJob(job: Job): Promise<void> {
  // Session 4 vague 3: propagate the job's correlation_id (posted by the
  // webhook at enqueue) into every log line emitted while processing.
  const correlation = {
    job_id: job.id,
    appel_id: job.appel_id,
    attempt: job.attempts,
    correlation_id: job.correlation_id,
  };

  // 1. Load rows -----------------------------------------------------------
  let appel = await getAppelForProcessing(job.appel_id);
  if (!appel) {
    // Appel purged between enqueue and claim (24-month cron, or
    // right-to-erasure). Nothing to do — success.
    logger.info(correlation, 'process_appel_missing_appel_skip');
    return;
  }
  // Add retell_call_id for downstream correlation. All fields below are
  // technical ids or cabinet-side ids — no patient data.
  const corrWithCall = { ...correlation, retell_call_id: appel.retell_call_id };

  const cabinet = await getCabinetForProcessing(appel.cabinet_id);
  if (!cabinet) {
    logger.warn(corrWithCall, 'process_appel_missing_cabinet_skip');
    return;
  }

  // 2. Cabinet status gate -------------------------------------------------
  if (cabinet.statut !== 'actif') {
    logger.info(
      { ...corrWithCall, cabinet_statut: cabinet.statut },
      'process_appel_cabinet_inactive_skip',
    );
    return;
  }

  // 3. Defence-in-depth: never re-send an email that DB says is sent.
  if (appel.email_status === 'sent') {
    logger.info(corrWithCall, 'process_appel_email_already_sent_skip');
    return;
  }

  // 4. Checkpoint state ----------------------------------------------------
  let payload = readCheckpoint(job.payload);
  // Ensure default `to` on retries where the initial webhook payload
  // predates the field. Trust the cabinet row over stale payload data.
  if (!payload.to) {
    payload = mergePayload(payload, { to: cabinet.email_notification });
  }
  if (payload.cc === undefined) {
    payload = mergePayload(payload, { cc: cabinet.email_notification_cc });
  }

  // Cal.com is authoritative for confirmed bookings. Retell post-call
  // analysis can report `echec` even when the booking tool succeeded. Before
  // rendering anything durable, give the fail-closed SQL reconciliation one
  // final opportunity to promote a unique confirmed booking, then reload the
  // row so both PDF and email use the corrected resultat / rdv_date.
  if (appel.motif_appel === 'prendre_rendez_vous') {
    const callEndedAt = new Date(
      new Date(appel.date_appel).getTime()
        + (appel.duree_secondes ?? 0) * 1_000,
    ).toISOString();
    const bookingId = await reconcileCalendarBookingForAppel(
      appel.id,
      appel.cabinet_id,
      appel.date_appel,
      callEndedAt,
      appel.rdv_date,
    );

    if (bookingId) {
      const reconciledAppel = await getAppelForProcessing(appel.id);
      if (!reconciledAppel) {
        logger.info(corrWithCall, 'process_appel_reconciled_appel_missing_skip');
        return;
      }
      appel = reconciledAppel;
      logger.info(
        { ...corrWithCall, booking_id: bookingId },
        'process_appel_calendar_booking_reconciled',
      );

      // A concurrent worker or administrative replay may have completed the
      // email between the initial read and the reconciliation reload.
      if (appel.email_status === 'sent') {
        logger.info(corrWithCall, 'process_appel_email_already_sent_skip');
        return;
      }
    }
  }

  // 5. PDF + upload --------------------------------------------------------
  let objectPath = payload.steps?.storage_path;
  const alreadyUploaded =
    payload.steps?.pdf_uploaded_at !== undefined && objectPath !== undefined;

  if (!alreadyUploaded) {
    let pdfBytes: Buffer;
    try {
      pdfBytes = await renderAppelPdf(appel, cabinet);
    } catch (err: unknown) {
      logger.error(
        { ...corrWithCall, ...toLogFields(err) },
        'pdf_generation_failed',
      );
      throw new PdfPipelineError('pdf_render_failed');
    }

    objectPath = buildPdfObjectPath(cabinet.id, appel.id, appel.date_appel);
    try {
      await uploadPdf(objectPath, pdfBytes);
    } catch (err: unknown) {
      logger.error(
        { ...corrWithCall, ...toLogFields(err) },
        'pdf_upload_failed',
      );
      throw new PdfPipelineError('pdf_upload_failed');
    }

    // Persist path in the appel row so pg_cron purges can find the file.
    await setAppelPdfPath(appel.id, objectPath);

    payload = mergePayload(payload, {
      steps: {
        storage_path: objectPath,
        pdf_uploaded_at: new Date().toISOString(),
      },
    });
    await updateJobPayload(job.id, payload);
    logger.info({ ...corrWithCall, storage_path: objectPath }, 'pdf_uploaded');
  }

  // 6. Email send ----------------------------------------------------------
  if (payload.steps?.email_sent_at) {
    // Should not happen — the email_status check above catches it. Kept as a
    // secondary guard in case DB-side status was reset by an admin.
    logger.info(corrWithCall, 'process_appel_email_checkpoint_skip');
    return;
  }

  if (!objectPath) {
    // Impossible in practice; keeps the type checker honest.
    throw new PdfPipelineError('pdf_object_path_missing');
  }

  try {
    const portalUrl = new URL(`/calls/${appel.id}`, env.ADMIN_APP_URL).toString();
    await sendRecapEmail({
      to: payload.to ?? cabinet.email_notification,
      cc: payload.cc ?? cabinet.email_notification_cc,
      appel,
      cabinet,
      adminUrl: portalUrl,
    });
  } catch (err: unknown) {
    // Session 4 vague 3: distinguish PERMANENT from TRANSIENT.
    //   - PERMANENT: sendRecapEmail already exhausted zero retries
    //     (bad recipient, blocked sender) and threw PermanentEmailError.
    //     Propagate it verbatim — the worker recognises the class and
    //     forces dead_letter without spending outer job attempts.
    //   - TRANSIENT: services/email.ts already ran its internal retry
    //     policy (SMTP_RETRY_ATTEMPTS). We land here only after ALL
    //     internal retries failed. Wrap it in EmailPipelineError so the
    //     outer worker retry (backoff) kicks in.
    if (err instanceof PermanentEmailError) {
      logger.error(
        { ...corrWithCall, err_name: err.name, smtp_code: err.smtpCode },
        'email_send_permanent_failure',
      );
      throw err;
    }
    logger.warn(
      { ...corrWithCall, ...toLogFields(err) },
      'email_send_failed_will_retry',
    );
    throw new EmailPipelineError('email_send_failed');
  }

  // Success: mark DB + last checkpoint.
  await markAppelEmailSent(appel.id);
  payload = mergePayload(payload, {
    steps: { email_sent_at: new Date().toISOString() },
  });
  await updateJobPayload(job.id, payload);

  logger.info(corrWithCall, 'process_appel_pipeline_success');
}
