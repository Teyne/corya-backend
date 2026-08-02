import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDeletion } from '../../src/types/index.js';

const claimMock = vi.fn<() => Promise<FileDeletion[]>>();
const completeMock = vi.fn<() => Promise<void>>();
const failMock = vi.fn<() => Promise<'pending' | 'dead_letter'>>();
const heartbeatMock = vi.fn<() => Promise<void>>();
vi.mock('../../src/db/queries.js', () => ({
  claimFileDeletions: claimMock,
  completeFileDeletion: completeMock,
  failFileDeletion: failMock,
  workerHeartbeatDeletionPoll: heartbeatMock,
}));

const storageDeleteMock = vi.fn<() => Promise<'deleted' | 'not_found'>>();
const retellDeleteMock = vi.fn<() => Promise<'deleted' | 'not_found'>>();
vi.mock('../../src/services/storage.js', () => ({ deleteStoredPdf: storageDeleteMock }));
vi.mock('../../src/services/retell.js', () => ({ deleteRetellCall: retellDeleteMock }));

const alertMock = vi.fn<() => Promise<void>>();
vi.mock('../../src/services/alert.js', () => ({ sendAlert: alertMock }));

const { runFileDeletionWorker } = await import('../../src/workers/file-deletion-worker.js');

function deletion(overrides: Partial<FileDeletion> = {}): FileDeletion {
  return {
    id: 'del-1', target: 'supabase_storage', bucket: 'pdf-recaps',
    object_path: 'cabinet/2026-08/appel.pdf', external_ref: null,
    reason: 'appel_purged_24m', status: 'processing', attempts: 1,
    max_attempts: 10, run_after: new Date().toISOString(), locked_at: new Date().toISOString(),
    locked_by: 'worker-test', last_error: null, source_appel_id: null,
    source_cabinet_id: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), deleted_at: null, ...overrides,
  };
}

beforeEach(() => {
  claimMock.mockReset().mockResolvedValue([]);
  completeMock.mockReset().mockResolvedValue(undefined);
  failMock.mockReset().mockResolvedValue('pending');
  heartbeatMock.mockReset().mockResolvedValue(undefined);
  storageDeleteMock.mockReset().mockResolvedValue('deleted');
  retellDeleteMock.mockReset().mockResolvedValue('deleted');
  alertMock.mockReset().mockResolvedValue(undefined);
});

describe('runFileDeletionWorker', () => {
  it('completes a Storage deletion and records its heartbeat', async () => {
    claimMock.mockResolvedValueOnce([deletion()]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    await Promise.resolve();
    expect(storageDeleteMock).toHaveBeenCalledWith('pdf-recaps', 'cabinet/2026-08/appel.pdf');
    expect(completeMock).toHaveBeenCalledWith('del-1', 'deleted');
    expect(heartbeatMock).toHaveBeenCalledWith('worker-test', 1);
  });

  it('treats a missing Retell call as an idempotent success', async () => {
    retellDeleteMock.mockResolvedValueOnce('not_found');
    claimMock.mockResolvedValueOnce([deletion({
      target: 'retell_audio', bucket: null, object_path: null, external_ref: 'call-1',
    })]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(completeMock).toHaveBeenCalledWith('del-1', 'not_found');
  });

  it('requeues a transient physical deletion failure', async () => {
    storageDeleteMock.mockRejectedValueOnce(new Error('remote down'));
    claimMock.mockResolvedValueOnce([deletion()]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(failMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'del-1' }), expect.any(String), expect.any(Number));
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('alerts when the retry budget is exhausted', async () => {
    storageDeleteMock.mockRejectedValueOnce(new Error('remote down'));
    failMock.mockResolvedValueOnce('dead_letter');
    claimMock.mockResolvedValueOnce([deletion({ attempts: 10 })]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(alertMock).toHaveBeenCalledWith(
      'file_deletion_dead_letter',
      expect.objectContaining({ deletion_id: 'del-1' }),
    );
  });
});
