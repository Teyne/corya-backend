/**
 * Integration tests — services/appel-processor.ts (the pipeline body).
 *
 * DB, PDF and email are all mocked. What we prove here:
 *
 *   1. Happy path — PDF is rendered, uploaded, path persisted, email sent,
 *      appel marked as sent, checkpoints written to jobs.payload.
 *   2. Paused / terminated cabinet — no PDF, no email, job succeeds.
 *   3. Already-sent short-circuit (defence-in-depth on email_status).
 *   4. Retry idempotence — a second run with checkpoints filled does NOT
 *      send a duplicate email.
 *   5. Transient SMTP failure throws EmailPipelineError (retry class).
 *   6. Log capture on a nominal run contains NO patient data.
 */
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageModule from '../../src/services/storage.js';
import type * as LoggerModule from '../../src/config/logger.js';
import type { ProcessAppelPayload } from '../../src/types/index.js';

// -------------------------- Mocks (order matters) --------------------------
// Explicit signatures so `mock.calls[N][M]` is a typed access, not `never`.
// Async-returning fns are `() => Promise.resolve(...)` rather than
// `async () => ...` to satisfy ESLint's `require-await`.
const getAppelForProcessingMock = vi.fn<(id: string) => Promise<unknown>>();
const getCabinetForProcessingMock = vi.fn<(id: string) => Promise<unknown>>();
const setAppelPdfPathMock = vi.fn<(id: string, path: string) => Promise<void>>(
  () => Promise.resolve(undefined),
);
const markAppelEmailSentMock = vi.fn<(id: string) => Promise<void>>(
  () => Promise.resolve(undefined),
);
const updateJobPayloadMock = vi.fn<(id: string, payload: ProcessAppelPayload) => Promise<void>>(
  () => Promise.resolve(undefined),
);

vi.mock('../../src/db/queries.js', () => ({
  getAppelForProcessing: getAppelForProcessingMock,
  getCabinetForProcessing: getCabinetForProcessingMock,
  setAppelPdfPath: setAppelPdfPathMock,
  markAppelEmailSent: markAppelEmailSentMock,
  updateJobPayload: updateJobPayloadMock,
}));

const renderAppelPdfMock = vi.fn<(...args: unknown[]) => Promise<Buffer>>(
  () => Promise.resolve(Buffer.from('%PDF-fake')),
);
vi.mock('../../src/services/pdf.js', () => ({
  renderAppelPdf: renderAppelPdfMock,
}));

const uploadPdfMock = vi.fn<(path: string, bytes: Buffer) => Promise<{ objectPath: string }>>(
  (path: string) => Promise.resolve({ objectPath: path }),
);
const createSignedPdfUrlMock = vi.fn<(path: string, ttl?: number) => Promise<string>>(
  () => Promise.resolve('https://signed/url'),
);
vi.mock('../../src/services/storage.js', async () => {
  // Keep the REAL buildPdfObjectPath (pure function, no supabase calls).
  const actual = await vi.importActual<typeof StorageModule>(
    '../../src/services/storage.js',
  );
  return {
    ...actual,
    uploadPdf: uploadPdfMock,
    createSignedPdfUrl: createSignedPdfUrlMock,
  };
});

interface SendRecapEmailArgs {
  to: string;
  cc: string | null;
  appel: { id: string };
  cabinet: { nom: string };
  pdfUrl: string;
  adminUrl: string;
  pdfBytes: Buffer;
}
const sendRecapEmailMock = vi.fn<(args: SendRecapEmailArgs) => Promise<void>>(
  () => Promise.resolve(undefined),
);
vi.mock('../../src/services/email.js', () => ({
  sendRecapEmail: sendRecapEmailMock,
}));

// Replace the shared logger with one that writes to an inspectable stream.
// `vi.mock` is hoisted to the top of the file, so any variables it
// captures must live inside `vi.hoisted()` to move up together.
const capture = vi.hoisted(() => {
  return {
    chunks: [] as string[],
  };
});

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
  return {
    ...actual,
    logger: testLogger,
  };
});

// SUT import AFTER all mocks are in place.
const { processAppelJob, EmailPipelineError } = await import(
  '../../src/services/appel-processor.js'
);

// -------------------------- Fixtures --------------------------
const APPEL_ID = 'appel-uuid-1';
const CABINET_ID = 'cab-uuid-1';

// Sentinel values — if any of these leak into the logs, the test fails.
const SENTINELS = {
  patientNom: 'PATIENT-SENTINEL-NOM',
  patientPrenom: 'PATIENT-SENTINEL-PRENOM',
  patientTel: '+41000000000-SENTINEL',
  motif: 'MOTIF-SENTINEL-DETAILS',
  transcript: 'TRANSCRIPT-SENTINEL-VERBATIM',
} as const;

