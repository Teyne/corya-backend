import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  claimFileDeletions,
  completeFileDeletion,
  failFileDeletion,
  workerHeartbeatDeletionPoll,
} from '../db/queries.js';
import { sendAlert } from '../services/alert.js';
import { deleteRetellCall } from '../services/retell.js';
import { deleteStoredPdf } from '../services/storage.js';
import type { FileDeletion } from '../types/index.js';
import { computeBackoffSeconds } from '../utils/backoff.js';
import { toLogFields } from '../utils/errors.js';

export interface FileDeletionWorkerOptions {
  workerId: string;
  pollIntervalMs?: number;
  batchSize?: number;
  staleAfterSeconds?: number;
  runOnce?: boolean;
}

export interface RunningFileDeletionWorker {
  stop: () => void;
  stopped: Promise<void>;
}

async function sleep(ms: number, stopped: () => boolean): Promise<void> {
  const step = 200;
  for (let elapsed = 0; elapsed < ms && !stopped(); elapsed += step) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
  }
}

async function deletePhysicalFile(row: FileDeletion): Promise<'deleted' | 'not_found'> {
  if (row.target === 'supabase_storage') {
    if (!row.bucket || !row.object_path) throw new Error('invalid_storage_deletion_order');
    return deleteStoredPdf(row.bucket, row.object_path);
  }
  if (!row.external_ref) throw new Error('invalid_retell_deletion_order');
  return deleteRetellCall(row.external_ref);
}

async function handleDeletion(row: FileDeletion): Promise<void> {
  const context = {
    deletion_id: row.id,
    deletion_target: row.target,
    attempt: row.attempts,
    max_attempts: row.max_attempts,
  };
  try {
    const status = await deletePhysicalFile(row);
    await completeFileDeletion(row.id, status);
    logger.info({ ...context, status }, 'file_deletion_completed');
  } catch (err: unknown) {
    logger.warn({ ...context, ...toLogFields(err) }, 'file_deletion_failed');
    const status = await failFileDeletion(
      row,
      `${toLogFields(err).err_name}:redacted_external_error`,
      computeBackoffSeconds(row.attempts),
    );
    if (status === 'dead_letter') {
      await sendAlert('file_deletion_dead_letter', { ...context, source: 'deletion_worker' });
    }
  }
}

export function runFileDeletionWorker(
  options: FileDeletionWorkerOptions,
): RunningFileDeletionWorker {
  const pollIntervalMs = options.pollIntervalMs ?? env.FILE_DELETION_POLL_INTERVAL_MS;
  const batchSize = options.batchSize ?? env.FILE_DELETION_BATCH_SIZE;
  const staleAfterSeconds = options.staleAfterSeconds ?? env.FILE_DELETION_STALE_AFTER_SECONDS;
  const runOnce = options.runOnce ?? false;
  let stopping = false;

  const stopped = (async (): Promise<void> => {
    logger.info({ worker_id: options.workerId, poll_ms: pollIntervalMs, batch: batchSize }, 'file_deletion_worker_started');
    while (!stopping) {
      let rows: FileDeletion[] = [];
      try {
        rows = await claimFileDeletions(options.workerId, batchSize, staleAfterSeconds);
        await Promise.all(rows.map(handleDeletion));
      } catch (err: unknown) {
        logger.error({ ...toLogFields(err) }, 'file_deletion_poll_failed');
      }
      workerHeartbeatDeletionPoll(options.workerId, rows.length).catch((err: unknown) => {
        logger.warn({ ...toLogFields(err) }, 'worker_heartbeat_deletion_poll_failed');
      });
      if (runOnce) break;
      await sleep(rows.length > 0 ? 0 : pollIntervalMs, () => stopping);
    }
    logger.info('file_deletion_worker_stopped');
  })();

  return { stop: () => { stopping = true; }, stopped };
}
