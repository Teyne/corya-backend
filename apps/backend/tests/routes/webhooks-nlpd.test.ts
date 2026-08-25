/**
 * nLPD regression test — POST /webhooks/retell/call-ended
 *
 * Session 3.1 audit finding: `err.message` used to be logged verbatim in
 * the webhook's fire-and-forget catch handler. Postgres surfaces the
 * offending column VALUE inside its error message
 * (e.g. `DETAIL: Key (patient_telephone)=(+41...)` on unique/type
 * violations), and the recursive log sanitizer only redacts by KEY name —
 * so a PII fragment would pass straight through.
 *
 * This test injects an error whose `.message` carries a sentinel shaped
 * like real Postgres output and asserts the sentinel does NOT appear
 * anywhere in the captured log stream.
 *
 * Kept in a dedicated file (rather than added to `webhooks.test.ts`) so
 * the module-scoped logger mock does not interfere with the existing suite.
 */
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type * as LoggerModule from '../../src/config/logger.js';

// -- Hoisted state so the vi.mock factory can write to it. -----------------
const capture = vi.hoisted(() => ({
  chunks: [] as string[],
}));

// -- Retell SDK stub: accept every signature so we can exercise the async
//    path. --------------------------------------------------------------
vi.mock('retell-sdk', () => ({
  verify: vi.fn(() => Promise.resolve(true)),
}));

// -- DB mock: `insertAppelIdempotent` throws with a message that contains
//    a Postgres-style PII fragment. This mirrors what supabase-js hands us
//    on a unique violation whose DETAIL includes the column value. ---------
const PII_SENTINEL = 'DETAIL: Key (patient_telephone)=(+41791234567-SENTINEL)';

vi.mock('../../src/db/queries.js', () => ({
  findCabinetByCoryaNumber: vi.fn(() =>
    Promise.resolve({
      id: '11111111-1111-1111-1111-111111111111',
      numero_corya: '+41215550100',
      email_notification: 'ops@corya.example',
      email_notification_cc: null,
    }),
  ),
  persistCallAnalyzed: vi.fn(() =>
    Promise.reject(
      new Error(`db_insert_appel_failed: ${PII_SENTINEL}`),
    ),
  ),
  enqueueJobIdempotent: vi.fn(() => Promise.resolve(true)),
  beginCalcomOAuthFlow: vi.fn(() => Promise.reject(new Error('not_configured'))),
  consumeCalcomOAuthFlow: vi.fn(() => Promise.resolve(null)),
  completeCalcomOAuthFlow: vi.fn(() => Promise.resolve(false)),
  failCalcomOAuthFlow: vi.fn(() => Promise.resolve(false)),
  getCalcomConnectionCredentials: vi.fn(() => Promise.resolve(null)),
  claimCalcomOAuthRefresh: vi.fn(() => Promise.resolve(null)),
  completeCalcomOAuthRefresh: vi.fn(() => Promise.resolve(false)),
  failCalcomOAuthRefresh: vi.fn(() => Promise.resolve(false)),
  getCalcomConnectionStatus: vi.fn(() => Promise.resolve(null)),
  setCalcomEventType: vi.fn(() => Promise.resolve(false)),
  disconnectCalcomOAuthConnection: vi.fn(() => Promise.resolve(false)),
  claimCalendarBookingCommand: vi.fn(() => Promise.resolve(null)),
  completeCalendarBookingCommand: vi.fn(() => Promise.resolve(false)),
  markCalendarBookingCommandUncertain: vi.fn(() => Promise.resolve(false)),
}));

// -- Logger mock: intercept the shared `logger` so we can inspect the JSON
//    lines the route emits. --------------------------------------------------
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

// SUT import AFTER all mocks.
const { app } = await import('../../src/index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureAnalyzed = readFileSync(
  resolve(__dirname, '..', 'fixtures', 'retell-payload.json'),
  'utf8',
);

function placeholderSignature(): string {
  return `v=${Date.now()},d=${'a'.repeat(64)}`;
}

beforeEach(() => {
  capture.chunks.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /webhooks/retell/call-ended — nLPD log leakage regression', () => {
  it('does not leak a Postgres-style PII fragment carried by err.message', async () => {
    const res = await request(app)
      .post('/webhooks/retell/call-ended')
      .set('Content-Type', 'application/json')
      .set('x-retell-signature', placeholderSignature())
      .send(fixtureAnalyzed);
    expect(res.status).toBe(500);

    // Wait for the fire-and-forget async path to actually log its failure.
    await vi.waitFor(
      () => {
        const raw = capture.chunks.join('');
        if (!raw.includes('webhook_persistence_failed')) {
          throw new Error('waiting');
        }
      },
      { timeout: 2000, interval: 10 },
    );

    const raw = capture.chunks.join('');
    // Positive: the intended log event fired.
    expect(raw).toContain('webhook_persistence_failed');
    // Positive: the error CLASS NAME survived so debugging remains possible.
    expect(raw).toContain('"err_name":"Error"');
    // Negative: the PII fragment carried by err.message was suppressed.
    expect(raw, 'PII fragment leaked through err.message into logs').not.toContain(
      PII_SENTINEL,
    );
    // And more specifically, the phone number component.
    expect(raw).not.toContain('+41791234567-SENTINEL');
  });
});
