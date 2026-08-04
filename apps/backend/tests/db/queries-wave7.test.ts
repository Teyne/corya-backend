import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDeletion } from '../../src/types/index.js';

const rpcMock = vi.fn();
const fromMock = vi.fn();
const selectMock = vi.fn();
const notMock = vi.fn();
const orderMock = vi.fn();
const limitMock = vi.fn();
const abortSignalMock = vi.fn();
const maybeSingleMock = vi.fn();
const queryBuilder: Record<string, unknown> = {};
Object.assign(queryBuilder, {
  select: selectMock,
  not: notMock,
  order: orderMock,
  limit: limitMock,
  abortSignal: abortSignalMock,
  maybeSingle: maybeSingleMock,
});
vi.mock('../../src/config/supabase.js', () => ({
  getServiceClient: () => ({ rpc: rpcMock, from: fromMock }),
}));

const {
  claimFileDeletionDeadLetterAlerts,
  completeFileDeletion,
  failFileDeletion,
  getMostRecentDeletionPoll,
  getWave7ContractVersion,
  markFileDeletionDeadLetterAlerted,
  persistCallAnalyzed,
  releaseFileDeletionDeadLetterAlert,
} = await import('../../src/db/queries.js');

function queueRpcResult(data: unknown, error: { message: string } | null = null): void {
  rpcMock.mockReturnValueOnce({
    abortSignal: vi.fn().mockResolvedValue({ data, error }),
  });
}

function deletion(): FileDeletion {
  return {
    id: 'deletion-1',
    target: 'supabase_storage',
    bucket: 'pdf-recaps',
    object_path: 'cabinet/month/appel.pdf',
    external_ref: null,
    reason: 'appel_purged_24m',
    status: 'processing',
    attempts: 1,
    max_attempts: 10,
    run_after: '2026-08-03T00:00:00.000Z',
    locked_at: '2026-08-03T10:11:12.123456Z',
    locked_by: 'worker-1',
    last_error: null,
    enqueued_by: 'purge_ancient_appels',
    source_appel_id: null,
    source_cabinet_id: null,
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
    deleted_at: null,
    dead_letter_alerted_at: null,
    dead_letter_alert_locked_at: null,
    dead_letter_alert_locked_by: null,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset().mockReturnValue(queryBuilder);
  selectMock.mockReset().mockReturnValue(queryBuilder);
  notMock.mockReset().mockReturnValue(queryBuilder);
  orderMock.mockReset().mockReturnValue(queryBuilder);
  limitMock.mockReset().mockReturnValue(queryBuilder);
  abortSignalMock.mockReset().mockReturnValue(queryBuilder);
  maybeSingleMock.mockReset().mockResolvedValue({ data: null, error: null });
});

describe('Wave 7 deletion-loop health query', () => {
  it('selects the freshest non-null deletion heartbeat across workers', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { last_deletion_poll_at: '2026-08-03T10:11:12.123456Z' },
      error: null,
    });

    await expect(getMostRecentDeletionPoll()).resolves.toEqual({
      last_deletion_poll_at: '2026-08-03T10:11:12.123456Z',
    });
    expect(fromMock).toHaveBeenCalledWith('worker_heartbeats');
    expect(selectMock).toHaveBeenCalledWith('last_deletion_poll_at');
    expect(notMock).toHaveBeenCalledWith('last_deletion_poll_at', 'is', null);
    expect(orderMock).toHaveBeenCalledWith('last_deletion_poll_at', { ascending: false });
  });
});

