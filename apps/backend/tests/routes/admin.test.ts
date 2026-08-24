/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Supertest exposes response bodies as any and Vitest mocks are method-shaped; assertions below keep all boundary values explicit. */
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAdminRouter,
  type AdminRouterDependencies,
} from '../../src/routes/admin.js';
import { TimeoutError } from '../../src/utils/timeout.js';
import type {
  PortalCabinetRow,
  PortalCallRow,
  PortalDashboardSnapshot,
} from '../../src/admin/types.js';
import {
  ADMIN_AUTHENTICATED_MAX,
  ADMIN_PREAUTH_SOURCE_MAX,
  __resetRateLimitForTests,
} from '../../src/middleware/rate-limit.js';

const CABINET_A = '11111111-1111-4111-8111-111111111111';
const CABINET_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CALL_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'test.portal.token.value';

const cabinet: PortalCabinetRow = {
  id: CABINET_A,
  nom: 'Cabinet Démonstration',
  type_cabinet: 'generaliste',
  adresse: 'Adresse de test',
  npa: '1000',
  ville: 'Ville test',
  email_notification: 'cabinet@example.test',
  email_notification_cc: null,
  statut: 'actif',
  config_agent: {},
  updated_at: '2026-08-06T10:00:00.000Z',
};

const portalCall: PortalCallRow = {
  id: CALL_ID,
  cabinet_id: CABINET_A,
  date_appel: '2026-08-06T09:00:00.000Z',
  duree_secondes: 42,
  resultat: 'rdv_pris',
  motif_appel: 'demande de rendez-vous',
  rdv_date: '2026-08-07T09:00:00.000Z',
  rdv_praticien: 'praticien-1',
  pdf_url: `${CABINET_A}/2026-08/${CALL_ID}.pdf`,
  pdf_envoye_at: '2026-08-06T09:01:00.000Z',
  email_status: 'sent',
  created_at: '2026-08-06T09:00:00.000Z',
};

const dashboardSnapshot: PortalDashboardSnapshot = {
  periodStart: '2026-07-07T10:00:00.000Z',
  totalCalls: 1,
  totalDurationSeconds: 42,
  appointments: 1,
  volume: [{ date: '2026-08-06', calls: 1 }],
  outcomes: [
    { resultat: 'rdv_pris', count: 1 },
    { resultat: 'message', count: 0 },
    { resultat: 'transfere', count: 0 },
    { resultat: 'urgence', count: 0 },
    { resultat: 'refus', count: 0 },
    { resultat: 'echec', count: 0 },
  ],
  recentCalls: [{
    id: portalCall.id,
    date_appel: portalCall.date_appel,
    duree_secondes: portalCall.duree_secondes,
    resultat: portalCall.resultat,
    motif_appel: portalCall.motif_appel,
    has_pdf: true,
    email_status: portalCall.email_status,
    rdv_date: portalCall.rdv_date,
    rdv_praticien: portalCall.rdv_praticien,
  }],
};

