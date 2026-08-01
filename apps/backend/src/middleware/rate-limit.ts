/**
 * In-memory fixed-window rate limiter.
 *
 * ---------------------------------------------------------------------------
 * Why bespoke, not `express-rate-limit`
 * ---------------------------------------------------------------------------
 * Decision validated by the founder. Trade-offs:
 *   - `express-rate-limit` ships a full pluggable store abstraction we do
 *     not need. In particular, its `ERR_ERL_PERMISSIVE_TRUST_PROXY` guard
 *     is a foot-gun in our reverse-proxy topology (Jelastic) — the
 *     library rejects requests with X-Forwarded-For when
 *     `trust proxy: true`, and we deliberately use `trust proxy: <hops>`.
 *   - A global fixed-window counter is ~25 lines. Behaviour is trivial to
 *     reason about, no shared-state contract to maintain across releases.
 *
 * ---------------------------------------------------------------------------
 * Why global (not per-IP) for the webhook
 * ---------------------------------------------------------------------------
 * Retell hits us from a small pool of egress IPs. A per-IP limit would:
 *   - fail to protect against anything meaningful (a hostile caller must
 *     forge Retell's HMAC — the real gate is `Retell.verify()`);
 *   - risk blocking the LEGITIMATE client during a burst of retry that
 *     originates from one of those pool IPs.
 * The global counter serves a different purpose: cap the resource
 * footprint of a bad batch (or a bug) at 300 requests / minute, no matter
 * the source. Retell's real production rate is far below.
 *
 * ---------------------------------------------------------------------------
 * Semantics
 * ---------------------------------------------------------------------------
 *   - Fixed window: current window starts at floor(now/window) * window.
 *   - Counter INCREMENTED on entry, BEFORE the handler runs. A handler
 *     that ends in 500 still consumed a slot — we do not credit it back.
 *   - On breach: 429 + `Retry-After: <seconds>` computed from
 *     the remaining time in the window.
 *   - Log entry on rejection: endpoint + counter + remaining. No patient
 *     data, no headers, no body.
 *
 * ---------------------------------------------------------------------------
 * `/api/*` middleware
 * ---------------------------------------------------------------------------
 * Exported (10 req/s per key: "api") but NOT MOUNTED in `src/index.ts` —
 * the /api routes do not yet exist. Adding the mount at first `/api` route
 * is a one-liner in `index.ts`.
 */
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

interface Bucket {
  /** Wall-clock ms marking the start of the current window. */
  windowStart: number;
  /** Requests counted in the current window. */
  count: number;
}

/** All buckets, keyed by rate-limit scope name. */
const buckets = new Map<string, Bucket>();

/** Test-only reset. Never called from production code. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}

export interface RateLimitOptions {
  /** Bucket key — different endpoints must use different keys. */
  scope: string;
  /** Max requests per window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Build an Express middleware enforcing a global counter.
 *
 * IMPORTANT: the returned middleware never throws — a rate-limit bug
 * must not become a 500 on every request. On the reject path we
 * `res.status(429).end()` and return.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { scope, max, windowMs } = options;

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    let bucket = buckets.get(scope);

    if (bucket === undefined || now - bucket.windowStart >= windowMs) {
      // Fresh window — align its start with `now` so the "retry after"
      // math below is meaningful in the borderline case (a request just
      // rolling over).
      bucket = { windowStart: now, count: 0 };
      buckets.set(scope, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const remainingMs = Math.max(0, windowMs - (now - bucket.windowStart));
      const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1_000));
      res.setHeader('Retry-After', String(retryAfterSec));
      // pino-http already attached req.log; use it so the entry carries
      // the correlation id and req.id like every other request log.
      req.log.warn(
        {
          rate_limit_scope: scope,
          count: bucket.count,
          max,
          window_ms: windowMs,
          path: req.path,
        },
        'rate_limited',
      );
      res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfterSec });
      return;
    }

    next();
  };
}

/**
 * Preset for the webhook path — GLOBAL scope, values from env. Mounted
 * on `/webhooks` in `src/index.ts`.
 */
export function buildWebhookRateLimiter() {
  return createRateLimiter({
    scope: 'webhook',
    max: env.RATE_LIMIT_WEBHOOK_MAX,
    windowMs: env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
  });
}

/**
 * Preset for the (future) `/api/*` back-office endpoints. 10 req/s,
 * still global. NOT MOUNTED — added here so the wiring is a one-liner
 * the day those routes land.
 */
export function buildApiRateLimiter() {
  return createRateLimiter({
    scope: 'api',
    max: 10,
    windowMs: 1_000,
  });
}
