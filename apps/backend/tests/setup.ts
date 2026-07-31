/**
 * Vitest global setup — injects fake env vars BEFORE any src/* module is
 * imported. This lets tests run without a real .env.local file.
 *
 * Never put real secrets in this file. The values below are dummy strings
 * that are structurally valid (URL / email) but functionally inert.
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
// Session 2.2 : bascule vers `retell-sdk`. Un seul secret désormais,
// obligatoire au boot (schema env.ts). RETELL_WEBHOOK_SECRET a disparu.
process.env.RETELL_API_KEY ??= 'test-retell-api-key-not-real';
