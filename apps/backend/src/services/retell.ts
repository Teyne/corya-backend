/**
 * Retell webhook signature verification + payload parsing.
 *
 * ---------------------------------------------------------------------------
 * Session 2.2 — BASCULE VERS LE SDK OFFICIEL `retell-sdk`.
 * ---------------------------------------------------------------------------
 *
 * Historique. Notre implémentation maison du HMAC n'a jamais pu être
 * validée sur du vrai trafic : les captures ngrok « reconstituées à la
 * main » depuis les copier-coller d'onglet ne sont pas garanties octet pour
 * octet, et un seul bit d'écart casse tout HMAC. Le résultat était un 401
 * systématique en production et 18 combinaisons `{secret, schema, encoding}`
 * qui rejetaient toutes la capture reconstituée — ce qui ne prouvait rien.
 *
 * Décision (fondateur, tranchée) : on arrête de réimplémenter un format
 * que Retell ne documente pas publiquement et on délègue au SDK officiel.
 * Retell utilise la clé API comme secret HMAC (il n'y a plus de webhook
 * secret séparé), donc on n'a plus qu'un seul secret dans l'environnement :
 * `RETELL_API_KEY`.
 *
 * Doc : https://docs.retellai.com/features/webhook-overview
 *
 * ---------------------------------------------------------------------------
 * API réelle du SDK, inspectée dans node_modules/retell-sdk/lib/webhook_auth.d.ts
 * ---------------------------------------------------------------------------
 *
 *   import { verify } from 'retell-sdk';
 *
 *   // Signature :
 *   //   verify(body: string, apiKey: string, signature: string) => Promise<boolean>
 *   //
 *   // - `body` est une CHAÎNE, pas un Buffer. On lui passe rawBody.toString('utf-8')
 *   //   pour rester octet-fidèle : le Buffer capturé par express.json({ verify })
 *   //   contient déjà les octets exacts reçus par Node, et toString('utf-8') est
 *   //   une bijection sur du JSON Retell (UTF-8 pur, pas de bytes invalides).
 *   // - `apiKey` = env.RETELL_API_KEY.
 *   // - `signature` = valeur brute de l'en-tête `X-Retell-Signature`.
 *   // - retourne une Promise<boolean> : false si signature mal formée, si le
 *   //   digest ne matche pas, ou si le timestamp est hors fenêtre (5 min par
 *   //   défaut côté SDK).
 *
 * Détail utile pour le futur : le SDK calcule HMAC-SHA256 sur `body + timestampMs`
 * (concaténation, timestamp EN FIN), et non `${timestampMs}.${body}` comme on
 * l'avait supposé. C'est exactement ce que notre implémentation maison ratait.
 *
 * ---------------------------------------------------------------------------
 * Anti-rejeu — contrôle CONDITIONNEL, défense en profondeur
 * ---------------------------------------------------------------------------
 *
 * On garde un contrôle de fraîcheur maison EN PLUS du SDK, mais avec un
 * garde-fou strict pour ne pas recréer le bug d'origine : notre ancien code
 * parsait `v=<ts>,d=<hex>` avant tout traitement et rejetait quand la forme
 * ne matchait pas. Si Retell change son format un jour (ex. `t=...,s=...`),
 * on rejetterait tout AVANT même d'appeler le SDK — on aurait migré sans
 * corriger le bug.
 *
 * Comportement exigé, implémenté ici :
 *   - Si le header suit la forme connue `v=<ts>,d=<hex>` → on parse le
 *     timestamp, on calcule la dérive et on rejette immédiatement (sans
 *     appeler le SDK) si on est hors fenêtre. Défense en profondeur.
 *   - Sinon → on log en DEBUG `signature format unrecognized for freshness
 *     check, delegating to SDK`, on NE rejette PAS, et on passe la main
 *     au SDK qui a sa propre vérification de fraîcheur.
 *
 * La sécurité réelle repose sur le SDK. Notre contrôle de fraîcheur n'est
 * qu'un bonus quand on peut l'appliquer.
 *
 * ---------------------------------------------------------------------------
 * Ce qui a été SUPPRIMÉ par cette bascule :
 *   - `getEffectiveRetellSecret()` (plus qu'un secret possible)
 *   - `RETELL_WEBHOOK_SECRET` (n'existe plus dans env.ts)
 *   - Le calcul HMAC maison (`createHmac(...)`) et la logique
 *     timing-safe : c'est le SDK qui s'en charge en interne.
 * ---------------------------------------------------------------------------
 */
