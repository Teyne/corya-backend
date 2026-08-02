/**
 * Integration tests — GET /health/deep (session 4 vague 4).
 *
 * We prove:
 *   - 404 when the token is missing / wrong / a different length
 *   - 200 + body shape when every check is green
 *   - 503 + status="unhealthy" when a CORE check (db, storage) fails
 *   - 503 + status="degraded" when only auxiliary checks fail
 *   - Response is cached — a second call inside the window does NOT
 *     re-invoke the underlying checks
 *   - `?full=1` triggers the SMTP check; base path does not
 *   - Response body carries NO url / no bucket name / no secret
 *   - Constant-time compare works across length mismatch (no throw)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// -- Mocks positioned BEFORE importing the app graph -----------------------
const pingDbMock = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve(undefined));
const getMostRecentHeartbeatMock = vi.fn<
  () => Promise<{ last_seen_at: string } | null>
>(() =>
  Promise.resolve({ last_seen_at: new Date().toISOString() }),
);
const countPendingJobsOlderThanMock = vi.fn<(sec: number) => Promise<number>>(
  () => Promise.resolve(0),
);
const getCronHealthMock = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));

vi.mock('../../src/db/queries.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/db/queries.js',
  );
  return {
    ...actual,
    pingDb: pingDbMock,
    getMostRecentHeartbeat: getMostRecentHeartbeatMock,
    countPendingJobsOlderThan: countPendingJobsOlderThanMock,
    getCronHealth: getCronHealthMock,
  };
});

const ensureBucketAccessibleMock = vi.fn<() => Promise<void>>(
  () => Promise.resolve(undefined),
);
vi.mock('../../src/services/storage.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/services/storage.js',
  );
  return { ...actual, ensureBucketAccessible: ensureBucketAccessibleMock };
});

const getSharedTransporterForHealthMock = vi.fn<
  () => { verify: () => Promise<true> } | null
>(() => ({ verify: (): Promise<true> => Promise.resolve(true) }));
vi.mock('../../src/services/email.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/services/email.js',
  );
  return { ...actual, getSharedTransporterForHealth: getSharedTransporterForHealthMock };
});

// A cron shape with all 8 supervised jobs green (last_run_at fresh).
function makeAllHealthyCronRows(): Array<{
  jobname: string;
  schedule: string;
  last_run_at: string;
  last_success_at: string;
  last_status: string;
  seconds_since_last_run: number;
  seconds_since_last_success: number;
  total_runs_last_24h: number;
  failed_runs_last_24h: number;
}> {
  const now = new Date().toISOString();
  return [
    'purge-expired-audio',
    'anonymize-old-transcripts',
    'purge-old-pdfs',
    'purge-ancient-appels',
    'requeue-stuck-jobs',
    'requeue-stuck-file-deletions',
    'purge-stale-worker-heartbeats',
    'purge-cron-run-details',
    'purge-ancient-logs-actions',
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
  }));
}

const { app } = await import('../../src/index.js');
const { __resetDeepHealthCacheForTests } = await import('../../src/routes/health.js');

const TOKEN = process.env.HEALTH_DEEP_TOKEN ?? '';

interface DeepBody {
  status: 'ok' | 'degraded' | 'unhealthy';
  checks: Record<string, { ok: boolean; [k: string]: unknown }>;
  cached: boolean;
  timestamp: string;
}

beforeEach(() => {
  __resetDeepHealthCacheForTests();
  pingDbMock.mockReset().mockResolvedValue(undefined);
  ensureBucketAccessibleMock.mockReset().mockResolvedValue(undefined);
  getMostRecentHeartbeatMock.mockReset().mockResolvedValue({
    last_seen_at: new Date().toISOString(),
  });
  countPendingJobsOlderThanMock.mockReset().mockResolvedValue(0);
  getCronHealthMock.mockReset().mockResolvedValue(makeAllHealthyCronRows());
  getSharedTransporterForHealthMock.mockReset().mockReturnValue({
    verify: (): Promise<true> => Promise.resolve(true),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Token protection
// ---------------------------------------------------------------------------
describe('GET /health/deep — token protection', () => {
  it('returns 404 when the header is missing (does not reveal endpoint existence)', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    // No checks invoked.
    expect(pingDbMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the header is wrong (same status as missing)', async () => {
    const res = await request(app)
      .get('/health/deep')
      .set('X-Health-Token', 'wrong-value-here-ok-16char');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a DIFFERENT-LENGTH header (constant-time compare cannot throw)', async () => {
    // timingSafeEqual throws on length mismatch — the compare wrapper
    // must short-circuit before hitting it. Prove by exercising with a
    // 3-char and a 200-char value.
    for (const attempt of ['abc', 'x'.repeat(200)]) {
      const res = await request(app).get('/health/deep').set('X-Health-Token', attempt);
      expect(res.status).toBe(404);
    }
  });

  it('accepts the valid token (200 body path exercised in the next block)', async () => {
    const res = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect([200, 503]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe('GET /health/deep — happy path', () => {
  it('returns 200 + status ok + all checks green', async () => {
    const res = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(200);
    const body = res.body as DeepBody;
    expect(body.status).toBe('ok');
    for (const [name, c] of Object.entries(body.checks)) {
      expect(c.ok, `check ${name} should be ok`).toBe(true);
    }
    // Base call: SMTP check must NOT be present (protects the Infomaniak quota).
    expect(body.checks.smtp).toBeUndefined();
    expect(body.cached).toBe(false);
  });

  it('adds the smtp check when ?full=1 and only then', async () => {
    const res = await request(app)
      .get('/health/deep?full=1')
      .set('X-Health-Token', TOKEN);
    expect(res.status).toBe(200);
    const body = res.body as DeepBody;
    expect(body.checks.smtp).toBeDefined();
    expect(body.checks.smtp?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Degradation & failure semantics
// ---------------------------------------------------------------------------
describe('GET /health/deep — degraded / unhealthy semantics', () => {
  it('is "unhealthy" (503) when db fails (core)', async () => {
    pingDbMock.mockRejectedValueOnce(new Error('conn refused'));
    const res = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(503);
    expect((res.body as DeepBody).status).toBe('unhealthy');
  });

  it('is "unhealthy" (503) when storage fails (core)', async () => {
    ensureBucketAccessibleMock.mockRejectedValueOnce(new Error('bucket unreachable'));
    const res = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(503);
    expect((res.body as DeepBody).status).toBe('unhealthy');
  });

  it('is "degraded" (503) when only worker heartbeat is stale', async () => {
    // Force a very old heartbeat.
    getMostRecentHeartbeatMock.mockResolvedValueOnce({
      last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const res = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(503);
    expect((res.body as DeepBody).status).toBe('degraded');
  });

  it('is "degraded" (503) when jobs_backlog exceeds the threshold', async () => {
    countPendingJobsOlderThanMock.mockResolvedValueOnce(999);
    const res = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(503);
    expect((res.body as DeepBody).status).toBe('degraded');
  });

  it('is "degraded" (503) when a supervised cron is stale', async () => {
    // Drop one cron from the healthy set → missing_cron path.
    const rows = makeAllHealthyCronRows().filter((r) => r.jobname !== 'purge-expired-audio');
    getCronHealthMock.mockResolvedValueOnce(rows);
    const res = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(503);
    const body = res.body as DeepBody;
    expect(body.status).toBe('degraded');
    const cronCheck = body.checks.crons as { ok: false; stale: Array<{ jobname: string; reason: string }> };
    expect(cronCheck.ok).toBe(false);
    expect(cronCheck.stale.some((s) => s.jobname === 'purge-expired-audio')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
describe('GET /health/deep — cache', () => {
  it('does not re-invoke checks on a second call inside the cache window', async () => {
    await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    const invocationsAfterFirst = {
      db: pingDbMock.mock.calls.length,
      storage: ensureBucketAccessibleMock.mock.calls.length,
      hb: getMostRecentHeartbeatMock.mock.calls.length,
    };
    const res2 = await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    expect(res2.status).toBe(200);
    expect((res2.body as DeepBody).cached).toBe(true);
    // No new invocations of the mocked checks.
    expect(pingDbMock.mock.calls.length).toBe(invocationsAfterFirst.db);
    expect(ensureBucketAccessibleMock.mock.calls.length).toBe(invocationsAfterFirst.storage);
    expect(getMostRecentHeartbeatMock.mock.calls.length).toBe(invocationsAfterFirst.hb);
  });

  it('caches base and full variants separately', async () => {
    await request(app).get('/health/deep').set('X-Health-Token', TOKEN);
    await request(app).get('/health/deep?full=1').set('X-Health-Token', TOKEN);
    // Both variants must have triggered independent computations.
    expect(pingDbMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Response body — no leakage
// ---------------------------------------------------------------------------
describe('GET /health/deep — response payload contains NO secrets/URLs/bucket names', () => {
  it('body never carries the HEALTH_DEEP_TOKEN, no supabase URL, no bucket name', async () => {
    const res = await request(app).get('/health/deep?full=1').set('X-Health-Token', TOKEN);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(TOKEN);
    // The test env sets SUPABASE_URL to localhost — assert it is not echoed.
    expect(raw).not.toContain('localhost:54321');
    // No storage bucket name leaked.
    expect(raw).not.toContain('pdf-recaps');
  });
});
