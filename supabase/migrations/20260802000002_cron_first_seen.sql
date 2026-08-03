-- =============================================================================
-- Corya — Registre cron_first_seen (correctif faux positif `never_run`)
-- Date : 2026-08-02
-- Auteur : sub-agent database-compliance
--
-- Session 4 — vague 7, pièce C : fermeture de l'écart §6.4 (« never_run
-- traité comme un échec — faux positif sur tout cron neuf »).
--
-- CONTEXTE
--   `cron-check.ts` classe `last_run_at IS NULL` en `reason: 'never_run'`,
--   donc en échec. Tout cron nouvellement créé déclenche `cron_stale` jusqu'à
--   sa première exécution effective. Vécu le 1er août : les deux crons
--   hebdomadaires créés par les migrations 20260801000001 et 20260801000003
--   ont forcé la désactivation de `ALERT_ENABLED` pendant 24 h (§6.5).
--
--   La migration B de cette vague (20260802000001) ajoute un cron MENSUEL.
--   Sans le présent correctif, il déclencherait une fausse alerte pendant
--   ~1 mois entier — le pattern est structurel et ne va que s'aggraver à
--   chaque cron ajouté.
--
-- CONTRAINTE TECHNIQUE ÉTABLIE
--   pg_cron n'expose AUCUNE colonne de date de création dans `cron.job`.
--   Vérifié en interrogeant information_schema.columns. Il faut donc un
--   registre côté nous : on ne peut pas se contenter d'introspecter pg_cron.
--
-- DESIGN
--   1. Table `public.cron_first_seen` : PRIMARY KEY sur `jobname` (unique
--      dans `cron.job`), une colonne `first_seen_at TIMESTAMPTZ DEFAULT NOW()`.
--      RLS activée, aucune policy — deny by default, calqué sur
--      `file_deletions_outbox` et `worker_heartbeats`.
--
--   2. SEED OBLIGATOIRE dans cette migration : les 9 crons actifs au moment
--      du déploiement doivent être insérés avec `first_seen_at = NOW()`.
--      Sans ce seed, ils basculeraient tous en `pending_first_run` (statut
--      neutre côté backend, cf. §RÈGLE MÉTIER plus bas) au premier appel de
--      `get_cron_health()`, ce qui recréerait exactement le trou qu'on ferme
--      (aucune alerte pendant la période de leurs plus longs). L'INSERT se
--      fait depuis `cron.job` avec `ON CONFLICT DO NOTHING` pour rester
--      exact et rejouable : si la migration est rejouée sur une base où le
--      registre existe déjà, aucune ligne n'est écrasée.
--
--   3. Alimentation continue : toute nouvelle entrée de `cron.job` doit être
--      enregistrée automatiquement. Fait dans `get_cron_health()` (qui
--      devient plpgsql) : upsert `ON CONFLICT DO NOTHING` avant le SELECT.
--      Choix motivé :
--        - Pas de trigger sur `cron.job` : c'est un schéma d'extension, on
--          ne veut pas y toucher (fragilité aux upgrades pg_cron).
--        - Un cron dédié « sync cron_first_seen » ajouterait un 10e cron et
--          une latence de détection de sa période — juste pour un upsert
--          qui coûte quelques µs dans une fonction déjà appelée toutes les
--          5 min par le poller cron-check. L'upsert dans get_cron_health()
--          est le point de rencontre naturel.
--
--   4. Extension du retour de `get_cron_health()` :
--      - AJOUT de `first_seen_at TIMESTAMPTZ`
--      - Décision arbitrée : on N'EXPOSE PAS la période dérivée depuis
--        `j.schedule`. Justification en §DÉCISION PÉRIODE.
--      - Toutes les colonnes existantes sont conservées à l'identique
--        (`cron-check.ts` consomme `jobname`, `schedule`, `last_run_at`,
--        `last_success_at`, `last_status`, `seconds_since_last_run`,
--        `seconds_since_last_success`, `total_runs_last_24h`,
--        `failed_runs_last_24h`) — aucune régression.
--
-- DÉCISION PÉRIODE (arbitrage explicite, à retransmettre à l'agent backend)
--   Le brief propose deux options :
--     (a) dériver la période en secondes depuis `j.schedule` en SQL et
--         l'exposer dans le retour ;
--     (b) exposer `schedule` (déjà présent) et laisser le backend calculer
--         la correspondance depuis sa table de tolérances.
--
--   Je retiens (b). Motifs :
--     - Le parsing d'une expression cron pour en dériver la PÉRIODE (pas la
--       PROCHAINE OCCURRENCE) est fragile en SQL pur. Cas déjà présents dans
--       notre inventaire qui poseraient problème :
--         * `0 4 1 * *` — mensuel : la « période » est ~30,44 jours en
--           moyenne, mais la vraie durée avant première exécution après
--           `first_seen_at` dépend de la date d'aujourd'hui et du calendrier
--           (28 à 31 jours). Une valeur unique en secondes serait trompeuse.
--         * `17 4 15 * *` — mensuel décalé, même problème.
--         * `0 5 * * 0` — hebdomadaire dominical : jusqu'à 7 jours.
--         * `*/5 * * * *` — trivial (300 s), mais le fait qu'un cas soit
--           facile ne compense pas la fragilité des autres.
--       Une implémentation SQL correcte réutiliserait le parser de pg_cron
--       lui-même (fonctions internes non stables entre versions) ou
--       impliquerait une extension supplémentaire (pg_cron_ext / croniter
--       serveur — hors périmètre).
--     - Le backend a DÉJÀ une table de tolérances (`CRON_TOLERANCES_SECONDS`
--       mentionnée dans les décisions Session 4, §5.2), maintenue à la main,
--       alignée avec les schedules réels. Y ajouter une entrée « période
--       maximale attendue avant première exécution » par cron connu est
--       une ligne de code par cron, testable, versionnée dans git.
--     - Un cron nouvellement ajouté et inconnu de la table backend produira
--       simplement une alerte au bout de la tolérance par défaut, exactement
--       comme aujourd'hui — pas de régression sur le comportement inconnu.
--
--   Contrat effectif exposé au backend :
--     - `schedule TEXT` — inchangé, valeur cron brute (ex : '17 4 15 * *').
--     - `first_seen_at TIMESTAMPTZ` — NOUVEAU, non NULL (défaut NOW()).
--   Le backend fait :
--     if last_run_at IS NULL:
--         period = TOLERANCES[jobname].max_period_before_first_run_seconds
--         if NOW() - first_seen_at < period:
--             status = 'pending_first_run'  # neutre, pas d'alerte
--         else:
--             status = 'never_run'          # échec réel
--
-- RÈGLE MÉTIER (arbitrage fondateur — retransmise pour implémentation TS)
--   La borne temporelle est la PÉRIODE du cron, PAS sa tolérance. Rationale :
--   un cron mensuel mort-né avec `first_seen_at + tolérance` (7-8 jours)
--   serait invisible 32 jours — inacceptable pour un cron de purge nLPD.
--   La borne « période » garantit qu'après ce délai, l'absence d'exécution
--   redevient une vraie panne détectable.
--
-- NON-RÉGRESSION
--   - `get_cron_health()` change de langage (sql -> plpgsql) et de signature
--     de retour (colonne ajoutée). CREATE OR REPLACE ne peut pas modifier le
--     type de retour d'une fonction : DROP FUNCTION IF EXISTS est requis.
--     Le cron n'appelle pas cette fonction ; seul le backend le fait. Le
--     backend consomme un tableau de lignes JSON, l'ajout d'une colonne au
--     retour est rétro-compatible côté supabase-js.
--   - RLS deny-by-default sur la nouvelle table : elle n'est jamais exposée
--     au frontend, seul le service_role la lit via `get_cron_health()`.
--   - Rejouabilité : la table est en CREATE TABLE IF NOT EXISTS, le seed
--     en INSERT ... ON CONFLICT DO NOTHING, le DROP FUNCTION est IF EXISTS,
--     et le CREATE FUNCTION recrée l'objet à l'identique + colonne ajoutée.
--
-- CONFORMITÉ
--   - Aucune PII dans `cron_first_seen` : uniquement des noms de crons
--     techniques.
--   - Aucun impact sur les données patient ni sur les rétentions existantes.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Table cron_first_seen
-- -----------------------------------------------------------------------------
-- PRIMARY KEY sur jobname : cron.job.jobname est unique par contrainte
-- interne pg_cron. TIMESTAMPTZ obligatoire pour comparer à NOW() dans le
-- backend (fuseau explicite, pas de conversion locale ambiguë).

