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
const backendRoot = resolve(__dirname, '..', '..'); // apps/backend
const monorepoRoot = resolve(backendRoot, '..', '..'); // <repo root>

for (const candidate of [
  resolve(backendRoot, '.env.local'),
  resolve(monorepoRoot, '.env.local'),
]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
  }
}

const booleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

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

  // ---- SMTP Infomaniak (optional in session 1, promote when email lands) ----
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).optional(),
  SMTP_SECURE: booleanString.optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM_NAME: z.string().min(1).optional(),
  SMTP_FROM_EMAIL: z.string().email().optional(),

  // ---- nLPD retention windows (optional, have defaults matching compliance.md) ----
  AUDIO_RETENTION_HOURS: z.coerce.number().int().positive().max(72).default(48),
  TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().positive().max(30).default(7),
  APPEL_RETENTION_MONTHS: z.coerce.number().int().positive().max(60).default(24),
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
