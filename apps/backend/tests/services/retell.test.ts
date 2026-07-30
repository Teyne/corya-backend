import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  parseRetellEvent,
  parseRetellPayload,
  verifyAndParse,
  verifyRetellSignature,
} from '../../src/services/retell.js';
import {
  RetellSignatureError,
  WebhookValidationError,
} from '../../src/utils/errors.js';

const SECRET = 'test-secret-abcdef';

/**
 * Build a valid `X-Retell-Signature` header value for the given raw body,
 * matching the real Retell format observed on ngrok:
 *   `v=<timestampMs>,d=<hmac(secret, `${ts}.${rawBody}`)>`.
 */
function buildHeader(
  body: Buffer,
  opts?: { secret?: string; timestampMs?: number },
): string {
  const secret = opts?.secret ?? SECRET;
  const ts = opts?.timestampMs ?? Date.now();
  const material = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), body]);
  const digest = createHmac('sha256', secret).update(material).digest('hex');
  return `v=${ts},d=${digest}`;
}

describe('verifyRetellSignature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'call_analyzed' }), 'utf8');

  it('accepts a valid signature in the v=ts,d=hex format', () => {
    expect(verifyRetellSignature(body, buildHeader(body), SECRET)).toBe(true);
  });

  it('rejects a signature whose HMAC digest is wrong but well-formed', () => {
    const now = Date.now();
    const material = Buffer.concat([Buffer.from(`${now}.`, 'utf8'), body]);
    const good = createHmac('sha256', SECRET).update(material).digest('hex');
    // Flip one hex char in the digest, keeping the 64-char length.
    const bad = good.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    expect(
      verifyRetellSignature(body, `v=${now},d=${bad}`, SECRET),
    ).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    expect(
      verifyRetellSignature(
        body,
        buildHeader(body, { secret: 'other-secret' }),
        SECRET,
      ),
    ).toBe(false);
  });

  it('rejects a signature whose timestamp is too far in the PAST (replay)', () => {
    const oldTs = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const header = buildHeader(body, { timestampMs: oldTs });
    expect(
      verifyRetellSignature(body, header, SECRET, { maxAgeSeconds: 300 }),
    ).toBe(false);
  });

  it('rejects a signature whose timestamp is too far in the FUTURE', () => {
    const futureTs = Date.now() + 10 * 60 * 1000; // 10 minutes ahead
    const header = buildHeader(body, { timestampMs: futureTs });
    expect(
      verifyRetellSignature(body, header, SECRET, { maxAgeSeconds: 300 }),
    ).toBe(false);
  });

  it('accepts a signature within the freshness window at both ends', () => {
    const now = Date.now();
    // 4 minutes ago — within 5-minute window
    const nearPast = now - 4 * 60 * 1000;
    // 4 minutes ahead — clock skew tolerated within window
    const nearFuture = now + 4 * 60 * 1000;
    expect(
      verifyRetellSignature(
        body,
        buildHeader(body, { timestampMs: nearPast }),
        SECRET,
        { maxAgeSeconds: 300, nowMs: now },
      ),
    ).toBe(true);
    expect(
      verifyRetellSignature(
        body,
        buildHeader(body, { timestampMs: nearFuture }),
        SECRET,
        { maxAgeSeconds: 300, nowMs: now },
      ),
    ).toBe(true);
  });

  it('rejects a header missing the v= prefix', () => {
    const now = Date.now();
    const digest = createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from(`${now}.`, 'utf8'), body]))
      .digest('hex');
    expect(verifyRetellSignature(body, `d=${digest}`, SECRET)).toBe(false);
  });

  it('rejects a header missing the d= component', () => {
    const now = Date.now();
    expect(verifyRetellSignature(body, `v=${now}`, SECRET)).toBe(false);
  });

  it('rejects a header without the comma separator', () => {
    const now = Date.now();
    const digest = createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from(`${now}.`, 'utf8'), body]))
      .digest('hex');
    // Space instead of comma.
    expect(verifyRetellSignature(body, `v=${now} d=${digest}`, SECRET)).toBe(
      false,
    );
  });

  it('rejects a header whose digest hex has the wrong length', () => {
    const now = Date.now();
    // 32 hex chars instead of 64.
    expect(
      verifyRetellSignature(body, `v=${now},d=${'a'.repeat(32)}`, SECRET),
    ).toBe(false);
  });

  it('rejects a header whose digest contains non-hex chars', () => {
    const now = Date.now();
    expect(
      verifyRetellSignature(body, `v=${now},d=${'z'.repeat(64)}`, SECRET),
    ).toBe(false);
  });

  it('rejects a raw HMAC hex (old format — no v=/d= wrapper)', () => {
    const material = Buffer.concat([
      Buffer.from(`${Date.now()}.`, 'utf8'),
      body,
    ]);
    const rawHex = createHmac('sha256', SECRET)
      .update(material)
      .digest('hex');
    expect(verifyRetellSignature(body, rawHex, SECRET)).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(verifyRetellSignature(body, '', SECRET)).toBe(false);
  });

  it('rejects when the header is undefined', () => {
    expect(verifyRetellSignature(body, undefined, SECRET)).toBe(false);
  });
});

