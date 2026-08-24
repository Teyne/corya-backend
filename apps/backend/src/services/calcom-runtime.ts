import {
  disconnectCalcomOAuthConnection,
  getCalcomConnectionStatus,
  setCalcomEventType,
  type CalcomConnectionStatus,
} from '../db/queries.js';
import {
  createCalcomBooking,
  getCalcomAvailability,
  listCalcomEventTypes,
  type CalcomAvailabilityInput,
  type CalcomBookingInput,
  type CalcomBookingResult,
  type CalcomEventType,
  type CalcomSlot,
} from './calcom-api.js';
import { resolveFreshCalcomCredential } from './calcom-credentials.js';

export interface CalcomRuntimeDependencies {
  status(cabinetId: string): Promise<CalcomConnectionStatus | null>;
  accessToken(cabinetId: string): Promise<{ accessToken: string }>;
  eventTypes(accessToken: string): Promise<CalcomEventType[]>;
  availability(input: CalcomAvailabilityInput): Promise<CalcomSlot[]>;
  booking(input: CalcomBookingInput): Promise<CalcomBookingResult>;
  select(input: {
    cabinetId: string;
    actorUserId: string;
    eventTypeId: string;
    title: string;
    lengthMinutes: number;
  }): Promise<boolean>;
  disconnect(cabinetId: string, actorUserId: string): Promise<boolean>;
}

export const defaultCalcomRuntimeDependencies: CalcomRuntimeDependencies = {
  status: getCalcomConnectionStatus,
  accessToken: resolveFreshCalcomCredential,
  eventTypes: listCalcomEventTypes,
  availability: getCalcomAvailability,
  booking: createCalcomBooking,
  select: setCalcomEventType,
  disconnect: disconnectCalcomOAuthConnection,
};

export class CalcomRuntimeUnavailableError extends Error {
  constructor() {
    super('calcom_runtime_unavailable');
    this.name = 'CalcomRuntimeUnavailableError';
  }
}

export async function listTenantCalcomEventTypes(
  cabinetId: string,
  dependencies: CalcomRuntimeDependencies = defaultCalcomRuntimeDependencies,
): Promise<CalcomEventType[]> {
  const status = await dependencies.status(cabinetId);
  if (status?.status !== 'connected') throw new CalcomRuntimeUnavailableError();
  const credential = await dependencies.accessToken(cabinetId);
  return dependencies.eventTypes(credential.accessToken);
}

export async function selectTenantCalcomEventType(
  cabinetId: string,
  actorUserId: string,
  eventTypeId: string,
  dependencies: CalcomRuntimeDependencies = defaultCalcomRuntimeDependencies,
): Promise<CalcomConnectionStatus> {
  const eventTypes = await listTenantCalcomEventTypes(cabinetId, dependencies);
  const selected = eventTypes.find((eventType) => eventType.id === eventTypeId);
  if (!selected) throw new CalcomRuntimeUnavailableError();
  const updated = await dependencies.select({
    cabinetId,
    actorUserId,
    eventTypeId: selected.id,
    title: selected.title,
    lengthMinutes: selected.lengthMinutes,
  });
  if (!updated) throw new CalcomRuntimeUnavailableError();
  const status = await dependencies.status(cabinetId);
  if (!status?.runtimeReady || status.eventTypeId !== selected.id) {
    throw new CalcomRuntimeUnavailableError();
  }
  return status;
}

async function tenantRuntime(
  cabinetId: string,
  dependencies: CalcomRuntimeDependencies,
): Promise<{ accessToken: string; eventTypeId: string }> {
  const status = await dependencies.status(cabinetId);
  if (!status?.runtimeReady || status.eventTypeId === null) {
    throw new CalcomRuntimeUnavailableError();
  }
  const credential = await dependencies.accessToken(cabinetId);
  return { accessToken: credential.accessToken, eventTypeId: status.eventTypeId };
}

export async function getTenantCalcomAvailability(
  cabinetId: string,
  input: Omit<CalcomAvailabilityInput, 'accessToken' | 'eventTypeId'>,
  dependencies: CalcomRuntimeDependencies = defaultCalcomRuntimeDependencies,
): Promise<CalcomSlot[]> {
  const runtime = await tenantRuntime(cabinetId, dependencies);
  return dependencies.availability({ ...input, ...runtime });
}

export async function createTenantCalcomBooking(
  cabinetId: string,
  input: Omit<CalcomBookingInput, 'accessToken' | 'eventTypeId'>,
  dependencies: CalcomRuntimeDependencies = defaultCalcomRuntimeDependencies,
): Promise<CalcomBookingResult> {
  const runtime = await tenantRuntime(cabinetId, dependencies);
  return dependencies.booking({ ...input, ...runtime });
}

export async function disconnectTenantCalcom(
  cabinetId: string,
  actorUserId: string,
  dependencies: CalcomRuntimeDependencies = defaultCalcomRuntimeDependencies,
): Promise<void> {
  if (!await dependencies.disconnect(cabinetId, actorUserId)) {
    throw new CalcomRuntimeUnavailableError();
  }
}
