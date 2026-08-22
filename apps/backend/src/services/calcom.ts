import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { persistCalcomBookingEvent } from '../db/queries.js';
import type {
  CalcomBookingEventInput,
  CalcomBookingEventResult,
} from '../types/index.js';

export const CALCOM_SIGNATURE_HEADER = 'x-cal-signature-256';

const triggerSchema = z.enum([
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
  'BOOKING_REJECTED',
]);

const bookingPayloadSchema = z.object({
  uid: z.string().min(1).max(200),
  rescheduleUid: z.string().min(1).max(200).nullish(),
  eventTypeId: z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/u)]),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
}).passthrough();

const webhookSchema = z.object({
  triggerEvent: triggerSchema,
  createdAt: z.string().datetime({ offset: true }),
  payload: bookingPayloadSchema,
}).passthrough();

export function verifyCalcomSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature as string, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function parseCalcomBookingEvent(
  rawBody: Buffer,
  body: unknown,
): CalcomBookingEventInput {
  const parsed = webhookSchema.parse(body);
  return {
    eventKey: createHash('sha256').update(rawBody).digest('hex'),
    triggerEvent: parsed.triggerEvent,
    providerCreatedAt: new Date(parsed.createdAt).toISOString(),
    providerBookingUid: parsed.payload.uid,
    rescheduleUid: parsed.payload.rescheduleUid ?? null,
    eventTypeId: String(parsed.payload.eventTypeId),
    startAt: new Date(parsed.payload.startTime).toISOString(),
    endAt: new Date(parsed.payload.endTime).toISOString(),
  };
}

export async function processCalcomBookingEvent(
  input: CalcomBookingEventInput,
): Promise<CalcomBookingEventResult> {
  return persistCalcomBookingEvent(input);
}
