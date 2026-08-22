/**
 * Email service — nodemailer over Infomaniak SMTP.
 *
 * ---------------------------------------------------------------------------
 * Config
 * ---------------------------------------------------------------------------
 * SMTP_* env vars stay OPTIONAL at boot (see config/env.ts) because the API
 * process can start without SMTP (e.g. running just to receive webhooks and
 * enqueue jobs). The WORKER, however, requires them: `assertSmtpConfigured`
 * is called at worker boot and throws a clear error if anything is missing.
 *
 * ---------------------------------------------------------------------------
 * Idempotence
 * ---------------------------------------------------------------------------
 * Send-twice would be a compliance breach (unexpected duplicate email
 * carrying patient data). Idempotence lives at TWO layers:
 *   1. The job's `payload.steps.email_sent_at` checkpoint — the worker never
 *      calls `sendRecapEmail` twice for the same job attempt sequence.
 *   2. Defence-in-depth: `appels.email_status === 'sent'` short-circuits
 *      any pipeline that somehow reached this service twice.
 *
 * ---------------------------------------------------------------------------
 * Logging
 * ---------------------------------------------------------------------------
 * The recipient address (`to`) is the CABINET's inbox — not patient PII —
 * and can safely be logged for support. Patient name/phone/motif from the
 * appel NEVER touch this file's log lines.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer, {
  type Transporter,
  type SendMailOptions,
} from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type {
  AppelProcessingRow,
  CabinetProcessingRow,
} from '../types/index.js';
import { isTimeoutError, withTimeout } from '../utils/timeout.js';
import { toLogFields } from '../utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '..', 'templates', 'email-recap.html');

let templateCache: string | null = null;
function loadTemplate(): string {
  if (templateCache === null) {
    templateCache = readFileSync(TEMPLATE_PATH, 'utf-8');
  }
  return templateCache;
}

export function __setTemplateForTests(content: string | null): void {
  templateCache = content;
}

// ---------------------------------------------------------------------------
// SMTP transporter
// ---------------------------------------------------------------------------

let transporter: Transporter | null = null;

/**
 * Validate all SMTP_* env vars are present. Called by the worker at boot so
 * a misconfiguration fails immediately (rather than at the first email 6 h
 * later). Returns a narrowed config object on success.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
}

export function assertSmtpConfigured(): SmtpConfig {
  const missing: string[] = [];
  if (!env.SMTP_HOST) missing.push('SMTP_HOST');
  if (env.SMTP_PORT === undefined) missing.push('SMTP_PORT');
  if (env.SMTP_SECURE === undefined) missing.push('SMTP_SECURE');
  if (!env.SMTP_USER) missing.push('SMTP_USER');
  if (!env.SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
  if (!env.SMTP_FROM_NAME) missing.push('SMTP_FROM_NAME');
  if (!env.SMTP_FROM_EMAIL) missing.push('SMTP_FROM_EMAIL');

  if (missing.length > 0) {
    throw new Error(
      `smtp_not_configured: missing env vars [${missing.join(', ')}]`,
    );
  }

  // All fields have been checked above — assertions are safe.
  return {
    host: env.SMTP_HOST!,
    port: env.SMTP_PORT!,
    secure: env.SMTP_SECURE!,
    user: env.SMTP_USER!,
    password: env.SMTP_PASSWORD!,
    fromName: env.SMTP_FROM_NAME!,
    fromEmail: env.SMTP_FROM_EMAIL!,
  };
}

/**
 * Return the shared SMTP transporter, lazy-building it. `pool: true` reuses
 * connections across sends so a small burst of jobs doesn't reopen the
 * TCP+TLS handshake each time.
 *
 * Session 4 vague 3 : timeouts are pushed to the Nodemailer layer directly
 * (`connectionTimeout`, `greetingTimeout`, `socketTimeout`) IN ADDITION to
 * the outer `withTimeout` wrap in `sendRecapEmailWithRetry`. Two layers on
 * purpose:
 *   - Nodemailer's socket-level timeout reclaims the underlying TCP
 *     handle inside the client. Without it, an unresponsive relay would
 *     leak a socket even after our outer promise timed out.
 *   - The outer `withTimeout` is our contract — it always rejects with
 *     `TimeoutError` (classified transient by the retry classifier).
 */
