/**
 * Supabase Storage helper — dedicated to the `pdf-recaps` private bucket.
 *
 * Contract enforced here:
 *   - Object path is DETERMINISTIC: `{cabinet_id}/{yyyy-mm}/{appel_id}.pdf`
 *     where `yyyy-mm` comes from `dateAppelIso` (NOT `Date.now()`). A retry
 *     that runs 6 h later must land on the same path, otherwise `upsert`
 *     would create a second file and orphan the first — a compliance leak
 *     (patient data survives past the J+30 PDF purge because the purge
 *     targets `appels.pdf_url` and misses the second copy).
 *
 *   - Upload uses `upsert: true`. Idempotence at the Storage layer means a
 *     retry after a partial upload doesn't fail with a 409 collision.
 *
 *   - Signed URLs are capped at 60 seconds and are consumed server-side by
 *     the authenticated Portal BFF. They are never exposed to a browser or
 *     email client.
 *
 *   - `ensureBucketAccessible()` runs at worker boot to fail LOUDLY if the
 *     bucket is missing or the service role can't reach it. Discovering
 *     this on the first live webhook would kill the SLA silently.
 */
import { getServiceClient } from '../config/supabase.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { withTimeout } from '../utils/timeout.js';

/** Bucket name — mirrors the migration. Constant on purpose. */
export const PDF_BUCKET = 'pdf-recaps';

/** Max signed URL lifetime we ever grant (compliance-hard). */
export const MAX_SIGNED_URL_TTL_SECONDS = 60;

/** Default server-to-server ticket lifetime. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60;

/**
 * Compute the Storage object path for a given appel.
 *
 * `dateAppelIso` MUST be the persisted `appels.date_appel` (or the same
 * value used at insert time). This guarantees the path is stable across
 * retries — see file-level rationale.
 */
export function buildPdfObjectPath(
  cabinetId: string,
  appelId: string,
  dateAppelIso: string,
): string {
  const d = new Date(dateAppelIso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid_date_appel_iso: ${dateAppelIso}`);
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${cabinetId}/${yyyy}-${mm}/${appelId}.pdf`;
}

/**
 * Boot-time sanity check. Called ONCE by the worker at startup so an
 * obvious misconfiguration (bucket typo, service role missing Storage
 * permissions) surfaces before the first webhook lands.
 *
 * Uses the `listBuckets` endpoint which the service role can always call
 * even when RLS is fully enabled on `storage.objects`.
 */
export async function ensureBucketAccessible(): Promise<void> {
  const supabase = getServiceClient();
  const { data, error } = await withTimeout(
    supabase.storage.listBuckets(),
    env.TIMEOUT_STORAGE_MS,
    'storage:listBuckets',
  );
  if (error) {
    throw new Error(
      `storage_list_buckets_failed: ${error.message} — check SUPABASE_SERVICE_KEY has Storage access`,
    );
  }
  const found = (data ?? []).some((b) => b.name === PDF_BUCKET);
  if (!found) {
    throw new Error(
      `storage_bucket_missing: "${PDF_BUCKET}" not found. Apply migration supabase/migrations/20260730120000_initial_schema.sql`,
    );
  }
  logger.info({ bucket: PDF_BUCKET }, 'storage_bucket_accessible');
}

/**
 * Upload a PDF buffer to the private bucket at the given object path.
 * Overwrites any existing object at that path (`upsert: true`) so a retry
 * after a crashed upload doesn't wedge on a 409.
 *
 * The returned `objectPath` is what should be persisted to
 * `appels.pdf_url` — NEVER the signed URL.
 */
export async function uploadPdf(
  objectPath: string,
  pdfBytes: Buffer | Uint8Array,
): Promise<{ objectPath: string }> {
  const supabase = getServiceClient();
  // Session 4 vague 3: bound the upload. supabase-js's storage client
  // does not expose an AbortController on `.upload()` — the timeout
  // rejection frees our worker slot but the underlying request may
  // still complete in the background. Acceptable: upsert:true means a
  // late completion is either a no-op or overwrites with identical bytes.
  const { error } = await withTimeout(
    supabase.storage.from(PDF_BUCKET).upload(objectPath, pdfBytes, {
      contentType: 'application/pdf',
      upsert: true,
    }),
    env.TIMEOUT_STORAGE_MS,
    'storage:upload',
  );
  if (error) {
    throw new Error(`storage_upload_failed: ${error.message}`);
  }
  return { objectPath };
}

/**
 * Create a signed URL for the given object. `ttlSeconds` is clamped to
 * `MAX_SIGNED_URL_TTL_SECONDS` (60 seconds) — a caller cannot accidentally
 * grant a long-lived URL.
 */
export async function createSignedPdfUrl(
  objectPath: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  const clamped = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_SIGNED_URL_TTL_SECONDS);
  const supabase = getServiceClient();
  const { data, error } = await withTimeout(
    supabase.storage.from(PDF_BUCKET).createSignedUrl(objectPath, clamped),
    env.TIMEOUT_STORAGE_MS,
    'storage:createSignedUrl',
  );
  if (error || !data) {
    throw new Error(`storage_sign_url_failed: ${error?.message ?? 'no_data'}`);
  }
  return data.signedUrl;
}

/** Physically remove a PDF object. An already-absent object is success. */
export async function deleteStoredPdf(
  bucket: string,
  objectPath: string,
): Promise<'deleted' | 'not_found'> {
  if (bucket !== PDF_BUCKET) throw new Error('storage_delete_unsupported_bucket');
  const objects = getServiceClient().storage.from(bucket);
  const existsResult = await withTimeout(
    objects.exists(objectPath),
    env.TIMEOUT_STORAGE_MS,
    'storage:exists',
  );
  if (existsResult.error) {
    throw new Error(`storage_exists_failed: ${existsResult.error.message}`);
  }
  if (!existsResult.data) return 'not_found';

  const { error } = await withTimeout(
    objects.remove([objectPath]),
    env.TIMEOUT_STORAGE_MS,
    'storage:remove',
  );
  if (error) throw new Error(`storage_delete_failed: ${error.message}`);
  return 'deleted';
}