describe('parseRetellPayload (call_analyzed strict)', () => {
  const validCall = {
    event: 'call_analyzed',
    call: {
      call_id: 'call_1',
      agent_id: 'agent_1',
      call_type: 'phone_call',
      call_status: 'ended',
      start_timestamp: 1000,
    },
  };

  it('parses a minimal valid payload', () => {
    const out = parseRetellPayload(validCall);
    expect(out.call.call_id).toBe('call_1');
  });

  it('throws WebhookValidationError on missing fields', () => {
    expect(() =>
      parseRetellPayload({ event: 'call_analyzed', call: { call_id: '' } }),
    ).toThrow(WebhookValidationError);
  });

  it('throws WebhookValidationError on wrong event', () => {
    expect(() =>
      parseRetellPayload({ ...validCall, event: 'other_event' }),
    ).toThrow(WebhookValidationError);
  });

  it('throws WebhookValidationError on non-object input', () => {
    expect(() => parseRetellPayload('nope')).toThrow(WebhookValidationError);
  });
});

describe('parseRetellEvent (discriminated union)', () => {
  it('parses a call_started event with only call_id + call_type', () => {
    const out = parseRetellEvent({
      event: 'call_started',
      call: { call_id: 'c_1', call_type: 'phone_call' },
    });
    expect(out.event).toBe('call_started');
  });

  it('parses a call_ended event with extra unknown fields (passthrough)', () => {
    const out = parseRetellEvent({
      event: 'call_ended',
      call: { call_id: 'c_2', something_new: true },
      event_timestamp: 42,
    });
    expect(out.event).toBe('call_ended');
  });

  it('parses a call_analyzed event with the strict schema', () => {
    const out = parseRetellEvent({
      event: 'call_analyzed',
      call: {
        call_id: 'c_3',
        agent_id: 'a',
        call_type: 'phone_call',
        call_status: 'ended',
        start_timestamp: 1,
      },
    });
    expect(out.event).toBe('call_analyzed');
  });

  it('rejects an unknown event value', () => {
    expect(() =>
      parseRetellEvent({ event: 'call_exploded', call: { call_id: 'c' } }),
    ).toThrow(WebhookValidationError);
  });

  it('rejects a call_analyzed missing strict fields, even though call_started tolerates the same shape', () => {
    // Ensure the discriminated union routes to the STRICT schema on
    // call_analyzed rather than the loose one.
    expect(() =>
      parseRetellEvent({
        event: 'call_analyzed',
        call: { call_id: 'c' }, // missing agent_id, call_type, ...
      }),
    ).toThrow(WebhookValidationError);
  });
});

describe('verifyAndParse', () => {
  const payloadObj = {
    event: 'call_analyzed',
    call: {
      call_id: 'c',
      agent_id: 'a',
      call_type: 'phone_call',
      call_status: 'ended',
      start_timestamp: 1,
    },
  };
  const raw = Buffer.from(JSON.stringify(payloadObj), 'utf8');

  it('parses when signature is valid', () => {
    const out = verifyAndParse(raw, buildHeader(raw), SECRET);
    expect(out.call.call_id).toBe('c');
  });

  it('throws RetellSignatureError on bad signature', () => {
    expect(() => verifyAndParse(raw, 'nope', SECRET)).toThrow(
      RetellSignatureError,
    );
  });

  it('throws RetellSignatureError when signature is missing', () => {
    expect(() => verifyAndParse(raw, undefined, SECRET)).toThrow(
      RetellSignatureError,
    );
  });

  it('throws WebhookValidationError when body is not JSON', () => {
    const junk = Buffer.from('not-json', 'utf8');
    expect(() => verifyAndParse(junk, buildHeader(junk), SECRET)).toThrow(
      WebhookValidationError,
    );
  });
});
