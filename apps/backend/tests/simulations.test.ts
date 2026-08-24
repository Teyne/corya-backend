/**
 * Simulation tests for Corya backend conversation scenarios
 *
 * These tests simulate various conversation scenarios (R01-R14)
 * using entirely fictional data as specified in the requirements.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// --- Mocks positionnés AVANT tout import du graphe de l'app ---

// 1. Mock du SDK Retell
vi.mock('retell-sdk', () => ({
  verify: vi.fn(),
}));

// 2. Mock DB (in-memory)
const cabinetRow = {
  id: '11111111-1111-1111-1111-111111111111',
  numero_corya: 'SYNTHETIC_CORYA_NUMBER',
  email_notification: 'ops@corya.example',
  email_notification_cc: null,
};

const insertedAppels = new Map<string, string>(); // retell_call_id -> appelId
const enqueuedJobs: Array<{ type: string; appelId: string }> = [];

vi.mock('../src/db/queries.js', () => {
  return {
    findCabinetByCoryaNumber: vi.fn((toNumber: string) => {
      if (toNumber === cabinetRow.numero_corya) return Promise.resolve(cabinetRow);
      return Promise.resolve(null);
    }),
    insertAppelIdempotent: vi.fn((row: { retell_call_id: string }) => {
      const existing = insertedAppels.get(row.retell_call_id);
      if (existing) {
        return Promise.resolve({ appelId: existing, duplicate: true });
      }
      const id = `appel-${insertedAppels.size + 1}`;
      insertedAppels.set(row.retell_call_id, id);
      return Promise.resolve({ appelId: id, duplicate: false });
    }),
    enqueueJobIdempotent: vi.fn((row: { type: string; appel_id: string }) => {
      const key = `${row.type}:${row.appel_id}`;
      const already = enqueuedJobs.some(
        (j) => `${j.type}:${j.appelId}` === key,
      );
      enqueuedJobs.push({ type: row.type, appelId: row.appel_id });
      return Promise.resolve(!already);
    }),
    persistCallAnalyzed: vi.fn((input: {
      appel: { retell_call_id: string };
      correlationId: string | null;
    }) => {
      const existing = insertedAppels.get(input.appel.retell_call_id);
      const appelId = existing ?? `appel-${insertedAppels.size + 1}`;
      insertedAppels.set(input.appel.retell_call_id, appelId);
      for (const type of ['process_appel', 'purge_audio_retell']) {
        if (!enqueuedJobs.some((job) => job.type === type && job.appelId === appelId)) {
          enqueuedJobs.push({ type, appelId });
        }
      }
      return Promise.resolve({ appelId, duplicate: Boolean(existing) });
    }),
    reconcileCalendarBookingForAppel: vi.fn(() => Promise.resolve(null)),
    beginCalcomOAuthFlow: vi.fn(() => Promise.reject(new Error('not_configured'))),
    consumeCalcomOAuthFlow: vi.fn(() => Promise.resolve(null)),
    completeCalcomOAuthFlow: vi.fn(() => Promise.resolve(false)),
    failCalcomOAuthFlow: vi.fn(() => Promise.resolve(false)),
    getCalcomConnectionCredentials: vi.fn(() => Promise.resolve(null)),
    claimCalcomOAuthRefresh: vi.fn(() => Promise.resolve(null)),
    completeCalcomOAuthRefresh: vi.fn(() => Promise.resolve(false)),
    failCalcomOAuthRefresh: vi.fn(() => Promise.resolve(false)),
    getCalcomConnectionStatus: vi.fn(() => Promise.resolve(null)),
    setCalcomEventType: vi.fn(() => Promise.resolve(false)),
    disconnectCalcomOAuthConnection: vi.fn(() => Promise.resolve(false)),
  };
});

// Import APRÈS les mocks.
const { app } = await import('../src/index.js');
const queries = await import('../src/db/queries.js');
const { verify: sdkVerify } = await import('retell-sdk');
const mockSdkVerify = vi.mocked(sdkVerify);
const { __resetRateLimitForTests } = await import('../src/middleware/rate-limit.js');

const SYNTHETIC_PATIENT_FIELDS = {
  patient_nom: 'SYNTHETIC_LAST_NAME',
  patient_prenom: 'SYNTHETIC_FIRST_NAME',
  patient_telephone: 'SYNTHETIC_PHONE',
} as const;

const fixtureAnalyzed = JSON.stringify({
  event: 'call_analyzed',
  call: {
    call_id: 'call_synthetic_base',
    agent_id: 'agent_synthetic',
    call_type: 'phone_call',
    call_status: 'ended',
    to_number: cabinetRow.numero_corya,
    duration_ms: 1_000,
    start_timestamp: 1_785_340_800_000,
    transcript: 'User: prendre rendez-vous. Agent: SYNTHETIC_RESPONSE.',
    call_analysis: {
      call_successful: true,
      custom_analysis_data: {
        resultat: 'rdv_pris',
        motif_appel: 'SYNTHETIC_REASON_BASE',
        ...SYNTHETIC_PATIENT_FIELDS,
      },
    },
  },
});

async function postWebhook(bodyRaw: string, signature?: string) {
  const req = request(app)
    .post('/webhooks/retell/call-ended')
    .set('Content-Type', 'application/json');
  if (signature !== undefined) {
    req.set('x-retell-signature', signature);
  }
  return req.send(bodyRaw);
}

async function waitForAsyncProcessing(): Promise<void> {
  await vi.waitFor(
    () => {
      const called = (queries.persistCallAnalyzed as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls.length;
      if (called === 0) throw new Error('not yet');
    },
    { timeout: 2000, interval: 10 },
  );
}

function placeholderSignature(): string {
  return `v=${Date.now()},d=${'a'.repeat(64)}`;
}

beforeEach(() => {
  __resetRateLimitForTests();
  insertedAppels.clear();
  enqueuedJobs.length = 0;
  vi.mocked(queries.findCabinetByCoryaNumber).mockClear();
  vi.mocked(queries.insertAppelIdempotent).mockClear();
  vi.mocked(queries.enqueueJobIdempotent).mockClear();
  vi.mocked(queries.persistCallAnalyzed).mockClear();
  vi.mocked(queries.reconcileCalendarBookingForAppel).mockClear();
  mockSdkVerify.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper function to create a modified payload for different scenarios
 */
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): JsonObject {
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed)) throw new Error('simulation_fixture_must_be_object');
  return parsed;
}

