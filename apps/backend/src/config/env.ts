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
 * Session-1 note (backend scaffold):
 *   Supabase / Retell / SMTP variables are declared OPTIONAL here so the
 *   server can boot without them. As each subsystem is implemented in a
 *   later session, the corresponding fields MUST be promoted to required.
 *   Track the promotions in this file's header when you do it.
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

  // ---- Supabase (optional in session 1, promote in session covering DB) ----
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  // ---- Retell AI (optional in session 1, promote when webhook lands) ----
  RETELL_API_KEY: z.string().min(1).optional(),
  RETELL_WEBHOOK_SECRET: z.string().min(1).optional(),

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
