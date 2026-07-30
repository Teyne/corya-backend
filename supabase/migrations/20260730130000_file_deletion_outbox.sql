-- =============================================================================
-- Corya — Outbox de suppression de fichiers externes
-- Date : 2026-07-30
-- Auteur : sub-agent database-compliance
--
-- But :
--   Garantir qu'aucun fichier (PDF Supabase Storage, audio Retell) ne survive
--   à la ligne `appels` qui le référence. La migration initiale
--   (20260730120000_initial_schema.sql) laissait deux fuites :
--     - purge_ancient_appels() DELETE l'appel mais pas le PDF Storage.
--     - purge_expired_audio() met audio_url à NULL mais ne demande pas la
--       suppression physique côté Retell.
--   Résultat : rétention illimitée non auditable de données de santé, en
--   violation de docs/compliance.md (24 mois PDF, 48h audio).
--
-- Piège traité :
--   La table `jobs` est ON DELETE CASCADE depuis appels. Un job de suppression
--   enfilé au moment du DELETE appels serait donc supprimé par la cascade avant
--   d'être exécuté. La solution ici crée une table SÉPARÉE, sans FK vers
--   appels, dont le cycle de vie est indépendant. On y matérialise les
--   références de fichiers (bucket + object_path, ou retell_call_id) qui sont
--   des UUID/identifiants techniques, JAMAIS des PII.
--
-- Contrat d'exécution :
--   PostgreSQL ne fait AUCUN appel réseau. Il ne fait que consigner « ce
--   fichier doit être supprimé ». Le backend api.corya.ch consomme cette table
--   comme une outbox et effectue les DELETE réels (Supabase Storage API,
--   Retell API), puis marque la ligne 'deleted' avec deleted_at horodaté :
--   c'est cette ligne qui sert de preuve d'audit nLPD.
--
-- Conformité :
--   - art. 6 nLPD (minimisation + limitation de la conservation) : les
--     fichiers ne survivent plus aux métadonnées.
--   - art. 8 nLPD (données sensibles santé) : trace auditable de suppression.
--   - art. 24 nLPD (notification violation) : en cas de fuite, on peut prouver
--     ce qui a été supprimé et quand.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Table file_deletions_outbox
-- -----------------------------------------------------------------------------
-- Volontairement AUCUNE FK vers appels : c'est le point technique clé qui
-- protège les ordres de suppression contre la cascade lors du DELETE d'un
-- appel. Les colonnes ne contiennent que des identifiants opaques (UUID,
-- retell_call_id) et un chemin d'objet Storage composé exclusivement d'UUID
-- et de yyyy-mm — jamais de nom, téléphone, motif ou fragment de transcript.

