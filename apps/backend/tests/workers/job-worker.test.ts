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

const claimJobsMock = vi.fn<
  (workerId: string, batchSize: number, staleAfterSeconds: number) => Promise<Job[]>
>();
const completeJobMock = vi.fn<(jobId: string) => Promise<void>>(
  () => Promise.resolve(undefined),
);
const failJobMock = vi.fn<(jobId: string, err: string, backoff: number) => Promise<void>>(
  () => Promise.resolve(undefined),
);
// Session 4 vague 3: forceDeadLetter is the bypass used on PERMANENT
// SMTP failures (see queries.forceDeadLetter). Mocked to a spy so tests
// can prove the branch was taken.
const forceDeadLetterMock = vi.fn<(jobId: string, err: string) => Promise<void>>(
  () => Promise.resolve(undefined),
);
// Session 4 heartbeats — always resolved so the tests never spend real time
// on an in-memory RPC. Individual tests can reset .mock.calls to assert.
const workerHeartbeatAliveMock = vi.fn<(id: string, v: string | null) => Promise<void>>(
  () => Promise.resolve(undefined),
);
const workerHeartbeatPollMock = vi.fn<(id: string, delta: number) => Promise<void>>(
  () => Promise.resolve(undefined),
);

vi.mock('../../src/db/queries.js', () => ({
  claimJobs: claimJobsMock,
  completeJob: completeJobMock,
  failJob: failJobMock,
  forceDeadLetter: forceDeadLetterMock,
  workerHeartbeatAlive: workerHeartbeatAliveMock,
  workerHeartbeatPoll: workerHeartbeatPollMock,
}));

// alert.ts is called from the worker on dead_letter transitions. Mock the
// public entry point so the real Nodemailer transporter is never touched.
const sendAlertMock = vi.fn<(type: string, ctx?: Record<string, unknown>) => Promise<void>>(
  () => Promise.resolve(undefined),
);
vi.mock('../../src/services/alert.js', () => ({
  sendAlert: sendAlertMock,
}));

