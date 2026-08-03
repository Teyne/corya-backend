/**
 * Alerting service — sends ops emails when the pipeline needs attention.
 *
 * ---------------------------------------------------------------------------
 * Contract (hard rules)
 * ---------------------------------------------------------------------------
 *   1. `sendAlert` MUST NEVER throw. It is called from error paths (worker
 *      failure handlers, pollers). A throw here would cascade and mask the
 *      original incident. Any internal failure is logged and swallowed.
 *
 *   2. In-memory deduplication: at most one alert per `AlertType` per
 *      `ALERT_DEDUP_WINDOW_MS` (default 15 min). Without this a worker
 *      looping on a deterministic error would produce ~1800 emails/hour.
 *      Deduper state is process-local — that is deliberate: two API replicas
 *      may each send one alert per window, which is the correct trade-off
 *      (either replica muting the other requires shared state we do not want
 *      to introduce here).
 *
 *   3. NO PATIENT DATA in the alert body. Only technical identifiers:
 *      job_id, retell_call_id, cabinet_id, correlation_id, counters. Any
 *      new context field added here goes through `sanitizeContext` which
 *      strips keys matching the shared PII deny-list.
 *
 *   4. `ALERT_ENABLED=false` short-circuits every send. It is logged ONCE at
 *      boot with a WARN (in `logAlertingModeOnce`) so an operator cannot
 *      mistake a silenced pipeline for a working one.
 *
 * ---------------------------------------------------------------------------
 * Why plain text (no HTML template)
 * ---------------------------------------------------------------------------
 * Alerts are for the on-call inbox. Plain text renders identically in every
 * client, cannot leak resources through inlined images, and keeps the SMTP
 * transaction light. This is not a marketing email.
 *
 * ---------------------------------------------------------------------------
 * Zero new dependency
 * ---------------------------------------------------------------------------
 * Session 4 constraint: we reuse the existing Nodemailer transporter built
 * by `services/email.ts`. When SMTP is not configured (e.g. the API process
 * running without email creds because it only enqueues), we log the alert
 * and return — no throw.
 */
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { toLogFields } from '../utils/errors.js';

/**
 * The exhaustive list of alert types. Adding a value here is a deliberate
 * act — the deduper keys on this string, and the pollers reference it.
 *
 * `cron_stale` is DECLARED but not yet wired. It lands with `/health/deep`
 * in vague 4; declaring it now keeps the poller enum stable.
 */
export type AlertType =
  | 'job_dead_letter'
  | 'pdf_orphelin'
  | 'worker_stale'
  | 'jobs_backlog'
  | 'cron_stale'
  | 'file_deletion_dead_letter'
  | 'retell_purge_failed';

/** Sanitisation deny-list. Matched case-insensitively at ANY nesting depth. */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    'patient_nom',
    'patient_prenom',
    'patient_telephone',
    'transcript',
    'transcript_object',
    'recording_url',
    'public_log_url',
    'from_number',
    'to_number',
    'authorization',
    'cookie',
    'x-retell-signature',
    // Defensive redact on anything that "looks like" it might carry the SMTP
    // password or the Retell secret if a lazy caller passed a whole env.
    'password',
    'secret',
  ].map((k) => k.toLowerCase()),
);

const CENSOR = '[REDACTED]';
const MAX_DEPTH = 8;

/**
 * Recursively censor keys matching the deny-list. This is defense in depth:
 * every caller is REQUIRED to pass only technical identifiers, but a
 * mistake at the call site must not turn into a compliance leak.
 */
function sanitizeContext(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[REDACTED:MAXDEPTH]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeContext(v, depth + 1));
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = CENSOR;
      } else {
        out[key] = sanitizeContext(src[key], depth + 1);
      }
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/** Map<AlertType, epoch_ms of last send>. Process-local by design. */
const lastSentAt = new Map<AlertType, number>();

/**
 * Returns true when the given alert type is inside its dedup window and
 * should be suppressed. Uses a monotonic-ish clock (Date.now) which is
 * good enough for a 15-min window.
 */
