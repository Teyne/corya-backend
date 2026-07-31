/**
 * test-email-pipeline.ts
 * ----------------------------------------------------------------------------
 * Manual end-to-end test of the post-call pipeline: PDF -> Storage -> email.
 * Sends a REAL email to teyne17@gmail.com.
 *
 * Idempotent by design:
 *   - The test cabinet is looked up (or inserted) by `slug = 'cabinet-test-corya'`.
 *   - The test appel is looked up (or inserted) by `retell_call_id =
 *     'test_call_pipeline'`.
 *   - Both use the natural unique keys already enforced by the schema.
 *   - Running the script twice reuses the same rows; the pipeline itself is
 *     idempotent (see appel-processor.ts) so a second run does NOT send a
 *     duplicate email (email_status = 'sent' short-circuits).
 *
 * Usage:
 *   npm run test:email-pipeline
 *   npm run test:email-pipeline -- --force-resend     (bypass email_status)
 *
 * Requires .env.local (repo root or apps/backend) with valid SUPABASE_* and
 * SMTP_* values.
 */
import { assertSmtpConfigured, closeTransporter } from '../src/services/email.js';
import { closeBrowser } from '../src/services/pdf.js';
import { ensureBucketAccessible } from '../src/services/storage.js';
import { getServiceClient } from '../src/config/supabase.js';
import { logger } from '../src/config/logger.js';
import { processAppelJob } from '../src/services/appel-processor.js';
import type { Job, ProcessAppelPayload } from '../src/types/index.js';

const TEST_CABINET_SLUG = 'cabinet-test-corya';
const TEST_RETELL_CALL_ID = 'test_call_pipeline';
const TEST_RECIPIENT = 'teyne17@gmail.com';

interface TestCabinetRow {
  id: string;
  nom: string;
  email_notification: string;
}
interface TestAppelRow {
  id: string;
  cabinet_id: string;
  email_status: string;
}

/** Ensure the test cabinet exists. Returns its id. */
async function ensureTestCabinet(): Promise<TestCabinetRow> {
  const supabase = getServiceClient();

  // Try to find it first.
  const { data: existing, error: findErr } = await supabase
    .from('cabinets')
    .select('id, nom, email_notification')
    .eq('slug', TEST_CABINET_SLUG)
    .maybeSingle<TestCabinetRow>();
  if (findErr) throw new Error(`test_cabinet_lookup_failed: ${findErr.message}`);
  if (existing) {
    // Refresh the notification email in case the operator updated it.
    if (existing.email_notification !== TEST_RECIPIENT) {
      const { error: updateErr } = await supabase
        .from('cabinets')
        .update({ email_notification: TEST_RECIPIENT, statut: 'actif' })
        .eq('id', existing.id);
      if (updateErr) {
        throw new Error(`test_cabinet_update_failed: ${updateErr.message}`);
      }
      existing.email_notification = TEST_RECIPIENT;
    }
    return existing;
  }

  // Insert.
  const insertRow = {
    nom: 'Cabinet Test Corya (pipeline)',
    slug: TEST_CABINET_SLUG,
    type_cabinet: 'physio',
    email_notification: TEST_RECIPIENT,
    statut: 'actif',
    // numero_corya kept null on purpose — the pipeline doesn't need it.
  };
  const { data, error } = await supabase
    .from('cabinets')
    .insert(insertRow)
    .select('id, nom, email_notification')
    .single<TestCabinetRow>();
  if (error) throw new Error(`test_cabinet_insert_failed: ${error.message}`);
  return data;
}

