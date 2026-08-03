import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSentMails,
  insertDeletionDirect,
  installQueryMocks,
  makeFakeTransporter,
  resetStore,
  sentMails,
  store,
} from './harness.js';

const storageDeleteMock = vi.hoisted(() =>
  vi.fn<(bucket: string, objectPath: string) => Promise<'deleted' | 'not_found'>>(),
);
const retellDeleteMock = vi.hoisted(() =>
  vi.fn<(externalRef: string) => Promise<'deleted' | 'not_found'>>(),
);

installQueryMocks();
vi.mock('../../src/services/storage.js', () => ({ deleteStoredPdf: storageDeleteMock }));
vi.mock('../../src/services/retell.js', () => ({ deleteRetellCall: retellDeleteMock }));

const { runFileDeletionWorker } = await import('../../src/workers/file-deletion-worker.js');
const {
  __setAlertPollersEnabledOverrideForTests,
  __setReceiptTransporterForTests,
  pollFileDeletionDeadLetterAlerts,
} = await import('../../src/services/alert-pollers.js');

beforeEach(() => {
  resetStore();
  clearSentMails();
  storageDeleteMock.mockReset().mockResolvedValue('deleted');
  retellDeleteMock.mockReset().mockResolvedValue('deleted');
  __setAlertPollersEnabledOverrideForTests(true);
  __setReceiptTransporterForTests(makeFakeTransporter());
});

afterEach(() => {
  __setAlertPollersEnabledOverrideForTests(null);
  __setReceiptTransporterForTests(null);
});

describe('file deletion outbox e2e — fenced worker and persistent alert', () => {
  it('does not overwrite a deletion reclaimed by another worker', async () => {
    const row = insertDeletionDirect({ id: 'deletion-lost-lease' });
    storageDeleteMock.mockImplementationOnce(() => {
      const current = store.deletions.get(row.id);
      if (current) {
        current.locked_by = 'worker-reclaimer';
        current.locked_at = '2026-08-03T12:00:00.654321Z';
      }
      return Promise.resolve('deleted');
    });

    const worker = runFileDeletionWorker({ workerId: 'worker-original', runOnce: true });
    await worker.stopped;

    expect(store.deletions.get(row.id)).toMatchObject({
      status: 'processing',
      locked_by: 'worker-reclaimer',
      locked_at: '2026-08-03T12:00:00.654321Z',
      deleted_at: null,
    });
    expect(sentMails).toEqual([]);
  });

  it('retries, dead-letters, then alerts and marks through the API poller', async () => {
    const row = insertDeletionDirect({
      id: 'deletion-retry-terminal',
      max_attempts: 2,
      object_path: 'PII-PATH-MUST-NOT-ALERT.pdf',
      source_appel_id: 'PII-SOURCE-MUST-NOT-ALERT',
    });
    storageDeleteMock.mockRejectedValue(new Error('remote unavailable'));

    const first = runFileDeletionWorker({ workerId: 'worker-e2e', runOnce: true });
    await first.stopped;
    expect(store.deletions.get(row.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(sentMails).toEqual([]);

    const pending = store.deletions.get(row.id);
    if (!pending) throw new Error('missing e2e deletion');
    pending.run_after = new Date(Date.now() - 1_000).toISOString();

    const second = runFileDeletionWorker({ workerId: 'worker-e2e', runOnce: true });
    await second.stopped;
    expect(store.deletions.get(row.id)).toMatchObject({ status: 'dead_letter', attempts: 2 });
    expect(sentMails).toEqual([]);

    await pollFileDeletionDeadLetterAlerts();

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.subject).toContain('file_deletion_dead_letter');
    const body = sentMails[0]?.text ?? '';
    expect(body).not.toContain('PII-PATH-MUST-NOT-ALERT.pdf');
    expect(body).not.toContain('PII-SOURCE-MUST-NOT-ALERT');
    expect(store.deletions.get(row.id)?.dead_letter_alerted_at).not.toBeNull();
    expect(store.deletions.get(row.id)?.dead_letter_alert_locked_at).toBeNull();
  });
});
