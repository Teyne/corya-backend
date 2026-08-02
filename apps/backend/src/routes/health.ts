/**
 * Health endpoints.
 *
 * ---------------------------------------------------------------------------
 * GET /health — liveness (public)
 * ---------------------------------------------------------------------------
 * Zero I/O. Answers 200 as long as the process is up. External monitors
 * ping it every ~3 min. Response fields kept minimal so a body regex on
 * the monitoring side stays stable across releases: status, version,
 * timestamp, uptime_seconds.
 *
 * ---------------------------------------------------------------------------
 * GET /health/deep — readiness (token-protected)
 * ---------------------------------------------------------------------------
 * Header `X-Health-Token`. Compared with `HEALTH_DEEP_TOKEN` in
 * CONSTANT TIME (`crypto.timingSafeEqual`). Length mismatch would throw
 * in `timingSafeEqual` so we guard on both sides:
 *   - equal length before calling
 *   - constant time on same-length buffers
 * On any failure (missing header, wrong token, no HEALTH_DEEP_TOKEN
 * configured) we return **404**, NOT 401: we do not reveal the endpoint's
 * existence to an unauthenticated caller.
 *
 * The response is cached in memory for HEALTH_DEEP_CACHE_MS (default 60 s)
 * so a misconfigured monitor cannot open Storage + SMTP + DB connections
 * in a hot loop. The cache is scoped per query variant (with/without
 * ?full=1) — a call with `?full=1` never returns a cached response
 * computed without it.
 *
 * Semantics of the returned `status`:
 *   - "ok"         : every check.ok === true
 *   - "unhealthy"  : at least one CORE check failed (db, storage)
 *   - "degraded"   : only auxiliary checks failed (worker, jobs_backlog,
 *                    crons, smtp when queried)
 * HTTP status is 200 for "ok", 503 for anything else (per brief).
 *
 * NEVER leak URLs, IDs, bucket names, or secrets in the response body.
 * Check payloads carry only booleans, counters, and stable jobnames from
 * the cron-check module.
 *
 * NB: no Retell check — a synthetic call would burn quota to learn that
 * Retell is up, information we cannot act on.
 */
import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getMostRecentHeartbeat, pingDb, countPendingJobsOlderThan } from '../db/queries.js';
import { ensureBucketAccessible } from '../services/storage.js';
import { getSharedTransporterForHealth } from '../services/email.js';
import { computeCronHealthReport } from '../services/cron-check.js';
import type { StaleCron } from '../services/cron-check.js';
import { extractErrorInfo } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckOk {
  ok: true;
  [extra: string]: unknown;
}
interface CheckFail {
  ok: false;
  [extra: string]: unknown;
}
type Check = CheckOk | CheckFail;

type OverallStatus = 'ok' | 'degraded' | 'unhealthy';

interface DeepHealthBody {
  status: OverallStatus;
  checks: Record<string, Check>;
  cached: boolean;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Timeouts hard-coded per brief (2 s db, 3 s storage, 3 s smtp)
// ---------------------------------------------------------------------------
const DB_TIMEOUT_MS = 2_000;
// Storage check delegates to ensureBucketAccessible which uses
// TIMEOUT_STORAGE_MS (30 s) already. A tighter 3 s ceiling here would
// duplicate that mechanism without adding value — the health cache
// (60 s default) is the real gate against burst calls.
const SMTP_TIMEOUT_MS = 3_000;
const BACKLOG_MIN_AGE_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// Process boot marker for uptime_seconds on GET /health
// ---------------------------------------------------------------------------
const bootTimeMs = Date.now();

/** Package version — set from index.ts to avoid re-reading package.json. */
let packageVersion = '0.0.0-unset';
export function setHealthPackageVersion(v: string): void {
  packageVersion = v;
}

// ---------------------------------------------------------------------------
// Token compare — constant time, safe on length mismatch
// ---------------------------------------------------------------------------
/**
 * True iff the supplied token matches HEALTH_DEEP_TOKEN in constant time.
 * Returns false on any of:
 *   - HEALTH_DEEP_TOKEN not configured
 *   - header missing / empty / not a string
 *   - length mismatch (short-circuit before timingSafeEqual which would throw)
 *   - byte-level inequality
 *
 * Only same-length inputs reach timingSafeEqual; still uses it to avoid
 * leaking side-channels in the equal-length case.
 */
function isValidHealthToken(supplied: unknown): boolean {
  const expected = env.HEALTH_DEEP_TOKEN;
  if (!expected) return false;
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
interface CacheEntry {
  computedAt: number;
  body: DeepHealthBody;
  httpStatus: number;
}
const cache = new Map<string, CacheEntry>();

/** Test-only: wipe the deep-health cache. */
export function __resetDeepHealthCacheForTests(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Individual checks — each returns a Check object and NEVER throws.
// ---------------------------------------------------------------------------

async function timed<T>(fn: () => Promise<T>): Promise<{ result?: T; err?: unknown; ms: number }> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, ms: Date.now() - t0 };
  } catch (err: unknown) {
    return { err, ms: Date.now() - t0 };
  }
}

