/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method -- focused HTTP doubles */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetellCalcomToolDependencies } from '../../src/services/retell-calcom-tools.js';

vi.mock('../../src/services/retell.js', () => ({
  RETELL_SIGNATURE_HEADER: 'x-retell-signature',
  verifyRetellSignature: vi.fn(),
}));

const { buildRetellCalcomToolsRouter } = await import(
  '../../src/routes/retell-calcom-tools.js'
);
const { verifyRetellSignature } = await import('../../src/services/retell.js');
const { __resetRateLimitForTests } = await import('../../src/middleware/rate-limit.js');

const CABINET_ID = '11111111-1111-4111-8111-111111111111';
const dependencies: RetellCalcomToolDependencies = {
  findCabinet: vi.fn(async () => ({
    id: CABINET_ID,
    numero_corya: '+41215394609',
    email_notification: 'synthetic@example.invalid',
    email_notification_cc: null,
  })),
  availability: vi.fn(async () => [{
    start: '2026-09-10T10:00:00.000Z',
    end: '2026-09-10T10:30:00.000Z',
  }]),
  booking: vi.fn(async () => ({
    providerBookingUid: 'synthetic-booking-uid',
    status: 'accepted',
    start: '2026-09-10T10:00:00.000Z',
    end: '2026-09-10T10:30:00.000Z',
    eventTypeId: '6723841',
  })),
  claim: vi.fn(async () => ({
    outcome: 'claimed' as const,
    providerBookingUid: null,
    providerStatus: null,
    bookedStart: null,
    bookedEnd: null,
  })),
  complete: vi.fn(async () => true),
  uncertain: vi.fn(async () => true),
  leaseOwner: vi.fn(() => '22222222-2222-4222-8222-222222222222'),
};

function buildApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));
  app.use('/webhooks/retell/tools/calcom', buildRetellCalcomToolsRouter(dependencies));
  app.use((_error: unknown, _req: express.Request, res: express.Response) => {
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

function payload(name: string, args: Record<string, unknown>) {
  return {
    name,
    call: {
      call_id: 'call_synthetic_001',
      agent_id: 'agent_synthetic',
      call_type: 'phone_call',
      to_number: '+41215394609',
      transcript: 'synthetic transcript that must not be returned',
    },
    args,
  };
}

describe('Retell Cal.com custom-function routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it('rejects an invalid signature before tenant or provider access', async () => {
    vi.mocked(verifyRetellSignature).mockResolvedValue(false);
    const response = await request(buildApp())
      .post('/webhooks/retell/tools/calcom/availability')
      .set('x-retell-signature', 'synthetic-invalid')
      .send(payload('check_corya_availability', {
        start: '2026-09-10T00:00:00.000Z',
        end: '2026-09-11T00:00:00.000Z',
      }));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'invalid_signature' });
    expect(dependencies.findCabinet).not.toHaveBeenCalled();
    expect(dependencies.availability).not.toHaveBeenCalled();
  });

  it('returns only bounded availability fields for an authenticated request', async () => {
    vi.mocked(verifyRetellSignature).mockResolvedValue(true);
    const response = await request(buildApp())
      .post('/webhooks/retell/tools/calcom/availability')
      .set('x-retell-signature', 'synthetic-valid')
      .send(payload('check_corya_availability', {
        start: '2026-09-10T00:00:00.000Z',
        end: '2026-09-11T00:00:00.000Z',
      }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      available: true,
      slots: [{
        start: '2026-09-10T10:00:00.000Z',
        end: '2026-09-10T10:30:00.000Z',
      }],
      time_zone: 'Europe/Zurich',
    });
    expect(JSON.stringify(response.body)).not.toContain('transcript');
  });

  it('returns integration_not_ready for an unknown signed destination', async () => {
    vi.mocked(verifyRetellSignature).mockResolvedValue(true);
    vi.mocked(dependencies.findCabinet).mockResolvedValueOnce(null);
    const response = await request(buildApp())
      .post('/webhooks/retell/tools/calcom/booking')
      .set('x-retell-signature', 'synthetic-valid')
      .send(payload('book_corya_appointment', {
        start: '2026-09-10T10:00:00.000Z',
        attendee_name: 'Personne Fictive',
      }));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'integration_not_ready' });
    expect(dependencies.booking).not.toHaveBeenCalled();
  });
});
