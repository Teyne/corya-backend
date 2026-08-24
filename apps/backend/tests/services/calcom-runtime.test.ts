/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await -- test doubles are intentionally immediate. */
import { describe, expect, it, vi } from 'vitest';
import {
  createTenantCalcomBooking,
  getTenantCalcomAvailability,
  listTenantCalcomEventTypes,
  selectTenantCalcomEventType,
  type CalcomRuntimeDependencies,
} from '../../src/services/calcom-runtime.js';

const CABINET_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';

function dependencies(): CalcomRuntimeDependencies {
  return {
    status: vi.fn(async () => ({
      connectionId: '33333333-3333-4333-8333-333333333333',
      status: 'connected' as const,
      eventTypeId: '6723841',
      eventTypeTitle: 'Consultation test',
      eventTypeLengthMinutes: 30,
      configuredScopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      grantedScopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      accessTokenExpiresAt: '2026-09-01T12:30:00.000Z',
      connectedAt: '2026-09-01T12:00:00.000Z',
      lastRefreshedAt: null,
      errorCode: null,
      demonstrationMode: false,
      runtimeReady: true,
    })),
    accessToken: vi.fn(async () => ({ accessToken: 'synthetic-token' })),
    eventTypes: vi.fn(async () => [{
      id: '6723841', title: 'Consultation test', slug: 'consultation-test', lengthMinutes: 30,
    }]),
    availability: vi.fn(async () => []),
    booking: vi.fn(async () => ({
      providerBookingUid: 'booking-id', status: 'accepted',
      start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:30:00.000Z',
      eventTypeId: '6723841',
    })),
    select: vi.fn(async () => true),
    disconnect: vi.fn(async () => true),
  };
}

describe('tenant-bound Cal.com runtime', () => {
  it('always uses the selected tenant event type for availability and booking', async () => {
    const deps = dependencies();
    await getTenantCalcomAvailability(CABINET_ID, {
      start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z',
    }, deps);
    await createTenantCalcomBooking(CABINET_ID, {
      start: '2026-09-01T09:00:00.000Z',
      attendee: { name: 'Test Fictif', email: 'test@example.invalid' },
    }, deps);

    expect(deps.status).toHaveBeenCalledWith(CABINET_ID);
    expect(deps.availability).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'synthetic-token', eventTypeId: '6723841',
    }));
    expect(deps.booking).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'synthetic-token', eventTypeId: '6723841',
    }));
  });

  it('fails before credentials or provider I/O when no event type is selected', async () => {
    const deps = dependencies();
    vi.mocked(deps.status).mockResolvedValue({
      ...(await deps.status(CABINET_ID))!, eventTypeId: null, runtimeReady: false,
    });

    await expect(getTenantCalcomAvailability(CABINET_ID, {
      start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z',
    }, deps)).rejects.toThrow('calcom_runtime_unavailable');
    expect(deps.accessToken).not.toHaveBeenCalled();
    expect(deps.availability).not.toHaveBeenCalled();
  });

  it('lists before selection and persists only an event type owned by the token account', async () => {
    const deps = dependencies();
    await expect(listTenantCalcomEventTypes(CABINET_ID, deps)).resolves.toHaveLength(1);
    await selectTenantCalcomEventType(CABINET_ID, ACTOR_ID, '6723841', deps);

    expect(deps.select).toHaveBeenCalledWith({
      cabinetId: CABINET_ID,
      actorUserId: ACTOR_ID,
      eventTypeId: '6723841',
      title: 'Consultation test',
      lengthMinutes: 30,
    });
    await expect(selectTenantCalcomEventType(
      CABINET_ID, ACTOR_ID, '9999999', deps,
    )).rejects.toThrow('calcom_runtime_unavailable');
  });
});
