/**
 * End-to-end — worker resilience (session 4 vague 5, bloc 9).
 *
 * We exercise the FULL worker pipeline against the in-memory harness:
 *   - a job left in `processing` past the stale threshold is reclaimed
 *     and processed;
 *   - a job that fails `max_attempts` times ends up in `dead_letter`
 *     AND fires a `job_dead_letter` alert (immediate, from the worker
 *     side per session 4 vague 2);
 *   - a `dead_letter` job whose `payload.steps.storage_path` is set
 *     but `email_sent_at` is not, fires a `pdf_orphelin` alert.
 *
 * All I/O is mocked at the queries / SMTP / Puppeteer boundaries — no
 * real database, no real SMTP, no browser binary needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSentMails,
  installQueryMocks,
  insertAppelDirect,
  insertJobDirect,
  makeFakeTransporter,
  resetStore,
  seedCabinet,
  sentMails,
  store,
  waitFor,
} from './harness.js';

// Install DB + puppeteer mocks BEFORE any src/* import.
installQueryMocks();

// Import after mocks are in place.
const { runJobWorker } = await import('../../src/workers/job-worker.js');
const { __setTransporterForTests, __setTemplateForTests } = await import(
  '../../src/services/email.js'
);
const {
  __setAlertTransporterForTests,
  __resetAlertDedupForTests,
} = await import('../../src/services/alert.js');
const { __setReceiptTransporterForTests } = await import(
  '../../src/services/alert-pollers.js'
);

// Minimal email template so the render pipeline finds every substitution.
const EMAIL_TEMPLATE = `
<html><body>
<h1>{{CABINET_NOM}}</h1>
<a href="{{ADMIN_URL}}">admin</a>
</body></html>`;

// Storage helpers are mocked at the top of each block that needs them.
// The worker's appel-processor uploads the PDF on the happy path; we
// short-circuit Storage to keep the harness hermetic.
const { default: puppeteerMock } = await import('puppeteer');
void puppeteerMock; // silence unused import warning

// ---------------------------------------------------------------------------
// Storage service — swap upload/signed URL to no-ops
// ---------------------------------------------------------------------------
// The queries mock covers `db/queries.js`; storage.js talks directly to
// supabase-js. We swap the two functions the worker calls.
const storageModule = await import('../../src/services/storage.js');
type StorageWithSetters = typeof storageModule & {
  __setUploadPdfForTests?: (fn: (path: string, bytes: Buffer | Uint8Array) => Promise<{ objectPath: string }>) => void;
};
// If the storage module does not expose test setters, monkey-patch the
// exported functions directly. Vitest allows re-assigning exports on the
// namespace object at test time (module records live in a mutable Map).
Object.defineProperty(storageModule, 'uploadPdf', {
  value: (path: string) => Promise.resolve({ objectPath: path }),
  writable: true,
  configurable: true,
});
void (storageModule as StorageWithSetters);

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStore();
  clearSentMails();
  __resetAlertDedupForTests();
  __setTemplateForTests(EMAIL_TEMPLATE);
  const fake = makeFakeTransporter();
  __setTransporterForTests(fake);
  __setAlertTransporterForTests(fake);
  __setReceiptTransporterForTests(fake);
});

afterEach(() => {
  __setTransporterForTests(null);
  __setAlertTransporterForTests(null);
  __setReceiptTransporterForTests(null);
  __setTemplateForTests(null);
});

// ---------------------------------------------------------------------------
// Test 1 — zombie reclaim
// ---------------------------------------------------------------------------

describe('worker-resilience e2e — zombie reclaim', () => {
  it('reclaims a job left in processing past the stale threshold and processes it to completion', async () => {
    seedCabinet();
    const appel = insertAppelDirect();
    // Directly seed a job in 'processing' with an OLD locked_at, mimicking
    // a worker that crashed mid-run.
    const stalePastMs = Date.now() - 10 * 60 * 1_000; // 10 min ago
    insertJobDirect({
      id: 'zombie-1',
      appel_id: appel.id,
      status: 'processing',
      attempts: 1,
      max_attempts: 5,
      locked_at: new Date(stalePastMs).toISOString(),
      locked_by: 'dead-worker',
      payload: { steps: {}, to: 'ops@cabinet.example' },
    });

    // Short stale threshold (2 s) so this job is IMMEDIATELY eligible for
    // reclaim on the very next claim_jobs() call.
    const worker = runJobWorker({ runOnce: true, staleAfterSeconds: 2 });
    await worker.stopped;

    const j = store.jobs.get('zombie-1');
    expect(j?.status).toBe('succeeded');
    // Email actually went out — end-to-end proof the reclaim path is
    // functionally identical to a fresh claim.
    expect(sentMails.length).toBe(1);
    expect(sentMails[0]?.to).toBe('ops@cabinet.example');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — max_attempts → dead_letter + alert
// ---------------------------------------------------------------------------

describe('worker-resilience e2e — dead_letter after max_attempts', () => {
  it('a persistently failing job ends up in dead_letter AND fires a job_dead_letter alert', async () => {
    seedCabinet();
    const appel = insertAppelDirect();
    // Force the pipeline to fail by removing the cabinet the appel points
    // to — no wait, the processor short-circuits on missing cabinet with
    // a SUCCESS return. So instead we force uploadPdf to reject.
    Object.defineProperty(storageModule, 'uploadPdf', {
      value: () => Promise.reject(new Error('storage down')),
      writable: true,
      configurable: true,
    });

    insertJobDirect({
      id: 'doomed-1',
      appel_id: appel.id,
      status: 'pending',
      attempts: 4, // one more attempt = dead_letter
      max_attempts: 5,
      payload: { steps: {}, to: 'ops@cabinet.example' },
    });

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    // The RPC contract: attempts is incremented at claim time, so after
    // one run this job's attempts is 5. failJob then flips to dead_letter.
    const j = store.jobs.get('doomed-1');
    expect(j?.status).toBe('dead_letter');
    expect(j?.attempts).toBe(5);

    // Immediate alert fired from the worker side. In the harness, the
    // fake transporter records into `sentMails`. Every alert email is a
    // plain-text send with subject `[Corya] <alert_type>` — see
    // src/services/alert.ts.
    await waitFor(
      () => sentMails.some((m) => m.subject === '[Corya] job_dead_letter'),
      3_000,
    );
    expect(
      sentMails.some((m) => m.subject === '[Corya] job_dead_letter'),
    ).toBe(true);

    // Restore for other tests.
    Object.defineProperty(storageModule, 'uploadPdf', {
      value: (path: string) => Promise.resolve({ objectPath: path }),
      writable: true,
      configurable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Test 3 — pdf_orphelin (PDF uploaded, email never sent)
// ---------------------------------------------------------------------------

describe('worker-resilience e2e — pdf_orphelin detection', () => {
  it('fires pdf_orphelin when a job hits dead_letter with storage_path but no email_sent_at', async () => {
    seedCabinet();
    const appel = insertAppelDirect();
    // Force the email leg to reject persistently. PDF path is already
    // stamped in the checkpoint — that's the orphelin condition.
    // We temporarily swap sendMail to reject only on the RECAP email,
    // not on alerts. Easiest way: swap the recap-email transporter for
    // one that throws on any send, and give a separate transporter to
    // the alert path.
    const throwingTransporter = {
      sendMail: () => Promise.reject(new Error('smtp down')),
      close: (): void => {},
    } as unknown as ReturnType<typeof makeFakeTransporter>;
    __setTransporterForTests(throwingTransporter);
    // Alert transporter stays functional so the alert really lands.
    const alertTransporter = makeFakeTransporter();
    __setAlertTransporterForTests(alertTransporter);
    __setReceiptTransporterForTests(alertTransporter);

    insertJobDirect({
      id: 'orphelin-1',
      appel_id: appel.id,
      status: 'pending',
      attempts: 4, // one more = dead_letter
      max_attempts: 5,
      payload: {
        steps: {
          pdf_uploaded_at: new Date(Date.now() - 60_000).toISOString(),
          storage_path: 'cab-e2e/2026-08/appel-e2e.pdf',
        },
        to: 'ops@cabinet.example',
      },
    });

    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    const j = store.jobs.get('orphelin-1');
    expect(j?.status).toBe('dead_letter');

    await waitFor(
      () => sentMails.some((m) => m.subject === '[Corya] pdf_orphelin'),
      3_000,
    );
    const orphelinMail = sentMails.find(
      (m) => m.subject === '[Corya] pdf_orphelin',
    );
    expect(orphelinMail).toBeDefined();
    // The alert body must not carry patient data.
    const body = String(orphelinMail?.text ?? '');
    expect(body).not.toContain('Test');
    expect(body).not.toContain('Patient');
    expect(body).not.toContain('+41780000000');
  });
});