/** Ensure the test appel exists. Returns its id. */
async function ensureTestAppel(
  cabinetId: string,
  forceResend: boolean,
): Promise<TestAppelRow> {
  const supabase = getServiceClient();

  const { data: existing, error: findErr } = await supabase
    .from('appels')
    .select('id, cabinet_id, email_status')
    .eq('retell_call_id', TEST_RETELL_CALL_ID)
    .maybeSingle<TestAppelRow>();
  if (findErr) throw new Error(`test_appel_lookup_failed: ${findErr.message}`);
  if (existing) {
    if (forceResend && existing.email_status === 'sent') {
      // Reset the flag so the pipeline actually re-sends the email.
      const { error: resetErr } = await supabase
        .from('appels')
        .update({ email_status: 'pending', pdf_envoye_at: null })
        .eq('id', existing.id);
      if (resetErr) {
        throw new Error(`test_appel_reset_failed: ${resetErr.message}`);
      }
      existing.email_status = 'pending';
    }
    return existing;
  }

  const now = new Date();
  const row = {
    cabinet_id: cabinetId,
    retell_call_id: TEST_RETELL_CALL_ID,
    date_appel: now.toISOString(),
    duree_secondes: 96,
    resultat: 'rdv_pris',
    motif_appel: 'Test manuel du pipeline post-appel',
    patient_nom: 'Fictive',
    patient_prenom: 'Test-Prénom',
    patient_telephone: '+41 78 000 00 00',
    rdv_date: new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString(),
    rdv_praticien: 'M. Testeur',
    transcript:
      'Agent: Bonjour, cabinet Corya test.\n' +
      'User: Bonjour, je souhaite prendre rendez-vous.\n' +
      'Agent: Pour quel motif ?\n' +
      'User: Test manuel du pipeline.\n' +
      'Agent: Rendez-vous confirmé.',
    email_status: 'pending',
  };
  const { data, error } = await supabase
    .from('appels')
    .insert(row)
    .select('id, cabinet_id, email_status')
    .single<TestAppelRow>();
  if (error) throw new Error(`test_appel_insert_failed: ${error.message}`);
  return data;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const forceResend = args.includes('--force-resend');

  // nLPD guardrail (session 3.1 audit): the script inserts a test cabinet
  // + test appel into the DB pointed to by SUPABASE_URL. Refuse hard when
  // NODE_ENV = production so a misconfigured shell (prod URL in
  // .env.local) cannot pollute the production database.
  if (process.env.NODE_ENV === 'production') {
    process.stderr.write(
      'refusing to run test-email-pipeline in NODE_ENV=production.\n' +
        '  Why: the script writes a test cabinet + appel to SUPABASE_URL.\n' +
        '  How to run: unset NODE_ENV (or set it to "development" / "test"),\n' +
        '              and point SUPABASE_URL at a non-prod project.\n',
    );
    return 1;
  }

  logger.info({ recipient: TEST_RECIPIENT, force_resend: forceResend }, 'pipeline_test_starting');

  // Boot checks — the worker would fail fast on either of these too.
  assertSmtpConfigured();
  await ensureBucketAccessible();

  const cabinet = await ensureTestCabinet();
  logger.info({ cabinet_id: cabinet.id }, 'pipeline_test_cabinet_ready');

  const appel = await ensureTestAppel(cabinet.id, forceResend);
  logger.info(
    { appel_id: appel.id, email_status: appel.email_status },
    'pipeline_test_appel_ready',
  );

  // Craft a fake in-memory Job row. We do NOT insert one into `jobs` — the
  // point is to test the processor code path, not the queue plumbing.
  const initialPayload: ProcessAppelPayload = {
    version: 1,
    steps: {},
  };
  const job: Job = {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'process_appel',
    appel_id: appel.id,
    payload: initialPayload,
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    run_after: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'test-pipeline-script',
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    await processAppelJob(job);
    logger.info('pipeline_test_success — email sent, PDF uploaded');
    return 0;
  } catch (err: unknown) {
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown', err_msg: err instanceof Error ? err.message : String(err) },
      'pipeline_test_failed',
    );
    return 1;
  } finally {
    closeTransporter();
    await closeBrowser();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Should be unreachable — main() catches its own errors — but keep a
    // last-resort guard.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${msg}\n`);
    process.exit(1);
  },
);
