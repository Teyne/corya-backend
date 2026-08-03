/**
 * Unit tests — services/alert-pollers.ts (session 4 block 2).
 *
 * We prove:
 *   - dead_letter poller: SMTP OK → row is stamped exactly once
 *   - dead_letter poller: SMTP fails → row is NOT stamped, re-alert next pass
 *   - dead_letter poller: pdf_orphelin fires when checkpoint payload matches
 *   - worker_stale poller: fires when getStaleWorkerHeartbeats returns rows
 *   - jobs_backlog poller: fires only above threshold
 *   - all-checks pass: independent — one failure does not skip the others
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transporter, SendMailOptions } from 'nodemailer';
import type { FileDeletion, Job } from '../../src/types/index.js';

// -- DB queries mock -------------------------------------------------------
const getStaleWorkerHeartbeatsMock = vi.fn<
  (seenSec: number, pollSec: number) => Promise<{
    worker_id: string;
    last_seen_at: string;
    last_poll_at: string | null;
    last_deletion_poll_at: string | null;
  }[]>
>(() => Promise.resolve([]));
const countPendingJobsOlderThanMock = vi.fn<(sec: number) => Promise<number>>(
  () => Promise.resolve(0),
);
const getDeadLetterJobsToAlertMock = vi.fn<(limit: number) => Promise<Job[]>>(
  () => Promise.resolve([]),
);
const markDeadLetterAlertedMock = vi.fn<(jobId: string) => Promise<void>>(
  () => Promise.resolve(undefined),
);
const claimFileDeletionDeadLetterAlertsMock = vi.fn<
  (alerterId: string, batchSize: number, staleAfterSeconds: number) => Promise<FileDeletion[]>
>(() => Promise.resolve([]));
const markFileDeletionDeadLetterAlertedMock = vi.fn<
  (deletionId: string, alerterId: string, lockedAt: string) => Promise<boolean>
>(() => Promise.resolve(true));
const releaseFileDeletionDeadLetterAlertMock = vi.fn<
  (deletionId: string, alerterId: string, lockedAt: string) => Promise<boolean>
>(() => Promise.resolve(true));
// Session 4 vague 4 — cron_stale poller depends on getCronHealth.
const getCronHealthMock = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));

vi.mock('../../src/db/queries.js', () => ({
  getStaleWorkerHeartbeats: getStaleWorkerHeartbeatsMock,
  countPendingJobsOlderThan: countPendingJobsOlderThanMock,
  getDeadLetterJobsToAlert: getDeadLetterJobsToAlertMock,
  markDeadLetterAlerted: markDeadLetterAlertedMock,
  claimFileDeletionDeadLetterAlerts: claimFileDeletionDeadLetterAlertsMock,
  markFileDeletionDeadLetterAlerted: markFileDeletionDeadLetterAlertedMock,
  releaseFileDeletionDeadLetterAlert: releaseFileDeletionDeadLetterAlertMock,
  getCronHealth: getCronHealthMock,
}));

// -- alert.ts (fire-and-forget path) -- mocked to a spy resolver ----------
const sendAlertMock = vi.fn<(type: string, ctx?: Record<string, unknown>) => Promise<void>>(
  () => Promise.resolve(undefined),
);
vi.mock('../../src/services/alert.js', () => ({
  sendAlert: sendAlertMock,
}));

const sendMailMock = vi.fn<(opts: SendMailOptions) => Promise<{ messageId: string }>>();
function fakeTransporter(): Transporter {
  return {
    sendMail: sendMailMock,
    close: vi.fn(),
  } as unknown as Transporter;
}

const {
  checkWorkerStale,
  checkJobsBacklog,
  checkCronStale,
  pollDeadLetterAlerts,
  pollFileDeletionDeadLetterAlerts,
  startAlertPollers,
  __setReceiptTransporterForTests,
} = await import('../../src/services/alert-pollers.js');

function makeDeadLetterJob(overrides?: Partial<Job>): Job {
  return {
    id: overrides?.id ?? 'dl-1',
    type: overrides?.type ?? 'process_appel',
    appel_id: overrides?.appel_id ?? 'appel-1',
    payload: overrides?.payload ?? {},
    status: 'dead_letter',
    attempts: overrides?.attempts ?? 5,
    max_attempts: overrides?.max_attempts ?? 5,
    run_after: '2026-08-01T09:00:00.000Z',
    locked_at: null,
    locked_by: null,
    last_error: overrides?.last_error ?? 'PdfPipelineError:pdf_render_failed',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:00.000Z',
    correlation_id: overrides?.correlation_id ?? 'corr-1',
    dead_letter_alerted_at: null,
    ...overrides,
  };
}

function makeDeadLetterDeletion(overrides?: Partial<FileDeletion>): FileDeletion {
  return {
    id: 'deletion-1',
    target: 'supabase_storage',
    bucket: 'pdf-recaps',
    object_path: 'sensitive/object.pdf',
    external_ref: null,
    reason: 'appel_purged_24m',
    status: 'dead_letter',
    attempts: 10,
    max_attempts: 10,
    run_after: '2026-08-01T09:00:00.000Z',
    locked_at: null,
    locked_by: null,
    last_error: 'TimeoutError:redacted_external_error',
    enqueued_by: 'purge_ancient_appels',
    source_appel_id: 'source-appel-secret',
    source_cabinet_id: 'source-cabinet-secret',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:00.000Z',
    deleted_at: null,
    dead_letter_alerted_at: null,
    dead_letter_alert_locked_at: '2026-08-03T10:11:12.123456Z',
    dead_letter_alert_locked_by: 'api-alert-owner',
    ...overrides,
  };
}

beforeEach(() => {
  getStaleWorkerHeartbeatsMock.mockReset().mockResolvedValue([]);
  countPendingJobsOlderThanMock.mockReset().mockResolvedValue(0);
  getDeadLetterJobsToAlertMock.mockReset().mockResolvedValue([]);
  markDeadLetterAlertedMock.mockReset().mockResolvedValue(undefined);
  claimFileDeletionDeadLetterAlertsMock.mockReset().mockResolvedValue([]);
  markFileDeletionDeadLetterAlertedMock.mockReset().mockResolvedValue(true);
  releaseFileDeletionDeadLetterAlertMock.mockReset().mockResolvedValue(true);
  getCronHealthMock.mockReset().mockResolvedValue([]);
  sendAlertMock.mockReset().mockResolvedValue(undefined);
  sendMailMock.mockReset().mockResolvedValue({ messageId: '<id@test>' });
  __setReceiptTransporterForTests(fakeTransporter());
  process.env.ALERT_ENABLED = 'true';
  process.env.ALERT_EMAIL = 'ops@corya.test';
});

afterEach(() => {
  __setReceiptTransporterForTests(null);
  vi.clearAllMocks();
});

// -----------------------------------------------------------------------
describe('checkWorkerStale', () => {
  it('does nothing when no workers are stale', async () => {
    await checkWorkerStale();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('fires worker_stale when at least one worker is stale', async () => {
    getStaleWorkerHeartbeatsMock.mockResolvedValueOnce([
      {
        worker_id: 'worker-abc-123',
        last_seen_at: new Date(Date.now() - 120_000).toISOString(),
        last_poll_at: new Date(Date.now() - 300_000).toISOString(),
        last_deletion_poll_at: new Date(Date.now() - 300_000).toISOString(),
      },
    ]);
    await checkWorkerStale();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0]?.[0]).toBe('worker_stale');
    const ctx = sendAlertMock.mock.calls[0]?.[1] ?? {};
    expect(ctx).toMatchObject({
      stale_worker_count: 1,
      first_worker_id: 'worker-abc-123',
    });
  });
});

// -----------------------------------------------------------------------
describe('pollFileDeletionDeadLetterAlerts — persistent fenced delivery', () => {
  it('claims then marks the exact opaque alert lease after SMTP success', async () => {
    const row = makeDeadLetterDeletion();
    claimFileDeletionDeadLetterAlertsMock.mockResolvedValueOnce([row]);

    await pollFileDeletionDeadLetterAlerts();

    const alerterId = claimFileDeletionDeadLetterAlertsMock.mock.calls[0]?.[0];
    expect(alerterId).toBeTruthy();
    expect(markFileDeletionDeadLetterAlertedMock).toHaveBeenCalledWith(
      row.id,
      alerterId,
      '2026-08-03T10:11:12.123456Z',
    );
    expect(releaseFileDeletionDeadLetterAlertMock).not.toHaveBeenCalled();
  });

  it('releases the exact lease after SMTP failure so a later pass can retry', async () => {
    const row = makeDeadLetterDeletion();
    claimFileDeletionDeadLetterAlertsMock.mockResolvedValueOnce([row]);
    sendMailMock.mockRejectedValueOnce(new Error('smtp unavailable'));

    await pollFileDeletionDeadLetterAlerts();

    const alerterId = claimFileDeletionDeadLetterAlertsMock.mock.calls[0]?.[0];
    expect(releaseFileDeletionDeadLetterAlertMock).toHaveBeenCalledWith(
      row.id,
      alerterId,
      '2026-08-03T10:11:12.123456Z',
    );
    expect(markFileDeletionDeadLetterAlertedMock).not.toHaveBeenCalled();
  });

  it('never includes deletion coordinates or source identifiers in the alert body', async () => {
    claimFileDeletionDeadLetterAlertsMock.mockResolvedValueOnce([makeDeadLetterDeletion({
      bucket: 'BUCKET-PII-SENTINEL',
      object_path: 'OBJECT-PATH-PII-SENTINEL',
      external_ref: null,
      source_appel_id: 'SOURCE-APPEL-PII-SENTINEL',
      last_error: 'LAST-ERROR-PII-SENTINEL',
    })]);

    await pollFileDeletionDeadLetterAlerts();

    const rawText = sendMailMock.mock.calls[0]?.[0]?.text;
    const body = typeof rawText === 'string' ? rawText : '';
    expect(body).not.toContain('BUCKET-PII-SENTINEL');
    expect(body).not.toContain('OBJECT-PATH-PII-SENTINEL');
    expect(body).not.toContain('SOURCE-APPEL-PII-SENTINEL');
    expect(body).not.toContain('LAST-ERROR-PII-SENTINEL');
    expect(body).not.toContain('source_cabinet_id');
    expect(body).not.toContain('external_ref');
  });
});

// -----------------------------------------------------------------------
describe('checkJobsBacklog', () => {
  it('does nothing when backlog <= threshold', async () => {
    countPendingJobsOlderThanMock.mockResolvedValueOnce(20); // threshold from setup.ts
    await checkJobsBacklog();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('fires jobs_backlog above the threshold', async () => {
    countPendingJobsOlderThanMock.mockResolvedValueOnce(42);
    await checkJobsBacklog();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const call = sendAlertMock.mock.calls[0];
    expect(call?.[0]).toBe('jobs_backlog');
    expect(call?.[1]).toMatchObject({ pending_count: 42 });
  });
});

// -----------------------------------------------------------------------
describe('pollDeadLetterAlerts — idempotence contract', () => {
  it('stamps dead_letter_alerted_at exactly once after a confirmed SMTP send', async () => {
    getDeadLetterJobsToAlertMock.mockResolvedValueOnce([makeDeadLetterJob({ id: 'dl-x' })]);
    await pollDeadLetterAlerts();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(markDeadLetterAlertedMock).toHaveBeenCalledWith('dl-x');
  });

  it('does NOT stamp when SMTP fails — re-alerts on the next pass', async () => {
    getDeadLetterJobsToAlertMock.mockResolvedValueOnce([makeDeadLetterJob({ id: 'dl-y' })]);
    sendMailMock.mockRejectedValueOnce(new Error('smtp 421 temp'));

    await pollDeadLetterAlerts();
    expect(markDeadLetterAlertedMock).not.toHaveBeenCalled();

    // Simulate the next pass: same row still comes back (still unalerted).
    getDeadLetterJobsToAlertMock.mockResolvedValueOnce([makeDeadLetterJob({ id: 'dl-y' })]);
    sendMailMock.mockResolvedValueOnce({ messageId: '<ok@x>' });
    await pollDeadLetterAlerts();
    expect(markDeadLetterAlertedMock).toHaveBeenCalledWith('dl-y');
  });

  it('sends pdf_orphelin BEFORE the generic dead_letter alert when checkpoint matches', async () => {
    getDeadLetterJobsToAlertMock.mockResolvedValueOnce([
      makeDeadLetterJob({
        id: 'dl-orph',
        payload: {
          steps: {
            pdf_uploaded_at: '2026-08-01T09:00:10.000Z',
            storage_path: 'cab/2026-08/appel.pdf',
          },
        },
      }),
    ]);
    await pollDeadLetterAlerts();
    // Two SMTP sends: pdf_orphelin + job_dead_letter.
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const subjects = sendMailMock.mock.calls.map((c) => c?.[0]?.subject ?? '');
    expect(subjects[0]).toContain('pdf_orphelin');
    expect(subjects[1]).toContain('job_dead_letter');
    expect(markDeadLetterAlertedMock).toHaveBeenCalledWith('dl-orph');
  });

  it('does NOT stamp when pdf_orphelin succeeds but dead_letter SMTP fails', async () => {
    getDeadLetterJobsToAlertMock.mockResolvedValueOnce([
      makeDeadLetterJob({
        id: 'dl-partial',
        payload: {
          steps: { storage_path: 'cab/2026-08/appel.pdf' },
        },
      }),
    ]);
    // First send (pdf_orphelin) OK, second (dead_letter) fails.
    sendMailMock
      .mockResolvedValueOnce({ messageId: '<orph@ok>' })
      .mockRejectedValueOnce(new Error('smtp glitch'));
    await pollDeadLetterAlerts();
    expect(markDeadLetterAlertedMock).not.toHaveBeenCalled();
  });

  it('carries only technical identifiers in the SMTP body (no PII sentinel)', async () => {
    const SENTINEL = 'PATIENT-PII-SENTINEL';
    getDeadLetterJobsToAlertMock.mockResolvedValueOnce([
      makeDeadLetterJob({
        id: 'dl-pii',
        // Extra hostile payload key — must not be surfaced by the poller.
        payload: {
          steps: { storage_path: 'cab/x.pdf' },
          patient_nom: SENTINEL,
        },
        last_error: 'PdfPipelineError:pdf_render_failed',
      }),
    ]);
    await pollDeadLetterAlerts();
    for (const call of sendMailMock.mock.calls) {
      const rawText = call?.[0]?.text;
      const body = typeof rawText === 'string' ? rawText : '';
      expect(body, 'PII leaked into dead_letter alert body').not.toContain(SENTINEL);
    }
  });
});

// -----------------------------------------------------------------------
describe('startAlertPollers — runOnce boot pass', () => {
  it('runs all three checks in one pass and returns', async () => {
    getStaleWorkerHeartbeatsMock.mockResolvedValueOnce([
      {
        worker_id: 'w-1',
        last_seen_at: new Date(Date.now() - 120_000).toISOString(),
        last_poll_at: null,
        last_deletion_poll_at: null,
      },
    ]);
    countPendingJobsOlderThanMock.mockResolvedValueOnce(999);

    const pollers = startAlertPollers({ runOnce: true });
    await pollers.stopped;

    expect(sendAlertMock).toHaveBeenCalledWith('worker_stale', expect.any(Object));
    expect(sendAlertMock).toHaveBeenCalledWith('jobs_backlog', expect.any(Object));
  });

  it('a failing DB query for one check does NOT prevent the others from running', async () => {
    getStaleWorkerHeartbeatsMock.mockRejectedValueOnce(new Error('db blip'));
    countPendingJobsOlderThanMock.mockResolvedValueOnce(999);

    const pollers = startAlertPollers({ runOnce: true });
    await pollers.stopped;

    // backlog alert still fired.
    expect(sendAlertMock).toHaveBeenCalledWith('jobs_backlog', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// Session 4 vague 4 — cron_stale
// ---------------------------------------------------------------------------
describe('checkCronStale (session 4 vague 4)', () => {
  it('does NOT fire when every supervised cron is fresh', async () => {
    // Full healthy set for the 8 supervised crons.
    const now = new Date().toISOString();
    getCronHealthMock.mockResolvedValueOnce(
      [
        'purge-expired-audio',
        'anonymize-old-transcripts',
        'purge-old-pdfs',
        'purge-ancient-appels',
        'requeue-stuck-jobs',
        'requeue-stuck-file-deletions',
        'purge-stale-worker-heartbeats',
        'purge-cron-run-details',
        'purge-ancient-logs-actions',
        'purge-terminal-file-deletions',
      ].map((jobname) => ({
        jobname,
        schedule: '* * * * *',
        last_run_at: now,
        last_success_at: now,
        last_status: 'succeeded',
        seconds_since_last_run: 5,
        seconds_since_last_success: 5,
        total_runs_last_24h: 100,
        failed_runs_last_24h: 0,
      })),
    );
    await checkCronStale();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('fires cron_stale with the failing jobnames when a cron is missing from DB', async () => {
    // Empty snapshot → every supervised cron reported missing.
    getCronHealthMock.mockResolvedValueOnce([]);
    await checkCronStale();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const call = sendAlertMock.mock.calls[0];
    expect(call?.[0]).toBe('cron_stale');
    const ctx = call?.[1] as {
      stale_count: number;
      stale: Array<{ jobname: string; reason: string }>;
    };
    expect(ctx.stale_count).toBeGreaterThan(0);
    // Every entry is missing_cron in this pass.
    for (const s of ctx.stale) {
      expect(s.reason).toBe('missing_cron');
    }
  });

  it('does not throw when getCronHealth rejects — logs and returns', async () => {
    getCronHealthMock.mockRejectedValueOnce(new Error('db blip'));
    await expect(checkCronStale()).resolves.toBeUndefined();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });
});
