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
    `Consulter dans Corya : ${ctx.adminUrl}`,
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

/**
 * Send the recap email. Throws on transient SMTP failure — the caller
 * (appel-processor) treats a throw as a retryable step.
 *
 * `to` and `cc` come from the cabinet row (cabinet-owned addresses), never
 * from patient data.
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
  // Nodemailer types SentMessageInfo as `any`. Narrow via unknown +
  // structural cast so we can log messageId safely.
  const info = (await t.sendMail(message)) as unknown as {
    messageId?: string;
  };

  // `to` is a cabinet-owned address, safe to log.
  logger.info(
    {
      to,
      cc: cc ?? null,
      appel_id: appel.id,
      message_id: info.messageId ?? null,
    },
    'email_recap_sent',
  );
}