function getTransporter(): Transporter {
  if (transporter !== null) return transporter;
  const cfg = assertSmtpConfigured();
  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    pool: true,
    maxConnections: 3,
    // nLPD compliance (session 3.1 audit): the recap email carries the
    // PDF as an attachment, which contains patient PII + transcript.
    // `secure: true` opens an implicit TLS socket (port 465). For any
    // non-implicit-TLS port (587/25), Nodemailer only issues STARTTLS
    // OPPORTUNISTICALLY — if the server does not advertise STARTTLS, the
    // message goes out in cleartext. `requireTLS: true` upgrades that
    // to a hard requirement: no STARTTLS = the send fails, no cleartext
    // fallback. Harmless when `secure: true` (Nodemailer no-ops it).
    requireTLS: true,
    // Session 4 vague 3 — client-side timeouts. TIMEOUT_SMTP_MS is the
    // ceiling for the full transaction; individual phases (connect,
    // greeting, socket) share the same budget rather than adding up.
    connectionTimeout: env.TIMEOUT_SMTP_MS,
    greetingTimeout: env.TIMEOUT_SMTP_MS,
    socketTimeout: env.TIMEOUT_SMTP_MS,
  });
  return transporter;
}

/**
 * Test-only hook — inject a fake transporter (typically nodemailer's
 * `jsonTransport` for unit tests).
 */
export function __setTransporterForTests(t: Transporter | null): void {
  transporter = t;
}

/**
 * Returns the current transporter if one is cached, or builds it via
 * `getTransporter()` — but ONLY when SMTP is configured. Used by the
 * /health/deep `?full=1` branch so a probe never crashes an unconfigured
 * dev process. Returns null when SMTP env vars are missing.
 *
 * Distinct from `getTransporter()` (which throws on missing config) so
 * the health handler can degrade gracefully instead of exploding.
 */
export function getSharedTransporterForHealth(): Transporter | null {
  if (transporter !== null) return transporter;
  try {
    return getTransporter();
  } catch {
    return null;
  }
}

/**
 * Close the transporter's connection pool. Called at worker shutdown so a
 * lingering SMTP socket doesn't keep the process alive past the grace
 * period.
 */