async function checkDb(): Promise<Check> {
  const { err, ms } = await timed(() => pingDb(DB_TIMEOUT_MS));
  if (err !== undefined) {
    return { ok: false, duration_ms: ms, err_name: errName(err) };
  }
  return { ok: true, duration_ms: ms };
}

async function checkStorage(): Promise<Check> {
  const { err, ms } = await timed(async () => {
    // ensureBucketAccessible enforces its own storage timeout via the
    // withTimeout wrapper. Any error here is a bucket-level or auth
    // failure — reported as check failure with just err_name (bucket
    // name intentionally NOT leaked).
    await ensureBucketAccessible();
  });
  if (err !== undefined) {
    return { ok: false, duration_ms: ms, err_name: errName(err) };
  }
  return { ok: true, duration_ms: ms };
}

async function checkWorker(): Promise<Check> {
  try {
    const row = await getMostRecentHeartbeat();
    if (row === null) {
      return { ok: false, reason: 'no_worker_heartbeat' };
    }
    const ageSec = Math.max(0, Math.round((Date.now() - new Date(row.last_seen_at).getTime()) / 1_000));
    const stale = ageSec > env.WORKER_STALE_THRESHOLD_SECONDS;
    return stale
      ? { ok: false, last_seen_seconds_ago: ageSec, threshold_seconds: env.WORKER_STALE_THRESHOLD_SECONDS }
      : { ok: true, last_seen_seconds_ago: ageSec };
  } catch (err: unknown) {
    return { ok: false, err_name: errName(err) };
  }
}

async function checkJobsBacklog(): Promise<Check> {
  try {
    const pending = await countPendingJobsOlderThan(BACKLOG_MIN_AGE_SECONDS);
    // Reuse the same threshold as the periodic alert so operators see
    // one number, not two. `ok: false` above the threshold.
    const ok = pending <= env.JOBS_BACKLOG_ALERT_THRESHOLD;
    return ok
      ? { ok: true, pending_older_than_5min: pending }
      : {
          ok: false,
          pending_older_than_5min: pending,
          threshold: env.JOBS_BACKLOG_ALERT_THRESHOLD,
        };
  } catch (err: unknown) {
    return { ok: false, err_name: errName(err) };
  }
}

async function checkCrons(): Promise<Check> {
  try {
    const report = await computeCronHealthReport();
    return report.stale.length === 0
      ? {
          ok: true,
          jobs_checked: report.jobs_checked,
          stale: [],
          pending_first_run: report.pending_first_run,
        }
      : {
          ok: false,
          jobs_checked: report.jobs_checked,
          // Stale entries carry jobname + reason + tolerances — no PII
          // possible (pg_cron rows don't reference appels/patients).
          stale: report.stale,
          pending_first_run: report.pending_first_run,
        };
  } catch (err: unknown) {
    return { ok: false, err_name: errName(err) };
  }
}

async function checkSmtp(): Promise<Check> {
  // Uses the SHARED transporter to reuse existing pool credentials, but
  // wraps verify() in our timeout wrapper. verify() opens a full
  // authenticated SMTP connection at Infomaniak — hence the ?full=1 gate.
  const { err, ms } = await timed(async () => {
    const { withTimeout } = await import('../utils/timeout.js');
    const t = getSharedTransporterForHealth();
    if (t === null) throw new Error('smtp_transporter_unavailable');
    await withTimeout(t.verify(), SMTP_TIMEOUT_MS, 'smtp:verify');
  });
  if (err !== undefined) {
    return { ok: false, duration_ms: ms, err_name: errName(err) };
  }
  return { ok: true, duration_ms: ms };
}

