/**
 * Tests d'intégration — POST /webhooks/retell/call-ended
 *
 * Session 2.2 : la vérification HMAC est déléguée au SDK officiel
 * `retell-sdk`. Ici on MOCKE le SDK au niveau du module, ce qui nous permet
 * de :
 *   - décider test par test si la signature est acceptée ou rejetée
 *   - vérifier que **un rejet du SDK produit un 401**, jamais un 200
 *     (le test-clé pour garantir qu'on n'a pas transformé une porte
 *     fermée en porte ouverte lors de la migration)
 *   - conserver les tests de discrimination d'événements et la politique
 *     de codes HTTP (200 pour tout ce qui est authentifié)
 *
 * On garde le mock DB in-memory pour prouver que les événements
 * notification-only et les événements inconnus ne touchent PAS la DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

// --- Mocks positionnés AVANT tout import du graphe de l'app ----------------

// 1. Mock du SDK Retell. Par défaut, chaque test devra explicitement dire
//    ce que le SDK renvoie via `mockSdkVerify.mockResolvedValueOnce(...)`.
//    Si un test oublie de le faire, l'appel renverra `undefined` (falsy)
//    et sera traité comme un rejet — ce qui protège contre les faux positifs.
vi.mock('retell-sdk', () => ({
  verify: vi.fn(),
}));

// 2. Mock DB (in-memory) — inchangé par rapport à la version précédente.
const cabinetRow = {
  id: '11111111-1111-1111-1111-111111111111',
  numero_corya: '+41215550100',
  email_notification: 'ops@corya.example',
  email_notification_cc: null,
};

const insertedAppels = new Map<string, string>(); // retell_call_id -> appelId
const enqueuedJobs: Array<{ type: string; appelId: string }> = [];

vi.mock('../../src/db/queries.js', () => {
  return {
    findCabinetByCoryaNumber: vi.fn((toNumber: string) => {
      if (toNumber === cabinetRow.numero_corya) return Promise.resolve(cabinetRow);
      return Promise.resolve(null);
    }),
    insertAppelIdempotent: vi.fn((row: { retell_call_id: string }) => {
      const existing = insertedAppels.get(row.retell_call_id);
      if (existing) {
        return Promise.resolve({ appelId: existing, duplicate: true });
      }
      const id = `appel-${insertedAppels.size + 1}`;
      insertedAppels.set(row.retell_call_id, id);
      return Promise.resolve({ appelId: id, duplicate: false });
    }),
    enqueueJobIdempotent: vi.fn((row: { type: string; appel_id: string }) => {
      const key = `${row.type}:${row.appel_id}`;
      const already = enqueuedJobs.some(
        (j) => `${j.type}:${j.appelId}` === key,
      );
      enqueuedJobs.push({ type: row.type, appelId: row.appel_id });
      return Promise.resolve(!already);
    }),
    persistCallAnalyzed: vi.fn((input: {
      appel: { retell_call_id: string };
      correlationId: string | null;
    }) => {
      const existing = insertedAppels.get(input.appel.retell_call_id);
      const appelId = existing ?? `appel-${insertedAppels.size + 1}`;
      insertedAppels.set(input.appel.retell_call_id, appelId);
      for (const type of ['process_appel', 'purge_audio_retell']) {
        if (!enqueuedJobs.some((job) => job.type === type && job.appelId === appelId)) {
          enqueuedJobs.push({ type, appelId });
        }
      }
      return Promise.resolve({ appelId, duplicate: Boolean(existing) });
    }),
    reconcileCalendarBookingForAppel: vi.fn(() => Promise.resolve(null)),
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
  };
});

// Import APRÈS les mocks.
const { app } = await import('../../src/index.js');
const queries = await import('../../src/db/queries.js');
const { verify: sdkVerify } = await import('retell-sdk');
const mockSdkVerify = vi.mocked(sdkVerify);
const { __resetRateLimitForTests } = await import('../../src/middleware/rate-limit.js');
const { env } = await import('../../src/config/env.js');
const { hashPhoneNumber } = await import('../../src/utils/redact.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '..', 'fixtures');
const fixtureAnalyzed = readFileSync(
  resolve(fixturesDir, 'retell-payload.json'),
  'utf8',
);
const fixtureStarted = readFileSync(
  resolve(fixturesDir, 'retell-call-started.json'),
  'utf8',
);
const fixtureEnded = readFileSync(
  resolve(fixturesDir, 'retell-call-ended.json'),
  'utf8',
);

/**
 * Placeholder signature — la vérification étant mockée, le contenu de
 * l'en-tête est indifférent tant que le mock répond `true`. On garde un
 * format ressemblant au vrai pour ne pas déclencher le contrôle de
 * fraîcheur maison (qui rejetterait avant même d'appeler le SDK si le
 * timestamp était hors fenêtre).
 */
