/**
 * Worker entrypoint — separate process from the HTTP server.
 *
 * Ran via `npm run worker` (compiled) or `npm run worker:dev` (tsx watch).
 * In production on Jelastic this is its own container so an OOM in the
 * webhook API doesn't kill the pipeline, and vice-versa.
 *
 * Boot sequence:
 *   1. Validate SMTP config — fail fast if the worker can't email.
 *   2. Verify the Storage bucket exists — fail fast if the bucket is
 *      missing or the service role can't reach it.
 *   3. Start the polling loop.
 *   4. Wire SIGTERM / SIGINT for graceful shutdown: stop claiming, await
 *      in-flight jobs, close Puppeteer + SMTP pool, exit 0.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './config/logger.js';
import { runJobWorker } from './workers/job-worker.js';
import { assertSmtpConfigured, closeTransporter } from './services/email.js';
import { closeBrowser } from './services/pdf.js';
import { ensureBucketAccessible } from './services/storage.js';
import { closeAlertTransporter, logAlertingModeOnce } from './services/alert.js';

// Version comes from package.json — same ESM-safe reading pattern as index.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));
interface PackageJsonShape { version: string }
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'),
) as PackageJsonShape;
const version: string = pkg.version;

async function main(): Promise<void> {
  try {
    assertSmtpConfigured();
  } catch (err: unknown) {
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown', err_msg: err instanceof Error ? err.message : 'unknown' },
      'worker_smtp_not_configured',
    );
    process.exit(1);
  }

  try {
    await ensureBucketAccessible();
  } catch (err: unknown) {
    logger.error(
      { err_name: err instanceof Error ? err.name : 'unknown', err_msg: err instanceof Error ? err.message : 'unknown' },
      'worker_bucket_check_failed',
    );
    process.exit(1);
  }

  // Session 4: emit a boot-time line describing the alerting mode. Hard
  // requirement from the founder — a silenced pipeline must be VISIBLE.
  logAlertingModeOnce();

  const worker = runJobWorker({ version });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'worker_received_signal');
    // Ask the loop to stop claiming new work.
    worker.stop();

    // Force-exit safeguard: if in-flight jobs hang past the grace period,
    // do NOT let Jelastic SIGKILL us silently — surface the timeout in the
    // logs first.
    const forceTimer = setTimeout(() => {
      logger.error('worker_graceful_shutdown_timeout_forcing_exit');
      process.exit(1);
    }, 25_000);
    forceTimer.unref();

    worker.stopped
      .then(async () => {
        // Close in the reverse order of use: SMTP first (cheapest), then
        // Puppeteer browser (heaviest).
        try {
          closeTransporter();
        } catch (err: unknown) {
          logger.warn(
            { err_name: err instanceof Error ? err.name : 'unknown' },
            'worker_smtp_close_failed',
          );
        }
        try {
          closeAlertTransporter();
        } catch (err: unknown) {
          logger.warn(
            { err_name: err instanceof Error ? err.name : 'unknown' },
            'worker_alert_close_failed',
          );
        }
        try {
          await closeBrowser();
        } catch (err: unknown) {
          logger.warn(
            { err_name: err instanceof Error ? err.name : 'unknown' },
            'worker_browser_close_failed',
          );
        }
        logger.info('worker_stopped_clean');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error(
          { err_name: err instanceof Error ? err.name : 'unknown' },
          'worker_shutdown_error',
        );
        process.exit(1);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Fire-and-forget: any error above is already logged; we don't want to
// leak an unhandled rejection to the top level.
main().catch((err: unknown) => {
  logger.error(
    { err_name: err instanceof Error ? err.name : 'unknown' },
    'worker_boot_failed',
  );
  process.exit(1);
});
