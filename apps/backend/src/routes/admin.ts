import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import * as portalQueries from '../db/queries.js';
import { buildPdfObjectPath, createSignedPdfUrl } from '../services/storage.js';
import { TimeoutError } from '../utils/timeout.js';
import {
  buildAdminPreAuthRateLimiter,
  consumeAuthenticatedAdminRateLimit,
} from '../middleware/rate-limit.js';
import type {
  PortalAuthUser,
  PortalCabinetPatch,
  PortalCabinetRow,
  PortalCallResult,
  PortalCallRow,
  PortalCallsQuery,
  PortalDashboardRecentCall,
  PortalDashboardSnapshot,
  PortalMembership,
  PortalPractice,
  PortalTeamRow,
} from '../admin/types.js';

const UUID = z.string().uuid();
const periodSchema = z.enum(['7d', '30d', '90d']);
const outcomeInputSchema = z.enum([
  'appointment',
  'message',
  'transferred',
  'emergency_redirected',
  'refused',
  'failed',
]);
const openingHoursSchema = z.array(
  z.object({ day: z.string().trim().min(1).max(32), hours: z.string().trim().min(1).max(64) }).strict(),
).max(14);
const practitionerSchema = z.object({
  id: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(120),
  specialty: z.string().trim().min(1).max(120),
  defaultDurationMin: z.number().int().min(5).max(240),
  active: z.boolean(),
}).strict();
const calendarIntegrationSchema = z.object({
  provider: z.literal('cal.com'),
  eventTypeId: z.coerce.string().regex(/^\d{1,20}$/u),
  calendarName: z.string().trim().min(1).max(120),
  status: z.literal('connected'),
  slotDurationMin: z.number().int().min(5).max(240),
  minimumNoticeHours: z.number().int().min(0).max(8_760),
  allowBooking: z.boolean(),
  allowReschedule: z.boolean(),
  allowCancellation: z.boolean(),
}).strict();
const settingsPatchSchema = z.object({
  practiceName: z.string().trim().min(2).max(160).optional(),
  specialty: z.enum([
    'physio', 'osteo', 'generaliste', 'cabinet_partage',
    'radiologie', 'clinique_privee', 'ems', 'autre',
  ]).optional(),
  addressLine: z.string().trim().min(2).max(240).optional(),
  postalCode: z.string().trim().min(4).max(12).optional(),
  city: z.string().trim().min(2).max(120).optional(),
  timezone: z.literal('Europe/Zurich').optional(),
  notificationEmail: z.string().email().max(254).optional(),
  ccEmail: z.union([z.string().email().max(254), z.literal('')]).optional(),
  openingHours: openingHoursSchema.optional(),
  practitioners: z.array(practitionerSchema).max(100).optional(),
  weeklyDigest: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
}).strict();

const assistantPatchSchema = z.object({
  publicName: z.string().trim().min(2).max(80).optional(),
  greeting: z.string().trim().min(10).max(500).optional(),
  language: z.enum(['fr-CH', 'de-CH', 'it-CH', 'en']).optional(),
  businessHours: openingHoursSchema.optional(),
  afterHoursBehaviour: z.enum(['message', 'transfer', 'voicemail']).optional(),
  allowedRequests: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  forbiddenRequests: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  transferRules: z.string().trim().max(500).optional(),
  maskedTransferNumber: z.string().trim().max(40).optional(),
  emergencyProtocol: z.string().trim().max(500).optional(),
  shareableInformation: z.string().trim().max(1000).optional(),
  minimalCollection: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  confirmAppointments: z.boolean().optional(),
}).strict();

