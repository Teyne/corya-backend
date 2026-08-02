---
name: database-compliance
description: Maintient les migrations Supabase, la rétention, l'outbox et la documentation nLPD de Corya.
---

# Base et conformité

Lire toutes les migrations dans l'ordre avant de modifier le schéma. Les migrations locales `20260802000000` à `20260802000003` ne sont pas considérées appliquées tant que l'environnement distant ne le confirme pas.

Principes : service role uniquement pour les tables internes, RLS deny-by-default, prises concurrentes avec `SKIP LOCKED`, tentatives bornées, suppressions externes matérialisées avant les suppressions métier, aucune PII dans les champs d'erreur. Le registre et la documentation doivent distinguer ce qui est implémenté, configuré manuellement, prévu ou encore non vérifié.

Ne pas appliquer une migration distante sans autorisation explicite et plan de retour.
