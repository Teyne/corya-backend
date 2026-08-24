/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await -- test doubles are intentionally immediate. */
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCalcomOAuthRouter,
  type CalcomOAuthRouterDependencies,
} from '../../src/routes/calcom-oauth.js';
import { __resetRateLimitForTests } from '../../src/middleware/rate-limit.js';

const STATE = 's'.repeat(43);

function dependencies(): CalcomOAuthRouterDependencies {
  return {
    portalReturnUrl: vi.fn((outcome) =>
      `https://portal.example.test/integrations?calcom=${outcome}`),
    complete: vi.fn(async () => true),
  };
}

function appFor(deps: CalcomOAuthRouterDependencies): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/oauth/calcom', buildCalcomOAuthRouter(deps));
  return app;
}

beforeEach(() => {
  __resetRateLimitForTests();
});

describe('Cal.com public OAuth callback', () => {
  it('consumes a bounded code and redirects only to the fixed connected URL', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps))
      .get('/oauth/calcom/callback')
      .query({ state: STATE, code: 'synthetic-code' });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      'https://portal.example.test/integrations?calcom=connected',
    );
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(deps.complete).toHaveBeenCalledWith({
      state: STATE,
      code: 'synthetic-code',
      providerDenied: false,
    });
  });

  it('consumes provider denial without reflecting its description', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockResolvedValue(false);
    const response = await request(appFor(deps))
      .get('/oauth/calcom/callback')
      .query({
        state: STATE,
        error: 'access_denied',
        error_description: 'SECRET-SENTINEL',
      });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      'https://portal.example.test/integrations?calcom=error',
    );
    expect(JSON.stringify(response.headers)).not.toContain('SECRET-SENTINEL');
    expect(deps.complete).toHaveBeenCalledWith({
      state: STATE,
      providerDenied: true,
    });
  });

  it('does not touch the flow store for malformed callback input', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps))
      .get('/oauth/calcom/callback')
      .query({ state: 'short', code: 'SECRET-SENTINEL' });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      'https://portal.example.test/integrations?calcom=error',
    );
    expect(deps.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(response.headers)).not.toContain('SECRET-SENTINEL');
  });

  it('maps internal callback failure to the same fixed error redirect', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockRejectedValue(new Error('SECRET-SENTINEL'));
    const response = await request(appFor(deps))
      .get('/oauth/calcom/callback')
      .query({ state: STATE, code: 'synthetic-code' });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      'https://portal.example.test/integrations?calcom=error',
    );
    expect(JSON.stringify(response.headers)).not.toContain('SECRET-SENTINEL');
  });
});