const callsQuerySchema = z.object({
  search: z.literal('').default(''),
  outcome: z.union([outcomeInputSchema, z.literal('all')]).default('all'),
  practitionerId: z.string().trim().max(80).default('all'),
  summaryStatus: z.enum(['all', 'complete', 'pending', 'failed']).default('all'),
  period: periodSchema.default('30d'),
  sort: z.enum(['date_desc', 'date_asc', 'duration_desc', 'duration_asc']).default('date_desc'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
}).strict();

interface PortalContext {
  user: PortalAuthUser;
  membership: PortalMembership;
}

export interface AdminRouterDependencies {
  authenticate(token: string): Promise<PortalAuthUser | null>;
  resolveMembership(userId: string, cabinetId?: string): Promise<PortalMembership | null>;
  getCabinet(cabinetId: string): Promise<PortalCabinetRow | null>;
  listCalls(cabinetId: string, query: PortalCallsQuery): Promise<{ rows: PortalCallRow[]; total: number }>;
  dashboardSnapshot(cabinetId: string, period: PortalCallsQuery['period']): Promise<PortalDashboardSnapshot>;
  getCall(cabinetId: string, callId: string): Promise<PortalCallRow | null>;
  listTeam(cabinetId: string): Promise<PortalTeamRow[]>;
  listPractices(userId: string): Promise<PortalPractice[]>;
  mutateCabinet(
    cabinetId: string,
    actorUserId: string,
    action: 'settings_updated' | 'assistant_updated',
    patch: PortalCabinetPatch,
    changedFields: string[],
    expectedUpdatedAt: string,
  ): Promise<PortalCabinetRow>;
  signPdf(path: string, ttlSeconds: number): Promise<string>;
}

const defaultDependencies: AdminRouterDependencies = {
  authenticate: (token) => portalQueries.authenticatePortalAccessToken(token),
  resolveMembership: (userId, cabinetId) => portalQueries.resolvePortalMembership(userId, cabinetId),
  getCabinet: (cabinetId) => portalQueries.getPortalCabinet(cabinetId),
  listCalls: (cabinetId, query) => portalQueries.listPortalCalls(cabinetId, query),
  dashboardSnapshot: (cabinetId, period) => portalQueries.getPortalDashboardSnapshot(cabinetId, period),
  getCall: (cabinetId, callId) => portalQueries.getPortalCall(cabinetId, callId),
  listTeam: (cabinetId) => portalQueries.listPortalTeam(cabinetId),
  listPractices: (userId) => portalQueries.listPortalPractices(userId),
  mutateCabinet: (cabinetId, actorUserId, action, patch, changedFields, expectedUpdatedAt) =>
    portalQueries.applyPortalCabinetPatchWithAudit(
      cabinetId,
      actorUserId,
      action,
      patch,
      changedFields,
      expectedUpdatedAt,
    ),
  signPdf: createSignedPdfUrl,
};

const OUTCOME_TO_DB: Readonly<Record<z.infer<typeof outcomeInputSchema>, PortalCallResult>> = {
  appointment: 'rdv_pris',
  message: 'message',
  transferred: 'transfere',
  emergency_redirected: 'urgence',
  refused: 'refus',
  failed: 'echec',
};

const DB_TO_OUTCOME = {
  rdv_pris: 'appointment',
  message: 'message',
  transfere: 'transferred',
  urgence: 'emergency_redirected',
  refus: 'refused',
  echec: 'failed',
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function portalConfig(cabinet: PortalCabinetRow): Record<string, unknown> {
  return asRecord(asRecord(cabinet.config_agent).portal);
}

function calendarIntegration(cabinet: PortalCabinetRow): z.infer<typeof calendarIntegrationSchema> | null {
  const parsed = calendarIntegrationSchema.safeParse(
    asRecord(cabinet.config_agent).calendar,
  );
  return parsed.success ? parsed.data : null;
}

function safeReason(value: string | null): string {
  if (!value) return 'Autre demande';
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase();
  if (/rendez|rdv|reservation|horaire/u.test(normalized)) return 'Rendez-vous';
  if (/factur|assurance|paiement|rembours/u.test(normalized)) return 'Facturation';
  if (/ordonnance|prescription|renouvel/u.test(normalized)) return 'Ordonnance';
  if (/message|rappel|joindre|contact/u.test(normalized)) return 'Message';
  if (/suivi|controle/u.test(normalized)) return 'Suivi';
  return 'Autre demande';
}

function callSummary(row: PortalCallRow): Record<string, unknown> {
  return {
    id: row.id,
    startedAt: row.date_appel,
    maskedNumber: 'Numéro non exposé',
    durationSec: Math.max(0, row.duree_secondes ?? 0),
    reason: safeReason(row.motif_appel),
    outcome: row.resultat ? DB_TO_OUTCOME[row.resultat] : 'failed',
    practitionerId: row.rdv_praticien,
    practitionerName: row.rdv_praticien,
    appointmentAt: row.rdv_date,
    pdfStatus: row.pdf_url ? 'generated' : row.email_status === 'failed' ? 'failed' : 'pending',
    emailStatus: row.email_status === 'bounced' ? 'failed' : row.email_status,
  };
}

function dashboardCallSummary(row: PortalDashboardRecentCall): Record<string, unknown> {
  return {
    id: row.id,
    startedAt: row.date_appel,
    maskedNumber: 'Numéro non exposé',
    durationSec: Math.max(0, row.duree_secondes ?? 0),
    reason: safeReason(row.motif_appel),
    outcome: row.resultat ? DB_TO_OUTCOME[row.resultat] : 'failed',
    practitionerId: row.rdv_praticien,
    practitionerName: row.rdv_praticien,
    appointmentAt: row.rdv_date,
    pdfStatus: row.has_pdf ? 'generated' : row.email_status === 'failed' ? 'failed' : 'pending',
    emailStatus: row.email_status === 'bounced' ? 'failed' : row.email_status,
  };
}

function callDetail(row: PortalCallRow): Record<string, unknown> {
  const summary = callSummary(row);
  const emailState = row.email_status === 'sent' ? 'done' : row.email_status === 'pending' ? 'pending' : 'failed';
  return {
    ...summary,
    timeline: [
      { at: row.date_appel, label: 'Appel reçu', state: 'done' },
      { at: row.pdf_envoye_at ?? row.date_appel, label: 'Récapitulatif PDF', state: row.pdf_url ? 'done' : 'pending' },
      { at: row.pdf_envoye_at ?? row.date_appel, label: 'Notification', state: emailState },
    ],
    audioDeletedAt: null,
    transcriptState: 'unavailable',
    transcript: [],
    summaryPdfName: row.pdf_url ? `recap-${row.id}.pdf` : null,
  };
}

function settingsDto(cabinet: PortalCabinetRow): Record<string, unknown> {
  const stored = asRecord(portalConfig(cabinet).settings);
  return {
    practiceName: cabinet.nom,
    specialty: cabinet.type_cabinet ?? 'autre',
    addressLine: cabinet.adresse ?? 'Non renseignée',
    postalCode: cabinet.npa ?? '0000',
    city: cabinet.ville ?? 'Non renseignée',
    timezone: 'Europe/Zurich',
    notificationEmail: cabinet.email_notification,
    ccEmail: cabinet.email_notification_cc ?? '',
    openingHours: openingHoursSchema.safeParse(stored.openingHours).success
      ? stored.openingHours
      : [],
    practitioners: z.array(practitionerSchema).safeParse(stored.practitioners).success
      ? stored.practitioners
      : [],
    weeklyDigest: typeof stored.weeklyDigest === 'boolean' ? stored.weeklyDigest : false,
    notifyOnFailure: typeof stored.notifyOnFailure === 'boolean' ? stored.notifyOnFailure : true,
  };
}

function assistantDto(cabinet: PortalCabinetRow): Record<string, unknown> {
  const stored = asRecord(portalConfig(cabinet).assistant);
  const defaults = {
    publicName: 'Assistant Corya',
    greeting: `Bonjour, vous êtes bien au cabinet ${cabinet.nom}.`,
    language: 'fr-CH',
    businessHours: [],
    afterHoursBehaviour: 'message',
    allowedRequests: [],
    forbiddenRequests: [],
    transferRules: '',
    maskedTransferNumber: '',
    emergencyProtocol: '',
    shareableInformation: '',
    minimalCollection: [],
    confirmAppointments: true,
  };
  const parsed = assistantPatchSchema.safeParse(stored);
  return parsed.success ? { ...defaults, ...parsed.data } : defaults;
}

function integrationsDto(cabinet: PortalCabinetRow): Record<string, unknown> {
  const settings = settingsDto(cabinet);
  const calendar = calendarIntegration(cabinet);
  return {
    integrations: [
      {
        id: 'calendar',
        category: 'calendar',
        name: 'Agenda',
        description: 'Agenda du cabinet',
        status: calendar ? 'connected' : 'not_configured',
        detail: calendar ? 'Cal.com actif' : 'Configuration requise',
      },
      { id: 'telephony', category: 'telephony', name: 'Téléphonie', description: 'Ligne téléphonique Corya', status: cabinet.statut === 'actif' ? 'connected' : 'degraded', detail: cabinet.statut === 'actif' ? 'Service actif' : 'Service suspendu' },
      { id: 'email', category: 'email', name: 'E-mail', description: 'Envoi des récapitulatifs', status: cabinet.email_notification ? 'connected' : 'needs_config', detail: cabinet.email_notification ? 'Destinataire configuré' : 'Configuration requise' },
    ],
    calendar: {
      provider: calendar?.provider ?? '',
      calendarName: calendar?.calendarName ?? '',
      practitionerIds: (settings.practitioners as Array<{ id: string }>).map((item) => item.id),
      slotDurationMin: calendar?.slotDurationMin ?? 30,
      openingHours: settings.openingHours,
      closedDays: [],
      minimumNoticeHours: calendar?.minimumNoticeHours ?? 24,
      allowBooking: calendar?.allowBooking ?? false,
      allowReschedule: calendar?.allowReschedule ?? false,
      allowCancellation: calendar?.allowCancellation ?? false,
    },
  };
}

function sendInvalid(res: Response): void {
  res.status(400).json({ error: 'invalid_request' });
}

function isPortalConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'portal_cabinet_concurrent_update';
}

function isPortalNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === 'portal_cabinet_not_found';
}