const APPEL_ROW = {
  id: APPEL_ID,
  cabinet_id: CABINET_ID,
  retell_call_id: 'call_test_1',
  date_appel: '2026-07-31T09:42:00.000Z',
  duree_secondes: 96,
  resultat: 'rdv_pris' as const,
  motif_appel: SENTINELS.motif,
  patient_nom: SENTINELS.patientNom,
  patient_prenom: SENTINELS.patientPrenom,
  patient_telephone: SENTINELS.patientTel,
  rdv_date: null,
  rdv_praticien: null,
  transcript: SENTINELS.transcript,
  pdf_url: null,
  email_status: 'pending' as const,
};

const CABINET_ROW = {
  id: CABINET_ID,
  nom: 'Cabinet Test',
  email_notification: 'ops@cabinet.example',
  email_notification_cc: null,
  statut: 'actif' as const,
};

function makeJob(overrides?: Partial<{ id: string; attempts: number; payload: Record<string, unknown> }>) {
  return {
    id: overrides?.id ?? 'job-uuid-1',
    type: 'process_appel' as const,
    appel_id: APPEL_ID,
    payload: overrides?.payload ?? { version: 1, steps: {} },
    status: 'processing' as const,
    attempts: overrides?.attempts ?? 1,
    max_attempts: 5,
    run_after: '2026-07-31T09:42:00.000Z',
    locked_at: '2026-07-31T09:42:01.000Z',
    locked_by: 'test-worker',
    last_error: null,
    created_at: '2026-07-31T09:42:00.000Z',
    updated_at: '2026-07-31T09:42:00.000Z',
  };
}