function dependencies(): AdminRouterDependencies {
  return {
    authenticate: vi.fn(async () => ({
      id: USER_ID,
      email: 'member@example.test',
      displayName: 'Membre test',
    })),
    resolveMembership: vi.fn(async (_userId: string, requestedCabinetId?: string) =>
      requestedCabinetId === CABINET_B
        ? null
        : { cabinetId: requestedCabinetId ?? CABINET_A, role: 'admin' as const }),
    getCabinet: vi.fn(async (cabinetId) => cabinetId === CABINET_A ? cabinet : null),
    listCalls: vi.fn(async () => ({ rows: [portalCall], total: 1 })),
    dashboardSnapshot: vi.fn(async () => dashboardSnapshot),
    getCall: vi.fn(async (cabinetId, callId) =>
      cabinetId === CABINET_A && callId === CALL_ID ? portalCall : null),
    listTeam: vi.fn(async () => [{
      user_id: USER_ID,
      role: 'admin' as const,
      actif: true,
      created_at: '2026-08-01T00:00:00.000Z',
    }]),
    listPractices: vi.fn(async () => [{ id: CABINET_A, name: cabinet.nom, role: 'admin' as const }]),
    mutateCabinet: vi.fn(async (_cabinetId, _actorUserId, _action, patch) => ({
      ...cabinet,
      nom: patch.nom ?? cabinet.nom,
      config_agent: patch.portalAssistant
        ? { portal: { assistant: patch.portalAssistant } }
        : patch.portalSettings
          ? { portal: { settings: patch.portalSettings } }
          : cabinet.config_agent,
    })),
    signPdf: vi.fn(async () => 'https://storage.example.test/signed'),
    getCalcomStatus: vi.fn(async () => ({
      connectionId: null,
      status: null,
      eventTypeId: null,
      eventTypeTitle: null,
      eventTypeLengthMinutes: null,
      configuredScopes: null,
      grantedScopes: null,
      accessTokenExpiresAt: null,
      connectedAt: null,
      lastRefreshedAt: null,
      errorCode: null,
      demonstrationMode: false,
      runtimeReady: false,
    })),
    connectCalcom: vi.fn(async () => ({
      authorizationUrl: 'https://app.cal.com/auth/oauth2/authorize?state=synthetic',
    })),
    disconnectCalcom: vi.fn(async () => undefined),
    listCalcomEventTypes: vi.fn(async () => [{
      id: '6723841',
      title: 'Consultation test',
      slug: 'consultation-test',
      lengthMinutes: 30,
    }]),
    selectCalcomEventType: vi.fn(async (_cabinetId, _actorUserId, eventTypeId) => ({
      connectionId: '77777777-7777-4777-8777-777777777777',
      status: 'connected' as const,
      eventTypeId,
      eventTypeTitle: 'Consultation test',
      eventTypeLengthMinutes: 30,
      configuredScopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      grantedScopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      accessTokenExpiresAt: '2026-09-01T12:30:00.000Z',
      connectedAt: '2026-09-01T12:00:00.000Z',
      lastRefreshedAt: null,
      errorCode: null,
      demonstrationMode: false,
      runtimeReady: true,
    })),
  };
}

function appFor(deps: AdminRouterDependencies): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/admin', buildAdminRouter(deps));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal_server_error' });
  });
  return app;
}

