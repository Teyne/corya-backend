/**
 * Retry backoff — exponential with jitter.
 *
 * Formula: `min(cap, 2^attempts + random(0, jitterCap))` seconds.
 *
 * Why jitter: without it, N workers hitting a transient SMTP or Retell
 * outage would all retry at exactly the same wall-clock second, dogpiling
 * the recovering service (thundering herd). Adding a small random offset
 * spreads the retries.
 *
 * `attempts` is expected to be the POST-claim value (i.e. how many attempts
 * this job has already used), which is what `claim_jobs` returns.
 */

export interface BackoffOptions {
  /** Hard cap on the returned value, seconds. Default 300 s (5 min). */
  capSeconds?: number;
  /** Max jitter added on top, seconds. Default 30. */
  jitterCapSeconds?: number;
  /** Injectable RNG so tests can be deterministic. Defaults to Math.random. */
  random?: () => number;
}

/**
 * Compute the delay to wait before the next retry.
 *
 * We saturate `attempts` at 20 so `2^attempts` cannot overflow the cap in a
 * surprising way if a job somehow reaches an unusually high attempt count.
 */
export function computeBackoffSeconds(
  attempts: number,
  options?: BackoffOptions,
): number {
  const cap = options?.capSeconds ?? 300;
  const jitterCap = options?.jitterCapSeconds ?? 30;
  const random = options?.random ?? Math.random;

  const safeAttempts = Math.max(1, Math.min(20, Math.floor(attempts)));
  const base = Math.pow(2, safeAttempts);
  const jitter = random() * jitterCap;
  return Math.min(cap, base + jitter);
}
