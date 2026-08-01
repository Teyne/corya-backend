/**
 * Vitest config for the end-to-end suite (session 4 vague 5, bloc 9).
 *
 * The e2e suite is DELIBERATELY isolated from the unit/integration suite:
 *   - Different `include` pattern (`tests/e2e/**`) — `npm test` never
 *     picks these up by accident.
 *   - Longer default timeout (30 s) — an e2e that walks the worker loop
 *     needs more headroom than a pure unit test.
 *   - Same `tests/setup.ts` — dummy env vars, no .env.local read (a
 *     stray production secret must not leak into an e2e process either).
 *
 * These tests use the FAKE nodemailer transporter via `__setTransporterForTests`
 * and mock supabase-js at the queries layer. They NEVER open a real SMTP
 * socket, NEVER touch a real Supabase project. Safe to run from any
 * developer machine.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/e2e/**/*.e2e.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    // Run e2e tests sequentially: the shared in-memory job store below is
    // mutated by each test file. Concurrent files would race on it.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
