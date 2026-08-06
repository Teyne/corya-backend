import { Writable } from 'node:stream';
import express from 'express';
import { pinoHttp, type HttpLogger } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  __internals,
  buildHttpLoggerOptions,
} from '../../src/config/http-logging.js';
import { createLogger } from '../../src/config/logger.js';

const SYNTHETIC = {
  correlationId: 'synthetic-correlation-123',
  querySecret: 'synthetic-query-secret-value',
  healthToken: 'synthetic-health-token-value',
  authorization: 'Bearer synthetic-authorization-value',
  cookie: 'synthetic_session=synthetic-cookie-value',
  apiKey: 'synthetic-api-key-value',
  proxyAuthorization: 'Basic synthetic-proxy-auth-value',
  unknownAuth: 'synthetic-unknown-auth-value',
  responseCookie: 'synthetic_response=synthetic-set-cookie-value',
  errorMessage: 'synthetic-automatic-error-message-secret',
  errorHeader: 'synthetic-error-header-secret',
  errorProperty: 'synthetic-error-property-secret',
  absoluteAuthority: 'synthetic-user:synthetic-password',
  absoluteQuery: 'synthetic-absolute-query-secret',
} as const;

function captureHttpLogs(): {
  middleware: HttpLogger;
  output: () => string;
} {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger(destination);
  logger.level = 'trace';
  return {
    middleware: pinoHttp(buildHttpLoggerOptions(logger)),
    output: () => chunks.join(''),
  };
}

const { middleware, output } = captureHttpLogs();
const testApp = express();
testApp.use(middleware);
testApp.get('/health/deep', (_req, res) => {
  res.setHeader('Set-Cookie', SYNTHETIC.responseCookie);
  res.status(200).json({ status: 'ok' });
});
testApp.get('/health/error', (req, res) => {
  req.log.error({ err_name: 'SyntheticHealthFailure' }, 'health_probe_failed');
  res.setHeader('WWW-Authenticate', 'Bearer synthetic-response-challenge');
  res.status(503).json({ status: 'unhealthy' });
});
testApp.get('/health/automatic-error', (_req, res) => {
  const error = new TypeError(SYNTHETIC.errorMessage) as TypeError & {
    headers: Record<string, string>;
    private_value: string;
  };
  error.headers = { authorization: SYNTHETIC.errorHeader };
  error.private_value = SYNTHETIC.errorProperty;
  res.err = error;
  res.status(500).json({ status: 'unhealthy' });
});

const absoluteUrlApp = express();
absoluteUrlApp.use((req, _res, next) => {
  req.url =
    `https://${SYNTHETIC.absoluteAuthority}@logs.invalid/health/absolute` +
    `?token=${SYNTHETIC.absoluteQuery}`;
  next();
});
absoluteUrlApp.use(middleware);
absoluteUrlApp.use((_req, res) => {
  res.status(204).end();
});

function sensitiveRequest(path: string): request.Test {
  return request(testApp)
    .get(path)
    .set('X-Correlation-Id', SYNTHETIC.correlationId)
    .set('X-Health-Token', SYNTHETIC.healthToken)
    .set('Authorization', SYNTHETIC.authorization)
    .set('Cookie', SYNTHETIC.cookie)
    .set('X-API-Key', SYNTHETIC.apiKey)
    .set('Proxy-Authorization', SYNTHETIC.proxyAuthorization)
    .set('X-Synthetic-Authentication', SYNTHETIC.unknownAuth);
}

