-- =============================================================================
-- Corya — RPC claim_file_deletions + bornage strict de requeue_stuck_file_deletions
-- Date : 2026-08-02
-- Auteur : sub-agent database-compliance
--
-- Session 4 — vague 7, pièce A : fermeture de l'écart de conformité §5.3
-- (« file_deletions_outbox sans consommateur »).
--
-- CONTEXTE
--   La table `file_deletions_outbox` existe depuis 20260730130000. Elle est
--   alimentée par purge_expired_audio, purge_ancient_appels et purge_old_pdfs
--   (migrations 20260730130000 / 20260731100000 / 20260731110000), mais aucun
--   consommateur applicatif ne l'a jamais lue. Conséquence : les PDF récap
--   restent dans le bucket `pdf-recaps` (nom patient + téléphone + transcript
--   dans le binaire) et les enregistrements audio Retell ne sont jamais
--   supprimés côté Retell. La rétention effective est illimitée — écart nLPD
--   majeur.
--
--   Cette migration fournit la PRIMITIVE SQL manquante : une RPC
--   `claim_file_deletions` calquée sur `claim_jobs`, que le worker backend
--   consommera pour effectuer les DELETE physiques puis marquer chaque ligne
--   'deleted' (ou 'not_found', voir §NOTE BACKEND en bas).
--
--   Elle corrige AUSSI, en même temps, la faille §2.1 (Session 4) dans
--   `requeue_stuck_file_deletions` : ce cron remettait en 'pending' sans
--   regarder `attempts`. Combiné au nouveau filtre `attempts < max_attempts`
--   de `claim_file_deletions`, un ordre épuisé remis en 'pending' n'aurait
--   plus jamais été claim : coincé indéfiniment en 'pending', invisible, sans
--   jamais atteindre 'dead_letter', donc sans jamais alerter. Exactement le
--   trou fermé pour `jobs` dans 20260801000000. On l'applique ici à l'outbox.
--
-- ARTICULATION DES SEUILS
--   claim_file_deletions.p_stale_after_seconds  = 300 s (5 min) par défaut
--   requeue_stuck_file_deletions (cron */10)    = 10 min (fixe ici)
--
--   Le seuil de claim est STRICTEMENT INFÉRIEUR à celui du cron : un worker
--   sain reprend son propre zombie au tick de polling suivant, avant que le
--   cron ne s'en mêle. Cohérent avec l'articulation retenue pour `jobs`
--   (claim 5 min / requeue 10 min) — cf. 20260801000000 §« Articulation ».
--
-- NON-RÉGRESSION
--   - `requeue_stuck_file_deletions` conserve son nom, sa signature (aucun
--     paramètre) et son type de retour INTEGER (nombre total de lignes
--     traitées : requeue + dead_letter confondus). Le cron
--     '*/10 * * * *' planifié en 20260730130000 continue de l'appeler tel
--     quel — inutile de reprogrammer.
--   - `file_deletions_outbox` a déjà les statuts 'dead_letter' et 'not_found'
--     dans son CHECK d'origine (20260730130000 §1). Aucun ALTER n'est requis.
--   - Réécriture idempotente : CREATE OR REPLACE pour la fonction cron,
--     CREATE OR REPLACE pour la RPC claim. Rejouable sans effet de bord.
--
-- CONFORMITÉ
--   - art. 6 nLPD (minimisation + limitation de la conservation) : la
--     primitive de consommation qui manquait pour que la chaîne SQL -> outbox
--     -> suppression physique soit réellement bouclée.
--   - art. 8 nLPD (données sensibles santé) : les ordres épuisés finissent
--     désormais en 'dead_letter' détectable, plus jamais coincés en 'pending'
--     invisible.
--   - art. 321 CP (secret médical) : `last_error` en cas de bascule
--     dead_letter est une CONSTANTE ('stuck_deletion_exhausted_attempts'),
--     sans PII, sans concaténation d'erreur externe.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. requeue_stuck_file_deletions — bornage strict + bascule dead_letter
-- -----------------------------------------------------------------------------
-- Traitement en DEUX branches disjointes, dans une seule transaction (fonction
-- plpgsql implicite) :
--
--   Branche A — stuck ET attempts >= max_attempts
--     -> bascule en 'dead_letter'. `last_error` = constante, verrous libérés.
--     Sans cette branche, ces lignes seraient remises en 'pending' et jamais
--     re-claim par claim_file_deletions (filtre attempts < max_attempts) :
--     coincées invisibles.
--
--   Branche B — stuck ET attempts < max_attempts
--     -> retour à 'pending' avec run_after = NOW() pour reprise immédiate.
--
-- Retour : total (requeue + dead_lettered) en INTEGER, pour préserver la
-- signature d'origine (le cron l'appelle avec `SELECT ...`, il capture la
-- valeur dans cron.job_run_details sans se soucier de son sens).
--
-- Design volontaire : on garde une seule valeur agrégée, contrairement à
-- requeue_stuck_jobs qui expose (requeued, dead_lettered). Ici on n'a pas
-- de raison opérationnelle de séparer — la supervision passera par le poller
-- backend qui interroge directement le statut des lignes.