export function closeTransporter(): void {
  if (transporter !== null) {
    transporter.close();
    transporter = null;
  }
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Minimal HTML escape — sufficient for content injected into HTML BODY.
 * We deliberately do NOT escape for HTML attributes here; the template
 * uses substitutions only in body text nodes and href attributes. For href,
 * only PDF_URL / ADMIN_URL flow through, which come from our own signed
 * URL helper and env — not user input.
 */
function htmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RESULTAT_LABELS: Record<string, string> = {
  rdv_pris: 'Rendez-vous pris',
  message: 'Message à traiter',
  transfere: 'Appel transféré',
  urgence: 'Urgence signalée',
  echec: 'Échec (à rappeler)',
  refus: 'Refus / annulation',
};

const DISPLAY_TIME_ZONE = 'Europe/Zurich';

function actionText(resultat: string | null): string {
  switch (resultat) {
    case 'rdv_pris':
      return 'Rendez-vous confirmé — aucune action requise, à titre d\'information.';
    case 'urgence':
      return 'Urgence signalée par le patient. Rappeler dès que possible.';
    case 'echec':
    case 'refus':
      return 'Appel non concluant. À rappeler pour un suivi.';
    case 'message':
      return 'Message laissé par le patient. Traiter dans la journée.';
    case 'transfere':
      return 'Appel transféré à un praticien. Aucune action supplémentaire.';
    default:
      return 'Résultat non catégorisé. Consulter le PDF ci-joint.';
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // fr-CH format — Node bundles ICU by default on modern Windows/Linux
  // (Alpine builds may not — safeguard with a fallback).
  try {
    return d.toLocaleString('fr-CH', {
      timeZone: DISPLAY_TIME_ZONE,
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
}

function formatDuree(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs) || secs < 0) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m === 0) return `${s} s`;
  return `${m} min ${s < 10 ? '0' : ''}${s} s`;
}

/**
 * Build the HTML + plain-text bodies. Exported for tests so we can assert
 * on the output without touching SMTP.
 */
export function renderEmailBodies(
  appel: AppelProcessingRow,
  cabinet: Pick<CabinetProcessingRow, 'nom'>,
  ctx: { pdfUrl: string; adminUrl: string },
): { html: string; text: string; subject: string } {
  const tpl = loadTemplate();
  const resultatLabel = appel.resultat
    ? RESULTAT_LABELS[appel.resultat] ?? appel.resultat
    : '—';
  const action = actionText(appel.resultat);
  const dateHeure = formatDate(appel.date_appel);
  const duree = formatDuree(appel.duree_secondes);
  const motif = appel.motif_appel && appel.motif_appel.length > 0 ? appel.motif_appel : '—';

  const substitutions: Record<string, string> = {
    '{{CABINET_NOM}}': htmlEscape(cabinet.nom),
    '{{DATE_HEURE}}': htmlEscape(dateHeure),
    '{{DUREE}}': htmlEscape(duree),
    '{{MOTIF}}': htmlEscape(motif),
    '{{ACTION}}': htmlEscape(action),
    '{{RESULTAT_LABEL}}': htmlEscape(resultatLabel),
    // URLs come from our own code — signed URL from storage.ts and
    // ADMIN_APP_URL from env. Safe as-is in href, still escape to be tidy.
    '{{PDF_URL}}': htmlEscape(ctx.pdfUrl),
    '{{ADMIN_URL}}': htmlEscape(ctx.adminUrl),
  };

  let html = tpl;
  for (const [needle, value] of Object.entries(substitutions)) {
    html = html.split(needle).join(value);
  }

  // Plain-text fallback for clients that reject HTML. Kept short and
  // action-first — the PDF is the source of truth.
  const text = [
    `Corya — Nouvel appel reçu pour ${cabinet.nom}`,
    '',
    `Date : ${dateHeure}`,
    `Durée : ${duree}`,
    `Motif : ${motif}`,
    `Résultat : ${resultatLabel}`,
    '',
    action,
    '',
    `PDF récap (lien valable 30 min) : ${ctx.pdfUrl}`,
    `Portail Corya : ${ctx.adminUrl}`,
    '',
    'Le récapitulatif est également joint à cet email.',
    '',
    'Cet email est envoyé automatiquement, ne pas y répondre.',
    'Support : support@corya.ch',
  ].join('\n');

  const subjectHour = (() => {
    const d = new Date(appel.date_appel);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return d.toLocaleTimeString('fr-CH', {
        timeZone: DISPLAY_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return d.toISOString().slice(11, 16);
    }
  })();
  const subject = `Nouvel appel reçu — ${cabinet.nom} — ${subjectHour}`;

  return { html, text, subject };
}

// ---------------------------------------------------------------------------
// Session 4 vague 3 — SMTP error classification + internal retry policy
// ---------------------------------------------------------------------------
//
// Two failure classes, one policy each:
//   - TRANSIENT (name: 'PermanentEmailError' NOT set):
//       Network hiccups, temporary SMTP throttles, TLS renegotiation
//       storms. Worth retrying inside the same job. The classifier lists
//       Node error codes (ETIMEDOUT, ECONNREFUSED, ECONNRESET, EAI_AGAIN,
//       ESOCKET) AND SMTP 4xx response codes 421/450/451/452.
//   - PERMANENT (thrown as PermanentEmailError):
//       Bad recipient, mailbox full, blocked sender, syntax error.
//       Retrying spends 5 outer job attempts on something structurally
//       broken. The caller (appel-processor / worker) treats
//       PermanentEmailError as "force dead_letter now, do NOT retry".
//       SMTP codes: 550, 551, 553, 554.
//
// Timeouts (TimeoutError from utils/timeout.ts) are classified TRANSIENT
// — a slow relay may accept the next attempt.
//
// The classifier is DEFENSIVE by default: any error we cannot classify
// (unknown shape, weird 5xx we didn't list) is treated as transient.
// Better to burn a retry than to prematurely dead-letter something that
// might have recovered. The founder's cost/risk calculus was explicit.

/**
 * Thrown by `sendRecapEmail` when the SMTP layer returned a PERMANENT
 * error code. The worker's fault handler recognises the class name and
 * forces `dead_letter` directly via `forceDeadLetter` (see queries.ts) —
 * it does NOT go through `fail_job`, which would only bump attempts.
 *
 * Message is a constant string ('permanent_smtp_failure') so it is safe
 * to persist in `jobs.last_error` — no PII leak.
 */
export class PermanentEmailError extends Error {
  /** SMTP response code that triggered the classification, if any. */
  public readonly smtpCode: number | null;
  constructor(smtpCode: number | null) {
    super('permanent_smtp_failure');
    this.name = 'PermanentEmailError';
    this.smtpCode = smtpCode;
  }
}

/** SMTP response codes classified as PERMANENT (no retry). */
const PERMANENT_SMTP_CODES: ReadonlySet<number> = new Set([550, 551, 553, 554]);

/** SMTP response codes classified as TRANSIENT (retryable). */
const TRANSIENT_SMTP_CODES: ReadonlySet<number> = new Set([421, 450, 451, 452]);

/** Node.js error codes classified as TRANSIENT (retryable). */
const TRANSIENT_NODE_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ESOCKET',
]);

/**
 * Decision: retry the send, or bail with a PermanentEmailError.
 *
 * Returns:
 *   - 'permanent' → throw PermanentEmailError, no more attempts
 *   - 'transient' → retry (until SMTP_RETRY_ATTEMPTS exhausted, then
 *                          rethrow the original error so the OUTER job
 *                          retry kicks in)
 */
type Classification = 'permanent' | 'transient';

function classifyEmailError(err: unknown): Classification {
  // Timeouts we produced are always transient (see utils/timeout.ts).
  if (isTimeoutError(err)) return 'transient';

  if (!(err instanceof Error)) return 'transient';

  // Nodemailer typically decorates errors with `code` (Node) and/or
  // `responseCode` (SMTP). Read both defensively — the `unknown` cast
  // via a structural type keeps eslint's no-any rule happy.
  const withProps = err as Error & {
    code?: unknown;
    responseCode?: unknown;
  };

  const smtpCode = typeof withProps.responseCode === 'number' ? withProps.responseCode : null;
  if (smtpCode !== null) {
    if (PERMANENT_SMTP_CODES.has(smtpCode)) return 'permanent';
    if (TRANSIENT_SMTP_CODES.has(smtpCode)) return 'transient';
  }

  const nodeCode = typeof withProps.code === 'string' ? withProps.code : null;
  if (nodeCode !== null && TRANSIENT_NODE_CODES.has(nodeCode)) return 'transient';

  // Fall-through: unknown error. See file-level rationale — default to
  // transient so we do not prematurely dead-letter a recoverable state.
  return 'transient';
}

function extractSmtpCode(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const c = (err as Error & { responseCode?: unknown }).responseCode;
  return typeof c === 'number' ? c : null;
}

/** Sleep helper — resolves after `ms` (0 → next microtask). */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send the recap email.
 *
 * Contract:
 *   - Runs UP TO `env.SMTP_RETRY_ATTEMPTS` internal attempts, sleeping
 *     `env.SMTP_RETRY_DELAYS_MS[i]` between attempts i and i+1.
 *   - On a PERMANENT error, throws `PermanentEmailError` immediately —
 *     the caller must not spend outer job retries on a doomed send.
 *   - On a TRANSIENT error after the last attempt, rethrows the original
 *     error unchanged so the outer job retry kicks in.
 *   - Each individual SMTP transaction is wrapped in `withTimeout` with
 *     `TIMEOUT_SMTP_MS`. The Nodemailer transporter also enforces its
 *     own socket-level timeouts (see getTransporter) — belt AND braces
 *     to guarantee no leaked handle.
 *
 * Never logs patient data: `to` / `cc` are cabinet addresses, `appel_id`
 * and `messageId` are technical identifiers.
 */
export async function sendRecapEmail(args: {
  to: string;
  cc: string | null;
  appel: AppelProcessingRow;
  cabinet: Pick<CabinetProcessingRow, 'nom'>;
  pdfUrl: string;
  adminUrl: string;
  pdfBytes: Buffer;
}): Promise<void> {
  const { to, cc, appel, cabinet, pdfUrl, adminUrl, pdfBytes } = args;
  const { html, text, subject } = renderEmailBodies(appel, cabinet, {
    pdfUrl,
    adminUrl,
  });

  const cfg = assertSmtpConfigured();

  const message: SendMailOptions = {
    from: { name: cfg.fromName, address: cfg.fromEmail },
    to,
    subject,
    text,
    html,
    attachments: [
      {
        filename: `corya-recap-${appel.id}.pdf`,
        content: pdfBytes,
        contentType: 'application/pdf',
      },
    ],
  };
  if (cc && cc.length > 0) {
    message.cc = cc;
  }

  const t = getTransporter();
  const attempts = env.SMTP_RETRY_ATTEMPTS;
  const delays = env.SMTP_RETRY_DELAYS_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Nodemailer types SentMessageInfo as `any`. Narrow via unknown +
      // structural cast so we can log messageId safely.
      const info = (await withTimeout(
        t.sendMail(message),
        env.TIMEOUT_SMTP_MS,
        'smtp:sendMail',
      )) as unknown as { messageId?: string };

      // `to` is a cabinet-owned address, safe to log.
      logger.info(
        {
          to,
          cc: cc ?? null,
          appel_id: appel.id,
          message_id: info.messageId ?? null,
          attempt,
        },
        'email_recap_sent',
      );
      return;
    } catch (err: unknown) {
      lastError = err;
      const classification = classifyEmailError(err);
      const smtpCode = extractSmtpCode(err);

      if (classification === 'permanent') {
        // Loud log — this is the ops-critical event for a bad recipient.
        // No err.message: nodemailer may echo the recipient address which
        // is a cabinet address (safe) but can also include the message
        // subject in verbose modes. Class + code is enough.
        logger.error(
          {
            to,
            appel_id: appel.id,
            attempt,
            smtp_code: smtpCode,
            ...toLogFields(err),
          },
          'email_send_permanent_failure',
        );
        throw new PermanentEmailError(smtpCode);
      }

      // Transient. Retry unless we exhausted the budget.
      const willRetry = attempt < attempts;
      logger.warn(
        {
          to,
          appel_id: appel.id,
          attempt,
          max_attempts: attempts,
          will_retry: willRetry,
          smtp_code: smtpCode,
          ...toLogFields(err),
        },
        'email_send_transient_error_retrying',
      );
      if (!willRetry) break;

      // delays[attempt - 1] because attempt is 1-based and the first gap
      // is delays[0] (between attempt 1 and 2). superRefine at boot has
      // already verified the list length.
      const delayIdx = attempt - 1;
      const delay = delays[delayIdx] ?? 0;
      await sleep(delay);
    }
  }

  // Transient outcomes only reach here (permanent throws inside the loop).
  // Rethrow so the OUTER job retry (worker + fail_job) kicks in.
  throw lastError instanceof Error ? lastError : new Error('email_send_unknown_failure');
}
