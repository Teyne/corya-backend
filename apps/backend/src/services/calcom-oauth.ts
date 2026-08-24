import { env } from '../config/env.js';
import {
  beginCalcomOAuthFlow,
  completeCalcomOAuthFlow,
  consumeCalcomOAuthFlow,
  failCalcomOAuthFlow,
} from '../db/queries.js';
import {
  CALCOM_OAUTH_SCOPES,
  exchangeCalcomAuthorizationCode,
  getCalcomProfileId,
  type CalcomOAuthTokenResult,
} from './calcom-api.js';

const CALCOM_AUTHORIZE_URL = 'https://app.cal.com/auth/oauth2/authorize';
const EXPECTED_SCOPES = [...CALCOM_OAUTH_SCOPES].sort();

export interface CalcomOAuthConfiguration {
  clientId: string;
  redirectUri: string;
  portalReturnUrl: string;
}

export interface CalcomOAuthFlowStart {
  flowId: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  scopes: string[];
  expiresAt: string;
}

export interface ConsumedCalcomOAuthFlow {
  flowId: string;
  cabinetId: string;
  actorUserId: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  deadline: string;
}

export interface CompleteCalcomOAuthFlowInput {
  flowId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  grantedScopes: string[];
  providerAccountId: string | null;
}

export interface CalcomOAuthFlowStore {
  begin(input: {
    cabinetId: string;
    actorUserId: string;
    redirectUri: string;
  }): Promise<CalcomOAuthFlowStart>;
  consume(state: string): Promise<ConsumedCalcomOAuthFlow | null>;
  complete(input: CompleteCalcomOAuthFlowInput): Promise<boolean>;
  fail(
    flowId: string,
    reason: 'access_denied' | 'token_exchange_failed' | 'event_type_invalid',
  ): Promise<void>;
}

export interface CalcomOAuthProvider {
  exchange(input: {
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<CalcomOAuthTokenResult>;
  profileId(accessToken: string): Promise<string>;
}

const defaultProvider: CalcomOAuthProvider = {
  exchange: exchangeCalcomAuthorizationCode,
  profileId: getCalcomProfileId,
};

export const dbCalcomOAuthFlowStore: CalcomOAuthFlowStore = {
  begin: ({ cabinetId, actorUserId, redirectUri }) =>
    beginCalcomOAuthFlow(cabinetId, actorUserId, redirectUri),
  consume: consumeCalcomOAuthFlow,
  complete: completeCalcomOAuthFlow,
  fail: failCalcomOAuthFlow,
};

export class CalcomOAuthError extends Error {
  constructor() {
    super('calcom_oauth_failed');
    this.name = 'CalcomOAuthError';
  }
}

export function getCalcomOAuthConfiguration(): CalcomOAuthConfiguration {
  if (
    env.CALCOM_OAUTH_CLIENT_ID === undefined
    || env.CALCOM_OAUTH_REDIRECT_URI === undefined
    || env.CALCOM_PORTAL_RETURN_URL === undefined
  ) throw new CalcomOAuthError();
  return {
    clientId: env.CALCOM_OAUTH_CLIENT_ID,
    redirectUri: env.CALCOM_OAUTH_REDIRECT_URI,
    portalReturnUrl: env.CALCOM_PORTAL_RETURN_URL,
  };
}

function scopesAreExact(scopes: readonly string[]): boolean {
  const normalized = [...new Set(scopes)].sort();
  return normalized.length === EXPECTED_SCOPES.length
    && normalized.every((scope, index) => scope === EXPECTED_SCOPES[index]);
}

export async function startCalcomOAuth(
  cabinetId: string,
  actorUserId: string,
  store: CalcomOAuthFlowStore,
  configuration: CalcomOAuthConfiguration = getCalcomOAuthConfiguration(),
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const flow = await store.begin({
    cabinetId,
    actorUserId,
    redirectUri: configuration.redirectUri,
  });
  if (
    flow.codeChallengeMethod !== 'S256'
    || flow.redirectUri !== configuration.redirectUri
    || !scopesAreExact(flow.scopes)
  ) throw new CalcomOAuthError();

  const url = new URL(CALCOM_AUTHORIZE_URL);
  url.searchParams.set('client_id', configuration.clientId);
  url.searchParams.set('redirect_uri', configuration.redirectUri);
  url.searchParams.set('state', flow.state);
  url.searchParams.set('scope', CALCOM_OAUTH_SCOPES.join(' '));
  url.searchParams.set('code_challenge', flow.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { authorizationUrl: url.toString(), expiresAt: flow.expiresAt };
}

async function failConsumedFlow(
  store: CalcomOAuthFlowStore,
  flow: ConsumedCalcomOAuthFlow,
  reason: 'access_denied' | 'token_exchange_failed' | 'event_type_invalid',
): Promise<void> {
  try {
    await store.fail(flow.flowId, reason);
  } catch {
    // The callback still returns only the fixed portal redirect. A failed
    // best-effort state transition must never expose OAuth material.
  }
}

export async function completeCalcomOAuthCallback(
  input: { state: string; code?: string; providerDenied: boolean },
  store: CalcomOAuthFlowStore,
  provider: CalcomOAuthProvider = defaultProvider,
  configuration: CalcomOAuthConfiguration = getCalcomOAuthConfiguration(),
): Promise<boolean> {
  const flow = await store.consume(input.state);
  if (!flow) return false;
  if (
    input.providerDenied
    || input.code === undefined
    || flow.redirectUri !== configuration.redirectUri
    || !scopesAreExact(flow.scopes)
    || Date.parse(flow.deadline) <= Date.now()
  ) {
    await failConsumedFlow(
      store,
      flow,
      input.providerDenied ? 'access_denied' : 'token_exchange_failed',
    );
    return false;
  }

  try {
    const tokens = await provider.exchange({
      clientId: configuration.clientId,
      code: input.code,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier,
    });
    if (!scopesAreExact(tokens.scopes)) {
      await failConsumedFlow(store, flow, 'token_exchange_failed');
      return false;
    }
    const providerAccountId = await provider.profileId(tokens.accessToken);
    return await store.complete({
      flowId: flow.flowId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.expiresAt,
      grantedScopes: tokens.scopes,
      providerAccountId,
    });
  } catch {
    await failConsumedFlow(store, flow, 'token_exchange_failed');
    return false;
  }
}
