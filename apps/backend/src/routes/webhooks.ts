/**
 * Retell webhook HTTP layer — deliberately thin.
 *
 * Contract:
 *   - Signature verified BEFORE anything else. 401 on failure.
 *   - Payload zod-validated. 400 on failure.
 *   - Once validation passes, respond 200 IMMEDIATELY and hand the payload
 *     to the async orchestrator. Retell must never see a 5xx (which would
 *     trigger their retry policy — we handle retries ourselves via the
 *     `jobs` table).
 *
 * Raw body:
 *   Signature is HMAC-SHA256 of the raw request body. The signature check
 *   MUST run on the bytes as received, so this route relies on the raw-body
 *   capture wired in `src/index.ts` (express.json `verify` callback stashing
 *   the Buffer on `req.rawBody`).
 */
import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { processCallAnalyzed } from '../services/appel.js';
import { parseRetellPayload, verifyRetellSignature, RETELL_SIGNATURE_HEADER } from '../services/retell.js';
import { RetellSignatureError, WebhookValidationError } from '../utils/errors.js';

/**
 * Extend Express' Request type locally: the raw body Buffer captured by the
 * express.json `verify` callback in src/index.ts.
 */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export const webhooksRouter: Router = Router();

webhooksRouter.post(
  '/retell/call-ended',
  (req: RawBodyRequest, res: Response): void => {
    const rawBody = req.rawBody;
    const headerSig = req.header(RETELL_SIGNATURE_HEADER);

    if (!rawBody || rawBody.length === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    // 1. Signature — timing-safe, no early return path leaks bytes.
    if (!env.RETELL_WEBHOOK_SECRET) {
      // Guardrail: env.ts should already enforce this at boot. Belt and
      // braces in case a test env slips through with the var missing.
      logger.error('retell_webhook_secret_missing');
      res.status(500).json({ error: 'server_misconfigured' });
      return;
    }

    if (!verifyRetellSignature(rawBody, headerSig, env.RETELL_WEBHOOK_SECRET)) {
      // No correlation id yet — we refuse to parse the body of an unsigned
      // request. Just log the header presence, nothing more.
      logger.warn(
        { has_header: Boolean(headerSig) },
        'retell_webhook_signature_invalid',
      );
      const err = new RetellSignatureError();
      res.status(err.httpStatus).json({ error: err.message });
      return;
    }

    // 2. Payload validation.
    let payload;
    try {
      const parsed: unknown = req.body;
      payload = parseRetellPayload(parsed);
    } catch (e) {
      if (e instanceof WebhookValidationError) {
        logger.warn({ err_msg: e.message }, 'retell_webhook_payload_invalid');
        res.status(e.httpStatus).json({ error: e.message });
        return;
      }
      throw e;
    }

    // 3. Respond 200 immediately, then process in background.
    res.status(200).json({ received: true });

    // Fire-and-forget: we own retries via the jobs table. Any thrown error
    // is caught here and logged; Retell must NEVER see it.
    void processCallAnalyzed(payload).catch((err: unknown) => {
      logger.error(
        {
          retell_call_id: payload.call.call_id,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'webhook_async_processing_failed',
      );
    });
  },
);