function isDeduped(type: AlertType, nowMs: number): boolean {
  const last = lastSentAt.get(type);
  if (last === undefined) return false;
  return nowMs - last < env.ALERT_DEDUP_WINDOW_MS;
}

/** Test-only: wipe the deduper state. Never call from production code. */
export function __resetAlertDedupForTests(): void {
  lastSentAt.clear();
}

// ---------------------------------------------------------------------------
// Transporter — reuse the same Nodemailer config as services/email.ts
// ---------------------------------------------------------------------------
//
// We deliberately keep a SEPARATE transporter instance from services/email.ts.
// Rationale:
//   - Alert delivery must not depend on the recap-email pool being healthy
//     (an event loop bug in the recap send code path could otherwise block
//     us from alerting on that very bug).
//   - The alert transporter uses a much smaller pool (1 connection) — alerts
//     are low-frequency (dedup + poller windows) and don't need parallelism.
//   - Different `close()` lifecycle: alert transporter closes at process
//     shutdown, not on worker graceful-drain (alerts may need to fire
//     DURING the drain).
//
// A test-only setter lets us swap in a fake transporter without opening any
// real socket.

let alertTransporter: Transporter | null = null;

function getAlertTransporter(): Transporter | null {
  if (alertTransporter !== null) return alertTransporter;
  // If any SMTP field is missing, return null: sendAlert will fall back to
  // "log and swallow" — safer than throwing from a fire-and-forget path.
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
  alertTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    pool: true,
    maxConnections: 1,
    // Same TLS hardening rationale as services/email.ts: never allow a
    // silent fallback to cleartext.
    requireTLS: true,
  });
  return alertTransporter;
}

/** Test-only: inject a stub transporter. Passing null clears any cache. */
export function __setAlertTransporterForTests(t: Transporter | null): void {
  alertTransporter = t;
}

/** Close the transporter at process shutdown. Safe if never initialised. */
export function closeAlertTransporter(): void {
  if (alertTransporter !== null) {
    try {
      alertTransporter.close();
    } catch {
      // Nothing to do — closing at shutdown is best-effort.
    }
    alertTransporter = null;
  }
}

// ---------------------------------------------------------------------------
// Boot-time visibility of the alerting mode
// ---------------------------------------------------------------------------

let bootLogEmitted = false;

/**
 * Emits a single boot-time line describing the alerting configuration. Must
 * be called from BOTH `src/index.ts` (API) and `src/worker.ts` (worker) so
 * neither process can silently think alerts are on when they are not.
 *
 * The founder's hard requirement: when ALERT_ENABLED=false, this MUST be a
 * WARN so the log line is visible in a routine log scan.
 */
export function logAlertingModeOnce(): void {
  if (bootLogEmitted) return;
  bootLogEmitted = true;

  if (!isAlertingEnabled()) {
    logger.warn(
      { alert_enabled: false },
      'alerting_disabled — no ops emails will be sent until ALERT_ENABLED=true',
    );
    return;
  }
  if (env.ALERT_EMAIL === undefined) {
    // Only reachable in non-production (superRefine forbids this in prod).
    logger.warn(
      { alert_enabled: true, alert_email_set: false },
      'alerting_enabled_but_recipient_missing — alerts will be logged only',
    );
    return;
  }
  logger.info(
    {
      alert_enabled: true,
      alert_email_set: true,
      dedup_window_ms: env.ALERT_DEDUP_WINDOW_MS,
    },
    'alerting_enabled',
  );
}

/** Test-only: reset the "boot log already emitted" latch. */
export function __resetAlertingBootLatchForTests(): void {
  bootLogEmitted = false;
}

// ---------------------------------------------------------------------------
// Test-only override of the ALERT_ENABLED master switch
// ---------------------------------------------------------------------------
//
// env is frozen at boot, so a per-test process.env mutation cannot flip
// ALERT_ENABLED. Tests need to prove the disable branch though — it is
// the safety switch operators rely on. Solution: a module-local override
// that overrides env.ALERT_ENABLED WHEN SET, otherwise the env value is
// used. Production code never calls the setter (it lives under
// __setForTests naming convention).

let enabledOverride: boolean | null = null;