import { verify as retellSdkVerify } from 'retell-sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { RetellSignatureError, WebhookValidationError } from '../utils/errors.js';
import type {
  RetellCallAnalyzed,
  RetellCallEnded,
  RetellCallStarted,
  RetellWebhookEvent,
} from '../types/index.js';

export const RETELL_SIGNATURE_HEADER = 'x-retell-signature';

/**
 * Regex de reconnaissance du format Retell CONNU. Volontairement strict :
 *   - `v=` littéral suivi de chiffres (timestamp ms)
 *   - `,d=` littéral
 *   - hex insensible à la casse, longueur variable (le SDK accepte upper et
 *     lower, longueur exacte 64 en pratique mais on ne l'impose pas ici — la
 *     vérification stricte de longueur est déléguée au SDK)
 *
 * Ce n'est PAS un filtre de sécurité : si la regex ne matche pas, on
 * délègue au SDK sans rejeter. Elle sert uniquement à savoir si on peut
 * ou non appliquer notre contrôle de fraîcheur bonus.
 */
const KNOWN_FORMAT_RE = /^v=(\d+),d=[0-9a-f]+$/i;

interface FreshnessCheckOptions {
  maxAgeSeconds?: number;
  nowMs?: number;
}

/**
 * Contrôle de fraîcheur CONDITIONNEL. Trois issues possibles :
 *   - `{ status: 'in_window' }`  → header reconnu ET fenêtre OK
 *   - `{ status: 'out_of_window', driftSeconds }` → header reconnu MAIS trop
 *     vieux/trop futur ; l'appelant DOIT rejeter avant d'appeler le SDK
 *   - `{ status: 'unrecognized' }` → format inconnu ; l'appelant DOIT
 *     déléguer au SDK sans rejeter
 *
 * Exporté pour être testable indépendamment. Ne dépend que de son argument
 * (aucun secret, aucun accès env) hors du fallback sur env.RETELL_SIGNATURE_MAX_AGE_SECONDS.
 */
export type FreshnessResult =
  | { status: 'in_window' }
  | { status: 'out_of_window'; driftSeconds: number; direction: 'past' | 'future' }
  | { status: 'unrecognized' };

export function checkFreshnessIfKnownFormat(
  headerValue: string | undefined,
  options?: FreshnessCheckOptions,
): FreshnessResult {
  if (!headerValue || headerValue.length === 0) {
    // Pas de header : on renvoie « unrecognized » plutôt que « out_of_window ».
    // Le SDK renverra false parce que la signature ne matche pas, ce qui
    // produira le 401 attendu. On évite d'avoir deux endroits qui décident
    // « il n'y a pas de header » avec des sémantiques divergentes.
    return { status: 'unrecognized' };
  }
  const match = KNOWN_FORMAT_RE.exec(headerValue.trim());
  if (!match) return { status: 'unrecognized' };

  const timestampMs = Number(match[1]);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    // Regex matche mais Number() dérape (improbable : chaîne de chiffres).
    // On considère ça comme « unrecognized » pour ne pas rejeter à tort.
    return { status: 'unrecognized' };
  }

  const maxAgeSeconds =
    options?.maxAgeSeconds ?? env.RETELL_SIGNATURE_MAX_AGE_SECONDS;
  const nowMs = options?.nowMs ?? Date.now();

  // Unités explicites : header en ms, on divise par 1000 pour comparer à
  // une fenêtre en SECONDES.
  const driftSeconds = (nowMs - timestampMs) / 1000; // signé
  if (Math.abs(driftSeconds) > maxAgeSeconds) {
    return {
      status: 'out_of_window',
      driftSeconds: Math.abs(driftSeconds),
      direction: timestampMs > nowMs ? 'future' : 'past',
    };
  }
  return { status: 'in_window' };
}

