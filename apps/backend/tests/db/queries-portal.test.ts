import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const builder: Record<string, unknown> = {};
  const methods = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    gte: vi.fn(),
    not: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    range: vi.fn(),
    update: vi.fn(),
    abortSignal: vi.fn(),
    maybeSingle: vi.fn(),
    getUser: vi.fn(),
    then: vi.fn(),
    rpc: vi.fn(),
  };
  return { builder, methods };
});

Object.assign(mocks.builder, {
  select: mocks.methods.select,
  eq: mocks.methods.eq,
  order: mocks.methods.order,
  limit: mocks.methods.limit,
  gte: mocks.methods.gte,
  not: mocks.methods.not,
  or: mocks.methods.or,
  ilike: mocks.methods.ilike,
  range: mocks.methods.range,
  update: mocks.methods.update,
  abortSignal: mocks.methods.abortSignal,
  maybeSingle: mocks.methods.maybeSingle,
  then: mocks.methods.then,
});

vi.mock('../../src/config/supabase.js', () => ({
  getAuthClient: () => ({ auth: { getUser: mocks.methods.getUser } }),
  getServiceClient: () => ({
    from: mocks.methods.from,
    rpc: mocks.methods.rpc,
  }),
}));

const {
  authenticatePortalAccessToken,
  getPortalCall,
  getPortalDashboardSnapshot,
  listPortalCalls,
  listPortalPractices,
  applyPortalCabinetPatchWithAudit,
  resolvePortalMembership,
} = await import('../../src/db/queries.js');

const CABINET_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CALL_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  for (const mock of Object.values(mocks.methods)) mock.mockReset();
  mocks.methods.from.mockReturnValue(mocks.builder);
  mocks.methods.rpc.mockReturnValue(mocks.builder);
  mocks.methods.select.mockReturnValue(mocks.builder);
  mocks.methods.eq.mockReturnValue(mocks.builder);
  mocks.methods.order.mockReturnValue(mocks.builder);
  mocks.methods.limit.mockReturnValue(mocks.builder);
  mocks.methods.gte.mockReturnValue(mocks.builder);
  mocks.methods.not.mockReturnValue(mocks.builder);
  mocks.methods.or.mockReturnValue(mocks.builder);
  mocks.methods.ilike.mockReturnValue(mocks.builder);
  mocks.methods.range.mockReturnValue(mocks.builder);
  mocks.methods.update.mockReturnValue(mocks.builder);
  mocks.methods.abortSignal.mockReturnValue(mocks.builder);
  mocks.methods.maybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.methods.then.mockImplementation((resolve: (value: unknown) => unknown) =>
    Promise.resolve(resolve({ data: [], error: null, count: 0 })));
});