function parsedLogs(): Record<string, unknown>[] {
  return output()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('pino-http safe HTTP allowlist', () => {
  it.each([
    {
      value: '/admin/calls/44444444-4444-4444-8444-444444444444?token=hidden',
      expected: '/admin/calls/:id',
    },
    {
      value: 'https://logs.invalid/admin/calls/44444444-4444-4444-8444-444444444444/pdf-url?token=hidden',
      expected: '/admin/calls/:id/pdf-url',
    },
    {
      value: '/admin/calls/not-a-uuid?token=hidden',
      expected: '/admin/calls/not-a-uuid',
    },
  ])('removes queries and normalizes UUID route segments', ({ value, expected }) => {
    expect(__internals.safeUrl(value)).toBe(expected);
  });

  it.each([
    { value: null, expectedType: 'Error' },
    { value: 'synthetic primitive', expectedType: 'Error' },
    {
      value: new TypeError('synthetic safe test error'),
      expectedType: 'TypeError',
    },
    {
      value: Object.defineProperty({}, 'type', {
        get: () => {
          throw new Error('synthetic hostile getter');
        },
      }),
      expectedType: 'Error',
    },
  ])(
    'defensively serializes $expectedType error inputs',
    ({ value, expectedType }) => {
      expect(() => __internals.serializeError(value)).not.toThrow();
      const serialized = __internals.serializeError(value);
      expect(serialized).toEqual({ type: expectedType });
      expect(JSON.stringify(serialized)).not.toContain('synthetic primitive');
    },
  );

  it('keeps useful health and error fields without logging any headers or secrets', async () => {
    await sensitiveRequest(
      `/health/deep?probe=${encodeURIComponent(SYNTHETIC.querySecret)}`,
    ).expect(200);
    await sensitiveRequest('/health/error?details=synthetic-error-query').expect(503);
    await sensitiveRequest('/health/automatic-error?details=hidden').expect(500);
    await request(absoluteUrlApp)
      .get('/synthetic-absolute-target')
      .set('X-Correlation-Id', SYNTHETIC.correlationId)
      .expect(204);

    const raw = output();
    const lowerRaw = raw.toLowerCase();
    for (const value of Object.values(SYNTHETIC).filter(
      (value) => value !== SYNTHETIC.correlationId,
    )) {
      expect(raw).not.toContain(value);
    }
    for (const sensitiveName of [
      'x-health-token',
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'proxy-authorization',
      'www-authenticate',
      'x-synthetic-authentication',
    ]) {
      expect(lowerRaw).not.toContain(sensitiveName);
    }
    expect(raw).not.toContain(SYNTHETIC.querySecret);
    expect(raw).not.toContain('synthetic-error-query');
    expect(raw).not.toContain('headers');

    const logs = parsedLogs();
    const deepLog = logs.find((entry) => {
      const req = entry.req as Record<string, unknown> | undefined;
      return req?.url === '/health/deep';
    });
    expect(deepLog).toMatchObject({
      level: 30,
      correlation_id: SYNTHETIC.correlationId,
      req: { method: 'GET', url: '/health/deep' },
      res: { statusCode: 200 },
    });
    expect(deepLog?.responseTime).toEqual(expect.any(Number));

    const manualErrorLog = logs.find(
      (entry) => entry.msg === 'health_probe_failed',
    );
    expect(manualErrorLog).toMatchObject({
      level: 50,
      correlation_id: SYNTHETIC.correlationId,
      err_name: 'SyntheticHealthFailure',
      req: { method: 'GET', url: '/health/error' },
    });

    const automaticErrorLog = logs.find((entry) => {
      const res = entry.res as Record<string, unknown> | undefined;
      return res?.statusCode === 503;
    });
    expect(automaticErrorLog).toMatchObject({
      level: 50,
      correlation_id: SYNTHETIC.correlationId,
      req: { method: 'GET', url: '/health/error' },
      res: { statusCode: 503 },
    });
    expect(automaticErrorLog?.responseTime).toEqual(expect.any(Number));

    const automatic500Log = logs.find((entry) => {
      const res = entry.res as Record<string, unknown> | undefined;
      return res?.statusCode === 500;
    });
    expect(automatic500Log).toMatchObject({
      level: 50,
      correlation_id: SYNTHETIC.correlationId,
      req: { method: 'GET', url: '/health/automatic-error' },
      res: { statusCode: 500 },
      err: { type: 'TypeError' },
    });
    expect(automatic500Log?.responseTime).toEqual(expect.any(Number));
    expect(Object.keys(automatic500Log?.err as Record<string, unknown>)).toEqual([
      'type',
    ]);

    const absoluteUrlLog = logs.find((entry) => {
      const req = entry.req as Record<string, unknown> | undefined;
      return req?.url === '/health/absolute';
    });
    expect(absoluteUrlLog).toMatchObject({
      correlation_id: SYNTHETIC.correlationId,
      req: { method: 'GET', url: '/health/absolute' },
      res: { statusCode: 204 },
    });
  });
});
