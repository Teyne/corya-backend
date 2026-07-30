import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  parseRetellPayload,
  verifyAndParse,
  verifyRetellSignature,
} from '../../src/services/retell.js';
import {
  RetellSignatureError,
  WebhookValidationError,
} from '../../src/utils/errors.js';

const SECRET = 'test-secret-abcdef';

function sign(body: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyRetellSignature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'call_analyzed' }), 'utf8');

  it('accepts a valid signature', () => {
    expect(verifyRetellSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a wrong signature of the correct length', () => {
    const wrong = sign(body).replace(/^./, (c) => (c === '0' ? '1' : '0'));
    expect(verifyRetellSignature(body, wrong, SECRET)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyRetellSignature(body, 'deadbeef', SECRET)).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(verifyRetellSignature(body, '', SECRET)).toBe(false);
  });

  it('rejects when the header is undefined', () => {
    expect(verifyRetellSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    expect(verifyRetellSignature(body, sign(body, 'other'), SECRET)).toBe(false);
  });
});

describe('parseRetellPayload', () => {
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
    const out = verifyAndParse(raw, sign(raw), SECRET);
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
    expect(() => verifyAndParse(junk, sign(junk), SECRET)).toThrow(
      WebhookValidationError,
    );
  });
});
