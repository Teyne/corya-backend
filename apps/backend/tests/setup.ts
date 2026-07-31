/**
 * Vitest global setup — injects fake env vars BEFORE any src/* module is
 * imported. This lets tests run without a real .env.local file.
 *
 * nLPD compliance (session 3.1 audit):
 *   - `src/config/env.ts` REFUSES to load `.env.local` when NODE_ENV = test.
 *     That means the values below MUST be sufficient on their own — the
 *     suite has to stay green with no .env.local present anywhere.
 *   - NEVER put real secrets in this file. Every value here is dummy,
 *     structurally valid (URL / email) but functionally inert. A pull
 *     request that adds a real secret to this file MUST be rejected.
 */
process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '3000'; // tests use supertest without listen(), value unused
process.env.APP_BASE_URL ??= 'http://localhost:3000';
process.env.LOG_LEVEL ??= 'silent';
process.env.CORS_ORIGIN ??= 'http://localhost:3001';

// -- Session 2 promotions: these are required at boot, dummy values suffice
// because tests either mock the DB layer or the SDK verifier. NEVER put
// real credentials here.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key-not-real';
// Optional Supabase creds — dummies so nothing from a real .env.local
// leaks into the test process. env.ts also no longer loads .env.local
// in test mode; this is defence in depth.
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key-not-real';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-not-real';

// Session 2.2 : bascule vers `retell-sdk`. Un seul secret désormais,
// obligatoire au boot (schema env.ts). RETELL_WEBHOOK_SECRET a disparu.
process.env.RETELL_API_KEY ??= 'test-retell-api-key-not-real';

// -- Session 3: worker + SMTP dummies. The SMTP block is entirely OPTIONAL
// at env boot, but individual tests may exercise `assertSmtpConfigured`
// which needs every field. Pre-populating them here keeps the SUITE
// self-contained; per-test overrides remain possible.
process.env.SMTP_HOST ??= 'smtp.test.local';
process.env.SMTP_PORT ??= '465';
process.env.SMTP_SECURE ??= 'true';
process.env.SMTP_USER ??= 'noreply@test.local';
process.env.SMTP_PASSWORD ??= 'test-smtp-password-not-real';
process.env.SMTP_FROM_NAME ??= 'Corya Test';
process.env.SMTP_FROM_EMAIL ??= 'noreply@test.local';

// Worker knobs — kept short so tests don't sleep.
process.env.WORKER_ID ??= 'test-worker';
process.env.JOB_POLL_INTERVAL_MS ??= '100';
process.env.JOB_BATCH_SIZE ??= '5';
process.env.ADMIN_APP_URL ??= 'http://localhost:3001';