// errName() is kept for backwards compat with the /health/deep RESPONSE
// shape (JSON to callers, not just an internal log). Internally it now
// delegates to `extractErrorInfo` so the result is consistent with
// log-site behaviour. New callers should prefer `toLogFields(err)` from
// utils/errors.ts for logs — it additionally surfaces message + PG
// code/details/hint.
function errName(err: unknown): string {
  return extractErrorInfo(err).name;
}

// ---------------------------------------------------------------------------
// Aggregator — combines the individual results into an overall status
// ---------------------------------------------------------------------------

/** Keys considered "core" — a failure here yields `unhealthy` (not just `degraded`). */
const CORE_CHECKS: ReadonlySet<string> = new Set(['db', 'storage']);

function aggregate(checks: Record<string, Check>): OverallStatus {
  let anyFailed = false;
  let coreFailed = false;
  for (const [name, c] of Object.entries(checks)) {
    if (!c.ok) {
      anyFailed = true;
      if (CORE_CHECKS.has(name)) coreFailed = true;
    }
  }
  if (!anyFailed) return 'ok';
  return coreFailed ? 'unhealthy' : 'degraded';
}

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

export const healthRouter: Router = Router();

/** Liveness probe — public. */
healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    version: packageVersion,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round((Date.now() - bootTimeMs) / 1_000),
  });
});

/**
 * Readiness probe — token-protected, cached, may trigger Storage + DB +
 * (optionally) SMTP I/O.
 *
 * A single-flight guard (in-flight promise per key) prevents a burst of
 * calls after the cache expires from launching parallel computations.
 */
const inFlight = new Map<string, Promise<{ body: DeepHealthBody; httpStatus: number }>>();

healthRouter.get('/deep', async (req: Request, res: Response) => {
  const supplied = req.header('X-Health-Token');
  if (!isValidHealthToken(supplied)) {
    // 404, NOT 401 — do not confirm the endpoint exists.
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const full = req.query.full === '1';
  const key = full ? 'full' : 'base';

  // Cache hit?
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.computedAt < env.HEALTH_DEEP_CACHE_MS) {
    res.status(cached.httpStatus).json({ ...cached.body, cached: true });
    return;
  }

  // Single-flight: if another request already recomputes for this key,
  // await its result instead of launching a parallel run.
  let pending = inFlight.get(key);
  if (pending === undefined) {
    pending = (async () => {
      // Run the checks in parallel — no dependency between them.
      const [db, storage, worker, jobsBacklog, crons, smtp] = await Promise.all([
        checkDb(),
        checkStorage(),
        checkWorker(),
        checkJobsBacklog(),
        checkCrons(),
        full ? checkSmtp() : Promise.resolve<Check | null>(null),
      ]);

      const checks: Record<string, Check> = {
        db,
        storage,
        worker,
        jobs_backlog: jobsBacklog,
        crons,
      };
      if (smtp !== null) checks.smtp = smtp;

      const status = aggregate(checks);
      const body: DeepHealthBody = {
        status,
        checks,
        cached: false,
        timestamp: new Date().toISOString(),
      };
      const httpStatus = status === 'ok' ? 200 : 503;
      cache.set(key, { computedAt: Date.now(), body, httpStatus });

      // Log the outcome (info on ok, warn otherwise). Bodies contain only
      // technical fields — safe to include in the log line.
      if (status === 'ok') {
        logger.info({ status, key }, 'health_deep_ok');
      } else {
        // Distill the stale cron list to just jobnames for readability.
        const staleCronNames =
          (checks.crons as CheckFail & { stale?: StaleCron[] }).stale?.map((s) => s.jobname) ??
          [];
        logger.warn(
          {
            status,
            key,
            failing: Object.entries(checks)
              .filter(([, c]) => !c.ok)
              .map(([n]) => n),
            stale_crons: staleCronNames,
          },
          'health_deep_not_ok',
        );
      }
      return { body, httpStatus };
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }

  const { body, httpStatus } = await pending;
  res.status(httpStatus).json(body);
});
