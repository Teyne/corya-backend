/**
 * Domain-specific error classes.
 *
 * Each subclass carries an explicit HTTP-ish semantic so the HTTP layer can
 * translate to a status code without leaking internals. Never stuff patient
 * data inside `.message` — messages ARE logged and returned to Retell.
 */

export class WebhookValidationError extends Error {
  public readonly httpStatus = 400;
  constructor(message: string) {
    super(message);
    this.name = 'WebhookValidationError';
  }
}

export class RetellSignatureError extends Error {
  public readonly httpStatus = 401;
  constructor(message = 'invalid_signature') {
    super(message);
    this.name = 'RetellSignatureError';
  }
}

export class CabinetNotFoundError extends Error {
  constructor(message = 'cabinet_not_found') {
    super(message);
    this.name = 'CabinetNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Structured extraction of an unknown throwable for logging
// ---------------------------------------------------------------------------
//
// WHY this exists
// ---------------
// The historical pattern across the codebase was:
//
//   catch (err: unknown) {
//     logger.error({ err_name: err instanceof Error ? err.name : 'unknown' }, 'x_failed');
//   }
//
// which discards `.message`, any Postgres/supabase-js code/details/hint, AND
// the `error.cause` chain. When an incident happened (session 4 vague 7 —
// `alert_poller_dead_letter_query_failed` at boot), the logs said only
// `err_name: "Error"` and the cause was undiagnosable without redeploying
// with extra instrumentation. This helper is the systemic fix.
//
// nLPD SAFETY
// -----------
// Every string that leaves this helper (`message`, `details`, `hint`, and
// the message of any nested cause) is passed through `scrubText` from
// `utils/redact.ts`. The recursive KEY-based sanitiser in the pino formatter
// (see `config/logger.ts`) does not protect string VALUES; this helper is
// the value-side counterpart. It exists specifically because a Postgres
// unique-violation message can embed a patient phone number inside its
// `DETAIL` line.
//
// LOG KEY SHAPE (documented breakage)
// -----------------------------------
// Callers historically emitted `{ err_name: '...' }`. After this refactor,
// callers spread `toLogFields(err)` and get:
//
//   { err_name, err_msg, err_code?, err_details?, err_hint?, err_cause? }
//
// The `err_name` key is preserved verbatim (backwards-compatible). The new
// keys are additive. Downstream log parsing that keyed on `err_name` keeps
// working; anything that used to strictly assert the object shape needs to
// tolerate the additional keys.

/**
 * Structured, log-ready view of an unknown throwable.
 * All string fields are already PII-scrubbed. Serialisable via JSON.stringify.
 */
export interface ErrorInfo {
  name: string;
  message: string;
  /** Postgres / supabase-js `PostgrestError.code` (e.g. '23505'). */
  code?: string;
  /** Postgres `DETAIL:` line. Scrubbed. */
  details?: string;
  /** Postgres `HINT:` line. Scrubbed. */
  hint?: string;
  /** One level of `error.cause` chain. Never recursed deeper (guard against cycles + log noise). */
  cause?: ErrorInfo;
}

/** Log-ready flat shape. Undefined fields are omitted (spread-friendly). */
export interface ErrorLogFields {
  err_name: string;
  err_msg: string;
  err_code?: string;
  err_details?: string;
  err_hint?: string;
  err_cause?: ErrorInfo;
}

// Shape guard for supabase-js `PostgrestError` and other {code, message, details, hint}
// bags — we do NOT import `PostgrestError` (would couple us to the SDK's exported
// types) and structural checks are enough.
function readStringProp(bag: Record<string, unknown>, key: string): string | undefined {
  const v = bag[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Lazy require to avoid a circular import risk in future refactors.
// `scrubText` has no dependencies on this module today, but keeping the
// import at top-level is fine — TypeScript ESM handles the cycle. Direct
// import kept for clarity.
import { scrubText } from './redact.js';

/**
 * Extract a structured, PII-scrubbed view from an unknown value.
 *
 * Handles:
 *   - Real `Error` instances (name, message, cause).
 *   - Postgres / supabase-js error bags exposing `code`, `details`, `hint`.
 *     Works whether these live on an `Error` subclass (RPC errors are thrown
 *     as `Error` with extra fields) or on a plain object returned in
 *     `{ data, error }` and later thrown.
 *   - Strings, numbers, plain objects (`name` defaults to a synthetic marker).
 *   - `null` / `undefined` (returns a sentinel — never throws).
 *   - Circular `.cause` chains (only ONE level of cause is expanded).
 */
export function extractErrorInfo(err: unknown): ErrorInfo {
  return extractInternal(err, /*allowCause*/ true);
}

function extractInternal(err: unknown, allowCause: boolean): ErrorInfo {
  if (err === null || err === undefined) {
    return { name: 'unknown', message: err === null ? 'null_thrown' : 'undefined_thrown' };
  }

  if (typeof err === 'string') {
    return { name: 'string', message: scrubText(err) };
  }

  if (typeof err !== 'object') {
    // Explicit branches keep the logger safe for every primitive without
    // relying on an object's potentially surprising toString implementation.
    let message: string;
    if (typeof err === 'symbol') message = err.description ?? 'symbol_thrown';
    else if (typeof err === 'bigint') message = `${err.toString()}n`;
    else if (typeof err === 'number') message = err.toString();
    else message = err ? 'true' : 'false';
    return { name: typeof err, message };
  }

  const bag = err as Record<string, unknown>;
  const isError = err instanceof Error;

  const name = isError
    ? err.name || 'Error'
    : (readStringProp(bag, 'name') ?? 'non_error');
  const rawMessage = isError
    ? err.message
    : (readStringProp(bag, 'message') ?? '');
  const message = scrubText(rawMessage);

  const info: ErrorInfo = { name, message };

  const code = readStringProp(bag, 'code');
  if (code !== undefined) info.code = code;
  const details = readStringProp(bag, 'details');
  if (details !== undefined) info.details = scrubText(details);
  const hint = readStringProp(bag, 'hint');
  if (hint !== undefined) info.hint = scrubText(hint);

  if (allowCause) {
    // `cause` is standardised on `Error` since Node 16 but may live on a
    // wrapped object too. Read defensively.
    const cause = isError ? (err as Error & { cause?: unknown }).cause : bag.cause;
    if (cause !== undefined && cause !== err) {
      info.cause = extractInternal(cause, /*allowCause*/ false);
    }
  }

  return info;
}

/**
 * Build a flat, log-ready record from an unknown throwable.
 *
 * Usage:
 *
 *   catch (err: unknown) {
 *     logger.error({ ...toLogFields(err), retell_call_id }, 'x_failed');
 *   }
 *
 * `err_name` is always present (backwards-compatible with the pre-refactor
 * shape). Other fields are only included when non-undefined so a "clean"
 * error log stays small.
 */
export function toLogFields(err: unknown): ErrorLogFields {
  const info = extractErrorInfo(err);
  const out: ErrorLogFields = {
    err_name: info.name,
    err_msg: info.message,
  };
  if (info.code !== undefined) out.err_code = info.code;
  if (info.details !== undefined) out.err_details = info.details;
  if (info.hint !== undefined) out.err_hint = info.hint;
  if (info.cause !== undefined) out.err_cause = info.cause;
  return out;
}
