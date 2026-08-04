import type * as NodeHttp from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let bindErrorHandler: ((err: Error) => void) | undefined;
  const bindError = Object.assign(new Error('synthetic bind failure'), {
    code: 'EADDRINUSE',
  });
  const server = {
    close: vi.fn(),
    listen: vi.fn(() => {
      queueMicrotask(() => bindErrorHandler?.(bindError));
    }),
    off: vi.fn(),
    once: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === 'error') bindErrorHandler = handler;
    }),
  };

  return {
    bindError,
    closeAlertTransporter: vi.fn(),
    closeReceiptTransporter: vi.fn(),
    createServer: vi.fn(() => server),
    logAlertingModeOnce: vi.fn(),
    logRetellSecretSourceOnce: vi.fn(),
    runWave7GatedStartup: vi.fn(
      async (start: () => void | Promise<void>) => start(),
    ),
    server,
    startAlertPollers: vi.fn(),
  };
});

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttp>();
  return { ...actual, createServer: mocks.createServer };
});

vi.mock('../src/services/startup.js', () => ({
  runWave7GatedStartup: mocks.runWave7GatedStartup,
}));

vi.mock('../src/services/retell.js', () => ({
  logRetellSecretSourceOnce: mocks.logRetellSecretSourceOnce,
}));

vi.mock('../src/services/alert.js', () => ({
  closeAlertTransporter: mocks.closeAlertTransporter,
  logAlertingModeOnce: mocks.logAlertingModeOnce,
}));

vi.mock('../src/services/alert-pollers.js', () => ({
  closeReceiptTransporter: mocks.closeReceiptTransporter,
  startAlertPollers: mocks.startAlertPollers,
}));

const originalSigtermListeners = new Set(process.listeners('SIGTERM'));
const originalSigintListeners = new Set(process.listeners('SIGINT'));

afterEach(() => {
  for (const listener of process.listeners('SIGTERM')) {
    if (!originalSigtermListeners.has(listener)) {
      process.removeListener('SIGTERM', listener);
    }
  }
  for (const listener of process.listeners('SIGINT')) {
    if (!originalSigintListeners.has(listener)) {
      process.removeListener('SIGINT', listener);
    }
  }
});

describe('API runtime startup', () => {
  it('rejects an asynchronous HTTP bind error before starting pollers', async () => {
    const { startApiServer } = await import('../src/index.js');

    await expect(startApiServer()).rejects.toBe(mocks.bindError);

    expect(mocks.server.once).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );
    expect(mocks.startAlertPollers).not.toHaveBeenCalled();
  });
});