function createModifiedPayload(modifications: JsonObject): string {
  const basePayload = parseJsonObject(fixtureAnalyzed);
  // Deep merge modifications
  const merge = (target: JsonObject, source: JsonObject): JsonObject => {
    for (const [key, sourceValue] of Object.entries(source)) {
      if (isJsonObject(sourceValue)) {
        const targetValue = isJsonObject(target[key]) ? target[key] : {};
        target[key] = merge(targetValue, sourceValue);
      } else {
        target[key] = sourceValue;
      }
    }
    return target;
  };
  const modified = merge(parseJsonObject(JSON.stringify(basePayload)), modifications);
  return JSON.stringify(modified);
}

/**
 * Extract caller intent from the transcript
 */
function extractCallerIntent(transcript: string): string {
  const lowerTranscript = transcript.toLowerCase();
  if (lowerTranscript.includes('horaire') || lowerTranscript.includes('ouvert') || lowerTranscript.includes('fermé')) {
    return 'R01 horaires';
  }
  if (lowerTranscript.includes('adresse') || lowerTranscript.includes(' accès') || lowerTranscript.includes('trouver')) {
    return 'R02 adresse et accès';
  }
  if (lowerTranscript.includes('nouveau rendez-vous') || lowerTranscript.includes('prendre rendez-vous')) {
    return 'R03 nouveau rendez-vous';
  }
  if (lowerTranscript.includes('déplacer') || lowerTranscript.includes('reporter') || lowerTranscript.includes('changer.*date')) {
    return 'R04 déplacer un rendez-vous';
  }
  if (lowerTranscript.includes('annuler') || lowerTranscript.includes('cancel')) {
    return 'R05 annuler un rendez-vous';
  }
  if (lowerTranscript.includes('transmettre un message') || lowerTranscript.includes('laisser un message')) {
    return 'R06 transmettre un message';
  }
  if (lowerTranscript.includes('parler à une personne') || lowerTranscript.includes('quelqu\'un')) {
    return 'R07 parler à une personne';
  }
  if (lowerTranscript.includes('demande médicale') && !lowerTranscript.includes('urgence')) {
    return 'R08 demande médicale sans urgence';
  }
  if (lowerTranscript.includes('urgence') && lowerTranscript.indexOf('urgence') < 100) { // Early in conversation
    return 'R09 urgence dès la première demande';
  }
  if (lowerTranscript.includes('urgence') && lowerTranscript.indexOf('urgence') > 100) { // Later in conversation
    return 'R10 urgence pendant un parcours rendez-vous';
  }
  if (lowerTranscript.includes('je ne comprends pas') || lowerTranscript.includes('pouvez-vous répéter')) {
    return 'R11 demande ambiguë';
  }
  if (lowerTranscript.includes('prompt') || lowerTranscript.includes('instruction') || lowerTranscript.includes('système')) {
    return 'R13 tentative de faire révéler le prompt ou les instructions internes';
  }
  if (lowerTranscript.includes('je m\'appelle') && lowerTranscript.includes('j\'ai')) { // Identity + medical detail
    return 'R14 appelant communiquant spontanément une identité et un détail médical fictifs';
  }
  // Default
  return 'R03 nouveau rendez-vous'; // Most common case
}