describe('call_analyzed atomic intake RPC wrapper', () => {
  it('passes the complete durable intent in one bounded RPC', async () => {
    queueRpcResult([{ appel_id: 'appel-atomic', duplicate: false }]);
    const appel = {
      cabinet_id: 'cabinet-1', retell_call_id: 'call-1',
      date_appel: '2026-08-04T00:00:00.000Z', duree_secondes: 12,
      numero_appelant_hash: null, numero_appelant_masque: null,
      resultat: null, motif_appel: null, patient_nom: null,
      patient_prenom: null, patient_telephone: null, rdv_date: null,
      rdv_praticien: null, transcript: null, transcript_anonymise: null,
      audio_url: null, audio_expires_at: null,
    };

    await expect(persistCallAnalyzed({
      appel,
      processAppelPayload: { version: 1, to: 'synthetic@example.invalid', cc: null, steps: {} },
      purgeAudioPayload: { retell_call_id: 'call-1' },
      purgeRunAfter: '2026-08-05T00:00:00.000Z',
      correlationId: 'correlation-1',
    })).resolves.toEqual({ appelId: 'appel-atomic', duplicate: false });

    expect(rpcMock).toHaveBeenCalledWith('persist_call_analyzed', {
      p_appel: appel,
      p_process_payload: { version: 1, to: 'synthetic@example.invalid', cc: null, steps: {} },
      p_purge_payload: { retell_call_id: 'call-1' },
      p_purge_run_after: '2026-08-05T00:00:00.000Z',
      p_correlation_id: 'correlation-1',
    });
  });
});

describe('Wave 7 fenced deletion RPC wrappers', () => {
  it('passes worker_id and locked_at verbatim when completing', async () => {
    const row = deletion();
    queueRpcResult('deleted');

    await expect(completeFileDeletion(row, 'worker-1', 'deleted')).resolves.toBe('deleted');

    expect(rpcMock).toHaveBeenCalledWith('complete_file_deletion', {
      p_deletion_id: row.id,
      p_worker_id: 'worker-1',
      p_locked_at: '2026-08-03T10:11:12.123456Z',
      p_status: 'deleted',
    });
  });

  it('returns explicit lost lease and passes the failure lease verbatim', async () => {
    const row = deletion();
    queueRpcResult(null);

    await expect(failFileDeletion(row, 'worker-1', 'TimeoutError:redacted', 30)).resolves.toBeNull();

    expect(rpcMock).toHaveBeenCalledWith('fail_file_deletion', {
      p_deletion_id: row.id,
      p_worker_id: 'worker-1',
      p_locked_at: '2026-08-03T10:11:12.123456Z',
      p_error: 'TimeoutError:redacted',
      p_backoff_seconds: 30,
    });
  });
});

describe('Wave 7 persistent deletion-alert RPC wrappers', () => {
  it('uses claim, mark and release with the exact alert lease', async () => {
    const alertLease = '2026-08-03T10:11:12.654321Z';
    queueRpcResult([]);
    await claimFileDeletionDeadLetterAlerts('alerter-1', 20, 300);
    expect(rpcMock).toHaveBeenLastCalledWith('claim_file_deletion_dead_letter_alerts', {
      p_alerter_id: 'alerter-1',
      p_batch_size: 20,
      p_stale_after_seconds: 300,
    });

    queueRpcResult(true);
    await expect(
      markFileDeletionDeadLetterAlerted('deletion-1', 'alerter-1', alertLease),
    ).resolves.toBe(true);
    expect(rpcMock).toHaveBeenLastCalledWith('mark_file_deletion_dead_letter_alerted', {
      p_deletion_id: 'deletion-1',
      p_alerter_id: 'alerter-1',
      p_alert_locked_at: alertLease,
    });

    queueRpcResult(true);
    await expect(
      releaseFileDeletionDeadLetterAlert('deletion-1', 'alerter-1', alertLease),
    ).resolves.toBe(true);
    expect(rpcMock).toHaveBeenLastCalledWith('release_file_deletion_dead_letter_alert', {
      p_deletion_id: 'deletion-1',
      p_alerter_id: 'alerter-1',
      p_alert_locked_at: alertLease,
    });
  });

  it('reads the boot contract through the timeout-wrapped RPC', async () => {
    queueRpcResult(7);
    await expect(getWave7ContractVersion()).resolves.toBe(7);
    expect(rpcMock).toHaveBeenCalledWith('get_wave7_contract_version');
  });
});
