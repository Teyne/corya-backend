/**
 * Compliance non-regression test — nLPD / art. 321 CP.
 *
 * Proves that the shared Pino logger NEVER emits patient identifiers,
 * transcript content, phone numbers, recording URLs or auth material —
 * even when the caller logs a full Retell webhook payload.
 *
 * How to trust this test:
 *   - We build a logger with a Writable capture stream, so we see exactly
 *     what would hit stdout/BetterStack in production.
 *   - We feed it an object with realistic-shaped Retell data using
 *     UNIQUE sentinel strings, then assert none of the sentinels leaked.
 *   - Manually validated by temporarily removing `transcript_object` from
 *     SENSITIVE_KEYS in logger.ts: the "no transcript verbatim leaked"
 *     assertion failed with the leaked `words[*].word` values, confirming
 *     the test actually detects breaches. Path was restored immediately.
 */
import { Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createLogger } from '../../src/config/logger.js';

interface CapturedLog {
  raw: string;
  parsed: Record<string, unknown>;
}

function makeTestLogger(): {
  logger: ReturnType<typeof createLogger>;
  logs: () => CapturedLog[];
} {
  const { stream, logs } = makeCapture();
  const logger = createLogger(stream);
  // The shared vitest setup pins LOG_LEVEL=silent to keep unrelated tests
  // quiet. Bump this test logger to 'trace' so our assertions actually see
  // output. This is a per-instance override, doesn't affect other tests.
  logger.level = 'trace';
  return { logger, logs };
}

function makeCapture(): { stream: Writable; logs: () => CapturedLog[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    logs: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((raw) => ({
          raw,
          parsed: JSON.parse(raw) as Record<string, unknown>,
        })),
  };
}

// Sentinel values — unique, unmistakable strings. If ANY of these appear in
// serialized log output, the redaction failed.
const SENTINELS = {
  patientNom: 'Dupont-SENTINEL-NOM',
  patientPrenom: 'Marie-SENTINEL-PRENOM',
  patientTel: '+41791234567-SENTINEL',
  fromNumber: '+41225550101-SENTINEL',
  toNumber: '+41225550202-SENTINEL',
  transcriptText: 'BONJOUR-SENTINEL-VERBATIM-TRANSCRIPT',
  transcriptContent1: 'AGENT-SENTINEL-CONTENT-1',
  transcriptContent2: 'PATIENT-SENTINEL-CONTENT-2',
  wordVerbatim: 'MOTVERBATIM-SENTINEL',
  recordingUrl: 'https://retell.example/recording-SENTINEL.wav',
  publicLogUrl: 'https://retell.example/log-SENTINEL.html',
  authHeader: 'Bearer super-secret-token-SENTINEL',
  retellSig: 'sig-header-SENTINEL',
  genericErrorMessage: 'GENERIC-ERROR-MESSAGE-SENTINEL',
  genericErrorHeader: 'GENERIC-ERROR-HEADER-SENTINEL',
  genericErrorCustom: 'GENERIC-ERROR-CUSTOM-SENTINEL',
  genericErrorCause: 'GENERIC-ERROR-CAUSE-SENTINEL',
} as const;

function buildRetellPayload(): Record<string, unknown> {
  return {
    event: 'call_analyzed',
    call: {
      call_id: 'call_test_123',
      agent_id: 'agent_test',
      from_number: SENTINELS.fromNumber,
      to_number: SENTINELS.toNumber,
      transcript: SENTINELS.transcriptText,
      transcript_object: [
        {
          role: 'agent',
          content: SENTINELS.transcriptContent1,
          words: [
            { word: SENTINELS.wordVerbatim, start: 0, end: 1 },
          ],
        },
        {
          role: 'user',
          content: SENTINELS.transcriptContent2,
          words: [{ word: SENTINELS.wordVerbatim, start: 1, end: 2 }],
        },
      ],
      recording_url: SENTINELS.recordingUrl,
      public_log_url: SENTINELS.publicLogUrl,
      call_analysis: {
        custom_analysis_data: {
          patient_nom: SENTINELS.patientNom,
          patient_prenom: SENTINELS.patientPrenom,
          patient_telephone: SENTINELS.patientTel,
        },
      },
    },
  };
}

function assertNoSentinelLeaked(raw: string): void {
  for (const [name, value] of Object.entries(SENTINELS)) {
    expect(raw, `sentinel "${name}" leaked in log output`).not.toContain(value);
  }
}

