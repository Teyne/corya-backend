import { describe, expect, it, vi } from 'vitest';
import {
  CalcomCredentialUnavailableError,
  resolveCalcomCredential,
  type CalcomCredentialProvider,
  type CalcomCredentialSnapshot,
  type CalcomDemoFallbackConfig,
} from '../../src/services/calcom-credentials.js';

const CABINET_A = '11111111-1111-4111-8111-111111111111';
const CABINET_B = '22222222-2222-4222-8222-222222222222';
const OAUTH_TOKEN = 'synthetic-oauth-token-not-real';
const DEMO_TOKEN = 'synthetic-demo-token-not-real';
const FUTURE_EXPIRY = '2026-09-01T12:05:00.000Z';

function demoFallback(
  overrides: Partial<CalcomDemoFallbackConfig> = {},
): CalcomDemoFallbackConfig {
  return {
    enabled: true,
    cabinetId: CABINET_A,
    apiKey: DEMO_TOKEN,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<CalcomCredentialSnapshot> = {},
): CalcomCredentialSnapshot {
  return {
    connectionId: '33333333-3333-4333-8333-333333333333',
    status: 'connected',
    oauthAccessToken: OAUTH_TOKEN,
    accessTokenExpiresAt: FUTURE_EXPIRY,
    demonstrationMode: false,
    ...overrides,
  };
}

function providerFor(
  snapshots: Readonly<Record<string, CalcomCredentialSnapshot | null>>,
): CalcomCredentialProvider & { loadForCabinet: ReturnType<typeof vi.fn> } {
  const loadForCabinet = vi.fn((cabinetId: string) =>
    Promise.resolve(snapshots[cabinetId] ?? null));
  return { loadForCabinet };
}

describe('resolveCalcomCredential', () => {
  it('uses the tenant OAuth/Vault token before the demo fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    const provider = providerFor({
      [CABINET_A]: snapshot({ demonstrationMode: true }),
    });

    try {
      await expect(resolveCalcomCredential(CABINET_A, provider, demoFallback()))
        .resolves.toEqual({
          accessToken: OAUTH_TOKEN,
          source: 'oauth_vault',
        });
      expect(provider.loadForCabinet).toHaveBeenCalledWith(CABINET_A);
      expect(provider.loadForCabinet).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the demo key only for an explicit boolean demonstration tenant', async () => {
    const provider = providerFor({
      [CABINET_A]: snapshot({
        connectionId: null,
        status: null,
        oauthAccessToken: null,
        accessTokenExpiresAt: null,
        demonstrationMode: true,
      }),
    });

    await expect(resolveCalcomCredential(CABINET_A, provider, demoFallback()))
      .resolves.toEqual({
        accessToken: DEMO_TOKEN,
        source: 'demo_environment',
      });
  });

  it.each([false, 'true', 1, null, undefined])(
    'fails closed for non-strict demonstration flag %s',
    async (demonstrationMode) => {
      const provider = providerFor({
        [CABINET_A]: snapshot({
          connectionId: null,
          status: null,
          oauthAccessToken: null,
          accessTokenExpiresAt: null,
          demonstrationMode,
        }),
      });

      await expect(resolveCalcomCredential(CABINET_A, provider, demoFallback()))
        .rejects.toBeInstanceOf(CalcomCredentialUnavailableError);
    },
  );

  it('fails closed when the tenant has no credential row', async () => {
    const provider = providerFor({});

    await expect(resolveCalcomCredential(CABINET_A, provider, demoFallback()))
      .rejects.toThrow('calcom_credentials_unavailable');
  });

  it('fails closed when the explicit demo tenant has no configured demo key', async () => {
    const provider = providerFor({
      [CABINET_A]: snapshot({
        connectionId: null,
        status: null,
        oauthAccessToken: null,
        accessTokenExpiresAt: null,
        demonstrationMode: true,
      }),
    });

    await expect(resolveCalcomCredential(
      CABINET_A,
      provider,
      demoFallback({ apiKey: '' }),
    ))
      .rejects.toThrow('calcom_credentials_unavailable');
  });

  it('never resolves another tenant credential', async () => {
    const provider = providerFor({
      [CABINET_B]: snapshot(),
    });

    await expect(resolveCalcomCredential(CABINET_A, provider, demoFallback()))
      .rejects.toThrow('calcom_credentials_unavailable');
    expect(provider.loadForCabinet).toHaveBeenCalledWith(CABINET_A);
    expect(provider.loadForCabinet).not.toHaveBeenCalledWith(CABINET_B);
  });

  it('rejects an invalid tenant id before consulting the provider', async () => {
    const provider = providerFor({});

    await expect(resolveCalcomCredential(
      'not-a-cabinet-id',
      provider,
      demoFallback(),
    ))
      .rejects.toThrow('calcom_credentials_unavailable');
    expect(provider.loadForCabinet).not.toHaveBeenCalled();
  });

  it('does not expose either credential through failure messages', async () => {
    const provider = providerFor({
      [CABINET_A]: snapshot({
        connectionId: null,
        status: null,
        oauthAccessToken: null,
        accessTokenExpiresAt: null,
      }),
    });

    let thrown: unknown;
    try {
      await resolveCalcomCredential(CABINET_A, provider, demoFallback());
    } catch (error: unknown) {
      thrown = error;
    }

    const serialized = JSON.stringify(thrown, Object.getOwnPropertyNames(
      thrown instanceof Error ? thrown : {},
    ));
    expect(serialized).not.toContain(DEMO_TOKEN);
    expect(serialized).not.toContain(OAUTH_TOKEN);
  });

  it.each([
    ['expired status', { status: 'expired' }],
    ['error status', { status: 'error' }],
    ['revoked status', { status: 'revoked' }],
    ['missing expiry', { accessTokenExpiresAt: null }],
    ['invalid expiry', { accessTokenExpiresAt: 'not-a-date' }],
    ['expiry inside safety margin', {
      accessTokenExpiresAt: '2026-09-01T12:00:30.000Z',
    }],
  ])('rejects an unusable OAuth credential: %s', async (_label, overrides) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    const provider = providerFor({
      [CABINET_A]: snapshot(overrides),
    });

    try {
      await expect(resolveCalcomCredential(CABINET_A, provider, demoFallback()))
        .rejects.toThrow('calcom_credentials_unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never falls back when an OAuth connection exists but is expired', async () => {
    const provider = providerFor({
      [CABINET_A]: snapshot({
        status: 'expired',
        demonstrationMode: true,
      }),
    });

    await expect(resolveCalcomCredential(CABINET_A, provider, demoFallback()))
      .rejects.toThrow('calcom_credentials_unavailable');
  });

  it('requires the demo fallback feature flag to be explicitly enabled', async () => {
    const provider = providerFor({
      [CABINET_A]: snapshot({
        connectionId: null,
        status: null,
        oauthAccessToken: null,
        accessTokenExpiresAt: null,
        demonstrationMode: true,
      }),
    });

    await expect(resolveCalcomCredential(
      CABINET_A,
      provider,
      demoFallback({ enabled: false }),
    )).rejects.toThrow('calcom_credentials_unavailable');
  });

  it('requires an exact demo cabinet id match', async () => {
    const provider = providerFor({
      [CABINET_A]: snapshot({
        connectionId: null,
        status: null,
        oauthAccessToken: null,
        accessTokenExpiresAt: null,
        demonstrationMode: true,
      }),
    });

    await expect(resolveCalcomCredential(
      CABINET_A,
      provider,
      demoFallback({ cabinetId: CABINET_B }),
    )).rejects.toThrow('calcom_credentials_unavailable');
  });
});
