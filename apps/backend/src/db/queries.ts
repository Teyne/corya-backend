/**
 * Typed DB access — the ONLY module that talks to Supabase.
 *
 * Everything else calls into these functions. That keeps compliance-sensitive
 * work (RLS bypass via service role, insertion of PII columns) inside one
 * reviewable surface.
 *
 * All functions return plain JS types or `null` (for "not found"). They
 * throw only on truly unexpected DB errors, never on empty result sets.
 */
import { getServiceClient } from '../config/supabase.js';
import type { AppelInsertRow, JobInsertRow } from '../types/index.js';

export interface CabinetRow {
  id: string;
  numero_corya: string;
  email_notification: string;
}

/**
 * Find the cabinet whose Corya-assigned number matches `toNumber`.
 * Returns null if no cabinet is mapped — the webhook route logs a warn and
 * still answers 200 so Retell never retries.
 */
export async function findCabinetByCoryaNumber(
  toNumber: string,
): Promise<CabinetRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('cabinets')
    .select('id, numero_corya, email_notification')
    .eq('numero_corya', toNumber)
    .eq('statut', 'actif')
    .maybeSingle<CabinetRow>();

  if (error) {
    throw new Error(`db_find_cabinet_failed: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Idempotent insert of an `appels` row.
 *
 * Uses the `retell_call_id` unique constraint for de-duplication. On
 * conflict we do NOT update the row — a replayed webhook must be a no-op.
 *
 * Return value:
 *   - `{ appelId, duplicate: false }` if the row was actually inserted
 *   - `{ appelId, duplicate: true  }` if a row with the same
 *                                       retell_call_id already existed
 */
export async function insertAppelIdempotent(
  row: AppelInsertRow,
): Promise<{ appelId: string; duplicate: boolean }> {
  const supabase = getServiceClient();

  // supabase-js has no "INSERT ... ON CONFLICT DO NOTHING RETURNING id" in a
  // single call. We simulate it in two steps: try the insert, if unique-
  // violation then look up the existing row. That keeps our behaviour
  // idempotent without needing a stored proc.
  const { data, error } = await supabase
    .from('appels')
    .insert(row)
    .select('id')
    .single<{ id: string }>();

  if (!error && data) {
    return { appelId: data.id, duplicate: false };
  }

  // Postgres unique_violation. Supabase surfaces it as code '23505'.
  if (error && error.code === '23505') {
    const { data: existing, error: lookupErr } = await supabase
      .from('appels')
      .select('id')
      .eq('retell_call_id', row.retell_call_id)
      .single<{ id: string }>();
    if (lookupErr || !existing) {
      throw new Error(
        `db_insert_appel_conflict_but_lookup_failed: ${lookupErr?.message ?? 'no_row'}`,
      );
    }
    return { appelId: existing.id, duplicate: true };
  }

  throw new Error(`db_insert_appel_failed: ${error?.message ?? 'unknown'}`);
}

/**
 * Enqueue a job. The `(type, appel_id) WHERE status IN ('pending',
 * 'processing')` unique partial index enforces that a job can't be enqueued
 * twice while active. If we hit that conflict, the intent is already in
 * flight — return silently instead of surfacing an error.
 *
 * Returns true if a new row was inserted, false if a duplicate was skipped.
 */
export async function enqueueJobIdempotent(row: JobInsertRow): Promise<boolean> {
  const supabase = getServiceClient();
  const { error } = await supabase.from('jobs').insert(row);

  if (!error) return true;
  if (error.code === '23505') {
    // Already queued or being processed. Idempotent success.
    return false;
  }
  throw new Error(`db_enqueue_job_failed: ${error.message}`);
}
