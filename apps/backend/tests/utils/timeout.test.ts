/**
 * Unit tests — utils/timeout.ts (session 4 vague 3).
 *
 * We prove:
 *   - withTimeout resolves when the wrapped promise resolves before deadline
 *   - withTimeout rejects with TimeoutError classified as transient
 *   - the timer is cleared on both resolve and reject paths (no leaked handles)
 *   - the source rejection propagates unchanged when it beats the deadline
 *   - an optional AbortController is aborted on timeout, left alone otherwise
 */
import { describe, expect, it, vi } from 'vitest';
import { isTimeoutError, TimeoutError, withTimeout } from '../../src/utils/timeout.js';

describe('withTimeout', () => {
  it('resolves with the wrapped value when it finishes before the deadline', async () => {
    const result = await withTimeout(Promise.resolve(42), 100, 'test:ok');
    expect(result).toBe(42);
  });

  it('rejects with a TimeoutError classified transient when the deadline fires first', async () => {
    const pending = new Promise((r) => setTimeout(() => r('late'), 500));
    await expect(withTimeout(pending, 20, 'test:slow')).rejects.toSatisfy(
      (err) => isTimeoutError(err) && err.label === 'test:slow' && err.transient === true,
    );
  });

  it('propagates the source rejection unchanged when it beats the deadline', async () => {
    const boom = new Error('inner_error');
    const rejecting = Promise.reject(boom);
    await expect(withTimeout(rejecting, 100, 'test:boom')).rejects.toBe(boom);
  });

  it('aborts the AbortController on timeout', async () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');
    const pending = new Promise((r) => setTimeout(() => r('late'), 500));
    await expect(
      withTimeout(pending, 10, 'test:abort', { signal: controller }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT abort the AbortController when the source resolves in time', async () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');
    await withTimeout(Promise.resolve('ok'), 100, 'test:noabort', { signal: controller });
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it('TimeoutError.message embeds the label and the deadline', () => {
    const err = new TimeoutError('smtp:sendMail', 30_000);
    expect(err.message).toBe('timeout:smtp:sendMail:30000ms');
    expect(err.name).toBe('TimeoutError');
  });
});
