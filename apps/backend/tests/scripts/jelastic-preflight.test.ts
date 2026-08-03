import { describe, expect, it } from 'vitest';

interface PreflightOptions {
  argv: string[];
  environment: Record<string, string>;
  nodeVersion: string;
  root?: string;
  fileSystem: {
    existsSync: (path: string) => boolean;
    statSync: (path: string) => { isFile: () => boolean };
  };
  output: {
    log: (message: string) => void;
    error: (message: string) => void;
  };
}

interface PreflightModule {
  parseRole: (argv: string[]) => 'api' | 'worker' | null;
  runPreflight: (options: PreflightOptions) => boolean;
}

interface SmokeOptions {
  renders: number;
  timeoutMs: number;
}

interface SmokeSummary {
  renders: number;
  initial_node_rss_mib: number;
  final_node_rss_mib: number;
  peak_node_rss_mib: number;
}

interface SmokeModule {
  parseOptions: (argv: string[]) => SmokeOptions;
  runSmoke: (
    options: SmokeOptions,
    dependencies: Record<string, unknown>,
  ) => Promise<SmokeSummary>;
}

const preflightScriptPath = '../../scripts/preflight-jelastic.mjs';
const smokeScriptPath = '../../scripts/smoke-puppeteer.mjs';
const preflightModule = (await import(
  preflightScriptPath
)) as PreflightModule;
const smokeModule = (await import(smokeScriptPath)) as SmokeModule;

const { parseRole, runPreflight } = preflightModule;
const { parseOptions, runSmoke } = smokeModule;

const validCommonEnvironment = Object.freeze({
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://api.corya.test',
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_KEY: 'synthetic-service-key',
  RETELL_API_KEY: 'synthetic-retell-key',
  ALERT_EMAIL: 'ops@corya.test',
  HEALTH_DEEP_TOKEN: 'synthetic-health-token',
  SMTP_HOST: 'smtp.corya.test',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'synthetic-user',
  SMTP_PASSWORD: 'synthetic-password',
  SMTP_FROM_NAME: 'Corya Operations',
  SMTP_FROM_EMAIL: 'noreply@corya.test',
});

function validEnvironment(role: 'api' | 'worker'): Record<string, string> {
  if (role === 'api') {
    return {
      ...validCommonEnvironment,
      PORT: '3123',
      CORS_ORIGIN: 'https://admin.corya.test,https://www.corya.test',
      TRUST_PROXY_HOPS: '1',
    };
  }
  return {
    ...validCommonEnvironment,
    ADMIN_APP_URL: 'https://admin.corya.test',
    JOB_BATCH_SIZE: '1',
  };
}

function passingFileSystem(): PreflightOptions['fileSystem'] {
  return {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true }),
  };
}

