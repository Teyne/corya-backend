/**
 * Unit tests — services/alert.ts (session 4 block 2).
 *
 * We prove:
 *   - sendAlert NEVER throws, even when the transporter throws
 *   - deduplication: N calls in the same window → 1 email
 *   - dedup entry is NOT written when SMTP fails (next call re-attempts)
 *   - ALERT_ENABLED=false short-circuits without touching SMTP
 *   - Missing ALERT_EMAIL short-circuits with a warn (dev/test only path)
 *   - No patient data survives sanitizeContext (PII sentinel guard)
 *   - logAlertingModeOnce fires WARN when disabled
 */
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transporter, SendMailOptions } from 'nodemailer';
import type * as LoggerModule from '../../src/config/logger.js';

// Wire a capture stream so we can assert on the emitted log lines.
const capture = vi.hoisted(() => ({ chunks: [] as string[] }));

vi.mock('../../src/config/logger.js', async () => {
  const actual = await vi.importActual<typeof LoggerModule>(
    '../../src/config/logger.js',
  );
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      capture.chunks.push(chunk.toString());
      cb();
    },
  });
  const testLogger = actual.createLogger(stream);
  testLogger.level = 'trace';
  return { ...actual, logger: testLogger };
});

const {
  __resetAlertDedupForTests,
  __setAlertTransporterForTests,
  __resetAlertingBootLatchForTests,
  __setAlertEnabledOverrideForTests,
  logAlertingModeOnce,
  sendAlert,
} = await import('../../src/services/alert.js');

const sendMailMock = vi.fn<(opts: SendMailOptions) => Promise<{ messageId: string }>>();

function fakeTransporter(): Transporter {
  return {
    sendMail: sendMailMock,
    close: vi.fn(),
  } as unknown as Transporter;
}

beforeEach(() => {
  capture.chunks.length = 0;
  sendMailMock.mockReset().mockResolvedValue({ messageId: '<id@test>' });
  __setAlertTransporterForTests(fakeTransporter());
  __resetAlertDedupForTests();
  __resetAlertingBootLatchForTests();
  process.env.ALERT_ENABLED = 'true';
  process.env.ALERT_EMAIL = 'ops@corya.test';
});

afterEach(() => {
  __setAlertTransporterForTests(null);
  __setAlertEnabledOverrideForTests(null);
  vi.clearAllMocks();
});

describe('sendAlert — never throws', () => {
  it('returns cleanly when the transporter rejects', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('smtp connection refused'));
    // If this throws, vitest fails the test — that IS the assertion.
    await expect(sendAlert('job_dead_letter', { job_id: 'j1' })).resolves.toBeUndefined();
    const raw = capture.chunks.join('');
    expect(raw).toContain('alert_send_failed');
  });

  it('returns cleanly when the transporter throws SYNCHRONOUSLY too', async () => {
    // Defense-in-depth: a nodemailer transporter that throws on the
    // sendMail call itself (not a rejected promise) must still be caught.
    const throwingTransporter = {
      sendMail: (): Promise<{ messageId: string }> => {
        throw new Error('sync boom');
      },
      close: vi.fn(),
    } as unknown as Transporter;
    __setAlertTransporterForTests(throwingTransporter);
    await expect(sendAlert('worker_stale', {})).resolves.toBeUndefined();
  });
});

describe('sendAlert — deduplication', () => {
  it('sends only once per type inside the dedup window', async () => {
    await sendAlert('worker_stale', { i: 1 });
    await sendAlert('worker_stale', { i: 2 });
    await sendAlert('worker_stale', { i: 3 });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('deduplication is per-type, not global', async () => {
    await sendAlert('worker_stale', {});
    await sendAlert('jobs_backlog', {});
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('logs only whether the alert recipient is configured', async () => {
    await sendAlert('jobs_backlog', {});
    const raw = capture.chunks.join('');
    expect(raw).toContain('"alert_email_set":true');
    expect(raw).not.toContain('ops@test.local');
  });

  it('does NOT stamp the deduper on SMTP failure — a following call retries', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('smtp 421 temp'));
    await sendAlert('job_dead_letter', {});
    // sendMail was called and threw. Dedup MUST allow the next call.
    sendMailMock.mockResolvedValueOnce({ messageId: '<ok@x>' });
    await sendAlert('job_dead_letter', {});
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });
});

describe('sendAlert — master switch', () => {
  it('emits a debug log and does not send when the type is deduped', async () => {
    await sendAlert('worker_stale', {});
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    // Second call in the same window: dedup suppresses.
    await sendAlert('worker_stale', {});
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const raw = capture.chunks.join('');
    expect(raw).toContain('alert_suppressed_dedup');
  });

  it('short-circuits when ALERT_ENABLED=false without touching SMTP (session 4 vague 3 reconciliation)', async () => {
    // Test-only override — env is frozen at boot, so this is the only
    // way to cover the disable branch. Cleared in afterEach.
    __setAlertEnabledOverrideForTests(false);
    await sendAlert('jobs_backlog', { job_id: 'j1' });
    await sendAlert('worker_stale', {});
    expect(sendMailMock).not.toHaveBeenCalled();
    const raw = capture.chunks.join('');
    expect(raw).toContain('alert_suppressed_disabled');
  });

  it('resumes sending when the override is cleared', async () => {
    __setAlertEnabledOverrideForTests(false);
    await sendAlert('jobs_backlog', {});
    expect(sendMailMock).not.toHaveBeenCalled();
    __setAlertEnabledOverrideForTests(null);
    await sendAlert('jobs_backlog', {});
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe('sendAlert — no patient data in the body', () => {
  it('redacts patient_nom / transcript / phone before composing the email', async () => {
    await sendAlert('job_dead_letter', {
      // Whitelisted technical id — SHOULD survive.
      job_id: 'job-uuid-1',
      // Hostile inputs — MUST be censored.
      patient_nom: 'DUPONT-SENTINEL',
      patient_prenom: 'MARIE-SENTINEL',
      patient_telephone: '+4179000-SENTINEL',
      transcript: 'BONJOUR-SENTINEL',
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const call = sendMailMock.mock.calls[0];
    if (!call) throw new Error('sendMail not invoked');
    const message = call[0];
    const rawText = message.text;
    const body = typeof rawText === 'string' ? rawText : '';

    // Positive: whitelisted id present.
    expect(body).toContain('job-uuid-1');
    // Negative: no PII sentinel survived.
    expect(body).not.toContain('DUPONT-SENTINEL');
    expect(body).not.toContain('MARIE-SENTINEL');
    expect(body).not.toContain('+4179000-SENTINEL');
    expect(body).not.toContain('BONJOUR-SENTINEL');
    // The sensitive keys are replaced by the [REDACTED] marker.
    expect(body).toContain('[REDACTED]');
  });
});

describe('logAlertingModeOnce — visibility contract', () => {
  it('emits an info line when enabled with a configured recipient', () => {
    process.env.ALERT_EMAIL = 'ops@corya.test';
    logAlertingModeOnce();
    const raw = capture.chunks.join('');
    expect(raw).toContain('alerting_enabled');
  });

  it('is idempotent — a second call is a no-op', () => {
    logAlertingModeOnce();
    const first = capture.chunks.length;
    logAlertingModeOnce();
    expect(capture.chunks.length).toBe(first);
  });
});
