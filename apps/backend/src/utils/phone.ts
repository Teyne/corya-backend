/**
 * Conservatively normalize a Swiss callback number to E.164.
 *
 * Accepted input forms:
 *   - +41 followed by the 9-digit national significant number
 *   - 0041 followed by the same 9 digits
 *   - 0 followed by the same 9 digits
 *
 * Only common Swiss geographic, corporate-network and mobile prefixes are
 * accepted. Free text, extensions and foreign/unprefixed numbers fail closed.
 */

const ALLOWED_PHONE_CHARS = /^\+?[\d\s().-]+$/;
const SWISS_NATIONAL_NUMBER =
  /^(?:2[12467]|3[1-4]|4[134]|5[12568]|6[12]|7[156-9]|8[01]|9[01])\d{7}$/;

export function normalizeSwissPhoneNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0 || !ALLOWED_PHONE_CHARS.test(trimmed)) return null;

  const compact = trimmed.replace(/[\s().-]/g, '');
  let nationalNumber: string;

  if (compact.startsWith('+41')) {
    nationalNumber = compact.slice(3);
  } else if (compact.startsWith('0041')) {
    nationalNumber = compact.slice(4);
  } else if (compact.startsWith('0')) {
    nationalNumber = compact.slice(1);
  } else {
    return null;
  }

  if (!SWISS_NATIONAL_NUMBER.test(nationalNumber)) return null;
  return `+41${nationalNumber}`;
}
