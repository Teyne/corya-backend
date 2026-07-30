/**
 * Retell webhook signature verification + payload parsing.
 *
 * Signature scheme (ASSUMPTION — see docs/architecture.md §"webhook"):
 *   header       : `x-retell-signature`
 *   algorithm    : HMAC-SHA256 of the RAW request body (bytes as received)
 *                  keyed with RETELL_WEBHOOK_SECRET
 *   encoding     : hex-encoded digest
 *
 * Retell's dashboard documents the secret but not a stable header format at
 * the time of writing; if we later find they prefix with e.g. `v1=` or send
 * base64, adapt `verifyRetellSignature` accordingly. The rest of the pipeline
 * doesn't care.
 *
 * Two design points to keep in mind:
 *   1. `crypto.timingSafeEqual` THROWS when the two buffers have different
 *      lengths — that itself would leak length information via error timing.
 *      We therefore compare lengths first and, when they differ, still run a
 *      dummy timingSafeEqual against a same-length zero buffer to keep the
 *      code path uniform.
 *   2. We MUST hash the raw body bytes, not the JSON-parsed object re-
 *      serialised. Any whitespace difference would break the signature. The
 *      caller (webhooks route) is responsible for handing us the raw Buffer.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RetellSignatureError, WebhookValidationError } from '../utils/errors.js';
import type { RetellCallAnalyzed } from '../types/index.js';

export const RETELL_SIGNATURE_HEADER = 'x-retell-signature';

/**
 * Constant-time signature check. Returns true / false only — never throws
 * on length mismatch (which would itself be a timing side-channel).
 */
export function verifyRetellSignature(
  rawBody: Buffer,
  headerSignature: string | undefined,
  secret: string,
): boolean {
  if (!headerSignature || headerSignature.length === 0) return false;

  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(headerSignature.trim(), 'utf8');

  // Length mismatch: run a dummy compare then return false. This keeps the
  // computation cost independent of the input length, avoiding a timing leak.
  if (expected.length !== provided.length) {
    const dummy = Buffer.alloc(expected.length);
    // Result discarded on purpose.
    timingSafeEqual(expected, dummy);
    return false;
  }

  return timingSafeEqual(expected, provided);
}

/**
 * Zod schema for the `call_analyzed` payload. We validate only the fields
 * the backend reads; unknown fields are ignored (zod default). Anything we
 * DO read must be validated so a malformed payload cannot slip through.
 */
const callSchema = z.object({
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

const payloadSchema = z.object({
  event: z.literal('call_analyzed'),
  call: callSchema,
});

/**
 * Parse an already-JSON-decoded payload. Throws WebhookValidationError with
 * a compact list of issue paths — never the offending value.
 */
export function parseRetellPayload(input: unknown): RetellCallAnalyzed {
  const result = payloadSchema.safeParse(input);
  if (!result.success) {
    const paths = result.error.issues
      .map((i) => i.path.join('.') || '<root>')
      .join(', ');
    throw new WebhookValidationError(`invalid_payload: ${paths}`);
  }
  return result.data satisfies RetellCallAnalyzed;
}

/**
 * Convenience: verify signature then parse. Throws RetellSignatureError
 * BEFORE any parsing so an invalid signature never triggers zod overhead
 * (or any log line containing payload fragments).
 */
export function verifyAndParse(
  rawBody: Buffer,
  headerSignature: string | undefined,
  secret: string,
): RetellCallAnalyzed {
  if (!verifyRetellSignature(rawBody, headerSignature, secret)) {
    throw new RetellSignatureError();
  }
  // The raw body is guaranteed to be JSON at this point (express.json ran
  // upstream and populated req.body). But we still parse defensively here
  // for the test path that hands us a raw Buffer directly.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookValidationError('body_not_json');
  }
  return parseRetellPayload(parsed);
}