CREATE OR REPLACE FUNCTION public.requeue_stuck_file_deletions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_requeued      INTEGER := 0;
  v_dead_lettered INTEGER := 0;
BEGIN
  -- Branche A : dead_letter pour les stuck épuisés.
  WITH stuck_exhausted AS (
    UPDATE public.file_deletions_outbox
    SET status     = 'dead_letter',
        locked_at  = NULL,
        locked_by  = NULL,
        last_error = 'stuck_deletion_exhausted_attempts'
    WHERE status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_at < NOW() - INTERVAL '10 minutes'
      AND attempts >= max_attempts
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_dead_lettered FROM stuck_exhausted;

  -- Branche B : requeue pour les stuck avec tentatives restantes.
  WITH requeued_rows AS (
    UPDATE public.file_deletions_outbox
    SET status    = 'pending',
        locked_at = NULL,
        locked_by = NULL,
        run_after = NOW()
    WHERE status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_at < NOW() - INTERVAL '10 minutes'
      AND attempts < max_attempts
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_requeued FROM requeued_rows;

  RETURN v_requeued + v_dead_lettered;
END;
$$;

COMMENT ON FUNCTION public.requeue_stuck_file_deletions() IS
  'Filet de sécurité pour ordres de suppression stuck en processing > 10 min. '
  'attempts >= max_attempts -> dead_letter (last_error constant, sans PII). '
  'Sinon -> pending avec run_after = NOW(). Retourne le total traité.';

REVOKE ALL     ON FUNCTION public.requeue_stuck_file_deletions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.requeue_stuck_file_deletions() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.requeue_stuck_file_deletions() TO service_role;


-- -----------------------------------------------------------------------------
-- 2. claim_file_deletions — RPC de prise concurrente
-- -----------------------------------------------------------------------------
-- Calquée sur claim_jobs (20260801000000). Traite en une seule requête :
--   - ordres 'pending' dont run_after <= NOW() (chemin normal)
--   - ordres 'processing' dont locked_at dépasse p_stale_after_seconds (zombies)
-- Dans les deux cas : attempts < max_attempts (protection dure).
--
-- Retour : SETOF public.file_deletions_outbox — ATTENTION AU PIÈGE.
--   PAS `RETURNS public.file_deletions_outbox` (sans SETOF) : ce type de
--   retour renvoie systématiquement une ligne, remplie de NULL en l'absence
--   de résultat, ce que supabase-js présente comme une ligne existante. C'est
--   le piège de §1 point 7 des décisions Session 4. `RETURNS SETOF` retourne
--   un tableau vide en absence de résultat — comportement attendu par le
--   worker (`.length === 0` = rien à faire).
--
-- Ordre de priorité :
--   1. pending avant zombies (chemin normal favorisé)
--   2. dans chaque groupe, clé temporelle pertinente (run_after / locked_at)
--
-- FOR UPDATE SKIP LOCKED : deux workers concurrents ne prennent jamais
-- le même ordre.
--
-- Incrément de attempts À LA PRISE : critique. Voir 20260801000000 §2 pour
-- la démonstration de bornage — mécanisme identique ici.
--
-- SECURITY DEFINER + search_path verrouillé (public, pg_temp) + REVOKE/GRANT
-- réservés à service_role : la table contient des références indirectes à
-- des appels (source_appel_id, source_cabinet_id) — traitement de données
-- sensibles au sens de l'art. 8 nLPD.

CREATE OR REPLACE FUNCTION public.claim_file_deletions(
  p_worker_id            TEXT,
  p_batch_size           INTEGER DEFAULT 5,
  p_stale_after_seconds  INTEGER DEFAULT 300
)
RETURNS SETOF public.file_deletions_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.file_deletions_outbox
    WHERE attempts < max_attempts
      AND (
        (status = 'pending' AND run_after <= NOW())
        OR
        (status = 'processing'
         AND locked_at IS NOT NULL
         AND locked_at < NOW() - make_interval(secs => p_stale_after_seconds))
      )
    ORDER BY
      (CASE WHEN status = 'pending' THEN 0 ELSE 1 END),
      (CASE WHEN status = 'pending' THEN run_after ELSE locked_at END)
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.file_deletions_outbox f
  SET status    = 'processing',
      locked_at = NOW(),
      locked_by = p_worker_id,
      attempts  = f.attempts + 1
  FROM candidates c
  WHERE f.id = c.id
  RETURNING f.*;
END;
$$;

COMMENT ON FUNCTION public.claim_file_deletions(TEXT, INTEGER, INTEGER) IS
  'Réserve jusqu''à p_batch_size ordres éligibles : pending mûrs ET zombies '
  '(processing verrouillés depuis > p_stale_after_seconds). Filtre '
  'attempts < max_attempts. Incrémente attempts à la prise. '
  'Ordre : pending d''abord, puis zombies. FOR UPDATE SKIP LOCKED.';

REVOKE ALL     ON FUNCTION public.claim_file_deletions(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_file_deletions(TEXT, INTEGER, INTEGER) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_file_deletions(TEXT, INTEGER, INTEGER) TO service_role;


-- -----------------------------------------------------------------------------
-- 3. NOTE POUR LE BACKEND (contrat d'utilisation de claim_file_deletions)
-- -----------------------------------------------------------------------------
-- 1. Signature d'appel supabase-js :
--
--      const { data, error } = await supabase.rpc('claim_file_deletions', {
--        p_worker_id: workerId,
--        p_batch_size: 5,
--        p_stale_after_seconds: 300,
--      });
--
--    `data` est un TABLEAU (SETOF) : vide s'il n'y a rien à traiter, sinon
--    contient les lignes verrouillées en 'processing' avec attempts
--    déjà incrémenté. Ne pas re-incrémenter attempts côté worker.
--
-- 2. Après suppression physique confirmée :
--
--      UPDATE public.file_deletions_outbox
--      SET status = 'deleted', deleted_at = NOW(),
--          locked_at = NULL, locked_by = NULL, last_error = NULL
--      WHERE id = $1;
--
--    Le CHECK `chk_deleted_at_consistency` (20260730130000) impose
--    `deleted_at IS NOT NULL` pour les statuts terminaux 'deleted' et
--    'not_found'.
--
-- 3. IDEMPOTENCE — fichier déjà absent côté cible (bucket ou API Retell) :
--    c'est un succès. Utiliser :
--
--      UPDATE public.file_deletions_outbox
--      SET status = 'not_found', deleted_at = NOW(),
--          locked_at = NULL, locked_by = NULL
--      WHERE id = $1;
--
--    Un DELETE Storage sur clé absente ne doit PAS repartir en retry — sinon
--    on épuise `max_attempts` sur une opération qui n'a rien à faire.
--
-- 4. En cas d'échec transitoire (5xx, timeout, rate limit), utiliser
--    l'équivalent applicatif de `fail_job` : repasser en 'pending' avec
--    run_after = NOW() + backoff, SANS ré-incrémenter attempts (l'incrément
--    a eu lieu à la prise). En cas d'échec permanent (403 sur bucket
--    supprimé côté Supabase, 404 attesté après retry), basculer en
--    'dead_letter' avec un `last_error` DÉJÀ REDACTÉ (aucun bucket-path
--    contenant PII — ce n'est pas le cas ici puisque `object_path` est
--    `{uuid}/{yyyy-mm}/{uuid}.pdf`, mais règle générale à respecter).
--
-- 5. Alerting dead_letter : la table n'a PAS de colonne
--    `dead_letter_alerted_at` (contrairement à `jobs`, cf. 20260801000000).
--    Le poller backend devra soit l'ajouter dans une migration ultérieure,
--    soit tenir un registre côté API. À arbitrer au moment du branchement
--    du consommateur — pas dans le scope de cette migration.


-- =============================================================================
-- Fin de migration.
-- =============================================================================
