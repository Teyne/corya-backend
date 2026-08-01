-- =============================================================================
-- Corya — RPC fail_job_permanent : bascule terminale immédiate d'un job
-- Date : 2026-08-01
-- Auteur : sub-agent database-compliance
--
-- CONTEXTE
--   Session 4 (backend-webhook) : le worker classe désormais les erreurs SMTP
--   entre TRANSITOIRES (timeout, 4xx temporaire, réseau) et PERMANENTES
--   (SMTP 550/551/553/554 : boîte inconnue, rejet définitif). Sur une erreur
--   permanente, brûler les 5 retries sur une adresse invalide est du gaspillage
--   et retarde d'autant l'alerte dead_letter. Il faut basculer terminalement,
--   maintenant, sans consommer le budget de tentatives.
--
--   Or `fail_job(p_job_id, p_error, p_backoff_seconds)` (migration
--   20260731100000, §3.3) ne passe en `dead_letter` que si
--   `attempts >= max_attempts`. Sinon, il re-planifie en `pending`.
--
--   Le backend contourne aujourd'hui via un UPDATE direct sur public.jobs
--   (`forceDeadLetter` dans apps/backend/src/db/queries.ts). Ça marche, mais
--   ça sort la transition d'état du SQL alors que tout le reste y est
--   centralisé (claim_jobs / complete_job / fail_job / requeue_stuck_jobs).
--   Cette RPC recentralise, et OUVRE LA VOIE au retrait futur du droit
--   UPDATE sur public.jobs pour service_role (cf. section "portée" en fin de
--   fichier) — réduction de surface d'écriture directe sur une table qui
--   porte des données de santé.
--
-- CONFORMITÉ
--   - art. 6 nLPD (minimisation) : `last_error` est TRONQUÉ à 500 caractères.
--   - art. 8 nLPD (données sensibles santé) : contrat d'appel — `p_error` DOIT
--     arriver déjà rédacté côté backend. Ne JAMAIS y passer une chaîne
--     d'origine externe brute (message Postgres, Nodemailer, Puppeteer,
--     Supabase Storage) : ces messages peuvent embarquer un nom, un
--     téléphone, un fragment d'URL signée, un chemin d'objet contenant un
--     UUID d'appel. La troncature à 500 chars ci-dessous est une DÉFENSE EN
--     PROFONDEUR, pas une garantie.
--   - art. 321 CP (secret médical) : idem.
--
-- IDEMPOTENCE
--   CREATE OR REPLACE + REVOKE/GRANT idempotents. La migration est rejouable
--   sans effet de bord.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- fail_job_permanent
-- -----------------------------------------------------------------------------
-- Corps IDENTIQUE à la branche `dead_letter` de fail_job (§3.3 migration
-- 20260731100000) — statut, libération des colonnes de verrou, écriture de
-- `last_error` tronqué à 500 chars — À UNE DIFFÉRENCE PRÈS, VOLONTAIRE :
--
--   >>> On IGNORE délibérément la colonne `attempts`. <<<
--
-- C'est tout l'intérêt de cette RPC. Sur une erreur permanente (SMTP 5xx
-- déterministe), consommer max_attempts pour rien est un gaspillage
-- opérationnel (retards, spam du relais, alerte dead_letter décalée). On
-- bascule maintenant, quel que soit `attempts`. Ce n'est PAS un oubli : ne
-- pas ré-ajouter de branche `IF attempts < max_attempts` par confusion avec
-- fail_job.
--
-- GARDE `WHERE status = 'processing'` :
--   - Un job qui n'est plus en `processing` a déjà été traité par un autre
--     chemin (complete_job dans une race, fail_job qui a épuisé les
--     tentatives, requeue_stuck_jobs suivi d'un nouveau claim, action admin
--     manuelle). Le résurrecter en `dead_letter` corromprait la timeline
--     d'états. Cette garde rend la RPC no-op silencieuse dans ces cas —
--     comportement défensif volontaire, alignement conscient avec le
--     `forceDeadLetter` actuel (qui pose la même garde côté backend).
--   - En pratique, l'appelant naturel est le worker qui vient de traiter un
--     job dont il détient le verrou : `status = 'processing'` est
--     l'invariant attendu au moment de l'appel.
--   - À noter : fail_job, lui, ne pose PAS cette garde (il agit sur toute
--     ligne existante). C'est une divergence assumée : fail_job est appelé
--     après une décision de retry avec compteur, où l'invariant a déjà été
--     validé par le fait que la ligne a été retournée par claim_jobs.
--     fail_job_permanent est un raccourci d'urgence ; on préfère un
--     silencieux à un écrasement.

CREATE OR REPLACE FUNCTION public.fail_job_permanent(
  p_job_id UUID,
  p_error  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_truncated_error TEXT;
BEGIN
  -- Défense en profondeur : le contrat d'appel exige déjà une chaîne
  -- rédactée côté backend. Voir en-tête du fichier.
  v_truncated_error := LEFT(COALESCE(p_error, ''), 500);

  UPDATE public.jobs
  SET status     = 'dead_letter',
      locked_at  = NULL,
      locked_by  = NULL,
      last_error = v_truncated_error
  WHERE id = p_job_id
    AND status = 'processing';
  -- Aucun RAISE si 0 ligne : la RPC est délibérément silencieuse en cas de
  -- transition concurrente (voir en-tête, section GARDE).
END;
$$;

COMMENT ON FUNCTION public.fail_job_permanent(UUID, TEXT) IS
  'Bascule un job de processing vers dead_letter, SANS regarder attempts. '
  'Usage : erreurs permanentes déterministes (SMTP 550/551/553/554, etc.) '
  'où consommer max_attempts est du gaspillage. Silencieuse si le job n''est '
  'plus en processing (transition concurrente). p_error doit arriver déjà '
  'rédacté côté backend ; tronqué à 500 chars en défense en profondeur.';


-- -----------------------------------------------------------------------------
-- Verrouillage des permissions
-- -----------------------------------------------------------------------------
-- Manipule potentiellement des lignes jobs qui référencent des appels via
-- appel_id : données sensibles santé. Seul service_role peut invoquer.
-- Aligné strictement sur le pattern de fail_job / complete_job / claim_jobs
-- (§3.5 migration 20260731100000).

REVOKE EXECUTE ON FUNCTION public.fail_job_permanent(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fail_job_permanent(UUID, TEXT) FROM anon, authenticated;

GRANT  EXECUTE ON FUNCTION public.fail_job_permanent(UUID, TEXT) TO service_role;


-- =============================================================================
-- PORTÉE : ce que cette migration N'INCLUT PAS (à traiter dans un autre lot)
--
--   Retrait du GRANT UPDATE ON public.jobs à service_role.
--
--   Non fait ici : d'autres chemins d'écriture directe subsistent côté
--   backend (`updateJobPayload` : checkpointing du pipeline post-appel ;
--   `markDeadLetterAlerted` : horodatage d'alerte dead_letter). Tant que ces
--   deux là ne sont pas convertis en RPC dédiées, révoquer UPDATE casserait
--   le worker et le poller d'alertes. Décision qui mérite son propre lot,
--   avec conversion couplée. Cette migration prépare seulement le terrain
--   côté forceDeadLetter.
-- =============================================================================
