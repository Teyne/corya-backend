/**
 * Retell webhook signature verification + payload parsing.
 *
 * ---------------------------------------------------------------------------
 * SIGNATURE FORMAT — observed on REAL ngrok traffic on 2026-07-31.
 * Not a supposition: captured from an actual Retell dashboard test webhook.
 * ---------------------------------------------------------------------------
 *
 *   Header  : `X-Retell-Signature`
 *   Value   : `v=<timestampMs>,d=<hmacSha256Hex>`
 *   Example : `v=1785450205245,d=4def1fb4105ac45e186acecf1a11cb23e8f3b5bb07d7f85ee6bdf6e5eb5086df`
 *
 *   HMAC input  : the ASCII string `${timestampMs}.${rawBody}` — the
 *                 millisecond timestamp, a literal ASCII dot, then the raw
 *                 request bytes exactly as received.
 *   HMAC output : hex-encoded SHA-256 digest, always 64 lowercase chars.
 *
 * Anti-replay: `timestampMs` is millisecond-precision Unix time and must
 * fall within +/- RETELL_SIGNATURE_MAX_AGE_SECONDS of the server clock —
 * bidirectional, so a clock skew or a forged future timestamp both fail
 * fast. The chosen unit (seconds vs ms) is a classic source of silent
 * bypasses, so the code is deliberately explicit about it at every step.
 *
 * ---------------------------------------------------------------------------
 * Why we DON'T use `retell-sdk` for this:
 *   The webhook is the front door for every piece of medical data we handle.
 *   For the nLPD audits we want the crypto code to live in-repo, be readable
 *   in a single screen, and be exhaustively unit-tested here — not hidden
 *   behind a third-party module we would also need to pin, audit, and watch
 *   for supply-chain incidents. It's ~15 lines of stable crypto. It stays.
 * ---------------------------------------------------------------------------
 *
 * Design notes:
 *   1. `crypto.timingSafeEqual` THROWS on length mismatch — and that throw
 *      itself would leak length information via error timing. We therefore
 *      compare lengths first and, when they differ, still run a dummy
 *      timingSafeEqual against a same-length zero buffer to keep the code
 *      path uniform.
 *   2. We MUST hash the raw body bytes, not the JSON-parsed object re-
 *      serialised. Any whitespace difference would break the signature. The
 *      caller (webhooks route) is responsible for handing us the raw Buffer.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { RetellSignatureError, WebhookValidationError } from '../utils/errors.js';
import type {
  RetellCallAnalyzed,
  RetellCallEnded,
  RetellCallStarted,
  RetellWebhookEvent,
} from '../types/index.js';

export const RETELL_SIGNATURE_HEADER = 'x-retell-signature';

/**
 * Strict header parser. The regex is anchored on both ends and enforces:
 *   - literal prefix `v=` followed by one or more digits (timestampMs)
 *   - literal separator `,d=`
 *   - exactly 64 lowercase hex chars (SHA-256 hex digest length)
 * Anything else is rejected. No forgiveness of whitespace, no alternative
 * orderings, no extra components.
 */
const SIGNATURE_HEADER_RE = /^v=(\d+),d=([a-f0-9]{64})$/;

interface ParsedSignatureHeader {
  timestampMs: number;
  digestHex: string;
}

function parseSignatureHeader(
  headerValue: string | undefined,
): ParsedSignatureHeader | null {
  if (!headerValue || headerValue.length === 0) return null;
  const m = SIGNATURE_HEADER_RE.exec(headerValue.trim());
  if (!m) return null;
  const timestampMs = Number(m[1]);
  // Number() on a ~13-digit string is exactly representable, but guard anyway.
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  return { timestampMs, digestHex: m[2] };
}

/**
 * Resolve which secret to use. `RETELL_WEBHOOK_SECRET` takes precedence
 * because it's the modern Retell convention; older accounts sign with the
 * API key, which is why we fall back to `RETELL_API_KEY`.
 *
 * env.ts has already enforced (via a zod refinement) that at least one of
 * the two is present, so this function is guaranteed to return a non-empty
 * string in production. The `throw` here is a belt-and-braces guard for
 * completeness of the type narrowing.
 */