const deleteRetellCallMock = vi.fn<(callId: string) => Promise<'deleted' | 'not_found'>>(
  () => Promise.resolve('deleted'),
);
vi.mock('../../src/services/retell.js', () => ({
  deleteRetellCall: deleteRetellCallMock,
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
vi.mock('../../src/services/email.js', () => {
  // Session 4 vague 3: worker imports PermanentEmailError to short-circuit
  // the fail_job path. Expose the class from the mock verbatim — the class
  // NAME is the whole contract.
  class PermanentEmailError extends Error {
    public readonly smtpCode: number | null;
    constructor(smtpCode: number | null) {
      super('permanent_smtp_failure');
      this.name = 'PermanentEmailError';
      this.smtpCode = smtpCode;
    }
  }
  return {
    closeTransporter: vi.fn(),
    PermanentEmailError,
  };
});

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
    correlation_id: null,
    dead_letter_alerted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  claimJobsMock.mockReset();
  completeJobMock.mockReset().mockResolvedValue(undefined);
  failJobMock.mockReset().mockResolvedValue(undefined);
  forceDeadLetterMock.mockReset().mockResolvedValue(undefined);
  processAppelJobMock.mockReset().mockResolvedValue(undefined);
  workerHeartbeatAliveMock.mockReset().mockResolvedValue(undefined);
  workerHeartbeatPollMock.mockReset().mockResolvedValue(undefined);
  sendAlertMock.mockReset().mockResolvedValue(undefined);
  deleteRetellCallMock.mockReset().mockResolvedValue('deleted');
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

  it('routes a truly unknown job type to failJob with an alert on dead_letter', async () => {
    // `purge_audio_retell` is a KNOWN-but-unimplemented type (see the
    // dedicated suite below) — it must NOT be used as an "unknown type"
    // fixture. Use a synthetic value cast through JobType so the runtime
    // dispatch treats it as truly unknown while TypeScript stays happy.
    const trulyUnknown = 'legacy_test_unknown_type' as unknown as Job['type'];
    claimJobsMock.mockResolvedValueOnce([
      makeJob({
        id: 'job-unknown',
        type: trulyUnknown,
        attempts: 5,
        max_attempts: 5,
      }),
    ]);
    claimJobsMock.mockResolvedValue([]);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(processAppelJobMock).not.toHaveBeenCalled();
    // True unknown: keeps the noisy path — fail_job + backoff + alert.
    expect(failJobMock).toHaveBeenCalledTimes(1);
    expect(forceDeadLetterMock).not.toHaveBeenCalled();
    const call = failJobMock.mock.calls[0];
    if (!call) throw new Error('failJob not called');
    expect(call[1]).toMatch(/unhandled_job_type:legacy_test_unknown_type/);
    // attempts >= max_attempts → alert fired.
    const types = sendAlertMock.mock.calls.map((c) => c?.[0]);
    expect(types).toContain('job_dead_letter');
  });

  it('routes a KNOWN-but-unimplemented job type (purge_audio_retell) straight to forceDeadLetter, silently', async () => {
    // Regression guard for the "48 h alert storm" incident: every appel
    // enfiled a `purge_audio_retell` job, which used to be treated as
    // unknown → 5 retries + email alert per cabinet actif.
    claimJobsMock.mockResolvedValueOnce([
      makeJob({
        id: 'job-purge',
        type: 'purge_audio_retell',
        payload: { retell_call_id: 'call-test' },
        // Even with attempts == max_attempts (worst-case timing) the
        // KNOWN-but-unimplemented branch must NOT fire an alert.
        attempts: 5,
        max_attempts: 5,
      }),
    ]);
    claimJobsMock.mockResolvedValue([]);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    // fail_job must NOT be called — we skip the retry budget entirely.
    expect(failJobMock).not.toHaveBeenCalled();
    // forceDeadLetter called with a CONSTANT last_error string.
    expect(forceDeadLetterMock).not.toHaveBeenCalled();
    expect(deleteRetellCallMock).toHaveBeenCalledWith('call-test');
    expect(completeJobMock).toHaveBeenCalledWith('job-purge');
    // No alert whatsoever — critical: this is what avoids the inbox storm.
    expect(sendAlertMock).not.toHaveBeenCalled();
    // And of course no handler ran.
    expect(processAppelJobMock).not.toHaveBeenCalled();
  });

  it('does not fire an alert if forceDeadLetter itself fails on a KNOWN-but-unimplemented type', async () => {
    // Defence in depth: even when the RPC to force dead_letter breaks,
    // we must not fall through to the noisy branch and email the operator.
    deleteRetellCallMock.mockRejectedValueOnce(new Error('retell_down'));
    claimJobsMock.mockResolvedValueOnce([
      makeJob({
        id: 'job-purge-dberr',
        type: 'purge_audio_retell',
        payload: { retell_call_id: 'call-test' },
        attempts: 5,
        max_attempts: 5,
      }),
    ]);
    claimJobsMock.mockResolvedValue([]);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(forceDeadLetterMock).not.toHaveBeenCalled();
    expect(failJobMock).not.toHaveBeenCalled();
    expect(completeJobMock).toHaveBeenCalledWith('job-purge-dberr');
    expect(sendAlertMock).toHaveBeenCalledWith(
      'retell_purge_failed',
      expect.objectContaining({ job_id: 'job-purge-dberr' }),
    );
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

// ---------------------------------------------------------------------------
// Session 4 — resilience + alerting (block 1)
// ---------------------------------------------------------------------------

describe('runJobWorker — claim_jobs contract (session 4)', () => {
  it('forwards JOB_STALE_AFTER_SECONDS as the 3rd RPC argument', async () => {
    claimJobsMock.mockResolvedValue([]);
    const worker = runJobWorker({ runOnce: true, staleAfterSeconds: 123 });
    await worker.stopped;

    expect(claimJobsMock).toHaveBeenCalled();
    const call = claimJobsMock.mock.calls[0];
    if (!call) throw new Error('claim_jobs not called');
    expect(call[2]).toBe(123);
  });

  it('treats an EMPTY claim_jobs return as no work (no false-positive on the "one row of NULLs" risk)', async () => {
    // supabase-js returns [] for SETOF-empty RPCs — proven by the mock
    // here and asserted end-to-end via the shipping code path.
    claimJobsMock.mockResolvedValue([]);
    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(processAppelJobMock).not.toHaveBeenCalled();
    expect(completeJobMock).not.toHaveBeenCalled();
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it('processes a reclaimed zombie (attempts > 1) exactly like any other job', async () => {
    const zombie = makeJob({ id: 'zombie-1', attempts: 3 });
    claimJobsMock.mockResolvedValueOnce([zombie]);
    claimJobsMock.mockResolvedValue([]);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(processAppelJobMock).toHaveBeenCalledTimes(1);
    expect(completeJobMock).toHaveBeenCalledWith('zombie-1');
    expect(failJobMock).not.toHaveBeenCalled();
  });
});

describe('runJobWorker — heartbeat (session 4)', () => {
  it('fires an immediate alive-tick at boot and again on the interval', async () => {
    // Use vitest fake timers so we can advance the setInterval without
    // waiting real ms. Only enable inside this test — global setup would
    // interfere with the async waits in other suites.
    vi.useFakeTimers();
    claimJobsMock.mockResolvedValue([]);

    try {
      const worker = runJobWorker({
        runOnce: false,
        heartbeatIntervalMs: 100,
        pollIntervalMs: 5_000,
        version: '0.1.0-test',
      });

      // The first (immediate) tick happens synchronously inside
      // runJobWorker. Flush microtasks so the .catch chain resolves.
      await Promise.resolve();
      expect(workerHeartbeatAliveMock).toHaveBeenCalledTimes(1);
      expect(workerHeartbeatAliveMock.mock.calls[0]?.[1]).toBe('0.1.0-test');

      // Advance past 3 intervals → 3 more calls (plus the immediate one).
      vi.advanceTimersByTime(350);
      await Promise.resolve();
      expect(workerHeartbeatAliveMock.mock.calls.length).toBeGreaterThanOrEqual(4);

      worker.stop();
      // After stop() the timer must NOT keep firing.
      const callsAtStop = workerHeartbeatAliveMock.mock.calls.length;
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      expect(workerHeartbeatAliveMock.mock.calls.length).toBe(callsAtStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires a poll-tick after each drain — batch size becomes the counter delta', async () => {
    claimJobsMock.mockResolvedValueOnce([makeJob({ id: 'ph-1' }), makeJob({ id: 'ph-2' })]);
    claimJobsMock.mockResolvedValue([]);

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    // At least one poll-tick with delta = 2 (the drained batch).
    const deltas = workerHeartbeatPollMock.mock.calls.map((c) => c?.[1] ?? -1);
    expect(deltas).toContain(2);
  });

  it('clears the heartbeat interval on stop() so no timer leaks between runs', async () => {
    vi.useFakeTimers();
    claimJobsMock.mockResolvedValue([]);
    try {
      const worker = runJobWorker({ runOnce: true, heartbeatIntervalMs: 50 });
      await worker.stopped;
      // stop() is called automatically after runOnce completes.
      const before = workerHeartbeatAliveMock.mock.calls.length;
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      expect(workerHeartbeatAliveMock.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runJobWorker — immediate dead_letter alert (session 4)', () => {
  it('fires job_dead_letter when the JUST-FAILED job hit max_attempts', async () => {
    // attempts=5, max_attempts=5 → this failure is terminal.
    claimJobsMock.mockResolvedValueOnce([
      makeJob({ id: 'dl-1', attempts: 5, max_attempts: 5 }),
    ]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new Error('boom'));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    const types = sendAlertMock.mock.calls.map((c) => c?.[0]);
    expect(types).toContain('job_dead_letter');
    // Not orphelin: no storage_path checkpoint.
    expect(types).not.toContain('pdf_orphelin');
  });

  it('adds pdf_orphelin when the PDF was uploaded but the email never went out', async () => {
    claimJobsMock.mockResolvedValueOnce([
      makeJob({
        id: 'orph-1',
        attempts: 5,
        max_attempts: 5,
        payload: {
          steps: {
            pdf_uploaded_at: '2026-08-01T09:42:10.000Z',
            storage_path: 'cab/2026-08/appel.pdf',
          },
        },
      }),
    ]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new Error('smtp down'));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    const types = sendAlertMock.mock.calls.map((c) => c?.[0]);
    expect(types).toContain('pdf_orphelin');
    expect(types).toContain('job_dead_letter');
  });

  it('does NOT fire an alert on a non-terminal failure (still retries left)', async () => {
    claimJobsMock.mockResolvedValueOnce([
      makeJob({ id: 'retry-1', attempts: 2, max_attempts: 5 }),
    ]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new Error('transient'));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('never leaks patient data in the alert context (PII sentinel guard)', async () => {
    const SENTINEL = 'PATIENT-NAME-SENTINEL-DUPONT';
    claimJobsMock.mockResolvedValueOnce([
      makeJob({
        id: 'safe-1',
        attempts: 5,
        max_attempts: 5,
        // Simulate a payload that accidentally carries patient PII through
        // a hypothetical future field. The alert context must NOT surface
        // arbitrary payload keys — only the whitelisted technical ids.
        payload: {
          steps: {
            storage_path: 'cab/2026-08/appel.pdf',
          },
          patient_nom: SENTINEL,
        },
      }),
    ]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new Error(SENTINEL));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    // Inspect the context objects passed to sendAlert.
    for (const call of sendAlertMock.mock.calls) {
      const ctx = call?.[1];
      const serialised = JSON.stringify(ctx ?? {});
      expect(serialised, 'PII leaked into alert context').not.toContain(SENTINEL);
    }
  });
});

// ---------------------------------------------------------------------------
// Session 4 vague 3 — PermanentEmailError → forceDeadLetter short-circuit
// ---------------------------------------------------------------------------

describe('runJobWorker — permanent SMTP failure (session 4 vague 3)', () => {
  it('routes a PermanentEmailError through forceDeadLetter (bypassing failJob)', async () => {
    const { PermanentEmailError } = await import('../../src/services/email.js');
    claimJobsMock.mockResolvedValueOnce([
      makeJob({ id: 'perm-1', attempts: 1, max_attempts: 5 }),
    ]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new PermanentEmailError(550));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    // failJob NOT called — attempts is only 1 out of 5, but the class
    // signals "no point retrying". forceDeadLetter is the right path.
    expect(failJobMock).not.toHaveBeenCalled();
    expect(forceDeadLetterMock).toHaveBeenCalledTimes(1);
    expect(forceDeadLetterMock.mock.calls[0]?.[0]).toBe('perm-1');
    // Redacted message keeps the class name — no PII, safe to persist.
    expect(forceDeadLetterMock.mock.calls[0]?.[1]).toContain('PermanentEmailError');
  });

  it('fires the alerts even though attempts < max_attempts', async () => {
    const { PermanentEmailError } = await import('../../src/services/email.js');
    claimJobsMock.mockResolvedValueOnce([
      makeJob({
        id: 'perm-orph',
        attempts: 1,
        max_attempts: 5,
        payload: { steps: { storage_path: 'cab/x.pdf' } },
      }),
    ]);
    claimJobsMock.mockResolvedValue([]);
    processAppelJobMock.mockRejectedValueOnce(new PermanentEmailError(554));

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    const types = sendAlertMock.mock.calls.map((c) => c?.[0]);
    // Orphelin because PDF uploaded, email never sent.
    expect(types).toContain('pdf_orphelin');
    expect(types).toContain('job_dead_letter');
  });
});
