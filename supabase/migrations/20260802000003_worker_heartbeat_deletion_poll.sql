-- =============================================================================
-- Corya — Heartbeat de la boucle de polling « outbox » (consommateur
--          file_deletions_outbox) dans le worker
-- Date : 2026-08-02
-- Auteur : sub-agent database-compliance
--
-- Session 4 — vague 7, pièce D : troisième champ de heartbeat pour couvrir
-- la nouvelle boucle du worker (consommation de file_deletions_outbox).
--
-- CONTEXTE
--   Le consommateur d'outbox introduit en vague 7 tournera dans le MÊME
--   process Node que le worker de jobs, dans une BOUCLE SÉPARÉE (période
--   ~10 s, contre 2 s pour la boucle jobs). Il appelle la nouvelle RPC
--   `claim_file_deletions` (migration 20260802000000) puis effectue les
--   suppressions physiques (Supabase Storage + API Retell).
--
--   Objection soulevée par le fondateur, validée : `worker_heartbeat_poll`
--   n'est appelée QUE par la boucle jobs. Rien ne bat au rythme de la
--   boucle outbox. Une boucle outbox morte pendant que la boucle jobs
--   continue de battre :
--     - laisse `last_poll_at` frais (la boucle jobs le met à jour)
--     - laisse `last_seen_at` frais (l'alive-tick indépendant continue)
--     - MAIS aucun ordre de suppression n'est traité, les PDF s'accumulent
--       dans le bucket avec PII, les audio Retell ne sont pas purgés.
--
--   C'est exactement le trou d'observabilité que le heartbeat à deux champs
--   (§2.2 des décisions Session 4) était censé fermer pour la boucle jobs :
--   « un seul champ donnerait un angle mort sur worker bloqué dans un job
--   qui pend ». Le même raisonnement s'applique boucle par boucle, pas
--   process par process.
--
-- DESIGN
--   1. Colonne `last_deletion_poll_at TIMESTAMPTZ` (nullable) sur
--      `public.worker_heartbeats`, ajoutée en ADD COLUMN IF NOT EXISTS.
--   2. Compteur `deletions_processed_total BIGINT NOT NULL DEFAULT 0`,
--      même sémantique que `jobs_processed_total`.
--   3. RPC `worker_heartbeat_deletion_poll(p_worker_id, p_delta)` calquée
--      sur `worker_heartbeat_poll` : met à jour `last_deletion_poll_at` ET
--      `last_seen_at` (si la boucle avance, le process est vivant — même
--      raisonnement que l'existant), incrémente le compteur via GREATEST
--      pour la défense en profondeur contre les deltas négatifs.
--   4. La RPC ne touche PAS `last_poll_at` : le découplage des trois tempos
--      est délibéré, exactement comme le découplage historique entre
--      `last_seen_at` et `last_poll_at` (§2.2 Session 4).
--
-- TABLE EN USAGE RÉEL — traitement du NULL
--   La table `worker_heartbeats` contient déjà des lignes (vérifié via le
--   déploiement du 1er août : `worker_id: dev-worker-local` a battu tout
--   au long de la validation locale). Toute nouvelle colonne DOIT donc :
--     - être NULLABLE et sans DEFAULT contraignant, ou
--     - avoir un DEFAULT compatible avec le NOT NULL (pour le compteur).
--
--   `last_deletion_poll_at` est NULLABLE sans DEFAULT : sur une ligne
--   existante, la valeur reste NULL tant que ce worker n'a pas encore
--   appelé worker_heartbeat_deletion_poll une première fois. Le backend
--   DOIT interpréter ce NULL comme « la boucle outbox n'a jamais démarré
--   pour ce worker », PAS comme « la boucle outbox est morte ». Sinon,
--   tous les workers déployés AVANT le branchement du consommateur d'outbox
--   (fenêtre entre l'application de cette migration et le déploiement du
--   code TypeScript qui appelle la RPC) déclencheraient une fausse alerte.
--
--   Règle pratique côté supervision (à implémenter en TypeScript, hors
--   scope de cette migration) :
--     if last_deletion_poll_at IS NULL:
--         status = 'deletion_loop_not_started'   # neutre, pas d'alerte
--     elif NOW() - last_deletion_poll_at > SEUIL:
--         status = 'deletion_loop_stalled'       # ALERTE
--     else:
--         status = 'ok'
--
--   `deletions_processed_total` a un DEFAULT 0 (NOT NULL) : les lignes
--   existantes reçoivent 0, ce qui est la valeur juste (aucune suppression
--   n'a été traitée par ce worker jusqu'ici).
--
-- COMPATIBILITÉ purge_stale_worker_heartbeats
--   Vérifié en lisant 20260801000001 §4 : `purge_stale_worker_heartbeats`
--   filtre sur `last_seen_at`. Comme `worker_heartbeat_deletion_poll` met
--   à jour `last_seen_at` (au même titre que `worker_heartbeat_poll`), un
--   worker qui ne ferait tourner QUE la boucle outbox (cas théorique, pas
--   prévu à ce stade) serait tout de même préservé de la purge tant qu'il
--   bat. Rien à modifier dans la purge existante.
--
-- SIGNATURE EXACTE (à retransmettre à l'agent backend)
--
--   RPC : worker_heartbeat_deletion_poll(p_worker_id TEXT, p_deletions_processed_delta BIGINT DEFAULT 0) RETURNS VOID
--
--   Appel supabase-js :
--     await supabase.rpc('worker_heartbeat_deletion_poll', {
--       p_worker_id: workerId,
--       p_deletions_processed_delta: n, // 0 si batch vide
--     });
--
--   Effets :
--     - Upsert par worker_id (identique aux deux autres RPC heartbeat).
--     - Écrit last_seen_at = NOW() et last_deletion_poll_at = NOW().
--     - Incrémente deletions_processed_total de GREATEST(0, delta).
--     - Ne touche jamais last_poll_at ni jobs_processed_total.
--
--   Sémantique du NULL sur last_deletion_poll_at :
--     - NULL = « la boucle outbox n'a jamais démarré pour ce worker »
--             (état légitime, ne pas alerter).
--     - Valeur non NULL trop ancienne = boucle outbox bloquée -> ALERTE.
--
-- CONFORMITÉ
--   Aucune PII. Uniquement des identifiants techniques (worker_id) et un
--   compteur. RLS deny-by-default héritée de la table (aucune policy
--   ajoutée par cette migration, cohérent avec 20260801000001).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Extension de public.worker_heartbeats
-- -----------------------------------------------------------------------------
-- ADD COLUMN IF NOT EXISTS : rejouable. Sur base existante, la migration
-- ajoute la colonne à toutes les lignes déjà présentes avec la valeur par
-- défaut (NULL pour last_deletion_poll_at, 0 pour deletions_processed_total).
-- Ni PII, ni recomputation coûteuse : instantané même sur historique.

ALTER TABLE public.worker_heartbeats
  ADD COLUMN IF NOT EXISTS last_deletion_poll_at TIMESTAMPTZ;

ALTER TABLE public.worker_heartbeats
  ADD COLUMN IF NOT EXISTS deletions_processed_total BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.worker_heartbeats.last_deletion_poll_at IS
  'Dernier tick de la boucle de polling de l''outbox de suppression '
  '(file_deletions_outbox). Nullable : NULL = boucle jamais démarrée pour ce '
  'worker (état légitime avant branchement du consommateur), à NE PAS traiter '
  'comme une boucle morte. Découplé de last_poll_at (boucle jobs).';

COMMENT ON COLUMN public.worker_heartbeats.deletions_processed_total IS
  'Compteur monotone croissant des ordres de suppression traités par ce '
  'worker_id (succès + échecs, agrégé sur PDF Storage et audio Retell). '
  'Incrémenté via worker_heartbeat_deletion_poll(p_deletions_processed_delta). '
  'GREATEST(0, delta) : défense en profondeur contre les deltas négatifs.';


-- -----------------------------------------------------------------------------
-- 2. RPC worker_heartbeat_deletion_poll
-- -----------------------------------------------------------------------------
-- Copie exacte du pattern de worker_heartbeat_poll (20260801000001 §3.2)
-- avec substitution :
--   last_poll_at         -> last_deletion_poll_at
--   jobs_processed_total -> deletions_processed_total
-- last_seen_at reste mis à jour ici aussi : si la boucle outbox avance, le
-- process est vivant. Ne PAS toucher last_poll_at (ce serait masquer la
-- mort de la boucle jobs).
--
-- INSERT INTO ... VALUES avec valeur explicite NOW() pour last_seen_at ET
-- last_deletion_poll_at : contrairement au DEFAULT NOW() de last_seen_at
-- côté définition de table, ici on veut être explicite dans la RPC pour
-- que le comportement soit lisible ligne à ligne.

CREATE OR REPLACE FUNCTION public.worker_heartbeat_deletion_poll(
  p_worker_id                  TEXT,
  p_deletions_processed_delta  BIGINT DEFAULT 0
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.worker_heartbeats (
    worker_id,
    last_seen_at,
    last_deletion_poll_at,
    deletions_processed_total
  )
  VALUES (
    p_worker_id,
    NOW(),
    NOW(),
    GREATEST(0::BIGINT, p_deletions_processed_delta)
  )
  ON CONFLICT (worker_id) DO UPDATE
    SET last_seen_at              = EXCLUDED.last_seen_at,
        last_deletion_poll_at     = EXCLUDED.last_deletion_poll_at,
        deletions_processed_total = public.worker_heartbeats.deletions_processed_total
                                  + GREATEST(0::BIGINT, EXCLUDED.deletions_processed_total);
$$;

COMMENT ON FUNCTION public.worker_heartbeat_deletion_poll(TEXT, BIGINT) IS
  'Poll-tick de la boucle outbox : met à jour last_deletion_poll_at + '
  'last_seen_at, incrémente deletions_processed_total du delta passé. '
  'Appelé à chaque tick de la boucle de consommation de file_deletions_outbox '
  '(période ~10 s). Ne touche pas last_poll_at (boucle jobs distincte).';


-- -----------------------------------------------------------------------------
-- 3. Verrouillage des permissions
-- -----------------------------------------------------------------------------
-- Même politique que les deux autres RPC heartbeat.

REVOKE EXECUTE ON FUNCTION public.worker_heartbeat_deletion_poll(TEXT, BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.worker_heartbeat_deletion_poll(TEXT, BIGINT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.worker_heartbeat_deletion_poll(TEXT, BIGINT) TO service_role;


-- -----------------------------------------------------------------------------
-- 4. Vérification purge_stale_worker_heartbeats (aucune modification)
-- -----------------------------------------------------------------------------
-- Confirmation explicite : `purge_stale_worker_heartbeats` (20260801000001
-- §4) filtre uniquement sur `last_seen_at`. Comme la nouvelle RPC met à
-- jour `last_seen_at`, la purge continue de fonctionner correctement pour
-- tous les workers (qu'ils battent via la boucle jobs, la boucle outbox,
-- ou l'alive-tick indépendant). Aucun changement requis.


-- =============================================================================
-- Fin de migration.
-- =============================================================================