function placeholderSignature(): string {
  return `v=${Date.now()},d=${'a'.repeat(64)}`;
}

async function postWebhook(bodyRaw: string, signature?: string) {
  const req = request(app)
    .post('/webhooks/retell/call-ended')
    .set('Content-Type', 'application/json');
  if (signature !== undefined) {
    req.set('x-retell-signature', signature);
  }
  return req.send(bodyRaw);
}

async function waitForAsyncProcessing(): Promise<void> {
  await vi.waitFor(
    () => {
      const called = (queries.persistCallAnalyzed as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls.length;
      if (called === 0) throw new Error('not yet');
    },
    { timeout: 2000, interval: 10 },
  );
}

function analyzedPayloadWithPhones(
  customPhone: unknown,
  callerPhone: string,
  rappelAutorise?: unknown,
): string {
  const payload = JSON.parse(fixtureAnalyzed) as {
    call: {
      from_number: string;
      call_analysis: {
        custom_analysis_data: Record<string, unknown>;
      };
    };
  };
  payload.call.from_number = callerPhone;
  payload.call.call_analysis.custom_analysis_data.patient_telephone = customPhone;
  if (rappelAutorise !== undefined) {
    payload.call.call_analysis.custom_analysis_data.rappel_autorise =
      rappelAutorise;
  }
  return JSON.stringify(payload);
}

beforeEach(() => {
  __resetRateLimitForTests();
  insertedAppels.clear();
  enqueuedJobs.length = 0;
  vi.mocked(queries.findCabinetByCoryaNumber).mockClear();
  vi.mocked(queries.insertAppelIdempotent).mockClear();
  vi.mocked(queries.enqueueJobIdempotent).mockClear();
  vi.mocked(queries.persistCallAnalyzed).mockClear();
  vi.mocked(queries.reconcileCalendarBookingForAppel).mockClear();
  mockSdkVerify.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Signature layer
// ---------------------------------------------------------------------------
describe('POST /webhooks/retell/call-ended — signature layer', () => {
  it('does not let unsigned traffic consume the authenticated Retell quota', async () => {
    mockSdkVerify.mockResolvedValue(false);

    for (let i = 0; i <= env.RATE_LIMIT_WEBHOOK_MAX; i += 1) {
      const unsigned = await postWebhook(fixtureStarted);
      expect(unsigned.status).toBe(401);
    }

    mockSdkVerify.mockResolvedValueOnce(true);
    const signed = await postWebhook(fixtureStarted, placeholderSignature());
    expect(signed.status).toBe(200);
    expect(signed.body).toEqual({ received: true, event: 'call_started' });
  });

  it('rejects a request without signature header (401)', async () => {
    // No signature → verifyRetellSignature delegates to SDK with empty
    // signature; SDK returns false; route returns 401.
    mockSdkVerify.mockResolvedValue(false);
    const res = await postWebhook(fixtureAnalyzed);
    expect(res.status).toBe(401);
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
  });

  it('returns 401 (NOT 200) when the SDK rejects the signature', async () => {
    // MIGRATION-CRITICAL: this is the test that guarantees we did not
    // turn a closed door into an open one during the SDK migration.
    // A rejection by the SDK MUST propagate to a 401 — never 200.
    mockSdkVerify.mockResolvedValue(false);
    const res = await postWebhook(fixtureAnalyzed, placeholderSignature());
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_signature' });
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.enqueueJobIdempotent)).not.toHaveBeenCalled();
  });

  it('returns 401 (short-circuits SDK) when the timestamp is out of window with a known-format header', async () => {
    // The freshness guard fires BEFORE the SDK, so mockSdkVerify must NOT
    // be called. This is defence in depth: even if the SDK accepted a
    // stale signature, we would reject it ourselves.
    mockSdkVerify.mockResolvedValue(true);
    const stale = `v=${Date.now() - 10 * 60 * 1000},d=${'a'.repeat(64)}`;
    const res = await postWebhook(fixtureAnalyzed, stale);
    expect(res.status).toBe(401);
    expect(mockSdkVerify).not.toHaveBeenCalled();
  });

  it('returns 401 for a future-dated timestamp with a known-format header', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const future = `v=${Date.now() + 10 * 60 * 1000},d=${'a'.repeat(64)}`;
    const res = await postWebhook(fixtureAnalyzed, future);
    expect(res.status).toBe(401);
    expect(mockSdkVerify).not.toHaveBeenCalled();
  });

  it('delegates to the SDK when the header does NOT match our known format', async () => {
    // If Retell changes their format one day, we must not preemptively
    // reject. This test proves the freshness guard is conditional.
    mockSdkVerify.mockResolvedValue(false); // SDK still rejects (unknown to it too)
    const res = await postWebhook(fixtureAnalyzed, 't=123,s=deadbeef');
    expect(res.status).toBe(401);
    expect(mockSdkVerify).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Notification-only events
// ---------------------------------------------------------------------------
describe('POST /webhooks/retell/call-ended — notification-only events', () => {
  it('accepts a signed call_started and does NOT touch the DB', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const res = await postWebhook(fixtureStarted, placeholderSignature());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, event: 'call_started' });
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(queries.findCabinetByCoryaNumber)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.enqueueJobIdempotent)).not.toHaveBeenCalled();
  });

  it('accepts a signed call_ended and does NOT touch the DB', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const res = await postWebhook(fixtureEnded, placeholderSignature());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, event: 'call_ended' });
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(queries.findCabinetByCoryaNumber)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.enqueueJobIdempotent)).not.toHaveBeenCalled();
  });

  it('rejects an unsigned call_started (401), same signature policy as call_analyzed', async () => {
    mockSdkVerify.mockResolvedValue(false);
    const res = await postWebhook(fixtureStarted);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Authenticated but unusable
// ---------------------------------------------------------------------------
describe('POST /webhooks/retell/call-ended — authenticated but unusable', () => {
  it('acks 200 for a signed but UNKNOWN event type (e.g. agent_created), zero DB, one warn', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const body = JSON.stringify({
      event: 'agent_created',
      call: { call_id: 'call_unknown_evt_1' },
      some_extra: true,
    });
    const res = await postWebhook(body, placeholderSignature());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, event: 'agent_created' });

    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(queries.findCabinetByCoryaNumber)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.enqueueJobIdempotent)).not.toHaveBeenCalled();
  });

  it('acks 200 for a signed call_analyzed with MALFORMED payload, zero DB', async () => {
    mockSdkVerify.mockResolvedValue(true);
    // event is known ("call_analyzed"), but the strict schema fails on the
    // empty call_id. Retries would not help — must not force Retell to loop.
    const badBody = JSON.stringify({
      event: 'call_analyzed',
      call: { call_id: '' },
    });
    const res = await postWebhook(badBody, placeholderSignature());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, event: 'call_analyzed' });

    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(queries.findCabinetByCoryaNumber)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.enqueueJobIdempotent)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// call_analyzed happy path