function isPortalAdminRevoked(error: unknown): boolean {
  return error instanceof Error && error.message === 'portal_admin_membership_required';
}

function changedFieldNames(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  return Object.keys(patch).filter((key) =>
    JSON.stringify(current[key]) !== JSON.stringify(patch[key]));
}

function parseBearer(req: Request): string | null {
  const value = req.header('authorization');
  if (!value || value.length > 4_103) return null;
  const match = /^Bearer ([A-Za-z0-9._~+\/-]{16,4096})$/u.exec(value);
  return match?.[1] ?? null;
}

export function buildAdminRouter(
  dependencies: AdminRouterDependencies = defaultDependencies,
): Router {
  const router = Router();
  const contexts = new WeakMap<Request, PortalContext>();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  // Global ingress budget is consumed before any token verification, so a
  // burst cannot turn Supabase Auth into an amplification target.
  router.use(buildAdminPreAuthRateLimiter());

  router.use(async (req, res, next): Promise<void> => {
    const token = parseBearer(req);
    if (!token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      const user = await dependencies.authenticate(token);
      if (!user) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const requestedHeader = req.header('x-corya-cabinet-id');
      if (requestedHeader !== undefined && !UUID.safeParse(requestedHeader).success) {
        sendInvalid(res);
        return;
      }
      const membership = await dependencies.resolveMembership(user.id, requestedHeader);
      if (!membership) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (!consumeAuthenticatedAdminRateLimit(
        req,
        res,
        user.id,
        membership.cabinetId,
      )) return;
      contexts.set(req, { user, membership });
      next();
    } catch (error: unknown) {
      if (
        error instanceof TimeoutError
        || (error instanceof Error && ['portal_auth_not_configured', 'portal_auth_unavailable'].includes(error.message))
      ) {
        res.status(503).json({ error: 'authentication_unavailable' });
        return;
      }
      next(error);
    }
  });

  const context = (req: Request): PortalContext => {
    const value = contexts.get(req);
    if (!value) throw new Error('portal_context_missing');
    return value;
  };

  const cabinet = async (req: Request, res: Response): Promise<PortalCabinetRow | null> => {
    const row = await dependencies.getCabinet(context(req).membership.cabinetId);
    if (!row) res.status(404).json({ error: 'not_found' });
    return row;
  };

  router.get('/me', async (req, res): Promise<void> => {
    const ctx = context(req);
    const row = await cabinet(req, res);
    if (!row) return;
    const practices = await dependencies.listPractices(ctx.user.id);
    res.json({
      id: ctx.user.id,
      displayName: ctx.user.displayName || 'Utilisateur Corya',
      email: ctx.user.email,
      role: ctx.membership.role,
      practiceId: row.id,
      practiceName: row.nom,
      practices,
    });
  });

  router.get('/dashboard', async (req, res): Promise<void> => {
    const parsed = periodSchema.safeParse(req.query.period ?? '30d');
    if (!parsed.success) return sendInvalid(res);
    const row = await cabinet(req, res);
    if (!row) return;
    const snapshot = await dependencies.dashboardSnapshot(row.id, parsed.data);
    const outcomeCounts = new Map(snapshot.outcomes.map((item) => [item.resultat, item.count]));
    const outcomes = Object.entries(DB_TO_OUTCOME).map(([resultat, outcome]) => ({
      outcome,
      count: outcomeCounts.get(resultat as PortalCallResult) ?? 0,
    }));
    const settings = settingsDto(row);
    res.json({
      metrics: [
        { key: 'calls', label: 'Appels', value: snapshot.totalCalls, unit: 'count', trendPct: null },
        { key: 'appointments', label: 'Rendez-vous', value: snapshot.appointments, unit: 'count', trendPct: null },
        { key: 'average_duration', label: 'Durée moyenne', value: snapshot.totalCalls ? Math.round(snapshot.totalDurationSeconds / snapshot.totalCalls) : 0, unit: 'seconds', trendPct: null },
      ],
      volume: snapshot.volume,
      outcomes,
      recentCalls: snapshot.recentCalls.map(dashboardCallSummary),
      assistantState: row.statut === 'actif' ? 'operational' : 'offline',
      calendarState: calendarIntegration(row) ? 'operational' : 'not_configured',
      alerts: [],
      coverage: settings.openingHours,
    });
  });

  router.get('/calls', async (req, res): Promise<void> => {
    const parsed = callsQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendInvalid(res);
    const outcome = parsed.data.outcome === 'all' ? undefined : OUTCOME_TO_DB[parsed.data.outcome];
    const query: PortalCallsQuery = {
      period: parsed.data.period,
      sort: parsed.data.sort,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      ...(parsed.data.practitionerId === 'all' ? {} : { practitionerId: parsed.data.practitionerId }),
      ...(outcome ? { outcome } : {}),
      ...(parsed.data.summaryStatus === 'all' ? {} : { summaryStatus: parsed.data.summaryStatus }),
    };
    const result = await dependencies.listCalls(context(req).membership.cabinetId, query);
    res.json({ items: result.rows.map(callSummary), total: result.total, page: query.page, pageSize: query.pageSize });
  });

  router.get('/calls/:id', async (req, res): Promise<void> => {
    const parsedId = UUID.safeParse(req.params.id);
    if (!parsedId.success) return sendInvalid(res);
    const row = await dependencies.getCall(context(req).membership.cabinetId, parsedId.data);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(callDetail(row));
  });

  router.post('/calls/:id/pdf-url', async (req, res): Promise<void> => {
    const parsedId = UUID.safeParse(req.params.id);
    if (!parsedId.success) return sendInvalid(res);
    const ctx = context(req);
    const row = await dependencies.getCall(ctx.membership.cabinetId, parsedId.data);
    if (!row?.pdf_url) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const expected = buildPdfObjectPath(ctx.membership.cabinetId, row.id, row.date_appel);
    if (row.pdf_url !== expected) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const expiresIn = 300;
    const url = await dependencies.signPdf(expected, expiresIn);
    res.json({ url, expiresIn });
  });

  router.get('/integrations', async (req, res): Promise<void> => {
    const row = await cabinet(req, res);
    if (row) res.json(integrationsDto(row));
  });

  router.get('/settings', async (req, res): Promise<void> => {
    const row = await cabinet(req, res);
    if (row) res.json(settingsDto(row));
  });

  router.patch('/settings', async (req, res): Promise<void> => {
    const ctx = context(req);
    if (ctx.membership.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return sendInvalid(res);
    const data = parsed.data;
    const current = await dependencies.getCabinet(ctx.membership.cabinetId);
    if (!current) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const changedFields = changedFieldNames(
      settingsDto(current),
      data,
    );
    if (changedFields.length === 0) {
      res.json(settingsDto(current));
      return;
    }
    const changed = new Set(changedFields);
    const portalSettings: Record<string, unknown> = {};
    for (const key of ['openingHours', 'practitioners', 'weeklyDigest', 'notifyOnFailure'] as const) {
      if (changed.has(key) && data[key] !== undefined) portalSettings[key] = data[key];
    }
    try {
      const patch: PortalCabinetPatch = {
        ...(changed.has('practiceName') ? { nom: data.practiceName } : {}),
        ...(changed.has('specialty') ? { type_cabinet: data.specialty } : {}),
        ...(changed.has('addressLine') ? { adresse: data.addressLine } : {}),
        ...(changed.has('postalCode') ? { npa: data.postalCode } : {}),
        ...(changed.has('city') ? { ville: data.city } : {}),
        ...(changed.has('notificationEmail') ? { email_notification: data.notificationEmail } : {}),
        ...(changed.has('ccEmail') ? { email_notification_cc: data.ccEmail || null } : {}),
        ...(Object.keys(portalSettings).length > 0 ? { portalSettings } : {}),
      };
      const updated = await dependencies.mutateCabinet(
        ctx.membership.cabinetId,
        ctx.user.id,
        'settings_updated',
        patch,
        changedFields,
        current.updated_at,
      );
      res.json(settingsDto(updated));
    } catch (error: unknown) {
      if (isPortalConflict(error)) {
        res.status(409).json({ error: 'conflict' });
        return;
      }
      if (isPortalNotFound(error)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (isPortalAdminRevoked(error)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      throw error;
    }
  });

  router.get('/team', async (req, res): Promise<void> => {
    const ctx = context(req);
    const rows = await dependencies.listTeam(ctx.membership.cabinetId);
    res.json(rows.map((member) => ({
      id: member.user_id,
      displayName: member.user_id === ctx.user.id ? (ctx.user.displayName || 'Utilisateur Corya') : 'Membre du cabinet',
      email: member.user_id === ctx.user.id ? ctx.user.email : '',
      role: member.role,
      status: member.actif ? 'active' : 'disabled',
      lastSeenAt: null,
    })));
  });

  router.get('/security/status', async (req, res): Promise<void> => {
    await cabinet(req, res);
    if (res.headersSent) return;
    res.json({
      retentionDays: 730,
      audioDeletionPolicy: 'Suppression planifiée sous 48 heures',
      transcriptPolicy: 'Données identifiantes supprimées après 7 jours',
      pdfStoragePolicy: 'Stockage privé, accès temporaire après autorisation',
      roleAccess: [
        { role: 'admin', description: 'Lecture et configuration du cabinet' },
        { role: 'viewer', description: 'Lecture seule' },
      ],
      auditLogAvailable: false,
      services: [{ name: 'Stockage des récapitulatifs', state: 'operational' }],
      storedData: [
        { category: 'Appels', detail: 'Métadonnées minimales, sans numéro appelant' },
        { category: 'Récapitulatifs', detail: 'PDF dans un stockage privé' },
      ],
    });
  });

  router.get('/assistant', async (req, res): Promise<void> => {
    const row = await cabinet(req, res);
    if (row) res.json(assistantDto(row));
  });

  router.patch('/assistant', async (req, res): Promise<void> => {
    const ctx = context(req);
    if (ctx.membership.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = assistantPatchSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return sendInvalid(res);
    const current = await dependencies.getCabinet(ctx.membership.cabinetId);
    if (!current) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const changedFields = changedFieldNames(
      assistantDto(current),
      parsed.data,
    );
    if (changedFields.length === 0) {
      res.json(assistantDto(current));
      return;
    }
    const changed = new Set(changedFields);
    const portalAssistant: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (changed.has(key)) portalAssistant[key] = value;
    }
    try {
      const updated = await dependencies.mutateCabinet(
        ctx.membership.cabinetId,
        ctx.user.id,
        'assistant_updated',
        { portalAssistant },
        changedFields,
        current.updated_at,
      );
      res.json(assistantDto(updated));
    } catch (error: unknown) {
      if (isPortalConflict(error)) {
        res.status(409).json({ error: 'conflict' });
        return;
      }
      if (isPortalNotFound(error)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (isPortalAdminRevoked(error)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      throw error;
    }
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (error instanceof TimeoutError) {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }
    if (error instanceof Error) {
      if (isPortalNotFound(error)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (error.message === 'portal_dashboard_snapshot_failed') {
        res.status(503).json({ error: 'dashboard_unavailable' });
        return;
      }
      if (error.message.startsWith('portal_') && error.message.endsWith('_failed')) {
        res.status(503).json({ error: 'service_unavailable' });
        return;
      }
    }
    next(error);
  });

  return router;
}

export const adminRouter: Router = buildAdminRouter();
