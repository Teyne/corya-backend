-- =============================================================================
-- Corya — Heartbeats worker : preuve de vie & preuve de polling
-- Date : 2026-08-01
-- Auteur : sub-agent database-compliance
--
-- Session 4 — pièce B du chantier « résilience du worker ».
--
-- OBJECTIF
--   Distinguer opérationnellement deux pathologies distinctes du worker :
--     - « process mort » (crash, OOM Jelastic, container tué) — l'event loop
--       n'existe plus.
--     - « boucle bloquée » — le process vit (répond aux signaux), mais la
--       boucle de polling n'avance pas (deadlock, appel Puppeteer suspendu,
--       socket SMTP en attente indéfinie, etc.).
--
--   Un seul champ « dernier signe de vie » ne peut pas différencier ces deux
--   cas sans compromis (soit fausses alertes sur batch lent, soit angle mort
--   sur worker bloqué dans un job qui pend). Deux horodatages distincts,
--   deux SLA distincts, deux causes racines distinctes.
--
-- CHAMPS
--   last_seen_at  — écrit toutes les 10 s par un setInterval INDÉPENDANT de
--                   la boucle de polling. Répond à « le process est vivant ».
--                   Seuil d'alerte côté supervision : 60 s.
--   last_poll_at  — écrit à chaque tick de la boucle de polling (dans
--                   run_job_worker). Répond à « la boucle avance ».
--                   Seuil d'alerte : 180 s (couvre un job long légitime).
--
-- CHOIX RPC PLUTÔT QU'UPSERT DIRECT
--   Le worker écrit BEAUCOUP dans cette table :
--     - toutes les 10 s pour l'alive-tick (8 640 upserts/jour/worker)
--     - à chaque tick de polling (~17 000/jour/worker à 5 s d'intervalle)
--   Deux raisons de préférer une RPC au ON CONFLICT construit côté client :
--     1. Une seule ronde réseau, plan préparé côté PG, coût minimal.
--     2. Verrouillage des permissions : GRANT EXECUTE sur la fonction >
--        droits INSERT/UPDATE au niveau table. Le service_role bypass RLS
--        de toute façon, mais si un jour on introduit un rôle worker
--        dédié (recommandation nLPD), on n'expose que ces deux RPC et non
--        toute la table.
--     3. Le contrat d'incrément atomique de jobs_processed_total est plus
--        propre en RPC (COALESCE + arithmétique dans DO UPDATE).
--
-- ÉLAGAGE
--   worker_id contient hostname+pid, il change à CHAQUE redéploiement
--   Jelastic. Sans élagage, la table accumule indéfiniment des lignes
--   fantômes. Cron hebdomadaire de purge des workers non vus depuis 30 j.
--
-- CONFORMITÉ
--   Aucune PII dans cette table : uniquement des identifiants techniques
--   (hostname, pid, version applicative). RLS activée par prudence
--   (deny by default) même si le contenu n'est pas sensible.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Table worker_heartbeats
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
  worker_id             TEXT        PRIMARY KEY,
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_poll_at          TIMESTAMPTZ,
  version               TEXT,
  jobs_processed_total  BIGINT      NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.worker_heartbeats IS
  'État de santé des workers de traitement de la file jobs. Deux horodatages '
  'distincts (last_seen_at = process vivant / last_poll_at = boucle avance). '
  'Aucune PII. Élagage hebdomadaire des workers > 30 jours sans signe de vie.';

COMMENT ON COLUMN public.worker_heartbeats.last_seen_at IS
  'Dernier tick de l''alive-heartbeat (setInterval 10 s indépendant de la '
  'boucle de polling). Seuil d''alerte recommandé : 60 s.';

COMMENT ON COLUMN public.worker_heartbeats.last_poll_at IS
  'Dernier tick de la boucle de polling (après retour de claim_jobs ou '
  'après traitement d''un batch). Seuil d''alerte recommandé : 180 s.';

COMMENT ON COLUMN public.worker_heartbeats.jobs_processed_total IS
  'Compteur monotone croissant du nombre de jobs traités par ce worker_id '
  '(succès + échecs). Incrémenté via worker_heartbeat_poll(p_jobs_processed_delta).';


-- -----------------------------------------------------------------------------
-- 2. RLS — deny by default, service_role only
-- -----------------------------------------------------------------------------
-- Calqué sur ce qu'on fait pour public.jobs : aucune policy pour
-- anon / authenticated. Le service_role bypass RLS chez Supabase.
-- Cette table ne doit jamais transiter par le frontend, même en lecture :
-- elle révèle indirectement la topologie d'infrastructure (hostnames,
-- versions déployées).

ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;
-- => volontairement zéro CREATE POLICY.


-- -----------------------------------------------------------------------------
-- 3. RPC — écriture des heartbeats
-- -----------------------------------------------------------------------------

