/**
 * Unit tests — middleware/correlation.ts (session 4 vague 3 / bloc 6).
 *
 * We prove:
 *   - Missing header → server generates a UUID and echoes it back
 *   - Valid header (UUID / ULID / short id) → server keeps it verbatim
 *   - Invalid header (spaces, angle brackets, over 64 chars) → discarded
 *     silently, fresh UUID generated (never rejects the request)
 *   - Response always carries X-Correlation-Id
 *   - Wired end-to-end through the Express app — the header is set on
 *     health responses too
 *   - `genReqId` (pino-http hook) mirrors the same policy
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { IncomingMessage } from 'node:http';
import {
  CORRELATION_HEADER,
  genReqId,
  readIncomingCorrelationId,
} from '../../src/middleware/correlation.js';
import { app } from '../../src/index.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fakeReq(headerValue: string | undefined): IncomingMessage {
  const headers: Record<string, string> = {};
  if (headerValue !== undefined) headers[CORRELATION_HEADER.toLowerCase()] = headerValue;
  return { headers } as unknown as IncomingMessage;
}

describe('readIncomingCorrelationId', () => {
  it('returns null when the header is absent', () => {
    expect(readIncomingCorrelationId(fakeReq(undefined))).toBeNull();
  });

  it('accepts a canonical UUID v4', () => {
    const uuid = '11111111-2222-4333-8444-555555555555';
    expect(readIncomingCorrelationId(fakeReq(uuid))).toBe(uuid);
  });

  it('accepts a short shell-safe correlation id (letters, digits, _, -)', () => {
    expect(readIncomingCorrelationId(fakeReq('req-abc_123'))).toBe('req-abc_123');
  });

  it('rejects a value containing spaces', () => {
    expect(readIncomingCorrelationId(fakeReq('has space'))).toBeNull();
  });

  it('rejects a value with control characters (log-line injection guard)', () => {
    expect(readIncomingCorrelationId(fakeReq('bad\nvalue'))).toBeNull();
    expect(readIncomingCorrelationId(fakeReq('bad\rvalue'))).toBeNull();
  });

  it('rejects a value with angle brackets or quotes', () => {
    expect(readIncomingCorrelationId(fakeReq('<script>'))).toBeNull();
    expect(readIncomingCorrelationId(fakeReq('"quoted"'))).toBeNull();
  });

  it('rejects a value exceeding 64 characters (matches DB CHECK constraint)', () => {
    expect(readIncomingCorrelationId(fakeReq('a'.repeat(65)))).toBeNull();
  });
});

describe('genReqId', () => {
  it('honours a valid incoming header', () => {
    const id = 'aaaa1111-2222-4333-8444-555555555555';
    expect(genReqId(fakeReq(id))).toBe(id);
  });

  it('generates a fresh UUID v4 when the incoming header is missing', () => {
    const generated = genReqId(fakeReq(undefined));
    expect(generated).toMatch(UUID_V4_REGEX);
  });

  it('generates a fresh UUID v4 when the incoming header is invalid', () => {
    const generated = genReqId(fakeReq('<bad>'));
    expect(generated).toMatch(UUID_V4_REGEX);
  });
});

// ---------------------------------------------------------------------------
// End-to-end wiring via Express
// ---------------------------------------------------------------------------

describe('correlation middleware — end to end', () => {
  it('sets a fresh X-Correlation-Id when the client does not send one', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    const header = res.header[CORRELATION_HEADER.toLowerCase()];
    expect(header).toBeTruthy();
    expect(header).toMatch(UUID_V4_REGEX);
  });

  it('echoes a valid X-Correlation-Id supplied by the client', async () => {
    const id = 'cid-e2e-001';
    const res = await request(app).get('/health').set(CORRELATION_HEADER, id);
    expect(res.status).toBe(200);
    expect(res.header[CORRELATION_HEADER.toLowerCase()]).toBe(id);
  });

  it('rejects an invalid X-Correlation-Id silently and generates a fresh one', async () => {
    const res = await request(app)
      .get('/health')
      .set(CORRELATION_HEADER, 'bad value with spaces');
    expect(res.status).toBe(200);
    const header = res.header[CORRELATION_HEADER.toLowerCase()];
    expect(header).not.toBe('bad value with spaces');
    expect(header).toMatch(UUID_V4_REGEX);
  });
});
