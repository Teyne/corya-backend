import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
vi.mock('../../src/config/supabase.js', () => ({
  getServiceClient: () => ({ rpc: rpcMock }),
  getAuthClient: vi.fn(),
}));

const {
  claimCalendarBookingCommand,
  completeCalendarBookingCommand,
  getCalcomConnectionCredentials,
  markCalendarBookingCommandUncertain,
} = await import(
  '../../src/db/queries.js'
);

const CABINET_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const ACCESS_TOKEN = 'synthetic-access-token-not-real';
const REFRESH_TOKEN = 'synthetic-refresh-token-not-real';

function queueRpcResult(
  data: unknown,
  error: { message: string } | null = null,
): void {
  rpcMock.mockReturnValueOnce({
    abortSignal: vi.fn().mockResolvedValue({ data, error }),
  });
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe('getCalcomConnectionCredentials', () => {
  it('calls the tenant-scoped RPC and maps its strict allowlist', async () => {
    queueRpcResult([{
      connection_id: CONNECTION_ID,
      status: 'connected',
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      access_token_expires_at: '2026-09-01T12:05:00.000Z',
      granted_scopes: ['booking:read', 'booking:write'],
      provider_account_id: 'provider-account-1',
      demonstration_mode: false,
    }]);

    await expect(getCalcomConnectionCredentials(CABINET_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      status: 'connected',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      accessTokenExpiresAt: '2026-09-01T12:05:00.000Z',
      grantedScopes: ['booking:read', 'booking:write'],
      providerAccountId: 'provider-account-1',
      demonstrationMode: false,
    });
    expect(rpcMock).toHaveBeenCalledWith('get_calcom_connection_credentials', {
      p_cabinet_id: CABINET_ID,
    });
  });

  it('accepts the canonical no-connection row for a demo cabinet', async () => {
    queueRpcResult([{
      connection_id: null,
      status: null,
      access_token: null,
      refresh_token: null,
      access_token_expires_at: null,
      granted_scopes: null,
      provider_account_id: null,
      demonstration_mode: true,
    }]);

    await expect(getCalcomConnectionCredentials(CABINET_ID)).resolves
      .toMatchObject({
        connectionId: null,
        demonstrationMode: true,
      });
  });

  it('rejects malformed rows without reproducing credential values', async () => {
    queueRpcResult([{
      connection_id: CONNECTION_ID,
      status: 'connected',
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      access_token_expires_at: 'not-a-date',
      granted_scopes: [],
      provider_account_id: null,
      demonstration_mode: 'true',
    }]);

    const promise = getCalcomConnectionCredentials(CABINET_ID);
    await expect(promise).rejects.toThrow(
      'db_get_calcom_credentials_invalid_result',
    );
    await expect(promise).rejects.not.toThrow(ACCESS_TOKEN);
    await expect(promise).rejects.not.toThrow(REFRESH_TOKEN);
  });

  it('maps provider errors to a constant secret-free error', async () => {
    queueRpcResult(null, {
      message: `provider failed with ${ACCESS_TOKEN}`,
    });

    await expect(getCalcomConnectionCredentials(CABINET_ID)).rejects.toThrow(
      'db_get_calcom_credentials_failed',
    );
  });

  it.each([
    { data: [] },
    {
      data: [
        { demonstration_mode: false },
        { demonstration_mode: false },
      ],
    },
  ])(
    'rejects a result whose cardinality is not exactly one',
    async ({ data }) => {
      queueRpcResult(data);
      await expect(getCalcomConnectionCredentials(CABINET_ID)).rejects.toThrow(
        'db_get_calcom_credentials_invalid_result',
      );
    },
  );
});

describe('calendar booking command RPC wrappers', () => {
  it('maps the strict claim response without exposing payload data', async () => {
    queueRpcResult([{
      outcome: 'claimed',
      provider_booking_uid: null,
      provider_status: null,
      booked_start: null,
      booked_end: null,
    }]);

    await expect(claimCalendarBookingCommand({
      commandKey: 'a'.repeat(64),
      cabinetId: CABINET_ID,
      requestedStart: '2026-09-10T10:00:00.000Z',
      leaseOwner: '33333333-3333-4333-8333-333333333333',
    })).resolves.toEqual({
      outcome: 'claimed',
      providerBookingUid: null,
      providerStatus: null,
      bookedStart: null,
      bookedEnd: null,
    });
    expect(rpcMock).toHaveBeenCalledWith('claim_calendar_booking_command', {
      p_command_key: 'a'.repeat(64),
      p_cabinet_id: CABINET_ID,
      p_requested_start: '2026-09-10T10:00:00.000Z',
      p_lease_owner: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('maps completion and uncertainty transitions to booleans', async () => {
    queueRpcResult(true);
    await expect(completeCalendarBookingCommand({
      commandKey: 'b'.repeat(64),
      leaseOwner: '33333333-3333-4333-8333-333333333333',
      providerBookingUid: 'synthetic-booking-uid',
      providerStatus: 'accepted',
      bookedStart: '2026-09-10T10:00:00.000Z',
      bookedEnd: '2026-09-10T10:30:00.000Z',
    })).resolves.toBe(true);

    queueRpcResult(false);
    await expect(markCalendarBookingCommandUncertain({
      commandKey: 'b'.repeat(64),
      leaseOwner: '33333333-3333-4333-8333-333333333333',
    })).resolves.toBe(false);
  });

  it('rejects malformed claim rows with a constant error', async () => {
    queueRpcResult([{
      outcome: 'claimed',
      provider_booking_uid: 'must-not-be-present-on-a-new-claim',
    }]);
    await expect(claimCalendarBookingCommand({
      commandKey: 'c'.repeat(64),
      cabinetId: CABINET_ID,
      requestedStart: '2026-09-10T10:00:00.000Z',
      leaseOwner: '33333333-3333-4333-8333-333333333333',
    })).rejects.toThrow('db_claim_calendar_booking_command_invalid_result');
  });
});
