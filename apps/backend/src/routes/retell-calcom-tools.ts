import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { consumeAuthenticatedWebhookRateLimit } from '../middleware/rate-limit.js';
import {
  RETELL_SIGNATURE_HEADER,
  verifyRetellSignature,
} from '../services/retell.js';
import {
  defaultRetellCalcomToolDependencies,
  RetellCalcomToolUnavailableError,
  RetellCalcomToolValidationError,
  runRetellCalcomAvailability,
  runRetellCalcomBooking,
  type RetellCalcomToolDependencies,
} from '../services/retell-calcom-tools.js';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

async function authenticateRetell(
  req: RawBodyRequest,
  res: Response,
): Promise<boolean> {
  if (!req.rawBody || req.rawBody.length === 0) {
    res.status(400).json({ error: 'empty_body' });
    return false;
  }
  const signature = req.header(RETELL_SIGNATURE_HEADER);
  if (!await verifyRetellSignature(req.rawBody, signature, env.RETELL_API_KEY)) {
    logger.warn({ has_header: Boolean(signature) }, 'retell_tool_signature_invalid');
    res.status(401).json({ error: 'invalid_signature' });
    return false;
  }
  return consumeAuthenticatedWebhookRateLimit(req, res);
}

function handleKnownError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof RetellCalcomToolValidationError) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  if (error instanceof RetellCalcomToolUnavailableError) {
    res.status(409).json({ error: 'integration_not_ready' });
    return;
  }
  next(error);
}

export function buildRetellCalcomToolsRouter(
  dependencies: RetellCalcomToolDependencies = defaultRetellCalcomToolDependencies,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/availability', async (req: RawBodyRequest, res, next): Promise<void> => {
    if (!await authenticateRetell(req, res)) return;
    try {
      res.json(await runRetellCalcomAvailability(req.body as unknown, dependencies));
    } catch (error: unknown) {
      handleKnownError(error, res, next);
    }
  });

  router.post('/booking', async (req: RawBodyRequest, res, next): Promise<void> => {
    if (!await authenticateRetell(req, res)) return;
    try {
      res.json(await runRetellCalcomBooking(req.body as unknown, dependencies));
    } catch (error: unknown) {
      handleKnownError(error, res, next);
    }
  });

  return router;
}

export const retellCalcomToolsRouter: Router = buildRetellCalcomToolsRouter();
