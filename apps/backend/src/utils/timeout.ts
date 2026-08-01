/**
 * Generic promise timeout helper.
 *
 * ---------------------------------------------------------------------------
 * Why a bespoke helper instead of Promise.race
 * ---------------------------------------------------------------------------
 * Two reasons:
 *   1. The rejection type must be a stable, classified error class so the
 *      SMTP retry policy (services/email.ts) can decide "retry or bail".
 *      Every timeout produced here is TRANSIENT — a slow disk, a jittery
 *      SMTP relay, a Puppeteer render that hits a lock. None of these are
 *      permanent by nature.
 *   2. Uniform label: the `label` becomes part of the error message AND
 *      the logged field name, so a triager reading Jelastic logs can spot
 *      which I/O leg pended (`db:findCabinet`, `smtp:sendMail`, ...).
 *
 * ---------------------------------------------------------------------------
 * AbortController integration
 * ---------------------------------------------------------------------------
 * Wrapping a promise with a timeout does NOT cancel the underlying work.
 * For fetch-based clients (supabase-js uses fetch), that means a socket
 * still in flight past the deadline keeps a server-side connection open —
 * exactly the leak we set out to fix. Callers that CAN pass an
 * AbortController do so via the optional `signal` option; the helper will
 * call `abort()` on the deadline. Callers that cannot (Puppeteer, older
 * paths) must rely on the client's own timeout knobs to reclaim resources
 * (e.g. `page.setDefaultTimeout` in services/pdf.ts).
 *
 * The signal ABORTS ON TIMEOUT ONLY. If the wrapped promise resolves or
 * rejects normally, we do NOT touch the signal — the caller may reuse it
 * for chained I/O.
 *
 * ---------------------------------------------------------------------------
 * NEVER swallows the original error
 * ---------------------------------------------------------------------------
 * If the wrapped promise rejects BEFORE the deadline, that rejection is
 * propagated verbatim. The timer is cleared. No wrapper class, no rename.
 */

/**
 * Thrown by `withTimeout` when the deadline expires. Classified transient
 * by the shared error taxonomy — the SMTP retry policy keys off `name` and
 * `transient` to decide whether to retry.
 */
export class TimeoutError extends Error {
  /** Symbolic name of the I/O leg (e.g. 'db:findCabinet', 'smtp:sendMail'). */
  public readonly label: string;
  /** Deadline that expired, in ms. */
  public readonly timeoutMs: number;
  /**
   * Retry classification. Timeouts are ALWAYS transient — the underlying
   * work may succeed on the next attempt (temporary network partition,
   * short SMTP throttle, GC pause).
   */
  public readonly transient = true as const;

  constructor(label: string, timeoutMs: number) {
    super(`timeout:${label}:${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Type guard for the classifier in services/email.ts. Kept here so the
 * class and its recogniser live together — a rename or refactor moves
 * both at once.
 */
export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof Error && err.name === 'TimeoutError';
}

export interface WithTimeoutOptions {
  /**
   * Optional AbortController. When the deadline expires, `abort()` is
   * called. If the wrapped promise resolves/rejects first, the signal is
   * left alone.
   */
  signal?: AbortController;
}

/**
 * Race `promise` against a `ms` deadline. Rejects with `TimeoutError(label)`
 * if the deadline fires first.
 *
 * `label` MUST be a constant string (or built from constants — never patient
 * data). It ends up in logs and in the persisted `jobs.last_error`.
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label: string,
  options?: WithTimeoutOptions,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        // Attempt to reclaim server-side resources associated with the
        // pending I/O. Best-effort — a client that ignores abort() will
        // simply keep the socket open until its own timeout, but at
        // least our worker slot is freed.
        try {
          options?.signal?.abort();
        } catch {
          // Aborting must never crash the timeout wrapper itself.
        }
        reject(new TimeoutError(label, ms));
      }, ms);
      // Attach handlers on the source promise; a rejection or resolution
      // BEFORE the deadline wins the race and cancels the timer in the
      // finally block below.
      Promise.resolve(promise).then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
