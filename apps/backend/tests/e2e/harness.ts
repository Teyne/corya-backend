/**
 * Shared harness for the e2e suite.
 *
 * ---------------------------------------------------------------------------
 * What we mock, what we run for real
 * ---------------------------------------------------------------------------
 * REAL: the Express app, the webhook route, the worker loop, the retry
 *       classifier, the correlation middleware, the alert pollers, the
 *       rate limiter — everything in `src/`.
 * FAKE: the DB layer (`src/db/queries.js`) — replaced by an in-memory
 *       store below. The Retell SDK verifier and Puppeteer are also
 *       swapped for no-op fakes: an e2e test that actually launched
 *       Chromium would take 10x longer and depend on the browser
 *       binary being installed on the CI runner.
 *
 * NEVER touches a real SMTP relay: the shared Nodemailer transporter
 * is replaced via `email.__setTransporterForTests` with a spy that
 * records every send. The alert transporters use the same swap in
 * `alert.__setAlertTransporterForTests` and
 * `alert-pollers.__setReceiptTransporterForTests`.
 *
 * ---------------------------------------------------------------------------
 * In-memory `jobs` store — behaviour mirror of the SQL contract
 * ---------------------------------------------------------------------------
 * This is not a full re-implementation of migration 20260731100000 and
 * 20260801000000; only the behaviours the worker depends on:
 *   - `claim_jobs` returns rows in `pending` OR `processing` (stale beyond
 *     `stale_after_seconds`), filters `attempts < max_attempts`,
 *     increments `attempts`, flips status to `processing`.
 *   - `fail_job` bumps `attempts` again? — no, we already incremented at
 *     claim time. `fail_job` only stamps `last_error`, resets to `pending`
 *     with backoff OR flips to `dead_letter` when `attempts >= max_attempts`.
 *   - `complete_job` flips to `succeeded`.
 *   - `fail_job_permanent` flips directly to `dead_letter`, ignoring attempts.
 *
 * This lets the e2e tests exercise the FULL worker code path while keeping
 * the suite hermetic.
 */
import { vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import type {
  AppelProcessingRow,
  CabinetProcessingRow,
  Job,
  JobInsertRow,
  JobType,
  ProcessAppelPayload,
} from '../../src/types/index.js';
import type { CabinetRow, CronHealthRow, WorkerHeartbeatRow } from '../../src/db/queries.js';

// ---------------------------------------------------------------------------
// Public store — reset via resetStore()
// ---------------------------------------------------------------------------

export interface E2eStore {
  cabinets: Map<string, CabinetProcessingRow & { numero_corya: string }>;
  appels: Map<string, AppelProcessingRow>;
  jobs: Map<string, Job>;
  heartbeats: Map<string, WorkerHeartbeatRow>;
  cronRows: CronHealthRow[];
}

export const store: E2eStore = {
  cabinets: new Map(),
  appels: new Map(),
  jobs: new Map(),
  heartbeats: new Map(),
  cronRows: [],
};

export function resetStore(): void {
  store.cabinets.clear();
  store.appels.clear();
  store.jobs.clear();
  store.heartbeats.clear();
  store.cronRows = [];
}

let jobSeq = 1;
function nextJobId(): string {
  return `job-${jobSeq++}`;
}

// ---------------------------------------------------------------------------
// Fake nodemailer transporter — collects every send for assertion
// ---------------------------------------------------------------------------

export interface SentMail {
  to: string;
  cc?: string | string[] | null;
  subject: string;
  html?: string;
  text?: string;
  attachments?: Array<{
    filename?: string;
    contentType?: string;
    content?: Buffer | string | Uint8Array;
  }>;
  from?: unknown;
}

export const sentMails: SentMail[] = [];

/**
 * Create a fresh in-memory transporter. Each e2e test injects it and
 * asserts on `sentMails` at the end.
 */
export function makeFakeTransporter(): Transporter {
  return {
    sendMail: (opts: SentMail): Promise<{ messageId: string }> => {
      sentMails.push({
        to: opts.to,
        cc: opts.cc ?? null,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        attachments: opts.attachments?.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content:
            typeof a.content === 'string' ? Buffer.from(a.content) : a.content,
        })),
        from: opts.from,
      });
      return Promise.resolve({ messageId: `<test-${sentMails.length}@e2e>` });
    },
    close: (): void => {},
    verify: (): Promise<true> => Promise.resolve(true),
  } as unknown as Transporter;
}

export function clearSentMails(): void {
  sentMails.length = 0;
}

// ---------------------------------------------------------------------------
// Mock installer — call this ONCE per test file (top-level) BEFORE
// importing anything from `src/`.
// ---------------------------------------------------------------------------

