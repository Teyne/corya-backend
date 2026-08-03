import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDeletion } from '../../src/types/index.js';

const claimMock = vi.fn<() => Promise<FileDeletion[]>>();
const completeMock = vi.fn<() => Promise<'deleted' | 'not_found' | null>>();
const failMock = vi.fn<() => Promise<'pending' | 'dead_letter' | null>>();
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

const { runFileDeletionWorker } = await import('../../src/workers/file-deletion-worker.js');

function deletion(overrides: Partial<FileDeletion> = {}): FileDeletion {
  return {
    id: 'del-1', target: 'supabase_storage', bucket: 'pdf-recaps',
    object_path: 'cabinet/2026-08/appel.pdf', external_ref: null,
    reason: 'appel_purged_24m', status: 'processing', attempts: 1,
    max_attempts: 10, run_after: new Date().toISOString(), locked_at: new Date().toISOString(),
    locked_by: 'worker-test', last_error: null, enqueued_by: 'test', source_appel_id: null,
    source_cabinet_id: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), deleted_at: null,
    dead_letter_alerted_at: null, dead_letter_alert_locked_at: null,
    dead_letter_alert_locked_by: null, ...overrides,
  };
}

beforeEach(() => {
  claimMock.mockReset().mockResolvedValue([]);
  completeMock.mockReset().mockResolvedValue('deleted');
  failMock.mockReset().mockResolvedValue('pending');
  heartbeatMock.mockReset().mockResolvedValue(undefined);
  storageDeleteMock.mockReset().mockResolvedValue('deleted');
  retellDeleteMock.mockReset().mockResolvedValue('deleted');
});

describe('runFileDeletionWorker', () => {
  it('completes a Storage deletion and records its heartbeat', async () => {
    claimMock.mockResolvedValueOnce([deletion()]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    await Promise.resolve();
    expect(storageDeleteMock).toHaveBeenCalledWith('pdf-recaps', 'cabinet/2026-08/appel.pdf');
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'del-1' }),
      'worker-test',
      'deleted',
    );
    expect(heartbeatMock).toHaveBeenCalledWith('worker-test', 1);
  });

  it('treats a missing Retell call as an idempotent success', async () => {
    retellDeleteMock.mockResolvedValueOnce('not_found');
    claimMock.mockResolvedValueOnce([deletion({
      target: 'retell_audio', bucket: null, object_path: null, external_ref: 'call-1',
    })]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'del-1' }),
      'worker-test',
      'not_found',
    );
  });

  it('requeues a transient physical deletion failure', async () => {
    storageDeleteMock.mockRejectedValueOnce(new Error('remote down'));
    claimMock.mockResolvedValueOnce([deletion()]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(failMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'del-1' }),
      'worker-test',
      expect.any(String),
      expect.any(Number),
    );
  });

  it('leaves dead-letter alerting exclusively to the persistent API poller', async () => {
    storageDeleteMock.mockRejectedValueOnce(new Error('remote down'));
    failMock.mockResolvedValueOnce('dead_letter');
    claimMock.mockResolvedValueOnce([deletion({ attempts: 10 })]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(failMock).toHaveBeenCalledOnce();
  });

  it('does not attempt another transition after losing the completion lease', async () => {
    completeMock.mockResolvedValueOnce(null);
    claimMock.mockResolvedValueOnce([deletion()]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(completeMock).toHaveBeenCalledOnce();
    expect(failMock).not.toHaveBeenCalled();
  });

  it('does not attempt another transition after losing the failure lease', async () => {
    storageDeleteMock.mockRejectedValueOnce(new Error('remote down'));
    failMock.mockResolvedValueOnce(null);
    claimMock.mockResolvedValueOnce([deletion()]);
    const worker = runFileDeletionWorker({ workerId: 'worker-test', runOnce: true });
    await worker.stopped;
    expect(failMock).toHaveBeenCalledOnce();
    expect(completeMock).not.toHaveBeenCalled();
  });
});
