import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
vi.mock('../../src/config/supabase.js', () => ({
  getServiceClient: () => ({ rpc: rpcMock }),
  getAuthClient: vi.fn(),
}));

const { getCalcomConnectionCredentials } = await import(
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
