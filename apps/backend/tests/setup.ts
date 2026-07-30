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
