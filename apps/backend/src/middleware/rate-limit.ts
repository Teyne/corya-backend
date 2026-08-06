/** In-memory fixed-window rate limiting with bounded, expiring buckets. */
import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

interface Bucket {
  windowStart: number;
  count: number;
  expiresAt: number;
}

const buckets = new Map<string, Bucket>();
const identitySalt = randomBytes(32);
const MAX_BUCKETS = 10_000;
const CLEANUP_INTERVAL = 128;
let operationsSinceCleanup = 0;

export const ADMIN_PREAUTH_SOURCE_MAX = 120;
export const ADMIN_AUTHENTICATED_MAX = 60;
const ADMIN_PREAUTH_WINDOW_MS = 10_000;
const ADMIN_GLOBAL_COLLAPSE_MAX = 2_000;
const ADMIN_GLOBAL_COLLAPSE_WINDOW_MS = 10_000;
const ADMIN_AUTHENTICATED_WINDOW_MS = 60_000;

/** Test-only reset. Never called from production code. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
  operationsSinceCleanup = 0;
}

/** Test-only bounded-store observation. */
export function __getRateLimitBucketCountForTests(): number {
  return buckets.size;
}

export interface RateLimitOptions {
  scope: string;
  max: number;
  windowMs: number;
  /** Constant log route; attacker-controlled request paths are never used. */
  route?: '/admin/*' | '/webhooks/*' | '/limited/*';
}

type IdentitySelector = (req: Request) => string;

const WEBHOOK_INGRESS_MULTIPLIER = 10;

function bucketKey(scope: string, identity?: string): string {
  if (identity === undefined) return `${scope}:global`;
  const digest = createHash('sha256')
    .update(identitySalt)
    .update('\0')
    .update(identity)
    .digest('base64url');
  return `${scope}:${digest}`;
}

function pruneAndBound(now: number): void {
  operationsSinceCleanup += 1;
  if (operationsSinceCleanup < CLEANUP_INTERVAL && buckets.size < MAX_BUCKETS) return;
  operationsSinceCleanup = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now) buckets.delete(key);
  }
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/** Consume one slot without ever logging or returning its identity key. */
export function consumeRateLimit(
  options: RateLimitOptions,
  req: Request,
  res: Response,
  identity?: string,
): boolean {
  const { scope, max, windowMs } = options;
  const now = Date.now();
  pruneAndBound(now);
  const key = bucketKey(scope, identity);
  let bucket = buckets.get(key);

  if (bucket === undefined || bucket.expiresAt <= now) {
    bucket = { windowStart: now, count: 0, expiresAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  if (bucket.count <= max) return true;

  const remainingMs = Math.max(0, bucket.expiresAt - now);
  const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1_000));
  res.setHeader('Retry-After', String(retryAfterSec));
  req.log?.warn(
    {
      rate_limit_scope: scope,
      count: bucket.count,
      max,
      window_ms: windowMs,
      route: options.route ?? '/limited/*',
    },
    'rate_limited',
  );
  res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfterSec });
  return false;
}

/** Build middleware around a global or request-derived ephemeral identity. */
export function createRateLimiter(
  options: RateLimitOptions,
  selectIdentity?: IdentitySelector,
) {
  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const identity = selectIdentity?.(req);
    if (consumeRateLimit(options, req, res, identity)) next();
  };
}

/** Bound all webhook traffic before signature verification. */
export function buildWebhookRateLimiter() {
  return createRateLimiter({
    scope: 'webhook_ingress',
    max: env.RATE_LIMIT_WEBHOOK_MAX * WEBHOOK_INGRESS_MULTIPLIER,
    windowMs: env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
    route: '/webhooks/*',
  });
}

/** Apply the configured business quota only after Retell authentication. */
export function consumeAuthenticatedWebhookRateLimit(req: Request, res: Response): boolean {
  return consumeRateLimit(
    {
      scope: 'webhook_authenticated',
      max: env.RATE_LIMIT_WEBHOOK_MAX,
      windowMs: env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
      route: '/webhooks/*',
    },
    req,
    res,
  );
}

/**
 * Pre-auth portal limiter: isolate abusive network sources first, then consume
 * a generous global circuit-breaker only for source-accepted traffic.
 */
export function buildAdminPreAuthRateLimiter() {
  return function adminPreAuthRateLimiter(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const source = req.ip || 'unknown';
    if (!consumeRateLimit(
      {
        scope: 'admin_pre_auth_source',
        max: ADMIN_PREAUTH_SOURCE_MAX,
        windowMs: ADMIN_PREAUTH_WINDOW_MS,
        route: '/admin/*',
      },
      req,
      res,
      source,
    )) return;

    if (consumeRateLimit(
      {
        scope: 'admin_pre_auth_global',
        max: ADMIN_GLOBAL_COLLAPSE_MAX,
        windowMs: ADMIN_GLOBAL_COLLAPSE_WINDOW_MS,
        route: '/admin/*',
      },
      req,
      res,
    )) next();
  };
}

/** Post-auth quota isolated by the verified actor+cabinet tuple. */
export function consumeAuthenticatedAdminRateLimit(
  req: Request,
  res: Response,
  actorUserId: string,
  cabinetId: string,
): boolean {
  return consumeRateLimit(
    {
      scope: 'admin_authenticated_actor_cabinet',
      max: ADMIN_AUTHENTICATED_MAX,
      windowMs: ADMIN_AUTHENTICATED_WINDOW_MS,
      route: '/admin/*',
    },
    req,
    res,
    `${actorUserId}:${cabinetId}`,
  );
}