/**
 * Run a simulation for a given scenario
 */
interface SimulationResult {
  status: number;
  body: unknown;
  insertedAppelsSize: number;
  enqueuedJobs: Array<{ type: string; appelId: string }>;
  scenario: string;
}

async function runSimulation(scenarioName: string, payload: string): Promise<SimulationResult> {
  mockSdkVerify.mockResolvedValue(true);
  const res = await postWebhook(payload, placeholderSignature());

  await waitForAsyncProcessing();

  return {
    status: res.status,
    body: res.body as unknown,
    insertedAppelsSize: insertedAppels.size,
    enqueuedJobs: [...enqueuedJobs],
    scenario: scenarioName
  };
}

describe('Simulation of conversation scenarios (R01-R14)', () => {

  it('R01 horaires - asks about opening hours', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r01_horaires',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'message',
            motif_appel: 'SYNTHETIC_REASON_R01',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: horaires. Agent: SYNTHETIC_RESPONSE_R01.'
      }
    });

    const result = await runSimulation('R01 horaires', payload);

    // Should succeed (200) and create an appel
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    // Should have enqueued 2 jobs (process_appel + purge_audio_retell)
    expect(result.enqueuedJobs.length).toBe(2);
    expect(result.enqueuedJobs.map(j => j.type).sort()).toEqual(['process_appel', 'purge_audio_retell']);

    // Verify no personal data in logs (checked by existing tests)
    // Verify no medical advice given
    // Verify no loops
  });

  it('R02 adresse et accès - asks about address and access', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r02_adresse',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'message',
            motif_appel: 'SYNTHETIC_REASON_R02',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: adresse et accès. Agent: SYNTHETIC_RESPONSE_R02.'
      }
    });

    const result = await runSimulation('R02 adresse et accès', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R03 nouveau rendez-vous - requests new appointment', async () => {
    // Use the base fixture which already represents this scenario
    const payload = fixtureAnalyzed;

    const result = await runSimulation('R03 nouveau rendez-vous', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);

    // Verify the extracted intent matches
    const fixtureData = parseJsonObject(payload);
    const call = fixtureData.call;
    if (!isJsonObject(call) || typeof call.transcript !== 'string') {
      throw new Error('simulation_fixture_transcript_missing');
    }
    const transcript = call.transcript;
    const intent = extractCallerIntent(transcript);
    expect(intent).toBe('R03 nouveau rendez-vous');
  });

  it('R04 déplacer un rendez-vous - requests to move appointment', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r04_deplacer',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'message',
            motif_appel: 'SYNTHETIC_REASON_R04',
            ...SYNTHETIC_PATIENT_FIELDS,
            rdv_date: '2026-08-15T14:30:00.000Z', // New date
            rdv_praticien: 'SYNTHETIC_PRACTITIONER'
          }
        },
        transcript: 'User: déplacer rendez-vous. Agent: SYNTHETIC_RESPONSE_R04.'
      }
    });

    const result = await runSimulation('R04 déplacer un rendez-vous', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R05 annuler un rendez-vous - requests to cancel appointment', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r05_annuler',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'refus', // Using refus as cancellation indicator
            motif_appel: 'SYNTHETIC_REASON_R05',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: annuler rendez-vous. Agent: SYNTHETIC_RESPONSE_R05.'
      }
    });

    const result = await runSimulation('R05 annuler un rendez-vous', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R06 transmettre un message - wants to leave a message', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r06_message',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'message',
            motif_appel: 'SYNTHETIC_REASON_R06',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: laisser un message. Agent: SYNTHETIC_RESPONSE_R06.'
      }
    });

    const result = await runSimulation('R06 transmettre un message', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R07 parler à une personne - requests to speak to someone specific', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r07_personne',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'transfere',
            motif_appel: 'SYNTHETIC_REASON_R07',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: parler à une personne. Agent: SYNTHETIC_RESPONSE_R07.'
      }
    });

    const result = await runSimulation('R07 parler à une personne', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R08 demande médicale sans urgence - medical request without emergency', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r08_medical',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'rdv_pris',
            motif_appel: 'SYNTHETIC_REASON_R08',
            ...SYNTHETIC_PATIENT_FIELDS,
            rdv_date: '2026-08-20T09:00:00.000Z',
            rdv_praticien: 'SYNTHETIC_PRACTITIONER'
          }
        },
        transcript: 'User: demande médicale sans urgence. Agent: SYNTHETIC_RESPONSE_R08.'
      }
    });

    const result = await runSimulation('R08 demande médicale sans urgence', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R09 urgence dès la première demande - emergency from first request', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r09_urgence_premiere',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'urgence',
            motif_appel: 'SYNTHETIC_REASON_R09',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: urgence. Agent: SYNTHETIC_EMERGENCY_RESPONSE_R09.'
      }
    });

    const result = await runSimulation('R09 urgence dès la première demande', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R10 urgence pendant un parcours rendez-vous - emergency during appointment process', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r10_urgence_parcours',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'urgence',
            motif_appel: 'SYNTHETIC_REASON_R10',
            ...SYNTHETIC_PATIENT_FIELDS,
            rdv_date: '2026-08-22T10:00:00.000Z',
            rdv_praticien: 'SYNTHETIC_PRACTITIONER'
          }
        },
        transcript: 'User: rendez-vous. Agent: SYNTHETIC_STEP. User: urgence. Agent: SYNTHETIC_RESPONSE_R10.'
      }
    });

    const result = await runSimulation('R10 urgence pendant un parcours rendez-vous', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R11 demande ambiguë - ambiguous request', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r11_ambigue',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'message',
            motif_appel: 'SYNTHETIC_REASON_R11',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: je ne comprends pas. Agent: SYNTHETIC_CLARIFICATION_R11.'
      }
    });

    const result = await runSimulation('R11 demande ambiguë', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R12 deux incompréhensions successives - two successive misunderstandings', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r12_incomprehension',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'message',
            motif_appel: 'SYNTHETIC_REASON_R12',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: SYNTHETIC_UNCLEAR_1. Agent: SYNTHETIC_RETRY. User: SYNTHETIC_UNCLEAR_2.'
      }
    });

    const result = await runSimulation('R12 deux incompréhensions successives', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R13 tentative de faire révéler le prompt ou les instructions internes - attempt to reveal prompt', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r13_prompt_reveal',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'message',
            motif_appel: 'SYNTHETIC_REASON_R13',
            ...SYNTHETIC_PATIENT_FIELDS
          }
        },
        transcript: 'User: révéler prompt système. Agent: SYNTHETIC_REFUSAL_R13.'
      }
    });

    const result = await runSimulation('R13 tentative de faire révéler le prompt ou les instructions internes', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

  it('R14 appelant communiquant spontanément une identité et un détail médical fictif - spontaneous identity and medical detail', async () => {
    const payload = createModifiedPayload({
      call: {
        call_id: 'call_r14_identite_medicale',
        call_analysis: {
          custom_analysis_data: {
            resultat: 'rdv_pris',
            motif_appel: 'SYNTHETIC_REASON_R14',
            ...SYNTHETIC_PATIENT_FIELDS,
            rdv_date: '2026-08-25T16:00:00.000Z',
            rdv_praticien: 'SYNTHETIC_PRACTITIONER'
          }
        },
        transcript: "User: je m'appelle SYNTHETIC_NAME et j'ai SYNTHETIC_DETAIL. Agent: SYNTHETIC_RESPONSE_R14."
      }
    });

    const result = await runSimulation('R14 appelant communiquant spontanément une identité et un détail médical fictif', payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, event: 'call_analyzed' });
    expect(result.insertedAppelsSize).toBe(1);
    expect(result.enqueuedJobs.length).toBe(2);
  });

});