describe('portal Auth and tenant query wrappers', () => {
  it('uses the official getUser(token) primitive and projects only safe identity fields', async () => {
    mocks.methods.getUser.mockResolvedValue({
      data: {
        user: {
          id: USER_ID,
          email: 'member@example.test',
          user_metadata: { full_name: 'Membre test', ignored: 'not-returned' },
        },
      },
      error: null,
    });

    await expect(authenticatePortalAccessToken('test.portal.token.value')).resolves.toEqual({
      id: USER_ID,
      email: 'member@example.test',
      displayName: 'Membre test',
    });
    expect(mocks.methods.getUser).toHaveBeenCalledWith('test.portal.token.value');
  });

  it('returns null for an invalid token without any service-role query', async () => {
    mocks.methods.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 401 },
    });

    await expect(authenticatePortalAccessToken('test.portal.token.value')).resolves.toBeNull();
    expect(mocks.methods.from).not.toHaveBeenCalled();
  });

  it('re-reads active memberships and orders deterministic selection by cabinet id', async () => {
    mocks.methods.maybeSingle.mockResolvedValue({
      data: { cabinet_id: CABINET_ID, role: 'viewer' },
      error: null,
    });

    await expect(resolvePortalMembership(USER_ID)).resolves.toEqual({
      cabinetId: CABINET_ID,
      role: 'viewer',
    });
    expect(mocks.methods.from).toHaveBeenCalledWith('cabinet_memberships');
    expect(mocks.methods.select).toHaveBeenCalledWith('cabinet_id, role');
    expect(mocks.methods.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(mocks.methods.eq).toHaveBeenCalledWith('actif', true);
    expect(mocks.methods.order).toHaveBeenCalledWith('cabinet_id', { ascending: true });
    expect(mocks.methods.limit).toHaveBeenCalledWith(1);
  });

  it('constrains a requested cabinet only after user and active filters', async () => {
    await resolvePortalMembership(USER_ID, CABINET_ID);

    expect(mocks.methods.eq.mock.calls).toEqual([
      ['user_id', USER_ID],
      ['actif', true],
      ['cabinet_id', CABINET_ID],
    ]);
  });

  it('selects an explicit call allowlist and always scopes detail by cabinet plus id', async () => {
    await getPortalCall(CABINET_ID, CALL_ID);

    const selected = String(mocks.methods.select.mock.calls[0]?.[0]);
    expect(selected).not.toContain('*');
    for (const forbidden of [
      'patient_nom', 'patient_prenom', 'patient_telephone',
    'numero_appelant_hash', 'transcript_anonymise', 'audio_url', 'retell_call_id',
      'numero_appelant_masque',
    ]) {
      expect(selected).not.toContain(forbidden);
    }
    expect(mocks.methods.eq).toHaveBeenCalledWith('cabinet_id', CABINET_ID);
    expect(mocks.methods.eq).toHaveBeenCalledWith('id', CALL_ID);
  });

  it('bounds the database range from validated page and page size', async () => {
    await listPortalCalls(CABINET_ID, {
      period: '30d',
      sort: 'date_desc',
      page: 3,
      pageSize: 25,
    });

    expect(mocks.methods.range).toHaveBeenCalledWith(50, 74);
    expect(mocks.methods.order).toHaveBeenCalledWith('date_appel', {
      ascending: false,
      nullsFirst: false,
    });
    expect(mocks.methods.order).toHaveBeenCalledWith('id', { ascending: false });
  });

  it('keeps pending disjoint from failed summary filters', async () => {
    await listPortalCalls(CABINET_ID, {
      period: '30d',
      summaryStatus: 'pending',
      sort: 'date_desc',
      page: 1,
      pageSize: 10,
    });

    expect(mocks.methods.eq).toHaveBeenCalledWith('email_status', 'pending');
    expect(mocks.methods.or).not.toHaveBeenCalledWith('pdf_url.is.null,email_status.eq.pending');
  });

  it('reads dashboard metrics and recent calls from one exact snapshot RPC', async () => {
    mocks.methods.then.mockImplementationOnce((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({
        data: [{
          period_start: '2026-07-07T12:00:00.000Z',
          total_calls: '1500',
          total_duration_seconds: 63000,
          appointments: 400,
          volume_by_date: [{ date: '2026-08-06', calls: 12 }],
          outcomes: [{ resultat: 'rdv_pris', count: 400 }],
          recent_calls: [],
        }],
        error: null,
      })));

    await expect(getPortalDashboardSnapshot(CABINET_ID, '30d')).resolves.toMatchObject({
      totalCalls: 1_500,
      totalDurationSeconds: 63_000,
      appointments: 400,
    });
    expect(mocks.methods.rpc).toHaveBeenCalledOnce();
    expect(mocks.methods.rpc).toHaveBeenCalledWith('get_portal_dashboard_snapshot', {
      p_cabinet_id: CABINET_ID,
      p_period: '30d',
    });
    expect(mocks.methods.from).not.toHaveBeenCalled();
  });

  it('maps a cabinet deleted concurrently with its dashboard snapshot', async () => {
    mocks.methods.then.mockImplementationOnce((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({ data: null, error: { code: 'P0002' } })));

    await expect(getPortalDashboardSnapshot(CABINET_ID, '30d'))
      .rejects.toThrow('portal_cabinet_not_found');
  });

  it('lists only parseable active practices for the authenticated actor', async () => {
    mocks.methods.then.mockImplementationOnce((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({
        data: [
          { cabinet_id: CABINET_ID, role: 'admin', cabinets: { id: CABINET_ID, nom: 'SYNTHETIC_PRACTICE_A' } },
          { cabinet_id: 'ignored', role: 'invalid', cabinets: { id: 'ignored', nom: 'SYNTHETIC_INVALID' } },
        ],
        error: null,
      })));

    await expect(listPortalPractices(USER_ID)).resolves.toEqual([
      { id: CABINET_ID, name: 'SYNTHETIC_PRACTICE_A', role: 'admin' },
    ]);
    expect(mocks.methods.select).toHaveBeenCalledWith('cabinet_id, role, cabinets!inner(id, nom)');
    expect(mocks.methods.eq.mock.calls).toEqual([
      ['user_id', USER_ID],
      ['actif', true],
    ]);
  });

  it('computes a stable period lower bound from the request clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T12:00:00.000Z'));
    try {
      await listPortalCalls(CABINET_ID, {
        period: '7d',
        sort: 'date_desc',
        page: 1,
        pageSize: 10,
      });
      expect(mocks.methods.gte).toHaveBeenCalledWith('date_appel', '2026-07-30T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a serialization conflict with the freshly re-read version', async () => {
    const base = {
      id: CABINET_ID,
      nom: 'Cabinet test',
      type_cabinet: 'generaliste',
      adresse: null,
      npa: null,
      ville: null,
      email_notification: 'cabinet@example.test',
      email_notification_cc: null,
      statut: 'actif',
    } as const;
    const fresh = {
      ...base,
      config_agent: { portal: { settings: { notifyOnFailure: false } } },
      updated_at: 'v2',
    };
    const updatedRow = {
      ...fresh,
      config_agent: { portal: { settings: { notifyOnFailure: false, weeklyDigest: true } } },
      updated_at: 'v3',
    };
    mocks.methods.then
      .mockImplementationOnce((resolve: (value: unknown) => unknown) =>
        Promise.resolve(resolve({ data: null, error: { code: '40001', message: 'portal_cabinet_concurrent_update' } })))
      .mockImplementationOnce((resolve: (value: unknown) => unknown) =>
        Promise.resolve(resolve({ data: [updatedRow], error: null })));
    mocks.methods.maybeSingle.mockResolvedValueOnce({ data: fresh, error: null });

    const updated = await applyPortalCabinetPatchWithAudit(
      CABINET_ID,
      USER_ID,
      'settings_updated',
      { portalSettings: { weeklyDigest: true } },
      ['weeklyDigest'],
      'v1',
    );

    expect(updated.updated_at).toBe('v3');
    expect(mocks.methods.rpc).toHaveBeenNthCalledWith(1, 'apply_portal_cabinet_patch_with_audit', {
      p_cabinet_id: CABINET_ID,
      p_actor_user_id: USER_ID,
      p_action: 'settings_updated',
      p_expected_updated_at: 'v1',
      p_patch: { portalSettings: { weeklyDigest: true } },
      p_changed_fields: ['weeklyDigest'],
    });
    expect(mocks.methods.rpc).toHaveBeenNthCalledWith(2, 'apply_portal_cabinet_patch_with_audit', {
      p_cabinet_id: CABINET_ID,
      p_actor_user_id: USER_ID,
      p_action: 'settings_updated',
      p_expected_updated_at: 'v2',
      p_patch: { portalSettings: { weeklyDigest: true } },
      p_changed_fields: ['weeklyDigest'],
    });
  });

  it('uses one atomic RPC so cabinet mutation cannot occur without its audit', async () => {
    const updatedRow = {
      id: CABINET_ID,
      nom: 'Cabinet test',
      type_cabinet: 'generaliste',
      adresse: null,
      npa: null,
      ville: null,
      email_notification: 'cabinet@example.test',
      email_notification_cc: null,
      statut: 'actif',
      config_agent: { portal: { assistant: { publicName: 'Accueil' } } },
      updated_at: 'v2',
    };
    mocks.methods.then.mockImplementationOnce((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [updatedRow], error: null })));

    await applyPortalCabinetPatchWithAudit(
      CABINET_ID,
      USER_ID,
      'assistant_updated',
      { portalAssistant: { publicName: 'Accueil' } },
      ['publicName'],
      'v1',
    );

    expect(mocks.methods.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.methods.rpc).toHaveBeenCalledWith('apply_portal_cabinet_patch_with_audit', {
      p_cabinet_id: CABINET_ID,
      p_actor_user_id: USER_ID,
      p_action: 'assistant_updated',
      p_expected_updated_at: 'v1',
      p_patch: { portalAssistant: { publicName: 'Accueil' } },
      p_changed_fields: ['publicName'],
    });
    expect(mocks.methods.from).not.toHaveBeenCalled();
    expect(mocks.methods.update).not.toHaveBeenCalled();
  });

  it('returns conflict after three atomic serialization failures', async () => {
    mocks.methods.then.mockImplementation((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({ data: null, error: { code: '40001', message: 'portal_cabinet_concurrent_update' } })));
    mocks.methods.maybeSingle
      .mockResolvedValueOnce({ data: { updated_at: 'v2' }, error: null })
      .mockResolvedValueOnce({ data: { updated_at: 'v3' }, error: null });

    await expect(applyPortalCabinetPatchWithAudit(
      CABINET_ID,
      USER_ID,
      'settings_updated',
      { portalSettings: { weeklyDigest: true } },
      ['weeklyDigest'],
      'v1',
    )).rejects.toThrow('portal_cabinet_concurrent_update');
    expect(mocks.methods.rpc).toHaveBeenCalledTimes(3);
  });

  it('maps a missing cabinet without retrying or issuing a separate audit', async () => {
    mocks.methods.then.mockImplementationOnce((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({ data: null, error: { code: 'P0002', message: 'portal_cabinet_not_found' } })));

    await expect(applyPortalCabinetPatchWithAudit(
      CABINET_ID,
      USER_ID,
      'assistant_updated',
      { portalAssistant: { publicName: 'Accueil' } },
      ['publicName'],
      'v1',
    )).rejects.toThrow('portal_cabinet_not_found');
    expect(mocks.methods.rpc).toHaveBeenCalledTimes(1);
  });

  it('maps a concurrently revoked admin without retrying', async () => {
    mocks.methods.then.mockImplementationOnce((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({ data: null, error: { code: '42501', message: 'portal_admin_membership_required' } })));

    await expect(applyPortalCabinetPatchWithAudit(
      CABINET_ID,
      USER_ID,
      'settings_updated',
      { portalSettings: { weeklyDigest: true } },
      ['weeklyDigest'],
      'v1',
    )).rejects.toThrow('portal_admin_membership_required');
    expect(mocks.methods.rpc).toHaveBeenCalledTimes(1);
  });
});