// ---------------------------------------------------------------------------
describe('POST /webhooks/retell/call-ended — call_analyzed', () => {
  it('normalizes and prefers a valid custom callback number', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const res = await postWebhook(
      analyzedPayloadWithPhones('078 400 16 80', '+41 79 123 45 67', true),
      placeholderSignature(),
    );
    expect(res.status).toBe(200);
    await waitForAsyncProcessing();

    const persisted = vi.mocked(queries.persistCallAnalyzed).mock.calls[0]?.[0];
    expect(persisted?.appel).toMatchObject({
      patient_telephone: '+41784001680',
      numero_appelant_hash: hashPhoneNumber('+41791234567'),
      numero_appelant_masque: '079 *** ** 67',
    });
  });

  it('persists no callback number when callback permission is strictly false', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const res = await postWebhook(
      analyzedPayloadWithPhones('078 400 16 80', '+41 79 123 45 67', false),
      placeholderSignature(),
    );
    expect(res.status).toBe(200);
    await waitForAsyncProcessing();

    const persisted = vi.mocked(queries.persistCallAnalyzed).mock.calls[0]?.[0];
    expect(persisted?.appel).toMatchObject({
      patient_telephone: null,
      numero_appelant_hash: hashPhoneNumber('+41791234567'),
      numero_appelant_masque: '079 *** ** 67',
    });
  });

  it('does not coerce the string "false" into a callback veto', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const res = await postWebhook(
      analyzedPayloadWithPhones('078 400 16 80', '+41 79 123 45 67', 'false'),
      placeholderSignature(),
    );
    expect(res.status).toBe(200);
    await waitForAsyncProcessing();

    const persisted = vi.mocked(queries.persistCallAnalyzed).mock.calls[0]?.[0];
    expect(persisted?.appel.patient_telephone).toBe('+41784001680');
  });

  it('keeps the legacy fallback when callback permission is absent', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const res = await postWebhook(
      analyzedPayloadWithPhones('numéro indisponible', '0041 78 400 16 80'),
      placeholderSignature(),
    );
    expect(res.status).toBe(200);
    await waitForAsyncProcessing();

    const persisted = vi.mocked(queries.persistCallAnalyzed).mock.calls[0]?.[0];
    expect(persisted?.appel).toMatchObject({
      patient_telephone: '+41784001680',
      numero_appelant_hash: hashPhoneNumber('+41784001680'),
      numero_appelant_masque: '078 *** ** 80',
    });
  });

  it('persists no callback identifier when custom data and caller-ID are invalid', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const res = await postWebhook(
      analyzedPayloadWithPhones('12345', '+33123456789'),
      placeholderSignature(),
    );
    expect(res.status).toBe(200);
    await waitForAsyncProcessing();

    const persisted = vi.mocked(queries.persistCallAnalyzed).mock.calls[0]?.[0];
    expect(persisted?.appel).toMatchObject({
      patient_telephone: null,
      numero_appelant_hash: null,
      numero_appelant_masque: null,
    });
  });

  it('returns 500 and does not acknowledge when persistence fails before insert', async () => {
    mockSdkVerify.mockResolvedValue(true);
    vi.mocked(queries.persistCallAnalyzed).mockRejectedValueOnce(
      new Error('synthetic_db_unavailable'),
    );
    const res = await postWebhook(fixtureAnalyzed, placeholderSignature());
    expect(res.status).toBe(500);
    expect(insertedAppels.size).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
  });

  it('returns 500 with no partial state when the atomic RPC fails between job inserts', async () => {
    mockSdkVerify.mockResolvedValue(true);
    vi.mocked(queries.persistCallAnalyzed).mockRejectedValueOnce(
      new Error('synthetic_transaction_rolled_back'),
    );
    const res = await postWebhook(fixtureAnalyzed, placeholderSignature());
    expect(res.status).toBe(500);
    expect(insertedAppels.size).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
  });

  it('replay repairs a historically missing purge job without duplicating process_appel', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const raw = JSON.parse(fixtureAnalyzed) as { call: { call_id: string } };
    insertedAppels.set(raw.call.call_id, 'appel-existing');
    enqueuedJobs.push({ type: 'process_appel', appelId: 'appel-existing' });
    const res = await postWebhook(fixtureAnalyzed, placeholderSignature());
    expect(res.status).toBe(200);
    expect(enqueuedJobs).toEqual([
      { type: 'process_appel', appelId: 'appel-existing' },
      { type: 'purge_audio_retell', appelId: 'appel-existing' },
    ]);
  });

  it('accepts a valid signed payload and enqueues 2 jobs (process_appel + purge_audio_retell)', async () => {
    // Session 3 change: the historical 3-job split (generate_pdf +
    // send_email + purge_audio_retell) was collapsed into ONE monolithic
    // `process_appel` job that runs the pipeline PDF -> upload -> email
    // with per-step checkpoints in its payload. The audio purge stays a
    // separate job because it fires at +48 h.
    mockSdkVerify.mockResolvedValue(true);
    const appointmentPayload = JSON.parse(fixtureAnalyzed) as {
      call: {
        call_analysis: {
          custom_analysis_data: Record<string, unknown>;
        };
      };
    };
    appointmentPayload.call.call_analysis.custom_analysis_data.resultat = 'echec';
    appointmentPayload.call.call_analysis.custom_analysis_data.motif_appel =
      'prendre_rendez_vous';
    appointmentPayload.call.call_analysis.custom_analysis_data.rdv_date = null;
    const res = await postWebhook(
      JSON.stringify(appointmentPayload),
      placeholderSignature(),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, event: 'call_analyzed' });

    await waitForAsyncProcessing();
    // Give the microtasks that follow enqueue #1 time to enqueue #2.
    await vi.waitFor(
      () => {
        if (enqueuedJobs.length < 2) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );

    expect(enqueuedJobs.map((j) => j.type).sort()).toEqual([
      'process_appel',
      'purge_audio_retell',
    ]);
    expect(vi.mocked(queries.reconcileCalendarBookingForAppel)).toHaveBeenCalledWith(
      'appel-1',
      cabinetRow.id,
      expect.any(String),
      expect.any(String),
      null,
    );
  });

  it('is idempotent: replaying the same webhook creates exactly one appel and one set of jobs', async () => {
    mockSdkVerify.mockResolvedValue(true);
    // First delivery.
    const res1 = await postWebhook(fixtureAnalyzed, placeholderSignature());
    expect(res1.status).toBe(200);
    await vi.waitFor(
      () => {
        if (enqueuedJobs.length < 2) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );

    const jobsAfterFirst = enqueuedJobs.length;
    const appelsAfterFirst = insertedAppels.size;
    expect(appelsAfterFirst).toBe(1);
    expect(jobsAfterFirst).toBe(2);

    // Replay: same body, fresh signature.
    const res2 = await postWebhook(fixtureAnalyzed, placeholderSignature());
    expect(res2.status).toBe(200);

    // Give the async path a chance to run (or short-circuit).
    await vi.waitFor(
      () => {
        const calls = vi.mocked(queries.persistCallAnalyzed).mock.calls.length;
        if (calls < 2) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );
    // Small settle so any (unwanted) follow-up enqueues would have run.
    await new Promise((r) => setTimeout(r, 50));

    expect(insertedAppels.size).toBe(1); // no new appel
    expect(enqueuedJobs.length).toBe(jobsAfterFirst); // no new jobs
  });

  it('propagates the request X-Correlation-Id into jobs.correlation_id (session 4 vague 3)', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const CORRELATION = 'cid-e2e-webhook-001';
    const req = request(app)
      .post('/webhooks/retell/call-ended')
      .set('Content-Type', 'application/json')
      .set('X-Correlation-Id', CORRELATION)
      .set('x-retell-signature', placeholderSignature());
    const res = await req.send(fixtureAnalyzed);
    expect(res.status).toBe(200);
    // Response echoes the correlation id (correlationMiddleware wiring).
    expect(res.header['x-correlation-id']).toBe(CORRELATION);

    // Wait for the async processing to enqueue at least the process_appel job.
    await vi.waitFor(
      () => {
        if (enqueuedJobs.length < 2) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );

    // Inspect the actual enqueue calls — the row must carry the CID.
    const persistCall = vi.mocked(queries.persistCallAnalyzed).mock.calls[0];
    expect(persistCall?.[0].correlationId).toBe(CORRELATION);
  });

  it('answers 200 (no crash) when to_number does not match any cabinet', async () => {
    mockSdkVerify.mockResolvedValue(true);
    const rawObj = JSON.parse(fixtureAnalyzed) as {
      call: { to_number: string; call_id: string };
    };
    rawObj.call.to_number = '+41215559999'; // unknown
    rawObj.call.call_id = 'call_unmapped_xyz';
    const raw = JSON.stringify(rawObj);

    const res = await postWebhook(raw, placeholderSignature());
    expect(res.status).toBe(200);

    // Wait for the async path to at least call the cabinet lookup.
    await vi.waitFor(
      () => {
        const calls = vi.mocked(queries.findCabinetByCoryaNumber).mock.calls
          .length;
        if (calls === 0) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );

    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.enqueueJobIdempotent)).not.toHaveBeenCalled();
  });
});
