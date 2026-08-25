import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  claimCalendarBookingCommand,
  completeCalendarBookingCommand,
  findCabinetByCoryaNumber,
  markCalendarBookingCommandUncertain,
  type CalendarBookingCommandClaim,
  type CabinetRow,
} from '../db/queries.js';
import { normalizeSwissPhoneNumber } from '../utils/phone.js';
import {
  createTenantCalcomBooking,
  getTenantCalcomAvailability,
} from './calcom-runtime.js';
import type { CalcomBookingResult, CalcomSlot } from './calcom-api.js';

const isoDateTimeSchema = z.string().datetime({ offset: true });
const functionCallSchema = z.object({
  call_id: z.string().min(1).max(200),
  agent_id: z.string().min(1).max(200),
  call_type: z.enum(['phone_call', 'web_call']),
  to_number: z.string().min(4).max(32),
}).passthrough();

const availabilityRequestSchema = z.object({
  name: z.enum(['check_corya_availability', 'check_corya_demo_availability']),
  call: functionCallSchema,
  args: z.object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    time_zone: z.literal('Europe/Zurich').optional(),
  }).strict(),
}).passthrough();

const bookingRequestSchema = z.object({
  name: z.enum(['book_corya_appointment', 'book_corya_demo_appointment']),
  call: functionCallSchema,
  args: z.object({
    start: isoDateTimeSchema,
    attendee_name: z.string().trim().min(1).max(120),
    attendee_phone: z.string().trim().min(8).max(24).optional(),
  }).strict(),
}).passthrough();

export interface RetellCalcomToolDependencies {
  findCabinet(toNumber: string): Promise<CabinetRow | null>;
  availability(
    cabinetId: string,
    input: { start: string; end: string; timeZone: 'Europe/Zurich' },
  ): Promise<CalcomSlot[]>;
  booking(
    cabinetId: string,
    input: {
      start: string;
      attendee: {
        name: string;
        email: string;
        timeZone: 'Europe/Zurich';
        phoneNumber?: string;
      };
    },
  ): Promise<CalcomBookingResult>;
  claim(input: {
    commandKey: string;
    cabinetId: string;
    requestedStart: string;
    leaseOwner: string;
  }): Promise<CalendarBookingCommandClaim>;
  complete(input: {
    commandKey: string;
    leaseOwner: string;
    providerBookingUid: string;
    providerStatus: string;
    bookedStart: string;
    bookedEnd: string;
  }): Promise<boolean>;
  uncertain(input: { commandKey: string; leaseOwner: string }): Promise<boolean>;
  leaseOwner(): string;
}

export const defaultRetellCalcomToolDependencies: RetellCalcomToolDependencies = {
  findCabinet: findCabinetByCoryaNumber,
  availability: getTenantCalcomAvailability,
  booking: createTenantCalcomBooking,
  claim: claimCalendarBookingCommand,
  complete: completeCalendarBookingCommand,
  uncertain: markCalendarBookingCommandUncertain,
  leaseOwner: randomUUID,
};

export class RetellCalcomToolValidationError extends Error {
  constructor() {
    super('retell_calcom_tool_invalid');
    this.name = 'RetellCalcomToolValidationError';
  }
}

export class RetellCalcomToolUnavailableError extends Error {
  constructor() {
    super('retell_calcom_tool_unavailable');
    this.name = 'RetellCalcomToolUnavailableError';
  }
}

function validWindow(start: string, end: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

function commandKey(cabinetId: string, callId: string, start: string): string {
  return createHash('sha256')
    .update(`${cabinetId}\n${callId}\n${start}`, 'utf8')
    .digest('hex');
}

async function resolveCabinet(
  toNumber: string,
  dependencies: RetellCalcomToolDependencies,
): Promise<CabinetRow> {
  const cabinet = await dependencies.findCabinet(toNumber);
  if (!cabinet) throw new RetellCalcomToolUnavailableError();
  return cabinet;
}

export async function runRetellCalcomAvailability(
  input: unknown,
  dependencies: RetellCalcomToolDependencies = defaultRetellCalcomToolDependencies,
): Promise<{ available: boolean; slots: CalcomSlot[]; time_zone: 'Europe/Zurich' }> {
  const parsed = availabilityRequestSchema.safeParse(input);
  if (!parsed.success || !validWindow(parsed.data.args.start, parsed.data.args.end)) {
    throw new RetellCalcomToolValidationError();
  }
  const cabinet = await resolveCabinet(parsed.data.call.to_number, dependencies);
  const slots = await dependencies.availability(cabinet.id, {
    start: parsed.data.args.start,
    end: parsed.data.args.end,
    timeZone: 'Europe/Zurich',
  });
  const bounded = slots.slice(0, 6);
  return { available: bounded.length > 0, slots: bounded, time_zone: 'Europe/Zurich' };
}

export async function runRetellCalcomBooking(
  input: unknown,
  dependencies: RetellCalcomToolDependencies = defaultRetellCalcomToolDependencies,
): Promise<
  | { success: true; status: string; start: string; end: string; replayed: boolean }
  | { success: false; outcome: 'unconfirmed' }
> {
  const parsed = bookingRequestSchema.safeParse(input);
  if (!parsed.success) throw new RetellCalcomToolValidationError();
  const phone = parsed.data.args.attendee_phone === undefined
    ? undefined
    : normalizeSwissPhoneNumber(parsed.data.args.attendee_phone);
  if (parsed.data.args.attendee_phone !== undefined && phone === null) {
    throw new RetellCalcomToolValidationError();
  }

  const cabinet = await resolveCabinet(parsed.data.call.to_number, dependencies);
  const key = commandKey(cabinet.id, parsed.data.call.call_id, parsed.data.args.start);
  const leaseOwner = dependencies.leaseOwner();
  const claim = await dependencies.claim({
    commandKey: key,
    cabinetId: cabinet.id,
    requestedStart: parsed.data.args.start,
    leaseOwner,
  });

  if (claim.outcome === 'replay') {
    if (
      claim.providerStatus === null
      || claim.bookedStart === null
      || claim.bookedEnd === null
    ) return { success: false, outcome: 'unconfirmed' };
    return {
      success: true,
      status: claim.providerStatus,
      start: claim.bookedStart,
      end: claim.bookedEnd,
      replayed: true,
    };
  }
  if (claim.outcome !== 'claimed') return { success: false, outcome: 'unconfirmed' };

  try {
    const result = await dependencies.booking(cabinet.id, {
      start: parsed.data.args.start,
      attendee: {
        name: parsed.data.args.attendee_name,
        email: 'no-reply@corya.ch',
        timeZone: 'Europe/Zurich',
        ...(phone ? { phoneNumber: phone } : {}),
      },
    });
    const completed = await dependencies.complete({
      commandKey: key,
      leaseOwner,
      providerBookingUid: result.providerBookingUid,
      providerStatus: result.status,
      bookedStart: result.start,
      bookedEnd: result.end,
    });
    if (!completed) {
      try {
        await dependencies.uncertain({ commandKey: key, leaseOwner });
      } catch {
        // The command remains fail-closed even if the uncertainty marker fails.
      }
      return { success: false, outcome: 'unconfirmed' };
    }
    return {
      success: true,
      status: result.status,
      start: result.start,
      end: result.end,
      replayed: false,
    };
  } catch {
    try {
      await dependencies.uncertain({ commandKey: key, leaseOwner });
    } catch {
      // The public result stays constant and never contains provider details.
    }
    return { success: false, outcome: 'unconfirmed' };
  }
}