// Log au démarrage, EXACTEMENT une fois par process. Émis depuis le
// bootstrap (`src/index.ts` -> `logRetellSecretSourceOnce`). Le contenu du
// message est figé : le brief de la session 2.2 l'exige mot pour mot pour
// qu'il soit grep-able dans les logs Jelastic.
let secretSourceLogged = false;
export function logRetellSecretSourceOnce(): void {
  if (secretSourceLogged) return;
  secretSourceLogged = true;
  // Aucune donnée sensible : on ne logue ni la valeur ni la longueur du
  // secret, uniquement le NOM de la variable d'environnement utilisée.
  logger.info('Retell signature verification via SDK, secret = RETELL_API_KEY');
}

/** Test-only. Reset the once-flag so tests can observe the log path. */
export function __resetSecretSourceLoggedForTests(): void {
  secretSourceLogged = false;
}

/**
 * Vérifie une signature webhook Retell via le SDK officiel.
 *
 * Étapes :
 *   1. Contrôle de fraîcheur CONDITIONNEL : si le header suit la forme
 *      connue et que le timestamp est hors fenêtre, on rejette avant
 *      d'appeler le SDK (défense en profondeur). Si la forme est inconnue,
 *      on log en debug et on délègue au SDK sans rejeter.
 *   2. Appel de `retell-sdk#verify(body, apiKey, signature)`. Le SDK :
 *        - parse le header
 *        - calcule HMAC-SHA256(apiKey, body + timestampMs)
 *        - compare timing-safe
 *        - applique sa propre fenêtre de rejeu (5 min par défaut)
 *        et retourne un booléen.
 *   3. On propage ce booléen sans le transformer.
 *
 * Sécurité : aucune donnée sensible ne quitte cette fonction — ni le corps
 * de la requête, ni le secret, ni le contenu de la signature. Les warnings
 * ne contiennent que des métadonnées non identifiantes (présence du header,
 * dérive en secondes, direction).
 *
 * IMPORTANT — cette fonction est `async` (le SDK l'est). Tous les appelants
 * sont adaptés en conséquence dans `routes/webhooks.ts`.
 */
