/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await -- test doubles are intentionally immediate. */
import { describe, expect, it, vi } from 'vitest';
import {
  completeCalcomOAuthCallback,
  startCalcomOAuth,
  type CalcomOAuthConfiguration,
  type CalcomOAuthFlowStore,
  type CalcomOAuthProvider,
} from '../../src/services/calcom-oauth.js';

const CABINET_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const FLOW_ID = '33333333-3333-4333-8333-333333333333';
const STATE = 's'.repeat(43);
const SCOPES = ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'];
const configuration: CalcomOAuthConfiguration = {
  clientId: 'synthetic-public-client',
  redirectUri: 'https://api.example.test/oauth/calcom/callback',
  portalReturnUrl: 'https://portal.example.test/integrations',
};

function store(): CalcomOAuthFlowStore {
  return {
    begin: vi.fn(async () => ({
      flowId: FLOW_ID,
      state: STATE,
      codeChallenge: 'c'.repeat(43),
      codeChallengeMethod: 'S256' as const,
      redirectUri: configuration.redirectUri,
      scopes: SCOPES,
      expiresAt: '2026-09-01T12:10:00.000Z',
    })),
    consume: vi.fn(async () => ({
      flowId: FLOW_ID,
      cabinetId: CABINET_ID,
      actorUserId: ACTOR_ID,
      codeVerifier: 'v'.repeat(64),
      redirectUri: configuration.redirectUri,
      scopes: SCOPES,
      deadline: '2026-09-01T12:02:00.000Z',
    })),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => undefined),
  };
}

function provider(): CalcomOAuthProvider {
  return {
    exchange: vi.fn(async () => ({
      accessToken: 'synthetic-access-token',
      refreshToken: 'synthetic-refresh-token',
      expiresAt: '2026-09-01T12:30:00.000Z',
      scopes: SCOPES,
    })),
    profileId: vi.fn(async () => '123'),
  };
}

describe('Cal.com OAuth orchestration', () => {
  it('starts a server-side S256 flow with the exact scope set', async () => {
    const flowStore = store();
    const result = await startCalcomOAuth(
      CABINET_ID,
      ACTOR_ID,
      flowStore,
      configuration,
    );

    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://app.cal.com/auth/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe(configuration.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(configuration.redirectUri);
    expect(url.searchParams.get('state')).toBe(STATE);
    expect(url.searchParams.get('scope')).toBe(SCOPES.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(flowStore.begin).toHaveBeenCalledWith({
      cabinetId: CABINET_ID,
      actorUserId: ACTOR_ID,
      redirectUri: configuration.redirectUri,
    });
  });

  it('consumes the flow once, verifies profile and persists tokens through the store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    const flowStore = store();
    const oauthProvider = provider();
    try {
      await expect(completeCalcomOAuthCallback(
        { state: STATE, code: 'synthetic-code', providerDenied: false },
        flowStore,
        oauthProvider,
        configuration,
      )).resolves.toBe(true);
      expect(flowStore.consume).toHaveBeenCalledWith(STATE);
      expect(oauthProvider.exchange).toHaveBeenCalledWith({
        clientId: configuration.clientId,
        code: 'synthetic-code',
        redirectUri: configuration.redirectUri,
        codeVerifier: 'v'.repeat(64),
      });
      expect(oauthProvider.profileId).toHaveBeenCalledWith('synthetic-access-token');
      expect(flowStore.complete).toHaveBeenCalledWith({
        flowId: FLOW_ID,
        accessToken: 'synthetic-access-token',
        refreshToken: 'synthetic-refresh-token',
        accessTokenExpiresAt: '2026-09-01T12:30:00.000Z',
        grantedScopes: SCOPES,
        providerAccountId: '123',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a replay before provider I/O', async () => {
    const flowStore = store();
    vi.mocked(flowStore.consume).mockResolvedValue(null);
    const oauthProvider = provider();

    await expect(completeCalcomOAuthCallback(
      { state: STATE, code: 'synthetic-code', providerDenied: false },
      flowStore,
      oauthProvider,
      configuration,
    )).resolves.toBe(false);
    expect(oauthProvider.exchange).not.toHaveBeenCalled();
    expect(flowStore.complete).not.toHaveBeenCalled();
  });

  it('marks an access denial without exchanging any code', async () => {
    const flowStore = store();
    const oauthProvider = provider();

    await expect(completeCalcomOAuthCallback(
      { state: STATE, providerDenied: true },
      flowStore,
      oauthProvider,
      configuration,
    )).resolves.toBe(false);
    expect(flowStore.fail).toHaveBeenCalledWith(FLOW_ID, 'access_denied');
    expect(oauthProvider.exchange).not.toHaveBeenCalled();
  });

  it('rejects a mismatched scope set without transporting tokens to persistence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    const flowStore = store();
    const oauthProvider = provider();
    vi.mocked(oauthProvider.exchange).mockResolvedValue({
      accessToken: 'SECRET-ACCESS-SENTINEL',
      refreshToken: 'SECRET-REFRESH-SENTINEL',
      expiresAt: '2026-09-01T12:30:00.000Z',
      scopes: ['PROFILE_READ'],
    });
    try {
      await expect(completeCalcomOAuthCallback(
        { state: STATE, code: 'synthetic-code', providerDenied: false },
        flowStore,
        oauthProvider,
        configuration,
      )).resolves.toBe(false);
      expect(oauthProvider.profileId).not.toHaveBeenCalled();
      expect(flowStore.complete).not.toHaveBeenCalled();
      expect(flowStore.fail).toHaveBeenCalledWith(FLOW_ID, 'token_exchange_failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
