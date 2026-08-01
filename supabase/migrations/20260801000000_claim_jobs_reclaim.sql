-- =============================================================================
-- Corya — Reclaim des zombies dans claim_jobs + bornage strict de
--          requeue_stuck_jobs + colonne dead_letter_alerted_at
-- Date : 2026-08-01
-- Auteur : sub-agent database-compliance
--
-- Session 4 — pièce A du chantier « résilience du worker ».
--
-- Ce que cette migration corrige :
--   1. Un job dont le worker crashe mid-processing attendait jusqu'à 10 min
--      (cron requeue-stuck-jobs) avant d'être réutilisable. La nouvelle
--      claim_jobs le reprend directement au tick de polling suivant.
--   2. TROU CRITIQUE identifié en Session 4 : requeue_stuck_jobs remettait
--      en 'pending' SANS regarder attempts. Combiné au nouveau filtre
--      « attempts < max_attempts » de claim_jobs, un job stuck épuisé serait
--      resté coincé en 'pending' indéfiniment — invisible, jamais claim,
--      jamais basculé en dead_letter, donc AUCUNE alerte n'aurait été
--      déclenchée. Pire que le rebond initial. Correctif : requeue_stuck_jobs
--      bascule directement en dead_letter les jobs stuck épuisés.
--   3. Ajout de jobs.dead_letter_alerted_at : SQL ne peut pas envoyer
--      d'email. Le backend aura un poller (5 min) qui alerte EXACTEMENT
--      UNE FOIS par ligne dead_letter. Cette colonne est le drapeau d'audit.
--
-- Articulation des seuils :
--   p_stale_after_seconds (défaut 300 s / 5 min) — claim_jobs
--   p_stuck_after         (défaut 10 min)         — requeue_stuck_jobs
--
--   Le seuil de claim_jobs est PLUS COURT que celui de requeue_stuck_jobs,
--   volontairement. Rationale :
--     - claim_jobs est le chemin normal de reprise (rapide, opportuniste).
--       Un zombie récent est réattribué au premier worker qui poll.
--     - requeue_stuck_jobs est le filet de sécurité (lent, systématique)
--       et surtout la voie de bascule en dead_letter pour les jobs épuisés.
--       Il doit s'exécuter APRÈS que claim_jobs ait eu au moins une chance
--       de reprendre — sinon on lynche un job qu'un worker sain aurait
--       repris à sa prochaine boucle.
--     - Marge : 10 min - 5 min = 5 min = 60 ticks de polling à 5 s, très
--       largement au-delà du besoin.
--
-- Non-régressions :
--   - claim_jobs change de signature (nouveau p_stale_after_seconds à
--     défaut 300). L'appelant TypeScript (apps/backend/src/db/queries.ts)
--     continue de fonctionner : il passe (p_worker_id, p_batch_size) et
--     Postgres résout l'appel via la valeur par défaut du 3e paramètre.
--     On DROP l'ancienne signature (TEXT, INT) pour éviter l'ambiguïté de
--     résolution PL/pgSQL.
--   - requeue_stuck_jobs change de type de retour (INTEGER -> TABLE).
--     Le cron l'appelle avec SELECT public.requeue_stuck_jobs() : ça
--     continue de marcher, cron.job_run_details capture juste le tuple
--     retourné sous forme de ligne.
--
-- Conformité :
--   - art. 6 nLPD : bornage strict des tentatives (pas de boucle
--     infinie invisible), garantie qu'un incident finit toujours par
--     produire un dead_letter détectable et alertable.
--   - Le message dead_letter est une CONSTANTE ('stuck_job_exhausted_attempts')
--     sans la moindre PII. Contrat compatible avec la troncature 500 chars
--     de fail_job.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Colonne jobs.dead_letter_alerted_at
-- -----------------------------------------------------------------------------
-- Contrat de propriété :
--   - Écrite EXCLUSIVEMENT par le backend api.corya.ch (poller dead_letter),
--     APRÈS un envoi d'alerte (email exploitation) confirmé côté SMTP.
--   - JAMAIS écrite par SQL (requeue_stuck_jobs, fail_job, cron, etc.).
--     Une bascule en dead_letter laisse cette colonne à NULL, ce qui signale
--     au poller qu'une alerte est due.
--   - Utilisation d'un index partiel très étroit pour que la requête
--     « dead_letter à alerter » reste O(1) même sur historique important.
--
-- Nullable, sans défaut, aucun backfill : la ligne existante en dead_letter
-- au moment du déploiement (s'il y en a) sera considérée comme non-alertée
-- et déclenchera une alerte au premier tick du poller — comportement
-- souhaité (rattrapage silencieux).

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS dead_letter_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.jobs.dead_letter_alerted_at IS
  'Horodatage de l''envoi d''une alerte pour cette entrée dead_letter. '
  'Écrite exclusivement par le backend, APRÈS envoi email OK. NULL = alerte due.';

-- Index partiel : la requête « dead_letter non encore alertés » est
-- exécutée toutes les 5 min par le poller. Elle doit rester rapide même
-- avec 100 000+ jobs historiques. La clé de tri (created_at) permet un
-- traitement chronologique.
CREATE INDEX IF NOT EXISTS idx_jobs_dead_letter_to_alert
  ON public.jobs (created_at)
  WHERE status = 'dead_letter' AND dead_letter_alerted_at IS NULL;


-- -----------------------------------------------------------------------------
-- 2. claim_jobs — reclaim des zombies + bornage attempts
-- -----------------------------------------------------------------------------
-- On DROP explicitement l'ancienne signature avant CREATE, pour deux raisons :
--   a. Le type de retour est identique (SETOF public.jobs) donc CREATE OR
--      REPLACE serait accepté, MAIS Postgres accepterait alors deux signatures
--      distinctes (TEXT,INT) et (TEXT,INT,INT). L'appel supabase-js
--      claim_jobs(p_worker_id, p_batch_size) matcherait l'ancienne — bug
--      silencieux garanti.
--   b. La sémantique change : l'ancienne ne prenait QUE des pending. Ne
--      pas la laisser en base évite qu'un code résiduel s'en serve par
--      erreur.

DROP FUNCTION IF EXISTS public.claim_jobs(TEXT, INT);

-- 2.1 Nouvelle claim_jobs -----------------------------------------------------
-- Prend en un seul passage jusqu'à p_batch_size jobs éligibles :
--   - jobs 'pending' avec run_after <= NOW() (chemin normal)
--   - jobs 'processing' dont locked_at < NOW() - p_stale_after_seconds
--     (zombies : worker crashé, OOM Jelastic, coupure)
-- Dans les DEUX cas : attempts < max_attempts (protection dure).
--
-- Ordre de priorité, explicite :
--   1. Les pending avant les zombies (priorité au chemin normal).
--   2. À l'intérieur de chaque groupe, ORDER BY la clé temporelle
--      pertinente (run_after pour pending, locked_at pour zombies).
--   Un tri implicite (ex : ORDER BY run_after) mélangerait mal les deux
--   groupes puisque run_after n'est plus mis à jour pour un zombie.
--
-- FOR UPDATE SKIP LOCKED : deux workers concurrents ne prennent jamais
-- le même job. Un job verrouillé par la transaction d'un autre worker
-- est simplement sauté.
--
-- Incrément de attempts À LA PRISE (et non à l'échec) : critique.
--   - Un worker qui crashe systématiquement (bug déterministe) verra
--     ses attempts monter naturellement au fil des reprises par claim_jobs.
--   - Une fois attempts >= max_attempts, ni claim_jobs (filtre WHERE) ni
--     requeue_stuck_jobs (§3, branche dead_letter) ne laisseront le job
--     tourner à vide. Bornage strict garanti.

CREATE FUNCTION public.claim_jobs(
  p_worker_id            TEXT,
  p_batch_size           INT DEFAULT 5,
  p_stale_after_seconds  INT DEFAULT 300
)
RETURNS SETOF public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.jobs
    WHERE attempts < max_attempts
      AND (
        (status = 'pending' AND run_after <= NOW())
        OR
        (status = 'processing'
         AND locked_at IS NOT NULL
         AND locked_at < NOW() - make_interval(secs => p_stale_after_seconds))
      )
    -- Priorité 1 : pending avant zombies (chemin normal favorisé)
    -- Priorité 2 : dans chaque groupe, la clé temporelle pertinente
    ORDER BY
      (CASE WHEN status = 'pending' THEN 0 ELSE 1 END),
      (CASE WHEN status = 'pending' THEN run_after ELSE locked_at END)
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.jobs j
  SET status    = 'processing',
      locked_at = NOW(),
      locked_by = p_worker_id,
      attempts  = j.attempts + 1
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$$;

COMMENT ON FUNCTION public.claim_jobs(TEXT, INT, INT) IS
  'Réserve jusqu''à p_batch_size jobs éligibles : pending mûrs ET zombies '
  '(processing verrouillés depuis > p_stale_after_seconds). Filtre '
  'attempts < max_attempts. Incrémente attempts à la prise. '
  'Ordre : pending d''abord, puis zombies. FOR UPDATE SKIP LOCKED.';

REVOKE EXECUTE ON FUNCTION public.claim_jobs(TEXT, INT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_jobs(TEXT, INT, INT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_jobs(TEXT, INT, INT) TO service_role;


-- -----------------------------------------------------------------------------
-- 3. requeue_stuck_jobs — bornage strict + bascule dead_letter
-- -----------------------------------------------------------------------------
-- DROP obligatoire : changement du type de retour (INTEGER -> TABLE(INT,INT)).
-- CREATE OR REPLACE ne peut pas modifier la signature de retour.

DROP FUNCTION IF EXISTS public.requeue_stuck_jobs(INTERVAL);

-- 3.1 Nouvelle requeue_stuck_jobs --------------------------------------------
-- Traitement en DEUX branches disjointes, dans une SEULE transaction (fonction
-- plpgsql implicite) :
--
--   Branche A — stuck ET attempts >= max_attempts
--     -> bascule en dead_letter, libération des verrous, last_error constant.
--     Sans cette branche, ces jobs seraient remis en 'pending' et jamais
--     re-claim par claim_jobs (filtre attempts < max_attempts), donc bloqués
--     invisibles. Détection par le poller dead_letter côté backend impossible.
--     C'est le trou identifié en Session 4 par le fondateur.
--
--   Branche B — stuck ET attempts < max_attempts
--     -> retour à 'pending' pour reprise par un autre worker (comportement
--        historique). run_after = NOW() : dispo immédiatement.
--
-- ORDRE D'EXÉCUTION : branche A d'abord. Les deux prédicats sont disjoints
-- (attempts >= max vs attempts <), l'ordre est en pratique indifférent — on
-- documente A avant B pour lisibilité (le cas le plus critique en premier).
--
-- Message dead_letter :
--   Constante 'stuck_job_exhausted_attempts'. Zéro PII. Long < 500 chars,
--   compatible avec la troncature de fail_job (par principe, même si on
--   n'appelle pas fail_job ici).

CREATE FUNCTION public.requeue_stuck_jobs(
  p_stuck_after INTERVAL DEFAULT INTERVAL '10 minutes'
)
RETURNS TABLE (
  requeued      INT,
  dead_lettered INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_requeued      INT := 0;
  v_dead_lettered INT := 0;
BEGIN
  -- Branche A : dead_letter pour les stuck épuisés.
  WITH stuck_exhausted AS (
    UPDATE public.jobs
    SET status     = 'dead_letter',
        locked_at  = NULL,
        locked_by  = NULL,
        last_error = 'stuck_job_exhausted_attempts'
    WHERE status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_at < NOW() - p_stuck_after
      AND attempts >= max_attempts
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_dead_lettered FROM stuck_exhausted;

  -- Branche B : requeue pour les stuck avec tentatives restantes.
  WITH requeued_rows AS (
    UPDATE public.jobs
    SET status    = 'pending',
        locked_at = NULL,
        locked_by = NULL,
        run_after = NOW()
    WHERE status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_at < NOW() - p_stuck_after
      AND attempts < max_attempts
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_requeued FROM requeued_rows;

  RETURN QUERY SELECT v_requeued, v_dead_lettered;
END;
$$;

COMMENT ON FUNCTION public.requeue_stuck_jobs(INTERVAL) IS
  'Filet de sécurité pour jobs stuck en processing au-delà de p_stuck_after. '
  'Si attempts >= max_attempts -> dead_letter (last_error constant, sans PII). '
  'Sinon -> pending avec run_after = NOW(). '
  'Retourne (requeued, dead_lettered) pour supervision.';

REVOKE EXECUTE ON FUNCTION public.requeue_stuck_jobs(INTERVAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.requeue_stuck_jobs(INTERVAL) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.requeue_stuck_jobs(INTERVAL) TO service_role;


-- -----------------------------------------------------------------------------
-- 4. Vérification de l'appel côté cron
-- -----------------------------------------------------------------------------
-- Le cron 'requeue-stuck-jobs' a été planifié dans 20260731100000 avec :
--   $$ SELECT public.requeue_stuck_jobs(); $$
--
-- Le changement de type de retour (INTEGER -> TABLE) ne casse rien : SELECT
-- sur une fonction table-returning matérialise la table en résultat SELECT
-- (une ligne, deux colonnes). cron.job_run_details capture ce résultat
-- normalement. Aucune reprogrammation nécessaire.


-- =============================================================================
-- Fin de migration.
-- =============================================================================
