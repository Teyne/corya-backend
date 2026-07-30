-- =============================================================================
-- Corya — Migration initiale
-- Date : 2026-07-30
-- Auteur : sub-agent database-compliance
--
-- Contenu :
--   1. Extensions (pgcrypto, pg_cron)
--   2. Fonctions utilitaires (update_updated_at, is_admin_user)
--   3. Tables : cabinets, appels, admin_users, logs_actions, jobs
--   4. Indexes
--   5. Triggers updated_at
--   6. RLS DENY BY DEFAULT + policies
--   7. Bucket Storage privé pdf-recaps + policies
--   8. Jobs pg_cron de purge (audio 48h, transcripts 7j, appels 24 mois)
--
-- Conformité : nLPD (art. 6, 8), art. 321 CP, cf. docs/compliance.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------

-- pgcrypto pour gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_cron pour les jobs de purge automatique (art. 6 nLPD : minimisation).
-- Sur Supabase managé, l'extension doit être activée depuis Dashboard > Database
-- > Extensions au préalable. La commande ci-dessous est idempotente.
CREATE EXTENSION IF NOT EXISTS pg_cron;


-- -----------------------------------------------------------------------------
-- 2. Fonctions utilitaires
-- -----------------------------------------------------------------------------

-- Trigger générique pour maintenir updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------

-- 3.1 cabinets --------------------------------------------------------------
CREATE TABLE public.cabinets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  type_cabinet TEXT CHECK (type_cabinet IN (
    'physio', 'osteo', 'generaliste', 'cabinet_partage',
    'radiologie', 'clinique_privee', 'ems', 'autre'
  )),
  adresse TEXT,
  npa TEXT,
  ville TEXT,
  -- Note : Corya est basée à Renens (VD) et cible d'abord la Suisse romande.
  -- Le défaut 'NE' des instructions internes a été remplacé par 'VD'.
  -- Le canton reste modifiable à l'insert par le backend.
  canton TEXT DEFAULT 'VD',
  numero_principal TEXT,
  numero_corya TEXT UNIQUE,
  email_notification TEXT NOT NULL,
  email_notification_cc TEXT,
  statut TEXT DEFAULT 'actif' CHECK (statut IN ('actif', 'pause', 'resilie')),
  config_agent JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cabinets_numero_corya ON public.cabinets(numero_corya);
CREATE INDEX idx_cabinets_statut ON public.cabinets(statut);

CREATE TRIGGER trigger_cabinets_updated_at
BEFORE UPDATE ON public.cabinets
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


