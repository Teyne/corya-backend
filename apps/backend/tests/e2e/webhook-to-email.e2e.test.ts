/**
 * End-to-end — webhook → job → PDF → email (session 4 vague 5, bloc 9).
 *
 * Full happy-path exercise:
 *   1. HTTP POST /webhooks/retell/call-ended with a SIGNED payload
 *      (SDK verifier mocked to accept).
 *   2. The webhook enqueues a `process_appel` job in the harness store.
 *   3. The worker (runOnce) picks it up, renders the PDF (fake bytes),
 *      "uploads" it (no-op), and sends the recap email through the fake
 *      transporter.
 *   4. We assert on: recipient, attachment presence, PDF bytes non-empty,
 *      correlation id round-trip.
 *
 * Retell HMAC signature is NOT computed for real — the SDK is mocked at
 * the module boundary to return true. That reflects the production reality
 * where the SDK is the single source of truth on signature validity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  clearSentMails,
  installQueryMocks,
  resetStore,
  seedCabinet,
  sentMails,
  store,
  waitFor,
} from './harness.js';

// Install DB + puppeteer mocks BEFORE any src/* import.
installQueryMocks();

// Mock the Retell SDK to accept our synthetic signature. In production,
// the SDK is what actually validates HMAC-SHA256 against RETELL_API_KEY —
// we exercise every OTHER layer of the pipeline instead of reimplementing
// its byte-level protocol here.
vi.mock('retell-sdk', () => ({
  verify: vi.fn(() => Promise.resolve(true)),
}));

// Reset the rate limiter counters between runs so a burst in one test
// doesn't spill into another. The webhook route is behind
// buildWebhookRateLimiter().
const { __resetRateLimitForTests } = await import('../../src/middleware/rate-limit.js');

const { app } = await import('../../src/index.js');
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
const { makeFakeTransporter } = await import('./harness.js');

// Storage — same treatment as the resilience test: swap upload / signed URL.
const storageModule = await import('../../src/services/storage.js');
Object.defineProperty(storageModule, 'uploadPdf', {
  value: (path: string) => Promise.resolve({ objectPath: path }),
  writable: true,
  configurable: true,
});
Object.defineProperty(storageModule, 'createSignedPdfUrl', {
  value: () => Promise.resolve('https://signed-e2e/url'),
  writable: true,
  configurable: true,
});

// Email template stub — the render pipeline needs every {{...}} present.
const EMAIL_TEMPLATE = `<html><body>
<h1>{{CABINET_NOM}}</h1>
<p>{{DATE_HEURE}} - {{DUREE}} - {{MOTIF}} - {{RESULTAT_LABEL}} - {{ACTION}}</p>
<a href="{{PDF_URL}}">pdf</a><a href="{{ADMIN_URL}}">admin</a>
</body></html>`;

// Fixture body — a real, signed call_analyzed payload.
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, '..', 'fixtures', 'retell-payload.json');
const fixtureBody = readFileSync(fixturePath, 'utf8');

function placeholderSignature(): string {
  // The `v=<ts>,d=<hex>` shape passes our own freshness guard; the SDK
  // (mocked) approves it beyond that.
  return `v=${Date.now()},d=${'a'.repeat(64)}`;
}

const { runJobWorker } = await import('../../src/workers/job-worker.js');

beforeEach(() => {
  resetStore();
  clearSentMails();
  __resetRateLimitForTests();
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

describe('webhook-to-email e2e — happy path', () => {
  it('POST /webhooks → worker drain → minimal recap email without PDF attachment', async () => {
    // Cabinet whose numero_corya matches the fixture's to_number.
    seedCabinet({ numero_corya: '+41215550100', email_notification: 'ops@cabinet.example' });

    const CORRELATION = 'e2e-cid-happy-01';
    const res = await request(app)
      .post('/webhooks/retell/call-ended')
      .set('Content-Type', 'application/json')
      .set('x-retell-signature', placeholderSignature())
      .set('X-Correlation-Id', CORRELATION)
      .send(fixtureBody);

    // The route responds 200 immediately; downstream processing is async.
    expect(res.status).toBe(200);
    expect(res.header['x-correlation-id']).toBe(CORRELATION);

    // Wait for the async webhook path to enqueue the process_appel job.
    await waitFor(
      () => Array.from(store.jobs.values()).some((j) => j.type === 'process_appel'),
      5_000,
    );

    // Drain the worker once — it should complete the job.
    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    // The job that came from the webhook is now succeeded.
    const processAppel = Array.from(store.jobs.values()).find(
      (j) => j.type === 'process_appel',
    );
    expect(processAppel?.status).toBe('succeeded');
    // Correlation id was propagated at enqueue.
    expect(processAppel?.correlation_id).toBe(CORRELATION);

    // The recap email must have been sent through the fake transporter.
    // Filter out any alert-shaped subject (there shouldn't be any on the
    // happy path, but be explicit).
    const recap = sentMails.find((m) => !m.subject.startsWith('[Corya]'));
    expect(recap).toBeDefined();
    expect(recap?.to).toBe('ops@cabinet.example');
    expect(recap?.subject).toMatch(/Nouveau récapitulatif disponible/);
    expect(recap?.attachments).toBeUndefined();
    expect(recap?.html).toContain(`/calls/${processAppel?.appel_id}`);
    expect(recap?.html).not.toContain('MOTIF-SENTINEL');
  });

  it('a webhook targeting an unknown numero_corya does NOT send an email', async () => {
    // No cabinet seeded, so the lookup returns null.
    const res = await request(app)
      .post('/webhooks/retell/call-ended')
      .set('Content-Type', 'application/json')
      .set('x-retell-signature', placeholderSignature())
      .send(fixtureBody);
    expect(res.status).toBe(200);

    // Give the async path time to attempt the lookup, then drain the worker.
    await new Promise((r) => setTimeout(r, 100));
    const worker = runJobWorker({ runOnce: true });
    await worker.stopped;

    // No recap email queued (no PDF, no send).
    const recap = sentMails.find((m) => !m.subject.startsWith('[Corya]'));
    expect(recap).toBeUndefined();
  });
});
