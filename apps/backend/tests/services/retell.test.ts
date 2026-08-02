/**
 * Tests unitaires — services/retell.ts
 *
 * Session 2.2 : la vérification HMAC est déléguée au SDK officiel
 * `retell-sdk`. On MOCKE le SDK au lieu de tester notre calcul maison
 * (qui n'existe plus). Les anciens tests qui recomputaient un HMAC
 * `${ts}.${body}` ont été supprimés — ils validaient une hypothèse
 * jamais confirmée sur le format Retell, sans valeur pour la couverture
 * actuelle.
 *
 * Ce qu'on teste ici :
 *   1. Le contrôle de fraîcheur CONDITIONNEL (`checkFreshnessIfKnownFormat`) :
 *      dérives, fenêtre, forme reconnue vs forme inconnue (le point le plus
 *      délicat de la migration, celui qui pourrait recréer le bug d'origine
 *      s'il rejetait à tort).
 *   2. Le contrat de `verifyRetellSignature` :
 *        - rejette AVANT d'appeler le SDK si header connu et hors fenêtre
 *        - délègue au SDK sinon (forme reconnue ET fenêtre OK, OU forme
 *          inconnue) et propage son verdict boolean
 *        - passe bien la CHAÎNE (rawBody.toString('utf-8')), l'apiKey et
 *          le header brut au SDK
 *        - renvoie false sans propager si le SDK throw (défense en profondeur)
 *   3. `parseRetellPayload` / `parseRetellEvent` : inchangé, toujours notre
 *      responsabilité — on garde les tests existants.
 *   4. `verifyAndParse` : async désormais, mock du SDK côté OK/KO.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkDelete = vi.hoisted(() => vi.fn());

// -- Mock du SDK Retell AVANT tout import du code sous test. ---------------
// `retell-sdk` expose une fonction async `verify(body, apiKey, signature)`
// (cf. node_modules/retell-sdk/lib/webhook_auth.d.ts). On la remplace par un
// spy qu'on contrôle test par test.
vi.mock('retell-sdk', () => {
  return {
    verify: vi.fn(),
    default: class RetellMock {
      call = { delete: sdkDelete };
    },
  };
});

// Import APRÈS le mock (ordre important pour ESM + vitest).
const { verify: sdkVerify } = await import('retell-sdk');
const {
  checkFreshnessIfKnownFormat,
  parseRetellEvent,
  parseRetellPayload,
  verifyAndParse,
  verifyRetellSignature,
  deleteRetellCall,
} = await import('../../src/services/retell.js');
const { RetellSignatureError, WebhookValidationError } = await import(
  '../../src/utils/errors.js'
);

const SECRET = 'test-api-key-abcdef';

const mockSdkVerify = vi.mocked(sdkVerify);

beforeEach(() => {
  mockSdkVerify.mockReset();
  sdkDelete.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('deleteRetellCall', () => {
  it('returns deleted after the SDK 204/no-content success', async () => {
    sdkDelete.mockResolvedValue(undefined);
    await expect(deleteRetellCall('call-1')).resolves.toBe('deleted');
    expect(sdkDelete).toHaveBeenCalledWith('call-1');
  });

  it('maps a 404 to idempotent not_found', async () => {
    sdkDelete.mockRejectedValue({ status: 404 });
    await expect(deleteRetellCall('call-missing')).resolves.toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// 1. Contrôle de fraîcheur conditionnel
// ---------------------------------------------------------------------------
describe('checkFreshnessIfKnownFormat', () => {
  it('returns in_window for a known-format header within the max age', () => {
    const now = Date.now();
    const header = `v=${now - 60_000},d=${'a'.repeat(64)}`; // 1 min ago
    const res = checkFreshnessIfKnownFormat(header, { maxAgeSeconds: 300, nowMs: now });
    expect(res).toEqual({ status: 'in_window' });
  });

  it('returns out_of_window with direction=past when timestamp too old', () => {
    const now = Date.now();
    const header = `v=${now - 10 * 60_000},d=${'a'.repeat(64)}`;
    const res = checkFreshnessIfKnownFormat(header, { maxAgeSeconds: 300, nowMs: now });
    expect(res.status).toBe('out_of_window');
    if (res.status !== 'out_of_window') throw new Error('narrowing');
    expect(res.direction).toBe('past');
    expect(res.driftSeconds).toBeGreaterThan(300);
  });

  it('returns out_of_window with direction=future when timestamp too far ahead', () => {
    const now = Date.now();
    const header = `v=${now + 10 * 60_000},d=${'a'.repeat(64)}`;
    const res = checkFreshnessIfKnownFormat(header, { maxAgeSeconds: 300, nowMs: now });
    expect(res.status).toBe('out_of_window');
    if (res.status !== 'out_of_window') throw new Error('narrowing');
    expect(res.direction).toBe('future');
  });

  it('returns unrecognized when the header is absent', () => {
    expect(checkFreshnessIfKnownFormat(undefined)).toEqual({ status: 'unrecognized' });
    expect(checkFreshnessIfKnownFormat('')).toEqual({ status: 'unrecognized' });
  });

  it('returns unrecognized when the header does not match v=<ts>,d=<hex>', () => {
    // Hypothetical future Retell format we do not want to reject preemptively.
    expect(
      checkFreshnessIfKnownFormat('t=1785450205245,s=deadbeef'),
    ).toEqual({ status: 'unrecognized' });
    expect(
      checkFreshnessIfKnownFormat('sha256=abcdef'),
    ).toEqual({ status: 'unrecognized' });
    expect(
      checkFreshnessIfKnownFormat('v=notanumber,d=abcd'),
    ).toEqual({ status: 'unrecognized' });
  });

  it('accepts both lowercase and uppercase hex in the known-format regex', () => {
    const now = Date.now();
    const lower = `v=${now},d=${'a'.repeat(64)}`;
    const upper = `v=${now},d=${'A'.repeat(64)}`;
    expect(
      checkFreshnessIfKnownFormat(lower, { nowMs: now, maxAgeSeconds: 300 }).status,
    ).toBe('in_window');
    expect(
      checkFreshnessIfKnownFormat(upper, { nowMs: now, maxAgeSeconds: 300 }).status,
    ).toBe('in_window');
  });
});

// ---------------------------------------------------------------------------
// 2. verifyRetellSignature — délégation au SDK, avec garde-fou fraîcheur
// ---------------------------------------------------------------------------
describe('verifyRetellSignature', () => {
  const rawBody = Buffer.from('{"event":"call_analyzed"}', 'utf8');

  it('passes body-as-string, apiKey and header to the SDK when format is known + fresh', async () => {
    mockSdkVerify.mockResolvedValueOnce(true);
    const now = Date.now();
    const header = `v=${now},d=${'a'.repeat(64)}`;

    const ok = await verifyRetellSignature(rawBody, header, SECRET, { nowMs: now });
    expect(ok).toBe(true);
    expect(mockSdkVerify).toHaveBeenCalledTimes(1);

    // The founder was explicit: pass rawBody.toString('utf-8'), not the Buffer.
    const [passedBody, passedSecret, passedSig] = mockSdkVerify.mock.calls[0];
    expect(typeof passedBody).toBe('string');
    expect(passedBody).toBe(rawBody.toString('utf-8'));
    expect(passedSecret).toBe(SECRET);
    expect(passedSig).toBe(header);
  });

  it('rejects WITHOUT calling the SDK when known format + timestamp out of window', async () => {
    const now = Date.now();
    const staleHeader = `v=${now - 10 * 60_000},d=${'a'.repeat(64)}`;
    const ok = await verifyRetellSignature(rawBody, staleHeader, SECRET, {
      maxAgeSeconds: 300,
      nowMs: now,
    });
    expect(ok).toBe(false);
    expect(mockSdkVerify).not.toHaveBeenCalled(); // defence-in-depth short-circuit
  });

  it('delegates to the SDK (does NOT reject on freshness) for UNKNOWN-format headers', async () => {
    // This is the migration-critical case: our old code rejected everything
    // that didn't match `v=<ts>,d=<hex>`. That was the whole bug. Now we
    // must delegate silently.
    mockSdkVerify.mockResolvedValueOnce(true);
    const ok = await verifyRetellSignature(
      rawBody,
      't=1785450205245,s=deadbeef', // hypothetical future Retell format
      SECRET,
    );
    expect(ok).toBe(true);
    expect(mockSdkVerify).toHaveBeenCalledTimes(1);
  });

  it('delegates to the SDK when the header is missing entirely (SDK will return false)', async () => {
    mockSdkVerify.mockResolvedValueOnce(false);
    const ok = await verifyRetellSignature(rawBody, undefined, SECRET);
    expect(ok).toBe(false);
    // The SDK was called with an empty signature string, as documented.
    expect(mockSdkVerify).toHaveBeenCalledWith(
      rawBody.toString('utf-8'),
      SECRET,
      '',
    );
  });

  it('returns the SDK boolean verdict unchanged (false when SDK says false)', async () => {
    mockSdkVerify.mockResolvedValueOnce(false);
    const now = Date.now();
    const header = `v=${now},d=${'a'.repeat(64)}`;
    const ok = await verifyRetellSignature(rawBody, header, SECRET, { nowMs: now });
    expect(ok).toBe(false);
  });

  it('returns false (does not throw) when the SDK throws', async () => {
    mockSdkVerify.mockRejectedValueOnce(new Error('subtle crypto unavailable'));
    const now = Date.now();
    const header = `v=${now},d=${'a'.repeat(64)}`;
    const ok = await verifyRetellSignature(rawBody, header, SECRET, { nowMs: now });
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. parseRetellPayload / parseRetellEvent — inchangé
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 4. verifyAndParse — désormais async
// ---------------------------------------------------------------------------
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

  it('parses when the SDK accepts the signature', async () => {
    mockSdkVerify.mockResolvedValueOnce(true);
    const out = await verifyAndParse(raw, 'sig-does-not-matter', SECRET);
    expect(out.call.call_id).toBe('c');
  });

  it('throws RetellSignatureError when the SDK rejects the signature', async () => {
    mockSdkVerify.mockResolvedValueOnce(false);
    await expect(verifyAndParse(raw, 'bad', SECRET)).rejects.toThrow(
      RetellSignatureError,
    );
  });

  it('throws RetellSignatureError when signature is missing (SDK returns false on empty)', async () => {
    mockSdkVerify.mockResolvedValueOnce(false);
    await expect(verifyAndParse(raw, undefined, SECRET)).rejects.toThrow(
      RetellSignatureError,
    );
  });

  it('throws WebhookValidationError when body is not JSON (SDK accepted signature)', async () => {
    mockSdkVerify.mockResolvedValueOnce(true);
    const junk = Buffer.from('not-json', 'utf8');
    await expect(verifyAndParse(junk, 'sig', SECRET)).rejects.toThrow(
      WebhookValidationError,
    );
  });
});