export function getEffectiveRetellSecret(): {
  secret: string;
  source: 'webhook_secret' | 'api_key';
} {
  const webhookSecret = env.RETELL_WEBHOOK_SECRET;
  if (webhookSecret && webhookSecret.length > 0) {
    return { secret: webhookSecret, source: 'webhook_secret' };
  }
  const apiKey = env.RETELL_API_KEY;
  if (apiKey && apiKey.length > 0) {
    return { secret: apiKey, source: 'api_key' };
  }
  // Should never happen — env.ts refuses to boot otherwise.
  throw new Error(
    'no_retell_secret_configured (env.ts refinement should have caught this)',
  );
}

// Log the chosen source EXACTLY ONCE per process. We used to inline this in
// the webhook handler, which spammed the logs and made the diagnostic value
// low. `logRetellSecretSourceOnce()` is invoked from the app bootstrap.
let secretSourceLogged = false;
export function logRetellSecretSourceOnce(): void {
  if (secretSourceLogged) return;
  secretSourceLogged = true;
  const { source } = getEffectiveRetellSecret();
  logger.info(
    { source },
    `Retell signature verification using: ${source}`,
  );
}

/** Test-only. Resets the once-flag so tests can observe the log path. */
export function __resetSecretSourceLoggedForTests(): void {
  secretSourceLogged = false;
}

/**
 * Verify a Retell webhook signature.
 *
 * Steps, with units spelled out to avoid the ms/s confusion trap:
 *   1. Parse the header into { timestampMs, digestHex }. Reject if malformed.
 *   2. Compute `ageSeconds = abs(nowMs - timestampMs) / 1000`.
 *   3. Reject if `ageSeconds > maxAgeSeconds` — bidirectional (rejects both
 *      stale replays AND timestamps too far in the future).
 *   4. Compute HMAC-SHA256(secret, `${timestampMs}.${rawBody}`) as hex.
 *   5. Compare against `digestHex` with timing-safe equality.
 *
 * On rejection the function returns `false`; the HTTP layer maps that to 401
 * via `RetellSignatureError`. Also logs the drift in seconds when the
 * timestamp check fails — this is what we need to spot an NTP drift on
 * Jelastic in prod.
 */
