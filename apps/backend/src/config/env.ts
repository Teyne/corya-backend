/**
 * Environment variable loading & validation.
 *
 * Loads dotenv from (in order, non-fatal if missing):
 *   1. apps/backend/.env.local  (backend-specific overrides)
 *   2. <monorepo-root>/.env.local  (two levels up)
 *
 * Then validates every variable via zod. On failure, prints a lisible list
 * of invalid fields — NEVER the offending value — and exits with code 1.
 *
 * ---------------------------------------------------------------------------
 * Promotion log (variables that started optional in session 1):
 *   - session 2 (Retell webhook):
 *       * SUPABASE_URL          -> REQUIRED (queries.ts uses it)
 *       * SUPABASE_SERVICE_KEY  -> REQUIRED (queries.ts uses it)
 *   - session 2.1 (real Retell traffic captured via ngrok):
 *       * RETELL_SIGNATURE_MAX_AGE_SECONDS added (default 300).
 *   - session 2.2 (bascule vers le SDK officiel `retell-sdk`):
 *       * RETELL_WEBHOOK_SECRET SUPPRIMÉ. Retell utilise la clé API comme
 *         secret HMAC — le SDK officiel et la doc ne connaissent qu'un seul
 *         secret. On garde uniquement RETELL_API_KEY, désormais REQUIS. La
 *         superRefine « au moins l'un des deux » disparaît par la même
 *         occasion.
 *   SMTP + SUPABASE_ANON_KEY + SUPABASE_JWT_SECRET remain optional until
 *   their respective subsystems land.
 * ---------------------------------------------------------------------------
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try to load env files in priority order. `override: false` keeps whatever
// the shell already exported. Missing files are silently ignored.
//
// nLPD compliance (session 3.1 audit): in TEST mode we DO NOT load
// `.env.local`. Real SMTP passwords / Supabase keys would otherwise sit
// in-process during the test run — harmless when tests mock the DB and
// SMTP (as ours do), but a stray console.log or a crash dump on CI would
// exfiltrate them. Tests supply dummy values via `tests/setup.ts` and MUST
// remain green without any .env.local present.
const backendRoot = resolve(__dirname, '..', '..'); // apps/backend
const monorepoRoot = resolve(backendRoot, '..', '..'); // <repo root>

if (process.env.NODE_ENV !== 'test') {
  for (const candidate of [
    resolve(backendRoot, '.env.local'),
    resolve(monorepoRoot, '.env.local'),
  ]) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate, override: false });
    }
  }
}

const booleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const httpsUrl = z.string().url().superRefine((value, ctx) => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    ctx.addIssue({ code: 'custom', message: 'must be an HTTPS URL without userinfo' });
  }
});

const envSchema = z.object({
  // ---- Core (required, with sane defaults) ----
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGIN: z
    .string()
    .min(1, 'CORS_ORIGIN must be a comma-separated list of allowed origins')
    .default('http://localhost:3001'),

  // ---- Supabase (promoted in session 2 — see header) ----
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  // ---- Retell AI --------------------------------------------------------
  // La bascule vers `retell-sdk` (session 2.2) a supprimé l'ambiguïté :
  // Retell n'expose plus qu'un seul secret HMAC, la clé API. Elle est
  // maintenant REQUISE au boot — sans elle, aucune vérification de
  // signature n'est possible et il vaut mieux refuser de démarrer plutôt
  // que d'accepter n'importe quelle requête en silence.
  RETELL_API_KEY: z.string().min(1),
  // Anti-replay window in SECONDS (bidirectional). 5 min default matches
  // Retell's own guidance and Stripe convention. Bounded to avoid a typo
  // silently disabling replay protection.
  //
  // NB : notre contrôle de fraîcheur est CONDITIONNEL — il ne s'applique
  // que lorsque le header suit la forme documentée `v=<ts>,d=<hex>` (voir
  // services/retell.ts). Quand la forme change (retell modifie son schéma),
  // on délègue silencieusement au SDK qui a sa propre fenêtre de rejeu.
  RETELL_SIGNATURE_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(300),

  // ---- Cal.com webhook registry ---------------------------------------
  // Dedicated HMAC secret configured on the Cal.com webhook subscription.
  // It is deliberately distinct from the Cal.com API key used by Retell.
  // Optional in dev/test; the production API preflight makes it mandatory.
  CALCOM_WEBHOOK_SECRET: z.string().min(32).optional(),
  // Temporary bridge credential for the controlled demonstration cabinet.
  // Production cabinet connections will use OAuth tokens stored through
  // Supabase Vault; this value must never be used as a multi-tenant registry.
  CALCOM_DEMO_API_KEY: z.string().min(1).optional(),
  CALCOM_DEMO_CABINET_ID: z.string().uuid().optional(),
  CALCOM_DEMO_FALLBACK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Public OAuth client: PKCE replaces a client secret. All three variables
  // are optional as a group outside configured environments.
  CALCOM_OAUTH_CLIENT_ID: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/u).optional(),
  CALCOM_OAUTH_REDIRECT_URI: httpsUrl.optional(),
  CALCOM_PORTAL_RETURN_URL: httpsUrl.optional(),

  // ---- SMTP Infomaniak (optional in session 1, promote when email lands) ----
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).optional(),
  SMTP_SECURE: booleanString.optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM_NAME: z.string().min(1).optional(),
  SMTP_FROM_EMAIL: z.string().email().optional(),

  // ---- Runtime nLPD retention window ----
  // Transcript/appel retention periods are fixed in SQL migrations and are
  // intentionally not exposed as environment configuration.
  AUDIO_RETENTION_HOURS: z.coerce.number().int().positive().max(72).default(48),

  // ---- Worker (session 3 — post-call pipeline: PDF -> upload -> email) ----
  // Optional stable identifier for a worker instance. Written to jobs.locked_by
  // when a job is claimed so a stuck-worker inspection tells you which node was
  // running it. Auto-generated if not provided.
  WORKER_ID: z.string().min(1).optional(),
  // How often the worker polls the DB for new jobs. Kept low because Retell
  // gives us a ~10s budget end-to-end for the email; a slow poll would push
  // the SLA on its own. After a non-empty batch the worker re-drains
  // immediately without waiting for this interval.
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  // How many jobs the worker claims in a single RPC call. Bounded by DB row
  // lock contention: 5 gives us parallelism without holding too many locks.
  JOB_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  // Separate physical-deletion outbox loop. Its own cadence and stale
  // threshold prevent a healthy jobs loop from masking a stuck purge loop.
  FILE_DELETION_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  FILE_DELETION_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  FILE_DELETION_STALE_AFTER_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  // URL prefix the email links point to for a "view details" call-to-action
  // in the admin back-office. Falls back to APP_BASE_URL when the back-office
  // still runs on the same origin as the API (dev).
  ADMIN_APP_URL: z.string().url().default('http://localhost:3001'),

  // ---- Session 4 — worker resilience + alerting ----
  // How long a `processing` job may stay locked before claim_jobs reclaims
  // it as a zombie. Kept SHORTER than requeue_stuck_jobs' 10-min filet so
  // opportunistic reclaim happens first — see migration 20260801000000.
  JOB_STALE_AFTER_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(300),
  // Alive-heartbeat tick period. INDEPENDENT of the polling loop so a job
  // that pends does not silence the "process alive" signal.
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(10_000),
  // Alerting threshold on `worker_heartbeats.last_seen_at`. If the API
  // poller sees a worker whose alive-tick is older than this, it fires a
  // `worker_stale` alert. `last_poll_at` uses a longer threshold (180 s)
  // hard-coded in the poller — it's not a knob, it's a design decision
  // (see services/alert-pollers.ts).
  WORKER_STALE_THRESHOLD_SECONDS: z.coerce
    .number()
    .int()
    .min(15)
    .max(3600)
    .default(60),
  // Above this count of `pending` jobs older than 5 min, fire `jobs_backlog`.
  JOBS_BACKLOG_ALERT_THRESHOLD: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(20),
  // Recipient of ops alerts. REQUIRED in production only (superRefine below)
  // so `npm run dev`, tests and the founder's local shell keep booting when
  // it's absent from .env.local. Empty string is normalised to `undefined`
  // so the alerting layer can key its "no recipient configured" branch off
  // a single check.
  ALERT_EMAIL: z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? undefined : v))
    .pipe(z.string().email().optional())
    .optional(),
  // Anti-spam window for the in-memory alert deduper. A worker looping on a
  // deterministic error must NOT flood the inbox — 1 alert per type per
  // window. 15 min is short enough that a real, sustained outage keeps
  // pinging (about 4 emails/hour), long enough that we don't self-DDoS
  // the SMTP outbox on a hot loop.
  ALERT_DEDUP_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1_000)
    .default(15 * 60 * 1_000),
  // Master switch. Kept as a boolean-shaped env var (not just "unset") so a
  // future ops incident can silence alerts INTENTIONALLY without editing
  // config elsewhere. When false, a WARN log is emitted at API AND worker
  // boot — hard requirement of the founder. Default applied to the STRING
  // side of the transform so the type inferred stays `boolean`.
  ALERT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ---- Session 4 vague 3 — timeouts on external I/O ----
  // Every external call is bounded. Missing timeouts historically let a
  // hung Supabase request pin a worker slot indefinitely — see
  // src/utils/timeout.ts and the audit trail in each service file.
  TIMEOUT_DB_MS: z.coerce.number().int().min(200).max(60_000).default(5_000),
  TIMEOUT_AUTH_MS: z.coerce.number().int().min(200).max(30_000).default(3_000),
  TIMEOUT_STORAGE_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  TIMEOUT_PDF_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  TIMEOUT_SMTP_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  TIMEOUT_RETELL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  TIMEOUT_CALCOM_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  // ---- Session 4 vague 3 — SMTP internal retry policy ----
  // Number of internal attempts INSIDE a single email job. Once exhausted
  // the caller either lets the outer job retry (transient) or forces
  // dead_letter (permanent) — see services/email.ts classifier.
  SMTP_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Delays between internal attempts, in ms, as a comma-separated list.
  // Length must be >= SMTP_RETRY_ATTEMPTS - 1 (the FIRST attempt is
  // immediate, subsequent attempts consume delays in order). Zod parses
  // and validates the list eagerly.
  // ---- Session 4 vague 4 — health + rate limiting ----
  // Bearer-like token protecting /health/deep. Optional in dev/test so
  // `npm run dev` boots without wiring monitoring; required in production
  // (see superRefine below). NEVER logged, NEVER echoed to responses.
  HEALTH_DEEP_TOKEN: z.string().min(16).optional(),
  // TTL (ms) of the in-memory /health/deep cache. Prevents a monitor loop
  // from hammering real Storage + DB connections.
  HEALTH_DEEP_CACHE_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  // Global fixed-window rate limit for /webhooks/*. NOT per IP — see
  // src/middleware/rate-limit.ts for rationale (Retell IP pool is small
  // and the real defence is the SDK signature verify).
  RATE_LIMIT_WEBHOOK_MAX: z.coerce.number().int().min(1).max(100_000).default(300),
  RATE_LIMIT_WEBHOOK_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1_000)
    .default(60_000),
  // Number of trusted reverse-proxy hops (Jelastic front). Numeric value
  // only — Express `trust proxy: true` blindly trusts every hop and is
  // never appropriate here. Kept even without an IP-scoped rate limit so
  // pino-http logs the real client IP instead of the proxy address.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  SMTP_RETRY_DELAYS_MS: z
    .string()
    .default('1000,5000,30000')
    .transform((s, ctx) => {
      const parts = s
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const out: number[] = [];
      for (const raw of parts) {
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 600_000) {
          ctx.addIssue({
            code: 'custom',
            message: `SMTP_RETRY_DELAYS_MS: invalid delay "${raw}" (must be integer ms in [0, 600000])`,
          });
          return z.NEVER;
        }
        out.push(n);
      }
      if (out.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'SMTP_RETRY_DELAYS_MS: must contain at least one delay',
        });
        return z.NEVER;
      }
      return out;
    }),
})
  .superRefine((v, ctx) => {
    const oauthConfigured = [
      v.CALCOM_OAUTH_CLIENT_ID,
      v.CALCOM_OAUTH_REDIRECT_URI,
      v.CALCOM_PORTAL_RETURN_URL,
    ];
    if (oauthConfigured.some((value) => value !== undefined)
      && oauthConfigured.some((value) => value === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CALCOM_OAUTH_CLIENT_ID'],
        message: 'Cal.com OAuth client id, redirect URI and portal return URL must be configured together',
      });
    }
    if (v.CALCOM_OAUTH_REDIRECT_URI !== undefined) {
      const redirect = new URL(v.CALCOM_OAUTH_REDIRECT_URI);
      if (redirect.pathname !== '/oauth/calcom/callback' || redirect.search || redirect.hash) {
        ctx.addIssue({
          code: 'custom',
          path: ['CALCOM_OAUTH_REDIRECT_URI'],
          message: 'must use the exact /oauth/calcom/callback path without query or fragment',
        });
      }
    }
    if (v.CALCOM_PORTAL_RETURN_URL !== undefined) {
      const portal = new URL(v.CALCOM_PORTAL_RETURN_URL);
      const allowedOrigins = v.CORS_ORIGIN.split(',').map((origin) => origin.trim());
      if (!allowedOrigins.includes(portal.origin) || portal.search || portal.hash) {
        ctx.addIssue({
          code: 'custom',
          path: ['CALCOM_PORTAL_RETURN_URL'],
          message: 'must use an allowlisted CORS origin without query or fragment',
        });
      }
    }
    // Production must have an alert recipient wired. Anywhere else the
    // ops team can (temporarily) run without one.
    if (v.NODE_ENV === 'production' && v.ALERT_EMAIL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALERT_EMAIL'],
        message: 'ALERT_EMAIL is required in production',
      });
    }
    // The delays list must cover EVERY inter-attempt gap. Attempt 1 fires
    // immediately, then N-1 gaps are consumed in order. A shorter list
    // means we would call `delays[undefined]` — surface it at boot, not
    // at the first SMTP outage.
    if (v.SMTP_RETRY_DELAYS_MS.length < v.SMTP_RETRY_ATTEMPTS - 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_RETRY_DELAYS_MS'],
        message: `SMTP_RETRY_DELAYS_MS needs at least ${v.SMTP_RETRY_ATTEMPTS - 1} entries for SMTP_RETRY_ATTEMPTS=${v.SMTP_RETRY_ATTEMPTS}`,
      });
    }
    // /health/deep MUST be protected in production. Empty token in dev is
    // fine (endpoint stays reachable behind the "give me the value" hurdle
    // via the localhost network boundary during npm run dev).
    if (v.NODE_ENV === 'production' && v.HEALTH_DEEP_TOKEN === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['HEALTH_DEEP_TOKEN'],
        message: 'HEALTH_DEEP_TOKEN is required in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function parseEnvOrDie(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  // Compose a compliance-safe error message: field names + issue only,
  // never the offending value (which may be a secret).
  const issues = parsed.error.issues
    .map((issue) => {
      const path = issue.path.join('.') || '<root>';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');

  // Using console.error is allowed by our eslint config; this fires before
  // the logger is initialized, so we cannot yet use pino.
  console.error(
    `[env] Invalid environment configuration. Fix the following fields:\n${issues}`,
  );
  process.exit(1);
}

/**
 * Fully-typed, frozen environment object. Import this everywhere instead of
 * reading process.env directly.
 */
export const env: Readonly<Env> = Object.freeze(parseEnvOrDie());
