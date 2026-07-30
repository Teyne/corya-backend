import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

// --- Mock the DB layer BEFORE importing the app graph -----------------------
// The webhook handler enqueues jobs via db/queries.ts. We keep in-memory
// spies here to assert idempotence.

const cabinetRow = {
  id: '11111111-1111-1111-1111-111111111111',
  numero_corya: '+41215550100',
  email_notification: 'ops@corya.example',
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
  };
});

const { app } = await import('../../src/index.js');
const queries = await import('../../src/db/queries.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, '..', 'fixtures', 'retell-payload.json');
const fixtureRaw = readFileSync(fixturePath, 'utf8');

const SECRET = process.env.RETELL_WEBHOOK_SECRET ?? 'test-retell-secret-not-real';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
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
  // The handler processes asynchronously after responding 200. Poll the
  // enqueue mock until it has been called for the current call.
  await vi.waitFor(
    () => {
      const called = (queries.enqueueJobIdempotent as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls.length;
      if (called === 0) throw new Error('not yet');
    },
    { timeout: 2000, interval: 10 },
  );
}

beforeEach(() => {
  insertedAppels.clear();
  enqueuedJobs.length = 0;
  vi.mocked(queries.findCabinetByCoryaNumber).mockClear();
  vi.mocked(queries.insertAppelIdempotent).mockClear();
  vi.mocked(queries.enqueueJobIdempotent).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /webhooks/retell/call-ended', () => {
  it('rejects a request without signature (401)', async () => {
    const res = await postWebhook(fixtureRaw);
    expect(res.status).toBe(401);
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature (401)', async () => {
    const res = await postWebhook(fixtureRaw, 'deadbeef');
    expect(res.status).toBe(401);
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload (400) when signature matches', async () => {
    const badBody = JSON.stringify({ event: 'call_analyzed', call: { call_id: '' } });
    const res = await postWebhook(badBody, sign(badBody));
    expect(res.status).toBe(400);
    expect(vi.mocked(queries.insertAppelIdempotent)).not.toHaveBeenCalled();
  });

  it('accepts a valid signed payload and enqueues 3 jobs', async () => {
    const res = await postWebhook(fixtureRaw, sign(fixtureRaw));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    await waitForAsyncProcessing();
    // Give the microtasks that follow enqueue #1 time to enqueue #2 and #3.
    await vi.waitFor(
      () => {
        if (enqueuedJobs.length < 3) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );

    expect(enqueuedJobs.map((j) => j.type).sort()).toEqual([
      'generate_pdf',
      'purge_audio_retell',
      'send_email',
    ]);
  });

  it('is idempotent: replaying the same webhook creates exactly one appel and one set of jobs', async () => {
    const sig = sign(fixtureRaw);

    // First delivery.
    const res1 = await postWebhook(fixtureRaw, sig);
    expect(res1.status).toBe(200);
    await vi.waitFor(
      () => {
        if (enqueuedJobs.length < 3) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );

    const jobsAfterFirst = enqueuedJobs.length;
    const appelsAfterFirst = insertedAppels.size;
    expect(appelsAfterFirst).toBe(1);
    expect(jobsAfterFirst).toBe(3);

    // Replay: the async orchestrator must detect the duplicate row and
    // return early, without touching the jobs table.
    const res2 = await postWebhook(fixtureRaw, sig);
    expect(res2.status).toBe(200);

    // Give the async path a chance to run (or short-circuit).
    await vi.waitFor(
      () => {
        const calls = vi.mocked(queries.insertAppelIdempotent).mock.calls.length;
        if (calls < 2) throw new Error('waiting');
      },
      { timeout: 2000, interval: 10 },
    );
    // Small settle so any (unwanted) follow-up enqueues would have run.
    await new Promise((r) => setTimeout(r, 50));

    expect(insertedAppels.size).toBe(1); // no new appel
    expect(enqueuedJobs.length).toBe(jobsAfterFirst); // no new jobs
  });

  it('answers 200 (no crash) when to_number does not match any cabinet', async () => {
    const rawObj = JSON.parse(fixtureRaw) as {
      call: { to_number: string; call_id: string };
    };
    rawObj.call.to_number = '+41215559999'; // unknown
    rawObj.call.call_id = 'call_unmapped_xyz';
    const raw = JSON.stringify(rawObj);

    const res = await postWebhook(raw, sign(raw));
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
