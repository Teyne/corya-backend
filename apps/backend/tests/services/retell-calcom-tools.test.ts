/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await -- focused in-memory doubles */
import { describe, expect, it, vi } from 'vitest';
import {
  runRetellCalcomAvailability,
  runRetellCalcomBooking,
  type RetellCalcomToolDependencies,
} from '../../src/services/retell-calcom-tools.js';

const CABINET_ID = '11111111-1111-4111-8111-111111111111';

function dependencies(): RetellCalcomToolDependencies {
  return {
    findCabinet: vi.fn(async () => ({
      id: CABINET_ID,
      numero_corya: '+41215394609',
      email_notification: 'synthetic@example.invalid',
      email_notification_cc: null,
    })),
    availability: vi.fn(async () => [
      { start: '2026-09-10T10:00:00.000Z', end: '2026-09-10T10:30:00.000Z' },
    ]),
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
}

function call(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    name,
    call: {
      call_id: 'call_synthetic_001',
      agent_id: 'agent_synthetic',
      call_type: 'phone_call',
      to_number: '+41215394609',
      transcript: 'must never be persisted or logged',
    },
    args,
  };
}

describe('Retell tenant Cal.com tools', () => {
  it('resolves the tenant only from the signed call destination', async () => {
    const deps = dependencies();
    await expect(runRetellCalcomAvailability(call('check_corya_availability', {
      start: '2026-09-10T00:00:00.000Z',
      end: '2026-09-11T00:00:00.000Z',
    }), deps)).resolves.toEqual({
      available: true,
      slots: [{ start: '2026-09-10T10:00:00.000Z', end: '2026-09-10T10:30:00.000Z' }],
      time_zone: 'Europe/Zurich',
    });
    expect(deps.findCabinet).toHaveBeenCalledWith('+41215394609');
    expect(deps.availability).toHaveBeenCalledWith(CABINET_ID, expect.objectContaining({
      timeZone: 'Europe/Zurich',
    }));
  });

  it('uses the Corya no-reply address and normalizes the optional Swiss phone', async () => {
    const deps = dependencies();
    await expect(runRetellCalcomBooking(call('book_corya_appointment', {
      start: '2026-09-10T10:00:00.000Z',
      attendee_name: 'Personne Fictive',
      attendee_phone: '078 400 16 80',
    }), deps)).resolves.toMatchObject({ success: true, replayed: false });
    expect(deps.booking).toHaveBeenCalledWith(CABINET_ID, {
      start: '2026-09-10T10:00:00.000Z',
      attendee: {
        name: 'Personne Fictive',
        email: 'no-reply@corya.ch',
        timeZone: 'Europe/Zurich',
        phoneNumber: '+41784001680',
      },
    });
  });

  it('replays a completed command without a second provider write', async () => {
    const deps = dependencies();
    vi.mocked(deps.claim).mockResolvedValue({
      outcome: 'replay',
      providerBookingUid: 'synthetic-booking-uid',
      providerStatus: 'accepted',
      bookedStart: '2026-09-10T10:00:00.000Z',
      bookedEnd: '2026-09-10T10:30:00.000Z',
    });
    await expect(runRetellCalcomBooking(call('book_corya_appointment', {
      start: '2026-09-10T10:00:00.000Z',
      attendee_name: 'Personne Fictive',
    }), deps)).resolves.toMatchObject({ success: true, replayed: true });
    expect(deps.booking).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('fails closed after an uncertain provider outcome and never retries automatically', async () => {
    const deps = dependencies();
    vi.mocked(deps.booking).mockRejectedValue(new Error('synthetic_provider_timeout'));
    await expect(runRetellCalcomBooking(call('book_corya_appointment', {
      start: '2026-09-10T10:00:00.000Z',
      attendee_name: 'Personne Fictive',
    }), deps)).resolves.toEqual({ success: false, outcome: 'unconfirmed' });
    expect(deps.uncertain).toHaveBeenCalledTimes(1);

    vi.mocked(deps.claim).mockResolvedValue({
      outcome: 'uncertain',
      providerBookingUid: null,
      providerStatus: null,
      bookedStart: null,
      bookedEnd: null,
    });
    await runRetellCalcomBooking(call('book_corya_appointment', {
      start: '2026-09-10T10:00:00.000Z',
      attendee_name: 'Personne Fictive',
    }), deps);
    expect(deps.booking).toHaveBeenCalledTimes(1);
  });

  it('marks the command uncertain when the provider succeeds but the checkpoint cannot complete', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockResolvedValue(false);
    await expect(runRetellCalcomBooking(call('book_corya_appointment', {
      start: '2026-09-10T10:00:00.000Z',
      attendee_name: 'Personne Fictive',
    }), deps)).resolves.toEqual({ success: false, outcome: 'unconfirmed' });
    expect(deps.booking).toHaveBeenCalledTimes(1);
    expect(deps.uncertain).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid phones and web calls without a real destination', async () => {
    const deps = dependencies();
    await expect(runRetellCalcomBooking(call('book_corya_appointment', {
      start: '2026-09-10T10:00:00.000Z',
      attendee_name: 'Personne Fictive',
      attendee_phone: '+33123456789',
    }), deps)).rejects.toThrow('retell_calcom_tool_invalid');
    expect(deps.booking).not.toHaveBeenCalled();
  });
});
