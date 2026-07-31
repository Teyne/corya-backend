/**
 * Retell webhook HTTP layer — deliberately thin.
 *
 * URL: `POST /webhooks/retell/call-ended`
 *   The name is historical. The Retell dashboard already points here, and
 *   we do NOT rename it just because we now receive three event types.
 *   Retell emits `call_started`, `call_ended` AND `call_analyzed` to this
 *   same endpoint. Only `call_analyzed` triggers business logic.
 *
 * Contract — HTTP status policy:
 *   - **401 uniquement si non authentifié** (signature invalide/absente,
 *     ou rejet du SDK Retell). C'est le SEUL cas où on refuse : la requête
 *     n'est pas prouvée venir de Retell, on ne doit surtout pas l'acquitter.
 *   - **400 uniquement si le body est vide/absent** — une requête sans
 *     corps ne vient manifestement pas de Retell.
 *   - **Tout le reste est acquitté 200**, pour ne pas déclencher les retries
 *     Retell. Nos propres retries passent par la table `jobs`, jamais par
 *     un rejeu HTTP côté Retell. En particulier :
 *       * `call_started` / `call_ended` (connus, notification-only) → 200
 *         + log info, zéro accès DB.
 *       * `call_analyzed` (connu, valide) → 200 immédiat + traitement async.
 *       * Événement AUTHENTIFIÉ mais TYPE INCONNU (ex: `agent_created`,
 *         `phone_number_updated`, ou n'importe quel event que le fondateur
 *         activerait un jour dans le dashboard sans qu'on l'ait câblé ici)
 *         → 200 + log warn. Rejouer ne changerait rien : on ne le gère pas
 *         par choix, pas par erreur.
 *       * Événement CONNU mais PAYLOAD MALFORMÉ (schéma zod échoue sur
 *         `call_analyzed`) → 200 + log error. Rejouer un payload cassé ne
 *         le réparera pas — le rejeu ne ferait qu'amplifier le problème.
 *         On veut une alerte dans les logs, pas une boucle de retry.
 *
 *   Corollaire important : `WebhookValidationError` reste utilisée pour son
 *   pouvoir de description (`.message` compact), mais ce endpoint IGNORE
 *   son `.httpStatus` — c'est le route handler qui décide du code de retour,
 *   pas la classe d'erreur.
 *
 * Signature — session 2.2, bascule vers `retell-sdk` :
 *   La vérification n'est plus faite en interne. On appelle le SDK officiel
 *   via `verifyRetellSignature` qui délègue à `retell-sdk#verify`. Le secret
 *   utilisé est UNIQUEMENT `env.RETELL_API_KEY` (le concept de webhook
 *   secret séparé a disparu). L'accès au raw body vient toujours du
 *   callback `express.json({ verify })` câblé dans `src/index.ts`.
 *
 * Async :
 *   La vérification étant maintenant asynchrone (SDK Retell renvoie une
 *   Promise), le handler l'est aussi. Toute exception non catchée est
 *   remontée à Express — le error middleware standard renvoie 500. Pour
 *   nous, c'est mieux qu'un ack silencieux d'une requête cassée : Retell
 *   verra une erreur et la rejouera, ce qui nous laisse une seconde chance.
 */
import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { processCallAnalyzed } from '../services/appel.js';
import {
  RETELL_SIGNATURE_HEADER,
  parseRetellEvent,
  verifyRetellSignature,
} from '../services/retell.js';
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
  async (req: RawBodyRequest, res: Response): Promise<void> => {
    const rawBody = req.rawBody;
    const headerSig = req.header(RETELL_SIGNATURE_HEADER);

    if (!rawBody || rawBody.length === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    // 1. Signature — via SDK Retell officiel. Le secret est RETELL_API_KEY
    //    (env.ts refuse le boot s'il est absent, donc pas de guard runtime).
    //    Applique aux trois types d'événement.
    const signatureOk = await verifyRetellSignature(
      rawBody,
      headerSig,
      env.RETELL_API_KEY,
    );
    if (!signatureOk) {
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
    //
    // Two failure modes to distinguish, because they lead to different logs:
    //   a) authenticated call with an event TYPE we don't handle (e.g. a
    //      newly-enabled Retell event that isn't in our discriminated union)
    //   b) authenticated call with a KNOWN event type but a malformed body
    //      (schema validation failure on call_analyzed's strict shape)
    //
    // Both are acknowledged 200 per the policy documented in the file header
    // — retries would not help either case.
    const bodyEventName =
      typeof req.body === 'object' &&
      req.body !== null &&
      typeof (req.body as { event?: unknown }).event === 'string'
        ? (req.body as { event: string }).event
        : null;

    const KNOWN_EVENTS: ReadonlySet<string> = new Set([
      'call_started',
      'call_ended',
      'call_analyzed',
    ]);

    // Best-effort call_id extraction for correlation logging on the unknown-
    // event / malformed-payload paths. Never PII, always a Retell-internal id.
    const bodyCallId =
      typeof req.body === 'object' &&
      req.body !== null &&
      typeof (req.body as { call?: { call_id?: unknown } }).call === 'object' &&
      (req.body as { call?: { call_id?: unknown } }).call !== null &&
      typeof (req.body as { call: { call_id?: unknown } }).call.call_id ===
        'string'
        ? (req.body as { call: { call_id: string } }).call.call_id
        : null;

    if (bodyEventName === null || !KNOWN_EVENTS.has(bodyEventName)) {
      // Authenticated but event type is either missing or unknown to us.
      // Ack 200 so Retell does not retry an event we would never process.
      logger.warn(
        {
          event: bodyEventName,
          retell_call_id: bodyCallId,
        },
        'retell_webhook_unknown_event_acked',
      );
      res.status(200).json({ received: true, event: bodyEventName ?? null });
      return;
    }

    // Known event type: run the strict discriminated-union parse. A failure
    // here means Retell sent a malformed body for an event we DO handle —
    // still acknowledged 200 to prevent a retry storm on broken data.
    let event;
    try {
      event = parseRetellEvent(req.body as unknown);
    } catch (e) {
      if (e instanceof WebhookValidationError) {
        logger.error(
          {
            event: bodyEventName,
            retell_call_id: bodyCallId,
            err_msg: e.message,
          },
          'retell_webhook_payload_invalid_acked',
        );
        // NOTE: intentionally NOT using e.httpStatus (400). The route decides
        // the status; the class only supplies a compact message string.
        res.status(200).json({ received: true, event: bodyEventName });
        return;
      }
      throw e;
    }

    // 3. Route by event type.
    if (event.event === 'call_started' || event.event === 'call_ended') {
      // Notification-only events: log with correlation id, ack 200, no DB.
      logger.info(
        {
          retell_call_id: event.call.call_id,
          event: event.event,
        },
        'retell_webhook_notification_event',
      );
      res.status(200).json({ received: true, event: event.event });
      return;
    }

    // event.event === 'call_analyzed' — the only path that touches the DB.
    // Respond 200 immediately, then process in background.
    res.status(200).json({ received: true, event: event.event });

    // Fire-and-forget: we own retries via the jobs table. Any thrown error
    // is caught here and logged; Retell must NEVER see it.
    const payload = event;
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
