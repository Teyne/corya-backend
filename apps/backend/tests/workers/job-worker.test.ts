/**
 * Unit tests — workers/job-worker.ts
 *
 * We prove:
 *   - a claimed process_appel job that succeeds is finished with completeJob
 *   - a thrown error becomes failJob(..., backoffSeconds > 0)
 *   - an unknown type does NOT crash the worker; it lands in failJob too
 *   - the backoff argument scales with attempts (exponential)
 *
 * The worker loop is exercised with `runOnce: true` so tests do not spin
 * forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/types/index.js';

const claimJobsMock = vi.fn<(workerId: string, batchSize: number) => Promise<Job[]>>();
const completeJobMock = vi.fn<(jobId: string) => Promise<void>>(
  () => Promise.resolve(undefined),
);
const failJobMock = vi.fn<(jobId: string, err: string, backoff: number) => Promise<void>>(
  () => Promise.resolve(undefined),
);

vi.mock('../../src/db/queries.js', () => ({
  claimJobs: claimJobsMock,
  completeJob: completeJobMock,
  failJob: failJobMock,
}));

const processAppelJobMock = vi.fn<(job: Job) => Promise<void>>(
  () => Promise.resolve(undefined),
);
// The worker imports the two pipeline error classes (in addition to
// `processAppelJob`) so its whitelist check on `err.name` works. Expose
// them from the mock verbatim — the class NAME is the whole contract.
vi.mock('../../src/services/appel-processor.js', () => {
  class PdfPipelineError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PdfPipelineError';
    }
  }
  class EmailPipelineError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'EmailPipelineError';
    }
  }
  return {
    processAppelJob: processAppelJobMock,
    PdfPipelineError,
    EmailPipelineError,
  };
});

// Puppeteer and Nodemailer helpers must be no-ops (worker.ts imports them
// through job-worker.ts's dispatch). We stub them so no browser/SMTP is ever
// touched.
vi.mock('../../src/services/pdf.js', () => ({
  closeBrowser: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../../src/services/email.js', () => ({
  closeTransporter: vi.fn(),
}));

const { runJobWorker } = await import('../../src/workers/job-worker.js');

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: overrides?.id ?? 'job-1',
    type: overrides?.type ?? 'process_appel',
    appel_id: 'appel-1',
    payload: {},
    status: 'processing',
    attempts: overrides?.attempts ?? 1,
    max_attempts: 5,
    run_after: '2026-07-31T09:42:00.000Z',
    locked_at: '2026-07-31T09:42:01.000Z',
    locked_by: 'worker-test',
    last_error: null,
    created_at: '2026-07-31T09:42:00.000Z',
    updated_at: '2026-07-31T09:42:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  claimJobsMock.mockReset();
  completeJobMock.mockReset().mockResolvedValue(undefined);
  failJobMock.mockReset().mockResolvedValue(undefined);
  processAppelJobMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runJobWorker', () => {
  it('claims a batch, runs process_appel, and completes each job', async () => {
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'job-a' }), makeJob({ id: 'job-b' })]);
    claimJobsMock.mockResolvedValue([]);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(processAppelJobMock).toHaveBeenCalledTimes(2);
    expect(completeJobMock).toHaveBeenCalledTimes(2);
    expect(completeJobMock.mock.calls.map((c) => c?.[0])).toEqual(
      expect.arrayContaining(['job-a', 'job-b']),
    );
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it('fails a job with backoff when process_appel throws', async () => {
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'job-x', attempts: 2 })]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new Error('boom'));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(completeJobMock).not.toHaveBeenCalled();
    expect(failJobMock).toHaveBeenCalledTimes(1);
    const call = failJobMock.mock.calls[0];
    if (!call) throw new Error('failJob not called');
    const [jobId, errMsg, backoff] = call;
    expect(jobId).toBe('job-x');
    expect(typeof errMsg).toBe('string');
    // Backoff must be > 0 and bounded by the 300s cap.
    expect(backoff).toBeGreaterThan(0);
    expect(backoff).toBeLessThanOrEqual(300);
  });

  it('routes an unknown job type to failJob rather than crashing', async () => {
    claimJobsMock.mockResolvedValueOnce([
      makeJob({ id: 'job-unknown', type: 'purge_audio_retell' }),
    ]);
    claimJobsMock.mockResolvedValue([]);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(processAppelJobMock).not.toHaveBeenCalled();
    expect(failJobMock).toHaveBeenCalledTimes(1);
    const call = failJobMock.mock.calls[0];
    if (!call) throw new Error('failJob not called');
    expect(call[1]).toMatch(/unhandled_job_type:purge_audio_retell/);
  });

  it('exits cleanly when claimJobs returns [] and runOnce is set', async () => {
    claimJobsMock.mockResolvedValue([]);
    const worker = runJobWorker({ runOnce: true, pollIntervalMs: 50 });
    await worker.stopped;
    expect(processAppelJobMock).not.toHaveBeenCalled();
  });

  it('backoff grows with attempts (exponential)', async () => {
    // attempts=1 -> base = 2^1 = 2 s + jitter <= 32 s
    // attempts=5 -> base = 2^5 = 32 s + jitter <= 62 s
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'j1', attempts: 1 })]);
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'j2', attempts: 5 })]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValue(new Error('boom'));

    const w1 = runJobWorker({ runOnce: true });
    await w1.stopped;
    const w2 = runJobWorker({ runOnce: true });
    await w2.stopped;

    expect(failJobMock).toHaveBeenCalledTimes(2);
    const call1 = failJobMock.mock.calls[0];
    const call2 = failJobMock.mock.calls[1];
    if (!call1 || !call2) throw new Error('failJob calls missing');
    const backoff1 = call1[2];
    const backoff2 = call2[2];
    expect(backoff2).toBeGreaterThan(backoff1);
  });
});

// ---------------------------------------------------------------------------
// nLPD regression — session 3.1 audit
// ---------------------------------------------------------------------------
// The worker used to persist `${errName}:${errMsg}` into `jobs.last_error`.
// `err.message` from an external library (Puppeteer error including HTML
// fragments with patient_nom + transcript, supabase-js error with
// Postgres DETAIL leaking column values, Nodemailer error mirroring the
// SMTP response) would land in a compliance-audited DB column.
//
// The fix: keep `err.message` only for a whitelisted set of pipeline error
// classes whose messages are constant by construction; for anything else,
// substitute a generic `redacted_external_error` marker.

describe('runJobWorker — nLPD: jobs.last_error redaction', () => {
  const PII_SENTINEL_PUPPETEER =
    'Evaluation failed: transcript "Agent: Bonjour Marie-SENTINEL-DUPONT au +41791234567-SENTINEL"';
  const PII_SENTINEL_PG =
    'duplicate key value violates unique constraint "appels_pkey" DETAIL: Key (patient_telephone)=(+41791234567-SENTINEL)';

  it('replaces an UNTRUSTED Puppeteer-style error message with a generic marker', async () => {
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'j-pup' })]);
    claimJobsMock.mockResolvedValue([]);
    // Simulate a raw Puppeteer error class name + PII-laden message.
    const puppeteerErr = Object.assign(new Error(PII_SENTINEL_PUPPETEER), {
      name: 'ProtocolError',
    });
    processAppelJobMock.mockRejectedValueOnce(puppeteerErr);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(failJobMock).toHaveBeenCalledTimes(1);
    const [, persisted] = failJobMock.mock.calls[0] ?? [];
    // Positive: class name is kept for debuggability.
    expect(persisted).toContain('ProtocolError');
    // Positive: a stable marker signals "look at the logs, not this column".
    expect(persisted).toContain('redacted_external_error');
    // Negative: the sentinel embedded in .message must NOT survive.
    expect(persisted, 'PII from external error message leaked into jobs.last_error').not.toContain(
      'Marie-SENTINEL-DUPONT',
    );
    expect(persisted).not.toContain('+41791234567-SENTINEL');
  });

  it('replaces an UNTRUSTED Postgres-style error message with a generic marker', async () => {
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'j-pg' })]);
    claimJobsMock.mockResolvedValue([]);
    const pgErr = Object.assign(new Error(PII_SENTINEL_PG), {
      name: 'PostgrestError',
    });
    processAppelJobMock.mockRejectedValueOnce(pgErr);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(failJobMock).toHaveBeenCalledTimes(1);
    const [, persisted] = failJobMock.mock.calls[0] ?? [];
    expect(persisted).toContain('PostgrestError');
    expect(persisted).toContain('redacted_external_error');
    expect(persisted).not.toContain('+41791234567-SENTINEL');
    expect(persisted).not.toContain('patient_telephone');
  });

  it('KEEPS the message verbatim for the whitelisted PdfPipelineError class', async () => {
    // Import the mocked classes lazily so they resolve against the module
    // mock (same instances the SUT sees).
    const { PdfPipelineError } = await import(
      '../../src/services/appel-processor.js'
    );
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'j-safe' })]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new PdfPipelineError('pdf_render_failed'));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(failJobMock).toHaveBeenCalledTimes(1);
    const [, persisted] = failJobMock.mock.calls[0] ?? [];
    // The whitelisted class carries a constant message — safe to persist.
    expect(persisted).toBe('PdfPipelineError:pdf_render_failed');
  });
});
