import { z } from 'zod';
import { env } from '../config/env.js';
import { withTimeout } from '../utils/timeout.js';

const CALCOM_API_BASE_URL = 'https://api.cal.com';
const SLOTS_API_VERSION = '2024-09-04';
const BOOKINGS_API_VERSION = '2026-02-25';

const MAX_SAFE_EVENT_TYPE_ID = BigInt(Number.MAX_SAFE_INTEGER);
const eventTypeIdSchema = z.string()
  .regex(/^\d{1,20}$/u)
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_SAFE_EVENT_TYPE_ID;
  });
const isoDateTimeSchema = z.string().datetime({ offset: true });

const slotSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema.optional(),
}).passthrough();

const slotsResponseSchema = z.object({
  status: z.literal('success'),
  data: z.record(z.string(), z.array(slotSchema)),
}).passthrough();

const bookingResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    uid: z.string().min(1).max(200),
    status: z.string().min(1).max(40),
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    eventTypeId: z.number().int().positive(),
  }).passthrough(),
}).passthrough();

export interface CalcomSlot {
  start: string;
  end: string | null;
}

export interface CalcomAvailabilityInput {
  accessToken: string;
  eventTypeId: string;
  start: string;
  end: string;
  timeZone?: 'Europe/Zurich';
}

export interface CalcomBookingInput {
  accessToken: string;
  eventTypeId: string;
  start: string;
  attendee: {
    name: string;
    email: string;
    timeZone?: 'Europe/Zurich';
    phoneNumber?: string;
  };
}

export interface CalcomBookingResult {
  providerBookingUid: string;
  status: string;
  start: string;
  end: string;
  eventTypeId: string;
}

export class CalcomApiError extends Error {
  public readonly operation: 'availability' | 'booking';
  public readonly statusCode: number | null;
  public readonly transient: boolean;

  constructor(
    operation: 'availability' | 'booking',
    statusCode: number | null,
    transient: boolean,
  ) {
    super(`calcom_${operation}_failed`);
    this.name = 'CalcomApiError';
    this.operation = operation;
    this.statusCode = statusCode;
    this.transient = transient;
  }
}

type FetchLike = typeof fetch;
let fetchImplementation: FetchLike = globalThis.fetch;

/** Test-only seam. Tests must never contact Cal.com. */
export function __setCalcomFetchForTests(value: FetchLike | null): void {
  fetchImplementation = value ?? globalThis.fetch;
}

function authHeaders(accessToken: string, apiVersion: string): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'cal-api-version': apiVersion,
  };
}

function validateWindow(start: string, end: string): void {
  const parsedStart = isoDateTimeSchema.safeParse(start);
  const parsedEnd = isoDateTimeSchema.safeParse(end);
  if (
    !parsedStart.success ||
    !parsedEnd.success ||
    Date.parse(parsedEnd.data) <= Date.parse(parsedStart.data)
  ) {
    throw new CalcomApiError('availability', null, false);
  }
}

async function fetchJson(
  operation: 'availability' | 'booking',
  url: URL,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  let response: Response;
  try {
    response = await withTimeout(
      fetchImplementation(url, { ...init, signal: controller.signal }),
      env.TIMEOUT_CALCOM_MS,
      `calcom:${operation}`,
      { signal: controller },
    );
  } catch (error: unknown) {
    if (error instanceof CalcomApiError) throw error;
    throw new CalcomApiError(operation, null, true);
  }

  if (!response.ok) {
    // Never read or reproduce the provider body: it may contain attendee data.
    throw new CalcomApiError(
      operation,
      response.status,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new CalcomApiError(operation, response.status, false);
  }
}

export async function getCalcomAvailability(
  input: CalcomAvailabilityInput,
): Promise<CalcomSlot[]> {
  const eventTypeId = eventTypeIdSchema.safeParse(input.eventTypeId);
  if (!eventTypeId.success || input.accessToken.length === 0) {
    throw new CalcomApiError('availability', null, false);
  }
  validateWindow(input.start, input.end);

  const url = new URL('/v2/slots', CALCOM_API_BASE_URL);
  url.searchParams.set('eventTypeId', eventTypeId.data);
  url.searchParams.set('start', input.start);
  url.searchParams.set('end', input.end);
  url.searchParams.set('timeZone', input.timeZone ?? 'Europe/Zurich');
  url.searchParams.set('format', 'range');

  const payload = slotsResponseSchema.safeParse(await fetchJson(
    'availability',
    url,
    { method: 'GET', headers: authHeaders(input.accessToken, SLOTS_API_VERSION) },
  ));
  if (!payload.success) throw new CalcomApiError('availability', 200, false);

  const slots = Object.values(payload.data.data)
    .flat()
    .map((slot) => ({ start: slot.start, end: slot.end ?? null }))
    .sort((left, right) => left.start.localeCompare(right.start));

  // Bound provider output before it reaches an LLM or a response payload.
  return slots.slice(0, 100);
}

export async function createCalcomBooking(
  input: CalcomBookingInput,
): Promise<CalcomBookingResult> {
  const eventTypeId = eventTypeIdSchema.safeParse(input.eventTypeId);
  const start = isoDateTimeSchema.safeParse(input.start);
  const attendee = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().email().max(254),
    timeZone: z.literal('Europe/Zurich').optional(),
    phoneNumber: z.string().trim().min(8).max(24).optional(),
  }).strict().safeParse(input.attendee);
  if (!eventTypeId.success || !start.success || !attendee.success || input.accessToken.length === 0) {
    throw new CalcomApiError('booking', null, false);
  }

  const payload = bookingResponseSchema.safeParse(await fetchJson(
    'booking',
    new URL('/v2/bookings', CALCOM_API_BASE_URL),
    {
      method: 'POST',
      headers: {
        ...authHeaders(input.accessToken, BOOKINGS_API_VERSION),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        start: start.data,
        eventTypeId: Number(eventTypeId.data),
        attendee: {
          ...attendee.data,
          timeZone: attendee.data.timeZone ?? 'Europe/Zurich',
          language: 'fr',
        },
      }),
    },
  ));
  if (!payload.success) throw new CalcomApiError('booking', 200, false);

  return {
    providerBookingUid: payload.data.data.uid,
    status: payload.data.data.status,
    start: payload.data.data.start,
    end: payload.data.data.end,
    eventTypeId: String(payload.data.data.eventTypeId),
  };
}
