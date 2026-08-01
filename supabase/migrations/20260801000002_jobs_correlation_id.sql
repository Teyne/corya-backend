-- =============================================================================
-- Corya — jobs.correlation_id (traçabilité de bout en bout)
-- Date : 2026-08-01
-- Auteur : sub-agent database-compliance
--
-- Session 4 — pièce C du chantier « résilience du worker ».
--
-- OBJECTIF
--   Permettre de suivre un traitement du webhook (Retell POST /webhooks/
--   retell/call-ended) jusqu'aux dernières lignes de log du worker (upload
--   Storage, envoi email) en filtrant sur une seule clé opaque.
--
--   Cycle de vie de la valeur :
--     1. Le webhook génère un correlation_id à l'entrée (UUID v4 ou ULID
--        côté backend — le champ est TEXT pour tolérer les deux).
--     2. Il l'ajoute à son logger enfant (pino child({ correlation_id }))
--        pour toutes les lignes de log du handler.
--     3. Il l'inscrit dans la ligne jobs enfilée pour ce call-ended.
--     4. Le worker lit correlation_id via claim_jobs (SETOF public.jobs
--        renvoie toutes les colonnes), le remet dans son logger enfant.
--     5. Chaque étape du pipeline (PDF, upload, email) log avec le même
--        correlation_id -> filtrage trivial dans les logs Jelastic.
--
-- CONTRAINTE FORTE (rappelée par le fondateur)
--   La table jobs est en usage réel. Aucune migration ne doit casser les
--   lignes existantes.
--   -> Colonne NULLABLE, aucun DEFAULT, aucun backfill.
--   -> Une ligne historique aura correlation_id = NULL, ce qui est
--      sémantiquement correct (elle est antérieure à cette traçabilité).
--
-- CONFORMITÉ nLPD
--   Le correlation_id est un UUID/ULID technique généré côté backend, sans
--   dérivation d'aucune PII. C'est le pattern de traçabilité recommandé
--   pour éviter que les logs cross-service dépendent de valeurs sensibles.
--
-- FORMAT
--   TEXT (pas UUID) : le backend peut choisir UUID v4, ULID, KSUID selon
--   sa librairie. Contrainte de longueur = protection élémentaire contre
--   un mauvais usage (max 64 chars couvre tous les formats standards).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Colonne jobs.correlation_id
-- -----------------------------------------------------------------------------

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

-- Contrainte de longueur : borne raisonnable pour éviter le stockage d'un
-- payload accidentel dans ce champ.
-- On utilise DROP + ADD pour l'idempotence : ALTER ADD CONSTRAINT ne
-- supporte pas IF NOT EXISTS en Postgres 15.
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_correlation_id_len_check;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_correlation_id_len_check
  CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 64);

COMMENT ON COLUMN public.jobs.correlation_id IS
  'Identifiant de corrélation opaque (UUID v4 / ULID / KSUID) posé par le '
  'webhook à l''enfilement, propagé dans les logs backend et worker pour '
  'traçabilité de bout en bout. NULL pour les jobs historiques.';


-- -----------------------------------------------------------------------------
-- 2. Index (debug / support)
-- -----------------------------------------------------------------------------
-- Requête cible : « donne-moi tous les jobs déclenchés par la requête HTTP
-- X ». Volume faible (une poignée de jobs par corrélation), cardinalité
-- très haute (une valeur par requête webhook), index B-tree partiel
-- (n'indexer que les lignes qui ont une valeur — les historiques sans
-- correlation_id restent hors index).

CREATE INDEX IF NOT EXISTS idx_jobs_correlation_id
  ON public.jobs (correlation_id)
  WHERE correlation_id IS NOT NULL;


-- =============================================================================
-- Fin de migration.
-- =============================================================================