CREATE TABLE IF NOT EXISTS public.cron_first_seen (
  jobname       TEXT        PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.cron_first_seen IS
  'Date de première observation de chaque cron pg_cron (pg_cron ne conserve '
  'pas cette info nativement). Utilisé par get_cron_health() pour permettre '
  'au backend de distinguer un cron « pas encore exécuté par immaturité » '
  '(pending_first_run) d''un cron « pas exécuté alors qu''il aurait dû » '
  '(never_run réel, alertable).';

COMMENT ON COLUMN public.cron_first_seen.first_seen_at IS
  'Horodatage de la première fois où get_cron_health() a vu ce cron. '
  'Seed initial : NOW() au moment de la migration 20260802000002 pour les '
  '10 crons alors actifs. Nouveaux crons : upsert à chaque appel de '
  'get_cron_health() (ON CONFLICT DO NOTHING).';


-- -----------------------------------------------------------------------------
-- 2. RLS deny-by-default
-- -----------------------------------------------------------------------------
ALTER TABLE public.cron_first_seen ENABLE ROW LEVEL SECURITY;
-- => volontairement AUCUNE CREATE POLICY, calqué sur file_deletions_outbox
--    et worker_heartbeats. Seul le service_role (bypass RLS natif) y accède.


-- -----------------------------------------------------------------------------
-- 3. SEED des crons actifs au moment de la migration
-- -----------------------------------------------------------------------------
-- Objectif : garantir que TOUS les crons présents au déploiement (les 10
-- actifs après application des migrations 20260802000000 et 20260802000001,
-- soit les 8 existants + les purges terminale outbox et logs_actions) reçoivent un
-- `first_seen_at = NOW()` immédiat. Sans ce seed, ils passeraient tous en
-- `pending_first_run` au premier appel de get_cron_health() et l'alerting
-- sur `never_run` réel serait suspendu pour la durée maximale de leur
-- période — jusqu'à ~30 jours pour purge-ancient-appels et purge-ancient-
-- logs-actions. On recréerait exactement le trou qu'on ferme.
--
-- INSERT depuis cron.job : la liste est puisée à la source (aucun risque de
-- décalage avec un inventaire codé en dur qui pourrait devenir faux).
-- WHERE j.active = true : cohérent avec le filtre de get_cron_health().
-- ON CONFLICT DO NOTHING : rejouabilité totale — si la migration est
-- rejouée sur une base où le registre existe déjà, aucune date n'est
-- écrasée (ce serait un bug : le premier `first_seen_at` est LA vérité,
-- pas la date de rejeu de la migration).

INSERT INTO public.cron_first_seen (jobname, first_seen_at)
SELECT j.jobname, NOW()
FROM cron.job j
WHERE j.active = true
ON CONFLICT (jobname) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 4. get_cron_health() — extension pour first_seen_at + auto-registration
-- -----------------------------------------------------------------------------
-- DROP obligatoire : la signature de retour change (colonne ajoutée), et
-- CREATE OR REPLACE ne peut pas modifier le type de retour d'une fonction.
-- Le cron n'appelle jamais cette fonction, seul le backend le fait via RPC :
-- pas de risque de rupture pendant le laps de recréation.

DROP FUNCTION IF EXISTS public.get_cron_health();

-- Version plpgsql (au lieu de sql) : nécessaire pour effectuer l'upsert
-- avant le SELECT. Le pattern reste minimal : un INSERT idempotent puis un
-- RETURN QUERY.

CREATE FUNCTION public.get_cron_health()
RETURNS TABLE (
  jobname                        TEXT,
  schedule                       TEXT,
  last_run_at                    TIMESTAMPTZ,
  last_success_at                TIMESTAMPTZ,
  last_status                    TEXT,
  seconds_since_last_run         NUMERIC,
  seconds_since_last_success     NUMERIC,
  total_runs_last_24h            BIGINT,
  failed_runs_last_24h           BIGINT,
  first_seen_at                  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
-- search_path minimal : pg_catalog pour les opérateurs/types système,
-- pg_temp obligatoire côté hygiène SECURITY DEFINER. Toutes les tables
-- non-système sont schéma-qualifiées ci-dessous (cron.job, cron.job_run_details,
-- public.cron_first_seen).
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- 4.1 Auto-registration : tout cron actif inconnu du registre est
  -- enregistré avec first_seen_at = NOW(). ON CONFLICT DO NOTHING pour
  -- ne jamais écraser la date d'origine.
  --
  -- Effet de bord assumé : ce SELECT écrit dans la base à chaque appel.
  -- Coût quasi nul (aucune ligne insérée en régime stationnaire — seuls les
  -- nouveaux crons génèrent une ligne). Alternative rejetée : trigger sur
  -- cron.job (voir COMMENT en tête de migration).
  INSERT INTO public.cron_first_seen (jobname, first_seen_at)
  SELECT j.jobname, NOW()
  FROM cron.job j
  WHERE j.active = true
  ON CONFLICT (jobname) DO NOTHING;

  -- 4.2 Renvoi de l'état de santé. Identique à la version 20260801000003
  -- avec en plus la LEFT JOIN sur public.cron_first_seen. LEFT JOIN plutôt
  -- que INNER : si un cron actif a été inséré par l'upsert ci-dessus mais
  -- que la ligne n'est pas encore visible dans cette même transaction (ne
  -- devrait pas arriver, PG lit ses propres écritures dans la même
  -- transaction — mais LEFT JOIN est défensif et coûte 0).
  RETURN QUERY
  SELECT
    j.jobname::TEXT,
    j.schedule::TEXT,
    MAX(d.end_time)                                            AS last_run_at,
    MAX(d.end_time) FILTER (WHERE d.status = 'succeeded')      AS last_success_at,
    (ARRAY_AGG(d.status ORDER BY d.start_time DESC NULLS LAST))[1]::TEXT
                                                               AS last_status,
    EXTRACT(EPOCH FROM (NOW() - MAX(d.end_time)))              AS seconds_since_last_run,
    EXTRACT(EPOCH FROM (NOW() - MAX(d.end_time)
                        FILTER (WHERE d.status = 'succeeded'))) AS seconds_since_last_success,
    COUNT(*) FILTER (WHERE d.start_time > NOW() - INTERVAL '24 hours')
                                                               AS total_runs_last_24h,
    COUNT(*) FILTER (WHERE d.start_time > NOW() - INTERVAL '24 hours'
                       AND d.status <> 'succeeded')            AS failed_runs_last_24h,
    fs.first_seen_at                                            AS first_seen_at
  FROM cron.job j
  LEFT JOIN cron.job_run_details d
    ON d.jobid = j.jobid
   AND d.database = current_database()
  LEFT JOIN public.cron_first_seen fs
    ON fs.jobname = j.jobname
  WHERE j.active = true
  GROUP BY j.jobname, j.schedule, fs.first_seen_at;
END;
$$;

COMMENT ON FUNCTION public.get_cron_health() IS
  'Santé des crons pg_cron actifs de la base courante. Distingue "jamais '
  'tourné par immaturité" (last_run_at NULL + first_seen_at récent) de '
  '"jamais tourné alors qu''il aurait dû" (last_run_at NULL + first_seen_at '
  'plus ancien que la période du cron) — bascule à évaluer côté backend. '
  'Enregistre automatiquement les nouveaux crons dans cron_first_seen. '
  'SECURITY DEFINER — appelé par le poller backend via service_role.';

REVOKE ALL     ON FUNCTION public.get_cron_health() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_cron_health() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_cron_health() TO service_role;


-- =============================================================================
-- Fin de migration.
-- =============================================================================
