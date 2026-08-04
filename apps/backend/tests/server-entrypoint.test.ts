import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  startApiServer: vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        queueMicrotask(() => reject(new Error('synthetic boot failure')));
      }),
  ),
  toLogFields: vi.fn(() => ({
    err_name: 'Error',
    err_message: 'synthetic boot failure',
  })),
}));

vi.mock('../src/index.js', () => ({
  startApiServer: mocks.startApiServer,
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { error: mocks.loggerError },
}));

vi.mock('../src/utils/errors.js', () => ({
  toLogFields: mocks.toLogFields,
}));

describe('API executable entrypoint', () => {
  it('is the PM2 target and starts the API instead of only importing its module', async () => {
    const require = createRequire(import.meta.url);
    const ecosystem = require('../ecosystem.config.cjs') as {
      apps: Array<{ name: string; script: string }>;
    };
    const apiProcess = ecosystem.apps.find(({ name }) => name === 'corya-api');
    expect(apiProcess?.script).toBe('dist/server.js');

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await import('../src/server.js');

      await vi.waitFor(() => {
        expect(mocks.startApiServer).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(1);
      });
      expect(mocks.toLogFields).toHaveBeenCalledTimes(1);
      expect(mocks.loggerError).toHaveBeenCalledWith(
        {
          err_name: 'Error',
          err_message: 'synthetic boot failure',
        },
        'api_boot_failed',
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
