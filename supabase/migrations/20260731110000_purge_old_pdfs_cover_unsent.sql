-- =============================================================================
-- Corya — Correctif purge_old_pdfs : couvrir le cas « email jamais parti »
-- Date : 2026-07-31
-- Auteur : sub-agent database-compliance
--
-- POURQUOI ce correctif :
--   La version de purge_old_pdfs livrée dans 20260731100000_job_claim_and_pdf_purge.sql
--   ne ciblait QUE les appels dont l'email récap avait été envoyé avec succès :
--     WHERE pdf_envoye_at IS NOT NULL AND pdf_envoye_at < now() - 30d
--
--   Or pdf_envoye_at n'est renseigné que par markAppelEmailSent, qui n'est
--   appelé qu'APRÈS un sendRecapEmail réussi (voir apps/backend/src/services/
--   appel-processor.ts). Si le job process_appel épuise ses max_attempts sur
--   l'étape email (SMTP Infomaniak down prolongé, adresse cabinet en erreur
--   permanente, etc.), il passe en 'dead_letter' avec :
--     - pdf_url renseigné (le PDF a bien été uploadé, setAppelPdfPath a tourné)
--     - pdf_envoye_at NULL (l'email n'est jamais parti)
--
--   Conséquence :
--     - purge_old_pdfs ignorait ces lignes de façon permanente.
--     - Le PDF (contenant patient_nom, patient_telephone, transcript verbatim)
--       survivait dans le bucket pdf-recaps jusqu'au filet de sécurité de
--       purge_ancient_appels — soit jusqu'à 24 mois plus tard.
--     - Pendant ce temps la ligne appels correspondante était anonymisée à
--       J+7 par anonymize_old_transcripts : le PDF perpétuait dans un binaire
--       exactement ce que la purge J+7 efface en base.
--
--   Violation caractérisée de l'art. 6 nLPD (limitation de la conservation)
--   et incohérence avec la doctrine J+7 sur les transcripts.
--
-- GARANTIE APPORTÉE PAR CE CORRECTIF :
--   Aucun PDF ne survit plus de 30 jours après la création de l'appel, quel
--   que soit le sort de l'email. Deux branches d'ancrage :
--     Cas nominal  : pdf_envoye_at OK    -> purge à pdf_envoye_at + 30 jours
--     Cas dégradé  : pdf_envoye_at NULL  -> purge à created_at    + 30 jours
--
-- Le pattern reste identique : alimenter file_deletions_outbox (le worker
-- backend consomme et supprime physiquement), puis NULLifier appels.pdf_url.
--
-- Nouveau motif d'audit distinct : 'pdf_purged_30d_unsent'. On aurait pu
-- réutiliser 'pdf_purged_30d' pour les deux cas, mais distinguer sert un
-- objectif opérationnel : une hausse anormale du volume 'pdf_purged_30d_unsent'
-- sur file_deletions_outbox = signal d'un problème SMTP ou d'une famille de
-- cabinets injoignables. Détection précoce sans instrumenter le backend.
--
-- Pas de nouveau cron : purge-old-pdfs (03:30 UTC quotidien, planifié dans
-- 20260731100000) continue d'appeler cette même fonction.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Extension du CHECK sur file_deletions_outbox.reason
-- -----------------------------------------------------------------------------
-- Ajout de 'pdf_purged_30d_unsent'. Les cinq valeurs précédentes sont
-- conservées telles quelles (des lignes historiques les portent déjà).

ALTER TABLE public.file_deletions_outbox
  DROP CONSTRAINT IF EXISTS file_deletions_outbox_reason_check;

ALTER TABLE public.file_deletions_outbox
  ADD CONSTRAINT file_deletions_outbox_reason_check
  CHECK (reason IN (
    'audio_expired_48h',
    'appel_purged_24m',
    'gdpr_erasure_request',
    'manual_admin_deletion',
    'pdf_purged_30d',           -- envoi email OK, purge à pdf_envoye_at + 30j
    'pdf_purged_30d_unsent'     -- email jamais parti, purge à created_at + 30j
  ));


