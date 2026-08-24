import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { buildAdminPreAuthRateLimiter } from '../middleware/rate-limit.js';
import {
  completeCalcomOAuthCallback,
  dbCalcomOAuthFlowStore,
  getCalcomOAuthConfiguration,
} from '../services/calcom-oauth.js';

const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u);
const codeSchema = z.string().min(1).max(4_096);

export interface CalcomOAuthRouterDependencies {
  portalReturnUrl(outcome: 'connected' | 'error'): string;
  complete(input: {
    state: string;
    code?: string;
    providerDenied: boolean;
  }): Promise<boolean>;
}

const defaultDependencies: CalcomOAuthRouterDependencies = {
  portalReturnUrl: (outcome) => {
    const url = new URL(getCalcomOAuthConfiguration().portalReturnUrl);
    url.searchParams.set('calcom', outcome);
    return url.toString();
  },
  complete: (input) => completeCalcomOAuthCallback(
    input,
    dbCalcomOAuthFlowStore,
  ),
};

export function buildCalcomOAuthRouter(
  dependencies: CalcomOAuthRouterDependencies = defaultDependencies,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.use(buildAdminPreAuthRateLimiter());

  router.get('/callback', async (req: Request, res: Response): Promise<void> => {
    let errorReturnUrl: string;
    try {
      errorReturnUrl = dependencies.portalReturnUrl('error');
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }

    const state = stateSchema.safeParse(req.query.state);
    const code = codeSchema.safeParse(req.query.code);
    const providerDenied = req.query.error !== undefined;
    if (!state.success || (!code.success && !providerDenied)) {
      res.redirect(303, errorReturnUrl);
      return;
    }

    let connected = false;
    try {
      connected = await dependencies.complete({
        state: state.data,
        ...(code.success && !providerDenied ? { code: code.data } : {}),
        providerDenied,
      });
    } catch {
      // Never reflect code, state, provider errors or descriptions. The fixed
      // portal destination is the only callback response in every outcome.
    }
    res.redirect(
      303,
      connected ? dependencies.portalReturnUrl('connected') : errorReturnUrl,
    );
  });

  return router;
}

export const calcomOAuthRouter = buildCalcomOAuthRouter();
