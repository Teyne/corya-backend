import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setCalcomFetchForTests,
  createCalcomBooking,
  getCalcomAvailability,
} from '../../src/services/calcom-api.js';

afterEach(() => {
  __setCalcomFetchForTests(null);
});

describe('Cal.com API boundary', () => {
  it('returns a sorted and reduced availability allowlist', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'success',
      data: {
        '2026-09-02': [{ start: '2026-09-02T14:00:00.000+02:00', end: '2026-09-02T14:30:00.000+02:00', attendee: 'PII-SENTINEL' }],
        '2026-09-01': [{ start: '2026-09-01T09:00:00.000+02:00', end: '2026-09-01T09:30:00.000+02:00' }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    __setCalcomFetchForTests(fetchMock);

    const result = await getCalcomAvailability({
      accessToken: 'synthetic-token',
      eventTypeId: '6723841',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-03T00:00:00.000Z',
    });

    expect(result).toEqual([
      { start: '2026-09-01T09:00:00.000+02:00', end: '2026-09-01T09:30:00.000+02:00' },
      { start: '2026-09-02T14:00:00.000+02:00', end: '2026-09-02T14:30:00.000+02:00' },
    ]);
    expect(JSON.stringify(result)).not.toContain('PII-SENTINEL');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error('expected_url');
    expect(url.searchParams.get('timeZone')).toBe('Europe/Zurich');
    expect(new Headers(init?.headers).get('cal-api-version')).toBe('2024-09-04');
  });

  it('returns only the booking technical allowlist', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'success',
      data: {
        uid: 'booking-uid',
        status: 'accepted',
        start: '2026-09-01T09:00:00.000Z',
        end: '2026-09-01T09:30:00.000Z',
        eventTypeId: 6723841,
        attendees: [{ name: 'PII-SENTINEL', email: 'pii@example.invalid' }],
      },
    }), { status: 201 }));
    __setCalcomFetchForTests(fetchMock);

    const result = await createCalcomBooking({
      accessToken: 'synthetic-token',
      eventTypeId: '6723841',
      start: '2026-09-01T09:00:00.000Z',
      attendee: { name: 'Test Fictif', email: 'test@example.invalid' },
    });

    expect(result).toEqual({
      providerBookingUid: 'booking-uid',
      status: 'accepted',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T09:30:00.000Z',
      eventTypeId: '6723841',
    });
    expect(JSON.stringify(result)).not.toContain('PII-SENTINEL');
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('cal-api-version')).toBe('2026-02-25');
  });

  it('classifies provider failures without reading or reproducing their body', async () => {
    const text = vi.fn().mockResolvedValue('PII-SENTINEL-PROVIDER-BODY');
    const response = new Response(null, { status: 429 });
    Object.defineProperty(response, 'text', { value: text });
    __setCalcomFetchForTests(vi.fn<typeof fetch>().mockResolvedValue(response));

    const promise = getCalcomAvailability({
      accessToken: 'synthetic-token',
      eventTypeId: '6723841',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-03T00:00:00.000Z',
    });

    await expect(promise).rejects.toMatchObject({
      name: 'CalcomApiError',
      statusCode: 429,
      transient: true,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('rejects invalid windows before any network call', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    __setCalcomFetchForTests(fetchMock);

    await expect(getCalcomAvailability({
      accessToken: 'synthetic-token',
      eventTypeId: '6723841',
      start: '2026-09-03T00:00:00.000Z',
      end: '2026-09-01T00:00:00.000Z',
    })).rejects.toMatchObject({ transient: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['availability', '99999999999999999999'],
    ['booking', '99999999999999999999'],
  ])('rejects an unsafe 20-digit event type id before %s network I/O', async (
    operation,
    eventTypeId,
  ) => {
    const fetchMock = vi.fn<typeof fetch>();
    __setCalcomFetchForTests(fetchMock);

    const promise = operation === 'availability'
      ? getCalcomAvailability({
        accessToken: 'synthetic-token',
        eventTypeId,
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-03T00:00:00.000Z',
      })
      : createCalcomBooking({
        accessToken: 'synthetic-token',
        eventTypeId,
        start: '2026-09-01T09:00:00.000Z',
        attendee: { name: 'Test Fictif', email: 'test@example.invalid' },
      });

    await expect(promise).rejects.toMatchObject({ transient: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