-- -----------------------------------------------------------------------------
-- 2. Réécriture de purge_old_pdfs avec prédicat composite
-- -----------------------------------------------------------------------------
-- Deux INSERT distincts pour préserver la distinction du motif d'audit.
-- L'UPDATE final NULLifie pdf_url pour les deux branches en un seul passage :
-- il utilise le même prédicat composite, ce qui garantit qu'on ne dé-référence
-- rien qu'on n'ait pas d'abord enfilé pour suppression physique.
--
-- ON CONFLICT DO NOTHING sur chaque INSERT : idempotent via l'index unique
-- partiel (bucket, object_path) WHERE status IN ('pending', 'processing').
-- Si deux exécutions successives voient la même ligne (pdf_url identique),
-- la seconde INSERT est un no-op silencieux.
--
-- GET DIAGNOSTICS lit ROW_COUNT du dernier statement (l'UPDATE) : le retour
-- reflète le nombre d'appels effectivement dé-référencés, cohérent avec le
-- contrat original de la fonction.

CREATE OR REPLACE FUNCTION public.purge_old_pdfs()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  -- Branche 1 : cas nominal — email envoyé avec succès il y a > 30 jours.
  -- Ancrage sur pdf_envoye_at (horodatage de l'envoi email OK, posé par
  -- markAppelEmailSent dans le backend).
  INSERT INTO public.file_deletions_outbox (
    target, bucket, object_path, reason,
    enqueued_by, source_appel_id, source_cabinet_id
  )
  SELECT
    'supabase_storage',
    'pdf-recaps',
    a.pdf_url,
    'pdf_purged_30d',
    'purge_old_pdfs',
    a.id,
    a.cabinet_id
  FROM public.appels a
  WHERE a.pdf_url IS NOT NULL
    AND a.pdf_envoye_at IS NOT NULL
    AND a.pdf_envoye_at < NOW() - INTERVAL '30 days'
  ON CONFLICT DO NOTHING;

  -- Branche 2 : cas dégradé — email jamais parti (job process_appel en
  -- dead_letter, pipeline bloqué avant l'étape email, etc.) mais PDF déjà
  -- uploadé. Ancrage sur appels.created_at pour garantir une borne dure :
  -- après 30 jours de création, le PDF disparaît quoi qu'il arrive.
  --
  -- Motif d'audit distinct pour permettre de détecter un problème SMTP en
  -- comptant les lignes de ce motif sur file_deletions_outbox.
  INSERT INTO public.file_deletions_outbox (
    target, bucket, object_path, reason,
    enqueued_by, source_appel_id, source_cabinet_id
  )
  SELECT
    'supabase_storage',
    'pdf-recaps',
    a.pdf_url,
    'pdf_purged_30d_unsent',
    'purge_old_pdfs',
    a.id,
    a.cabinet_id
  FROM public.appels a
  WHERE a.pdf_url IS NOT NULL
    AND a.pdf_envoye_at IS NULL
    AND a.created_at < NOW() - INTERVAL '30 days'
  ON CONFLICT DO NOTHING;

  -- NULLification de pdf_url pour les deux branches en un seul UPDATE.
  -- Même prédicat composite que la somme des deux INSERT ci-dessus.
  UPDATE public.appels
  SET pdf_url = NULL
  WHERE pdf_url IS NOT NULL
    AND (
      (pdf_envoye_at IS NOT NULL AND pdf_envoye_at < NOW() - INTERVAL '30 days')
      OR
      (pdf_envoye_at IS NULL     AND created_at   < NOW() - INTERVAL '30 days')
    );

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

COMMENT ON FUNCTION public.purge_old_pdfs() IS
  'Purge les PDF récap au-delà de 30 jours. Ancrage sur pdf_envoye_at si '
  'email OK, sinon sur created_at (garantie borne dure : aucun PDF ne '
  'survit plus de 30 jours après création de l''appel). Alimente '
  'file_deletions_outbox pour la suppression physique par le worker. '
  'Base légale : art. 6 nLPD (minimisation).';


-- =============================================================================
-- Fin de migration.
-- =============================================================================