describe('logger — nLPD compliance redaction', () => {
  it('never leaks any Retell payload sentinel in the serialized log', () => {
    const { logger: testLogger, logs } = makeTestLogger();

    testLogger.info(
      { payload: buildRetellPayload() },
      'processing retell webhook',
    );

    const captured = logs();
    expect(captured.length).toBe(1);
    assertNoSentinelLeaked(captured[0].raw);

    // Structure is preserved — sensitive keys become '[REDACTED]', not gone.
    const payload = captured[0].parsed.payload as Record<string, unknown>;
    const call = payload.call as Record<string, unknown>;
    expect(call.transcript).toBe('[REDACTED]');
    expect(call.transcript_object).toBe('[REDACTED]');
    expect(call.recording_url).toBe('[REDACTED]');
    expect(call.public_log_url).toBe('[REDACTED]');
    expect(call.from_number).toBe('[REDACTED]');
    expect(call.to_number).toBe('[REDACTED]');
    // Non-sensitive metadata is kept — helps debugging.
    expect(call.call_id).toBe('call_test_123');
  });

  it('never leaks sensitive data when the payload is passed at the root', () => {
    const { logger: testLogger, logs } = makeTestLogger();

    testLogger.info(buildRetellPayload(), 'root-level payload');

    const raw = logs().map((l) => l.raw).join('\n');
    assertNoSentinelLeaked(raw);
  });

  it('redacts the complete headers object and top-level auth material', () => {
    const { logger: testLogger, logs } = makeTestLogger();

    testLogger.warn(
      {
        req: {
          method: 'POST',
          url: '/webhooks/retell/call-ended',
          headers: {
            authorization: SENTINELS.authHeader,
            'x-retell-signature': SENTINELS.retellSig,
            cookie: 'session=SENTINEL-COOKIE',
            'user-agent': 'retell-webhook/1.0',
          },
        },
        authorization: SENTINELS.authHeader,
      },
      'incoming webhook',
    );

    const captured = logs();
    const raw = captured.map((l) => l.raw).join('\n');
    expect(raw).not.toContain(SENTINELS.authHeader);
    expect(raw).not.toContain(SENTINELS.retellSig);
    expect(raw).not.toContain('SENTINEL-COOKIE');
    // Header objects are deliberately all-or-nothing: an unknown auth header
    // must not bypass a finite blacklist.
    expect(raw).not.toContain('retell-webhook/1.0');
    const req = captured[0].parsed.req as Record<string, unknown>;
    expect(req.headers).toBe('[REDACTED]');
  });

  it('redacts even when the sensitive key is deeply nested', () => {
    const { logger: testLogger, logs } = makeTestLogger();

    testLogger.info({
      ctx: {
        stage: 'analyze',
        wrapper: {
          more: {
            call: {
              transcript_object: [
                { content: SENTINELS.transcriptContent1 },
              ],
              recording_url: SENTINELS.recordingUrl,
            },
          },
        },
      },
    });

    const raw = logs().map((l) => l.raw).join('\n');
    expect(raw).not.toContain(SENTINELS.transcriptContent1);
    expect(raw).not.toContain(SENTINELS.recordingUrl);
  });

  it('serializes a generic Error as an allowlisted type only', () => {
    const { logger: testLogger, logs } = makeTestLogger();
    const err = new TypeError(SENTINELS.genericErrorMessage) as TypeError & {
      cause: Error;
      custom_payload: string;
      headers: Record<string, string>;
    };
    err.cause = new Error(SENTINELS.genericErrorCause);
    err.custom_payload = SENTINELS.genericErrorCustom;
    err.headers = { authorization: SENTINELS.genericErrorHeader };

    testLogger.error({ err }, 'synthetic_generic_error');

    const captured = logs();
    expect(captured).toHaveLength(1);
    assertNoSentinelLeaked(captured[0].raw);
    expect(captured[0].raw).not.toContain('message');
    expect(captured[0].raw).not.toContain('stack');
    expect(captured[0].raw).not.toContain('headers');
    expect(captured[0].raw).not.toContain('custom_payload');
    expect(captured[0].parsed).toMatchObject({
      level: 50,
      msg: 'synthetic_generic_error',
      err: { type: 'TypeError' },
    });
    expect(captured[0].parsed.err).toEqual({ type: 'TypeError' });
  });

  it.each([null, 'synthetic primitive'])(
    'safely serializes a non-object err value: %s',
    (err) => {
      const { logger: testLogger, logs } = makeTestLogger();

      expect(() =>
        testLogger.error({ err }, 'synthetic_invalid_error'),
      ).not.toThrow();

      const captured = logs();
      expect(captured).toHaveLength(1);
      expect(captured[0].raw).not.toContain('synthetic primitive');
      expect(captured[0].parsed.err).toEqual({ type: 'Error' });
    },
  );

  it('safely serializes an err object with a hostile type getter', () => {
    const { logger: testLogger, logs } = makeTestLogger();
    const err = Object.defineProperty({}, 'type', {
      get: () => {
        throw new Error('synthetic hostile getter');
      },
    });

    expect(() =>
      testLogger.error({ err }, 'synthetic_hostile_error'),
    ).not.toThrow();

    const captured = logs();
    expect(captured).toHaveLength(1);
    expect(captured[0].parsed.err).toEqual({ type: 'Error' });
  });
});