beforeEach(() => {
  getAppelForProcessingMock.mockReset();
  getCabinetForProcessingMock.mockReset();
  setAppelPdfPathMock.mockReset().mockResolvedValue(undefined);
  markAppelEmailSentMock.mockReset().mockResolvedValue(undefined);
  updateJobPayloadMock.mockReset().mockResolvedValue(undefined);
  renderAppelPdfMock.mockReset().mockResolvedValue(Buffer.from('%PDF-fake'));
  uploadPdfMock
    .mockReset()
    .mockImplementation((path: string) => Promise.resolve({ objectPath: path }));
  createSignedPdfUrlMock.mockReset().mockResolvedValue('https://signed/url');
  sendRecapEmailMock.mockReset().mockResolvedValue(undefined);
  capture.chunks.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// -------------------------- Tests --------------------------

describe('processAppelJob — happy path', () => {
  it('renders PDF, uploads, sends email, marks sent, checkpoints payload', async () => {
    getAppelForProcessingMock.mockResolvedValue(APPEL_ROW);
    getCabinetForProcessingMock.mockResolvedValue(CABINET_ROW);

    await processAppelJob(makeJob());

    expect(renderAppelPdfMock).toHaveBeenCalledTimes(1);
    expect(uploadPdfMock).toHaveBeenCalledWith(
      `${CABINET_ID}/2026-07/${APPEL_ID}.pdf`,
      expect.any(Buffer),
    );
    expect(setAppelPdfPathMock).toHaveBeenCalledWith(
      APPEL_ID,
      `${CABINET_ID}/2026-07/${APPEL_ID}.pdf`,
    );
    expect(sendRecapEmailMock).toHaveBeenCalledTimes(1);
    expect(sendRecapEmailMock.mock.calls[0]?.[0]).toMatchObject({
      to: CABINET_ROW.email_notification,
      cc: null,
      pdfUrl: 'https://signed/url',
    });
    expect(markAppelEmailSentMock).toHaveBeenCalledWith(APPEL_ID);
    // Two checkpoints: after upload, after email sent.
    expect(updateJobPayloadMock).toHaveBeenCalledTimes(2);
    const finalPayload = updateJobPayloadMock.mock.calls[1]?.[1];
    expect(finalPayload?.steps?.pdf_uploaded_at).toBeTruthy();
    expect(finalPayload?.steps?.storage_path).toBe(`${CABINET_ID}/2026-07/${APPEL_ID}.pdf`);
    expect(finalPayload?.steps?.email_sent_at).toBeTruthy();
  });
});

describe('processAppelJob — cabinet inactive', () => {
  it.each(['pause', 'resilie'] as const)(
    'short-circuits without PDF or email when statut = %s',
    async (statut) => {
      getAppelForProcessingMock.mockResolvedValue(APPEL_ROW);
      getCabinetForProcessingMock.mockResolvedValue({ ...CABINET_ROW, statut });

      await processAppelJob(makeJob());

      expect(renderAppelPdfMock).not.toHaveBeenCalled();
      expect(uploadPdfMock).not.toHaveBeenCalled();
      expect(sendRecapEmailMock).not.toHaveBeenCalled();
      expect(markAppelEmailSentMock).not.toHaveBeenCalled();
    },
  );
});

describe('processAppelJob — defence-in-depth', () => {
  it('does NOT resend when appels.email_status is already "sent"', async () => {
    getAppelForProcessingMock.mockResolvedValue({ ...APPEL_ROW, email_status: 'sent' });
    getCabinetForProcessingMock.mockResolvedValue(CABINET_ROW);

    await processAppelJob(makeJob());

    expect(renderAppelPdfMock).not.toHaveBeenCalled();
    expect(sendRecapEmailMock).not.toHaveBeenCalled();
    expect(markAppelEmailSentMock).not.toHaveBeenCalled();
  });
});

describe('processAppelJob — idempotence on retry', () => {
  it('skips the upload step when payload.steps.pdf_uploaded_at is set, then sends email', async () => {
    getAppelForProcessingMock.mockResolvedValue({
      ...APPEL_ROW,
      pdf_url: `${CABINET_ID}/2026-07/${APPEL_ID}.pdf`,
    });
    getCabinetForProcessingMock.mockResolvedValue(CABINET_ROW);

    const preCheckpointed = makeJob({
      payload: {
        version: 1,
        to: CABINET_ROW.email_notification,
        cc: null,
        steps: {
          pdf_uploaded_at: '2026-07-31T09:42:10.000Z',
          storage_path: `${CABINET_ID}/2026-07/${APPEL_ID}.pdf`,
        },
      },
    });

    await processAppelJob(preCheckpointed);

    // Upload skipped.
    expect(uploadPdfMock).not.toHaveBeenCalled();
    expect(setAppelPdfPathMock).not.toHaveBeenCalled();
    // Email still sent.
    expect(sendRecapEmailMock).toHaveBeenCalledTimes(1);
    expect(markAppelEmailSentMock).toHaveBeenCalledTimes(1);
  });

  it('a fully-checkpointed payload short-circuits via email_status = sent', async () => {
    // Simulate the DB row already reflecting "sent" (the pipeline crashed
    // right after the SMTP accepted but before markAppelEmailSent).
    // The very first defence catches it: email_status.
    getAppelForProcessingMock.mockResolvedValue({ ...APPEL_ROW, email_status: 'sent' });
    getCabinetForProcessingMock.mockResolvedValue(CABINET_ROW);

    await processAppelJob(
      makeJob({
        payload: {
          version: 1,
          steps: {
            pdf_uploaded_at: '2026-07-31T09:42:10.000Z',
            storage_path: `${CABINET_ID}/2026-07/${APPEL_ID}.pdf`,
            email_sent_at: '2026-07-31T09:42:15.000Z',
          },
        },
      }),
    );
    expect(sendRecapEmailMock).not.toHaveBeenCalled();
  });
});

describe('processAppelJob — transient SMTP failure', () => {
  it('throws EmailPipelineError so the worker retries with backoff', async () => {
    getAppelForProcessingMock.mockResolvedValue(APPEL_ROW);
    getCabinetForProcessingMock.mockResolvedValue(CABINET_ROW);
    sendRecapEmailMock.mockRejectedValueOnce(new Error('smtp 421 temporary'));

    await expect(processAppelJob(makeJob())).rejects.toBeInstanceOf(EmailPipelineError);

    // Email not marked as sent since it failed.
    expect(markAppelEmailSentMock).not.toHaveBeenCalled();
    // The PDF upload happened BEFORE the email attempt, so its checkpoint
    // is persisted — on the retry, the pipeline will skip PDF and only
    // retry the email.
    expect(uploadPdfMock).toHaveBeenCalledTimes(1);
    const lastCheckpoint =
      updateJobPayloadMock.mock.calls[updateJobPayloadMock.mock.calls.length - 1]?.[1];
    expect(lastCheckpoint?.steps?.pdf_uploaded_at).toBeTruthy();
    expect(lastCheckpoint?.steps?.email_sent_at).toBeUndefined();
  });
});

describe('processAppelJob — no patient data in logs', () => {
  it('captures the nominal-run log stream and asserts no sentinel leaked', async () => {
    getAppelForProcessingMock.mockResolvedValue(APPEL_ROW);
    getCabinetForProcessingMock.mockResolvedValue(CABINET_ROW);

    await processAppelJob(makeJob());

    const raw = capture.chunks.join('');
    // Positive assertions to ensure the logger was actually invoked.
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toContain('pdf_uploaded');
    expect(raw).toContain('process_appel_pipeline_success');
    // Negative: no PII leaked.
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(raw, `patient sentinel "${name}" leaked in log output`).not.toContain(value);
    }
  });
});
