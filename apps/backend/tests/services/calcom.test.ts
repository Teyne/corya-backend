import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistMock = vi.fn();
vi.mock('../../src/db/queries.js', () => ({
  persistCalcomBookingEvent: persistMock,
}));

const {
  parseCalcomBookingEvent,
  processCalcomBookingEvent,
  verifyCalcomSignature,
} = await import('../../src/services/calcom.js');

const secret = 'synthetic-calcom-secret-with-32-characters';
const payload = {
  triggerEvent: 'BOOKING_CREATED',
  createdAt: '2026-08-22T17:00:00.000Z',
  payload: {
    uid: 'booking-technical-uid',
    eventTypeId: 6723841,
    startTime: '2026-08-24T08:00:00.000Z',
    endTime: '2026-08-24T08:30:00.000Z',
    name: 'PII-SENTINEL-NAME',
    email: 'pii-sentinel@example.invalid',
    responses: { notes: 'PII-SENTINEL-NOTES' },
  },
};

beforeEach(() => {
  persistMock.mockReset();
});

describe('Cal.com webhook security boundary', () => {
  it('accepts only the exact HMAC-SHA256 of the raw body', () => {
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', secret).update(raw).digest('hex');

    expect(verifyCalcomSignature(raw, signature, secret)).toBe(true);
    expect(verifyCalcomSignature(raw, '0'.repeat(64), secret)).toBe(false);
    expect(verifyCalcomSignature(raw, undefined, secret)).toBe(false);
    expect(verifyCalcomSignature(raw, 'not-hex', secret)).toBe(false);
  });

  it('reduces an authenticated body to the PII-free allowlist', () => {
    const raw = Buffer.from(JSON.stringify(payload));
    const parsed = parseCalcomBookingEvent(raw, payload);

    expect(parsed.eventKey).toMatch(/^[0-9a-f]{64}$/u);
    expect({ ...parsed, eventKey: undefined }).toEqual({
      eventKey: undefined,
      triggerEvent: 'BOOKING_CREATED',
      providerCreatedAt: '2026-08-22T17:00:00.000Z',
      providerBookingUid: 'booking-technical-uid',
      rescheduleUid: null,
      eventTypeId: '6723841',
      startAt: '2026-08-24T08:00:00.000Z',
      endAt: '2026-08-24T08:30:00.000Z',
    });
    expect(JSON.stringify(parsed)).not.toContain('PII-SENTINEL');
  });

  it('rejects unsupported triggers and malformed intervals before persistence', () => {
    const unsupported = { ...payload, triggerEvent: 'BOOKING_PAID' };
    expect(() => parseCalcomBookingEvent(Buffer.from('{}'), unsupported)).toThrow();

    const malformed = {
      ...payload,
      payload: { ...payload.payload, startTime: 'not-a-date' },
    };
    expect(() => parseCalcomBookingEvent(Buffer.from('{}'), malformed)).toThrow();
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('delegates only the reduced event to the bounded database wrapper', async () => {
    const raw = Buffer.from(JSON.stringify(payload));
    const parsed = parseCalcomBookingEvent(raw, payload);
    persistMock.mockResolvedValue({
      bookingId: 'booking-id',
      cabinetId: 'cabinet-id',
      sourceAppelId: null,
      outcome: 'applied',
    });

    await expect(processCalcomBookingEvent(parsed)).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(persistMock).toHaveBeenCalledWith(parsed);
  });
});
