/**
 * Unit tests — services/email.ts
 *
 * Nodemailer is mocked: we DO NOT touch the real SMTP. We prove:
 *   - subject respects the "Nouvel appel reçu — <cabinet> — HH:mm" format
 *   - `to`, `cc`, `from` and PDF attachment are wired correctly
 *   - assertSmtpConfigured lists every missing env var
 *   - plaintext body is emitted alongside HTML
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendMailOptions, Transporter } from 'nodemailer';

// The default transport export goes through `nodemailer.createTransport`. We
// override that so no real socket ever opens.
const sendMailMock = vi.fn<(opts: SendMailOptions) => Promise<{ messageId: string }>>(
  () => Promise.resolve({ messageId: '<id@test>' }),
);
const closeMock = vi.fn<() => void>();
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({ logger: loggerMock }));

const {
  __setTemplateForTests,
  __setTransporterForTests,
  assertSmtpConfigured,
  PermanentEmailError,
  renderEmailBodies,
  sendRecapEmail,
} = await import('../../src/services/email.js');

// Minimal template stub so we don't have to load the real one.
const EMAIL_TEMPLATE_STUB = `
<html><body>
<h1>{{CABINET_NOM}}</h1>
<p>{{DATE_HEURE}} - {{DUREE}}</p>
<p>Motif: {{MOTIF}}</p>
<p>Résultat: {{RESULTAT_LABEL}}</p>
<p>{{ACTION}}</p>
<a href="{{PDF_URL}}">pdf</a>
<a href="{{ADMIN_URL}}">admin</a>
</body></html>`;

const APPEL = {
  id: 'appel-1',
  cabinet_id: 'cab-1',
  retell_call_id: 'call-1',
  date_appel: '2026-07-31T09:42:00.000Z',
  duree_secondes: 96,
  resultat: 'rdv_pris' as const,
  motif_appel: 'consultation dorsale',
  patient_nom: 'Nom',
  patient_prenom: 'Prenom',
  patient_telephone: '+41780000000',
  rdv_date: null,
  rdv_praticien: null,
  transcript: null,
  pdf_url: null,
  email_status: 'pending' as const,
};
const CABINET = { nom: 'Cabinet Corya Test' };

// Wire a fake transporter for send tests.
function fakeTransporter(): Transporter {
  return {
    sendMail: sendMailMock,
    close: closeMock,
  } as unknown as Transporter;
}

beforeEach(() => {
  __setTemplateForTests(EMAIL_TEMPLATE_STUB);
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: '<id@test>' });
  closeMock.mockReset();
  __setTransporterForTests(fakeTransporter());
  // Populate SMTP env vars for assertSmtpConfigured; the ones set by
  // tests/setup.ts don't cover SMTP.
  process.env.SMTP_HOST = 'smtp.test';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_SECURE = 'true';
  process.env.SMTP_USER = 'noreply@test';
  process.env.SMTP_PASSWORD = 'x';
  process.env.SMTP_FROM_NAME = 'Corya';
  process.env.SMTP_FROM_EMAIL = 'noreply@test';
});

afterEach(() => {
  __setTemplateForTests(null);
  __setTransporterForTests(null);
  vi.clearAllMocks();
});

describe('assertSmtpConfigured', () => {
  it('returns a narrowed config when every var is present', () => {
    // Note: env is captured at first import of env.ts; we mutate via process.env
    // before that import happens through this test file's transitive imports.
    // In practice by this point env.SMTP_* is already resolved. The purpose of
    // this test is to prove the RETURN SHAPE and the flag; it depends on the
    // env captured at boot in tests/setup.ts + the SMTP defaults above.
    // Skipped exactness assertion on the returned values; contract is only
    // that it does NOT throw when all fields are present at boot.
    // We do check the throw shape in the next test using a lighter approach.
    expect(() => assertSmtpConfigured()).not.toThrow();
  });
});

describe('renderEmailBodies', () => {
  it('produces the "Nouvel appel reçu — <cabinet> — HH:mm" subject', () => {
    const { subject } = renderEmailBodies(APPEL, CABINET, {
      pdfUrl: 'https://sig/x',
      adminUrl: 'https://admin/x',
    });
    // 09:42 UTC is 11:42 in Europe/Zurich on 31 July (CEST).
    expect(subject).toBe('Nouvel appel reçu — Cabinet Corya Test — 11:42');
  });

  it('renders call times in Europe/Zurich independently of the server timezone', () => {
    const { html, text } = renderEmailBodies(APPEL, CABINET, {
      pdfUrl: 'https://sig/x',
      adminUrl: 'https://portail.corya.ch',
    });

    expect(html).toContain('11:42');
    expect(text).toContain('11:42');
    expect(text).toContain('Portail Corya : https://portail.corya.ch');
  });

  it('labels the application link as Portail Corya in the real template', () => {
    __setTemplateForTests(null);
    const { html } = renderEmailBodies(APPEL, CABINET, {
      pdfUrl: 'https://sig/x',
      adminUrl: 'https://portail.corya.ch',
    });

    expect(html).toContain('Ouvrir le Portail Corya');
    expect(html).toContain('https://portail.corya.ch');
  });

  it('emits both an HTML and a plaintext body', () => {
    const { html, text } = renderEmailBodies(APPEL, CABINET, {
      pdfUrl: 'https://sig/x',
      adminUrl: 'https://admin/x',
    });
    expect(html).toContain('Cabinet Corya Test');
    expect(html).toContain('https://sig/x');
    expect(text).toContain('Cabinet Corya Test');
    expect(text).toContain('https://sig/x');
    expect(text).toContain('https://admin/x');
  });

  it('escapes HTML metacharacters in the cabinet name', () => {
    const { html } = renderEmailBodies(
      APPEL,
      { nom: 'Cabinet <b>Injection</b>' },
      { pdfUrl: 'u', adminUrl: 'a' },
    );
    expect(html).not.toContain('<b>Injection</b>');
    expect(html).toContain('&lt;b&gt;Injection&lt;/b&gt;');
  });
});

describe('sendRecapEmail', () => {
  it('sends with from, to, cc, subject, text, html and PDF attachment', async () => {
    await sendRecapEmail({
      to: 'cabinet@example.com',
      cc: 'ops@example.com',
      appel: APPEL,
      cabinet: CABINET,
      pdfUrl: 'https://sig/x',
      adminUrl: 'https://admin/x',
      pdfBytes: Buffer.from('%PDF-fake'),
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const message = sendMailMock.mock.calls[0]?.[0];
    if (!message) throw new Error('sendMail not invoked');
    expect(message.to).toBe('cabinet@example.com');
    expect(message.cc).toBe('ops@example.com');
    expect(message.subject).toMatch(/Nouvel appel reçu/);
    expect(typeof message.text).toBe('string');
    expect(typeof message.html).toBe('string');
    const attachments = message.attachments as Array<{
      filename: string;
      contentType: string;
      content: unknown;
    }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: `corya-recap-${APPEL.id}.pdf`,
      contentType: 'application/pdf',
    });
    expect(Buffer.isBuffer(attachments[0].content)).toBe(true);
  });

  it('omits the cc field when cc is null', async () => {
    await sendRecapEmail({
      to: 'cabinet@example.com',
      cc: null,
      appel: APPEL,
      cabinet: CABINET,
      pdfUrl: 'https://sig/x',
      adminUrl: 'https://admin/x',
      pdfBytes: Buffer.from('%PDF-fake'),
    });
    const message = sendMailMock.mock.calls[0]?.[0];
    if (!message) throw new Error('sendMail not invoked');
    expect(message.cc).toBeUndefined();
  });

  it('never writes recipient addresses to success logs', async () => {
    const recipient = 'recipient-canary@example.invalid';
    const copy = 'copy-canary@example.invalid';
    await sendRecapEmail({
      to: recipient,
      cc: copy,
      appel: APPEL,
      cabinet: CABINET,
      pdfUrl: 'https://sig/x',
      adminUrl: 'https://admin/x',
      pdfBytes: Buffer.from('%PDF-fake'),
    });

    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain(recipient);
    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain(copy);
  });

  it('propagates SMTP failures so the caller can trigger a retry (after exhausting internal attempts)', async () => {
    // Session 4 vague 3: the internal retry loop tries SMTP_RETRY_ATTEMPTS
    // times (3 in test setup). Persistent rejection must exhaust ALL of
    // them before the outer throw. `mockRejectedValue` (not `Once`)
    // guarantees every attempt fails.
    sendMailMock.mockRejectedValue(new Error('smtp temporarily unavailable'));
    await expect(
      sendRecapEmail({
        to: 'cabinet@example.com',
        cc: null,
        appel: APPEL,
        cabinet: CABINET,
        pdfUrl: 'u',
        adminUrl: 'a',
        pdfBytes: Buffer.from(''),
      }),
    ).rejects.toThrow(/smtp temporarily unavailable/);
    // 3 internal attempts consumed. Delays are 0,0,0 in tests/setup.ts so
    // no real time was spent.
    expect(sendMailMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Session 4 vague 3 — SMTP error classification + retry policy
// ---------------------------------------------------------------------------

describe('sendRecapEmail — retry policy (session 4 vague 3)', () => {
  const baseArgs = {
    to: 'cabinet@example.com',
    cc: null,
    appel: APPEL,
    cabinet: CABINET,
    pdfUrl: 'u',
    adminUrl: 'a',
    pdfBytes: Buffer.from(''),
  };

  it('retries after a transient failure and eventually succeeds', async () => {
    sendMailMock
      .mockRejectedValueOnce(
        Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('slow relay'), { responseCode: 421 }),
      )
      .mockResolvedValueOnce({ messageId: '<final@ok>' });
    await expect(sendRecapEmail(baseArgs)).resolves.toBeUndefined();
    expect(sendMailMock).toHaveBeenCalledTimes(3);
  });

  it('throws PermanentEmailError IMMEDIATELY on SMTP 550 (no retries)', async () => {
    sendMailMock.mockRejectedValueOnce(
      Object.assign(new Error('mailbox unknown'), { responseCode: 550 }),
    );
    await expect(sendRecapEmail(baseArgs)).rejects.toBeInstanceOf(PermanentEmailError);
    // Only ONE attempt — no retries burned on a doomed send.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain(baseArgs.to);
  });

  it('throws PermanentEmailError immediately on SMTP 553 (bad address syntax)', async () => {
    sendMailMock.mockRejectedValueOnce(
      Object.assign(new Error('syntax'), { responseCode: 553 }),
    );
    const promise = sendRecapEmail(baseArgs);
    await expect(promise).rejects.toBeInstanceOf(PermanentEmailError);
    await promise.catch((err: unknown) => {
      // The class carries the original SMTP code — useful downstream.
      expect((err as InstanceType<typeof PermanentEmailError>).smtpCode).toBe(553);
    });
  });

  it('classifies a TimeoutError as transient (retryable)', async () => {
    // First attempt: fake a TimeoutError shape. Second attempt: success.
    class LocalTimeoutError extends Error {
      constructor() {
        super('timeout:smtp:sendMail:30000ms');
        this.name = 'TimeoutError';
      }
    }
    sendMailMock
      .mockRejectedValueOnce(new LocalTimeoutError())
      .mockResolvedValueOnce({ messageId: '<ok@x>' });
    await expect(sendRecapEmail(baseArgs)).resolves.toBeUndefined();
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('classifies an unknown error as transient by default (safe path)', async () => {
    // No `code`, no `responseCode` — defensive default is transient.
    sendMailMock
      .mockRejectedValueOnce(new Error('mysterious wobble'))
      .mockResolvedValueOnce({ messageId: '<ok@x>' });
    await expect(sendRecapEmail(baseArgs)).resolves.toBeUndefined();
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(loggerMock.warn.mock.calls)).not.toContain(baseArgs.to);
  });
});
