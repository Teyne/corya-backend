import { describe, expect, it } from 'vitest';
import { extractErrorInfo, toLogFields } from '../../src/utils/errors.js';

describe('structured error logging', () => {
  it('extracts Postgres fields and scrubs phone numbers', () => {
    const fields = toLogFields({
      name: 'PostgrestError', code: '23505',
      message: 'duplicate patient +41791234567',
      details: 'Key telephone=(079 123 45 67) already exists',
      hint: 'retry safely',
    });
    expect(fields.err_code).toBe('23505');
    expect(JSON.stringify(fields)).not.toContain('41791234567');
    expect(JSON.stringify(fields)).not.toContain('079 123 45 67');
  });

  it('includes only one cause level and tolerates primitives', () => {
    const root = new Error('root', { cause: new Error('inner', { cause: new Error('deep') }) });
    const info = extractErrorInfo(root);
    expect(info.cause?.message).toBe('inner');
    expect(info.cause?.cause).toBeUndefined();
    expect(extractErrorInfo(Symbol('boom')).message).toBe('boom');
  });
});
