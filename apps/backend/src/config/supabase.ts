/**
 * Supabase client — service-role. Bypasses RLS by design.
 *
 * This module MUST be imported only from `src/db/queries.ts`. The rest of
 * the codebase talks to the DB through the query layer so that:
 *   - types stay in one place
 *   - service-role credentials never leak into request handlers
 *   - future swap to a queue-based DB access stays localised
 *
 * The env variable is `SUPABASE_SERVICE_KEY` (as promoted to required in
 * `env.ts`). Do NOT rename it to SUPABASE_SERVICE_ROLE_KEY without
 * coordinating with the database-compliance agent.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Lazily-built service-role client. Lazy because at test time we mock the
 * `queries` module entirely and never touch this client — so we don't want
 * to require real Supabase env vars just to load the module.
 */
let cached: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cached) return cached;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error(
      'Supabase service client requested but SUPABASE_URL / SUPABASE_SERVICE_KEY are not set',
    );
  }
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: {
      // Backend context: no browser session, no token refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cached;
}

/** Test-only: drop the cached client so tests can rebuild it. */
export function __resetForTests(): void {
  cached = null;
}