export async function verifyRetellSignature(
  rawBody: Buffer,
  headerSignature: string | undefined,
  secret: string,
  options?: FreshnessCheckOptions,
): Promise<boolean> {
  // 1. Contrôle de fraîcheur CONDITIONNEL (défense en profondeur).
  const freshness = checkFreshnessIfKnownFormat(headerSignature, options);
  if (freshness.status === 'out_of_window') {
    logger.warn(
      {
        drift_seconds: Math.round(freshness.driftSeconds),
        max_age_seconds:
          options?.maxAgeSeconds ?? env.RETELL_SIGNATURE_MAX_AGE_SECONDS,
        direction: freshness.direction,
      },
      'retell_signature_timestamp_out_of_window',
    );
    return false;
  }
  if (freshness.status === 'unrecognized') {
    logger.debug('signature format unrecognized for freshness check, delegating to SDK');
  }

  // 2. Délégation au SDK. Si le header est manquant/vide, le SDK renverra
  //    false — inutile d'ajouter un guard qui masquerait un comportement
  //    différent du SDK.
  //
  //    Le fondateur a explicitement demandé de passer la CHAÎNE (le SDK
  //    attend `body: string`, cf. webhook_auth.d.ts). rawBody.toString('utf-8')
  //    est octet-fidèle pour du JSON Retell (UTF-8 pur).
  const bodyStr = rawBody.toString('utf-8');
  const signatureStr = headerSignature ?? '';

  try {
    return await retellSdkVerify(bodyStr, secret, signatureStr);
  } catch (err) {
    // Le SDK peut throw si le runtime n'a pas Web Crypto (impossible sur
    // Node 20+, mais défense en profondeur). On ne relaye JAMAIS le message
    // du SDK dans un log — il pourrait, dans une version future, mentionner
    // le secret ou des fragments du corps. On logue uniquement le NOM de
    // l'erreur.
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown' },
      'retell_sdk_verify_threw',
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Payload schemas — one per event, plus a discriminated union.
// ---------------------------------------------------------------------------
//
// Retell emits THREE events per phone call:
//   1. `call_started`  — agent picked up, no transcript/analysis yet
//   2. `call_ended`    — call finished, still no analysis
//   3. `call_analyzed` — analysis finished, transcript + custom fields ready
//
// Only `call_analyzed` triggers our business logic. The other two are
// acknowledged with 200 and zero DB work.
//
// Schemas for `call_started` and `call_ended` are intentionally MINIMAL —
// we only validate what we log (call_id + call_type). Any unknown field is
// tolerated, so a Retell payload shape change on those two events cannot
// break us.

const callAnalyzedCallSchema = z.object({
  call_id: z.string().min(1),
  agent_id: z.string().min(1),
  call_type: z.enum(['phone_call', 'web_call']),
  call_status: z.string().min(1),
  from_number: z.string().min(1).optional(),
  to_number: z.string().min(1).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  start_timestamp: z.number().int().nonnegative(),
  end_timestamp: z.number().int().nonnegative().optional(),
  disconnect_reason: z.string().optional(),
  transcript: z.string().optional(),
  recording_url: z.string().url().optional(),
  public_log_url: z.string().url().optional(),
  call_analysis: z
    .object({
      call_summary: z.string().optional(),
      user_sentiment: z
        .enum(['Positive', 'Neutral', 'Negative', 'Unknown'])
        .optional(),
      call_successful: z.boolean().optional(),
      custom_analysis_data: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

const callAnalyzedSchema = z.object({
  event: z.literal('call_analyzed'),
  call: callAnalyzedCallSchema,
});

// Minimal schemas for the two "notification-only" events. `call_id` is what
// we log for correlation. Everything else is tolerated.
const minimalCallSchema = z
  .object({
    call_id: z.string().min(1),
    call_type: z.enum(['phone_call', 'web_call']).optional(),
  })
  .passthrough();

const callStartedSchema = z
  .object({
    event: z.literal('call_started'),
    call: minimalCallSchema,
  })
  .passthrough();

const callEndedSchema = z
  .object({
    event: z.literal('call_ended'),
    call: minimalCallSchema,
  })
  .passthrough();

const anyEventSchema = z.discriminatedUnion('event', [
  callStartedSchema,
  callEndedSchema,
  callAnalyzedSchema,
]);

/**
 * Parse a `call_analyzed` payload strictly. Throws WebhookValidationError
 * with a compact list of issue paths — never the offending value.
 */
export function parseRetellPayload(input: unknown): RetellCallAnalyzed {
  const result = callAnalyzedSchema.safeParse(input);
  if (!result.success) {
    const paths = result.error.issues
      .map((i) => i.path.join('.') || '<root>')
      .join(', ');
    throw new WebhookValidationError(`invalid_payload: ${paths}`);
  }
  return result.data satisfies RetellCallAnalyzed;
}

/**
 * Parse any of the three Retell events. Business logic in the route decides
 * what to do with each `event` value.
 */
export function parseRetellEvent(input: unknown): RetellWebhookEvent {
  const result = anyEventSchema.safeParse(input);
  if (!result.success) {
    const paths = result.error.issues
      .map((i) => i.path.join('.') || '<root>')
      .join(', ');
    throw new WebhookValidationError(`invalid_payload: ${paths}`);
  }
  // Discriminated-union narrowing: TS knows result.data matches one of the
  // three variants. The satisfies check keeps drift with the shared type
  // definition honest at compile time.
  return result.data satisfies
    | RetellCallStarted
    | RetellCallEnded
    | RetellCallAnalyzed;
}

/**
 * Convenience for tests: verify signature then parse. Throws
 * RetellSignatureError BEFORE any parsing so an invalid signature never
 * triggers zod overhead (or any log line containing payload fragments).
 *
 * Devient `async` par transitivité avec `verifyRetellSignature`.
 */
export async function verifyAndParse(
  rawBody: Buffer,
  headerSignature: string | undefined,
  secret: string,
  options?: FreshnessCheckOptions,
): Promise<RetellCallAnalyzed> {
  const ok = await verifyRetellSignature(rawBody, headerSignature, secret, options);
  if (!ok) {
    throw new RetellSignatureError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookValidationError('body_not_json');
  }
  return parseRetellPayload(parsed);
}