function bearer(value = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${value}` };
}

beforeEach(() => {
  __resetRateLimitForTests();
});

describe('portal admin authentication and tenant isolation', () => {
  let deps: AdminRouterDependencies;

  beforeEach(() => {
    deps = dependencies();
  });

  it('rejects absent and malformed bearer tokens without privileged DB access', async () => {
    const app = appFor(deps);
    const absent = await request(app).get('/admin/me');
    const malformed = await request(app).get('/admin/me').set('Authorization', `Basic ${TOKEN}`);

    expect(absent.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(deps.authenticate).not.toHaveBeenCalled();
    expect(deps.resolveMembership).not.toHaveBeenCalled();
    expect(deps.getCabinet).not.toHaveBeenCalled();
  });

  it('maps an invalid or expired token to a generic 401 before membership lookup', async () => {
    vi.mocked(deps.authenticate).mockResolvedValue(null);
    const response = await request(appFor(deps)).get('/admin/me').set(bearer());

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(deps.resolveMembership).not.toHaveBeenCalled();
  });

  it('maps auth timeout to a generic 503 without privileged DB access', async () => {
    vi.mocked(deps.authenticate).mockRejectedValue(new TimeoutError('auth:getUser', 3000));
    const response = await request(appFor(deps)).get('/admin/me').set(bearer());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'authentication_unavailable' });
    expect(deps.resolveMembership).not.toHaveBeenCalled();
    expect(deps.getCabinet).not.toHaveBeenCalled();
  });

  it('keeps existing services bootable while unconfigured portal auth returns 503', async () => {
    vi.mocked(deps.authenticate).mockRejectedValue(new Error('portal_auth_not_configured'));
    const response = await request(appFor(deps)).get('/admin/me').set(bearer());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'authentication_unavailable' });
    expect(deps.resolveMembership).not.toHaveBeenCalled();
  });

  it('rejects absent or inactive membership and does not read cabinet data', async () => {
    vi.mocked(deps.resolveMembership).mockResolvedValue(null);
    const response = await request(appFor(deps)).get('/admin/me').set(bearer());

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
    expect(deps.getCabinet).not.toHaveBeenCalled();
  });

  it('authorizes cabinet A and returns a generic refusal for cabinet B', async () => {
    const app = appFor(deps);
    const allowed = await request(app).get('/admin/me').set(bearer()).set('X-Corya-Cabinet-Id', CABINET_A);
    const denied = await request(app).get('/admin/me').set(bearer()).set('X-Corya-Cabinet-Id', CABINET_B);

    expect(allowed.status).toBe(200);
    expect(allowed.body.practiceId).toBe(CABINET_A);
    expect(denied.status).toBe(403);
    expect(deps.getCabinet).toHaveBeenCalledTimes(1);
  });

  it('delegates deterministic multi-cabinet selection when the header is absent', async () => {
    const response = await request(appFor(deps)).get('/admin/me').set(bearer());

    expect(response.status).toBe(200);
    expect(deps.resolveMembership).toHaveBeenCalledWith(USER_ID, undefined);
  });

  it('returns the active multi-cabinet allowlist without unrelated memberships', async () => {
    vi.mocked(deps.listPractices).mockResolvedValue([
      { id: CABINET_A, name: 'Synthetic practice A', role: 'admin' },
      { id: CABINET_B, name: 'Synthetic practice B', role: 'viewer' },
    ]);
    const response = await request(appFor(deps)).get('/admin/me').set(bearer());

    expect(response.status).toBe(200);
    expect(response.body.practices).toEqual([
      { id: CABINET_A, name: 'Synthetic practice A', role: 'admin' },
      { id: CABINET_B, name: 'Synthetic practice B', role: 'viewer' },
    ]);
    expect(deps.listPractices).toHaveBeenCalledWith(USER_ID);
    expect(response.body.practices).toHaveLength(2);
  });

  it('rejects malformed cabinet selectors before membership or service data reads', async () => {
    const response = await request(appFor(deps))
      .get('/admin/me')
      .set(bearer())
      .set('X-Corya-Cabinet-Id', 'not-a-uuid');

    expect(response.status).toBe(400);
    expect(deps.resolveMembership).not.toHaveBeenCalled();
    expect(deps.getCabinet).not.toHaveBeenCalled();
  });

  it('isolates pre-auth source quotas so one attacker does not block another source', async () => {
    const deps = dependencies();
    vi.mocked(deps.authenticate).mockResolvedValue(null);
    const app = appFor(deps);
    for (let index = 0; index < ADMIN_PREAUTH_SOURCE_MAX; index += 1) {
      const accepted = await request(app)
        .get('/admin/me')
        .set(bearer())
        .set('X-Forwarded-For', '192.0.2.10');
      expect(accepted.status).toBe(401);
    }
    const limited = await request(app)
      .get('/admin/me')
      .set(bearer())
      .set('X-Forwarded-For', '192.0.2.10');
    const otherSource = await request(app)
      .get('/admin/me')
      .set(bearer())
      .set('X-Forwarded-For', '198.51.100.20');

    expect(limited.status).toBe(429);
    expect(otherSource.status).toBe(401);
    expect(deps.authenticate).toHaveBeenCalledTimes(ADMIN_PREAUTH_SOURCE_MAX + 1);
  });

  it('isolates post-auth quotas by verified actor and cabinet', async () => {
    const deps = dependencies();
    vi.mocked(deps.authenticate).mockImplementation(async (token) => ({
      id: token.includes('actor-b')
        ? '66666666-6666-4666-8666-666666666666'
        : USER_ID,
      email: '',
      displayName: 'Synthetic member',
    }));
    const app = appFor(deps);
    const actorA = bearer('test.portal.actor-a.token');
    const actorB = bearer('test.portal.actor-b.token');
    for (let index = 0; index < ADMIN_AUTHENTICATED_MAX; index += 1) {
      const accepted = await request(app)
        .get('/admin/me')
        .set(actorA)
        .set('X-Forwarded-For', '192.0.2.30');
      expect(accepted.status).toBe(200);
    }
    const actorALimited = await request(app)
      .get('/admin/me')
      .set(actorA)
      .set('X-Forwarded-For', '192.0.2.30');
    const actorBAllowed = await request(app)
      .get('/admin/me')
      .set(actorB)
      .set('X-Forwarded-For', '192.0.2.30');

    expect(actorALimited.status).toBe(429);
    expect(actorBAllowed.status).toBe(200);
  });
});

describe('portal admin call DTOs and pagination', () => {
  it('returns only the safe call projection and categorizes free-text reason', async () => {
    const deps = dependencies();
    const list = await request(appFor(deps)).get('/admin/calls').set(bearer());
    const detail = await request(appFor(deps)).get(`/admin/calls/${CALL_ID}`).set(bearer());
    const serialized = JSON.stringify({ list: list.body, detail: detail.body });

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(list.body.items[0].reason).toBe('Rendez-vous');
    expect(detail.body.transcript).toEqual([]);
    expect(detail.body.transcriptState).toBe('unavailable');
    expect(list.body.items[0].maskedNumber).toBe('Numéro non exposé');
    for (const forbidden of [
      'patient_nom', 'patient_prenom', 'patient_telephone',
      'numero_appelant_hash', 'transcript_anonymise', 'audio_url',
      'pdf_url', 'retell_call_id', 'motif_appel', 'numero_appelant_masque',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(list.headers['cache-control']).toBe('private, no-store');
  });

  it('forwards bounded pagination and filters', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps))
      .get('/admin/calls?page=2&pageSize=100&period=7d&outcome=appointment&summaryStatus=complete&sort=duration_asc&practitionerId=praticien-1')
      .set(bearer());

    expect(response.status).toBe(200);
    expect(deps.listCalls).toHaveBeenCalledWith(CABINET_A, {
      period: '7d',
      outcome: 'rdv_pris',
      practitionerId: 'praticien-1',
      summaryStatus: 'complete',
      sort: 'duration_asc',
      page: 2,
      pageSize: 100,
    });
  });

  it('rejects oversized pagination before the calls query', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps)).get('/admin/calls?pageSize=101').set(bearer());

    expect(response.status).toBe(400);
    expect(deps.listCalls).not.toHaveBeenCalled();
  });

  it('rejects non-empty search because masked caller data is not queried', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps)).get('/admin/calls?search=123').set(bearer());

    expect(response.status).toBe(400);
    expect(deps.listCalls).not.toHaveBeenCalled();
  });

  it('uses id plus authorized cabinet and returns generic 404 for IDOR', async () => {
    const deps = dependencies();
    vi.mocked(deps.getCall).mockResolvedValue(null);
    const response = await request(appFor(deps)).get(`/admin/calls/${CALL_ID}`).set(bearer());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
    expect(deps.getCall).toHaveBeenCalledWith(CABINET_A, CALL_ID);
  });

  it('maps a bounded portal DB failure without exposing its details', async () => {
    const deps = dependencies();
    vi.mocked(deps.listCalls).mockRejectedValue(new Error('portal_calls_list_failed'));
    const response = await request(appFor(deps)).get('/admin/calls').set(bearer());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
  });
});

describe('portal admin PDF signing', () => {
  it('signs only the expected cabinet path with a five-minute TTL and no-store', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps)).post(`/admin/calls/${CALL_ID}/pdf-url`).set(bearer());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: 'https://storage.example.test/signed', expiresIn: 300 });
    expect(deps.signPdf).toHaveBeenCalledWith(`${CABINET_A}/2026-08/${CALL_ID}.pdf`, 300);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('returns generic 404 and never signs an IDOR or unexpected path', async () => {
    const deps = dependencies();
    vi.mocked(deps.getCall)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...portalCall, pdf_url: `${CABINET_B}/2026-08/${CALL_ID}.pdf` });
    const app = appFor(deps);

    const idor = await request(app).post(`/admin/calls/${CALL_ID}/pdf-url`).set(bearer());
    const wrongPath = await request(app).post(`/admin/calls/${CALL_ID}/pdf-url`).set(bearer());

    expect(idor.status).toBe(404);
    expect(wrongPath.status).toBe(404);
    expect(deps.signPdf).not.toHaveBeenCalled();
  });
});

describe('portal admin read and mutation contracts', () => {
  it('starts Cal.com OAuth only for the authorized admin tenant', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps))
      .post('/admin/integrations/calcom/connect')
      .set(bearer());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authorizationUrl: 'https://app.cal.com/auth/oauth2/authorize?state=synthetic',
    });
    expect(deps.connectCalcom).toHaveBeenCalledWith(CABINET_A, USER_ID);
  });

  it.each([
    ['post', '/admin/integrations/calcom/connect'],
    ['post', '/admin/integrations/calcom/disconnect'],
    ['get', '/admin/integrations/calcom/event-types'],
    ['patch', '/admin/integrations/calcom/event-type'],
  ] as const)('keeps viewer Cal.com management read-only: %s %s', async (method, path) => {
    const deps = dependencies();
    vi.mocked(deps.resolveMembership).mockResolvedValue({ cabinetId: CABINET_A, role: 'viewer' });
    const call = request(appFor(deps))[method](path).set(bearer());
    const response = method === 'patch' ? await call.send({ eventTypeId: '6723841' }) : await call;

    expect(response.status).toBe(403);
    expect(deps.connectCalcom).not.toHaveBeenCalled();
    expect(deps.disconnectCalcom).not.toHaveBeenCalled();
    expect(deps.listCalcomEventTypes).not.toHaveBeenCalled();
    expect(deps.selectCalcomEventType).not.toHaveBeenCalled();
  });

  it('returns only allowlisted event type fields and verifies selection server-side', async () => {
    const deps = dependencies();
    const app = appFor(deps);
    const listed = await request(app)
      .get('/admin/integrations/calcom/event-types')
      .set(bearer());
    const selected = await request(app)
      .patch('/admin/integrations/calcom/event-type')
      .set(bearer())
      .send({ eventTypeId: '6723841' });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      items: [{ id: '6723841', title: 'Consultation test', lengthMinutes: 30 }],
    });
    expect(JSON.stringify(listed.body)).not.toContain('slug');
    expect(selected.status).toBe(200);
    expect(deps.listCalcomEventTypes).toHaveBeenCalledWith(CABINET_A);
    expect(deps.selectCalcomEventType).toHaveBeenCalledWith(
      CABINET_A,
      USER_ID,
      '6723841',
    );
    expect(selected.body).toEqual({
      status: 'connected',
      adminCanManage: true,
      connectedAt: '2026-09-01T12:00:00.000Z',
      scopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      eventType: {
        id: '6723841',
        title: 'Consultation test',
        lengthMinutes: 30,
      },
    });
  });

  it('rejects unsafe event type identifiers before provider or DB access', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps))
      .patch('/admin/integrations/calcom/event-type')
      .set(bearer())
      .send({ eventTypeId: '99999999999999999999' });

    expect(response.status).toBe(400);
    expect(deps.selectCalcomEventType).not.toHaveBeenCalled();
  });

  it('disconnects locally without claiming a provider-side revoke', async () => {
    const deps = dependencies();
    vi.mocked(deps.getCalcomStatus).mockResolvedValue({
      connectionId: '77777777-7777-4777-8777-777777777777',
      status: 'revoked',
      eventTypeId: null,
      eventTypeTitle: null,
      eventTypeLengthMinutes: null,
      configuredScopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      grantedScopes: null,
      accessTokenExpiresAt: null,
      connectedAt: '2026-09-01T12:00:00.000Z',
      lastRefreshedAt: null,
      errorCode: null,
      demonstrationMode: false,
      runtimeReady: false,
    });
    const response = await request(appFor(deps))
      .post('/admin/integrations/calcom/disconnect')
      .set(bearer());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'revoked',
      adminCanManage: true,
      connectedAt: '2026-09-01T12:00:00.000Z',
      scopes: [],
      eventType: null,
    });
    expect(deps.disconnectCalcom).toHaveBeenCalledWith(CABINET_A, USER_ID);
    expect(deps.getCalcomStatus).toHaveBeenCalledWith(CABINET_A);
  });

  it('maps the exact dashboard snapshot without exposing storage fields', async () => {
    const response = await request(appFor(dependencies()))
      .get('/admin/dashboard?period=30d')
      .set(bearer());

    expect(response.status).toBe(200);
    expect(response.body.metrics).toEqual([
      { key: 'calls', label: 'Appels', value: 1, unit: 'count', trendPct: null },
      { key: 'appointments', label: 'Rendez-vous', value: 1, unit: 'count', trendPct: null },
      { key: 'average_duration', label: 'Durée moyenne', value: 42, unit: 'seconds', trendPct: null },
    ]);
    expect(response.body.volume).toEqual([{ date: '2026-08-06', calls: 1 }]);
    expect(response.body.recentCalls[0]).not.toHaveProperty('pdf_url');
    expect(response.body.recentCalls[0]).not.toHaveProperty('has_pdf');
    expect(response.body.recentCalls[0].maskedNumber).toBe('Numéro non exposé');
  });

  it('exposes only an allowlisted Cal.com state when the cabinet config is valid', async () => {
    const deps = dependencies();
    vi.mocked(deps.getCalcomStatus).mockResolvedValue({
      connectionId: '77777777-7777-4777-8777-777777777777',
      status: 'connected',
      eventTypeId: '6723841',
      eventTypeTitle: 'Agenda de démonstration',
      eventTypeLengthMinutes: 30,
      configuredScopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      grantedScopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      accessTokenExpiresAt: '2026-09-01T12:30:00.000Z',
      connectedAt: '2026-09-01T12:00:00.000Z',
      lastRefreshedAt: null,
      errorCode: null,
      demonstrationMode: false,
      runtimeReady: true,
    });
    vi.mocked(deps.getCabinet).mockResolvedValue({
      ...cabinet,
      config_agent: {
        calendar: {
          provider: 'cal.com',
          eventTypeId: '6723841',
          calendarName: 'Agenda de démonstration',
          status: 'connected',
          slotDurationMin: 30,
          minimumNoticeHours: 24,
          allowBooking: true,
          allowReschedule: false,
          allowCancellation: false,
        },
      },
    });
    const app = appFor(deps);

    const integrations = await request(app).get('/admin/integrations').set(bearer());
    const dashboard = await request(app).get('/admin/dashboard?period=30d').set(bearer());

    expect(integrations.status).toBe(200);
    expect(integrations.body.integrations[0]).toMatchObject({
      id: 'calendar',
      status: 'connected',
      detail: 'Cal.com actif',
    });
    expect(integrations.body.calendar).toMatchObject({
      provider: 'cal.com',
      calendarName: 'Agenda de démonstration',
      slotDurationMin: 30,
      minimumNoticeHours: 24,
      allowBooking: true,
      allowReschedule: false,
      allowCancellation: false,
    });
    expect(integrations.body.calcom).toEqual({
      status: 'connected',
      adminCanManage: true,
      connectedAt: '2026-09-01T12:00:00.000Z',
      scopes: ['BOOKING_READ', 'BOOKING_WRITE', 'EVENT_TYPE_READ', 'PROFILE_READ'],
      eventType: { id: '6723841', title: 'Agenda de démonstration', lengthMinutes: 30 },
    });
    expect(JSON.stringify(integrations.body)).not.toContain('apiKey');
    expect(dashboard.body.calendarState).toBe('operational');
  });

  it('fails closed when the stored calendar integration is malformed', async () => {
    const deps = dependencies();
    vi.mocked(deps.getCabinet).mockResolvedValue({
      ...cabinet,
      config_agent: {
        calendar: {
          provider: 'cal.com',
          calendarName: 'Agenda invalide',
          status: 'connected',
          slotDurationMin: 30,
          minimumNoticeHours: 24,
          allowBooking: true,
          allowReschedule: false,
          allowCancellation: false,
          apiKey: 'synthetic-forbidden-value',
        },
      },
    });

    const response = await request(appFor(deps)).get('/admin/integrations').set(bearer());

    expect(response.status).toBe(200);
    expect(response.body.integrations[0].status).toBe('not_configured');
    expect(response.body.calendar.allowBooking).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-forbidden-value');
  });

  it.each([
    '/admin/dashboard?period=30d',
    '/admin/integrations',
    '/admin/settings',
    '/admin/team',
    '/admin/security/status',
    '/admin/assistant',
  ])('serves %s with private no-store', async (path) => {
    const response = await request(appFor(dependencies())).get(path).set(bearer());
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('allows admin allowlisted settings and assistant patches', async () => {
    const deps = dependencies();
    const app = appFor(deps);
    const settings = await request(app)
      .patch('/admin/settings')
      .set(bearer())
      .send({ practiceName: 'Cabinet Modifié', weeklyDigest: true });
    const assistant = await request(app)
      .patch('/admin/assistant')
      .set(bearer())
      .send({ publicName: 'Corya Accueil' });

    expect(settings.status).toBe(200);
    expect(assistant.status).toBe(200);
    expect(deps.mutateCabinet).toHaveBeenCalledTimes(2);
    expect(deps.mutateCabinet).toHaveBeenNthCalledWith(
      1,
      CABINET_A,
      USER_ID,
      'settings_updated',
      { nom: 'Cabinet Modifié', portalSettings: { weeklyDigest: true } },
      ['practiceName', 'weeklyDigest'],
      cabinet.updated_at,
    );
    expect(deps.mutateCabinet).toHaveBeenNthCalledWith(
      2,
      CABINET_A,
      USER_ID,
      'assistant_updated',
      { portalAssistant: { publicName: 'Corya Accueil' } },
      ['publicName'],
      cabinet.updated_at,
    );
  });

  it('keeps viewer mutations read-only', async () => {
    const deps = dependencies();
    vi.mocked(deps.resolveMembership).mockResolvedValue({ cabinetId: CABINET_A, role: 'viewer' });
    const app = appFor(deps);
    const settings = await request(app).patch('/admin/settings').set(bearer()).send({ weeklyDigest: true });
    const assistant = await request(app).patch('/admin/assistant').set(bearer()).send({ publicName: 'Nom test' });

    expect(settings.status).toBe(403);
    expect(assistant.status).toBe(403);
    expect(deps.mutateCabinet).not.toHaveBeenCalled();
  });

  it('rejects unknown or invalid mutation fields', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps))
      .patch('/admin/settings')
      .set(bearer())
      .send({ secret: 'not-accepted' });

    expect(response.status).toBe(400);
    expect(deps.mutateCabinet).not.toHaveBeenCalled();
  });

  it('returns explicit 409 after optimistic concurrency retries are exhausted', async () => {
    const deps = dependencies();
    vi.mocked(deps.mutateCabinet).mockRejectedValue(new Error('portal_cabinet_concurrent_update'));
    const response = await request(appFor(deps))
      .patch('/admin/settings')
      .set(bearer())
      .send({ weeklyDigest: true });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'conflict' });
    expect(deps.mutateCabinet).toHaveBeenCalledTimes(1);
  });

  it('maps a cabinet deleted before the atomic mutation to generic 404', async () => {
    const deps = dependencies();
    vi.mocked(deps.mutateCabinet).mockRejectedValue(new Error('portal_cabinet_not_found'));
    const response = await request(appFor(deps))
      .patch('/admin/assistant')
      .set(bearer())
      .send({ publicName: 'Accueil test' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
    expect(deps.mutateCabinet).toHaveBeenCalledTimes(1);
  });

  it('rejects an admin membership revoked before the atomic mutation', async () => {
    const deps = dependencies();
    vi.mocked(deps.mutateCabinet).mockRejectedValue(new Error('portal_admin_membership_required'));
    const response = await request(appFor(deps))
      .patch('/admin/settings')
      .set(bearer())
      .send({ weeklyDigest: true });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
  });

  it('does not write or audit an idempotent no-op patch', async () => {
    const deps = dependencies();
    const response = await request(appFor(deps))
      .patch('/admin/settings')
      .set(bearer())
      .send({ practiceName: cabinet.nom, weeklyDigest: false });

    expect(response.status).toBe(200);
    expect(deps.mutateCabinet).not.toHaveBeenCalled();
  });

  it('returns explicit dashboard unavailability instead of partial metrics', async () => {
    const deps = dependencies();
    vi.mocked(deps.dashboardSnapshot).mockRejectedValue(new Error('portal_dashboard_snapshot_failed'));
    const response = await request(appFor(deps)).get('/admin/dashboard?period=90d').set(bearer());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'dashboard_unavailable' });
  });

  it('returns 404 when the cabinet disappears before the dashboard snapshot', async () => {
    const deps = dependencies();
    vi.mocked(deps.dashboardSnapshot).mockRejectedValue(new Error('portal_cabinet_not_found'));
    const response = await request(appFor(deps)).get('/admin/dashboard?period=90d').set(bearer());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
  });

  it('maps an atomic mutation-and-audit outage generically', async () => {
    const deps = dependencies();
    vi.mocked(deps.mutateCabinet).mockRejectedValue(new Error('portal_cabinet_atomic_update_failed'));
    const response = await request(appFor(deps))
      .patch('/admin/settings')
      .set(bearer())
      .send({ weeklyDigest: true });

    expect(response.status).toBe(503);
    expect(deps.mutateCabinet).toHaveBeenCalledWith(
      CABINET_A,
      USER_ID,
      'settings_updated',
      { portalSettings: { weeklyDigest: true } },
      ['weeklyDigest'],
      cabinet.updated_at,
    );
  });

  it('does not expose other team member email addresses', async () => {
    const deps = dependencies();
    vi.mocked(deps.listTeam).mockResolvedValue([
      { user_id: USER_ID, role: 'admin', actif: true, created_at: '2026-08-01T00:00:00.000Z' },
      { user_id: '55555555-5555-4555-8555-555555555555', role: 'viewer', actif: true, created_at: '2026-08-02T00:00:00.000Z' },
    ]);
    const response = await request(appFor(deps)).get('/admin/team').set(bearer());

    expect(response.status).toBe(200);
    expect(response.body[0].email).toBe('member@example.test');
    expect(response.body[1].email).toBe('');
  });
});