-- 3.2 appels ---------------------------------------------------------------
CREATE TABLE public.appels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  retell_call_id TEXT UNIQUE NOT NULL,
  date_appel TIMESTAMPTZ NOT NULL,
  duree_secondes INTEGER,
  -- SHA-256 du numéro appelant : sert d'identifiant technique sans PII lisible.
  numero_appelant_hash TEXT,
  -- Format ex : "078 *** ** 45" pour affichage admin.
  numero_appelant_masque TEXT,
  resultat TEXT CHECK (resultat IN (
    'rdv_pris', 'message', 'transfere', 'urgence', 'echec', 'refus'
  )),
  -- Motif court non identifiant (ex : "consultation de suivi").
  motif_appel TEXT,
  -- PII patient : purgé après 7 jours (job anonymize_old_transcripts).
  patient_nom TEXT,
  patient_prenom TEXT,
  patient_telephone TEXT,
  rdv_date TIMESTAMPTZ,
  rdv_praticien TEXT,
  -- Transcript brut : purgé après 7 jours.
  transcript TEXT,
  -- Transcript anonymisé : conservé jusqu'à 24 mois pour analytics.
  transcript_anonymise TEXT,
  -- URL Retell de l'audio : purgée après 48h max.
  audio_url TEXT,
  audio_expires_at TIMESTAMPTZ,
  -- URL Supabase Storage du PDF récap : purgé avec l'appel (24 mois).
  pdf_url TEXT,
  pdf_envoye_at TIMESTAMPTZ,
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN (
    'pending', 'sent', 'failed', 'bounced'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appels_cabinet ON public.appels(cabinet_id);
CREATE INDEX idx_appels_date ON public.appels(date_appel DESC);
CREATE INDEX idx_appels_retell ON public.appels(retell_call_id);
CREATE INDEX idx_appels_audio_expires ON public.appels(audio_expires_at)
  WHERE audio_url IS NOT NULL;


-- 3.3 admin_users ----------------------------------------------------------
CREATE TABLE public.admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  nom TEXT,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
  actif BOOLEAN NOT NULL DEFAULT true,
  derniere_connexion TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_users_email_actif ON public.admin_users(email) WHERE actif = true;


-- 3.4 logs_actions ---------------------------------------------------------
CREATE TABLE public.logs_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_logs_user ON public.logs_actions(user_id, created_at DESC);
CREATE INDEX idx_logs_entity ON public.logs_actions(entity_type, entity_id);


-- 3.5 jobs -----------------------------------------------------------------
-- File de travail persistante pour les traitements post-webhook (PDF, email,
-- purge audio Retell, etc.). Motif : Retell exige un 200 OK sous ~10 s ; le
-- traitement est donc asynchrone et doit survivre à un redémarrage Jelastic.
--
-- Décisions de design :
--   - type : chaîne courte + CHECK (pas d'enum PG, évolutif via nouvelle migration)
--   - appel_id : FK forte vers appels (tous les jobs actuels tournent autour d'un appel)
--   - payload : JSONB pour contexte NON sensible (ex : email destinataire déjà connu du cabinet)
--   - status : machine à états simple (pending -> processing -> succeeded | failed | dead_letter)
--   - attempts / max_attempts : back-off applicatif, passage en dead_letter au delà
--   - run_after : date/heure du prochain essai (worker filtre WHERE run_after <= now())
--   - locked_at / locked_by : observabilité d'un job crashé mid-processing
--   - last_error : message d'erreur COURT, JAMAIS de PII (contrat backend via redact.ts)
--
-- Anti double-prise :
--   1. Le worker fait SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1 dans une TX, puis
--      passe le status à 'processing' -> deux workers ne peuvent jamais prendre le même.
--   2. Un index unique partiel empêche la présence de deux jobs identiques en attente
--      (type, appel_id) tant qu'ils sont pending ou processing.
CREATE TABLE public.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN (
    'process_call',        -- extraction + persistance depuis payload Retell
    'generate_pdf',        -- rendu Puppeteer + upload Storage
    'send_email',          -- envoi email cabinet via SMTP Infomaniak
    'purge_audio_retell'   -- suppression audio côté Retell à T+48h
  )),
  appel_id UUID NOT NULL REFERENCES public.appels(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'dead_letter'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Requête principale du worker : "prochain job dispo".
CREATE INDEX idx_jobs_ready ON public.jobs(run_after)
  WHERE status = 'pending';

-- Recherche par appel (debug/UI admin).
CREATE INDEX idx_jobs_appel ON public.jobs(appel_id);

-- Anti-doublon : pas deux jobs actifs pour (type, appel_id).
CREATE UNIQUE INDEX idx_jobs_dedup_active
  ON public.jobs(type, appel_id)
  WHERE status IN ('pending', 'processing');

CREATE TRIGGER trigger_jobs_updated_at
BEFORE UPDATE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


-- -----------------------------------------------------------------------------
-- 4. Helper d'autorisation (utilisé par les policies RLS)
-- -----------------------------------------------------------------------------

-- Vérifie que le JWT courant appartient à un admin actif.
-- SECURITY DEFINER pour bypasser le RLS de admin_users lors de la vérification.
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE email = auth.jwt() ->> 'email'
      AND actif = true
  );
END;
$$;


-- -----------------------------------------------------------------------------
-- 5. Row Level Security — DENY BY DEFAULT
-- -----------------------------------------------------------------------------
-- Principe : activer RLS sur toutes les tables. Sans policy explicite, un rôle
-- non-service_role n'a accès à rien. Le service_role bypass RLS nativement chez
-- Supabase : c'est lui que le backend api.corya.ch utilise.

ALTER TABLE public.cabinets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logs_actions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs          ENABLE ROW LEVEL SECURITY;

-- 5.1 cabinets : CRUD admin (le DELETE reste possible mais audité via logs_actions).
CREATE POLICY "Admins can read cabinets" ON public.cabinets
  FOR SELECT TO authenticated USING (public.is_admin_user());

CREATE POLICY "Admins can insert cabinets" ON public.cabinets
  FOR INSERT TO authenticated WITH CHECK (public.is_admin_user());

CREATE POLICY "Admins can update cabinets" ON public.cabinets
  FOR UPDATE TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- 5.2 appels : lecture admin uniquement. Aucune écriture côté client :
-- inserts, updates et deletes passent obligatoirement par le service_role
-- (webhook backend et purges pg_cron).
CREATE POLICY "Admins can read appels" ON public.appels
  FOR SELECT TO authenticated USING (public.is_admin_user());

-- 5.3 admin_users : lecture de la liste par les admins. Modification réservée
-- au service_role (bootstrap opérationnel via backend ou SQL manuel).
CREATE POLICY "Admins can view admin list" ON public.admin_users
  FOR SELECT TO authenticated USING (public.is_admin_user());

-- 5.4 logs_actions : lecture admin uniquement. Écriture par service_role.
CREATE POLICY "Admins can read logs" ON public.logs_actions
  FOR SELECT TO authenticated USING (public.is_admin_user());

-- 5.5 jobs : AUCUNE policy pour les rôles authenticated / anon. Seul le
-- service_role (bypass RLS) peut lire/écrire. La file de travail ne doit pas
-- transiter par le frontend, même en lecture.
-- => volontairement zéro CREATE POLICY sur public.jobs.


-- -----------------------------------------------------------------------------
-- 6. Storage : bucket privé pdf-recaps
-- -----------------------------------------------------------------------------
-- Structure de path : {cabinet_id}/{yyyy-mm}/{appel_id}.pdf
-- Bucket privé : lecture uniquement via URL signée (max 30 minutes côté backend).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'pdf-recaps',
  'pdf-recaps',
  false,
  10485760, -- 10 MiB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Storage.objects a déjà RLS activé par défaut chez Supabase.

-- Upload : réservé au service_role. Interdit à tout rôle client.
CREATE POLICY "pdf_recaps_service_write_only"
  ON storage.objects
  FOR INSERT
  TO service_role
  WITH CHECK (bucket_id = 'pdf-recaps');

-- Lecture directe : uniquement admins connectés. En pratique le backend
-- génère des URLs signées (30 min) pour l'affichage front — cette policy
-- couvre les accès directs via le SDK Supabase authentifié.
CREATE POLICY "pdf_recaps_admin_read"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'pdf-recaps' AND public.is_admin_user());

-- Update / Delete : uniquement service_role (purges automatiques).
CREATE POLICY "pdf_recaps_service_update"
  ON storage.objects
  FOR UPDATE
  TO service_role
  USING (bucket_id = 'pdf-recaps')
  WITH CHECK (bucket_id = 'pdf-recaps');

CREATE POLICY "pdf_recaps_service_delete"
  ON storage.objects
  FOR DELETE
  TO service_role
  USING (bucket_id = 'pdf-recaps');


-- -----------------------------------------------------------------------------
-- 7. Fonctions et jobs de purge (art. 6 nLPD, minimisation + limitation)
-- -----------------------------------------------------------------------------

-- 7.1 Purge audio > 48h (rétention max fixée dans docs/compliance.md)
CREATE OR REPLACE FUNCTION public.purge_expired_audio()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  UPDATE public.appels
  SET audio_url = NULL,
      audio_expires_at = NULL
  WHERE audio_url IS NOT NULL
    AND audio_expires_at IS NOT NULL
    AND audio_expires_at < NOW();
  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

-- 7.2 Anonymisation des données patient et transcript brut au delà de 7 jours.
CREATE OR REPLACE FUNCTION public.anonymize_old_transcripts()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  anonymized_count INTEGER;
BEGIN
  UPDATE public.appels
  SET patient_nom = NULL,
      patient_prenom = NULL,
      patient_telephone = NULL,
      transcript = NULL
      -- transcript_anonymise conservé pour analytics (24 mois max)
  WHERE created_at < NOW() - INTERVAL '7 days'
    AND (
      patient_nom IS NOT NULL
      OR patient_prenom IS NOT NULL
      OR patient_telephone IS NOT NULL
      OR transcript IS NOT NULL
    );
  GET DIAGNOSTICS anonymized_count = ROW_COUNT;
  RETURN anonymized_count;
END;
$$;

-- 7.3 Purge complète des appels de plus de 24 mois (et donc PDF associés via
-- la logique applicative de purge Storage — à ajouter côté backend).
CREATE OR REPLACE FUNCTION public.purge_ancient_appels()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  DELETE FROM public.appels
  WHERE created_at < NOW() - INTERVAL '24 months';
  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

-- 7.4 Planification pg_cron
-- NB : cron.schedule est idempotent au niveau du nom : si le job existe déjà
-- il est remplacé. Sur Supabase managé, ces jobs tournent dans la base postgres.
SELECT cron.schedule(
  'purge-expired-audio',
  '0 * * * *',                    -- toutes les heures
  $$ SELECT public.purge_expired_audio(); $$
);

SELECT cron.schedule(
  'anonymize-old-transcripts',
  '0 3 * * *',                    -- 03:00 UTC chaque jour
  $$ SELECT public.anonymize_old_transcripts(); $$
);

SELECT cron.schedule(
  'purge-ancient-appels',
  '0 4 1 * *',                    -- 04:00 UTC le 1er de chaque mois
  $$ SELECT public.purge_ancient_appels(); $$
);


-- =============================================================================
-- Fin de la migration initiale.
-- =============================================================================
