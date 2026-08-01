/**
 * Correlation ID middleware.
 *
 * ---------------------------------------------------------------------------
 * Responsibilities
 * ---------------------------------------------------------------------------
 *   1. Read `X-Correlation-Id` from the incoming request, OR generate a
 *      fresh UUID v4 (via `crypto.randomUUID` — Node ≥ 20, no npm dep).
 *   2. Validate the incoming header against a strict regex — a
 *      client-supplied string is UNTRUSTED input, and it will end up in
 *      logs AND (via jobs.correlation_id) in a persisted DB column with
 *      a 1..64 CHECK constraint (see migration 20260801000002).
 *   3. Attach the correlation id to `req.correlationId` for downstream
 *      handlers (they read it, they do NOT generate it a second time).
 *   4. Echo the resulting id back in `X-Correlation-Id` on the response,
 *      so callers can grep their own logs against it.
 *
 * ---------------------------------------------------------------------------
 * Wiring
 * ---------------------------------------------------------------------------
 * The `genReqId` option of pino-http reads the same header/regex so the
 * `req.id` embedded in every request log line MATCHES `req.correlationId`.
 * Sharing the id means the log tuple (req.id / correlation_id) is one
 * grep, not two.
 *
 * ---------------------------------------------------------------------------
 * Format policy
 * ---------------------------------------------------------------------------
 *   - Accept: `^[A-Za-z0-9_-]{1,64}$`
 *     Matches UUIDv4 canonical form, ULID (26 chars, Crockford base32),
 *     KSUID (27 chars, base62), and short shell-safe correlation ids.
 *     Rejects control characters, spaces, quotes, angle brackets — a
 *     hostile client cannot inject log-line breaks or SQL fragments.
 *   - Reject silently: an INVALID header is discarded (not 400'd) and we
 *     generate a fresh id. Rationale: refusing the whole request over an
 *     invalid correlation header would create a new denial-of-service
 *     surface. We just log a debug line noting the substitution.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { logger } from '../config/logger.js';

/** Response header used both for input (from client) and output. */
export const CORRELATION_HEADER = 'X-Correlation-Id';

/** Strict regex, aligned with the DB CHECK constraint (1..64 chars). */
const CORRELATION_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Extend Express' Request type in the module scope. The augmentation is
 * intentionally minimal — no other request fields belong here.
 */
declare module 'express-serve-static-core' {
  interface Request {
    correlationId?: string;
  }
}

/**
 * Read a candidate correlation id from an incoming request without doing
 * any generation. Returns `null` when the header is absent OR invalid.
 * Exported for `genReqId` (pino-http) so the pino req id matches.
 */
export function readIncomingCorrelationId(
  req: IncomingMessage,
): string | null {
  const raw = req.headers[CORRELATION_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return CORRELATION_REGEX.test(trimmed) ? trimmed : null;
}

/**
 * pino-http `genReqId` hook. Uses the SAME derivation as the middleware
 * below so pino's `req.id` and `req.correlationId` are always identical.
 * pino-http calls this before the request pipeline runs; the middleware
 * later reads `req.correlationId` (which we set inside the middleware to
 * the same id). Two writers, one truth.
 */
export function genReqId(req: IncomingMessage): string {
  const incoming = readIncomingCorrelationId(req);
  return incoming ?? randomUUID();
}

/**
 * Express middleware — must be installed AFTER `pino-http` so the log
 * enhancer sees the request id already, and BEFORE any route so
 * downstream handlers can read `req.correlationId`.
 */
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawHeader = req.header(CORRELATION_HEADER);
  const incoming = readIncomingCorrelationId(req);

  let id: string;
  if (incoming !== null) {
    id = incoming;
  } else {
    id = randomUUID();
    if (typeof rawHeader === 'string' && rawHeader.length > 0) {
      // Header was present but rejected. Debug-level: this is a
      // client-facing hint, not an ops incident.
      logger.debug(
        { header_present: true },
        'correlation_id_header_invalid_generated_fresh',
      );
    }
  }
  req.correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
}