-- 3.1 worker_heartbeat_alive -------------------------------------------------
-- Appelée toutes les 10 s par un setInterval INDÉPENDANT. Ne touche PAS
-- last_poll_at : c'est délibéré, ces deux tempos doivent rester découplées
-- pour que le diagnostic (mort vs bloqué) reste possible.
--
-- COALESCE(EXCLUDED.version, worker_heartbeats.version) : si un tick passe
-- version = NULL, on conserve la version déjà connue. Utile pour ne pas
-- « oublier » la version entre deux upserts d'alive-tick.

CREATE OR REPLACE FUNCTION public.worker_heartbeat_alive(
  p_worker_id TEXT,
  p_version   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.worker_heartbeats (worker_id, last_seen_at, version)
  VALUES (p_worker_id, NOW(), p_version)
  ON CONFLICT (worker_id) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at,
        version      = COALESCE(EXCLUDED.version, public.worker_heartbeats.version);
$$;

COMMENT ON FUNCTION public.worker_heartbeat_alive(TEXT, TEXT) IS
  'Alive-tick : met à jour last_seen_at (et éventuellement version). '
  'Appelé toutes les 10 s par un setInterval indépendant de la boucle de '
  'polling. Ne touche pas last_poll_at (découplage volontaire).';


-- 3.2 worker_heartbeat_poll --------------------------------------------------
-- Appelée à chaque tick de la boucle de polling, APRÈS retour de claim_jobs
-- (batch vide ou traité). Touche à la fois last_seen_at ET last_poll_at :
--   - last_seen_at : cohérence (si la boucle avance, le process est vivant)
--   - last_poll_at : c'est l'événement propre à ce heartbeat
--
-- Incrément atomique de jobs_processed_total :
--   Le worker passe le NOMBRE de jobs traités dans le batch qui vient de
--   se terminer (0 si batch vide). Compteur monotone strictement croissant
--   par worker_id, remis à zéro à chaque nouveau déploiement (nouveau pid,
--   donc nouvelle ligne, donc DEFAULT 0).
--
-- GREATEST(0, ...) : défense en profondeur contre un appel malicieux avec
-- delta négatif qui ferait baisser le compteur (audit).

CREATE OR REPLACE FUNCTION public.worker_heartbeat_poll(
  p_worker_id             TEXT,
  p_jobs_processed_delta  BIGINT DEFAULT 0
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.worker_heartbeats (
    worker_id, last_seen_at, last_poll_at, jobs_processed_total
  )
  VALUES (
    p_worker_id, NOW(), NOW(), GREATEST(0::BIGINT, p_jobs_processed_delta)
  )
  ON CONFLICT (worker_id) DO UPDATE
    SET last_seen_at         = EXCLUDED.last_seen_at,
        last_poll_at         = EXCLUDED.last_poll_at,
        jobs_processed_total = public.worker_heartbeats.jobs_processed_total
                             + GREATEST(0::BIGINT, EXCLUDED.jobs_processed_total);
$$;

COMMENT ON FUNCTION public.worker_heartbeat_poll(TEXT, BIGINT) IS
  'Poll-tick : met à jour last_poll_at + last_seen_at, incrémente '
  'jobs_processed_total du delta passé. Appelé à chaque tick de la boucle '
  'de polling (après retour de claim_jobs).';


-- 3.3 Verrouillage des permissions ------------------------------------------

REVOKE EXECUTE ON FUNCTION public.worker_heartbeat_alive(TEXT, TEXT)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.worker_heartbeat_alive(TEXT, TEXT)      FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.worker_heartbeat_alive(TEXT, TEXT)      TO service_role;

REVOKE EXECUTE ON FUNCTION public.worker_heartbeat_poll(TEXT, BIGINT)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.worker_heartbeat_poll(TEXT, BIGINT)     FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.worker_heartbeat_poll(TEXT, BIGINT)     TO service_role;


-- -----------------------------------------------------------------------------
-- 4. Élagage des workers disparus
-- -----------------------------------------------------------------------------
-- worker_id embarque hostname et pid, il change à CHAQUE redéploiement
-- Jelastic. Sans élagage, la table accumule une ligne par déploiement
-- (dizaines par semaine en phase active). Purge hebdomadaire, seuil
-- conservateur (30 jours) pour laisser une fenêtre d'analyse post-mortem
-- si un incident récent est étudié.

CREATE OR REPLACE FUNCTION public.purge_stale_worker_heartbeats(
  p_stale_after INTERVAL DEFAULT INTERVAL '30 days'
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  DELETE FROM public.worker_heartbeats
  WHERE last_seen_at < NOW() - p_stale_after;
  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

COMMENT ON FUNCTION public.purge_stale_worker_heartbeats(INTERVAL) IS
  'Supprime les lignes de workers non vus depuis p_stale_after. Cron '
  'hebdomadaire, protège contre l''accumulation liée aux redéploiements.';

-- Cron : dimanche 05:00 UTC, hebdomadaire.
DO $$
BEGIN
  PERFORM cron.unschedule('purge-stale-worker-heartbeats');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-stale-worker-heartbeats',
  '0 5 * * 0',                        -- dimanche 05:00 UTC
  $$ SELECT public.purge_stale_worker_heartbeats(); $$
);


-- =============================================================================
-- Fin de migration.
-- =============================================================================