CREATE TABLE public.file_deletions_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Système cible du fichier à supprimer.
  target TEXT NOT NULL CHECK (target IN (
    'supabase_storage',   -- PDF récap dans le bucket pdf-recaps
    'retell_audio'        -- enregistrement audio hébergé chez Retell
  )),

  -- Coordonnées du fichier côté Supabase Storage (NULL si target != 'supabase_storage').
  --   bucket      = 'pdf-recaps'
  --   object_path = '{cabinet_id}/{yyyy-mm}/{appel_id}.pdf'  (UUID + date, sans PII)
  bucket TEXT,
  object_path TEXT,

  -- Référence externe côté Retell (NULL si target != 'retell_audio').
  -- On stocke le retell_call_id, qui est un identifiant technique opaque.
  external_ref TEXT,

  -- Pourquoi la suppression a été enfilée (traçabilité audit nLPD).
  reason TEXT NOT NULL CHECK (reason IN (
    'audio_expired_48h',
    'appel_purged_24m',
    'gdpr_erasure_request',       -- droit à l'effacement art. 32 nLPD
    'manual_admin_deletion'
  )),

  -- Machine à états, alignée sur celle de public.jobs.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',       -- en attente de prise en charge par le worker
    'processing',    -- worker en train de traiter
    'deleted',       -- suppression physique confirmée (deleted_at rempli)
    'failed',        -- échec transitoire, sera retenté
    'dead_letter',   -- échecs répétés : à investiguer manuellement
    'not_found'      -- le fichier n'existait déjà plus côté cible (idempotent)
  )),

  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,

  -- Contexte non sensible pour retrouver l'origine si besoin (UUID d'appel
  -- déjà supprimé, cabinet_id). Pas de PII.
  enqueued_by TEXT,       -- ex : 'purge_ancient_appels', 'purge_expired_audio'
  source_appel_id UUID,   -- UUID de l'appel d'origine (peut ne plus exister)
  source_cabinet_id UUID, -- UUID du cabinet d'origine

  -- Horodatages de preuve.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ, -- rempli par le backend UNIQUEMENT après DELETE physique confirmé

  -- Cohérence : selon la cible, les bonnes colonnes sont remplies.
  CONSTRAINT chk_target_columns CHECK (
    (target = 'supabase_storage'
       AND bucket IS NOT NULL
       AND object_path IS NOT NULL
       AND external_ref IS NULL)
    OR
    (target = 'retell_audio'
       AND external_ref IS NOT NULL
       AND bucket IS NULL
       AND object_path IS NULL)
  ),

  -- Cohérence de la preuve d'audit : deleted_at rempli <=> status finalisé.
  CONSTRAINT chk_deleted_at_consistency CHECK (
    (deleted_at IS NULL AND status IN ('pending', 'processing', 'failed', 'dead_letter'))
    OR
    (deleted_at IS NOT NULL AND status IN ('deleted', 'not_found'))
  )
);

-- Requête principale du worker : « prochaine suppression à effectuer ».
CREATE INDEX idx_fdo_ready
  ON public.file_deletions_outbox (run_after)
  WHERE status = 'pending';

-- Anti-doublon : deux ordres actifs pour le même fichier n'ont aucun sens.
-- Un index unique partiel par cible évite les collisions entre les deux
-- familles (Storage vs Retell), qui ont des colonnes disjointes.
CREATE UNIQUE INDEX idx_fdo_dedup_storage
  ON public.file_deletions_outbox (bucket, object_path)
  WHERE target = 'supabase_storage' AND status IN ('pending', 'processing');

CREATE UNIQUE INDEX idx_fdo_dedup_retell
  ON public.file_deletions_outbox (external_ref)
  WHERE target = 'retell_audio' AND status IN ('pending', 'processing');

-- Recherche par appel d'origine (support / audit).
CREATE INDEX idx_fdo_source_appel
  ON public.file_deletions_outbox (source_appel_id);

CREATE TRIGGER trigger_fdo_updated_at
BEFORE UPDATE ON public.file_deletions_outbox
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


-- -----------------------------------------------------------------------------
-- 2. RLS : outbox strictement service_role
-- -----------------------------------------------------------------------------
-- La table ne doit JAMAIS être exposée au frontend, même en lecture : elle
-- révèle indirectement l'existence d'appels et de fichiers. Seul le backend
-- (service_role, bypass RLS natif Supabase) y accède.

ALTER TABLE public.file_deletions_outbox ENABLE ROW LEVEL SECURITY;
-- => aucune CREATE POLICY : DENY BY DEFAULT pour anon / authenticated.


-- -----------------------------------------------------------------------------
-- 3. Réécriture des fonctions de purge pour alimenter l'outbox
-- -----------------------------------------------------------------------------

