/**
 * Anonymisation helpers for patient phone numbers.
 *
 * - `hashPhoneNumber` : deterministic SHA-256 of the E.164-ish number.
 *   Serves as a technical identifier stored in `appels.numero_appelant_hash`,
 *   enabling per-caller analytics without keeping the raw number past J+7.
 *
 * - `maskPhoneNumber` : display-only masking ("078 *** ** 45"). Stored in
 *   `appels.numero_appelant_masque`, safe for the admin back-office.
 *
 * Neither function is intended for cryptographic secrecy — SHA-256 of a phone
 * number is trivially rainbow-tabled. It is a minimisation measure that
 * removes the direct identifier from analytics-only rows.
 */
import { createHash } from 'node:crypto';

/**
 * Normalise a phone number to digits only (keeping a leading `+`).
 * Everything else (spaces, dashes, parens) is stripped, so the hash is stable
 * regardless of the format Retell hands us.
 */
export function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  return hasPlus ? `+${digits}` : digits;
}

/**
 * SHA-256 hex of the normalised phone number.
 */
export function hashPhoneNumber(raw: string): string {
  return createHash('sha256').update(normalizePhoneNumber(raw)).digest('hex');
}

/**
 * Mask a phone number for display. Keeps the leading operator prefix (first 3
 * digits) and the trailing 2 digits; everything in between becomes `*`, with
 * the same visual spacing as the Swiss "078 *** ** 45" convention.
 *
 * Falls back to `***` if the number is too short to be meaningful.
 */
export function maskPhoneNumber(raw: string): string {
  const digits = normalizePhoneNumber(raw).replace(/^\+/, '');
  if (digits.length < 6) return '***';
  const prefix = digits.slice(0, 3);
  const suffix = digits.slice(-2);
  const middleLen = digits.length - 5;
  // Swiss layout: "078 *** ** 45" — three stars, space, two stars, space, tail.
  // For non-standard lengths we degrade gracefully to a single star run.
  if (middleLen === 5) {
    return `${prefix} *** ** ${suffix}`;
  }
  return `${prefix} ${'*'.repeat(middleLen)} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Free-text scrubbing (for error messages)
// ---------------------------------------------------------------------------
//
// The recursive sanitiser in `config/logger.ts` redacts by KEY name. That
// covers structured payloads (Retell events, DB rows, request bodies) but is
// blind to patient data that leaks INSIDE the string VALUE of an error
// message — the archetypal case being a Postgres unique-key violation:
//
//   `duplicate key value violates unique constraint "appels_telephone_key"
//    DETAIL:  Key (patient_telephone)=(+41791234567) already exists.`
//
// `scrubText` is the value-side counterpart to that key-side sanitiser. It
// erases two families of patterns from any string before it can reach the
// logs:
//
//   1. Postgres `(column)=(value)` detail fragments — the value is replaced
//      wholesale so any column name (including columns we may add tomorrow)
//      is covered without an allow-list.
//
//   2. Phone-number-like digit runs (Swiss, E.164, or partially formatted).
//      This is deliberately over-inclusive: a false positive on an unrelated
//      long numeric ID is preferable to leaking a patient phone number.
//
// LIMITATION deliberately assumed: bare names in prose ("Dupont exists")
// cannot be reliably regex-detected. Names carried inside a Postgres detail
// fragment ARE caught by rule 1 above; names in free prose from an
// unforeseen source are not. New leak vectors, if any surface, must be
// closed by patching the emitter, not by extending this helper.

const PG_KEY_VALUE_RX = /\(([A-Za-z_][\w.]*)\)\s*=\s*\(([^)]*)\)/g;

// A digit run that looks like a phone number: optional `+`, then at least
// 8 digits total, with any number of spaces/dashes/dots/parens as separators.
// Anchored to a leading digit and a trailing digit so it does not greedily
// eat surrounding punctuation.
const PHONE_LIKE_RX = /\+?\d(?:[\s.\-()]*\d){7,14}/g;

/**
 * Scrub a free-text string of PII patterns.
 *
 * Returns the original text if no pattern matches. Never throws.
 * Empty / non-string inputs are returned untouched (typed at call site).
 */
export function scrubText(text: string): string {
  if (text.length === 0) return text;
  let out = text.replace(PG_KEY_VALUE_RX, '($1)=([REDACTED])');
  out = out.replace(PHONE_LIKE_RX, '[REDACTED]');
  return out;
}
