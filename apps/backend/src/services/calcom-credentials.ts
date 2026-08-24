import { z } from 'zod';
import { env } from '../config/env.js';
import { getCalcomConnectionCredentials } from '../db/queries.js';

const cabinetIdSchema = z.string().uuid();
const OAUTH_EXPIRY_MARGIN_MS = 60_000;

/**
 * Minimal DB-facing snapshot returned by the provider in `db/queries.ts`.
 *
 * `unknown` is intentional for the demonstration flag: the policy must only
 * accept the exact database boolean `true`, never a truthy string or number.
 */
export interface CalcomCredentialSnapshot {
  connectionId: string | null;
  status: unknown;
  oauthAccessToken: string | null;
  accessTokenExpiresAt: string | null;
  demonstrationMode: unknown;
}

export interface CalcomCredentialProvider {
  loadForCabinet: (
    cabinetId: string,
  ) => Promise<CalcomCredentialSnapshot | null>;
}

export interface ResolvedCalcomCredential {
  accessToken: string;
  source: 'oauth_vault' | 'demo_environment';
}

export interface CalcomDemoFallbackConfig {
  enabled: boolean;
  cabinetId: string | undefined;
  apiKey: string | undefined;
}

export class CalcomCredentialUnavailableError extends Error {
  constructor() {
    super('calcom_credentials_unavailable');
    this.name = 'CalcomCredentialUnavailableError';
  }
}

export const dbCalcomCredentialProvider: CalcomCredentialProvider = {
  loadForCabinet: async (cabinetId) => {
    const credentials = await getCalcomConnectionCredentials(cabinetId);
    return {
      connectionId: credentials.connectionId,
      status: credentials.status,
      oauthAccessToken: credentials.accessToken,
      accessTokenExpiresAt: credentials.accessTokenExpiresAt,
      demonstrationMode: credentials.demonstrationMode,
    };
  },
};

function presentSecret(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function oauthCredentialIsUsable(
  snapshot: CalcomCredentialSnapshot,
): snapshot is CalcomCredentialSnapshot & { oauthAccessToken: string } {
  if (
    snapshot.connectionId === null
    || snapshot.status !== 'connected'
    || !presentSecret(snapshot.oauthAccessToken)
    || snapshot.accessTokenExpiresAt === null
  ) {
    return false;
  }

  const expiresAt = Date.parse(snapshot.accessTokenExpiresAt);
  return Number.isFinite(expiresAt)
    && expiresAt > Date.now() + OAUTH_EXPIRY_MARGIN_MS;
}

/**
 * Resolve one cabinet's Cal.com credential without ever crossing tenants.
 *
 * The provider receives exactly the requested cabinet id. OAuth/Vault always
 * wins. The process-level demonstration key is a deliberately narrow bridge:
 * it requires an explicit feature flag, an exact cabinet-id match, no OAuth
 * connection at all, and a tenant row carrying the exact boolean `true`.
 * Every other state fails closed with a constant, non-secret error.
 */
export async function resolveCalcomCredential(
  cabinetId: string,
  provider: CalcomCredentialProvider = dbCalcomCredentialProvider,
  demoFallback: CalcomDemoFallbackConfig = {
    enabled: env.CALCOM_DEMO_FALLBACK_ENABLED,
    cabinetId: env.CALCOM_DEMO_CABINET_ID,
    apiKey: env.CALCOM_DEMO_API_KEY,
  },
): Promise<ResolvedCalcomCredential> {
  if (!cabinetIdSchema.safeParse(cabinetId).success) {
    throw new CalcomCredentialUnavailableError();
  }

  const snapshot = await provider.loadForCabinet(cabinetId);
  if (snapshot && oauthCredentialIsUsable(snapshot)) {
    return {
      accessToken: snapshot.oauthAccessToken,
      source: 'oauth_vault',
    };
  }

  if (
    demoFallback.enabled === true
    && demoFallback.cabinetId === cabinetId
    && snapshot?.connectionId === null
    && snapshot.demonstrationMode === true
    && presentSecret(demoFallback.apiKey)
  ) {
    return {
      accessToken: demoFallback.apiKey,
      source: 'demo_environment',
    };
  }

  throw new CalcomCredentialUnavailableError();
}
