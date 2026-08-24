import { describe, expect, it } from 'vitest';
import { normalizeSwissPhoneNumber } from '../../src/utils/phone.js';

describe('normalizeSwissPhoneNumber', () => {
  it.each([
    ['+41 78 400 16 80', '+41784001680'],
    ['0041 78 400 16 80', '+41784001680'],
    ['078 400 16 80', '+41784001680'],
    ['+41 (21) 539-46-09', '+41215394609'],
    ['032 552 00 40', '+41325520040'],
  ])('normalizes the common Swiss format %s', (input, expected) => {
    expect(normalizeSwissPhoneNumber(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    'appelez-moi au 078 400 16 80',
    '078 400 16 80 poste 12',
    '+33123456789',
    '+4178400168',
    '+417840016800',
    '+410784001680',
    '41784001680',
    '0112345678',
  ])('rejects invalid or untrusted input %s', (input) => {
    expect(normalizeSwissPhoneNumber(input)).toBeNull();
  });
});
