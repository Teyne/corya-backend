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