/** Test-only override. Pass a boolean to force, or null to clear. */
export function __setAlertEnabledOverrideForTests(value: boolean | null): void {
  enabledOverride = value;
}

function isAlertingEnabled(): boolean {
  return enabledOverride ?? env.ALERT_ENABLED;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send an alert email, dedup'd by type. Never throws.
 *
 * Behaviour matrix:
 *   - ALERT_ENABLED=false          -> log info + return
 *   - ALERT_EMAIL missing          -> log warn + return
 *   - Deduped                      -> log debug + return
 *   - SMTP not configured          -> log warn + return (no throw)
 *   - SMTP send throws             -> log error + return (no throw)
 *   - SMTP send OK                 -> stamp deduper + log info
 *
 * IMPORTANT: the dedup entry is written ONLY on a confirmed SMTP send. That
 * way a transient SMTP outage does not silence real alerts — the caller may
 * fire again next tick and the alert will re-attempt.
 */
export async function sendAlert(
  type: AlertType,
  context: Record<string, unknown> = {},
): Promise<void> {
  // 1. Master switch. Log at info because it is a normal expected branch
  //    when ops explicitly disabled alerting.
  if (!isAlertingEnabled()) {
    logger.info({ alert_type: type }, 'alert_suppressed_disabled');
    return;
  }

  // 2. Recipient. In prod this is enforced at boot; here we defend against
  //    a dev/test caller reaching the send path without one configured.
  const recipient = env.ALERT_EMAIL;
  if (recipient === undefined) {
    // Context is safe to include here: it is intended for the operator
    // reading logs. The sanitizer redacts by key regardless.
    logger.warn(
      { alert_type: type, context: sanitizeContext(context) },
      'alert_recipient_missing_only_logged',
    );
    return;
  }

  // 3. Deduplication.
  const now = Date.now();
  if (isDeduped(type, now)) {
    logger.debug(
      { alert_type: type, dedup_window_ms: env.ALERT_DEDUP_WINDOW_MS },
      'alert_suppressed_dedup',
    );
    return;
  }

  // 4. Transporter.
  const transport = getAlertTransporter();
  if (transport === null) {
    logger.warn(
      { alert_type: type, context: sanitizeContext(context) },
      'alert_transporter_unavailable_only_logged',
    );
    return;
  }

  // 5. Compose. Plain-text body only — see file header.
  const safeContext = sanitizeContext(context) as Record<string, unknown>;
  const subject = `[Corya] ${type}`;
  const bodyLines: string[] = [
    `Corya ops alert: ${type}`,
    '',
    `Environment : ${env.NODE_ENV}`,
    `Timestamp   : ${new Date(now).toISOString()}`,
    '',
    'Context (technical identifiers only, no patient data):',
  ];
  for (const [key, value] of Object.entries(safeContext)) {
    bodyLines.push(`  ${key} = ${JSON.stringify(value)}`);
  }
  bodyLines.push('');
  bodyLines.push(
    `Deduplication window: ${Math.round(env.ALERT_DEDUP_WINDOW_MS / 1000)} s.`,
  );
  bodyLines.push('Next alert of this type will be suppressed until the window elapses.');

  const message: SendMailOptions = {
    from: { name: env.SMTP_FROM_NAME!, address: env.SMTP_FROM_EMAIL! },
    to: recipient,
    subject,
    text: bodyLines.join('\n'),
  };

  // 6. Send. NEVER throw — this is the whole reason the function exists.
  try {
    await transport.sendMail(message);
  } catch (err: unknown) {
    // Log the class name only. Nodemailer error messages can mirror the SMTP
    // response body which, on some servers, echoes the subject and headers
    // back — we already redact by key in the logger, but keeping it out of
    // the log line entirely is the tighter guarantee.
    logger.error(
      {
        alert_type: type,
        ...toLogFields(err),
      },
      'alert_send_failed',
    );
    return;
  }

  // 7. Only stamp the deduper on confirmed SMTP acceptance.
  lastSentAt.set(type, now);
  logger.info(
    { alert_type: type, alert_email_set: true },
    'alert_sent',
  );
}
