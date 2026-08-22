import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type * as CalcomModule from '../../src/services/calcom.js';

const processMock = vi.fn();
vi.mock('../../src/services/calcom.js', async () => {
  const actual = await vi.importActual<typeof CalcomModule>(
    '../../src/services/calcom.js',
  );
  return { ...actual, processCalcomBookingEvent: processMock };
});
vi.mock('retell-sdk', () => ({ verify: vi.fn() }));

const { app } = await import('../../src/index.js');
const { env } = await import('../../src/config/env.js');
const { __resetRateLimitForTests } = await import('../../src/middleware/rate-limit.js');

const body = {
  triggerEvent: 'BOOKING_CREATED',
  createdAt: '2026-08-22T17:00:00.000Z',
  payload: {
    uid: 'booking-technical-uid',
    eventTypeId: 6723841,
    startTime: '2026-08-24T08:00:00.000Z',
    endTime: '2026-08-24T08:30:00.000Z',
    name: 'PII-SENTINEL-NAME',
    email: 'pii-sentinel@example.invalid',
  },
};

function sign(raw: string): string {
  return createHmac('sha256', env.CALCOM_WEBHOOK_SECRET as string)
    .update(raw)
    .digest('hex');
}

beforeEach(() => {
  __resetRateLimitForTests();
  processMock.mockReset().mockResolvedValue({
    bookingId: 'booking-id',
    cabinetId: 'cabinet-id',
    sourceAppelId: null,
    outcome: 'applied',
  });
});

describe('POST /webhooks/calcom/booking', () => {
  it('rejects an absent or invalid signature without touching persistence', async () => {
    const raw = JSON.stringify(body);
    const absent = await request(app)
      .post('/webhooks/calcom/booking')
      .set('Content-Type', 'application/json')
      .send(raw);
    const invalid = await request(app)
      .post('/webhooks/calcom/booking')
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', '0'.repeat(64))
      .send(raw);

    expect(absent.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it('persists one authenticated allowlisted event and acknowledges it', async () => {
    const raw = JSON.stringify(body);
    const response = await request(app)
      .post('/webhooks/calcom/booking')
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', sign(raw))
      .send(raw);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: 'applied' });
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(processMock.mock.calls[0]?.[0])).not.toContain('PII-SENTINEL');
  });

  it('acknowledges an authenticated malformed payload without persistence', async () => {
    const malformed = JSON.stringify({ triggerEvent: 'BOOKING_CREATED' });
    const response = await request(app)
      .post('/webhooks/calcom/booking')
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', sign(malformed))
      .send(malformed);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(processMock).not.toHaveBeenCalled();
  });

  it('returns 500 on a bounded persistence failure so Cal.com can retry', async () => {
    processMock.mockRejectedValueOnce(new Error('synthetic-persistence-failure'));
    const raw = JSON.stringify(body);
    const response = await request(app)
      .post('/webhooks/calcom/booking')
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', sign(raw))
      .send(raw);

    expect(response.status).toBe(500);
  });
});
