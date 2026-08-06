export type PortalRole = 'admin' | 'viewer';

export interface PortalAuthUser {
  id: string;
  email: string;
  displayName: string;
}

export interface PortalMembership {
  cabinetId: string;
  role: PortalRole;
}

export interface PortalPractice {
  id: string;
  name: string;
  role: PortalRole;
}

export interface PortalCabinetRow {
  id: string;
  nom: string;
  type_cabinet: string | null;
  adresse: string | null;
  npa: string | null;
  ville: string | null;
  email_notification: string;
  email_notification_cc: string | null;
  statut: 'actif' | 'pause' | 'resilie';
  config_agent: Record<string, unknown>;
  updated_at: string;
}

export type PortalCallResult =
  | 'rdv_pris'
  | 'message'
  | 'transfere'
  | 'urgence'
  | 'echec'
  | 'refus';

export interface PortalCallRow {
  id: string;
  cabinet_id: string;
  date_appel: string;
  duree_secondes: number | null;
  resultat: PortalCallResult | null;
  motif_appel: string | null;
  rdv_date: string | null;
  rdv_praticien: string | null;
  pdf_url: string | null;
  pdf_envoye_at: string | null;
  email_status: 'pending' | 'sent' | 'failed' | 'bounced';
  created_at: string;
}

export interface PortalDashboardRecentCall {
  id: string;
  date_appel: string;
  duree_secondes: number | null;
  resultat: PortalCallResult | null;
  motif_appel: string | null;
  has_pdf: boolean;
  email_status: 'pending' | 'sent' | 'failed' | 'bounced';
  rdv_date: string | null;
  rdv_praticien: string | null;
}

export interface PortalDashboardSnapshot {
  periodStart: string;
  totalCalls: number;
  totalDurationSeconds: number;
  appointments: number;
  volume: Array<{ date: string; calls: number }>;
  outcomes: Array<{ resultat: PortalCallResult; count: number }>;
  recentCalls: PortalDashboardRecentCall[];
}

export interface PortalCallsQuery {
  period: '7d' | '30d' | '90d';
  outcome?: PortalCallResult;
  summaryStatus?: 'complete' | 'pending' | 'failed';
  practitionerId?: string;
  sort: 'date_desc' | 'date_asc' | 'duration_desc' | 'duration_asc';
  page: number;
  pageSize: number;
}

export interface PortalTeamRow {
  user_id: string;
  role: PortalRole;
  actif: boolean;
  created_at: string;
}

export interface PortalCabinetPatch {
  nom?: string;
  type_cabinet?: string;
  adresse?: string;
  npa?: string;
  ville?: string;
  email_notification?: string;
  email_notification_cc?: string | null;
  portalSettings?: Record<string, unknown>;
  portalAssistant?: Record<string, unknown>;
}