-- 3.1 purge_expired_audio : enfile une demande de suppression Retell AVANT
--     de NULL-ifier audio_url. Idempotent grâce à l'index unique partiel.
CREATE OR REPLACE FUNCTION public.purge_expired_audio()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  -- Étape 1 : matérialiser l'ordre de suppression côté Retell.
  -- ON CONFLICT DO NOTHING : si un ordre pending/processing existe déjà pour
  -- ce retell_call_id (via l'index unique partiel), on ne duplique pas.
  INSERT INTO public.file_deletions_outbox (
    target, external_ref, reason,
    enqueued_by, source_appel_id, source_cabinet_id
  )
  SELECT
    'retell_audio',
    a.retell_call_id,
    'audio_expired_48h',
    'purge_expired_audio',
    a.id,
    a.cabinet_id
  FROM public.appels a
  WHERE a.audio_url IS NOT NULL
    AND a.audio_expires_at IS NOT NULL
    AND a.audio_expires_at < NOW()
    AND a.retell_call_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- Étape 2 : effacer la référence en base une fois l'ordre consigné.
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


-- 3.2 purge_ancient_appels : c'est ici que se joue la protection anti-cascade.
--     On enfile TOUS les ordres de suppression (PDF Storage + éventuel audio
--     Retell résiduel) dans l'outbox AVANT le DELETE de l'appel. Comme
--     file_deletions_outbox n'a AUCUNE FK vers appels, la cascade ne peut
--     pas les emporter. L'INSERT et le DELETE se font dans la même
--     transaction implicite (fonction plpgsql), donc soit tout est consigné
--     et supprimé, soit rien ne l'est.
CREATE OR REPLACE FUNCTION public.purge_ancient_appels()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  -- 1. Enfiler la suppression des PDF Storage encore référencés.
  --    On parse pdf_url pour en extraire l'object_path relatif au bucket.
  --    Convention (initial_schema §6) : path = '{cabinet_id}/{yyyy-mm}/{appel_id}.pdf'
  --    stocké tel quel dans pdf_url (chemin d'objet, pas URL signée).
  INSERT INTO public.file_deletions_outbox (
    target, bucket, object_path, reason,
    enqueued_by, source_appel_id, source_cabinet_id
  )
  SELECT
    'supabase_storage',
    'pdf-recaps',
    a.pdf_url,
    'appel_purged_24m',
    'purge_ancient_appels',
    a.id,
    a.cabinet_id
  FROM public.appels a
  WHERE a.created_at < NOW() - INTERVAL '24 months'
    AND a.pdf_url IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- 2. Filet de sécurité : si un audio_url a survécu à sa purge horaire
  --    (bug, panne pg_cron), on enfile aussi sa suppression côté Retell.
  INSERT INTO public.file_deletions_outbox (
    target, external_ref, reason,
    enqueued_by, source_appel_id, source_cabinet_id
  )
  SELECT
    'retell_audio',
    a.retell_call_id,
    'appel_purged_24m',
    'purge_ancient_appels',
    a.id,
    a.cabinet_id
  FROM public.appels a
  WHERE a.created_at < NOW() - INTERVAL '24 months'
    AND a.retell_call_id IS NOT NULL
    AND a.audio_url IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- 3. DELETE effectif de l'appel. La cascade emporte public.jobs pour cet
  --    appel — c'est voulu, ces jobs ne servent plus. Elle n'emporte PAS
  --    file_deletions_outbox (pas de FK), donc les ordres survivent.
  DELETE FROM public.appels
  WHERE created_at < NOW() - INTERVAL '24 months';

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;


-- -----------------------------------------------------------------------------
-- 4. Job pg_cron : relance des ordres bloqués
-- -----------------------------------------------------------------------------
-- On ne crée PAS de job cron qui « supprime les fichiers » depuis Postgres :
-- Postgres ne fait pas d'appel réseau (contrainte architecturale). En
-- revanche, si un ordre reste 'processing' anormalement longtemps (worker
-- crashé mid-processing), on le remet en 'pending' pour qu'un autre worker
-- le reprenne. Reprise conservative : 15 minutes.

CREATE OR REPLACE FUNCTION public.requeue_stuck_file_deletions()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  requeued_count INTEGER;
BEGIN
  UPDATE public.file_deletions_outbox
  SET status = 'pending',
      locked_at = NULL,
      locked_by = NULL,
      run_after = NOW()
  WHERE status = 'processing'
    AND locked_at IS NOT NULL
    AND locked_at < NOW() - INTERVAL '15 minutes';
  GET DIAGNOSTICS requeued_count = ROW_COUNT;
  RETURN requeued_count;
END;
$$;

SELECT cron.schedule(
  'requeue-stuck-file-deletions',
  '*/10 * * * *',                     -- toutes les 10 minutes
  $$ SELECT public.requeue_stuck_file_deletions(); $$
);


-- =============================================================================
-- Fin de migration.
-- =============================================================================