export function verifyRetellSignature(
  rawBody: Buffer,
  headerSignature: string | undefined,
  secret: string,
  options?: { maxAgeSeconds?: number; nowMs?: number },
): boolean {
  const parsed = parseSignatureHeader(headerSignature);
  if (!parsed) return false;

  const maxAgeSeconds =
    options?.maxAgeSeconds ?? env.RETELL_SIGNATURE_MAX_AGE_SECONDS;
  const nowMs = options?.nowMs ?? Date.now();

  // Explicit units: header is in ms, we divide by 1000 to compare with the
  // maxAge configured in SECONDS.
  const driftSeconds = Math.abs(nowMs - parsed.timestampMs) / 1000;
  if (driftSeconds > maxAgeSeconds) {
    logger.warn(
      {
        drift_seconds: Math.round(driftSeconds),
        max_age_seconds: maxAgeSeconds,
        direction: parsed.timestampMs > nowMs ? 'future' : 'past',
      },
      'retell_signature_timestamp_out_of_window',
    );
    return false;
  }

  // HMAC over `${timestampMs}.${rawBody}`. We build the signed material by
  // concatenating the ASCII prefix with the raw body BUFFER — never re-
  // decoding the body, so binary-safe (Retell only sends UTF-8 JSON today,
  // but this is one less surprise vector).
  const prefix = Buffer.from(`${parsed.timestampMs}.`, 'utf8');
  const signedMaterial = Buffer.concat([prefix, rawBody]);
  const expectedHex = createHmac('sha256', secret)
    .update(signedMaterial)
    .digest('hex');

  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(parsed.digestHex, 'utf8');

  // Length mismatch defence: keep the compute cost constant to avoid a
  // length-based timing leak. In practice both sides are always 64 bytes
  // (the regex enforces 64 hex chars on `provided`, and sha256 hex is 64
  // chars on `expected`) — this branch is unreachable but stays as belt.
  if (expected.length !== provided.length) {
    const dummy = Buffer.alloc(expected.length);
    timingSafeEqual(expected, dummy);
    return false;
  }

  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// Payload schemas — one per event, plus a discriminated union.
// ---------------------------------------------------------------------------
//
// Retell emits THREE events per phone call:
//   1. `call_started`  — agent picked up, no transcript/analysis yet
//   2. `call_ended`    — call finished, still no analysis
//   3. `call_analyzed` — analysis finished, transcript + custom fields ready
//
// Only `call_analyzed` triggers our business logic. The other two are
// acknowledged with 200 and zero DB work.
//
// Schemas for `call_started` and `call_ended` are intentionally MINIMAL —
// we only validate what we log (call_id + call_type). Any unknown field is
// tolerated, so a Retell payload shape change on those two events cannot
// break us.

const callAnalyzedCallSchema = z.object({
  call_id: z.string().min(1),
  agent_id: z.string().min(1),
  call_type: z.enum(['phone_call', 'web_call']),
  call_status: z.string().min(1),
  from_number: z.string().min(1).optional(),
  to_number: z.string().min(1).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  start_timestamp: z.number().int().nonnegative(),
  end_timestamp: z.number().int().nonnegative().optional(),
  disconnect_reason: z.string().optional(),
  transcript: z.string().optional(),
  recording_url: z.string().url().optional(),
  public_log_url: z.string().url().optional(),
  call_analysis: z
    .object({
      call_summary: z.string().optional(),
      user_sentiment: z
        .enum(['Positive', 'Neutral', 'Negative', 'Unknown'])
        .optional(),
      call_successful: z.boolean().optional(),
      custom_analysis_data: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

const callAnalyzedSchema = z.object({
  event: z.literal('call_analyzed'),
  call: callAnalyzedCallSchema,
});

// Minimal schemas for the two "notification-only" events. `call_id` is what
// we log for correlation. Everything else is tolerated.
const minimalCallSchema = z
  .object({
    call_id: z.string().min(1),
    call_type: z.enum(['phone_call', 'web_call']).optional(),
  })
  .passthrough();

const callStartedSchema = z
  .object({
    event: z.literal('call_started'),
    call: minimalCallSchema,
  })
  .passthrough();

const callEndedSchema = z
  .object({
    event: z.literal('call_ended'),
    call: minimalCallSchema,
  })
  .passthrough();

const anyEventSchema = z.discriminatedUnion('event', [
  callStartedSchema,
  callEndedSchema,
  callAnalyzedSchema,
]);

/**
 * Parse a `call_analyzed` payload strictly. Throws WebhookValidationError
 * with a compact list of issue paths — never the offending value.
 */
export function parseRetellPayload(input: unknown): RetellCallAnalyzed {
  const result = callAnalyzedSchema.safeParse(input);
  if (!result.success) {
    const paths = result.error.issues
      .map((i) => i.path.join('.') || '<root>')
      .join(', ');
    throw new WebhookValidationError(`invalid_payload: ${paths}`);
  }
  return result.data satisfies RetellCallAnalyzed;
}

/**
 * Parse any of the three Retell events. Business logic in the route decides
 * what to do with each `event` value.
 */
export function parseRetellEvent(input: unknown): RetellWebhookEvent {
  const result = anyEventSchema.safeParse(input);
  if (!result.success) {
    const paths = result.error.issues
      .map((i) => i.path.join('.') || '<root>')
      .join(', ');
    throw new WebhookValidationError(`invalid_payload: ${paths}`);
  }
  // Discriminated-union narrowing: TS knows result.data matches one of the
  // three variants. The satisfies check keeps drift with the shared type
  // definition honest at compile time.
  return result.data satisfies
    | RetellCallStarted
    | RetellCallEnded
    | RetellCallAnalyzed;
}

/**
 * Convenience for tests: verify signature then parse. Throws
 * RetellSignatureError BEFORE any parsing so an invalid signature never
 * triggers zod overhead (or any log line containing payload fragments).
 */
export function verifyAndParse(
  rawBody: Buffer,
  headerSignature: string | undefined,
  secret: string,
  options?: { maxAgeSeconds?: number; nowMs?: number },
): RetellCallAnalyzed {
  if (!verifyRetellSignature(rawBody, headerSignature, secret, options)) {
    throw new RetellSignatureError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookValidationError('body_not_json');
  }
  return parseRetellPayload(parsed);
}
