/** In-memory global fixed-window rate limiting. */
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/** Test-only reset. Never called from production code. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}

export interface RateLimitOptions {
  scope: string;
  max: number;
  windowMs: number;
}

/**
 * A wider but finite ingress budget protects signature verification without
 * allowing unsigned traffic to consume Retell's authenticated quota.
 */
const WEBHOOK_INGRESS_MULTIPLIER = 10;

/** Consume one slot synchronously from a named global bucket. */
export function consumeRateLimit(
  options: RateLimitOptions,
  req: Request,
  res: Response,
): boolean {
  const { scope, max, windowMs } = options;
  const now = Date.now();
  let bucket = buckets.get(scope);

  if (bucket === undefined || now - bucket.windowStart >= windowMs) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(scope, bucket);
  }

  bucket.count += 1;
  if (bucket.count <= max) return true;

  const remainingMs = Math.max(0, windowMs - (now - bucket.windowStart));
  const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1_000));
  res.setHeader('Retry-After', String(retryAfterSec));
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
  return false;
}

/** Build an Express middleware around a named global bucket. */
export function createRateLimiter(options: RateLimitOptions) {
  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    if (consumeRateLimit(options, req, res)) next();
  };
}

/** Bound all webhook traffic before signature verification. */
export function buildWebhookRateLimiter() {
  return createRateLimiter({
    scope: 'webhook_ingress',
    max: env.RATE_LIMIT_WEBHOOK_MAX * WEBHOOK_INGRESS_MULTIPLIER,
    windowMs: env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
  });
}

/** Apply the configured business quota only after Retell authentication. */
export function consumeAuthenticatedWebhookRateLimit(req: Request, res: Response): boolean {
  return consumeRateLimit(
    {
      scope: 'webhook_authenticated',
      max: env.RATE_LIMIT_WEBHOOK_MAX,
      windowMs: env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
    },
    req,
    res,
  );
}

/** Future back-office API limiter; not mounted yet. */
export function buildApiRateLimiter() {
  return createRateLimiter({ scope: 'api', max: 10, windowMs: 1_000 });
}