function captureOutput(): {
  lines: string[];
  output: PreflightOptions['output'];
} {
  const lines: string[] = [];
  return {
    lines,
    output: {
      log: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  };
}

function runFor(
  role: 'api' | 'worker',
  overrides: Partial<PreflightOptions> = {},
): { result: boolean; lines: string[] } {
  const capture = captureOutput();
  const result = runPreflight({
    argv: ['--role', role],
    environment: validEnvironment(role),
    nodeVersion: '24.18.0',
    fileSystem: passingFileSystem(),
    output: capture.output,
    ...overrides,
  });
  return { result, lines: capture.lines };
}

describe('Jelastic role preflight', () => {
  it('accepts exclusively --role api|worker', () => {
    expect(parseRole(['--role', 'api'])).toBe('api');
    expect(parseRole(['--role', 'worker'])).toBe('worker');
    expect(parseRole(['--role', 'api', '--extra'])).toBeNull();
    expect(parseRole(['--role', 'other'])).toBeNull();
  });

  it('accepts valid API and worker configurations on Node 24', () => {
    expect(runFor('api').result).toBe(true);
    expect(runFor('worker').result).toBe(true);
  });

  it('requires exactly one worker job during the Jelastic trial', () => {
    const environment = validEnvironment('worker');
    environment.JOB_BATCH_SIZE = '2';

    const { result, lines } = runFor('worker', { environment });

    expect(result).toBe(false);
    expect(lines.join('\n')).toContain('JOB_BATCH_SIZE');
    expect(lines.join('\n')).not.toContain('=2');
  });

  it('rejects malformed URLs, emails, tokens, booleans and bounded numbers', () => {
    const environment = {
      ...validEnvironment('api'),
      APP_BASE_URL: 'http://api.corya.test',
      SUPABASE_URL: 'not a url',
      ALERT_EMAIL: 'not-an-email',
      SMTP_FROM_EMAIL: 'not-an-email',
      HEALTH_DEEP_TOKEN: 'short',
      SMTP_PORT: '70000',
      SMTP_SECURE: 'sometimes',
      PORT: '0',
      CORS_ORIGIN: '*',
      TRUST_PROXY_HOPS: '11',
    };

    const { result, lines } = runFor('api', { environment });
    const report = lines.join('\n');

    expect(result).toBe(false);
    for (const name of [
      'APP_BASE_URL',
      'SUPABASE_URL',
      'APP_BASE_URL',
      'ALERT_EMAIL',
      'SMTP_FROM_EMAIL',
      'HEALTH_DEEP_TOKEN',
      'SMTP_PORT',
      'SMTP_SECURE',
      'PORT',
      'CORS_ORIGIN',
      'TRUST_PROXY_HOPS',
    ]) {
      expect(report).toContain(name);
    }
    for (const value of Object.values(environment)) {
      expect(report).not.toContain(value);
    }
  });

  it('reports missing variables by name without disclosing another value', () => {
    const environment = validEnvironment('api');
    environment.SUPABASE_SERVICE_KEY = 'do-not-disclose-this-value';
    delete environment.RETELL_API_KEY;

    const { result, lines } = runFor('api', { environment });
    const report = lines.join('\n');

    expect(result).toBe(false);
    expect(report).toContain('RETELL_API_KEY');
    expect(report).not.toContain('do-not-disclose-this-value');
  });

  it('rejects a non-24 runtime and a missing compiled role entrypoint', () => {
    const wrongNode = runFor('api', { nodeVersion: '22.23.1' });
    expect(wrongNode.result).toBe(false);
    expect(wrongNode.lines.join('\n')).toContain('Node.js major 24');

    const missingDist = runFor('worker', {
      fileSystem: {
        existsSync: () => false,
        statSync: () => ({ isFile: () => false }),
      },
    });
    expect(missingDist.result).toBe(false);
    expect(missingDist.lines.join('\n')).toContain('dist/worker.js');
  });

  it('keeps invalid CLI diagnostics stable and value-free', () => {
    const capture = captureOutput();
    const result = runPreflight({
      argv: ['--role', 'api', '--token=do-not-disclose'],
      environment: validEnvironment('api'),
      nodeVersion: '24.18.0',
      fileSystem: passingFileSystem(),
      output: capture.output,
    });

    expect(result).toBe(false);
    expect(capture.lines.join('\n')).toContain('invalid arguments');
    expect(capture.lines.join('\n')).not.toContain('do-not-disclose');
  });
});

describe('Puppeteer smoke options and lifecycle', () => {
  it('keeps sequential render count and timeout bounded', () => {
    expect(parseOptions([])).toEqual({ renders: 3, timeoutMs: 15_000 });
    expect(parseOptions(['--renders', '10', '--timeout-ms', '60000'])).toEqual({
      renders: 10,
      timeoutMs: 60_000,
    });
    expect(() => parseOptions(['--renders', '0'])).toThrow();
    expect(() => parseOptions(['--renders', '11'])).toThrow();
    expect(() => parseOptions(['--timeout-ms', '999'])).toThrow();

    let message = '';
    try {
      parseOptions(['--secret=do-not-disclose', 'value']);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('unknown option');
    expect(message).not.toContain('do-not-disclose');
  });

  it('renders strictly sequentially and reports Node RSS explicitly', async () => {
    let activePages = 0;
    let maximumActivePages = 0;
    let pageNumber = 0;
    let browserClosed = false;
    let clock = 0;
    const logs: string[] = [];

    const browser = {
      newPage: () => {
        pageNumber += 1;
        activePages += 1;
        maximumActivePages = Math.max(maximumActivePages, activePages);
        return Promise.resolve({
          setDefaultTimeout: () => undefined,
          setContent: () => Promise.resolve(),
          pdf: () => Promise.resolve(Uint8Array.from([1, 2, pageNumber])),
          close: () => {
            activePages -= 1;
            return Promise.resolve();
          },
        });
      },
      close: () => {
        browserClosed = true;
        return Promise.resolve();
      },
      process: () => null,
    };

    const summary = await runSmoke(
      { renders: 3, timeoutMs: 1_000 },
      {
        puppeteerApi: { launch: () => Promise.resolve(browser) },
        now: () => {
          clock += 10;
          return clock;
        },
        memoryUsage: () => ({ rss: 64 * 1024 * 1024 }),
        output: { log: (message: string) => logs.push(message) },
        cleanupTimeoutMs: 20,
      },
    );

    expect(summary).toMatchObject({
      renders: 3,
      initial_node_rss_mib: 64,
      final_node_rss_mib: 64,
      peak_node_rss_mib: 64,
    });
    expect(maximumActivePages).toBe(1);
    expect(activePages).toBe(0);
    expect(browserClosed).toBe(true);
    expect(logs.join('\n')).toContain('node_rss_mib');
    expect(logs.join('\n')).not.toMatch(/[{,]"rss_mib":/u);
  });

  it('bounds cleanup and kills only its launched browser when close blocks', async () => {
    let pageCloseCalled = false;
    let browserCloseCalled = false;
    const killedSignals: string[] = [];
    const neverSettles = () => new Promise<void>(() => undefined);

    const browser = {
      newPage: () => Promise.resolve({
        setDefaultTimeout: () => undefined,
        setContent: () => Promise.resolve(),
        pdf: () => Promise.reject(new Error('synthetic render failure')),
        close: () => {
          pageCloseCalled = true;
          return neverSettles();
        },
      }),
      close: () => {
        browserCloseCalled = true;
        return neverSettles();
      },
      process: () => ({
        kill: (signal: string) => {
          killedSignals.push(signal);
          return true;
        },
      }),
    };

    await expect(
      runSmoke(
        { renders: 1, timeoutMs: 1_000 },
        {
          puppeteerApi: { launch: () => Promise.resolve(browser) },
          output: { log: () => undefined },
          cleanupTimeoutMs: 5,
        },
      ),
    ).rejects.toThrow('synthetic render failure');

    expect(pageCloseCalled).toBe(true);
    expect(browserCloseCalled).toBe(true);
    expect(killedSignals).toEqual(['SIGKILL']);
  });

  it('fails explicitly when page cleanup times out after a successful render', async () => {
    const errors: string[] = [];
    const browser = {
      newPage: () => Promise.resolve({
        setDefaultTimeout: () => undefined,
        setContent: () => Promise.resolve(),
        pdf: () => Promise.resolve(Uint8Array.from([1, 2, 3])),
        close: () => new Promise<void>(() => undefined),
      }),
      close: () => Promise.resolve(),
      process: () => null,
    };

    await expect(
      runSmoke(
        { renders: 1, timeoutMs: 1_000 },
        {
          puppeteerApi: { launch: () => Promise.resolve(browser) },
          output: {
            log: () => undefined,
            error: (message: string) => errors.push(message),
          },
          cleanupTimeoutMs: 5,
        },
      ),
    ).rejects.toThrow('page cleanup failed');

    expect(errors).toEqual(['[puppeteer-smoke] page cleanup failed']);
  });

  it('fails explicitly and kills its browser when browser cleanup times out', async () => {
    const errors: string[] = [];
    const killedSignals: string[] = [];
    const browser = {
      newPage: () => Promise.resolve({
        setDefaultTimeout: () => undefined,
        setContent: () => Promise.resolve(),
        pdf: () => Promise.resolve(Uint8Array.from([1, 2, 3])),
        close: () => Promise.resolve(),
      }),
      close: () => new Promise<void>(() => undefined),
      process: () => ({
        kill: (signal: string) => {
          killedSignals.push(signal);
          return true;
        },
      }),
    };

    await expect(
      runSmoke(
        { renders: 1, timeoutMs: 1_000 },
        {
          puppeteerApi: { launch: () => Promise.resolve(browser) },
          output: {
            log: () => undefined,
            error: (message: string) => errors.push(message),
          },
          cleanupTimeoutMs: 5,
        },
      ),
    ).rejects.toThrow('browser cleanup failed');

    expect(errors).toEqual(['[puppeteer-smoke] browser cleanup failed']);
    expect(killedSignals).toEqual(['SIGKILL']);
  });
});