export function installQueryMocks(): void {
  vi.mock('../../src/db/queries.js', () => {
    // Re-import types so callers can build valid rows; use `unknown` to
    // avoid dragging real query behaviour by accident.
    return {
      // ---------- reads ----------
      findCabinetByCoryaNumber: (toNumber: string): Promise<CabinetRow | null> => {
        for (const c of store.cabinets.values()) {
          if (c.numero_corya === toNumber && c.statut === 'actif') {
            return Promise.resolve({
              id: c.id,
              numero_corya: c.numero_corya,
              email_notification: c.email_notification,
              email_notification_cc: c.email_notification_cc,
            });
          }
        }
        return Promise.resolve(null);
      },
      getAppelForProcessing: (
        appelId: string,
      ): Promise<AppelProcessingRow | null> => {
        return Promise.resolve(store.appels.get(appelId) ?? null);
      },
      getCabinetForProcessing: (
        cabinetId: string,
      ): Promise<CabinetProcessingRow | null> => {
        const c = store.cabinets.get(cabinetId);
        if (!c) return Promise.resolve(null);
        return Promise.resolve({
          id: c.id,
          nom: c.nom,
          email_notification: c.email_notification,
          email_notification_cc: c.email_notification_cc,
          statut: c.statut,
        });
      },
      // ---------- writes (appel row) ----------
      insertAppelIdempotent: (row: Record<string, unknown> & { retell_call_id: string }): Promise<{
        appelId: string;
        duplicate: boolean;
      }> => {
        for (const [id, existing] of store.appels) {
          if (existing.retell_call_id === row.retell_call_id) {
            return Promise.resolve({ appelId: id, duplicate: true });
          }
        }
        const id = `appel-${store.appels.size + 1}`;
        const appel: AppelProcessingRow = {
          id,
          cabinet_id: String(row.cabinet_id),
          retell_call_id: row.retell_call_id,
          date_appel: String(row.date_appel),
          duree_secondes:
            typeof row.duree_secondes === 'number' ? row.duree_secondes : null,
          resultat: (row.resultat as AppelProcessingRow['resultat']) ?? null,
          motif_appel: (row.motif_appel as string | null) ?? null,
          patient_nom: (row.patient_nom as string | null) ?? null,
          patient_prenom: (row.patient_prenom as string | null) ?? null,
          patient_telephone: (row.patient_telephone as string | null) ?? null,
          rdv_date: (row.rdv_date as string | null) ?? null,
          rdv_praticien: (row.rdv_praticien as string | null) ?? null,
          transcript: (row.transcript as string | null) ?? null,
          pdf_url: null,
          email_status: 'pending',
        };
        store.appels.set(id, appel);
        return Promise.resolve({ appelId: id, duplicate: false });
      },
      setAppelPdfPath: (appelId: string, path: string): Promise<void> => {
        const a = store.appels.get(appelId);
        if (a) a.pdf_url = path;
        return Promise.resolve();
      },
      markAppelEmailSent: (appelId: string): Promise<void> => {
        const a = store.appels.get(appelId);
        if (a) a.email_status = 'sent';
        return Promise.resolve();
      },
      markAppelEmailFailed: (appelId: string): Promise<void> => {
        const a = store.appels.get(appelId);
        if (a) a.email_status = 'failed';
        return Promise.resolve();
      },
      // ---------- jobs table ----------
      enqueueJobIdempotent: (row: JobInsertRow): Promise<boolean> => {
        // Idempotence key = (type, appel_id) WHERE status IN ('pending','processing')
        for (const j of store.jobs.values()) {
          if (
            j.type === row.type &&
            j.appel_id === row.appel_id &&
            (j.status === 'pending' || j.status === 'processing')
          ) {
            return Promise.resolve(false);
          }
        }
        const id = nextJobId();
        const job: Job = {
          id,
          type: row.type,
          appel_id: row.appel_id,
          payload: row.payload ?? {},
          status: 'pending',
          attempts: 0,
          max_attempts: 5,
          run_after: row.run_after ?? new Date().toISOString(),
          locked_at: null,
          locked_by: null,
          last_error: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          correlation_id: row.correlation_id ?? null,
          dead_letter_alerted_at: null,
        };
        store.jobs.set(id, job);
        return Promise.resolve(true);
      },
      claimJobs: (
        workerId: string,
        batchSize: number,
        staleAfterSeconds: number,
      ): Promise<Job[]> => {
        const now = Date.now();
        const claimed: Job[] = [];
        for (const j of store.jobs.values()) {
          if (claimed.length >= batchSize) break;
          if (j.attempts >= j.max_attempts) continue;
          const isPendingDue =
            j.status === 'pending' && new Date(j.run_after).getTime() <= now;
          const isZombie =
            j.status === 'processing' &&
            j.locked_at !== null &&
            now - new Date(j.locked_at).getTime() > staleAfterSeconds * 1_000;
          if (!isPendingDue && !isZombie) continue;
          j.status = 'processing';
          j.locked_at = new Date().toISOString();
          j.locked_by = workerId;
          j.attempts += 1;
          claimed.push({ ...j });
        }
        return Promise.resolve(claimed);
      },
      completeJob: (jobId: string): Promise<void> => {
        const j = store.jobs.get(jobId);
        if (j) {
          j.status = 'succeeded';
          j.locked_at = null;
          j.locked_by = null;
          j.last_error = null;
        }
        return Promise.resolve();
      },
      failJob: (
        jobId: string,
        errorMessage: string,
        backoffSeconds: number,
      ): Promise<void> => {
        const j = store.jobs.get(jobId);
        if (!j) return Promise.resolve();
        j.last_error = errorMessage.slice(0, 500);
        j.locked_at = null;
        j.locked_by = null;
        if (j.attempts >= j.max_attempts) {
          j.status = 'dead_letter';
        } else {
          j.status = 'pending';
          j.run_after = new Date(Date.now() + backoffSeconds * 1_000).toISOString();
        }
        return Promise.resolve();
      },
      forceDeadLetter: (jobId: string, errorMessage: string): Promise<void> => {
        const j = store.jobs.get(jobId);
        if (!j || j.status !== 'processing') return Promise.resolve();
        j.status = 'dead_letter';
        j.locked_at = null;
        j.locked_by = null;
        j.last_error = errorMessage.slice(0, 500);
        return Promise.resolve();
      },
      updateJobPayload: (
        jobId: string,
        payload: ProcessAppelPayload,
      ): Promise<void> => {
        const j = store.jobs.get(jobId);
        if (j) j.payload = payload;
        return Promise.resolve();
      },
      // ---------- heartbeats ----------
      workerHeartbeatAlive: (
        workerId: string,
        version: string | null,
      ): Promise<void> => {
        const existing = store.heartbeats.get(workerId);
        store.heartbeats.set(workerId, {
          worker_id: workerId,
          last_seen_at: new Date().toISOString(),
          last_poll_at: existing?.last_poll_at ?? null,
          last_deletion_poll_at: existing?.last_deletion_poll_at ?? null,
          ...(version !== null ? { version } : {}),
        });
        return Promise.resolve();
      },
      workerHeartbeatPoll: (
        workerId: string,
        _delta: number,
      ): Promise<void> => {
        const existing = store.heartbeats.get(workerId);
        const now = new Date().toISOString();
        store.heartbeats.set(workerId, {
          worker_id: workerId,
          last_seen_at: now,
          last_poll_at: now,
          last_deletion_poll_at: existing?.last_deletion_poll_at ?? null,
          ...(existing ?? {}),
        });
        return Promise.resolve();
      },
      // ---------- alert pollers ----------
      getStaleWorkerHeartbeats: (
        seenThresholdSec: number,
        pollThresholdSec: number,
      ): Promise<WorkerHeartbeatRow[]> => {
        const now = Date.now();
        const stale: WorkerHeartbeatRow[] = [];
        for (const h of store.heartbeats.values()) {
          const seenAge = (now - new Date(h.last_seen_at).getTime()) / 1_000;
          const pollAge = h.last_poll_at
            ? (now - new Date(h.last_poll_at).getTime()) / 1_000
            : null;
          if (seenAge > seenThresholdSec) stale.push(h);
          else if (pollAge !== null && pollAge > pollThresholdSec) stale.push(h);
        }
        return Promise.resolve(stale);
      },
      countPendingJobsOlderThan: (olderThanSec: number): Promise<number> => {
        const cutoff = Date.now() - olderThanSec * 1_000;
        let n = 0;
        for (const j of store.jobs.values()) {
          if (j.status === 'pending' && new Date(j.run_after).getTime() < cutoff) n += 1;
        }
        return Promise.resolve(n);
      },
      getDeadLetterJobsToAlert: (limit: number): Promise<Job[]> => {
        const out: Job[] = [];
        for (const j of store.jobs.values()) {
          if (out.length >= limit) break;
          if (j.status === 'dead_letter' && j.dead_letter_alerted_at === null) {
            out.push({ ...j });
          }
        }
        return Promise.resolve(out);
      },
      markDeadLetterAlerted: (jobId: string): Promise<void> => {
        const j = store.jobs.get(jobId);
        if (j) j.dead_letter_alerted_at = new Date().toISOString();
        return Promise.resolve();
      },
      // ---------- health ----------
      pingDb: (_timeoutMs: number): Promise<void> => Promise.resolve(),
      getMostRecentHeartbeat: (): Promise<{ last_seen_at: string } | null> => {
        let latest: string | null = null;
        for (const h of store.heartbeats.values()) {
          if (latest === null || h.last_seen_at > latest) latest = h.last_seen_at;
        }
        return Promise.resolve(latest ? { last_seen_at: latest } : null);
      },
      getCronHealth: (): Promise<CronHealthRow[]> =>
        Promise.resolve(store.cronRows),
    };
  });

  // Puppeteer — return a fake page.pdf that produces a valid-ish PDF byte
  // sequence. The email attachment assertion looks at .length > 0.
  vi.mock('puppeteer', () => {
    const fakeBrowser = {
      newPage: (): Promise<unknown> =>
        Promise.resolve({
          setContent: (): Promise<void> => Promise.resolve(),
          pdf: (): Promise<Buffer> =>
            // Minimal valid PDF header — enough for assertions on non-empty
            // bytes without pulling a real Chromium.
            Promise.resolve(Buffer.from('%PDF-1.4\n%%EOF\n')),
          close: (): Promise<void> => Promise.resolve(),
          setDefaultTimeout: (): void => {},
        }),
      close: (): Promise<void> => Promise.resolve(),
      on: (): void => {},
    };
    return {
      default: {
        launch: (): Promise<unknown> => Promise.resolve(fakeBrowser),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Small helpers used by both e2e files
// ---------------------------------------------------------------------------

/** Seed a healthy cabinet with the given Corya number. */
export function seedCabinet(overrides?: {
  id?: string;
  numero_corya?: string;
  email_notification?: string;
  statut?: CabinetProcessingRow['statut'];
}): CabinetProcessingRow & { numero_corya: string } {
  const cabinet: CabinetProcessingRow & { numero_corya: string } = {
    id: overrides?.id ?? 'cab-e2e',
    nom: 'Cabinet E2E',
    email_notification: overrides?.email_notification ?? 'ops@cabinet.example',
    email_notification_cc: null,
    statut: overrides?.statut ?? 'actif',
    numero_corya: overrides?.numero_corya ?? '+41215550100',
  };
  store.cabinets.set(cabinet.id, cabinet);
  return cabinet;
}

/** Enqueue a job directly, bypassing the webhook (for resilience tests). */
export function insertJobDirect(overrides?: Partial<Job>): Job {
  const id = overrides?.id ?? nextJobId();
  const j: Job = {
    id,
    type: (overrides?.type as JobType) ?? 'process_appel',
    appel_id: overrides?.appel_id ?? 'appel-1',
    payload: overrides?.payload ?? {},
    status: overrides?.status ?? 'pending',
    attempts: overrides?.attempts ?? 0,
    max_attempts: overrides?.max_attempts ?? 5,
    run_after: overrides?.run_after ?? new Date().toISOString(),
    locked_at: overrides?.locked_at ?? null,
    locked_by: overrides?.locked_by ?? null,
    last_error: overrides?.last_error ?? null,
    created_at: overrides?.created_at ?? new Date().toISOString(),
    updated_at: overrides?.updated_at ?? new Date().toISOString(),
    correlation_id: overrides?.correlation_id ?? null,
    dead_letter_alerted_at: overrides?.dead_letter_alerted_at ?? null,
  };
  store.jobs.set(id, j);
  return j;
}

/** Insert an appel directly (used when seeding a worker test scenario). */
export function insertAppelDirect(overrides?: Partial<AppelProcessingRow>): AppelProcessingRow {
  const id = overrides?.id ?? 'appel-e2e';
  const a: AppelProcessingRow = {
    id,
    cabinet_id: overrides?.cabinet_id ?? 'cab-e2e',
    retell_call_id: overrides?.retell_call_id ?? 'call-e2e-1',
    date_appel: overrides?.date_appel ?? new Date().toISOString(),
    duree_secondes: overrides?.duree_secondes ?? 60,
    resultat: overrides?.resultat ?? 'rdv_pris',
    motif_appel: overrides?.motif_appel ?? 'consultation',
    patient_nom: overrides?.patient_nom ?? 'Test',
    patient_prenom: overrides?.patient_prenom ?? 'Patient',
    patient_telephone: overrides?.patient_telephone ?? '+41780000000',
    rdv_date: overrides?.rdv_date ?? null,
    rdv_praticien: overrides?.rdv_praticien ?? null,
    transcript: overrides?.transcript ?? 'Agent: bonjour\nUser: bonjour',
    pdf_url: overrides?.pdf_url ?? null,
    email_status: overrides?.email_status ?? 'pending',
  };
  store.appels.set(id, a);
  return a;
}

/** Wait until `predicate` returns truthy or `timeoutMs` elapses. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate never became truthy within ${timeoutMs}ms`);
}
